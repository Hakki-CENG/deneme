import { describe, it, expect } from "vitest";

import { AuroraCognitiveRuntime } from "../src/aurora/cognitive-runtime.js";

/**
 * Integration density proof: every FAZ 17-50 pipeline must be reachable,
 * live, and actually used — not merely exported.
 */

const PIPELINES = [
  "capabilitySynthesis",
  "skillSynthesis",
  "skillComposition",
  "skillPromotion",
  "worldModel",
  "goalDiscovery",
  "selfImprovement",
  "integrationVerification",
  "rewardHackingDefense",
  "modelRouting",
  "society",
  "persistence",
  "security",
  "surface",
] as const;

describe("AuroraCognitiveRuntime wiring", () => {
  it("exposes all 14 pipelines as live instances", () => {
    const runtime = new AuroraCognitiveRuntime();
    for (const name of PIPELINES) {
      expect(runtime[name], `${name} should be instantiated`).toBeDefined();
    }
  });

  it("reports every pipeline as wired in its health check", () => {
    const runtime = new AuroraCognitiveRuntime();
    runtime.initialize();

    const health = runtime.health();
    expect(health.initialized).toBe(true);
    expect(health.totalWired).toBe(PIPELINES.length);

    for (const name of PIPELINES) {
      expect(health.pipelines[name]?.wired, `${name} not wired: ${health.pipelines[name]?.detail}`).toBe(true);
    }
  });

  it("is idempotent across repeated initialization", () => {
    const runtime = new AuroraCognitiveRuntime();
    runtime.initialize();
    const first = runtime.selfImprovement.codeEvolver.getProtectedPaths().length;
    runtime.initialize();
    const second = runtime.selfImprovement.codeEvolver.getProtectedPaths().length;
    expect(second).toBe(first);
  });

  it("protects the verifier and security core from self-modification", () => {
    const runtime = new AuroraCognitiveRuntime();
    runtime.initialize();

    const protectedPaths = runtime.selfImprovement.codeEvolver.getProtectedPaths();
    expect(protectedPaths.some((p) => p.includes("integration-verification"))).toBe(true);
    expect(protectedPaths.some((p) => p.includes("reward-hacking-defense"))).toBe(true);
    expect(protectedPaths.some((p) => p.includes("security-system"))).toBe(true);
    // The sandbox itself must not be rewritable by the evolver.
    expect(protectedPaths.some((p) => p.includes("sandbox-worker"))).toBe(true);
  });

  it("honours custom immutable paths", () => {
    const runtime = new AuroraCognitiveRuntime({
      immutablePaths: ["custom/protected.ts"],
    });
    runtime.initialize();
    expect(runtime.selfImprovement.codeEvolver.getProtectedPaths()).toContain(
      "custom/protected.ts"
    );
  });

  it("loads default attack patterns into the reward-hacking defense", () => {
    const runtime = new AuroraCognitiveRuntime();
    runtime.initialize();
    const stats = runtime.rewardHackingDefense.attackPatterns.getStats();
    expect(stats.totalPatterns).toBeGreaterThan(0);
  });

  it("aggregates stats from every pipeline", () => {
    const runtime = new AuroraCognitiveRuntime();
    runtime.initialize();
    const stats = runtime.getStats();
    for (const name of PIPELINES) {
      expect(stats[name], `${name} missing from aggregate stats`).toBeDefined();
    }
  });
});

describe("capability acquisition end-to-end", () => {
  it("verifies a correct capability against the real sandbox", async () => {
    const runtime = new AuroraCognitiveRuntime();
    const result = await runtime.acquireCapability({
      name: "adder",
      description: "adds two numbers",
      code: "return input.a + input.b;",
      testInput: { a: 20, b: 22 },
      expectedOutput: 42,
    });

    expect(result.verified).toBe(true);
    expect(result.output).toBe(42);
    expect(result.error).toBeUndefined();
    // Verification alone must not grant trust.
    expect(result.trustLevel).toBe("quarantine");
  });

  it("rejects a capability whose output is wrong", async () => {
    const runtime = new AuroraCognitiveRuntime();
    const result = await runtime.acquireCapability({
      name: "broken-adder",
      description: "claims to add",
      code: "return 0;",
      testInput: { a: 20, b: 22 },
      expectedOutput: 42,
    });

    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.trustLevel).toBe("quarantine");
  });

  it("rejects a capability that throws", async () => {
    const runtime = new AuroraCognitiveRuntime();
    const result = await runtime.acquireCapability({
      name: "exploder",
      description: "throws",
      code: "throw new Error('nope');",
      testInput: {},
    });

    expect(result.verified).toBe(false);
    expect(String(result.error)).toContain("nope");
  });

  it("records an auditable event for every acquisition decision", async () => {
    const runtime = new AuroraCognitiveRuntime();

    await runtime.acquireCapability({
      name: "ok",
      description: "fine",
      code: "return 1;",
      testInput: {},
      expectedOutput: 1,
    });
    await runtime.acquireCapability({
      name: "bad",
      description: "wrong",
      code: "return 2;",
      testInput: {},
      expectedOutput: 99,
    });

    const stats = runtime.persistence.eventStore.getStats();
    expect(stats.totalEvents).toBeGreaterThanOrEqual(2);
  });

  it("does not promote an unverified capability implicitly", async () => {
    const runtime = new AuroraCognitiveRuntime();
    const result = await runtime.acquireCapability({
      name: "unproven",
      description: "never verified",
      code: "throw new Error('fail');",
      testInput: {},
    });

    const caps = runtime.capabilitySynthesis.synthesis.getCapabilities();
    const cap = caps.find((c) => c.id === result.capabilityId);
    expect(cap?.trustLevel).toBe("quarantine");
    // A failed probe must leave the capability suspended, not active.
    expect(cap?.status).toBe("suspended");
  });
});
