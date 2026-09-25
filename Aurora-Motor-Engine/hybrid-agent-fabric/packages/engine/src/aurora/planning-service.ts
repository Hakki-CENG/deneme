import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  auroraDigest, auroraIds, auroraInteger, auroraRound, auroraTags, auroraText, auroraUnit, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_PLANS = 20_000;
const MAX_STEPS = 200;

export type PlanStatus = "draft" | "active" | "blocked" | "completed" | "abandoned" | "superseded";
export type PlanStepStatus = "pending" | "ready" | "in-progress" | "blocked" | "done" | "skipped" | "failed";
export type PlanHorizon = "reactive" | "tactical" | "strategic";

export interface PlanStep {
  id: string;
  key: string;
  title: string;
  detail: string;
  dependsOn: string[];
  status: PlanStepStatus;
  estimateMinutes: number;
  estimateTokens: number;
  riskLevel: number;
  verification: string;
  assignedRoleId?: string;
  taskId?: string;
  evidenceRefs: string[];
  startedAt?: string;
  finishedAt?: string;
  actualMinutes?: number;
  note?: string;
}

export interface PlanRevision {
  version: number;
  reason: string;
  trigger: "manual" | "step-failed" | "blocked" | "scope-change" | "budget" | "review";
  changedStepKeys: string[];
  at: string;
}

export interface PlanRecord {
  id: string;
  tenantId: string;
  sessionId?: string;
  goalId?: string;
  title: string;
  objective: string;
  horizon: PlanHorizon;
  status: PlanStatus;
  version: number;
  steps: PlanStep[];
  criticalPath: string[];
  estimatedMinutes: number;
  estimatedTokens: number;
  riskBufferMinutes: number;
  progress: number;
  tags: string[];
  revisions: PlanRevision[];
  supersedesPlanId?: string;
  decisionId?: string;
  digest: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface PlanProgressReport {
  planId: string;
  status: PlanStatus;
  progress: number;
  done: number;
  total: number;
  ready: string[];
  blocked: Array<{ key: string; waitingOn: string[] }>;
  failed: string[];
  remainingMinutes: number;
  remainingTokens: number;
  criticalPathRemaining: string[];
  estimateAccuracy?: number;
  generatedAt: string;
}

interface PlanningStateShape {
  schemaVersion: 1;
  plans: PlanRecord[];
}

/**
 * Aurora planning layer: turns an objective into a dependency-ordered plan with estimates, explicit
 * verification per step, a computed critical path and a risk buffer derived from declared step risk.
 *
 * Two properties matter more than the graph itself:
 * - dependency cycles are rejected at write time, so a plan can always be executed;
 * - every change is a versioned revision with a trigger and reason, so replanning is auditable rather
 *   than a silent rewrite of what Aurora claimed it would do.
 */
export class PlanningService {
  private readonly store: DurableJsonState<PlanningStateShape>;

  constructor(rootPath: string, private readonly now: () => number = Date.now) {
    this.store = new DurableJsonState<PlanningStateShape>(
      join(rootPath, "planning", "state.json"),
      () => ({ schemaVersion: 1, plans: [] }),
      (value) => {
        const state = value as PlanningStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.plans);
      },
      "Aurora planning state",
    );
  }

  async create(input: {
    tenantId: string; title: string; objective: string; horizon?: PlanHorizon; sessionId?: string; goalId?: string;
    decisionId?: string; tags?: string[];
    steps: Array<{ key: string; title: string; detail?: string; dependsOn?: string[]; estimateMinutes?: number; estimateTokens?: number; riskLevel?: number; verification?: string; assignedRoleId?: string }>;
  }): Promise<PlanRecord> {
    return await this.store.mutate((state) => {
      if (state.plans.length >= MAX_PLANS) throw new Error("Aurora plan limit reached.");
      const steps = this.buildSteps(input.steps);
      const nowIso = new Date(this.now()).toISOString();
      const plan: PlanRecord = {
        id: `plan-${randomUUID()}`,
        tenantId: input.tenantId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.goalId ? { goalId: input.goalId } : {}),
        ...(input.decisionId ? { decisionId: input.decisionId } : {}),
        title: auroraText(input.title, 300, "Plan title"),
        objective: auroraText(input.objective, 20_000, "Plan objective"),
        horizon: input.horizon ?? "tactical",
        status: "active",
        version: 1,
        steps,
        criticalPath: [],
        estimatedMinutes: 0,
        estimatedTokens: 0,
        riskBufferMinutes: 0,
        progress: 0,
        tags: auroraTags(input.tags, "Plan tags"),
        revisions: [{ version: 1, reason: "Initial plan.", trigger: "manual", changedStepKeys: steps.map((item) => item.key), at: nowIso }],
        digest: "",
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.recompute(plan);
      state.plans.push(plan);
      return structuredClone(plan);
    });
  }

