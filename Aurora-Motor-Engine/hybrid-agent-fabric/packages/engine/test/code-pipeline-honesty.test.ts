/**
 * Code pipeline honesty.
 *
 * `CodePipelineService` is reachable from `engine.codePipeline`, and several of
 * its stages used to fabricate success:
 *
 *   - `securityReview()` returned `score: 100, passed: true` having inspected
 *     nothing
 *   - `runCI()` returned every job green
 *   - `deploy()` returned a successful deployment
 *   - `createPR()` invented a PR number with `Math.random()`
 *   - `runTests()` returned an all-zero `TestResult`, which reads as
 *     "no failures" to every caller
 *
 * A stub that reports success is worse than a missing feature: callers cannot
 * distinguish an approved change from an unreviewed one. These tests pin the
 * corrected behaviour — the stages now fail loudly and say what they need.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CodePipelineService,
  CodePipelineStageNotImplementedError,
} from "../src/pipeline/code-pipeline-service.js";

async function service(): Promise<CodePipelineService> {
  const root = await mkdtemp(join(tmpdir(), "haf-code-pipeline-"));
  return new CodePipelineService(root);
}

describe("unimplemented stages refuse to fake success", () => {
  it("fails the run instead of reporting a clean security review", async () => {
    const pipeline = await service();
    const issue = await pipeline.createIssue("t", "Add feature", "Implement the thing");
    const run = await pipeline.startPipeline("t", issue.id);

    await expect(pipeline.executePipeline(run.id)).rejects.toThrow(CodePipelineStageNotImplementedError);

    const stored = await pipeline.getPipelineRun(run.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toBeTruthy();
  });

  it("names the stage and what implementing it would require", async () => {
    const pipeline = await service();
    const issue = await pipeline.createIssue("t", "Another change", "Do the work");
    const run = await pipeline.startPipeline("t", issue.id);

    let caught: unknown;
    try {
      await pipeline.executePipeline(run.id);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CodePipelineStageNotImplementedError);
    const failure = caught as CodePipelineStageNotImplementedError;
    expect(failure.stage.length).toBeGreaterThan(0);
    expect(failure.requirement.length).toBeGreaterThan(0);
    // The message must be actionable, not a bare "not implemented".
    expect(failure.message).toContain("requires");
  });

  it("marks the failing stage as failed rather than completed", async () => {
    const pipeline = await service();
    const issue = await pipeline.createIssue("t", "Third change", "Work");
    const run = await pipeline.startPipeline("t", issue.id);

    await pipeline.executePipeline(run.id).catch(() => undefined);

    const stored = await pipeline.getPipelineRun(run.id);
    const failed = stored?.stages.filter((stage) => stage.status === "failed") ?? [];

    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.error).toBeTruthy();

    // Critically: no stage may be recorded as completed with a fabricated
    // result once the pipeline has failed.
    const completedWithFakeSuccess = (stored?.stages ?? []).filter(
      (stage) => stage.status === "completed" && stage.stage === "security_review",
    );
    expect(completedWithFakeSuccess).toHaveLength(0);
  });

  it("never records a deployment for a run that failed", async () => {
    const pipeline = await service();
    const issue = await pipeline.createIssue("t", "Deploy attempt", "Should not deploy");
    const run = await pipeline.startPipeline("t", issue.id);

    await pipeline.executePipeline(run.id).catch(() => undefined);

    const stats = await pipeline.getStats("t");
    expect(stats.totalRuns).toBeGreaterThan(0);

    const stored = await pipeline.getPipelineRun(run.id);
    expect(stored?.status).toBe("failed");
    // A failed pipeline must not leave a success-shaped deployment behind.
    expect(stored?.metadata.prNumber).toBeUndefined();
  });
});

describe("stats reflect failures honestly", () => {
  it("counts a failed run as failed, not completed", async () => {
    const pipeline = await service();
    const issue = await pipeline.createIssue("t", "Failing run", "Work");
    const run = await pipeline.startPipeline("t", issue.id);

    await pipeline.executePipeline(run.id).catch(() => undefined);

    const stats = await pipeline.getStats("t");
    expect(stats.byStatus["completed"] ?? 0).toBe(0);
    expect(stats.byStatus["failed"] ?? 0).toBeGreaterThan(0);
  });
});
