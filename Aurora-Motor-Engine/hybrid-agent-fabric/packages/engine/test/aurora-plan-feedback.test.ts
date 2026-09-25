import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

async function setup() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-plan-feedback-"));
  const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
  await engine.society.roles("tenant");
  return { engine };
}

async function decisionWithPlan(engine: HybridAgentEngine) {
  let decision = await engine.decisions.open({
    tenantId: "tenant",
    title: "Pick the migration strategy",
    question: "Do we migrate in place or rebuild?",
    context: "The datastore is at capacity.",
    reversibility: "reversible",
    criteria: [{ name: "speed", weight: 0.5, direction: "maximize" as const }, { name: "risk", weight: 0.5, direction: "minimize" as const }],
  });
  decision = await engine.decisions.addOption({ tenantId: "tenant", decisionId: decision.id, name: "migrate in place", scores: { speed: 0.8, risk: 0.3 } });
  decision = await engine.decisions.addOption({ tenantId: "tenant", decisionId: decision.id, name: "rebuild", scores: { speed: 0.3, risk: 0.6 } });
  decision = await engine.decisions.decide({
    tenantId: "tenant", decisionId: decision.id,
    expectedOutcome: "Migration completes without downtime.", rationale: "Faster and lower risk.",
  });
  const plan = await engine.planning.create({
    tenantId: "tenant", title: "Migrate in place", objective: "Execute the chosen strategy.",
    decisionId: decision.id,
    steps: [
      { key: "prepare", title: "Prepare", estimateTokens: 1000, verification: "checked" },
      { key: "migrate", title: "Migrate", dependsOn: ["prepare"], estimateTokens: 1000, verification: "row counts" },
    ],
  });
  return { decision, plan };
}

describe("Aurora plan feedback into decision calibration", () => {
  it("records a decision outcome once its plan completes, derived from step evidence", async () => {
    const { engine } = await setup();
    const { decision, plan } = await decisionWithPlan(engine);
    expect((await engine.planFeedback.candidates("tenant"))[0]).toMatchObject({ eligible: false, reason: "plan-still-open" });

    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "prepare", status: "done" });
    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "migrate", status: "done" });

    const result = await engine.planFeedback.reconcile({ tenantId: "tenant" });
    expect(result.recorded.length).toBe(1);
    const record = result.recorded[0]!;
    expect(record.succeeded).toBe(true);
    expect(record.doneRatio).toBe(1);
    expect(record.observedValue).toBe(1);
    expect(record.evidenceRefs).toContain(plan.id);
    expect(record.brierScore).toBeCloseTo((decision.confidence - 1) ** 2, 5);

    const updated = await engine.decisions.get("tenant", decision.id);
    expect(updated.status).toBe("reviewed");
    expect(updated.outcome?.succeeded).toBe(true);
    expect(updated.outcome?.note).toContain("100% of steps finished");
    // Calibration now has a real data point instead of an open bet.
    const calibration = await engine.decisions.calibration("tenant");
    expect(calibration.reviewed).toBe(1);
    await engine.shutdown();
  });

  it("records a failure when the plan is blocked by a failed step", async () => {
    const { engine } = await setup();
    const { decision, plan } = await decisionWithPlan(engine);
    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "prepare", status: "failed", note: "Backup could not be verified." });

    const result = await engine.planFeedback.reconcile({ tenantId: "tenant" });
    expect(result.recorded[0]?.succeeded).toBe(false);
    const updated = await engine.decisions.get("tenant", decision.id);
    expect(updated.outcome?.succeeded).toBe(false);
    expect(updated.outcome?.surprise).toBeGreaterThan(0);
    await engine.shutdown();
  });

  it("shows exactly what it would write in a dry run without touching the decision", async () => {
    const { engine } = await setup();
    const { decision, plan } = await decisionWithPlan(engine);
    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "prepare", status: "done" });
    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "migrate", status: "done" });

    const preview = await engine.planFeedback.reconcile({ tenantId: "tenant", dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.recorded.length).toBe(1);
    expect((await engine.decisions.get("tenant", decision.id)).outcome).toBeUndefined();
    expect((await engine.planFeedback.records("tenant")).length).toBe(0);
    await engine.shutdown();
  });

  it("marks a decision executed while its plan is still running, without claiming a result", async () => {
    const { engine } = await setup();
    const { decision, plan } = await decisionWithPlan(engine);
    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "prepare", status: "in-progress" });

    const result = await engine.planFeedback.reconcile({ tenantId: "tenant" });
    expect(result.executedMarked).toContain(decision.id);
    expect(result.recorded).toEqual([]);
    const updated = await engine.decisions.get("tenant", decision.id);
    expect(updated.status).toBe("executed");
    expect(updated.outcome).toBeUndefined();
    await engine.shutdown();
  });

  it("never overwrites an outcome someone already recorded", async () => {
    const { engine } = await setup();
    const { decision, plan } = await decisionWithPlan(engine);
    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "prepare", status: "done" });
    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "migrate", status: "done" });
    await engine.decisions.markExecuted("tenant", decision.id, "Executed by hand.");
    await engine.decisions.recordOutcome({ tenantId: "tenant", decisionId: decision.id, succeeded: false, note: "Human verdict: it hurt more than it helped." });

    const result = await engine.planFeedback.reconcile({ tenantId: "tenant" });
    expect(result.recorded).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("outcome-already-recorded");
    expect((await engine.decisions.get("tenant", decision.id)).outcome?.succeeded).toBe(false);
    await engine.shutdown();
  });

  it("summarises the loop and keeps records tenant-scoped", async () => {
    const { engine } = await setup();
    const { plan } = await decisionWithPlan(engine);
    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "prepare", status: "done" });
    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "migrate", status: "done" });
    await engine.planFeedback.reconcile({ tenantId: "tenant" });

    const summary = await engine.planFeedback.summary("tenant");
    expect(summary).toMatchObject({ recorded: 1, succeeded: 1, successRate: 1 });
    expect(summary.meanBrier).toBeGreaterThan(0);
    expect(await engine.planFeedback.records("other")).toEqual([]);
    expect(await engine.planFeedback.candidates("other")).toEqual([]);
    await engine.shutdown();
  });

  it("folds plan feedback into the ACOS evaluate phase", async () => {
    const { engine } = await setup();
    const { plan } = await decisionWithPlan(engine);
    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "prepare", status: "done" });
    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "migrate", status: "done" });

    const report = await engine.acos.tick("tenant", { mode: "full" });
    const evaluate = report.phases.find((item) => item.phase === "evaluate");
    expect(evaluate?.detail.feedbackRecorded).toBe(1);
    expect((await engine.decisions.get("tenant", plan.decisionId!)).status).toBe("reviewed");
    await engine.shutdown();
  });
});

