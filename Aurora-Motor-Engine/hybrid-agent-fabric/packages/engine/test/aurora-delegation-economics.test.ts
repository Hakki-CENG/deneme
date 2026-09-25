import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

async function setup() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-delegation-econ-"));
  const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
  const session = await engine.createSession({ tenantId: "tenant" });
  await engine.society.roles("tenant");
  await engine.harvester.configure({ tenantId: "tenant", settleAfterMs: 0 });
  return { engine, session };
}

async function chores(engine: HybridAgentEngine, keys: string[], estimateTokens = 20_000, title = "Parallel work") {
  return await engine.planning.create({
    tenantId: "tenant", title, objective: "Independent chores that can all start now.", tags: ["planning"],
    steps: keys.map((key) => ({ key, title: `Chore ${key}`, estimateTokens, verification: "checked" })),
  });
}

describe("Aurora delegation economics", () => {
  it("respects the society concurrency ceiling instead of posting tasks that can never be awarded", async () => {
    const { engine, session } = await setup();
    await engine.society.configureBudget("tenant", 1_000_000, 2);
    await engine.delegation.configure({ tenantId: "tenant", maxActiveTasksPerPlan: 10, maxTasksPerRun: 10 });
    const plan = await chores(engine, ["a", "b", "c", "d"]);

    const result = await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId });
    expect(result.created.length).toBe(2);
    expect(result.skipped.filter((item) => item.reason === "society-concurrency-exhausted").length).toBe(2);
    // Nothing was posted for the skipped steps, so the marketplace has no orphan tasks.
    expect((await engine.society.tasks("tenant")).length).toBe(2);
    await engine.shutdown();
  });

  it("respects the daily token budget and names the shortfall", async () => {
    const { engine, session } = await setup();
    await engine.society.configureBudget("tenant", 45_000, 8);
    await engine.delegation.configure({ tenantId: "tenant", maxActiveTasksPerPlan: 10, maxTasksPerRun: 10 });
    const plan = await chores(engine, ["a", "b", "c"], 20_000);

    const result = await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId });
    expect(result.created.length).toBe(2);
    const exhausted = result.skipped.find((item) => item.reason.startsWith("society-token-budget-exhausted"));
    expect(exhausted?.reason).toMatch(/needs 20000, 5000 left today/);
    await engine.shutdown();
  });

  it("still posts unawarded work when the caller opted out of awarding", async () => {
    const { engine, session } = await setup();
    await engine.society.configureBudget("tenant", 1_000_000, 1);
    await engine.delegation.configure({ tenantId: "tenant", maxActiveTasksPerPlan: 5, maxTasksPerRun: 5 });
    const plan = await chores(engine, ["a", "b"]);
    // Without awarding, the concurrency ceiling does not apply: the work waits in the marketplace.
    const result = await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId, award: false });
    expect(result.created.length).toBe(2);
    expect(result.created.every((link) => link.status === "posted" || link.status === "nominated")).toBe(true);
    await engine.shutdown();
  });

  it("shares the unattended run budget fairly across plans", async () => {
    const { engine, session } = await setup();
    await engine.society.configureBudget("tenant", 1_000_000, 8);
    const first = await chores(engine, ["a1", "a2"], 5000, "Plan A");
    const second = await chores(engine, ["b1", "b2"], 5000, "Plan B");
    await engine.delegation.configure({ tenantId: "tenant", autoDelegate: true, rootSessionId: session.sessionId, maxTasksPerRun: 1, maxActiveTasksPerPlan: 5 });

    await engine.delegation.runCycle("tenant");
    await engine.delegation.runCycle("tenant");
    const links = await engine.delegation.links("tenant", { limit: 50 });
    // One task each: the plan that had never been delegated goes first on the second pass.
    expect(new Set(links.map((link) => link.planId))).toEqual(new Set([first.id, second.id]));
    await engine.shutdown();
  });
});

