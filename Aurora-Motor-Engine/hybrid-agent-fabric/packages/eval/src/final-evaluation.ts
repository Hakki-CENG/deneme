/**
 * Final Evaluation — Aurora Cognitive Runtime
 *
 * Final benchmark.
 * Performance comparison.
 * Production readiness.
 */

import { randomUUID } from "node:crypto";
import { CORE_EVAL_TASKS } from "./tasks/core-tasks.js";

/**
 * Maps the numeric 1-5 difficulty used by the core eval task set onto the
 * benchmark runner's named difficulty bands.
 */
const DIFFICULTY_BY_LEVEL: readonly BenchmarkTask["difficulty"][] = [
  "trivial",
  "easy",
  "medium",
  "hard",
  "expert",
];

/**
 * Benchmark task.
 */
export interface BenchmarkTask {
  id: string;
  name: string;
  category: string;
  difficulty: "trivial" | "easy" | "medium" | "hard" | "expert";
  input: unknown;
  expectedOutput: unknown;
  timeout: number;
}

/**
 * Benchmark result.
 */
export interface BenchmarkResult {
  id: string;
  taskId: string;
  modelName: string;
  score: number; // 0-1
  latencyMs: number;
  costTokens: number;
  success: boolean;
  error?: string;
  timestamp: string;
}

/**
 * Performance comparison.
 */
export interface PerformanceComparison {
  id: string;
  baseline: string;
  challenger: string;
  metrics: {
    accuracy: { baseline: number; challenger: number; improvement: number };
    latency: { baseline: number; challenger: number; improvement: number };
    cost: { baseline: number; challenger: number; improvement: number };
  };
  overallImprovement: number;
  significant: boolean;
  timestamp: string;
}

/**
 * Production readiness.
 */
export interface ProductionReadiness {
  id: string;
  category: string;
  checks: Array<{
    name: string;
    passed: boolean;
    severity: "low" | "medium" | "high" | "critical";
    message: string;
  }>;
  overallScore: number; // 0-1
  ready: boolean;
  timestamp: string;
}

/**
 * Benchmark Runner
 * 
 * Final benchmark.
 */
export class FinalBenchmarkRunner {
  private readonly tasks = new Map<string, BenchmarkTask>();
  private readonly results = new Map<string, BenchmarkResult>();

  /**
   * Benchmark task ekle.
   */
  addTask(params: {
    name: string;
    category: string;
    difficulty: BenchmarkTask["difficulty"];
    input: unknown;
    expectedOutput: unknown;
    timeout?: number;
  }): BenchmarkTask {
    const id = randomUUID();
    const task: BenchmarkTask = {
      id,
      name: params.name,
      category: params.category,
      difficulty: params.difficulty,
      input: params.input,
      expectedOutput: params.expectedOutput,
      timeout: params.timeout ?? 5000,
    };
    this.tasks.set(id, task);
    return task;
  }

  /**
   * Load the real core eval task set (FAZ 1 gate).
   *
   * This used to synthesise a categories×difficulties grid of placeholder
   * tasks whose `expectedOutput` was literally `{ result: "expected" }`. Such
   * tasks can never fail meaningfully, so any benchmark built on them reported
   * a score that measured nothing. They are replaced by `CORE_EVAL_TASKS`:
   * real, self-contained tasks with executable acceptance criteria.
   *
   * The task ids are the stable eval ids (e.g. `coding-001-fizzbuzz`) rather
   * than random UUIDs, so benchmark results stay comparable across runs.
   */
  addDefaultTasks(): void {
    for (const task of CORE_EVAL_TASKS) {
      const benchmarkTask: BenchmarkTask = {
        id: task.id,
        name: task.name,
        category: task.category,
        difficulty: DIFFICULTY_BY_LEVEL[Math.min(Math.max(task.difficulty, 1), 5) - 1]!,
        // The agent receives the instruction plus any workspace seed files.
        input: {
          instruction: task.instruction,
          ...(task.workspace ? { workspace: task.workspace } : {}),
        },
        // Acceptance criteria are executable checks, not a canned value.
        expectedOutput: { acceptance: task.acceptance },
        timeout: task.budget.timeoutMs,
      };
      this.tasks.set(benchmarkTask.id, benchmarkTask);
    }
  }

  /**
   * Benchmark çalıştır.
   */
  async runBenchmark(params: {
    modelName: string;
    taskIds?: string[];
    evaluate: (task: BenchmarkTask) => Promise<{ score: number; output: unknown }>;
  }): Promise<BenchmarkResult[]> {
    const tasks = params.taskIds
      ? params.taskIds.map(id => this.tasks.get(id)).filter(Boolean) as BenchmarkTask[]
      : [...this.tasks.values()];

    const results: BenchmarkResult[] = [];

    for (const task of tasks) {
      const startTime = Date.now();

      try {
        const { score, output } = await Promise.race([
          params.evaluate(task),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), task.timeout)
          ),
        ]);

