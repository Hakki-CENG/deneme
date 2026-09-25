/**
 * FAZ 30 gate — learning.
 *
 * Gate: "Aynı görev ailesi ikinci karşılaşmada daha az adımla/daha düşük
 * maliyetle tamamlandı."
 *
 * These tests are adversarial on purpose. The easy failure mode for a learning
 * metric is to reward runs that got "cheaper" by failing, skipping or getting
 * lucky once — so most of what follows tries to claim learning dishonestly and
 * asserts the gate refuses.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateLearningGate,
  evaluateFamily,
  formatLearningReport,
  type TaskEncounter,
} from "../src/metrics/learning-metrics.js";

/** Build an encounter with sensible defaults. */
function encounter(overrides: Partial<TaskEncounter> & Pick<TaskEncounter, "familyId" | "encounterIndex">): TaskEncounter {
  return {
    taskId: `${overrides.familyId}-task`,
    outcome: "success",
    steps: 10,
    totalTokens: 1000,
    totalCostUsd: 0.1,
    durationMs: 5000,
    ...overrides,
  };
}

/** A family that genuinely got cheaper: 10 steps -> 6 steps. */
function learnedFamily(familyId: string): TaskEncounter[] {
  return [
    encounter({ familyId, encounterIndex: 1, steps: 10, totalTokens: 1000, totalCostUsd: 0.1, durationMs: 5000 }),
    encounter({ familyId, encounterIndex: 2, steps: 6, totalTokens: 620, totalCostUsd: 0.06, durationMs: 3100 }),
  ];
}

describe("a genuine efficiency gain passes the gate", () => {
  it("passes when every family completes the second encounter in fewer steps", () => {
    const result = evaluateLearningGate([
      ...learnedFamily("whitespace-normalisation"),
      ...learnedFamily("json-reshaping"),
      ...learnedFamily("log-parsing"),
    ]);

    expect(result.passed).toBe(true);
    expect(result.countedFamilies).toBe(3);
    expect(result.improvedFamilies).toBe(3);
    expect(result.regressedFamilies).toBe(0);
    expect(result.meanStepReduction).toBeCloseTo(0.4, 5);
    expect(result.reason).toContain("fewer steps");
  });

  it("reports reductions across every cost dimension", () => {
    const family = evaluateFamily("f", learnedFamily("f"));

    expect(family.counted).toBe(true);
    expect(family.steps?.ratio).toBeCloseTo(0.4, 5);
    expect(family.tokens?.ratio).toBeCloseTo(0.38, 5);
    expect(family.cost?.ratio).toBeCloseTo(0.4, 5);
    expect(family.duration?.ratio).toBeCloseTo(0.38, 5);
    expect(family.improved).toBe(true);
    expect(family.regressed).toBe(false);
  });
});

