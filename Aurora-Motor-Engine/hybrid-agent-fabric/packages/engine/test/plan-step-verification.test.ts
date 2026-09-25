/**
 * B6: a step that ran gets checked against its own criterion.
 *
 * What was measured before this existed. A task whose goal was "Create
 * hello.txt with Hi", run with a goal-scoped verifier that confirmed
 * "hello.txt contains Hi", reported:
 *
 *     status=succeeded verdict=pass
 *     steps=write:unverified check:not_implemented
 *     summary=Verified after 1 attempt(s). … Plan: 2 step(s), 1 not attempted.
 *
 * The report said "the file was checked and contains Hi" at the goal level and
 * "nothing could confirm the result for this step" at the step level — in the
 * same breath. The evidence existed; it was never attached to the step that
 * produced the work. Worse, the criterion the planner is explicitly prompted
 * for (`expectedOutput`) was dropped twice on the way to the loop: once in
 * `PlanningEngine.plan`'s step mapping and once in the engine's `deps.plan`
 * bridge, so no step could ever have been verified even in principle.
 */
import { describe, expect, it } from "vitest";

import { buildPlan, markStep } from "../src/execution/plan-progress.js";
import { selectStepVerifiers } from "../src/execution/plan-execution.js";
import { UnifiedExecutionLoop } from "../src/execution/unified-execution-loop.js";
import {
  formalVerifier,
  type StepClaim,
  type Verifier,
} from "../src/execution/verification-factory.js";
import { TaskPlanner, type PlanningModel } from "../src/aurora/task-planner.js";
import { PlanningEngine } from "../src/aurora/unified-engines.js";
import { CognitiveState } from "../src/aurora/cognitive-state.js";
import type { ModelRequest, ModelStreamEvent } from "../src/types.js";

const goal = "Create hello.txt with Hi";

/** A verifier that can check claims about hello.txt. */
function helloVerifier(ok: boolean, name = "file-hello"): Verifier {
  return {
    ...formalVerifier(name, async () => ({
      ok,
      output: ok ? "hello.txt exists and contains Hi" : "hello.txt does not exist",
    })),
    appliesTo: (step: StepClaim) => (step.successCriterion ?? "").includes("hello.txt"),
  };
}

describe("a step's criterion survives the plan", () => {
  it("buildPlan carries successCriterion into the step", () => {
    const plan = buildPlan([
      { id: "write", description: "create hello.txt", successCriterion: "hello.txt exists and contains Hi" },
    ]);
    expect(plan.steps[0]?.successCriterion).toBe("hello.txt exists and contains Hi");
  });
});

describe("verifier selection is automated, from the verifier's side", () => {
  const step = {
    id: "write",
    description: "create hello.txt",
    dependencies: [],
    status: "not_implemented" as const,
    successCriterion: "hello.txt exists and contains Hi",
  };

  it("selects the verifiers that declared they can evaluate the claim", () => {
    const pool = [helloVerifier(true), helloVerifier(true, "other-file")];
    // The second verifier's appliesTo does not match this step's criterion.
    pool[1] = {
      ...formalVerifier("other-file", async () => ({ ok: true, output: "other.txt fine" })),
      appliesTo: (claim: StepClaim) => (claim.successCriterion ?? "").includes("other.txt"),
    };
    expect(selectStepVerifiers(step, pool).map((v) => v.name)).toEqual(["file-hello"]);
  });

  it("excludes workspace-scoped verifiers however well they seem to apply", () => {
    // P1.6: build/test evidence is general. A green build says the workspace is
    // sound; it cannot vouch for one step's criterion.
    const build = {
      ...formalVerifier("build", async () => ({ ok: true, output: "tsc clean" }), "workspace"),
      appliesTo: () => true,
    };
    expect(selectStepVerifiers(step, [build])).toEqual([]);
  });

  it("excludes verifiers that never declared step applicability", () => {
    const goalOnly = formalVerifier("goal-only", async () => ({ ok: true, output: "fine" }));
    expect(selectStepVerifiers(step, [goalOnly])).toEqual([]);
  });
});

