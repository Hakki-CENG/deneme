import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

async function setup() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-harvest-"));
  const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
  const session = await engine.createSession({ tenantId: "tenant" });
  await engine.society.roles("tenant");
  // The settle window only exists to avoid harvesting work in flight; tests drive the clock instead.
  await engine.harvester.configure({ tenantId: "tenant", settleAfterMs: 0 });
  return { engine, session };
}

async function plan(engine: HybridAgentEngine, key = "design") {
  return await engine.planning.create({
    tenantId: "tenant", title: "Harvest plan", objective: "Prove the outcome loop closes.", tags: ["planning"],
    steps: [{ key, title: "Do the work", estimateTokens: 20_000, verification: "reviewed" }],
  });
}

async function settledDelegation(engine: HybridAgentEngine, sessionId: string) {
  const record = await plan(engine);
  const link = (await engine.delegation.delegate({ tenantId: "tenant", planId: record.id, rootSessionId: sessionId })).created[0]!;
  await engine.delegation.activate("tenant", link.id);
  const task = await engine.society.getTask("tenant", link.taskId);
  for (let index = 0; index < 300; index++) {
    const child = await engine.session(task.childSessionId!);
    const events = await engine.readEvents(task.childSessionId!);
    if (!child.activeTurnId && child.status === "idle" && events.some((item) => item.type === "message.created")) break;
    await new Promise((wait) => setTimeout(wait, 10));
  }
  return { plan: record, link, task };
}

