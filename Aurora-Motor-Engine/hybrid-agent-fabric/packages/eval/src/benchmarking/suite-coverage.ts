import { CORE_EVAL_TASKS } from "../tasks/core-tasks.js";
import type { EvalTask } from "../tasks/types.js";

/**
 * P3.1 benchmark suite coverage, stated honestly.
 *
 * The master plan names ten benchmark dimensions. The suite covers eight of
 * them directly with workspace-graded tasks; the remaining two (multi-agent
 * and proactive) are exercised by the engine-level benchmark harness
 * (`engine/test/r-ablation-benchmark.test.ts`), which drives the real society
 * delegation and initiative cycle — dimensions whose evidence lives in engine
 * state, not in files a workspace grader can check. This report maps each
 * concept to where it is actually measured, with counts, and never rounds
 * "we have tasks about X" up to "X is covered".
 */

export interface ConceptCoverage {
  /** The benchmark concept from the master plan. */
  concept: string;
  /** Where it is measured: suite category or engine-level harness. */
  measuredBy: string;
  taskCount: number;
  coverage: "suite" | "engine-harness" | "none";
  note: string;
}

export interface SuiteCoverageReport {
  totalSuiteTasks: number;
  byCategory: Record<string, number>;
  concepts: ConceptCoverage[];
}

const CONCEPT_MAP: Array<{ concept: string; categories: string[]; note: string }> = [
  { concept: "coding", categories: ["coding"], note: "Write, fix and refactor code, command-graded." },
  { concept: "research", categories: ["research"], note: "Search, verify sources, synthesize." },
  { concept: "browser", categories: ["tool_use"], note: "Covered by tool_use tasks (filesystem, git, browser, MCP)." },
  { concept: "files", categories: ["tool_use"], note: "Covered by tool_use tasks (filesystem, git, browser, MCP)." },
  { concept: "planning", categories: ["planning"], note: "Plan, replan, handle dependencies." },
  { concept: "multi-agent", categories: [], note: "Engine-level harness: society delegation with real roles, tasks and outcomes; workspace grading cannot see engine state." },
  { concept: "memory", categories: ["memory"], note: "Recall, associate, consolidate." },
  { concept: "long-horizon", categories: ["long_horizon"], note: "Multi-session, persistent goals; restart persistence additionally proven at engine level." },
  { concept: "recovery", categories: ["recovery"], note: "Handle failures, find alternatives." },
  { concept: "proactive", categories: [], note: "Engine-level harness: initiative intake, evaluation and durable cadence; workspace grading cannot see engine state." },
];

export function suiteCoverage(tasks: readonly EvalTask[] = CORE_EVAL_TASKS): SuiteCoverageReport {
  const byCategory: Record<string, number> = {};
  for (const task of tasks) byCategory[task.category] = (byCategory[task.category] ?? 0) + 1;

  const concepts: ConceptCoverage[] = CONCEPT_MAP.map((entry) => {
    if (entry.categories.length > 0) {
      const taskCount = entry.categories.reduce((sum, category) => sum + (byCategory[category] ?? 0), 0);
      return {
        concept: entry.concept,
        measuredBy: entry.categories.join(", "),
        taskCount,
        coverage: taskCount > 0 ? "suite" : "none",
        note: taskCount > 0
          ? entry.note
          : `${entry.note} No tasks currently exist in ${entry.categories.join(", ")}.`,
      } as const;
    }
    return {
      concept: entry.concept,
      measuredBy: "engine benchmark harness (r-ablation-benchmark)",
      taskCount: 0,
      coverage: "engine-harness",
      note: entry.note,
    } as const;
  });

  return {
    totalSuiteTasks: tasks.length,
    byCategory,
    concepts,
  };
}
