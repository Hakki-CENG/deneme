/**
 * Thought Loop Architecture — BackgroundThinkingService.
 *
 * Written alongside the first tests for ThoughtCoreService; this service had
 * 309 lines and zero coverage while being constructed in `engine.ts` and
 * started/stopped with the engine lifecycle.
 *
 * Several assertions here pin *honesty* rather than arithmetic. The service used
 * to report a `lastRunAt` stamped with `new Date()` on every `getStatus()` call
 * even when it had never run, claim `stopped: true` for thread ids that were
 * never started, and report the configured iteration count when the duration
 * budget had truncated the loop. Those are fabricated-success defects of exactly
 * the kind `execution-status.ts` exists to prevent, so they are tested directly.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { BackgroundThinkingService } from "../src/thought/background-thinking-service.js";
import { ThoughtCoreService } from "../src/thought/thought-core-service.js";

const TENANT = "local";
const OTHER = "other-tenant";

let root: string;
let core: ThoughtCoreService;
let service: BackgroundThinkingService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "background-thinking-"));
  core = new ThoughtCoreService(root);
  await core.initialize();
  service = new BackgroundThinkingService(root, core);
});

function thought(title: string, tags: string[], overrides: Record<string, unknown> = {}) {
  return core.createThought({
    tenantId: TENANT,
    title,
    content: `Content for ${title}`,
    type: "insight",
    sourceType: "agent",
    tags,
    ...overrides,
  } as never);
}

describe("memory scanning for connections", () => {
  it("connects thoughts that share at least two tags at or above the similarity floor", async () => {
    const a = await thought("retrieval recall", ["retrieval", "recall", "eval"]);
    const b = await thought("recall margin", ["retrieval", "recall", "gate"]);

    const scan = await service.scanMemoryForConnections(TENANT);

    expect(scan.thoughtsScanned).toBe(2);
    expect(scan.connectionsFound).toHaveLength(1);
    const [connection] = scan.connectionsFound;
    // 2 common of 4 distinct tags.
    expect(connection?.similarity).toBeCloseTo(0.5, 6);
    expect(connection?.commonTags.sort()).toEqual(["recall", "retrieval"]);
    expect([connection?.thoughtId1, connection?.thoughtId2].sort()).toEqual([a.id, b.id].sort());
  });

  it("does not connect thoughts sharing only one tag, however similar they look", async () => {
    await thought("one", ["retrieval", "alpha"]);
    await thought("two", ["retrieval", "beta"]);

    const scan = await service.scanMemoryForConnections(TENANT);
    expect(scan.connectionsFound).toEqual([]);
  });

  it("respects the similarity floor", async () => {
    await thought("sparse a", ["x", "y", "p", "q", "r"]);
    await thought("sparse b", ["x", "y", "s", "t", "u"]);

    // 2 common of 8 distinct = 0.25, above nothing by default.
    expect((await service.scanMemoryForConnections(TENANT)).connectionsFound).toEqual([]);
    expect(
      (await service.scanMemoryForConnections(TENANT, { minSimilarity: 0.2 })).connectionsFound,
    ).toHaveLength(1);
  });

  it("skips pairs that are already linked", async () => {
    const b = await thought("linked b", ["shared", "tags"]);
    // A already references B, so the only candidate pair is not new information.
    const a = await thought("linked a", ["shared", "tags"], { relatedThoughtIds: [b.id] });

    const scan = await service.scanMemoryForConnections(TENANT);
    expect(scan.thoughtsScanned).toBe(2);
    expect(scan.connectionsFound).toEqual([]);

    // And the direction does not matter: the reverse link is skipped too.
    const bFirst = await mkdtemp(join(tmpdir(), "background-thinking-reverse-"));
    const reverseCore = new ThoughtCoreService(bFirst);
    await reverseCore.initialize();
    const reverseService = new BackgroundThinkingService(bFirst, reverseCore);
    const a2 = await reverseCore.createThought({
      tenantId: TENANT,
      title: "reverse a",
      content: "reverse a",
      type: "insight",
      sourceType: "agent",
      tags: ["shared", "tags"],
    });
    await reverseCore.createThought({
      tenantId: TENANT,
      title: "reverse b",
      content: "reverse b",
      type: "insight",
      sourceType: "agent",
      tags: ["shared", "tags"],
      relatedThoughtIds: [a2.id],
    });
    expect((await reverseService.scanMemoryForConnections(TENANT)).connectionsFound).toEqual([]);
    expect(a.id).toBeTruthy();
  });

  it("scans only the requesting tenant", async () => {
    await thought("mine", ["shared", "tags"]);
    await core.createThought({
      tenantId: OTHER,
      title: "theirs",
      content: "theirs",
      type: "insight",
      sourceType: "agent",
      tags: ["shared", "tags"],
    });

    const scan = await service.scanMemoryForConnections(TENANT);
    expect(scan.thoughtsScanned).toBe(1);
    expect(scan.connectionsFound).toEqual([]);
  });
});

describe("research opportunities", () => {
  it("proposes investigation for high-importance, low-confidence thoughts", async () => {
    await thought("confident enough", ["a"], { importance: 0.9, confidence: 0.9 });
    await thought("needs work", ["b"], { importance: 0.9, confidence: 0.2 });
    // Below the importance floor, so it must not be proposed.
    await thought("not important", ["c"], { importance: 0.3, confidence: 0.1 });

    const found = await service.findResearchOpportunities(TENANT);
    const titles = found.opportunities.map((o) => o.title);
    expect(titles).toContain("Investigate: needs work");
    expect(titles).not.toContain("Investigate: confident enough");
    expect(titles).not.toContain("Investigate: not important");
  });

  it("does not propose work for a thought already being researched", async () => {
    const researching = await thought("already on it", ["d"], { importance: 0.9, confidence: 0.1 });
    await core.startResearching(TENANT, researching.id);

    const found = await service.findResearchOpportunities(TENANT);
    expect(found.opportunities.map((o) => o.title)).not.toContain("Investigate: already on it");
  });

  it("proposes review for open problems that were never reviewed", async () => {
    await core.createOpenProblem({
      tenantId: TENANT,
      title: "recall margin",
      description: "Hybrid beats bm25 by less than the margin.",
      category: "retrieval",
    });

    const found = await service.findResearchOpportunities(TENANT);
    const review = found.opportunities.find((o) => o.title === "Review: recall margin");
    expect(review).toBeDefined();
    expect(review?.reason).toContain("never");
    expect(found.scanned).toBeGreaterThan(0);
  });
});

describe("run cycle accounting", () => {
  it("runs on its default arguments", async () => {
    // Regression: the per-iteration budget was `maxDurationMs / maxIterations`,
    // i.e. 10000 / 3 = 3333.333…, and ThoughtCoreService validates that value
    // with auroraInteger(_, 100, 60000). Both `runCycle()` and
    // `startBackgroundThread()` therefore threw "Max duration is invalid." on
    // their default arguments, every time, and nothing caught it.
    const cycle = await service.runCycle(TENANT);
    expect(cycle.iteration).toBeGreaterThan(0);

    const started = await service.startBackgroundThread(TENANT);
    expect(started.threadId).toMatch(/^bg-thread-\d+$/);
  });

  it("clamps an absurd iteration count instead of dividing by zero", async () => {
    const cycle = await service.runCycle(TENANT, { maxIterations: 0, maxDurationMs: 60_000 });
    expect(cycle.iteration).toBeGreaterThanOrEqual(0);
  });

  it("reports the iterations that actually ran, not the configured maximum", async () => {
    // A duration budget already exhausted on entry must produce zero passes,
    // not `maxIterations`.
    const truncated = await service.runCycle(TENANT, { maxIterations: 5, maxDurationMs: -1 });
    expect(truncated.iteration).toBe(0);

    const full = await service.runCycle(TENANT, { maxIterations: 2, maxDurationMs: 60_000 });
    expect(full.iteration).toBe(2);
    expect(full.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(full.nextRunInMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(full.nextRunInMs).toBeLessThan(15 * 60 * 1000);
  });

  it("aggregates work across iterations", async () => {
    await thought("process me", ["x"]);
    const single = await service.runCycle(TENANT, { maxIterations: 1, maxDurationMs: 60_000 });
    const double = await service.runCycle(TENANT, { maxIterations: 2, maxDurationMs: 60_000 });
    expect(double.thoughtsProcessed).toBeGreaterThanOrEqual(single.thoughtsProcessed);
  });
});

describe("status and thread honesty", () => {
  it("reports no last run before anything has run", async () => {
    const status = await service.getStatus(TENANT);

    // Regression: lastRunAt used to be `new Date().toISOString()` on every call,
    // so an idle service claimed to have just completed a cycle.
    expect(status.lastRunAt).toBeUndefined();
    expect(status.totalCycles).toBe(0);
    expect(status.totalThoughtsProcessed).toBe(0);
    expect(status.totalConnectionsFound).toBe(0);
    expect(status.isRunning).toBe(false);
    expect(status.activeThreads).toBe(0);
  });

  it("records real counters after a cycle", async () => {
    await thought("process me", ["x"]);
    const cycle = await service.runCycle(TENANT, { maxIterations: 1, maxDurationMs: 60_000 });
    const status = await service.getStatus(TENANT);

    expect(status.totalCycles).toBe(1);
    expect(status.totalThoughtsProcessed).toBe(cycle.thoughtsProcessed);
    expect(typeof status.lastRunAt).toBe("string");
    expect(status.lastRunDurationMs).toBe(cycle.totalDurationMs);
  });

  it("accumulates across cycles", async () => {
    await service.runCycle(TENANT, { maxIterations: 1, maxDurationMs: 60_000 });
    await service.runCycle(TENANT, { maxIterations: 1, maxDurationMs: 60_000 });
    expect((await service.getStatus(TENANT)).totalCycles).toBe(2);
  });

  it("refuses to stop a thread that was never started", async () => {
    // Regression: any id returned `stopped: true`.
    const bogus = await service.stopBackgroundThread("bg-thread-never-existed");
    expect(bogus.stopped).toBe(false);
    expect(bogus.message).toMatch(/was not running/);
  });

  it("stops a thread it actually started, exactly once", async () => {
    const started = await service.startBackgroundThread(TENANT);
    expect(started.threadId).toMatch(/^bg-thread-\d+$/);
    expect((await service.getStatus(TENANT)).activeThreads).toBe(1);

    const stopped = await service.stopBackgroundThread(started.threadId);
    expect(stopped.stopped).toBe(true);
    expect((await service.getStatus(TENANT)).activeThreads).toBe(0);

    // A second stop of the same id is not a success.
    expect((await service.stopBackgroundThread(started.threadId)).stopped).toBe(false);
  });

  it("counts only the requesting tenant's threads", async () => {
    await service.startBackgroundThread(TENANT);
    expect((await service.getStatus(TENANT)).activeThreads).toBe(1);
    expect((await service.getStatus(OTHER)).activeThreads).toBe(0);
  });

  it("reflects start/stop and clears threads on stop", async () => {
    await service.startBackgroundThread(TENANT);
    service.start();
    expect((await service.getStatus(TENANT)).isRunning).toBe(true);

    service.stop();
    const status = await service.getStatus(TENANT);
    expect(status.isRunning).toBe(false);
    expect(status.activeThreads).toBe(0);
  });
});

describe("old thought reevaluation", () => {
  it("reports no work when every thought is recent", async () => {
    await thought("fresh", ["x"]);
    const result = await service.reevaluateOldThoughts(TENANT, { minAgeDays: 30 });
    expect(result).toEqual({ thoughtsReevaluated: 0, reactivated: 0, movedToWaiting: 0 });
  });

  it("counts thoughts older than the threshold as reevaluated", async () => {
    // A core whose clock sits 90 days in the past makes every thought it writes
    // look old to this service, which reads the real wall clock.
    const pastRoot = await mkdtemp(join(tmpdir(), "background-thinking-past-"));
    const pastClock = Date.now() - 90 * 86_400_000;
    const pastCore = new ThoughtCoreService(pastRoot, () => pastClock);
    await pastCore.initialize();
    const pastService = new BackgroundThinkingService(pastRoot, pastCore);

    await pastCore.createThought({
      tenantId: TENANT,
      title: "ninety days old",
      content: "stale",
      type: "insight",
      sourceType: "agent",
    });

    const result = await pastService.reevaluateOldThoughts(TENANT, { minAgeDays: 30 });
    expect(result.thoughtsReevaluated).toBe(1);
    // A 'new' thought is neither reactivated nor demoted.
    expect(result.reactivated).toBe(0);
    expect(result.movedToWaiting).toBe(0);
  });

  it("does not report an archive action it never performs", async () => {
    // The counter used to be named `archived` while the code wrote `waiting`.
    // The rename is the fix; this asserts the returned shape cannot silently
    // reintroduce the misleading name.
    const result = await service.reevaluateOldThoughts(TENANT);
    expect(Object.keys(result).sort()).toEqual(["movedToWaiting", "reactivated", "thoughtsReevaluated"]);
    expect("archived" in result).toBe(false);
  });

  it("demotes a heavily reactivated active thought to waiting", async () => {
    const pastRoot = await mkdtemp(join(tmpdir(), "background-thinking-demote-"));
    const pastClock = Date.now() - 90 * 86_400_000;
    const pastCore = new ThoughtCoreService(pastRoot, () => pastClock);
    await pastCore.initialize();
    const pastService = new BackgroundThinkingService(pastRoot, pastCore);

    const stale = await pastCore.createThought({
      tenantId: TENANT,
      title: "churned six times",
      content: "stale",
      type: "insight",
      sourceType: "agent",
    });
    await pastCore.activateThought(TENANT, stale.id);
    // Drive activationCount past the threshold: each waiting -> active hop counts.
    for (let index = 0; index < 6; index += 1) {
      await pastCore.setWaiting(TENANT, stale.id);
      await pastCore.activateThought(TENANT, stale.id);
    }
    expect((await pastCore.listThoughts(TENANT))[0]?.activationCount).toBe(6);

    const result = await pastService.reevaluateOldThoughts(TENANT, { minAgeDays: 30 });
    expect(result.movedToWaiting).toBe(1);
    expect((await pastCore.listThoughts(TENANT))[0]?.state).toBe("waiting");
  });
});
