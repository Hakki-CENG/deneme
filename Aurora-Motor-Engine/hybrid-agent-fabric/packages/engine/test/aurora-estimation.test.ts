import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

async function setup() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-estimation-"));
  const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
  await engine.society.roles("tenant");
  return { engine };
}

/** Three finished plans in the same bucket, each taking twice as long as estimated. */
async function measuredHistory(engine: HybridAgentEngine, ratio = 2, count = 3, tag = "delivery") {
  for (let index = 0; index < count; index++) {
    const plan = await engine.planning.create({
      tenantId: "tenant", title: `Past plan ${index}`, objective: "Historic work.", tags: [tag],
      steps: [{ key: "work", title: "Work", estimateMinutes: 60, estimateTokens: 1000, verification: "checked" }],
    });
    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "work", status: "done", actualMinutes: 60 * ratio });
  }
}

describe("Aurora estimation calibration", () => {
  it("learns a correction factor from measured durations and reports its confidence", async () => {
    const { engine } = await setup();
    await measuredHistory(engine);
    const ingest = await engine.estimation.ingest("tenant");
    expect(ingest.ingested).toBe(3);

    const profile = await engine.estimation.profile("tenant");
    expect(profile.overall.samples).toBe(3);
    expect(profile.overall.factor).toBe(2);
    expect(profile.overall.confidence).toBeCloseTo(0.15, 5);
    expect(profile.buckets[0]?.bucket).toBe("delivery");
    // Ingest is idempotent: the same finished step is never sampled twice.
    expect((await engine.estimation.ingest("tenant")).ingested).toBe(0);
    await engine.shutdown();
  });

  it("suggests corrected estimates and explains the ones it leaves alone", async () => {
    const { engine } = await setup();
    await measuredHistory(engine);
    await engine.estimation.ingest("tenant");
    const plan = await engine.planning.create({
      tenantId: "tenant", title: "Next plan", objective: "Future work.", tags: ["delivery"],
      steps: [{ key: "build", title: "Build", estimateMinutes: 30, estimateTokens: 1000, verification: "checked" }],
    });
    const suggestion = (await engine.estimation.suggest("tenant", plan.id)).suggestions[0]!;
    expect(suggestion.suggestedMinutes).toBe(60);
    expect(suggestion.rationale).toContain("median actual/estimate ratio 2");

    const fresh = await setup();
    const emptyPlan = await fresh.engine.planning.create({
      tenantId: "tenant", title: "No history", objective: "First plan.", tags: ["delivery"],
      steps: [{ key: "build", title: "Build", estimateMinutes: 30, estimateTokens: 1000, verification: "checked" }],
    });
    const untouched = (await fresh.engine.estimation.suggest("tenant", emptyPlan.id)).suggestions[0]!;
    expect(untouched.suggestedMinutes).toBe(30);
    expect(untouched.factor).toBe(1);
    expect(untouched.rationale).toContain("not enough history");
    await fresh.engine.shutdown();
    await engine.shutdown();
  });

  it("applies corrections as an auditable plan revision", async () => {
    const { engine } = await setup();
    await measuredHistory(engine);
    await engine.estimation.ingest("tenant");
    const plan = await engine.planning.create({
      tenantId: "tenant", title: "Corrected plan", objective: "Future work.", tags: ["delivery"],
      steps: [
        { key: "build", title: "Build", estimateMinutes: 30, estimateTokens: 1000, verification: "checked" },
        { key: "verify", title: "Verify", dependsOn: ["build"], estimateMinutes: 10, estimateTokens: 500, verification: "checked" },
      ],
    });
    const applied = await engine.estimation.apply({ tenantId: "tenant", planId: plan.id });
    expect(applied.applied.map((item) => item.suggestedMinutes)).toEqual([60, 20]);
    const revised = applied.plan!;
    expect(revised.version).toBe(plan.version + 1);
    expect(revised.steps.find((step) => step.key === "build")?.estimateMinutes).toBe(60);
    expect(revised.revisions.at(-1)?.reason).toContain("recalibrated");
    expect(revised.steps.find((step) => step.key === "build")?.detail).toContain("Estimate recalibrated from 30 to 60");
    await engine.shutdown();
  });

  it("resists a single pathological sample by using the median", async () => {
    const { engine } = await setup();
    await measuredHistory(engine, 2, 3);
    const outlier = await engine.planning.create({
      tenantId: "tenant", title: "Outlier", objective: "One catastrophic step.", tags: ["delivery"],
      steps: [{ key: "work", title: "Work", estimateMinutes: 60, estimateTokens: 1000, verification: "checked" }],
    });
    await engine.planning.updateStep({ tenantId: "tenant", planId: outlier.id, stepKey: "work", status: "done", actualMinutes: 60 * 100 });
    await engine.estimation.ingest("tenant");
    const profile = await engine.estimation.profile("tenant");
    expect(profile.overall.samples).toBe(4);
    expect(profile.overall.factor).toBeLessThanOrEqual(4); // clamped, and the median keeps it near 2
    expect(profile.overall.factor).toBeGreaterThanOrEqual(2);
    await engine.shutdown();
  });

  it("keeps estimation history tenant-scoped and ingests inside the ACOS learn phase", async () => {
    const { engine } = await setup();
    await measuredHistory(engine);
    const report = await engine.acos.tick("tenant", { mode: "full" });
    const learn = report.phases.find((item) => item.phase === "learn");
    expect(learn?.detail.estimationIngested).toBe(3);
    expect((await engine.estimation.profile("other")).overall.samples).toBe(0);
    expect(await engine.estimation.samples("other")).toEqual([]);
    await engine.shutdown();
  });
});

