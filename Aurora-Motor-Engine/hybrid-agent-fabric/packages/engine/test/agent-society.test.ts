import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

async function setup(agentProfileId?: string) {
  const homePath = await mkdtemp(join(tmpdir(), "haf-society-"));
  const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
  const session = await engine.createSession({ tenantId: "tenant", ...(agentProfileId ? { agentProfileId } : {}) });
  return { homePath, engine, session };
}
async function waitForEvents(engine: HybridAgentEngine, sessionId: string) { for (let i=0;i<100;i++) { const events=await engine.readEvents(sessionId); if (events.length) return events; await new Promise(r=>setTimeout(r,10)); } return []; }

describe("Aurora agent society substrate", () => {
  it("seeds Prime/council/specialist roles and runs a budgeted marketplace task with evidence-bound reputation", async () => {
    const { engine, session } = await setup();
    const roles = await engine.society.roles("tenant");
    expect(roles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "aurora-prime", layer: "prime" }),
      expect.objectContaining({ id: "security-director", layer: "council" }),
      expect.objectContaining({ id: "coding-agent", layer: "specialist" }),
      expect.objectContaining({ id: "guardian-agent", layer: "specialist" }),
    ]));
    await engine.society.configureBudget("tenant", 100_000, 2);
    let task = await engine.society.postTask({ tenantId: "tenant", rootSessionId: session.sessionId, title: "Plan release", objective: "Produce a safe release plan with dependencies.", requiredCapabilityTags: ["planning"], priority: "high", maxTokens: 80_000 });
    task = await engine.society.bid({ tenantId: "tenant", taskId: task.id, roleId: "planning-director", confidence: .7, estimatedTokens: 50_000, estimatedDurationMs: 1000, rationale: "Council planning authority." });
    task = await engine.society.bid({ tenantId: "tenant", taskId: task.id, roleId: "planner-agent", confidence: .9, estimatedTokens: 30_000, estimatedDurationMs: 1000, rationale: "Specialist task decomposition." });
    task = await engine.society.award("tenant", task.id);
    expect(task).toMatchObject({ status: "assigned", assignedRoleId: "planner-agent", reservedTokens: 30_000 });
    task = await engine.society.execute("tenant", task.id);
    expect(task.status).toBe("running"); expect(task.childSessionId).toBeTruthy();
    const events = await waitForEvents(engine, task.childSessionId!);
    expect(events.length).toBeGreaterThan(0);
    task = await engine.society.recordOutcome({ tenantId: "tenant", taskId: task.id, success: true, quality: .9, actualTokens: 20_000, evidenceEventIds: [events[0]!.eventId] });
    expect(task.status).toBe("completed");
    expect((await engine.society.roles("tenant")).find(r=>r.id==="planner-agent")?.reputation).toBe(.9);
    expect(await engine.society.budget("tenant")).toMatchObject({ usedTokens: 20_000, reservedTokens: 0 });
    await engine.shutdown();
  });

  it("preserves dissent and returns uncertainty when weighted consensus is close", async () => {
    const { engine } = await setup();
    let d = await engine.society.createDeliberation({ tenantId: "tenant", question: "Should the experimental deployment proceed?", requiredRoleIds: ["planning-director","security-director","user-director"], quorum: 3 });
    d = await engine.society.submitPerspective({ tenantId: "tenant", deliberationId: d.id, roleId: "planning-director", recommendation: "approve", confidence: .9, summary: "Delivery value is high." });
    d = await engine.society.submitPerspective({ tenantId: "tenant", deliberationId: d.id, roleId: "security-director", recommendation: "reject", confidence: .9, summary: "Security evidence is incomplete." });
    d = await engine.society.submitPerspective({ tenantId: "tenant", deliberationId: d.id, roleId: "user-director", recommendation: "abstain", confidence: .8, summary: "Need explicit user preference." });
    d = await engine.society.resolveDeliberation("tenant", d.id);
    expect(d.result).toMatchObject({ decision: "uncertain", approveWeight: expect.any(Number), rejectWeight: expect.any(Number), missingRoleIds: [] });
    expect(d.perspectives).toHaveLength(3);
    await engine.shutdown();
  });

  it("enforces capability tags, daily token and concurrency budgets", async () => {
    const { engine, session } = await setup();
    await engine.society.configureBudget("tenant", 10_000, 1);
    const task = await engine.society.postTask({ tenantId: "tenant", rootSessionId: session.sessionId, title: "Secure review", objective: "Review security.", requiredCapabilityTags: ["security"], maxTokens: 10_000 });
    await expect(engine.society.bid({ tenantId: "tenant", taskId: task.id, roleId: "coding-agent", confidence: .9, estimatedTokens: 1000, estimatedDurationMs: 1000, rationale: "wrong role" })).rejects.toThrow("does not satisfy");
    await engine.society.bid({ tenantId: "tenant", taskId: task.id, roleId: "security-director", confidence: .9, estimatedTokens: 9000, estimatedDurationMs: 1000, rationale: "security role" });
    await engine.society.award("tenant", task.id);
    const second = await engine.society.postTask({ tenantId: "tenant", rootSessionId: session.sessionId, title: "Second", objective: "Second task.", requiredCapabilityTags: ["planning"], maxTokens: 10_000 });
    await engine.society.bid({ tenantId: "tenant", taskId: second.id, roleId: "planner-agent", confidence: .9, estimatedTokens: 1000, estimatedDurationMs: 1000, rationale: "planning" });
    await expect(engine.society.award("tenant", second.id)).rejects.toThrow("concurrency");
    await engine.shutdown();
  });

  it("prevents a society role profile from escalating beyond the parent profile", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-society-profile-"));
    const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
    const parentProfile = await engine.agentProfiles.add({ tenantId: "tenant", name: "parent", instructions: "restricted", allowedCapabilityIds: ["filesystem.read"] });
    const broader = await engine.agentProfiles.add({ tenantId: "tenant", name: "broader", instructions: "broader", allowedCapabilityIds: ["filesystem.read","filesystem.write"] });
    const session = await engine.createSession({ tenantId: "tenant", agentProfileId: parentProfile.id });
    await engine.society.bindProfile("tenant", "planner-agent", broader.id);
    const task = await engine.society.postTask({ tenantId: "tenant", rootSessionId: session.sessionId, title: "Plan", objective: "Plan safely.", requiredCapabilityTags: ["planning"], maxTokens: 1000 });
    await engine.society.bid({ tenantId: "tenant", taskId: task.id, roleId: "planner-agent", confidence: 1, estimatedTokens: 500, estimatedDurationMs: 1000, rationale: "best" });
    await engine.society.award("tenant", task.id);
    await expect(engine.society.execute("tenant", task.id)).rejects.toThrow("exceed parent capability authority");
    await engine.shutdown();
  });
});
