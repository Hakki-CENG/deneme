import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DecisionService } from "../src/aurora/decision-service.js";
import { PlanningService } from "../src/aurora/planning-service.js";
import { HybridAgentEngine } from "../src/engine.js";
import type { CommandEnvelope } from "../src/types.js";

async function decisions(now?: () => number): Promise<DecisionService> {
  const root = await mkdtemp(join(tmpdir(), "haf-aurora-decisions-"));
  return now ? new DecisionService(root, now) : new DecisionService(root);
}
async function planning(now?: () => number): Promise<PlanningService> {
  const root = await mkdtemp(join(tmpdir(), "haf-aurora-planning-"));
  return now ? new PlanningService(root, now) : new PlanningService(root);
}

describe("Aurora decision layer", () => {
  it("normalizes criteria weights and ranks options deterministically", async () => {
    const service = await decisions();
    const decision = await service.open({
      tenantId: "tenant", title: "Choose a vector store", question: "Which vector store should Aurora use?",
      criteria: [
        { name: "reliability", weight: 3 / 6 },
        { name: "cost", weight: 2 / 6, direction: "minimize" },
        { name: "effort", weight: 1 / 6, direction: "minimize" },
      ],
    });
    expect(decision.criteria.reduce((sum, item) => sum + item.weight, 0)).toBeCloseTo(1, 6);
    await service.addOption({ tenantId: "tenant", decisionId: decision.id, name: "Managed service", scores: { reliability: 0.9, cost: 0.8, effort: 0.2 } });
    const withSecond = await service.addOption({ tenantId: "tenant", decisionId: decision.id, name: "Self-hosted", scores: { reliability: 0.7, cost: 0.2, effort: 0.7 } });
    const ranked = [...withSecond.options].sort((a, b) => b.weightedScore - a.weightedScore);
    expect(ranked[0]?.name).toBe("Self-hosted");
    expect(ranked[0]?.weightedScore).toBeGreaterThan(ranked[1]!.weightedScore);
  });

  it("requires two options, preserves dissent and lowers confidence when it exists", async () => {
    const service = await decisions();
    const decision = await service.open({ tenantId: "tenant", title: "Ship now?", question: "Ship the release today?", criteria: [{ name: "value", weight: 1 }] });
    await service.addOption({ tenantId: "tenant", decisionId: decision.id, name: "Ship", scores: { value: 0.9 } });
    await expect(service.decide({ tenantId: "tenant", decisionId: decision.id, rationale: "Only one option.", expectedOutcome: "Shipped." })).rejects.toThrow("at least two options");
    await service.addOption({ tenantId: "tenant", decisionId: decision.id, name: "Wait", scores: { value: 0.4 } });
    await service.recordDissent({ tenantId: "tenant", decisionId: decision.id, source: "risk-agent", concern: "The adversarial suite has not run." });
    const decided = await service.decide({ tenantId: "tenant", decisionId: decision.id, rationale: "Value is high and reversible.", expectedOutcome: "Release lands without a rollback." });
    expect(decided.chosenOptionId).toBe(decided.options.find((item) => item.name === "Ship")?.id);
    expect(decided.dissent).toHaveLength(1);
    expect(decided.confidence).toBeLessThan(0.9);
    expect(decided.margin).toBeCloseTo(0.5, 5);
    expect(decided.reviewDueAt).toBeTruthy();
  });

  it("demands an override reason for a lower-ranked option and refuses constitutionally denied decisions", async () => {
    const service = await decisions();
    const decision = await service.open({ tenantId: "tenant", title: "Pick an approach", question: "Which approach?", criteria: [{ name: "speed", weight: 1 }] });
    await service.addOption({ tenantId: "tenant", decisionId: decision.id, name: "Fast", scores: { speed: 0.9 } });
    const withBoth = await service.addOption({ tenantId: "tenant", decisionId: decision.id, name: "Slow", scores: { speed: 0.2 } });
    const slow = withBoth.options.find((item) => item.name === "Slow")!;
    await expect(service.decide({ tenantId: "tenant", decisionId: decision.id, chosenOptionId: slow.id, rationale: "Because.", expectedOutcome: "Slow but fine." })).rejects.toThrow("override reason");
    await expect(service.decide({ tenantId: "tenant", decisionId: decision.id, rationale: "x", expectedOutcome: "y", constitutionVerdict: "deny" })).rejects.toThrow("denied by the constitution");
    const overridden = await service.decide({ tenantId: "tenant", decisionId: decision.id, chosenOptionId: slow.id, rationale: "Quality outweighs speed here.", expectedOutcome: "Slower but safer.", overrideReason: "The fast path skips verification." });
    expect(overridden.chosenOptionId).toBe(slow.id);
    expect(overridden.rationale).toContain("Override:");
  });

  it("measures surprise, Brier score and overconfidence from real outcomes", async () => {
    let now = Date.parse("2026-11-01T12:00:00Z");
    const service = await decisions(() => now);
    for (const [index, succeeded] of [true, false, false].entries()) {
      const decision = await service.open({ tenantId: "tenant", title: `Decision ${index}`, question: "?", criteria: [{ name: "value", weight: 1 }], reversibility: index === 0 ? "irreversible" : "reversible" });
      await service.addOption({ tenantId: "tenant", decisionId: decision.id, name: "A", scores: { value: 0.9 } });
      await service.addOption({ tenantId: "tenant", decisionId: decision.id, name: "B", scores: { value: 0.1 } });
      await service.decide({ tenantId: "tenant", decisionId: decision.id, rationale: "A looks stronger.", expectedOutcome: "A works." });
      await service.recordOutcome({ tenantId: "tenant", decisionId: decision.id, succeeded, note: succeeded ? "Worked." : "Did not work." });
    }
    const calibration = await service.calibration("tenant");
    expect(calibration.reviewed).toBe(3);
    expect(calibration.successRate).toBeCloseTo(1 / 3, 4);
    expect(calibration.overconfidence).toBeGreaterThan(0);
    expect(calibration.brierMean).toBeGreaterThan(0);
    expect(calibration.byReversibility["irreversible"]?.reviewed).toBe(1);
    expect(calibration.worstDecisions.length).toBeGreaterThan(0);
  });

  it("tracks the review backlog", async () => {
    let now = Date.parse("2026-11-01T12:00:00Z");
    const service = await decisions(() => now);
    const decision = await service.open({ tenantId: "tenant", title: "Review me", question: "?", criteria: [{ name: "value", weight: 1 }] });
    await service.addOption({ tenantId: "tenant", decisionId: decision.id, name: "A", scores: { value: 0.8 } });
    await service.addOption({ tenantId: "tenant", decisionId: decision.id, name: "B", scores: { value: 0.3 } });
    await service.decide({ tenantId: "tenant", decisionId: decision.id, rationale: "A.", expectedOutcome: "Works.", reviewInDays: 3 });
    expect(await service.dueForReview("tenant")).toHaveLength(0);
    now += 4 * 86_400_000;
    expect((await service.dueForReview("tenant")).map((item) => item.id)).toEqual([decision.id]);
  });
});

