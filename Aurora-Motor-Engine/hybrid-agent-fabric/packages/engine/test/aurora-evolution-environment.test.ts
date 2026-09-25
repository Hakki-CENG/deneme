import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvironmentAwarenessService } from "../src/environment/environment-awareness-service.js";
import { SkillEvolutionService } from "../src/evolution/skill-evolution-service.js";

async function evolution(now?: () => number): Promise<SkillEvolutionService> {
  const root = await mkdtemp(join(tmpdir(), "haf-aurora-evolution-"));
  return now ? new SkillEvolutionService(root, now) : new SkillEvolutionService(root);
}

async function promoteToProduction(service: SkillEvolutionService, tenantId: string, name: string): Promise<string> {
  const candidate = await service.createBlueprint({ tenantId, name, purpose: `Purpose of ${name}`, tools: ["web.fetch"], risks: ["network egress"], tests: ["golden-set"] });
  await service.advanceStage({ tenantId, candidateId: candidate.id, to: "sandbox", actor: "skill-builder", reason: "Design reviewed." });
  await service.recordEvaluation({ tenantId, candidateId: candidate.id, suite: "sandbox", passed: 95, failed: 5, averageLatencyMs: 800 });
  await service.advanceStage({ tenantId, candidateId: candidate.id, to: "test", actor: "skill-builder", reason: "Sandbox evidence recorded." });
  await service.recordEvaluation({ tenantId, candidateId: candidate.id, suite: "integration", passed: 98, failed: 2, averageLatencyMs: 600, utility: 0.9 });
  await service.advanceStage({ tenantId, candidateId: candidate.id, to: "beta", actor: "skill-builder", reason: "Accuracy and safety floors met." });
  await service.recordUsage({ tenantId, candidateId: candidate.id, success: true, durationMs: 500 });
  await service.recordRegressionBaseline(tenantId, candidate.id, "integration", 0.95);
  await service.advanceStage({ tenantId, candidateId: candidate.id, to: "production", actor: "skill-director", reason: "Beta usage is healthy.", approval: { actor: "human-reviewer", reason: "Reviewed evidence and safety findings." } });
  return candidate.id;
}

