/**
 * B1 (P1.1): a task's identity travels with it.
 *
 * What was measured before this existed. `TaskContextInit` carried tenant, goal,
 * id, session, workspace, constraints, budget and a correlation id — and nothing
 * else. Of the identity P1.1 demands for every task ("ID, tenant, user, parent
 * task, deadline, budget, priority, provenance"), four were missing entirely
 * (user, parent task, deadline-as-an-instant, priority) and provenance existed
 * only as `correlationId`, which ties a task to a trace but says nothing about
 * which surface produced the task. The report did not even carry the tenant: it
 * crossed process boundaries — serialized into API responses — as a thing that
 * had to be told its tenant out of band.
 */
import { describe, expect, it } from "vitest";

import { UnifiedExecutionLoop } from "../src/execution/unified-execution-loop.js";
import type { TaskProvenance } from "../src/execution/task-context.js";

const runAgent = async () => ({ completed: true, summary: "done" });

describe("task identity (P1.1 / B1)", () => {
  it("carries who asked, parentage, class, deadline and provenance to the report", async () => {
    const provenance: TaskProvenance = { surface: "channel", ref: "telegram:4242" };
    const loop = new UnifiedExecutionLoop({ runAgent });

    const report = await loop.run({
      tenantId: "tenant-a",
      goal: "Summarise the channel question",
      userId: "user-7",
      parentTaskId: "task-root-1",
      priority: "P2",
      deadline: "2026-09-25T17:00:00.000Z",
      provenance,
    });

    expect(report.tenantId).toBe("tenant-a");
    expect(report.userId).toBe("user-7");
    expect(report.parentTaskId).toBe("task-root-1");
    expect(report.priority).toBe("P2");
    expect(report.deadline).toBe("2026-09-25T17:00:00.000Z");
    expect(report.provenance).toEqual(provenance);
  });

  it("does not invent identity a task was not given", async () => {
    const loop = new UnifiedExecutionLoop({ runAgent });

    const report = await loop.run({ tenantId: "t", goal: "g" });

    // Absent means absent — "the tenant" is not a user, and a task with no
    // deadline must not read as if someone had set one.
    expect(report.userId).toBeUndefined();
    expect(report.parentTaskId).toBeUndefined();
    expect(report.priority).toBeUndefined();
    expect(report.deadline).toBeUndefined();
    expect(report.provenance).toBeUndefined();
    // The tenant, by contrast, is always known: the primitive cannot run a
    // task for nobody.
    expect(report.tenantId).toBe("t");
  });

  it("keeps a deadline and a time budget as the different constraints they are", async () => {
    const loop = new UnifiedExecutionLoop({ runAgent });

    const report = await loop.run({
      tenantId: "t",
      goal: "g",
      // "You may spend 10 minutes" and "the user needs it by 17:00" are both
      // set here, and both survive — the report does not collapse one into
      // the other.
      budget: { timeMs: 600_000 },
      deadline: "2026-09-25T17:00:00.000Z",
    });

    expect(report.deadline).toBe("2026-09-25T17:00:00.000Z");
    expect(report.spend).toBeDefined();
  });

  it("task.received carries the identity for trace consumers", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const loop = new UnifiedExecutionLoop({
      runAgent,
      emit: async (event) => {
        events.push({ type: event.type, payload: event.payload as Record<string, unknown> });
      },
    });

    await loop.run({
      tenantId: "t",
      goal: "g",
      userId: "user-7",
      parentTaskId: "task-root-1",
      priority: "P2",
      deadline: "2026-09-25T17:00:00.000Z",
      provenance: { surface: "scheduler", ref: "automation-9" },
    });

    const received = events.find((event) => event.type === "task.received");
    expect(received).toBeDefined();
    expect(received?.payload.userId).toBe("user-7");
    expect(received?.payload.parentTaskId).toBe("task-root-1");
    expect(received?.payload.priority).toBe("P2");
    expect(received?.payload.deadline).toBe("2026-09-25T17:00:00.000Z");
    expect(received?.payload.provenance).toEqual({ surface: "scheduler", ref: "automation-9" });
  });
});
