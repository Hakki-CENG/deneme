/**
 * Eval Runner
 * Orchestrates evaluation tasks against Aurora engine.
 */

import { randomUUID } from "node:crypto";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { HybridAgentEngine } from "@haf/engine";
import type {
  EvalTask,
  EvalResult,
  EvalSuite,
  EvalSuiteResult,
  GradeResult,
  TaskMetrics,
  TrajectoryEvent,
} from "../tasks/types.js";
import { gradeTask } from "../graders/grader.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { calculateAggregateMetrics } from "../metrics/metrics.js";

export interface EvalRunnerConfig {
  /** Output directory for results (reports, trajectories, run summaries). */
  outputDir: string;
  /**
   * Scratch directory for per-task workspaces.
   *
   * Kept separate from `outputDir` on purpose: task seed files are transient
   * fixtures, not results. Writing them into the results directory polluted it
   * with stray `.js`/`.test.js` files, which the test runner then tried to
   * collect as suites.
   */
  workspaceDir: string;
  /** Tenant ID to use for eval */
  tenantId: string;
  /** Whether to save trajectories */
  saveTrajectories: boolean;
  /** Whether to stop on first failure */
  bailOnFailure: boolean;
  /** Verbose logging */
  verbose: boolean;
}

const DEFAULT_CONFIG: EvalRunnerConfig = {
  outputDir: "packages/eval/results",
  workspaceDir: "packages/eval/.workspaces",
  tenantId: "eval",
  saveTrajectories: true,
  bailOnFailure: false,
  verbose: true,
};

export class EvalRunner {
  private config: EvalRunnerConfig;
  private engine: HybridAgentEngine;

