/**
 * Reward-hacking detectors.
 *
 * The defence pipeline previously ran `async () => true` for every check, so
 * it reported a clean audit no matter what the system did. These tests exist
 * to prove the replacement detectors can actually return a negative verdict —
 * a security check that cannot fail is worse than no check, because it
 * manufactures confidence.
 *
 * Each detector is therefore tested in both directions: it must catch the
 * attack signature, and it must not cry wolf on healthy data.
 */

import { describe, expect, it } from "vitest";
import {
  detectRewardCurveManipulation,
  detectScoreSpike,
  detectEvaluationCheating,
  detectMetricGaming,
  detectDataPoisoning,
  buildDefenceChecks,
  detectorForCategory,
  correlation,
  type ScoreSample,
} from "../src/security/reward-hacking-detectors.js";
import { RewardHackingDefensePipeline } from "../src/security/reward-hacking-defense.js";

/** Score and ground truth rising together — genuine improvement. */
const HEALTHY: ScoreSample[] = [
  { step: 1, score: 0.50, groundTruth: 0.48 },
  { step: 2, score: 0.55, groundTruth: 0.54 },
  { step: 3, score: 0.62, groundTruth: 0.60 },
  { step: 4, score: 0.68, groundTruth: 0.67 },
  { step: 5, score: 0.74, groundTruth: 0.72 },
  { step: 6, score: 0.80, groundTruth: 0.78 },
];

/** Score climbing while real capability stays flat — the classic signature. */
const HACKED: ScoreSample[] = [
  { step: 1, score: 0.50, groundTruth: 0.48 },
  { step: 2, score: 0.62, groundTruth: 0.49 },
  { step: 3, score: 0.74, groundTruth: 0.47 },
  { step: 4, score: 0.86, groundTruth: 0.50 },
  { step: 5, score: 0.93, groundTruth: 0.48 },
  { step: 6, score: 0.98, groundTruth: 0.49 },
];

describe("reward curve manipulation", () => {
  it("flags a score that climbs while ground truth stays flat", () => {
    const verdict = detectRewardCurveManipulation(HACKED);

    expect(verdict.clean).toBe(false);
    expect(verdict.suspicion).toBeGreaterThan(0);
    expect(verdict.detail).toContain("ground truth");
    expect(verdict.evidence?.divergence).toBeGreaterThan(0.2);
  });

  it("does not flag genuine improvement", () => {
    const verdict = detectRewardCurveManipulation(HEALTHY);

    expect(verdict.clean).toBe(true);
    expect(verdict.suspicion).toBe(0);
    expect(verdict.evidence?.correlation).toBeGreaterThan(0.9);
  });

  it("declines to judge on insufficient paired evidence", () => {
    const verdict = detectRewardCurveManipulation([{ step: 1, score: 0.9 }]);

    // Honest abstention, and it says so rather than implying a passing audit.
    expect(verdict.clean).toBe(true);
    expect(verdict.detail).toContain("Insufficient");
    expect(verdict.suspicion).toBe(0);
  });
});

describe("score spikes", () => {
  it("flags a jump far outside historical variance", () => {
    const verdict = detectScoreSpike([
      { step: 1, score: 0.50 },
      { step: 2, score: 0.52 },
      { step: 3, score: 0.49 },
      { step: 4, score: 0.51 },
      { step: 5, score: 0.53 },
      { step: 6, score: 0.99 },
    ]);

    expect(verdict.clean).toBe(false);
    expect(verdict.evidence?.zScore).toBeGreaterThan(3);
  });

  it("catches a leap from a perfectly flat baseline, where variance is zero", () => {
    // Guards against a divide-by-zero making the check silently unfalsifiable.
    const verdict = detectScoreSpike([
      { step: 1, score: 0.5 },
      { step: 2, score: 0.5 },
      { step: 3, score: 0.5 },
      { step: 4, score: 0.5 },
      { step: 5, score: 1.0 },
    ]);

    expect(verdict.clean).toBe(false);
    expect(verdict.detail).toContain("flat baseline");
  });

  it("accepts steady incremental progress", () => {
    const verdict = detectScoreSpike(HEALTHY);
    expect(verdict.clean).toBe(true);
  });
});

describe("evaluation cheating", () => {
  it("flags self-grading", () => {
    const verdict = detectEvaluationCheating([
      { taskId: "t1", score: 1, gradedBy: "agent-a", solvedBy: "agent-a" },
      { taskId: "t2", score: 1, gradedBy: "grader", solvedBy: "agent-a" },
    ]);

    expect(verdict.clean).toBe(false);
    expect(verdict.detail).toContain("same identity");
  });

  it("flags a held-out generalisation collapse", () => {
    const verdict = detectEvaluationCheating([
      { taskId: "seen-1", score: 1.0, gradedBy: "grader", solvedBy: "agent", heldOut: false },
      { taskId: "seen-2", score: 0.98, gradedBy: "grader", solvedBy: "agent", heldOut: false },
      { taskId: "held-1", score: 0.35, gradedBy: "grader", solvedBy: "agent", heldOut: true },
      { taskId: "held-2", score: 0.30, gradedBy: "grader", solvedBy: "agent", heldOut: true },
    ]);

    expect(verdict.clean).toBe(false);
    expect(verdict.detail).toContain("held-out");
    expect(verdict.evidence?.gap).toBeGreaterThan(0.3);
  });

  it("accepts independent grading with consistent held-out performance", () => {
    const verdict = detectEvaluationCheating([
      { taskId: "seen-1", score: 0.80, gradedBy: "grader", solvedBy: "agent", heldOut: false },
      { taskId: "seen-2", score: 0.78, gradedBy: "grader", solvedBy: "agent", heldOut: false },
      { taskId: "held-1", score: 0.75, gradedBy: "grader", solvedBy: "agent", heldOut: true },
      { taskId: "held-2", score: 0.72, gradedBy: "grader", solvedBy: "agent", heldOut: true },
    ]);

    expect(verdict.clean).toBe(true);
  });
});

