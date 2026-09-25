import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CognitiveWorkspaceService } from "../src/cognitive/cognitive-workspace-service.js";

async function workspace(now?: () => number): Promise<{ service: CognitiveWorkspaceService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "haf-aurora-cognitive-"));
  return { service: now ? new CognitiveWorkspaceService(root, now) : new CognitiveWorkspaceService(root), root };
}

describe("Aurora Phase B extensions: intake, preemption, reflection and cognitive health", () => {
  it("deduplicates automatic intake, enforces a daily quota and stores only digests", async () => {
    const { service, root } = await workspace();
    const accepted = await service.intake({ tenantId: "tenant", source: "world-model", title: "Backup missing", content: "The nightly backup job did not run.", sourceId: "evt-1" });
    expect(accepted.accepted).toBe(true);
    expect(accepted.object?.kind).toBe("observation");
    const duplicate = await service.intake({ tenantId: "tenant", source: "world-model", title: "Backup missing", content: "The nightly backup job did not run." });
    expect(duplicate).toMatchObject({ accepted: false, reason: "duplicate-intake-signal" });
    expect(duplicate.object).toBeUndefined();
    const quota = await service.intake({ tenantId: "tenant", source: "research", title: "Another signal", content: "Fresh signal.", dailyLimit: 1 });
    expect(quota).toMatchObject({ accepted: false, reason: "intake-quota-exhausted" });
    const log = await service.intakeLog("tenant");
    expect(log).toHaveLength(3);
    const disk = await readFile(join(root, "cognitive", "workspace.json"), "utf8");
    const parsed = JSON.parse(disk) as { intake: Array<{ digest: string; reason: string }> };
    expect(parsed.intake.every((item) => /^[0-9a-f]{64}$/.test(item.digest))).toBe(true);
    expect((await service.objects("tenant")).length).toBe(1);
  });

  it("preempts a lower-class focus for a constitutionally higher-class thought and never loses reservations", async () => {
    const { service } = await workspace();
    await service.configureBudget("tenant", 100_000, 1);
    const research = await service.createGoal({ tenantId: "tenant", title: "Research", objective: "Explore", class: "P3", importance: 1, urgency: 1, userRelevance: 1 });
    const safety = await service.createGoal({ tenantId: "tenant", title: "Safety", objective: "Protect", class: "P1", importance: 0.5, urgency: 0.5, userRelevance: 0.5 });
    const low = await service.createObject({ tenantId: "tenant", kind: "opportunity", title: "Paper", content: "New paper", sourceType: "event", confidence: 1, importance: 1, urgency: 1, impact: 1, userRelevance: 1, horizon: "strategic", goalId: research.id, requestedTokens: 10_000 });
    const first = await service.allocateAttention("tenant");
    expect(first.focused.map((item) => item.id)).toEqual([low.id]);
    expect(first.budget.reservedTokens).toBe(10_000);

    const urgent = await service.createObject({ tenantId: "tenant", kind: "risk", title: "Credential leak", content: "A credential may be exposed.", sourceType: "event", confidence: 0.8, importance: 0.8, urgency: 0.9, impact: 0.9, userRelevance: 0.9, horizon: "reactive", goalId: safety.id, requestedTokens: 12_000 });
    const withoutPreempt = await service.allocateAttention("tenant");
    expect(withoutPreempt.focused).toHaveLength(0);
    expect(withoutPreempt.deferred).toContain(urgent.id);

    const preempting = await service.allocateAttention("tenant", { preempt: true });
    expect(preempting.preempted).toEqual([low.id]);
    expect(preempting.focused.map((item) => item.id)).toEqual([urgent.id]);
    expect(preempting.budget.reservedTokens).toBe(12_000);
    const preempted = (await service.objects("tenant")).find((item) => item.id === low.id)!;
    expect(preempted).toMatchObject({ attentionState: "queued", reservedTokens: 0, state: "waiting" });
  });

  it("interrupts focus without losing budget accounting", async () => {
    const { service } = await workspace();
    await service.configureBudget("tenant", 50_000, 2);
    const object = await service.createObject({ tenantId: "tenant", kind: "problem", title: "Long task", content: "Investigate", sourceType: "agent", confidence: 0.5, importance: 0.7, urgency: 0.5, impact: 0.6, userRelevance: 0.7, horizon: "tactical", requestedTokens: 20_000 });
    await service.allocateAttention("tenant");
    expect((await service.budget("tenant")).reservedTokens).toBe(20_000);
    const interrupted = await service.interruptFocus("tenant", object.id, "User asked something else");
    expect(interrupted.state).toBe("waiting");
    expect(interrupted.tags.some((tag) => tag.startsWith("interrupted:"))).toBe(true);
    expect((await service.budget("tenant")).reservedTokens).toBe(0);
    await expect(service.interruptFocus("tenant", object.id, "again")).rejects.toThrow("not focused");
  });

  it("gates Dream Mode and meta reflection behind the matching cognitive mode", async () => {
    const { service } = await workspace();
    await expect(service.scheduleReflection({ tenantId: "tenant", kind: "dream" })).rejects.toThrow("dream cognitive mode");
    await expect(service.scheduleReflection({ tenantId: "tenant", kind: "meta" })).rejects.toThrow("reflection or dream");
    const mini = await service.scheduleReflection({ tenantId: "tenant", kind: "mini", note: "Quick review of today." });
    expect(mini.tags).toContain("reflection");
    await service.transitionMode("tenant", "reflection", "Scheduled review window");
    const deep = await service.scheduleReflection({ tenantId: "tenant", kind: "meta", note: "Review the review process." });
    expect(deep.horizon).toBe("strategic");
    await service.transitionMode("tenant", "dream", "Low-priority synthesis window");
    const dream = await service.scheduleReflection({ tenantId: "tenant", kind: "dream" });
    expect(dream.kind).toBe("insight");
    expect(dream.userRelevance).toBeLessThan(0.5);
  });

  it("ranks a curiosity queue and reports cognitive health with constitutional violations", async () => {
    let now = Date.parse("2026-08-01T12:00:00Z");
    const { service } = await workspace(() => now);
    await service.configureBudget("tenant", 20_000, 1);
    const hypothesis = await service.createObject({ tenantId: "tenant", kind: "hypothesis", title: "Neuromorphic speedup", content: "Neuromorphic hardware may cut inference cost.", sourceType: "agent", confidence: 0.2, importance: 0.9, urgency: 0.3, impact: 0.9, userRelevance: 0.7, horizon: "strategic", requestedTokens: 5_000, requestedTimeMs: 60_000 });
    await service.createObject({ tenantId: "tenant", kind: "observation", title: "Trivial", content: "Nothing interesting.", sourceType: "system", confidence: 0.95, importance: 0.1, urgency: 0.1, impact: 0.1, userRelevance: 0.1, horizon: "reactive" });
    const queue = await service.curiosityQueue("tenant");
    expect(queue[0]?.object.id).toBe(hypothesis.id);
    expect(queue[0]?.curiosity).toBeGreaterThan(0);

    await service.allocateAttention("tenant");
    now += 10 * 60_000;
    const looping = await service.createObject({ tenantId: "tenant", kind: "problem", title: "Loop", content: "Retrying the same approach.", sourceType: "agent", confidence: 0.5, importance: 0.5, urgency: 0.5, impact: 0.5, userRelevance: 0.5, horizon: "tactical" });
    for (let index = 0; index < 3; index++) await service.recordIteration("tenant", looping.id, "identical outcome");
    const health = await service.health("tenant");
    expect(health.loopBlocked).toContain(looping.id);
    expect(health.focusOverruns).toContain(hypothesis.id);
    expect(health.unsourcedHighConfidence.length).toBe(1);
    expect(health.constitutionalViolations.some((item) => item.code === "repeated-loop")).toBe(true);
    expect(health.constitutionalViolations.some((item) => item.code === "focus-overrun")).toBe(true);
    expect(health.healthScore).toBeLessThan(1);
    expect(health.intakeToday).toBe(0);
    expect(health.mode).toBe("reactive");
  });

  it("enforces cognitive-economy allocation buckets inside the attention budget", async () => {
    let now = Date.parse("2026-10-01T12:00:00Z");
    const { service } = await workspace(() => now);
    await service.configureBudget("tenant", 100_000, 5);
    await service.configureAllocation("tenant", [{ name: "project", share: 0.4 }, { name: "research", share: 0.2 }]);
    const view = await service.allocationView("tenant");
    expect(view).toEqual([
      expect.objectContaining({ name: "project", capTokens: 40_000, remainingTokens: 40_000 }),
      expect.objectContaining({ name: "research", capTokens: 20_000, remainingTokens: 20_000 }),
    ]);
    const projectWork = await service.createObject({ tenantId: "tenant", kind: "problem", title: "Ship the memory layer", content: "Implement consolidation", sourceType: "agent", confidence: 0.8, importance: 0.9, urgency: 0.8, impact: 0.9, userRelevance: 0.9, horizon: "tactical", bucket: "project", requestedTokens: 30_000 });
    const overflow = await service.createObject({ tenantId: "tenant", kind: "problem", title: "Second project task", content: "More project work", sourceType: "agent", confidence: 0.8, importance: 0.85, urgency: 0.8, impact: 0.85, userRelevance: 0.85, horizon: "tactical", bucket: "project", requestedTokens: 30_000 });
    const research = await service.createObject({ tenantId: "tenant", kind: "opportunity", title: "Scan new papers", content: "Weekly literature scan", sourceType: "system", confidence: 0.6, importance: 0.6, urgency: 0.4, impact: 0.6, userRelevance: 0.6, horizon: "strategic", bucket: "research", requestedTokens: 15_000 });

    const allocation = await service.allocateAttention("tenant");
    expect(allocation.focused.map((item) => item.id)).toEqual([projectWork.id, research.id]);
    expect(allocation.deferred).toContain(overflow.id);
    const buckets = Object.fromEntries(allocation.allocation.map((item) => [item.name, item]));
    expect(buckets["project"]).toMatchObject({ reservedTokens: 30_000, remainingTokens: 10_000 });
    expect(buckets["research"]).toMatchObject({ reservedTokens: 15_000, remainingTokens: 5_000 });

    await service.completeFocus("tenant", projectWork.id, "solved", 25_000);
    const after = await service.allocationView("tenant");
    expect(after[0]).toMatchObject({ name: "project", usedTokens: 25_000, reservedTokens: 0 });
    await expect(service.configureAllocation("tenant", [{ name: "a", share: 0.7 }, { name: "b", share: 0.5 }])).rejects.toThrow("cannot exceed 1");
    now += 86_400_000;
    expect((await service.allocationView("tenant"))[0]).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
  });

  it("keeps older workspace files readable after the intake ledger was introduced", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-aurora-cognitive-legacy-"));
    const legacy = new CognitiveWorkspaceService(root);
    const object = await legacy.createObject({ tenantId: "tenant", kind: "insight", title: "Legacy", content: "Existing state", sourceType: "system", confidence: 0.5, importance: 0.5, urgency: 0.5, impact: 0.5, userRelevance: 0.5, horizon: "tactical" });
    const path = join(root, "cognitive", "workspace.json");
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    delete parsed["intake"];
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    const reopened = new CognitiveWorkspaceService(root);
    expect((await reopened.objects("tenant")).map((item) => item.id)).toEqual([object.id]);
    expect(await reopened.intakeLog("tenant")).toEqual([]);
  });
});
