import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { auroraRound, DurableJsonState } from "../util/aurora-state.js";

interface Scenario { id: string; name: string; description: string; assumptions: string[]; parameters: Record<string, number | string>; estimatedEffort: number; estimatedRisk: number; estimatedCost: number; estimatedQuality: number; pros: string[]; cons: string[]; confidence: number; }
interface Simulation { id: string; tenantId: string; question: string; context: string; scenarios: Scenario[]; recommendedScenarioId: string; reasoning: string; outcome: string; actualOutcome: string; actualVsPredicted: { effort: number; risk: number; cost: number; quality: number } | null; createdAt: string; decidedAt: string; }

interface SimStateShape { schemaVersion: number; simulations: Simulation[]; }

export class CounterfactualSimulatorService {
  private store: DurableJsonState<SimStateShape>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<SimStateShape>(join(baseDir, "counterfactual-simulator.json"), () => ({ schemaVersion: 1, simulations: [] }), (v) => { const s = v as SimStateShape; return !!s && s.schemaVersion === 1; }, "Aurora counterfactual simulator");
  }
  async init(): Promise<void> { await this.store.read(); }

  async createSimulation(tenantId: string, question: string, context: string): Promise<Simulation> {
    const sim: Simulation = { id: randomUUID(), tenantId, question, context, scenarios: [], recommendedScenarioId: "", reasoning: "", outcome: "", actualOutcome: "", actualVsPredicted: null, createdAt: new Date().toISOString(), decidedAt: "" };
    await this.store.mutate(s => { s.simulations.push(sim); });
    return sim;
  }

  async addScenario(simId: string, scenario: Omit<Scenario, "id">): Promise<Scenario> {
    const sc: Scenario = { ...scenario, id: randomUUID() };
    await this.store.mutate(s => { const sim = s.simulations.find(x => x.id === simId); if (sim) sim.scenarios.push(sc); });
    return sc;
  }

  async recommend(simId: string, weights?: { effort: number; risk: number; cost: number; quality: number }): Promise<{ scenarioId: string; reasoning: string }> {
    return await this.store.mutate(s => {
      const sim = s.simulations.find(x => x.id === simId);
      if (!sim || !sim.scenarios.length) return { scenarioId: "", reasoning: "No scenarios" };
      const w = weights ?? { effort: 0.25, risk: 0.3, cost: 0.2, quality: 0.25 };
      let bestId = sim.scenarios[0]!.id; let bestScore = -Infinity;
      for (const sc of sim.scenarios) {
        const score = (1 - sc.estimatedRisk) * w.risk + (1 - sc.estimatedCost / 100) * w.cost + sc.estimatedQuality * w.quality + (1 - sc.estimatedEffort / 100) * w.effort;
        if (score > bestScore) { bestScore = score; bestId = sc.id; }
      }
      sim.recommendedScenarioId = bestId;
      sim.reasoning = `Best scenario score ${auroraRound(bestScore)}. Weights: effort=${w.effort}, risk=${w.risk}, cost=${w.cost}, quality=${w.quality}`;
      return { scenarioId: bestId, reasoning: sim.reasoning };
    });
  }

  async recordOutcome(simId: string, chosenScenarioId: string, actualOutcome: string, actualMetrics?: { effort: number; risk: number; cost: number; quality: number }): Promise<void> {
    await this.store.mutate(s => {
      const sim = s.simulations.find(x => x.id === simId);
      if (!sim) return;
      sim.outcome = "executed"; sim.actualOutcome = actualOutcome; sim.decidedAt = new Date().toISOString();
      if (actualMetrics) {
        const chosen = sim.scenarios.find(sc => sc.id === chosenScenarioId);
        if (chosen) sim.actualVsPredicted = { effort: auroraRound(actualMetrics.effort - chosen.estimatedEffort), risk: auroraRound(actualMetrics.risk - chosen.estimatedRisk), cost: auroraRound(actualMetrics.cost - chosen.estimatedCost), quality: auroraRound(actualMetrics.quality - chosen.estimatedQuality) };
      }
    });
  }

  async getSimulations(tenantId: string, limit: number = 20): Promise<Simulation[]> {
    const s = await this.store.read();
    return s.simulations.filter(sim => sim.tenantId === tenantId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  }

  async getCalibrationAccuracy(tenantId: string) {
    const s = await this.store.read();
    const completed = s.simulations.filter(sim => sim.tenantId === tenantId && sim.actualVsPredicted);
    if (!completed.length) return { avgEffortError: 0, avgRiskError: 0, avgCostError: 0, avgQualityError: 0, sampleSize: 0 };
    const sum = completed.reduce((acc, sim) => ({ effort: acc.effort + Math.abs(sim.actualVsPredicted!.effort), risk: acc.risk + Math.abs(sim.actualVsPredicted!.risk), cost: acc.cost + Math.abs(sim.actualVsPredicted!.cost), quality: acc.quality + Math.abs(sim.actualVsPredicted!.quality) }), { effort: 0, risk: 0, cost: 0, quality: 0 });
    return { avgEffortError: auroraRound(sum.effort / completed.length), avgRiskError: auroraRound(sum.risk / completed.length), avgCostError: auroraRound(sum.cost / completed.length), avgQualityError: auroraRound(sum.quality / completed.length), sampleSize: completed.length };
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const items = (s as any).simulations?.filter((x: any) => x.tenantId === tenantId) ?? [];
    return { total: items.length }

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
