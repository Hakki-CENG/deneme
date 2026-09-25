import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/aurora/event-bus.js";
import { HybridAgentEngine } from "../src/engine.js";
import { randomUUID } from "node:crypto";
import type { CapabilityLifecycleEvent } from "../src/capabilities/capability-broker.js";
import { ProactiveIntakeBus } from "../src/initiative/proactive-intake-bus.js";
import {
  ProactiveInitiativeService,
  type InitiativeProviders,
} from "../src/initiative/proactive-initiative-service.js";

async function service(
  providers: InitiativeProviders = {},
  now: () => number = () => Date.parse("2026-09-25T12:00:00Z"),
): Promise<ProactiveInitiativeService> {
  const root = await mkdtemp(join(tmpdir(), "haf-proactive-"));
  return new ProactiveInitiativeService(root, now, {}, providers);
}

async function highWorthinessInitiative(target: ProactiveInitiativeService, overrides: Record<string, unknown> = {}) {
  return await target.propose({
    tenantId: "t",
    kind: "risk",
    title: `Repository backup missing ${Math.random().toString(36).slice(2, 8)}`,
    message: "The main repository has no backup and a disk failure would lose everything.",
    importance: 1,
    urgency: 1,
    impact: 1,
    confidence: 0.95,
    userRelevance: 1,
    mode: "guardian",
    ...overrides,
  });
}

// ─── K2: initiative engine — context fit + real goal alignment ───

describe("initiative engine (P1.50)", () => {
  it("scores goal alignment through the provider against real active goals", async () => {
    let scoredText = "";
    const target = await service({
      goalAlignment: async (_tenantId, text) => {
        scoredText = text;
        return 0.9;
      },
    });
    const initiative = await target.propose({
      tenantId: "t", kind: "opportunity", title: "Aurora memory milestone", message: "Split the memory milestone into tasks.",
      importance: 0.8, urgency: 0.6, impact: 0.8, confidence: 0.8, userRelevance: 0.4,
    });
    expect(scoredText).toContain("Aurora memory milestone");
    expect(initiative.goalAlignment).toBe(0.9); // provider score, not the 0.4 relevance fallback
    // With no provider the alignment stays the relevance-implied default — never invented.
    const plain = await (await service()).propose({
      tenantId: "t", kind: "opportunity", title: "Unrelated thing xyz", message: "Something else entirely.",
      importance: 0.8, urgency: 0.6, impact: 0.8, confidence: 0.8, userRelevance: 0.4,
    });
    expect(plain.goalAlignment).toBe(0.4);
  });

  it("defers P1 messages while the user is estimated busy, but never a guardian risk", async () => {
    const busyService = await service({
      contextState: async () => ({ state: "busy", confidence: 0.8 }),
    });
    // P1-grade (not P0-grade) assistant message gets deferred to the digest.
    const p1 = await busyService.propose({
      tenantId: "t", kind: "insight", title: `New library released ${Math.random().toString(36).slice(2, 8)}`,
      message: "A relevant library was released today.",
      importance: 0.9, urgency: 0.7, impact: 0.8, confidence: 0.9, userRelevance: 0.9, mode: "assistant",
    });
    const evaluation = await busyService.evaluate("t");
    expect(evaluation.digested).toContain(p1.id);
    const stored = (await busyService.initiatives("t")).find((item) => item.id === p1.id)!;
    expect(stored.suppressionReason).toBe("context-fit-busy");
    expect(stored.decision?.contextFit).toMatchObject({ state: "busy", applied: true });
    expect(stored.decision?.reason).toContain("busy");
    // A guardian risk still goes through — urgency beats politeness.
    const risk = await highWorthinessInitiative(busyService);
    const second = await busyService.evaluate("t");
    expect(second.queued.map((item) => item.id)).toContain(risk.id);
  });

  it("demotes nothing without a state estimate (a miss is not 'idle')", async () => {
    const target = await service({ contextState: async () => undefined });
    const p1 = await target.propose({
      tenantId: "t", kind: "insight", title: `Grant window ${Math.random().toString(36).slice(2, 8)}`,
      message: "Applications close soon.", importance: 0.9, urgency: 0.7, impact: 0.8, confidence: 0.9, userRelevance: 0.9,
    });
    const evaluation = await target.evaluate("t");
    expect(evaluation.queued.map((item) => item.id)).toContain(p1.id); // P1 survives without evidence
    expect(evaluation.digested).not.toContain(p1.id);
  });

  it("explains every verdict with the arithmetic that produced it (P1.54)", async () => {
    const target = await service();
    const queued = await highWorthinessInitiative(target);
    const low = await target.propose({
      tenantId: "t", kind: "insight", title: `Tangential blog post ${Math.random().toString(36).slice(2, 8)}`,
      message: "A tangentially related blog post appeared.", importance: 0.2, urgency: 0.1, impact: 0.1, confidence: 0.5, userRelevance: 0.2,
    });
    await target.evaluate("t");
    const queuedStored = (await target.initiatives("t")).find((item) => item.id === queued.id)!;
    const lowStored = (await target.initiatives("t")).find((item) => item.id === low.id)!;
    expect(queuedStored.decision?.reason).toContain("queued for delivery");
    expect(queuedStored.decision?.thresholds).toMatchObject({ p0: 0.35, p1: 0.15, p2: 0.05 });
    expect(lowStored.decision?.reason).toMatch(/silence|digest territory/);
    expect(typeof lowStored.decision?.effectiveScore).toBe("number");
  });
});