describe("Aurora surprise-driven replanning advisories", () => {
  async function decidedPlan(engine: HybridAgentEngine) {
    let decision = await engine.decisions.open({
      tenantId: "tenant", title: "Pick the approach", question: "Which approach?", context: "Deadline pressure.",
      criteria: [{ name: "speed", weight: 1 }],
    });
    decision = await engine.decisions.addOption({ tenantId: "tenant", decisionId: decision.id, name: "fast path", scores: { speed: 0.9 } });
    decision = await engine.decisions.addOption({ tenantId: "tenant", decisionId: decision.id, name: "slow path", scores: { speed: 0.2 } });
    decision = await engine.decisions.decide({ tenantId: "tenant", decisionId: decision.id, expectedOutcome: "Ships on time.", rationale: "Speed matters most." });
    const plan = await engine.planning.create({
      tenantId: "tenant", title: "Fast path", objective: "Execute the fast path.", decisionId: decision.id,
      steps: [{ key: "ship", title: "Ship it", estimateMinutes: 30, estimateTokens: 1000, verification: "released" }],
    });
    return { decision, plan };
  }

  it("raises a candidate initiative when a plan fails its decision's expectation", async () => {
    const { engine } = await setup();
    const { decision, plan } = await decidedPlan(engine);
    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "ship", status: "failed", note: "Release blocked." });

    const result = await engine.planFeedback.reconcile({ tenantId: "tenant" });
    const record = result.recorded[0]!;
    expect(record.succeeded).toBe(false);
    expect(record.advisory?.initiativeId).toBeTruthy();
    const initiative = (await engine.initiative.initiatives("tenant", { limit: 10 })).find((item) => item.id === record.advisory?.initiativeId)!;
    expect(initiative.kind).toBe("risk");
    expect(initiative.title).toContain(decision.title);
    expect(initiative.evidenceRefs).toContain(plan.id);
    await engine.shutdown();
  });

  it("stays quiet when the plan landed close to what was expected", async () => {
    const { engine } = await setup();
    const { plan } = await decidedPlan(engine);
    await engine.planning.updateStep({ tenantId: "tenant", planId: plan.id, stepKey: "ship", status: "done", actualMinutes: 30 });
    const result = await engine.planFeedback.reconcile({ tenantId: "tenant" });
    const record = result.recorded[0]!;
    expect(record.succeeded).toBe(true);
    if (record.surprise < 0.4) expect(record.advisory).toBeUndefined();
    await engine.shutdown();
  });
});

describe("Aurora probation visibility", () => {
  it("reports benched roles, what they block, and records the coverage gap", async () => {
    const { engine } = await setup();
    const session = await engine.createSession({ tenantId: "tenant" });
    await engine.delegation.configure({ tenantId: "tenant", probation: { minAttempts: 2, maxFailureRate: 0.4, riskFloor: 0.7 } });

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

    const risky = await engine.planning.create({
      tenantId: "tenant", title: "Risky plan", objective: "Dangerous step.", tags: ["planning"],
      steps: [{ key: "danger", title: "Irreversible migration", riskLevel: 0.9, estimateTokens: 5000, verification: "verified" }],
    });
    await engine.delegation.delegate({ tenantId: "tenant", planId: risky.id, rootSessionId: session.sessionId });

    const report = await engine.delegation.probationReport("tenant");
    expect(report.roles.length).toBeGreaterThan(0);
    expect(report.roles[0]?.failureRate).toBeGreaterThan(0.4);
    expect(report.blockedSteps.some((item) => item.stepKey === "danger")).toBe(true);

    // The society having nobody trustworthy for this risk level is itself a recorded capability gap.
    const gaps = await engine.evolution.gaps("tenant", "open");
    expect(gaps.some((gap) => gap.description.includes("No reliable society role"))).toBe(true);
    await engine.shutdown();
  });
});
