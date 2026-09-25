import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type GoalStatus = "pending" | "active" | "completed" | "failed" | "deferred" | "abandoned";
type GoalPriority = "P0" | "P1" | "P2" | "P3" | "P4";

interface Goal { id: string; tenantId: string; title: string; description: string; priority: GoalPriority; status: GoalStatus; parentId: string; childIds: string[]; dependencies: string[]; progress: number; successCriteria: string; blockers: string[]; estimatedEffort: number; actualEffort: number; createdAt: string; completedAt: string; }
interface GoalMetrics { completionRate: number; avgTimeToComplete: number; mostCommonBlocker: string; priorityDistribution: Record<string, number>; }

interface GoalState { schemaVersion: number; goals: Goal[]; }

export class GoalStackService {
  private store: DurableJsonState<GoalState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<GoalState>(
      join(baseDir, "goal-stack.json"),
      () => ({ schemaVersion: 1, goals: [] }),
      (v) => { const s = v as GoalState; return !!s && s.schemaVersion === 1; },
      "Aurora goal stack",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async addGoal(tenantId: string, title: string, description: string, priority: GoalPriority, successCriteria: string, parentId?: string, estimatedEffort?: number): Promise<Goal> {
    const goal: Goal = { id: randomUUID(), tenantId, title, description, priority, status: "pending", parentId: parentId ?? "", childIds: [], dependencies: [], progress: 0, successCriteria, blockers: [], estimatedEffort: estimatedEffort ?? 0, actualEffort: 0, createdAt: new Date().toISOString(), completedAt: "" };
    await this.store.mutate(s => {
      s.goals.push(goal);
      if (parentId) { const parent = s.goals.find(g => g.id === parentId); if (parent) parent.childIds.push(goal.id); }
    });
    return goal;
  }

  async activateGoal(goalId: string): Promise<void> {
    await this.store.mutate(s => {
      const g = s.goals.find(x => x.id === goalId);
      if (!g || g.status !== "pending") return;
      const depsResolved = g.dependencies.every(depId => s.goals.find(x => x.id === depId)?.status === "completed");
      if (!depsResolved) return;
      g.status = "active";
    });
  }

  async updateProgress(goalId: string, progress: number, blockers: string[] = []): Promise<void> {
    await this.store.mutate(s => {
      const g = s.goals.find(x => x.id === goalId);
      if (!g) return;
      g.progress = Math.max(0, Math.min(1, progress));
      g.blockers = blockers;
      if (g.progress >= 1) { g.status = "completed"; g.completedAt = new Date().toISOString(); }
    });
  }

  async addDependency(goalId: string, dependencyId: string): Promise<void> {
    await this.store.mutate(s => {
      const g = s.goals.find(x => x.id === goalId);
      if (g && !g.dependencies.includes(dependencyId)) g.dependencies.push(dependencyId);
    });
  }

  async deferGoal(goalId: string): Promise<void> {
    await this.store.mutate(s => { const g = s.goals.find(x => x.id === goalId); if (g && g.status === "pending") g.status = "deferred"; });
  }

  async getActiveGoals(tenantId: string): Promise<Goal[]> {
    const s = await this.store.read();
    const priorityOrder: Record<GoalPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
    return s.goals.filter(g => g.tenantId === tenantId && (g.status === "active" || g.status === "pending")).sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  }

  async getGoalTree(tenantId: string): Promise<Goal[]> {
    const s = await this.store.read();
    return s.goals.filter(g => g.tenantId === tenantId && !g.parentId);
  }

  async getMetrics(tenantId: string): Promise<GoalMetrics> {
    const s = await this.store.read();
    const tg = s.goals.filter(g => g.tenantId === tenantId);
    const completed = tg.filter(g => g.status === "completed");
    const completionRate = tg.length ? completed.length / tg.length : 0;
    const avgTime = completed.length ? completed.reduce((sum, g) => sum + (new Date(g.completedAt).getTime() - new Date(g.createdAt).getTime()), 0) / completed.length : 0;
    const blockerCount: Record<string, number> = {};
    for (const g of tg) for (const b of g.blockers) blockerCount[b] = (blockerCount[b] ?? 0) + 1;
    let mostCommonBlocker = ""; let maxB = 0;
    for (const [k, v] of Object.entries(blockerCount)) { if (v > maxB) { maxB = v; mostCommonBlocker = k; } }
    const priorityDist: Record<string, number> = {};
    for (const g of tg) priorityDist[g.priority] = (priorityDist[g.priority] ?? 0) + 1;
    return { completionRate, avgTimeToComplete: avgTime, mostCommonBlocker, priorityDistribution: priorityDist };
  }

  // ═══ P2: Explainability ═══

  
  // ═══ P3: Stats ═══

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const items = (s as any).goals?.filter((x: any) => x.tenantId === tenantId) ?? [];
    return { total: items.length };
  }

async why(tenantId: string, goalId: string): Promise<{
    goal: string; priority: number; progress: number; status: string;
    rationale: string[]; blockers: string[]; dependencies: string[];
  }> {
    const s = await this.store.read();
    const g = s.goals.find((x: any) => x.tenantId === tenantId && x.id === goalId);
    if (!g) throw new Error("Aurora goal not found");
    const rationale: string[] = [`Goal: ${g.description}`, `Priority: ${g.priority}`, `Progress: ${(g.progress * 100).toFixed(0)}%`];
    if (g.progress < 0.3 && g.status === "active") rationale.push("WARNING: Goal is stalled — may need intervention");
    if (g.childIds.length > 0) rationale.push(`Has ${g.childIds.length} child goal(s)`);
    if (g.dependencies.length > 0) rationale.push(`Depends on ${g.dependencies.length} goal(s)`);
    return { goal: g.description, priority: typeof g.priority === "number" ? g.priority : 5, progress: g.progress, status: g.status, rationale, blockers: g.blockers, dependencies: g.dependencies };
  }
}