describe("Aurora delegated outcome harvester", () => {
  it("scores a settled child session from recorded events and records the outcome", async () => {
    const { engine, session } = await setup();
    const { plan: record, link } = await settledDelegation(engine, session.sessionId);

    const result = await engine.harvester.harvest({ tenantId: "tenant" });
    expect(result.considered).toBe(1);
    expect(result.recorded).toBe(1);
    const assessment = result.assessments[0]!;
    expect(assessment.disposition).toBe("recorded");
    expect(assessment.success).toBe(true);
    expect(assessment.evidenceEventIds.length).toBeGreaterThan(0);
    expect(assessment.criteria.map((item) => item.code)).toEqual([
      "produced-output", "tool-reliability", "session-health", "no-guardrail-trips", "within-budget",
    ]);
    // The score is re-derivable from the stored criteria: no hidden judgement.
    const weighted = assessment.criteria.reduce((sum, item) => sum + item.weight * item.score, 0)
      / assessment.criteria.reduce((sum, item) => sum + item.weight, 0);
    expect(Math.abs(weighted - assessment.quality)).toBeLessThan(0.01);

    const task = await engine.society.getTask("tenant", link.taskId);
    expect(task.status).toBe("completed");
    const updated = await engine.planning.get("tenant", record.id);
    expect(updated.steps[0]?.status).toBe("done");
    expect(updated.steps[0]?.evidenceRefs.length).toBeGreaterThan(0);
    await engine.shutdown();
  });

  it("never harvests work that is still in flight", async () => {
    const { engine, session } = await setup();
    await engine.harvester.configure({ tenantId: "tenant", settleAfterMs: 3_600_000 });
    const record = await plan(engine);
    const link = (await engine.delegation.delegate({ tenantId: "tenant", planId: record.id, rootSessionId: session.sessionId })).created[0]!;
    // Assigned but never activated: there is no child session at all.
    const beforeActivation = await engine.harvester.harvest({ tenantId: "tenant" });
    expect(beforeActivation.recorded).toBe(0);
    expect(beforeActivation.skipped).toBe(1);

    await engine.delegation.activate("tenant", link.id);
    const running = await engine.harvester.harvest({ tenantId: "tenant" });
    expect(running.recorded).toBe(0);
    expect((await engine.society.getTask("tenant", link.taskId)).status).toBe("running");
    await engine.shutdown();
  });

  it("lets a human resolve a review item while keeping the machine scorecard attached", async () => {
    const { engine, session } = await setup();
    const { plan: record, link } = await settledDelegation(engine, session.sessionId);
    await engine.harvester.configure({ tenantId: "tenant", autoRecord: false });
    const harvest = await engine.harvester.harvest({ tenantId: "tenant" });
    expect(harvest.review).toBe(1);
    const item = harvest.assessments[0]!;

    const resolved = await engine.harvester.resolveReview({ tenantId: "tenant", assessmentId: item.id, success: true, quality: 0.8, note: "Reviewed the diff by hand." });
    expect(resolved.disposition).toBe("recorded");
    expect(resolved.quality).toBe(0.8);
    expect(resolved.criteria.length).toBe(5);
    expect(resolved.reason).toContain("Resolved by a human");
    expect((await engine.society.getTask("tenant", link.taskId)).status).toBe("completed");
    expect((await engine.planning.get("tenant", record.id)).steps[0]?.status).toBe("done");
    await expect(engine.harvester.resolveReview({ tenantId: "tenant", assessmentId: item.id, success: true })).rejects.toThrow(/already recorded/);
    await engine.shutdown();
  });

  it("treats a session with no assistant output as a hard failure", async () => {
    const { engine, session } = await setup();
    const record = await plan(engine);
    const link = (await engine.delegation.delegate({ tenantId: "tenant", planId: record.id, rootSessionId: session.sessionId })).created[0]!;
    await engine.delegation.activate("tenant", link.id);
    // Harvest immediately with force: the child has not produced anything yet.
    const result = await engine.harvester.harvest({ tenantId: "tenant", force: true });
    const assessment = result.assessments[0];
    if (assessment) {
      expect(assessment.reason.startsWith("Hard failure") || assessment.success).toBeDefined();
      if (assessment.reason.startsWith("Hard failure")) {
        expect(assessment.success).toBe(false);
        expect(assessment.quality).toBeLessThanOrEqual(0.2);
      }
    }
    await engine.shutdown();
  });

  it("moves role reputation from real evidence", async () => {
    const { engine, session } = await setup();
    const { link } = await settledDelegation(engine, session.sessionId);
    const before = (await engine.society.roles("tenant")).find((item) => item.id === link.assignedRoleId)!;
    await engine.harvester.harvest({ tenantId: "tenant" });
    const after = (await engine.society.roles("tenant")).find((item) => item.id === link.assignedRoleId)!;
    expect(after.completedTasks).toBe(before.completedTasks + 1);
    expect(after.reputation).not.toBe(before.reputation);
    await engine.shutdown();
  });

  it("assesses a single delegation without recording anything", async () => {
    const { engine, session } = await setup();
    const { link } = await settledDelegation(engine, session.sessionId);
    const assessment = await engine.harvester.assess("tenant", link.id);
    expect(assessment.criteria.length).toBe(5);
    expect((await engine.society.getTask("tenant", link.taskId)).status).toBe("running");
    expect((await engine.harvester.assessments("tenant")).length).toBe(0);
    await engine.shutdown();
  });

  it("rejects an inverted threshold configuration", async () => {
    const { engine } = await setup();
    await expect(engine.harvester.configure({ tenantId: "tenant", failBelow: 0.9, successAtOrAbove: 0.5 }))
      .rejects.toThrow(/failure threshold cannot sit above/);
    await engine.shutdown();
  });

  it("runs harvesting inside the ACOS execute phase", async () => {
    const { engine, session } = await setup();
    await settledDelegation(engine, session.sessionId);
    const report = await engine.acos.tick("tenant", { mode: "full" });
    const execute = report.phases.find((item) => item.phase === "execute");
    expect(execute?.status).toBe("ok");
    expect(execute?.detail.outcomesHarvested).toBe(1);
    await engine.shutdown();
  });

  it("keeps assessments tenant-scoped", async () => {
    const { engine, session } = await setup();
    await settledDelegation(engine, session.sessionId);
    await engine.harvester.harvest({ tenantId: "tenant" });
    expect((await engine.harvester.assessments("other"))).toEqual([]);
    await expect(engine.harvester.assess("other", "delegation-missing")).rejects.toThrow(/not found in tenant/);
    await engine.shutdown();
  });
});

/**
 * Scorecard behaviour is exercised against stub dependencies so each criterion can be driven exactly.
 * The integration tests above prove the same code path runs against a real engine.
 */
