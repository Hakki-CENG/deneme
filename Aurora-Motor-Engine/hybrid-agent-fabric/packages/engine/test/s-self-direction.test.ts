/**
 * S — the self-direction layer: loop detection (S4), risk/opportunity
 * derivation (S5/S6), execution reputation (S7), micro-agent factory (S10).
 *
 * S1 (Memory Palace), S2 (Meta-World), S3 (Cognitive Health), S8
 * (continuous self-optimization) and S9 (capability synthesis) were measured
 * as already implemented and tested by earlier sections; the proofs live in
 * aurora-memory-graph / aurora-world-model / aurora-cognitive-extensions /
 * capability-acquisition-* test files. This file covers what did NOT exist.
 *
 * Design rules:
 * 1. Signals are derived from measured report fields only; a tenant with no
 *    signals gets empty lists, never a made-up digest.
 * 2. Self-direction must never rewrite a task verdict.
 * 3. A specialist proposal without measured capabilities is refused — an
 *    invented skill list would be fabrication, not creation.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LoopDetectionService } from "../src/cognitive/loop-detection-service.js";
import { HybridAgentEngine } from "../src/engine.js";
import { MicroAgentFactory } from "../src/society/micro-agent-factory.js";
import { RiskOpportunityEngine } from "../src/proactive/risk-opportunity-engine.js";

function baseConfig(homePath: string) {
  return {
    homePath,
    kernelServerScript: "",
    sandboxBackend: "local",
    autoApproveWorkspaceWrites: true,
    model: { provider: "mock" },
  } as never;
}

async function makeEngine(homePath?: string): Promise<{ engine: HybridAgentEngine; homePath: string }> {
  const root = homePath ?? (await mkdtemp(join(tmpdir(), "s-selfdir-")));
  return { engine: new HybridAgentEngine(baseConfig(root)), homePath: root };
}

function failVerifier() {
  return [
    {
      name: "acceptance",
      tier: "V2_empirical" as const,
      run: async () => ({ verdict: "fail" as const, evidence: "acceptance check failed", confidence: 0.9 }),
    },
  ];
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

const FAILING_GOAL = "Deploy the quarterly metrics pipeline to production cluster alpha";
const OTHER_GOAL = "Rotate the database credentials for the staging environment";

async function runFailing(engine: HybridAgentEngine, goal: string, tenantId = "tenant") {
  return await engine.execute({
    tenantId,
    goal,
    budget: { timeMs: 30_000 },
    maxAttempts: 1,
    verifiers: failVerifier(),
  });
}

describe("S4 — loop detection", () => {
  it(
    "the same failing outcome three times is one loop, not three unrelated failures",
    async () => {
      const { engine } = await makeEngine();
      await runFailing(engine, FAILING_GOAL);
      await runFailing(engine, FAILING_GOAL);
      // Two identical failures: below the threshold, nothing is flagged.
      expect(await engine.loops.activeLoops("tenant")).toHaveLength(0);

      const third = await runFailing(engine, FAILING_GOAL);
      const active = await engine.loops.activeLoops("tenant");
      expect(active).toHaveLength(1);
      expect(active[0]?.occurrences).toBe(3);
      expect(active[0]?.kind).toBe("task");
      expect(active[0]?.detectedAt).not.toBe("");
      expect(active[0]?.evidence).toHaveLength(3);
      expect(active[0]?.evidence[0]?.subject).toBe(FAILING_GOAL);

      // No capabilities were measured on these mock runs, so the engine says
      // so instead of inventing a specialist.
      const selfDirection = (third.observations ?? []).filter((item) => item.source === "self-direction");
      expect(selfDirection.some((item) => item.summary.includes("no specialist proposal"))).toBe(true);
      expect(await engine.microAgents.proposals("tenant")).toHaveLength(0);

      // A different goal does not join the loop.
      await runFailing(engine, OTHER_GOAL);
      expect(await engine.loops.activeLoops("tenant")).toHaveLength(1);

      // Acknowledging ends the active loop; the record stays as history.
      const acknowledged = await engine.loops.acknowledge("tenant", active[0]!.id);
      expect(acknowledged.status).toBe("acknowledged");
      expect(await engine.loops.activeLoops("tenant")).toHaveLength(0);
      expect((await engine.loops.loops("tenant")).some((item) => item.status === "acknowledged")).toBe(true);
      await engine.shutdown();
    },
    180_000,
  );

  it("service unit: threshold crossed exactly once, evidence capped, count restarts after acknowledgement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "s-loops-"));
    const service = new LoopDetectionService(dir, Date.now, 3);
    const signature = "sig-1";

    const first = await service.record({ tenantId: "t", kind: "thought", signature, subject: "s", summary: "same" });
    const second = await service.record({ tenantId: "t", kind: "thought", signature, subject: "s", summary: "same" });
    const third = await service.record({ tenantId: "t", kind: "thought", signature, subject: "s", summary: "same" });
    const fourth = await service.record({ tenantId: "t", kind: "thought", signature, subject: "s", summary: "same" });
    expect(first.thresholdReached).toBe(false);
    expect(second.thresholdReached).toBe(false);
    expect(third.thresholdReached).toBe(true);
    expect(third.loop?.id).toBeTruthy();
    // The threshold fires once, not on every later occurrence.
    expect(fourth.thresholdReached).toBe(false);
    expect(fourth.occurrences).toBe(4);

    // Evidence is capped so a long loop cannot grow unbounded.
    for (let i = 0; i < 12; i += 1) {
      await service.record({ tenantId: "t", kind: "thought", signature, subject: "s", summary: "same" });
    }
    const [loop] = await service.activeLoops("t");
    expect(loop?.evidence.length).toBeLessThanOrEqual(10);

    // After acknowledgement the same signature counts from zero: one more
    // occurrence is recurrence counting, not yet a loop.
    await service.acknowledge("t", loop!.id);
    await service.record({ tenantId: "t", kind: "thought", signature, subject: "s", summary: "same" });
    expect(await service.activeLoops("t")).toHaveLength(0);
    const history = await service.loops("t");
    expect(history.some((item) => item.status === "acknowledged" && item.occurrences >= 10)).toBe(true);
    const counted = history.find((item) => item.status === "active");
    expect(counted?.occurrences).toBe(1);
    expect(counted?.detectedAt).toBe("");

    // A nonsensical threshold is a configuration error, not a silent default.
    expect(() => new LoopDetectionService(dir, Date.now, 1)).toThrow(/threshold/);
  });
});

describe("S7 — execution reputation", () => {
  it(
    "records per model path from real task outcomes and persists across restarts",
    async () => {
      const { engine, homePath } = await makeEngine();
      for (let i = 0; i < 3; i += 1) {
        await engine.execute({
          tenantId: "tenant",
          goal: `Summarise the quarterly deployment metrics report ${i}`,
          budget: { timeMs: 30_000 },
          maxAttempts: 1,
          verifiers: passVerifier(),
        });
      }
      const entries = await engine.reputation.entries("tenant");
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.agentId.startsWith("execution:")).toBe(true);
      expect(entry.interactions).toBe(3);
      expect(entry.successRate).toBe(1);
      // Three verified successes move a fresh entry up the trust ladder.
      expect(["trusted", "verified"]).toContain(entry.trustLevel);
      expect(entry.expertise["task-execution"]).toBe(3);
      await engine.shutdown();

      // Reputation is durable state, not memory of one engine instance.
      const { engine: second } = await makeEngine(homePath);
      const revived = (await second.reputation.entries("tenant"))[0];
      expect(revived?.interactions).toBe(3);
      expect(revived?.successRate).toBe(1);
      await second.shutdown();
    },
    180_000,
  );
});

describe("S5+S6 — risk & opportunity derivation", () => {
  it(
    "a detected loop becomes a risk initiative with evidence, through the real initiative layer",
    async () => {
      const { engine } = await makeEngine();
      for (let i = 0; i < 3; i += 1) await runFailing(engine, FAILING_GOAL);

      const evaluation = await engine.riskOpportunity.evaluate("tenant");
      const loopRisk = evaluation.risks.find((risk) => risk.kind === "repeated-outcome");
      expect(loopRisk).toBeDefined();
      expect(loopRisk?.message).toContain("3 time(s)");
      expect(evaluation.signalCounts.activeLoops).toBe(1);

      const active = await engine.loops.activeLoops("tenant");
      expect(loopRisk?.evidenceRefs).toEqual([active[0]?.id]);

      const { created } = await engine.riskOpportunity.propose("tenant");
      expect(created).toBeGreaterThanOrEqual(1);
      const initiatives = await engine.initiative.initiatives("tenant");
      const riskInitiative = initiatives.find((item) => item.kind === "risk");
      expect(riskInitiative?.title).toContain("Recurring outcome detected");
      await engine.shutdown();
    },
    180_000,
  );

  it(
    "a repeatedly-missing capability becomes an acquisition opportunity; an unverified palace hypothesis becomes a testing opportunity",
    async () => {
      const { engine } = await makeEngine();
      await engine.riskOpportunity.recordCapabilityGap(
        "tenant",
        { type: "tool", missing: "visual_diff", description: "No capability compares two screenshots pixel-wise." },
        "task-1",
      );
      // Seen once: not yet an opportunity — one occurrence is not a pattern.
      let evaluation = await engine.riskOpportunity.evaluate("tenant");
      expect(evaluation.opportunities.find((item) => item.kind === "capability-acquisition")).toBeUndefined();
      expect(evaluation.signalCounts.repeatedGaps).toBe(0);

      await engine.riskOpportunity.recordCapabilityGap(
        "tenant",
        { type: "tool", missing: "visual_diff", description: "No capability compares two screenshots pixel-wise." },
        "task-2",
      );
      evaluation = await engine.riskOpportunity.evaluate("tenant");
      const gapOpportunity = evaluation.opportunities.find((item) => item.kind === "capability-acquisition");
      expect(gapOpportunity?.title).toContain("visual_diff");
      expect(gapOpportunity?.title).toContain("2x");
      expect(evaluation.signalCounts.repeatedGaps).toBe(1);

      // A palace hypothesis that was never verified is a testing opportunity.
      await engine.memoryGraph.remember({
        tenantId: "tenant",
        layer: "palace",
        claimType: "hypothesis",
        title: "Nightly failures correlate with cache flushes",
        content: "The deployment failures cluster within an hour of the nightly cache flush.",
        sourceType: "agent",
        confidence: 0.6,
        importance: 0.7,
        tags: ["hypothesis", "deployment"],
      });
      evaluation = await engine.riskOpportunity.evaluate("tenant");
      expect(
        evaluation.opportunities.find((item) => item.kind === "unverified-hypothesis")?.title,
      ).toContain("Nightly failures correlate with cache flushes");

      const { created } = await engine.riskOpportunity.propose("tenant");
      expect(created).toBeGreaterThanOrEqual(2);
      const initiatives = await engine.initiative.initiatives("tenant");
      expect(initiatives.some((item) => item.kind === "opportunity")).toBe(true);
      await engine.shutdown();
    },
    180_000,
  );

  it("empty signals give empty lists, and saturation/staleness derive from health", async () => {
    const dir = await mkdtemp(join(tmpdir(), "s-riskopp-"));
    const loops = new LoopDetectionService(dir, Date.now, 3);
    const engine = new RiskOpportunityEngine(
      dir,
      {
        loops,
        cognitiveHealth: async () => ({ budgetSaturation: 0.42, staleStrategic: [] }),
        palaceHypotheses: async () => [],
        propose: async () => {
          throw new Error("nothing should be proposed");
        },
      },
      Date.now,
    );
    const empty = await engine.evaluate("t");
    expect(empty.risks).toHaveLength(0);
    expect(empty.opportunities).toHaveLength(0);
    expect(empty.signalCounts).toEqual({
      activeLoops: 0,
      budgetSaturation: 0.42,
      staleStrategic: 0,
      repeatedGaps: 0,
      unverifiedHypotheses: 0,
    });

    // Saturation and staleness are risks; a failing propose propagates real
    // errors but counts duplicate suppression.
    const saturated = new RiskOpportunityEngine(
      dir,
      {
        loops,
        cognitiveHealth: async () => ({ budgetSaturation: 0.95, staleStrategic: ["obj-1", "obj-2"] }),
        palaceHypotheses: async () => [],
        propose: async () => {
          throw new Error("Initiative was suppressed as a duplicate of a recent notification.");
        },
      },
      Date.now,
    );
    const report = await saturated.evaluate("t");
    expect(report.risks.map((risk) => risk.kind).sort()).toEqual(["budget-saturation", "stale-strategic"]);
    const result = await saturated.propose("t");
    expect(result.created).toBe(0);
    expect(result.suppressed).toBe(2);
  });
});

describe("S10 — micro-agent factory", () => {
  it(
    "derives a specialist from measured loop evidence, applies it as a real society micro role that can then win a task",
    async () => {
      const { engine } = await makeEngine();
      // Seed the loop with occurrences that DID invoke capabilities — the
      // only honest basis for a specialist's skill list.
      for (let i = 0; i < 3; i += 1) {
        await engine.loops.record({
          tenantId: "tenant",
          kind: "task",
          signature: "deploy-fail-sig",
          subject: "Deploy the metrics pipeline",
          summary: "failed at rollout",
          capabilities: i === 0 ? ["git.status"] : ["filesystem.read", "git.status"],
        });
      }
      const [loop] = await engine.loops.activeLoops("tenant");
      expect(loop).toBeDefined();

      const proposal = await engine.microAgents.proposeFromLoop("tenant", loop!);
      expect(proposal.status).toBe("proposed");
      expect(proposal.capabilityTags).toEqual(["filesystem.read", "git.status"]);
      expect(proposal.trigger.occurrences).toBe(3);
      expect(proposal.evidenceRefs).toEqual([loop!.id]);

      // A recurring pattern proposes ONE specialist, not one per recurrence.
      const again = await engine.microAgents.proposeFromLoop("tenant", loop!);
      expect(again.id).toBe(proposal.id);

      const applied = await engine.microAgents.apply("tenant", proposal.id);
      expect(applied.status).toBe("applied");
      expect(applied.roleId).toBeTruthy();

      // The role is real society state, not a record in a factory file.
      const roles = await engine.society.roles("tenant");
      const role = roles.find((item) => item.id === applied.roleId);
      expect(role?.layer).toBe("micro");
      expect(role?.builtin).toBe(false);
      expect(role?.capabilityTags).toEqual(["filesystem.read", "git.status"]);

      // And it can actually compete for matching work in the marketplace.
      const session = (await engine.createSession({ tenantId: "tenant" })) as { sessionId: string };
      await engine.society.configureBudget("tenant", 100_000, 2);
      let task = await engine.society.postTask({
        tenantId: "tenant",
        rootSessionId: session.sessionId,
        title: "Read deploy logs",
        objective: "Read the deployment logs and report the failing step.",
        requiredCapabilityTags: ["filesystem.read"],
        maxTokens: 5_000,
      });
      task = await engine.society.bid({
        tenantId: "tenant", taskId: task.id, roleId: applied.roleId!,
        confidence: 0.9, estimatedTokens: 4_000, estimatedDurationMs: 1000, rationale: "Measured specialist for this exact pattern.",
      });
      task = await engine.society.award("tenant", task.id);
      expect(task.status).toBe("assigned");
      expect(task.assignedRoleId).toBe(applied.roleId);

      // An applied proposal cannot be rejected; a fresh proposal needs fresh evidence.
      await expect(engine.microAgents.reject("tenant", proposal.id, "changed my mind")).rejects.toThrow(/retire the role/);
      await engine.shutdown();
    },
    120_000,
  );

  it("refuses to invent a specialist without measured capabilities", async () => {
    const dir = await mkdtemp(join(tmpdir(), "s-micro-"));
    const loops = new LoopDetectionService(dir, Date.now, 2);
    const factory = new MicroAgentFactory(
      dir,
      {
        addRole: async () => {
          throw new Error("must not be called");
        },
      },
      Date.now,
    );
    await loops.record({ tenantId: "t", kind: "task", signature: "sig", subject: "s", summary: "x" });
    await loops.record({ tenantId: "t", kind: "task", signature: "sig", subject: "s", summary: "x" });
    const [loop] = await loops.activeLoops("t");
    await expect(factory.proposeFromLoop("t", loop!)).rejects.toThrow(/nothing measured/);
    expect(await factory.proposals("t")).toHaveLength(0);
  });
});
