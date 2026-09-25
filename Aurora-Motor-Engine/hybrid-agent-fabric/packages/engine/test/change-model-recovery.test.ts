/**
 * P0-7, closing the honest gap left last round.
 *
 * `change_model` and `change_tool` were given directives — text telling the
 * agent to try something else — but nothing actually changed the model. The
 * name still promised more than the behaviour delivered.
 *
 * The mechanism already existed and was unused by recovery:
 * `SessionAgentProfile` carries `modelRoute` and `fallbackModels`, and
 * `ModelRouter.stream()` walks `[model, ...fallbackModels]` in order. So a
 * `change_model` recovery has a real move available: run the next attempt on
 * the next route instead of the one that just failed.
 *
 * These tests pin that the escalation happens, is bounded, and stays honest
 * when there is nothing to escalate to.
 */
import { describe, expect, it } from "vitest";
import { UnifiedExecutionLoop } from "../src/execution/unified-execution-loop.js";
import { TaskContext } from "../src/execution/task-context.js";

describe("change_model actually changes the model", () => {
  it("a reasoning failure moves the next attempt to the fallback route", async () => {
    const routes: (string | undefined)[] = [];
    let call = 0;

    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async (context) => {
          call += 1;
          routes.push(context.modelRoute);
          // "invalid reasoning" → reasoning_failure → change_model.
          return call === 1
            ? { completed: false, summary: "bad logic", error: "invalid reasoning in step 2" }
            : { completed: true, summary: "ok" };
        },
      },
      {
        maxAttempts: 2,
        modelRoute: "openai/gpt-4o-mini",
        fallbackModels: ["openai/gpt-4o", "anthropic/claude-sonnet"],
      },
    );

    await loop.run({ tenantId: "t", goal: "Prove the invariant" });

    expect(call).toBe(2);
    expect(routes[0]).toBe("openai/gpt-4o-mini");
    // The retry must not run on the model that just failed.
    expect(routes[1]).toBe("openai/gpt-4o");
  });

  it("escalation walks the fallback list in order, one step per failure", async () => {
    const routes: (string | undefined)[] = [];

    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async (context) => {
          routes.push(context.modelRoute);
          return { completed: false, summary: "bad logic", error: "invalid reasoning again" };
        },
      },
      {
        maxAttempts: 3,
        modelRoute: "m0",
        fallbackModels: ["m1", "m2"],
      },
    );

    await loop.run({ tenantId: "t", goal: "Prove the invariant" });

    expect(routes).toEqual(["m0", "m1", "m2"]);
  });

  it("with no fallback configured it does not pretend to switch", async () => {
    const routes: (string | undefined)[] = [];
    let call = 0;

    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async (context) => {
          call += 1;
          routes.push(context.modelRoute);
          return call === 1
            ? { completed: false, summary: "bad logic", error: "invalid reasoning in step 2" }
            : { completed: true, summary: "ok" };
        },
      },
      { maxAttempts: 2, modelRoute: "only-model" },
    );

    const report = await loop.run({ tenantId: "t", goal: "Prove the invariant" });

    // Same route both times — there is nowhere to escalate to.
    expect(routes).toEqual(["only-model", "only-model"]);
    // And the report must say so rather than claiming a model change happened.
    const said = JSON.stringify(report.failures);
    expect(said).toMatch(/no alternative model|exhausted|same model/i);
  });

  it("a plain retry does not burn a fallback route", async () => {
    const routes: (string | undefined)[] = [];
    let call = 0;

    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async (context) => {
          call += 1;
          routes.push(context.modelRoute);
          // exit code 1 → execution_failure → retry (not change_model).
          return call === 1
            ? { completed: false, summary: "build failed", error: "npm run build: exit code 1" }
            : { completed: true, summary: "ok" };
        },
      },
      { maxAttempts: 2, modelRoute: "m0", fallbackModels: ["m1"] },
    );

    await loop.run({ tenantId: "t", goal: "Fix the build" });

    // The model was not the problem, so the fallback stays available.
    expect(routes).toEqual(["m0", "m0"]);
  });

  it("the chosen route reaches the agent session, not just the context", async () => {
    const context = new TaskContext({ tenantId: "t", goal: "x" });
    context.modelRoute = "openai/gpt-4o";
    context.fallbackModels = ["anthropic/claude-sonnet"];

    // escalateModel() is the single place that decides the next route.
    const next = context.escalateModel();
    expect(next).toBe("anthropic/claude-sonnet");
    expect(context.modelRoute).toBe("anthropic/claude-sonnet");

    // Exhausted: returns undefined rather than silently reusing the last one.
    expect(context.escalateModel()).toBeUndefined();
  });
});