describe("the loop checks unverified steps against their own criteria", () => {
  it("attaches the evidence to the step that produced the work", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "did it" }),
      plan: async () => [
        {
          id: "write",
          description: "create hello.txt",
          dependencies: [],
          successCriterion: "hello.txt exists and contains Hi",
        },
        { id: "check", description: "confirm hello.txt", dependencies: ["write"] },
      ],
      verifiersFor: async () => [helloVerifier(true)],
    });

    const report = await loop.run({ tenantId: "local", goal });
    const byId = new Map((report.plan?.steps ?? []).map((step) => [step.id, step]));
    const write = byId.get("write")!;

    // The step is now a *checked* success, with the record of the check.
    expect(write.status).toBe("succeeded");
    expect(write.verification?.verdict).toBe("pass");
    expect(write.verification?.verifiers).toEqual(["file-hello"]);
    expect(write.verification?.attempt).toBe(1);
    // The run record is still the run record — verification did not replace it.
    expect(write.attempts).toBe(1);
    expect(write.evidence?.attempt).toBe(1);

    // The B4 boundary holds: the caller's criterion ended the task, so the
    // next step was never walked.
    expect(byId.get("check")?.status).toBe("not_implemented");
    expect(report.status).toBe("succeeded");
    expect(report.summary).toContain("1 succeeded");
    expect(report.summary).toContain("1 not attempted");
  });

  it("marks a refuted step failed and blocks its dependants", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "did it" }),
      plan: async () => [
        {
          id: "write",
          description: "create hello.txt",
          dependencies: [],
          successCriterion: "hello.txt exists and contains Hi",
        },
        { id: "check", description: "confirm hello.txt", dependencies: ["write"] },
      ],
      verifiersFor: async () => [helloVerifier(false)],
    }, { maxAttempts: 1 });

    const report = await loop.run({ tenantId: "local", goal });
    const byId = new Map((report.plan?.steps ?? []).map((step) => [step.id, step]));

    expect(byId.get("write")?.status).toBe("failed");
    expect(byId.get("write")?.detail).toContain("Refuted by file-hello");
    expect(byId.get("write")?.verification?.verdict).toBe("fail");
    // The dependant never got the chance: blocked, not failed.
    expect(byId.get("check")?.status).toBe("blocked");
  });

  it("leaves a step unverified when the panel could not decide", async () => {
    const undecided: Verifier = {
      ...helloVerifier(true),
      canRun: async () => false,
    };
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "did it" }),
      plan: async () => [
        {
          id: "write",
          description: "create hello.txt",
          dependencies: [],
          successCriterion: "hello.txt exists and contains Hi",
        },
      ],
      verifiersFor: async () => [undecided],
    }, { maxAttempts: 1 });

    const report = await loop.run({ tenantId: "local", goal });
    const write = report.plan?.steps[0]!;

    expect(write.status).toBe("unverified");
    expect(write.detail).toContain("Step verification was uncertain");
    expect(write.verification?.verdict).toBe("uncertain");
  });

  it("says so when a step declares a criterion nothing can check", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "did it" }),
      plan: async () => [
        {
          id: "write",
          description: "create hello.txt",
          dependencies: [],
          successCriterion: "hello.txt exists and contains Hi",
        },
      ],
      // A perfectly good goal verifier that says nothing about steps.
      verifiersFor: async () => [formalVerifier("goal-only", async () => ({ ok: true, output: "goal fine" }))],
    });

    const report = await loop.run({ tenantId: "local", goal });
    const write = report.plan?.steps[0]!;

    expect(write.status).toBe("unverified");
    expect(report.observations.some((o) => o.summary.includes("no verifier applies"))).toBe(true);
  });

  it("runs every applicable verifier and lets a hard fail refute the step", async () => {
    // P1.6's evaluator panel, assembled automatically: both verifiers declared
    // they can check the claim, so both run, and the factory's combine rules
    // decide — a formal fail is not outvoted by a formal pass.
    const panel: Verifier[] = [
      helloVerifier(true, "content-check"),
      helloVerifier(false, "existence-check"),
    ];
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "did it" }),
      plan: async () => [
        {
          id: "write",
          description: "create hello.txt",
          dependencies: [],
          successCriterion: "hello.txt exists and contains Hi",
        },
      ],
      verifiersFor: async () => panel,
    }, { maxAttempts: 1 });

    const report = await loop.run({ tenantId: "local", goal });
    const write = report.plan?.steps[0]!;

    expect(write.status).toBe("failed");
    expect(write.verification?.verifiers).toEqual(["content-check", "existence-check"]);
  });
});

describe("the criterion survives the journey from the planner to the loop", () => {
  /** A model that answers with fixed text, so the planner's reaction is testable. */
  function modelReturning(reply: string): PlanningModel {
    return {
      async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        yield { type: "text_delta", delta: reply };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
  }

  const stubFallback = () => [
    { name: "Understand", description: "Analyse the goal", dependencies: [], estimatedMs: 4000, risk: "low" as const },
    { name: "Execute", description: "Do it", dependencies: ["Understand"], estimatedMs: 10000, risk: "low" as const },
  ];

  function stubDoubles() {
    let n = 0;
    return {
      planner: {} as never,
      plannerV2: { createPlan: async () => { n += 1; return { id: `plan-${n}` }; } },
      goalStack: { addGoal: async () => ({ id: "goal-1" }) },
      bus: { emit: async () => undefined },
      state: new CognitiveState(),
    };
  }

  it("PlanningEngine carries expectedOutput from the model's plan", async () => {
    const d = stubDoubles();
    const taskPlanner = new TaskPlanner({
      fallback: stubFallback,
      model: modelReturning(
        JSON.stringify({
          steps: [
            {
              name: "Find entry points",
              description: "List the routes exposed without authentication",
              dependencies: [],
              expectedOutput: "A list of route handlers reachable from outside",
              estimatedMs: 3000,
              risk: "low",
            },
          ],
        }),
      ),
    });
    const engine = new PlanningEngine(d.planner, d.plannerV2 as never, d.goalStack as never, d.bus as never, d.state, taskPlanner);

    const result = await engine.plan({ tenantId: "local", goal: "Add a rate limit to the public API" });

    // This is the exact field the old mapping dropped, measured by reading the
    // mapping: name, description, dependencies, estimatedMs, risk — and nothing
    // else survived.
    expect(result.steps[0]?.expectedOutput).toBe("A list of route handlers reachable from outside");
    expect(result.source).toBe("model");
  });

  it("the keyword fallback carries no criterion, and does not invent one", async () => {
    const d = stubDoubles();
    const engine = new PlanningEngine(d.planner, d.plannerV2 as never, d.goalStack as never, d.bus as never, d.state);

    const result = await engine.plan({ tenantId: "local", goal: "Add a rate limit to the public API" });

    expect(result.steps.every((step) => step.expectedOutput === undefined)).toBe(true);
  });
});
