import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type SwarmRole = "leader" | "worker" | "scout" | "optimizer" | "validator";
type SwarmTaskStatus = "pending" | "assigned" | "executing" | "completed" | "failed";

interface SwarmMember { agentId: string; role: SwarmRole; capabilities: string[]; load: number; reliability: number; joinedAt: string; }
interface SwarmTask { id: string; tenantId: string; description: string; assignedTo: string[]; status: SwarmTaskStatus; priority: number; parallelizable: boolean; subtasks: { id: string; assignedTo: string; status: SwarmTaskStatus; output: string; }[]; result: string; createdAt: string; completedAt: string; }
interface SwarmSession { id: string; tenantId: string; name: string; members: SwarmMember[]; tasks: SwarmTask[]; strategy: "round-robin" | "capability-match" | "load-balance" | "auction"; totalTasks: number; completedTasks: number; avgCompletionMs: number; createdAt: string; }

interface SwarmState { schemaVersion: number; swarms: SwarmSession[]; }

export class SwarmOrchestrationService {
  private store: DurableJsonState<SwarmState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<SwarmState>(
      join(baseDir, "swarm-orchestration.json"),
      () => ({ schemaVersion: 1, swarms: [] }),
      (v) => { const s = v as SwarmState; return !!s && s.schemaVersion === 1; },
      "Aurora swarm orchestration",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async createSwarm(tenantId: string, name: string, strategy: SwarmSession["strategy"]): Promise<SwarmSession> {
    const swarm: SwarmSession = { id: randomUUID(), tenantId, name, members: [], tasks: [], strategy, totalTasks: 0, completedTasks: 0, avgCompletionMs: 0, createdAt: new Date().toISOString() };
    await this.store.mutate(s => { s.swarms.push(swarm); });
    return swarm;
  }

  async addMember(swarmId: string, agentId: string, role: SwarmRole, capabilities: string[], reliability: number): Promise<void> {
    await this.store.mutate(s => {
      const swarm = s.swarms.find(x => x.id === swarmId);
      if (!swarm) return;
      if (!swarm.members.find(m => m.agentId === agentId)) swarm.members.push({ agentId, role, capabilities, load: 0, reliability, joinedAt: new Date().toISOString() });
    });
  }

  async submitTask(swarmId: string, description: string, priority: number, parallelizable: boolean): Promise<SwarmTask | null> {
    return await this.store.mutate(s => {
      const swarm = s.swarms.find(x => x.id === swarmId);
      if (!swarm || swarm.members.length === 0) return null;
      const task: SwarmTask = { id: randomUUID(), tenantId: swarm.tenantId, description, assignedTo: [], status: "pending", priority, parallelizable, subtasks: [], result: "", createdAt: new Date().toISOString(), completedAt: "" };
      // Assign based on strategy
      if (swarm.strategy === "capability-match") {
        const desc = description.toLowerCase();
        const best = swarm.members.filter(m => m.capabilities.some(c => desc.includes(c))).sort((a, b) => b.reliability - a.reliability)[0];
        if (best) { task.assignedTo = [best.agentId]; task.status = "assigned"; best.load++; }
      } else if (swarm.strategy === "load-balance") {
        const lightest = [...swarm.members].sort((a, b) => a.load - b.load).slice(0, parallelizable ? 3 : 1);
        task.assignedTo = lightest.map(m => m.agentId);
        task.status = "assigned";
        lightest.forEach(m => m.load++);
      } else {
        const idx = swarm.totalTasks % swarm.members.length;
        const member = swarm.members[idx]!;
        task.assignedTo = [member.agentId];
        task.status = "assigned";
        member.load++;
      }
      swarm.tasks.push(task);
      swarm.totalTasks++;
      return task;
    });
  }

  async completeTask(swarmId: string, taskId: string, result: string, success: boolean): Promise<void> {
    await this.store.mutate(s => {
      const swarm = s.swarms.find(x => x.id === swarmId);
      if (!swarm) return;
      const task = swarm.tasks.find(t => t.id === taskId);
      if (!task) return;
      task.status = success ? "completed" : "failed";
      task.result = result;
      task.completedAt = new Date().toISOString();
      if (success) swarm.completedTasks++;
      const dur = new Date(task.completedAt).getTime() - new Date(task.createdAt).getTime();
      swarm.avgCompletionMs = swarm.avgCompletionMs > 0 ? (swarm.avgCompletionMs + dur) / 2 : dur;
      for (const agentId of task.assignedTo) { const m = swarm.members.find(x => x.agentId === agentId); if (m) m.load = Math.max(0, m.load - 1); }
    });
  }

  async getSwarms(tenantId: string): Promise<SwarmSession[]> {
    const s = await this.store.read();
    return s.swarms.filter(sw => sw.tenantId === tenantId);
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const ts = s.swarms.filter(sw => sw.tenantId === tenantId);
    const totalMembers = ts.reduce((sum, sw) => sum + sw.members.length, 0);
    const totalTasks = ts.reduce((sum, sw) => sum + sw.totalTasks, 0);
    const completedTasks = ts.reduce((sum, sw) => sum + sw.completedTasks, 0);
    return { totalSwarms: ts.length, totalMembers, totalTasks, completedTasks, avgCompletionMs: ts.length ? ts.reduce((sum, sw) => sum + sw.avgCompletionMs, 0) / ts.length : 0, taskSuccessRate: totalTasks > 0 ? completedTasks / totalTasks : 0 };
  }

  // ═══ P2: Explainability ═══

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
