/**
 * FAZ 1 gate — second half.
 *
 * `core-tasks.test.ts` proves the tasks exist and are well-formed. This suite
 * proves something stronger and more important: the acceptance criteria are
 * **discriminative**. For every statically checkable task we run its criteria
 * against the unsolved workspace (must fail) and, where a reference solution
 * exists, against a known-good answer (must pass).
 *
 * This is the regression guard for the failure mode that made the previous
 * benchmark meaningless: criteria that pass no matter what the agent does.
 */

import { describe, it, expect } from "vitest";

import {
  validateTask,
  validateCoreSuite,
  formatCriteriaValidationReport,
} from "../src/runner/criteria-validation.js";
import { CORE_EVAL_TASKS } from "../src/tasks/core-tasks.js";
import { REFERENCE_SOLUTIONS } from "../src/tasks/reference-solutions.js";

describe("acceptance criteria are discriminative", () => {
  it("rejects the unsolved workspace and accepts the reference solution for every task", async () => {
    const report = await validateCoreSuite();

    // No task may pass before any work is done, unless it is explicitly a
    // no-op recognition test.
    expect(report.vacuous).toBe(0);

    // No task's criteria may reject a known-good solution.
    expect(report.brokenCriteria).toBe(0);

    // Everything statically checkable must discriminate.
    expect(report.discriminative).toBe(report.evaluatedTasks);
    expect(report.evaluatedTasks).toBeGreaterThanOrEqual(55);

    // Reference solutions must actually be exercised.
    expect(report.withReferenceSolution).toBeGreaterThanOrEqual(10);
  }, 240_000);

  it("produces a saveable markdown report", async () => {
    const report = await validateCoreSuite();
    const markdown = formatCriteriaValidationReport(report);

    expect(markdown).toContain("# Eval Acceptance-Criteria Validation");
    expect(markdown).toContain("Discriminative");
    expect(markdown).toContain(String(report.evaluatedTasks));
  }, 240_000);
});

describe("the validator itself detects bad criteria", () => {
  it("flags a task whose criteria pass on the unsolved workspace", async () => {
    const vacuous = await validateTask({
      id: "synthetic-vacuous",
      category: "coding",
      name: "Vacuous task",
      instruction: "Do something that is never checked.",
      workspace: { files: [{ path: "already.txt", content: "done\n" }] },
      // This passes immediately — exactly the failure mode we guard against.
      acceptance: [{ type: "property", fileExists: "already.txt" }],
      budget: { maxTokens: 100, maxSteps: 1, maxCostUsd: 0.01, timeoutMs: 5_000 },
      difficulty: 1,
    });

    expect(vacuous.negativeControl.passed).toBe(true);
    expect(vacuous.discriminative).toBe(false);
    expect(vacuous.notes.some((note) => note.startsWith("VACUOUS"))).toBe(true);
  }, 30_000);

  it("treats a tagged no-op recognition task as intentional", async () => {
    const byDesign = await validateTask({
      id: "synthetic-precondition",
      category: "planning",
      name: "Already satisfied",
      instruction: "Recognise the work is already done.",
      workspace: { files: [{ path: "done.txt", content: "complete\n" }] },
      acceptance: [{ type: "property", fileExists: "done.txt", fileContentContains: ["complete"] }],
      budget: { maxTokens: 100, maxSteps: 1, maxCostUsd: 0.01, timeoutMs: 5_000 },
      difficulty: 1,
      tags: ["precondition-satisfied"],
    });

    expect(byDesign.negativeControl.passed).toBe(true);
    // Tagged, so it is NOT a defect.
    expect(byDesign.discriminative).toBe(true);
    expect(byDesign.notes.some((note) => note.startsWith("By design"))).toBe(true);
  }, 30_000);

  it("flags criteria that reject a correct solution", async () => {
    const broken = await validateTask({
      id: "coding-001-fizzbuzz",
      category: "coding",
      name: "Impossible criteria",
      instruction: "Create fizzbuzz.js",
      // Demands a file the reference solution never writes, so it must fail.
      acceptance: [{ type: "property", fileExists: "never-created-by-reference.txt" }],
      budget: { maxTokens: 100, maxSteps: 1, maxCostUsd: 0.01, timeoutMs: 5_000 },
      difficulty: 1,
    });

    expect(broken.negativeControl.passed).toBe(false);
    expect(broken.referenceSolution?.passed).toBe(false);
    expect(broken.discriminative).toBe(false);
    expect(broken.notes.some((note) => note.startsWith("BROKEN"))).toBe(true);
  }, 30_000);
});

describe("reference solutions", () => {
  it("only reference real task ids", () => {
    const taskIds = new Set(CORE_EVAL_TASKS.map((task) => task.id));
    for (const id of Object.keys(REFERENCE_SOLUTIONS)) {
      expect(taskIds.has(id)).toBe(true);
    }
  });

  it("write at least one file each", () => {
    for (const [id, solution] of Object.entries(REFERENCE_SOLUTIONS)) {
      expect(solution.files.length, `${id} has no files`).toBeGreaterThan(0);
      for (const file of solution.files) {
        expect(file.path.startsWith("/"), `${id}: absolute path`).toBe(false);
        expect(file.path.includes(".."), `${id}: path traversal`).toBe(false);
        expect(file.content.length).toBeGreaterThan(0);
      }
    }
  });
});
