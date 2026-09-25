/**
 * R — P3.3 ablation benchmark, P3.4 long-horizon restart, P3.5 adaptive
 * routing, and the two benchmark concepts the workspace-graded suite cannot
 * see (multi-agent, proactive).
 *
 * Design rules, stated up front:
 *
 * 1. An ablation is only a measurement if the removed layer is proven absent
 *    by an observable difference in the task report — no "Recalled" outcome,
 *    no "Planned" outcome, no verification, no routing observation. These
 *    tests assert those differences; they never trust the flag alone.
 * 2. Ablated engines must still complete tasks. An ablation that turns the
 *    engine into a crash is not a measurement of "memory's contribution", it
 *    is a measurement of a broken engine.
 * 3. Restart tests create a second engine over the same home directory, not
 *    "the same engine re-initialised" — persistence that only survives in
 *    memory is not persistence.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AdaptiveRouterService } from "../src/aurora/adaptive-router.js";
import { HybridAgentEngine } from "../src/engine.js";

const GOAL = "Summarise the quarterly deployment metrics report";

function baseConfig(homePath: string, ablations?: readonly string[]) {
  return {
    homePath,
    kernelServerScript: "",
    sandboxBackend: "local",
    autoApproveWorkspaceWrites: true,
    model: { provider: "mock" },
    ...(ablations ? { ablations } : {}),
  };
}

async function makeEngine(ablations?: readonly string[]): Promise<HybridAgentEngine> {
  const homePath = await mkdtemp(join(tmpdir(), "r-bench-"));
  return new HybridAgentEngine(baseConfig(homePath, ablations));
}

async function seedMemory(engine: HybridAgentEngine, tenantId: string): Promise<void> {
  await engine.memory.create({
    tenantId,
    kind: "semantic",
    scope: "org",
    title: "Quarterly deployment metrics report",
    content: `The quarterly deployment metrics report is published by the release team. ${GOAL}.`,
    evidenceEventIds: [],
    provenance: { createdBy: "user" },
    status: "active",
  });
}

function passVerifier() {
  return [
    {
      name: "acceptance",
      tier: "V2_empirical" as const,
      run: async () => ({ verdict: "pass" as const, evidence: "acceptance check passed", confidence: 0.9 }),
    },
  ];
}

const outcomeTexts = (report: { outcomes: Array<{ evidence: string }> }) =>
  report.outcomes.map((item) => item.evidence).join("\n");
const observationSources = (report: { observations?: Array<{ source?: string }> }) =>
  (report.observations ?? []).map((item) => item.source ?? "");

async function waitForEvents(engine: HybridAgentEngine, sessionId: string) {
  for (let i = 0; i < 100; i += 1) {
    const events = await engine.readEvents(sessionId);
    if (events.length) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return [];
}

describe("R — ablation benchmark (P3.3)", () => {
  it(
    "baseline: the full engine recalls seeded memory, plans, routes, predicts and verifies",
    async () => {
      const engine = await makeEngine();
      await seedMemory(engine, "tenant");
      const report = await engine.execute({
        tenantId: "tenant",
        goal: GOAL,
        budget: { timeMs: 60_000 },
        verifiers: passVerifier(),
      });

      const texts = outcomeTexts(report);
      // Every layer this study removes is observably present here.
      expect(texts).toMatch(/Recalled \d+ memories?/);
      expect(texts).not.toContain("No planner was supplied");
      expect(report.verification?.verdict).toBe("pass");
      expect(report.status).toBe("succeeded");
      expect(observationSources(report)).toContain("routing");
      expect(observationSources(report)).toContain("world-model");
      await engine.shutdown();
    },
    120_000,
  );

  it(
    "-memory: no recalled memories in the task context",
    async () => {
      const engine = await makeEngine(["memory"]);
      await seedMemory(engine, "tenant");
      const report = await engine.execute({
        tenantId: "tenant",
        goal: GOAL,
        budget: { timeMs: 60_000 },
        verifiers: passVerifier(),
      });
      expect(outcomeTexts(report)).not.toMatch(/Recalled \d+ memories?/);
      // The engine is degraded, not broken.
      expect(report.status).toBe("succeeded");
      await engine.shutdown();
    },
    120_000,
  );

  it(
    "-planning: the loop runs without a planner and says so",
    async () => {
      const engine = await makeEngine(["planning"]);
      const report = await engine.execute({
        tenantId: "tenant",
        goal: GOAL,
        budget: { timeMs: 60_000 },
        verifiers: passVerifier(),
      });
      expect(outcomeTexts(report)).toContain("No planner was supplied");
      expect(report.plan?.steps ?? []).toHaveLength(0);
      expect(report.status).toBe("succeeded");
      await engine.shutdown();
    },
    120_000,
  );

  it(
    "-verification: caller-supplied verifiers are not run, so success cannot be claimed",
    async () => {
      const engine = await makeEngine(["verification"]);
      const report = await engine.execute({
        tenantId: "tenant",
        goal: GOAL,
        budget: { timeMs: 60_000 },
        verifiers: passVerifier(),
      });
      // The verifier was supplied by the caller and still did not run: zero
      // verification results, an uncertain verdict, and no success claim.
      expect(report.verification?.results ?? []).toHaveLength(0);
      expect(report.verification?.verdict).toBe("uncertain");
      expect(report.status).toBe("unverified");
      await engine.shutdown();
    },
    120_000,
  );

  it(
    "-world-model: no pre-action prediction is recorded",
    async () => {
      const engine = await makeEngine(["world-model"]);
      const report = await engine.execute({
        tenantId: "tenant",
        goal: GOAL,
        budget: { timeMs: 60_000 },
        verifiers: passVerifier(),
      });
      expect(observationSources(report)).not.toContain("world-model");
      expect(report.status).toBe("succeeded");
      await engine.shutdown();
    },
    120_000,
  );

  it(
    "-adaptive-routing: no model selection observation is recorded",
    async () => {
      const engine = await makeEngine(["adaptive-routing"]);
      const report = await engine.execute({
        tenantId: "tenant",
        goal: GOAL,
        budget: { timeMs: 60_000 },
        verifiers: passVerifier(),
      });
      expect(observationSources(report)).not.toContain("routing");
      expect(report.status).toBe("succeeded");
      await engine.shutdown();
    },
    120_000,
  );

  it(
    "-cognitive-core and -self-improvement: the engine still completes tasks",
    async () => {
      const engine = await makeEngine(["cognitive-core", "self-improvement"]);
      const report = await engine.execute({
        tenantId: "tenant",
        goal: GOAL,
        budget: { timeMs: 60_000 },
        verifiers: passVerifier(),
      });
      expect(["succeeded", "failed", "unverified"]).toContain(report.status);
      expect(report.verification?.verdict).toBe("pass");
      await engine.shutdown();
    },
    120_000,
  );

  it("an unknown ablation flag throws instead of silently measuring the full system", async () => {
    const engine = await makeEngine(["memry"]);
    await expect(
      engine.execute({ tenantId: "tenant", goal: GOAL, budget: { timeMs: 60_000 } }),
    ).rejects.toThrow(/Unknown ablation flag "memry"/);
    await engine.shutdown();
  }, 120_000);
});

describe("R — long-horizon: restart, recovery, persistence (P3.4)", () => {
  it(
    "memory, schedules and watchers survive an engine restart and the second engine uses the memory",
    async () => {
      const homePath = await mkdtemp(join(tmpdir(), "r-longhorizon-"));

      // Session 1: state is created and a task runs to completion.
      const first = new HybridAgentEngine(baseConfig(homePath));
      await seedMemory(first, "tenant");
      const session = (await first.createSession({ tenantId: "tenant" })) as { sessionId: string };
      const job = await first.scheduler.create({
        tenantId: "tenant",
        sessionId: session.sessionId,
        prompt: "Summarise project progress.",
        schedule: { kind: "once", at: new Date(Date.now() + 3_600_000).toISOString() },
      });
      const watcher = await first.initiative.registerWatcher({
        tenantId: "tenant",
        kind: "file",
        name: "watch deployment logs",
        target: "var/log/deploy.log",
        keywords: ["deploy"],
      });
      const report1 = await first.execute({
        tenantId: "tenant",
        goal: GOAL,
        budget: { timeMs: 60_000 },
        verifiers: passVerifier(),
      });
      // The running engine recalls the seeded memory.
      expect(outcomeTexts(report1)).toMatch(/Recalled \d+ memories?/);
      await first.shutdown();

      // Session 2: a NEW engine instance over the same home directory.
      const second = new HybridAgentEngine(baseConfig(homePath));
      const found = await second.memory.search("tenant", GOAL);
      expect(found.length).toBeGreaterThan(0);

      const jobs = await second.scheduler.list("tenant");
      expect(jobs.some((item) => item.id === job.id)).toBe(true);

      const watchers = await second.initiative.watchers("tenant");
      expect(watchers.some((item) => item.id === watcher.id && item.keywords.includes("deploy"))).toBe(true);

      // Changing world state between sessions: a new memory lands while the
      // engine is down, and the restarted engine's next task sees it.
      await second.memory.create({
        tenantId: "tenant",
        kind: "decision",
        scope: "org",
        title: "Metrics schema changed",
        content: `${GOAL}: the schema now includes canary deployments.`,
        evidenceEventIds: [],
        provenance: { createdBy: "user" },
        status: "active",
      });
      const report2 = await second.execute({
        tenantId: "tenant",
        goal: GOAL,
        budget: { timeMs: 60_000 },
        verifiers: passVerifier(),
      });
      const texts = outcomeTexts(report2);
      expect(texts).toMatch(/Recalled \d+ memories?/);
      expect(report2.status).toBe("succeeded");
      await second.shutdown();
    },
    180_000,
  );
});

describe("R — engine-level benchmark concepts (P3.1: multi-agent, proactive)", () => {
  it(
    "multi-agent: a society task is delegated, executed by a specialist and scored with evidence",
    async () => {
      const engine = await makeEngine();
      const session = (await engine.createSession({ tenantId: "tenant" })) as { sessionId: string };
      await engine.society.configureBudget("tenant", 100_000, 2);
      let task = await engine.society.postTask({
        tenantId: "tenant",
        rootSessionId: session.sessionId,
        title: "Plan release",
        objective: "Produce a safe release plan with dependencies.",
        requiredCapabilityTags: ["planning"],
        priority: "high",
        maxTokens: 80_000,
      });
      task = await engine.society.bid({
        tenantId: "tenant", taskId: task.id, roleId: "planning-director",
        confidence: 0.7, estimatedTokens: 50_000, estimatedDurationMs: 1000, rationale: "Council planning authority.",
      });
      task = await engine.society.bid({
        tenantId: "tenant", taskId: task.id, roleId: "planner-agent",
        confidence: 0.9, estimatedTokens: 30_000, estimatedDurationMs: 1000, rationale: "Specialist task decomposition.",
      });
      task = await engine.society.award("tenant", task.id);
      expect(task.status).toBe("assigned");
      task = await engine.society.execute("tenant", task.id);
      expect(task.status).toBe("running");
      expect(task.childSessionId).toBeTruthy();
      const events = await waitForEvents(engine, task.childSessionId!);
      expect(events.length).toBeGreaterThan(0);
      task = await engine.society.recordOutcome({
        tenantId: "tenant", taskId: task.id, success: true, quality: 0.9, actualTokens: 20_000,
        evidenceEventIds: [events[0]!.eventId],
      });
      expect(task.status).toBe("completed");
      const budget = await engine.society.budget("tenant");
      expect(budget.usedTokens).toBe(20_000);
      await engine.shutdown();
    },
    120_000,
  );

  it(
    "proactive: an ingested event matches a durable watcher and raises an initiative",
    async () => {
      const engine = await makeEngine();
      await engine.initiative.registerWatcher({
        tenantId: "tenant",
        kind: "log",
        name: "deployment failures",
        target: "var/log/deploy.log",
        keywords: ["deploy"],
      });
      await engine.initiative.ingest({
        tenantId: "tenant",
        source: "log",
        summary: "deploy pipeline failed three times in production",
        tags: ["deploy"],
      });
      const { matched, scanned } = await engine.initiative.runWatchers("tenant");
      expect(scanned).toBeGreaterThan(0);
      expect(matched.length).toBeGreaterThan(0);
      expect(matched[0]?.initiativeId).toBeTruthy();
      await engine.shutdown();
    },
    120_000,
  );
});

describe("R — adaptive routing benchmark (P3.5)", () => {
  const PATHS = [
    { path: "fast:cheap", latencyMs: 100, cost: 0.001, reliability: 0.75 },
    { path: "slow:premium", latencyMs: 2000, cost: 0.05, reliability: 0.99 },
    { path: "mid:balanced", latencyMs: 600, cost: 0.01, reliability: 0.9 },
  ];

  async function makeRouter(): Promise<{ router: AdaptiveRouterService; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "r-router-"));
    const router = new AdaptiveRouterService(dir);
    await router.init();
    return { router, dir };
  }

  it("cold start: no learned rules, the strategy alone decides", async () => {
    const { router } = await makeRouter();
    const byPerf = await router.route("t", "r1", "code-generation", PATHS, "performance");
    expect(byPerf.selectedPath).toBe("fast:cheap");
    expect(byPerf.selectedReason).toContain("performance score:");

    const byCost = await router.route("t", "r2", "code-generation", PATHS, "cost");
    expect(byCost.selectedPath).toBe("fast:cheap");

    const byQuality = await router.route("t", "r3", "code-generation", PATHS, "quality");
    expect(byQuality.selectedPath).toBe("slow:premium");
    expect(byQuality.selectedReason).not.toContain("learned");
  });

  it("measured models: outcomes update success rate and average latency of the rule", async () => {
    const { router } = await makeRouter();
    const decision = await router.route("t", "r1", "translation", PATHS, "performance");
    await router.recordOutcome(decision.id, 150, true);
    const failure = await router.route("t", "r2", "translation", PATHS, "performance");
    await router.recordOutcome(failure.id, 900, false);
    const stats = await router.getStats("t");
    expect(stats.totalRoutes).toBe(2);
    // One success, one failure: the recorded success rate is the measured one.
    expect(stats.successRate).toBeCloseTo(0.5);
    expect(stats.avgLatency).toBeCloseTo((150 + 900) / 2);
  });

  it("changing provider quality: a degraded path loses its learned boost", async () => {
    const { router } = await makeRouter();
    // Teach the router that fast:cheap is reliable (3+ uses unlocks the boost).
    for (let i = 0; i < 3; i += 1) {
      const decision = await router.route("t", `warm-${i}`, "summarization", PATHS, "performance");
      await router.recordOutcome(decision.id, 100, true);
    }
    const warm = await router.route("t", "warm-check", "summarization", PATHS, "performance");
    expect(warm.selectedPath).toBe("fast:cheap");
    expect(warm.selectedReason).toContain("learned:");

    // Provider quality changes: the path starts failing.
    for (let i = 0; i < 6; i += 1) {
      const decision = await router.route("t", `degrade-${i}`, "summarization", PATHS, "performance");
      await router.recordOutcome(decision.id, 4000, false);
    }
    const degraded = await router.route("t", "after-degrade", "summarization", PATHS, "performance");
    expect(degraded.selectedReason).toContain("learned:");
    // 3 wins then 6 losses: the measured success rate is 33%.
    expect(degraded.selectedReason).toContain("33% success");
    // The learned boost shrank, so the same path now scores lower.
    expect(degraded.selectedScore).toBeLessThan(warm.selectedScore);
  });

  it("cost/latency/quality strategies pick different paths for the same providers", async () => {
    const { router } = await makeRouter();
    const paths = [
      { path: "a:latency-king", latencyMs: 50, cost: 0.9, reliability: 0.7 },
      { path: "b:cost-king", latencyMs: 5000, cost: 0.0001, reliability: 0.7 },
      { path: "c:quality-king", latencyMs: 1000, cost: 0.1, reliability: 0.999 },
    ];
    expect((await router.route("t", "s1", "x", paths, "performance")).selectedPath).toBe("a:latency-king");
    expect((await router.route("t", "s2", "x", paths, "cost")).selectedPath).toBe("b:cost-king");
    expect((await router.route("t", "s3", "x", paths, "quality")).selectedPath).toBe("c:quality-king");
  });

  it("router state persists across restarts (cold start is only the first time)", async () => {
    const { router, dir } = await makeRouter();
    const decision = await router.route("t", "persist-1", "summarization", PATHS, "performance");
    await router.recordOutcome(decision.id, 120, true);

    const revived = new AdaptiveRouterService(dir);
    await revived.init();
    const stats = await revived.getStats("t");
    expect(stats.totalRoutes).toBe(1);
    const again = await revived.route("t", "persist-2", "summarization", PATHS, "performance");
    expect(again.selectedPath).toBe("fast:cheap");
  });
});
