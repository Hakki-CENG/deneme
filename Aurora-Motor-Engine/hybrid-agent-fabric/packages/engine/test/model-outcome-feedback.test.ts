/**
 * Model outcome feedback: the loop must report what the model actually did.
 *
 * Both `ModelCapabilityRegistry.recordOutcome()` and
 * `AdaptiveRouter.recordOutcome()` existed and neither was reachable from a real
 * task, so the router ranked models on evidence nothing ever collected. These
 * tests pin the wiring at both ends: the loop emits a measured sample, and the
 * registry accepts a model it has never seen before instead of dropping the
 * first sample on the floor.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UnifiedExecutionLoop, type ModelOutcomeSample } from "../src/execution/unified-execution-loop.js";
import { ModelCapabilityRegistryService } from "../src/aurora/model-capability-registry.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("the loop reports a measured model outcome", () => {
  it("emits latency, verdict and tokens after verification", async () => {
    const samples: ModelOutcomeSample[] = [];
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "did the work", tokens: 120 }),
      // The engine's real selector applies the chosen route to the context so
      // the session actor actually runs on it; the loop records whichever route
      // the context says the attempt used. Mirrored here rather than assumed.
      selectModel: async (context) => {
        context.modelRoute = "mock:mock-model-1";
        return {
          selectedModel: "mock:mock-model-1",
          reason: "test",
          confidence: 1,
          taskType: "general",
          decisionId: "decision-1",
        };
      },
      recordModelOutcome: (sample) => {
        samples.push(sample);
      },
    });

    await loop.run({ tenantId: "local", goal: "Say hello" });

    expect(samples).toHaveLength(1);
    const sample = samples[0]!;
    expect(sample.route).toBe("mock:mock-model-1");
    expect(sample.decisionId).toBe("decision-1");
    expect(sample.tokens).toBe(120);
    expect(sample.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("uses the verification verdict as success, not the agent's own claim", async () => {
    // The agent says it finished; nothing can confirm it. Recording that as a
    // model success would teach the router to prefer a model that lies well.
    const samples: ModelOutcomeSample[] = [];
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "done" }),
      recordModelOutcome: (sample) => {
        samples.push(sample);
      },
    });

    const report = await loop.run({ tenantId: "local", goal: "Do something unverifiable" });

    expect(report.status).toBe("unverified");
    expect(samples).toHaveLength(1);
    expect(samples[0]!.completed).toBe(true);
    expect(samples[0]!.verified).toBe(false);
  });

  it("survives a recorder that throws, and says the measurement was lost", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "done" }),
      recordModelOutcome: () => {
        throw new Error("registry is down");
      },
    });

    const report = await loop.run({ tenantId: "local", goal: "Do something" });

    // Telemetry failing must not fail the task it is describing -- but the loss
    // has to be visible, or the hole in the evidence is silent.
    expect(report.observations.some((o) => o.summary.includes("not recorded"))).toBe(true);
  });

  it("records nothing when no recorder is wired, and does not pretend otherwise", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "done" }),
    });

    const report = await loop.run({ tenantId: "local", goal: "Do something" });

    // No fabricated outcome, no crash. The report simply carries no claim.
    expect(report.observations.some((o) => o.summary.includes("not recorded"))).toBe(false);
  });
});

describe("the capability registry learns from a model it has never seen", () => {
  it("bootstraps a profile from the first real outcome instead of dropping it", async () => {
    const registry = new ModelCapabilityRegistryService(tempDir("cap-boot-"));
    await registry.init();

    // Nothing was pre-registered for this route.
    expect(await registry.getProfile("mock:unseen-model")).toBeNull();

    await registry.recordOutcome("mock:unseen-model", true, 42);

    const profile = await registry.getProfile("mock:unseen-model");
    expect(profile).not.toBeNull();
    expect(profile!.totalRequests).toBe(1);
    expect(profile!.successfulRequests).toBe(1);
    expect(profile!.avgLatencyMs).toBe(42);
    expect(profile!.provider).toBe("mock");
  });

  it("leaves unknown specifications absent rather than inventing them", async () => {
    const registry = new ModelCapabilityRegistryService(tempDir("cap-absent-"));
    await registry.init();

    await registry.recordOutcome("mock:unseen-model", true, 10);

    const profile = (await registry.getProfile("mock:unseen-model"))!;
    // A route string says nothing about the context window. Writing 0 would be a
    // fabricated specification that later reads as "tiny context".
    expect(profile.contextWindow).toBeUndefined();
    expect(profile.capabilities).toEqual([]);
  });

  it("accumulates across outcomes once bootstrapped", async () => {
    const registry = new ModelCapabilityRegistryService(tempDir("cap-accum-"));
    await registry.init();

    await registry.recordOutcome("mock:m", true, 100);
    await registry.recordOutcome("mock:m", false, 200);

    const profile = (await registry.getProfile("mock:m"))!;
    expect(profile.totalRequests).toBe(2);
    expect(profile.successfulRequests).toBe(1);
    expect(profile.successRate).toBe(0.5);
    expect(profile.avgLatencyMs).toBe(150);
  });

  it("counts the bootstrapped model as measured", async () => {
    const registry = new ModelCapabilityRegistryService(tempDir("cap-count-"));
    await registry.init();

    expect((await registry.getStats()).measuredModels).toBe(0);
    await registry.recordOutcome("mock:m", true, 10);
    expect((await registry.getStats()).measuredModels).toBe(1);
  });
});
