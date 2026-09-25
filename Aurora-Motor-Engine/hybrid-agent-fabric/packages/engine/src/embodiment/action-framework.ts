/**
 * Action Framework
 * Goal → Plan → Action → Result → Verification → Memory cycle.
 * Enables Aurora to plan and execute multi-step actions.
 *
 * P0-8 FIX: All state now durable via DurableJsonState.
 * Process crash loses nothing. Supports file and Postgres persistence.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

export type GoalStatus = "proposed" | "accepted" | "in_progress" | "completed" | "failed" | "abandoned";
export type PlanStatus = "draft" | "approved" | "executing" | "completed" | "failed";
export type ActionStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface Goal {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  status: GoalStatus;
  priority: "P0" | "P1" | "P2" | "P3" | "P4";
  successCriteria: string[];
  constraints: string[];
  deadline?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Plan {
  id: string;
  tenantId: string;
  goalId: string;
  title: string;
  description: string;
  status: PlanStatus;
  steps: PlanStep[];
  estimatedDurationMs: number;
  estimatedTokens: number;
  riskLevel: RiskLevel;
  createdAt: string;
  updatedAt: string;
}

export interface PlanStep {
  id: string;
  order: number;
  title: string;
  description: string;
  actionType: string;
  input: Record<string, unknown>;
  expectedOutput: string;
  dependsOn: string[];
  status: ActionStatus;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  owner: string;
  result?: ActionResult;
  rollbackAction?: string;
}

export interface ActionResult {
  success: boolean;
  output: unknown;
  error?: string;
  durationMs: number;
  tokensUsed: number;
  sideEffects: string[];
  verificationNeeded: boolean;
  evidence: string[];
}

export interface Verification {
  id: string;
  planId: string;
  stepId: string;
  status: "pending" | "passed" | "failed" | "skipped";
  checks: VerificationCheck[];
  result?: string;
  verifiedAt?: string;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
  message?: string;
}

export interface ActionFrameworkConfig {
  maxStepsPerPlan: number;
  maxConcurrentActions: number;
  enableAutoVerification: boolean;
  enableMemoryCapture: boolean;
  maxPlanDurationMs: number;
}

const DEFAULT_CONFIG: ActionFrameworkConfig = {
  maxStepsPerPlan: 20,
  maxConcurrentActions: 3,
  enableAutoVerification: true,
  enableMemoryCapture: true,
  maxPlanDurationMs: 30 * 60 * 1000,
};

interface ActionFrameworkState {
  schemaVersion: number;
  goals: Goal[];
  plans: Plan[];
  verifications: Verification[];
}

export class ActionFramework {
  private config: ActionFrameworkConfig;
  private engine: any;
  private store: DurableJsonState<ActionFrameworkState>;

  constructor(engine: any, config: Partial<ActionFrameworkConfig> = {}, baseDir?: string) {
    this.engine = engine;
    this.config = { ...DEFAULT_CONFIG, ...config };

    const dataRoot = baseDir
      ?? (engine.config?.homePath
        ? join(engine.config.homePath, "data")
        : join(process.cwd(), "data"));

    this.store = new DurableJsonState<ActionFrameworkState>(
      join(dataRoot, "action-framework.json"),
      () => ({ schemaVersion: 1, goals: [], plans: [], verifications: [] }),
      (v) => { const s = v as ActionFrameworkState; return !!s && s.schemaVersion === 1; },
      "Aurora action framework (durable)",
    );
  }

  async init(): Promise<void> {
    await this.store.read();
  }

  // ═══ Goal Operations ═══

  async createGoal(input: {
    tenantId: string;
    title: string;
    description: string;
    priority?: Goal["priority"];
    successCriteria?: string[];
    constraints?: string[];
    deadline?: string;
  }): Promise<Goal> {
    const now = new Date().toISOString();
    const goal: Goal = {
      id: randomUUID(),
      tenantId: input.tenantId,
      title: input.title,
      description: input.description,
      status: "proposed",
      priority: input.priority ?? "P2",
      successCriteria: input.successCriteria ?? [],
      constraints: input.constraints ?? [],
      createdAt: now,
      updatedAt: now,
    };

    await this.store.mutate(s => { s.goals.push(goal); });
    return goal;
  }

  async acceptGoal(goalId: string): Promise<Goal> {
    return await this.store.mutate(s => {
      const goal = s.goals.find(g => g.id === goalId);
      if (!goal) throw new Error(`Goal not found: ${goalId}`);
      goal.status = "accepted";
      goal.updatedAt = new Date().toISOString();
      return { ...goal };
    });
  }

  // ═══ Plan Operations ═══

  async createPlan(input: {
    tenantId: string;
    goalId: string;
    title: string;
    description: string;
    steps: Array<{
      title: string;
      description: string;
      actionType: string;
      input?: Record<string, unknown>;
      expectedOutput?: string;
      dependsOn?: number[];
    }>;
    riskLevel?: RiskLevel;
  }): Promise<Plan> {
    if (input.steps.length > this.config.maxStepsPerPlan) {
      throw new Error(`Too many steps: ${input.steps.length} (max: ${this.config.maxStepsPerPlan})`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    const steps: PlanStep[] = input.steps.map((step, index) => ({
      id: `${id}-step-${index}`,
      order: index,
      title: step.title,
      description: step.description,
      actionType: step.actionType,
      input: step.input ?? {},
      expectedOutput: step.expectedOutput ?? "",
      dependsOn: (step.dependsOn ?? []).map(depIndex => `${id}-step-${depIndex}`),
      status: "pending",
      attempt: 0,
      startedAt: "",
      finishedAt: "",
      owner: "system",
    }));

    const plan: Plan = {
      id,
      tenantId: input.tenantId,
      goalId: input.goalId,
      title: input.title,
      description: input.description,
      status: "draft",
      steps,
      estimatedDurationMs: steps.length * 5000,
      estimatedTokens: steps.length * 500,
      riskLevel: input.riskLevel ?? "low",
      createdAt: now,
      updatedAt: now,
    };

    await this.store.mutate(s => { s.plans.push(plan); });
    return plan;
  }

  async approvePlan(planId: string): Promise<Plan> {
    return await this.store.mutate(s => {
      const plan = s.plans.find(p => p.id === planId);
      if (!plan) throw new Error(`Plan not found: ${planId}`);
      plan.status = "approved";
      plan.updatedAt = new Date().toISOString();

      const goal = s.goals.find(g => g.id === plan.goalId);
      if (goal) { goal.status = "in_progress"; goal.updatedAt = new Date().toISOString(); }

      return { ...plan };
    });
  }

  // ═══ Step Execution ═══

  async startStep(planId: string, stepId: string, owner: string = "system"): Promise<void> {
    await this.store.mutate(s => {
      const plan = s.plans.find(p => p.id === planId);
      if (!plan) throw new Error(`Plan not found: ${planId}`);
      const step = plan.steps.find(st => st.id === stepId);
      if (!step) throw new Error(`Step not found: ${stepId}`);
      step.status = "running";
      step.attempt++;
      step.startedAt = new Date().toISOString();
      step.owner = owner;
      if (plan.status === "approved") plan.status = "executing";
    });
  }

  async recordStepResult(planId: string, stepId: string, result: ActionResult): Promise<void> {
    await this.store.mutate(s => {
      const plan = s.plans.find(p => p.id === planId);
      if (!plan) throw new Error(`Plan not found: ${planId}`);
      const step = plan.steps.find(st => st.id === stepId);
      if (!step) throw new Error(`Step not found: ${stepId}`);

      step.status = result.success ? "completed" : "failed";
      step.result = result;
      step.finishedAt = new Date().toISOString();
      plan.updatedAt = new Date().toISOString();

      const allDone = plan.steps.every(st => st.status === "completed" || st.status === "skipped");
      const anyFailed = plan.steps.some(st => st.status === "failed");

      if (allDone) {
        plan.status = "completed";
        const goal = s.goals.find(g => g.id === plan.goalId);
        if (goal) { goal.status = "completed"; goal.updatedAt = new Date().toISOString(); }
      } else if (anyFailed) {
        plan.status = "failed";
        const goal = s.goals.find(g => g.id === plan.goalId);
        if (goal) { goal.status = "failed"; goal.updatedAt = new Date().toISOString(); }
      }
    });
  }

  // ═══ Verification ═══

  async createVerification(planId: string, stepId: string, checks: VerificationCheck[]): Promise<Verification> {
    const verification: Verification = {
      id: randomUUID(),
      planId,
      stepId,
      status: "pending",
      checks,
    };

    await this.store.mutate(s => { s.verifications.push(verification); });
    return verification;
  }

  async executeVerification(verificationId: string): Promise<Verification> {
    return await this.store.mutate(s => {
      const v = s.verifications.find(x => x.id === verificationId);
      if (!v) throw new Error(`Verification not found: ${verificationId}`);
      const allPassed = v.checks.every(c => c.passed);
      v.status = allPassed ? "passed" : "failed";
      v.result = allPassed ? "All checks passed" : "Some checks failed";
      v.verifiedAt = new Date().toISOString();
      return { ...v };
    });
  }

  // ═══ Queries ═══

  async getGoals(tenantId?: string): Promise<Goal[]> {
    const s = await this.store.read();
    return tenantId ? s.goals.filter(g => g.tenantId === tenantId) : s.goals;
  }

  async getPlans(tenantId?: string): Promise<Plan[]> {
    const s = await this.store.read();
    return tenantId ? s.plans.filter(p => p.tenantId === tenantId) : s.plans;
  }

  async getPlansForGoal(goalId: string): Promise<Plan[]> {
    const s = await this.store.read();
    return s.plans.filter(p => p.goalId === goalId);
  }

  async getVerifications(planId?: string): Promise<Verification[]> {
    const s = await this.store.read();
    return planId ? s.verifications.filter(v => v.planId === planId) : s.verifications;
  }

  async getStats(tenantId?: string) {
    const s = await this.store.read();
    const goals = tenantId ? s.goals.filter(g => g.tenantId === tenantId) : s.goals;
    const plans = tenantId ? s.plans.filter(p => p.tenantId === tenantId) : s.plans;
    return {
      totalGoals: goals.length,
      activeGoals: goals.filter(g => g.status === "in_progress").length,
      completedGoals: goals.filter(g => g.status === "completed").length,
      failedGoals: goals.filter(g => g.status === "failed").length,
      totalPlans: plans.length,
      activePlans: plans.filter(p => p.status === "executing").length,
      completedPlans: plans.filter(p => p.status === "completed").length,
      totalVerifications: s.verifications.length,
      config: this.config,
    };
  }
}
