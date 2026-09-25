import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/aurora/event-bus.js";
import type { CapabilityLifecycleEvent } from "../src/capabilities/capability-broker.js";
import { UserModelIntegration } from "../src/user/user-model-integration.js";
import { UserModelService } from "../src/user/user-model-service.js";

async function setup(options: { now?: () => number; defaultUserId?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "haf-user-model-int-"));
  let now = options.now?.() ?? Date.parse("2026-09-25T12:00:00Z");
  const clock = () => now;
  const advance = (days: number) => { now += days * 86_400_000; };
  const userModel = new UserModelService(root, clock);
  const eventBus = new EventBus(100);
  const listeners: Array<(event: CapabilityLifecycleEvent) => void> = [];
  const broker = {
    subscribe(listener: (event: CapabilityLifecycleEvent) => void) {
      listeners.push(listener);
      return () => { listeners.splice(listeners.indexOf(listener), 1); };
    },
  };
  const integration = new UserModelIntegration(eventBus, userModel, broker, {
    ...(options.defaultUserId ? { defaultUserId: options.defaultUserId } : {}),
  });
  integration.init();
  const capabilityEvent = (descriptorId: string): void => {
    for (const listener of listeners) {
      listener({
        phase: "finished",
        descriptor: { id: descriptorId, version: "1.0.0", description: "", risk: "pure", sideEffect: false, source: "core" },
        context: { tenantId: "tenant", sessionId: "session-1", familyId: "f", turnId: "t", toolCallId: "c", source: "user", workspacePath: "/tmp", idempotencyKey: "k" },
        status: "ok",
        durationMs: 5,
      });
    }
  };
  return { userModel, eventBus, integration, advance, capabilityEvent, clock };
}

// ─── J1: event wiring ───

describe("user model event wiring (P1.44)", () => {
  it("keeps conversation goals out of the model while inference is not consented (the default)", async () => {
    const { eventBus, userModel } = await setup();
    await eventBus.emit("task.received", "test", { tenantId: "tenant", goal: "Ship the memory layer", userId: "u1", taskId: "task-1" });
    expect(await userModel.claims("tenant", "u1")).toHaveLength(0);
    const consents = await userModel.featureConsents("tenant", "u1");
    expect(consents.features["inference"]).toBe(false); // opt-in by default
  });

  it("proposes a goal claim from task requests once inference is consented", async () => {
    const { eventBus, userModel } = await setup();
    await userModel.setFeatureConsent("tenant", "u1", "inference", true);
    await eventBus.emit("task.received", "test", { tenantId: "tenant", goal: "Ship the memory layer", userId: "u1", taskId: "task-1" });
    const claims = await userModel.claims("tenant", "u1", { category: "goal" });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ status: "proposed", consent: "pending", source: "inferred" });
    expect(claims[0]!.evidenceRefs).toContain("task-1");
  });

  it("turns task outcomes into signals and auto-observes advice follow-through", async () => {
    const { eventBus, userModel } = await setup();
    const advice = await userModel.recordAdvice({ tenantId: "tenant", userId: "u1", summary: "Split the milestone into three tasks.", taskRef: "task-9" });
    await eventBus.emit("task.completed", "test", { tenantId: "tenant", taskId: "task-9", userId: "u1", status: "succeeded" });
    // activity signal recorded
    const state = await userModel.estimateState("tenant", "u1");
    expect(state.state).not.toBe("unknown");
    // advice followed observed, helpfulness unknown
    const records = await userModel.exportUser("tenant", "u1");
    const observed = records.advice.find((item) => item.id === advice.id)!;
    expect(observed.outcome).toMatchObject({ followed: true, autoObserved: true });
    expect(observed.outcome!.helpful).toBeUndefined();
    // the user's rating still lands on top
    const rated = await userModel.recordAdviceOutcome({ tenantId: "tenant", adviceId: advice.id, followed: true, helpful: true });
    expect(rated.outcome).toMatchObject({ helpful: true });
  });

  it("task failures become error signals for frustration detection", async () => {
    const { eventBus, userModel } = await setup();
    await eventBus.emit("task.failed", "test", { tenantId: "tenant", taskId: "task-f", userId: "u1", status: "failed" });
    const risk = await userModel.frustrationRisk("tenant", "u1");
    expect(risk.signals).toBe(1);
    expect(risk.risk).toBeGreaterThan(0);
  });

  it("maps research and push capability finishes to behavioural signals", async () => {
    const { userModel, capabilityEvent } = await setup({ defaultUserId: "u1" });
    capabilityEvent("research.query");
    capabilityEvent("git.push");
    capabilityEvent("filesystem.read"); // not a mapped capability
    // The broker listener is fire-and-forget by design; give the handlers a tick.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const exportData = await userModel.exportUser("tenant", "u1");
    const kinds = exportData.signals.map((signal) => signal.kind).sort();
    expect(kinds).toEqual(["commit", "research"]);
  });

  it("honours the signals consent switch", async () => {
    const { eventBus, userModel } = await setup();
    await userModel.setFeatureConsent("tenant", "u1", "signals", false);
    await eventBus.emit("task.completed", "test", { tenantId: "tenant", taskId: "task-s", userId: "u1", status: "succeeded" });
    const exportData = await userModel.exportUser("tenant", "u1");
    expect(exportData.signals).toHaveLength(0);
  });

  it("never lets a failing handler break the emitting task", async () => {
    const { eventBus } = await setup();
    // observeClaim on a protected topic throws inside the handler; the emit
    // itself must still resolve.
    await expect(eventBus.emit("task.received", "test", { tenantId: "tenant", goal: "user religion profile", userId: "u2", taskId: "task-p" })).resolves.toBeTruthy();
  });
});