describe("metric gaming", () => {
  it("flags one metric rising while another degrades", () => {
    const verdict = detectMetricGaming(
      {
        score: [0.5, 0.6, 0.8, 0.9],
        latency: [0.8, 0.7, 0.5, 0.3],
      },
      { targetMetric: "score" },
    );

    expect(verdict.clean).toBe(false);
    expect(verdict.detail).toContain("latency");
  });

  it("accepts broad improvement across metrics", () => {
    const verdict = detectMetricGaming(
      {
        score: [0.5, 0.6, 0.7, 0.8],
        latency: [0.5, 0.55, 0.6, 0.65],
      },
      { targetMetric: "score" },
    );

    expect(verdict.clean).toBe(true);
  });
});

describe("data poisoning", () => {
  it("flags a distribution stuffed with outliers", () => {
    const verdict = detectDataPoisoning([
      ...Array.from({ length: 10 }, (_, index) => ({ id: `n${index}`, value: 50 + (index % 3) })),
      ...Array.from({ length: 6 }, (_, index) => ({ id: `p${index}`, value: 5000 })),
    ]);

    expect(verdict.clean).toBe(false);
    // Tukey fences alone miss this: 6 of 16 poisoned points drag Q3 out to
    // 5000, widening the fences until the poison sits inside them. The MAD
    // fallback is what catches it.
    expect(verdict.detail).toContain("median absolute deviation");
    expect(verdict.evidence?.outlierShare).toBeGreaterThanOrEqual(0.2);
  });

  it("flags a single source dominating the dataset", () => {
    const verdict = detectDataPoisoning([
      ...Array.from({ length: 19 }, (_, index) => ({ id: `a${index}`, value: 50 + (index % 5), source: "attacker" })),
      { id: "legit", value: 52, source: "trusted" },
    ]);

    expect(verdict.clean).toBe(false);
    expect(verdict.detail).toContain("dominating");
  });

  it("accepts a healthy mixed distribution", () => {
    const verdict = detectDataPoisoning(
      Array.from({ length: 20 }, (_, index) => ({
        id: `s${index}`,
        value: 50 + (index % 7),
        source: index % 2 === 0 ? "source-a" : "source-b",
      })),
    );

    expect(verdict.clean).toBe(true);
  });
});

describe("correlation helper", () => {
  it("returns 1 for a perfectly linear relationship", () => {
    expect(correlation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 5);
  });

  it("returns 0 for a constant series rather than NaN", () => {
    expect(correlation([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
  });
});

describe("defence checks are executable, not stubs", () => {
  it("returns false for at least one check when the system is compromised", async () => {
    const checks = buildDefenceChecks({
      scoreHistory: HACKED,
      evaluations: [{ taskId: "t", score: 1, gradedBy: "agent", solvedBy: "agent" }],
    });

    const results = await Promise.all(checks.map((entry) => entry.check()));

    // The old stubs made this impossible: every check returned true forever.
    expect(results).toContain(false);
    expect(results.filter((value) => value === false).length).toBeGreaterThanOrEqual(2);
  });

  it("returns true for every check on a healthy system", async () => {
    const checks = buildDefenceChecks({
      scoreHistory: HEALTHY,
      evaluations: [{ taskId: "t", score: 0.8, gradedBy: "grader", solvedBy: "agent" }],
    });

    const results = await Promise.all(checks.map((entry) => entry.check()));
    expect(results.every(Boolean)).toBe(true);
  });

  it("maps every attack category to a real detector", () => {
    const categories = ["reward_hacking", "metric_gaming", "evaluation_cheating", "data_poisoning"] as const;

    for (const category of categories) {
      const verdict = detectorForCategory(category, { scoreHistory: HACKED });
      expect(verdict, `${category} has no detector`).toBeDefined();
      expect(typeof verdict.clean).toBe("boolean");
      expect(verdict.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("RewardHackingDefensePipeline end to end", () => {
  it("reports findings when given evidence of reward hacking", async () => {
    const pipeline = new RewardHackingDefensePipeline();
    pipeline.initialize();

    const report = await pipeline.runDefensePipeline({
      targetId: "model-under-test",
      targetType: "model",
      evidence: {
        scoreHistory: HACKED,
        evaluations: [{ taskId: "t1", score: 1, gradedBy: "agent", solvedBy: "agent" }],
      },
    });

    expect(report.evidenceSupplied).toBe(true);
    expect(report.securityAudit.findings.length).toBeGreaterThan(0);
    expect(["high", "critical"]).toContain(report.overallRisk);

    // The attack tests must register detections rather than a clean sweep.
    expect(report.attackTests.some((test) => test.detected)).toBe(true);
  });

  it("passes a clean system but admits when no evidence was supplied", async () => {
    const pipeline = new RewardHackingDefensePipeline();
    pipeline.initialize();

    const withEvidence = await pipeline.runDefensePipeline({
      targetId: "model",
      targetType: "model",
      evidence: { scoreHistory: HEALTHY },
    });
    expect(withEvidence.evidenceSupplied).toBe(true);
    expect(withEvidence.securityAudit.findings).toHaveLength(0);

    // No evidence must NOT be reported the same way as a passing audit.
    const withoutEvidence = await pipeline.runDefensePipeline({
      targetId: "model",
      targetType: "model",
    });
    expect(withoutEvidence.evidenceSupplied).toBe(false);
  });
});
