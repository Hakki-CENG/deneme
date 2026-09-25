/**
 * P1, second half: does a lesson from one task actually reach the next one?
 *
 * The write side exists (`learn` stores a memory) and the read side exists
 * (`recall` queries by goal text). What was never tested is the loop closing:
 * task A fails, the failure is written down, task B on the same subject starts
 * and the agent is *told* about it.
 *
 * A learning loop that writes memories nobody reads is bookkeeping. These
 * tests pin the whole path: store → recall → briefing.
 */
import { describe, expect, it } from "vitest";
import { UnifiedExecutionLoop } from "../src/execution/unified-execution-loop.js";
import { buildAgentBriefing } from "../src/execution/session-agent-adapter.js";
import { TaskContext } from "../src/execution/task-context.js";

/** Minimal memory store with the same shape the engine's hooks use. */
function makeMemory() {
  const rows: { content: string; importance: number; category: string }[] = [];
  return {
    rows,
    store: async (content: string, importance: number, category: string) => {
      rows.push({ content, importance, category });
    },
    recall: async (text: string) => {
      // Crude term overlap, standing in for the real recall.
      const terms = text.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
      return rows
        .filter((row) => terms.some((term) => row.content.toLowerCase().includes(term)))
        .map((row) => row.content);
    },
  };
}

describe("a lesson from one task reaches the next", () => {
  it("a failure is written down and recalled into the next task's briefing", async () => {
    const memory = makeMemory();
    const briefings: string[] = [];

    const makeLoop = (behaviour: () => Promise<{ completed: boolean; summary: string; error?: string }>) =>
      new UnifiedExecutionLoop(
        {
          runAgent: async (context) => {
            briefings.push(buildAgentBriefing(context));
            return behaviour();
          },
          recall: async (context) => memory.recall(context.goal),
          learn: async (context, report) => {
            if (report.status === "succeeded") return;
            await memory.store(
              `Goal: ${context.goal}. The postgres migration fails unless the connection pool is drained first.`,
              0.5,
              "task-failure",
            );
          },
        },
        { maxAttempts: 1 },
      );

    // Task A fails and records why.
    await makeLoop(async () => ({
      completed: false,
      summary: "migration failed",
      error: "ECONNREFUSED postgres",
    })).run({ tenantId: "t", goal: "Run the postgres migration" });

    expect(memory.rows).toHaveLength(1);

    // Task B, same subject, later.
    await makeLoop(async () => ({ completed: true, summary: "done" })).run({
      tenantId: "t",
      goal: "Run the postgres migration again",
    });

    expect(briefings).toHaveLength(2);
    // The first task knew nothing...
    expect(briefings[0]).not.toMatch(/connection pool/i);
    // ...the second one was told.
    expect(briefings[1]).toMatch(/connection pool/i);
    expect(briefings[1]).toContain("RELEVANT MEMORY");
  });

  it("an unrelated goal does not drag in the lesson", async () => {
    const memory = makeMemory();
    await memory.store(
      "Goal: Run the postgres migration. Drain the connection pool first.",
      0.5,
      "task-failure",
    );

    const briefings: string[] = [];
    const loop = new UnifiedExecutionLoop({
      runAgent: async (context) => {
        briefings.push(buildAgentBriefing(context));
        return { completed: true, summary: "ok" };
      },
      recall: async (context) => memory.recall(context.goal),
    });

    await loop.run({ tenantId: "t", goal: "Update the frontend button colour" });

    // Recall must not staple every past lesson onto every future task.
    expect(briefings[0]).not.toMatch(/connection pool/i);
    expect(briefings[0]).not.toContain("RELEVANT MEMORY");
  });

  it("learning never turns a failed task into a successful one", async () => {
    let learnCalled = false;

    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async () => ({
          completed: false,
          summary: "failed",
          error: "npm run build: exit code 1",
        }),
        learn: async () => {
          learnCalled = true;
          // A learning step that succeeds must not launder the task's status.
        },
      },
      { maxAttempts: 1 },
    );

    const report = await loop.run({ tenantId: "t", goal: "Fix the build" });

    expect(learnCalled).toBe(true);
    expect(report.status).not.toBe("succeeded");
  });

  it("a failing learn step does not fail the task", async () => {
    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async () => ({ completed: true, summary: "done" }),
        // The hook is `verifiersFor`, returning real Verifier objects — the
        // loop owns the factory, callers only supply checks.
        verifiersFor: async () => [
          {
            name: "always-passes",
            tier: "V2_empirical" as const,
            run: async () => ({ verdict: "pass" as const, evidence: "checked" }),
          },
        ],
        learn: async () => {
          throw new Error("memory backend down");
        },
      },
      { maxAttempts: 1 },
    );

    // A degraded memory backend is not a failed task.
    const report = await loop.run({ tenantId: "t", goal: "Do the thing" });
    expect(report.status).toBe("succeeded");
  });
});

describe("recalled memory is bounded and honest in the briefing", () => {
  it("caps how much memory is pasted in, so the goal is not buried", () => {
    const context = new TaskContext({ tenantId: "t", goal: "Ship the feature" });
    for (let i = 0; i < 40; i++) {
      context.memories.push(`Lesson ${i}: ${"x".repeat(2000)}`);
    }

    const briefing = buildAgentBriefing(context);

    expect(briefing.length).toBeLessThan(8000);
    // The goal must still be the first thing read.
    expect(briefing.indexOf("Ship the feature")).toBeLessThan(50);
  });

  it("writes no memory section at all when nothing was recalled", () => {
    const context = new TaskContext({ tenantId: "t", goal: "Ship the feature" });
    const briefing = buildAgentBriefing(context);

    // An empty "RELEVANT MEMORY:" heading invites the model to invent one.
    expect(briefing).not.toContain("RELEVANT MEMORY");
  });
});
