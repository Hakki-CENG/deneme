/**
 * P0-2 / A5: per-task cognitive context, and a flat view that is derived.
 *
 * The original complaint was that `engine.cognitiveState` is one global object
 * holding things that belong to a single task — active goal, active plan,
 * confidence, verification result — so two tasks running at once overwrite each
 * other.
 *
 * Per-task slots fixed the *records*. This file also covers the second half:
 * the flat fields used to be a second, independently written store, so "the
 * active goal" was whichever `await` resumed last. They are now derived from
 * one named slot, and `focusedTask()` says whose.
 */
import { describe, expect, it } from "vitest";
import { CognitiveState } from "../src/aurora/cognitive-state.js";

function goal(id: string, title = id) {
  return { id, title, priority: "P1" as const, progress: 0, status: "active" as const, startedAt: Date.now() };
}

describe("two tasks no longer overwrite each other's record", () => {
  it("each task keeps its own goal even when they interleave", () => {
    const state = new CognitiveState();
    state.beginTask("task-A", "tenant-1");
    state.setActiveGoalFor("task-A", goal("goal-A", "Task A: add rate limiting"));

    // Task B starts while A is still running.
    state.beginTask("task-B", "tenant-1");
    state.setActiveGoalFor("task-B", goal("goal-B", "Task B: rename a column"));

    // A's goal is still A's: nothing was lost, and it can be asked for by id.
    expect(state.snapshotForTask("task-A")?.goal?.title).toBe("Task A: add rate limiting");
    expect(state.snapshotForTask("task-B")?.goal?.title).toBe("Task B: rename a column");
  });

  it("there is no longer a way to declare 'the' active goal without naming a task", () => {
    const state = new CognitiveState() as unknown as Record<string, unknown>;
    // These were the ambiguous entry points. They are gone, not deprecated: a
    // caller that cannot say whose goal it is setting is a caller that will get
    // it wrong under concurrency.
    expect(typeof state.setActiveGoal).toBe("undefined");
    expect(typeof state.setActivePlan).toBe("undefined");
  });

  it("a verdict belongs to the task that produced it", () => {
    const state = new CognitiveState();
    state.beginTask("task-A", "t");
    state.beginTask("task-B", "t");

    state.setVerificationResultFor("task-A", "fail");
    state.setVerificationResultFor("task-B", "pass");

    expect(state.snapshotForTask("task-A")?.verificationResult).toBe("fail");
    expect(state.snapshotForTask("task-B")?.verificationResult).toBe("pass");
  });

  it("mode is still system-wide, and says so rather than pretending to be per-task", () => {
    const state = new CognitiveState();
    state.setMode("planning", "task A planning");
    state.setMode("executing", "task B executing");
    // Honest for a single engine instance: one process is in one mode.
    expect(state.snapshot().mode).toBe("executing");
  });
});

describe("the flat view is derived, not a second store", () => {
  it("names the task it describes", () => {
    const state = new CognitiveState();
    expect(state.focusedTask()).toBeNull();
    state.beginTask("task-A", "t");
    expect(state.focusedTask()).toBe("task-A");
  });

  it("a background task writing its goal does not replace the focused task's", () => {
    const state = new CognitiveState();
    state.beginTask("task-A", "t");
    state.setActiveGoalFor("task-A", goal("goal-A"));
    state.beginTask("task-B", "t");
    // Focus moves to the newest task, so make A the focus again explicitly by
    // ending B: an operator looking at the dashboard is looking at A.
    state.endTask("task-B");
    expect(state.focusedTask()).toBe("task-A");

    state.setActiveGoalFor("task-B", goal("goal-B"));
    expect(state.snapshot().activeGoal?.id).toBe("goal-A");
    expect(state.snapshotForTask("task-B")?.goal?.id).toBe("goal-B");
  });

  it("focus moves off a finished task instead of reporting a dead goal", () => {
    const state = new CognitiveState();
    state.beginTask("task-A", "t");
    state.setActiveGoalFor("task-A", goal("goal-A"));
    state.beginTask("task-B", "t");
    state.setActiveGoalFor("task-B", goal("goal-B"));

    state.endTask("task-B");
    expect(state.focusedTask()).toBe("task-A");
    expect(state.snapshot().activeGoal?.id).toBe("goal-A");

    state.endTask("task-A");
    expect(state.focusedTask()).toBeNull();
    // Nothing is running, so "the active goal" is honestly null rather than the
    // last thing that happened to be written.
    expect(state.snapshot().activeGoal).toBeNull();
    expect(state.snapshot().activePlan).toBeNull();
  });

  it("the plan follows the same rule as the goal", () => {
    const state = new CognitiveState();
    state.beginTask("task-A", "t");
    state.setActivePlanFor("task-A", { id: "plan-A", goalId: "goal-A", currentStep: 0, totalSteps: 3, status: "executing" });
    expect(state.snapshot().activePlan?.id).toBe("plan-A");

    state.beginTask("task-B", "t");
    state.setActivePlanFor("task-B", { id: "plan-B", goalId: "goal-B", currentStep: 0, totalSteps: 1, status: "executing" });
    expect(state.snapshot().activePlan?.id).toBe("plan-B");
    expect(state.snapshotForTask("task-A")?.plan?.id).toBe("plan-A");
  });
});

