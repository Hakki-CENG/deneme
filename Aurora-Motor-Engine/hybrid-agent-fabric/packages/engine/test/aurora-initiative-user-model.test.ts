import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProactiveInitiativeService } from "../src/initiative/proactive-initiative-service.js";
import { UserModelService } from "../src/user/user-model-service.js";

async function initiative(now: () => number): Promise<{ service: ProactiveInitiativeService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "haf-aurora-initiative-"));
  return { service: new ProactiveInitiativeService(root, now), root };
}

describe("Aurora Phase E proactive initiative engine", () => {
  it("scores worthiness, classifies P0-P4 and respects the daily attention budget", async () => {
    let now = Date.parse("2026-04-01T12:00:00Z");
    const { service } = await initiative(() => now);
    await service.configureBudget({ tenantId: "tenant", dailyImmediateLimit: 1, dailyMessageLimit: 1 });
    const critical = await service.propose({ tenantId: "tenant", kind: "risk", title: "Repository has no backup", message: "The main repository has no backup and a disk failure would lose everything.", importance: 1, urgency: 1, impact: 1, confidence: 0.95, userRelevance: 1, mode: "guardian" });
    expect(critical.worthiness).toBeCloseTo(0.95, 5);
    const second = await service.propose({ tenantId: "tenant", kind: "risk", title: "Certificate expires tomorrow", message: "A TLS certificate expires in 24 hours.", importance: 0.95, urgency: 1, impact: 0.95, confidence: 0.95, userRelevance: 1, mode: "guardian" });
    const minor = await service.propose({ tenantId: "tenant", kind: "insight", title: "New blog post", message: "A tangentially related blog post appeared.", importance: 0.2, urgency: 0.1, impact: 0.1, confidence: 0.5, userRelevance: 0.2 });
    const evaluation = await service.evaluate("tenant");
    const queuedIds = evaluation.queued.map((item) => item.id);
    expect(queuedIds).toContain(critical.id);
    expect(evaluation.queued.find((item) => item.id === critical.id)?.priority).toBe("P0");
    expect(evaluation.digested).toContain(minor.id);
    const secondState = (await service.initiatives("tenant")).find((item) => item.id === second.id)!;
    expect(["queued", "digested"]).toContain(secondState.state);
    expect(evaluation.budget.usedImmediate).toBe(1);
  });

  it("suppresses duplicate signals and enforces quiet hours for non-critical classes", async () => {
    let now = Date.parse("2026-04-01T02:00:00Z");
    const { service } = await initiative(() => now);
    await service.configureBudget({ tenantId: "tenant", quietHoursUtc: { startHour: 0, endHour: 6 }, dailyMessageLimit: 5, minWorthinessP0: 0.9 });
    await service.propose({ tenantId: "tenant", kind: "reminder", title: "Deadline approaching", message: "A submission deadline is close.", importance: 0.7, urgency: 0.8, impact: 0.7, confidence: 0.8, userRelevance: 0.9 });
    await expect(service.propose({ tenantId: "tenant", kind: "reminder", title: "Deadline approaching", message: "Duplicate signal.", importance: 0.7, urgency: 0.8, impact: 0.7, confidence: 0.8, userRelevance: 0.9 })).rejects.toThrow("duplicate");
    const evaluation = await service.evaluate("tenant");
    expect(evaluation.queued).toHaveLength(0);
    const digested = (await service.initiatives("tenant", { state: "digested" }))[0]!;
    expect(digested.suppressionReason).toBe("quiet-hours");
  });

  it("adapts thresholds to trust feedback and builds briefings and reviews", async () => {
    let now = Date.parse("2026-04-02T12:00:00Z");
    const { service } = await initiative(() => now);
    await service.configureBudget({ tenantId: "tenant", dailyImmediateLimit: 5, dailyMessageLimit: 5 });
    const first = await service.propose({ tenantId: "tenant", kind: "opportunity", title: "Grant programme opened", message: "A relevant grant programme opened applications.", importance: 0.8, urgency: 0.7, impact: 0.8, confidence: 0.8, userRelevance: 0.9 });
    await service.evaluate("tenant");
    await service.markDelivered("tenant", first.id, "telegram");
    const before = await service.budget("tenant");
    const feedback = await service.recordFeedback({ tenantId: "tenant", initiativeId: first.id, useful: false, actedOn: false, note: "Not relevant to me." });
    expect(feedback.budget.trustScore).toBeLessThan(before.trustScore);
    const recovered = await service.recordFeedback({ tenantId: "tenant", initiativeId: (await (async () => {
      const second = await service.propose({ tenantId: "tenant", kind: "insight", title: "Stalled memory work", message: "No progress on the memory layer for two weeks.", importance: 0.8, urgency: 0.6, impact: 0.8, confidence: 0.8, userRelevance: 0.9 });
      await service.evaluate("tenant");
      await service.markDelivered("tenant", second.id, "telegram");
      return second.id;
    })()), useful: true, actedOn: true });
    expect(recovered.budget.trustScore).toBeGreaterThan(feedback.budget.trustScore);
    const digest = await service.buildDigest("tenant", "daily");
    expect(digest.title).toBe("Daily briefing");
    expect(digest.initiativeIds.length).toBeGreaterThan(0);
    const weekly = await service.buildDigest("tenant", "weekly");
    expect(weekly.sections.length).toBeGreaterThan(0);
  });

  it("runs watchers over intake events without storing raw payloads and escalates on demand", async () => {
    let now = Date.parse("2026-04-03T12:00:00Z");
    const { service, root } = await initiative(() => now);
    const watcher = await service.registerWatcher({ tenantId: "tenant", kind: "research", name: "Neuromorphic watch", target: "neuromorphic", keywords: ["loihi", "neuromorphic"], intervalMinutes: 1, mode: "assistant" });
    await service.ingest({ tenantId: "tenant", source: "research", summary: "A new Loihi paper was published.", payload: { secret: "confidential-abstract-body" }, tags: ["research"] });
    await service.ingest({ tenantId: "tenant", source: "weather", summary: "Rain expected tomorrow.", tags: ["weather"] });
    const run = await service.runWatchers("tenant");
    expect(run.matched).toHaveLength(1);
    expect(run.matched[0]?.watcherId).toBe(watcher.id);
    const disk = await readFile(join(root, "initiative", "state.json"), "utf8");
    expect(disk).not.toContain("confidential-abstract-body");
    const created = (await service.initiatives("tenant"))[0]!;
    const escalated = await service.escalate("tenant", created.id, "The user explicitly asked to be told about Loihi immediately.");
    expect(escalated.escalations).toHaveLength(1);
    expect(escalated.state).toBe("candidate");
    await expect(service.escalate("tenant", escalated.id, "again")).resolves.toBeTruthy();
  });

  it("resets the daily budget across days and keeps tenants isolated", async () => {
    let now = Date.parse("2026-04-04T12:00:00Z");
    const { service } = await initiative(() => now);
    await service.configureBudget({ tenantId: "tenant", dailyImmediateLimit: 1, dailyMessageLimit: 0, minWorthinessP0: 0.1 });
    await service.propose({ tenantId: "tenant", kind: "risk", title: "Disk almost full", message: "Disk usage is at 97%.", importance: 0.9, urgency: 0.9, impact: 0.9, confidence: 0.9, userRelevance: 0.9 });
    expect((await service.evaluate("tenant")).queued).toHaveLength(1);
    expect((await service.budget("tenant")).usedImmediate).toBe(1);
    now += 86_400_000;
    expect((await service.budget("tenant")).usedImmediate).toBe(0);
    expect(await service.initiatives("other")).toHaveLength(0);
  });
});

