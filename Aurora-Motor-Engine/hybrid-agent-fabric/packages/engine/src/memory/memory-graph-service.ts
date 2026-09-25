import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  auroraDigest, auroraIds, auroraInteger, auroraRound, auroraSimilarity, auroraTags, auroraText,
  auroraTimestamp, auroraTokens, auroraUnit, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_MEMORIES = 200_000;
const MAX_RELATIONS = 500_000;
const MAX_ANCHORS = 5_000;
const LAYER_TTL_MS: Partial<Record<MemoryLayer, number>> = { working: 30 * 60_000, session: 24 * 60 * 60_000 };

/** Aurora Memory Pyramid layers L1-L8. `palace` is the long-horizon theory/hypothesis space. */
export type MemoryLayer = "working" | "session" | "episodic" | "semantic" | "procedural" | "user" | "palace";
/** Constitutional requirement: observation, inference, hypothesis and prediction are distinct. */
export type MemoryClaimType = "observation" | "inference" | "hypothesis" | "prediction";
export type MemorySourceType = "user" | "agent" | "event" | "memory" | "system" | "external";
export type MemoryRelationType = "relates" | "causes" | "supports" | "contradicts" | "part-of" | "derived-from" | "precedes";
export type MemoryRecallStrategy = "semantic" | "graph" | "temporal" | "goal" | "user";

