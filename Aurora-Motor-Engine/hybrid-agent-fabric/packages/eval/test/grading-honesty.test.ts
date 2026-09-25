/**
 * Two ways an eval harness lies to itself, both found by scanning for
 * "what looks finished but isn't":
 *
 *   1. A grader that reports a score it did not earn the right to report.
 *   2. An aggregate that treats "not measured" as "perfect".
 *
 * Both are worse than a missing feature, because eval numbers are what the
 * project uses to decide whether it improved.
 */

import { describe, expect, it } from "vitest";

import { averageQuality, formatQuality } from "../src/benchmarking/performance-benchmark.js";
import { gradeTask } from "../src/graders/grader.js";
import type { EvalTask, TrajectoryEvent } from "../src/tasks/types.js";

const BUDGET = { maxTokens: 1000, maxSteps: 10, maxCostUsd: 1, timeoutMs: 10_000 };

function judgeTask(minScore?: number): EvalTask {
  return {
    id: "judge-task",
    name: "judge",
    category: "reasoning",
    instruction: "Explain the tradeoffs",
    acceptance: [{ type: "judge", ...(minScore === undefined ? {} : { minScore }) }],
    budget: BUDGET,
    difficulty: 3,
  };
}

/** The trajectory that used to score a perfect 1.0 without doing anything. */
const BUSY_BUT_EMPTY: TrajectoryEvent[] = [
  { sequence: 0, kind: "session.tool.called", timestamp: "2026-01-01T00:00:00Z", payload: {} },
  { sequence: 1, kind: "session.completed", timestamp: "2026-01-01T00:00:01Z", payload: {} },
];

describe("the judge grader does not invent a score", () => {
  it("refuses to pass a trajectory that merely looks busy", async () => {
    // Before the fix this scored 1.0 and passed: one tool event plus one
    // "completed" event was enough, whatever the agent actually produced.
    const [grade] = await gradeTask(judgeTask(), BUSY_BUT_EMPTY, undefined, {});

    expect(grade?.passed).toBe(false);
    expect(grade?.score).toBe(0);
  });

  it("names what is missing instead of guessing", async () => {
    const [grade] = await gradeTask(judgeTask(), BUSY_BUT_EMPTY, undefined, {});

    expect(grade?.details).toContain("not implemented");
    expect(grade?.details).toMatch(/judge model/i);
  });

  it("cannot be satisfied by lowering minScore", async () => {
    // A tempting workaround: set minScore to 0 and let activity count as proof.
    const [grade] = await gradeTask(judgeTask(0), BUSY_BUT_EMPTY, undefined, {});

    expect(grade?.passed).toBe(false);
  });

  it("stays unscored even for a long, eventful trajectory", async () => {
    const many: TrajectoryEvent[] = Array.from({ length: 50 }, (_, index) => ({
      sequence: index,
      kind: index % 2 === 0 ? "session.tool.called" : "session.completed",
      timestamp: "2026-01-01T00:00:00Z",
      payload: {},
    }));

    const [grade] = await gradeTask(judgeTask(), many, undefined, {});
    expect(grade?.score).toBe(0);
    expect(grade?.passed).toBe(false);
  });
});

describe("unmeasured quality is not counted as perfect", () => {
  const entry = (qualityScore: number | undefined) => ({
    taskId: "t",
    category: "c",
    difficulty: 3,
    durationMs: 10,
    trajectoryEvents: 0,
    qualityScore,
    status: "pass",
    timestamp: "2026-01-01T00:00:00Z",
  });

  it("excludes unmeasured tasks from the average instead of scoring them 1.0", () => {
    // Old behaviour: (0.4 + 1.0 + 1.0) / 3 = 0.80 — inflated by two guesses.
    // Correct: only the measured task counts.
    expect(averageQuality([entry(0.4), entry(undefined), entry(undefined)])).toBeCloseTo(0.4, 5);
  });

  it("averages several measured tasks normally", () => {
    expect(averageQuality([entry(0.5), entry(1), entry(undefined)])).toBeCloseTo(0.75, 5);
  });

  it("reports undefined when nothing was measured", () => {
    expect(averageQuality([entry(undefined), entry(undefined)])).toBeUndefined();
  });

  it("says so in the report rather than printing a number", () => {
    expect(formatQuality(undefined)).toContain("unmeasured");
    expect(formatQuality(0.42)).toBe("0.42");
  });
});
