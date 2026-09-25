import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AsyncMutex } from "../util/async-mutex.js";
import { atomicWrite } from "../util/atomic-file.js";

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_OBJECTS = 100_000;
const MAX_GOALS = 10_000;
const LOOP_HISTORY = 20;

export type CognitiveObjectKind = "observation" | "problem" | "hypothesis" | "insight" | "risk" | "opportunity" | "decision";
export type CognitiveObjectState = "new" | "active" | "researching" | "waiting" | "blocked" | "archived" | "solved";
export type CognitiveMode = "reactive" | "research" | "development" | "reflection" | "dream" | "emergency";
export type CognitiveHorizon = "reactive" | "tactical" | "strategic";
export type CognitiveGoalClass = "P0" | "P1" | "P2" | "P3" | "P4";

export interface CognitiveGoal {
  id: string;
  tenantId: string;
  title: string;
  objective: string;
  class: CognitiveGoalClass;
  importance: number;
  urgency: number;
  userRelevance: number;
  state: "active" | "paused" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}
export interface CognitiveObject {
  id: string;
  tenantId: string;
  sessionId?: string;
  kind: CognitiveObjectKind;
  title: string;
  content: string;
  sourceType: "user" | "agent" | "event" | "memory" | "system";
  sourceId?: string;
  confidence: number;
  importance: number;
  urgency: number;
  impact: number;
  userRelevance: number;
  priorityScore: number;
  horizon: CognitiveHorizon;
  goalId?: string;
  state: CognitiveObjectState;
  attentionState: "queued" | "focused" | "deferred";
  requestedTokens: number;
  requestedTimeMs: number;
  reservedTokens: number;
  bucket?: string;
  tags: string[];
  relations: string[];
  iterationHashes: string[];
  repeatedIterationCount: number;
  lastIterationAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface CognitiveBudget {
  tenantId: string;
  date: string;
  dailyTokenBudget: number;
  usedTokens: number;
  reservedTokens: number;
  maxFocusedObjects: number;
}
export interface CognitiveModeState {
  tenantId: string;
  mode: CognitiveMode;
  reason: string;
  changedAt: string;
  history: Array<{ from: CognitiveMode; to: CognitiveMode; reason: string; changedAt: string }>;
}
export interface CognitiveArbitration {
  id: string;
  tenantId: string;
  winnerGoalId?: string;
  rankedGoalIds: string[];
  conflictGoalIds: string[];
  reason: string;
  createdAt: string;
}
export type CognitiveIntakeSource = "user" | "agent" | "event" | "memory" | "system" | "world-model" | "initiative" | "society" | "environment";
export type CognitiveReflectionKind = "mini" | "deep" | "meta" | "dream";

/** Bounded, hash-only intake ledger: the Global Workspace records that it saw something, not the payload. */
export interface CognitiveIntakeRecord {
  id: string;
  tenantId: string;
  source: CognitiveIntakeSource;
  digest: string;
  objectId?: string;
  accepted: boolean;
  reason: string;
  at: string;
}

export interface CognitiveHealthReport {
  tenantId: string;
  mode: CognitiveMode;
  totals: { objects: number; focused: number; queued: number; deferred: number; blocked: number };
  loopBlocked: string[];
  focusOverruns: string[];
  staleStrategic: string[];
  unsourcedHighConfidence: string[];
  budgetSaturation: number;
  intakeToday: number;
  constitutionalViolations: Array<{ code: string; objectId?: string; detail: string }>;
  healthScore: number;
  generatedAt: string;
}

/** Cognitive economy: a named share of the daily attention budget (for example project 40%). */
export interface CognitiveAllocationBucket {
  name: string;
  share: number;
  usedTokens: number;
  reservedTokens: number;
}
export interface CognitiveAllocationPlan {
  tenantId: string;
  date: string;
  buckets: CognitiveAllocationBucket[];
}
export interface CognitiveAllocationView {
  name: string;
  share: number;
  capTokens: number;
  usedTokens: number;
  reservedTokens: number;
  remainingTokens: number;
}

interface CognitiveState {
  schemaVersion: 1;
  objects: CognitiveObject[];
  goals: CognitiveGoal[];
  budgets: CognitiveBudget[];
  modes: CognitiveModeState[];
  arbitrations: CognitiveArbitration[];
  intake: CognitiveIntakeRecord[];
  allocations: CognitiveAllocationPlan[];
}

const GOAL_WEIGHT: Record<CognitiveGoalClass, number> = { P0: 2, P1: 1.6, P2: 1.25, P3: 1, P4: 0.6 };
const GOAL_ORDER: Record<CognitiveGoalClass, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
const MODE_TRANSITIONS: Record<CognitiveMode, CognitiveMode[]> = {
  reactive: ["research", "development", "reflection", "emergency"],
  research: ["reactive", "development", "reflection", "dream", "emergency"],
  development: ["reactive", "research", "reflection", "emergency"],
  reflection: ["reactive", "research", "dream", "emergency"],
  dream: ["reactive", "research", "reflection", "emergency"],
  emergency: ["reactive", "reflection"],
};

/**
 * E6 / P1.13: what each cognitive mode DOES to attention, as policy in code.
 *
 * A mode that changes only a label changes nothing. `minUrgency` is the
 * urgency a task must carry to earn focus while the tenant is in that mode;
 * `undefined` means the mode imposes no extra constraint beyond the shared
 * budget. Emergency is the one mode with teeth: routine work must wait until
 * the crisis is over, because emergency focus IS the crisis budget.
 */
export const MODE_ATTENTION_POLICY: Record<
  CognitiveMode,
  { readonly minUrgency: number | undefined; readonly note: string }
> = {
  reactive: { minUrgency: undefined, note: "Reactive mode: the shared attention budget applies." },
  research: { minUrgency: undefined, note: "Research mode: the shared attention budget applies." },
  development: { minUrgency: undefined, note: "Development mode: the shared attention budget applies." },
  reflection: { minUrgency: undefined, note: "Reflection mode: the shared attention budget applies." },
  dream: { minUrgency: undefined, note: "Dream mode: the shared attention budget applies." },
  emergency: { minUrgency: 0.7, note: "Emergency mode: only urgent work may take focus." },
};

/** Durable Global Workspace, attention budget, cognitive modes, loop detection and goal arbitration. */
export class CognitiveWorkspaceService {
  private state: CognitiveState = { schemaVersion: 1, objects: [], goals: [], budgets: [], modes: [], arbitrations: [], intake: [], allocations: [] };
  private loaded = false;
  private readonly mutex = new AsyncMutex();
  constructor(private readonly rootPath: string, private readonly now: () => number = Date.now) {}