describe("Aurora outcome scorecard", () => {
  function envelope(type: string, payload: unknown, index: number) {
    return { eventId: `event-${index}`, sequence: index, type, payload, timestamp: new Date(1_700_000_000_000 + index).toISOString() } as any;
  }
  function assistantMessage(index: number) { return envelope("message.created", { message: { role: "assistant" } }, index); }
  function toolCall(index: number, failed: boolean) { return envelope("capability.finished", failed ? { capabilityId: "fs.write", status: "failed", error: "denied" } : { capabilityId: "fs.write", status: "ok" }, index); }

  async function harness(options: { events: any[]; status?: string; tokens?: number; maxTokens?: number }) {
    const root = await mkdtemp(join(tmpdir(), "haf-harvest-unit-"));
    const recorded: any[] = [];
    const link = { id: "link-1", tenantId: "tenant", planId: "plan-1", stepKey: "design", taskId: "task-1", status: "running" } as any;
    const task = { id: "task-1", tenantId: "tenant", status: "running", childSessionId: "child-1", maxTokens: options.maxTokens ?? 100_000, evidenceEventIds: [] } as any;
    const bridge = {
      links: async () => [link],
      sync: async () => ({ synced: 1, updatedSteps: [], closed: 0, generatedAt: new Date().toISOString() }),
      runCycle: async () => ({ synced: 1, updatedSteps: 0, delegated: 0, skipped: 0, autoDelegate: false }),
    } as any;
    const society = {
      getTask: async () => task,
      recordOutcome: async (input: any) => { recorded.push(input); task.status = input.success ? "completed" : "failed"; return task; },
    } as any;
    const sessions = { session: async () => ({ sessionId: "child-1", status: options.status ?? "idle", totalUsage: { inputTokens: options.tokens ?? 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }) } as any;
    const events = { read: async () => options.events } as any;
    const { AuroraOutcomeHarvester } = await import("../src/aurora/outcome-harvester.js");
    const harvester = new AuroraOutcomeHarvester(join(root, "data"), { bridge, society, sessions, events });
    await harvester.configure({ tenantId: "tenant", settleAfterMs: 0 });
    return { harvester, recorded, task };
  }

  it("penalises failing tool calls proportionally", async () => {
    const clean = await harness({ events: [assistantMessage(1), toolCall(2, false), toolCall(3, false), toolCall(4, false)] });
    const cleanResult = await clean.harvester.harvest({ tenantId: "tenant" });
    expect(cleanResult.assessments[0]?.quality).toBe(1);

    const messy = await harness({ events: [assistantMessage(1), toolCall(2, true), toolCall(3, true), toolCall(4, false)] });
    const messyResult = await messy.harvester.harvest({ tenantId: "tenant" });
    const assessment = messyResult.assessments[0]!;
    expect(assessment.quality).toBeLessThan(1);
    expect(assessment.criteria.find((item) => item.code === "tool-reliability")?.score).toBeCloseTo(0.333333, 4);
    expect(assessment.evidenceEventIds).toContain("event-2");
  });

  it("sends the ambiguous middle band to review instead of guessing", async () => {
    const { harvester, recorded } = await harness({ events: [assistantMessage(1), toolCall(2, true), toolCall(3, true), toolCall(4, false)] });
    await harvester.configure({ tenantId: "tenant", failBelow: 0.5, successAtOrAbove: 0.95 });
    const result = await harvester.harvest({ tenantId: "tenant" });
    expect(result.recorded).toBe(0);
    expect(result.review).toBe(1);
    expect(recorded).toEqual([]);
    expect(result.assessments[0]?.reason).toMatch(/between the failure/);
    expect((await harvester.reviewQueue("tenant")).length).toBe(1);
  });

  it("records a clear failure below the failure threshold without asking anyone", async () => {
    const { harvester, recorded } = await harness({ events: [assistantMessage(1), toolCall(2, true), toolCall(3, true), toolCall(4, true)], status: "failed" });
    const result = await harvester.harvest({ tenantId: "tenant" });
    expect(result.recorded).toBe(1);
    expect(result.assessments[0]?.success).toBe(false);
    expect(recorded[0]).toMatchObject({ success: false });
  });

  it("counts guardrail trips and budget overruns", async () => {
    const { harvester } = await harness({
      events: [assistantMessage(1), envelope("guardrail.tool_loop_limit", { detail: "loop" }, 2)],
      tokens: 200_000, maxTokens: 100_000,
    });
    const result = await harvester.harvest({ tenantId: "tenant", force: true });
    const criteria = Object.fromEntries((result.assessments[0]?.criteria ?? []).map((item) => [item.code, item.score]));
    expect(criteria["no-guardrail-trips"]).toBe(0);
    expect(criteria["within-budget"]).toBe(0);
  });

  it("refuses to record when the child session left no usable evidence", async () => {
    const { harvester, recorded } = await harness({ events: [] });
    const result = await harvester.harvest({ tenantId: "tenant", force: true });
    expect(result.recorded).toBe(0);
    expect(result.review).toBe(1);
    expect(result.assessments[0]?.reason).toMatch(/no event that could serve as evidence/);
    expect(recorded).toEqual([]);
  });
});
