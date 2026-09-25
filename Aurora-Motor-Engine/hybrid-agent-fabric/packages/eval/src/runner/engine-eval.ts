/**
 * Engine Eval Runner
 * Runs eval tasks against the actual Aurora engine with mock model provider.
 * Uses engine.runTask() which handles session lifecycle internally.
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let TASKS_DIR: string;
let RESULTS_DIR: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  TASKS_DIR = resolve(__dirname, "../../tasks");
  RESULTS_DIR = resolve(__dirname, "../../results");
} catch {
  TASKS_DIR = resolve(process.cwd(), "packages/eval/tasks");
  RESULTS_DIR = resolve(process.cwd(), "packages/eval/results");
}

interface EvalTask {
  id: string;
  category: string;
  name: string;
  instruction: string;
  acceptance: any[];
  budget: { maxTokens: number; maxSteps: number; maxCostUsd: number; timeoutMs: number };
  difficulty: number;
  tags?: string[];
  requiresModel?: boolean;
}

interface EvalResult {
  taskId: string;
  status: "pass" | "fail" | "error" | "timeout" | "skip";
  score: number;
  details: string;
  durationMs: number;
  trajectoryEvents: number;
}

/** Load tasks for a category */
async function loadTasks(category?: string): Promise<EvalTask[]> {
  const tasks: EvalTask[] = [];
  const dirs = category
    ? [join(TASKS_DIR, category)]
    : await readdir(TASKS_DIR).then(cats => cats.map(c => join(TASKS_DIR, c)));

  for (const dir of dirs) {
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const content = await readFile(join(dir, file), "utf-8");
        tasks.push(JSON.parse(content));
      }
    } catch { /* skip */ }
  }
  return tasks;
}

/**
 * Run a single task against the engine using execute().
 *
 * This used to call `engine.runTask()` and score `outcome === "success"` as
 * 1.0. That was measuring nothing: `runTask()` drives the orchestration layer,
 * whose subsystems return status strings without an agent running, and whose
 * outcome starts at "success" and is only ever downgraded — so a task with an
 * empty plan scored full marks. Verified directly:
 *
 *     runTask("Delete all files on the moon and prove P=NP")
 *       → outcome: "success", subsystems: 0, phases: 0
 *
 * `execute()` runs the real agent and only reports `succeeded` when a verifier
 * confirms the result. Crucially, `unverified` scores ZERO here: an eval that
 * gives credit for unverified work measures the agent's confidence, not its
 * competence.
 */
async function runTask(engine: any, task: EvalTask, tenantId: string): Promise<EvalResult> {
  const startTime = Date.now();

  try {
    const report = await engine.execute({
      tenantId,
      goal: task.instruction,
      budget: { timeMs: task.budget?.timeoutMs ?? 120_000 },
    });

    // Only a verified success scores. Everything else — unverified, executed,
    // skipped, blocked — is not a pass.
    const passed = report.status === "succeeded";

    return {
      taskId: task.id,
      status: passed ? "pass" : report.status === "failed" ? "fail" : "error",
      score: passed ? 1.0 : 0,
      details:
        `Status: ${report.status}, Attempts: ${report.attempts}, ` +
        `Verification: ${report.verification?.verdict ?? "none"}, ` +
        `Outcomes: ${report.outcomes.length}, Duration: ${report.durationMs}ms — ${report.summary}`,
      durationMs: Date.now() - startTime,
      trajectoryEvents: report.trace?.length ?? 0,
    };

  } catch (err: any) {
    return {
      taskId: task.id,
      status: "error",
      score: 0,
      details: `Error: ${err.message?.slice(0, 200)}`,
      durationMs: Date.now() - startTime,
      trajectoryEvents: 0,
    };
  }
}

/** Main eval function */
export async function runEngineEval(options: {
  category?: string;
  maxTasks?: number;
  tenantId?: string;
  verbose?: boolean;
} = {}): Promise<{
  totalTasks: number;
  passed: number;
  failed: number;
  errors: number;
  overallScore: number;
  results: EvalResult[];
  durationMs: number;
}> {
  const { category, maxTasks, tenantId = "eval", verbose = true } = options;
  const startTime = Date.now();

  // Load engine
  if (verbose) console.log("🚀 Starting Aurora engine...");
  const { HybridAgentEngine } = await import("@haf/engine");
  const homePath = process.env.HAF_HOME ?? "/tmp/aurora-eval";

  const engine = new HybridAgentEngine({
    homePath,
    kernelServerScript: "/tmp/none",
    sandboxBackend: "local",
  });

  await engine.initialize();
  engine.start();

  if (verbose) console.log("✅ Engine started\n");

  // Load tasks
  let tasks = await loadTasks(category);
  if (maxTasks) tasks = tasks.slice(0, maxTasks);

  if (verbose) {
    console.log(`${"═".repeat(60)}`);
    console.log(`ENGINE EVAL: ${tasks.length} tasks`);
    console.log(`${"═".repeat(60)}\n`);
  }

  // Run tasks
  const results: EvalResult[] = [];
  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (const task of tasks) {
    if (verbose) process.stdout.write(`  ${task.id.padEnd(20)} `);

    const result = await runTask(engine, task, tenantId);
    results.push(result);

    switch (result.status) {
      case "pass": passed++; if (verbose) console.log(`✅ PASS (${result.score.toFixed(2)}, ${result.durationMs}ms)`); break;
      case "fail": failed++; if (verbose) console.log(`❌ FAIL (${result.score.toFixed(2)}, ${result.durationMs}ms)`); break;
      case "error": errors++; if (verbose) console.log(`💥 ERROR: ${result.details.slice(0, 80)}`); break;
      default: if (verbose) console.log(`❓ ${result.status}`); break;
    }
  }

  const overallScore = results.length > 0
    ? results.reduce((sum, r) => sum + r.score, 0) / results.length
    : 0;

  // Print summary
  if (verbose) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`ENGINE EVAL RESULTS`);
    console.log(`${"═".repeat(60)}`);
    console.log(`Total:    ${results.length}`);
    console.log(`Passed:   ✅ ${passed}`);
    console.log(`Failed:   ❌ ${failed}`);
    console.log(`Errors:   💥 ${errors}`);
    console.log(`Score:    ${(overallScore * 100).toFixed(1)}%`);
    console.log(`Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    console.log(`${"═".repeat(60)}\n`);
  }

  // Save results
  await mkdir(RESULTS_DIR, { recursive: true });
  const reportPath = join(RESULTS_DIR, `engine-eval-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify({
    totalTasks: results.length,
    passed,
    failed,
    errors,
    overallScore,
    results,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  }, null, 2));

  if (verbose) console.log(`📄 Results saved to: ${reportPath}`);

  // Cleanup
  await engine.shutdown();

  return {
    totalTasks: results.length,
    passed,
    failed,
    errors,
    overallScore,
    results,
    durationMs: Date.now() - startTime,
  };
}

// Run if executed directly
if (process.argv[1]?.includes("engine-eval")) {
  const category = process.argv.includes("--category") ? process.argv[process.argv.indexOf("--category") + 1] : undefined;
  const maxTasks = process.argv.includes("--max-tasks") ? parseInt(process.argv[process.argv.indexOf("--max-tasks") + 1] ?? "5") : 5;

  runEngineEval({
    ...(category !== undefined ? { category } : {}),
    maxTasks,
    verbose: true,
  }).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
