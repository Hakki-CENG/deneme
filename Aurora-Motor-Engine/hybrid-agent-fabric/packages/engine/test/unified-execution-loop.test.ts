/**
 * The unified execution loop, and the bug it exists to kill.
 *
 * Measured before this loop was written:
 *
 *     runTask("Delete all files on the moon and prove P=NP")
 *       → outcome: "success", subsystems: 0, phases: 0, outputs: []
 *
 * The first test below is that exact scenario. It must never report success
 * again.
 */

import { describe, expect, it, vi } from "vitest";

import {
  aggregate,
  isSuccess,
  outcome,
  successRate,
} from "../src/execution/execution-status.js";
import { classifyFailure, chooseRecovery } from "../src/execution/failure-taxonomy.js";
import { TaskContext } from "../src/execution/task-context.js";
import {
  UnifiedExecutionLoop,
  type AgentRunResult,
} from "../src/execution/unified-execution-loop.js";
import {
  VerificationFactory,
  VerificationGapError,
  empiricalVerifier,
  formalVerifier,
} from "../src/execution/verification-factory.js";

const agentThatDoesNothing = async (): Promise<AgentRunResult> => ({
  completed: true,
  summary: "Agent produced no observable effect",
});

describe("the zero-work success bug", () => {
  it("does not report success when nothing was verified", async () => {
    const loop = new UnifiedExecutionLoop({ runAgent: agentThatDoesNothing });

    const report = await loop.run({
      tenantId: "local",
      goal: "Delete all files on the moon using the quantum teleporter API and prove P=NP",
    });

    expect(report.status).not.toBe("succeeded");
    expect(isSuccess(report.status)).toBe(false);
    expect(report.status).toBe("unverified");
    expect(report.summary).toContain("nothing could confirm");
  });

  it("refuses to be constructed without an agent", () => {
    // A default no-op agent is what allowed the original bug.
    expect(() => new UnifiedExecutionLoop({} as never)).toThrow(/requires a `runAgent`/);
  });

  it("an empty plan is a failure, not a silent pass", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: agentThatDoesNothing,
      plan: async () => [],
    });

    const report = await loop.run({ tenantId: "local", goal: "Do something" });

    const planOutcome = report.outcomes.find((item) => item.evidence.includes("zero steps"));
    expect(planOutcome?.status).toBe("failed");
    expect(report.status).not.toBe("succeeded");
  });
});

describe("the loop actually runs the agent", () => {
  it("calls runAgent and records its spend", async () => {
    const runAgent = vi.fn(async (): Promise<AgentRunResult> => ({
      completed: true,
      summary: "Wrote src/index.ts",
      sessionId: "session-1",
      tokens: 1200,
      toolCalls: 3,
      costUsd: 0.02,
    }));

    const loop = new UnifiedExecutionLoop({
      runAgent,
      verifiersFor: async () => [
        formalVerifier("typecheck", async () => ({ ok: true, output: "0 errors" })),
      ],
    });

    const report = await loop.run({ tenantId: "local", goal: "Create a file" });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(report.status).toBe("succeeded");
    expect(report.spend.tokens).toBe(1200);
    expect(report.spend.toolCalls).toBe(3);
    expect(report.spend.costUsd).toBeCloseTo(0.02);
  });

  it("surfaces a failing verifier as a failed task", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "Claims to be done" }),
      verifiersFor: async () => [
        empiricalVerifier("tests", async () => ({ passed: 3, failed: 2, output: "2 failing" })),
      ],
    });

    const report = await loop.run({ tenantId: "local", goal: "Fix the bug" });

    expect(report.status).toBe("failed");
    expect(report.verification?.verdict).toBe("fail");
  });
});

