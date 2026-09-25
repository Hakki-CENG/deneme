/**
 * B8 (P1.8): the long-horizon task manager.
 *
 * What was measured before this existed: the `DurableScheduler` schedules
 * session prompts and `AutomationService` persists command runs — both durable,
 * neither about tasks. A goal that takes hours or days had no representation at
 * all: `engine.execute()` is a synchronous promise, and a restart lost
 * everything. No pause, no human-approval wait, no escalation, no parent-child
 * linkage, no digest — the eight things P1.8 lists, none of them present.
 *
 * The manager is tested here against a stub executor, so what is asserted is
 * the manager's own behaviour: sequencing, durability, parking, waiting,
 * deadlines, escalation and reporting. The steps' *within* is the execution
 * primitive's business and has its own tests (B1–B7).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LongHorizonTaskManager, type StepExecutor } from "../src/execution/long-horizon-task-manager.js";

interface Launch {
  tenantId: string;
  goal: string;
  parentTaskId: string;
  provenance?: { surface: string; ref?: string | undefined } | undefined;
  userId?: string | undefined;
}

function harness(opts: {
  execute: StepExecutor;
  now?: () => Date;
}): { manager: LongHorizonTaskManager; rootPath: string } {
  const rootPath = mkdtempSync();
  const manager = new LongHorizonTaskManager({
    rootPath,
    execute: opts.execute,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { manager, rootPath };
}

function mkdtempSync(): string {
  // mkdtemp is async; a sync stand-in keeps `harness` non-async.
  const dir = join(tmpdir(), `haf-lht-${process.pid}-${Math.random().toString(36).slice(2)}`);
  return dir;
}

const ok: StepExecutor = async (launch) => ({
  taskId: `child-${launch.goal.slice(0, 8)}`,
  status: "succeeded",
  summary: "done",
});

describe("a long-horizon task is a sequence of real child tasks", () => {
  it("runs its steps in order, linked to the parent, and records each child", async () => {
    const launches: Launch[] = [];
    const { manager } = harness({
      execute: async (launch) => {
        launches.push(launch);
        return { taskId: `child-${launches.length}`, status: "succeeded", summary: "done" };
      },
    });

    const task = await manager.submit({
      tenantId: "t",
      goal: "Roll out the migration over the weekend",
      steps: [{ goal: "prepare the copy" }, { goal: "switch the writes" }, { goal: "retire the old table" }],
      userId: "user-1",
    });
    await manager.tick();
    const done = await manager.get(task.id);

    expect(done?.status).toBe("succeeded");
    expect(launches.map((l) => l.goal)).toEqual(["prepare the copy", "switch the writes", "retire the old table"]);
    // Every child is linked to its parent (P1.8: parent-child tasks) and
    // carries the parent's identity (P1.1) plus its true origin.
    for (const launch of launches) {
      expect(launch.parentTaskId).toBe(task.id);
      expect(launch.userId).toBe("user-1");
      expect(launch.provenance).toEqual({ surface: "background", ref: task.id });
    }
    expect(done?.steps.map((s) => s.childTaskId)).toEqual(["child-1", "child-2", "child-3"]);
  });

  it("runs one task at a time, in submission order", async () => {
    const order: string[] = [];
    const { manager } = harness({
      execute: async (launch) => {
        order.push(`${launch.parentTaskId.slice(0, 7)}:${launch.goal}`);
        return { taskId: "c", status: "succeeded", summary: "" };
      },
    });

    const a = await manager.submit({ tenantId: "t", goal: "A", steps: [{ goal: "a1" }, { goal: "a2" }] });
    const b = await manager.submit({ tenantId: "t", goal: "B", steps: [{ goal: "b1" }] });
    await manager.tick();

    expect(order).toEqual([`${a.id.slice(0, 7)}:a1`, `${a.id.slice(0, 7)}:a2`, `${b.id.slice(0, 7)}:b1`]);
    expect((await manager.get(a.id))?.status).toBe("succeeded");
    expect((await manager.get(b.id))?.status).toBe("succeeded");
  });
});

describe("the queue is durable (P1.8)", () => {
  it("a restart loads the state and continues where the task stood", async () => {
    let clock = new Date("2026-09-24T10:00:00.000Z");
    const launches: string[] = [];
    const rootPath = mkdtempSync();
    const execute: StepExecutor = async (launch) => {
      launches.push(launch.goal);
      return { taskId: `child-${launches.length}`, status: "succeeded", summary: "" };
    };

    const first = new LongHorizonTaskManager({ rootPath, execute, now: () => clock });
    const task = await first.submit({
      tenantId: "t",
      goal: "Index the archive",
      steps: [
        { goal: "first batch" },
        // The second batch is scheduled for an hour out, so the first manager
        // parks the task and "the process dies" right after.
        { goal: "second batch", scheduledFor: "2026-09-24T11:00:00.000Z" },
      ],
    });
    await first.tick();
    expect((await first.get(task.id))?.status).toBe("scheduled");
    expect(launches).toEqual(["first batch"]);

    // A NEW manager instance — a restart — over the same state file.
    const second = new LongHorizonTaskManager({ rootPath, execute, now: () => clock });
    const reloaded = await second.get(task.id);
    expect(reloaded?.status).toBe("scheduled");
    expect(reloaded?.steps[0]?.status).toBe("succeeded");
    expect(reloaded?.steps[0]?.childTaskId).toBe("child-1");

    // Before the scheduled time, ticking does nothing.
    await second.tick();
    expect(launches).toEqual(["first batch"]);

    // Time moves; the continuation runs.
    clock = new Date("2026-09-24T11:30:00.000Z");
    await second.tick();
    expect(launches).toEqual(["first batch", "second batch"]);
    expect((await second.get(task.id))?.status).toBe("succeeded");
  });

  it("a task found running after a restart is re-queued, not trusted", async () => {
    const rootPath = mkdtempSync();
    const first = new LongHorizonTaskManager({ rootPath, execute: ok });
    const task = await first.submit({ tenantId: "t", goal: "g", steps: [{ goal: "s1" }] });
    // Simulate a crash mid-step by writing the running state directly —
    // exactly what the file would contain if the process died between the
    // pre-step persist and the post-step persist.
    const state = JSON.parse(await (await import("node:fs/promises")).readFile(join(rootPath, "long-horizon", "long-horizon-tasks.json"), "utf8")) as { tasks: Array<{ id: string; status: string }> };
    state.tasks[0]!.status = "running";
    await (await import("node:fs/promises")).writeFile(join(rootPath, "long-horizon", "long-horizon-tasks.json"), JSON.stringify(state));

    const second = new LongHorizonTaskManager({ rootPath, execute: ok });
    const requeued = await second.get(task.id);
    // The step may have half-happened; it re-runs under the primitive's
    // idempotency key rather than being counted as done.
    expect(requeued?.status).toBe("queued");
  });
});

describe("pause and resume (P1.8)", () => {
  it("parks between steps — a running step finishes, the next does not start", async () => {
    let manager: LongHorizonTaskManager;
    const launches: string[] = [];
    manager = new LongHorizonTaskManager({
      rootPath: mkdtempSync(),
      execute: async (launch) => {
        launches.push(launch.goal);
        // Pause arrives WHILE the first step is in flight.
        if (launches.length === 1) await manager.pause(taskIdHolder.id!);
        return { taskId: "c", status: "succeeded", summary: "" };
      },
    });
    const taskIdHolder: { id?: string } = {};
    const task = await manager.submit({ tenantId: "t", goal: "g", steps: [{ goal: "s1" }, { goal: "s2" }] });
    taskIdHolder.id = task.id;

    await manager.tick();
    expect(launches).toEqual(["s1"]);
    expect((await manager.get(task.id))?.status).toBe("paused");

    await manager.resume(task.id);
    await manager.tick();
    expect(launches).toEqual(["s1", "s2"]);
    expect((await manager.get(task.id))?.status).toBe("succeeded");
  });

  it("refuses to pause a finished task", async () => {
    const { manager } = harness({ execute: ok });
    const task = await manager.submit({ tenantId: "t", goal: "g", steps: [{ goal: "s1" }] });
    await manager.tick();
    await expect(manager.pause(task.id)).rejects.toThrow("nothing to pause");
  });
});

describe("human approval (P1.8)", () => {
  it("waits before a step that requires approval, then runs it once approved", async () => {
    const launches: string[] = [];
    const { manager } = harness({
      execute: async (launch) => {
        launches.push(launch.goal);
        return { taskId: "c", status: "succeeded", summary: "" };
      },
    });
    const task = await manager.submit({
      tenantId: "t",
      goal: "Drop the old table",
      steps: [{ goal: "verify usage" }, { goal: "drop it", requiresApproval: true }],
    });

    await manager.tick();
    expect(launches).toEqual(["verify usage"]);
    const waiting = await manager.get(task.id);
    expect(waiting?.status).toBe("waiting_approval");
    expect(waiting?.steps[1]?.status).toBe("waiting_approval");

    await manager.approve(task.id, "approved");
    await manager.tick();
    expect(launches).toEqual(["verify usage", "drop it"]);
    expect((await manager.get(task.id))?.status).toBe("succeeded");
  });

  it("a rejection fails the task and leaves the remaining steps not_run", async () => {
    const launches: string[] = [];
    const { manager } = harness({
      execute: async (launch) => {
        launches.push(launch.goal);
        return { taskId: "c", status: "succeeded", summary: "" };
      },
    });
    const task = await manager.submit({
      tenantId: "t",
      goal: "g",
      steps: [{ goal: "s1" }, { goal: "s2", requiresApproval: true }, { goal: "s3" }],
    });

    await manager.tick();
    await manager.approve(task.id, "rejected");
    const failed = await manager.get(task.id);

    expect(failed?.status).toBe("failed");
    expect(launches).toEqual(["s1"]);
    expect(failed?.steps[1]?.status).toBe("not_run");
    expect(failed?.steps[2]?.status).toBe("not_run");
  });
});

describe("deadline awareness (P1.8)", () => {
  it("fails the task without running anything once the deadline is past", async () => {
    const clock = new Date("2026-09-24T12:00:00.000Z");
    const launches: string[] = [];
    const { manager } = harness({
      execute: async (launch) => {
        launches.push(launch.goal);
        return { taskId: "c", status: "succeeded", summary: "" };
      },
      now: () => clock,
    });
    const task = await manager.submit({
      tenantId: "t",
      goal: "g",
      deadline: "2026-09-24T11:00:00.000Z",
      steps: [{ goal: "s1" }, { goal: "s2" }],
    });

    await manager.tick();
    const failed = await manager.get(task.id);

    expect(launches).toEqual([]);
    expect(failed?.status).toBe("failed");
    expect(failed?.steps.every((s) => s.status === "not_run")).toBe(true);
  });
});

describe("failure escalation (P1.8)", () => {
  function failingThen(outcomes: string[]): StepExecutor {
    let call = 0;
    return async (launch) => {
      const status = outcomes[call] ?? "succeeded";
      call += 1;
      return { taskId: `child-${call}`, status, summary: `child ended ${status}` };
    };
  }

  it("abort: the task fails and the remaining steps are not_run", async () => {
    const launches: string[] = [];
    const { manager } = harness({
      execute: async (launch) => {
        launches.push(launch.goal);
        return { taskId: "c", status: "failed", summary: "boom" };
      },
    });
    const task = await manager.submit({
      tenantId: "t",
      goal: "g",
      escalation: "abort",
      steps: [{ goal: "s1" }, { goal: "s2" }],
    });

    await manager.tick();
    const failed = await manager.get(task.id);
    expect(failed?.status).toBe("failed");
    expect(launches).toEqual(["s1"]);
    expect(failed?.steps[1]?.status).toBe("not_run");
    expect(failed?.steps[0]?.childStatus).toBe("failed");
  });

  it("continue: the remaining steps run, and the task does not claim success over recorded failures", async () => {
    const launches: string[] = [];
    const { manager } = harness({
      execute: async (launch) => {
        launches.push(launch.goal);
        const status = launch.goal === "s1" ? "failed" : "succeeded";
        return { taskId: "c", status, summary: "" };
      },
    });
    const task = await manager.submit({
      tenantId: "t",
      goal: "g",
      escalation: "continue",
      steps: [{ goal: "s1" }, { goal: "s2" }],
    });

    await manager.tick();
    const done = await manager.get(task.id);

    expect(launches).toEqual(["s1", "s2"]);
    expect(done?.steps.map((s) => s.status)).toEqual(["failed", "succeeded"]);
    // The honest terminal status: work was dispositioned, but a recorded
    // failure means "succeeded" would be a lie.
    expect(done?.status).toBe("failed");
  });

  it("escalate: a human decides, and approving continues PAST the failed step without re-running it", async () => {
    const launches: string[] = [];
    const { manager } = harness({
      execute: async (launch) => {
        launches.push(launch.goal);
        const status = launches.length === 1 ? "failed" : "succeeded";
        return { taskId: `child-${launches.length}`, status, summary: "" };
      },
    });
    const task = await manager.submit({
      tenantId: "t",
      goal: "g",
      escalation: "escalate",
      steps: [{ goal: "s1" }, { goal: "s2" }, { goal: "s3" }],
    });

    await manager.tick();
    expect(launches).toEqual(["s1"]);
    const waiting = await manager.get(task.id);
    expect(waiting?.status).toBe("waiting_approval");
    expect(waiting?.waitingReason).toContain("a human decides");

    await manager.approve(task.id, "approved");
    await manager.tick();

    // "Approved" meant continue past s1 — not retry it: s1 ran exactly once.
    expect(launches).toEqual(["s1", "s2", "s3"]);
    const done = await manager.get(task.id);
    expect(done?.steps[0]?.status).toBe("failed");
    expect(done?.steps[1]?.status).toBe("succeeded");
    expect(done?.status).toBe("failed");
  });
});

describe("the progress digest (P1.8)", () => {
  it("says where every task stands, with the numbers a human needs", async () => {
    const clock = new Date("2026-09-24T10:00:00.000Z");
    const { manager } = harness({
      execute: async (launch) => {
        const status = launch.goal === "bad" ? "failed" : "succeeded";
        return { taskId: "c", status, summary: "" };
      },
      now: () => clock,
    });

    const waiting = await manager.submit({
      tenantId: "t",
      goal: "Roll out",
      deadline: "2026-09-25T00:00:00.000Z",
      steps: [{ goal: "prepare" }, { goal: "drop", requiresApproval: true }],
    });
    const other = await manager.submit({ tenantId: "other", goal: "Other tenant", steps: [{ goal: "x" }] });

    await manager.tick();

    const digests = await manager.digest("t");
    expect(digests.length).toBe(1);
    const d = digests[0]!;
    expect(d.taskId).toBe(waiting.id);
    expect(d.status).toBe("waiting_approval");
    expect(d.steps).toEqual({ total: 2, succeeded: 1, failed: 0, pending: 1 });
    expect(d.nextStep).toBe("drop");
    expect(d.deadline).toBe("2026-09-25T00:00:00.000Z");
    expect(d.waitingReason).toContain("approval");

    // Tenant isolation in the digest, as everywhere else.
    expect((await manager.digest("other"))[0]?.goal).toBe("Other tenant");
    void other;
  });
});