  /**
   * Replace the step graph with a new version. The reason and trigger are mandatory: a plan that
   * changes without an explanation is indistinguishable from a plan that was never followed.
   */
  async revise(input: {
    tenantId: string; planId: string; reason: string; trigger?: PlanRevision["trigger"];
    steps: Array<{ key: string; title: string; detail?: string; dependsOn?: string[]; estimateMinutes?: number; estimateTokens?: number; riskLevel?: number; verification?: string; assignedRoleId?: string; status?: PlanStepStatus }>;
  }): Promise<PlanRecord> {
    return await this.store.mutate((state) => {
      const plan = this.mutable(state, input.tenantId, input.planId);
      if (["completed", "abandoned", "superseded"].includes(plan.status)) throw new Error("A finished plan cannot be revised; create a successor plan instead.");
      const previous = new Map(plan.steps.map((item) => [item.key, item]));
      const steps = this.buildSteps(input.steps).map((step) => {
        const existing = previous.get(step.key);
        if (!existing) return step;
        // Completed work survives replanning unless the caller explicitly resets it.
        return {
          ...step,
          status: input.steps.find((item) => item.key === step.key)?.status ?? existing.status,
          ...(existing.startedAt ? { startedAt: existing.startedAt } : {}),
          ...(existing.finishedAt ? { finishedAt: existing.finishedAt } : {}),
          ...(existing.actualMinutes !== undefined ? { actualMinutes: existing.actualMinutes } : {}),
          evidenceRefs: [...new Set([...existing.evidenceRefs, ...step.evidenceRefs])].slice(0, 200),
        } satisfies PlanStep;
      });
      const changed = steps.filter((step) => {
        const existing = previous.get(step.key);
        return !existing || existing.title !== step.title || JSON.stringify(existing.dependsOn) !== JSON.stringify(step.dependsOn);
      }).map((step) => step.key);
      const removed = [...previous.keys()].filter((key) => !steps.some((step) => step.key === key));
      const nowIso = new Date(this.now()).toISOString();
      plan.steps = steps;
      plan.version++;
      plan.revisions.push({
        version: plan.version,
        reason: auroraText(input.reason, 5000, "Revision reason"),
        trigger: input.trigger ?? "manual",
        changedStepKeys: [...changed, ...removed.map((key) => `-${key}`)].slice(0, 200),
        at: nowIso,
      });
      if (plan.revisions.length > 500) plan.revisions.splice(0, plan.revisions.length - 500);
      plan.status = plan.status === "blocked" ? "active" : plan.status;
      plan.updatedAt = nowIso;
      this.recompute(plan);
      return structuredClone(plan);
    });
  }