describe("recovery is bounded and classified", () => {
  it("retries, classifies the failure, then stops at the attempt limit", async () => {
    const runAgent = vi.fn(async (): Promise<AgentRunResult> => ({
      completed: false,
      summary: "Tool missing",
      error: "Error: no such tool 'visual_diff'",
    }));

    const loop = new UnifiedExecutionLoop({ runAgent }, { maxAttempts: 3 });
    const report = await loop.run({ tenantId: "local", goal: "Compare screenshots" });

    expect(report.status).not.toBe("succeeded");
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures[0]?.classification.kind).toBe("tool_gap");
    expect(report.failures[0]?.recovery.strategy).toBe("acquire_capability");
    // Bounded: it must not loop forever.
    expect(runAgent.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("never auto-retries a security block", async () => {
    const runAgent = vi.fn(async (): Promise<AgentRunResult> => ({
      completed: false,
      summary: "Refused",
      error: "Action blocked by policy: kill switch engaged",
    }));

    const loop = new UnifiedExecutionLoop({ runAgent }, { maxAttempts: 5 });
    const report = await loop.run({ tenantId: "local", goal: "Delete production" });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(report.failures[0]?.recovery.strategy).toBe("abort");
    expect(report.failures[0]?.recovery.canContinue).toBe(false);
  });
});

describe("task contexts are isolated from each other", () => {
  it("two concurrent tasks do not share phase or spend", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async (context) => {
        context.spendTokens(context.goal.length);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { completed: true, summary: `Ran ${context.goal}` };
      },
    });

    const [a, b] = await Promise.all([
      loop.run({ tenantId: "t", goal: "AAAA" }),
      loop.run({ tenantId: "t", goal: "BBBBBBBBBB" }),
    ]);

    expect(a.taskId).not.toBe(b.taskId);
    expect(a.spend.tokens).toBe(4);
    expect(b.spend.tokens).toBe(10);
  });

  it("gives each task its own trace and correlation id", () => {
    const first = new TaskContext({ tenantId: "t", goal: "one" });
    const second = new TaskContext({ tenantId: "t", goal: "two" });

    expect(first.traceId).not.toBe(second.traceId);
    first.enterPhase("planning", "test");
    expect(first.phase).toBe("planning");
    expect(second.phase).toBe("observing");
  });
});

describe("budgets stop the loop", () => {
  it("blocks when the recovery budget is spent", async () => {
    const loop = new UnifiedExecutionLoop(
      { runAgent: async () => ({ completed: false, summary: "nope", error: "exit code 1" }) },
      { maxAttempts: 2 },
    );

    const report = await loop.run({
      tenantId: "t",
      goal: "Impossible",
      budget: { maxRecoveryAttempts: 1 },
    });

    expect(["failed", "blocked"]).toContain(report.status);
    expect(report.attempts).toBeLessThanOrEqual(2);
  });
});

describe("status vocabulary", () => {
  it("treats only `succeeded` as success", () => {
    expect(isSuccess("succeeded")).toBe(true);
    for (const status of ["executed", "skipped", "unavailable", "simulated", "unverified"] as const) {
      expect(isSuccess(status)).toBe(false);
    }
  });

  it("aggregates an empty list as skipped, never succeeded", () => {
    expect(aggregate([])).toBe("skipped");
  });

  it("does not let unverified work aggregate to success", () => {
    const result = aggregate([
      outcome("succeeded", "verified"),
      outcome("unverified", "nothing checked this"),
    ]);
    expect(result).toBe("unverified");
  });

  it("excludes absent work from the success rate instead of counting it", () => {
    const rate = successRate([
      outcome("succeeded", "ok"),
      outcome("unavailable", "no backend"),
      outcome("skipped", "n/a"),
    ]);

    expect(rate.succeeded).toBe(1);
    expect(rate.measured).toBe(1);
    expect(rate.absent).toBe(2);
    expect(rate.rate).toBe(1);
    expect(rate.note).toContain("excluded as absent");
  });

  it("reports a rate of zero, with a note, when nothing was measurable", () => {
    const rate = successRate([outcome("unavailable", "a"), outcome("blocked", "b")]);
    expect(rate.rate).toBe(0);
    expect(rate.note).toContain("No work was measured");
  });

  it("requires evidence for every outcome", () => {
    expect(() => outcome("succeeded", "   ")).toThrow(/needs evidence/);
  });
});