// ─── J2: goal model conflicts and dependencies ───

describe("goal model conflicts and dependencies (P1.45)", () => {
  it("detects declared conflicts, dependency cycles and overcommit", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-user-goals-"));
    const service = new UserModelService(root, () => Date.parse("2026-09-25T12:00:00Z"));
    const a = await service.upsertGoal({ tenantId: "t", userId: "u", horizon: "long", title: "Migrate to platform A" });
    const b = await service.upsertGoal({ tenantId: "t", userId: "u", horizon: "long", title: "Stay on platform B" });
    await service.upsertGoal({ tenantId: "t", userId: "u", horizon: "long", title: "Declared conflict", conflictsWithGoalIds: [a.id, b.id] });
    // dependency cycle: a → c → a
    const c = await service.upsertGoal({ tenantId: "t", userId: "u", horizon: "short", title: "Cycle member", dependsOnGoalIds: [a.id] });
    await service.upsertGoal({ tenantId: "t", userId: "u", goalId: a.id, horizon: "long", title: "Migrate to platform A", dependsOnGoalIds: [c.id] });
    for (let index = 0; index < 9; index++) {
      await service.upsertGoal({ tenantId: "t", userId: "u", horizon: "short", title: `Short ${index}` });
    }
    const conflicts = await service.goalConflicts("t", "u");
    expect(conflicts.filter((conflict) => conflict.kind === "declared").length).toBe(2);
    expect(conflicts.filter((conflict) => conflict.kind === "dependency-cycle").length).toBeGreaterThan(0);
    expect(conflicts.find((conflict) => conflict.kind === "overcommit")).toBeTruthy();
  });

  it("blocks goals on unfinished dependencies and unblocks on achievement", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-user-goals-"));
    const service = new UserModelService(root, () => Date.parse("2026-09-25T12:00:00Z"));
    const foundation = await service.upsertGoal({ tenantId: "t", userId: "u", horizon: "short", title: "Lay the foundation" });
    await service.upsertGoal({ tenantId: "t", userId: "u", horizon: "short", title: "Build the feature", dependsOnGoalIds: [foundation.id] });
    expect((await service.blockedGoals("t", "u"))[0]!.blockedByGoalIds).toEqual([foundation.id]);
    await service.upsertGoal({ tenantId: "t", userId: "u", goalId: foundation.id, horizon: "short", title: "Lay the foundation", status: "achieved" });
    expect(await service.blockedGoals("t", "u")).toHaveLength(0);
  });

  it("rejects self-referencing and missing dependency/conflict refs", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-user-goals-"));
    const service = new UserModelService(root, () => Date.parse("2026-09-25T12:00:00Z"));
    const goal = await service.upsertGoal({ tenantId: "t", userId: "u", horizon: "short", title: "G" });
    await expect(service.upsertGoal({ tenantId: "t", userId: "u", goalId: goal.id, horizon: "short", title: "G", dependsOnGoalIds: [goal.id] })).rejects.toThrow("cannot depend on itself");
    await expect(service.upsertGoal({ tenantId: "t", userId: "u", horizon: "short", title: "X", dependsOnGoalIds: ["ugoal-missing"] })).rejects.toThrow("not found");
  });
});

// ─── J3: project model ───

