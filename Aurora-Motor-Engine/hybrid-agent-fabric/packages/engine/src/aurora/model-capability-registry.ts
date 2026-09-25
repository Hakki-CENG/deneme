/**
 * Model Capability Registry
 * P1-56: Her model için capability metadata tutar.
 * Context window, vision, tools, reasoning, latency, cost, availability.
 * AdaptiveRouter ve ModelSelectionEngine bu registry'yi kullanır.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

export type ModelCapability =
  | "text" | "vision" | "audio" | "code" | "reasoning" | "math"
  | "tool_calling" | "structured_output" | "long_context" | "fast"
  | "creative" | "multilingual" | "embedding";

export interface ModelProfile {
  id: string;
  /** Provider-specific model identifier (e.g., "qwen-27b", "claude-3-opus") */
  modelId: string;
  /** Human-readable name */
  displayName: string;
  /** Provider name */
  provider: string;
  /** What this model can do */
  capabilities: ModelCapability[];
  /**
   * Maximum context window in tokens. Absent until something reports it.
   *
   * A profile bootstrapped from a real request knows the route and nothing
   * else; writing 0 here would be a fabricated specification. Nothing in the
   * system reads this field to make a decision, so leaving it out costs
   * nothing and lies about nothing.
   */
  contextWindow?: number;
  /** Maximum output tokens. Absent until reported, for the same reason. */
  maxOutputTokens?: number;
  /**
   * Measured latency, cost, reliability and quality.
   *
   * `undefined` means **not measured yet**, and that is a state this type has to
   * be able to express. These used to be non-optional and seeded with constants
   * -- reliability 0.9, successRate 1.0, avgLatencyMs 2000, costPer1kInput
   * 0.001 -- so a model that had never served a request was published as 90%
   * reliable and 100% successful. Worse, the seeds polluted the learned values:
   * reliability is an EMA, so the first success produced 0.9 * 0.95 + 0.05 =
   * 0.905, and the first real latency was averaged against a fabricated 2000ms.
   * A number that has not been measured must be absent, not invented.
   */
  avgLatencyMs?: number | undefined;
  /** Cost per 1K input tokens (USD) */
  costPer1kInput?: number | undefined;
  /** Cost per 1K output tokens (USD) */
  costPer1kOutput?: number | undefined;
  /** Historical reliability (0-1, learned from usage) */
  reliability?: number | undefined;
  /** Historical success rate (0-1) */
  successRate?: number | undefined;
  /** Total requests made */
  totalRequests: number;
  /** Total successful requests */
  successfulRequests: number;
  /** Average quality score (0-1, from benchmarks). Undefined until benchmarked. */
  qualityScore?: number | undefined;
  /** Whether this model is currently available */
  available: boolean;
  /** Specialization domains (e.g., "coding", "research", "creative") */
  specializations: string[];
  /** Last benchmark timestamp */
  lastBenchmarkAt: string;
  createdAt: string;
  updatedAt: string;
}

interface BenchmarkResult {
  id: string;
  modelId: string;
  benchmark: string;
  score: number;
  latencyMs: number;
  costUsd: number;
  timestamp: string;
}

interface ModelCapabilityState {
  schemaVersion: number;
  profiles: ModelProfile[];
  benchmarks: BenchmarkResult[];
}

/**
 * Mean of the values that exist, or `undefined` when none do.
 *
 * An average over an empty set is not zero -- reporting 0 would claim the
 * measured models are unreliable when the truth is that nothing was measured.
 */
function averageOf(values: ReadonlyArray<number | undefined>): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  if (present.length === 0) return undefined;
  return present.reduce((sum, v) => sum + v, 0) / present.length;
}

export class ModelCapabilityRegistryService {
  private store: DurableJsonState<ModelCapabilityState>;

  constructor(private baseDir: string) {
    this.store = new DurableJsonState<ModelCapabilityState>(
      join(baseDir, "model-capability-registry.json"),
      () => ({ schemaVersion: 1, profiles: [], benchmarks: [] }),
      (v) => { const s = v as ModelCapabilityState; return !!s && s.schemaVersion === 1; },
      "Aurora model capability registry",
    );
  }

  async init(): Promise<void> { await this.store.read(); }

