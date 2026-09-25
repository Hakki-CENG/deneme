/**
 * Code Pipeline Service
 * Full software development lifecycle: issue → plan → branch → implementation
 * → test → security review → PR → CI result → deployment chain.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

// ─── Types ───

export type PipelineStage = "issue" | "plan" | "branch" | "implement" | "test" | "security_review" | "pr" | "ci" | "deploy" | "rollback" | "completed" | "failed";

export interface PipelineRun {
  id: string;
  tenantId: string;
  issueId: string;
  title: string;
  description: string;
  stages: PipelineStageState[];
  currentStage: PipelineStage;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "rolled_back";
  metadata: PipelineMetadata;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface PipelineStageState {
  stage: PipelineStage;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  result?: unknown;
  error?: string;
  artifacts?: string[];
}

export interface PipelineMetadata {
  repository?: string;
  branch?: string;
  prNumber?: number;
  commitSha?: string;
  deploymentUrl?: string;
  testCoverage?: number;
  securityScore?: number;
  rollbackTarget?: string;
}

export interface Issue {
  id: string;
  title: string;
  description: string;
  labels: string[];
  priority: "critical" | "high" | "medium" | "low";
  assignee?: string;
  status: "open" | "in_progress" | "resolved" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface ImplementationPlan {
  id: string;
  issueId: string;
  steps: PlanStep[];
  estimatedDuration: string;
  risks: string[];
  dependencies: string[];
  createdAt: string;
}

export interface PlanStep {
  id: string;
  description: string;
  files: string[];
  estimatedMinutes: number;
  status: "pending" | "in_progress" | "completed";
}

/**
 * Raised when a pipeline stage has no real implementation behind it.
 *
 * Carries the stage name and what would be required to implement it, so a
 * failed run explains itself instead of surfacing an opaque error.
 */
export class CodePipelineStageNotImplementedError extends Error {
  readonly stage: string;
  readonly requirement: string;

  constructor(stage: string, requirement: string) {
    super(`Pipeline stage '${stage}' is not implemented. It requires ${requirement}.`);
    this.name = "CodePipelineStageNotImplementedError";
    this.stage = stage;
    this.requirement = requirement;
  }
}

export interface SecurityReviewResult {
  score: number; // 0-100
  vulnerabilities: SecurityVulnerability[];
  warnings: string[];
  recommendations: string[];
  passed: boolean;
}

export interface SecurityVulnerability {
  severity: "critical" | "high" | "medium" | "low" | "info";
  type: string;
  file: string;
  line?: number;
  description: string;
  recommendation: string;
}

export interface TestResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  coverage?: number;
  durationMs: number;
  failures: { name: string; error: string; file?: string }[];
}

export interface DeploymentResult {
  environment: "staging" | "production";
  url?: string;
  version: string;
  status: "success" | "failed" | "rolled_back";
  deployedAt: string;
  rollbackAvailable: boolean;
}

// ─── State ───

interface PipelineState {
  schemaVersion: number;
  runs: PipelineRun[];
  issues: Issue[];
  plans: ImplementationPlan[];
  deployments: DeploymentResult[];
}

export class CodePipelineService {
  private store: DurableJsonState<PipelineState>;

  constructor(private baseDir: string) {
    this.store = new DurableJsonState<PipelineState>(
      join(baseDir, "code-pipeline.json"),
      () => ({ schemaVersion: 1, runs: [], issues: [], plans: [], deployments: [] }),
      (v) => { const s = v as PipelineState; return !!s && s.schemaVersion === 1; },
      "Code pipeline service",
    );
  }

  async init(): Promise<void> { await this.store.read(); }

  // ─── Issue Management ───

