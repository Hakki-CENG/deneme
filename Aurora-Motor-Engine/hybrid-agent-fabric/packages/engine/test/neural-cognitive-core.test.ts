import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NeuralCognitiveCoreService,
  normalisedEntropy,
} from "../src/aurora/neural-cognitive-core.js";

/**
 * These tests exist because two of this service's numbers were wrong and nothing
 * caught it: the service had no test file at all.
 *
 * Both bugs were the same shape -- a field that looks like a measurement but is
 * not one. A success rate that can go negative, and an entropy drawn from
 * `Math.random()`, both survive review because they are plausible at a glance.
 */
function makeService(): NeuralCognitiveCoreService {
  return new NeuralCognitiveCoreService(mkdtempSync(join(tmpdir(), "neural-core-")));
}

describe("NeuralCognitiveCoreService.recordOutcome", () => {
  it("keeps the success rate at zero after failures with no prior activation", async () => {
    // Was (0.5 * (0 - 1) + 0) / (0 || 1) = -0.5. A rate outside [0, 1] is not a
    // rate, and getStats() averages these across patterns, so one bad pattern
    // dragged the aggregate down too.
    const service = makeService();
    await service.init();
    const pattern = await service.registerPattern("p", "d", ["key"], "response");

    await service.recordOutcome(pattern.id, false);

    const stats = await service.getStats("t");
    expect(stats.topPatterns[0]?.success).toBe(0);
  });

  it("does not oscillate when a second failure is recorded", async () => {
    // Two consecutive failures moved the old value from -0.5 back up to 0.5,
    // because the running average was weighted by the activation count rather
    // than by the number of outcomes.
    const service = makeService();
    await service.init();
    const pattern = await service.registerPattern("p", "d", ["key"], "response");

    await service.recordOutcome(pattern.id, false);
    await service.recordOutcome(pattern.id, false);

    const stats = await service.getStats("t");
    expect(stats.topPatterns[0]?.success).toBe(0);
  });

  it("reports successes over outcomes, not over activations", async () => {
    const service = makeService();
    await service.init();
    const pattern = await service.registerPattern("p", "d", ["key"], "response");

    await service.recordOutcome(pattern.id, false);
    await service.recordOutcome(pattern.id, false);
    await service.recordOutcome(pattern.id, true);

    const stats = await service.getStats("t");
    expect(stats.topPatterns[0]?.success).toBeCloseTo(1 / 3, 10);
  });

  it("stays inside [0, 1] however the outcomes arrive", async () => {
    const service = makeService();
    await service.init();
    const pattern = await service.registerPattern("p", "d", ["key"], "response");

    for (const outcome of [false, true, false, false, true, true, false]) {
      await service.recordOutcome(pattern.id, outcome);
      const stats = await service.getStats("t");
      const rate = stats.topPatterns[0]?.success ?? 0;
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
  });

  it("counts activations and outcomes separately", async () => {
    // `usageCount` is incremented by activate(); the success rate must not
    // depend on it. Activating the pattern repeatedly without recording outcomes
    // leaves the rate alone.
    const service = makeService();
    await service.init();
    const pattern = await service.registerPattern("p", "d", ["key"], "response");

    await service.recordOutcome(pattern.id, true);
    await service.activate("key here", "context");
    await service.activate("key here", "context");

    const stats = await service.getStats("t");
    expect(stats.topPatterns[0]?.usage).toBe(2);
    expect(stats.topPatterns[0]?.success).toBe(1);
  });

  it("ignores an outcome for a pattern that does not exist", async () => {
    const service = makeService();
    await service.init();

    await expect(service.recordOutcome("no-such-pattern", true)).resolves.toBeUndefined();
  });
});

describe("normalisedEntropy", () => {
  it("is zero when all the weight sits in one place", () => {
    expect(normalisedEntropy([1, 0, 0])).toBe(0);
  });

  it("is one when the weight is spread evenly", () => {
    expect(normalisedEntropy([1, 1, 1])).toBeCloseTo(1, 10);
  });

  it("lands between the bounds for an uneven spread", () => {
    const value = normalisedEntropy([0.9, 0.05, 0.05]);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1);
  });

  it("does not depend on how many entries there are when the shape is the same", () => {
    // Normalising by log(n) is what makes the number comparable across pattern
    // counts; an unnormalised entropy would grow with n.
    expect(normalisedEntropy([1, 1])).toBeCloseTo(normalisedEntropy([1, 1, 1, 1]), 10);
  });

  it("is zero for fewer than two usable weights rather than dividing by log(1)", () => {
    expect(normalisedEntropy([])).toBe(0);
    expect(normalisedEntropy([5])).toBe(0);
  });

  it("ignores non-finite and non-positive weights", () => {
    expect(normalisedEntropy([NaN, -1, 0, 2, 2])).toBeCloseTo(1, 10);
  });
});

describe("NeuralCognitiveCoreService.snapshot", () => {
  it("returns the same entropy for the same state", async () => {
    // The field used to be Math.random() * 0.5 + 0.2. Measured on identical
    // state it returned 0.372, 0.519 and 0.434 -- three different numbers for one
    // system, which made the snapshots useless for comparison.
    const service = makeService();
    await service.init();
    await service.registerPattern("p", "d", ["key"], "response");

    const first = await service.snapshot("t", "same");
    const second = await service.snapshot("t", "same");
    const third = await service.snapshot("t", "same");

    expect(first.entropy).toBe(second.entropy);
    expect(second.entropy).toBe(third.entropy);
  });

  it("reports a higher entropy once activations are actually spread out", async () => {
    const service = makeService();
    await service.init();
    await service.registerPattern("even", "d", ["alpha"], "r");
    await service.registerPattern("spread", "d", ["beta"], "r");

    const before = await service.snapshot("t", "before");

    // Two patterns reaching different strengths: the distribution has spread.
    await service.activate("alpha", "");
    await service.activate("alpha beta", "");
    await service.activate("beta", "");

    const after = await service.snapshot("t", "after");
    expect(after.entropy).toBeGreaterThan(before.entropy);
  });

  it("keeps entropy within [0, 1]", async () => {
    const service = makeService();
    await service.init();
    for (const name of ["a", "b", "c"]) {
      await service.registerPattern(name, "d", [name], "r");
      await service.activate(name, "");
    }

    const snap = await service.snapshot("t", "bounded");
    expect(snap.entropy).toBeGreaterThanOrEqual(0);
    expect(snap.entropy).toBeLessThanOrEqual(1);
  });
});
