/**
 * B3: a planner that decomposes the goal, and says which planner ran.
 *
 * What was measured before this existed: `PlanningEngine.decomposeGoal()` emits
 * step names from a fixed set (`Understand`, `Research`, `Design`, `Simulate`,
 * `Execute`, `Verify`, `Learn`), the goal text only toggles which of the middle
 * three appear through substring tests like `g.includes("create")`, and every
 * `estimatedMs`/`risk` is a literal. The last test in this file pins that
 * behaviour, because it is the reason the rest of the file exists.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLAN_CONSTRAINTS,
  TaskPlanner,
  parsePlanJson,
  parallelWaves,
  validatePlanSteps,
  type PlanningModel,
} from "../src/aurora/task-planner.js";
import { HybridAgentEngine } from "../src/engine.js";
import type { ModelRequest, ModelStreamEvent } from "../src/types.js";

/** A model that answers with fixed text, so the planner's reaction is testable. */
function modelReturning(reply: string): PlanningModel & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      calls.push(request);
      yield { type: "text_delta", delta: reply };
      yield { type: "route_selected", provider: "mock", model: "stub-planner", attempt: 1, fallback: false };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

function modelThrowing(message: string): PlanningModel {
  return {
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<ModelStreamEvent> {
      throw new Error(message);
    },
  };
}

const stubFallback = () => [
  { name: "Understand", description: "Analyse the goal", dependencies: [], estimatedMs: 4000, risk: "low" as const },
  { name: "Execute", description: "Do it", dependencies: ["Understand"], estimatedMs: 10000, risk: "low" as const },
  { name: "Verify", description: "Check it", dependencies: ["Execute"], estimatedMs: 6000, risk: "low" as const },
];

const request = { tenantId: "local", goal: "Add a rate limit to the public API" };

describe("the planner asks the model first and records what happened", () => {
  it("uses the model's decomposition when it is valid", async () => {
    const model = modelReturning(
      JSON.stringify({
        steps: [
          {
            name: "Find the public entry points",
            description: "List the routes exposed without authentication",
            dependencies: [],
            expectedOutput: "A list of route handlers reachable from outside",
            estimatedMs: 3000,
            risk: "low",
          },
          {
            name: "Add a token-bucket guard in front of them",
            description: "One shared limiter keyed by client id",
            dependencies: ["Find the public entry points"],
            expectedOutput: "A 429 response once the bucket is empty",
            estimatedMs: 9000,
            risk: "medium",
          },
        ],
      }),
    );
    const planner = new TaskPlanner({ fallback: stubFallback, model });

    const plan = await planner.plan(request);

    expect(plan.source).toBe("model");
    expect(plan.fallbackReason).toBeUndefined();
    // The plan is about *this* goal, not a generic skeleton.
    expect(plan.steps.map((step) => step.name)).toEqual([
      "Find the public entry points",
      "Add a token-bucket guard in front of them",
    ]);
    expect(plan.steps[1]?.dependencies).toEqual(["Find the public entry points"]);
    expect(plan.steps[0]?.expectedOutput).toContain("route handlers");
    expect(plan.totalEstimatedMs).toBe(12000);
    expect(plan.modelRoute).toBe("mock:stub-planner");
    // And the model was really asked, with the goal in the prompt.
    expect(model.calls).toHaveLength(1);
    expect(JSON.stringify(model.calls[0]?.messages)).toContain("Add a rate limit to the public API");
  });

  it("falls back and says why when the model answers with prose", async () => {
    const planner = new TaskPlanner({
      fallback: stubFallback,
      model: modelReturning("Sure! First you would want to understand the requirements."),
    });

    const plan = await planner.plan(request);

    expect(plan.source).toBe("fallback");
    expect(plan.fallbackReason).toContain("no JSON object");
    expect(plan.steps.map((step) => step.name)).toEqual(["Understand", "Execute", "Verify"]);
  });

  it("falls back and says why when the model throws", async () => {
    const planner = new TaskPlanner({
      fallback: stubFallback,
      model: modelThrowing("upstream 503"),
    });

    const plan = await planner.plan(request);

    expect(plan.source).toBe("fallback");
    expect(plan.fallbackReason).toContain("upstream 503");
  });

  it("falls back and says why when no model was supplied", async () => {
    const planner = new TaskPlanner({ fallback: stubFallback });
    const plan = await planner.plan(request);
    expect(plan.source).toBe("fallback");
    expect(plan.fallbackReason).toContain("no model");
  });

  it("falls back and says why when the model returns an empty reply", async () => {
    const planner = new TaskPlanner({ fallback: stubFallback, model: modelReturning("   ") });
    const plan = await planner.plan(request);
    expect(plan.source).toBe("fallback");
    expect(plan.fallbackReason).toContain("no text");
  });

  it("never throws for a planning reason, so a task cannot stall in planning", async () => {
    const planner = new TaskPlanner({ fallback: stubFallback, model: modelReturning("{not json") });
    await expect(planner.plan(request)).resolves.toMatchObject({ source: "fallback" });
  });
});

