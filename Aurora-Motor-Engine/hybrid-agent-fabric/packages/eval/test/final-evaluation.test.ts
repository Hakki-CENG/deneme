import { describe, it, expect } from "vitest";

import {
  FinalBenchmarkRunner,
  PerformanceComparator,
  ProductionReadinessChecker,
  FinalEvaluationPipeline,
} from "../src/final-evaluation.js";
import {
  DocumentationGenerator,
  RepoCleanupManager,
  DeploymentManager,
  FinalDocumentationPipeline,
} from "../src/final-documentation.js";
import { CORE_EVAL_TASKS } from "../src/tasks/core-tasks.js";

describe("FinalBenchmarkRunner", () => {
  it("runs registered tasks and records scores", async () => {
    const runner = new FinalBenchmarkRunner();
    runner.addTask({
      name: "sum",
      category: "coding",
      difficulty: "easy",
      input: { a: 1, b: 2 },
      expectedOutput: 3,
    });

    const results = await runner.runBenchmark({
      modelName: "test-model",
      evaluate: async (task) => {
        const input = task.input as { a: number; b: number };
        return { score: input.a + input.b === 3 ? 1 : 0, output: input.a + input.b };
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(1);
  });

  it("marks a task failed when the evaluator throws", async () => {
    const runner = new FinalBenchmarkRunner();
    runner.addTask({
      name: "broken",
      category: "coding",
      difficulty: "easy",
      input: {},
      expectedOutput: null,
    });

    const results = await runner.runBenchmark({
      modelName: "test-model",
      evaluate: async () => {
        throw new Error("evaluator exploded");
      },
    });

    expect(results[0]?.score).toBe(0);
  });

  it("enforces a per-task timeout instead of hanging", async () => {
    const runner = new FinalBenchmarkRunner();
    runner.addTask({
      name: "slow",
      category: "coding",
      difficulty: "easy",
      input: {},
      expectedOutput: null,
      timeout: 100,
    });

    const results = await runner.runBenchmark({
      modelName: "test-model",
      evaluate: async () =>
        await new Promise((resolve) =>
          setTimeout(() => resolve({ score: 1, output: null }), 2000)
        ),
    });

    expect(results[0]?.score).toBe(0);
  }, 15_000);

  it("loads the real core eval task set, not placeholder tasks", () => {
    const runner = new FinalBenchmarkRunner();
    runner.addDefaultTasks();

    const tasks = runner.getTasks();

    // The default set must BE the core eval suite (FAZ 1 gate), not a
    // synthetic categories x difficulties grid.
    expect(tasks.length).toBe(CORE_EVAL_TASKS.length);
    expect(tasks.length).toBeGreaterThanOrEqual(60);

    // Stable eval ids, so results stay comparable across runs.
    const ids = tasks.map((task) => task.id).sort();
    expect(ids).toEqual(CORE_EVAL_TASKS.map((task) => task.id).sort());
    expect(new Set(ids).size).toBe(ids.length);

    for (const task of tasks) {
      // Regression guard: the old generator emitted `{ result: "expected" }`,
      // an assertion that can never fail and therefore measures nothing.
      expect(JSON.stringify(task.expectedOutput)).not.toContain('"result":"expected"');

      // Every task must carry executable acceptance criteria.
      const expected = task.expectedOutput as { acceptance?: unknown[] };
      expect(Array.isArray(expected.acceptance)).toBe(true);
      expect(expected.acceptance!.length).toBeGreaterThan(0);

      // And a real instruction for the agent.
      const input = task.input as { instruction?: string };
      expect(typeof input.instruction).toBe("string");
      expect(input.instruction!.length).toBeGreaterThan(10);

      expect(task.timeout).toBeGreaterThan(0);
      expect(["trivial", "easy", "medium", "hard", "expert"]).toContain(task.difficulty);
    }

    // Categories come from the real suite rather than a hardcoded list.
    expect(new Set(tasks.map((task) => task.category)).size).toBeGreaterThanOrEqual(8);
  });
});

describe("PerformanceComparator", () => {
  it("compares two models on measured scores", () => {
    const comparator = new PerformanceComparator();
    const result = comparator.compare({
      baseline: "base",
      challenger: "cand",
      baselineResults: [
        { id: "1", taskId: "t1", modelName: "base", score: 0.5, latencyMs: 100, costUsd: 0.01, success: true, executedAt: new Date().toISOString() },
      ],
      challengerResults: [
        { id: "2", taskId: "t1", modelName: "cand", score: 0.9, latencyMs: 90, costUsd: 0.01, success: true, executedAt: new Date().toISOString() },
      ],
    });

    expect(result).toBeDefined();
    expect(result.metrics.accuracy.challenger).toBeGreaterThan(
      result.metrics.accuracy.baseline
    );
    expect(result.metrics.accuracy.improvement).toBeGreaterThan(0);
  });
});

describe("ProductionReadinessChecker", () => {
  it("reports not-ready when a critical check fails", async () => {
    const checker = new ProductionReadinessChecker();
    const [result] = await checker.checkReadiness({
      categories: [
        {
          name: "core",
          checks: [
            { name: "build", check: async () => true, severity: "critical" },
            { name: "tests", check: async () => false, severity: "critical" },
          ],
        },
      ],
    });

    expect(result?.ready).toBe(false);
  });

  it("reports ready when all critical checks pass", async () => {
    const checker = new ProductionReadinessChecker();
    const [result] = await checker.checkReadiness({
      categories: [
        {
          name: "core",
          checks: [
            { name: "build", check: async () => true, severity: "critical" },
            { name: "tests", check: async () => true, severity: "critical" },
          ],
        },
      ],
    });

    expect(result?.ready).toBe(true);
  });

  it("treats a throwing check as a critical failure", async () => {
    const checker = new ProductionReadinessChecker();
    const [result] = await checker.checkReadiness({
      categories: [
        {
          name: "core",
          checks: [
            {
              name: "explodes",
              check: async () => {
                throw new Error("boom");
              },
              severity: "low",
            },
          ],
        },
      ],
    });

    // A check that errors must never be counted as passing.
    expect(result?.ready).toBe(false);
  });
});

describe("FinalEvaluationPipeline", () => {
  it("exposes aggregate stats", () => {
    expect(new FinalEvaluationPipeline().getStats()).toBeDefined();
  });
});

describe("DocumentationGenerator", () => {
  it("generates documentation sections", () => {
    const generator = new DocumentationGenerator();
    generator.addDefaultSections();
    expect(generator.getSections().length).toBeGreaterThan(0);
    expect(generator.generateFullDocumentation().length).toBeGreaterThan(0);
  });
});

describe("RepoCleanupManager", () => {
  it("tracks cleanup tasks", () => {
    const manager = new RepoCleanupManager();
    manager.addDefaultTasks();
    expect(manager.getStats()).toBeDefined();
  });
});

describe("DeploymentManager", () => {
  it("tracks deployment readiness", () => {
    expect(new DeploymentManager().getStats()).toBeDefined();
  });
});

describe("FinalDocumentationPipeline", () => {
  it("runs the documentation pipeline end to end", async () => {
    const pipeline = new FinalDocumentationPipeline();
    pipeline.initialize();
    const result = await pipeline.runPipeline();
    expect(result).toBeDefined();
    expect(result.documentation).toBeDefined();
  });
});