describe("Aurora learning from delegated failures", () => {
  it("turns a failed delegation into an evidence-backed capability gap", async () => {
    const { engine } = await setup();
    // A failing child session is driven through stubs so the failure is exact; the learning sinks
    // (evolution, distiller) are the engine's real, governed services.
    const link = {
      id: "link-1", tenantId: "tenant", planId: "plan-1", planTitle: "Learning plan", stepKey: "work",
      taskId: "task-1", status: "running", assignedRoleId: "coding-agent",
    } as any;
    const task = { id: "task-1", tenantId: "tenant", status: "running", childSessionId: "child-1", maxTokens: 10_000, evidenceEventIds: [] } as any;
    const bridge = {
      links: async () => [link],
      sync: async () => ({ synced: 1, updatedSteps: [], closed: 0, generatedAt: new Date().toISOString() }),
      runCycle: async () => ({ synced: 0, updatedSteps: 0, delegated: 0, skipped: 0, autoDelegate: false }),
    } as any;
    // The stub keeps the task running so the same failure can be harvested twice and deduplicated.
    const society = { getTask: async () => task, recordOutcome: async () => task } as any;
    const sessions = { session: async () => ({ sessionId: "child-1", status: "failed", totalUsage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }) } as any;
    const events = { read: async () => [
      { eventId: "event-1", sequence: 1, type: "capability.finished", payload: { capabilityId: "fs.write", status: "failed", error: "denied" }, timestamp: new Date().toISOString() },
    ] } as any;

    const { AuroraOutcomeHarvester } = await import("../src/aurora/outcome-harvester.js");
    const root = await mkdtemp(join(tmpdir(), "haf-learning-"));
    const harvester = new AuroraOutcomeHarvester(join(root, "data"), {
      bridge, society, sessions, events, evolution: engine.evolution, distiller: engine.distiller,
    });
    await harvester.configure({ tenantId: "tenant", settleAfterMs: 0 });

    const harvest = await harvester.harvest({ tenantId: "tenant" });
    expect(harvest.recorded).toBe(1);
    const assessment = harvest.assessments[0]!;
    expect(assessment.success).toBe(false);
    expect(assessment.reason).toMatch(/Hard failure/);
    expect(assessment.learning?.gapId).toBeTruthy();

    const gap = (await engine.evolution.gaps("tenant", "open")).find((item) => item.id === assessment.learning?.gapId)!;
    expect(gap.description).toContain("work");
    expect(gap.evidenceRefs).toContain("task-1");
    expect(gap.severity).toBeGreaterThan(0);
    // The same failure twice is one deduplicated gap with a higher occurrence count, not two.
    const second = await harvester.harvest({ tenantId: "tenant", force: true });
    expect(second.assessments[0]?.learning?.gapOccurrences).toBeGreaterThan(1);
    expect((await engine.evolution.gaps("tenant", "open")).length).toBe(1);
    await engine.shutdown();
  });

  it("learns nothing from a clean success and can be switched off entirely", async () => {
    const { engine, session } = await setup();
    const plan = await chores(engine, ["work"], 10_000, "Quiet plan");
    const link = (await engine.delegation.delegate({ tenantId: "tenant", planId: plan.id, rootSessionId: session.sessionId })).created[0]!;
    await engine.delegation.activate("tenant", link.id);
    const task = await engine.society.getTask("tenant", link.taskId);
    for (let index = 0; index < 300; index++) {
      const child = await engine.session(task.childSessionId!);
      if (!child.activeTurnId && child.status === "idle") break;
      await new Promise((wait) => setTimeout(wait, 10));
    }
    const harvest = await engine.harvester.harvest({ tenantId: "tenant" });
    expect(harvest.assessments[0]?.success).toBe(true);
    expect(harvest.assessments[0]?.learning).toBeUndefined();
    expect((await engine.evolution.gaps("tenant", "open")).length).toBe(0);

    const policy = await engine.harvester.configure({ tenantId: "tenant", learnFromFailures: false });
    expect(policy.learnFromFailures).toBe(false);
    await engine.shutdown();
  });
});