  /**
   * Register a new model with its capabilities.
   */
  async register(input: {
    modelId: string;
    displayName: string;
    provider: string;
    capabilities: ModelCapability[];
    contextWindow: number;
    maxOutputTokens?: number;
    avgLatencyMs?: number;
    costPer1kInput?: number;
    costPer1kOutput?: number;
    specializations?: string[];
  }): Promise<ModelProfile> {
    const now = new Date().toISOString();
    const profile: ModelProfile = {
      id: randomUUID(),
      modelId: input.modelId,
      displayName: input.displayName,
      provider: input.provider,
      capabilities: input.capabilities,
      contextWindow: input.contextWindow,
      maxOutputTokens: input.maxOutputTokens ?? 4096,
      // Only what the caller actually knows. Anything left out stays absent
      // until it is measured -- see the note on ModelProfile.
      ...(input.avgLatencyMs !== undefined ? { avgLatencyMs: input.avgLatencyMs } : {}),
      ...(input.costPer1kInput !== undefined ? { costPer1kInput: input.costPer1kInput } : {}),
      ...(input.costPer1kOutput !== undefined ? { costPer1kOutput: input.costPer1kOutput } : {}),
      totalRequests: 0,
      successfulRequests: 0,
      available: true,
      specializations: input.specializations ?? [],
      lastBenchmarkAt: "",
      createdAt: now,
      updatedAt: now,
    };

    await this.store.mutate(s => {
      const existing = s.profiles.findIndex(p => p.modelId === input.modelId);
      if (existing >= 0) {
        s.profiles[existing] = profile;
      } else {
        s.profiles.push(profile);
      }
    });

    return profile;
  }

  /**
   * Record a request outcome — updates reliability and success rate.
   */
  async recordOutcome(modelId: string, success: boolean, latencyMs: number): Promise<void> {
    await this.store.mutate(s => {
      let p = s.profiles.find(x => x.modelId === modelId);
      if (!p) {
        // Bootstrap from the first real request instead of dropping the sample.
        // This used to `return`, so a model nobody had pre-registered could
        // never accumulate evidence: its first outcome was discarded, which
        // meant there was no profile for the second one to find either, and the
        // learning loop could not start on its own. Only the route is known
        // here, so only the route is recorded.
        const separator = modelId.indexOf(":");
        const now = new Date().toISOString();
        p = {
          id: randomUUID(),
          modelId,
          displayName: modelId,
          provider: separator > 0 ? modelId.slice(0, separator) : "unknown",
          capabilities: [],
          totalRequests: 0,
          successfulRequests: 0,
          available: true,
          specializations: [],
          lastBenchmarkAt: "",
          createdAt: now,
          updatedAt: now,
        };
        s.profiles.push(p);
      }
      p.totalRequests++;
      if (success) p.successfulRequests++;
      p.successRate = p.successfulRequests / p.totalRequests;
      // Reliability is an EMA over observed outcomes. Seeded from the first
      // outcome rather than from a constant, so it describes this model and not
      // the prior it happened to start at.
      p.reliability =
        p.reliability === undefined ? (success ? 1 : 0) : p.reliability * 0.95 + (success ? 0.05 : 0);
      // Averaged over the samples actually seen; a fabricated seed would drag the
      // first real measurement towards it.
      p.avgLatencyMs =
        p.avgLatencyMs === undefined
          ? Math.round(latencyMs)
          : Math.round((p.avgLatencyMs * (p.totalRequests - 1) + latencyMs) / p.totalRequests);
      p.updatedAt = new Date().toISOString();
    });
  }

  /**
   * Record a benchmark result.
   */
  async recordBenchmark(modelId: string, benchmark: string, score: number, latencyMs: number, costUsd: number): Promise<void> {
    const result: BenchmarkResult = {
      id: randomUUID(), modelId, benchmark, score, latencyMs, costUsd, timestamp: new Date().toISOString(),
    };
    await this.store.mutate(s => {
      s.benchmarks.push(result);
      const p = s.profiles.find(x => x.modelId === modelId);
      if (p) {
        p.qualityScore = score;
        p.lastBenchmarkAt = result.timestamp;
        p.updatedAt = new Date().toISOString();
      }
    });
  }