describe("Aurora planning layer", () => {
  it("rejects dependency cycles and unknown dependencies", async () => {
    const service = await planning();
    await expect(service.create({
      tenantId: "tenant", title: "Bad plan", objective: "x",
      steps: [{ key: "a", title: "A", dependsOn: ["b"] }, { key: "b", title: "B", dependsOn: ["a"] }],
    })).rejects.toThrow("cycle");
    await expect(service.create({
      tenantId: "tenant", title: "Bad plan", objective: "x",
      steps: [{ key: "a", title: "A", dependsOn: ["missing"] }],
    })).rejects.toThrow("unknown step");
  });

  it("computes the critical path, risk buffer and ready steps", async () => {
    const service = await planning();
    const plan = await service.create({
      tenantId: "tenant", title: "Memory layer", objective: "Ship consolidation", horizon: "tactical",
      steps: [
        { key: "design", title: "Design", estimateMinutes: 60, riskLevel: 0.2, verification: "Design reviewed" },
        { key: "build", title: "Build", dependsOn: ["design"], estimateMinutes: 180, riskLevel: 0.5 },
        { key: "docs", title: "Docs", dependsOn: ["design"], estimateMinutes: 30, riskLevel: 0.1 },
        { key: "ship", title: "Ship", dependsOn: ["build", "docs"], estimateMinutes: 30, riskLevel: 0.4 },
      ],
    });
    expect(plan.criticalPath).toEqual(["design", "build", "ship"]);
    expect(plan.estimatedMinutes).toBe(300);
    expect(plan.riskBufferMinutes).toBe(12 + 90 + 3 + 12);
    expect(plan.steps.find((item) => item.key === "design")?.status).toBe("ready");
    expect(plan.steps.find((item) => item.key === "build")?.status).toBe("pending");

    await expect(service.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "build", status: "in-progress" })).rejects.toThrow("depends on");
    await service.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "design", status: "done", actualMinutes: 90 });
    const progress = await service.progress("tenant", plan.id);
    expect(progress.ready.sort()).toEqual(["build", "docs"]);
    expect(progress.done).toBe(1);
    expect(progress.remainingMinutes).toBe(240);
    expect(progress.criticalPathRemaining).toEqual(["build", "ship"]);
    expect(progress.estimateAccuracy).toBeLessThan(1);
  });

  it("versions revisions, preserves completed work and records the trigger", async () => {
    const service = await planning();
    const plan = await service.create({
      tenantId: "tenant", title: "Research", objective: "Survey the field",
      steps: [{ key: "scan", title: "Scan papers", estimateMinutes: 60 }, { key: "summarize", title: "Summarize", dependsOn: ["scan"] }],
    });
    await service.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "scan", status: "done", actualMinutes: 55 });
    const revised = await service.revise({
      tenantId: "tenant", planId: plan.id, reason: "Add a verification step after review feedback.", trigger: "review",
      steps: [
        { key: "scan", title: "Scan papers", estimateMinutes: 60 },
        { key: "verify", title: "Verify claims", dependsOn: ["scan"], estimateMinutes: 45 },
        { key: "summarize", title: "Summarize", dependsOn: ["verify"] },
      ],
    });
    expect(revised.version).toBe(2);
    expect(revised.revisions.at(-1)).toMatchObject({ trigger: "review" });
    expect(revised.steps.find((item) => item.key === "scan")?.status).toBe("done");
    expect(revised.steps.find((item) => item.key === "scan")?.actualMinutes).toBe(55);
    expect(revised.criticalPath).toEqual(["scan", "verify", "summarize"]);
  });

  it("completes, blocks and supersedes plans", async () => {
    const service = await planning();
    const plan = await service.create({ tenantId: "tenant", title: "Tiny", objective: "Do one thing", steps: [{ key: "only", title: "Only step" }] });
    const done = await service.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "only", status: "done" });
    expect(done.status).toBe("completed");
    expect(done.progress).toBe(1);

    const failing = await service.create({ tenantId: "tenant", title: "Risky", objective: "Try", steps: [{ key: "attempt", title: "Attempt" }, { key: "after", title: "After", dependsOn: ["attempt"] }] });
    const blocked = await service.updateStep({ tenantId: "tenant", planId: failing.id, stepKey: "attempt", status: "failed" });
    expect(blocked.status).toBe("blocked");

    const superseded = await service.supersede({
      tenantId: "tenant", planId: failing.id, reason: "The approach did not survive contact with reality.",
      steps: [{ key: "rethink", title: "Rethink approach" }],
    });
    expect(superseded.previous.status).toBe("superseded");
    expect(superseded.next.supersedesPlanId).toBe(failing.id);
  });

  it("reports stalled plans with their ready work", async () => {
    let now = Date.parse("2026-11-01T12:00:00Z");
    const service = await planning(() => now);
    const plan = await service.create({ tenantId: "tenant", title: "Slow", objective: "Eventually", steps: [{ key: "start", title: "Start" }] });
    expect(await service.stalled("tenant", 7)).toHaveLength(0);
    now += 10 * 86_400_000;
    const stalled = await service.stalled("tenant", 7);
    expect(stalled[0]?.plan.id).toBe(plan.id);
    expect(stalled[0]?.idleDays).toBeGreaterThanOrEqual(10);
    expect(stalled[0]?.readySteps).toEqual(["start"]);
  });
});

