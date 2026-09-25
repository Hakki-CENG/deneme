/**
 * Bölüm E — REASONING: hipotezler, eleştirmen ve dikkat gerçek karara girer.
 *
 * Ölçüm (yazmadan önce):
 *
 *  - E1: `MultiHypothesisReasoningService` makinesi tamamdı (propose/evidence/
 *    test/reason/supersede, durable) ama yalnız HTTP `/v1/reason` ve bir durum
 *    penceresinden çağrılıyordu; yürütme yolundaki hiçbir karar hipotez
 *    üretmiyordu. `competingHypotheses` alanı her hipotezde vardı — dolduran
 *    hiçbir metot yoktu.
 *  - E2: `InternalCriticService.review` yalnız ReasoningEngine (HTTP) ve durum
 *    penceresi tarafından çağrılıyordu. Planı hiç görmedi; hiçbir eleştiri
 *    hiçbir planı değiştirmedi.
 *  - E5+E6+E7: Global Workspace (nesneler, bütçe, odak slotları, modlar) kendi
 *    içinde tamamdı; girişimler ve ACOS döngüleri yarışıyordu — ama görevin
 *    kendisi (engine.execute) kara tahtaya hiç girmiyordu, bütçe yürütme
 *    yolunu bağlamıyordu ve "emergency" modunun hiçbir davranışsal etkisi
 *    yoktu.
 *  - E4: karşıolgusal makinesinin ÇAĞIRANI YOKTU — tek sarmalayıcı
 *    (`WorldEngine.simulateCounterfactual`) senaryo eklemeden "recommended"
 *    olarak simülasyonun kendi id'sini döndürüyordu: hiçbir şeyin tavsiyesi.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CounterfactualSimulatorService } from "../src/aurora/counterfactual-simulator.js";
import { WorldEngine } from "../src/aurora/unified-engines.js";
import { HybridAgentEngine } from "../src/engine.js";
import { UnifiedExecutionLoop, type AgentRunResult } from "../src/execution/unified-execution-loop.js";
import { empiricalVerifier } from "../src/execution/verification-factory.js";

const okAgent = async (): Promise<AgentRunResult> => ({ completed: true, summary: "done" });

const oneStepPlan = async (): Promise<readonly import("../src/execution/unified-execution-loop.js").PlannedStep[]> => [
  { id: "s1", description: "Do the one thing that matters", dependencies: [] },
];

async function newEngine() {
  const root = await mkdtemp(join(tmpdir(), "haf-reason-"));
  return new HybridAgentEngine({
    homePath: root,
    kernelServerScript: "",
    sandboxBackend: "local",
    model: { provider: "mock" },
  } as never);
}

describe("the loop's critic contract (E2)", () => {
  it("a rejected plan blocks the task before the agent acts on it", async () => {
    let agentRuns = 0;
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => {
        agentRuns += 1;
        return { completed: true, summary: "should not run" };
      },
      plan: oneStepPlan,
      critiquePlan: async () => ({
        recommendation: "reject",
        critiques: [{ severity: "critical", description: "Step 1 depends on a tool that does not exist", suggestion: "Acquire or replace the tool first" }],
      }),
    });

    const report = await loop.run({ tenantId: "t", goal: "Use the missing tool" });

    expect(report.status).toBe("blocked");
    expect(agentRuns).toBe(0);
    expect(report.outcomes.some((o) => o.evidence.includes("internal critic rejected the plan"))).toBe(true);
    expect(report.observations.some((o) => o.source === "internal-critic")).toBe(true);
  });

  it("a revise recommendation reaches the agent through the briefing constraints", async () => {
    const seenConstraints: readonly string[] = [];
    const loop = new UnifiedExecutionLoop({
      runAgent: async (context) => {
        seenConstraints.push(...context.constraints);
        return { completed: true, summary: "done" };
      },
      plan: oneStepPlan,
      critiquePlan: async () => ({
        recommendation: "revise",
        critiques: [
          { severity: "warning", description: "Absolute claim detected", suggestion: "Qualify the claim" },
          { severity: "warning", description: "No verification criteria on any step", suggestion: "State what would prove each step" },
          { severity: "warning", description: "Single point of failure", suggestion: "Add a fallback" },
        ],
      }),
    });

    const report = await loop.run({ tenantId: "t", goal: "Ship it" });

    expect(report.status).not.toBe("blocked");
    expect(seenConstraints.some((line) => line.includes("Critic (warning): Absolute claim detected"))).toBe(true);
    expect(seenConstraints.some((line) => line.includes("Qualify the claim"))).toBe(true);
  });

  it("a critic that errors is a lost review, not a failed task", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: okAgent,
      plan: oneStepPlan,
      critiquePlan: async () => {
        throw new Error("critic store unavailable");
      },
    });

    const report = await loop.run({ tenantId: "t", goal: "Ship it" });

    expect(report.status).not.toBe("blocked");
    expect(report.observations.some((o) => o.source === "internal-critic" && o.summary.includes("ran unreviewed"))).toBe(true);
  });
});

describe("the loop's recovery-hypothesis contract (E1)", () => {
  it("a failed attempt's recovery opens competing hypotheses; the next verdict grades them", async () => {
    const opened: Array<{ attempt: number; failureKind: string; strategy: string }> = [];
    const tested: Array<{ attempt: number; verified: boolean }> = [];
    let verifierCalls = 0;

    const loop = new UnifiedExecutionLoop({
      runAgent: okAgent,
      verifiersFor: async () => [
        empiricalVerifier("flaky", async () => {
          verifierCalls += 1;
          return verifierCalls === 1
            ? { passed: 0, failed: 2, output: "test run failed on the first pass" }
            : { passed: 2, failed: 0, output: "test run passed" };
        }),
      ],
      recoveryHypothesis: {
        open: async (info) => {
          opened.push({ attempt: info.attempt, failureKind: info.failureKind, strategy: info.strategy });
        },
        test: async (info) => {
          tested.push({ attempt: info.attempt, verified: info.verified });
        },
      },
    });

    const report = await loop.run({ tenantId: "t", goal: "Make the suite green", maxAttempts: 2 });

    expect(report.status).toBe("succeeded");
    expect(verifierCalls).toBe(2);
    // The bet was written down when it was made...
    expect(opened).toHaveLength(1);
    expect(opened[0]!.attempt).toBe(1);
    expect(opened[0]!.failureKind).toBe("execution_failure");
    expect(opened[0]!.strategy).toBe("retry");
    // ...and graded by the attempt that followed.
    expect(tested).toEqual([{ attempt: 2, verified: true }]);
  });

  it("an uncertain verdict leaves the bet honestly untested", async () => {
    const opened: number[] = [];
    const tested: number[] = [];
    const loop = new UnifiedExecutionLoop({
      runAgent: okAgent,
      verifiersFor: async () => [
        empiricalVerifier("empty", async () => ({ passed: 0, failed: 0, output: "no tests found" })),
      ],
      recoveryHypothesis: {
        open: async (info) => {
          opened.push(info.attempt);
        },
        test: async (info) => {
          tested.push(info.attempt);
        },
      },
    });

    await loop.run({ tenantId: "t", goal: "Anything", maxAttempts: 2 });

    expect(opened.length).toBeGreaterThanOrEqual(1);
    expect(tested).toHaveLength(0);
  });
});

describe("the engine wires reasoning into the real path", () => {
  it("E1: a retry's recovery becomes one confirmed and one refuted competing hypothesis", async () => {
    const engine = await newEngine();
    const tenant = "hyp-t";
    let verifierCalls = 0;
    await engine.execute({
      tenantId: tenant,
      goal: "Stabilise the flaky deploy",
      maxAttempts: 2,
      verifiers: [
        empiricalVerifier("flaky", async () => {
          verifierCalls += 1;
          return verifierCalls === 1
            ? { passed: 0, failed: 2, output: "test run failed on the first pass" }
            : { passed: 2, failed: 0, output: "test run passed" };
        }),
      ],
    });

    expect(verifierCalls).toBe(2);
    const hypotheses = await engine.multiHypothesis.getHypotheses(tenant);
    const positive = hypotheses.find((h) => h.statement.startsWith('Recovery "retry" resolves'));
    const negative = hypotheses.find((h) => h.statement.includes("is structural"));
    expect(positive).toBeDefined();
    expect(negative).toBeDefined();
    // The next attempt verified: the bet is confirmed, its negation refuted.
    expect(positive!.status).toBe("confirmed");
    expect(negative!.status).toBe("refuted");
    // And they are linked as competitors — the field nothing could populate before.
    expect(positive!.competingHypotheses).toContain(negative!.id);
    expect(negative!.competingHypotheses).toContain(positive!.id);
    // The verification that settled it is on the record as evidence.
    expect(positive!.evidence.length).toBeGreaterThan(0);
  }, 120_000);

  it("E2: the plan is reviewed by the internal critic before the agent acts", async () => {
    const engine = await newEngine();
    const report = await engine.execute({ tenantId: "critic-t", goal: "Write a small utility" });

    const note = report.observations.find((o) => o.source === "internal-critic");
    expect(note).toBeDefined();
    expect(note!.summary).toMatch(/Internal critic: (approve|revise|reject)/);
    // Whatever the verdict, it was made BEFORE acting — one plan, one review.
    expect(report.observations.filter((o) => o.source === "internal-critic")).toHaveLength(1);
  }, 120_000);

  it("E7: the task itself enters the Global Workspace and releases its focus when done", async () => {
    const engine = await newEngine();
    const tenant = "gw-t";
    await engine.execute({ tenantId: tenant, goal: "Be visible on the blackboard" });

    const objects = await engine.cognitive.objects(tenant);
    const task = objects.find((o) => o.title === "Be visible on the blackboard");
    expect(task).toBeDefined();
    expect(task!.kind).toBe("problem");
    expect(task!.tags).toContain("engine-task");
    // While it ran it held focus (the reservation was observed)...
    // ...and afterwards the slot is released, not leaked.
    expect(task!.attentionState).not.toBe("focused");
    expect(["active", "solved", "blocked"]).toContain(task!.state);
  }, 120_000);

  it("E5: an exhausted cognitive budget blocks the task before any attempt", async () => {
    const engine = await newEngine();
    const tenant = "budget-t";
    await engine.cognitive.configureBudget(tenant, 1000, 8);
    // Reserve the entire budget with one other focused object.
    const other = await engine.cognitive.intake({
      tenantId: tenant, source: "agent", title: "Background work that takes everything",
      content: "reserves all tokens", requestedTokens: 1000,
    });
    await engine.cognitive.allocateAttention(tenant);

    expect(other.accepted).toBe(true);
    const report = await engine.execute({ tenantId: tenant, goal: "One more thing" });

    expect(report.status).toBe("blocked");
    expect(report.attempts).toBe(0);
    expect(report.observations.some((o) => o.source === "attention" && o.summary.includes("Cognitive budget exhausted"))).toBe(true);
    expect(report.outcomes.some((o) => o.evidence.includes("cognitive attention budget blocked execution"))).toBe(true);
  }, 120_000);

  it("E6: emergency mode defers routine work and still admits urgent work", async () => {
    const engine = await newEngine();
    const tenant = "mode-t";
    await engine.cognitive.transitionMode(tenant, "emergency", "production incident");

    const routine = await engine.execute({ tenantId: tenant, goal: "Refactor the utilities module" });
    expect(routine.status).toBe("blocked");
    expect(routine.attempts).toBe(0);
    expect(routine.observations.some((o) => o.source === "attention" && o.summary.includes("Emergency mode"))).toBe(true);

    const urgent = await engine.execute({ tenantId: tenant, goal: "Stop the bleeding in the auth service", priority: "P0" });
    expect(urgent.status).not.toBe("blocked");
    expect(urgent.attempts).toBeGreaterThanOrEqual(1);

    // Exit the emergency (the only legal exits are reactive and reflection).
    await engine.cognitive.transitionMode(tenant, "reactive", "incident resolved");
    const back = await engine.execute({ tenantId: tenant, goal: "Resume routine maintenance work" });
    expect(back.status).not.toBe("blocked");
  }, 120_000);
});

describe("E4: the counterfactual machine", () => {
  it("recommends by weighted score and calibrates against what actually happened", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-cf-"));
    const service = new CounterfactualSimulatorService(root);
    const sim = await service.createSimulation("t", "Ship Friday or Monday?", "release planning");

    await service.addScenario(sim.id, { name: "ship Friday", description: "d", assumptions: [], parameters: {}, estimatedEffort: 30, estimatedRisk: 0.7, estimatedCost: 40, estimatedQuality: 0.9, pros: [], cons: [], confidence: 0.6 });
    await service.addScenario(sim.id, { name: "ship Monday", description: "d", assumptions: [], parameters: {}, estimatedEffort: 50, estimatedRisk: 0.2, estimatedCost: 45, estimatedQuality: 0.85, pros: [], cons: [], confidence: 0.6 });

    const recommendation = await service.recommend(sim.id);
    const scenarios = (await service.getSimulations("t"))[0]!.scenarios;
    const friday = scenarios.find((s) => s.name === "ship Friday")!;
    // Default weights favour low risk (0.3) over quality (0.25): Monday wins.
    expect(recommendation.scenarioId).toBe(scenarios.find((s) => s.name === "ship Monday")!.id);
    expect(recommendation.scenarioId).not.toBe(friday.id);

    await service.recordOutcome(sim.id, recommendation.scenarioId, "shipped Monday, no incidents", { effort: 52, risk: 0.15, cost: 44, quality: 0.9 });
    const calibration = await service.getCalibrationAccuracy("t");
    expect(calibration.sampleSize).toBe(1);
    // Actual effort 52 vs estimated 50 → |2|; predicted-vs-actual is recorded.
    expect(calibration.avgEffortError).toBeCloseTo(2, 5);
  });

  it("the engine wrapper no longer recommends the simulation itself", async () => {
    const engine = await newEngine();
    const result = await engine.worldEngine.simulateCounterfactual("t", "What if we had waited?", "context");
    // Before E4 this returned { recommended: <the simulation's own id>, scenarios: 0 }.
    expect(result.recommendedScenarioId).toBeNull();
    expect(result.scenarios).toBe(0);
    expect(result.simulationId).toMatch(/^[0-9a-f-]{36}$/);
  }, 60_000);
});