describe("cheaper-by-failing is not learning", () => {
  it("excludes a family whose second encounter failed, however cheap it was", () => {
    const result = evaluateLearningGate([
      ...learnedFamily("a"),
      ...learnedFamily("b"),
      ...learnedFamily("c"),
      // Bailed out after 1 step. Cheapest run in the set — and worthless.
      encounter({ familyId: "quitter", encounterIndex: 1, steps: 10 }),
      encounter({ familyId: "quitter", encounterIndex: 2, steps: 1, outcome: "failure" }),
    ]);

    const quitter = result.families.find((family) => family.familyId === "quitter");
    expect(quitter?.counted).toBe(false);
    expect(quitter?.exclusionReason).toBe("second_encounter_not_successful");
    expect(quitter?.improved).toBe(false);

    // The honest families still carry the gate.
    expect(result.countedFamilies).toBe(3);
    expect(result.excludedFamilies).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("cannot pass the gate using only failed second encounters", () => {
    const result = evaluateLearningGate([
      encounter({ familyId: "a", encounterIndex: 1, steps: 10 }),
      encounter({ familyId: "a", encounterIndex: 2, steps: 1, outcome: "failure" }),
      encounter({ familyId: "b", encounterIndex: 1, steps: 10 }),
      encounter({ familyId: "b", encounterIndex: 2, steps: 1, outcome: "failure" }),
      encounter({ familyId: "c", encounterIndex: 1, steps: 10 }),
      encounter({ familyId: "c", encounterIndex: 2, steps: 1, outcome: "failure" }),
    ]);

    expect(result.passed).toBe(false);
    expect(result.countedFamilies).toBe(0);
    expect(result.excludedFamilies).toBe(3);
    expect(result.reason).toContain("valid first+second successful pair");
  });

  it("excludes a family whose FIRST encounter failed, so the baseline is not fake", () => {
    // A failed first run is a cheap baseline; comparing against it would make
    // an ordinary second run look like a regression, or worse, hide a real one.
    const family = evaluateFamily("f", [
      encounter({ familyId: "f", encounterIndex: 1, steps: 2, outcome: "failure" }),
      encounter({ familyId: "f", encounterIndex: 2, steps: 8 }),
    ]);

    expect(family.counted).toBe(false);
    expect(family.exclusionReason).toBe("first_encounter_not_successful");
  });
});

describe("`skipped` is never `success`", () => {
  it("excludes a skipped second encounter", () => {
    const family = evaluateFamily("f", [
      encounter({ familyId: "f", encounterIndex: 1, steps: 10 }),
      encounter({ familyId: "f", encounterIndex: 2, steps: 0, outcome: "skipped" }),
    ]);

    expect(family.counted).toBe(false);
    expect(family.exclusionReason).toBe("second_encounter_not_successful");
    // A zero-step skip must never register as a 100% improvement.
    expect(family.improved).toBe(false);
    expect(family.steps).toBeUndefined();
  });

  it("cannot pass the gate by skipping everything", () => {
    const result = evaluateLearningGate([
      encounter({ familyId: "a", encounterIndex: 1, steps: 10 }),
      encounter({ familyId: "a", encounterIndex: 2, steps: 0, outcome: "skipped" }),
      encounter({ familyId: "b", encounterIndex: 1, steps: 10 }),
      encounter({ familyId: "b", encounterIndex: 2, steps: 0, outcome: "skipped" }),
      encounter({ familyId: "c", encounterIndex: 1, steps: 10 }),
      encounter({ familyId: "c", encounterIndex: 2, steps: 0, outcome: "skipped" }),
    ]);

    expect(result.passed).toBe(false);
    expect(result.countedFamilies).toBe(0);
  });
});

describe("noise is not learning", () => {
  it("fails when a single family improves and the rest do not", () => {
    const result = evaluateLearningGate([
      ...learnedFamily("lucky"),
      // Identical cost on both encounters.
      encounter({ familyId: "flat-1", encounterIndex: 1, steps: 10 }),
      encounter({ familyId: "flat-1", encounterIndex: 2, steps: 10 }),
      encounter({ familyId: "flat-2", encounterIndex: 1, steps: 10 }),
      encounter({ familyId: "flat-2", encounterIndex: 2, steps: 10 }),
      encounter({ familyId: "flat-3", encounterIndex: 1, steps: 10 }),
      encounter({ familyId: "flat-3", encounterIndex: 2, steps: 10 }),
    ]);

    expect(result.passed).toBe(false);
    expect(result.improvedFamilies).toBe(1);
    expect(result.countedFamilies).toBe(4);
    expect(result.reason).toContain("1/4 families improved");
  });

  it("rejects an improvement that is smaller than the margin", () => {
    // 10 -> 9.5 steps is a 5% gain, under the 10% default margin.
    const family = evaluateFamily("f", [
      encounter({ familyId: "f", encounterIndex: 1, steps: 100 }),
      encounter({ familyId: "f", encounterIndex: 2, steps: 95 }),
    ]);

    expect(family.counted).toBe(true);
    expect(family.steps?.ratio).toBeCloseTo(0.05, 5);
    expect(family.improved).toBe(false);
  });

  it("fails the whole gate when any family regresses badly", () => {
    const result = evaluateLearningGate([
      ...learnedFamily("a"),
      ...learnedFamily("b"),
      ...learnedFamily("c"),
      ...learnedFamily("d"),
      // 10 -> 20 steps: the agent got worse at this family.
      encounter({ familyId: "regressed", encounterIndex: 1, steps: 10 }),
      encounter({ familyId: "regressed", encounterIndex: 2, steps: 20 }),
    ]);

    // 4 of 5 improved, so the fraction test would have passed — the regression
    // check is what stops it.
    expect(result.improvedFamilies).toBe(4);
    expect(result.regressedFamilies).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Regression detected");
  });
});

describe("evidence hygiene", () => {
  it("requires a second encounter to exist at all", () => {
    const family = evaluateFamily("f", [encounter({ familyId: "f", encounterIndex: 1 })]);

    expect(family.counted).toBe(false);
    expect(family.exclusionReason).toBe("missing_second_encounter");
  });

  it("uses the earliest attempt at each index, so duplicates cannot be cherry-picked", () => {
    const family = evaluateFamily("f", [
      encounter({ familyId: "f", encounterIndex: 1, steps: 100, recordedAt: "2026-01-01T00:00:00.000Z" }),
      // The real second encounter: a modest 5% gain, under the margin.
      encounter({ familyId: "f", encounterIndex: 2, steps: 95, recordedAt: "2026-01-02T00:00:00.000Z" }),
      // A later, conveniently cheap re-run that would fake a 90% gain.
      encounter({ familyId: "f", encounterIndex: 2, steps: 10, recordedAt: "2026-01-03T00:00:00.000Z" }),
    ]);

    // The earliest second-encounter (95 steps) is used, not the flattering one.
    expect(family.steps?.second).toBe(95);
    expect(family.steps?.ratio).toBeCloseTo(0.05, 5);
    expect(family.improved).toBe(false);
  });

  it("does not divide by zero when the first encounter cost nothing", () => {
    const family = evaluateFamily("f", [
      encounter({ familyId: "f", encounterIndex: 1, steps: 0, totalTokens: 0, totalCostUsd: 0, durationMs: 0 }),
      encounter({ familyId: "f", encounterIndex: 2, steps: 0, totalTokens: 0, totalCostUsd: 0, durationMs: 0 }),
    ]);

    expect(Number.isFinite(family.steps?.ratio)).toBe(true);
    expect(family.steps?.ratio).toBe(0);
    expect(family.improved).toBe(false);
  });

  it("handles an empty dataset without throwing", () => {
    const result = evaluateLearningGate([]);

    expect(result.passed).toBe(false);
    expect(result.countedFamilies).toBe(0);
    expect(result.meanStepReduction).toBe(0);
  });
});

describe("configurability", () => {
  it("honours a stricter improvement margin", () => {
    const encounters = [
      encounter({ familyId: "a", encounterIndex: 1, steps: 100 }),
      encounter({ familyId: "a", encounterIndex: 2, steps: 80 }), // 20%
      encounter({ familyId: "b", encounterIndex: 1, steps: 100 }),
      encounter({ familyId: "b", encounterIndex: 2, steps: 80 }),
      encounter({ familyId: "c", encounterIndex: 1, steps: 100 }),
      encounter({ familyId: "c", encounterIndex: 2, steps: 80 }),
    ];

    expect(evaluateLearningGate(encounters, { improvementMargin: 0.1 }).passed).toBe(true);
    // Demand 30% and the same data no longer qualifies.
    expect(evaluateLearningGate(encounters, { improvementMargin: 0.3 }).passed).toBe(false);
  });

  it("honours a higher minimum family count", () => {
    const encounters = [...learnedFamily("a"), ...learnedFamily("b"), ...learnedFamily("c")];

    expect(evaluateLearningGate(encounters, { minFamilies: 3 }).passed).toBe(true);
    expect(evaluateLearningGate(encounters, { minFamilies: 5 }).passed).toBe(false);
  });
});

describe("reporting", () => {
  it("renders a markdown report showing per-family verdicts", () => {
    const result = evaluateLearningGate([
      ...learnedFamily("whitespace"),
      ...learnedFamily("json"),
      ...learnedFamily("logs"),
      encounter({ familyId: "aborted", encounterIndex: 1, steps: 10 }),
      encounter({ familyId: "aborted", encounterIndex: 2, steps: 2, outcome: "failure" }),
    ]);

    const markdown = formatLearningReport(result);

    expect(markdown).toContain("# Learning Gate — FAZ 30");
    expect(markdown).toContain("✅ PASS");
    expect(markdown).toContain("whitespace");
    expect(markdown).toContain("excluded: second_encounter_not_successful");
    expect(markdown).toContain("Mean step reduction");
  });
});
