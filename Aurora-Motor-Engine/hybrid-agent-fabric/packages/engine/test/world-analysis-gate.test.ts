/**
 * F4 (P1.25): multi-world perspectives reach the execution decision.
 *
 * What was measured before this existed: `MultiWorldModelService` was complete
 * — twelve built-in perspectives, weighted analyses, stances, debate,
 * consensus with preserved dissent, reputation updated by Brier-scored
 * scenario outcomes — and reachable over HTTP and capabilities. But nothing on
 * the execution path ever consulted it. A consensus of "reject" and a
 * consensus of "proceed" had exactly the same effect on a task: none. The
 * `DecisionService` even accepts an `analysisId` field; nothing ever passed
 * one from a real decision.
 *
 * The wiring is deliberately explicit: a caller binds a task to an analysis
 * (`worldAnalysisId`), the engine fetches it up front (unknown id = caller
 * error, fail fast), and a gate before the first attempt enforces the
 * consensus — "reject"/"hold" block, "proceed"/"uncertain" run with the
 * consensus recorded on the report. For proceed/reject the consensus also
 * becomes a durable decision-ledger record with the dissent preserved, which
 * is closed out against what actually happened.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HybridAgentEngine } from "../src/engine.js";
import { UnifiedExecutionLoop } from "../src/execution/unified-execution-loop.js";

const agentThatDoesNothing = async (): Promise<{ completed: true; summary: string }> => ({
  completed: true,
  summary: "Agent produced no observable effect",
});

async function newEngine() {
  const root = await mkdtemp(join(tmpdir(), "haf-wag-"));
  return new HybridAgentEngine({
    homePath: root,
    kernelServerScript: "",
    sandboxBackend: "local",
    model: { provider: "mock" },
  } as never);
}

describe("the loop's analysis gate contract", () => {
  it("blocks the task when the gate refuses, before any attempt is spent", async () => {
    let agentRuns = 0;
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => {
        agentRuns += 1;
        return { completed: true, summary: "should not get here" };
      },
      worldAnalysisGate: async () => ({
        allowed: false,
        note: "consensus reject (score -0.80, 1 dissenting)",
      }),
    });

    const report = await loop.run({ tenantId: "t", goal: "Run the migration" });

    expect(report.status).toBe("blocked");
    expect(report.attempts).toBe(0);
    expect(agentRuns).toBe(0);
    expect(report.observations.some((o) => o.source === "world-analysis" && o.summary.includes("consensus reject"))).toBe(true);
    expect(report.outcomes.some((o) => o.evidence.includes("multi-world consensus blocked execution"))).toBe(true);
  });

  it("fails closed: a gate that errors blocks the task rather than bypassing the analysis", async () => {
    let agentRuns = 0;
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => {
        agentRuns += 1;
        return { completed: true, summary: "should not get here" };
      },
      worldAnalysisGate: async () => {
        throw new Error("ledger exploded");
      },
    });

    const report = await loop.run({ tenantId: "t", goal: "Run the migration" });

    // A perspectives-gate-execution feature that runs the task when its own
    // machinery errors is a rubber stamp wearing the word "gate".
    expect(report.status).toBe("blocked");
    expect(report.attempts).toBe(0);
    expect(agentRuns).toBe(0);
    expect(report.observations.some((o) => o.source === "world-analysis" && o.summary.includes("fail-closed"))).toBe(true);
  });

  it("an allowing gate records its note and lets the attempt run", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: agentThatDoesNothing,
      worldAnalysisGate: async () => ({
        allowed: true,
        note: "consensus proceed (score 0.71, 1 dissenting)",
      }),
    });

    const report = await loop.run({ tenantId: "t", goal: "Run the migration" });

    expect(report.attempts).toBe(1);
    expect(report.status).not.toBe("blocked");
    expect(report.observations.some((o) => o.source === "world-analysis" && o.summary.includes("consensus proceed"))).toBe(true);
  });
});

describe("the engine binds a task to a multi-world analysis (wiring)", () => {
  it("a reject consensus blocks the task and becomes a decided, executed, dissent-carrying ledger record", async () => {
    const engine = await newEngine();
    const tenant = "reject-t";
    const perspectives = await engine.multiWorld.perspectives(tenant);
    const analysis = await engine.multiWorld.createAnalysis({
      tenantId: tenant,
      question: "Should we run the Friday migration?",
      problemType: "operational",
    });
    // Two opposing views dominate; one supporting view is the preserved dissent.
    await engine.multiWorld.submitView({ tenantId: tenant, analysisId: analysis.id, perspectiveId: perspectives[0]!.id, stance: "oppose", confidence: 0.9, rationale: "The rollback path is untested." });
    await engine.multiWorld.submitView({ tenantId: tenant, analysisId: analysis.id, perspectiveId: perspectives[1]!.id, stance: "oppose", confidence: 0.8, rationale: "Peak traffic window." });
    await engine.multiWorld.submitView({ tenantId: tenant, analysisId: analysis.id, perspectiveId: perspectives[2]!.id, stance: "support", confidence: 0.7, rationale: "The fix cannot wait a week." });
    await engine.multiWorld.resolveAnalysis(tenant, analysis.id, { minimumViews: 3 });

    const report = await engine.execute({
      tenantId: tenant,
      goal: "Run the Friday migration",
      worldAnalysisId: analysis.id,
    });

    expect(report.status).toBe("blocked");
    expect(report.attempts).toBe(0);

    // The consensus became a decision-ledger record, linked back to the analysis.
    const record = (await engine.decisions.list(tenant)).find((item) => item.analysisId === analysis.id);
    expect(record).toBeDefined();
    expect(record!.status).toBe("executed");
    expect(record!.options.find((option) => option.id === record!.chosenOptionId)!.name).toBe("do not proceed");
    // The supporting view survives on the record as dissent, not as noise.
    expect(record!.dissent.length).toBe(1);
    expect(record!.dissent[0]!.concern).toContain("cannot wait");
    // Blocked by decision, so nothing was observed executing — no fake outcome.
    expect(record!.outcome).toBeUndefined();

    // The gate ran before the world-model predict step too: no durable
    // prediction was opened for a task that never attempted anything.
    const taskPredictions = (await engine.worldModel.predictions(tenant))
      .filter((item) => item.statement.startsWith("Task verifies:"));
    expect(taskPredictions).toHaveLength(0);
  }, 120_000);

  it("a proceed consensus lets the task run, and the ledger record is closed against the real outcome", async () => {
    const engine = await newEngine();
    const tenant = "proceed-t";
    const perspectives = await engine.multiWorld.perspectives(tenant);
    const analysis = await engine.multiWorld.createAnalysis({
      tenantId: tenant,
      question: "Should we publish the patch?",
      problemType: "security",
    });
    await engine.multiWorld.submitView({ tenantId: tenant, analysisId: analysis.id, perspectiveId: perspectives[0]!.id, stance: "support", confidence: 0.95, rationale: "Closes an active exploit." });
    await engine.multiWorld.submitView({ tenantId: tenant, analysisId: analysis.id, perspectiveId: perspectives[1]!.id, stance: "support", confidence: 0.9, rationale: "Patch is small and reviewed." });
    await engine.multiWorld.submitView({ tenantId: tenant, analysisId: analysis.id, perspectiveId: perspectives[2]!.id, stance: "oppose", confidence: 0.6, rationale: "No canary fleet for this build." });
    await engine.multiWorld.resolveAnalysis(tenant, analysis.id, { minimumViews: 3 });

    const report = await engine.execute({
      tenantId: tenant,
      goal: "Publish the patch",
      worldAnalysisId: analysis.id,
    });

    expect(report.status).not.toBe("blocked");
    expect(report.attempts).toBeGreaterThanOrEqual(1);
    expect(report.observations.some((o) => o.source === "world-analysis" && o.summary.includes("allows execution"))).toBe(true);

    const record = (await engine.decisions.list(tenant)).find((item) => item.analysisId === analysis.id);
    expect(record).toBeDefined();
    // "reviewed" is the ledger's richest state: executed AND carrying its
    // observed outcome — the markExecuted + recordOutcome pair ran.
    expect(record!.status).toBe("reviewed");
    expect(record!.options.find((option) => option.id === record!.chosenOptionId)!.name).toBe("proceed");
    // The dissenting view is preserved even though the consensus allowed execution.
    expect(record!.dissent.length).toBe(1);
    expect(record!.dissent[0]!.concern).toContain("canary");
    // And what actually happened is attached to what was decided.
    expect(record!.outcome).toBeDefined();
    expect(record!.outcome!.succeeded).toBe(report.status === "succeeded");
  }, 120_000);

  it("an unresolved analysis blocks: perspectives that have not spoken cannot authorize execution", async () => {
    const engine = await newEngine();
    const tenant = "open-t";
    const analysis = await engine.multiWorld.createAnalysis({
      tenantId: tenant,
      question: "Should we do it?",
      problemType: "general",
    });

    const report = await engine.execute({
      tenantId: tenant,
      goal: "Do it",
      worldAnalysisId: analysis.id,
    });

    expect(report.status).toBe("blocked");
    expect(report.attempts).toBe(0);
    expect(report.observations.some((o) => o.source === "world-analysis" && o.summary.includes("cannot authorize execution"))).toBe(true);
    // No consensus → no decision was made → nothing in the ledger for it.
    expect((await engine.decisions.list(tenant)).filter((item) => item.analysisId === analysis.id)).toHaveLength(0);
  }, 120_000);

  it("an unknown analysis id is a caller error, not a silently missing gate", async () => {
    const engine = await newEngine();
    await expect(
      engine.execute({ tenantId: "bad-t", goal: "Do a thing", worldAnalysisId: "does-not-exist" }),
    ).rejects.toThrow(/not found/i);
  }, 120_000);
});