// ─── K6: user override — kind mute ───

describe("initiative mutes (P1.54)", () => {
  it("mutes a kind until a deadline and lets it lapse automatically", async () => {
    let now = Date.parse("2026-09-25T12:00:00Z");
    const target = await service({}, () => now);
    await target.muteKind("t", "insight", new Date(now + 86_400_000).toISOString(), "too noisy");
    expect((await target.mutes("t"))[0]).toMatchObject({ kind: "insight" });

    const muted = await target.propose({
      tenantId: "t", kind: "insight", title: `Muted insight ${Math.random().toString(36).slice(2, 8)}`,
      message: "Would normally queue.", importance: 0.9, urgency: 0.8, impact: 0.8, confidence: 0.9, userRelevance: 0.9,
    });
    const evaluation = await target.evaluate("t");
    expect(evaluation.digested).toContain(muted.id);
    const stored = (await target.initiatives("t")).find((item) => item.id === muted.id)!;
    expect(stored.suppressionReason).toBe("kind-muted");
    expect(stored.decision?.muted).toBe(true);

    // After the deadline the same kind flows again.
    now += 2 * 86_400_000;
    const fresh = await target.propose({
      tenantId: "t", kind: "insight", title: `Fresh insight ${Math.random().toString(36).slice(2, 8)}`,
      message: "Now audible again.", importance: 0.9, urgency: 0.8, impact: 0.8, confidence: 0.9, userRelevance: 0.9,
    });
    const later = await target.evaluate("t");
    expect(later.queued.map((item) => item.id)).toContain(fresh.id);
    expect(await target.mutes("t")).toHaveLength(0);
  });

  it("rejects mute deadlines in the past", async () => {
    const target = await service();
    await expect(target.muteKind("t", "insight", "2000-01-01T00:00:00.000Z")).rejects.toThrow("future");
  });
});

// ─── K4: communication selector + delivery ───