describe("Aurora Phase F skill and workflow evolution", () => {
  it("deduplicates capability gaps and recommends a candidate after repeated friction", async () => {
    const service = await evolution();
    const first = await service.observeGap({ tenantId: "tenant", kind: "friction", description: "Cannot analyse a YouTube video transcript automatically." });
    expect(first.gap.occurrences).toBe(1);
    expect(first.candidateRecommended).toBe(false);
    await service.observeGap({ tenantId: "tenant", kind: "friction", description: "cannot analyse a youtube video transcript automatically" });
    const third = await service.observeGap({ tenantId: "tenant", kind: "friction", description: "Cannot analyse a YouTube video transcript automatically!" });
    expect(third.gap.id).toBe(first.gap.id);
    expect(third.gap.occurrences).toBe(3);
    expect(third.candidateRecommended).toBe(true);
    expect((await service.gaps("tenant", "open"))).toHaveLength(1);
  });

  it("refuses to skip evolution stages and enforces evidence gates", async () => {
    const service = await evolution();
    const candidate = await service.createBlueprint({ tenantId: "tenant", name: "VideoAnalyzer", purpose: "Analyse videos.", tools: ["ffmpeg"], risks: [], tests: [] });
    await expect(service.advanceStage({ tenantId: "tenant", candidateId: candidate.id, to: "production", actor: "agent", reason: "Skip." })).rejects.toThrow("forbidden");
    await expect(service.advanceStage({ tenantId: "tenant", candidateId: candidate.id, to: "sandbox", actor: "agent", reason: "No tests declared." })).rejects.toThrow("declared test");
    const readiness = await service.stageReadiness("tenant", candidate.id);
    expect(readiness.next).toBe("sandbox");
    expect(readiness.blockers.length).toBeGreaterThan(0);
  });

  it("requires approval, regression baseline and score floors for production", async () => {
    const service = await evolution();
    const candidate = await service.createBlueprint({ tenantId: "tenant", name: "PaperAnalyzer", purpose: "Analyse papers.", tools: ["web.fetch"], risks: ["network"], tests: ["golden-set"] });
    await service.advanceStage({ tenantId: "tenant", candidateId: candidate.id, to: "sandbox", actor: "builder", reason: "Design reviewed." });
    await service.recordEvaluation({ tenantId: "tenant", candidateId: candidate.id, suite: "sandbox", passed: 60, failed: 40, safetyFindings: 1 });
    await service.advanceStage({ tenantId: "tenant", candidateId: candidate.id, to: "test", actor: "builder", reason: "Sandbox evidence." });
    await expect(service.advanceStage({ tenantId: "tenant", candidateId: candidate.id, to: "beta", actor: "builder", reason: "Force." })).rejects.toThrow("below the 0.7 beta floor");
    await service.recordEvaluation({ tenantId: "tenant", candidateId: candidate.id, suite: "integration", passed: 140, failed: 0, utility: 0.8 });
    await expect(service.advanceStage({ tenantId: "tenant", candidateId: candidate.id, to: "beta", actor: "builder", reason: "Accuracy recovered." })).rejects.toThrow("Safety");
    await service.recordEvaluation({ tenantId: "tenant", candidateId: candidate.id, suite: "safety-remediation", passed: 40, failed: 0, utility: 0.8 });
    const promoted = await service.advanceStage({ tenantId: "tenant", candidateId: candidate.id, to: "beta", actor: "builder", reason: "Safety finding remediated with two clean suites." });
    expect(promoted.stage).toBe("beta");
    await expect(service.advanceStage({ tenantId: "tenant", candidateId: candidate.id, to: "production", actor: "builder", reason: "Ship." })).rejects.toThrow("approval");
    await service.recordUsage({ tenantId: "tenant", candidateId: candidate.id, success: true, durationMs: 400 });
    await expect(service.advanceStage({ tenantId: "tenant", candidateId: candidate.id, to: "production", actor: "builder", reason: "Ship.", approval: { actor: "human", reason: "Reviewed." } })).rejects.toThrow("regression baseline");
    await service.recordRegressionBaseline("tenant", candidate.id, "integration", 0.95);
    const production = await service.advanceStage({ tenantId: "tenant", candidateId: candidate.id, to: "production", actor: "builder", reason: "Ship.", approval: { actor: "human", reason: "Reviewed." } });
    expect(production.stage).toBe("production");
    expect(production.version).toBe("1.0.0");
    expect(production.approvals).toHaveLength(1);
  });

  it("blocks regressions against recorded baselines", async () => {
    const service = await evolution();
    const id = await promoteToProduction(service, "tenant", "RepositoryMonitor");
    const clean = await service.checkRegression("tenant", id, [{ suite: "integration", passRate: 0.96 }]);
    expect(clean.passed).toBe(true);
    const regressed = await service.checkRegression("tenant", id, [{ suite: "integration", passRate: 0.8 }]);
    expect(regressed.passed).toBe(false);
    expect(regressed.violations[0]).toMatchObject({ suite: "integration", baseline: 0.95, observed: 0.8 });
    expect((await service.journalEntries("tenant")).some((entry) => entry.kind === "regression")).toBe(true);
  });

  it("composes skills, protects members from retirement and sweeps unused skills", async () => {
    let now = Date.parse("2026-06-01T12:00:00Z");
    const service = await evolution(() => now);
    const research = await promoteToProduction(service, "tenant", "ResearchSkill");
    const summarizer = await promoteToProduction(service, "tenant", "Summarizer");
    const composite = await service.createBlueprint({ tenantId: "tenant", name: "ResearchAssistant", purpose: "Research then summarize.", tools: ["compose"], risks: ["chained failures"], tests: ["pipeline"], compositeOfIds: [research, summarizer] });
    const graph = await service.compositionGraph("tenant");
    expect(graph.find((node) => node.id === composite.id)?.members.sort()).toEqual([research, summarizer].sort());
    expect(graph.find((node) => node.id === research)?.dependents).toContain(composite.id);
    await expect(service.retire({ tenantId: "tenant", candidateId: research, reason: "No longer needed." })).rejects.toThrow("composite");
    now += 200 * 86_400_000;
    const retired = await service.sweepRetirement("tenant", { maxIdleDays: 90 });
    expect(retired.length).toBe(0);
    await service.retire({ tenantId: "tenant", candidateId: composite.id, reason: "Superseded by a workflow." });
    const swept = await service.sweepRetirement("tenant", { maxIdleDays: 90 });
    expect(swept.map((item) => item.candidateId).sort()).toEqual([research, summarizer].sort());
  });

  it("tracks workflow evolution, bottlenecks and the cognitive evolution index", async () => {
    const service = await evolution();
    await service.recordWorkflowVersion({ tenantId: "tenant", name: "research", steps: ["search", "summarize", "store"], averageDurationMs: 120_000, successRate: 0.6, rationale: "Original process." });
    const evolved = await service.recordWorkflowVersion({ tenantId: "tenant", name: "research", steps: ["search", "verify", "compare", "summarize", "store"], averageDurationMs: 90_000, successRate: 0.85, rationale: "Added verification and comparison.", bottleneckStep: "compare" });
    expect(evolved.version).toBe(2);
    expect(evolved.supersedesVersionId).toBeTruthy();
    const bottlenecks = await service.workflowBottlenecks("tenant");
    expect(bottlenecks[0]).toMatchObject({ name: "research", latestVersion: 2, bottleneckStep: "compare" });
    expect(bottlenecks[0]?.successTrend).toBeCloseTo(0.25, 5);

    const before = await service.evolutionIndex("tenant");
    await promoteToProduction(service, "tenant", "GraphIndexer");
    const after = await service.evolutionIndex("tenant");
    expect(after.productionSkills).toBe(1);
    expect(after.index).toBeGreaterThan(before.index);
    expect(after.delta).toBeGreaterThan(0);
    expect((await service.journalEntries("tenant")).length).toBeGreaterThan(0);
  });
});