describe("Aurora delegation scheduling intelligence", () => {
  it("delegates the critical path before slack work when the budget is tight", async () => {
    const { engine } = await setup();
    const session = await engine.createSession({ tenantId: "tenant" });
    const plan = await engine.planning.create({
      tenantId: "tenant", title: "Critical path plan", objective: "Two ready steps, one on the critical path.", tags: ["planning"],
      steps: [
        { key: "slack", title: "Nice to have", estimateMinutes: 10, estimateTokens: 5000, verification: "checked" },
        { key: "spine", title: "Long pole", estimateMinutes: 120, estimateTokens: 5000, verification: "checked" },
        { key: "finish", title: "Depends on the long pole", dependsOn: ["spine"], estimateMinutes: 60, estimateTokens: 5000, verification: "checked" },
      ],
    });
    expect(plan.criticalPath).toContain("spine");
    await engine.delegation.configure({ tenantId: "tenant", maxActiveTasksPerPlan: 1, maxTasksPerRun: 1 });
    const result = await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId });
    expect(result.created.map((link) => link.stepKey)).toEqual(["spine"]);
    await engine.shutdown();
  });

  it("keeps a role with a bad record away from high-risk work while leaving low-risk work alone", async () => {
    const { engine } = await setup();
    const session = await engine.createSession({ tenantId: "tenant" });
    await engine.delegation.configure({ tenantId: "tenant", probation: { minAttempts: 2, maxFailureRate: 0.4, riskFloor: 0.7 } });

    // Give every planning-capable role a failing record through the society's own accounting.
    const planningRoles = (await engine.society.roles("tenant")).filter((role) => role.capabilityTags.includes("planning"));
    for (const role of planningRoles) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const task = await engine.society.postTask({ tenantId: "tenant", rootSessionId: session.sessionId, title: `Probe ${role.id} ${attempt}`, objective: "probe", requiredCapabilityTags: ["planning"], maxTokens: 1000 });
        await engine.society.bid({ tenantId: "tenant", taskId: task.id, roleId: role.id, confidence: 0.5, estimatedTokens: 100, estimatedDurationMs: 10, rationale: "probe" });
        await engine.society.award("tenant", task.id);
        const running = await engine.society.execute("tenant", task.id);
        let events = await engine.readEvents(running.childSessionId!);
        for (let wait = 0; wait < 200 && !events.length; wait++) { await new Promise((r) => setTimeout(r, 10)); events = await engine.readEvents(running.childSessionId!); }
        await engine.society.recordOutcome({ tenantId: "tenant", taskId: task.id, success: false, quality: 0.1, actualTokens: 100, evidenceEventIds: [events[0]!.eventId] });
      }
    }
    const candidates = await engine.delegation.candidates("tenant", ["planning"]);
    expect(candidates.every((item) => item.onProbation)).toBe(true);

    const risky = await engine.planning.create({
      tenantId: "tenant", title: "Risky plan", objective: "One dangerous step.", tags: ["planning"],
      steps: [{ key: "danger", title: "Irreversible migration", riskLevel: 0.9, estimateTokens: 5000, verification: "verified" }],
    });
    const blocked = await engine.delegation.delegate({ tenantId: "tenant", planId: risky.id, rootSessionId: session.sessionId });
    expect(blocked.created).toEqual([]);
    expect(blocked.skipped[0]?.reason).toMatch(/all-matching-roles-on-probation/);

    const routine = await engine.planning.create({
      tenantId: "tenant", title: "Routine plan", objective: "One safe step.", tags: ["planning"],
      steps: [{ key: "safe", title: "Draft the outline", riskLevel: 0.1, estimateTokens: 5000, verification: "reviewed" }],
    });
    const allowed = await engine.delegation.delegate({ tenantId: "tenant", planId: routine.id, rootSessionId: session.sessionId });
    expect(allowed.created.length).toBe(1);
    await engine.shutdown();
  });
});