/** Aurora Memory Object standard: ID, timestamp, type, source, confidence, importance, tags and relations. */
export interface MemoryObjectRecord {
  id: string;
  tenantId: string;
  layer: MemoryLayer;
  claimType: MemoryClaimType;
  title: string;
  content: string;
  contentDigest: string;
  sourceType: MemorySourceType;
  sourceId?: string;
  sessionId?: string;
  goalIds: string[];
  userId?: string;
  confidence: number;
  importance: number;
  emotionalImpact: number;
  tags: string[];
  validFrom: string;
  validTo?: string;
  state: "active" | "archived" | "superseded";
  supersededById?: string;
  consolidatedFromIds: string[];
  contradictionIds: string[];
  usageCount: number;
  reinforcementCount: number;
  lastAccessedAt?: string;
  lastVerifiedAt?: string;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRelationRecord {
  id: string;
  tenantId: string;
  fromId: string;
  toId: string;
  type: MemoryRelationType;
  strength: number;
  reinforcementCount: number;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ThoughtAnchorFinding {
  summary: string;
  confidence: number;
  memoryIds: string[];
  recordedAt: string;
}

/** Long-term thought anchors let Aurora keep an open problem alive for months or years. */
export interface ThoughtAnchorRecord {
  id: string;
  tenantId: string;
  title: string;
  question: string;
  status: "active" | "paused" | "resolved" | "abandoned";
  importance: number;
  confidence: number;
  nextStep: string;
  memoryIds: string[];
  findings: ThoughtAnchorFinding[];
  reviewIntervalDays: number;
  lastReviewedAt: string;
  nextReviewAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRecallResult {
  memory: MemoryObjectRecord;
  score: number;
  reason: string;
}

export interface MemoryHealthReport {
  tenantId: string;
  total: number;
  byLayer: Record<string, number>;
  byClaimType: Record<string, number>;
  stale: string[];
  contradicted: string[];
  lowUsage: string[];
  lowConfidence: string[];
  expired: string[];
  duplicateClusters: Array<{ digest: string; memoryIds: string[] }>;
  healthScore: number;
  generatedAt: string;
}

export interface MemoryInsightCandidate {
  leftId: string;
  rightId: string;
  sharedTags: string[];
  noveltyScore: number;
  rationale: string;
  suggestedTitle: string;
}

export interface MemoryConsolidationReport {
  tenantId: string;
  layer: MemoryLayer;
  clusters: Array<{ summaryMemoryId: string; sourceMemoryIds: string[]; tags: string[] }>;
  archived: number;
  relationsStrengthened: number;
  generatedAt: string;
}

interface MemoryGraphStateShape {
  schemaVersion: 1;
  memories: MemoryObjectRecord[];
  relations: MemoryRelationRecord[];
  anchors: ThoughtAnchorRecord[];
}

/**
 * Optional semantic index used to upgrade recall from lexical overlap to embedding similarity.
 * Kept as a narrow interface so the memory graph never depends on a specific embedding provider.
 */
export interface MemorySemanticIndex {
  upsert(input: { id: string; tenantId: string; kind: "memory"; text: string; metadata: Record<string, string | number | boolean> }): Promise<unknown>;
  remove(tenantId: string, id: string): Promise<boolean>;
  search(input: { tenantId: string; query: string; kinds?: Array<"memory">; limit?: number }): Promise<Array<{ id: string; score: number; vectorScore: number; lexicalScore: number }>>;
}

/**
 * Aurora Phase C — typed memory pyramid, relation graph with temporal validity, consolidation,
 * contradiction/staleness health and long-term thought anchors.
 *
 * This service never replaces the existing `MemoryStore`: it is the relational/temporal layer above it.
 * Nothing here is auto-promoted into prompts; retrieval remains an explicit, bounded call.
 */
export class MemoryGraphService {
  private readonly store: DurableJsonState<MemoryGraphStateShape>;

  constructor(
    rootPath: string,
    private readonly now: () => number = Date.now,
    private readonly semanticIndex?: MemorySemanticIndex,
  ) {
    this.store = new DurableJsonState<MemoryGraphStateShape>(
      join(rootPath, "memory-graph", "state.json"),
      () => ({ schemaVersion: 1, memories: [], relations: [], anchors: [] }),
      (value) => {
        const state = value as MemoryGraphStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.memories) && Array.isArray(state.relations) && Array.isArray(state.anchors);
      },
      "Aurora memory graph",
    );
  }

  /** Store a memory object. Identical content in the same layer reinforces the existing object instead of duplicating it. */
  async remember(input: {
    tenantId: string;
    layer: MemoryLayer;
    claimType: MemoryClaimType;
    title: string;
    content: string;
    sourceType: MemorySourceType;
    sourceId?: string;
    sessionId?: string;
    userId?: string;
    goalIds?: string[];
    confidence: number;
    importance: number;
    emotionalImpact?: number;
    tags?: string[];
    validFrom?: string;
    validTo?: string;
    evidenceRefs?: string[];
    relatedMemoryIds?: string[];
  }): Promise<MemoryObjectRecord> {
    let indexed: MemoryObjectRecord | undefined;
    const result = await this.store.mutate((state) => {
      if (state.memories.length >= MAX_MEMORIES) throw new Error("Aurora memory limit reached.");
      const timestamp = this.now();
      const nowIso = new Date(timestamp).toISOString();
      const title = auroraText(input.title, 500, "Memory title");
      const content = auroraText(input.content, 100_000, "Memory content");
      const digest = auroraDigest(`${input.layer}:${content}`);
      const existing = state.memories.find((item) => item.tenantId === input.tenantId && item.contentDigest === digest && item.state === "active");
      if (existing) {
        existing.reinforcementCount++;
        existing.importance = Math.max(existing.importance, auroraUnit(input.importance, "Memory importance"));
        existing.confidence = auroraRound(Math.min(1, (existing.confidence * existing.reinforcementCount + auroraUnit(input.confidence, "Memory confidence")) / (existing.reinforcementCount + 1) + 0.02));
        existing.tags = [...new Set([...existing.tags, ...auroraTags(input.tags)])].slice(0, 100);
        existing.updatedAt = nowIso;
        return structuredClone(existing);
      }
      const validFrom = auroraTimestamp(input.validFrom, timestamp, "Memory validFrom");
      const validTo = input.validTo === undefined ? undefined : auroraTimestamp(input.validTo, timestamp, "Memory validTo");
      if (validTo && Date.parse(validTo) <= Date.parse(validFrom)) throw new Error("Memory validTo must follow validFrom.");
      const record: MemoryObjectRecord = {
        id: `mem-${randomUUID()}`,
        tenantId: input.tenantId,
        layer: input.layer,
        claimType: input.claimType,
        title,
        content,
        contentDigest: digest,
        ...(input.sourceId ? { sourceId: auroraText(input.sourceId, 300, "Memory source ID") } : {}),
        sourceType: input.sourceType,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.userId ? { userId: auroraText(input.userId, 200, "Memory user ID") } : {}),
        goalIds: auroraIds(input.goalIds, 50, "Memory goal IDs"),
        confidence: auroraUnit(input.confidence, "Memory confidence"),
        importance: auroraUnit(input.importance, "Memory importance"),
        emotionalImpact: auroraUnit(input.emotionalImpact ?? 0, "Memory emotional impact"),
        tags: auroraTags(input.tags),
        validFrom,
        ...(validTo ? { validTo } : {}),
        state: "active",
        consolidatedFromIds: [],
        contradictionIds: [],
        usageCount: 0,
        reinforcementCount: 0,
        evidenceRefs: auroraIds(input.evidenceRefs, 200, "Memory evidence refs"),
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.memories.push(record);
      indexed = record;
      for (const relatedId of auroraIds(input.relatedMemoryIds, 50, "Related memory IDs")) {
        const target = state.memories.find((item) => item.tenantId === input.tenantId && item.id === relatedId);
        if (!target) continue;
        this.upsertRelation(state, { tenantId: input.tenantId, fromId: record.id, toId: target.id, type: "relates", strength: 0.4, evidenceRefs: [], nowIso });
      }
      return structuredClone(record);
    });
    if (indexed && this.semanticIndex) {
      // Indexing is an optimization: a failing embedding provider must not lose the memory.
      try {
        await this.semanticIndex.upsert({
          id: indexed.id,
          tenantId: indexed.tenantId,
          kind: "memory",
          text: `${indexed.title}\n${indexed.content}\n${indexed.tags.join(" ")}`,
          metadata: { layer: indexed.layer, claimType: indexed.claimType, confidence: indexed.confidence, importance: indexed.importance },
        });
      } catch {
        // ignored: recall falls back to lexical scoring
      }
    }
    return result;
  }

  async get(tenantId: string, id: string): Promise<MemoryObjectRecord> {
    const state = await this.store.read();
    const record = state.memories.find((item) => item.tenantId === tenantId && item.id === id);
    if (!record) throw new Error("Aurora memory not found in tenant.");
    return structuredClone(record);
  }

  async list(tenantId: string, filter?: { layer?: MemoryLayer; claimType?: MemoryClaimType; state?: MemoryObjectRecord["state"]; tag?: string; limit?: number }): Promise<MemoryObjectRecord[]> {
    const state = await this.store.read();
    const limit = filter?.limit ? auroraInteger(filter.limit, 1, 1000, "Memory list limit") : 200;
    return state.memories
      .filter((item) => item.tenantId === tenantId
        && (!filter?.layer || item.layer === filter.layer)
        && (!filter?.claimType || item.claimType === filter.claimType)
        && (!filter?.state || item.state === filter.state)
        && (!filter?.tag || item.tags.includes(filter.tag.trim().toLowerCase())))
      .sort((a, b) => b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((item) => structuredClone(item));
  }

  /** Create or strengthen a typed relation. `contradicts` also records mutual contradiction health flags. */
  async relate(input: { tenantId: string; fromId: string; toId: string; type: MemoryRelationType; strength?: number; evidenceRefs?: string[] }): Promise<MemoryRelationRecord> {
    return await this.store.mutate((state) => {
      if (state.relations.length >= MAX_RELATIONS) throw new Error("Aurora memory relation limit reached.");
      if (input.fromId === input.toId) throw new Error("Aurora memory relation must connect two distinct memories.");
      const from = this.mutableMemory(state, input.tenantId, input.fromId);
      const to = this.mutableMemory(state, input.tenantId, input.toId);
      const nowIso = new Date(this.now()).toISOString();
      const relation = this.upsertRelation(state, {
        tenantId: input.tenantId,
        fromId: from.id,
        toId: to.id,
        type: input.type,
        strength: input.strength === undefined ? 0.5 : auroraUnit(input.strength, "Relation strength"),
        evidenceRefs: auroraIds(input.evidenceRefs, 200, "Relation evidence refs"),
        nowIso,
      });
      if (input.type === "contradicts") {
        if (!from.contradictionIds.includes(to.id)) from.contradictionIds.push(to.id);
        if (!to.contradictionIds.includes(from.id)) to.contradictionIds.push(from.id);
        from.updatedAt = nowIso;
        to.updatedAt = nowIso;
      }
      return structuredClone(relation);
    });
  }

  async relations(tenantId: string, memoryId?: string): Promise<MemoryRelationRecord[]> {
    const state = await this.store.read();
    return state.relations
      .filter((item) => item.tenantId === tenantId && (!memoryId || item.fromId === memoryId || item.toId === memoryId))
      .map((item) => structuredClone(item));
  }

  /** Bounded graph traversal (Knowledge Graph / L7) returning memories and the edges that connected them. */
  async neighborhood(tenantId: string, memoryId: string, depth = 1, limit = 50): Promise<{ memories: MemoryObjectRecord[]; relations: MemoryRelationRecord[] }> {
    const state = await this.store.read();
    const bounds = { depth: auroraInteger(depth, 1, 4, "Graph depth"), limit: auroraInteger(limit, 1, 500, "Graph limit") };
    this.mutableMemory(state, tenantId, memoryId);
    const visited = new Set<string>([memoryId]);
    const edges: MemoryRelationRecord[] = [];
    let frontier = [memoryId];
    for (let level = 0; level < bounds.depth && visited.size < bounds.limit; level++) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const relation of state.relations.filter((item) => item.tenantId === tenantId && (item.fromId === current || item.toId === current))) {
          const other = relation.fromId === current ? relation.toId : relation.fromId;
          if (!edges.some((item) => item.id === relation.id)) edges.push(relation);
          if (!visited.has(other) && visited.size < bounds.limit) {
            visited.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return {
      memories: state.memories.filter((item) => item.tenantId === tenantId && visited.has(item.id)).map((item) => structuredClone(item)),
      relations: edges.map((item) => structuredClone(item)),
    };
  }

  /**
   * Multi-strategy recall: semantic (lexical overlap), graph (relation expansion from seeds),
   * temporal (validity window at a point in time), goal-scoped and user-scoped.
   */
  async recall(tenantId: string, query: string, options?: {
    strategy?: MemoryRecallStrategy;
    layers?: MemoryLayer[];
    claimTypes?: MemoryClaimType[];
    minConfidence?: number;
    goalId?: string;
    userId?: string;
    at?: string;
    seedMemoryId?: string;
    limit?: number;
  }): Promise<MemoryRecallResult[]> {
    const strategy = options?.strategy ?? "semantic";
    const limit = options?.limit ? auroraInteger(options.limit, 1, 100, "Recall limit") : 10;
    const at = options?.at ? Date.parse(auroraTimestamp(options.at, this.now(), "Recall timestamp")) : this.now();
    const minConfidence = options?.minConfidence === undefined ? 0 : auroraUnit(options.minConfidence, "Recall minimum confidence");
    const text = auroraText(query, 2000, "Recall query");
    const seeds = strategy === "graph" && options?.seedMemoryId
      ? new Set((await this.neighborhood(tenantId, options.seedMemoryId, 2, 200)).memories.map((item) => item.id))
      : undefined;
    const accessed: string[] = [];
    const semantic = new Map<string, number>();
    if (this.semanticIndex && (strategy === "semantic" || strategy === "goal" || strategy === "user")) {
      try {
        for (const hit of await this.semanticIndex.search({ tenantId, query: text, kinds: ["memory"], limit: Math.max(limit * 4, 20) })) {
          semantic.set(hit.id, Math.max(0, Math.min(1, hit.score)));
        }
      } catch {
        // ignored: lexical scoring remains authoritative
      }
    }
    const state = await this.store.read();
    const scored = state.memories
      .filter((item) => item.tenantId === tenantId && item.state === "active"
        && item.confidence >= minConfidence
        && (!options?.layers?.length || options.layers.includes(item.layer))
        && (!options?.claimTypes?.length || options.claimTypes.includes(item.claimType))
        && (!options?.goalId || item.goalIds.includes(options.goalId))
        && (!options?.userId || item.userId === options.userId)
        && (strategy !== "temporal" || (Date.parse(item.validFrom) <= at && (!item.validTo || Date.parse(item.validTo) >= at)))
        && (!seeds || seeds.has(item.id)))
      .map((memory) => {
        const lexical = auroraSimilarity(text, `${memory.title} ${memory.content} ${memory.tags.join(" ")}`);
        const ageDays = Math.max(0, (at - Date.parse(memory.createdAt)) / 86_400_000);
        const recency = 1 / (1 + ageDays / 30);
        const graphBoost = seeds ? 0.25 : 0;
        const goalBoost = options?.goalId && memory.goalIds.includes(options.goalId) ? 0.2 : 0;
        const userBoost = options?.userId && memory.userId === options.userId ? 0.2 : 0;
        const temporalBoost = strategy === "temporal" ? 0.2 : 0;
        const vector = semantic.get(memory.id);
        // With a semantic index the lexical weight is shared with embedding similarity, so a
        // paraphrase can be recalled; without one the original lexical behaviour is preserved.
        const relevance = vector === undefined ? lexical : lexical * 0.5 + vector * 0.5;
        const base = relevance * 0.55 + memory.importance * 0.2 + memory.confidence * 0.15 + recency * 0.1;
        return {
          memory,
          score: auroraRound(base + graphBoost + goalBoost + userBoost + temporalBoost),
          reason: `${strategy} recall: lexical=${lexical.toFixed(3)}${vector === undefined ? "" : ` semantic=${vector.toFixed(3)}`} importance=${memory.importance} confidence=${memory.confidence} recency=${recency.toFixed(3)}`,
        };
      })
      .filter((item) => item.score > 0 || strategy !== "semantic")
      .sort((a, b) => b.score - a.score || b.memory.importance - a.memory.importance)
      .slice(0, limit);
    for (const item of scored) accessed.push(item.memory.id);
    if (accessed.length) {
      await this.store.mutate((live) => {
        const nowIso = new Date(this.now()).toISOString();
        for (const id of accessed) {
          const memory = live.memories.find((item) => item.tenantId === tenantId && item.id === id);
          if (!memory) continue;
          memory.usageCount++;
          memory.lastAccessedAt = nowIso;
        }
      });
    }
    return scored.map((item) => ({ ...item, memory: structuredClone(item.memory) }));
  }

  /** Promote a memory between pyramid layers (for example working -> episodic) with an audit trail relation. */
  async promoteLayer(tenantId: string, id: string, layer: MemoryLayer): Promise<MemoryObjectRecord> {
    return await this.store.mutate((state) => {
      const memory = this.mutableMemory(state, tenantId, id);
      if (memory.state !== "active") throw new Error("Only active memories can change layer.");
      memory.layer = layer;
      memory.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(memory);
    });
  }

  /** Replace an outdated memory. The superseded object is retained for provenance and temporal queries. */
  async supersede(tenantId: string, id: string, replacementId: string): Promise<MemoryObjectRecord> {
    return await this.store.mutate((state) => {
      const memory = this.mutableMemory(state, tenantId, id);
      const replacement = this.mutableMemory(state, tenantId, replacementId);
      if (memory.id === replacement.id) throw new Error("A memory cannot supersede itself.");
      const nowIso = new Date(this.now()).toISOString();
      memory.state = "superseded";
      memory.supersededById = replacement.id;
      memory.validTo = memory.validTo ?? nowIso;
      memory.updatedAt = nowIso;
      memory.contradictionIds = memory.contradictionIds.filter((item) => item !== replacement.id);
      replacement.contradictionIds = replacement.contradictionIds.filter((item) => item !== memory.id);
      this.upsertRelation(state, { tenantId, fromId: replacement.id, toId: memory.id, type: "derived-from", strength: 0.9, evidenceRefs: [], nowIso });
      return structuredClone(memory);
    });
  }

  async archive(tenantId: string, id: string): Promise<MemoryObjectRecord> {
    return await this.store.mutate((state) => {
      const memory = this.mutableMemory(state, tenantId, id);
      memory.state = "archived";
      memory.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(memory);
    });
  }

  /** Hard deletion for privacy/consent requests: removes the object and every edge that referenced it. */
  async forget(tenantId: string, id: string): Promise<{ removedMemoryId: string; removedRelations: number }> {
    return await this.store.mutate((state) => {
      const index = state.memories.findIndex((item) => item.tenantId === tenantId && item.id === id);
      if (index < 0) throw new Error("Aurora memory not found in tenant.");
      state.memories.splice(index, 1);
      const before = state.relations.length;
      state.relations = state.relations.filter((item) => !(item.tenantId === tenantId && (item.fromId === id || item.toId === id)));
      for (const memory of state.memories.filter((item) => item.tenantId === tenantId)) {
        memory.contradictionIds = memory.contradictionIds.filter((item) => item !== id);
        memory.consolidatedFromIds = memory.consolidatedFromIds.filter((item) => item !== id);
        if (memory.supersededById === id) delete memory.supersededById;
      }
      for (const anchor of state.anchors.filter((item) => item.tenantId === tenantId)) {
        anchor.memoryIds = anchor.memoryIds.filter((item) => item !== id);
        for (const finding of anchor.findings) finding.memoryIds = finding.memoryIds.filter((item) => item !== id);
      }
      return { removedMemoryId: id, removedRelations: before - state.relations.length };
    }).then(async (outcome) => {
      if (this.semanticIndex) {
        try { await this.semanticIndex.remove(tenantId, id); } catch { /* ignored */ }
      }
      return outcome;
    });
  }

  /**
   * Sleep-like consolidation: near-duplicate memories in one layer are compressed into a single
   * summary object, sources are archived (never silently deleted) and relations are strengthened.
   */
  async consolidate(tenantId: string, options?: { layer?: MemoryLayer; similarityThreshold?: number; minClusterSize?: number; maxClusters?: number }): Promise<MemoryConsolidationReport> {
    const layer = options?.layer ?? "episodic";
    const threshold = options?.similarityThreshold === undefined ? 0.6 : auroraUnit(options.similarityThreshold, "Consolidation threshold");
    const minCluster = auroraInteger(options?.minClusterSize ?? 2, 2, 100, "Consolidation cluster size");
    const maxClusters = auroraInteger(options?.maxClusters ?? 20, 1, 200, "Consolidation cluster limit");
    return await this.store.mutate((state) => {
      const nowIso = new Date(this.now()).toISOString();
      const pool = state.memories.filter((item) => item.tenantId === tenantId && item.layer === layer && item.state === "active");
      const used = new Set<string>();
      const clusters: MemoryConsolidationReport["clusters"] = [];
      let strengthened = 0;
      let archived = 0;
      for (const seed of pool) {
        if (clusters.length >= maxClusters) break;
        if (used.has(seed.id)) continue;
        const group = [seed, ...pool.filter((item) => item.id !== seed.id && !used.has(item.id)
          && auroraSimilarity(`${seed.title} ${seed.content}`, `${item.title} ${item.content}`) >= threshold)];
        if (group.length < minCluster) continue;
        for (const item of group) used.add(item.id);
        const tags = [...new Set(group.flatMap((item) => item.tags))].slice(0, 100);
        const summary: MemoryObjectRecord = {
          id: `mem-${randomUUID()}`,
          tenantId,
          layer: layer === "working" || layer === "session" ? "episodic" : layer,
          claimType: "inference",
          title: `Consolidated: ${seed.title}`.slice(0, 500),
          content: group.map((item) => `- (${item.confidence}) ${item.title}: ${item.content}`).join("\n").slice(0, 100_000),
          contentDigest: auroraDigest(`consolidated:${group.map((item) => item.contentDigest).sort().join("|")}`),
          sourceType: "memory",
          sourceId: seed.id,
          goalIds: [...new Set(group.flatMap((item) => item.goalIds))].slice(0, 50),
          confidence: auroraRound(group.reduce((sum, item) => sum + item.confidence, 0) / group.length),
          importance: auroraRound(Math.max(...group.map((item) => item.importance))),
          emotionalImpact: auroraRound(Math.max(...group.map((item) => item.emotionalImpact))),
          tags,
          validFrom: group.map((item) => item.validFrom).sort()[0] ?? nowIso,
          state: "active",
          consolidatedFromIds: group.map((item) => item.id),
          contradictionIds: [],
          usageCount: 0,
          reinforcementCount: 0,
          evidenceRefs: [...new Set(group.flatMap((item) => item.evidenceRefs))].slice(0, 200),
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        state.memories.push(summary);
        for (const item of group) {
          item.state = "archived";
          item.updatedAt = nowIso;
          archived++;
          this.upsertRelation(state, { tenantId, fromId: summary.id, toId: item.id, type: "derived-from", strength: 0.8, evidenceRefs: [], nowIso });
          for (const relation of state.relations.filter((edge) => edge.tenantId === tenantId && (edge.fromId === item.id || edge.toId === item.id) && edge.type !== "derived-from")) {
            relation.strength = auroraRound(Math.min(1, relation.strength + 0.05));
            relation.reinforcementCount++;
            relation.updatedAt = nowIso;
            strengthened++;
          }
        }
        clusters.push({ summaryMemoryId: summary.id, sourceMemoryIds: group.map((item) => item.id), tags });
      }
      return { tenantId, layer, clusters, archived, relationsStrengthened: strengthened, generatedAt: nowIso };
    });
  }

  /** Expire working/session memories whose lifetime has passed, keeping the pyramid bounded. */
  async sweep(tenantId: string): Promise<{ archived: string[]; expired: string[] }> {
    return await this.store.mutate((state) => {
      const timestamp = this.now();
      const nowIso = new Date(timestamp).toISOString();
      const archivedIds: string[] = [];
      const expiredIds: string[] = [];
      for (const memory of state.memories.filter((item) => item.tenantId === tenantId && item.state === "active")) {
        const ttl = LAYER_TTL_MS[memory.layer];
        if (ttl && timestamp - Date.parse(memory.createdAt) > ttl) {
          memory.state = "archived";
          memory.updatedAt = nowIso;
          archivedIds.push(memory.id);
          continue;
        }
        if (memory.validTo && Date.parse(memory.validTo) < timestamp) {
          memory.state = "archived";
          memory.updatedAt = nowIso;
          expiredIds.push(memory.id);
        }
      }
      return { archived: archivedIds, expired: expiredIds };
    });
  }

  /** Detect contradictions between active claims that share tags but assert opposite polarity. */
  async detectContradictions(tenantId: string, options?: { similarityThreshold?: number }): Promise<Array<{ leftId: string; rightId: string; similarity: number; reason: string }>> {
    const threshold = options?.similarityThreshold === undefined ? 0.45 : auroraUnit(options.similarityThreshold, "Contradiction threshold");
    return await this.store.mutate((state) => {
      const nowIso = new Date(this.now()).toISOString();
      const pool = state.memories.filter((item) => item.tenantId === tenantId && item.state === "active");
      const found: Array<{ leftId: string; rightId: string; similarity: number; reason: string }> = [];
      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          const left = pool[i]!;
          const right = pool[j]!;
          const similarity = auroraSimilarity(`${left.title} ${left.content}`, `${right.title} ${right.content}`);
          if (similarity < threshold) continue;
          const polarityLeft = negationScore(left.content);
          const polarityRight = negationScore(right.content);
          const overlappingValidity = (!left.validTo || Date.parse(left.validTo) > Date.parse(right.validFrom))
            && (!right.validTo || Date.parse(right.validTo) > Date.parse(left.validFrom));
          if (polarityLeft === polarityRight || !overlappingValidity) continue;
          if (!left.contradictionIds.includes(right.id)) left.contradictionIds.push(right.id);
          if (!right.contradictionIds.includes(left.id)) right.contradictionIds.push(left.id);
          left.updatedAt = nowIso;
          right.updatedAt = nowIso;
          this.upsertRelation(state, { tenantId, fromId: left.id, toId: right.id, type: "contradicts", strength: auroraRound(similarity), evidenceRefs: [], nowIso });
          found.push({ leftId: left.id, rightId: right.id, similarity, reason: "Overlapping validity with opposite polarity." });
        }
      }
      return found;
    });
  }

  /**
   * Dream Mode concept formation: find distant-but-related memories that share tags yet have never
   * been connected, and propose them as insight candidates. Nothing is written until the caller
   * materializes a candidate, so creative association can never quietly become a stored fact.
   */
  async proposeInsights(tenantId: string, options?: { minSharedTags?: number; minImportance?: number; limit?: number }): Promise<MemoryInsightCandidate[]> {
    const minShared = auroraInteger(options?.minSharedTags ?? 1, 1, 20, "Insight shared-tag minimum");
    const minImportance = options?.minImportance === undefined ? 0.3 : auroraUnit(options.minImportance, "Insight importance minimum");
    const limit = auroraInteger(options?.limit ?? 10, 1, 100, "Insight limit");
    const state = await this.store.read();
    const pool = state.memories.filter((item) => item.tenantId === tenantId && item.state === "active" && item.importance >= minImportance && item.tags.length > 0);
    const connected = new Set(state.relations.filter((item) => item.tenantId === tenantId).map((item) => [item.fromId, item.toId].sort().join("::")));
    const candidates: MemoryInsightCandidate[] = [];
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const left = pool[i]!;
        const right = pool[j]!;
        if (connected.has([left.id, right.id].sort().join("::"))) continue;
        const shared = left.tags.filter((tag) => right.tags.includes(tag));
        if (shared.length < minShared) continue;
        const union = new Set([...left.tags, ...right.tags]).size;
        const overlap = shared.length / union;
        // Distance: different layers or claim types mean the connection crosses a knowledge boundary.
        const distance = (left.layer === right.layer ? 0.5 : 1) * (left.claimType === right.claimType ? 0.8 : 1.1);
        const lexical = 1 - auroraSimilarity(`${left.title} ${left.content}`, `${right.title} ${right.content}`);
        const novelty = auroraRound(overlap * distance * lexical * ((left.importance + right.importance) / 2));
        if (novelty <= 0) continue;
        candidates.push({
          leftId: left.id,
          rightId: right.id,
          sharedTags: shared,
          noveltyScore: novelty,
          rationale: `Shared tags [${shared.join(", ")}] across ${left.layer}/${left.claimType} and ${right.layer}/${right.claimType} with low textual overlap.`,
          suggestedTitle: `Connection: ${left.title} <-> ${right.title}`.slice(0, 300),
        });
      }
    }
    return candidates.sort((a, b) => b.noveltyScore - a.noveltyScore).slice(0, limit);
  }

  /** Materialize an insight candidate as a palace-layer hypothesis linked to both sources. */
  async materializeInsight(input: { tenantId: string; leftId: string; rightId: string; title: string; content: string; confidence?: number; importance?: number; tags?: string[] }): Promise<MemoryObjectRecord> {
    const left = await this.get(input.tenantId, input.leftId);
    const right = await this.get(input.tenantId, input.rightId);
    const insight = await this.remember({
      tenantId: input.tenantId,
      layer: "palace",
      claimType: "hypothesis",
      title: input.title,
      content: input.content,
      sourceType: "memory",
      sourceId: left.id,
      confidence: input.confidence ?? 0.3,
      importance: input.importance ?? Math.max(left.importance, right.importance),
      tags: input.tags ?? [...new Set([...left.tags, ...right.tags])].slice(0, 100),
      evidenceRefs: [...new Set([...left.evidenceRefs, ...right.evidenceRefs])].slice(0, 200),
    });
    await this.relate({ tenantId: input.tenantId, fromId: insight.id, toId: left.id, type: "derived-from", strength: 0.6 });
    await this.relate({ tenantId: input.tenantId, fromId: insight.id, toId: right.id, type: "derived-from", strength: 0.6 });
    // The insight asserts the connection itself, so the source pair is no longer an open candidate.
    await this.relate({ tenantId: input.tenantId, fromId: left.id, toId: right.id, type: "relates", strength: 0.5, evidenceRefs: [insight.id] });
    return insight;
  }

  async health(tenantId: string): Promise<MemoryHealthReport> {
    const state = await this.store.read();
    const timestamp = this.now();
    const memories = state.memories.filter((item) => item.tenantId === tenantId);
    const active = memories.filter((item) => item.state === "active");
    const byLayer: Record<string, number> = {};
    const byClaimType: Record<string, number> = {};
    for (const memory of memories) {
      byLayer[memory.layer] = (byLayer[memory.layer] ?? 0) + 1;
      byClaimType[memory.claimType] = (byClaimType[memory.claimType] ?? 0) + 1;
    }
    const stale = active.filter((item) => timestamp - Date.parse(item.lastAccessedAt ?? item.createdAt) > 90 * 86_400_000).map((item) => item.id);
    const contradicted = active.filter((item) => item.contradictionIds.length > 0).map((item) => item.id);
    const lowUsage = active.filter((item) => item.usageCount === 0 && timestamp - Date.parse(item.createdAt) > 30 * 86_400_000).map((item) => item.id);
    const lowConfidence = active.filter((item) => item.confidence < 0.35).map((item) => item.id);
    const expired = active.filter((item) => item.validTo && Date.parse(item.validTo) < timestamp).map((item) => item.id);
    const digestGroups = new Map<string, string[]>();
    for (const memory of active) digestGroups.set(memory.contentDigest, [...(digestGroups.get(memory.contentDigest) ?? []), memory.id]);
    const duplicateClusters = [...digestGroups.entries()].filter(([, ids]) => ids.length > 1).map(([digest, memoryIds]) => ({ digest, memoryIds }));
    const penalties = active.length
      ? (stale.length * 0.25 + contradicted.length * 0.35 + lowUsage.length * 0.15 + lowConfidence.length * 0.15 + expired.length * 0.2 + duplicateClusters.length * 0.3) / active.length
      : 0;
    return {
      tenantId,
      total: memories.length,
      byLayer,
      byClaimType,
      stale,
      contradicted,
      lowUsage,
      lowConfidence,
      expired,
      duplicateClusters,
      healthScore: auroraRound(Math.max(0, Math.min(1, 1 - penalties))),
      generatedAt: new Date(timestamp).toISOString(),
    };
  }

  async createAnchor(input: { tenantId: string; title: string; question: string; importance: number; confidence?: number; nextStep: string; reviewIntervalDays?: number; memoryIds?: string[] }): Promise<ThoughtAnchorRecord> {
    return await this.store.mutate((state) => {
      if (state.anchors.length >= MAX_ANCHORS) throw new Error("Aurora thought anchor limit reached.");
      const timestamp = this.now();
      const nowIso = new Date(timestamp).toISOString();
      const interval = auroraInteger(input.reviewIntervalDays ?? 7, 1, 365, "Anchor review interval");
      const anchor: ThoughtAnchorRecord = {
        id: `anchor-${randomUUID()}`,
        tenantId: input.tenantId,
        title: auroraText(input.title, 300, "Anchor title"),
        question: auroraText(input.question, 5000, "Anchor question"),
        status: "active",
        importance: auroraUnit(input.importance, "Anchor importance"),
        confidence: auroraUnit(input.confidence ?? 0.3, "Anchor confidence"),
        nextStep: auroraText(input.nextStep, 2000, "Anchor next step"),
        memoryIds: auroraIds(input.memoryIds, 500, "Anchor memory IDs"),
        findings: [],
        reviewIntervalDays: interval,
        lastReviewedAt: nowIso,
        nextReviewAt: new Date(timestamp + interval * 86_400_000).toISOString(),
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.anchors.push(anchor);
      return structuredClone(anchor);
    });
  }

  /** Record progress on a long-horizon problem; findings never overwrite each other. */
  async recordAnchorProgress(input: { tenantId: string; anchorId: string; summary: string; confidence: number; memoryIds?: string[]; nextStep?: string; status?: ThoughtAnchorRecord["status"] }): Promise<ThoughtAnchorRecord> {
    return await this.store.mutate((state) => {
      const anchor = state.anchors.find((item) => item.tenantId === input.tenantId && item.id === input.anchorId);
      if (!anchor) throw new Error("Aurora thought anchor not found in tenant.");
      const timestamp = this.now();
      const nowIso = new Date(timestamp).toISOString();
      anchor.findings.push({
        summary: auroraText(input.summary, 10_000, "Anchor finding"),
        confidence: auroraUnit(input.confidence, "Anchor finding confidence"),
        memoryIds: auroraIds(input.memoryIds, 200, "Anchor finding memory IDs"),
        recordedAt: nowIso,
      });
      if (anchor.findings.length > 500) anchor.findings.splice(0, anchor.findings.length - 500);
      anchor.memoryIds = [...new Set([...anchor.memoryIds, ...auroraIds(input.memoryIds, 200, "Anchor memory IDs")])].slice(0, 500);
      if (input.nextStep) anchor.nextStep = auroraText(input.nextStep, 2000, "Anchor next step");
      if (input.status) anchor.status = input.status;
      anchor.confidence = auroraRound(anchor.findings.reduce((sum, item) => sum + item.confidence, 0) / anchor.findings.length);
      anchor.lastReviewedAt = nowIso;
      anchor.nextReviewAt = new Date(timestamp + anchor.reviewIntervalDays * 86_400_000).toISOString();
      anchor.updatedAt = nowIso;
      return structuredClone(anchor);
    });
  }

  async anchors(tenantId: string, status?: ThoughtAnchorRecord["status"]): Promise<ThoughtAnchorRecord[]> {
    const state = await this.store.read();
    return state.anchors
      .filter((item) => item.tenantId === tenantId && (!status || item.status === status))
      .sort((a, b) => b.importance - a.importance || a.nextReviewAt.localeCompare(b.nextReviewAt))
      .map((item) => structuredClone(item));
  }

  /** Anchors whose review window has elapsed; the Thought Loop uses this to resume long-term problems. */
  async dueAnchors(tenantId: string): Promise<ThoughtAnchorRecord[]> {
    const state = await this.store.read();
    const timestamp = this.now();
    return state.anchors
      .filter((item) => item.tenantId === tenantId && item.status === "active" && Date.parse(item.nextReviewAt) <= timestamp)
      .sort((a, b) => b.importance - a.importance)
      .map((item) => structuredClone(item));
  }

  /** Verify a memory — updates lastVerifiedAt and confidence. */
  async verifyMemory(tenantId: string, memoryId: string, confirmed: boolean): Promise<MemoryObjectRecord> {
    return await this.store.mutate(state => {
      const memory = this.mutableMemory(state, tenantId, memoryId);
      const nowIso = new Date(this.now()).toISOString();
      memory.lastVerifiedAt = nowIso;
      if (confirmed) {
        memory.confidence = auroraRound(Math.min(1, memory.confidence + 0.1));
      } else {
        memory.confidence = auroraRound(Math.max(0, memory.confidence - 0.2));
      }
      memory.updatedAt = nowIso;
      return structuredClone(memory);
    });
  }

  /** Get unverified memories for a tenant. */
  async getUnverified(tenantId: string, limit = 20): Promise<MemoryObjectRecord[]> {
    const state = await this.store.read();
    return state.memories
      .filter((item) => item.tenantId === tenantId && item.state === "active" && !item.lastVerifiedAt)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit)
      .map((item) => structuredClone(item));
  }

  private upsertRelation(state: MemoryGraphStateShape, input: { tenantId: string; fromId: string; toId: string; type: MemoryRelationType; strength: number; evidenceRefs: string[]; nowIso: string }): MemoryRelationRecord {
    const existing = state.relations.find((item) => item.tenantId === input.tenantId && item.type === input.type
      && ((item.fromId === input.fromId && item.toId === input.toId) || (item.fromId === input.toId && item.toId === input.fromId)));
    if (existing) {
      existing.strength = auroraRound(Math.min(1, Math.max(existing.strength, input.strength) + 0.05));
      existing.reinforcementCount++;
      existing.evidenceRefs = [...new Set([...existing.evidenceRefs, ...input.evidenceRefs])].slice(0, 200);
      existing.updatedAt = input.nowIso;
      return existing;
    }
    const relation: MemoryRelationRecord = {
      id: `rel-${randomUUID()}`,
      tenantId: input.tenantId,
      fromId: input.fromId,
      toId: input.toId,
      type: input.type,
      strength: input.strength,
      reinforcementCount: 0,
      evidenceRefs: input.evidenceRefs,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    };
    state.relations.push(relation);
    return relation;
  }

  private mutableMemory(state: MemoryGraphStateShape, tenantId: string, id: string): MemoryObjectRecord {
    const memory = state.memories.find((item) => item.tenantId === tenantId && item.id === id);
    if (!memory) throw new Error("Aurora memory not found in tenant.");
    return memory;
  }
}

const NEGATIONS = ["not", "no", "never", "cannot", "can't", "won't", "isn't", "aren't", "doesn't", "without", "değil", "yok", "olmaz", "hayır"];
function negationScore(content: string): boolean {
  const tokens = auroraTokens(content);
  return tokens.some((token) => NEGATIONS.includes(token));
}
