import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type ExperimentStatus = "designed" | "running" | "completed" | "failed" | "aborted";

interface Experiment { id: string; tenantId: string; name: string; hypothesis: string; methodology: string; variables: { name: string; type: "independent" | "dependent" | "controlled"; value: string; }[]; status: ExperimentStatus; results: { metric: string; value: number; baseline: number; improvement: number; }[]; conclusion: string; confidence: number; duration: number; startedAt: string; completedAt: string; createdAt: string; }
interface ExperimentTemplate { id: string; name: string; description: string; domain: string; methodology: string; defaultVariables: string[]; successCriteria: string; usageCount: number; }

interface ExperimentState { schemaVersion: number; experiments: Experiment[]; templates: ExperimentTemplate[]; }

export class ExperimentEngineService {
  private store: DurableJsonState<ExperimentState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<ExperimentState>(
      join(baseDir, "experiment-engine.json"),
      () => ({ schemaVersion: 1, experiments: [], templates: [] }),
      (v) => { const s = v as ExperimentState; return !!s && s.schemaVersion === 1; },
      "Aurora experiment engine",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async createExperiment(tenantId: string, name: string, hypothesis: string, methodology: string, variables: Experiment["variables"]): Promise<Experiment> {
    const exp: Experiment = { id: randomUUID(), tenantId, name, hypothesis, methodology, variables, status: "designed", results: [], conclusion: "", confidence: 0, duration: 0, startedAt: "", completedAt: "", createdAt: new Date().toISOString() };
    await this.store.mutate(s => { s.experiments.push(exp); });
    return exp;
  }

  async startExperiment(experimentId: string): Promise<void> {
    await this.store.mutate(s => { const e = s.experiments.find(x => x.id === experimentId); if (e && e.status === "designed") { e.status = "running"; e.startedAt = new Date().toISOString(); } });
  }

  async recordResult(experimentId: string, metric: string, value: number, baseline: number): Promise<void> {
    await this.store.mutate(s => {
      const e = s.experiments.find(x => x.id === experimentId);
      if (!e) return;
      e.results.push({ metric, value, baseline, improvement: baseline > 0 ? ((value - baseline) / baseline) * 100 : 0 });
    });
  }

  async completeExperiment(experimentId: string, conclusion: string, confidence: number): Promise<void> {
    await this.store.mutate(s => {
      const e = s.experiments.find(x => x.id === experimentId);
      if (!e) return;
      e.status = "completed"; e.conclusion = conclusion; e.confidence = confidence;
      e.completedAt = new Date().toISOString();
      e.duration = new Date(e.completedAt).getTime() - new Date(e.startedAt).getTime();
    });
  }

  async addTemplate(name: string, description: string, domain: string, methodology: string, defaultVariables: string[], successCriteria: string): Promise<ExperimentTemplate> {
    const t: ExperimentTemplate = { id: randomUUID(), name, description, domain, methodology, defaultVariables, successCriteria, usageCount: 0 };
    await this.store.mutate(s => { s.templates.push(t); });
    return t;
  }

  async getExperiments(tenantId: string, limit = 30): Promise<Experiment[]> {
    const s = await this.store.read();
    return s.experiments.filter(e => e.tenantId === tenantId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const te = s.experiments.filter(e => e.tenantId === tenantId);
    const completed = te.filter(e => e.status === "completed").length;
    const avgConfidence = te.filter(e => e.status === "completed").reduce((sum, e) => sum + e.confidence, 0) / (completed || 1);
    const avgImprovement = te.flatMap(e => e.results).reduce((sum, r) => sum + r.improvement, 0) / (te.flatMap(e => e.results).length || 1);
    return { totalExperiments: te.length, completed, running: te.filter(e => e.status === "running").length, avgConfidence, avgImprovement, templates: s.templates.length }

};

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
