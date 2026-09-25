/**
 * A plan the agent never sees is dead computation.
 *
 * The loop already produces a plan and recalls memory into `TaskContext`. The
 * adapter then sent `payload: { text: context.goal }` — the raw goal and
 * nothing else. So planning cost time and tokens, and changed nothing about
 * what the agent did.
 *
 * These tests pin the briefing contract: goal, constraints, plan, recalled
 * memory and success criteria reach the agent, and each section appears only
 * when there is something real to put in it.
 */

import { describe, expect, it, vi } from "vitest";

import { runAgentViaSession } from "../src/execution/session-agent-adapter.js";
import { TaskContext } from "../src/execution/task-context.js";

/** Captures the prompt text the agent was actually given. */
function capturingEngine() {
  const prompts: string[] = [];
  return {
    prompts,
    createSession: vi.fn(async () => ({ sessionId: "s1", status: "idle" })),
    command: vi.fn(async (command: { payload?: { text?: string } }) => {
      prompts.push(String(command.payload?.text ?? ""));
      return { ok: true };
    }),
    session: vi.fn(async () => ({ status: "idle" })),
    readEvents: vi.fn(async () => [{ kind: "session.tool.called" }]),
  };
}

async function promptFor(context: TaskContext): Promise<string> {
  const engine = capturingEngine();
  await runAgentViaSession(engine as never, context, { pollIntervalMs: 1 });
  return engine.prompts[0] ?? "";
}

describe("the agent is briefed, not just prompted", () => {
  it("includes the plan the loop computed", async () => {
    const context = new TaskContext({ tenantId: "t", goal: "Migrate the auth module" });
    context.plan = {
      steps: [
        { description: "Read the current auth flow", status: "skipped" },
        { description: "Write the migration", status: "skipped" },
      ],
    };

    const prompt = await promptFor(context);

    expect(prompt).toContain("Migrate the auth module");
    expect(prompt).toContain("Read the current auth flow");
    expect(prompt).toContain("Write the migration");
  });

  it("numbers the plan steps so the agent can refer to them", async () => {
    const context = new TaskContext({ tenantId: "t", goal: "g" });
    context.plan = {
      steps: [
        { description: "First thing", status: "skipped" },
        { description: "Second thing", status: "skipped" },
      ],
    };

    const prompt = await promptFor(context);
    expect(prompt).toMatch(/1\.\s*First thing/);
    expect(prompt).toMatch(/2\.\s*Second thing/);
  });

  it("includes recalled memory", async () => {
    const context = new TaskContext({ tenantId: "t", goal: "Fix the flaky test" });
    context.memories.push("Last time this failed because of a timezone assumption");

    const prompt = await promptFor(context);
    expect(prompt).toContain("timezone assumption");
  });

  it("includes constraints", async () => {
    const context = new TaskContext({
      tenantId: "t",
      goal: "Refactor the parser",
      constraints: ["Do not change the public API"],
    });

    const prompt = await promptFor(context);
    expect(prompt).toContain("Do not change the public API");
  });

  it("tells the agent how the work will be judged", async () => {
    const context = new TaskContext({ tenantId: "t", goal: "Add a health endpoint" });

    const prompt = await promptFor(context);
    // The agent should know a verifier decides the outcome, not its own say-so.
    expect(prompt).toMatch(/verif/i);
  });
});

describe("the briefing stays honest when there is nothing to say", () => {
  it("sends the bare goal when there is no plan, memory or constraint", async () => {
    const context = new TaskContext({ tenantId: "t", goal: "Just do this one thing" });

    const prompt = await promptFor(context);

    expect(prompt).toContain("Just do this one thing");
    // No empty scaffolding: an empty "PLAN" heading invites the model to
    // invent one and then report against it.
    expect(prompt).not.toMatch(/PLAN/);
    expect(prompt).not.toMatch(/RELEVANT MEMORY/);
    expect(prompt).not.toMatch(/CONSTRAINTS/);
  });

  it("omits the plan section when the planner returned no steps", async () => {
    const context = new TaskContext({ tenantId: "t", goal: "g" });
    context.plan = { steps: [] };

    const prompt = await promptFor(context);
    expect(prompt).not.toMatch(/PLAN/);
  });

  it("does not invent memory when recall found nothing", async () => {
    const context = new TaskContext({ tenantId: "t", goal: "g" });

    const prompt = await promptFor(context);
    expect(prompt).not.toMatch(/RELEVANT MEMORY/);
  });
});