  async createGoal(input: { tenantId: string; title: string; objective: string; class: CognitiveGoalClass; importance: number; urgency: number; userRelevance: number }): Promise<CognitiveGoal> {
    return await this.mutex.runExclusive(async () => {
      await this.load(); if (this.state.goals.length >= MAX_GOALS) throw new Error("Cognitive goal limit reached.");
      const now = new Date(this.now()).toISOString(); const goal: CognitiveGoal = { id: randomUUID(), tenantId: input.tenantId, title: bounded(input.title, 300, "Cognitive goal title"), objective: bounded(input.objective, 10_000, "Cognitive goal objective"), class: input.class, importance: unit(input.importance, "Goal importance"), urgency: unit(input.urgency, "Goal urgency"), userRelevance: unit(input.userRelevance, "Goal user relevance"), state: "active", createdAt: now, updatedAt: now };
      this.state.goals.push(goal); await this.save(); return structuredClone(goal);
    });
  }
  async setGoalState(tenantId: string, id: string, state: CognitiveGoal["state"]): Promise<CognitiveGoal> { return await this.mutex.runExclusive(async () => { const goal = await this.goal(tenantId, id); goal.state = state; goal.updatedAt = new Date(this.now()).toISOString(); if (state !== "active") for (const object of this.state.objects.filter((item) => item.goalId === goal.id && item.attentionState === "focused")) await this.releaseReservation(object, "deferred", 0); await this.save(); return structuredClone(goal); }); }
  async goals(tenantId: string): Promise<CognitiveGoal[]> { await this.load(); return this.state.goals.filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item)); }

  async createObject(input: { tenantId: string; sessionId?: string; kind: CognitiveObjectKind; title: string; content: string; sourceType: CognitiveObject["sourceType"]; sourceId?: string; confidence: number; importance: number; urgency: number; impact: number; userRelevance: number; horizon: CognitiveHorizon; goalId?: string; bucket?: string; requestedTokens?: number; requestedTimeMs?: number; tags?: string[]; relations?: string[] }): Promise<CognitiveObject> {
    return await this.mutex.runExclusive(async () => {
      await this.load(); if (this.state.objects.length >= MAX_OBJECTS) throw new Error("Cognitive object limit reached.");
      let goal: CognitiveGoal | undefined; if (input.goalId) { goal = await this.goal(input.tenantId, input.goalId); if (goal.state !== "active") throw new Error("Cognitive object goal is not active."); }
      const confidence = unit(input.confidence, "Confidence"), importance = unit(input.importance, "Importance"), urgency = unit(input.urgency, "Urgency"), impact = unit(input.impact, "Impact"), relevance = unit(input.userRelevance, "User relevance");
      const now = new Date(this.now()).toISOString(); const value: CognitiveObject = { id: randomUUID(), tenantId: input.tenantId, ...(input.sessionId ? { sessionId: input.sessionId } : {}), kind: input.kind, title: bounded(input.title, 500, "Cognitive object title"), content: bounded(input.content, 100_000, "Cognitive object content"), sourceType: input.sourceType, ...(input.sourceId ? { sourceId: bounded(input.sourceId, 500, "Cognitive source ID") } : {}), confidence, importance, urgency, impact, userRelevance: relevance, priorityScore: calculatePriority(importance, urgency, impact, confidence, relevance, goal?.class ?? "P3"), horizon: input.horizon, ...(goal ? { goalId: goal.id } : {}), ...(input.bucket ? { bucket: labels([input.bucket])[0]! } : {}), state: "new", attentionState: "queued", requestedTokens: integer(input.requestedTokens ?? 10_000, 100, 10_000_000, "Requested cognitive tokens"), requestedTimeMs: integer(input.requestedTimeMs ?? 60_000, 1000, 24 * 60 * 60_000, "Requested cognitive time"), reservedTokens: 0, tags: labels(input.tags ?? []), relations: [...new Set(input.relations ?? [])].slice(0, 200), iterationHashes: [], repeatedIterationCount: 0, createdAt: now, updatedAt: now };
      this.state.objects.push(value); await this.save(); return structuredClone(value);
    });
  }
  async objects(tenantId: string, attentionState?: CognitiveObject["attentionState"]): Promise<CognitiveObject[]> { await this.load(); return this.state.objects.filter((item) => item.tenantId === tenantId && (!attentionState || item.attentionState === attentionState)).sort((a,b)=>b.priorityScore-a.priorityScore).map((item)=>structuredClone(item)); }
  async setObjectState(tenantId: string, id: string, state: CognitiveObjectState): Promise<CognitiveObject> { return await this.mutex.runExclusive(async () => { const object = await this.object(tenantId,id); object.state=state; if (["blocked","archived","solved"].includes(state) && object.attentionState==="focused") await this.releaseReservation(object, state === "blocked" ? "deferred" : "queued", 0); object.updatedAt=new Date(this.now()).toISOString(); await this.save(); return structuredClone(object); }); }

  async configureBudget(tenantId: string, dailyTokenBudget: number, maxFocusedObjects: number): Promise<CognitiveBudget> { return await this.mutex.runExclusive(async () => { await this.load(); let budget=this.state.budgets.find((item)=>item.tenantId===tenantId); if(!budget){budget={tenantId,date:day(this.now()),dailyTokenBudget:0,usedTokens:0,reservedTokens:0,maxFocusedObjects:1};this.state.budgets.push(budget);} this.rollBudget(budget); budget.dailyTokenBudget=integer(dailyTokenBudget,1000,100_000_000,"Cognitive daily token budget"); budget.maxFocusedObjects=integer(maxFocusedObjects,1,100,"Focused object limit"); await this.save(); return structuredClone(budget); }); }
  async budget(tenantId: string): Promise<CognitiveBudget> { await this.load(); let b=this.state.budgets.find((item)=>item.tenantId===tenantId); if(!b) return await this.configureBudget(tenantId,500_000,8); if(this.rollBudget(b)) await this.save(); return structuredClone(b); }

  /**
   * Configure the cognitive economy: named shares of the daily attention budget. Shares must sum to
   * at most 1; whatever is left is the implicit `default` pool for unbucketed work.
   */
  async configureAllocation(tenantId: string, buckets: Array<{ name: string; share: number }>): Promise<CognitiveAllocationPlan> {
    return await this.mutex.runExclusive(async () => {
      await this.load();
      if (buckets.length > 20) throw new Error("Cognitive allocation supports at most 20 buckets.");
      const names = new Set<string>();
      const normalized: CognitiveAllocationBucket[] = [];
      let total = 0;
      for (const bucket of buckets) {
        const name = labels([bucket.name])[0]!;
        if (names.has(name)) throw new Error("Cognitive allocation bucket names must be unique.");
        names.add(name);
        const share = unit(bucket.share, "Allocation share");
        total += share;
        normalized.push({ name, share, usedTokens: 0, reservedTokens: 0 });
      }
      if (total > 1.000001) throw new Error("Cognitive allocation shares cannot exceed 1.");
      const existing = this.state.allocations.find((item) => item.tenantId === tenantId);
      const plan: CognitiveAllocationPlan = { tenantId, date: day(this.now()), buckets: normalized };
      if (existing) {
        existing.date = plan.date;
        existing.buckets = normalized;
      } else this.state.allocations.push(plan);
      await this.save();
      return structuredClone(existing ?? plan);
    });
  }

  /** Current per-bucket caps and consumption against the daily attention budget. */
  async allocationView(tenantId: string): Promise<CognitiveAllocationView[]> {
    await this.load();
    const budget = await this.budget(tenantId);
    const plan = this.state.allocations.find((item) => item.tenantId === tenantId);
    if (!plan) return [];
    if (plan.date !== day(this.now())) {
      for (const bucket of plan.buckets) { bucket.usedTokens = 0; bucket.reservedTokens = 0; }
      plan.date = day(this.now());
      await this.save();
    }
    return plan.buckets.map((bucket) => {
      const capTokens = Math.floor(budget.dailyTokenBudget * bucket.share);
      return {
        name: bucket.name,
        share: bucket.share,
        capTokens,
        usedTokens: bucket.usedTokens,
        reservedTokens: bucket.reservedTokens,
        remainingTokens: Math.max(0, capTokens - bucket.usedTokens - bucket.reservedTokens),
      };
    });
  }

  /**
   * Allocate Global Workspace focus. Ordering is constitutional first (goal class), then priority score.
   * With `preempt`, a strictly higher-ranked candidate may reclaim a focused slot from a lower-ranked
   * object; the preempted object returns to the queue with its reservation released (never lost).
   */
  async allocateAttention(tenantId: string, options?: { preempt?: boolean }): Promise<{ focused: CognitiveObject[]; deferred: string[]; preempted: string[]; budget: CognitiveBudget; allocation: CognitiveAllocationView[] }> {
    return await this.mutex.runExclusive(async () => {
      await this.load();
      const budget = await this.mutableBudget(tenantId);
      const plan = this.state.allocations.find((item) => item.tenantId === tenantId);
      if (plan && plan.date !== day(this.now())) {
        for (const bucket of plan.buckets) { bucket.usedTokens = 0; bucket.reservedTokens = 0; }
        plan.date = day(this.now());
      }
      const bucketOf = (object: CognitiveObject): CognitiveAllocationBucket | undefined =>
        plan && object.bucket ? plan.buckets.find((item) => item.name === object.bucket) : undefined;
      const activeGoals = new Map(this.state.goals.filter((g) => g.tenantId === tenantId && g.state === "active").map((g) => [g.id, g]));
      const rank = (object: CognitiveObject): number => {
        const goalClass = object.goalId ? activeGoals.get(object.goalId)?.class ?? "P3" : "P3";
        return GOAL_ORDER[goalClass] * 1000 - object.priorityScore;
      };
      const focused = this.state.objects.filter((o) => o.tenantId === tenantId && o.attentionState === "focused");
      let slots = Math.max(0, budget.maxFocusedObjects - focused.length);
      const candidates = this.state.objects
        .filter((o) => o.tenantId === tenantId && ["new", "active", "researching", "waiting"].includes(o.state) && o.attentionState !== "focused" && (!o.goalId || activeGoals.has(o.goalId)))
        .sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
      const allocated: CognitiveObject[] = [];
      const deferred: string[] = [];
      const preempted: string[] = [];
      for (const object of candidates) {
        if (slots <= 0 && options?.preempt) {
          const victim = this.state.objects
            .filter((o) => o.tenantId === tenantId && o.attentionState === "focused" && rank(o) > rank(object) + 1e-9)
            .sort((a, b) => rank(b) - rank(a))[0];
          if (victim) {
            await this.releaseReservation(victim, "queued", 0);
            victim.state = victim.state === "active" ? "waiting" : victim.state;
            victim.updatedAt = new Date(this.now()).toISOString();
            preempted.push(victim.id);
            slots++;
          }
        }
        const bucket = bucketOf(object);
        const bucketCap = bucket ? Math.floor(budget.dailyTokenBudget * bucket.share) : undefined;
        const bucketExhausted = bucket !== undefined && bucketCap !== undefined
          && bucket.usedTokens + bucket.reservedTokens + object.requestedTokens > bucketCap;
        if (slots <= 0 || bucketExhausted || budget.usedTokens + budget.reservedTokens + object.requestedTokens > budget.dailyTokenBudget) {
          object.attentionState = "deferred";
          deferred.push(object.id);
          continue;
        }
        object.attentionState = "focused";
        object.state = object.state === "new" ? "active" : object.state;
        object.reservedTokens = object.requestedTokens;
        object.updatedAt = new Date(this.now()).toISOString();
        budget.reservedTokens += object.requestedTokens;
        if (bucket) bucket.reservedTokens += object.requestedTokens;
        slots--;
        allocated.push(structuredClone(object));
      }
      await this.save();
      const allocation: CognitiveAllocationView[] = (plan?.buckets ?? []).map((bucket) => {
        const capTokens = Math.floor(budget.dailyTokenBudget * bucket.share);
        return { name: bucket.name, share: bucket.share, capTokens, usedTokens: bucket.usedTokens, reservedTokens: bucket.reservedTokens, remainingTokens: Math.max(0, capTokens - bucket.usedTokens - bucket.reservedTokens) };
      });
      return { focused: allocated, deferred, preempted, budget: structuredClone(budget), allocation };
    });
  }

  /**
   * Automatic event intake. Duplicate signals inside the intake window are recorded and dropped,
   * and a bounded daily intake quota keeps a noisy environment from flooding the workspace.
   */
  async intake(input: { tenantId: string; source: CognitiveIntakeSource; title: string; content: string; sourceId?: string; sessionId?: string; goalId?: string; confidence?: number; importance?: number; urgency?: number; impact?: number; userRelevance?: number; horizon?: CognitiveHorizon; kind?: CognitiveObjectKind; tags?: string[]; bucket?: string; dailyLimit?: number; requestedTokens?: number; requestedTimeMs?: number }): Promise<{ accepted: boolean; reason: string; object?: CognitiveObject; record: CognitiveIntakeRecord }> {
    const digest = createHash("sha256").update(`${input.source}:${input.title.trim().toLowerCase()}:${input.content.trim()}`).digest("hex");
    const dailyLimit = integer(input.dailyLimit ?? 500, 1, 100_000, "Cognitive intake daily limit");
    const pending = await this.mutex.runExclusive(async () => {
      await this.load();
      const timestamp = this.now();
      const nowIso = new Date(timestamp).toISOString();
      const today = day(timestamp);
      const todayRecords = this.state.intake.filter((item) => item.tenantId === input.tenantId && item.at.slice(0, 10) === today);
      const duplicate = this.state.intake.find((item) => item.tenantId === input.tenantId && item.digest === digest && timestamp - Date.parse(item.at) < 6 * 60 * 60_000);
      const reason = duplicate ? "duplicate-intake-signal" : todayRecords.filter((item) => item.accepted).length >= dailyLimit ? "intake-quota-exhausted" : "accepted";
      const record: CognitiveIntakeRecord = { id: randomUUID(), tenantId: input.tenantId, source: input.source, digest, accepted: reason === "accepted", reason, at: nowIso };
      this.state.intake.push(record);
      if (this.state.intake.length > 50_000) this.state.intake.splice(0, this.state.intake.length - 50_000);
      await this.save();
      return { record, accepted: reason === "accepted", reason };
    });
    if (!pending.accepted) return { accepted: false, reason: pending.reason, record: pending.record };
    const sourceType: CognitiveObject["sourceType"] = input.source === "user" || input.source === "agent" || input.source === "memory" || input.source === "event" ? input.source : "system";
    const object = await this.createObject({
      tenantId: input.tenantId,
      kind: input.kind ?? "observation",
      title: input.title,
      content: input.content,
      sourceType,
      confidence: input.confidence ?? 0.6,
      importance: input.importance ?? 0.5,
      urgency: input.urgency ?? 0.4,
      impact: input.impact ?? 0.4,
      userRelevance: input.userRelevance ?? 0.5,
      horizon: input.horizon ?? "tactical",
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.goalId ? { goalId: input.goalId } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.bucket ? { bucket: input.bucket } : {}),
      // A caller that knows its budget states it; `completeFocus` charges
      // actual spend against this reservation, and the default (10k) would
      // silently cap accounting for any task that budgeted more.
      ...(input.requestedTokens !== undefined ? { requestedTokens: input.requestedTokens } : {}),
      ...(input.requestedTimeMs !== undefined ? { requestedTimeMs: input.requestedTimeMs } : {}),
    });
    const record = await this.mutex.runExclusive(async () => {
      await this.load();
      const stored = this.state.intake.find((item) => item.id === pending.record.id);
      if (stored) stored.objectId = object.id;
      await this.save();
      return structuredClone(stored ?? pending.record);
    });
    return { accepted: true, reason: "accepted", object, record };
  }

  async intakeLog(tenantId: string, limit = 200): Promise<CognitiveIntakeRecord[]> {
    await this.load();
    return this.state.intake.filter((item) => item.tenantId === tenantId).slice(-integer(limit, 1, 5000, "Intake log limit")).reverse().map((item) => structuredClone(item));
  }

  /** Interrupt a focused thought without losing its reservation accounting (interruptible background work). */
  async interruptFocus(tenantId: string, id: string, reason: string): Promise<CognitiveObject> {
    return await this.mutex.runExclusive(async () => {
      const object = await this.object(tenantId, id);
      if (object.attentionState !== "focused") throw new Error("Cognitive object is not focused.");
      await this.releaseReservation(object, "queued", 0);
      object.state = "waiting";
      object.updatedAt = new Date(this.now()).toISOString();
      const tag = bounded(reason, 200, "Interrupt reason").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
      if (tag && !object.tags.includes(`interrupted:${tag}`) && object.tags.length < 100) object.tags.push(`interrupted:${tag}`);
      await this.save();
      return structuredClone(object);
    });
  }

  /**
   * Scheduled reflection: mini/deep/meta reviews and Dream Mode low-priority synthesis.
   * Dream and meta reflection require the matching cognitive mode, so background creativity
   * cannot silently consume reactive-mode budget.
   */
  async scheduleReflection(input: { tenantId: string; kind: CognitiveReflectionKind; focusObjectIds?: string[]; note?: string }): Promise<CognitiveObject> {
    const mode = await this.mode(input.tenantId);
    if (input.kind === "dream" && mode.mode !== "dream") throw new Error("Dream Mode synthesis requires the dream cognitive mode.");
    if (input.kind === "meta" && !["reflection", "dream"].includes(mode.mode)) throw new Error("Meta reflection requires reflection or dream mode.");
    const focusIds = [...new Set(input.focusObjectIds ?? [])].slice(0, 50);
    for (const id of focusIds) await this.object(input.tenantId, id);
    const profile = {
      mini: { importance: 0.4, urgency: 0.4, impact: 0.35, tokens: 4_000, horizon: "reactive" as CognitiveHorizon },
      deep: { importance: 0.7, urgency: 0.35, impact: 0.7, tokens: 25_000, horizon: "tactical" as CognitiveHorizon },
      meta: { importance: 0.8, urgency: 0.3, impact: 0.8, tokens: 40_000, horizon: "strategic" as CognitiveHorizon },
      dream: { importance: 0.3, urgency: 0.05, impact: 0.5, tokens: 8_000, horizon: "strategic" as CognitiveHorizon },
    }[input.kind];
    return await this.createObject({
      tenantId: input.tenantId,
      kind: input.kind === "dream" ? "insight" : "problem",
      title: `${input.kind} reflection`,
      content: `${input.note ?? `Scheduled ${input.kind} reflection.`}\nFocus objects: ${focusIds.length ? focusIds.join(", ") : "workspace-wide"}`,
      sourceType: "system",
      confidence: 0.5,
      importance: profile.importance,
      urgency: profile.urgency,
      impact: profile.impact,
      userRelevance: input.kind === "dream" ? 0.2 : 0.6,
      horizon: profile.horizon,
      requestedTokens: profile.tokens,
      tags: ["reflection", input.kind],
      relations: focusIds,
    });
  }

  /**
   * Curiosity queue: low-confidence, high-impact hypotheses and opportunities that deserve
   * investigation when spare attention exists. Blocked and solved objects are never returned.
   */
  async curiosityQueue(tenantId: string, limit = 20): Promise<Array<{ object: CognitiveObject; curiosity: number }>> {
    await this.load();
    return this.state.objects
      .filter((item) => item.tenantId === tenantId && ["hypothesis", "opportunity", "problem"].includes(item.kind) && !["blocked", "archived", "solved"].includes(item.state))
      .map((item) => ({ object: structuredClone(item), curiosity: Number(((1 - item.confidence) * item.impact * item.importance).toFixed(6)) }))
      .filter((item) => item.curiosity > 0)
      .sort((a, b) => b.curiosity - a.curiosity)
      .slice(0, integer(limit, 1, 200, "Curiosity limit"));
  }

  /**
   * Cognitive health and constitution check: loop-blocked thoughts, focus overruns, stale strategic
   * work, unsourced high-confidence claims and budget saturation.
   */
  async health(tenantId: string): Promise<CognitiveHealthReport> {
    await this.load();
    const timestamp = this.now();
    const objects = this.state.objects.filter((item) => item.tenantId === tenantId);
    const budget = await this.budget(tenantId);
    const mode = await this.mode(tenantId);
    const focused = objects.filter((item) => item.attentionState === "focused");
    const loopBlocked = objects.filter((item) => item.state === "blocked" && item.repeatedIterationCount >= 3).map((item) => item.id);
    const focusOverruns = focused.filter((item) => timestamp - Date.parse(item.updatedAt) > item.requestedTimeMs).map((item) => item.id);
    const staleStrategic = objects.filter((item) => item.horizon === "strategic" && !["solved", "archived"].includes(item.state) && timestamp - Date.parse(item.updatedAt) > 30 * 86_400_000).map((item) => item.id);
    const unsourced = objects.filter((item) => item.confidence >= 0.9 && item.sourceType === "system" && !item.sourceId).map((item) => item.id);
    const violations: CognitiveHealthReport["constitutionalViolations"] = [];
    for (const id of loopBlocked) violations.push({ code: "repeated-loop", objectId: id, detail: "Identical outcome repeated at least three times; the object was blocked." });
    for (const id of focusOverruns) violations.push({ code: "focus-overrun", objectId: id, detail: "Focused longer than its requested time budget without completion." });
    for (const id of unsourced) violations.push({ code: "unsourced-high-confidence", objectId: id, detail: "Confidence >= 0.9 without a source reference." });
    const saturation = budget.dailyTokenBudget ? Number(((budget.usedTokens + budget.reservedTokens) / budget.dailyTokenBudget).toFixed(6)) : 0;
    if (saturation >= 0.95) violations.push({ code: "budget-saturated", detail: "Daily attention token budget is effectively exhausted." });
    if (mode.mode === "emergency" && focused.length > 1) violations.push({ code: "emergency-focus-spread", detail: "Emergency mode should concentrate on a single focus." });
    const penalty = objects.length ? (loopBlocked.length * 0.3 + focusOverruns.length * 0.25 + staleStrategic.length * 0.1 + unsourced.length * 0.2) / objects.length : 0;
    return {
      tenantId,
      mode: mode.mode,
      totals: {
        objects: objects.length,
        focused: focused.length,
        queued: objects.filter((item) => item.attentionState === "queued").length,
        deferred: objects.filter((item) => item.attentionState === "deferred").length,
        blocked: objects.filter((item) => item.state === "blocked").length,
      },
      loopBlocked,
      focusOverruns,
      staleStrategic,
      unsourcedHighConfidence: unsourced,
      budgetSaturation: saturation,
      intakeToday: this.state.intake.filter((item) => item.tenantId === tenantId && item.at.slice(0, 10) === day(timestamp) && item.accepted).length,
      constitutionalViolations: violations,
      healthScore: Number(Math.max(0, Math.min(1, 1 - penalty - saturation * 0.15)).toFixed(6)),
      generatedAt: new Date(timestamp).toISOString(),
    };
  }

  async completeFocus(tenantId:string,id:string,outcome:"active"|"solved"|"blocked",actualTokens:number):Promise<CognitiveObject>{return await this.mutex.runExclusive(async()=>{const object=await this.object(tenantId,id);if(object.attentionState!=="focused")throw new Error("Cognitive object is not focused.");const actual=integer(actualTokens,0,object.requestedTokens*2,"Actual cognitive tokens");await this.releaseReservation(object,outcome==="blocked"?"deferred":"queued",actual);object.state=outcome;object.updatedAt=new Date(this.now()).toISOString();await this.save();return structuredClone(object);});}

  async recordIteration(tenantId:string,id:string,result:string):Promise<{object:CognitiveObject;loopDetected:boolean;repeatCount:number}>{return await this.mutex.runExclusive(async()=>{const object=await this.object(tenantId,id);const hash=createHash("sha256").update(result).digest("hex");const previous=object.iterationHashes.at(-1);object.repeatedIterationCount=previous===hash?object.repeatedIterationCount+1:1;object.iterationHashes.push(hash);if(object.iterationHashes.length>LOOP_HISTORY)object.iterationHashes.splice(0,object.iterationHashes.length-LOOP_HISTORY);object.lastIterationAt=new Date(this.now()).toISOString();const loop=object.repeatedIterationCount>=3;if(loop){object.state="blocked";if(object.attentionState==="focused")await this.releaseReservation(object,"deferred",0);}object.updatedAt=new Date(this.now()).toISOString();await this.save();return{object:structuredClone(object),loopDetected:loop,repeatCount:object.repeatedIterationCount};});}

  async mode(tenantId:string):Promise<CognitiveModeState>{await this.load();let mode=this.state.modes.find(m=>m.tenantId===tenantId);if(!mode){mode={tenantId,mode:"reactive",reason:"default",changedAt:new Date(this.now()).toISOString(),history:[]};this.state.modes.push(mode);await this.save();}return structuredClone(mode);}
  async transitionMode(tenantId:string,to:CognitiveMode,reason:string):Promise<CognitiveModeState>{return await this.mutex.runExclusive(async()=>{await this.load();let mode=this.state.modes.find(m=>m.tenantId===tenantId);if(!mode){mode={tenantId,mode:"reactive",reason:"default",changedAt:new Date(this.now()).toISOString(),history:[]};this.state.modes.push(mode);}if(mode.mode!==to&&!MODE_TRANSITIONS[mode.mode].includes(to))throw new Error(`Cognitive mode transition ${mode.mode} -> ${to} is forbidden.`);if(mode.mode!==to){const changedAt=new Date(this.now()).toISOString();mode.history.push({from:mode.mode,to,reason:bounded(reason,1000,"Mode transition reason"),changedAt});if(mode.history.length>1000)mode.history.splice(0,mode.history.length-1000);mode.mode=to;mode.reason=reason;mode.changedAt=changedAt;}await this.save();return structuredClone(mode);});}

  async arbitrateGoals(tenantId:string):Promise<CognitiveArbitration>{return await this.mutex.runExclusive(async()=>{await this.load();const goals=this.state.goals.filter(g=>g.tenantId===tenantId&&g.state==="active").sort((a,b)=>GOAL_ORDER[a.class]-GOAL_ORDER[b.class]||goalScore(b)-goalScore(a)||a.createdAt.localeCompare(b.createdAt));const winner=goals[0];const conflicts=winner?goals.filter(g=>g.id!==winner.id&&GOAL_ORDER[g.class]===GOAL_ORDER[winner.class]&&Math.abs(goalScore(g)-goalScore(winner))<.1).map(g=>g.id):[];const result:CognitiveArbitration={id:randomUUID(),tenantId,...(winner?{winnerGoalId:winner.id}:{}),rankedGoalIds:goals.map(g=>g.id),conflictGoalIds:conflicts,reason:winner?`Selected ${winner.class} goal by constitutional class then importance/urgency/user relevance.`:"No active goals.",createdAt:new Date(this.now()).toISOString()};this.state.arbitrations.push(result);if(this.state.arbitrations.length>10_000)this.state.arbitrations.splice(0,this.state.arbitrations.length-10_000);await this.save();return structuredClone(result);});}
  async arbitrations(tenantId:string):Promise<CognitiveArbitration[]>{await this.load();return this.state.arbitrations.filter(a=>a.tenantId===tenantId).map(a=>structuredClone(a));}

  private async releaseReservation(object:CognitiveObject,attention:CognitiveObject["attentionState"],actual:number):Promise<void>{
    const budget=await this.mutableBudget(object.tenantId);
    budget.reservedTokens=Math.max(0,budget.reservedTokens-object.reservedTokens);
    budget.usedTokens=Math.min(budget.dailyTokenBudget,budget.usedTokens+actual);
    const plan=this.state.allocations.find((item)=>item.tenantId===object.tenantId);
    const bucket=plan&&object.bucket?plan.buckets.find((item)=>item.name===object.bucket):undefined;
    if(bucket){
      bucket.reservedTokens=Math.max(0,bucket.reservedTokens-object.reservedTokens);
      bucket.usedTokens+=actual;
    }
    object.reservedTokens=0;
    object.attentionState=attention;
  }
  private async goal(tenantId:string,id:string):Promise<CognitiveGoal>{await this.load();const g=this.state.goals.find(x=>x.tenantId===tenantId&&x.id===id);if(!g)throw new Error("Cognitive goal not found in tenant.");return g;}
  private async object(tenantId:string,id:string):Promise<CognitiveObject>{await this.load();const o=this.state.objects.find(x=>x.tenantId===tenantId&&x.id===id);if(!o)throw new Error("Cognitive object not found in tenant.");return o;}
  private async mutableBudget(tenantId:string):Promise<CognitiveBudget>{await this.load();let b=this.state.budgets.find(x=>x.tenantId===tenantId);if(!b){b={tenantId,date:day(this.now()),dailyTokenBudget:500_000,usedTokens:0,reservedTokens:0,maxFocusedObjects:8};this.state.budgets.push(b);}this.rollBudget(b);return b;}
  private rollBudget(b:CognitiveBudget):boolean{const current=day(this.now());if(b.date!==current){b.date=current;b.usedTokens=0;b.reservedTokens=0;for(const o of this.state.objects.filter(x=>x.tenantId===b.tenantId&&x.attentionState==="focused")){o.attentionState="queued";o.reservedTokens=0;}return true;}return false;}
  private get path():string{return join(this.rootPath,"cognitive","workspace.json");}
  private async load():Promise<void>{if(this.loaded)return;try{const raw=await readFile(this.path,"utf8");if(Buffer.byteLength(raw)>MAX_STATE_BYTES)throw new Error("Cognitive workspace exceeds its safety bound.");const parsed=JSON.parse(raw) as CognitiveState;if(parsed.schemaVersion!==1||!Array.isArray(parsed.objects)||!Array.isArray(parsed.goals)||!Array.isArray(parsed.budgets)||!Array.isArray(parsed.modes)||!Array.isArray(parsed.arbitrations))throw new Error("Cognitive workspace is malformed.");if(!Array.isArray(parsed.intake))parsed.intake=[];if(!Array.isArray(parsed.allocations))parsed.allocations=[];this.state=parsed;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}this.loaded=true;}
  private async save():Promise<void>{const encoded=`${JSON.stringify(this.state,null,2)}\n`;if(Buffer.byteLength(encoded)>MAX_STATE_BYTES)throw new Error("Cognitive workspace exceeds its safety bound.");await atomicWrite(this.path,encoded);}
}

function calculatePriority(i:number,u:number,impact:number,c:number,r:number,g:CognitiveGoalClass):number{return Number((i*u*impact*c*r*GOAL_WEIGHT[g]).toFixed(8));}
function goalScore(g:CognitiveGoal):number{return g.importance*g.urgency*g.userRelevance;}
function unit(value:number,label:string):number{if(!Number.isFinite(value)||value<0||value>1)throw new Error(`${label} must be between 0 and 1.`);return Number(value.toFixed(6));}
function integer(value:number,min:number,max:number,label:string):number{if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${label} is invalid.`);return value;}
function bounded(value:string,max:number,label:string):string{const text=value.trim();if(!text||text.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))throw new Error(`${label} is invalid.`);return text;}
function labels(values:string[]):string[]{const out=[...new Set(values.map(v=>v.trim().toLowerCase()))];if(out.length>100||out.some(v=>!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(v)))throw new Error("Cognitive labels are invalid.");return out;}
function day(now:number):string{return new Date(now).toISOString().slice(0,10);}