describe("communication selector (P1.52)", () => {
  async function queuedInitiative(providers: InitiativeProviders) {
    const target = await service(providers);
    const initiative = await highWorthinessInitiative(target);
    await target.evaluate("t");
    return { target, initiative };
  }

  it("prefers the highest available channel and falls back to in-app with a reason", async () => {
    const { target, initiative } = await queuedInitiative({ availableChannels: () => ["telegram", "email"] });
    await target.setChannelPreferences("t", { orderedChannels: ["discord", "telegram", "in-app"], destination: "@user" });
    const selected = await target.selectChannel("t", initiative.id);
    expect(selected.channel).toBe("telegram"); // discord preferred but not configured
    expect(selected.reason).toContain("telegram");
    expect(selected.alternatives).toContain("in-app");

    const noneConfigured = await queuedInitiative({ availableChannels: () => [] });
    await noneConfigured.target.setChannelPreferences("t", { orderedChannels: ["telegram"] });
    const fallback = await noneConfigured.target.selectChannel("t", noneConfigured.initiative.id);
    expect(fallback.channel).toBe("in-app");
    expect(fallback.reason).toContain("falling back to in-app");
  });

  it("delivers over a real channel through the sender and records the delivery", async () => {
    const sent: Array<{ channel: string; text: string; destination?: string }> = [];
    const { target, initiative } = await queuedInitiative({
      availableChannels: () => ["telegram"],
      sendChannel: async (channel, item, destination) => {
        sent.push({ channel, text: item.title, destination });
      },
    });
    await target.setChannelPreferences("t", { orderedChannels: ["telegram"], destination: "@aurora-user" });
    const delivered = await target.deliver("t", initiative.id);
    expect(delivered.state).toBe("delivered");
    expect(delivered.deliveredChannel).toBe("telegram");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.destination).toBe("@aurora-user");
    expect(sent[0]!.text).toContain("Repository backup missing");
  });

  it("delivers in-app without a sender; other channels require one", async () => {
    const { target, initiative } = await queuedInitiative({ availableChannels: () => [] });
    const delivered = await target.deliver("t", initiative.id); // in-app: no sender needed
    expect(delivered.deliveredChannel).toBe("in-app");

    const { target: withChannel, initiative: other } = await queuedInitiative({
      availableChannels: () => ["telegram"],
    });
    await withChannel.setChannelPreferences("t", { orderedChannels: ["telegram"] });
    await expect(withChannel.deliver("t", other.id)).rejects.toThrow("delivery sender");
  });

  it("only queued initiatives can be routed or delivered", async () => {
    const target = await service();
    const initiative = await highWorthinessInitiative(target); // still a candidate
    await expect(target.selectChannel("t", initiative.id)).rejects.toThrow("queued");
    await expect(target.deliver("t", initiative.id)).rejects.toThrow("queued");
  });
});

// ─── K5: briefings with live sections ───

describe("briefings (P1.53)", () => {
  it("adds live project-risk, goal and memory sections when providers answer", async () => {
    const target = await service({
      digestSections: [
        { heading: "Project risks", items: async () => ["Overdue: Aurora (deadline 2026-09-20)"] },
        { heading: "Goal changes", items: async () => ["Stalled (no progress in 14+ days): Ship the API"] },
        { heading: "Memory changes", items: async () => [] }, // empty provider → no section
      ],
    });
    await highWorthinessInitiative(target);
    await target.evaluate("t");
    const digest = await target.buildDigest("t", "daily");
    const headings = digest.sections.map((section) => section.heading);
    expect(headings).toContain("Risks"); // from the initiative itself
    expect(headings).toContain("Project risks");
    expect(headings).toContain("Goal changes");
    expect(headings).not.toContain("Memory changes"); // honestly absent
    expect(digest.sections.find((section) => section.heading === "Project risks")!.items[0]).toContain("Overdue");
  });

  it("a failing provider never breaks the briefing", async () => {
    const target = await service({
      digestSections: [{ heading: "Broken", items: async () => { throw new Error("provider down"); } }],
    });
    const digest = await target.buildDigest("t", "daily");
    expect(digest.sections.map((section) => section.heading)).not.toContain("Broken");
  });
});

// ─── K3: durable proactive cycle ───