describe("verification factory", () => {
  it("returns uncertain, not pass, when no verifier is registered", async () => {
    const report = await new VerificationFactory().verify("the work is done");
    expect(report.verdict).toBe("uncertain");
    expect(report.status).toBe("unverified");
  });

  it("treats a throwing verifier as uncertain rather than passing", async () => {
    const factory = new VerificationFactory().register({
      name: "broken",
      tier: "V1_formal",
      run: async () => {
        throw new Error("verifier itself crashed");
      },
    });

    const report = await factory.verify("claim");
    expect(report.verdict).toBe("uncertain");
    expect(report.results[0]?.evidence).toContain("crashed");
  });

  it("treats an empty test run as uncertain, not a pass", async () => {
    const factory = new VerificationFactory().register(
      empiricalVerifier("tests", async () => ({ passed: 0, failed: 0, output: "no tests found" })),
    );

    const report = await factory.verify("tests pass");
    expect(report.verdict).toBe("uncertain");
  });

  it("throws VerificationGapError when asked to guarantee an unverifiable claim", async () => {
    const factory = new VerificationFactory();
    await expect(factory.verifyOrThrow("it works")).rejects.toThrow(VerificationGapError);
  });

  it("lets a formal failure override a consensus pass", async () => {
    const factory = new VerificationFactory()
      .register(formalVerifier("typecheck", async () => ({ ok: false, output: "TS2345" })))
      .register({
        name: "model-a",
        tier: "V3_consensus",
        run: async () => ({ verdict: "pass" as const, evidence: "looks right", confidence: 0.7 }),
      });

    const report = await factory.verify("compiles");
    expect(report.verdict).toBe("fail");
    expect(report.strongestTier).toBe("V1_formal");
  });

  it("requires approval for consensus-only verdicts", async () => {
    const factory = new VerificationFactory()
      .register({
        name: "model-a",
        tier: "V3_consensus",
        run: async () => ({ verdict: "pass" as const, evidence: "ok", confidence: 0.6 }),
      })
      .register({
        name: "model-b",
        tier: "V3_consensus",
        run: async () => ({ verdict: "pass" as const, evidence: "ok", confidence: 0.6 }),
      });

    const report = await factory.verify("prose is good");
    expect(report.verdict).toBe("pass");
    expect(report.autonomy).toBe("controlled");
  });
});

describe("failure classification drives recovery", () => {
  it("routes a missing tool to capability acquisition, not retry", () => {
    const classification = classifyFailure("Error: no such tool 'visual_diff'");
    expect(classification.kind).toBe("tool_gap");

    const recovery = chooseRecovery(classification, { attemptsUsed: 0, maxAttempts: 3 });
    expect(recovery.strategy).toBe("acquire_capability");
  });

  it("routes a timeout to scope reduction rather than an identical retry", () => {
    const recovery = chooseRecovery(classifyFailure("operation timed out after 30000ms"), {
      attemptsUsed: 1,
      maxAttempts: 3,
    });
    expect(recovery.strategy).toBe("reduce_scope");
  });

  it("aborts on resource exhaustion instead of spending more", () => {
    const recovery = chooseRecovery(classifyFailure("token budget exhausted"), {
      attemptsUsed: 0,
      maxAttempts: 3,
    });
    expect(recovery.strategy).toBe("abort");
    expect(recovery.canContinue).toBe(false);
  });

  it("admits when it cannot classify rather than guessing", () => {
    const classification = classifyFailure("wobble");
    expect(classification.kind).toBe("fundamental_unknown");
    expect(classification.confidence).toBeLessThan(0.5);

    const recovery = chooseRecovery(classification, { attemptsUsed: 0, maxAttempts: 3 });
    expect(recovery.strategy).toBe("ask_human");
  });

  it("escalates to a skill gap when the same unknown error repeats", () => {
    const classification = classifyFailure("wobble", { attemptCount: 3 });
    expect(classification.kind).toBe("skill_gap");
  });
});