        const latencyMs = Date.now() - startTime;

        const result: BenchmarkResult = {
          id: randomUUID(),
          taskId: task.id,
          modelName: params.modelName,
          score,
          latencyMs,
          costTokens: JSON.stringify(task.input).length + JSON.stringify(output).length,
          success: score > 0.5,
          timestamp: new Date().toISOString(),
        };

        results.push(result);
        this.results.set(result.id, result);
      } catch (error) {
        const latencyMs = Date.now() - startTime;

        const result: BenchmarkResult = {
          id: randomUUID(),
          taskId: task.id,
          modelName: params.modelName,
          score: 0,
          latencyMs,
          costTokens: 0,
          success: false,
          error: String(error),
          timestamp: new Date().toISOString(),
        };

        results.push(result);
        this.results.set(result.id, result);
      }
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
    const tasks = [...this.tasks.values()].filter(t => t.category === category);
    const taskIds = new Set(tasks.map(t => t.id));
    return [...this.results.values()].filter(r => taskIds.has(r.taskId));
  }

  /**
   * Registered benchmark tasks, so callers can inspect what will actually run.
   */
  getTasks(): BenchmarkTask[] {
    return [...this.tasks.values()];
  }

  /**
   * Look up a single registered task by id.
   */
  getTask(taskId: string): BenchmarkTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalTasks: number;
    totalResults: number;
    avgScore: number;
    avgLatency: number;
    successRate: number;
    byCategory: Record<string, { avgScore: number; count: number }>;
    byDifficulty: Record<string, { avgScore: number; count: number }>;
  } {
    const results = [...this.results.values()];
    const tasks = [...this.tasks.values()];

    const byCategory: Record<string, { avgScore: number; count: number }> = {};
    const byDifficulty: Record<string, { avgScore: number; count: number }> = {};

    // Category stats
    for (const category of new Set(tasks.map(t => t.category))) {
      const categoryTasks = tasks.filter(t => t.category === category);
      const categoryResults = results.filter(r =>
        categoryTasks.some(t => t.id === r.taskId)
      );
      byCategory[category] = {
        avgScore: categoryResults.length > 0
          ? categoryResults.reduce((sum, r) => sum + r.score, 0) / categoryResults.length
          : 0,
        count: categoryResults.length,
      };
    }

    // Difficulty stats
    for (const difficulty of new Set(tasks.map(t => t.difficulty))) {
      const difficultyTasks = tasks.filter(t => t.difficulty === difficulty);
      const difficultyResults = results.filter(r =>
        difficultyTasks.some(t => t.id === r.taskId)
      );
      byDifficulty[difficulty] = {
        avgScore: difficultyResults.length > 0
          ? difficultyResults.reduce((sum, r) => sum + r.score, 0) / difficultyResults.length
          : 0,
        count: difficultyResults.length,
      };
    }

    return {
      totalTasks: tasks.length,
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
      byCategory,
      byDifficulty,
    };
  }
}

/**
 * Performance Comparator
 * 
 * Performance comparison.
 */
export class PerformanceComparator {
  private readonly comparisons = new Map<string, PerformanceComparison>();

