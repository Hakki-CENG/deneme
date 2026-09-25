/**
 * Task Grader
 * Grades eval task results against acceptance criteria.
 */

import { resolve, sep } from "node:path";

import type { HybridAgentEngine } from "@haf/engine";
import type {
  EvalTask,
  AcceptanceCriteria,
  GradeResult,
  TrajectoryEvent,
} from "../tasks/types.js";

/**
 * Where the criteria are evaluated.
 *
 * Tasks state their criteria as workspace-relative paths (`fileExists:
 * "hello.txt"`, `command: "cat port.txt"`). Grading those against
 * `process.cwd()` judges the repository instead of the task: a solved task
 * looks failed, and — far worse — a criterion can pass because of an unrelated
 * file that happens to exist in the repo (`package.json`, `README.md`).
 * `criteria-validation.ts` already runs every criterion with `cwd: root`;
 * the real runner must do the same.
 */
export interface GradingContext {
  /** Absolute path of the task's scratch workspace. */
  workspacePath?: string | undefined;
}

/** A criterion path that could not be used, with the reason. */
interface ResolvedPath {
  absolute?: string;
  error?: string;
}

/**
 * Resolve a task-relative path inside the workspace.
 *
 * Refuses to grade when no workspace was supplied rather than silently falling
 * back to `process.cwd()`, and refuses paths that escape the workspace — a
 * criterion reaching for `../../etc/passwd` is a broken task, not a pass.
 */
function resolveInWorkspace(context: GradingContext, relativePath: string): ResolvedPath {
  const root = context.workspacePath;
  if (!root) {
    return {
      error:
        "No workspace was supplied to the grader, so file criteria cannot be checked. " +
        "Pass the task's workspace path instead of grading the process directory.",
    };
  }

  const rootAbsolute = resolve(root);
  const target = resolve(rootAbsolute, relativePath);
  if (target !== rootAbsolute && !target.startsWith(rootAbsolute + sep)) {
    return { error: `Path resolves outside the workspace: ${relativePath}` };
  }

  return { absolute: target };
}

/** Grade a task against all its acceptance criteria */
export async function gradeTask(
  task: EvalTask,
  events: TrajectoryEvent[],
  engine: HybridAgentEngine | undefined,
  context: GradingContext = {},
): Promise<GradeResult[]> {
  const grades: GradeResult[] = [];

  for (const criteria of task.acceptance) {
    const grade = await gradeCriteria(criteria, events, engine, context);
    grades.push(grade);
  }

  return grades;
}

/** Grade a single criteria */
async function gradeCriteria(
  criteria: AcceptanceCriteria,
  events: TrajectoryEvent[],
  engine: HybridAgentEngine | undefined,
  context: GradingContext,
): Promise<GradeResult> {
  switch (criteria.type) {
    case "command":
      return gradeCommand(criteria, context);
    case "property":
      return gradeProperty(criteria, context);
    case "trajectory":
      return gradeTrajectory(criteria, events);
    case "composite":
      return gradeComposite(criteria, events, engine, context);
    case "judge":
      return gradeJudge(criteria, events);
    case "human":
      return { criteria: "human", passed: false, score: 0, details: "Requires human review" };
    default:
      return { criteria: criteria.type, passed: false, score: 0, details: `Unknown grading method: ${criteria.type}` };
  }
}

/** Grade by running a command */
async function gradeCommand(criteria: AcceptanceCriteria, context: GradingContext): Promise<GradeResult> {
  if (!criteria.command) {
    return { criteria: "command", passed: false, score: 0, details: "No command specified" };
  }

  // The command inspects the work the agent did, so it must run where that
  // work happened.
  const workspace = resolveInWorkspace(context, ".");
  if (!workspace.absolute) {
    return { criteria: "command", passed: false, score: 0, details: workspace.error ?? "Unusable workspace" };
  }

  try {
    const { execSync } = await import("node:child_process");
    const output = execSync(criteria.command, {
      encoding: "utf-8",
      timeout: 30000,
      cwd: workspace.absolute,
    });

    let passed = true;
    const details: string[] = [];

    // Check output contains
    if (criteria.outputContains) {
      for (const expected of criteria.outputContains) {
        if (!output.includes(expected)) {
          passed = false;
          details.push(`Missing expected output: "${expected}"`);
        }
      }
    }

    // Check output does NOT contain
    if (criteria.outputNotContains) {
      for (const forbidden of criteria.outputNotContains) {
        if (output.includes(forbidden)) {
          passed = false;
          details.push(`Found forbidden output: "${forbidden}"`);
        }
      }
    }

    return {
      criteria: "command",
      passed,
      score: passed ? 1 : 0,
      details: details.length > 0 ? details.join("; ") : "All checks passed",
      evidence: { output: output.slice(0, 1000) },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      criteria: "command",
      passed: false,
      score: 0,
      details: `Command failed: ${message}`,
    };
  }
}

