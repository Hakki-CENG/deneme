/**
 * The grader must judge the task's workspace — not the directory the runner
 * happens to be started from.
 *
 * Core tasks state their acceptance criteria as workspace-relative paths
 * (`fileExists: "hello.txt"`, `command: "cat port.txt"`). If the grader
 * resolves those against `process.cwd()` it grades the repository root, so a
 * correctly solved task is marked failed — and, worse, a task could pass
 * because of an unrelated file that happens to sit in the repo.
 *
 * `criteria-validation.ts` already runs every criterion with `cwd: root`.
 * These tests hold the real runner's grader to the same standard.
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gradeTask } from "../src/graders/grader.js";
import type { EvalTask } from "../src/tasks/types.js";

let workspace: string;

const BUDGET = { maxTokens: 1000, maxSteps: 10, maxCostUsd: 1, timeoutMs: 10_000 };

function task(acceptance: EvalTask["acceptance"]): EvalTask {
  return {
    id: "grader-workspace",
    name: "workspace-relative grading",
    category: "tool_use",
    instruction: "irrelevant",
    acceptance,
    budget: BUDGET,
    difficulty: 1,
  };
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "haf-grader-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("property criteria resolve against the task workspace", () => {
  it("passes when the solved file exists in the workspace", async () => {
    await writeFile(join(workspace, "hello.txt"), "hello world\n");

    const [grade] = await gradeTask(
      task([{ type: "property", fileExists: "hello.txt", fileContentContains: ["hello world"] }]),
      [],
      undefined,
      { workspacePath: workspace },
    );

    expect(grade?.passed).toBe(true);
  });

  it("fails when the file is missing from the workspace", async () => {
    const [grade] = await gradeTask(
      task([{ type: "property", fileExists: "hello.txt" }]),
      [],
      undefined,
      { workspacePath: workspace },
    );

    expect(grade?.passed).toBe(false);
    expect(grade?.details).toContain("hello.txt");
  });

  it("does not credit a same-named file sitting in the process directory", async () => {
    // `package.json` exists at the repo root but NOT in the task workspace.
    // Resolving against process.cwd() would wrongly pass this.
    const [grade] = await gradeTask(
      task([{ type: "property", fileExists: "package.json" }]),
      [],
      undefined,
      { workspacePath: workspace },
    );

    expect(grade?.passed).toBe(false);
  });

  it("refuses paths that escape the workspace", async () => {
    const [grade] = await gradeTask(
      task([{ type: "property", fileExists: "../../etc/passwd" }]),
      [],
      undefined,
      { workspacePath: workspace },
    );

    expect(grade?.passed).toBe(false);
    expect(grade?.details).toMatch(/outside the workspace/i);
  });

  it("reads nested files relative to the workspace", async () => {
    await mkdir(join(workspace, "data"), { recursive: true });
    await writeFile(join(workspace, "data", "one.md"), "one");

    const [grade] = await gradeTask(
      task([{ type: "property", fileExists: "data/one.md", fileContentContains: ["one"] }]),
      [],
      undefined,
      { workspacePath: workspace },
    );

    expect(grade?.passed).toBe(true);
  });
});

describe("command criteria run inside the task workspace", () => {
  it("runs the command with the workspace as its working directory", async () => {
    await writeFile(join(workspace, "port.txt"), "8080\n");

    const [grade] = await gradeTask(
      task([{ type: "command", command: "cat port.txt", outputContains: ["8080"] }]),
      [],
      undefined,
      { workspacePath: workspace },
    );

    expect(grade?.passed).toBe(true);
  });

  it("fails when the command cannot find the file in the workspace", async () => {
    const [grade] = await gradeTask(
      task([{ type: "command", command: "cat port.txt", outputContains: ["8080"] }]),
      [],
      undefined,
      { workspacePath: workspace },
    );

    expect(grade?.passed).toBe(false);
  });
});

describe("grading without a workspace is still honest", () => {
  it("reports that no workspace was supplied rather than grading the repo root", async () => {
    const [grade] = await gradeTask(task([{ type: "property", fileExists: "package.json" }]), [], undefined, {});

    expect(grade?.passed).toBe(false);
    expect(grade?.details).toMatch(/no workspace/i);
  });
});
