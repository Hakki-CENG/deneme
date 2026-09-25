/**
 * Engine Eval with Trajectory Recording
 * Runs eval tasks against the Aurora engine while recording cognitive events
 * as trajectories. Generates self-improvement reports from trajectory analysis.
 * 
 * This is the full feedback loop:
 *   Engine → EventBus → TrajectoryBridge → TrajectoryStore → Analysis → Report
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Eval imports
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { TrajectoryStore } from "../trajectory/trajectory-store.js";
import { TrajectoryBridge } from "../integration/trajectory-bridge.js";
import { TrajectoryAnalyzer } from "../trajectory/trajectory-analyzer.js";
import { EvalIntegration } from "../integration/eval-integration.js";
import { calculateDifficultyScore, loadTaskDifficulties, formatDifficultyReport } from "../scoring/difficulty-scorer.js";
import { runRegressionDetection } from "../monitoring/regression-detector.js";
import { runBenchmark } from "../benchmarking/performance-benchmark.js";
import { runCostTracking } from "../cost/cost-tracker.js";
import { runQualityGates } from "../quality/quality-gates.js";
import { runContinuousMonitor } from "../monitoring/continuous-monitor.js";
import { runAutoRecovery } from "../recovery/auto-recovery.js";
import type { TrajectoryEvent } from "../trajectory/types.js";

let TASKS_DIR: string;
let RESULTS_DIR: string;
let TRAJECTORIES_DIR: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  TASKS_DIR = resolve(__dirname, "../../tasks");
  RESULTS_DIR = resolve(__dirname, "../../results");
  TRAJECTORIES_DIR = resolve(__dirname, "../../results/trajectories");
} catch {
  TASKS_DIR = resolve(process.cwd(), "packages/eval/tasks");
  RESULTS_DIR = resolve(process.cwd(), "packages/eval/results");
  TRAJECTORIES_DIR = resolve(process.cwd(), "packages/eval/results/trajectories");
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

interface TrajectoryEvalResult {
  taskId: string;
  category: string;
  status: "pass" | "fail" | "error" | "timeout" | "skip";
  score: number;
  details: string;
  durationMs: number;
  trajectoryEvents: number;
  trajectoryId?: string;
  qualityScore?: number;
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
 * Capture EventBus events during a task execution and convert them to trajectory events.
 * Returns a function that unsubscribes from the EventBus.
 */
function captureBusEvents(engine: any, bridge: TrajectoryBridge, trajectoryId: string): () => void {
  const subId = engine.eventBus.subscribe("*", (event: any) => {
    // Map EventBus event types to trajectory event kinds
    const kind = event.type;
    const source = event.source;
    const payload = event.payload;

    bridge.recordEvent(trajectoryId, {
      kind: `bus.${kind}`,
      source,
      payload: {
        severity: event.severity,
        phase: event.phase,
        traceId: event.traceId,
        data: payload,
      },
      success: event.severity !== "critical",
    });
  });

  return () => {
    engine.eventBus.unsubscribe(subId);
  };
}

/**
 * Run a single task with trajectory recording.
 */