describe("Aurora Phase E governed user model", () => {
  async function userModel(now?: () => number): Promise<UserModelService> {
    const root = await mkdtemp(join(tmpdir(), "haf-aurora-user-"));
    return now ? new UserModelService(root, now) : new UserModelService(root);
  }

  it("keeps inferences proposed until confirmed and records evidence", async () => {
    const service = await userModel();
    const inferred = await service.observeClaim({ tenantId: "tenant", userId: "u1", category: "habit", key: "research-loop", value: "Long research phases delay implementation.", confidence: 0.6, source: "inferred", evidenceRefs: ["evt-1"] });
    expect(inferred).toMatchObject({ status: "proposed", consent: "pending", observations: 1 });
    await service.observeClaim({ tenantId: "tenant", userId: "u1", category: "habit", key: "research-loop", value: "Long research phases delay implementation.", confidence: 0.7, source: "inferred" });
    const third = await service.observeClaim({ tenantId: "tenant", userId: "u1", category: "habit", key: "research-loop", value: "Long research phases delay implementation.", confidence: 0.7, source: "inferred" });
    expect(third.status).toBe("active");
    expect(third.observations).toBe(3);
    const stated = await service.observeClaim({ tenantId: "tenant", userId: "u1", category: "communication", key: "style", value: "Short and technical.", confidence: 0.9, source: "user-stated" });
    expect(stated).toMatchObject({ status: "active", consent: "granted" });
  });

  it("rejects protected-topic inferences", async () => {
    const service = await userModel();
    await expect(service.observeClaim({ tenantId: "tenant", userId: "u1", category: "habit", key: "belief", value: "The user follows a specific religion.", confidence: 0.5, source: "inferred" })).rejects.toThrow("protected-topic");
    await expect(service.observeClaim({ tenantId: "tenant", userId: "u1", category: "identity-context", key: "salary", value: "The user earns a certain salary.", confidence: 0.5, source: "user-stated" })).rejects.toThrow("protected-topic");
  });

  it("supports correction, consent withdrawal and full deletion", async () => {
    const service = await userModel();
    const claim = await service.observeClaim({ tenantId: "tenant", userId: "u1", category: "learning-style", key: "prefers", value: "Video tutorials.", confidence: 0.5, source: "inferred" });
    const corrected = await service.correctClaim({ tenantId: "tenant", claimId: claim.id, correctedValue: "Written documentation and code samples.", reason: "The user corrected Aurora." });
    expect(corrected.value).toBe("Written documentation and code samples.");
    expect(corrected.correctionHistory[0]?.previousValue).toBe("Video tutorials.");
    expect(corrected.source).toBe("user-stated");
    const denied = await service.setConsent("tenant", corrected.id, "denied");
    expect(denied.status).toBe("retracted");
    await service.upsertGoal({ tenantId: "tenant", userId: "u1", horizon: "long", title: "Ship Aurora", importance: 0.9 });
    const removed = await service.forgetUser("tenant", "u1");
    expect(removed.removedClaims).toBe(1);
    expect(removed.removedGoals).toBe(1);
    expect(await service.claims("tenant", "u1")).toHaveLength(0);
  });

  it("models goals, stalled progress, state estimation and advice effectiveness", async () => {
    let now = Date.parse("2026-05-01T12:00:00Z");
    const service = await userModel(() => now);
    const goal = await service.upsertGoal({ tenantId: "tenant", userId: "u1", horizon: "long", title: "Aurora V2", description: "Memory, thought loop and world model.", importance: 0.95 });
    await service.upsertGoal({ tenantId: "tenant", userId: "u1", horizon: "short", title: "Memory architecture", parentGoalId: goal.id, importance: 0.8 });
    expect((await service.goals("tenant", "u1"))[0]?.horizon).toBe("long");
    now += 20 * 86_400_000;
    expect((await service.stalledGoals("tenant", "u1", 14)).length).toBe(2);

    await service.recordSignal({ tenantId: "tenant", userId: "u1", kind: "commit", intensity: 0.9 });
    await service.recordSignal({ tenantId: "tenant", userId: "u1", kind: "activity", intensity: 0.7 });
    const estimate = await service.estimateState("tenant", "u1");
    expect(estimate.state).toBe("working");
    expect(estimate.isEstimate).toBe(true);
    expect(estimate.uncertainty).toBeCloseTo(1 - estimate.confidence, 5);

    const advice = await service.recordAdvice({ tenantId: "tenant", userId: "u1", summary: "Split the memory milestone into three tasks." });
    await service.recordAdviceOutcome({ tenantId: "tenant", adviceId: advice.id, followed: true, helpful: true });
    const summary = await service.summary("tenant", "u1");
    expect(summary.adviceEffectiveness).toMatchObject({ total: 1, followed: 1, helpful: 1 });
    expect(summary.goals.length).toBe(2);

    const alignment = await service.alignmentCheck("tenant", "u1", "Refactor the memory architecture module for Aurora V2.");
    expect(alignment.aligned).toBe(true);
    expect(alignment.supportingGoalIds.length).toBeGreaterThan(0);
  });

  it("estimates frustration risk from errors and stalled goals", async () => {
    let now = Date.parse("2026-05-01T12:00:00Z");
    const service = await userModel(() => now);
    await service.upsertGoal({ tenantId: "tenant", userId: "u1", horizon: "short", title: "Fix flaky pipeline", importance: 0.7 });
    for (let index = 0; index < 6; index++) await service.recordSignal({ tenantId: "tenant", userId: "u1", kind: "error", intensity: 0.8 });
    now += 20 * 86_400_000;
    const risk = await service.frustrationRisk("tenant", "u1");
    expect(risk.risk).toBeGreaterThan(0);
    expect(risk.recommendation).toBeTruthy();
    expect((await service.timeline("tenant", "u1"))).toHaveLength(0);
    const milestone = await service.addMilestone({ tenantId: "tenant", userId: "u1", kind: "turning-point", title: "Switched approach", summary: "Adopted a staged rollout." });
    expect((await service.timeline("tenant", "u1"))[0]?.id).toBe(milestone.id);
  });
});
