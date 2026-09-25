import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type CompositionPattern = "sequential" | "parallel" | "conditional" | "loop" | "fan-out" | "fan-in";

interface Component { id: string; name: string; type: string; capabilities: string[]; latencyMs: number; reliability: number; cost: number; }
interface CompositionRule { id: string; pattern: CompositionPattern; description: string; componentTypes: string[]; outputType: string; successRate: number; avgLatencyMs: number; usageCount: number; }
interface DynamicComposition { id: string; tenantId: string; goal: string; components: string[]; pattern: CompositionPattern; status: "proposed" | "active" | "completed" | "failed"; performance: { latencyMs: number; success: boolean; cost: number; }[]; createdAt: string; }

interface CompositionState { schemaVersion: number; components: Component[]; rules: CompositionRule[]; compositions: DynamicComposition[]; }

export class DynamicCompositionService {
  private store: DurableJsonState<CompositionState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<CompositionState>(
      join(baseDir, "dynamic-composition.json"),
      () => ({ schemaVersion: 1, components: [], rules: [], compositions: [] }),
      (v) => { const s = v as CompositionState; return !!s && s.schemaVersion === 1; },
      "Aurora dynamic composition",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async registerComponent(name: string, type: string, capabilities: string[], latencyMs: number, reliability: number, cost: number): Promise<Component> {
    const c: Component = { id: randomUUID(), name, type, capabilities, latencyMs, reliability, cost };
    await this.store.mutate(s => { s.components.push(c); });
    return c;
  }

  async compose(tenantId: string, goal: string, requiredCapabilities: string[]): Promise<DynamicComposition | null> {
    return await this.store.mutate(s => {
      const matching = s.components.filter(c => requiredCapabilities.some(cap => c.capabilities.includes(cap)));
      if (matching.length < requiredCapabilities.length) return null;
      const canParallel = matching.every(m => m.reliability > 0.7);
      const pattern: CompositionPattern = canParallel ? "parallel" : "sequential";
      const comp: DynamicComposition = { id: randomUUID(), tenantId, goal, components: matching.map(m => m.id), pattern, status: "proposed", performance: [], createdAt: new Date().toISOString() };
      s.compositions.push(comp);
      return comp;
    });
  }

  async activateComposition(compositionId: string): Promise<void> {
    await this.store.mutate(s => { const c = s.compositions.find(x => x.id === compositionId); if (c) c.status = "active"; });
  }

  async recordPerformance(compositionId: string, latencyMs: number, success: boolean, cost: number): Promise<void> {
    await this.store.mutate(s => {
      const c = s.compositions.find(x => x.id === compositionId);
      if (!c) return;
      c.performance.push({ latencyMs, success, cost });
      if (c.performance.length >= 3) {
        const allSuccess = c.performance.every(p => p.success);
        c.status = allSuccess ? "completed" : "failed";
      }
    });
  }

  async getCompositions(tenantId: string, limit = 30): Promise<DynamicComposition[]> {
    const s = await this.store.read();
    return s.compositions.filter(c => c.tenantId === tenantId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const tc = s.compositions.filter(c => c.tenantId === tenantId);
    const completed = tc.filter(c => c.status === "completed").length;
    const avgLatency = tc.flatMap(c => c.performance).length ? tc.flatMap(c => c.performance).reduce((sum, p) => sum + p.latencyMs, 0) / tc.flatMap(c => c.performance).length : 0;
    return { totalCompositions: tc.length, completed, totalComponents: s.components.length, totalRules: s.rules.length, avgLatency };
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