async function runTaskWithTrajectory(
  engine: any,
  task: EvalTask,
  tenantId: string,
  bridge: TrajectoryBridge,
  store: TrajectoryStore,
  recorder: TrajectoryRecorder,
): Promise<TrajectoryEvalResult> {
  const startTime = Date.now();

  // Start trajectory
  const trajectoryId = bridge.startTrajectory(task.id, tenantId, `eval-${task.id}`);

  // Subscribe to EventBus events for this task
  const unsubscribe = captureBusEvents(engine, bridge, trajectoryId);

  try {
    // Record task start
    bridge.recordEvent(trajectoryId, {
      kind: "eval.task.started",
      source: "engine-eval",
      payload: { taskId: task.id, category: task.category, instruction: task.instruction.slice(0, 200) },
    });

    // Run the task through the REAL agent.
    //
    // This used to call `engine.runTask()` and score `outcome === "success"`
    // as 1.0, with `partial` worth 0.5. That measured the orchestration
    // layer's self-report, not work: runTask()'s outcome starts optimistic and
    // is only ever downgraded, so an empty plan scored full marks while no
    // agent ran at all. `execute()` runs the session agent and only reports
    // `succeeded` when a verifier confirms the result.
    const report = await engine.execute({
      tenantId,
      goal: task.instruction,
      budget: { timeMs: task.budget?.timeoutMs ?? 120_000 },
    });

    // Only verified success counts. `unverified` scores zero: crediting
    // unverified work measures the agent's confidence, not its competence.
    // There is no half credit — a partially-done task is a failed task here.
    const passed = report.status === "succeeded";

    // Record task completion
    bridge.recordEvent(trajectoryId, {
      kind: "eval.task.completed",
      source: "engine-eval",
      payload: {
        status: report.status,
        attempts: report.attempts,
        verification: report.verification?.verdict ?? "none",
      },
      success: passed,
    });

    // Complete trajectory
    const trajectory = await bridge.completeTrajectory(
      trajectoryId,
      passed ? "success" : report.status === "failed" ? "failure" : "error",
      `Task ${task.id}: ${report.status}`,
    );

    // Analyze trajectory quality
    const analyzer = new TrajectoryAnalyzer();
    const analysis = analyzer.analyze(trajectory);

    return {
      taskId: task.id,
      category: task.category,
      status: passed ? "pass" : report.status === "failed" ? "fail" : "error",
      score: passed ? 1.0 : 0,
      details:
        `Status: ${report.status}, Attempts: ${report.attempts}, ` +
        `Verification: ${report.verification?.verdict ?? "none"}, ` +
        `Events: ${trajectory.events.length}, Quality: ${analysis.qualityScore.toFixed(2)} — ${report.summary}`,
      durationMs: Date.now() - startTime,
      trajectoryEvents: trajectory.events.length,
      trajectoryId,
      qualityScore: analysis.qualityScore,
    };

  } catch (err: any) {
    // Record error
    bridge.recordEvent(trajectoryId, {
      kind: "eval.task.error",
      source: "engine-eval",
      payload: { error: err.message },
      success: false,
    });

    // Still complete the trajectory to save partial data
    try {
      await bridge.completeTrajectory(trajectoryId, "error", `Error: ${err.message?.slice(0, 200)}`);
    } catch { /* best effort */ }

    return {
      taskId: task.id,
      category: task.category,
      status: "error",
      score: 0,
      details: `Error: ${err.message?.slice(0, 200)}`,
      durationMs: Date.now() - startTime,
      trajectoryEvents: 0,
      trajectoryId,
    };
  } finally {
    unsubscribe();
  }
}

/**
 * Main engine eval with trajectory recording.
 */
