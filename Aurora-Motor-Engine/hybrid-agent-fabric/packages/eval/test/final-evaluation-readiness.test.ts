/**
 * Production readiness checks must be able to fail.
 *
 * `runFullEvaluation` hard-coded six readiness checks as `async () => true` —
 * three of them `critical`. They contribute 40% of `overallScore`, so a system
 * with no injection detection and no kill switch still reported itself ready.
 *
 * The probes are now caller-supplied and mandatory.
 */

import { describe, expect, it } from "vitest";

import { FinalEvaluationPipeline } from "../src/final-evaluation.js";

const passingProbes = {
  engineInitialized: async () => true,
  memorySystemActive: async () => true,
  verificationSystemActive: async () => true,
  injectionDetectionActive: async () => true,
  killSwitchConfigured: async () => true,
  trustLevelsConfigured: async () => true,
};

const models = [
  {
    name: "baseline",
    evaluate: async () => ({ score: 0.9, output: "ok" }),
  },
];

describe("readiness probes are mandatory", () => {
  it("refuses to run without probes", async () => {
    const pipeline = new FinalEvaluationPipeline();

    await expect(
      // @ts-expect-error — deliberately omitting the required probes
      pipeline.runFullEvaluation({ models, baselineModel: "baseline" }),
    ).rejects.toThrow(/readiness probe/i);
  });

  it("names the missing probe", async () => {
    const pipeline = new FinalEvaluationPipeline();
    const incomplete = { ...passingProbes } as Record<string, unknown>;
    delete incomplete["killSwitchConfigured"];

    await expect(
      pipeline.runFullEvaluation({
        models,
        baselineModel: "baseline",
        // @ts-expect-error — deliberately incomplete
        readinessProbes: incomplete,
      }),
    ).rejects.toThrow(/killSwitchConfigured/);
  });
});

describe("a failing probe actually lowers readiness", () => {
  it("reports not-ready when a critical probe fails", async () => {
    const pipeline = new FinalEvaluationPipeline();

    const result = await pipeline.runFullEvaluation({
      models,
      baselineModel: "baseline",
      readinessProbes: {
        ...passingProbes,
        injectionDetectionActive: async () => false,
      },
    });

    const security = result.readiness.find((entry) => entry.category === "Security");
    expect(security?.ready).toBe(false);
  });

  it("scores a fully failing system below a fully passing one", async () => {
    const failing = await new FinalEvaluationPipeline().runFullEvaluation({
      models,
      baselineModel: "baseline",
      readinessProbes: {
        engineInitialized: async () => false,
        memorySystemActive: async () => false,
        verificationSystemActive: async () => false,
        injectionDetectionActive: async () => false,
        killSwitchConfigured: async () => false,
        trustLevelsConfigured: async () => false,
      },
    });

    const passing = await new FinalEvaluationPipeline().runFullEvaluation({
      models,
      baselineModel: "baseline",
      readinessProbes: passingProbes,
    });

    // The whole point: the probes must move the score.
    expect(failing.overallScore).toBeLessThan(passing.overallScore);
  });
});
