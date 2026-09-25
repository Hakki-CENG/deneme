/**
 * Model Routing — Aurora Cognitive Runtime
 *
 * Task-type-driven model scoring, benchmark history and routing history.
 *
 * Not the provider registry -- that is `ModelProviderRegistry` in
 * `models/model-router.ts`. The two were both called "router" for long enough to
 * cause real confusion: one is a registry of what exists, the other scores and
 * picks. A call to `this.models.selectModel(...)` reads plausibly and fails to
 * compile, because `this.models` is the registry.
 *
 * This class is deliberately **not** the model selector on the execution path.
 * That is `ModelSelectionEngine`, which draws candidates from the registry and
 * the tenant's model configurations. Scoring here uses accuracy, latency and cost
 * fields that no real model in this system carries, so using it to choose would
 * mean inventing those numbers. What it is genuinely good at -- running
 * benchmarks, keeping their history, mapping a task type to requirements -- is
 * what it is kept for.
 */

import { randomUUID } from "node:crypto";

/**
 * Model profile.
 */
export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  capabilities: string[];
  costPerToken: number;
  latencyMs: number;
  accuracy: number; // 0-1
  maxTokens: number;
  supportedLanguages: string[];
}

/**
 * Routing decision.
 */
export interface RoutingDecision {
  id: string;
  taskId: string;
  selectedModel: string;
  reason: string;
  confidence: number; // 0-1
  alternatives: string[];
  timestamp: string;
}

/**
 * Benchmark result.
 */
export interface BenchmarkResult {
  id: string;
  modelName: string;
  taskCategory: string;
  score: number; // 0-1
  latencyMs: number;
  costTokens: number;
  success: boolean;
  timestamp: string;
}

/**
 * Comparison result.
 */
export interface ComparisonResult {
  id: string;
  baseline: string;
  challenger: string;
  metric: string;
  baselineScore: number;
  challengerScore: number;
  improvement: number; // percentage
  significant: boolean;
  timestamp: string;
}

/**
 * Adaptive Model Router
 * 
 * Adaptive model selection.
 */
export class AdaptiveModelRouter {
  private readonly models = new Map<string, ModelProfile>();
  private readonly routingHistory = new Map<string, RoutingDecision>();

  /**
   * Model ekle.
   */
  addModel(model: Omit<ModelProfile, "id">): ModelProfile {
    const id = randomUUID();
    const profile: ModelProfile = {
      ...model,
      id,
    };
    this.models.set(id, profile);
    return profile;
  }

  /**
   * Task için en iyi modeli seç.
   */
  selectModel(params: {
    taskType: string;
    requirements: {
      maxLatency?: number;
      maxCost?: number;
      minAccuracy?: number;
      language?: string;
    };
    context?: Record<string, unknown>;
  }): RoutingDecision {
    const candidates = [...this.models.values()].filter(model => {
      // Latency kontrolü
      if (params.requirements.maxLatency && model.latencyMs > params.requirements.maxLatency) {
        return false;
      }

      // Cost kontrolü
      if (params.requirements.maxCost && model.costPerToken > params.requirements.maxCost) {
        return false;
      }

      // Accuracy kontrolü
      if (params.requirements.minAccuracy && model.accuracy < params.requirements.minAccuracy) {
        return false;
      }

      // Language kontrolü
      if (params.requirements.language && !model.supportedLanguages.includes(params.requirements.language)) {
        return false;
      }

      return true;
    });

    // En iyi modeli seç (accuracy * 0.6 + (1 - latency/maxLatency) * 0.2 + (1 - cost/maxCost) * 0.2)
    let bestModel: ModelProfile | null = null;
    let bestScore = -1;

    for (const model of candidates) {
      const latencyScore = params.requirements.maxLatency
        ? 1 - (model.latencyMs / params.requirements.maxLatency)
        : 0.5;
      const costScore = params.requirements.maxCost
        ? 1 - (model.costPerToken / params.requirements.maxCost)
        : 0.5;

      const score = model.accuracy * 0.6 + latencyScore * 0.2 + costScore * 0.2;

      if (score > bestScore) {
        bestScore = score;
        bestModel = model;
      }
    }

    const decision: RoutingDecision = {
      id: randomUUID(),
      taskId: randomUUID(),
      selectedModel: bestModel?.id ?? "none",
      reason: bestModel
        ? `Selected ${bestModel.name} with score ${bestScore.toFixed(2)}`
        : "No suitable model found",
      confidence: bestScore,
      alternatives: candidates
        .filter(m => m.id !== bestModel?.id)
        .map(m => m.id)
        .slice(0, 3),
      timestamp: new Date().toISOString(),
    };

    this.routingHistory.set(decision.id, decision);
    return decision;
  }

