import { join } from "node:path";
import { auroraInteger, auroraText, DurableJsonState } from "../util/aurora-state.js";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface EffortProfile {
  level: EffortLevel;
  /** How many tool iterations a single turn may take before the loop guard stops it. */
  toolIterations: number;
  /** Multiplier applied to Aurora's prompt context budgets. */
  contextScale: number;
  /** What a provider that supports reasoning effort should be asked for. */
  reasoningEffort: "low" | "medium" | "high" | "max";
  /** Ceiling on autonomous continuations for this level. */
  continuationCeiling: number;
  description: string;
}

export interface SessionEffortState {
  sessionId: string;
  tenantId: string;
  level: EffortLevel;
  updatedAt: string;
  updatedBy: string;
  note?: string;
}

interface EffortStateShape {
  schemaVersion: 1;
  sessions: SessionEffortState[];
  defaults: Array<{ tenantId: string; level: EffortLevel; updatedAt: string }>;
}

const PROFILES: Record<EffortLevel, EffortProfile> = {
  low: { level: "low", toolIterations: 4, contextScale: 0.6, reasoningEffort: "low", continuationCeiling: 1, description: "Answer quickly with minimal tool use. Good for lookups and triage." },
  medium: { level: "medium", toolIterations: 8, contextScale: 0.85, reasoningEffort: "medium", continuationCeiling: 2, description: "The default balance between speed and thoroughness." },
  high: { level: "high", toolIterations: 12, contextScale: 1, reasoningEffort: "high", continuationCeiling: 4, description: "Multi-step work: more tool iterations and full context budgets." },
  xhigh: { level: "xhigh", toolIterations: 20, contextScale: 1.25, reasoningEffort: "high", continuationCeiling: 6, description: "Hard problems worth the tokens: deep tool loops and enlarged context." },
  max: { level: "max", toolIterations: 32, contextScale: 1.5, reasoningEffort: "max", continuationCeiling: 8, description: "Everything the runtime allows. Use deliberately; it is the most expensive setting." },
};

const LEVELS = Object.keys(PROFILES) as EffortLevel[];

/**
 * Per-session effort.
 *
 * Peers expose a single "how hard should I think about this?" dial, and it does two different jobs:
 * it asks the provider for more reasoning, and it changes how much *the harness* is willing to spend —
 * tool iterations, context budget, autonomous continuations. Aurora had the second half hard-coded at
 * construction and the first half fixed per provider.
 *
 * This service makes it one setting with an explicit, inspectable profile per level. Nothing here is a
 * hidden multiplier: `session.effort` returns the exact numbers the runtime will use, so an operator
 * can see why a turn stopped after four tool calls instead of guessing.
 */
export class SessionEffortService {
  private readonly store: DurableJsonState<EffortStateShape>;

  constructor(rootPath: string, private readonly now: () => number = Date.now, private readonly options: { defaultLevel?: EffortLevel } = {}) {
    this.store = new DurableJsonState<EffortStateShape>(
      join(rootPath, "policy", "session-effort.json"),
      () => ({ schemaVersion: 1, sessions: [], defaults: [] }),
      (value) => {
        const state = value as EffortStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.sessions) && Array.isArray(state.defaults);
      },
      "Aurora session effort",
    );
  }

  levels(): EffortProfile[] {
    return LEVELS.map((level) => structuredClone(PROFILES[level]));
  }

  profile(level: EffortLevel): EffortProfile {
    const found = PROFILES[level];
    if (!found) throw new Error(`Unknown effort level "${level}".`);
    return structuredClone(found);
  }

  async get(tenantId: string, sessionId: string): Promise<SessionEffortState & { profile: EffortProfile }> {
    const state = await this.store.read();
    const session = state.sessions.find((item) => item.tenantId === tenantId && item.sessionId === sessionId);
    const fallback = state.defaults.find((item) => item.tenantId === tenantId)?.level ?? this.options.defaultLevel ?? "medium";
    const level = session?.level ?? fallback;
    return {
      sessionId,
      tenantId,
      level,
      updatedAt: session?.updatedAt ?? new Date(this.now()).toISOString(),
      updatedBy: session?.updatedBy ?? "default",
      ...(session?.note ? { note: session.note } : {}),
      profile: this.profile(level),
    };
  }

  async set(input: { tenantId: string; sessionId: string; level: EffortLevel; actor?: string; note?: string }): Promise<SessionEffortState & { profile: EffortProfile }> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const sessionId = auroraText(input.sessionId, 200, "Session ID");
    if (!LEVELS.includes(input.level)) throw new Error(`Unknown effort level "${input.level}".`);
    await this.store.mutate((state) => {
      const record: SessionEffortState = {
        sessionId,
        tenantId,
        level: input.level,
        updatedAt: new Date(this.now()).toISOString(),
        updatedBy: auroraText(input.actor ?? "operator", 200, "Actor"),
        ...(input.note ? { note: auroraText(input.note, 500, "Effort note") } : {}),
      };
      const index = state.sessions.findIndex((item) => item.tenantId === tenantId && item.sessionId === sessionId);
      if (index >= 0) state.sessions[index] = record;
      else {
        if (state.sessions.length >= 50_000) state.sessions.splice(0, state.sessions.length - 49_999);
        state.sessions.push(record);
      }
    });
    return await this.get(tenantId, sessionId);
  }

  async setDefault(tenantId: string, level: EffortLevel): Promise<{ tenantId: string; level: EffortLevel }> {
    if (!LEVELS.includes(level)) throw new Error(`Unknown effort level "${level}".`);
    const id = auroraText(tenantId, 200, "Tenant ID");
    return await this.store.mutate((state) => {
      const existing = state.defaults.find((item) => item.tenantId === id);
      if (existing) { existing.level = level; existing.updatedAt = new Date(this.now()).toISOString(); }
      else state.defaults.push({ tenantId: id, level, updatedAt: new Date(this.now()).toISOString() });
      return { tenantId: id, level };
    });
  }

  /** Tool-iteration ceiling for a turn. Never throws: the runtime default applies on any failure. */
  async toolIterations(tenantId: string, sessionId: string, fallback: number): Promise<number> {
    try {
      const resolved = await this.get(tenantId, sessionId);
      return auroraInteger(resolved.profile.toolIterations, 1, 200, "Tool iteration ceiling");
    } catch {
      return fallback;
    }
  }
}