describe("Aurora custom role authority templates", () => {
  it("defines, resolves, applies and removes a tenant template", async () => {
    const { engine } = await setup();
    const defined = await engine.roleAuthority.defineTemplate({
      tenantId: "tenant",
      id: "reporter",
      title: "Reporting specialist",
      rationale: "Reads Aurora state and reports; never writes.",
      roleIds: ["communication-agent"],
      allow: ["aurora.metrics", "aurora.alerts", "plan.list", "plan.progress"],
      deny: ["plan.progress"],
      maxRisk: "pure",
    });
    expect(defined.template.builtin).toBe(false);
    expect(defined.resolved.capabilityIds).toContain("aurora.metrics");
    expect(defined.resolved.droppedByDeny).toContain("plan.progress");

    const all = await engine.roleAuthority.allTemplates("tenant");
    expect(all.filter((item) => item.builtin).length).toBeGreaterThan(5);
    expect(all.find((item) => item.id === "reporter")?.tenantId).toBe("tenant");

    const applied = await engine.roleAuthority.apply({ tenantId: "tenant", templateId: "reporter" });
    expect(applied.profile.name).toBe("aurora-reporter");
    expect(applied.boundRoleIds).toEqual(["communication-agent"]);

    expect(await engine.roleAuthority.removeTemplate("tenant", "reporter")).toEqual({ templateId: "reporter", removed: true });
    expect((await engine.roleAuthority.allTemplates("tenant")).some((item) => item.id === "reporter")).toBe(false);
    await engine.shutdown();
  });

  it("protects the built-ins and rejects templates that grant nothing", async () => {
    const { engine } = await setup();
    await expect(engine.roleAuthority.defineTemplate({ tenantId: "tenant", id: "coder", title: "x", rationale: "y", allow: ["aurora.metrics"], maxRisk: "pure" }))
      .rejects.toThrow(/reserved by a built-in/);
    await expect(engine.roleAuthority.removeTemplate("tenant", "coder")).rejects.toThrow(/cannot be removed/);
    await expect(engine.roleAuthority.defineTemplate({ tenantId: "tenant", id: "ghost", title: "x", rationale: "y", allow: ["nothing.matches.this"], maxRisk: "pure" }))
      .rejects.toThrow(/resolves to no capability/);
    await expect(engine.roleAuthority.defineTemplate({ tenantId: "tenant", id: "Bad Id", title: "x", rationale: "y", allow: ["aurora.metrics"], maxRisk: "pure" }))
      .rejects.toThrow(/Template ID/);
    await engine.shutdown();
  });

  it("keeps custom templates and their drift audit tenant-scoped", async () => {
    const { engine } = await setup();
    await engine.roleAuthority.defineTemplate({
      tenantId: "tenant", id: "reporter", title: "Reporting specialist", rationale: "Read-only reporting.",
      allow: ["aurora.metrics"], maxRisk: "pure",
    });
    expect((await engine.roleAuthority.allTemplates("other")).some((item) => item.id === "reporter")).toBe(false);
    await expect(engine.roleAuthority.resolveFor("other", "reporter")).rejects.toThrow(/Unknown role authority template/);

    const applied = await engine.roleAuthority.apply({ tenantId: "tenant", templateId: "reporter", bind: false });
    await engine.agentProfiles.update(applied.profile.id, { allowedCapabilityIds: [...(applied.profile.allowedCapabilityIds ?? []), "process.exec"] });
    const audit = await engine.roleAuthority.audit("tenant");
    expect(audit.findings.some((item) => item.code === "profile-drifted-above-template")).toBe(true);
    await engine.shutdown();
  });
});

describe("Aurora policy forward migration", () => {
  it("reads a delegation policy written before probation existed", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-legacy-policy-"));
    const dataRoot = join(homePath, "data");
    await mkdir(join(dataRoot, "planning"), { recursive: true });
    await writeFile(join(dataRoot, "planning", "delegation.json"), `${JSON.stringify({
      schemaVersion: 1,
      links: [],
      policies: [{ tenantId: "tenant", autoDelegate: false, autoActivate: false, maxActiveTasksPerPlan: 3, maxTasksPerRun: 5, requireRoleMatch: true, updatedAt: new Date().toISOString() }],
    }, null, 2)}\n`, "utf8");
    await writeFile(join(dataRoot, "planning", "harvest.json"), `${JSON.stringify({
      schemaVersion: 1,
      assessments: [],
      policies: [{ tenantId: "tenant", autoRecord: true, successAtOrAbove: 0.6, failBelow: 0.35, settleAfterMs: 60_000, maxPerRun: 25, updatedAt: new Date().toISOString() }],
    }, null, 2)}\n`, "utf8");

    const { AuroraExecutionBridge } = await import("../src/aurora/execution-bridge.js");
    const { AuroraOutcomeHarvester } = await import("../src/aurora/outcome-harvester.js");
    const stub = { list: async () => [], get: async () => { throw new Error("no plan"); }, progress: async () => ({ ready: [] }) } as any;
    const society = { roles: async () => [], tasks: async () => [], budget: async () => ({ dailyTokenBudget: 0, usedTokens: 0, reservedTokens: 0, maxConcurrentTasks: 0 }) } as any;
    const bridge = new AuroraExecutionBridge(dataRoot, { planning: stub, society });
    const policy = await bridge.policy("tenant");
    expect(policy.probation).toEqual({ minAttempts: 4, maxFailureRate: 0.5, riskFloor: 0.7 });
    expect(await bridge.probationReport("tenant")).toMatchObject({ roles: [], blockedSteps: [] });

    const harvester = new AuroraOutcomeHarvester(dataRoot, { bridge, society, sessions: {} as any, events: {} as any });
    expect((await harvester.policy("tenant")).learnFromFailures).toBe(true);
  });
});
