import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

async function setup() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-society-bus-"));
  const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
  const session = await engine.createSession({ tenantId: "tenant" });
  return { engine, session };
}

describe("Aurora Phase A extensions: communication bus and meta-agent monitoring", () => {
  it("routes bounded messages between roles and tracks acknowledgements", async () => {
    const { engine } = await setup();
    const message = await engine.society.broadcast({
      tenantId: "tenant", fromRoleId: "research-director", topic: "New evidence",
      body: "Three papers relevant to the memory architecture were published.", audienceRoleIds: ["memory-director", "planning-director"], importance: 0.7,
    });
    expect(message.audienceRoleIds).toEqual(["memory-director", "planning-director"]);
    const memoryInbox = await engine.society.inbox("tenant", "memory-director");
    expect(memoryInbox.map((item) => item.id)).toEqual([message.id]);
    expect(await engine.society.inbox("tenant", "risk-agent")).toHaveLength(0);
    const broadcast = await engine.society.broadcast({ tenantId: "tenant", fromRoleId: "aurora-prime", topic: "Priorities", body: "Safety work takes precedence this week." });
    expect((await engine.society.inbox("tenant", "risk-agent")).map((item) => item.id)).toEqual([broadcast.id]);
    const acknowledged = await engine.society.acknowledgeMessage("tenant", message.id, "memory-director");
    expect(acknowledged.acknowledgedBy).toEqual(["memory-director"]);
    expect((await engine.society.inbox("tenant", "memory-director", { unacknowledgedOnly: true })).map((item) => item.id)).toEqual([broadcast.id]);
    await expect(engine.society.broadcast({ tenantId: "tenant", fromRoleId: "missing-role", topic: "x", body: "y" })).rejects.toThrow("not found");
    await engine.shutdown();
  });

  it("reports stalled work, unbid tasks, duplicates and budget saturation", async () => {
    const { engine, session } = await setup();
    await engine.society.configureBudget("tenant", 20_000, 1);
    const first = await engine.society.postTask({ tenantId: "tenant", rootSessionId: session.sessionId, title: "Audit dependencies", objective: "Audit third-party dependencies.", requiredCapabilityTags: ["security"], maxTokens: 18_000 });
    await engine.society.postTask({ tenantId: "tenant", rootSessionId: session.sessionId, title: "Audit dependencies", objective: "Duplicate objective.", requiredCapabilityTags: ["security"], maxTokens: 5_000 });
    await engine.society.bid({ tenantId: "tenant", taskId: first.id, roleId: "security-director", confidence: 0.9, estimatedTokens: 18_000, estimatedDurationMs: 1000, rationale: "Security authority." });
    await engine.society.award("tenant", first.id);
    const report = await engine.society.metaMonitor("tenant", { stalledAfterMs: 60_000 });
    const codes = report.advisories.map((item) => item.code);
    expect(codes).toContain("duplicate-task");
    expect(codes).toContain("budget-saturated");
    expect(codes).toContain("concurrency-starved");
    expect(report.utilization.runningTasks).toBe(1);
    expect(report.budgetSaturation).toBeGreaterThanOrEqual(0.9);
    await engine.shutdown();
  });

  it("retires only non-builtin roles with an evidence-bound failure record", async () => {
    const { engine, session } = await setup();
    const role = await engine.society.addRole({ tenantId: "tenant", name: "Flaky Scraper", layer: "micro", purpose: "Scrape sites.", capabilityTags: ["scraping"], parentRoleId: "research-director" });
    await engine.society.configureBudget("tenant", 1_000_000, 4);
    for (let index = 0; index < 5; index++) {
      let task = await engine.society.postTask({ tenantId: "tenant", rootSessionId: session.sessionId, title: `Scrape ${index}`, objective: "Scrape a page.", requiredCapabilityTags: ["scraping"], maxTokens: 5_000 });
      task = await engine.society.bid({ tenantId: "tenant", taskId: task.id, roleId: role.id, confidence: 0.6, estimatedTokens: 1_000, estimatedDurationMs: 1000, rationale: "Only scraper." });
      task = await engine.society.award("tenant", task.id);
      task = await engine.society.execute("tenant", task.id);
      let events = await engine.readEvents(task.childSessionId!);
      for (let attempt = 0; attempt < 100 && !events.length; attempt++) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        events = await engine.readEvents(task.childSessionId!);
      }
      await engine.society.recordOutcome({ tenantId: "tenant", taskId: task.id, success: false, quality: 0, actualTokens: 500, evidenceEventIds: [events[0]!.eventId] });
    }
    const retired = await engine.society.retireUnderperformers("tenant", { minAttempts: 5, maxFailureRate: 0.5 });
    expect(retired.map((item) => item.roleId)).toEqual([role.id]);
    expect((await engine.society.roles("tenant")).find((item) => item.id === role.id)?.status).toBe("retired");
    expect((await engine.society.roles("tenant")).find((item) => item.id === "aurora-prime")?.status).toBe("active");
    const advisories = (await engine.society.metaMonitor("tenant")).advisories;
    expect(advisories.every((item) => item.subjectId !== role.id || item.code !== "failing-role")).toBe(true);
    await engine.shutdown();
  }, 30_000);
});
