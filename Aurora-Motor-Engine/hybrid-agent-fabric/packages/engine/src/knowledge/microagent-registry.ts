import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  auroraDigest, auroraInteger, auroraRound, auroraTags, auroraText, auroraTokens, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_MICROAGENTS = 5_000;
const MAX_BODY = 50_000;

/**
 * Microagent activation modes, following the OpenHands microagent model:
 * - `always`: injected in every recall (repository-wide conventions)
 * - `keyword`: injected when a trigger word appears in the query or task
 * - `glob`: injected when a touched file path matches a glob
 * - `manual`: only injected when explicitly requested by name
 */
export type MicroagentActivation = "always" | "keyword" | "glob" | "manual";

export interface Microagent {
  id: string;
  tenantId: string;
  name: string;
  activation: MicroagentActivation;
  triggers: string[];
  globs: string[];
  body: string;
  bodyDigest: string;
  summary: string;
  priority: number;
  enabled: boolean;
  source: "user" | "repository" | "skill" | "learned";
  sourceRef?: string;
  tags: string[];
  screened: boolean;
  screeningFindings: string[];
  recallCount: number;
  helpfulCount: number;
  unhelpfulCount: number;
  effectiveness: number;
  lastRecalledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MicroagentRecall {
  tenantId: string;
  query: string;
  characterBudget: number;
  usedCharacters: number;
  knowledge: Array<{ id: string; name: string; activation: MicroagentActivation; reason: string; score: number; body: string }>;
  omitted: Array<{ id: string; name: string; reason: string }>;
  digest: string;
  generatedAt: string;
}

interface MicroagentStateShape {
  schemaVersion: 1;
  microagents: Microagent[];
}

/**
 * Injection screening patterns. Knowledge documents are prompt content, so anything that tries to
 * rewrite the agent's instructions, exfiltrate credentials or disable safety is flagged and the
 * microagent stays quarantined until a human clears it.
 */
const INJECTION_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "instruction-override", pattern: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|prompts)\b/i },
  { code: "role-hijack", pattern: /\byou\s+are\s+now\s+(a|an|the)\b/i },
  { code: "policy-bypass", pattern: /\b(bypass|disable|skip|ignore)\s+(the\s+)?(policy|approval|guardrail|safety|sandbox|constitution)\b/i },
  { code: "credential-exfiltration", pattern: /\b(api[_\s-]?key|secret|token|password|credential)s?\b[^\n]{0,40}\b(send|post|upload|exfiltrate|share|email)\b/i },
  { code: "autonomy-escalation", pattern: /\b(always|never)\s+(auto[- ]?approve|approve\s+everything|run\s+without\s+asking)\b/i },
  { code: "destructive-instruction", pattern: /\brm\s+-rf\s+\/(?!\w)|\bDROP\s+DATABASE\b|\bgit\s+push\s+--force\b/i },
];

/**
 * Aurora microagent registry (OpenHands-derived, Aurora-governed).
 *
 * Microagents are small knowledge documents that load themselves when they are relevant, instead of
 * permanently inflating the system prompt. Aurora adds: injection screening with quarantine,
 * per-recall character budgets, effectiveness feedback and content digests for audit.
 */
export class MicroagentRegistry {
  private readonly store: DurableJsonState<MicroagentStateShape>;