  /**
   * Find the best model for a task based on required capabilities and strategy.
   */
  async selectBest(input: {
    requiredCapabilities: ModelCapability[];
    strategy: "performance" | "cost" | "quality" | "balanced";
    maxLatencyMs?: number;
    maxCostPer1k?: number;
    preferSpecialization?: string;
  }): Promise<ModelProfile | null> {
    const s = await this.store.read();
    let candidates = s.profiles.filter(p =>
      p.available &&
      input.requiredCapabilities.every(cap => p.capabilities.includes(cap))
    );

    // An unmeasured model cannot be shown to satisfy a numeric bound, so it does
    // not pass one. Excluding it is honest; assuming it fits would be a guess
    // dressed as a guarantee.
    if (input.maxLatencyMs) {
      candidates = candidates.filter(
        (p) => p.avgLatencyMs !== undefined && p.avgLatencyMs <= input.maxLatencyMs!,
      );
    }
    if (input.maxCostPer1k) {
      candidates = candidates.filter(
        (p) => p.costPer1kInput !== undefined && p.costPer1kInput <= input.maxCostPer1k!,
      );
    }

    if (candidates.length === 0) return null;

    // Score each candidate.
    //
    // Only measured evidence contributes. A dimension nobody has measured adds
    // nothing rather than a plausible-looking constant, so two unmeasured models
    // tie at zero -- which reads as "no basis to prefer either", the true state.
    const scored = candidates.map(p => {
      const quality = p.qualityScore ?? 0;
      const reliability = p.reliability ?? 0;
      const success = p.successRate ?? 0;
      // Normalised against the 0.01 USD/1K reference the cost strategy already
      // used; unmeasured cost contributes nothing.
      const costScore = p.costPer1kInput === undefined ? 0 : 1 - p.costPer1kInput / 0.01;
      let score = 0;
      switch (input.strategy) {
        case "performance":
          score = quality * 0.4 + reliability * 0.3 + success * 0.3;
          break;
        case "cost":
          score = costScore * 0.6 + reliability * 0.2 + quality * 0.2;
          break;
        case "quality":
          score = quality * 0.6 + success * 0.2 + reliability * 0.2;
          break;
        case "balanced":
          score = quality * 0.25 + reliability * 0.25 + success * 0.25 + costScore * 0.25;
          break;
      }
      // Specialization bonus
      if (input.preferSpecialization && p.specializations.includes(input.preferSpecialization)) {
        score += 0.15;
      }
      return { profile: p, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]!.profile;
  }

  /**
   * Get all registered models.
   */
  async getProfiles(): Promise<ModelProfile[]> {
    const s = await this.store.read();
    return s.profiles;
  }

  /**
   * Get a specific model profile.
   */
  async getProfile(modelId: string): Promise<ModelProfile | null> {
    const s = await this.store.read();
    return s.profiles.find(p => p.modelId === modelId) ?? null;
  }

  /**
   * Get benchmark history for a model.
   */
  async getBenchmarks(modelId: string): Promise<BenchmarkResult[]> {
    const s = await this.store.read();
    return s.benchmarks.filter(b => b.modelId === modelId).sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  /**
   * Set model availability.
   */
  async setAvailability(modelId: string, available: boolean): Promise<void> {
    await this.store.mutate(s => {
      const p = s.profiles.find(x => x.modelId === modelId);
      if (p) { p.available = available; p.updatedAt = new Date().toISOString(); }
    });
  }

  /**
   * Registry statistics.
   */
  // ═══ P2: Multi-Model Orchestration ═══

  async orchestrate(input: {
task: string; requiredCapabilities: string[];
    maxModels?: number; preferCost?: boolean;
    }): Promise<{
    /** `estimatedCost` is absent when the model's pricing was never recorded. */
    selectedModels: Array<{
      modelId: string;
      role: string;
      confidence: number;
      estimatedCost?: number | undefined;
    }>;
    fallbackChain: string[];
    rationale: string[];
  }> {
    const s = await this.store.read();
    const available = s.profiles.filter(p => p.available);
    const maxModels = input.maxModels ?? 3;
    const rationale: string[] = [];

    // Score models by capability match
    const scored = available.map(p => {
      const capMatch = input.requiredCapabilities.filter(c => 
        p.capabilities.some((cap: any) => ((cap as any).domain ?? (cap as any).name ?? "").toLowerCase().includes(c.toLowerCase()))
      ).length;
      const score = capMatch / Math.max(1, input.requiredCapabilities.length);
      return { profile: p, score, capMatch };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

    const selectedModels = scored.slice(0, maxModels).map((x, i) => ({
      modelId: x.profile.modelId,
      role: i === 0 ? "primary" : i === 1 ? "validator" : "fallback",
      confidence: x.score,
      // Absent when either side is unmeasured: an estimate built from a constant
      // would look like a quote.
      ...(x.profile.costPer1kInput !== undefined && x.profile.costPer1kOutput !== undefined
        ? { estimatedCost: (x.profile.costPer1kInput + x.profile.costPer1kOutput) / 2 }
        : {}),
    }));

    const fallbackChain = scored.slice(maxModels, maxModels + 3).map(x => x.profile.modelId);

    if (selectedModels.length === 0) {
      rationale.push("No models match required capabilities — consider registering more models");
    } else {
      rationale.push(`Selected ${selectedModels.length} model(s) for task`);
      rationale.push(`Primary: ${selectedModels[0]?.modelId ?? "none"} (${((selectedModels[0]?.confidence ?? 0) * 100).toFixed(0)}% capability match)`);
    }

    return { selectedModels, fallbackChain, rationale };
  }

  async getStats() {
    const s = await this.store.read();
    return {
      totalModels: s.profiles.length,
      availableModels: s.profiles.filter(p => p.available).length,
      totalBenchmarks: s.benchmarks.length,
      // Averaged over the models that have actually been measured, with the
      // denominator reported. Averaging over every profile and treating the
      // unmeasured ones as zero would pull both numbers down and read as a
      // decline in quality that never happened.
      avgReliability: averageOf(s.profiles.map((p) => p.reliability)),
      avgQuality: averageOf(s.profiles.map((p) => p.qualityScore)),
      measuredModels: s.profiles.filter((p) => p.reliability !== undefined).length,
      byProvider: s.profiles.reduce((acc, p) => { acc[p.provider] = (acc[p.provider] ?? 0) + 1; return acc; }, {} as Record<string, number>),
      byCapability: s.profiles.reduce((acc, p) => {
        for (const cap of p.capabilities) acc[cap] = (acc[cap] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    };
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

