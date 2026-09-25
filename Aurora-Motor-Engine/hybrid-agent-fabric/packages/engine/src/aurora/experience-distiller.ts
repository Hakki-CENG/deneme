import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { EventEnvelope, JsonValue } from "../types.js";
import type { EventStore } from "../persistence/event-store.js";
import type { ContinualHarnessService } from "../harness/continual-harness-service.js";
import type { MicroagentRegistry } from "../knowledge/microagent-registry.js";
import type { SkillEvolutionService } from "../evolution/skill-evolution-service.js";
import { analyzeStuck, type StuckReport } from "../runtime/stuck-detector.js";
import {
  auroraDigest, auroraInteger, auroraRound, auroraText, auroraTokens, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_PROPOSALS = 20_000;

export type DistillationKind = "harness-memory" | "microagent" | "skill-blueprint" | "workflow";

/**
 * A candidate lesson distilled from a real session trajectory. Nothing is applied automatically:
 * a proposal carries its evidence, a dedupe signature and a confidence, and an operator or an
 * explicitly governed capability call decides whether it becomes durable harness state.
 */
export interface DistillationProposal {
  id: string;
  tenantId: string;
  sessionId: string;
  kind: DistillationKind;
  key: string;
  title: string;
  body: string;
  rationale: string;
  confidence: number;
  signature: string;
  evidenceEventIds: string[];
  metrics: Record<string, number>;
  status: "proposed" | "applied" | "rejected" | "duplicate";
  appliedRef?: string;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DistillationReport {
  tenantId: string;
  sessionId: string;
  analyzedEvents: number;
  toolCalls: number;
  failures: number;
  distinctCapabilities: number;
  durationMs: number;
  complexity: number;
  proposals: DistillationProposal[];
  skipped: string[];
  stuck?: StuckReport;
  generatedAt: string;
}

interface DistillerStateShape {
  schemaVersion: 1;
  proposals: DistillationProposal[];
}

interface CapabilityPayload {
  capabilityId?: string;
  status?: string | null;
  error?: string | null;
  durationMs?: number | null;
}

/**
 * Aurora experience distiller (Hermes-derived closed learning loop, Aurora-governed).
 *
 * Hermes writes a skill document after a complex task; Prime refines its harness from the trajectory.
 * Aurora does both, but only as *proposals*: it reads the durable event log of a finished session,
 * measures complexity, extracts the capability sequence, recurring failures and stuck patterns, and
 * emits deduplicated candidate lessons with evidence event IDs. Applying a proposal routes through
 * the already-governed harness, microagent and skill-evolution services.
 */
export class ExperienceDistiller {
  private readonly store: DurableJsonState<DistillerStateShape>;

  constructor(
    rootPath: string,
    private readonly deps: {
      events: EventStore;
      harness: ContinualHarnessService;
      microagents: MicroagentRegistry;
      evolution: SkillEvolutionService;
    },
    private readonly now: () => number = Date.now,
    private readonly options: { minToolCalls?: number; minComplexity?: number } = {},
  ) {
    this.store = new DurableJsonState<DistillerStateShape>(
      join(rootPath, "distiller", "state.json"),
      () => ({ schemaVersion: 1, proposals: [] }),
      (value) => {
        const state = value as DistillerStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.proposals);
      },
      "Aurora experience distiller",
    );
  }

  /** Analyze a session trajectory and record deduplicated candidate lessons. */
  async distill(input: { tenantId: string; sessionId: string; maxEvents?: number; objective?: string }): Promise<DistillationReport> {
    const maxEvents = auroraInteger(input.maxEvents ?? 500, 10, 5000, "Distillation window");
    const events = await this.deps.events.read(input.sessionId, 0, maxEvents);
    const minToolCalls = this.options.minToolCalls ?? 5;
    const minComplexity = this.options.minComplexity ?? 0.25;

    const started = events.filter((item) => item.type === "capability.started");
    const finished = events.filter((item) => item.type === "capability.finished");
    const failures = finished.filter((item) => {
      const payload = item.payload as CapabilityPayload;
      return payload?.status === "failed" || typeof payload?.error === "string";
    });
    const capabilities = new Map<string, number>();
    for (const event of started) {
      const id = capabilityIdOf(event.payload);
      capabilities.set(id, (capabilities.get(id) ?? 0) + 1);
    }
    const first = events[0];
    const last = events[events.length - 1];
    const durationMs = first && last ? Math.max(0, Date.parse(last.timestamp) - Date.parse(first.timestamp)) : 0;
    const complexity = auroraRound(Math.min(1,
      started.length / 20 * 0.5
      + capabilities.size / 8 * 0.3
      + Math.min(1, durationMs / (30 * 60_000)) * 0.2));
    const stuck = analyzeStuck(input.sessionId, events);
    const skipped: string[] = [];
    const proposals: DistillationProposal[] = [];
    const nowIso = new Date(this.now()).toISOString();

    if (started.length < minToolCalls) skipped.push(`Only ${started.length} tool call(s); below the ${minToolCalls} threshold for distillation.`);
    else if (complexity < minComplexity) skipped.push(`Complexity ${complexity} is below the ${minComplexity} threshold.`);
    else {
      // 1. Procedure: the capability sequence that solved the task becomes a reusable harness memory.
      const sequence = started.map((event) => capabilityIdOf(event.payload));
      const compressed = compressSequence(sequence).slice(0, 12);
      if (compressed.length >= 3) {
        proposals.push(this.buildProposal({
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          kind: "harness-memory",
          key: `procedure-${auroraDigest(compressed.join(">")).slice(0, 10)}`,
          title: `Working procedure: ${compressed.slice(0, 4).join(" -> ")}`,
          body: [
            input.objective ? `Objective: ${input.objective}` : "",
            `Effective capability sequence: ${compressed.join(" -> ")}.`,
            `Observed over ${started.length} calls across ${capabilities.size} capabilities in ${Math.round(durationMs / 60_000)} minute(s).`,
          ].filter(Boolean).join("\n"),
          rationale: "A repeated capability sequence is cheaper to recall than to rediscover.",
          confidence: auroraRound(Math.min(0.85, 0.4 + complexity * 0.5)),
          evidenceEventIds: started.slice(0, 20).map((event) => event.eventId),
          metrics: { toolCalls: started.length, capabilities: capabilities.size, durationMinutes: Math.round(durationMs / 60_000), complexity },
          at: nowIso,
        }));
      }

      // 2. Failure classes: repeated identical errors become preventive knowledge.
      const errorGroups = new Map<string, EventEnvelope[]>();
      for (const failure of failures) {
        const payload = failure.payload as CapabilityPayload;
        const signature = `${capabilityIdOf(failure.payload)}:${normalizeError(typeof payload?.error === "string" ? payload.error : "failed")}`;
        errorGroups.set(signature, [...(errorGroups.get(signature) ?? []), failure]);
      }
      for (const [signature, group] of errorGroups) {
        if (group.length < 2) continue;
        const [capabilityId = "unknown", errorClass = "failure"] = signature.split(":");
        proposals.push(this.buildProposal({
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          kind: "microagent",
          key: `pitfall-${auroraDigest(signature).slice(0, 10)}`,
          title: `Pitfall: ${capabilityId} keeps failing with "${errorClass.slice(0, 60)}"`,
          body: `When using ${capabilityId}, the failure class "${errorClass}" recurred ${group.length} times in one session. Check the precondition before invoking it again, and prefer a different approach after the second failure.`,
          rationale: "A failure that recurs inside one session will recur across sessions.",
          confidence: auroraRound(Math.min(0.9, 0.5 + group.length * 0.1)),
          evidenceEventIds: group.slice(0, 20).map((event) => event.eventId),
          metrics: { occurrences: group.length },
          at: nowIso,
        }));
      }

      // 3. Structural friction: a stuck pattern is a capability-gap candidate, not just a warning.
      for (const pattern of stuck.patterns.filter((item) => item.severity !== "info").slice(0, 3)) {
        proposals.push(this.buildProposal({
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          kind: "skill-blueprint",
          key: `gap-${auroraDigest(`${pattern.code}:${pattern.detail}`).slice(0, 10)}`,
          title: `Capability gap from ${pattern.code}`,
          body: `${pattern.detail}\nRecommended remedy: ${pattern.recommendation}`,
          rationale: "Structural friction that the runtime had to detect is a missing capability, not a prompt problem.",
          confidence: auroraRound(Math.min(0.8, 0.4 + pattern.occurrences * 0.08)),
          evidenceEventIds: pattern.evidenceEventIds.slice(0, 20),
          metrics: { occurrences: pattern.occurrences },
          at: nowIso,
        }));
      }
    }

    const stored = await this.store.mutate((state) => {
      const kept: DistillationProposal[] = [];
      for (const proposal of proposals) {
        const duplicate = state.proposals.find((item) => item.tenantId === proposal.tenantId && item.signature === proposal.signature && item.status !== "rejected");
        if (duplicate) {
          duplicate.metrics = { ...duplicate.metrics, repeats: (duplicate.metrics["repeats"] ?? 0) + 1 };
          duplicate.confidence = auroraRound(Math.min(0.95, duplicate.confidence + 0.05));
          duplicate.updatedAt = proposal.createdAt;
          kept.push(structuredClone(duplicate));
          continue;
        }
        if (state.proposals.length >= MAX_PROPOSALS) state.proposals.splice(0, Math.ceil(MAX_PROPOSALS * 0.1));
        state.proposals.push(proposal);
        kept.push(structuredClone(proposal));
      }
      return kept;
    });

    return {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      analyzedEvents: events.length,
      toolCalls: started.length,
      failures: failures.length,
      distinctCapabilities: capabilities.size,
      durationMs,
      complexity,
      proposals: stored,
      skipped,
      stuck,
      generatedAt: nowIso,
    };
  }

  async proposals(tenantId: string, filter?: { status?: DistillationProposal["status"]; kind?: DistillationKind; limit?: number }): Promise<DistillationProposal[]> {
    const state = await this.store.read();
    return state.proposals
      .filter((item) => item.tenantId === tenantId && (!filter?.status || item.status === filter.status) && (!filter?.kind || item.kind === filter.kind))
      .sort((a, b) => b.confidence - a.confidence || b.createdAt.localeCompare(a.createdAt))
      .slice(0, auroraInteger(filter?.limit ?? 100, 1, 1000, "Proposal limit"))
      .map((item) => structuredClone(item));
  }

  /**
   * Apply a proposal through the governed service that owns that kind of state. Harness memories go
   * through a refinement batch (snapshotted, rollback-capable), knowledge goes through screening, and
   * skill blueprints become capability-gap observations rather than executable skills.
   */
  async apply(input: { tenantId: string; proposalId: string; actor: string }): Promise<{ proposal: DistillationProposal; appliedRef: string }> {
    const proposal = await this.mutableProposal(input.tenantId, input.proposalId);
    if (proposal.status === "applied") throw new Error("Distillation proposal is already applied.");
    if (proposal.status === "rejected") throw new Error("A rejected proposal cannot be applied.");
    let appliedRef = "";
    if (proposal.kind === "harness-memory" || proposal.kind === "workflow") {
      const refinement = await this.deps.harness.refine({
        tenantId: input.tenantId,
        scope: "tenant",
        trigger: `Distilled from session ${proposal.sessionId}`,
        rationale: `${proposal.rationale} Applied by ${auroraText(input.actor, 200, "Actor")}.`,
        evidenceRefs: proposal.evidenceEventIds,
        operations: [{ operation: "create", component: "memory", key: proposal.key, title: proposal.title, body: proposal.body, priority: Math.round(proposal.confidence * 100) }],
      });
      appliedRef = refinement.id;
    } else if (proposal.kind === "microagent") {
      const record = await this.deps.microagents.register({
        tenantId: input.tenantId,
        name: proposal.key,
        body: proposal.body,
        activation: "keyword",
        triggers: keywordsFor(proposal.title),
        summary: proposal.title,
        source: "learned",
        sourceRef: proposal.sessionId,
        priority: Math.round(proposal.confidence * 100),
      });
      appliedRef = record.id;
    } else {
      const gap = await this.deps.evolution.observeGap({
        tenantId: input.tenantId,
        kind: "capability-gap",
        description: proposal.title,
        context: proposal.body,
        severity: proposal.confidence,
        evidenceRefs: proposal.evidenceEventIds,
      });
      appliedRef = gap.gap.id;
    }
    const updated = await this.store.mutate((state) => {
      const record = state.proposals.find((item) => item.tenantId === input.tenantId && item.id === input.proposalId);
      if (!record) throw new Error("Distillation proposal not found in tenant.");
      record.status = "applied";
      record.appliedRef = appliedRef;
      record.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(record);
    });
    return { proposal: updated, appliedRef };
  }

  async reject(tenantId: string, proposalId: string, reason: string): Promise<DistillationProposal> {
    return await this.store.mutate((state) => {
      const record = state.proposals.find((item) => item.tenantId === tenantId && item.id === proposalId);
      if (!record) throw new Error("Distillation proposal not found in tenant.");
      record.status = "rejected";
      record.rejectionReason = auroraText(reason, 2000, "Rejection reason");
      record.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(record);
    });
  }

  private buildProposal(input: {
    tenantId: string; sessionId: string; kind: DistillationKind; key: string; title: string; body: string;
    rationale: string; confidence: number; evidenceEventIds: string[]; metrics: Record<string, number>; at: string;
  }): DistillationProposal {
    return {
      id: `distilled-${randomUUID()}`,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      kind: input.kind,
      key: input.key,
      title: auroraText(input.title, 300, "Proposal title"),
      body: auroraText(input.body, 20_000, "Proposal body"),
      rationale: auroraText(input.rationale, 5000, "Proposal rationale"),
      confidence: input.confidence,
      signature: auroraDigest(`${input.kind}:${input.key}`),
      evidenceEventIds: input.evidenceEventIds.slice(0, 50),
      metrics: input.metrics,
      status: "proposed",
      createdAt: input.at,
      updatedAt: input.at,
    };
  }

  private async mutableProposal(tenantId: string, proposalId: string): Promise<DistillationProposal> {
    const state = await this.store.read();
    const record = state.proposals.find((item) => item.tenantId === tenantId && item.id === proposalId);
    if (!record) throw new Error("Distillation proposal not found in tenant.");
    return structuredClone(record);
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const items = (s as any)[Object.keys(s).find(k => Array.isArray((s as any)[k])) ?? ""]?.filter((x: any) => x.tenantId === tenantId) ?? [];
    return { total: items.length };
  }

  // ═══ P3: Explainability ═══

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    const s = await this.store.read();
    const keys = Object.keys(s);
    const arrayKey = keys.find(k => Array.isArray((s as any)[k]));
    const items: any[] = arrayKey ? ((s as any)[arrayKey] as any[]).filter((x: any) => x.tenantId === tenantId) : [];
    const entity = items.find((x: any) => x.id === entityId);
    if (!entity) throw new Error("Entity not found");
    const rationale: string[] = [`Found entity: ${entity.name ?? entity.title ?? entity.id ?? entityId}`];
    return { entity: entity.name ?? entity.title ?? entityId, summary: entity.description ?? entity.statement ?? "", rationale, details: entity };
  }
}



function capabilityIdOf(payload: JsonValue): string {
  const value = (payload as { capabilityId?: unknown } | undefined)?.capabilityId;
  return typeof value === "string" ? value : "unknown";
}

function normalizeError(error: string): string {
  return error.toLowerCase().replace(/[0-9a-f]{8,}/g, "<id>").replace(/\d+/g, "<n>").slice(0, 120);
}

/** Collapses immediate repeats so `a a a b b c` becomes `a b c`. */
function compressSequence(sequence: string[]): string[] {
  const output: string[] = [];
  for (const item of sequence) if (output[output.length - 1] !== item) output.push(item);
  return output;
}

function keywordsFor(title: string): string[] {
  return auroraTokens(title)
    .filter((token) => /^[a-z0-9][a-z0-9._-]*$/.test(token))
    .slice(0, 8);
}
