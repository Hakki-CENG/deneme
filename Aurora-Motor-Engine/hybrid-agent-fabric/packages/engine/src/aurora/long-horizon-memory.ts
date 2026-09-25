import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

export type Horizon = "short" | "medium" | "long" | "permanent";
export type MemoryCategory = "episodic" | "semantic" | "procedural" | "emotional" | "strategic";

/**
 * Importance runs 0..10 throughout this service.
 *
 * `consolidate()` used to compute `Math.min(1, maxImportance + 0.1)`, which
 * assumed a 0..1 scale while `storeMemory()` writes 0..10. Merging two
 * memories of importance 9 produced one of importance 1 — consolidation made
 * knowledge *less* important, and the clamp hid it by always landing on a
 * plausible-looking number.
 */
export const MAX_IMPORTANCE = 10;

/** Below this, a non-permanent memory is pruned by `decay()`. */
export const PRUNE_THRESHOLD = 0.01;

export interface LongMemory { id: string; tenantId: string; category: MemoryCategory; horizon: Horizon; title: string; content: string; importance: number; emotionalWeight: number; associations: string[]; accessCount: number; lastAccessedAt: string; decayFactor: number; consolidatedFrom: string[]; createdAt: string; }

interface LongHorizonState { schemaVersion: number; memories: LongMemory[]; }

