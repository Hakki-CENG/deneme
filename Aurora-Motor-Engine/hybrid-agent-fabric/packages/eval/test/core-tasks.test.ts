import { describe, it, expect } from "vitest";

import {
  CORE_EVAL_TASKS,
  CORE_EVAL_SUITE,
  tasksByCategory,
  tasksByDifficulty,
  deterministicTasks,
  suiteSummary,
} from "../src/tasks/core-tasks.js";

/**
 * FAZ 1 gate: "60 eval görevi çalışıyor ve sonuçları kaydediliyor".
 *
 * These tests enforce that the suite is real: enough tasks, unique ids,
 * executable acceptance criteria, and no placeholder expectations.
 */

describe("FAZ 1 gate — core eval suite", () => {
  it("contains at least 60 tasks", () => {
    expect(CORE_EVAL_TASKS.length).toBeGreaterThanOrEqual(60);
  });

  it("gives every task a unique id", () => {
    const ids = CORE_EVAL_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every task at least one acceptance criterion", () => {
    for (const task of CORE_EVAL_TASKS) {
      expect(task.acceptance.length, `${task.id} has no acceptance criteria`).toBeGreaterThan(0);
    }
  });

  it("gives every acceptance criterion something executable to check", () => {
    for (const task of CORE_EVAL_TASKS) {
      for (const criterion of task.acceptance) {
        const actionable =
          criterion.command !== undefined ||
          criterion.fileExists !== undefined ||
          criterion.fileContentContains !== undefined ||
          criterion.fileContentMatch !== undefined ||
          criterion.requiredEvents !== undefined ||
          criterion.forbiddenEvents !== undefined ||
          criterion.rubric !== undefined ||
          criterion.graders !== undefined;
        expect(actionable, `${task.id} has an empty criterion`).toBe(true);
      }
    }
  });

  it("contains no placeholder expectations", () => {
    const serialised = JSON.stringify(CORE_EVAL_TASKS);
    // The old synthetic generator emitted {"result":"expected"} for every task.
    expect(serialised).not.toContain('"result":"expected"');
  });

  it("gives every task a positive budget", () => {
    for (const task of CORE_EVAL_TASKS) {
      expect(task.budget.maxSteps, `${task.id}`).toBeGreaterThan(0);
      expect(task.budget.timeoutMs, `${task.id}`).toBeGreaterThan(0);
      expect(task.budget.maxTokens, `${task.id}`).toBeGreaterThan(0);
    }
  });

  it("rates every task on the 1-5 difficulty scale", () => {
    for (const task of CORE_EVAL_TASKS) {
      expect(task.difficulty).toBeGreaterThanOrEqual(1);
      expect(task.difficulty).toBeLessThanOrEqual(5);
    }
  });

  it("covers all 11 cognitive categories", () => {
    const categories = new Set(CORE_EVAL_TASKS.map((t) => t.category));
    expect(categories.size).toBe(11);
  });

  it("spans the full difficulty range", () => {
    for (let d = 1; d <= 5; d += 1) {
      expect(tasksByDifficulty(d).length, `no tasks at difficulty ${d}`).toBeGreaterThan(0);
    }
  });

  it("provides a substantial model-free subset for CI", () => {
    const deterministic = deterministicTasks();
    expect(deterministic.length).toBeGreaterThanOrEqual(40);
    expect(deterministic.every((t) => t.requiresModel !== true)).toBe(true);
  });

  it("declares workspace files for every task that references one", () => {
    for (const task of CORE_EVAL_TASKS) {
      if (!task.workspace?.files) continue;
      for (const file of task.workspace.files) {
        expect(file.path.length).toBeGreaterThan(0);
        expect(typeof file.content).toBe("string");
      }
    }
  });

  it("exposes a coherent suite object", () => {
    expect(CORE_EVAL_SUITE.tasks.length).toBe(CORE_EVAL_TASKS.length);
    expect(CORE_EVAL_SUITE.id).toBe("aurora-core");
    expect(CORE_EVAL_SUITE.defaultBudget).toBeDefined();
  });

  it("filters correctly by category", () => {
    const coding = tasksByCategory("coding");
    expect(coding.length).toBeGreaterThan(0);
    expect(coding.every((t) => t.category === "coding")).toBe(true);
  });

  it("summarises the suite consistently", () => {
    const summary = suiteSummary();
    expect(summary.total).toBe(CORE_EVAL_TASKS.length);
    const summed = Object.values(summary.byCategory).reduce((a, b) => a + b, 0);
    expect(summed).toBe(summary.total);
  });
});

describe("security task coverage", () => {
  it("includes a prompt-injection resistance task", () => {
    const security = tasksByCategory("security");
    expect(security.some((t) => t.tags?.includes("injection"))).toBe(true);
  });

  it("includes a verifier-integrity (reward hacking) task", () => {
    const security = tasksByCategory("security");
    expect(security.some((t) => t.tags?.includes("reward-hacking"))).toBe(true);
  });

  it("includes a secret-exfiltration task", () => {
    expect(tasksByCategory("security").some((t) => t.tags?.includes("secrets"))).toBe(true);
  });
});

describe("learning / efficiency coverage", () => {
  it("includes a second-encounter efficiency task", () => {
    expect(
      CORE_EVAL_TASKS.some((t) => t.tags?.includes("second-encounter"))
    ).toBe(true);
  });

  it("includes an honesty task for partial completion", () => {
    expect(
      CORE_EVAL_TASKS.some((t) => t.tags?.includes("outcome-accuracy"))
    ).toBe(true);
  });
});