  /** Advance one step. Dependencies must be satisfied before a step can start. */
  async updateStep(input: {
    tenantId: string; planId: string; stepKey: string; status: PlanStepStatus;
    note?: string; actualMinutes?: number; evidenceRefs?: string[]; taskId?: string;
  }): Promise<PlanRecord> {
    return await this.store.mutate((state) => {
      const plan = this.mutable(state, input.tenantId, input.planId);
      const step = plan.steps.find((item) => item.key === input.stepKey.trim().toLowerCase());
      if (!step) throw new Error("Plan step not found.");
      const nowIso = new Date(this.now()).toISOString();
      if (input.status === "in-progress") {
        const unmet = step.dependsOn.filter((key) => plan.steps.find((item) => item.key === key)?.status !== "done"
          && plan.steps.find((item) => item.key === key)?.status !== "skipped");
        if (unmet.length) throw new Error(`Step "${step.key}" still depends on: ${unmet.join(", ")}.`);
        step.startedAt = step.startedAt ?? nowIso;
      }
      if (input.status === "done" || input.status === "skipped" || input.status === "failed") step.finishedAt = nowIso;
      step.status = input.status;
      if (input.note) step.note = auroraText(input.note, 5000, "Step note");
      if (input.actualMinutes !== undefined) step.actualMinutes = auroraInteger(input.actualMinutes, 0, 100_000, "Actual minutes");
      if (input.taskId) step.taskId = auroraText(input.taskId, 200, "Step task ID");
      if (input.evidenceRefs) step.evidenceRefs = [...new Set([...step.evidenceRefs, ...auroraIds(input.evidenceRefs, 200, "Step evidence refs")])].slice(0, 200);
      plan.updatedAt = nowIso;
      this.recompute(plan);
      if (plan.steps.every((item) => ["done", "skipped"].includes(item.status))) {
        plan.status = "completed";
        plan.completedAt = nowIso;
      } else if (plan.steps.some((item) => item.status === "failed")) {
        plan.status = "blocked";
      } else if (plan.status === "completed") {
        plan.status = "active";
        delete plan.completedAt;
      }
      return structuredClone(plan);
    });
  }

  async abandon(tenantId: string, planId: string, reason: string): Promise<PlanRecord> {
    return await this.store.mutate((state) => {
      const plan = this.mutable(state, tenantId, planId);
      plan.status = "abandoned";
      plan.revisions.push({ version: plan.version, reason: auroraText(reason, 5000, "Abandon reason"), trigger: "manual", changedStepKeys: [], at: new Date(this.now()).toISOString() });
      plan.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(plan);
    });
  }

  /** Create a successor plan and mark the previous one superseded, preserving both. */
  async supersede(input: { tenantId: string; planId: string; title?: string; objective?: string; reason: string; steps: Array<{ key: string; title: string; detail?: string; dependsOn?: string[]; estimateMinutes?: number; estimateTokens?: number; riskLevel?: number; verification?: string }> }): Promise<{ previous: PlanRecord; next: PlanRecord }> {
    const previous = await this.get(input.tenantId, input.planId);
    const next = await this.create({
      tenantId: input.tenantId,
      title: input.title ?? `${previous.title} (v${previous.version + 1})`,
      objective: input.objective ?? previous.objective,
      horizon: previous.horizon,
      ...(previous.sessionId ? { sessionId: previous.sessionId } : {}),
      ...(previous.goalId ? { goalId: previous.goalId } : {}),
      tags: previous.tags,
      steps: input.steps,
    });
    const updated = await this.store.mutate((state) => {
      const record = this.mutable(state, input.tenantId, input.planId);
      record.status = "superseded";
      record.revisions.push({ version: record.version, reason: auroraText(input.reason, 5000, "Supersede reason"), trigger: "scope-change", changedStepKeys: [], at: new Date(this.now()).toISOString() });
      record.updatedAt = new Date(this.now()).toISOString();
      const successor = state.plans.find((item) => item.id === next.id);
      if (successor) successor.supersedesPlanId = record.id;
      return structuredClone(record);
    });
    return { previous: updated, next: await this.get(input.tenantId, next.id) };
  }

  async get(tenantId: string, planId: string): Promise<PlanRecord> {
    const state = await this.store.read();
    const plan = state.plans.find((item) => item.tenantId === tenantId && item.id === planId);
    if (!plan) throw new Error("Aurora plan not found in tenant.");
    return structuredClone(plan);
  }

