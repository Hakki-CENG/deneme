import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  auroraIds, auroraInteger, auroraRound, auroraSimilarity, auroraTags, auroraText, auroraTimestamp,
  auroraUnit, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_ENTITIES = 100_000;
const MAX_STATES = 500_000;
const MAX_RELATIONS = 200_000;
const MAX_EVENTS = 200_000;
const MAX_LINKS = 50_000;
const MAX_PREDICTIONS = 100_000;

export type WorldEntityType =
  | "person" | "place" | "project" | "file" | "task" | "tool" | "website" | "model"
  | "organization" | "document" | "device" | "service" | "concept" | "goal";
/** Sub-models from the PDF: personal, environment, digital, project, human and goal world models. */
export type WorldScope = "personal" | "environment" | "digital" | "project" | "human" | "goal" | "general";
export type WorldClaimType = "observation" | "inference" | "hypothesis" | "prediction";
export type WorldSourceType = "user" | "agent" | "event" | "memory" | "system" | "external";

export interface WorldEntity {
  id: string;
  tenantId: string;
  type: WorldEntityType;
  scope: WorldScope;
  name: string;
  attributes: Record<string, string | number | boolean>;
  confidence: number;
  importance: number;
  tags: string[];
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface WorldStateFact {
  id: string;
  tenantId: string;
  entityId: string;
  key: string;
  value: string;
  claimType: WorldClaimType;
  sourceType: WorldSourceType;
  sourceId?: string;
  confidence: number;
  observedAt: string;
  validFrom: string;
  validTo?: string;
  supersededById?: string;
  evidenceRefs: string[];
  createdAt: string;
}

export interface WorldRelation {
  id: string;
  tenantId: string;
  fromEntityId: string;
  toEntityId: string;
  type: string;
  strength: number;
  confidence: number;
  validFrom: string;
  validTo?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorldEvent {
  id: string;
  tenantId: string;
  entityIds: string[];
  summary: string;
  detail?: string;
  occurredAt: string;
  sourceType: WorldSourceType;
  sourceId?: string;
  confidence: number;
  importance: number;
  userRelevance: number;
  tags: string[];
  createdAt: string;
}

/** Cause -> effect assertion with an evidence-driven strength that is updated by real outcomes. */
export interface WorldCausalLink {
  id: string;
  tenantId: string;
  causeKind: "event" | "state";
  causeRef: string;
  effectKind: "event" | "state";
  effectRef: string;
  description: string;
  strength: number;
  confidence: number;
  confirmations: number;
  refutations: number;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorldPrediction {
  id: string;
  tenantId: string;
  statement: string;
  entityId?: string;
  probability: number;
  horizonAt: string;
  basisLinkIds: string[];
  basisStateIds: string[];
  status: "open" | "resolved" | "expired";
  outcome?: boolean;
  brierScore?: number;
  resolvedAt: string | undefined;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorldCalibration {
  tenantId: string;
  resolved: number;
  correct: number;
  accuracy: number;
  brierMean: number;
  buckets: Array<{ bucket: string; predicted: number; observed: number; count: number }>;
  generatedAt: string;
}

export interface WorldInconsistency {
  entityId: string;
  key: string;
  conflicting: Array<{ stateId: string; value: string; confidence: number; claimType: WorldClaimType; observedAt: string }>;
  recommendation: string;
}

export interface WorldSimulationStep {
  depth: number;
  linkId: string;
  description: string;
  targetKind: "event" | "state";
  targetRef: string;
  probability: number;
}

export interface WorldSimulationResult {
  id: string;
  tenantId: string;
  mode: "simulation" | "counterfactual";
  premise: string;
  steps: WorldSimulationStep[];
  terminalProbability: number;
  uncertainty: number;
  notes: string[];
  generatedAt: string;
}

interface WorldModelStateShape {
  schemaVersion: 1;
  entities: WorldEntity[];
  states: WorldStateFact[];
  relations: WorldRelation[];
  events: WorldEvent[];
  links: WorldCausalLink[];
  predictions: WorldPrediction[];
}

/**
 * Aurora Phase D — Entity -> State -> Relation -> Event -> Outcome world representation with
 * causality, temporal validity, prediction calibration, consistency checks and bounded simulation.
 *
 * Everything is confidence-scored and typed by claim kind, so an inference is never silently
 * promoted to an observation.
 */
export class WorldModelService {
  private readonly store: DurableJsonState<WorldModelStateShape>;

  constructor(rootPath: string, private readonly now: () => number = Date.now) {
    this.store = new DurableJsonState<WorldModelStateShape>(
      join(rootPath, "world-model", "state.json"),
      () => ({ schemaVersion: 1, entities: [], states: [], relations: [], events: [], links: [], predictions: [] }),
      (value) => {
        const state = value as WorldModelStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.entities) && Array.isArray(state.states)
          && Array.isArray(state.relations) && Array.isArray(state.events) && Array.isArray(state.links) && Array.isArray(state.predictions);
      },
      "Aurora world model",
    );
  }

  async upsertEntity(input: { tenantId: string; type: WorldEntityType; name: string; scope?: WorldScope; attributes?: Record<string, string | number | boolean>; confidence?: number; importance?: number; tags?: string[] }): Promise<WorldEntity> {
    return await this.store.mutate((state) => {
      const nowIso = new Date(this.now()).toISOString();
      const name = auroraText(input.name, 300, "Entity name");
      const attributes = boundedAttributes(input.attributes);
      const existing = state.entities.find((item) => item.tenantId === input.tenantId && item.type === input.type && item.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        existing.attributes = { ...existing.attributes, ...attributes };
        if (input.scope) existing.scope = input.scope;
        if (input.confidence !== undefined) existing.confidence = auroraUnit(input.confidence, "Entity confidence");
        if (input.importance !== undefined) existing.importance = auroraUnit(input.importance, "Entity importance");
        existing.tags = [...new Set([...existing.tags, ...auroraTags(input.tags)])].slice(0, 100);
        existing.updatedAt = nowIso;
        return structuredClone(existing);
      }
      if (state.entities.length >= MAX_ENTITIES) throw new Error("World entity limit reached.");
      const entity: WorldEntity = {
        id: `ent-${randomUUID()}`,
        tenantId: input.tenantId,
        type: input.type,
        scope: input.scope ?? "general",
        name,
        attributes,
        confidence: auroraUnit(input.confidence ?? 0.7, "Entity confidence"),
        importance: auroraUnit(input.importance ?? 0.5, "Entity importance"),
        tags: auroraTags(input.tags),
        status: "active",
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.entities.push(entity);
      return structuredClone(entity);
    });
  }

  async entities(tenantId: string, filter?: { scope?: WorldScope; type?: WorldEntityType; status?: WorldEntity["status"] }): Promise<WorldEntity[]> {
    const state = await this.store.read();
    return state.entities
      .filter((item) => item.tenantId === tenantId && (!filter?.scope || item.scope === filter.scope) && (!filter?.type || item.type === filter.type) && (!filter?.status || item.status === filter.status))
      .sort((a, b) => b.importance - a.importance || a.name.localeCompare(b.name))
      .map((item) => structuredClone(item));
  }

  async archiveEntity(tenantId: string, entityId: string): Promise<WorldEntity> {
    return await this.store.mutate((state) => {
      const entity = this.mutableEntity(state, tenantId, entityId);
      entity.status = "archived";
      entity.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(entity);
    });
  }

  /** Record a state fact. A new value for the same key closes the previous temporal record. */
  async recordState(input: {
    tenantId: string; entityId: string; key: string; value: string; claimType?: WorldClaimType;
    sourceType: WorldSourceType; sourceId?: string; confidence: number; observedAt?: string; validTo?: string; evidenceRefs?: string[];
  }): Promise<WorldStateFact> {
    return await this.store.mutate((state) => {
      if (state.states.length >= MAX_STATES) throw new Error("World state limit reached.");
      const entity = this.mutableEntity(state, input.tenantId, input.entityId);
      const timestamp = this.now();
      const nowIso = new Date(timestamp).toISOString();
      const key = auroraText(input.key, 200, "State key").toLowerCase();
      const value = auroraText(input.value, 5000, "State value");
      const observedAt = auroraTimestamp(input.observedAt, timestamp, "State observedAt");
      const claimType = input.claimType ?? "observation";
      const fact: WorldStateFact = {
        id: `st-${randomUUID()}`,
        tenantId: input.tenantId,
        entityId: entity.id,
        key,
        value,
        claimType,
        sourceType: input.sourceType,
        ...(input.sourceId ? { sourceId: auroraText(input.sourceId, 300, "State source ID") } : {}),
        confidence: auroraUnit(input.confidence, "State confidence"),
        observedAt,
        validFrom: observedAt,
        ...(input.validTo ? { validTo: auroraTimestamp(input.validTo, timestamp, "State validTo") } : {}),
        evidenceRefs: auroraIds(input.evidenceRefs, 200, "State evidence refs"),
        createdAt: nowIso,
      };
      const previous = state.states
        .filter((item) => item.tenantId === input.tenantId && item.entityId === entity.id && item.key === key && !item.validTo && !item.supersededById)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
      if (previous && previous.value !== value) {
        previous.validTo = observedAt;
        previous.supersededById = fact.id;
      }
      state.states.push(fact);
      entity.updatedAt = nowIso;
      return structuredClone(fact);
    });
  }

  /** Temporal query: the believed state of an entity at a point in time (default: now). */
  async stateAt(tenantId: string, entityId: string, at?: string): Promise<Record<string, WorldStateFact>> {
    const state = await this.store.read();
    const timestamp = at ? Date.parse(auroraTimestamp(at, this.now(), "State query time")) : this.now();
    const result: Record<string, WorldStateFact> = {};
    for (const fact of state.states.filter((item) => item.tenantId === tenantId && item.entityId === entityId)) {
      if (Date.parse(fact.validFrom) > timestamp) continue;
      if (fact.validTo && Date.parse(fact.validTo) <= timestamp) continue;
      const current = result[fact.key];
      if (!current || current.observedAt < fact.observedAt || (current.observedAt === fact.observedAt && current.confidence < fact.confidence)) result[fact.key] = structuredClone(fact);
    }
    return result;
  }

  /** Past / present / future view of an entity, including open predictions that target it. */
  async temporalView(tenantId: string, entityId: string): Promise<{ past: WorldStateFact[]; present: Record<string, WorldStateFact>; future: WorldPrediction[] }> {
    const state = await this.store.read();
    const timestamp = this.now();
    return {
      past: state.states
        .filter((item) => item.tenantId === tenantId && item.entityId === entityId && item.validTo && Date.parse(item.validTo) <= timestamp)
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
        .map((item) => structuredClone(item)),
      present: await this.stateAt(tenantId, entityId),
      future: state.predictions
        .filter((item) => item.tenantId === tenantId && item.entityId === entityId && item.status === "open")
        .sort((a, b) => a.horizonAt.localeCompare(b.horizonAt))
        .map((item) => structuredClone(item)),
    };
  }

  async relate(input: { tenantId: string; fromEntityId: string; toEntityId: string; type: string; strength?: number; confidence?: number; validTo?: string }): Promise<WorldRelation> {
    return await this.store.mutate((state) => {
      if (state.relations.length >= MAX_RELATIONS) throw new Error("World relation limit reached.");
      const from = this.mutableEntity(state, input.tenantId, input.fromEntityId);
      const to = this.mutableEntity(state, input.tenantId, input.toEntityId);
      if (from.id === to.id) throw new Error("World relation must connect two distinct entities.");
      const nowIso = new Date(this.now()).toISOString();
      const type = auroraText(input.type, 100, "Relation type").toLowerCase();
      const existing = state.relations.find((item) => item.tenantId === input.tenantId && item.fromEntityId === from.id && item.toEntityId === to.id && item.type === type && !item.validTo);
      if (existing) {
        existing.strength = auroraRound(Math.min(1, existing.strength + 0.05));
        if (input.confidence !== undefined) existing.confidence = auroraUnit(input.confidence, "Relation confidence");
        if (input.validTo) existing.validTo = auroraTimestamp(input.validTo, this.now(), "Relation validTo");
        existing.updatedAt = nowIso;
        return structuredClone(existing);
      }
      const relation: WorldRelation = {
        id: `wrel-${randomUUID()}`,
        tenantId: input.tenantId,
        fromEntityId: from.id,
        toEntityId: to.id,
        type,
        strength: input.strength === undefined ? 0.5 : auroraUnit(input.strength, "Relation strength"),
        confidence: input.confidence === undefined ? 0.7 : auroraUnit(input.confidence, "Relation confidence"),
        validFrom: nowIso,
        ...(input.validTo ? { validTo: auroraTimestamp(input.validTo, this.now(), "Relation validTo") } : {}),
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.relations.push(relation);
      return structuredClone(relation);
    });
  }

  async recordEvent(input: {
    tenantId: string; entityIds?: string[]; summary: string; detail?: string; occurredAt?: string;
    sourceType: WorldSourceType; sourceId?: string; confidence: number; importance?: number; userRelevance?: number; tags?: string[];
  }): Promise<WorldEvent> {
    return await this.store.mutate((state) => {
      if (state.events.length >= MAX_EVENTS) throw new Error("World event limit reached.");
      const timestamp = this.now();
      const nowIso = new Date(timestamp).toISOString();
      const entityIds = auroraIds(input.entityIds, 50, "Event entity IDs");
      for (const id of entityIds) this.mutableEntity(state, input.tenantId, id);
      const event: WorldEvent = {
        id: `evt-${randomUUID()}`,
        tenantId: input.tenantId,
        entityIds,
        summary: auroraText(input.summary, 1000, "Event summary"),
        ...(input.detail ? { detail: auroraText(input.detail, 20_000, "Event detail") } : {}),
        occurredAt: auroraTimestamp(input.occurredAt, timestamp, "Event occurredAt"),
        sourceType: input.sourceType,
        ...(input.sourceId ? { sourceId: auroraText(input.sourceId, 300, "Event source ID") } : {}),
        confidence: auroraUnit(input.confidence, "Event confidence"),
        importance: auroraUnit(input.importance ?? 0.5, "Event importance"),
        userRelevance: auroraUnit(input.userRelevance ?? 0.5, "Event user relevance"),
        tags: auroraTags(input.tags),
        createdAt: nowIso,
      };
      state.events.push(event);
      return structuredClone(event);
    });
  }

  async events(tenantId: string, limit = 100): Promise<WorldEvent[]> {
    const state = await this.store.read();
    return state.events
      .filter((item) => item.tenantId === tenantId)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, auroraInteger(limit, 1, 1000, "Event limit"))
      .map((item) => structuredClone(item));
  }

  async assertCausality(input: {
    tenantId: string; causeKind: "event" | "state"; causeRef: string; effectKind: "event" | "state"; effectRef: string;
    description: string; strength?: number; confidence?: number; evidenceRefs?: string[];
  }): Promise<WorldCausalLink> {
    return await this.store.mutate((state) => {
      if (state.links.length >= MAX_LINKS) throw new Error("World causal link limit reached.");
      this.requireRef(state, input.tenantId, input.causeKind, input.causeRef);
      this.requireRef(state, input.tenantId, input.effectKind, input.effectRef);
      const nowIso = new Date(this.now()).toISOString();
      const existing = state.links.find((item) => item.tenantId === input.tenantId && item.causeRef === input.causeRef && item.effectRef === input.effectRef);
      if (existing) {
        existing.strength = auroraRound(Math.min(1, existing.strength + 0.05));
        existing.updatedAt = nowIso;
        return structuredClone(existing);
      }
      const link: WorldCausalLink = {
        id: `cause-${randomUUID()}`,
        tenantId: input.tenantId,
        causeKind: input.causeKind,
        causeRef: input.causeRef,
        effectKind: input.effectKind,
        effectRef: input.effectRef,
        description: auroraText(input.description, 2000, "Causal description"),
        strength: input.strength === undefined ? 0.5 : auroraUnit(input.strength, "Causal strength"),
        confidence: input.confidence === undefined ? 0.5 : auroraUnit(input.confidence, "Causal confidence"),
        confirmations: 0,
        refutations: 0,
        evidenceRefs: auroraIds(input.evidenceRefs, 200, "Causal evidence refs"),
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.links.push(link);
      return structuredClone(link);
    });
  }

  /** Reality feedback for a causal assertion; confidence is recomputed from confirmations vs refutations. */
  async recordCausalObservation(tenantId: string, linkId: string, confirmed: boolean, evidenceRefs?: string[]): Promise<WorldCausalLink> {
    return await this.store.mutate((state) => {
      const link = state.links.find((item) => item.tenantId === tenantId && item.id === linkId);
      if (!link) throw new Error("World causal link not found in tenant.");
      if (confirmed) link.confirmations++; else link.refutations++;
      const total = link.confirmations + link.refutations;
      link.confidence = auroraRound((link.confirmations + 1) / (total + 2));
      link.strength = auroraRound(Math.max(0, Math.min(1, link.strength + (confirmed ? 0.05 : -0.1))));
      link.evidenceRefs = [...new Set([...link.evidenceRefs, ...auroraIds(evidenceRefs, 200, "Causal evidence refs")])].slice(0, 200);
      link.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(link);
    });
  }

  async causalLinks(tenantId: string): Promise<WorldCausalLink[]> {
    const state = await this.store.read();
    return state.links.filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item));
  }

  async predict(input: { tenantId: string; statement: string; probability: number; horizonAt: string; entityId?: string; basisLinkIds?: string[]; basisStateIds?: string[] }): Promise<WorldPrediction> {
    return await this.store.mutate((state) => {
      if (state.predictions.length >= MAX_PREDICTIONS) throw new Error("World prediction limit reached.");
      const timestamp = this.now();
      const nowIso = new Date(timestamp).toISOString();
      const horizonAt = auroraTimestamp(input.horizonAt, timestamp, "Prediction horizon");
      if (Date.parse(horizonAt) <= timestamp) throw new Error("Prediction horizon must be in the future.");
      if (input.entityId) this.mutableEntity(state, input.tenantId, input.entityId);
      const prediction: WorldPrediction = {
        id: `pred-${randomUUID()}`,
        tenantId: input.tenantId,
        statement: auroraText(input.statement, 2000, "Prediction statement"),
        ...(input.entityId ? { entityId: input.entityId } : {}),
        probability: auroraUnit(input.probability, "Prediction probability"),
        horizonAt,
        basisLinkIds: auroraIds(input.basisLinkIds, 100, "Prediction basis links"),
        basisStateIds: auroraIds(input.basisStateIds, 100, "Prediction basis states"),
        status: "open",
        resolvedAt: undefined,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.predictions.push(prediction);
      return structuredClone(prediction);
    });
  }

  /** Reality alignment: resolve a prediction, score it with Brier loss and feed the causal basis back. */
  async resolvePrediction(tenantId: string, predictionId: string, outcome: boolean, note?: string): Promise<WorldPrediction> {
    return await this.store.mutate((state) => {
      const prediction = state.predictions.find((item) => item.tenantId === tenantId && item.id === predictionId);
      if (!prediction) throw new Error("World prediction not found in tenant.");
      if (prediction.status !== "open") throw new Error("World prediction is already resolved.");
      const nowIso = new Date(this.now()).toISOString();
      prediction.status = "resolved";
      prediction.outcome = outcome;
      prediction.brierScore = auroraRound((prediction.probability - (outcome ? 1 : 0)) ** 2);
      prediction.resolvedAt = nowIso;
      if (note) prediction.note = auroraText(note, 2000, "Prediction note");
      prediction.updatedAt = nowIso;
      for (const linkId of prediction.basisLinkIds) {
        const link = state.links.find((item) => item.tenantId === tenantId && item.id === linkId);
        if (!link) continue;
        if (outcome) link.confirmations++; else link.refutations++;
        const total = link.confirmations + link.refutations;
        link.confidence = auroraRound((link.confirmations + 1) / (total + 2));
        link.updatedAt = nowIso;
      }
      return structuredClone(prediction);
    });
  }

  /** Expire predictions whose horizon has passed without resolution so calibration stays honest. */
  async expirePredictions(tenantId: string): Promise<string[]> {
    return await this.store.mutate((state) => {
      const timestamp = this.now();
      const expired: string[] = [];
      for (const prediction of state.predictions.filter((item) => item.tenantId === tenantId && item.status === "open" && Date.parse(item.horizonAt) < timestamp - 86_400_000)) {
        prediction.status = "expired";
        prediction.updatedAt = new Date(timestamp).toISOString();
        expired.push(prediction.id);
      }
      return expired;
    });
  }

  async predictions(tenantId: string, status?: WorldPrediction["status"]): Promise<WorldPrediction[]> {
    const state = await this.store.read();
    return state.predictions
      .filter((item) => item.tenantId === tenantId && (!status || item.status === status))
      .sort((a, b) => a.horizonAt.localeCompare(b.horizonAt))
      .map((item) => structuredClone(item));
  }

  async calibration(tenantId: string): Promise<WorldCalibration> {
    const state = await this.store.read();
    const resolved = state.predictions.filter((item) => item.tenantId === tenantId && item.status === "resolved");
    const buckets = new Map<string, { predicted: number; observed: number; count: number }>();
    let brierTotal = 0;
    let correct = 0;
    for (const prediction of resolved) {
      brierTotal += prediction.brierScore ?? 0;
      const hit = (prediction.probability >= 0.5) === (prediction.outcome === true);
      if (hit) correct++;
      const bucketKey = `${Math.min(9, Math.floor(prediction.probability * 10)) * 10}-${Math.min(9, Math.floor(prediction.probability * 10)) * 10 + 10}%`;
      const bucket = buckets.get(bucketKey) ?? { predicted: 0, observed: 0, count: 0 };
      bucket.predicted += prediction.probability;
      bucket.observed += prediction.outcome ? 1 : 0;
      bucket.count++;
      buckets.set(bucketKey, bucket);
    }
    return {
      tenantId,
      resolved: resolved.length,
      correct,
      accuracy: resolved.length ? auroraRound(correct / resolved.length) : 0,
      brierMean: resolved.length ? auroraRound(brierTotal / resolved.length) : 0,
      buckets: [...buckets.entries()].map(([bucket, value]) => ({
        bucket,
        predicted: auroraRound(value.predicted / value.count),
        observed: auroraRound(value.observed / value.count),
        count: value.count,
      })).sort((a, b) => a.bucket.localeCompare(b.bucket)),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /** World Consistency Engine: conflicting current values for the same entity key. */
  async inconsistencies(tenantId: string): Promise<WorldInconsistency[]> {
    const state = await this.store.read();
    const timestamp = this.now();
    const groups = new Map<string, WorldStateFact[]>();
    for (const fact of state.states.filter((item) => item.tenantId === tenantId && !item.supersededById && (!item.validTo || Date.parse(item.validTo) > timestamp))) {
      const key = `${fact.entityId}::${fact.key}`;
      groups.set(key, [...(groups.get(key) ?? []), fact]);
    }
    const result: WorldInconsistency[] = [];
    for (const [key, facts] of groups) {
      const distinct = [...new Set(facts.map((item) => item.value.toLowerCase()))];
      if (distinct.length < 2) continue;
      const [entityId = "", stateKey = ""] = key.split("::");
      const ranked = [...facts].sort((a, b) => b.confidence - a.confidence || b.observedAt.localeCompare(a.observedAt));
      const best = ranked[0]!;
      result.push({
        entityId,
        key: stateKey,
        conflicting: ranked.map((item) => ({ stateId: item.id, value: item.value, confidence: item.confidence, claimType: item.claimType, observedAt: item.observedAt })),
        recommendation: `Prefer "${best.value}" (confidence ${best.confidence}, ${best.claimType}) or gather a new observation.`,
      });
    }
    return result;
  }

  /**
   * Bounded forward simulation over causal links. Counterfactual mode marks the premise as
   * hypothetical and never writes state, matching the PDF's "what if" engine.
   */
  async simulate(input: { tenantId: string; premise: string; startKind: "event" | "state"; startRef: string; depth?: number; mode?: "simulation" | "counterfactual" }): Promise<WorldSimulationResult> {
    const state = await this.store.read();
    const depth = auroraInteger(input.depth ?? 3, 1, 8, "Simulation depth");
    this.requireRef(state, input.tenantId, input.startKind, input.startRef);
    const steps: WorldSimulationStep[] = [];
    const notes: string[] = [];
    const visited = new Set<string>([input.startRef]);
    let frontier: Array<{ kind: "event" | "state"; ref: string; probability: number }> = [{ kind: input.startKind, ref: input.startRef, probability: 1 }];
    for (let level = 1; level <= depth; level++) {
      const next: typeof frontier = [];
      for (const node of frontier) {
        const outgoing = state.links.filter((item) => item.tenantId === input.tenantId && item.causeRef === node.ref && !visited.has(item.effectRef));
        if (!outgoing.length) continue;
        for (const link of outgoing.sort((a, b) => b.strength * b.confidence - a.strength * a.confidence).slice(0, 4)) {
          const probability = auroraRound(node.probability * link.strength * link.confidence);
          visited.add(link.effectRef);
          steps.push({ depth: level, linkId: link.id, description: link.description, targetKind: link.effectKind, targetRef: link.effectRef, probability });
          next.push({ kind: link.effectKind, ref: link.effectRef, probability });
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    if (!steps.length) notes.push("No causal links extend from the premise; the world model cannot project this branch yet.");
    const terminal = steps.length ? Math.max(...steps.filter((item) => item.depth === Math.max(...steps.map((entry) => entry.depth))).map((item) => item.probability)) : 0;
    const lowConfidence = steps.filter((item) => item.probability < 0.2).length;
    if (lowConfidence) notes.push(`${lowConfidence} projected step(s) are below 0.2 probability and should be treated as speculative.`);
    if (input.mode === "counterfactual") notes.push("Counterfactual branch: the premise is assumed, not observed, and no world state was written.");
    return {
      id: `sim-${randomUUID()}`,
      tenantId: input.tenantId,
      mode: input.mode ?? "simulation",
      premise: auroraText(input.premise, 2000, "Simulation premise"),
      steps,
      terminalProbability: auroraRound(terminal),
      uncertainty: auroraRound(1 - terminal),
      notes,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Scoped view (personal / environment / digital / project / human / goal world models). */
  async scopeView(tenantId: string, scope: WorldScope): Promise<{ scope: WorldScope; entities: WorldEntity[]; recentEvents: WorldEvent[]; openPredictions: WorldPrediction[] }> {
    const state = await this.store.read();
    const entities = state.entities.filter((item) => item.tenantId === tenantId && item.scope === scope && item.status === "active");
    const ids = new Set(entities.map((item) => item.id));
    return {
      scope,
      entities: entities.map((item) => structuredClone(item)),
      recentEvents: state.events
        .filter((item) => item.tenantId === tenantId && item.entityIds.some((id) => ids.has(id)))
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 50).map((item) => structuredClone(item)),
      openPredictions: state.predictions
        .filter((item) => item.tenantId === tenantId && item.status === "open" && item.entityId !== undefined && ids.has(item.entityId))
        .map((item) => structuredClone(item)),
    };
  }

  /** Re-evaluate old assumptions after a new observation: which states/predictions are now suspect. */
  async reassess(tenantId: string, entityId: string): Promise<{ supersededStates: string[]; challengedPredictions: Array<{ predictionId: string; reason: string }>; inconsistencies: WorldInconsistency[] }> {
    const state = await this.store.read();
    const current = await this.stateAt(tenantId, entityId);
    const currentText = Object.values(current).map((item) => `${item.key}=${item.value}`).join(" ");
    const challenged = state.predictions
      .filter((item) => item.tenantId === tenantId && item.status === "open" && item.entityId === entityId)
      .filter((item) => auroraSimilarity(item.statement, currentText) < 0.05)
      .map((item) => ({ predictionId: item.id, reason: "Current entity state no longer supports the prediction basis." }));
    return {
      supersededStates: state.states.filter((item) => item.tenantId === tenantId && item.entityId === entityId && item.supersededById).map((item) => item.id),
      challengedPredictions: challenged,
      inconsistencies: (await this.inconsistencies(tenantId)).filter((item) => item.entityId === entityId),
    };
  }

  private requireRef(state: WorldModelStateShape, tenantId: string, kind: "event" | "state", ref: string): void {
    const found = kind === "event"
      ? state.events.some((item) => item.tenantId === tenantId && item.id === ref)
      : state.states.some((item) => item.tenantId === tenantId && item.id === ref);
    if (!found) throw new Error(`World ${kind} reference not found in tenant.`);
  }

  private mutableEntity(state: WorldModelStateShape, tenantId: string, id: string): WorldEntity {
    const entity = state.entities.find((item) => item.tenantId === tenantId && item.id === id);
    if (!entity) throw new Error("World entity not found in tenant.");
    return entity;
  }
}

function boundedAttributes(attributes: Record<string, string | number | boolean> | undefined): Record<string, string | number | boolean> {
  const entries = Object.entries(attributes ?? {});
  if (entries.length > 100) throw new Error("World entity attributes are invalid.");
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    const name = auroraText(key, 100, "Entity attribute key").toLowerCase();
    if (typeof value === "string") result[name] = auroraText(value, 2000, "Entity attribute value");
    else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Entity attribute value is invalid.");
      result[name] = value;
    } else result[name] = value;
  }
  return result;
}