  constructor(rootPath: string, private readonly now: () => number = Date.now) {
    this.store = new DurableJsonState<MicroagentStateShape>(
      join(rootPath, "microagents", "state.json"),
      () => ({ schemaVersion: 1, microagents: [] }),
      (value) => {
        const state = value as MicroagentStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.microagents);
      },
      "Aurora microagent registry",
    );
  }

  /** Register or replace a microagent. Screening runs on every write; findings quarantine the document. */
  async register(input: {
    tenantId: string; name: string; body: string; activation?: MicroagentActivation; triggers?: string[]; globs?: string[];
    summary?: string; priority?: number; source?: Microagent["source"]; sourceRef?: string; tags?: string[];
  }): Promise<Microagent> {
    return await this.store.mutate((state) => {
      const name = auroraText(input.name, 120, "Microagent name").toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{1,119}$/.test(name)) throw new Error("Microagent name is invalid.");
      const body = auroraText(input.body, MAX_BODY, "Microagent body");
      const activation = input.activation ?? (input.globs?.length ? "glob" : input.triggers?.length ? "keyword" : "manual");
      if (activation === "keyword" && !(input.triggers ?? []).length) throw new Error("Keyword microagents require at least one trigger.");
      if (activation === "glob" && !(input.globs ?? []).length) throw new Error("Glob microagents require at least one glob.");
      const findings = screen(body);
      const nowIso = new Date(this.now()).toISOString();
      const existing = state.microagents.find((item) => item.tenantId === input.tenantId && item.name === name);
      if (!existing && state.microagents.length >= MAX_MICROAGENTS) throw new Error("Microagent limit reached.");
      const record: Microagent = existing ?? {
        id: `microagent-${randomUUID()}`,
        tenantId: input.tenantId,
        name,
        activation,
        triggers: [],
        globs: [],
        body,
        bodyDigest: auroraDigest(body),
        summary: "",
        priority: 50,
        enabled: true,
        source: input.source ?? "user",
        tags: [],
        screened: findings.length === 0,
        screeningFindings: findings,
        recallCount: 0,
        helpfulCount: 0,
        unhelpfulCount: 0,
        effectiveness: 0.5,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      record.activation = activation;
      record.triggers = auroraTags(input.triggers, "Microagent triggers");
      record.globs = (input.globs ?? []).slice(0, 50).map((item) => auroraText(item, 300, "Microagent glob"));
      record.body = body;
      record.bodyDigest = auroraDigest(body);
      record.summary = input.summary ? auroraText(input.summary, 1000, "Microagent summary") : body.slice(0, 200);
      record.priority = auroraInteger(input.priority ?? record.priority, 0, 100, "Microagent priority");
      record.source = input.source ?? record.source;
      if (input.sourceRef) record.sourceRef = auroraText(input.sourceRef, 500, "Microagent source ref");
      record.tags = auroraTags(input.tags, "Microagent tags");
      record.screeningFindings = findings;
      record.screened = findings.length === 0;
      if (findings.length) record.enabled = false;
      record.updatedAt = nowIso;
      if (!existing) state.microagents.push(record);
      return structuredClone(record);
    });
  }

  /** Clear a quarantined microagent after human review; the reviewer and reason are recorded in tags. */
  async approveQuarantined(tenantId: string, microagentId: string, reviewer: string): Promise<Microagent> {
    return await this.store.mutate((state) => {
      const record = this.mutable(state, tenantId, microagentId);
      if (!record.screeningFindings.length) return structuredClone(record);
      record.screened = true;
      record.enabled = true;
      record.tags = [...new Set([...record.tags, `reviewed-by:${auroraText(reviewer, 80, "Reviewer").toLowerCase().replace(/[^a-z0-9._-]/g, "-")}`])].slice(0, 100);
      record.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(record);
    });
  }

  async setEnabled(tenantId: string, microagentId: string, enabled: boolean): Promise<Microagent> {
    return await this.store.mutate((state) => {
      const record = this.mutable(state, tenantId, microagentId);
      if (enabled && record.screeningFindings.length && !record.screened) throw new Error("Quarantined microagents must be reviewed before they can be enabled.");
      record.enabled = enabled;
      record.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(record);
    });
  }

  async remove(tenantId: string, microagentId: string): Promise<{ removed: string }> {
    return await this.store.mutate((state) => {
      const index = state.microagents.findIndex((item) => item.tenantId === tenantId && item.id === microagentId);
      if (index < 0) throw new Error("Microagent not found in tenant.");
      state.microagents.splice(index, 1);
      return { removed: microagentId };
    });
  }

  async list(tenantId: string, filter?: { activation?: MicroagentActivation; enabledOnly?: boolean; quarantinedOnly?: boolean }): Promise<Microagent[]> {
    const state = await this.store.read();
    return state.microagents
      .filter((item) => item.tenantId === tenantId
        && (!filter?.activation || item.activation === filter.activation)
        && (!filter?.enabledOnly || item.enabled)
        && (!filter?.quarantinedOnly || item.screeningFindings.length > 0))
      .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
      .map((item) => structuredClone(item));
  }

  /**
   * Recall the knowledge that applies right now: always-on documents, keyword hits from the query,
   * glob hits from touched files and explicitly requested names — all inside a character budget.
   */
  async recall(input: { tenantId: string; query?: string; touchedPaths?: string[]; requestedNames?: string[]; characterBudget?: number }): Promise<MicroagentRecall> {
    const budget = auroraInteger(input.characterBudget ?? 8000, 50, 100_000, "Microagent recall budget");
    const query = input.query ? auroraText(input.query, 20_000, "Microagent recall query") : "";
    const tokens = new Set(auroraTokens(query));
    const paths = (input.touchedPaths ?? []).slice(0, 200).map((item) => item.toLowerCase());
    const requested = new Set((input.requestedNames ?? []).map((item) => item.trim().toLowerCase()));
    return await this.store.mutate((state) => {
      const nowIso = new Date(this.now()).toISOString();
      const scored: Array<{ record: Microagent; reason: string; score: number }> = [];
      for (const record of state.microagents.filter((item) => item.tenantId === input.tenantId && item.enabled && item.screened)) {
        if (requested.has(record.name)) {
          scored.push({ record, reason: "explicitly requested", score: 100 + record.priority });
          continue;
        }
        if (record.activation === "always") {
          scored.push({ record, reason: "always-on knowledge", score: 80 + record.priority / 10 });
          continue;
        }
        if (record.activation === "keyword") {
          const hits = record.triggers.filter((trigger) => tokens.has(trigger) || (query && query.toLowerCase().includes(trigger)));
          if (hits.length) scored.push({ record, reason: `trigger match: ${hits.slice(0, 5).join(", ")}`, score: 60 + hits.length * 5 + record.priority / 10 });
          continue;
        }
        if (record.activation === "glob") {
          const hits = paths.filter((path) => record.globs.some((glob) => matchesGlob(path, glob.toLowerCase())));
          if (hits.length) scored.push({ record, reason: `path match: ${hits.slice(0, 3).join(", ")}`, score: 70 + hits.length * 3 + record.priority / 10 });
        }
      }
      scored.sort((a, b) => b.score - a.score || b.record.effectiveness - a.record.effectiveness);
      const knowledge: MicroagentRecall["knowledge"] = [];
      const omitted: MicroagentRecall["omitted"] = [];
      let used = 0;
      for (const item of scored) {
        const cost = item.record.body.length + item.record.name.length + 4;
        if (used + cost > budget) {
          omitted.push({ id: item.record.id, name: item.record.name, reason: "recall budget exhausted" });
          continue;
        }
        used += cost;
        item.record.recallCount++;
        item.record.lastRecalledAt = nowIso;
        knowledge.push({ id: item.record.id, name: item.record.name, activation: item.record.activation, reason: item.reason, score: auroraRound(item.score), body: item.record.body });
      }
      return {
        tenantId: input.tenantId,
        query,
        characterBudget: budget,
        usedCharacters: used,
        knowledge,
        omitted,
        digest: auroraDigest(knowledge.map((item) => item.id)),
        generatedAt: nowIso,
      } satisfies MicroagentRecall;
    });
  }

  /** Feedback loop: knowledge that never helps gets deprioritized instead of silently bloating recall. */
  async recordFeedback(tenantId: string, microagentId: string, helpful: boolean): Promise<Microagent> {
    return await this.store.mutate((state) => {
      const record = this.mutable(state, tenantId, microagentId);
      if (helpful) record.helpfulCount++; else record.unhelpfulCount++;
      record.effectiveness = auroraRound((record.helpfulCount + 1) / (record.helpfulCount + record.unhelpfulCount + 2));
      record.priority = auroraInteger(Math.max(0, Math.min(100, Math.round(record.priority + (helpful ? 2 : -5)))), 0, 100, "Microagent priority");
      record.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(record);
    });
  }

  private mutable(state: MicroagentStateShape, tenantId: string, id: string): Microagent {
    const record = state.microagents.find((item) => item.tenantId === tenantId && (item.id === id || item.name === id.toLowerCase()));
    if (!record) throw new Error("Microagent not found in tenant.");
    return record;
  }
}

function screen(body: string): string[] {
  return INJECTION_PATTERNS.filter((item) => item.pattern.test(body)).map((item) => item.code);
}

/** Minimal glob matcher supporting `*`, `**` and `?` — deliberately not a full shell glob engine. */
function matchesGlob(path: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const expression = escaped
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${expression}$`).test(path);
}