  /**
   * Routing history'yi al.
   */
  getRoutingHistory(): RoutingDecision[] {
    return [...this.routingHistory.values()];
  }

  /**
   * Model'leri al.
   */
  getModels(): ModelProfile[] {
    return [...this.models.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalModels: number;
    totalDecisions: number;
    avgConfidence: number;
  } {
    const decisions = [...this.routingHistory.values()];
    return {
      totalModels: this.models.size,
      totalDecisions: decisions.length,
      avgConfidence: decisions.length > 0
        ? decisions.reduce((sum, d) => sum + d.confidence, 0) / decisions.length
        : 0,
    };
  }
}

/**
 * Benchmark Runner
 * 
 * Qwen vs Qwen+Aurora comparison.
 */
export class BenchmarkRunner {
  private readonly results = new Map<string, BenchmarkResult>();

  /**
   * Benchmark çalıştır.
   */
  async runBenchmark(params: {
    modelName: string;
    taskCategory: string;
    testCases: Array<{
      input: string;
      expectedOutput: string;
    }>;
    /**
     * Produces the model output for a test case.
     *
     * This is REQUIRED. The benchmark previously fabricated output with
     * `const output = \`Response for: ${testCase.input}\``, scored that string,
     * and stored the result as a real measurement — so a "Qwen vs Qwen+Aurora"
     * comparison was really comparing two identical synthetic strings. A
     * benchmark that never calls a model cannot produce a benchmark.
     */
    generate: (input: string) => Promise<string>;
    evaluate: (input: string, output: string, expected: string) => Promise<number>;
  }): Promise<BenchmarkResult[]> {
    if (typeof params.generate !== "function") {
      throw new Error(
        "runBenchmark requires a `generate` function that calls the model under test. " +
          "Without it the benchmark would score fabricated output.",
      );
    }

    const results: BenchmarkResult[] = [];

    for (const testCase of params.testCases) {
      const startTime = Date.now();

      const output = await params.generate(testCase.input);
      const score = await params.evaluate(testCase.input, output, testCase.expectedOutput);
      const latencyMs = Date.now() - startTime;

      const result: BenchmarkResult = {
        id: randomUUID(),
        modelName: params.modelName,
        taskCategory: params.taskCategory,
        score,
        latencyMs,
        costTokens: testCase.input.length + output.length,
        success: score > 0.5,
        timestamp: new Date().toISOString(),
      };

      results.push(result);
      this.results.set(result.id, result);
    }

    return results;
  }

  /**
   * Sonuçları al.
   */
  getResults(): BenchmarkResult[] {
    return [...this.results.values()];
  }

  /**
   * Model bazlı sonuçları al.
   */
  getResultsByModel(modelName: string): BenchmarkResult[] {
    return [...this.results.values()].filter(r => r.modelName === modelName);
  }

  /**
   * Kategori bazlı sonuçları al.
   */
  getResultsByCategory(category: string): BenchmarkResult[] {
    return [...this.results.values()].filter(r => r.taskCategory === category);
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalResults: number;
    avgScore: number;
    avgLatency: number;
    successRate: number;
  } {
    const results = [...this.results.values()];
    return {
      totalResults: results.length,
      avgScore: results.length > 0
        ? results.reduce((sum, r) => sum + r.score, 0) / results.length
        : 0,
      avgLatency: results.length > 0
        ? results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length
        : 0,
      successRate: results.length > 0
        ? results.filter(r => r.success).length / results.length
        : 0,
    };
  }
}

/**
 * Model Comparator
 * 
 * Qwen vs Qwen+Aurora comparison.
 */
export class ModelComparator {
  private readonly comparisons = new Map<string, ComparisonResult>();

