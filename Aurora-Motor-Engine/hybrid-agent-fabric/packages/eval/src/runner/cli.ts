#!/usr/bin/env tsx
/**
 * Aurora Eval CLI
 * Run evaluation suites against Aurora engine.
 *
 * Usage:
 *   npm run eval -- --suite all
 *   npm run eval -- --suite coding
 *   npm run eval -- --task coding-001
 *   npm run eval -- --list
 */

import { readdir, readFile } from "node:fs/promises";
import { join, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalTask, EvalSuite } from "../tasks/types.js";
import { EvalRunner } from "./eval-runner.js";
import { generateMarkdownReport, generateSummary } from "../reports/report-generator.js";

// Resolve tasks directory robustly — works with npx tsx, ts-node, and compiled dist
let TASKS_DIR: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  TASKS_DIR = resolve(__dirname, "../../tasks");
} catch {
  // Fallback: find tasks relative to cwd
  TASKS_DIR = resolve(process.cwd(), "packages/eval/tasks");
}

/** Load all task JSON files from a directory */
async function loadTasksFromDir(dir: string): Promise<EvalTask[]> {
  const tasks: EvalTask[] = [];
  try {
    const files = await readdir(dir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        const content = await readFile(join(dir, file), "utf-8");
        tasks.push(JSON.parse(content));
      }
    }
  } catch {
    // Directory may not exist
  }
  return tasks;
}

/** Load all tasks from all category directories */
async function loadAllTasks(): Promise<EvalTask[]> {
  const categories = await readdir(TASKS_DIR);
  const allTasks: EvalTask[] = [];

  for (const cat of categories) {
    const catDir = join(TASKS_DIR, cat);
    const tasks = await loadTasksFromDir(catDir);
    allTasks.push(...tasks);
  }

  return allTasks;
}

/** Load tasks for a specific category */
async function loadCategoryTasks(category: string): Promise<EvalTask[]> {
  return loadTasksFromDir(join(TASKS_DIR, category));
}

/** Load a specific task by ID */
async function loadTaskById(taskId: string): Promise<EvalTask | null> {
  const allTasks = await loadAllTasks();
  return allTasks.find(t => t.id === taskId) ?? null;
}

/** Build a suite from tasks */
function buildSuite(id: string, name: string, tasks: EvalTask[]): EvalSuite {
  return {
    id,
    name,
    description: `Eval suite with ${tasks.length} tasks`,
    tasks,
  };
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const suiteArg = args.find(a => a.startsWith("--suite="))?.split("=")[1] ?? (args.includes("--suite") ? args[args.indexOf("--suite") + 1] : undefined);
  const taskArg = args.find(a => a.startsWith("--task="))?.split("=")[1] ?? (args.includes("--task") ? args[args.indexOf("--task") + 1] : undefined);
  const listFlag = args.includes("--list");
  const bailFlag = args.includes("--bail");
  const dryRunFlag = args.includes("--dry-run");

  // List all tasks
  if (listFlag) {
    const allTasks = await loadAllTasks();
    console.log("\n📋 Available Eval Tasks:\n");
    const byCategory = new Map<string, EvalTask[]>();
    for (const task of allTasks) {
      if (!byCategory.has(task.category)) byCategory.set(task.category, []);
      byCategory.get(task.category)!.push(task);
    }
    for (const [cat, tasks] of byCategory) {
      console.log(`  ${cat.toUpperCase()} (${tasks.length})`);
      for (const t of tasks) {
        console.log(`    ${t.id.padEnd(20)} ${t.name} [difficulty: ${t.difficulty}/5]`);
      }
    }
    console.log(`\nTotal: ${allTasks.length} tasks\n`);
    return;
  }

  // Dry run
  if (dryRunFlag) {
    const tasks = suiteArg ? await loadCategoryTasks(suiteArg) : await loadAllTasks();
    console.log(`\n🔍 Dry run: would run ${tasks.length} tasks\n`);
    for (const t of tasks) {
      console.log(`  ${t.id}: ${t.name} (budget: ${t.budget.maxTokens} tokens, ${t.budget.maxSteps} steps)`);
    }
    return;
  }

  // Load engine dynamically (avoid circular deps)
  let engine: any;
  try {
    // Try to import the engine
    const { HybridAgentEngine } = await import("@haf/engine");
    const homePath = process.env.HAF_HOME ?? "/tmp/aurora-eval";
    engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: "/tmp/none",
      sandboxBackend: "local",
    });
    await engine.start();
  } catch (err) {
    console.error("⚠️  Could not start engine — running in standalone mode");
    console.error("   Some tasks that require engine will be skipped.\n");
    engine = null;
  }

  const runner = new EvalRunner(engine, {
    bailOnFailure: bailFlag,
    verbose: true,
  });

  // Run specific task
  if (taskArg) {
    const task = await loadTaskById(taskArg);
    if (!task) {
      console.error(`❌ Task not found: ${taskArg}`);
      process.exit(1);
    }
    const result = await runner.runTask(task);
    console.log(`\nResult: ${result.status} (score: ${result.score.toFixed(2)})`);
    process.exit(result.status === "pass" ? 0 : 1);
  }

  // Run suite
  const tasks = suiteArg ? await loadCategoryTasks(suiteArg) : await loadAllTasks();
  if (tasks.length === 0) {
    console.error("❌ No tasks found");
    process.exit(1);
  }

  const suite = buildSuite(
    suiteArg ? `eval-${suiteArg}` : "eval-all",
    suiteArg ? `${suiteArg} eval` : "Full eval",
    tasks,
  );

  const result = await runner.runSuite(suite);

  // Generate report
  const report = generateMarkdownReport(result);
  const { writeFile } = await import("node:fs/promises");
  const reportPath = join(import.meta.dirname, `../../results/${suite.id}-report.md`);
  await writeFile(reportPath, report);
  console.log(`\n📄 Report saved to: ${reportPath}`);
  console.log(`\n${generateSummary(result)}`);

  // Cleanup
  if (engine?.stop) await engine.stop();

  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