export async function runEngineEvalWithTrajectory(options: {
  category?: string;
  maxTasks?: number;
  tenantId?: string;
  verbose?: boolean;
  generateReport?: boolean;
} = {}): Promise<{
  totalTasks: number;
  passed: number;
  failed: number;
  errors: number;
  overallScore: number;
  results: TrajectoryEvalResult[];
  durationMs: number;
  trajectoriesSaved: number;
}> {
  const { category, maxTasks, tenantId = "eval", verbose = true, generateReport = true } = options;
  const startTime = Date.now();

  // Initialize trajectory system
  await mkdir(TRAJECTORIES_DIR, { recursive: true });
  const recorder = new TrajectoryRecorder();
  const store = new TrajectoryStore(TRAJECTORIES_DIR);
  const bridge = new TrajectoryBridge(recorder, store, { autoSave: true });

  // Load engine
  if (verbose) console.log("🚀 Starting Aurora engine with trajectory recording...");
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
    console.log(`ENGINE EVAL + TRAJECTORY RECORDING: ${tasks.length} tasks`);
    console.log(`${"═".repeat(60)}\n`);
  }

  // Run tasks with trajectory recording
  const results: TrajectoryEvalResult[] = [];
  let passed = 0;
  let failed = 0;
  let errors = 0;
  let trajectoriesSaved = 0;

  for (const task of tasks) {
    if (verbose) process.stdout.write(`  ${task.id.padEnd(25)} `);

    const result = await runTaskWithTrajectory(engine, task, tenantId, bridge, store, recorder);
    results.push(result);
    if (result.trajectoryId) trajectoriesSaved++;

    switch (result.status) {
      case "pass": passed++; if (verbose) console.log(`✅ PASS (${result.score.toFixed(2)}, ${result.durationMs}ms, q=${result.qualityScore?.toFixed(2) ?? "?"})`); break;
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
    console.log(`ENGINE EVAL + TRAJECTORY RESULTS`);
    console.log(`${"═".repeat(60)}`);
    console.log(`Total:       ${results.length}`);
    console.log(`Passed:      ✅ ${passed}`);
    console.log(`Failed:      ❌ ${failed}`);
    console.log(`Errors:      💥 ${errors}`);
    console.log(`Score:       ${(overallScore * 100).toFixed(1)}%`);
    console.log(`Trajectories: ${trajectoriesSaved} saved`);
    console.log(`Duration:    ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    // Average quality score
    const qualityScores = results.filter(r => r.qualityScore !== undefined).map(r => r.qualityScore!);
    if (qualityScores.length > 0) {
      const avgQuality = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;
      console.log(`Avg Quality: ${avgQuality.toFixed(3)}`);
    }
    console.log(`${"═".repeat(60)}\n`);
  }

  // Save results
  await mkdir(RESULTS_DIR, { recursive: true });
  const reportPath = join(RESULTS_DIR, `engine-eval-trajectory-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify({
    totalTasks: results.length,
    passed,
    failed,
    errors,
    overallScore,
    results,
    trajectoriesSaved,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  }, null, 2));

  if (verbose) console.log(`📄 Results saved to: ${reportPath}`);

  // Generate self-improvement report
  if (generateReport && trajectoriesSaved > 0) {
    if (verbose) console.log("\n📊 Generating self-improvement report...");

    const integration = new EvalIntegration(store);

    // Build EvalSuiteResult format
    const suiteResult = {
      suiteId: `engine-eval-${Date.now()}`,
      results: results.map(r => ({
        taskId: r.taskId,
        status: r.status,
        score: r.score,
        metrics: {
          totalTokens: 0,
          totalCostUsd: 0,
          totalDurationMs: r.durationMs,
          stepsExecuted: r.trajectoryEvents,
          toolsUsed: [],
          memoryOps: 0,
          planChanges: 0,
          verificationsPassed: 0,
          verificationsFailed: 0,
        },
        durationMs: r.durationMs,
        ...(r.details ? { details: r.details } : {}),
      })),
      overallScore,
      totalDurationMs: Date.now() - startTime,
      totalTokens: 0,
      totalCostUsd: 0,
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
    };

    const report = await integration.generateReport(suiteResult as any);
    const reportMarkdown = integration.formatReport(report);

    const reportPath2 = join(RESULTS_DIR, "self-improvement-report.md");
    await writeFile(reportPath2, reportMarkdown);
    if (verbose) console.log(`📊 Self-improvement report saved to: ${reportPath2}`);

    // Generate difficulty analysis report
    if (verbose) console.log("\n📊 Generating difficulty analysis...");
    const taskDifficulties = await loadTaskDifficulties();
    const difficultyScore = calculateDifficultyScore(results, taskDifficulties);
    const difficultyReport = formatDifficultyReport(difficultyScore);

    const diffReportPath = join(RESULTS_DIR, "difficulty-analysis.md");
    await writeFile(diffReportPath, difficultyReport);
    if (verbose) {
      console.log(`📊 Difficulty analysis saved to: ${diffReportPath}`);
      console.log(`   Weighted Score: ${(difficultyScore.weightedScore * 100).toFixed(1)}%`);
      console.log(`   Raw Score:      ${(difficultyScore.rawScore * 100).toFixed(1)}%`);
      console.log(`   Difficulty Bonus: ${((difficultyScore.weightedScore - difficultyScore.rawScore) * 100).toFixed(1)}%`);
    }

    // Run regression detection
    if (verbose) console.log("\n🔍 Running regression detection...");
    const regressionReport = await runRegressionDetection();
    if (regressionReport && verbose) {
      if (regressionReport.hasRegressions) {
        console.log(`⚠️  ${regressionReport.stats.totalRegressions} regressions detected!`);
      } else {
        console.log("✅ No regressions detected.");
      }
      console.log(`📈 Trend: ${regressionReport.trendDetails}`);
    }

    // Run performance benchmark
    if (verbose) console.log("\n📊 Running performance benchmark...");
    const benchmarkReport = await runBenchmark();
    if (benchmarkReport && verbose) {
      console.log(`   Avg Duration: ${benchmarkReport.overall.avgDurationMs.toFixed(1)}ms`);
      console.log(`   Throughput: ${benchmarkReport.overall.throughput.toFixed(1)} tasks/sec`);
      console.log(`   Bottlenecks: ${benchmarkReport.bottlenecks.length} detected`);
      if (benchmarkReport.bottlenecks.length > 0) {
        console.log(`   Top bottleneck: ${benchmarkReport.bottlenecks[0]?.taskId} (${benchmarkReport.bottlenecks[0]?.slowdownFactor.toFixed(1)}x slower)`);
      }
    }

    // Run cost tracking
    if (verbose) console.log("\n💰 Running cost tracking...");
    const costReport = await runCostTracking({ model: "mock", budgetLimit: 100 });
    if (costReport && verbose) {
      console.log(`   Total Tokens: ${costReport.overall.totalTokens.toLocaleString()}`);
      console.log(`   Total Cost: $${costReport.overall.totalCostUsd.toFixed(4)}`);
      console.log(`   Avg Tokens/Task: ${costReport.overall.avgTokensPerTask.toFixed(0)}`);
      if (costReport.budgetAlerts.length > 0) {
        console.log(`   ⚠️  ${costReport.budgetAlerts.length} budget alerts!`);
      }
    }

    // Run quality gates
    if (verbose) console.log("\n🚦 Running quality gates...");
    const gateResult = await runQualityGates();
    if (verbose) {
      console.log(`   ${gateResult.summary}`);
      console.log(`   Checks: ${gateResult.passedChecks}/${gateResult.totalChecks} passed`);
      if (gateResult.failedChecks > 0) {
        const failedGates = gateResult.checks.filter(c => !c.passed);
        for (const f of failedGates) {
          console.log(`   ❌ ${f.name}: ${f.message}`);
        }
      }
    }

    // Run continuous monitoring
    if (verbose) console.log("\n🔍 Running continuous monitoring...");
    const monitorReport = await runContinuousMonitor();
    if (verbose) {
      const healthIcon = monitorReport.status.health === "healthy" ? "🟢" : monitorReport.status.health === "degraded" ? "🟡" : "🔴";
      console.log(`   Health: ${healthIcon} ${monitorReport.status.health}`);
      console.log(`   Alerts: ${monitorReport.status.recentAlerts.length}`);
      if (monitorReport.recommendations.length > 0) {
        console.log(`   Recommendations: ${monitorReport.recommendations.length}`);
      }
    }

    // Run auto-recovery check
    if (verbose) console.log("\n🔧 Running auto-recovery check...");
    const recoveryReport = await runAutoRecovery();
    if (verbose) {
      const cbIcon = recoveryReport.circuitBreaker.state === "closed" ? "🟢" : recoveryReport.circuitBreaker.state === "open" ? "🔴" : "🟡";
      console.log(`   Circuit Breaker: ${cbIcon} ${recoveryReport.circuitBreaker.state}`);
      console.log(`   Success Rate: ${(recoveryReport.stats.successRate * 100).toFixed(1)}%`);
      if (recoveryReport.recommendations.length > 0) {
        console.log(`   Recommendations: ${recoveryReport.recommendations.length}`);
      }
    }
  }

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
    trajectoriesSaved,
  };
}

// Run if executed directly
if (process.argv[1]?.includes("engine-eval-trajectory")) {
  const category = process.argv.includes("--category") ? process.argv[process.argv.indexOf("--category") + 1] : undefined;
  const maxTasks = process.argv.includes("--max-tasks") ? parseInt(process.argv[process.argv.indexOf("--max-tasks") + 1] ?? "5") : 5;

  runEngineEvalWithTrajectory({
    ...(category !== undefined ? { category } : {}),
    maxTasks,
    verbose: true,
    generateReport: true,
  }).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