  /**
   * Model'leri karşılaştır.
   */
  compareModels(params: {
    baseline: string;
    challenger: string;
    metric: string;
    baselineResults: BenchmarkResult[];
    challengerResults: BenchmarkResult[];
  }): ComparisonResult {
    const baselineAvg = params.baselineResults.length > 0
      ? params.baselineResults.reduce((sum, r) => sum + r.score, 0) / params.baselineResults.length
      : 0;

    const challengerAvg = params.challengerResults.length > 0
      ? params.challengerResults.reduce((sum, r) => sum + r.score, 0) / params.challengerResults.length
      : 0;

    const improvement = baselineAvg > 0
      ? ((challengerAvg - baselineAvg) / baselineAvg) * 100
      : 0;

    // Statistical significance (simplified)
    const significant = Math.abs(improvement) > 5; // 5% threshold

    const comparison: ComparisonResult = {
      id: randomUUID(),
      baseline: params.baseline,
      challenger: params.challenger,
      metric: params.metric,
      baselineScore: baselineAvg,
      challengerScore: challengerAvg,
      improvement,
      significant,
      timestamp: new Date().toISOString(),
    };

    this.comparisons.set(comparison.id, comparison);
    return comparison;
  }

  /**
   * Karşılaştırmaları al.
   */
  getComparisons(): ComparisonResult[] {
    return [...this.comparisons.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalComparisons: number;
    significantImprovements: number;
    avgImprovement: number;
  } {
    const comparisons = [...this.comparisons.values()];
    return {
      totalComparisons: comparisons.length,
      significantImprovements: comparisons.filter(c => c.significant && c.improvement > 0).length,
      avgImprovement: comparisons.length > 0
        ? comparisons.reduce((sum, c) => sum + c.improvement, 0) / comparisons.length
        : 0,
    };
  }
}

/**
 * Model Routing Pipeline
 * 
 * Adaptive model selection + Qwen vs Qwen+Aurora comparison.
 */
export class ModelRoutingPipeline {
  readonly router: AdaptiveModelRouter;
  readonly benchmarkRunner: BenchmarkRunner;
  readonly comparator: ModelComparator;

  constructor() {
    this.router = new AdaptiveModelRouter();
    this.benchmarkRunner = new BenchmarkRunner();
    this.comparator = new ModelComparator();
  }

  /**
   * Varsayılan model'leri ekle.
   */
  addDefaultModels(): void {
    this.router.addModel({
      name: "Qwen3.8-27B",
      provider: "qwen",
      capabilities: ["text-generation", "code-generation", "reasoning"],
      costPerToken: 0.0001,
      latencyMs: 500,
      accuracy: 0.85,
      maxTokens: 32768,
      supportedLanguages: ["en", "tr", "zh"],
    });

    this.router.addModel({
      name: "Qwen3.8-27B+Aurora",
      provider: "qwen+aurora",
      capabilities: ["text-generation", "code-generation", "reasoning", "planning", "memory"],
      costPerToken: 0.00015,
      latencyMs: 600,
      accuracy: 0.92,
      maxTokens: 32768,
      supportedLanguages: ["en", "tr", "zh"],
    });

    this.router.addModel({
      name: "GPT-4o",
      provider: "openai",
      capabilities: ["text-generation", "code-generation", "reasoning", "vision"],
      costPerToken: 0.005,
      latencyMs: 1000,
      accuracy: 0.90,
      maxTokens: 128000,
      supportedLanguages: ["en", "tr"],
    });
  }