describe("durable proactive cycle (P1.51)", () => {
  it("runs watchers, evaluates and builds each period digest exactly once", async () => {
    let now = Date.parse("2026-09-25T12:00:00Z");
    const target = await service({}, () => now);
    await target.ingest({ tenantId: "t", source: "research", summary: "New paper on agent memory architectures published.", tags: ["research"] });
    await target.registerWatcher({ tenantId: "t", kind: "research", name: "Agent memory research", target: "agent memory", keywords: ["memory"], intervalMinutes: 60 });

    const first = await target.runProactiveCycle("t");
    expect(first.watchers.scanned).toBe(1);
    expect(first.digestsBuilt.map((digest) => digest.period).sort()).toEqual(["daily", "monthly", "weekly"]);
    expect((await target.digests("t"))).toHaveLength(3);

    // Same period: the cycle does not build duplicates.
    now += 60_000;
    const second = await target.runProactiveCycle("t");
    expect(second.digestsBuilt).toHaveLength(0);
    // The intake event was consumed by the first watcher run; nothing new scanned.
    expect(second.watchers.scanned).toBe(0);

    // Next day: exactly one new digest (daily), and the watcher is due again
    // but the pending queue is empty, so no new match.
    now += 86_400_000;
    const third = await target.runProactiveCycle("t");
    expect(third.digestsBuilt.map((digest) => digest.period)).toEqual(["daily"]);
    expect((await target.digests("t"))).toHaveLength(4);
  });

  it("lists every tenant that has proactive state", async () => {
    const target = await service();
    await target.ingest({ tenantId: "a", source: "memory", summary: "Memory event." });
    await target.propose({ tenantId: "b", kind: "insight", title: "Only a proposal", message: "Nothing else.", importance: 0.5, urgency: 0.5, impact: 0.5, confidence: 0.5, userRelevance: 0.5 });
    await target.registerWatcher({ tenantId: "c", kind: "risk", name: "Certificates", target: "tls" });
    expect(await target.tenants()).toEqual(["a", "b", "c"]);
  });
});

// ─── K1: event intake bus ───

