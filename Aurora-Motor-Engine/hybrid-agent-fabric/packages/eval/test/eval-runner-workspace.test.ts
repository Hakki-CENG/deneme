/**
 * The eval runner must hand the agent the same workspace it later grades.
 *
 * Before this was wired, `setupWorkspace()` seeded files into
 * `.workspaces/<taskId>` and then created a session with no `workspacePath`.
 * The agent therefore worked somewhere else entirely, while the grader looked
 * at the process directory — so every file-based task was unwinnable, and a
 * criterion could pass on an unrelated repository file.
 *
 * These tests pin the contract: seed → same path to the session → same path to
 * the grader → graded exactly once.
 */

import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EvalRunner } from "../src/runner/eval-runner.js";
import type { EvalTask } from "../src/tasks/types.js";

const WORKSPACE_DIR = resolve("packages/eval/.workspaces-test");

const BUDGET = { maxTokens: 10_000, maxSteps: 20, maxCostUsd: 1, timeoutMs: 5_000 };

function task(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: "workspace-wiring",
    name: "workspace wiring",
    category: "tool_use",
    instruction: "Write hello.txt",
    workspace: { files: [{ path: "seed.txt", content: "seeded\n" }] },
    acceptance: [{ type: "property", fileExists: "hello.txt", fileContentContains: ["hello world"] }],
    budget: BUDGET,
    difficulty: 1,
    ...overrides,
  };
}

/**
 * A fake engine that records what it was given and, optionally, does the work
 * the task asks for. Using a fake keeps the test about the wiring; the real
 * agent path is covered by the engine package's own integration tests.
 */
function fakeEngine(options: { solve?: boolean } = {}) {
  const createSession = vi.fn(async (input: { workspacePath?: string }) => {
    if (options.solve && input.workspacePath) {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(input.workspacePath, { recursive: true });
      await writeFile(join(input.workspacePath, "hello.txt"), "hello world\n");
    }
    return { sessionId: "session-1", status: "idle" };
  });

  return {
    createSession,
    command: vi.fn(async () => ({ ok: true })),
    readEvents: vi.fn(async () => [{ kind: "session.completed", payload: {} }]),
    session: vi.fn(async () => ({ status: "idle" })),
  };
}

afterEach(async () => {
  await rm(WORKSPACE_DIR, { recursive: true, force: true });
});

describe("the seeded workspace reaches the agent", () => {
  it("passes the task's workspace path to createSession", async () => {
    const engine = fakeEngine();
    const runner = new EvalRunner(engine as never, {
      workspaceDir: WORKSPACE_DIR,
      verbose: false,
      saveTrajectories: false,
    });

    await runner.runTask(task());

    const [input] = engine.createSession.mock.calls[0] ?? [];
    expect(input?.workspacePath).toBe(join(WORKSPACE_DIR, "workspace-wiring"));
    // And the seed file really is there for the agent to find.
    expect(await readFile(join(WORKSPACE_DIR, "workspace-wiring", "seed.txt"), "utf8")).toBe("seeded\n");
  });

  it("omits workspacePath for tasks that declare no workspace", async () => {
    const engine = fakeEngine();
    const runner = new EvalRunner(engine as never, {
      workspaceDir: WORKSPACE_DIR,
      verbose: false,
      saveTrajectories: false,
    });

    const noWorkspace = task({ workspace: undefined, acceptance: [{ type: "trajectory", requiredEvents: [] }] });
    await runner.runTask(noWorkspace);

    const [input] = engine.createSession.mock.calls[0] ?? [];
    expect(input?.workspacePath).toBeUndefined();
  });
});

describe("grading judges that same workspace", () => {
  it("passes when the work was really done there", async () => {
    const runner = new EvalRunner(fakeEngine({ solve: true }) as never, {
      workspaceDir: WORKSPACE_DIR,
      verbose: false,
      saveTrajectories: false,
    });

    const result = await runner.runTask(task());

    expect(result.status).toBe("pass");
    expect(result.score).toBe(1);
  });

  it("fails when the agent did nothing", async () => {
    const runner = new EvalRunner(fakeEngine({ solve: false }) as never, {
      workspaceDir: WORKSPACE_DIR,
      verbose: false,
      saveTrajectories: false,
    });

    const result = await runner.runTask(task());

    expect(result.status).toBe("fail");
    expect(result.score).toBe(0);
    expect(result.grades[0]?.details).toContain("hello.txt");
  });

  it("does not credit a criterion that names a repository file", async () => {
    const runner = new EvalRunner(fakeEngine({ solve: false }) as never, {
      workspaceDir: WORKSPACE_DIR,
      verbose: false,
      saveTrajectories: false,
    });

    // package.json exists at the repo root; it must not satisfy the task.
    const result = await runner.runTask(
      task({ acceptance: [{ type: "property", fileExists: "package.json" }] }),
    );

    expect(result.status).toBe("fail");
  });
});

describe("the workspace is clean for every run", () => {
  it("removes a previous run's output before seeding", async () => {
    const runner = new EvalRunner(fakeEngine({ solve: true }) as never, {
      workspaceDir: WORKSPACE_DIR,
      verbose: false,
      saveTrajectories: false,
    });

    const first = await runner.runTask(task());
    expect(first.status).toBe("pass");

    // Re-run with an engine that does nothing: last run's hello.txt must not
    // be mistaken for this run's work.
    const lazy = new EvalRunner(fakeEngine({ solve: false }) as never, {
      workspaceDir: WORKSPACE_DIR,
      verbose: false,
      saveTrajectories: false,
    });
    const second = await lazy.runTask(task());

    expect(second.status).toBe("fail");
    expect(existsSync(join(WORKSPACE_DIR, "workspace-wiring", "hello.txt"))).toBe(false);
  });
});

describe("acceptance commands run once", () => {
  it("does not execute acceptance commands twice per task", async () => {
    const runner = new EvalRunner(fakeEngine({ solve: true }) as never, {
      workspaceDir: WORKSPACE_DIR,
      verbose: false,
      saveTrajectories: false,
    });

    // Appends a line each time it runs; a double-grade would write two.
    const counted = task({
      acceptance: [
        { type: "command", command: "echo ran >> ran.log && cat ran.log", outputContains: ["ran"] },
      ],
    });

    const result = await runner.runTask(counted);
    expect(result.status).toBe("pass");

    const log = await readFile(join(WORKSPACE_DIR, "workspace-wiring", "ran.log"), "utf8");
    expect(log.trim().split("\n")).toHaveLength(1);
  });
});