describe("a model plan is validated before anything acts on it", () => {
  const ok = { name: "a", description: "do a", dependencies: [], estimatedMs: 1000, risk: "low" };

  it("rejects a cycle", async () => {
    const planner = new TaskPlanner({
      fallback: stubFallback,
      model: modelReturning(
        JSON.stringify({
          steps: [
            { ...ok, name: "a", dependencies: ["b"] },
            { ...ok, name: "b", dependencies: ["a"] },
          ],
        }),
      ),
    });
    const plan = await planner.plan(request);
    expect(plan.source).toBe("fallback");
    expect(plan.fallbackReason).toMatch(/depends on (unknown step|later step)/);
  });

  it("rejects a repeated step name, because dependencies would be ambiguous", async () => {
    const plan = validatePlanSteps([ok, { ...ok, name: "a", description: "do a again" }]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain('appears twice');
  });

  it("rejects a dependency on a step that does not exist", () => {
    const plan = validatePlanSteps([{ ...ok, dependencies: ["nonexistent"] }]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("unknown step");
  });

  it("rejects a step that depends on itself", () => {
    const plan = validatePlanSteps([{ ...ok, dependencies: ["a"] }]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("depends on itself");
  });

  it("rejects zero steps rather than reporting an empty plan as a success", () => {
    const plan = validatePlanSteps([]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("zero steps");
  });

  it("rejects a risk label it does not know instead of coercing it", () => {
    const plan = validatePlanSteps([{ ...ok, risk: "extreme" }]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("extreme");
  });

  it("rejects a plan over the step budget", () => {
    const many = Array.from({ length: DEFAULT_PLAN_CONSTRAINTS.maxSteps + 1 }, (_, index) => ({
      ...ok,
      name: `s${index}`,
      dependencies: index === 0 ? [] : [`s${index - 1}`],
    }));
    const plan = validatePlanSteps(many);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("limit");
  });

  it("rejects a plan whose budgets add up past the ceiling", () => {
    // Four steps, each under the per-step limit, totalling more than the plan
    // budget: the two ceilings are different checks and both have to hold.
    const perStep = DEFAULT_PLAN_CONSTRAINTS.maxStepMs;
    const plan = validatePlanSteps(
      [
        { ...ok, name: "a", estimatedMs: perStep },
        { ...ok, name: "b", dependencies: ["a"], estimatedMs: perStep },
        { ...ok, name: "c", dependencies: ["b"], estimatedMs: perStep },
        { ...ok, name: "d", dependencies: ["c"], estimatedMs: perStep },
      ],
      DEFAULT_PLAN_CONSTRAINTS,
    );
    expect(4 * perStep).toBeGreaterThan(DEFAULT_PLAN_CONSTRAINTS.maxTotalMs);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("budget");
  });

  it("rejects a single step over the per-step ceiling before it can reach the total", () => {
    const plan = validatePlanSteps(
      [{ ...ok, estimatedMs: DEFAULT_PLAN_CONSTRAINTS.maxStepMs + 1 }],
      DEFAULT_PLAN_CONSTRAINTS,
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("per-step limit");
  });

  it("reads a plan out of a fenced or prose-wrapped reply", () => {
    const fenced = parsePlanJson('Here you go:\n```json\n{"steps":[{"name":"a"}]}\n```\nHope that helps.');
    expect(fenced.ok).toBe(true);
    const unterminated = parsePlanJson('{"steps": [{"name":');
    expect(unterminated.ok).toBe(false);
    const noArray = parsePlanJson('{"plan":"do things"}');
    expect(noArray.ok).toBe(false);
    if (!noArray.ok) expect(noArray.reason).toContain("steps");
  });

  it("does not let a brace inside a string end the object early", () => {
    const parsed = parsePlanJson('{"steps":[{"name":"handle {legacy} ids"}]}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const step = (parsed.steps[0] as { name: string }).name;
      expect(step).toBe("handle {legacy} ids");
    }
  });
});

describe("parallelism is measured, not asserted", () => {
  it("finds the independent work in a diamond", () => {
    const waves = parallelWaves([
      { name: "a", description: "", dependencies: [], estimatedMs: 0, risk: "low" },
      { name: "b", description: "", dependencies: ["a"], estimatedMs: 0, risk: "low" },
      { name: "c", description: "", dependencies: ["a"], estimatedMs: 0, risk: "low" },
      { name: "d", description: "", dependencies: ["b", "c"], estimatedMs: 0, risk: "low" },
    ]);
    expect(waves).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("reports a chain as having no parallelism to claim", () => {
    const waves = parallelWaves([
      { name: "Understand", description: "", dependencies: [], estimatedMs: 0, risk: "low" },
      { name: "Execute", description: "", dependencies: ["Understand"], estimatedMs: 0, risk: "low" },
      { name: "Verify", description: "", dependencies: ["Execute"], estimatedMs: 0, risk: "low" },
    ]);
    expect(waves.map((wave) => wave.length)).toEqual([1, 1, 1]);
  });
});

describe("the engine's planner is the model-backed one", () => {
  it("plans through TaskPlanner and labels the source, even when it falls back", async () => {
    // The mock provider emits prose, not a plan, so the honest result is a
    // recorded fallback — which is exactly what this asserts. Before B3 the same
    // call returned a plan with no provenance at all, so a reader could not tell
    // a decomposition from a template.
    const engine = new HybridAgentEngine({
      homePath: await mkdtemp(`${tmpdir()}/haf-task-planner-`),
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
      autoApproveWorkspaceWrites: true,
      allowProcessExecution: true,
    });
    try {
      await engine.initialize();
      expect(engine.taskPlanner).toBeInstanceOf(TaskPlanner);

      const result = await engine.planningEngine.plan({
        tenantId: "local",
        goal: "Add a rate limit to the public API",
        sessionId: "planner-test",
      });

      expect(result.source).toBe("fallback");
      expect(result.fallbackReason).toBeTruthy();
      expect(result.steps.length).toBeGreaterThan(0);
    } finally {
      await engine.shutdown();
    }
  });
});

describe("what the keyword skeleton cannot do (the reason B3 exists)", () => {
  it("gives two very different goals the same plan when they share a keyword", async () => {
    const homePath = await mkdtemp(`${tmpdir()}/haf-keyword-plan-`);
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
      autoApproveWorkspaceWrites: true,
      allowProcessExecution: true,
    });
    try {
      await engine.initialize();

      const trivial = engine.planningEngine.keywordDecomposition(
        "Create a file called hello.txt containing the word hello",
        "balanced",
      );
      const enormous = engine.planningEngine.keywordDecomposition(
        "Create a distributed consensus system that survives a Byzantine partition across nine regions",
        "balanced",
      );

      // Measured, and it is the whole argument: identical step names in
      // identical order. Both goals contain "create", so both get `Design`.
      expect(trivial.map((step) => step.name)).toEqual(enormous.map((step) => step.name));
      expect(trivial.map((step) => step.name)).toContain("Design");

      // The budgets are not identical, and that is worse than if they were. The
      // only step whose budget differs is `Execute`, and it differs because of
      // `execTime = needsCoding ? 20000 : goal.length > 500 ? 15000 : 10000`.
      // The hello.txt goal contains the word "file", so it is budgeted at
      // 20s of implementation work; the Byzantine consensus goal matches no
      // keyword and is under 500 characters, so it is budgeted at 10s. Measured,
      // not read off the code: the harder goal gets half the time, because of a
      // substring test.
      const trivialExecute = trivial.find((step) => step.name === "Execute");
      const enormousExecute = enormous.find((step) => step.name === "Execute");
      expect(trivialExecute?.estimatedMs).toBe(20000);
      expect(enormousExecute?.estimatedMs).toBe(10000);
      expect(
        trivial.filter((step) => step.name !== "Execute").map((step) => step.estimatedMs),
      ).toEqual(enormous.filter((step) => step.name !== "Execute").map((step) => step.estimatedMs));
    } finally {
      await engine.shutdown();
    }
  });
});
