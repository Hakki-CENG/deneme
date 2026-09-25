/**
 * B4: the runtime walks the plan.
 *
 * The measurement this file exists to overturn. A three-step chain
 * (`a → b → c`) under the previous walk:
 *
 *     wave1 ready:   a
 *     after wave 1:  a=unverified  b=not_implemented  c=not_implemented
 *     next ready:    (none)
 *
 * The agent had completed the goal, and two thirds of its own plan were never
 * attempted — not `blocked` (nothing failed), just never reached, because
 * `readySteps()` gates on `isSuccess` and an `unverified` step is not one.
 */
import { describe, expect, it } from "vitest";

import {
  advancePlan,
  nextSteps,
  pendingSteps,
  plannedWaves,
  prerequisiteAllowsDependants,
  walkComplete,
} from "../src/execution/plan-execution.js";
import { blockUnreachable, buildPlan } from "../src/execution/plan-progress.js";
import { UnifiedExecutionLoop } from "../src/execution/unified-execution-loop.js";
import { formalVerifier } from "../src/execution/verification-factory.js";
import type { TaskPlan } from "../src/execution/task-context.js";

const goal = "Ship the changelog automation";

function chain(): TaskPlan {
  return buildPlan([
    { id: "a", description: "read the changelog", dependencies: [] },
    { id: "b", description: "summarise it", dependencies: ["a"] },
    { id: "c", description: "post the summary", dependencies: ["b"] },
  ]);
}

const ran = { attempt: 1, completed: true, summary: "did work", durationMs: 42 };

describe("what lets a dependant start", () => {
  it("accepts a verified or plainly executed prerequisite", () => {
    expect(prerequisiteAllowsDependants("succeeded")).toBe(true);
    expect(prerequisiteAllowsDependants("executed")).toBe(true);
  });

  it("accepts an unverified prerequisite by default, because the alternative stalls the plan", () => {
    // Not a softening of execution-status.ts: the *task* still cannot be
    // `succeeded` on unverified work. This only decides whether the next step
    // may start, and refusing to start it does not make the first one checked.
    expect(prerequisiteAllowsDependants("unverified")).toBe(true);
    expect(prerequisiteAllowsDependants("unverified", { unverifiedSatisfiesDependency: false })).toBe(false);
  });

  it("refuses everything that did not actually happen", () => {
    for (const status of ["failed", "blocked", "skipped", "unavailable", "not_implemented", "timed_out", "cancelled", "simulated"] as const) {
      expect(prerequisiteAllowsDependants(status), status).toBe(false);
    }
  });
});

describe("the walk gets past wave 1", () => {
  it("runs the whole chain when each wave completes unverified", () => {
    const plan = chain();
    expect(nextSteps(plan).map((step) => step.id)).toEqual(["a"]);

    // Wave 1.
    for (const mark of advancePlan(plan, ran)) {
      plan.steps.find((step) => step.id === mark.id)!.status = mark.status;
    }
    expect(plan.steps.map((step) => step.status)).toEqual(["unverified", "not_implemented", "not_implemented"]);

    // Wave 2 is now reachable — the thing the old walk could never do.
    expect(nextSteps(plan).map((step) => step.id)).toEqual(["b"]);
    for (const mark of advancePlan(plan, { ...ran, attempt: 2 })) {
      plan.steps.find((step) => step.id === mark.id)!.status = mark.status;
    }
    expect(nextSteps(plan).map((step) => step.id)).toEqual(["c"]);

    for (const mark of advancePlan(plan, { ...ran, attempt: 3 })) {
      plan.steps.find((step) => step.id === mark.id)!.status = mark.status;
    }
    expect(walkComplete(plan)).toBe(true);
    expect(pendingSteps(plan)).toEqual([]);
  });

  it("runs independent steps in the same wave", () => {
    const plan = buildPlan([
      { id: "a", description: "a", dependencies: [] },
      { id: "b", description: "b", dependencies: [] },
      { id: "c", description: "c", dependencies: ["a", "b"] },
    ]);
    expect(nextSteps(plan).map((step) => step.id)).toEqual(["a", "b"]);
    expect(plannedWaves(plan)).toEqual([["a", "b"], ["c"]]);
  });

  it("does not treat an unknown prerequisite as satisfied", () => {
    const plan = buildPlan([{ id: "a", description: "a", dependencies: ["ghost"] }]);
    expect(nextSteps(plan)).toEqual([]);
  });
});

describe("what one run means for the plan", () => {
  it("marks only the steps that were ready when the agent reports nothing per step", () => {
    const plan = chain();
    const marks = advancePlan(plan, ran);

    // `b` and `c` are not touched: claiming they ran would be inventing
    // progress, and leaving them is what lets the next attempt pick them up.
    expect(marks.map((mark) => mark.id)).toEqual(["a"]);
    expect(marks[0]?.status).toBe("unverified");
    expect(marks[0]?.evidence.attempt).toBe(1);
    expect(marks[0]?.evidence.durationMs).toBe(42);
  });

  it("marks the ready steps failed when the run failed", () => {
    const plan = chain();
    const marks = advancePlan(plan, {
      attempt: 1,
      completed: false,
      summary: "the fetch threw",
      error: "ECONNREFUSED",
    });
    expect(marks.map((mark) => [mark.id, mark.status])).toEqual([["a", "failed"]]);
    expect(marks[0]?.evidence.error).toBe("ECONNREFUSED");
  });

  it("uses the adapter's per-step attribution when it can give any", () => {
    const plan = chain();
    const marks = advancePlan(plan, {
      ...ran,
      stepResults: [
        { id: "a", status: "succeeded", detail: "read 40 entries" },
        { id: "b", status: "failed", detail: "no summary template" },
      ],
    });
    expect(marks.map((mark) => [mark.id, mark.status])).toEqual([
      ["a", "succeeded"],
      ["b", "failed"],
    ]);
    expect(marks[0]?.evidence.detail).toBe("read 40 entries");
  });

  it("drops an attributed id the plan does not contain instead of inventing a step", () => {
    const plan = chain();
    const marks = advancePlan(plan, {
      ...ran,
      stepResults: [{ id: "nope", status: "succeeded" }],
    });
    expect(marks).toEqual([]);
  });

  it("returns nothing when no step can start, rather than marking something arbitrary", () => {
    const plan = chain();
    plan.steps[0]!.status = "failed";
    expect(advancePlan(plan, ran)).toEqual([]);
  });
});