describe("event intake bus (P1.49)", () => {
  async function busSetup() {
    const initiativeService = await service();
    const eventBus = new EventBus(50);
    const listeners: Array<(event: CapabilityLifecycleEvent) => void> = [];
    const broker = {
      subscribe(listener: (event: CapabilityLifecycleEvent) => void) {
        listeners.push(listener);
        return () => { listeners.splice(listeners.indexOf(listener), 1); };
      },
    };
    const bus = new ProactiveIntakeBus(eventBus, initiativeService, broker);
    bus.init();
    const capabilityEvent = (capabilityId: string, tenantId = "t"): void => {
      for (const listener of listeners) {
        listener({
          phase: "finished",
          descriptor: { id: capabilityId, version: "1.0.0", description: "", risk: "pure", sideEffect: false, source: "core" },
          context: { tenantId, sessionId: "s", familyId: "f", turnId: "t", toolCallId: "c", source: "api", workspacePath: "/tmp", idempotencyKey: "k" },
          status: "ok",
          durationMs: 3,
        });
      }
    };
    return { initiativeService, eventBus, bus, capabilityEvent };
  }

  it("turns task outcomes into typed intake events", async () => {
    const { initiativeService, eventBus } = await busSetup();
    await eventBus.emit("task.completed", "test", { tenantId: "t", taskId: "task-1", goal: "Ship the research layer" });
    await eventBus.emit("task.failed", "test", { tenantId: "t", taskId: "task-2" });
    const events = await initiativeService.intakeEvents("t");
    const sources = events.map((event) => event.source);
    expect(sources).toContain("tasks");
    expect(events.find((event) => event.summary.includes("Ship the research layer"))).toBeTruthy();
    expect(events.find((event) => event.summary.includes("Task failed"))).toBeTruthy();
  });

  it("maps capability finishes to their real sources and ignores the rest", async () => {
    const { initiativeService, capabilityEvent } = await busSetup();
    capabilityEvent("git.push");
    capabilityEvent("filesystem.write");
    capabilityEvent("research.query");
    capabilityEvent("environment.probe");
    capabilityEvent("filesystem.read"); // not mapped
    await new Promise((resolve) => setTimeout(resolve, 20));
    const events = await initiativeService.intakeEvents("t");
    const sources = [...new Set(events.map((event) => event.source))].sort();
    expect(sources).toEqual(["filesystem", "git", "research", "system"]);
  });

  it("records inbound notifications and recent schedule fires", async () => {
    const { initiativeService, bus } = await busSetup();
    await bus.recordNotification({ tenantId: "t", platform: "telegram", text: "Is the deploy done?", userId: "u1" });
    let firedAt = "2026-09-25T11:55:00.000Z";
    const scheduleBus = new ProactiveIntakeBus(new EventBus(10), initiativeService, undefined, {
      recentSchedules: async () => [{ id: "job-1", tenantId: "t", label: "Nightly backup", lastRunAt: firedAt }],
    });
    await scheduleBus.ingestRecentSchedules();
    await scheduleBus.ingestRecentSchedules(); // same fire → not re-ingested
    firedAt = "2026-09-25T12:55:00.000Z";
    await scheduleBus.ingestRecentSchedules(); // new fire → ingested
    const events = await initiativeService.intakeEvents("t");
    const notifications = events.filter((event) => event.source === "notification");
    const schedules = events.filter((event) => event.source === "schedules");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.summary).toContain("telegram");
    expect(schedules).toHaveLength(2);
    expect(schedules.map((event) => event.occurredAt).sort()).toEqual(["2026-09-25T11:55:00.000Z", "2026-09-25T12:55:00.000Z"]);
  });

  it("feeds a watcher end to end: intake event → watcher match → initiative", async () => {
    const { initiativeService, eventBus } = await busSetup();
    await initiativeService.registerWatcher({ tenantId: "t", kind: "risk", name: "Deploy risk", target: "deploy", keywords: ["deploy"], intervalMinutes: 60 });
    await eventBus.emit("task.completed", "test", { tenantId: "t", taskId: "task-3", goal: "Deploy the staging build" });
    const { matched, scanned } = await initiativeService.runWatchers("t");
    expect(scanned).toBe(1);
    expect(matched).toHaveLength(1);
    const candidates = await initiativeService.initiatives("t", { state: "candidate" });
    expect(candidates[0]!.intakeEventIds).toHaveLength(1);
  });
});

// ─── Engine wiring: the proactive surface is real, not just the service ───

