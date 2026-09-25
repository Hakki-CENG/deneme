/**
 * Plan steps must carry real status and real edges.
 *
 * `TaskReport.plan` existed long before this test did, and it was useless: the
 * loop built every step with a hard-coded `status: "skipped"` and never touched
 * it again. A plan whose every step succeeded serialized identically to a plan
 * that was never started. The field was present; the field meant nothing.
 *
 * These tests pin the two distinctions that make it mean something:
 *   - `not_implemented` (nobody tried) vs `skipped` (someone decided)
 *   - `blocked` (prerequisite failed) vs `failed` (this step failed)
 */
import { describe, it, expect } from "vitest";

import {
  blockUnreachable,
  buildPlan,
  cyclicSteps,
  markStep,
  planSummary,
  readySteps,
  stepId,
  unresolvedDependencies,
} from "../src/execution/plan-progress.js";

describe("buildPlan", () => {
  it("accepts bare strings and produces a dependency-free plan", () => {
    // A planner that only emits descriptions must not have edges invented for
    // it. No edges is honest; guessed edges are not.
    const plan = buildPlan(["read the file", "summarise it"]);

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.id).toBe("s1");
    expect(plan.steps[0]?.dependencies).toEqual([]);
    expect(plan.steps[1]?.dependencies).toEqual([]);
  });

  it("starts every step as not_implemented, never as skipped", () => {
    // The distinction this whole module exists for. `skipped` is a decision;
    // an untouched step has not been decided about.
    const plan = buildPlan(["a", "b", "c"]);

    for (const step of plan.steps) {
      expect(step.status).toBe("not_implemented");
      expect(step.status).not.toBe("skipped");
    }
  });

  it("preserves dependency edges the planner computed", () => {
    const plan = buildPlan([
      { description: "fetch", id: "fetch" },
      { description: "parse", id: "parse", dependencies: ["fetch"] },
      { description: "report", id: "report", dependencies: ["parse"] },
    ]);

    expect(plan.steps[1]?.dependencies).toEqual(["fetch"]);
    expect(plan.steps[2]?.dependencies).toEqual(["parse"]);
  });

  it("drops a self-dependency rather than deadlocking on it", () => {
    const plan = buildPlan([{ description: "loop", id: "x", dependencies: ["x"] }]);
    expect(plan.steps[0]?.dependencies).toEqual([]);
    expect(readySteps(plan)).toHaveLength(1);
  });

  it("generates positional ids matching stepId", () => {
    const plan = buildPlan(["one", "two"]);
    expect(plan.steps.map((s) => s.id)).toEqual([stepId(0), stepId(1)]);
  });
});

describe("graph validation", () => {
  it("reports dependencies pointing at steps that do not exist", () => {
    // Silently dropping the edge would turn a broken plan into a plausible one.
    const plan = buildPlan([
      { description: "build", id: "build", dependencies: ["ghost"] },
    ]);

    expect(unresolvedDependencies(plan)).toEqual(["ghost"]);
  });

  it("finds a cycle", () => {
    const plan = buildPlan([
      { description: "a", id: "a", dependencies: ["b"] },
      { description: "b", id: "b", dependencies: ["a"] },
    ]);

    expect(cyclicSteps(plan).sort()).toEqual(["a", "b"]);
  });

  it("finds a longer cycle", () => {
    const plan = buildPlan([
      { description: "a", id: "a", dependencies: ["c"] },
      { description: "b", id: "b", dependencies: ["a"] },
      { description: "c", id: "c", dependencies: ["b"] },
    ]);

    expect(cyclicSteps(plan).sort()).toEqual(["a", "b", "c"]);
  });

  it("does not call a diamond a cycle", () => {
    // Two paths converging is normal, and an over-eager cycle check would
    // reject correct plans.
    const plan = buildPlan([
      { description: "root", id: "root" },
      { description: "left", id: "left", dependencies: ["root"] },
      { description: "right", id: "right", dependencies: ["root"] },
      { description: "join", id: "join", dependencies: ["left", "right"] },
    ]);

    expect(cyclicSteps(plan)).toEqual([]);
    expect(unresolvedDependencies(plan)).toEqual([]);
  });
});

