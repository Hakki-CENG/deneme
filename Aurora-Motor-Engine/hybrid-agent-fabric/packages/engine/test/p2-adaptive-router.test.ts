/**
 * Adaptive router — strategy scoring and learned routing.
 *
 * These tests used to assert `expect(decision.selectedPath).toBeDefined()`,
 * `rulesUpdated >= 0` and `confidence >= 0`. Every one of those holds for a
 * router that ignores its inputs and returns the first path with a hardcoded
 * confidence, so the suite could not tell routing from a coin flip.
 *
 * They now use two paths with deliberately opposed trade-offs and assert WHICH
 * one each strategy picks, plus the actual success-rate arithmetic the learning
 * step produces.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdaptiveRouterService } from "../src/aurora/adaptive-router.js";

async function router(): Promise<AdaptiveRouterService> {
  const root = await mkdtemp(join(tmpdir(), "haf-router-"));
  return new AdaptiveRouterService(root);
}

/**
 * Two paths that disagree on every axis, so a strategy cannot satisfy all of
 * them at once and its choice reveals what it optimised for.
 */
const FAST = { path: "/fast-cheap-unreliable", latencyMs: 50, cost: 0.001, reliability: 0.5 };
const RELIABLE = { path: "/slow-costly-reliable", latencyMs: 500, cost: 0.1, reliability: 0.99 };

describe("P2: Adaptive Router — Learned Routing", () => {
  it("picks the reliable path for quality and the fast path for performance", async () => {
    const service = await router();

    const quality = await service.route("tenant1", "req-q", "/api/chat", [FAST, RELIABLE], "quality");
    const performance = await service.route("tenant1", "req-p", "/api/chat", [FAST, RELIABLE], "performance");
    const cost = await service.route("tenant1", "req-c", "/api/chat", [FAST, RELIABLE], "cost");

    // The strategy actually changes the answer — the point of having strategies.
    expect(quality.selectedPath).toBe(RELIABLE.path);
    expect(performance.selectedPath).toBe(FAST.path);
    expect(cost.selectedPath).toBe(FAST.path);
    expect(quality.selectedPath).not.toBe(performance.selectedPath);
  });

  it("learns a success rate from recorded outcomes rather than counting calls", async () => {
    const service = await router();

    // Four attempts, three of which succeed → 0.75, a value that can only come
    // from dividing successes by attempts.
    for (let i = 0; i < 4; i++) {
      const decision = await service.route("tenant1", `req${i}`, "/api/chat", [FAST], "quality");
      await service.recordOutcome(decision.id, 100, i < 3);
    }

    const result = await service.learnRoute("tenant1");

    expect(result.rulesUpdated).toBe(1);
    expect(result.topRoutes).toHaveLength(1);
    expect(result.topRoutes[0]?.path).toBe(FAST.path);
    expect(result.topRoutes[0]?.successRate).toBeCloseTo(0.75, 6);
    expect(result.topRoutes[0]?.avgLatencyMs).toBeCloseTo(100, 6);
  });

  it("admits it has no basis for a recommendation before anything is learned", async () => {
    const service = await router();

    const result = await service.smartRoute("tenant1", "/api/never-seen");

    // Honest low-confidence default instead of inventing a route.
    expect(result.recommendedPath).toBe("default");
    expect(result.confidence).toBeCloseTo(0.3, 6);
    expect(result.rationale.join(" ")).toMatch(/no matching rules/i);
  });

  it("raises confidence once outcomes back the route", async () => {
    const service = await router();

    const cold = await service.smartRoute("tenant1", FAST.path);

    for (let i = 0; i < 4; i++) {
      const decision = await service.route("tenant1", `req${i}`, "/api/chat", [FAST], "quality");
      await service.recordOutcome(decision.id, 100, i < 3);
    }
    await service.learnRoute("tenant1");

    const warm = await service.smartRoute("tenant1", FAST.path);

    // Evidence changed the answer: path, strategy and confidence all move.
    expect(warm.recommendedPath).toBe(FAST.path);
    expect(warm.strategy).toBe("quality");
    expect(warm.confidence).toBeGreaterThan(cold.confidence);
    expect(warm.rationale.join(" ")).toMatch(/0\.75 success rate/);
    expect(warm.rationale.join(" ")).toMatch(/Used 4 times/);
  });

  it("why() reports the strategy and candidates behind a decision", async () => {
    const service = await router();

    const decision = await service.route(
      "tenant1",
      "req1",
      "/api/test",
      [FAST, RELIABLE],
      "hybrid",
    );

    const explanation = await service.why("tenant1", decision.id);

    expect(explanation.rationale).toBeInstanceOf(Array);
    expect(explanation.rationale.length).toBeGreaterThan(0);
    // The explanation has to mention the path that was actually chosen.
    expect(JSON.stringify(explanation)).toContain(decision.selectedPath);
  });
});
