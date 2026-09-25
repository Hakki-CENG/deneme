import { describe, expect, it } from "vitest";

import { compareRuns, type ComparisonRun } from "../src/benchmarking/comparison.js";
import { suiteCoverage } from "../src/benchmarking/suite-coverage.js";

describe("suite coverage (P3.1)", () => {
  it("maps all ten master-plan benchmark concepts to where they are measured", () => {
    const report = suiteCoverage();
    expect(report.totalSuiteTasks).toBe(61);
    expect(Object.keys(report.byCategory).length).toBe(11);

    const concepts = report.concepts.map((concept) => concept.concept).sort();
    expect(concepts).toEqual(
      [
        "browser",
        "coding",
        "files",
        "long-horizon",
        "memory",
        "multi-agent",
        "planning",
        "proactive",
        "recovery",
        "research",
      ].sort(),
    );
  });

  it("does not round partial coverage up to covered", () => {
    const report = suiteCoverage();
    const multiAgent = report.concepts.find((concept) => concept.concept === "multi-agent");
    const proactive = report.concepts.find((concept) => concept.concept === "proactive");
    // Measured by the engine-level harness, not by workspace-graded suite tasks.
    expect(multiAgent?.coverage).toBe("engine-harness");
    expect(proactive?.coverage).toBe("engine-harness");
    expect(multiAgent?.taskCount).toBe(0);

    // Suite-measured concepts carry real counts.
    const coding = report.concepts.find((concept) => concept.concept === "coding");
    expect(coding?.coverage).toBe("suite");
    expect(coding?.taskCount).toBeGreaterThan(0);
  });

  it("is honest about an empty category", () => {
    const report = suiteCoverage([{ id: "t", category: "reasoning", name: "t", instruction: "i", acceptance: [], budget: { maxTokens: 1000, maxSteps: 3, maxCostUsd: 0, timeoutMs: 1000 }, difficulty: 1 }]);
    expect(report.totalSuiteTasks).toBe(1);
    const coding = report.concepts.find((concept) => concept.concept === "coding");
    expect(coding?.coverage).toBe("none");
    expect(coding?.note).toContain("No tasks currently exist");
  });
});

describe("competitor comparison (P3.2)", () => {
  const ours: ComparisonRun = {
    agent: "aurora",
    results: [
      { taskId: "a", success: true, verified: true, completed: true, recovered: false, latencyMs: 100, costUsd: 0.01, interventions: 0, memoryRetention: 1 },
      { taskId: "b", success: false, verified: false, completed: true, recovered: true, latencyMs: 400, costUsd: 0.05, interventions: 1, memoryRetention: 0.5 },
      { taskId: "c", success: true, verified: true, completed: true, recovered: false, latencyMs: 200, costUsd: 0.02, interventions: 0, memoryRetention: 1 },
    ],
    source: "engine benchmark run",
  };

  it("computes every metric from the shared task set", () => {
    const report = compareRuns([ours]);
    const byName = new Map(report.metrics.map((metric) => [metric.name, metric]));
    expect(byName.get("task_success_rate")?.values[0]).toBeCloseTo(2 / 3);
    expect(byName.get("verified_success_rate")?.values[0]).toBeCloseTo(2 / 3);
    expect(byName.get("task_completion_rate")?.values[0]).toBe(1);
    expect(byName.get("recovery_success_rate")?.values[0]).toBeCloseTo(1 / 3);
    expect(byName.get("average_latency_ms")?.values[0]).toBeCloseTo((100 + 400 + 200) / 3);
    expect(byName.get("average_cost_usd")?.values[0]).toBeCloseTo((0.01 + 0.05 + 0.02) / 3);
    expect(byName.get("average_interventions")?.values[0]).toBeCloseTo(1 / 3);
    expect(byName.get("average_memory_retention")?.values[0]).toBeCloseTo(2.5 / 3);
    // a and c claimed success and were verified; b did not claim success.
    expect(byName.get("false_success_rate")?.values[0]).toBe(0);
  });

  it("detects a false success: claimed success without verification", () => {
    const fabricator: ComparisonRun = {
      agent: "claims-everything",
      results: [
        { taskId: "a", success: true, verified: false, completed: true },
        { taskId: "b", success: true, verified: false, completed: true },
        { taskId: "c", success: true, verified: true, completed: true },
      ],
    };
    const byName = new Map(compareRuns([fabricator]).metrics.map((metric) => [metric.name, metric]));
    expect(byName.get("false_success_rate")?.values[0]).toBeCloseTo(2 / 3);
  });

  it("never zero-fills an unrecorded metric", () => {
    const sparse: ComparisonRun = {
      agent: "sparse",
      results: [{ taskId: "a", success: true, completed: true }],
    };
    const byName = new Map(compareRuns([sparse]).metrics.map((metric) => [metric.name, metric]));
    expect(byName.get("average_latency_ms")?.values[0]).toBe("not-provided");
    expect(byName.get("average_latency_ms")?.providedRuns).toBe(0);
    expect(byName.get("average_cost_usd")?.values[0]).toBe("not-provided");
    // Success was recorded on the one shared task.
    expect(byName.get("task_success_rate")?.values[0]).toBe(1);
    expect(reportHasNote(compareRuns([sparse]), "not-provided")).toBe(true);
  });

  it("excludes tasks an agent did not run, and says so", () => {
    const partial: ComparisonRun = {
      agent: "partial",
      results: [
        { taskId: "a", success: true, verified: true, completed: true, latencyMs: 50 },
        { taskId: "b", success: true, verified: true, completed: true, latencyMs: 60 },
        // task c never ran for this agent
      ],
    };
    const report = compareRuns([ours, partial]);
    expect(report.nonOverlappingTaskIds).toEqual(["c"]);
    expect(report.honestNotes.join(" ")).toContain("excluded from every ratio");
    // Ratios are computed over the shared set {a, b} only.
    const byName = new Map(report.metrics.map((metric) => [metric.name, metric]));
    expect(byName.get("task_success_rate")?.values[0]).toBe(0.5); // ours over {a, b}: a ✓ b ✗
    expect(byName.get("task_success_rate")?.values[0]).not.toBe(2 / 3);
    expect(byName.get("task_success_rate")?.values[1]).toBe(1);
  });

  it("reports per-agent provenance and an empty report is honest about being empty", () => {
    const withSource = compareRuns([
      { agent: "x", results: [], source: "vendor whitepaper, not reproduced" },
    ]);
    expect(withSource.honestNotes.join(" ")).toContain("vendor whitepaper");

    const empty = compareRuns([]);
    expect(empty.honestNotes).toEqual(["No runs were provided."]);
    expect(empty.metrics).toEqual([]);
  });

  it("false_success_rate is not-provided when success and verified never co-occur", () => {
    const noVerify: ComparisonRun = {
      agent: "no-verify",
      results: [{ taskId: "a", success: true, completed: true, latencyMs: 10 }],
    };
    const report = compareRuns([noVerify]);
    const byName = new Map(report.metrics.map((metric) => [metric.name, metric]));
    expect(byName.get("false_success_rate")?.values[0]).toBe("not-provided");
    expect(report.honestNotes.join(" ")).toContain("no run recorded both");
  });
});

function reportHasNote(report: ReturnType<typeof compareRuns>, needle: string): boolean {
  return report.honestNotes.some((note) => note.includes(needle));
}