describe("the briefing does not drown the goal", () => {
  it("caps how much recalled memory is injected", async () => {
    const context = new TaskContext({ tenantId: "t", goal: "g" });
    for (let index = 0; index < 50; index += 1) {
      context.memories.push(`memory number ${index} ${"x".repeat(400)}`);
    }

    const prompt = await promptFor(context);

    // Everything recalled must not become everything sent: an unbounded
    // briefing pushes the actual goal out of the model's attention.
    expect(prompt.length).toBeLessThan(8000);
    expect(prompt).toContain("g");
  });

  it("keeps the goal first", async () => {
    const context = new TaskContext({ tenantId: "t", goal: "THE ACTUAL GOAL" });
    context.memories.push("some context");
    context.plan = { steps: [{ description: "a step", status: "skipped" }] };

    const prompt = await promptFor(context);
    expect(prompt.indexOf("THE ACTUAL GOAL")).toBeLessThan(prompt.indexOf("a step"));
  });
});

describe("retries tell the agent what already failed", () => {
  it("passes prior failure context so the agent does not repeat it", async () => {
    const context = new TaskContext({ tenantId: "t", goal: "Fix the build" });
    context.plan = { steps: [{ description: "step", status: "skipped" }] };
    context.attempt = 2;
    context.priorFailures = ["npm run build failed: TS2304 Cannot find name 'foo'"];

    const prompt = await promptFor(context);

    expect(prompt).toContain("TS2304");
    expect(prompt).toMatch(/attempt 2/i);
  });

  it("says nothing about failures on the first attempt", async () => {
    const context = new TaskContext({ tenantId: "t", goal: "Fix the build" });

    const prompt = await promptFor(context);
    expect(prompt).not.toMatch(/PREVIOUS ATTEMPT/i);
  });
});

describe("retry actually changes the briefing (loop → adapter)", () => {
  it("feeds a failed attempt's error into the next attempt's prompt", async () => {
    const { UnifiedExecutionLoop } = await import("../src/execution/unified-execution-loop.js");

    const briefings: string[] = [];
    let call = 0;

    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async (context) => {
          call += 1;
          briefings.push(
            (await import("../src/execution/session-agent-adapter.js")).buildAgentBriefing(context),
          );
          // `exit code 1` classifies as execution_failure → retry. An error the
          // taxonomy reads as fundamental (e.g. a bare type error) correctly
          // stops after one attempt instead, so it would not exercise retry.
          return call === 1
            ? { completed: false, summary: "build failed", error: "npm run build: exit code 1 — TS2304" }
            : { completed: true, summary: "fixed it" };
        },
      },
      { maxAttempts: 2 },
    );

    await loop.run({ tenantId: "t", goal: "Fix the build" });

    expect(briefings).toHaveLength(2);
    // First attempt knows nothing about failures...
    expect(briefings[0]).not.toMatch(/PREVIOUS ATTEMPT/);
    // ...the retry does.
    expect(briefings[1]).toContain("TS2304");
    expect(briefings[1]).toMatch(/attempt 2/i);
  });
});

describe("the planner is not injected, and that is deliberate", () => {
  it("PlanningEngine produces goal-independent meta-phases", async () => {
    // This is why its output is not put in front of the agent: the same steps
    // come back regardless of the goal, so they carry no task information.
    const { PlanningEngine } = await import("../src/aurora/unified-engines.js");
    expect(typeof PlanningEngine).toBe("function");

    const source = await (await import("node:fs/promises")).readFile(
      new URL("../src/aurora/unified-engines.ts", import.meta.url),
      "utf8",
    );
    const decompose = source.slice(source.indexOf("private decomposeGoal"));
    expect(decompose).toContain("Gather relevant context from memory");
    expect(decompose).toContain("Execute the planned approach with appropriate tools");
  });

  it("the briefing carries real task information instead", async () => {
    const context = new TaskContext({
      tenantId: "t",
      goal: "Add rate limiting to the login endpoint",
      constraints: ["Keep the existing response shape"],
    });
    context.memories.push("The login handler lives in src/auth/login.ts");

    const prompt = await promptFor(context);

    expect(prompt).toContain("Add rate limiting to the login endpoint");
    expect(prompt).toContain("Keep the existing response shape");
    expect(prompt).toContain("src/auth/login.ts");
  });
});