/** Grade by checking file properties */
async function gradeProperty(criteria: AcceptanceCriteria, context: GradingContext): Promise<GradeResult> {
  const { existsSync, readFileSync } = await import("node:fs");
  const details: string[] = [];
  let passed = true;

  let absolutePath: string | undefined;
  if (criteria.fileExists) {
    const resolved = resolveInWorkspace(context, criteria.fileExists);
    if (!resolved.absolute) {
      return { criteria: "property", passed: false, score: 0, details: resolved.error ?? "Unusable path" };
    }
    absolutePath = resolved.absolute;

    if (!existsSync(absolutePath)) {
      passed = false;
      details.push(`File does not exist: ${criteria.fileExists}`);
    }
  }

  if (criteria.fileContentMatch && absolutePath) {
    try {
      const content = readFileSync(absolutePath, "utf-8");
      const regex = new RegExp(criteria.fileContentMatch);
      if (!regex.test(content)) {
        passed = false;
        details.push(`File content does not match pattern: ${criteria.fileContentMatch}`);
      }
    } catch {
      passed = false;
      details.push(`Could not read file: ${criteria.fileExists}`);
    }
  }

  if (criteria.fileContentContains && absolutePath) {
    try {
      const content = readFileSync(absolutePath, "utf-8");
      for (const expected of criteria.fileContentContains) {
        if (!content.includes(expected)) {
          passed = false;
          details.push(`File missing expected content: "${expected}"`);
        }
      }
    } catch {
      passed = false;
      details.push(`Could not read file: ${criteria.fileExists}`);
    }
  }

  return {
    criteria: "property",
    passed,
    score: passed ? 1 : 0,
    details: details.length > 0 ? details.join("; ") : "All property checks passed",
  };
}

/** Grade by checking trajectory events */
function gradeTrajectory(criteria: AcceptanceCriteria, events: TrajectoryEvent[]): GradeResult {
  const details: string[] = [];
  let passed = true;

  // Check required events
  if (criteria.requiredEvents) {
    for (const required of criteria.requiredEvents) {
      const found = events.some(e => e.kind.includes(required));
      if (!found) {
        passed = false;
        details.push(`Missing required event: "${required}"`);
      }
    }
  }

  // Check forbidden events
  if (criteria.forbiddenEvents) {
    for (const forbidden of criteria.forbiddenEvents) {
      const found = events.some(e => e.kind.includes(forbidden));
      if (found) {
        passed = false;
        details.push(`Found forbidden event: "${forbidden}"`);
      }
    }
  }

  return {
    criteria: "trajectory",
    passed,
    score: passed ? 1 : 0,
    details: details.length > 0 ? details.join("; ") : "Trajectory checks passed",
    evidence: { eventKinds: events.map(e => e.kind) },
  };
}

/** Grade with composite criteria */
async function gradeComposite(
  criteria: AcceptanceCriteria,
  events: TrajectoryEvent[],
  engine: HybridAgentEngine | undefined,
  context: GradingContext,
): Promise<GradeResult> {
  if (!criteria.graders || criteria.graders.length === 0) {
    return { criteria: "composite", passed: false, score: 0, details: "No sub-graders" };
  }

  const subGrades: GradeResult[] = [];
  for (const sub of criteria.graders) {
    subGrades.push(await gradeCriteria(sub, events, engine, context));
  }

  const allPassed = subGrades.every(g => g.passed);
  const avgScore = subGrades.reduce((sum, g) => sum + g.score, 0) / subGrades.length;

  return {
    criteria: "composite",
    passed: allPassed,
    score: avgScore,
    details: subGrades.map(g => `${g.criteria}: ${g.passed ? "PASS" : "FAIL"}`).join(", "),
    evidence: subGrades,
  };
}

/**
 * LLM-judge grading — deliberately NOT implemented.
 *
 * This used to call itself an "LLM judge" and then score activity instead of
 * correctness:
 *
 *     score = (events exist ? 0.3 : 0)
 *           + (a tool was called ? 0.3 : 0)
 *           + (something said "completed" ? 0.4 : 0)
 *
 * Measured: a trajectory of two events — one tool call, one `session.completed`
 * — scores **1.0 and passes**, no matter what the agent actually produced. An
 * agent that emitted the wrong answer confidently would get full marks, while
 * a correct agent that finished in one step could fail. That grades enthusiasm,
 * not work.
 *
 * A judge needs a model, and no model is wired into the grader. Returning a
 * number anyway would put a fabricated score into eval results that are used to
 * decide whether the system improved — the most damaging place to lie. So this
 * reports `uncertain` (score 0, not passed) and names what is missing.
 *
 * When a judge model is supplied, replace the body — do not remove the guard.
 */
function gradeJudge(criteria: AcceptanceCriteria, events: TrajectoryEvent[]): GradeResult {
  return {
    criteria: "judge",
    passed: false,
    score: 0,
    details:
      "LLM-judge grading is not implemented: no judge model is wired into the grader. " +
      "It requires a model binding plus a rubric. Scoring trajectory activity " +
      `(${events.length} event(s)) would measure effort, not correctness — reporting unscored instead.`,
    evidence: { unscored: true, reason: "no-judge-model", minScore: criteria.minScore ?? null },
  };
}