describe("readySteps", () => {
  it("returns only steps whose prerequisites all succeeded", () => {
    const plan = buildPlan([
      { description: "fetch", id: "fetch" },
      { description: "parse", id: "parse", dependencies: ["fetch"] },
    ]);

    expect(readySteps(plan).map((s) => s.id)).toEqual(["fetch"]);

    markStep(plan, "fetch", "succeeded");
    expect(readySteps(plan).map((s) => s.id)).toEqual(["parse"]);
  });

  it("does not release a step whose prerequisite merely ran", () => {
    // `executed` means it ran; `succeeded` means it worked. Only the latter
    // satisfies a dependency, or a broken prerequisite would unblock the step
    // that depends on its output.
    const plan = buildPlan([
      { description: "fetch", id: "fetch" },
      { description: "parse", id: "parse", dependencies: ["fetch"] },
    ]);

    markStep(plan, "fetch", "executed");
    expect(readySteps(plan).map((s) => s.id)).toEqual([]);
  });

  it("never releases a step with an unknown prerequisite", () => {
    const plan = buildPlan([
      { description: "build", id: "build", dependencies: ["ghost"] },
    ]);

    expect(readySteps(plan)).toEqual([]);
  });

  it("releases both arms of a diamond at once", () => {
    const plan = buildPlan([
      { description: "root", id: "root" },
      { description: "left", id: "left", dependencies: ["root"] },
      { description: "right", id: "right", dependencies: ["root"] },
    ]);

    markStep(plan, "root", "succeeded");
    expect(readySteps(plan).map((s) => s.id).sort()).toEqual(["left", "right"]);
  });
});

describe("blockUnreachable", () => {
  it("marks a dependent of a failed step blocked, not failed", () => {
    // The distinction that stops one root cause from reading as a cascade of
    // independent defects.
    const plan = buildPlan([
      { description: "fetch", id: "fetch" },
      { description: "parse", id: "parse", dependencies: ["fetch"] },
    ]);

    markStep(plan, "fetch", "failed", "network down");
    blockUnreachable(plan);

    expect(plan.steps[1]?.status).toBe("blocked");
    expect(plan.steps[1]?.status).not.toBe("failed");
    expect(plan.steps[1]?.detail).toContain("fetch");
  });

  it("propagates blocking transitively", () => {
    const plan = buildPlan([
      { description: "a", id: "a" },
      { description: "b", id: "b", dependencies: ["a"] },
      { description: "c", id: "c", dependencies: ["b"] },
    ]);

    markStep(plan, "a", "failed");
    blockUnreachable(plan);

    expect(plan.steps[1]?.status).toBe("blocked");
    expect(plan.steps[2]?.status).toBe("blocked");
    // C names its own unmet prerequisite, so a reader can walk backwards one
    // hop at a time instead of being handed the distant root cause.
    expect(plan.steps[2]?.detail).toContain("b");
  });

  it("leaves independent steps untouched", () => {
    const plan = buildPlan([
      { description: "a", id: "a" },
      { description: "b", id: "b", dependencies: ["a"] },
      { description: "solo", id: "solo" },
    ]);

    markStep(plan, "a", "failed");
    blockUnreachable(plan);

    expect(plan.steps[2]?.status).toBe("not_implemented");
  });

  it("blocks dependents of skipped and unavailable steps too", () => {
    // Those statuses also mean the output never arrived.
    for (const status of ["skipped", "unavailable"] as const) {
      const plan = buildPlan([
        { description: "a", id: "a" },
        { description: "b", id: "b", dependencies: ["a"] },
      ]);

      markStep(plan, "a", status);
      blockUnreachable(plan);

      expect(plan.steps[1]?.status).toBe("blocked");
    }
  });

  it("does not block a dependent of a succeeded step", () => {
    const plan = buildPlan([
      { description: "a", id: "a" },
      { description: "b", id: "b", dependencies: ["a"] },
    ]);

    markStep(plan, "a", "succeeded");
    blockUnreachable(plan);

    expect(plan.steps[1]?.status).toBe("not_implemented");
  });
});

describe("planSummary", () => {
  it("counts each status separately", () => {
    const plan = buildPlan([
      { description: "a", id: "a" },
      { description: "b", id: "b", dependencies: ["a"] },
      { description: "c", id: "c" },
      { description: "d", id: "d" },
    ]);

    markStep(plan, "a", "failed");
    markStep(plan, "c", "succeeded");
    blockUnreachable(plan);

    expect(planSummary(plan)).toEqual({
      total: 4,
      succeeded: 1,
      failed: 1,
      blocked: 1,
      unverified: 0,
      untouched: 1,
    });
  });

  it("does not count unverified as succeeded", () => {
    // `unverified` is what a step gets when the agent finished but nothing
    // attributed the work to that step. Counting it as success would restore
    // the optimism this module was written to remove.
    const plan = buildPlan(["a"]);
    markStep(plan, "s1", "unverified");

    expect(planSummary(plan).succeeded).toBe(0);
    // B6: and it is counted as what it is, not folded into "not attempted".
    expect(planSummary(plan).unverified).toBe(1);
  });
});
