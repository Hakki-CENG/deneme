import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { BackgroundThinkingService } from "../src/thought/background-thinking-service.js";
import { ThoughtCoreService } from "../src/thought/thought-core-service.js";
import { EventBus } from "../src/aurora/event-bus.js";
import { SelfDebuggingService } from "../src/aurora/self-debugging.js";
import { SelfModelIntegration } from "../src/aurora/self-model-integration.js";
import { SelfModelService } from "../src/aurora/self-model-service.js";

const TENANT = "tenant-a";

async function freshRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `${prefix}-`));
}

// ═══ L3: open problems ↔ hypotheses ═══

describe("L3 — hypotheses link to open problems", () => {
  it("attaches a hypothesis to a problem and lists it back, rejecting bad links", async () => {
    const root = await freshRoot("haf-l3");
    const service = new ThoughtCoreService(root);
    await service.initialize();

    const thought = await service.createThought({
      tenantId: TENANT,
      title: "Recall drops on paraphrases",
      content: "Hybrid search misses paraphrased queries.",
      type: "problem",
      sourceType: "user",
    });
    const problem = await service.createOpenProblem({
      tenantId: TENANT,
      title: "Recall gate",
      description: "Paraphrase recall is below the gate.",
      category: "retrieval",
    });

    const hypothesis = await service.createHypothesis({
      tenantId: TENANT,
      statement: "Embedding recall alone closes the gap",
      thoughtId: thought.id,
      problemId: problem.id,
      confidence: 0.4,
    });
    expect(hypothesis.problemId).toBe(problem.id);

    const listed = await service.hypothesesForProblem(TENANT, problem.id);
    expect(listed.map((h) => h.id)).toContain(hypothesis.id);

    // A bad link is rejected instead of being silently dropped.
    await expect(service.createHypothesis({
      tenantId: TENANT,
      statement: "Bad link",
      thoughtId: thought.id,
      problemId: "problem-does-not-exist",
    })).rejects.toThrow(/Open problem not found/);

    // Tenant isolation: another tenant sees nothing.
    expect(await service.hypothesesForProblem("tenant-b", problem.id)).toHaveLength(0);
    await rm(root, { recursive: true, force: true });
  });
});

// ═══ L1: durable background-thinking ledger ═══

describe("L1 — background thinking ledger is durable", () => {
  it("starts empty, survives a restart and clears threads on stop", async () => {
    const root = await freshRoot("haf-l1");
    const service = new BackgroundThinkingService(root);
    const status = await service.getStatus(TENANT);
    expect(status.totalCycles).toBe(0);
    expect(status.activeThreads).toBe(0);
    expect(status.lastRunAt).toBeUndefined();

    const cycle = await service.runCycle(TENANT);
    expect(cycle.iteration).toBeGreaterThanOrEqual(0);
    expect(typeof cycle.thoughtsProcessed).toBe("number");
    expect((await service.getStatus(TENANT)).totalCycles).toBe(1);

    // Durable: a fresh instance over the same root reads the same ledger.
    const reloaded = new BackgroundThinkingService(root);
    expect((await reloaded.getStatus(TENANT)).totalCycles).toBe(1);
    expect(existsSync(join(root, "background-thinking", "ledger.json"))).toBe(true);

    // Threads are durable too, and stop() clears them.
    await reloaded.startBackgroundThread(TENANT, "curiosity", { maxIterations: 2, maxDurationMs: 5000 });
    expect((await reloaded.getStatus(TENANT)).activeThreads).toBe(1);
    const again = new BackgroundThinkingService(root);
    expect((await again.getStatus(TENANT)).activeThreads).toBe(1);
    await again.stop();
    expect((await again.getStatus(TENANT)).activeThreads).toBe(0);
    await rm(root, { recursive: true, force: true });
  });
});

// ═══ L5: reflection is per-tenant, not hardcoded ═══

describe("L5 — reflection cycles", () => {
  it("reflects one tenant's failures without leaking into another tenant", async () => {
    const root = await freshRoot("haf-l5");
    const service = new SelfModelService(root);

    for (let index = 0; index < 3; index++) {
      await service.recordFailure(TENANT, "Extract tables from scanned PDFs", "task-failure", "pdf layout variance", "direct", "Scanned PDFs need OCR before table extraction.");
    }
    const reflected = await service.reflect(TENANT, "failure");
    expect(reflected.insights.length).toBeGreaterThan(0);
    expect(reflected.insights.join(" ").toLowerCase()).toContain("pdf");

    const other = await service.reflect("tenant-b", "failure");
    expect(other.insights.join(" ").toLowerCase()).not.toContain("pdf");
    await rm(root, { recursive: true, force: true });
  });
});

