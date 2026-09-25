import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type ActivationFunction = "sigmoid" | "relu" | "tanh" | "softmax";

interface Neuron { id: string; layer: number; bias: number; activation: ActivationFunction; output: number; }
interface Connection { fromId: string; toId: string; weight: number; }
interface CognitivePattern {
  id: string;
  name: string;
  description: string;
  triggerConditions: string[];
  activations: number[];
  responseTemplate: string;
  successRate: number;
  usageCount: number;
  /**
   * Outcomes recorded, and how many of them succeeded.
   *
   * These are deliberately separate from `usageCount`, which counts activations.
   * A pattern can be activated many times and only occasionally have its result
   * reported, so the activation count is the wrong denominator for a success
   * rate. Optional because state written before this field existed will not have
   * it; absent is read as zero.
   */
  outcomeCount?: number;
  successCount?: number;
}
interface NeuralSnapshot { id: string; tenantId: string; description: string; layerCount: number; neuronCount: number; patternCount: number; avgActivation: number; entropy: number; createdAt: string; }

interface NeuralCoreState { schemaVersion: number; patterns: CognitivePattern[]; snapshots: NeuralSnapshot[]; globalStats: { totalActivations: number; avgResponseTime: number; patternHitRate: number; } }

/**
 * Normalised Shannon entropy of a set of non-negative weights.
 *
 * Returns a value in [0, 1]: 0 when all the weight sits in one place, 1 when it
 * is spread evenly. Dividing by log(n) is what makes the bound independent of how
 * many patterns exist, so the number means the same thing for 3 patterns as for
 * 300.
 *
 * This replaced `Math.random() * 0.5 + 0.2` in `snapshot()`. That was not a
 * measurement: three calls on identical state returned 0.372, 0.519 and 0.434.
 * A field presented as a property of the system has to be a function of the
 * system.
 */
export function normalisedEntropy(weights: readonly number[]): number {
  const usable = weights.filter((w) => Number.isFinite(w) && w > 0);
  if (usable.length < 2) return 0;
  const total = usable.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return 0;
  const entropy = usable.reduce((sum, w) => {
    const p = w / total;
    return sum - p * Math.log(p);
  }, 0);
  return entropy / Math.log(usable.length);
}

export class NeuralCognitiveCoreService {
  private store: DurableJsonState<NeuralCoreState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<NeuralCoreState>(
      join(baseDir, "neural-cognitive-core.json"),
      () => ({ schemaVersion: 1, patterns: [], snapshots: [], globalStats: { totalActivations: 0, avgResponseTime: 0, patternHitRate: 0 } }),
      (v) => { const s = v as NeuralCoreState; return !!s && s.schemaVersion === 1; },
      "Aurora neural cognitive core",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async registerPattern(name: string, description: string, triggerConditions: string[], responseTemplate: string): Promise<CognitivePattern> {
    const p: CognitivePattern = { id: randomUUID(), name, description, triggerConditions, activations: [], responseTemplate, successRate: 0.5, usageCount: 0 };
    await this.store.mutate(s => { s.patterns.push(p); });
    return p;
  }

  async activate(input: string, context: string): Promise<{ matchedPattern: CognitivePattern | null; response: string; confidence: number }> {
    return await this.store.mutate(s => {
      s.globalStats.totalActivations++;
      const text = (input + " " + context).toLowerCase();
      let bestMatch: CognitivePattern | null = null;
      let bestScore = 0;
      for (const p of s.patterns) {
        const matchCount = p.triggerConditions.filter(c => text.includes(c.toLowerCase())).length;
        const score = matchCount / (p.triggerConditions.length || 1);
        if (score > bestScore && score > 0.3) { bestScore = score; bestMatch = p; }
      }
      if (bestMatch) {
        bestMatch.usageCount++;
        bestMatch.activations.push(bestScore);
        if (bestMatch.activations.length > 100) bestMatch.activations = bestMatch.activations.slice(-100);
        return { matchedPattern: bestMatch, response: bestMatch.responseTemplate, confidence: bestScore };
      }
      return { matchedPattern: null, response: "No pattern matched — default reasoning engaged", confidence: 0 };
    });
  }

  async recordOutcome(patternId: string, success: boolean): Promise<void> {
    await this.store.mutate(s => {
      const p = s.patterns.find(x => x.id === patternId);
      if (!p) return;
      // Count outcomes, then derive the rate from the counts.
      //
      // This used to be a running average over `usageCount`, which is the
      // activation count, not the outcome count. Measured consequences:
      //   - one failure on a never-activated pattern gave (0.5 * -1 + 0) / 1,
      //     i.e. successRate -0.5, a rate outside [0, 1];
      //   - a second failure moved it back up to 0.5, so the value oscillated
      //     instead of tracking anything.
      // A rate computed as successes / outcomes cannot leave [0, 1] and does not
      // depend on how often the pattern happened to be activated.
      p.outcomeCount = (p.outcomeCount ?? 0) + 1;
      if (success) p.successCount = (p.successCount ?? 0) + 1;
      p.successRate = (p.successCount ?? 0) / p.outcomeCount;
    });
  }

  async snapshot(tenantId: string, description: string): Promise<NeuralSnapshot> {
    return await this.store.mutate(s => {
      // Mean activation per pattern, reused for both aggregates so the two
      // numbers describe the same distribution.
      const meanActivations = s.patterns.map((p) =>
        p.activations.length
          ? p.activations.reduce((a, b) => a + b, 0) / p.activations.length
          : 0,
      );
      const snap: NeuralSnapshot = {
        id: randomUUID(),
        tenantId,
        description,
        layerCount: 3,
        neuronCount: s.patterns.length * 10,
        patternCount: s.patterns.length,
        avgActivation: meanActivations.length
          ? meanActivations.reduce((a, b) => a + b, 0) / meanActivations.length
          : 0,
        entropy: normalisedEntropy(meanActivations),
        createdAt: new Date().toISOString(),
      };
      s.snapshots.push(snap);
      return snap;
    });
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const avgSuccess = s.patterns.length ? s.patterns.reduce((sum, p) => sum + p.successRate, 0) / s.patterns.length : 0;
    return { totalPatterns: s.patterns.length, totalActivations: s.globalStats.totalActivations, avgPatternSuccess: avgSuccess, topPatterns: s.patterns.sort((a, b) => b.usageCount - a.usageCount).slice(0, 5).map(p => ({ name: p.name, usage: p.usageCount, success: p.successRate })), snapshots: s.snapshots.filter(ss => ss.tenantId === tenantId).length };
  }

  // ═══ P3: Explainability ═══

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

