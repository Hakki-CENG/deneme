import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

async function setup() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-delegation-"));
  const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
  const session = await engine.createSession({ tenantId: "tenant" });
  await engine.society.roles("tenant"); // seed builtin roles
  return { engine, session };
}

async function waitForEvents(engine: HybridAgentEngine, sessionId: string) {
  for (let index = 0; index < 200; index++) {
    const events = await engine.readEvents(sessionId);
    if (events.length) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return [];
}

async function twoStepPlan(engine: HybridAgentEngine) {
  return await engine.planning.create({
    tenantId: "tenant",
    title: "Ship the migration",
    objective: "Migrate the datastore without downtime.",
    tags: ["planning"],
    steps: [
      { key: "design", title: "Design the migration", estimateMinutes: 30, estimateTokens: 20_000, verification: "Design reviewed" },
      { key: "execute", title: "Run the migration", dependsOn: ["design"], estimateMinutes: 60, estimateTokens: 40_000, riskLevel: 0.9, verification: "Row counts match" },
    ],
  });
}

describe("Aurora execution bridge", () => {
  it("delegates only ready steps and refuses to run ahead of the dependency graph", async () => {
    const { engine, session } = await setup();
    const plan = await twoStepPlan(engine);
    const result = await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId });
    expect(result.created.map((link) => link.stepKey)).toEqual(["design"]);
    expect(result.skipped).toEqual([]);
    // "execute" depends on "design", so it is not even offered to the society yet.
    const forced = await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId, stepKeys: ["execute"] });
    expect(forced.created).toEqual([]);
    expect(forced.skipped[0]?.reason).toMatch(/step-not-ready/);
    await engine.shutdown();
  });

  it("records deterministic match evidence and nominates the best-matching role", async () => {
    const { engine, session } = await setup();
    const plan = await twoStepPlan(engine);
    const result = await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId, capabilityTags: ["planning"] });
    const link = result.created[0]!;
    expect(link.requiredCapabilityTags).toEqual(["planning"]);
    expect(link.match?.coverage).toBe(1);
    expect(link.match?.roleId).toBe(link.nominatedRoleId);
    // Posted, nominated and awarded, but never activated implicitly.
    expect(link.status).toBe("assigned");
    expect(link.assignedRoleId).toBeTruthy();
    const task = await engine.society.getTask("tenant", link.taskId);
    expect(task.status).toBe("assigned");
    expect(task.bids[0]?.rationale).toContain("machine-authored");
    await engine.shutdown();
  });

  it("never delegates the same step twice while its task is live", async () => {
    const { engine, session } = await setup();
    const plan = await twoStepPlan(engine);
    await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId });
    const second = await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId });
    expect(second.created).toEqual([]);
    expect(second.skipped[0]).toMatchObject({ stepKey: "design", reason: "already-delegated" });
    await engine.shutdown();
  });

  it("refuses to post work no active role can satisfy", async () => {
    const { engine, session } = await setup();
    const plan = await twoStepPlan(engine);
    const result = await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId, capabilityTags: ["quantum-astrology"] });
    expect(result.created).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/no-role-matches/);
    // With the guard disabled the task is posted anyway, which is exactly why the guard is on by default.
    await engine.delegation.configure({ tenantId: "tenant", requireRoleMatch: false });
    const relaxed = await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId, capabilityTags: ["quantum-astrology"] });
    expect(relaxed.created.length).toBe(1);
    expect(relaxed.created[0]?.status).toBe("posted");
    await engine.shutdown();
  });

  it("carries a completed task's evidence back into the plan step", async () => {
    const { engine, session } = await setup();
    const plan = await twoStepPlan(engine);
    const link = (await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId })).created[0]!;
    const activated = await engine.delegation.activate("tenant", link.id);
    expect(activated.status).toBe("running");

    const running = await engine.society.getTask("tenant", link.taskId);
    const events = await waitForEvents(engine, running.childSessionId!);
    expect(events.length).toBeGreaterThan(0);

    // Mid-flight reconciliation moves the step to in-progress without claiming completion.
    const midSync = await engine.delegation.sync({ tenantId: "tenant", planId: plan.id });
    expect(midSync.updatedSteps[0]).toMatchObject({ stepKey: "design", to: "in-progress" });

    await engine.society.recordOutcome({ tenantId: "tenant", taskId: link.taskId, success: true, quality: 0.9, actualTokens: 1000, evidenceEventIds: [events[0]!.eventId] });
    const sync = await engine.delegation.sync({ tenantId: "tenant", planId: plan.id });
    expect(sync.updatedSteps[0]).toMatchObject({ stepKey: "design", to: "done" });

    const updated = await engine.planning.get("tenant", plan.id);
    const step = updated.steps.find((item) => item.key === "design")!;
    expect(step.status).toBe("done");
    expect(step.evidenceRefs).toContain(events[0]!.eventId);
    expect(step.taskId).toBe(link.taskId);
    // The next step becomes ready only because the first one actually finished.
    expect((await engine.planning.progress("tenant", plan.id)).ready).toEqual(["execute"]);
    await engine.shutdown();
  });

  it("marks the step failed and keeps the plan honest when the society fails", async () => {
    const { engine, session } = await setup();
    const plan = await twoStepPlan(engine);
    const link = (await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId })).created[0]!;
    await engine.delegation.activate("tenant", link.id);
    const running = await engine.society.getTask("tenant", link.taskId);
    const events = await waitForEvents(engine, running.childSessionId!);
    await engine.society.recordOutcome({ tenantId: "tenant", taskId: link.taskId, success: false, quality: 0.1, actualTokens: 500, evidenceEventIds: [events[0]!.eventId] });

    await engine.delegation.sync({ tenantId: "tenant" });
    const updated = await engine.planning.get("tenant", plan.id);
    expect(updated.steps.find((item) => item.key === "design")?.status).toBe("failed");
    expect(updated.status).toBe("blocked");
    const links = await engine.delegation.links("tenant", { planId: plan.id });
    expect(links[0]?.status).toBe("failed");
    expect(links[0]?.outcome?.success).toBe(false);
    await engine.shutdown();
  });

  it("bounds concurrent delegation per plan", async () => {
    const { engine, session } = await setup();
    const plan = await engine.planning.create({
      tenantId: "tenant", title: "Parallel work", objective: "Four independent chores.",
      steps: ["a", "b", "c", "d"].map((key) => ({ key, title: `Chore ${key}`, estimateTokens: 5000, verification: "checked" })),
    });
    await engine.delegation.configure({ tenantId: "tenant", maxActiveTasksPerPlan: 2, maxTasksPerRun: 10 });
    const result = await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId });
    expect(result.created.length).toBe(2);
    expect(result.skipped.filter((item) => item.reason === "plan-concurrency-limit").length).toBe(2);
    await engine.shutdown();
  });

  it("reports delegation coverage by role and lists undelegated ready work", async () => {
    const { engine, session } = await setup();
    const plan = await twoStepPlan(engine);
    await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId });
    const report = await engine.delegation.report("tenant", plan.id);
    expect(report).toMatchObject({ steps: 2, delegated: 1, open: 1, completed: 0, failed: 0 });
    expect(report.coverage).toBeCloseTo(0.5, 5);
    expect(report.byRole[0]?.tasks).toBe(1);
    expect(report.undelegatedReady).toEqual([]);
    await engine.shutdown();
  });

  it("detaches a delegation for replanning without touching the society task", async () => {
    const { engine, session } = await setup();
    const plan = await twoStepPlan(engine);
    const link = (await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId })).created[0]!;
    const detached = await engine.delegation.detach("tenant", link.id, "Scope changed after review.");
    expect(detached.status).toBe("detached");
    expect((await engine.society.getTask("tenant", link.taskId)).status).toBe("assigned");
    await expect(engine.delegation.detach("tenant", link.id, "again")).rejects.toThrow(/already detached/);
    // Once detached, the step can be delegated again.
    const again = await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId, stepKeys: ["design"] });
    expect(again.created.length).toBe(1);
    await engine.shutdown();
  });

  it("keeps unattended delegation inert until a tenant enables it with a root session", async () => {
    const { engine, session } = await setup();
    const plan = await twoStepPlan(engine);
    const idle = await engine.delegation.runCycle("tenant");
    expect(idle).toMatchObject({ autoDelegate: false, delegated: 0 });
    expect((await engine.delegation.links("tenant")).length).toBe(0);

    await engine.delegation.configure({ tenantId: "tenant", autoDelegate: true });
    expect((await engine.delegation.runCycle("tenant")).delegated).toBe(0); // no root session yet

    await engine.delegation.configure({ tenantId: "tenant", rootSessionId: session.sessionId });
    const active = await engine.delegation.runCycle("tenant");
    expect(active.delegated).toBe(1);
    expect((await engine.delegation.links("tenant", { planId: plan.id })).length).toBe(1);
    await engine.shutdown();
  });

  it("ranks role candidates deterministically by coverage, reputation and current load", async () => {
    const { engine } = await setup();
    const candidates = await engine.delegation.candidates("tenant", ["security"]);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.coverage).toBe(1);
    expect(candidates.every((item, index) => index === 0 || candidates[index - 1]!.score >= item.score)).toBe(true);
    const repeat = await engine.delegation.candidates("tenant", ["security"]);
    expect(repeat.map((item) => item.roleId)).toEqual(candidates.map((item) => item.roleId));
    await engine.shutdown();
  });

  it("surfaces delegation reconciliation inside the ACOS execute phase", async () => {
    const { engine, session } = await setup();
    const plan = await twoStepPlan(engine);
    await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId });
    const report = await engine.acos.tick("tenant", { mode: "full" });
    const execute = report.phases.find((item) => item.phase === "execute");
    expect(execute?.status).toBe("ok");
    expect(execute?.detail.delegationsSynced).toBe(1);
    await engine.shutdown();
  });

  it("isolates delegations per tenant", async () => {
    const { engine, session } = await setup();
    const plan = await twoStepPlan(engine);
    const link = (await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId })).created[0]!;
    expect(await engine.delegation.links("other")).toEqual([]);
    await expect(engine.delegation.detach("other", link.id, "cross-tenant")).rejects.toThrow(/not found in tenant/);
    await engine.shutdown();
  });
});