describe("project model (P1.46)", () => {
  async function projectService() {
    const root = await mkdtemp(join(tmpdir(), "haf-user-projects-"));
    let now = Date.parse("2026-09-25T12:00:00Z");
    const service = new UserModelService(root, () => now);
    return { service, advance: (days: number) => { now += days * 86_400_000; }, now: () => now };
  }

  it("models repo links, deadlines, next actions, failures and architecture notes", async () => {
    const { service } = await projectService();
    const project = await service.upsertProject({
      tenantId: "t", userId: "u", name: "Aurora",
      repoUrl: "https://github.com/example/aurora", workspacePath: "/workspace/aurora",
      deadline: new Date(Date.parse("2026-09-20T00:00:00Z")).toISOString(),
      architectureNotes: "Monorepo: engine + eval + CLI.", expertise: ["typescript", "agents"],
      activeTasks: 4,
    });
    const withAction = await service.upsertProject({ tenantId: "t", userId: "u", projectId: project.id, name: "Aurora", addNextAction: "Wire the research watcher" });
    await service.upsertProject({ tenantId: "t", userId: "u", projectId: project.id, name: "Aurora", recordFailure: "Integration suite flaked on browser tests." });

    const overview = await service.projectOverview("t", "u", project.id);
    expect(overview.project.repoUrl).toBe("https://github.com/example/aurora");
    expect(overview.overdue).toBe(true); // deadline already passed
    expect(overview.pendingNextActions.map((action) => action.title)).toEqual(["Wire the research watcher"]);
    expect(overview.failuresLast7Days).toBe(1);
    expect(withAction.architectureNotes).toContain("Monorepo");

    await service.upsertProject({ tenantId: "t", userId: "u", projectId: project.id, name: "Aurora", completeNextActionId: withAction.nextActions[0]!.id });
    expect((await service.projectOverview("t", "u", project.id)).pendingNextActions).toHaveLength(0);
  });

  it("validates repository URLs and rejects missing projects", async () => {
    const { service } = await projectService();
    await expect(service.upsertProject({ tenantId: "t", userId: "u", name: "X", repoUrl: "ftp://example.com/x" })).rejects.toThrow("https:// URL or git@");
    await expect(service.projectOverview("t", "u", "uproject-missing")).rejects.toThrow("not found");
  });

  it("surfaces projects in the user model summary", async () => {
    const { service } = await projectService();
    await service.upsertProject({ tenantId: "t", userId: "u", name: "Aurora", deadline: new Date(Date.parse("2026-10-01T00:00:00Z")).toISOString() });
    const summary = await service.summary("t", "u");
    expect(summary.projects).toHaveLength(1);
    expect(summary.projects[0]).toMatchObject({ name: "Aurora", activeTasks: 0 });
  });
});

// ─── J4: advice effectiveness ───

describe("advice policy (P1.47)", () => {
  async function withAdvice(outcomes: Array<{ followed: boolean; helpful: boolean }>) {
    const root = await mkdtemp(join(tmpdir(), "haf-user-advice-"));
    const service = new UserModelService(root, () => Date.parse("2026-09-25T12:00:00Z"));
    for (const outcome of outcomes) {
      const advice = await service.recordAdvice({ tenantId: "t", userId: "u", summary: "Try decomposing the task." });
      await service.recordAdviceOutcome({ tenantId: "t", adviceId: advice.id, followed: outcome.followed, helpful: outcome.helpful });
    }
    return service;
  }

  it("stays honest with insufficient evidence", async () => {
    const service = await withAdvice([{ followed: true, helpful: false }]);
    const policy = await service.advicePolicy("t", "u");
    expect(policy.mode).toBe("insufficient-evidence");
    expect(policy.basis).toContain("1 user-rated");
  });

  it("adapts downward when advice is not working", async () => {
    const service = await withAdvice([
      { followed: false, helpful: false },
      { followed: true, helpful: false },
      { followed: false, helpful: false },
    ]);
    const policy = await service.advicePolicy("t", "u");
    expect(policy.mode).toBe("advise-less");
    expect(policy.suggestedMinIntervalHours).toBe(72);
  });

  it("adapts upward when advice lands", async () => {
    const service = await withAdvice([
      { followed: true, helpful: true },
      { followed: true, helpful: true },
      { followed: true, helpful: true },
    ]);
    const policy = await service.advicePolicy("t", "u");
    expect(policy.mode).toBe("advise-more");
    expect(policy.suggestedMinIntervalHours).toBe(6);
  });

  it("user ratings outrank auto-observations and are counted separately", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-user-advice-"));
    const service = new UserModelService(root, () => Date.parse("2026-09-25T12:00:00Z"));
    const advice = await service.recordAdvice({ tenantId: "t", userId: "u", summary: "A", taskRef: "task-1" });
    await service.observeAdviceFollowedByTask("t", "u", "task-1");
    await service.recordAdviceOutcome({ tenantId: "t", adviceId: advice.id, followed: true, helpful: true });
    await expect(service.recordAdviceOutcome({ tenantId: "t", adviceId: advice.id, followed: true, helpful: false })).rejects.toThrow("already recorded");
    const policy = await service.advicePolicy("t", "u");
    expect(policy.ratedOutcomes).toBe(1);
    expect(policy.mode).toBe("insufficient-evidence"); // one rating is not enough to adapt
  });
});