  constructor(engine: HybridAgentEngine, config: Partial<EvalRunnerConfig> = {}) {
    this.engine = engine;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Run a single eval task */
  async runTask(task: EvalTask): Promise<EvalResult> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const recorder = new TrajectoryRecorder();

    this.log(`\n▶ Running task: ${task.id} — ${task.name}`);
    this.log(`  Category: ${task.category} | Difficulty: ${task.difficulty}/5`);

    let status: EvalResult["status"] = "pass";
    let score = 0;
    let error: string | undefined;

    try {
      // 1. Setup workspace if needed
      if (task.workspace) {
        await this.setupWorkspace(task);
      }

      // 2. Create session for eval.
      //    The agent must work in the task's scratch workspace, and the grader
      //    must later judge that same directory. Seeding files the agent never
      //    sees would make every file-based task unsolvable.
      const workspacePath = task.workspace ? resolve(this.workspacePathFor(task.id)) : undefined;

      const session = await this.engine.createSession({
        tenantId: this.config.tenantId,
        name: `eval-${task.id}`,
        ...(workspacePath ? { workspacePath } : {}),
      });

      recorder.record({ kind: "task.started", timestamp: new Date().toISOString(), payload: { taskId: task.id } });

      // 3. Send task instruction to Aurora
      const result = await this.engine.command({
        protocolVersion: 1,
        commandId: randomUUID(),
        clientId: "eval-runner",
        tenantId: this.config.tenantId,
        sessionId: session.sessionId,
        kind: "session.prompt",
        source: "api",
        issuedAt: new Date().toISOString(),
        payload: { text: task.instruction },
      });

      recorder.record({ kind: "task.prompted", timestamp: new Date().toISOString(), payload: { result } });

      // 4. Wait for completion (with timeout)
      const timeoutMs = task.budget.timeoutMs;
      const deadline = startTime + timeoutMs;

      // Poll for completion
      let completed = false;
      let events: TrajectoryEvent[] = [];
      let seq = 2;

      while (Date.now() < deadline) {
        const sessionEvents = await this.engine.readEvents(session.sessionId, 0, 100);
        events = sessionEvents.map((e: any, i: number) => ({
          sequence: i,
          kind: String(e.kind ?? e.type ?? "unknown"),
          timestamp: String(e.issuedAt ?? e.createdAt ?? new Date().toISOString()),
          payload: e.payload,
        }));

        // Check if session is done
        const sessionState = await this.engine.session(session.sessionId);
        if (sessionState.status === "closed" || sessionState.status === "idle") {
          completed = true;
          break;
        }

        // Check token budget
        const totalTokens = events.reduce((sum, e) => {
          const p = e.payload as any;
          return sum + (p?.usage?.totalTokens ?? 0);
        }, 0);

        if (totalTokens > task.budget.maxTokens) {
          status = "budget_exceeded";
          error = `Token budget exceeded: ${totalTokens} > ${task.budget.maxTokens}`;
          break;
        }

        // Wait before polling again
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (!completed && status !== "budget_exceeded") {
        status = "timeout";
        error = `Task timed out after ${timeoutMs}ms`;
      }

      recorder.record({ kind: "task.completed", timestamp: new Date().toISOString(), payload: { status } });

      // 5. Grade the result.
      //    Graded exactly once: acceptance commands have side effects and cost
      //    real time, so grading twice both doubles the cost and risks two
      //    different verdicts for one run.
      let grades: GradeResult[] = [];
      if (status === "pass") {
        grades = await gradeTask(task, events, this.engine, { workspacePath });
        const allPassed = grades.every(g => g.passed);
        score = grades.length > 0 ? grades.reduce((sum, g) => sum + g.score, 0) / grades.length : 0;

        if (!allPassed) {
          status = "fail";
        }
      }

      // 6. Collect metrics
      const metrics = this.collectMetrics(events);

      // Check budget constraints
      if (metrics.totalTokens > task.budget.maxTokens) {
        status = "budget_exceeded";
      }
      if (metrics.totalSteps > task.budget.maxSteps) {
        status = "budget_exceeded";
      }
      if (metrics.totalCostUsd > task.budget.maxCostUsd) {
        status = "budget_exceeded";
      }

      // 7. Save trajectory
      if (this.config.saveTrajectories) {
        await this.saveTrajectory(task.id, events);
      }

      const result2: EvalResult = {
        taskId: task.id,
        status,
        score,
        grades,
        trajectory: events,
        metrics,
        error,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
      };

      this.log(`  Result: ${status === "pass" ? "✅" : "❌"} ${status} (score: ${score.toFixed(2)}, ${result2.durationMs}ms)`);
      return result2;

    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`  Error: ${errorMsg}`);

      return {
        taskId: task.id,
        status: "error",
        score: 0,
        grades: [],
        metrics: this.collectMetrics([]),
        error: errorMsg,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /** Run a full eval suite */
  async runSuite(suite: EvalSuite): Promise<EvalSuiteResult> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    this.log(`\n${"═".repeat(60)}`);
    this.log(`EVAL SUITE: ${suite.name}`);
    this.log(`${suite.description}`);
    this.log(`Tasks: ${suite.tasks.length}`);
    this.log(`${"═".repeat(60)}`);

    const results: EvalResult[] = [];
    let passed = 0;
    let failed = 0;
    let errors = 0;
    let timeouts = 0;

    for (const task of suite.tasks) {
      const result = await this.runTask(task);
      results.push(result);

      switch (result.status) {
        case "pass": passed++; break;
        case "fail": failed++; break;
        case "error": errors++; break;
        case "timeout": timeouts++; break;
        case "budget_exceeded": failed++; break;
      }

      if (this.config.bailOnFailure && result.status !== "pass") {
        this.log(`\n⛔ Bailing on failure: ${task.id}`);
        break;
      }
    }

    const aggregateMetrics = calculateAggregateMetrics(results.map(r => r.metrics));
    const overallScore = results.length > 0
      ? results.reduce((sum, r) => sum + r.score, 0) / results.length
      : 0;

    const suiteResult: EvalSuiteResult = {
      suiteId: suite.id,
      totalTasks: results.length,
      passed,
      failed,
      errors,
      timeouts,
      overallScore,
      results,
      aggregateMetrics,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    };

    // Save results
    await this.saveResults(suite.id, suiteResult);

    // Print summary
    this.printSummary(suiteResult);

    return suiteResult;
  }

  /** Collect metrics from trajectory events */
  private collectMetrics(events: TrajectoryEvent[]): TaskMetrics {
    let totalTokens = 0;
    let toolCalls = 0;
    let toolFailures = 0;
    let replans = 0;
    let memoryRecalls = 0;
    let verificationAttempts = 0;

    for (const event of events) {
      const p = event.payload as any;
      if (p?.usage?.totalTokens) totalTokens += p.usage.totalTokens;
      if (event.kind.includes("tool")) toolCalls++;
      if (event.kind.includes("tool") && event.kind.includes("fail")) toolFailures++;
      if (event.kind.includes("replan")) replans++;
      if (event.kind.includes("memory") && event.kind.includes("recall")) memoryRecalls++;
      if (event.kind.includes("verification")) verificationAttempts++;
    }

    // Estimate cost (rough: $0.001 per 1K tokens)
    const totalCostUsd = totalTokens * 0.000001;

    return {
      totalTokens,
      totalCostUsd,
      totalSteps: events.length,
      toolCalls,
      toolFailures,
      replans,
      memoryRecalls,
      verificationAttempts,
    };
  }

  /** Absolute path of a task's scratch workspace. */
  private workspacePathFor(taskId: string): string {
    return join(this.config.workspaceDir, taskId);
  }

  /**
   * Materialise a task's seed files into a clean scratch workspace.
   *
   * The directory is removed first so a previous run's leftovers can never be
   * mistaken for work the agent did this time.
   */
  private async setupWorkspace(task: EvalTask): Promise<void> {
    if (!task.workspace) return;

    const root = this.workspacePathFor(task.id);
    await rm(root, { recursive: true, force: true });

    for (const file of task.workspace.files ?? []) {
      const target = join(root, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
  }

  /** Save trajectory to file */
  private async saveTrajectory(taskId: string, events: TrajectoryEvent[]): Promise<void> {
    const dir = join(this.config.outputDir, "trajectories");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${taskId}-${Date.now()}.json`),
      JSON.stringify(events, null, 2),
    );
  }

  /** Save suite results */
  private async saveResults(suiteId: string, result: EvalSuiteResult): Promise<void> {
    const dir = join(this.config.outputDir, "runs");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${suiteId}-${Date.now()}.json`),
      JSON.stringify(result, null, 2),
    );
  }

  /** Print summary */
  private printSummary(result: EvalSuiteResult): void {
    this.log(`\n${"═".repeat(60)}`);
    this.log(`SUITE RESULTS: ${result.suiteId}`);
    this.log(`${"═".repeat(60)}`);
    this.log(`Total:    ${result.totalTasks}`);
    this.log(`Passed:   ✅ ${result.passed}`);
    this.log(`Failed:   ❌ ${result.failed}`);
    this.log(`Errors:   💥 ${result.errors}`);
    this.log(`Timeouts: ⏰ ${result.timeouts}`);
    this.log(`Score:    ${(result.overallScore * 100).toFixed(1)}%`);
    this.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    this.log(`Tokens:   ${result.aggregateMetrics.totalTokens.toLocaleString()}`);
    this.log(`Cost:     $${result.aggregateMetrics.totalCostUsd.toFixed(4)}`);
    this.log(`${"═".repeat(60)}\n`);
  }

  private log(msg: string): void {
    if (this.config.verbose) {
      console.log(msg);
    }
  }
}
