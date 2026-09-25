import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

interface BenchmarkRun { id: string; tenantId: string; name: string; subsystem: string; metrics: { name: string; value: number; unit: string; baseline: number; }[]; duration: number; iterations: number; environment: string; createdAt: string; }
interface BenchmarkSuite { id: string; name: string; subsystem: string; testCases: { name: string; input: string; expectedOutput: string; }[]; runCount: number; lastRunAt: string; }

interface BenchmarkState { schemaVersion: number; runs: BenchmarkRun[]; suites: BenchmarkSuite[]; }

export class BenchmarkLabService {
  private store: DurableJsonState<BenchmarkState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<BenchmarkState>(
      join(baseDir, "benchmark-lab.json"),
      () => ({ schemaVersion: 1, runs: [], suites: [] }),
      (v) => { const s = v as BenchmarkState; return !!s && s.schemaVersion === 1; },
      "Aurora benchmark lab",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async recordRun(tenantId: string, name: string, subsystem: string, metrics: BenchmarkRun["metrics"], duration: number, iterations: number, environment: string): Promise<BenchmarkRun> {
    const run: BenchmarkRun = { id: randomUUID(), tenantId, name, subsystem, metrics, duration, iterations, environment, createdAt: new Date().toISOString() };
    await this.store.mutate(s => { s.runs.push(run); });
    return run;
  }

  async createSuite(name: string, subsystem: string, testCases: BenchmarkSuite["testCases"]): Promise<BenchmarkSuite> {
    const suite: BenchmarkSuite = { id: randomUUID(), name, subsystem, testCases, runCount: 0, lastRunAt: "" };
    await this.store.mutate(s => { s.suites.push(suite); });
    return suite;
  }

  async recordSuiteRun(suiteId: string, tenantId: string, results: { passed: number; failed: number; duration: number }): Promise<void> {
    await this.store.mutate(s => {
      const suite = s.suites.find(x => x.id === suiteId);
      if (!suite) return;
      suite.runCount++;
      suite.lastRunAt = new Date().toISOString();
      this.store; // keep reference
    });
    await this.recordRun(tenantId, `Suite: ${suiteId}`, "", [{ name: "passed", value: results.passed, unit: "count", baseline: 0 }, { name: "failed", value: results.failed, unit: "count", baseline: 0 }], results.duration, 1, "suite-run");
  }

  async getRuns(tenantId: string, subsystem?: string, limit = 30): Promise<BenchmarkRun[]> {
    const s = await this.store.read();
    return s.runs.filter(r => r.tenantId === tenantId && (!subsystem || r.subsystem === subsystem)).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  }

  async compareRuns(runIdA: string, runIdB: string) {
    const s = await this.store.read();
    const a = s.runs.find(r => r.id === runIdA);
    const b = s.runs.find(r => r.id === runIdB);
    if (!a || !b) return null;
    const comparisons = a.metrics.map(ma => {
      const mb = b.metrics.find(x => x.name === ma.name);
      return { metric: ma.name, valueA: ma.value, valueB: mb?.value ?? 0, change: mb ? ((mb.value - ma.value) / (ma.value || 1)) * 100 : 0 };
    });
    return { runA: a.name, runB: b.name, comparisons, overallDurationChange: ((b.duration - a.duration) / (a.duration || 1)) * 100 };
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const tr = s.runs.filter(r => r.tenantId === tenantId);
    const subsystemDist: Record<string, number> = {};
    for (const r of tr) subsystemDist[r.subsystem] = (subsystemDist[r.subsystem] ?? 0) + 1;
    return { totalRuns: tr.length, totalSuites: s.suites.length, avgDuration: tr.length ? tr.reduce((sum, r) => sum + r.duration, 0) / tr.length : 0, subsystemDistribution: subsystemDist };
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
