import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type StepStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

interface PlanStep { id: string; name: string; description: string; status: StepStatus; dependencies: string[]; estimatedMs: number; actualMs: number; outputs: string[]; risk: "low" | "medium" | "high"; }
interface Plan { id: string; tenantId: string; goal: string; steps: PlanStep[]; strategy: string; estimatedTotalMs: number; actualTotalMs: number; successRate: number; adaptiveChanges: { stepId: string; change: string; reason: string; timestamp: string; }[]; status: "draft" | "active" | "completed" | "abandoned"; createdAt: string; completedAt: string; }
interface PlannerStats { plansCreated: number; plansCompleted: number; avgStepsPerPlan: number; avgAccuracy: number; mostCommonStrategy: string; adaptiveChangesCount: number; }

interface PlannerState { schemaVersion: number; plans: Plan[]; strategyUsage: Record<string, { count: number; successRate: number }>; }

export class PlannerV2Service {
  private store: DurableJsonState<PlannerState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<PlannerState>(
      join(baseDir, "planner-v2.json"),
      () => ({ schemaVersion: 1, plans: [], strategyUsage: {} }),
      (v) => { const s = v as PlannerState; return !!s && s.schemaVersion === 1; },
      "Aurora planner v2",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async createPlan(tenantId: string, goal: string, strategy: string, steps: Omit<PlanStep, "id" | "status" | "actualMs" | "outputs">[]): Promise<Plan> {
    const planSteps: PlanStep[] = steps.map(s => ({ ...s, id: randomUUID(), status: "pending", actualMs: 0, outputs: [] }));
    const plan: Plan = { id: randomUUID(), tenantId, goal, steps: planSteps, strategy, estimatedTotalMs: planSteps.reduce((sum, s) => sum + s.estimatedMs, 0), actualTotalMs: 0, successRate: 0, adaptiveChanges: [], status: "draft", createdAt: new Date().toISOString(), completedAt: "" };
    await this.store.mutate(s => {
      s.plans.push(plan);
      if (!s.strategyUsage[strategy]) s.strategyUsage[strategy] = { count: 0, successRate: 0 };
      s.strategyUsage[strategy]!.count++;
    });
    return plan;
  }

  async activatePlan(planId: string): Promise<void> {
    await this.store.mutate(s => { const p = s.plans.find(x => x.id === planId); if (p && p.status === "draft") p.status = "active"; });
  }

  async updateStep(planId: string, stepId: string, status: StepStatus, outputs: string[] = []): Promise<void> {
    await this.store.mutate(s => {
      const plan = s.plans.find(x => x.id === planId);
      if (!plan) return;
      const step = plan.steps.find(x => x.id === stepId);
      if (!step) return;
      step.status = status;
      step.outputs = outputs;
      if (status === "completed" || status === "failed") step.actualMs = Date.now() - new Date(plan.createdAt).getTime();
      // Check if all steps done
      const allDone = plan.steps.every(st => st.status === "completed" || st.status === "failed" || st.status === "skipped");
      if (allDone) {
        plan.status = plan.steps.some(st => st.status === "failed") ? "abandoned" : "completed";
        plan.completedAt = new Date().toISOString();
        plan.actualTotalMs = plan.steps.reduce((sum, st) => sum + st.actualMs, 0);
        plan.successRate = plan.steps.filter(st => st.status === "completed").length / plan.steps.length;
      }
    });
  }

  async adaptPlan(planId: string, stepId: string, change: string, reason: string): Promise<void> {
    await this.store.mutate(s => {
      const plan = s.plans.find(x => x.id === planId);
      if (!plan) return;
      plan.adaptiveChanges.push({ stepId, change, reason, timestamp: new Date().toISOString() });
    });
  }

  async getPlans(tenantId: string, limit = 30): Promise<Plan[]> {
    const s = await this.store.read();
    return s.plans.filter(p => p.tenantId === tenantId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  }

  async getStats(tenantId: string): Promise<PlannerStats> {
    const s = await this.store.read();
    const tp = s.plans.filter(p => p.tenantId === tenantId);
    const completed = tp.filter(p => p.status === "completed");
    const avgAccuracy = completed.length ? completed.reduce((sum, p) => {
      const estimatedMs = p.estimatedTotalMs || 1;
      return sum + Math.min(2, p.actualTotalMs / estimatedMs);
    }, 0) / completed.length : 0;
    let mostCommon = ""; let maxCount = 0;
    for (const [k, v] of Object.entries(s.strategyUsage)) { if (v.count > maxCount) { maxCount = v.count; mostCommon = k; } }
    return { plansCreated: tp.length, plansCompleted: completed.length, avgStepsPerPlan: tp.length ? tp.reduce((sum, p) => sum + p.steps.length, 0) / tp.length : 0, avgAccuracy, mostCommonStrategy: mostCommon, adaptiveChangesCount: tp.reduce((sum, p) => sum + p.adaptiveChanges.length, 0) };
  }

  // ═══ P2: Explainability ═══

  async why(tenantId: string, planId: string): Promise<{
    planTitle: string; goal: string; strategy: string;
    rationale: string[]; taskBreakdown: Array<{ task: string; status: string; dependency: string | null }>;
    risks: string[]; estimatedCompletion: string;
  }> {
    const s = await this.store.read();
    const p = s.plans.find((x: any) => x.tenantId === tenantId && x.id === planId);
    if (!p) throw new Error("Aurora plan not found");
    const rationale: string[] = [`Plan: ${p.goal ?? p.id}`, `Strategy: ${p.strategy}`, `Steps: ${p.steps.length}`];
    const taskBreakdown = p.steps.map((st: any) => ({ task: st.name ?? st.description ?? st.id, status: st.status, dependency: st.dependsOn ?? null }));
    const risks = p.adaptiveChanges.map((c: any) => c.reason ?? "adaptive change");
    const remaining = p.steps.filter((st: any) => st.status !== "completed").length;
    const estimatedCompletion = remaining === 0 ? "Complete" : `~${remaining * 2}h remaining`;
    return { planTitle: p.id, goal: p.goal ?? p.id, strategy: p.strategy, rationale, taskBreakdown, risks, estimatedCompletion };
  }
}