describe("plan steps in the report", () => {
  /**
   * These pin the fix for a field that existed but carried no information.
   *
   * `TaskReport.plan` shipped with every step hard-coded to `"skipped"`, so a
   * fully executed plan and a plan that never started produced byte-identical
   * output. Anyone reading a report to find out which step went wrong learned
   * nothing from it.
   */
  const goal = "Fetch the changelog and summarise it";

  it("no longer reports every step as skipped", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: agentThatDoesNothing,
      plan: async () => ["fetch the changelog", "summarise it"],
    });

    const report = await loop.run({ tenantId: "local", goal });

    expect(report.plan?.steps).toHaveLength(2);
    for (const step of report.plan?.steps ?? []) {
      expect(step.status).not.toBe("skipped");
    }
  });

  it("marks steps unverified when the agent cannot attribute work to them", async () => {
    // The agent is handed the whole goal and reports once. Work happened, but
    // nothing proved it was *this* step's work, so `succeeded` would claim
    // more than is known — that inference is what produced "10/10, score 1.0"
    // from an agent that never ran.
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "Did the thing" }),
      plan: async () => ["fetch the changelog"],
    });

    const report = await loop.run({ tenantId: "local", goal });

    expect(report.plan?.steps[0]?.status).toBe("unverified");
    // The wording changed with B4 ("Ran during this attempt; nothing could
    // confirm the result for this step"); the claim it has to keep making is
    // that the step ran and nothing checked it.
    expect(report.plan?.steps[0]?.detail).toContain("nothing could confirm");

    // B4: the status now carries the record behind it, not just a label.
    const evidence = report.plan?.steps[0]?.evidence;
    expect(evidence?.attempt).toBe(1);
    expect(evidence?.at).toBeTruthy();
    expect(report.plan?.steps[0]?.attempts).toBe(1);
  });

  it("uses per-step outcomes when the adapter reports them", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({
        completed: true,
        summary: "Fetched, then failed to summarise",
        stepResults: [
          { id: "s1", status: "succeeded" as const, detail: "200 OK" },
          { id: "s2", status: "failed" as const, detail: "empty body" },
        ],
      }),
      plan: async () => ["fetch the changelog", "summarise it"],
    });

    const report = await loop.run({ tenantId: "local", goal });

    expect(report.plan?.steps[0]?.status).toBe("succeeded");
    expect(report.plan?.steps[0]?.detail).toBe("200 OK");
    expect(report.plan?.steps[1]?.status).toBe("failed");
  });

  it("blocks a step whose dependency failed instead of failing it", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({
        completed: false,
        summary: "fetch failed",
        stepResults: [{ id: "fetch", status: "failed" as const, detail: "network down" }],
      }),
      plan: async () => [
        { description: "fetch the changelog", id: "fetch" },
        { description: "summarise it", id: "summarise", dependencies: ["fetch"] },
      ],
    });

    const report = await loop.run({ tenantId: "local", goal });
    const summarise = report.plan?.steps.find((s) => s.id === "summarise");

    expect(summarise?.status).toBe("blocked");
    expect(summarise?.status).not.toBe("failed");
    expect(summarise?.detail).toContain("fetch");
  });

  it("carries planner dependency edges into the report", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: agentThatDoesNothing,
      plan: async () => [
        { description: "fetch", id: "fetch" },
        { description: "summarise", id: "summarise", dependencies: ["fetch"] },
      ],
    });

    const report = await loop.run({ tenantId: "local", goal });

    expect(report.plan?.steps[1]?.dependencies).toEqual(["fetch"]);
  });

  it("fails planning when the plan has a dependency cycle", async () => {
    // No step in a cycle can ever become ready, so reporting a usable plan
    // would hand the agent something guaranteed to stall.
    const loop = new UnifiedExecutionLoop({
      runAgent: agentThatDoesNothing,
      plan: async () => [
        { description: "a", id: "a", dependencies: ["b"] },
        { description: "b", id: "b", dependencies: ["a"] },
      ],
    });

    const report = await loop.run({ tenantId: "local", goal });
    const planning = report.outcomes.filter((o) => o.evidence.includes("cycle"));

    expect(planning).toHaveLength(1);
    expect(planning[0]?.status).toBe("failed");
  });

  it("fails planning when a dependency names a step that does not exist", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: agentThatDoesNothing,
      plan: async () => [{ description: "build", id: "build", dependencies: ["ghost"] }],
    });

    const report = await loop.run({ tenantId: "local", goal });
    const planning = report.outcomes.filter((o) => o.evidence.includes("unknown steps"));

    expect(planning).toHaveLength(1);
    expect(planning[0]?.status).toBe("failed");
  });

  it("still treats an empty plan as a planning failure", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: agentThatDoesNothing,
      plan: async () => [],
    });

    const report = await loop.run({ tenantId: "local", goal });

    expect(report.outcomes.some((o) => o.evidence.includes("zero steps"))).toBe(true);
  });

  it("puts plan progress in the human-readable summary", async () => {
    // A report that says "succeeded" while steps were never reached is true
    // about the goal and misleading about the work.
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({
        completed: false,
        summary: "fetch failed",
        stepResults: [{ id: "fetch", status: "failed" as const }],
      }),
      plan: async () => [
        { description: "fetch", id: "fetch" },
        { description: "summarise", id: "summarise", dependencies: ["fetch"] },
      ],
    });

    const report = await loop.run({ tenantId: "local", goal });

    expect(report.summary).toContain("Plan:");
    expect(report.summary).toContain("blocked");
  });
});
