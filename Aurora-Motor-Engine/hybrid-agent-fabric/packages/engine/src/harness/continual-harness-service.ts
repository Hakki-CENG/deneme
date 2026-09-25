import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  auroraDigest, auroraIds, auroraInteger, auroraRound, auroraTags, auroraText, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_ENTRIES = 20_000;
const MAX_REFINEMENTS = 20_000;
const MAX_SNAPSHOTS = 2_000;

/**
 * Continual Harness state components, following the H = (prompt, sub-agents, skills, memory)
 * decomposition: everything the agent may improve about its own scaffolding — and nothing else.
 * The immutable base system prompt is never part of this state.
 */
export type HarnessComponent = "prompt-note" | "memory" | "skill-spec" | "subagent-spec";
export type HarnessScope = "session" | "tenant";

export interface HarnessEntry {
  id: string;
  tenantId: string;
  scope: HarnessScope;
  sessionId?: string;
  component: HarnessComponent;
  key: string;
  title: string;
  body: string;
  tags: string[];
  priority: number;
  enabled: boolean;
  version: number;
  origin: "user" | "agent" | "refinement" | "system";
  evidenceRefs: string[];
  useCount: number;
  helpfulCount: number;
  unhelpfulCount: number;
  effectiveness: number;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessRefinement {
  id: string;
  tenantId: string;
  scope: HarnessScope;
  sessionId?: string;
  trigger: string;
  rationale: string;
  operations: Array<{ operation: "create" | "update" | "delete" | "enable" | "disable"; component: HarnessComponent; entryId: string; key: string; beforeDigest?: string; afterDigest?: string }>;
  snapshotId: string;
  status: "applied" | "rolled-back";
  evidenceRefs: string[];
  outcome?: { helpful: boolean; note: string; recordedAt: string };
  appliedAt: string;
  rolledBackAt?: string;
}

interface HarnessSnapshot {
  id: string;
  tenantId: string;
  scope: HarnessScope;
  sessionId?: string;
  entries: HarnessEntry[];
  takenAt: string;
}

export interface HarnessProjection {
  tenantId: string;
  sessionId?: string;
  characterBudget: number;
  usedCharacters: number;
  sections: Array<{ component: HarnessComponent; entries: Array<{ key: string; title: string; body: string; priority: number }> }>;
  omittedEntryIds: string[];
  digest: string;
  generatedAt: string;
}

interface HarnessStateShape {
  schemaVersion: 1;
  entries: HarnessEntry[];
  refinements: HarnessRefinement[];
  snapshots: HarnessSnapshot[];
}

export interface HarnessOperationInput {
  operation: "create" | "update" | "delete" | "enable" | "disable";
  component: HarnessComponent;
  key: string;
  title?: string;
  body?: string;
  tags?: string[];
  priority?: number;
  evidenceRefs?: string[];
}

/**
 * Aurora Continual Harness (Prime-derived, Aurora-governed).
 *
 * The agent may create, read, update and delete its own supplemental prompt notes, durable memories,
 * skill descriptions and sub-agent specifications — but only through small, evidence-backed refinement
 * batches. Every batch snapshots the previous state, is attributable to a trigger, and can be rolled
 * back by ID. The base system prompt, policy, profiles and capability allowlists are outside this
 * surface by construction, so self-improvement can never widen authority.
 */
export class ContinualHarnessService {
  private readonly store: DurableJsonState<HarnessStateShape>;

  constructor(
    rootPath: string,
    private readonly now: () => number = Date.now,
    private readonly limits: { maxOperationsPerRefinement?: number; maxRefinementsPerDay?: number } = {},
  ) {
    this.store = new DurableJsonState<HarnessStateShape>(
      join(rootPath, "harness", "state.json"),
      () => ({ schemaVersion: 1, entries: [], refinements: [], snapshots: [] }),
      (value) => {
        const state = value as HarnessStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.entries) && Array.isArray(state.refinements) && Array.isArray(state.snapshots);
      },
      "Aurora continual harness",
    );
  }