  /**
   * Performance karşılaştırması yap.
   */
  compare(params: {
    baseline: string;
    challenger: string;
    baselineResults: BenchmarkResult[];
    challengerResults: BenchmarkResult[];
  }): PerformanceComparison {
    const baselineAccuracy = params.baselineResults.length > 0
      ? params.baselineResults.reduce((sum, r) => sum + r.score, 0) / params.baselineResults.length
      : 0;
    const challengerAccuracy = params.challengerResults.length > 0
      ? params.challengerResults.reduce((sum, r) => sum + r.score, 0) / params.challengerResults.length
      : 0;

    const baselineLatency = params.baselineResults.length > 0
      ? params.baselineResults.reduce((sum, r) => sum + r.latencyMs, 0) / params.baselineResults.length
      : 0;
    const challengerLatency = params.challengerResults.length > 0
      ? params.challengerResults.reduce((sum, r) => sum + r.latencyMs, 0) / params.challengerResults.length
      : 0;

    const baselineCost = params.baselineResults.length > 0
      ? params.baselineResults.reduce((sum, r) => sum + r.costTokens, 0) / params.baselineResults.length
      : 0;
    const challengerCost = params.challengerResults.length > 0
      ? params.challengerResults.reduce((sum, r) => sum + r.costTokens, 0) / params.challengerResults.length
      : 0;

    const accuracyImprovement = baselineAccuracy > 0
      ? ((challengerAccuracy - baselineAccuracy) / baselineAccuracy) * 100
      : 0;
    const latencyImprovement = baselineLatency > 0
      ? ((baselineLatency - challengerLatency) / baselineLatency) * 100
      : 0;
    const costImprovement = baselineCost > 0
      ? ((baselineCost - challengerCost) / baselineCost) * 100
      : 0;

    const overallImprovement = (accuracyImprovement + latencyImprovement + costImprovement) / 3;

    const comparison: PerformanceComparison = {
      id: randomUUID(),
      baseline: params.baseline,
      challenger: params.challenger,
      metrics: {
        accuracy: { baseline: baselineAccuracy, challenger: challengerAccuracy, improvement: accuracyImprovement },
        latency: { baseline: baselineLatency, challenger: challengerLatency, improvement: latencyImprovement },
        cost: { baseline: baselineCost, challenger: challengerCost, improvement: costImprovement },
      },
      overallImprovement,
      significant: Math.abs(overallImprovement) > 5,
      timestamp: new Date().toISOString(),
    };

    this.comparisons.set(comparison.id, comparison);
    return comparison;
  }

  /**
   * Karşılaştırmaları al.
   */
  getComparisons(): PerformanceComparison[] {
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
      significantImprovements: comparisons.filter(c => c.significant && c.overallImprovement > 0).length,
      avgImprovement: comparisons.length > 0
        ? comparisons.reduce((sum, c) => sum + c.overallImprovement, 0) / comparisons.length
        : 0,
    };
  }
}

/**
 * Production Readiness Checker
 * 
 * Production readiness.
 */
export class ProductionReadinessChecker {
  private readonly readinessResults = new Map<string, ProductionReadiness>();

  /**
   * Production readiness kontrolü yap.
   */
  async checkReadiness(params: {
    categories: Array<{
      name: string;
      checks: Array<{
        name: string;
        check: () => Promise<boolean>;
        severity: "low" | "medium" | "high" | "critical";
      }>;
    }>;
  }): Promise<ProductionReadiness[]> {
    const results: ProductionReadiness[] = [];

    for (const category of params.categories) {
      const checks: ProductionReadiness["checks"] = [];

      for (const check of category.checks) {
        try {
          const passed = await check.check();
          checks.push({
            name: check.name,
            passed,
            severity: check.severity,
            message: passed ? "Check passed" : "Check failed",
          });
        } catch (error) {
          checks.push({
            name: check.name,
            passed: false,
            severity: "critical",
            message: `Check error: ${error}`,
          });
        }
      }

      const passedChecks = checks.filter(c => c.passed).length;
      const overallScore = checks.length > 0 ? passedChecks / checks.length : 0;
      const criticalFailed = checks.some(c => !c.passed && c.severity === "critical");

      const readiness: ProductionReadiness = {
        id: randomUUID(),
        category: category.name,
        checks,
        overallScore,
        ready: overallScore >= 0.8 && !criticalFailed,
        timestamp: new Date().toISOString(),
      };

      results.push(readiness);
      this.readinessResults.set(readiness.id, readiness);
    }

    return results;
  }

  /**
   * Readiness sonuçlarını al.
   */
  getReadinessResults(): ProductionReadiness[] {
    return [...this.readinessResults.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    overallReady: boolean;
  } {
    const results = [...this.readinessResults.values()];
    const allChecks = results.flatMap(r => r.checks);
    return {
      totalChecks: allChecks.length,
      passedChecks: allChecks.filter(c => c.passed).length,
      failedChecks: allChecks.filter(c => !c.passed).length,
      overallReady: results.every(r => r.ready),
    };
  }
}

/**
 * Final Evaluation Pipeline
 * 
 * Final benchmark + Performance comparison + Production readiness.
 */
export class FinalEvaluationPipeline {
  readonly benchmarkRunner: FinalBenchmarkRunner;
  readonly comparator: PerformanceComparator;
  readonly readinessChecker: ProductionReadinessChecker;

  constructor() {
    this.benchmarkRunner = new FinalBenchmarkRunner();
    this.comparator = new PerformanceComparator();
    this.readinessChecker = new ProductionReadinessChecker();
  }

