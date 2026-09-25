/**
 * B5: when the plan is the problem, make a new one — and keep the work.
 *
 * What was measured before this existed. `chooseRecovery` has returned
 * `strategy: "replan"` for three failure kinds since the taxonomy was written:
 *
 *     "The plan was invalid: circular dependency between steps"  → replan
 *     "The plan was empty"                                       → replan
 *     "I do not know which version is deployed"                  → replan
 *
 * and nothing ever read it. The loop handled `acquire_capability`,
 * `change_tool`, `change_model` and `add_verification` by name; `replan` fell
 * through to a plain retry, so a task whose *plan* was wrong was handed the same
 * plan again — while the recovery directive told the agent to take a different
 * approach. Telling is not doing.
 */
import { describe, expect, it } from "vitest";

import { mergeReplan } from "../src/execution/plan-execution.js";
import { buildPlan, markStep } from "../src/execution/plan-progress.js";
import { UnifiedExecutionLoop } from "../src/execution/unified-execution-loop.js";

const goal = "Publish the release notes";
const planningFailure = "The plan was invalid: circular dependency between steps";

function walkedPlan() {
  const plan = buildPlan([
    { id: "collect", description: "collect the changelog", dependencies: [] },
    { id: "draft", description: "draft the notes", dependencies: ["collect"] },
    { id: "publish", description: "publish them", dependencies: ["draft"] },
  ]);
  // One step has genuinely run; the other two have not.
  markStep(plan, "collect", "succeeded", "40 entries read");
  plan.steps[0]!.evidence = { attempt: 1, detail: "40 entries read", at: "2026-09-24T00:00:00.000Z" };
  return plan;
}

describe("a replan keeps the work and replaces only what was never attempted", () => {
  it("preserves an attempted step, status and evidence intact", () => {
    const merged = mergeReplan(walkedPlan(), [
      { id: "research-format", description: "find the required format", dependencies: ["collect"] },
      { id: "draft-2", description: "draft against that format", dependencies: ["research-format"] },
    ]);

    expect(merged.rejected).toBeUndefined();
    expect(merged.kept).toEqual(["collect"]);
    expect(merged.replaced).toEqual(["draft", "publish"]);
    expect(merged.added).toEqual(["research-format", "draft-2"]);

    const collect = merged.plan.steps.find((step) => step.id === "collect");
    expect(collect?.status).toBe("succeeded");
    expect(collect?.evidence?.detail).toBe("40 entries read");
    expect(merged.plan.steps.find((step) => step.id === "draft")).toBeUndefined();
  });

  it("keeps an edge that points at a kept step and drops one that points at a dropped step", () => {
    const merged = mergeReplan(walkedPlan(), [
      // `collect` survived; `draft` did not.
      { id: "x", description: "x", dependencies: ["collect", "draft"] },
    ]);
    expect(merged.plan.steps.find((step) => step.id === "x")?.dependencies).toEqual(["collect"]);
  });

  it("refuses an empty proposal instead of emptying the plan", () => {
    const before = walkedPlan();
    const merged = mergeReplan(before, []);
    expect(merged.rejected).toContain("no steps");
    expect(merged.plan).toBe(before);
  });

  it("refuses a proposal that reuses the id of a step that already ran", () => {
    const merged = mergeReplan(walkedPlan(), [
      { id: "collect", description: "collect again", dependencies: [] },
    ]);
    expect(merged.rejected).toContain("already been attempted");
  });

  it("refuses a proposal that names the same new step twice", () => {
    const merged = mergeReplan(walkedPlan(), [
      { id: "x", description: "x", dependencies: [] },
      { id: "x", description: "x again", dependencies: [] },
    ]);
    expect(merged.rejected).toContain("twice");
  });

  it("refuses a proposal containing a cycle rather than installing an unwalkable plan", () => {
    const merged = mergeReplan(walkedPlan(), [
      { id: "x", description: "x", dependencies: ["y"] },
      { id: "y", description: "y", dependencies: ["x"] },
    ]);
    expect(merged.rejected).toContain("cycle");
  });

  it("says plainly when a planner cannot be replanned safely", () => {
    // Bare descriptions get positional ids, and `s1` already belongs to the step
    // that ran. Merging anyway would make every edge into `s1` ambiguous, so the
    // honest result is a refusal that names the real requirement.
    const plan = buildPlan(["collect", "draft"]);
    markStep(plan, "s1", "succeeded");
    const merged = mergeReplan(plan, ["research the format", "draft again"]);
    expect(merged.rejected).toContain("must name its steps");
  });
});