describe("Aurora Phase G environment awareness and embodiment", () => {
  async function environment(now?: () => number): Promise<EnvironmentAwarenessService> {
    const root = await mkdtemp(join(tmpdir(), "haf-aurora-env-"));
    return now ? new EnvironmentAwarenessService(root, now) : new EnvironmentAwarenessService(root);
  }

  it("inventories resources by kind and safe execution zone", async () => {
    const service = await environment();
    await service.registerResource({ tenantId: "tenant", kind: "filesystem", name: "Workspace", locator: "/workspaces/aurora", zone: 1, capabilityIds: ["fs.read", "fs.write"] });
    const database = await service.registerResource({ tenantId: "tenant", kind: "database", name: "Primary Postgres", locator: "postgres://primary", zone: 4 });
    expect(database.requiresApproval).toBe(true);
    const inventory = await service.inventory("tenant");
    expect(inventory.totals.resources).toBe(2);
    expect(inventory.byZone["zone-4"]).toBe(1);
    expect(inventory.byKind["filesystem"]).toBe(1);
    expect(await service.resources("tenant", { maxZone: 1 })).toHaveLength(1);
  });

  it("links goal, plan, action, result, verification and memory updates", async () => {
    const service = await environment();
    const resource = await service.registerResource({ tenantId: "tenant", kind: "git", name: "Repo", locator: "/workspaces/aurora/.git", zone: 2 });
    const action = await service.planAction({
      tenantId: "tenant", resourceId: resource.id, goal: "Keep the repository backed up",
      plan: ["Check remotes", "Push the main branch"], action: "git.push", parameters: { branch: "main" },
      expectedOutcome: "The remote contains the latest commit.",
    });
    expect(action.status).toBe("planned");
    await service.startAction("tenant", action.id);
    const completed = await service.completeAction({ tenantId: "tenant", actionId: action.id, success: true, summary: "Pushed 3 commits.", durationMs: 1200 });
    expect(completed.status).toBe("completed");
    expect((await service.unverifiedActions("tenant"))).toHaveLength(1);
    const verified = await service.verifyAction({ tenantId: "tenant", actionId: action.id, method: "git ls-remote comparison", passed: true, evidenceRefs: ["evt-1"], memoryUpdateRefs: ["mem-1"] });
    expect(verified.status).toBe("verified");
    expect(verified.memoryUpdateRefs).toEqual(["mem-1"]);
    expect((await service.unverifiedActions("tenant"))).toHaveLength(0);
    const updated = (await service.resources("tenant")).find((item) => item.id === resource.id)!;
    expect(updated.health.successes).toBe(1);
    expect(updated.health.reputation).toBeGreaterThan(0.5);
  });

  it("requires approval and a rollback plan for high zones and supports rollback", async () => {
    const service = await environment();
    const resource = await service.registerResource({ tenantId: "tenant", kind: "database", name: "Prod DB", locator: "postgres://prod", zone: 4 });
    await expect(service.planAction({ tenantId: "tenant", resourceId: resource.id, goal: "Drop stale table", plan: ["Verify usage"], action: "sql.execute", expectedOutcome: "Table removed." })).rejects.toThrow("rollback plan");
    const action = await service.planAction({ tenantId: "tenant", resourceId: resource.id, goal: "Drop stale table", plan: ["Verify usage", "Drop table"], action: "sql.execute", expectedOutcome: "Table removed.", rollbackPlan: "Restore from the pre-action snapshot." });
    await expect(service.startAction("tenant", action.id)).rejects.toThrow("approval");
    await service.approveAction({ tenantId: "tenant", actionId: action.id, actor: "human", reason: "Reviewed the migration plan." });
    await service.startAction("tenant", action.id);
    await service.completeAction({ tenantId: "tenant", actionId: action.id, success: false, summary: "Constraint violation.", durationMs: 900, unexpected: true });
    const rolled = await service.rollbackAction({ tenantId: "tenant", actionId: action.id, reason: "Restored the snapshot after the failure." });
    expect(rolled.status).toBe("rolled-back");
    expect((await service.inventory("tenant")).unexpectedOutcomes).toBe(1);
  });

  it("degrades unreliable tools through execution reputation", async () => {
    const service = await environment();
    const resource = await service.registerResource({ tenantId: "tenant", kind: "api", name: "Flaky API", locator: "https://api.example.com", zone: 2 });
    for (let index = 0; index < 4; index++) {
      const action = await service.planAction({ tenantId: "tenant", resourceId: resource.id, goal: "Fetch data", plan: ["Call endpoint"], action: "api.call", expectedOutcome: "200 response." });
      await service.startAction("tenant", action.id);
      await service.completeAction({ tenantId: "tenant", actionId: action.id, success: false, summary: "Timeout.", durationMs: 30_000 });
    }
    const degraded = (await service.resources("tenant")).find((item) => item.id === resource.id)!;
    expect(degraded.status).toBe("degraded");
    expect(degraded.health.reputation).toBeLessThan(0.4);
    expect((await service.inventory("tenant")).lowReputation).toHaveLength(1);
  });

  it("tracks project awareness and workspace habits", async () => {
    let now = Date.parse("2026-07-01T12:00:00Z");
    const service = await environment(() => now);
    await service.upsertProject({ tenantId: "tenant", name: "Aurora", workspacePath: "/workspaces/aurora", openTasks: 4, risks: ["memory layer stalled"], progress: 0.35 });
    expect(await service.staleProjects("tenant", 7)).toHaveLength(0);
    now += 10 * 86_400_000;
    const stale = await service.staleProjects("tenant", 7);
    expect(stale[0]?.idleDays).toBeGreaterThanOrEqual(7);
    await service.recordHabit({ tenantId: "tenant", scope: "aurora", pattern: "run tests before commit", success: true });
    const habit = await service.recordHabit({ tenantId: "tenant", scope: "aurora", pattern: "run tests before commit", success: false });
    expect(habit.occurrences).toBe(2);
    expect(habit.successRate).toBe(0.5);
  });
});