  /**
   * Full evaluation pipeline çalıştır.
   */
  async runFullEvaluation(params: {
    models: Array<{
      name: string;
      evaluate: (task: BenchmarkTask) => Promise<{ score: number; output: unknown }>;
    }>;
    baselineModel: string;
    /**
     * Readiness probes for the Core Systems and Security categories.
     *
     * REQUIRED. These checks were hard-coded as `async () => true` — six
     * checks, three of them `critical`, that could never fail. They feed 40% of
     * `overallScore`, so every evaluation carried a free pass and a system with
     * no injection detection and no kill switch still reported itself ready.
     *
     * This pipeline has no handle on the engine, so it cannot honestly probe
     * these itself. The caller owns the engine and must supply real probes.
     */
    readinessProbes: {
      engineInitialized: () => Promise<boolean>;
      memorySystemActive: () => Promise<boolean>;
      verificationSystemActive: () => Promise<boolean>;
      injectionDetectionActive: () => Promise<boolean>;
      killSwitchConfigured: () => Promise<boolean>;
      trustLevelsConfigured: () => Promise<boolean>;
    };
  }): Promise<{
    benchmarkResults: Map<string, BenchmarkResult[]>;
    comparisons: PerformanceComparison[];
    readiness: ProductionReadiness[];
    overallScore: number;
  }> {
    const requiredProbes = [
      "engineInitialized",
      "memorySystemActive",
      "verificationSystemActive",
      "injectionDetectionActive",
      "killSwitchConfigured",
      "trustLevelsConfigured",
    ] as const;
    for (const probe of requiredProbes) {
      if (typeof params.readinessProbes?.[probe] !== "function") {
        throw new Error(
          `runFullEvaluation requires a real '${probe}' readiness probe. ` +
            `Hard-coded passes previously made a critical readiness check unable to fail.`,
        );
      }
    }

    // 1. Benchmark tasks ekle
    this.benchmarkRunner.addDefaultTasks();

    // 2. Her model için benchmark çalıştır
    const benchmarkResults = new Map<string, BenchmarkResult[]>();
    for (const model of params.models) {
      const results = await this.benchmarkRunner.runBenchmark({
        modelName: model.name,
        evaluate: model.evaluate,
      });
      benchmarkResults.set(model.name, results);
    }

    // 3. Performance karşılaştırması
    const comparisons: PerformanceComparison[] = [];
    const baselineResults = benchmarkResults.get(params.baselineModel) ?? [];

    for (const [modelName, results] of benchmarkResults) {
      if (modelName !== params.baselineModel) {
        const comparison = this.comparator.compare({
          baseline: params.baselineModel,
          challenger: modelName,
          baselineResults,
          challengerResults: results,
        });
        comparisons.push(comparison);
      }
    }

    // 4. Production readiness
    const readiness = await this.readinessChecker.checkReadiness({
      categories: [
        {
          name: "Core Systems",
          checks: [
            { name: "Engine initialized", check: params.readinessProbes.engineInitialized, severity: "critical" },
            { name: "Memory system active", check: params.readinessProbes.memorySystemActive, severity: "critical" },
            { name: "Verification system active", check: params.readinessProbes.verificationSystemActive, severity: "high" },
          ],
        },
        {
          name: "Security",
          checks: [
            { name: "Injection detection active", check: params.readinessProbes.injectionDetectionActive, severity: "critical" },
            { name: "Kill switch configured", check: params.readinessProbes.killSwitchConfigured, severity: "high" },
            { name: "Trust levels configured", check: params.readinessProbes.trustLevelsConfigured, severity: "medium" },
          ],
        },
        {
          name: "Performance",
          checks: [
            { name: "Benchmark completed", check: async () => benchmarkResults.size > 0, severity: "high" },
            { name: "Success rate > 70%", check: async () => {
              const stats = this.benchmarkRunner.getStats();
              return stats.successRate > 0.7;
            }, severity: "high" },
          ],
        },
      ],
    });

    // 5. Overall score
    const benchmarkStats = this.benchmarkRunner.getStats();
    const readinessStats = this.readinessChecker.getStats();
    const overallScore = (benchmarkStats.avgScore * 0.6) + (readinessStats.passedChecks / Math.max(1, readinessStats.totalChecks) * 0.4);

    return {
      benchmarkResults,
      comparisons,
      readiness,
      overallScore,
    };
  }

  /**
   * Pipeline istatistiklerini al.
   */
  getStats(): {
    benchmark: ReturnType<FinalBenchmarkRunner["getStats"]>;
    comparator: ReturnType<PerformanceComparator["getStats"]>;
    readiness: ReturnType<ProductionReadinessChecker["getStats"]>;
  } {
    return {
      benchmark: this.benchmarkRunner.getStats(),
      comparator: this.comparator.getStats(),
      readiness: this.readinessChecker.getStats(),
    };
  }
}