  async createIssue(tenantId: string, title: string, description: string, labels: string[] = [], priority: Issue["priority"] = "medium"): Promise<Issue> {
    const issue: Issue = {
      id: randomUUID(),
      title,
      description,
      labels,
      priority,
      status: "open",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.store.mutate(s => { s.issues.push(issue); });
    return issue;
  }

  async getIssues(tenantId: string, status?: Issue["status"]): Promise<Issue[]> {
    const s = await this.store.read();
    return s.issues.filter(i => !status || i.status === status);
  }

  // ─── Pipeline Execution ───

  async startPipeline(tenantId: string, issueId: string): Promise<PipelineRun> {
    const s = await this.store.read();
    const issue = s.issues.find(i => i.id === issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);

    const stages: PipelineStage[] = ["issue", "plan", "branch", "implement", "test", "security_review", "pr", "ci", "deploy"];

    const run: PipelineRun = {
      id: randomUUID(),
      tenantId,
      issueId,
      title: issue.title,
      description: issue.description,
      stages: stages.map(stage => ({ stage, status: "pending" })),
      currentStage: "issue",
      status: "pending",
      metadata: {},
      createdAt: new Date().toISOString(),
    };

    await this.store.mutate(s => { s.runs.push(run); });
    return run;
  }

  async executePipeline(runId: string): Promise<PipelineRun> {
    const s = await this.store.read();
    const run = s.runs.find(r => r.id === runId);
    if (!run) throw new Error(`Pipeline run not found: ${runId}`);

    const stages: PipelineStage[] = ["issue", "plan", "branch", "implement", "test", "security_review", "pr", "ci", "deploy"];

    // Execute all stages, updating state after each
    for (const stage of stages) {
      await this.store.mutate(state => {
        const r = state.runs.find(x => x.id === runId);
        if (!r) return;
        r.status = "running";
        r.startedAt = r.startedAt ?? new Date().toISOString();
        r.currentStage = stage;
        const stageState = r.stages.find(s => s.stage === stage);
        if (stageState) {
          stageState.status = "running";
          stageState.startedAt = new Date().toISOString();
        }
      });

      try {
        const result = await this.executeStage(run, stage);
        await this.store.mutate(state => {
          const r = state.runs.find(x => x.id === runId);
          if (!r) return;
          const stageState = r.stages.find(s => s.stage === stage);
          if (stageState) {
            stageState.status = "completed";
            stageState.result = result;
            stageState.completedAt = new Date().toISOString();
            stageState.durationMs = new Date(stageState.completedAt).getTime() - new Date(stageState.startedAt!).getTime();
          }
        });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await this.store.mutate(state => {
          const r = state.runs.find(x => x.id === runId);
          if (!r) return;
          const stageState = r.stages.find(s => s.stage === stage);
          if (stageState) {
            stageState.status = "failed";
            stageState.error = errorMsg;
          }
          r.status = "failed";
          r.error = errorMsg;
          r.completedAt = new Date().toISOString();
        });
        throw err;
      }
    }

    await this.store.mutate(state => {
      const r = state.runs.find(x => x.id === runId);
      if (r) { r.status = "completed"; r.completedAt = new Date().toISOString(); }
    });
    return run;
  }

  async getPipelineRuns(tenantId: string, status?: PipelineRun["status"]): Promise<PipelineRun[]> {
    const s = await this.store.read();
    return s.runs.filter(r => r.tenantId === tenantId && (!status || r.status === status));
  }

  async getPipelineRun(id: string): Promise<PipelineRun | undefined> {
    const s = await this.store.read();
    return s.runs.find(r => r.id === id);
  }

  // ─── Stage Execution ───

  private async executeStage(run: PipelineRun, stage: PipelineStage): Promise<unknown> {
    switch (stage) {
      case "issue":
        return this.processIssue(run);
      case "plan":
        return this.createPlan(run);
      case "branch":
        return this.createBranch(run);
      case "implement":
        return this.implement(run);
      case "test":
        return this.runTests(run);
      case "security_review":
        return this.securityReview(run);
      case "pr":
        return this.createPR(run);
      case "ci":
        return this.runCI(run);
      case "deploy":
        return this.deploy(run);
      default:
        return {};
    }
  }

  private async processIssue(run: PipelineRun): Promise<{ analyzed: boolean }> {
    // Analyze issue requirements
    return { analyzed: true };
  }

  private async createPlan(run: PipelineRun): Promise<ImplementationPlan> {
    const plan: ImplementationPlan = {
      id: randomUUID(),
      issueId: run.issueId,
      steps: [
        { id: randomUUID(), description: "Analyze requirements", files: [], estimatedMinutes: 15, status: "pending" },
        { id: randomUUID(), description: "Implement changes", files: [], estimatedMinutes: 60, status: "pending" },
        { id: randomUUID(), description: "Write tests", files: [], estimatedMinutes: 30, status: "pending" },
      ],
      estimatedDuration: "2h",
      risks: [],
      dependencies: [],
      createdAt: new Date().toISOString(),
    };

    await this.store.mutate(s => { s.plans.push(plan); });
    return plan;
  }

  private async createBranch(run: PipelineRun): Promise<{ branch: string }> {
    const branch = `feature/${run.issueId.slice(0, 8)}-${run.title.toLowerCase().replace(/\s+/g, "-").slice(0, 30)}`;
    run.metadata.branch = branch;
    return { branch };
  }

  /**
   * Stages below are NOT implemented.
   *
   * They previously returned fabricated success: `securityReview` reported
   * `score: 100, passed: true` without inspecting anything, `runCI` reported
   * every job green, `deploy` reported a successful deployment, and `createPR`
   * invented a PR number with `Math.random()`.
   *
   * That is the most dangerous shape a stub can take — a caller cannot tell a
   * passing gate from an absent one, so an unreviewed change looks approved.
   * Each stage now fails loudly instead. Wiring a real implementation means
   * replacing the throw, not removing the guard.
   */
  private notImplemented(stage: string, requirement: string): never {
    throw new CodePipelineStageNotImplementedError(stage, requirement);
  }

  private async implement(_run: PipelineRun): Promise<{ filesChanged: number; linesAdded: number; linesRemoved: number }> {
    this.notImplemented("implement", "a code-generation backend that edits the worktree");
  }

  private async runTests(_run: PipelineRun): Promise<TestResult> {
    // Returning an all-zero TestResult reads as "0 failures" to every caller,
    // which is indistinguishable from a green run. Refuse instead.
    this.notImplemented("test", "a test runner bound to the project's toolchain");
  }

  private async securityReview(_run: PipelineRun): Promise<SecurityReviewResult> {
    this.notImplemented("security_review", "a real scanner (SAST/dependency audit) reporting findings");
  }

  private async createPR(_run: PipelineRun): Promise<{ prNumber: number; url: string }> {
    this.notImplemented("pr", "a hosted-repository provider able to open a pull request");
  }

  private async runCI(_run: PipelineRun): Promise<{ passed: boolean; jobs: string[] }> {
    this.notImplemented("ci", "a CI provider reporting real job results");
  }

  private async deploy(_run: PipelineRun): Promise<DeploymentResult> {
    this.notImplemented("deploy", "a deployment target with a verifiable rollout status");
  }

  // ─── Rollback ───

  async rollback(runId: string): Promise<{ success: boolean; targetVersion: string }> {
    const run = (await this.store.read()).runs.find(r => r.id === runId);
    if (!run) throw new Error(`Pipeline run not found: ${runId}`);

    await this.store.mutate(s => {
      const r = s.runs.find(x => x.id === runId);
      if (r) r.status = "rolled_back";
      const deployment = s.deployments.find(d => d.version === run.metadata.commitSha);
      if (deployment) deployment.status = "rolled_back";
    });

    return { success: true, targetVersion: run.metadata.rollbackTarget ?? "previous" };
  }

  // ─── Stats ───

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const runs = s.runs.filter(r => r.tenantId === tenantId);
    const byStatus: Record<string, number> = {};
    const byStage: Record<string, number> = {};
    for (const r of runs) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      byStage[r.currentStage] = (byStage[r.currentStage] ?? 0) + 1;
    }
    const completedRuns = runs.filter(r => r.status === "completed");
    const avgDuration = completedRuns.length > 0
      ? completedRuns.reduce((sum, r) => sum + (r.completedAt && r.startedAt ? new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime() : 0), 0) / completedRuns.length
      : 0;

    return {
      totalRuns: runs.length,
      totalIssues: s.issues.length,
      totalDeployments: s.deployments.length,
      byStatus,
      byStage,
      avgDurationMs: Math.round(avgDuration),
      successRate: runs.length > 0 ? completedRuns.length / runs.length : 0,
    };
  }
}
