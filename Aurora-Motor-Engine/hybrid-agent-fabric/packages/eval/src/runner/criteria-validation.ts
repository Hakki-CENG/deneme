/**
 * Acceptance-Criteria Validation Harness — FAZ 1 gate, second half.
 *
 * The first half of the gate ("60 eval görevi çalışıyor") is about the tasks
 * existing and being well-formed; `test/core-tasks.test.ts` covers that.
 *
 * This file covers the part that actually matters: **are the acceptance
 * criteria discriminative?** A task whose criteria pass no matter what the
 * agent does measures nothing — that is exactly the failure mode that made the
 * old `final-evaluation.ts` benchmark worthless (`expectedOutput: {result:"expected"}`).
 *
 * So for each deterministic task we materialise a scratch workspace and run its
 * criteria twice:
 *
 *   1. **Negative control** — only the task's own seed files (`task.workspace`),
 *      i.e. the state before any work is done. The criteria MUST fail.
 *      If they pass here, the task is vacuous.
 *
 *   2. **Reference solution** — the seed files plus a known-good solution, when
 *      the task set supplies one. The criteria MUST pass. If they fail here,
 *      the criteria are over-constrained or simply broken.
 *
 * This runs with no model and no engine, so it is fast, deterministic and
 * CI-safe, while still producing a real, saved result artifact.
 */

import { execSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { AcceptanceCriteria, EvalTask } from "../tasks/types.js";
import { CORE_EVAL_TASKS, CORE_EVAL_SUITE } from "../tasks/core-tasks.js";
import { REFERENCE_SOLUTIONS } from "../tasks/reference-solutions.js";

/** Outcome of evaluating one criterion. */
export interface CriterionOutcome {
  type: AcceptanceCriteria["type"];
  passed: boolean;
  detail: string;
}

/** Outcome for a single task under one workspace condition. */
export interface ConditionOutcome {
  passed: boolean;
  criteria: CriterionOutcome[];
}

/** Full validation record for one task. */
export interface TaskValidation {
  taskId: string;
  name: string;
  category: string;
  difficulty: number;
  /** Criteria evaluated against the unsolved workspace. Expected: fail. */
  negativeControl: ConditionOutcome;
  /** Criteria evaluated against the reference solution, when one exists. */
  referenceSolution: ConditionOutcome | undefined;
  /**
   * `true` when the task behaved correctly:
   *   - criteria rejected the unsolved workspace, AND
   *   - criteria accepted the reference solution (when supplied).
   */
  discriminative: boolean;
  notes: string[];
}

/** Aggregate report, persisted to `results/`. */
export interface CriteriaValidationReport {
  suiteId: string;
  suiteName: string;
  generatedAt: string;
  totalTasks: number;
  evaluatedTasks: number;
  skippedTasks: number;
  withReferenceSolution: number;
  discriminative: number;
  vacuous: number;
  /** Tasks whose precondition is satisfied on purpose (no-op recognition tests). */
  byDesignNoop: number;
  brokenCriteria: number;
  tasks: TaskValidation[];
}

const COMMAND_TIMEOUT_MS = 20_000;

/** Write a file, creating parent directories as needed. */
async function writeFileDeep(root: string, relativePath: string, content: string): Promise<void> {
  const target = resolve(root, relativePath);
  // Refuse to escape the scratch workspace.
  if (!target.startsWith(resolve(root))) {
    throw new Error(`Refusing to write outside the workspace: ${relativePath}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

/** Materialise the task's seed files into a fresh directory. */
async function seedWorkspace(task: EvalTask, root: string): Promise<void> {
  for (const file of task.workspace?.files ?? []) {
    await writeFileDeep(root, file.path, file.content);
  }
}

/** Evaluate a single acceptance criterion against a workspace. */
async function evaluateCriterion(
  criterion: AcceptanceCriteria,
  root: string,
): Promise<CriterionOutcome> {
  switch (criterion.type) {
    case "command": {
      if (!criterion.command) {
        return { type: criterion.type, passed: false, detail: "no command specified" };
      }
      try {
        const stdout = execSync(criterion.command, {
          cwd: root,
          timeout: COMMAND_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
          env: { ...process.env, NODE_OPTIONS: "" },
        });
        const expectedExit = criterion.exitCode ?? 0;
        if (expectedExit !== 0) {
          return {
            type: criterion.type,
            passed: false,
            detail: `expected exit ${expectedExit} but command succeeded`,
          };
        }
        for (const needle of criterion.outputContains ?? []) {
          if (!stdout.includes(needle)) {
            return { type: criterion.type, passed: false, detail: `output missing ${JSON.stringify(needle)}` };
          }
        }
        for (const needle of criterion.outputNotContains ?? []) {
          if (stdout.includes(needle)) {
            return { type: criterion.type, passed: false, detail: `output contains forbidden ${JSON.stringify(needle)}` };
          }
        }
        return { type: criterion.type, passed: true, detail: "command succeeded" };
      } catch (error) {
        const status = (error as { status?: number }).status;
        const expectedExit = criterion.exitCode ?? 0;
        if (typeof status === "number" && status === expectedExit) {
          return { type: criterion.type, passed: true, detail: `command exited ${status} as expected` };
        }
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        return { type: criterion.type, passed: false, detail: `command failed: ${message}` };
      }
    }

    case "property": {
      if (criterion.fileExists) {
        const target = resolve(root, criterion.fileExists);
        if (!existsSync(target)) {
          return { type: criterion.type, passed: false, detail: `missing file ${criterion.fileExists}` };
        }
      }
      const inspected = criterion.fileExists;
      if (inspected && (criterion.fileContentMatch || criterion.fileContentContains)) {
        const content = await readFile(resolve(root, inspected), "utf8");
        if (criterion.fileContentMatch && !new RegExp(criterion.fileContentMatch).test(content)) {
          return { type: criterion.type, passed: false, detail: `content does not match /${criterion.fileContentMatch}/` };
        }
        for (const needle of criterion.fileContentContains ?? []) {
          if (!content.includes(needle)) {
            return { type: criterion.type, passed: false, detail: `content missing ${JSON.stringify(needle)}` };
          }
        }
      }
      return { type: criterion.type, passed: true, detail: "property satisfied" };
    }

    case "composite": {
      const sub = criterion.graders ?? [];
      if (sub.length === 0) {
        return { type: criterion.type, passed: false, detail: "composite with no sub-graders" };
      }
      for (const child of sub) {
        const outcome = await evaluateCriterion(child, root);
        if (!outcome.passed) {
          return { type: criterion.type, passed: false, detail: `sub-grader failed: ${outcome.detail}` };
        }
      }
      return { type: criterion.type, passed: true, detail: "all sub-graders passed" };
    }

    default:
      // `trajectory` and `judge` need a live run or a model; not statically checkable.
      return { type: criterion.type, passed: false, detail: `${criterion.type} requires a live run` };
  }
}

/** Evaluate every criterion of a task against one workspace state. */
async function evaluateAll(task: EvalTask, root: string): Promise<ConditionOutcome> {
  const criteria: CriterionOutcome[] = [];
  for (const criterion of task.acceptance) {
    criteria.push(await evaluateCriterion(criterion, root));
  }
  return { passed: criteria.length > 0 && criteria.every((item) => item.passed), criteria };
}

/** A task is statically checkable when all its criteria are command/property/composite. */
function staticallyCheckable(task: EvalTask): boolean {
  const ok = (criterion: AcceptanceCriteria): boolean => {
    if (criterion.type === "command" || criterion.type === "property") return true;
    if (criterion.type === "composite") return (criterion.graders ?? []).every(ok);
    return false;
  };
  return task.acceptance.length > 0 && task.acceptance.every(ok);
}

/** Validate a single task. */
export async function validateTask(task: EvalTask): Promise<TaskValidation> {
  const notes: string[] = [];

  // 1. Negative control: seed files only.
  const negativeRoot = await mkdtemp(join(tmpdir(), `eval-neg-${task.id}-`));
  let negativeControl: ConditionOutcome;
  try {
    await seedWorkspace(task, negativeRoot);
    negativeControl = await evaluateAll(task, negativeRoot);
  } finally {
    await rm(negativeRoot, { recursive: true, force: true });
  }

  // Some tasks deliberately start from a state that already satisfies the
  // file-level criteria: they test whether the agent RECOGNISES the no-op
  // instead of doing redundant (or actively harmful) work. For those the
  // discriminating signal is the step budget, not the final file state, so a
  // passing negative control is expected rather than a defect.
  const preconditionSatisfied = (task.tags ?? []).includes("precondition-satisfied");

  if (negativeControl.passed && !preconditionSatisfied) {
    notes.push("VACUOUS: criteria pass on the unsolved workspace — this task measures nothing.");
  }

  if (negativeControl.passed && preconditionSatisfied) {
    notes.push(
      "By design: the precondition is already satisfied; efficiency is scored via expectedSteps/maxSteps.",
    );
  }

  // 2. Reference solution, when the task set supplies one.
  const solution = REFERENCE_SOLUTIONS[task.id];
  let referenceSolution: ConditionOutcome | undefined;

  if (solution) {
    const solvedRoot = await mkdtemp(join(tmpdir(), `eval-ref-${task.id}-`));
    try {
      await seedWorkspace(task, solvedRoot);
      for (const file of solution.files) {
        await writeFileDeep(solvedRoot, file.path, file.content);
      }
      referenceSolution = await evaluateAll(task, solvedRoot);
    } finally {
      await rm(solvedRoot, { recursive: true, force: true });
    }

    if (!referenceSolution.passed) {
      const failed = referenceSolution.criteria.filter((item) => !item.passed).map((item) => item.detail);
      notes.push(`BROKEN: criteria reject the reference solution — ${failed.join("; ")}`);
    }
  } else {
    notes.push("No reference solution supplied; only the negative control was checked.");
  }

  const discriminative =
    (!negativeControl.passed || preconditionSatisfied) &&
    (referenceSolution === undefined || referenceSolution.passed);

  return {
    taskId: task.id,
    name: task.name,
    category: task.category,
    difficulty: task.difficulty,
    negativeControl,
    referenceSolution,
    discriminative,
    notes,
  };
}

/** Validate the whole core suite. */
export async function validateCoreSuite(): Promise<CriteriaValidationReport> {
  const tasks: TaskValidation[] = [];
  let skipped = 0;

  for (const task of CORE_EVAL_TASKS) {
    if (!staticallyCheckable(task)) {
      skipped++;
      continue;
    }
    tasks.push(await validateTask(task));
  }

  const withReferenceSolution = tasks.filter((item) => item.referenceSolution !== undefined).length;
  // Only count tasks that pass unsolved WITHOUT being tagged `precondition-satisfied`.
  const vacuous = tasks.filter(
    (item) => item.negativeControl.passed && item.notes.some((note) => note.startsWith("VACUOUS")),
  ).length;
  const byDesignNoop = tasks.filter(
    (item) => item.negativeControl.passed && item.notes.some((note) => note.startsWith("By design")),
  ).length;
  const brokenCriteria = tasks.filter(
    (item) => item.referenceSolution !== undefined && !item.referenceSolution.passed,
  ).length;

  return {
    suiteId: CORE_EVAL_SUITE.id,
    suiteName: CORE_EVAL_SUITE.name,
    generatedAt: new Date().toISOString(),
    totalTasks: CORE_EVAL_TASKS.length,
    evaluatedTasks: tasks.length,
    skippedTasks: skipped,
    withReferenceSolution,
    discriminative: tasks.filter((item) => item.discriminative).length,
    vacuous,
    byDesignNoop,
    brokenCriteria,
    tasks,
  };
}

/** Render the report as markdown. */
export function formatCriteriaValidationReport(report: CriteriaValidationReport): string {
  const lines: string[] = [];
  lines.push(`# Eval Acceptance-Criteria Validation`);
  lines.push("");
  lines.push(`**Suite:** ${report.suiteName} (\`${report.suiteId}\`)`);
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push("");
  lines.push(
    "Each task's acceptance criteria are run against (1) the unsolved workspace — they must FAIL — " +
      "and (2) a known-good reference solution — they must PASS. This proves the criteria actually " +
      "discriminate, rather than passing regardless of what the agent does.",
  );
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Total tasks in suite | ${report.totalTasks} |`);
  lines.push(`| Statically checkable | ${report.evaluatedTasks} |`);
  lines.push(`| Skipped (need a live run) | ${report.skippedTasks} |`);
  lines.push(`| With reference solution | ${report.withReferenceSolution} |`);
  lines.push(`| **Discriminative** | **${report.discriminative} / ${report.evaluatedTasks}** |`);
  lines.push(`| Vacuous (pass when unsolved) | ${report.vacuous} |`);
  lines.push(`| By-design no-op recognition | ${report.byDesignNoop} |`);
  lines.push(`| Broken (reject the reference) | ${report.brokenCriteria} |`);
  lines.push("");

  const problems = report.tasks.filter((task) => !task.discriminative);
  if (problems.length === 0) {
    lines.push("✅ Every statically checkable task rejected the unsolved workspace, and every task with a reference solution accepted it.");
  } else {
    lines.push(`### ❌ ${problems.length} task(s) need attention`);
    lines.push("");
    lines.push("| Task | Problem |");
    lines.push("|---|---|");
    for (const task of problems) {
      lines.push(`| \`${task.taskId}\` | ${task.notes.join(" ")} |`);
    }
  }
  lines.push("");

  lines.push("### Per-task detail");
  lines.push("");
  lines.push("| Task | Category | Diff | Unsolved rejected | Reference accepted |");
  lines.push("|---|---|---|---|---|");
  for (const task of report.tasks) {
    const rejected = task.negativeControl.passed ? "❌ no" : "✅ yes";
    const accepted =
      task.referenceSolution === undefined ? "— none" : task.referenceSolution.passed ? "✅ yes" : "❌ no";
    lines.push(`| \`${task.taskId}\` | ${task.category} | ${task.difficulty} | ${rejected} | ${accepted} |`);
  }
  lines.push("");

  return lines.join("\n");
}