// ═══ L7: self-model decision inputs and advice ═══

describe("L7 — self-model decision mechanism", () => {
  it("reports measured reliability and advises delegation for a weak capability", async () => {
    const root = await freshRoot("haf-l7");
    const service = new SelfModelService(root);

    // A weak capability: four failures, no success.
    for (let index = 0; index < 4; index++) {
      await service.recordCapabilityOutcome(TENANT, "pdf-table-extraction", false);
    }
    const inputs = await service.decisionInputs(TENANT, {
      availableCapabilities: () => ["process.exec", "fs.read"],
      availableModels: () => ["mock"],
    });
    const weak = inputs.reliabilityPerCapability.find((item) => item.domain === "pdf-table-extraction");
    expect(weak?.attempts).toBe(4);
    expect(weak?.successRate).toBe(0);
    expect(inputs.weaknesses.map((w) => w.domain)).toContain("pdf-table-extraction");
    expect(inputs.availableTools).toEqual({ capabilities: ["process.exec", "fs.read"], models: ["mock"] });

    const advice = await service.advise(TENANT, "Extract tables from this scanned pdf");
    expect(advice.recommendDelegate).toBe(true);
    expect(advice.rationale.join(" ")).toContain("pdf-table-extraction");

    // A tenant with no history gets an honest no-reason-to-deviate answer.
    const fresh = await service.advise("tenant-b", "Extract tables from this scanned pdf");
    expect(fresh.recommendDelegate).toBe(false);
    expect(fresh.rationale.join(" ")).toContain("no reason to deviate");
    await rm(root, { recursive: true, force: true });
  });
});

// ═══ M8: meta-learning on strategy outcomes ═══

describe("M8 — meta-learning stays honest below the evidence threshold", () => {
  it("refuses to advise with insufficient evidence, then advises with five samples", async () => {
    const root = await freshRoot("haf-m8");
    const service = new SelfModelService(root);

    const early = await service.strategyAdvice(TENANT);
    expect(early.mode).toBe("insufficient-evidence");

    for (let index = 0; index < 5; index++) {
      await service.recordStrategyOutcome(TENANT, "direct", false, "pdf extraction");
    }
    const advice = await service.strategyAdvice(TENANT);
    expect(advice.mode).toBe("advising");
    expect(advice.strategyStats.find((s) => s.strategy === "direct")?.successRate).toBe(0);
    expect(advice.recommendations.length).toBeGreaterThan(0);
    await rm(root, { recursive: true, force: true });
  });
});

// ═══ M7: self-debugging learns from verified fixes ═══

describe("M7 — self-healing uses verified history before templates", () => {
  it("reapplies verified fixes for the same subsystem and labels the template fallback", async () => {
    const root = await freshRoot("haf-m7");
    const service = new SelfDebuggingService(root);

    // No history yet: the template applies and says so.
    const templated = await service.selfHeal(TENANT, "search", ["recall dropped", "timeout on queries"]);
    expect(templated.basis).toBe("symptom-template");
    expect(templated.knownFixes).toHaveLength(0);
    expect(templated.healingSteps.map((s) => s.step)).toContain("hypothesize");

    // Build real history: bug → fix → verified.
    const bug = await service.reportBug(TENANT, "integration", "Search recall regressed after index change", ["recall dropped"], "search", ["run recall suite"], "high");
    const fix = await service.proposeFix(bug.id, "Reindex with the correct analyzer", "analyzer was changed to keyword", "restore the standard analyzer and reindex");
    await service.applyFix(fix.id);
    await service.verifyFix(fix.id, "haf-test", true);

    const healed = await service.selfHeal(TENANT, "search", ["recall dropped"]);
    expect(healed.basis).toBe("verified-history");
    expect(healed.knownFixes.map((f) => f.fixId)).toContain(fix.id);
    expect(healed.healingSteps.some((s) => s.action.includes("standard analyzer"))).toBe(true);
    expect(healed.healingSteps.some((s) => s.step === "verify")).toBe(true);

    // Another subsystem has no verified history: template again, honestly.
    const other = await service.selfHeal(TENANT, "scheduler", ["stuck jobs"]);
    expect(other.basis).toBe("symptom-template");
    await rm(root, { recursive: true, force: true });
  });
});

// ═══ M6: semantic evaluation gates promotion on measured regressions ═══