describe("a failed step still blocks what depends on it", () => {
  it("blocks dependants and calls them blocked, not failed", () => {
    const plan = chain();
    for (const mark of advancePlan(plan, { attempt: 1, completed: false, summary: "no", error: "boom" })) {
      plan.steps.find((step) => step.id === mark.id)!.status = mark.status;
    }
    blockUnreachable(plan);

    expect(plan.steps.map((step) => step.status)).toEqual(["failed", "blocked", "blocked"]);
    expect(nextSteps(plan)).toEqual([]);
  });
});

describe("the loop really walks the plan", () => {
  it("attempts every step of a chain, not just the first wave", async () => {
    // The regression this pins: under the old walk `b` and `c` stayed
    // `not_implemented` forever and the report read "3 step(s), 2 not
    // attempted" for a task the agent had completed.
    let agentCalls = 0;
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => {
        agentCalls += 1;
        return { completed: true, summary: "did the thing" };
      },
      plan: async () => [
        { id: "a", description: "read the changelog", dependencies: [] },
        { id: "b", description: "summarise it", dependencies: ["a"] },
        { id: "c", description: "post the summary", dependencies: ["b"] },
      ],
    });

    const report = await loop.run({ tenantId: "local", goal });
    const steps = report.plan?.steps ?? [];

    expect(steps).toHaveLength(3);
    // Nothing was left unattempted, which is the whole point.
    expect(steps.map((step) => step.status)).not.toContain("not_implemented");
    expect(steps.every((step) => (step.attempts ?? 0) >= 1)).toBe(true);
    // And it took more than one pass to get there.
    expect(agentCalls).toBeGreaterThan(1);
    // Each step carries the record behind its status.
    for (const step of steps) {
      expect(step.evidence?.attempt).toBeGreaterThanOrEqual(1);
      expect(step.evidence?.at).toBeTruthy();
    }
  });

  it("keeps an unverified walk from being reported as success", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "did the thing" }),
      plan: async () => [
        { id: "a", description: "one", dependencies: [] },
        { id: "b", description: "two", dependencies: ["a"] },
      ],
    });

    const report = await loop.run({ tenantId: "local", goal });

    // Every step ran, and the task is still not `succeeded`: walking the plan
    // is not the same as verifying it.
    expect(report.plan?.steps.every((step) => step.status === "unverified")).toBe(true);
    expect(report.status).not.toBe("succeeded");
  });

  it("stops at once when a verifier passes, even with plan steps left", async () => {
    // The regression this pins: an earlier version of B4 kept walking after a
    // `pass`, and the extra attempts went through recovery and turned
    // `succeeded` into `failed` in `engine-execute-integration.test.ts`. The
    // caller's acceptance criterion decides when the task is over; Aurora's own
    // decomposition does not get to spend budget on top of it.
    let agentCalls = 0;
    const loopWithVerifier = new UnifiedExecutionLoop({
      runAgent: async () => {
        agentCalls += 1;
        return { completed: true, summary: "did the thing" };
      },
      plan: async () => [
        { id: "a", description: "one", dependencies: [] },
        { id: "b", description: "two", dependencies: ["a"] },
        { id: "c", description: "three", dependencies: ["b"] },
      ],
      verifiersFor: async () => [
        formalVerifier("acceptance", async () => ({ ok: true, output: "acceptance check passed" })),
      ],
    });

    const report = await loopWithVerifier.run({ tenantId: "local", goal });

    expect(report.status).toBe("succeeded");
    expect(agentCalls).toBe(1);
    // And the report says plainly that the plan was not walked to the end,
    // rather than implying it was.
    expect(report.plan?.steps.some((step) => step.status === "not_implemented")).toBe(true);
  });

  it("stops the walk when a step fails and reports the rest as blocked", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: false, summary: "the fetch threw", error: "ECONNREFUSED" }),
      plan: async () => [
        { id: "a", description: "read the changelog", dependencies: [] },
        { id: "b", description: "summarise it", dependencies: ["a"] },
      ],
      // Do not let recovery manufacture attempts; this test is about the walk.
      maxAttempts: 1,
    });

    const report = await loop.run({ tenantId: "local", goal });
    const byId = new Map((report.plan?.steps ?? []).map((step) => [step.id, step]));

    expect(byId.get("a")?.status).toBe("failed");
    expect(byId.get("b")?.status).toBe("blocked");
    expect(byId.get("b")?.evidence).toBeUndefined();
  });
});