  async entries(tenantId: string, filter?: { scope?: HarnessScope; sessionId?: string; component?: HarnessComponent; enabledOnly?: boolean }): Promise<HarnessEntry[]> {
    const state = await this.store.read();
    return state.entries
      .filter((item) => item.tenantId === tenantId
        && (!filter?.component || item.component === filter.component)
        && (!filter?.enabledOnly || item.enabled)
        && (filter?.scope ? item.scope === filter.scope : true)
        && (filter?.sessionId ? item.scope === "tenant" || item.sessionId === filter.sessionId : true))
      .sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key))
      .map((item) => structuredClone(item));
  }

  /** Direct authoring (user or system). Agents should prefer `refine` so changes stay reversible. */
  async upsert(input: { tenantId: string; scope?: HarnessScope; sessionId?: string; component: HarnessComponent; key: string; title: string; body: string; tags?: string[]; priority?: number; origin?: HarnessEntry["origin"]; evidenceRefs?: string[] }): Promise<HarnessEntry> {
    return await this.store.mutate((state) => structuredClone(this.applyUpsert(state, {
      tenantId: input.tenantId,
      scope: input.scope ?? (input.sessionId ? "session" : "tenant"),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      component: input.component,
      key: input.key,
      title: input.title,
      body: input.body,
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      origin: input.origin ?? "user",
      ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
    })));
  }

  async remove(tenantId: string, entryId: string): Promise<{ removed: string }> {
    return await this.store.mutate((state) => {
      const index = state.entries.findIndex((item) => item.tenantId === tenantId && item.id === entryId);
      if (index < 0) throw new Error("Harness entry not found in tenant.");
      state.entries.splice(index, 1);
      return { removed: entryId };
    });
  }

  /**
   * Apply one evidence-backed refinement batch: snapshot first, then apply small operations.
   * Batches are size-limited and rate-limited per day so a runaway loop cannot rewrite the harness.
   */
  async refine(input: {
    tenantId: string; scope?: HarnessScope; sessionId?: string; trigger: string; rationale: string;
    operations: HarnessOperationInput[]; evidenceRefs?: string[];
  }): Promise<HarnessRefinement> {
    const maxOperations = this.limits.maxOperationsPerRefinement ?? 8;
    const maxPerDay = this.limits.maxRefinementsPerDay ?? 24;
    return await this.store.mutate((state) => {
      const scope: HarnessScope = input.scope ?? (input.sessionId ? "session" : "tenant");
      if (scope === "session" && !input.sessionId) throw new Error("Session-scoped refinement requires a session ID.");
      if (!input.operations.length) throw new Error("A refinement must contain at least one operation.");
      if (input.operations.length > maxOperations) throw new Error(`A refinement may contain at most ${maxOperations} operations.`);
      const timestamp = this.now();
      const dayAgo = timestamp - 86_400_000;
      const recent = state.refinements.filter((item) => item.tenantId === input.tenantId && item.status === "applied" && Date.parse(item.appliedAt) >= dayAgo);
      if (recent.length >= maxPerDay) throw new Error("Daily harness refinement budget is exhausted.");

      const affected = state.entries.filter((item) => item.tenantId === input.tenantId
        && (scope === "tenant" ? item.scope === "tenant" : item.sessionId === input.sessionId));
      const snapshot: HarnessSnapshot = {
        id: `snapshot-${randomUUID()}`,
        tenantId: input.tenantId,
        scope,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        entries: affected.map((item) => structuredClone(item)),
        takenAt: new Date(timestamp).toISOString(),
      };
      state.snapshots.push(snapshot);
      if (state.snapshots.length > MAX_SNAPSHOTS) state.snapshots.splice(0, state.snapshots.length - MAX_SNAPSHOTS);

      const operations: HarnessRefinement["operations"] = [];
      for (const operation of input.operations) {
        const key = auroraText(operation.key, 200, "Harness key").toLowerCase();
        const existing = state.entries.find((item) => item.tenantId === input.tenantId && item.component === operation.component && item.key === key
          && (scope === "tenant" ? item.scope === "tenant" : item.sessionId === input.sessionId));
        const beforeDigest = existing ? auroraDigest(`${existing.title}:${existing.body}:${existing.enabled}`) : undefined;
        if (operation.operation === "delete") {
          if (!existing) throw new Error(`Harness entry ${operation.component}:${key} does not exist.`);
          state.entries = state.entries.filter((item) => item.id !== existing.id);
          operations.push({ operation: "delete", component: operation.component, entryId: existing.id, key, ...(beforeDigest ? { beforeDigest } : {}) });
          continue;
        }
        if (operation.operation === "enable" || operation.operation === "disable") {
          if (!existing) throw new Error(`Harness entry ${operation.component}:${key} does not exist.`);
          existing.enabled = operation.operation === "enable";
          existing.version++;
          existing.updatedAt = new Date(timestamp).toISOString();
          operations.push({ operation: operation.operation, component: operation.component, entryId: existing.id, key, ...(beforeDigest ? { beforeDigest } : {}), afterDigest: auroraDigest(`${existing.title}:${existing.body}:${existing.enabled}`) });
          continue;
        }
        if (operation.operation === "create" && existing) throw new Error(`Harness entry ${operation.component}:${key} already exists; use update.`);
        if (operation.operation === "update" && !existing) throw new Error(`Harness entry ${operation.component}:${key} does not exist; use create.`);
        if (!operation.title || !operation.body) throw new Error("Harness create/update operations require a title and body.");
        const entry = this.applyUpsert(state, {
          tenantId: input.tenantId,
          scope,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          component: operation.component,
          key,
          title: operation.title,
          body: operation.body,
          ...(operation.tags ? { tags: operation.tags } : {}),
          ...(operation.priority !== undefined ? { priority: operation.priority } : {}),
          origin: "refinement",
          ...(operation.evidenceRefs ? { evidenceRefs: operation.evidenceRefs } : {}),
        });
        operations.push({
          operation: operation.operation,
          component: operation.component,
          entryId: entry.id,
          key,
          ...(beforeDigest ? { beforeDigest } : {}),
          afterDigest: auroraDigest(`${entry.title}:${entry.body}:${entry.enabled}`),
        });
      }

      const refinement: HarnessRefinement = {
        id: `refinement-${randomUUID()}`,
        tenantId: input.tenantId,
        scope,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        trigger: auroraText(input.trigger, 2000, "Refinement trigger"),
        rationale: auroraText(input.rationale, 10_000, "Refinement rationale"),
        operations,
        snapshotId: snapshot.id,
        status: "applied",
        evidenceRefs: auroraIds(input.evidenceRefs, 200, "Refinement evidence refs"),
        appliedAt: new Date(timestamp).toISOString(),
      };
      state.refinements.push(refinement);
      if (state.refinements.length > MAX_REFINEMENTS) state.refinements.splice(0, state.refinements.length - MAX_REFINEMENTS);
      return structuredClone(refinement);
    });
  }

  /** Roll one refinement back to its recorded snapshot. Later refinements in the same scope block it. */
  async rollback(tenantId: string, refinementId: string): Promise<{ refinement: HarnessRefinement; restoredEntries: number }> {
    return await this.store.mutate((state) => {
      const index = state.refinements.findIndex((item) => item.tenantId === tenantId && item.id === refinementId);
      if (index < 0) throw new Error("Harness refinement not found in tenant.");
      const refinement = state.refinements[index]!;
      if (refinement.status === "rolled-back") throw new Error("Harness refinement is already rolled back.");
      // Append order is the authoritative sequence: two refinements can share a millisecond.
      const newer = state.refinements.slice(index + 1).filter((item) => item.tenantId === tenantId && item.status === "applied"
        && item.scope === refinement.scope && item.sessionId === refinement.sessionId);
      if (newer.length) throw new Error("Roll back the newer refinements in this scope first.");
      const snapshot = state.snapshots.find((item) => item.id === refinement.snapshotId);
      if (!snapshot) throw new Error("Harness snapshot is no longer available; rollback is not possible.");
      state.entries = state.entries.filter((item) => !(item.tenantId === tenantId
        && (refinement.scope === "tenant" ? item.scope === "tenant" : item.sessionId === refinement.sessionId)));
      for (const entry of snapshot.entries) state.entries.push(structuredClone(entry));
      refinement.status = "rolled-back";
      refinement.rolledBackAt = new Date(this.now()).toISOString();
      return { refinement: structuredClone(refinement), restoredEntries: snapshot.entries.length };
    });
  }

  /** Was the refinement actually useful? Effectiveness feeds entry scoring and future pruning. */
  async recordRefinementOutcome(tenantId: string, refinementId: string, helpful: boolean, note: string): Promise<HarnessRefinement> {
    return await this.store.mutate((state) => {
      const refinement = state.refinements.find((item) => item.tenantId === tenantId && item.id === refinementId);
      if (!refinement) throw new Error("Harness refinement not found in tenant.");
      refinement.outcome = { helpful, note: auroraText(note, 2000, "Refinement outcome note"), recordedAt: new Date(this.now()).toISOString() };
      for (const operation of refinement.operations) {
        const entry = state.entries.find((item) => item.id === operation.entryId);
        if (!entry) continue;
        if (helpful) entry.helpfulCount++; else entry.unhelpfulCount++;
        entry.effectiveness = auroraRound((entry.helpfulCount + 1) / (entry.helpfulCount + entry.unhelpfulCount + 2));
        entry.updatedAt = new Date(this.now()).toISOString();
      }
      return structuredClone(refinement);
    });
  }

  async refinements(tenantId: string, filter?: { sessionId?: string; status?: HarnessRefinement["status"]; limit?: number }): Promise<HarnessRefinement[]> {
    const state = await this.store.read();
    return state.refinements
      .filter((item) => item.tenantId === tenantId
        && (!filter?.sessionId || item.sessionId === filter.sessionId)
        && (!filter?.status || item.status === filter.status))
      .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))
      .slice(0, auroraInteger(filter?.limit ?? 100, 1, 1000, "Refinement limit"))
      .map((item) => structuredClone(item));
  }

  /**
   * Bounded projection of harness state for prompt assembly: priority-ordered, character-budgeted,
   * and usage-accounted so the system can tell which lessons actually get used.
   */
  async project(input: { tenantId: string; sessionId?: string; characterBudget?: number; components?: HarnessComponent[] }): Promise<HarnessProjection> {
    const budget = auroraInteger(input.characterBudget ?? 6000, 200, 100_000, "Harness projection budget");
    return await this.store.mutate((state) => {
      const nowIso = new Date(this.now()).toISOString();
      const candidates = state.entries
        .filter((item) => item.tenantId === input.tenantId && item.enabled
          && (item.scope === "tenant" || item.sessionId === input.sessionId)
          && (!input.components?.length || input.components.includes(item.component)))
        .sort((a, b) => b.priority - a.priority || b.effectiveness - a.effectiveness || a.key.localeCompare(b.key));
      const sections = new Map<HarnessComponent, Array<{ key: string; title: string; body: string; priority: number }>>();
      const omitted: string[] = [];
      let used = 0;
      for (const entry of candidates) {
        const cost = entry.title.length + entry.body.length + 8;
        if (used + cost > budget) {
          omitted.push(entry.id);
          continue;
        }
        used += cost;
        sections.set(entry.component, [...(sections.get(entry.component) ?? []), { key: entry.key, title: entry.title, body: entry.body, priority: entry.priority }]);
        entry.useCount++;
        entry.lastUsedAt = nowIso;
      }
      return {
        tenantId: input.tenantId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        characterBudget: budget,
        usedCharacters: used,
        sections: [...sections.entries()].map(([component, entries]) => ({ component, entries })),
        omittedEntryIds: omitted,
        digest: auroraDigest([...sections.entries()]),
        generatedAt: nowIso,
      } satisfies HarnessProjection;
    });
  }

  /** Prune harness entries that are never used or consistently unhelpful. */
  async prune(tenantId: string, options?: { minUseCount?: number; maxIdleDays?: number; minEffectiveness?: number }): Promise<Array<{ entryId: string; key: string; reason: string }>> {
    const minUse = auroraInteger(options?.minUseCount ?? 1, 0, 1000, "Prune minimum use");
    const idleDays = auroraInteger(options?.maxIdleDays ?? 60, 1, 3650, "Prune idle window");
    const minEffectiveness = options?.minEffectiveness ?? 0.35;
    return await this.store.mutate((state) => {
      const timestamp = this.now();
      const pruned: Array<{ entryId: string; key: string; reason: string }> = [];
      state.entries = state.entries.filter((entry) => {
        if (entry.tenantId !== tenantId || entry.origin === "user") return true;
        const idleMs = timestamp - Date.parse(entry.lastUsedAt ?? entry.createdAt);
        if (entry.useCount < minUse && idleMs > idleDays * 86_400_000) {
          pruned.push({ entryId: entry.id, key: entry.key, reason: `Unused for more than ${idleDays} days.` });
          return false;
        }
        if (entry.helpfulCount + entry.unhelpfulCount >= 3 && entry.effectiveness < minEffectiveness) {
          pruned.push({ entryId: entry.id, key: entry.key, reason: `Effectiveness ${entry.effectiveness} below ${minEffectiveness}.` });
          return false;
        }
        return true;
      });
      return pruned;
    });
  }

  private applyUpsert(state: HarnessStateShape, input: { tenantId: string; scope: HarnessScope; sessionId?: string; component: HarnessComponent; key: string; title: string; body: string; tags?: string[]; priority?: number; origin: HarnessEntry["origin"]; evidenceRefs?: string[] }): HarnessEntry {
    const key = auroraText(input.key, 200, "Harness key").toLowerCase();
    const nowIso = new Date(this.now()).toISOString();
    const existing = state.entries.find((item) => item.tenantId === input.tenantId && item.component === input.component && item.key === key
      && (input.scope === "tenant" ? item.scope === "tenant" : item.sessionId === input.sessionId));
    if (existing) {
      existing.title = auroraText(input.title, 300, "Harness title");
      existing.body = auroraText(input.body, 20_000, "Harness body");
      if (input.tags) existing.tags = auroraTags(input.tags, "Harness tags");
      if (input.priority !== undefined) existing.priority = auroraInteger(input.priority, 0, 100, "Harness priority");
      existing.evidenceRefs = [...new Set([...existing.evidenceRefs, ...auroraIds(input.evidenceRefs, 200, "Harness evidence refs")])].slice(0, 200);
      existing.origin = input.origin;
      existing.version++;
      existing.updatedAt = nowIso;
      return existing;
    }
    if (state.entries.length >= MAX_ENTRIES) throw new Error("Harness entry limit reached.");
    const entry: HarnessEntry = {
      id: `harness-${randomUUID()}`,
      tenantId: input.tenantId,
      scope: input.scope,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      component: input.component,
      key,
      title: auroraText(input.title, 300, "Harness title"),
      body: auroraText(input.body, 20_000, "Harness body"),
      tags: auroraTags(input.tags, "Harness tags"),
      priority: auroraInteger(input.priority ?? 50, 0, 100, "Harness priority"),
      enabled: true,
      version: 1,
      origin: input.origin,
      evidenceRefs: auroraIds(input.evidenceRefs, 200, "Harness evidence refs"),
      useCount: 0,
      helpfulCount: 0,
      unhelpfulCount: 0,
      effectiveness: 0.5,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    state.entries.push(entry);
    return entry;
  }
}