// ─── J5: privacy controls, retention, export ───

describe("user controls: privacy, retention, export (P1.48)", () => {
  it("defaults to inference-off and lets the user flip features", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-user-privacy-"));
    const service = new UserModelService(root, () => Date.parse("2026-09-25T12:00:00Z"));
    const initial = await service.featureConsents("t", "u");
    expect(initial.features).toEqual({
      inference: false, signals: true, "advice-tracking": true, "research-memory": true, "state-estimation": true,
    });
    await service.setFeatureConsent("t", "u", "inference", true);
    await service.setFeatureConsent("t", "u", "signals", false);
    const updated = await service.featureConsents("t", "u");
    expect(updated.features["inference"]).toBe(true);
    expect(updated.features["signals"]).toBe(false);
  });

  it("enforces retention on inferred data while keeping user-stated claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-user-retention-"));
    let now = Date.parse("2026-09-25T12:00:00Z");
    const service = new UserModelService(root, () => now);
    await service.observeClaim({ tenantId: "t", userId: "u", category: "habit", key: "style", value: "Deep focus blocks.", confidence: 0.6, source: "inferred" });
    await service.observeClaim({ tenantId: "t", userId: "u", category: "communication", key: "style", value: "Short and technical.", confidence: 0.9, source: "user-stated" });
    await service.recordSignal({ tenantId: "t", userId: "u", kind: "activity", intensity: 0.5 });
    await service.setRetention("t", "u", 30);
    now += 40 * 86_400_000;
    const result = await service.applyRetention("t", "u");
    expect(result.retentionDays).toBe(30);
    expect(result.removed.claims).toBe(1); // the inferred one
    expect(result.keptUserStatedClaims).toBe(1);
    expect(result.removed.signals).toBe(1);
  });

  it("does nothing until a retention period is set", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-user-retention-"));
    const service = new UserModelService(root, () => Date.parse("2026-09-25T12:00:00Z"));
    await service.recordSignal({ tenantId: "t", userId: "u", kind: "activity", intensity: 0.5 });
    const result = await service.applyRetention("t", "u");
    expect(result.retentionDays).toBeNull();
    expect(result.removed.signals).toBe(0);
  });

  it("exports everything held about the user, including privacy settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-user-export-"));
    const service = new UserModelService(root, () => Date.parse("2026-09-25T12:00:00Z"));
    await service.observeClaim({ tenantId: "t", userId: "u", category: "goal", key: "current-focus", value: "Ship it.", confidence: 0.8, source: "user-stated" });
    await service.upsertGoal({ tenantId: "t", userId: "u", horizon: "short", title: "G" });
    await service.upsertProject({ tenantId: "t", userId: "u", name: "P" });
    await service.recordAdvice({ tenantId: "t", userId: "u", summary: "A" });
    await service.addMilestone({ tenantId: "t", userId: "u", kind: "start", title: "M", summary: "S" });
    await service.setFeatureConsent("t", "u", "inference", true);
    const exported = await service.exportUser("t", "u");
    expect(exported.claims).toHaveLength(1);
    expect(exported.goals).toHaveLength(1);
    expect(exported.projects).toHaveLength(1);
    expect(exported.advice).toHaveLength(1);
    expect(exported.milestones).toHaveLength(1);
    expect(exported.privacy.features["inference"]).toBe(true);
    // Tenant isolation: another tenant sees nothing.
    expect((await service.exportUser("other", "u")).claims).toHaveLength(0);
  });

  it("forgets projects along with the rest of the user model", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-user-forget-"));
    const service = new UserModelService(root, () => Date.parse("2026-09-25T12:00:00Z"));
    await service.upsertProject({ tenantId: "t", userId: "u", name: "P" });
    const removed = await service.forgetUser("t", "u");
    expect(removed.removedProjects).toBe(1);
    expect(await service.projects("t", "u")).toHaveLength(0);
  });
});