describe("M6 — semantic evaluation blocks regressions against the baseline", () => {
  it("fails promotion when a command that passed at baseline fails after the change", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-m6-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      autoApproveWorkspaceWrites: true,
      allowProcessExecution: true,
      model: { provider: "mock" },
    });
    const session = await engine.createSession({ tenantId: "tenant" });
    await writeFile(join(session.workspacePath, "quality.ok"), "ok");

    const candidate = await engine.learning.propose({
      tenantId: "tenant", sessionId: session.sessionId, kind: "prompt_addendum", scope: "session",
      title: "quality policy", content: "Always verify quality.ok.", evidenceEventIds: ["event-1"],
      expectedOutcome: "quality evidence", createdBy: "agent",
    });
    const release = await engine.learningRollouts.create({
      candidateId: candidate.id,
      evalCommands: ["test -f quality.ok"],
    });

    // Before the change: the check passes and is recorded as the baseline.
    const baseline = await engine.learningRollouts.runBaseline(release.id);
    expect(baseline.baseline?.[0]?.exitCode).toBe(0);

    // The "improvement" removes the file — measured behavior gets worse.
    await rm(join(session.workspacePath, "quality.ok"), { force: true });

    const evaluated = await engine.learningRollouts.runEvaluation(release.id);
    expect(evaluated.status).toBe("evaluation_failed");
    expect(evaluated.semanticVerdict?.verdict).toBe("regression");
    expect(evaluated.semanticVerdict?.exitCodeRegressions).toBe(1);
    expect(evaluated.semanticVerdict?.hasBaseline).toBe(true);
    // The rejection must carry the measured regression as its reason — a bare
    // exit-code failure would reject too, but without this evidence the
    // before/after comparison is not actually doing any work.
    const rejected = JSON.stringify(await engine.learning.get(candidate.id));
    expect(rejected).toContain("semantic:regression");
    expect(rejected).toContain("Regression vs baseline");
    await engine.shutdown();
  });

  it("promotes a clean change and reports the comparison honestly without a baseline", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-m6b-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      autoApproveWorkspaceWrites: true,
      allowProcessExecution: true,
      model: { provider: "mock" },
    });
    const session = await engine.createSession({ tenantId: "tenant" });
    await writeFile(join(session.workspacePath, "quality.ok"), "ok");

    const candidate = await engine.learning.propose({
      tenantId: "tenant", sessionId: session.sessionId, kind: "memory", scope: "session",
      title: "quality lesson", content: "Verify quality.ok.", evidenceEventIds: ["event-1"],
      expectedOutcome: "quality evidence", createdBy: "agent",
    });
    const release = await engine.learningRollouts.create({
      candidateId: candidate.id,
      evalCommands: ["test -f quality.ok"],
    });

    // No baseline run: the comparison says so instead of inventing one.
    const evaluated = await engine.learningRollouts.runEvaluation(release.id);
    expect(evaluated.status).toBe("awaiting_signature");
    expect(evaluated.semanticVerdict?.verdict).toBe("no-baseline");
    expect(typeof evaluated.evaluation[0]?.durationMs).toBe("number");
    await engine.shutdown();
  });
});

// ═══ L5 wiring: reflection is driven by real engine events ═══

describe("L5 wiring — reflection on task events", () => {
  it("reflects on completion and records failures on task failure, never throwing back", async () => {
    const root = await freshRoot("haf-l5w");
    const bus = new EventBus(100);
    const model = new SelfModelService(root);
    const integration = new SelfModelIntegration(bus, model);
    integration.init();

    // Exactly one reflection per event — deterministic, so a double-fired
    // handler would show up as a count mismatch instead of a flaky compare.
    await bus.emit("task.completed", "test", { tenantId: TENANT, goal: "Ship the recall fix" });
    expect((await model.getFullState(TENANT)).metacog.reflectionCount).toBe(1);

    await bus.emit("task.failed", "test", { tenantId: TENANT, goal: "Extract tables from scanned PDFs" });
    const afterFailure = await model.getFullState(TENANT);
    expect(afterFailure.metacog.reflectionCount).toBe(2);
    const failures = await model.getCapabilities(TENANT);
    expect(failures).toHaveLength(0); // failures are not capability assessments
    const advice = await model.strategyAdvice(TENANT);
    expect(advice.strategyStats.find((s) => s.strategy === "direct")?.failures).toBe(1);

    // A malformed event must not throw back into the emitter.
    await expect(bus.emit("task.failed", "test", { tenantId: 42 })).resolves.toBeDefined();
    integration.dispose();
    await rm(root, { recursive: true, force: true });
  });
});
