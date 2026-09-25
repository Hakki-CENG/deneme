/**
 * F3 + F2 (P1.23 + the learning signal of P1.24): predict → act → observe →
 * compare → surprise → update — made durable and learned.
 *
 * What was measured before this existed:
 *
 *  - The predict/record pair around the agent was wired, but everything it
 *    learned lived in the in-memory exploration pipeline: a restart erased it,
 *    and the surprise it computed changed no future behaviour.
 *  - The durable `WorldModelService` prediction machinery (Brier loss,
 *    calibration curves, causal feedback) was reachable only through
 *    capabilities and HTTP. The task loop never fed it, so on the real
 *    execution path calibration was permanently empty.
 *  - The prediction prior was a fixed heuristic (0.5 + planned + verifiers)
 *    that no amount of experience could move — P1.23's "caller-provided
 *    heuristic" in its purest form.
 *
 * The fix is a bridge, not a second system: the same adapter that already
 * predicted and recorded now (1) opens ONE durable prediction per task on the
 * first attempt and resolves it with the verified outcome, and (2) blends the
 * prior toward the tenant's measured base rate once enough resolved
 * predictions exist. Thin evidence is ignored, and the basis string says
 * which regime the confidence came from.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AuroraCognitiveRuntime } from "../src/aurora/cognitive-runtime.js";
import { HybridAgentEngine } from "../src/engine.js";
import { empiricalVerifier } from "../src/execution/verification-factory.js";

async function newEngine() {
  const root = await mkdtemp(join(tmpdir(), "haf-wmp-"));
  return new HybridAgentEngine({
    homePath: root,
    kernelServerScript: "",
    sandboxBackend: "local",
    model: { provider: "mock" },
  } as never);
}

describe("the prediction prior (F2: heuristic → learned)", () => {
  it("stays the uninformed heuristic when there is no evidence, and says so", async () => {
    const runtime = new AuroraCognitiveRuntime();
    const prediction = await runtime.predictStep({
      goal: "g", attempt: 1, planned: true, hasVerifiers: true,
    });
    expect(prediction.confidence).toBeCloseTo(0.75, 10);
    expect(prediction.basis).toContain("uninformed heuristic");
  });

  it("ignores thin evidence: four resolved predictions are an anecdote", async () => {
    const runtime = new AuroraCognitiveRuntime();
    const prediction = await runtime.predictStep({
      goal: "g", attempt: 1, planned: true, hasVerifiers: true,
      measuredBaseRate: { resolved: 4, successRate: 0.1 },
    });
    // A base rate of 0.1 over four samples must not move the prior: learning
    // the shape of noise is not learning.
    expect(prediction.confidence).toBeCloseTo(0.75, 10);
    expect(prediction.basis).toContain("uninformed heuristic");
  });

  it("blends toward the measured base rate once evidence exists", async () => {
    const runtime = new AuroraCognitiveRuntime();
    // Blend weight 5/20 = 0.25 → 0.75 × 0.75 + 0.4 × 0.25 = 0.6625.
    const prediction = await runtime.predictStep({
      goal: "g", attempt: 1, planned: true, hasVerifiers: true,
      measuredBaseRate: { resolved: 5, successRate: 0.4 },
    });
    expect(prediction.confidence).toBeCloseTo(0.6625, 10);
    expect(prediction.basis).toContain("learned");
    expect(prediction.basis).toContain("5");
  });

  it("is the base rate outright at full evidence", async () => {
    const runtime = new AuroraCognitiveRuntime();
    const prediction = await runtime.predictStep({
      goal: "g", attempt: 1, planned: true, hasVerifiers: true,
      measuredBaseRate: { resolved: 20, successRate: 0.9 },
    });
    expect(prediction.confidence).toBeCloseTo(0.9, 10);
  });
});

describe("the real execution path feeds the durable world model (F3)", () => {
  it("opens one durable prediction per task — across retries — and resolves it with the verified outcome", async () => {
    const engine = await newEngine();
    let verifierCalls = 0;
    const report = await engine.execute({
      tenantId: "retry-t",
      goal: "Ship the release",
      maxAttempts: 2,
      verifiers: [
        empiricalVerifier("flaky", async () => {
          verifierCalls += 1;
          // "test run failed" classifies as execution_failure → retry, so the
          // loop really makes a second attempt with the same verifier.
          return verifierCalls === 1
            ? { passed: 0, failed: 2, output: "test run failed on the first pass" }
            : { passed: 2, failed: 0, output: "test run passed" };
        }),
      ],
    });

    // The retry actually happened: the flaky verifier saw both attempts.
    expect(verifierCalls).toBe(2);

    const taskPredictions = (await engine.worldModel.predictions("retry-t"))
      .filter((item) => item.statement.startsWith("Task verifies:"));
    // Exactly ONE durable prediction despite two attempts: the claim being
    // scored is "this task verifies", not "attempt N verifies".
    expect(taskPredictions).toHaveLength(1);
    const ours = taskPredictions[0]!;
    expect(ours.status).toBe("resolved");
    expect(ours.outcome).toBe(report.status === "succeeded");
    expect(ours.brierScore).toBeCloseTo(
      (ours.probability - (report.status === "succeeded" ? 1 : 0)) ** 2,
      10,
    );

    // The calibration curve — empty on this path before — now has a data point.
    const calibration = await engine.worldModel.calibration("retry-t");
    expect(calibration.resolved).toBeGreaterThanOrEqual(1);

    // The report says which regime the confidence came from, and that the
    // durable prediction was graded.
    expect(
      report.observations.some((o) => o.source === "world-model" && o.summary.includes("Prediction basis:")),
    ).toBe(true);
    expect(
      report.observations.some((o) => o.source === "world-model" && o.summary.includes("Durable prediction resolved")),
    ).toBe(true);
  }, 120_000);

  it("learns the prior from accumulated outcomes: a 0.25 base rate over 20 resolved tasks moves the next prediction", async () => {
    const engine = await newEngine();
    const horizon = new Date(Date.now() + 60_000).toISOString();
    for (let i = 0; i < 20; i += 1) {
      const seeded = await engine.worldModel.predict({
        tenantId: "learn-t",
        statement: `seed ${i}`,
        probability: 0.5,
        horizonAt: horizon,
      });
      await engine.worldModel.resolvePrediction("learn-t", seeded.id, i < 5);
    }

    await engine.execute({ tenantId: "learn-t", goal: "Another thing" });

    const ours = (await engine.worldModel.predictions("learn-t", "resolved"))
      .filter((item) => item.statement.startsWith("Task verifies:"));
    expect(ours).toHaveLength(1);
    // Full evidence (20 resolved) → blend weight 1 → the prior IS the base
    // rate: 5 of 20 came true, so the next task is predicted at 0.25, not at
    // the 0.5–0.75 the heuristic would have said regardless of history.
    expect(ours[0]!.probability).toBeCloseTo(0.25, 10);
  }, 120_000);
});