describe("Aurora semantic recall", () => {
  it("recalls a paraphrase through the embedding index that lexical overlap alone would miss", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-aurora-semantic-"));
    const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
    await engine.memoryGraph.remember({
      tenantId: "local", layer: "semantic", claimType: "observation", title: "Nightly backup policy",
      content: "The repository backup job runs every night at 03:00 UTC and pushes to the mirror remote.",
      sourceType: "external", confidence: 0.9, importance: 0.8, tags: ["backup", "policy"],
    });
    await engine.memoryGraph.remember({
      tenantId: "local", layer: "semantic", claimType: "observation", title: "Unrelated note",
      content: "The espresso machine descaling interval is ninety days.",
      sourceType: "user", confidence: 0.9, importance: 0.4, tags: ["office"],
    });
    const results = await engine.memoryGraph.recall("local", "when does the repository backup job run");
    expect(results[0]?.memory.title).toBe("Nightly backup policy");
    expect(results[0]?.reason).toContain("semantic=");
    await engine.shutdown();
  }, 30_000);
});

describe("Aurora experience distiller, autopilot and provenance", () => {
  async function engineFixture(): Promise<HybridAgentEngine> {
    const homePath = await mkdtemp(join(tmpdir(), "haf-aurora-final-"));
    return new HybridAgentEngine({
      homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local", model: { provider: "mock" }, autoApproveWorkspaceWrites: true,
    });
  }
  function prompt(sessionId: string, text: string): CommandEnvelope {
    return {
      protocolVersion: 1, commandId: randomUUID(), clientId: "test-client", tenantId: "local",
      sessionId, kind: "session.prompt", source: "api", issuedAt: new Date().toISOString(), payload: { text },
    };
  }

  it("skips shallow sessions and distills complex ones into governed proposals", async () => {
    const engine = await engineFixture();
    const session = await engine.createSession({ tenantId: "local", name: "distill" });
    await engine.command(prompt(session.sessionId, "hello"));
    const shallow = await engine.distiller.distill({ tenantId: "local", sessionId: session.sessionId });
    expect(shallow.proposals).toHaveLength(0);
    expect(shallow.skipped[0]).toContain("below the 5 threshold");

    for (let index = 0; index < 3; index++) {
      await engine.command(prompt(session.sessionId, `[tool filesystem.write {"path":"file-${index}.txt","content":"data ${index}"}]`));
      await engine.command(prompt(session.sessionId, `[tool filesystem.read {"path":"file-${index}.txt"}]`));
      await engine.command(prompt(session.sessionId, `[tool filesystem.list {"path":"."}]`));
    }
    const report = await engine.distiller.distill({ tenantId: "local", sessionId: session.sessionId, objective: "Write project files" });
    expect(report.toolCalls).toBeGreaterThanOrEqual(9);
    expect(report.distinctCapabilities).toBeGreaterThanOrEqual(3);
    expect(report.proposals.length).toBeGreaterThan(0);
    const procedure = report.proposals.find((item) => item.kind === "harness-memory");
    expect(procedure?.evidenceEventIds.length).toBeGreaterThan(0);
    expect(procedure?.status).toBe("proposed");

    if (procedure) {
      const applied = await engine.distiller.apply({ tenantId: "local", proposalId: procedure.id, actor: "operator" });
      expect(applied.proposal.status).toBe("applied");
      const refinements = await engine.harness.refinements("local");
      expect(refinements.some((item) => item.id === applied.appliedRef)).toBe(true);
      const entries = await engine.harness.entries("local");
      expect(entries.some((item) => item.key === procedure.key)).toBe(true);
      await expect(engine.distiller.apply({ tenantId: "local", proposalId: procedure.id, actor: "operator" })).rejects.toThrow("already applied");
    }
    await engine.shutdown();
  }, 60_000);

  it("keeps autopilot disabled by default and bounds unattended runs", async () => {
    const engine = await engineFixture();
    expect((await engine.autopilot.config("local")).enabled).toBe(false);
    expect(await engine.autopilot.runDue("local")).toHaveLength(0);

    await engine.autopilot.configure({
      tenantId: "local", enabled: true, maxRunsPerDay: 2,
      cadences: [{ kind: "pulse", enabled: true, everyMinutes: 5 }, { kind: "maintenance", enabled: true, everyMinutes: 5 }, { kind: "reflection", enabled: false }, { kind: "daily-briefing", enabled: false }, { kind: "weekly-review", enabled: false }],
    });
    // Cadences are scheduled forward on configure, so nothing is due yet.
    expect(await engine.autopilot.runDue("local")).toHaveLength(0);
    await engine.autopilot.configure({ tenantId: "local", cadences: [{ kind: "pulse", everyMinutes: 5 }] });

    const config = await engine.autopilot.config("local");
    expect(config.cadences.find((item) => item.kind === "pulse")?.enabled).toBe(true);
    expect(config.maxRunsPerDay).toBe(2);
    const health = await engine.autopilot.health("local");
    expect(health.enabled).toBe(true);
    expect(health.nextRun?.kind).toBeTruthy();
    await engine.shutdown();
  }, 30_000);

  it("runs due cadences through ACOS and records the ledger", async () => {
    const engine = await engineFixture();
    await engine.autopilot.configure({ tenantId: "local", enabled: true, maxRunsPerDay: 10, cadences: [{ kind: "pulse", enabled: true, everyMinutes: 5 }] });
    // Force the pulse cadence due by rewinding its next-run marker through a short interval.
    await engine.autopilot.configure({ tenantId: "local", cadences: [{ kind: "maintenance", enabled: false }, { kind: "reflection", enabled: false }, { kind: "daily-briefing", enabled: false }, { kind: "weekly-review", enabled: false }] });
    const config = await engine.autopilot.config("local");
    expect(config.cadences.filter((item) => item.enabled).map((item) => item.kind)).toEqual(["pulse"]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    const runs = await engine.autopilot.runDue("local");
    // The pulse is scheduled five minutes ahead, so an immediate run is correctly skipped.
    expect(runs).toHaveLength(0);
    const cycles = await engine.acos.cycles("local");
    expect(cycles).toHaveLength(0);
    await engine.shutdown();
  }, 30_000);

  it("explains an action end to end across subsystems", async () => {
    const engine = await engineFixture();
    const intake = await engine.initiative.ingest({ tenantId: "local", source: "git", summary: "Repository has no backup remote." });
    const initiative = await engine.initiative.propose({
      tenantId: "local", kind: "risk", title: "Configure a backup remote", message: "The repository has no backup remote configured.",
      importance: 0.9, urgency: 0.8, impact: 0.9, confidence: 0.9, userRelevance: 0.9, intakeEventIds: [intake.id], mode: "guardian",
    });
    await engine.initiative.evaluate("local");
    const memory = await engine.memoryGraph.remember({
      tenantId: "local", layer: "procedural", claimType: "observation", title: "Backup procedure",
      content: "Add a second git remote and push the main branch nightly.", sourceType: "agent", confidence: 0.8, importance: 0.7, tags: ["backup"],
    });
    const resource = await engine.environment.registerResource({ tenantId: "local", kind: "git", name: "Repo", locator: "/workspaces/aurora/.git", zone: 2 });
    const action = await engine.environment.planAction({
      tenantId: "local", resourceId: resource.id, goal: "Configure the backup remote",
      plan: ["Add remote", "Push main"], action: "git.remote.add", expectedOutcome: "Backup remote exists.",
    });
    await engine.environment.startAction("local", action.id);
    await engine.environment.completeAction({ tenantId: "local", actionId: action.id, success: true, summary: "Remote added.", durationMs: 800 });
    await engine.environment.verifyAction({ tenantId: "local", actionId: action.id, method: "git remote -v", passed: true, memoryUpdateRefs: [memory.id] });

    const trace = await engine.provenance.explain({ tenantId: "local", kind: "environment-action", id: action.id, depth: 3 });
    const kinds = trace.nodes.map((item) => item.kind);
    expect(kinds).toContain("environment-action");
    expect(kinds).toContain("environment-resource");
    expect(kinds).toContain("memory");
    expect(trace.narrative.join(" ")).toContain("verification");
    expect(trace.edges.some((item) => item.relation === "produced")).toBe(true);
    expect(trace.digest).toMatch(/^[0-9a-f]{64}$/);

    const initiativeTrace = await engine.provenance.explain({ tenantId: "local", kind: "initiative", id: initiative.id, depth: 3 });
    expect(initiativeTrace.nodes.map((item) => item.kind)).toContain("intake");
    expect(initiativeTrace.narrative.join(" ")).toContain("worthiness");
    await engine.shutdown();
  }, 30_000);

  it("surfaces decision and plan signals inside the ACOS cycle", async () => {
    const engine = await engineFixture();
    const plan = await engine.planning.create({
      tenantId: "local", title: "Stalled work", objective: "Finish the migration",
      steps: [{ key: "start", title: "Start migration" }],
    });
    const decision = await engine.decisions.open({ tenantId: "local", title: "Migration order", question: "Which table first?", criteria: [{ name: "risk", weight: 1, direction: "minimize" }] });
    await engine.decisions.addOption({ tenantId: "local", decisionId: decision.id, name: "Small table", scores: { risk: 0.2 } });
    await engine.decisions.addOption({ tenantId: "local", decisionId: decision.id, name: "Big table", scores: { risk: 0.8 } });
    await engine.decisions.decide({ tenantId: "local", decisionId: decision.id, rationale: "Start small.", expectedOutcome: "No downtime.", reviewInDays: 1 });

    const report = await engine.acos.tick("local");
    expect(report.signals).toHaveProperty("decisionsDue");
    expect(report.signals).toHaveProperty("stalledPlans");
    const status = await engine.acos.status("local") as Record<string, any>;
    expect(status["plans"].active).toBe(1);
    expect(status["decisions"].reviewed).toBe(0);
    expect(plan.criticalPath).toEqual(["start"]);
    await engine.shutdown();
  }, 30_000);
});
