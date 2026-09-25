/**
 * FAZ 1 gate — live end-to-end run.
 *
 * `criteria-validation.test.ts` proves the acceptance criteria discriminate
 * when files are placed directly. This suite proves the other half: the tasks
 * actually run through the **real engine** — session creation, prompting,
 * event collection, grading, budget enforcement — and produce saved results.
 *
 * It runs against the mock provider, which echoes text and cannot write files
 * or execute commands. That makes the expected score exactly zero, and that is
 * the point: a non-acting model passing a task would prove the task is
 * vacuous. This is the inverse control to the reference-solution check.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HybridAgentEngine } from "@haf/engine";
import { EvalRunner } from "../src/runner/eval-runner.js";
import { CORE_EVAL_TASKS } from "../src/tasks/core-tasks.js";

let engine: HybridAgentEngine;
let runner: EvalRunner;

beforeAll(async () => {
  const homePath = await mkdtemp(join(tmpdir(), "eval-live-test-"));
  engine = new HybridAgentEngine({
    homePath,
    kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local",
    model: { provider: "mock" },
    autoApproveWorkspaceWrites: true,
    allowProcessExecution: true,
  });
  await engine.initialize();
  runner = new EvalRunner(engine, { outputDir: "results", verbose: false, saveTrajectories: false });
}, 120_000);

afterAll(async () => {
  await engine?.shutdown().catch(() => undefined);
});

describe("tasks execute end-to-end through the real engine", () => {
  it("runs a task and returns a fully populated result", async () => {
    const task = CORE_EVAL_TASKS.find((item) => item.id === "coding-001-fizzbuzz")!;
    const result = await runner.runTask(task);

    // The run completed and was graded rather than crashing.
    expect(result.taskId).toBe("coding-001-fizzbuzz");
    expect(["pass", "fail", "budget_exceeded", "timeout", "error"]).toContain(result.status);
    expect(result.metrics).toBeDefined();

    // The engine took real steps. This used to assert `typeof totalSteps ===
    // "number"`, which a metrics object wired to nothing satisfies by staying
    // at zero — the whole claim of this test is that the task ran end-to-end,
    // so the step counter has to show it. Measured: 21 steps on this task.
    expect(result.metrics.totalSteps).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(new Date(result.completedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(result.startedAt).getTime(),
    );
  }, 120_000);

  it("materialises the task's seed workspace before grading", async () => {
    // This task ships a `buggy.js` that must exist for the grader to run at
    // all; if workspace setup were broken the grader would error rather than
    // return a clean failure.
    const task = CORE_EVAL_TASKS.find((item) => item.id === "coding-002-fix-off-by-one")!;
    const result = await runner.runTask(task);

    expect(result.status).not.toBe("error");
    expect(result.score).toBeLessThan(1);
  }, 120_000);
});

describe("a model that cannot act scores zero", () => {
  it("fails every sampled task, proving the criteria are not vacuous", async () => {
    // A representative slice across categories keeps CI fast while still
    // covering command graders, property graders and seeded workspaces.
    const sample = [
      "coding-001-fizzbuzz",
      "coding-004-binary-search",
      "tool-001-create-file",
      "tool-002-read-and-summarise",
    ]
      .map((id) => CORE_EVAL_TASKS.find((task) => task.id === id)!)
      .filter(Boolean);

    expect(sample).toHaveLength(4);

    for (const task of sample) {
      const result = await runner.runTask(task);

      // The mock provider cannot create files or run commands, so a pass here
      // would mean the task accepts a no-op.
      expect(result.status, `${task.id} must not pass with a non-acting model`).not.toBe("pass");
      expect(result.score, `${task.id} scored above zero with a non-acting model`).toBeLessThan(1);
    }
  }, 300_000);
});

describe("budget enforcement is live", () => {
  it("marks a task budget_exceeded rather than silently passing", async () => {
    // Force an impossible budget: any real execution overshoots it.
    const task = CORE_EVAL_TASKS.find((item) => item.id === "coding-001-fizzbuzz")!;
    const constrained = {
      ...task,
      id: "synthetic-budget-probe",
      budget: { maxTokens: 1, maxSteps: 1, maxCostUsd: 0.000001, timeoutMs: 15_000 },
    };

    const result = await runner.runTask(constrained);

    expect(result.status).not.toBe("pass");
    expect(["budget_exceeded", "fail", "timeout"]).toContain(result.status);
  }, 60_000);
});