  /**
   * Full routing pipeline çalıştır.
   */
  /**
   * Selects a model for a task without benchmarking it.
   *
   * This was a gap, not a design choice. `runPipeline` does selection and
   * benchmarking in one call, and benchmarking requires real model invocations
   * against supplied test cases -- correctly so, since a benchmark that never
   * calls a model is not a benchmark. The consequence was that nothing could
   * ask "which model fits this task?" on a per-task path without paying for a
   * benchmark, so the router was never consulted at all.
   *
   * Selection here is the scoring the router already implements: candidates are
   * filtered by the caller's latency/cost/accuracy/language requirements and
   * ranked by `accuracy * 0.6 + latencyScore * 0.2 + costScore * 0.2`. It
   * reports which model won and why, and it does not claim the winner was
   * measured -- that is what `runPipeline` is for.
   */
  selectForTask(params: {
    taskType: string;
    requirements: {
      maxLatency?: number | undefined;
      maxCost?: number | undefined;
      minAccuracy?: number | undefined;
      language?: string | undefined;
    };
    context?: Record<string, unknown> | undefined;
  }): RoutingDecision & {
    /** The selected profile's name, resolved from its generated id. */
    readonly selectedModelName: string;
    /** The alternatives' names, in ranked order. */
    readonly alternativeNames: readonly string[];
  } {
    // `selectModel` declares its requirements without `| undefined`, and this
    // package compiles with `exactOptionalPropertyTypes`, so absent constraints
    // are omitted rather than passed through as explicit undefined. An omitted
    // constraint means "no limit" to the scorer; an explicit undefined would not
    // type-check and would not mean anything different.
    const requirements: {
      maxLatency?: number;
      maxCost?: number;
      minAccuracy?: number;
      language?: string;
    } = {};
    if (params.requirements.maxLatency !== undefined) {
      requirements.maxLatency = params.requirements.maxLatency;
    }
    if (params.requirements.maxCost !== undefined) {
      requirements.maxCost = params.requirements.maxCost;
    }
    if (params.requirements.minAccuracy !== undefined) {
      requirements.minAccuracy = params.requirements.minAccuracy;
    }
    if (params.requirements.language !== undefined) {
      requirements.language = params.requirements.language;
    }

    const decision = this.router.selectModel({
      taskType: params.taskType,
      requirements,
      ...(params.context !== undefined ? { context: params.context } : {}),
    });

    // `RoutingDecision.selectedModel` is the profile's generated id, and the
    // human-readable name only appears inside the `reason` string. A caller
    // cannot route on a UUID it has never seen, so the names are resolved here
    // rather than left to be parsed out of prose.
    const profiles = this.router.getModels();
    const nameOf = (id: string): string =>
      profiles.find((profile) => profile.id === id)?.name ?? id;

    return {
      ...decision,
      selectedModelName: nameOf(decision.selectedModel),
      alternativeNames: decision.alternatives.map(nameOf),
    };
  }

  async runPipeline(params: {
    taskType: string;
    requirements: {
      maxLatency?: number;
      maxCost?: number;
      minAccuracy?: number;
      language?: string;
    };
    testCases: Array<{
      input: string;
      expectedOutput: string;
    }>;
    /** Calls the model under test. Required — see `BenchmarkRunner.runBenchmark`. */
    generate: (input: string) => Promise<string>;
  }): Promise<{
    routingDecision: RoutingDecision;
    benchmarkResults: BenchmarkResult[];
    comparison: ComparisonResult;
  }> {
    // 1. Model selection
    const routingDecision = this.router.selectModel({
      taskType: params.taskType,
      requirements: params.requirements,
    });

    // 2. Benchmark for selected model
    const selectedModel = this.router.getModels().find(m => m.id === routingDecision.selectedModel);
    const benchmarkResults = await this.benchmarkRunner.runBenchmark({
      modelName: selectedModel?.name ?? "unknown",
      taskCategory: params.taskType,
      testCases: params.testCases,
      generate: params.generate,
      evaluate: async (_input, output, expected) => {
        // Substring containment is a weak proxy for correctness; it is adequate
        // for routing comparisons but must not be read as an accuracy metric.
        return output.includes(expected) ? 1.0 : 0.0;
      },
    });

    // 3. Compare with baseline (Qwen without Aurora)
    const baselineResults = this.benchmarkRunner.getResultsByModel("Qwen3.8-27B");
    const challengerResults = this.benchmarkRunner.getResultsByModel("Qwen3.8-27B+Aurora");

    const comparison = this.comparator.compareModels({
      baseline: "Qwen3.8-27B",
      challenger: "Qwen3.8-27B+Aurora",
      metric: "accuracy",
      baselineResults,
      challengerResults,
    });

    return {
      routingDecision,
      benchmarkResults,
      comparison,
    };
  }

  /**
   * Pipeline istatistiklerini al.
   */
  getStats(): {
    router: ReturnType<AdaptiveModelRouter["getStats"]>;
    benchmarkRunner: ReturnType<BenchmarkRunner["getStats"]>;
    comparator: ReturnType<ModelComparator["getStats"]>;
  } {
    return {
      router: this.router.getStats(),
      benchmarkRunner: this.benchmarkRunner.getStats(),
      comparator: this.comparator.getStats(),
    };
  }
}