describe("proactive wiring in the engine (P1.49–P1.54)", () => {
  async function newEngine() {
    const homePath = await mkdtemp(join(tmpdir(), "haf-proactive-engine-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: "",
      sandboxBackend: "local",
      model: { provider: "mock" },
      autoApproveWorkspaceWrites: true,
      allowProcessExecution: true,
      userModelIntegration: { defaultUserId: "proactive-user" },
    } as never);
    const session = await engine.createSession({ tenantId: "p-tenant", name: "proactive" });
    const snapshot = await engine.session(session.sessionId);
    const context = (suffix: string) => ({
      tenantId: "p-tenant",
      sessionId: session.sessionId,
      familyId: session.sessionId,
      turnId: `turn-${suffix}`,
      toolCallId: `call-${suffix}`,
      source: "api" as const,
      workspacePath: snapshot.workspacePath,
      idempotencyKey: `p-${suffix}-${randomUUID()}`,
    });
    return { engine, context, sessionId: session.sessionId };
  }

  async function approveCall(engine: HybridAgentEngine, sessionId: string, match: string): Promise<void> {
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const pending = await engine.approvals.list(sessionId);
      const request = pending.find((item) => JSON.stringify(item).includes(match));
      if (request) {
        await engine.approvals.resolve(request.id, "approve_session");
        return;
      }
    }
    throw new Error(`No pending approval matched ${match}`);
  }

  it("registers the new proactive capabilities on the broker", async () => {
    const { engine } = await newEngine();
    const listed = engine.capabilities.list().map((capability) => capability.id);
    for (const id of [
      "initiative.channel.preferences", "initiative.channel.select", "initiative.deliver",
      "initiative.mute", "initiative.mutes.list", "initiative.cycle.run",
    ]) {
      expect(listed, `missing capability ${id}`).toContain(id);
    }
  });

  it("runs a full proactive cycle for every tenant through the engine", async () => {
    const { engine, context } = await newEngine();
    // Seed one intake event through the broker so the tenant has state.
    await engine.capabilities.execute("initiative.intake", { source: "research", summary: "New agent memory paper published." }, context("seed"));
    const summaries = await engine.runProactiveCycleForAllTenants();
    const own = summaries.find((summary) => summary.tenantId === "p-tenant");
    expect(own).toBeTruthy();
    expect(own!.digestsBuilt).toBe(3); // first cycle: daily + weekly + monthly
    // The context provider is wired through the user model (estimateState).
    const estimate = await engine.userModel.estimateState("p-tenant", "proactive-user");
    expect(estimate.isEstimate).toBe(true);
  });

  it("wires the goal-alignment provider to the real user model", async () => {
    const { engine, context } = await newEngine();
    await engine.capabilities.execute("user.goal.upsert", { userId: "proactive-user", horizon: "long", title: "Ship Aurora memory layer", importance: 0.9 }, context("goal"));
    const initiative = await engine.capabilities.execute("initiative.propose", {
      kind: "opportunity", title: `Aurora memory milestone ${Math.random().toString(36).slice(2, 8)}`,
      message: "Split the Aurora memory layer work into three deliverable tasks.",
      importance: 0.9, urgency: 0.5, impact: 0.7, confidence: 0.8, userRelevance: 0.5,
    }, context("propose"));
    expect(initiative.goalAlignment).toBeGreaterThan(0.5); // scored against the real goal, not the 0.5 relevance
  });

  it("honours a kind mute end to end through the broker", async () => {
    const { engine, context, sessionId } = await newEngine();
    const muteExecution = engine.capabilities.execute("initiative.mute", { kind: "insight", until: new Date(Date.now() + 3_600_000).toISOString(), reason: "too noisy today" }, context("mute"));
    await approveCall(engine, sessionId, "initiative.mute"); // privileged: human approval gate
    await muteExecution;
    const mutes = await engine.capabilities.execute("initiative.mutes.list", {}, context("mutes"));
    expect(mutes.mutes[0]).toMatchObject({ kind: "insight" });
    const proposal = await engine.capabilities.execute("initiative.propose", {
      kind: "insight", title: `Muted insight ${Math.random().toString(36).slice(2, 8)}`,
      message: "Would normally reach the user.", importance: 0.9, urgency: 0.8, impact: 0.8, confidence: 0.9, userRelevance: 0.9,
    }, context("propose-muted"));
    const evaluateExecution = engine.capabilities.execute("initiative.evaluate", {}, context("evaluate"));
    await approveCall(engine, sessionId, "initiative.evaluate"); // privileged: human approval gate
    const evaluation = await evaluateExecution;
    expect(evaluation.digested).toContain(proposal.id);
    const stored = (await engine.capabilities.execute("initiative.list", { state: "digested" }, context("list")) as { initiatives: Array<{ id: string; suppressionReason?: string; decision?: { muted?: boolean } }> }).initiatives
      .find((item) => item.id === proposal.id)!;
    expect(stored.suppressionReason).toBe("kind-muted");
    expect(stored.decision?.muted).toBe(true);
  });
});