describe("the real execution path does not depend on the global state", () => {
  it("TaskContext carries per-task state on its own", async () => {
    const { TaskContext } = await import("../src/execution/task-context.js");

    const a = new TaskContext({ tenantId: "t", goal: "Task A" });
    const b = new TaskContext({ tenantId: "t", goal: "Task B" });

    a.memories.push("A-only memory");
    b.memories.push("B-only memory");
    a.attempt = 3;

    // Two concurrent tasks keep their own goal, memory and attempt counter.
    expect(a.goal).toBe("Task A");
    expect(b.goal).toBe("Task B");
    expect(a.memories).toEqual(["A-only memory"]);
    expect(b.memories).toEqual(["B-only memory"]);
    expect(a.attempt).toBe(3);
    expect(b.attempt).toBe(1);
  });

  it("two tasks can run concurrently through the loop without mixing up results", async () => {
    const { UnifiedExecutionLoop } = await import("../src/execution/unified-execution-loop.js");

    const loop = new UnifiedExecutionLoop({
      runAgent: async (context) => {
        // Yield, so the two runs genuinely interleave.
        await new Promise((r) => setTimeout(r, 5));
        return { completed: true, summary: `done: ${context.goal}` };
      },
    });

    const [a, b] = await Promise.all([
      loop.run({ tenantId: "t", goal: "Task A" }),
      loop.run({ tenantId: "t", goal: "Task B" }),
    ]);

    expect(a.goal).toBe("Task A");
    expect(b.goal).toBe("Task B");
    expect(a.goal).not.toBe(b.goal);
  });
});

describe("per-task slots", () => {
  it("running tasks are listable, so 'what is in flight?' has a real answer", () => {
    const state = new CognitiveState();
    state.beginTask("task-A", "t");
    state.beginTask("task-B", "t");
    state.endTask("task-A");

    const running = state.runningTasks().map((t) => t.taskId);
    expect(running).toEqual(["task-B"]);
  });

  it("writing to an unknown task is ignored rather than inventing a slot", () => {
    const state = new CognitiveState();
    state.setVerificationResultFor("never-started", "pass");
    expect(state.snapshotForTask("never-started")).toBeNull();
  });

  it("a failure is attached to a task and still visible system-wide", () => {
    const state = new CognitiveState();
    state.beginTask("task-A", "t");
    state.recordFailureFor("task-A", {
      type: "execution",
      description: "tool call failed",
      subsystem: "test",
      timestamp: Date.now(),
      recoveryAttempted: false,
    });

    // "Why did this task fail?" is answerable…
    expect(state.snapshotForTask("task-A")?.failures).toHaveLength(1);
    // …and so is "what went wrong most recently, anywhere?".
    expect(state.snapshot().lastFailure?.description).toBe("tool call failed");
  });

  it("finished tasks are bounded so the map cannot grow forever", () => {
    const state = new CognitiveState();
    for (let i = 0; i < 120; i++) {
      state.beginTask(`task-${i}`, "t");
      state.endTask(`task-${i}`);
    }
    expect(state.snapshot().taskCount).toBeLessThanOrEqual(100);
  });
});

describe("PlanningEngine keeps concurrent plans apart (the live API path)", () => {
  /** Minimal doubles: only what plan() touches. */
  function makePlanningEngine(state: CognitiveState) {
    let n = 0;
    const planner = {} as never;
    const plannerV2 = {
      createPlan: async () => {
        // Await, so two concurrent plan() calls genuinely interleave.
        await new Promise((r) => setTimeout(r, 5));
        n += 1;
        return { id: `plan-${n}` };
      },
    };
    const goalStack = {
      addGoal: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { id: `goal-${n + 1}` };
      },
    };
    const bus = { emit: async () => undefined };
    return { planner, plannerV2, goalStack, bus, state };
  }

  it("two plans requested at once each keep their own goal", async () => {
    const { PlanningEngine } = await import("../src/aurora/unified-engines.js");
    const state = new CognitiveState();
    const d = makePlanningEngine(state);
    const engine = new PlanningEngine(
      d.planner,
      d.plannerV2 as never,
      d.goalStack as never,
      d.bus as never,
      d.state,
    );

    const [a, b] = await Promise.all([
      engine.plan({ goal: "Task A: add rate limiting", tenantId: "t" }),
      engine.plan({ goal: "Task B: rename a column", tenantId: "t" }),
    ]);

    expect(a.planId).not.toBe(b.planId);

    // Each plan's record survives the other's write.
    const slotA = state.snapshotForTask(a.planId);
    const slotB = state.snapshotForTask(b.planId);
    expect(slotA?.goal?.title).toBe("Task A: add rate limiting");
    expect(slotB?.goal?.title).toBe("Task B: rename a column");

    // The flat view resolves, and it says whose it is: the focused task is one
    // of the two plans, and its goal matches the slot for that same id.
    const focused = state.focusedTask();
    expect([a.planId, b.planId]).toContain(focused);
    expect(state.snapshot().activeGoal?.id).toBe(state.snapshotForTask(focused!)?.goal?.id);
  });
});