describe("the loop replans when recovery says the plan was the problem", () => {
  it("asks the planner again and replaces only the step nobody attempted", async () => {
    const plannerCalls: number[] = [];
    const events: string[] = [];
    let attempt = 0;

    const loop = new UnifiedExecutionLoop({
      runAgent: async () => {
        attempt += 1;
        if (attempt === 1) {
          // The agent attributes one step and then reports the plan itself as
          // broken, so `collect` is genuinely done and `publish` was never
          // attempted — the only shape in which "replace the affected subtree"
          // has something to replace.
          return {
            completed: false,
            summary: planningFailure,
            error: planningFailure,
            stepResults: [{ id: "collect", status: "succeeded" as const, detail: "40 entries read" }],
          };
        }
        return { completed: true, summary: "published" };
      },
      plan: async () => {
        plannerCalls.push(plannerCalls.length + 1);
        return plannerCalls.length === 1
          ? [
              { id: "collect", description: "collect the changelog", dependencies: [] },
              { id: "publish", description: "publish them", dependencies: ["collect"] },
            ]
          // A planner is not asked to propose work that already ran: `collect`
          // succeeded, so the new plan builds on it rather than repeating it.
          // Re-proposing the id of an attempted step is refused by the merge,
          // and there is a separate test for that.
          : [
              { id: "research-format", description: "find the required format", dependencies: ["collect"] },
              { id: "publish-2", description: "publish against that format", dependencies: ["research-format"] },
            ];
      },
      emit: async (event) => {
        events.push(event.type);
      },
    }, { maxAttempts: 3 });

    const report = await loop.run({ tenantId: "local", goal });
    const byId = new Map((report.plan?.steps ?? []).map((step) => [step.id, step]));

    expect(plannerCalls).toEqual([1, 2]);
    // Finished work carried across, evidence intact.
    expect(byId.get("collect")?.status).toBe("succeeded");
    expect(byId.get("collect")?.evidence?.detail).toBe("40 entries read");
    // The unattempted step was replaced by the new subtree.
    expect(byId.has("publish")).toBe(false);
    expect(byId.has("research-format")).toBe(true);
    expect(byId.has("publish-2")).toBe(true);
    expect(events).toContain("task.replanned");
    // The final summary is the last attempt's, so the replan surfaces in the
    // plan note rather than in place of the outcome sentence.
    expect(report.summary).toContain("replanned 1 time(s) after planning_failure");
  });

  it("keeps a failed step as a record rather than erasing what went wrong", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: false, summary: planningFailure, error: planningFailure }),
      plan: async () => [
        { id: "collect", description: "collect", dependencies: [] },
        { id: "research-format", description: "find the format", dependencies: ["collect"] },
      ],
    }, { maxAttempts: 2 });

    const report = await loop.run({ tenantId: "local", goal });
    const byId = new Map((report.plan?.steps ?? []).map((step) => [step.id, step]));

    // `collect` failed on the attempt. Replanning must not make that disappear:
    // the failure is the reason there is a new plan at all.
    expect(byId.get("collect")?.status).toBe("failed");
    expect(byId.has("research-format")).toBe(true);
  });

  it("records a refused replan instead of quietly keeping the old plan", async () => {
    let plannerCalls = 0;
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: false, summary: planningFailure, error: planningFailure }),
      plan: async () => {
        plannerCalls += 1;
        // Second call proposes a cycle, which the merge refuses.
        return plannerCalls === 1
          ? [{ id: "collect", description: "collect", dependencies: [] }]
          : [
              { id: "x", description: "x", dependencies: ["y"] },
              { id: "y", description: "y", dependencies: ["x"] },
            ];
      },
    }, { maxAttempts: 3 });

    const report = await loop.run({ tenantId: "local", goal });

    expect((report.plan?.steps ?? []).map((step) => step.id)).toEqual(["collect"]);
    const outcomes = report.outcomes.map((entry) => JSON.stringify(entry));
    expect(outcomes.some((entry) => entry.includes("Replan rejected"))).toBe(true);
    expect(outcomes.some((entry) => entry.includes("cycle"))).toBe(true);
  });

  it("stops replanning after the cap and says so", async () => {
    let plannerCalls = 0;
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: false, summary: planningFailure, error: planningFailure }),
      plan: async () => {
        plannerCalls += 1;
        // A different id every time, so the only thing that can stop the
        // replanning is the cap.
        return [
          { id: `collect-${plannerCalls}`, description: "collect", dependencies: [] },
          { id: `publish-${plannerCalls}`, description: "publish", dependencies: [`collect-${plannerCalls}`] },
        ];
      },
      // `maxAttempts` is LoopConfig — the loop's second constructor argument —
      // not a dependency. The first version of this test put it in the deps
      // object, where it was silently ignored and the default of 3 ended the
      // task before the replan cap could be reached.
    }, { maxAttempts: 8 });

    const report = await loop.run({ tenantId: "local", goal });
    const outcomes = report.outcomes.map((entry) => JSON.stringify(entry));

    // 1 initial plan + 2 replans, then the cap.
    expect(plannerCalls).toBe(3);
    expect(outcomes.some((entry) => entry.includes("already been replanned"))).toBe(true);
  });

  it("does not replan for a failure whose plan was not the problem", async () => {
    let plannerCalls = 0;
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({
        completed: false,
        summary: "the fetch failed",
        error: "ECONNREFUSED 127.0.0.1:443",
      }),
      plan: async () => {
        plannerCalls += 1;
        return [{ id: "fetch", description: "fetch it", dependencies: [] }];
      },
    }, { maxAttempts: 3 });

    await loop.run({ tenantId: "local", goal });

    // `environment_failure` recovers with `retry_with_backoff`: the plan was
    // fine, the network was not. Replanning would burn a model call for nothing.
    expect(plannerCalls).toBe(1);
  });
});