  async list(tenantId: string, filter?: { status?: PlanStatus; goalId?: string; limit?: number }): Promise<PlanRecord[]> {
    const state = await this.store.read();
    return state.plans
      .filter((item) => item.tenantId === tenantId && (!filter?.status || item.status === filter.status) && (!filter?.goalId || item.goalId === filter.goalId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, auroraInteger(filter?.limit ?? 100, 1, 1000, "Plan limit"))
      .map((item) => structuredClone(item));
  }

  /** What can start now, what is waiting on what, and how much work is genuinely left. */
  async progress(tenantId: string, planId: string): Promise<PlanProgressReport> {
    const plan = await this.get(tenantId, planId);
    const byKey = new Map(plan.steps.map((item) => [item.key, item]));
    const isSatisfied = (key: string): boolean => ["done", "skipped"].includes(byKey.get(key)?.status ?? "");
    const ready = plan.steps.filter((item) => item.status === "pending" || item.status === "ready")
      .filter((item) => item.dependsOn.every(isSatisfied)).map((item) => item.key);
    const blocked = plan.steps.filter((item) => !["done", "skipped"].includes(item.status))
      .map((item) => ({ key: item.key, waitingOn: item.dependsOn.filter((key) => !isSatisfied(key)) }))
      .filter((item) => item.waitingOn.length > 0);
    const remaining = plan.steps.filter((item) => !["done", "skipped"].includes(item.status));
    const finished = plan.steps.filter((item) => item.status === "done" && item.actualMinutes !== undefined);
    const estimateAccuracy = finished.length
      ? auroraRound(1 - Math.min(1, finished.reduce((sum, item) => sum + Math.abs((item.actualMinutes ?? 0) - item.estimateMinutes) / Math.max(1, item.estimateMinutes), 0) / finished.length))
      : undefined;
    return {
      planId: plan.id,
      status: plan.status,
      progress: plan.progress,
      done: plan.steps.filter((item) => ["done", "skipped"].includes(item.status)).length,
      total: plan.steps.length,
      ready,
      blocked,
      failed: plan.steps.filter((item) => item.status === "failed").map((item) => item.key),
      remainingMinutes: remaining.reduce((sum, item) => sum + item.estimateMinutes, 0),
      remainingTokens: remaining.reduce((sum, item) => sum + item.estimateTokens, 0),
      criticalPathRemaining: plan.criticalPath.filter((key) => !isSatisfied(key)),
      ...(estimateAccuracy !== undefined ? { estimateAccuracy } : {}),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Plans that have not moved for a while: the stalled-progress signal for the initiative engine. */
  async stalled(tenantId: string, days = 7): Promise<Array<{ plan: PlanRecord; idleDays: number; readySteps: string[] }>> {
    const state = await this.store.read();
    const timestamp = this.now();
    const window = auroraInteger(days, 1, 365, "Stalled window") * 86_400_000;
    const results: Array<{ plan: PlanRecord; idleDays: number; readySteps: string[] }> = [];
    for (const plan of state.plans.filter((item) => item.tenantId === tenantId && ["active", "blocked"].includes(item.status))) {
      const idle = timestamp - Date.parse(plan.updatedAt);
      if (idle < window) continue;
      const byKey = new Map(plan.steps.map((item) => [item.key, item]));
      const ready = plan.steps.filter((item) => !["done", "skipped"].includes(item.status)
        && item.dependsOn.every((key) => ["done", "skipped"].includes(byKey.get(key)?.status ?? ""))).map((item) => item.key);
      results.push({ plan: structuredClone(plan), idleDays: Math.floor(idle / 86_400_000), readySteps: ready });
    }
    return results.sort((a, b) => b.idleDays - a.idleDays);
  }

  private buildSteps(input: Array<{ key: string; title: string; detail?: string; dependsOn?: string[]; estimateMinutes?: number; estimateTokens?: number; riskLevel?: number; verification?: string; assignedRoleId?: string; status?: PlanStepStatus }>): PlanStep[] {
    if (!input.length || input.length > MAX_STEPS) throw new Error(`A plan needs 1-${MAX_STEPS} steps.`);
    const keys = new Set<string>();
    const steps: PlanStep[] = input.map((item) => {
      const key = auroraText(item.key, 120, "Step key").toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(key)) throw new Error("Step keys must be lowercase identifiers.");
      if (keys.has(key)) throw new Error(`Duplicate plan step key "${key}".`);
      keys.add(key);
      return {
        id: `step-${randomUUID()}`,
        key,
        title: auroraText(item.title, 300, "Step title"),
        detail: item.detail ? auroraText(item.detail, 20_000, "Step detail") : "",
        dependsOn: [...new Set((item.dependsOn ?? []).map((value) => value.trim().toLowerCase()))].slice(0, 50),
        status: item.status ?? "pending",
        estimateMinutes: auroraInteger(item.estimateMinutes ?? 30, 0, 100_000, "Step estimate minutes"),
        estimateTokens: auroraInteger(item.estimateTokens ?? 10_000, 0, 100_000_000, "Step estimate tokens"),
        riskLevel: auroraUnit(item.riskLevel ?? 0.2, "Step risk"),
        verification: item.verification ? auroraText(item.verification, 2000, "Step verification") : "",
        ...(item.assignedRoleId ? { assignedRoleId: auroraText(item.assignedRoleId, 200, "Step role") } : {}),
        evidenceRefs: [],
      } satisfies PlanStep;
    });
    for (const step of steps) {
      for (const dependency of step.dependsOn) {
        if (!keys.has(dependency)) throw new Error(`Step "${step.key}" depends on unknown step "${dependency}".`);
        if (dependency === step.key) throw new Error(`Step "${step.key}" cannot depend on itself.`);
      }
    }
    const cycle = findCycle(steps);
    if (cycle) throw new Error(`Plan dependency cycle detected: ${cycle.join(" -> ")}.`);
    return steps;
  }

  private recompute(plan: PlanRecord): void {
    const byKey = new Map(plan.steps.map((item) => [item.key, item]));
    const memo = new Map<string, { minutes: number; path: string[] }>();
    const longest = (key: string, guard = new Set<string>()): { minutes: number; path: string[] } => {
      const cached = memo.get(key);
      if (cached) return cached;
      if (guard.has(key)) return { minutes: 0, path: [] };
      guard.add(key);
      const step = byKey.get(key);
      if (!step) return { minutes: 0, path: [] };
      let best: { minutes: number; path: string[] } = { minutes: 0, path: [] };
      for (const dependency of step.dependsOn) {
        const candidate = longest(dependency, guard);
        if (candidate.minutes > best.minutes) best = candidate;
      }
      const result = { minutes: best.minutes + step.estimateMinutes, path: [...best.path, key] };
      memo.set(key, result);
      guard.delete(key);
      return result;
    };
    let critical: { minutes: number; path: string[] } = { minutes: 0, path: [] };
    for (const step of plan.steps) {
      const candidate = longest(step.key);
      if (candidate.minutes > critical.minutes) critical = candidate;
    }
    const done = plan.steps.filter((item) => ["done", "skipped"].includes(item.status)).length;
    plan.criticalPath = critical.path;
    plan.estimatedMinutes = plan.steps.reduce((sum, item) => sum + item.estimateMinutes, 0);
    plan.estimatedTokens = plan.steps.reduce((sum, item) => sum + item.estimateTokens, 0);
    // Risk buffer: riskier steps buy more slack on the critical path.
    plan.riskBufferMinutes = Math.round(plan.steps.reduce((sum, item) => sum + item.estimateMinutes * item.riskLevel, 0));
    plan.progress = plan.steps.length ? auroraRound(done / plan.steps.length) : 0;
    plan.digest = auroraDigest(plan.steps.map((item) => `${item.key}:${item.status}:${item.dependsOn.join(",")}`).join("|"));
    for (const step of plan.steps) {
      if (step.status !== "pending") continue;
      if (step.dependsOn.every((key) => ["done", "skipped"].includes(byKey.get(key)?.status ?? ""))) step.status = "ready";
    }
  }

  private mutable(state: PlanningStateShape, tenantId: string, id: string): PlanRecord {
    const plan = state.plans.find((item) => item.tenantId === tenantId && item.id === id);
    if (!plan) throw new Error("Aurora plan not found in tenant.");
    return plan;
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



function findCycle(steps: PlanStep[]): string[] | undefined {
  const graph = new Map(steps.map((item) => [item.key, item.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const walk = (key: string): string[] | undefined => {
    if (visited.has(key)) return undefined;
    if (visiting.has(key)) return [...stack.slice(stack.indexOf(key)), key];
    visiting.add(key);
    stack.push(key);
    for (const dependency of graph.get(key) ?? []) {
      const cycle = walk(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(key);
    visited.add(key);
    return undefined;
  };
  for (const step of steps) {
    const cycle = walk(step.key);
    if (cycle) return cycle;
  }
  return undefined;
}