export class LongHorizonMemoryService {
  private store: DurableJsonState<LongHorizonState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<LongHorizonState>(
      join(baseDir, "long-horizon-memory.json"),
      () => ({ schemaVersion: 1, memories: [] }),
      (v) => { const s = v as LongHorizonState; return !!s && s.schemaVersion === 1; },
      "Aurora long-horizon memory",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async storeMemory(tenantId: string, category: MemoryCategory, horizon: Horizon, title: string, content: string, importance: number, emotionalWeight: number = 0, associations: string[] = []): Promise<LongMemory> {
    const m: LongMemory = { id: randomUUID(), tenantId, category, horizon, title, content, importance, emotionalWeight, associations, accessCount: 0, lastAccessedAt: new Date().toISOString(), decayFactor: horizon === "permanent" ? 0 : horizon === "long" ? 0.001 : horizon === "medium" ? 0.01 : 0.05, consolidatedFrom: [], createdAt: new Date().toISOString() };
    await this.store.mutate(s => { s.memories.push(m); });
    return m;
  }

  async recall(memoryId: string): Promise<LongMemory | null> {
    return await this.store.mutate(s => {
      const m = s.memories.find(x => x.id === memoryId);
      if (!m) return null;
      m.accessCount++;
      m.lastAccessedAt = new Date().toISOString();
      m.importance = Math.min(1, m.importance + 0.02);
      return m;
    });
  }

  /**
   * Find memories matching a query.
   *
   * Matches on any query term rather than the whole string as one substring.
   * The previous implementation required the entire query to appear verbatim,
   * so a natural-language question returned nothing at all:
   *
   *     search("t1", "why did the postgres migration fail")  ->  []
   *
   * even with a memory reading "The postgres migration failed because of a
   * missing index". Callers pass questions, not substrings, and a store that
   * answers questions with silence cannot be ranked, fused or improved — every
   * layer above it inherits the empty result.
   *
   * Short terms are dropped: "the", "did" and "a" match nearly everything and
   * would turn any question into a full scan.
   */
  async search(tenantId: string, query: string, category?: MemoryCategory, horizon?: Horizon): Promise<LongMemory[]> {
    const s = await this.store.read();
    const q = query.toLowerCase().trim();
    const terms = q.split(/[^a-z0-9._-]+/i).filter(t => t.length > 2);

    const scope = s.memories.filter(m =>
      m.tenantId === tenantId &&
      (!category || m.category === category) &&
      (!horizon || m.horizon === horizon));

    const matches = (m: LongMemory): boolean => {
      const haystack = `${m.title} ${m.content} ${m.associations.join(" ")}`.toLowerCase();
      // Whole-query match still counts, so exact-phrase callers keep working.
      if (q.length > 0 && haystack.includes(q)) return true;
      return terms.some(term => haystack.includes(term));
    };

    // Rank by how many distinct query terms a memory matches, then by
    // importance. Importance alone answered "what matters in general" rather
    // than "what matters for this question".
    const overlap = (m: LongMemory): number => {
      const haystack = `${m.title} ${m.content} ${m.associations.join(" ")}`.toLowerCase();
      return terms.filter(term => haystack.includes(term)).length;
    };

    return scope
      .filter(matches)
      .sort((a, b) => (overlap(b) - overlap(a)) || (b.importance - a.importance))
      .slice(0, 20);
  }

  /**
   * Merge several memories into one consolidated memory.
   *
   * `consolidatedFrom` is read in two directions: on the merged memory it
   * lists its sources, and on a source it points at the summary that absorbed
   * it. A non-empty value on either side means "already consolidated", which
   * is what keeps `autoConsolidate` idempotent.
   *
   * The consolidated memory is at least as important as its most important
   * source. The previous formula clamped to `1`, silently demoting merged
   * knowledge on the 0..10 scale the rest of the service uses.
   *
   * Sources are not deleted: `consolidatedFrom` records the lineage so a
   * consolidation can be audited or reversed. Pruning them is `decay()`'s job,
   * and it happens only once they have actually decayed.
   */
  async consolidate(memoryIds: string[], title: string, content: string): Promise<LongMemory> {
    return await this.store.mutate(s => {
      const sourceMems = s.memories.filter(m => memoryIds.includes(m.id));
      const maxImportance = sourceMems.reduce((max, m) => Math.max(max, m.importance), 0);
      const m: LongMemory = { id: randomUUID(), tenantId: sourceMems[0]?.tenantId ?? "", category: "semantic", horizon: "long", title, content, importance: Math.min(MAX_IMPORTANCE, maxImportance + 0.1), emotionalWeight: sourceMems.reduce((sum, mem) => sum + mem.emotionalWeight, 0) / (sourceMems.length || 1), associations: [...new Set(sourceMems.flatMap(mem => mem.associations))], accessCount: 0, lastAccessedAt: new Date().toISOString(), decayFactor: 0.001, consolidatedFrom: memoryIds, createdAt: new Date().toISOString() };
      s.memories.push(m);
      return m;
    });
  }

  /**
   * Age every non-permanent memory and prune what has faded to nothing.
   *
   * Returns what it did. The previous signature was `Promise<void>`, so a
   * caller could not tell a run that pruned half the store from a run that
   * touched nothing — which is part of why nothing ever called it.
   *
   * Decay is measured from `lastAccessedAt`, not `createdAt`: a memory that
   * keeps being recalled is being used, however old it is.
   */
  async decay(): Promise<{ aged: number; pruned: number; prunedTitles: string[] }> {
    return await this.store.mutate(s => {
      let aged = 0;
      for (const m of s.memories) {
        if (m.horizon === "permanent") continue;
        const elapsed = (Date.now() - new Date(m.lastAccessedAt).getTime()) / 86400000;
        const before = m.importance;
        m.importance = Math.max(0, m.importance - m.decayFactor * elapsed);
        if (m.importance < before) aged++;
      }
      const doomed = s.memories.filter(m => m.importance <= PRUNE_THRESHOLD && m.horizon !== "permanent");
      s.memories = s.memories.filter(m => m.importance > PRUNE_THRESHOLD || m.horizon === "permanent");
      return { aged, pruned: doomed.length, prunedTitles: doomed.map(m => m.title) };
    });
  }

  async getMemories(tenantId: string, limit = 50): Promise<LongMemory[]> {
    const s = await this.store.read();
    return s.memories.filter(m => m.tenantId === tenantId).sort((a, b) => b.importance - a.importance).slice(0, limit);
  }

  // ═══ P2: Auto Memory Consolidation ═══

  /**
   * Run a full maintenance pass: consolidate, decay, promote.
   *
   * Every number this returns is now an effect that happened, not a condition
   * that was observed. The previous implementation counted memories *matching*
   * promotion and decay criteria and changed nothing:
   *
   *     autoConsolidate() -> { promoted: 1, insights: ["Promoted 'hot' from
   *                            short to long-term (importance: 9)"] }
   *     memory 'hot'.horizon -> still "short"
   *
   * Measured, not inferred. The report claimed a promotion in prose, the store
   * disagreed, and nothing reconciled the two. A maintenance routine that
   * reports work it did not do is worse than one that does nothing, because
   * the caller stops checking.
   */
  async autoConsolidate(tenantId: string): Promise<{
    consolidated: number;
    decayed: number;
    promoted: number;
    pruned: number;
    insights: string[];
  }> {
    const insights: string[] = [];

    // ── Consolidate clusters ──────────────────────────────────────────
    // A memory may belong to several association groups. Consolidating it
    // twice would duplicate the same knowledge under two titles, so each
    // memory is claimed by at most one cluster.
    const s0 = await this.store.read();
    const memories = s0.memories.filter(m => m.tenantId === tenantId);

    const byAssociations: Record<string, LongMemory[]> = {};
    for (const m of memories) {
      // Already-consolidated memories are not re-consolidated: that would
      // build towers of summaries of summaries.
      if (m.consolidatedFrom.length > 0) continue;
      for (const assoc of m.associations ?? []) {
        (byAssociations[assoc] ??= []).push(m);
      }
    }

    let consolidated = 0;
    const claimed = new Set<string>();
    // Largest clusters first, so the strongest grouping wins a contested
    // memory rather than whichever association happened to be enumerated
    // first.
    const clusters = Object.entries(byAssociations)
      .map(([assoc, group]) => ({ assoc, group }))
      .sort((a, b) => b.group.length - a.group.length);

    for (const { assoc, group } of clusters) {
      const available = group.filter(m => !claimed.has(m.id));
      if (available.length < 3) continue;

      const contents = available.map(m => `${m.title}: ${m.content}`).join("\n---\n");
      const ids = available.map(m => m.id);
      try {
        const merged = await this.consolidate(ids, `Consolidated: ${assoc}`, contents);
        // Point each source at the memory that now summarises it. Without this
        // the next maintenance pass re-consolidates the same cluster forever,
        // growing one summary per run: the routine was not idempotent, which a
        // second call proved.
        await this.store.mutate(state => {
          for (const m of state.memories) {
            if (ids.includes(m.id) && m.consolidatedFrom.length === 0) {
              m.consolidatedFrom = [merged.id];
            }
          }
        });
        for (const m of available) claimed.add(m.id);
        consolidated++;
        insights.push(`Consolidated ${available.length} memories about "${assoc}"`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        insights.push(`Failed to consolidate "${assoc}": ${msg}`);
      }
    }

    // ── Promote what has earned it ────────────────────────────────────
    // This is a real mutation now. `decayFactor` moves with the horizon, or a
    // promoted memory would keep ageing at its old short-term rate and fall
    // straight back out.
    let promoted = 0;
    const promotedTitles = await this.store.mutate(state => {
      const titles: string[] = [];
      for (const m of state.memories) {
        if (m.tenantId !== tenantId) continue;
        if (m.horizon === "short" && m.importance >= 7) {
          m.horizon = "long";
          m.decayFactor = 0.001;
          titles.push(m.title);
        }
      }
      return titles;
    });
    promoted = promotedTitles.length;
    for (const title of promotedTitles) {
      insights.push(`Promoted "${title}" from short to long-term`);
    }

    // ── Decay ─────────────────────────────────────────────────────────
    // One definition of decay, applied by one function. The old code had two:
    // `decay()` aged by `decayFactor` from `lastAccessedAt`, while this method
    // counted memories older than 30 days with importance < 3 — a threshold on
    // a different scale, reachable only after ~100 days of actual decay. The
    // two never agreed and neither drove the other.
    const decayResult = await this.decay();
    if (decayResult.pruned > 0) {
      insights.push(`Pruned ${decayResult.pruned} faded memories: ${decayResult.prunedTitles.join(", ")}`);
    }

    return {
      consolidated,
      decayed: decayResult.aged,
      promoted,
      pruned: decayResult.pruned,
      insights,
    };
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const tm = s.memories.filter(m => m.tenantId === tenantId);
    const catDist: Record<string, number> = {};
    for (const m of tm) catDist[m.category] = (catDist[m.category] ?? 0) + 1;
    const horizonDist: Record<string, number> = {};
    for (const m of tm) horizonDist[m.horizon] = (horizonDist[m.horizon] ?? 0) + 1;
    return { totalMemories: tm.length, avgImportance: tm.length ? tm.reduce((sum, m) => sum + m.importance, 0) / tm.length : 0, totalAccesses: tm.reduce((sum, m) => sum + m.accessCount, 0), categoryDistribution: catDist, horizonDistribution: horizonDist, consolidatedCount: tm.filter(m => m.consolidatedFrom.length > 0).length };
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

