/**
 * Standalone Eval Runner
 * Runs eval tasks without the full engine — tests property and command graders directly.
 * This gives us a baseline of what the eval system can verify statically.
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import type { EvalTask, EvalResult, EvalSuiteResult, TaskMetrics, TrajectoryEvent } from "../tasks/types.js";
import { gradeTask } from "../graders/grader.js";

let TASKS_DIR: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  TASKS_DIR = resolve(__dirname, "../../tasks");
} catch {
  TASKS_DIR = resolve(process.cwd(), "packages/eval/tasks");
}

const RESULTS_DIR = resolve(TASKS_DIR, "../results");

/** Load all tasks */
async function loadAllTasks(): Promise<EvalTask[]> {
  const categories = await readdir(TASKS_DIR);
  const allTasks: EvalTask[] = [];
  for (const cat of categories) {
    const catDir = join(TASKS_DIR, cat);
    try {
      const files = await readdir(catDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const content = await readFile(join(catDir, file), "utf-8");
        allTasks.push(JSON.parse(content));
      }
    } catch { /* skip */ }
  }
  return allTasks;
}

/** Run a single task's property/command graders without the engine */
async function runStandaloneTask(task: EvalTask): Promise<EvalResult> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  const trajectory: TrajectoryEvent[] = [];
  let seq = 0;

  // For standalone mode, we only test property and command graders
  // that don't require the engine to actually execute the task
  const grades: { criteria: string; passed: boolean; score: number; details: string }[] = [];

  for (const criteria of task.acceptance) {
    if (criteria.type === "property") {
      // Check file existence
      if (criteria.fileExists) {
        const { existsSync } = await import("node:fs");
        const exists = existsSync(criteria.fileExists);
        grades.push({
          criteria: "property.fileExists",
          passed: exists,
          score: exists ? 1 : 0,
          details: exists ? `File ${criteria.fileExists} exists` : `File ${criteria.fileExists} does not exist`,
        });
        trajectory.push({ sequence: seq++, kind: "property.check", timestamp: new Date().toISOString(), payload: { success: exists } });
      }
    } else if (criteria.type === "command" && criteria.command) {
      // Try to run the command
      try {
        const output = execSync(criteria.command, { encoding: "utf-8", timeout: 10000, cwd: process.cwd() }).toString();
        let passed = true;
        const details: string[] = [];

        if (criteria.outputContains) {
          for (const expected of criteria.outputContains) {
            if (!output.includes(expected)) {
              passed = false;
              details.push(`Missing: "${expected}"`);
            }
          }
        }

        grades.push({
          criteria: "command",
          passed,
          score: passed ? 1 : 0,
          details: details.length > 0 ? details.join("; ") : "Command passed",
        });
        trajectory.push({ sequence: seq++, kind: "command.execute", timestamp: new Date().toISOString(), payload: { success: passed } });
      } catch (err: any) {
        grades.push({
          criteria: "command",
          passed: false,
          score: 0,
          details: `Command failed: ${err.message?.slice(0, 200)}`,
        });
        trajectory.push({ sequence: seq++, kind: "command.fail", timestamp: new Date().toISOString(), payload: { error: err.message?.slice(0, 200) } });
      }
    } else if (criteria.type === "trajectory") {
      // Trajectory graders can't be tested standalone — skip
      grades.push({
        criteria: "trajectory",
        passed: false,
        score: 0,
        details: "Skipped — requires engine execution",
      });
    } else if (criteria.type === "judge") {
      // Judge graders can't be tested standalone — skip
      grades.push({
        criteria: "judge",
        passed: false,
        score: 0,
        details: "Skipped — requires LLM judge",
      });
    }
  }

  const allPassed = grades.length > 0 && grades.every(g => g.passed);
  const score = grades.length > 0 ? grades.reduce((sum, g) => sum + g.score, 0) / grades.length : 0;

  return {
    taskId: task.id,
    status: allPassed ? "pass" : "fail",
    score,
    grades: grades.map(g => ({
      criteria: g.criteria as any,
      passed: g.passed,
      score: g.score,
      details: g.details,
    })),
    trajectory,
    metrics: {
      totalTokens: 0,
      totalCostUsd: 0,
      totalSteps: trajectory.length,
      toolCalls: 0,
      toolFailures: 0,
      replans: 0,
      memoryRecalls: 0,
      verificationAttempts: 0,
    },
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
  };
}

/** Run all tasks in standalone mode */
export async function runStandaloneEval(): Promise<EvalSuiteResult> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  const tasks = await loadAllTasks();
  console.log(`\n${"═".repeat(60)}`);
  console.log(`STANDALONE EVAL: ${tasks.length} tasks`);
  console.log(`${"═".repeat(60)}\n`);

  const results: EvalResult[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const task of tasks) {
    process.stdout.write(`  ${task.id.padEnd(20)} `);
    const result = await runStandaloneTask(task);
    results.push(result);

    if (result.status === "pass") {
      passed++;
      console.log(`✅ PASS (${result.score.toFixed(2)})`);
    } else if (result.score === 0 && result.grades.every(g => g.details.includes("Skipped"))) {
      skipped++;
      console.log(`⏭️  SKIP (requires engine)`);
    } else {
      failed++;
      console.log(`❌ FAIL (${result.score.toFixed(2)})`);
    }
  }

  const overallScore = results.length > 0
    ? results.filter(r => r.score > 0).reduce((sum, r) => sum + r.score, 0) / results.filter(r => r.score > 0).length
    : 0;

  const aggregateMetrics: TaskMetrics = {
    totalTokens: 0,
    totalCostUsd: 0,
    totalSteps: results.reduce((sum, r) => sum + r.metrics.totalSteps, 0),
    toolCalls: 0,
    toolFailures: 0,
    replans: 0,
    memoryRecalls: 0,
    verificationAttempts: 0,
  };

  const suiteResult: EvalSuiteResult = {
    suiteId: "standalone-eval",
    totalTasks: results.length,
    passed,
    failed,
    errors: skipped,
    timeouts: 0,
    overallScore,
    results,
    aggregateMetrics,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
  };

  // Print summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`STANDALONE EVAL RESULTS`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Total:    ${suiteResult.totalTasks}`);
  console.log(`Passed:   ✅ ${passed}`);
  console.log(`Failed:   ❌ ${failed}`);
  console.log(`Skipped:  ⏭️  ${skipped} (requires engine)`);
  console.log(`Score:    ${(overallScore * 100).toFixed(1)}%`);
  console.log(`Duration: ${(suiteResult.durationMs / 1000).toFixed(1)}s`);
  console.log(`${"═".repeat(60)}\n`);

  // Save results
  await mkdir(RESULTS_DIR, { recursive: true });
  const reportPath = join(RESULTS_DIR, `standalone-eval-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(suiteResult, null, 2));
  console.log(`📄 Results saved to: ${reportPath}`);

  return suiteResult;
}

// Run if executed directly
if (process.argv[1]?.includes("standalone-eval")) {
  runStandaloneEval().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
