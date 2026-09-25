import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type ResourceType = "cpu" | "memory" | "storage" | "network" | "model_tokens" | "attention_budget";
type AllocationPriority = "critical" | "high" | "normal" | "low" | "background";

interface ResourceAllocation { id: string; tenantId: string; subsystem: string; resourceType: ResourceType; allocated: number; used: number; priority: AllocationPriority; maxBurst: number; expiresAt: string; createdAt: string; }
interface ResourcePool { type: ResourceType; totalCapacity: number; allocated: number; reserved: number; utilizationHistory: { timestamp: string; utilization: number; }[]; }
interface OptimizationSuggestion { id: string; resourceType: ResourceType; subsystem: string; suggestion: string; estimatedSaving: number; confidence: number; timestamp: string; }

interface ResourceState { schemaVersion: number; pools: ResourcePool[]; allocations: ResourceAllocation[]; suggestions: OptimizationSuggestion[]; }

export class ResourceIntelligenceService {
  private store: DurableJsonState<ResourceState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<ResourceState>(
      join(baseDir, "resource-intelligence.json"),
      () => ({
        schemaVersion: 1,
        pools: [
          { type: "cpu", totalCapacity: 100, allocated: 0, reserved: 10, utilizationHistory: [] },
          { type: "memory", totalCapacity: 100, allocated: 0, reserved: 15, utilizationHistory: [] },
          { type: "storage", totalCapacity: 100, allocated: 0, reserved: 5, utilizationHistory: [] },
          { type: "network", totalCapacity: 100, allocated: 0, reserved: 5, utilizationHistory: [] },
          { type: "model_tokens", totalCapacity: 100000, allocated: 0, reserved: 10000, utilizationHistory: [] },
          { type: "attention_budget", totalCapacity: 100, allocated: 0, reserved: 10, utilizationHistory: [] },
        ],
        allocations: [],
        suggestions: [],
      }),
      (v) => { const s = v as ResourceState; return !!s && s.schemaVersion === 1; },
      "Aurora resource intelligence",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async allocate(tenantId: string, subsystem: string, resourceType: ResourceType, amount: number, priority: AllocationPriority): Promise<ResourceAllocation | null> {
    return await this.store.mutate(s => {
      const pool = s.pools.find(p => p.type === resourceType);
      if (!pool) return null;
      const available = pool.totalCapacity - pool.allocated - pool.reserved;
      if (amount > available && priority !== "critical") return null;
      const actual = Math.min(amount, available + (priority === "critical" ? pool.reserved : 0));
      const alloc: ResourceAllocation = { id: randomUUID(), tenantId, subsystem, resourceType, allocated: actual, used: 0, priority, maxBurst: actual * 1.5, expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: new Date().toISOString() };
      pool.allocated += actual;
      s.allocations.push(alloc);
      return alloc;
    });
  }

  async release(allocationId: string): Promise<void> {
    await this.store.mutate(s => {
      const alloc = s.allocations.find(a => a.id === allocationId);
      if (!alloc) return;
      const pool = s.pools.find(p => p.type === alloc.resourceType);
      if (pool) pool.allocated = Math.max(0, pool.allocated - alloc.allocated);
      s.allocations = s.allocations.filter(a => a.id !== allocationId);
    });
  }

  async recordUsage(allocationId: string, amount: number): Promise<void> {
    await this.store.mutate(s => {
      const alloc = s.allocations.find(a => a.id === allocationId);
      if (alloc) alloc.used = Math.min(alloc.allocated * alloc.maxBurst, alloc.used + amount);
    });
  }

  async analyze(tenantId: string): Promise<OptimizationSuggestion[]> {
    return await this.store.mutate(s => {
      const suggestions: OptimizationSuggestion[] = [];
      const tenantAllocs = s.allocations.filter(a => a.tenantId === tenantId);
      for (const pool of s.pools) {
        const utilization = pool.totalCapacity > 0 ? pool.allocated / pool.totalCapacity : 0;
        pool.utilizationHistory.push({ timestamp: new Date().toISOString(), utilization });
        if (pool.utilizationHistory.length > 100) pool.utilizationHistory = pool.utilizationHistory.slice(-100);
      }
      for (const alloc of tenantAllocs) {
        if (alloc.used < alloc.allocated * 0.3) {
          const sg: OptimizationSuggestion = { id: randomUUID(), resourceType: alloc.resourceType, subsystem: alloc.subsystem, suggestion: `Low utilization (${(alloc.used / alloc.allocated * 100).toFixed(0)}%) — consider reducing allocation`, estimatedSaving: alloc.allocated * 0.5, confidence: 0.7, timestamp: new Date().toISOString() };
          suggestions.push(sg);
        }
      }
      s.suggestions.push(...suggestions);
      return suggestions;
    });
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const ta = s.allocations.filter(a => a.tenantId === tenantId);
    return { pools: s.pools.map(p => ({ type: p.type, total: p.totalCapacity, allocated: p.allocated, reserved: p.reserved, utilization: p.totalCapacity > 0 ? p.allocated / p.totalCapacity : 0 })), allocationsCount: ta.length, suggestions: s.suggestions.filter(sg => ta.some(a => a.subsystem === sg.subsystem)).length };
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
