import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type AttentionCategory = "task" | "threat" | "opportunity" | "maintenance" | "social" | "learning";

interface AttentionTarget { id: string; tenantId: string; category: AttentionCategory; title: string; description: string; salience: number; urgency: number; importance: number; decayRate: number; focusTimeMs: number; lastFocusedAt: string; createdAt: string; }
interface AttentionAllocation { totalBudgetMs: number; allocatedMs: number; distribution: Record<AttentionCategory, number>; }

interface AttentionState { schemaVersion: number; targets: AttentionTarget[]; allocationHistory: { timestamp: string; distribution: Record<AttentionCategory, number>; }[]; }

export class AttentionV2Service {
  private store: DurableJsonState<AttentionState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<AttentionState>(
      join(baseDir, "attention-v2.json"),
      () => ({ schemaVersion: 1, targets: [], allocationHistory: [] }),
      (v) => { const s = v as AttentionState; return !!s && s.schemaVersion === 1; },
      "Aurora attention v2",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async registerTarget(tenantId: string, category: AttentionCategory, title: string, description: string, urgency: number, importance: number, decayRate: number = 0.01): Promise<AttentionTarget> {
    const t: AttentionTarget = { id: randomUUID(), tenantId, category, title, description, salience: (urgency + importance) / 2, urgency, importance, decayRate, focusTimeMs: 0, lastFocusedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
    await this.store.mutate(s => { s.targets.push(t); });
    return t;
  }

  async focus(targetId: string, durationMs: number): Promise<void> {
    await this.store.mutate(s => {
      const t = s.targets.find(x => x.id === targetId);
      if (!t) return;
      t.focusTimeMs += durationMs;
      t.lastFocusedAt = new Date().toISOString();
      t.salience = Math.min(1, t.salience + 0.05);
    });
  }

  async decay(): Promise<void> {
    await this.store.mutate(s => {
      for (const t of s.targets) {
        const elapsed = (Date.now() - new Date(t.lastFocusedAt).getTime()) / 60000;
        t.salience = Math.max(0, t.salience - t.decayRate * elapsed);
      }
    });
  }

  async getTopTargets(tenantId: string, limit: number = 10): Promise<AttentionTarget[]> {
    const s = await this.store.read();
    return s.targets.filter(t => t.tenantId === tenantId).sort((a, b) => b.salience - a.salience).slice(0, limit);
  }

  async allocate(tenantId: string, budgetMs: number): Promise<AttentionAllocation> {
    const s = await this.store.read();
    const tg = s.targets.filter(t => t.tenantId === tenantId).sort((a, b) => b.salience - a.salience);
    const totalSalience = tg.reduce((sum, t) => sum + t.salience, 0);
    const dist: Record<AttentionCategory, number> = { task: 0, threat: 0, opportunity: 0, maintenance: 0, social: 0, learning: 0 };
    for (const t of tg) {
      const alloc = totalSalience > 0 ? (t.salience / totalSalience) * budgetMs : 0;
      dist[t.category] += alloc;
    }
    await this.store.mutate(s2 => { s2.allocationHistory.push({ timestamp: new Date().toISOString(), distribution: dist }); });
    return { totalBudgetMs: budgetMs, allocatedMs: Object.values(dist).reduce((sum, v) => sum + v, 0), distribution: dist };
  }

  async removeTarget(targetId: string): Promise<void> {
    await this.store.mutate(s => { s.targets = s.targets.filter(t => t.id !== targetId); });
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const tg = s.targets.filter(t => t.tenantId === tenantId);
    const catDist: Record<string, { count: number; totalFocus: number; avgSalience: number }> = {};
    for (const t of tg) {
      if (!catDist[t.category]) catDist[t.category] = { count: 0, totalFocus: 0, avgSalience: 0 };
      catDist[t.category]!.count++;
      catDist[t.category]!.totalFocus += t.focusTimeMs;
      catDist[t.category]!.avgSalience += t.salience;
    }
    for (const v of Object.values(catDist)) if (v.count > 0) v.avgSalience = v.avgSalience / v.count;
    return { totalTargets: tg.length, avgSalience: tg.length ? tg.reduce((sum, t) => sum + t.salience, 0) / tg.length : 0, categoryDistribution: catDist, totalFocusTime: tg.reduce((sum, t) => sum + t.focusTimeMs, 0) };
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
