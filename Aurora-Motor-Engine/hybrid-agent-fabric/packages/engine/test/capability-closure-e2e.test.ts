import { describe, expect, it } from "vitest";

import { CapabilitySynthesisPipeline } from "../src/capabilities/capability-synthesis.js";
import {
  CapabilityAcquisition,
  contractFromGap,
} from "../src/execution/capability-acquisition.js";
import { detectGaps } from "../src/execution/gap-detection.js";
import { UnifiedExecutionLoop } from "../src/execution/unified-execution-loop.js";

/**
 * The closing claim of the whole capability programme:
 *
 *   task fails -> gap named -> contract -> code -> static analysis -> sandbox
 *   -> known-good -> decoys -> adversarial -> registry -> ORIGINAL task retried
 *   -> PASS
 *
 * `capability-acquisition-e2e.test.ts` already covers that chain with a
 * hand-written contract. What it cannot show is where the contract comes from:
 * until the requirement table carried examples, `contractFromGap` produced an
 * empty contract, acquisition refused to build anything, and the chain never
 * ran outside a test that supplied the examples itself.
 *
 * These tests use the examples the detector really ships, so a regression in
 * the table breaks them.
 */

/** A genuine implementation: compares two pixel arrays elementwise. */
const REAL_DIFF = `const a = input.a ?? []; const b = input.b ?? [];
const out = []; const n = Math.max(a.length, b.length);
for (let i = 0; i < n; i++) { if (a[i] !== b[i]) out.push(i); }
return out;`;

/**
 * Passes every known-good case by memorising it, then returns a constant.
 *
 * This is the failure mode decoys exist for, and it is not hypothetical: it is
 * what a code generator produces when it optimises for the visible tests.
 */
const MEMORISER = `const k = JSON.stringify(input);
if (k === '{"a":[1,2,3],"b":[1,9,3]}') return [1];
if (k === '{"a":[5,5],"b":[5,5]}') return [];
if (k === '{"a":[0,1,2,3],"b":[9,1,9,3]}') return [0,2];
return [1];`;

const GOAL = "Compare the screenshot with the baseline and report visual differences";

function visualDiffGap() {
  const { gaps } = detectGaps({
    goal: GOAL,
    failures: [],
    inventory: { capabilityIds: [], descriptions: [] },
  });
  const gap = gaps.find((item) => item.missing === "visual_diff");
  expect(gap, "detector must still name visual_diff for this goal").toBeDefined();
  return gap!;
}

function contractFor(gap: ReturnType<typeof visualDiffGap>) {
  return contractFromGap(gap, {
    knownGood: gap.testCases?.knownGood ?? [],
    knownBad: gap.testCases?.knownBad ?? [],
    adversarial: gap.testCases?.adversarial ?? [],
  });
}

describe("capability closure: a detected gap becomes a working capability", () => {
  it("ships enough examples to specify the capability, not just name it", () => {
    const gap = visualDiffGap();

    // The thresholds acquisition enforces: 2 known-good and 1 decoy. Asserting
    // them here means shrinking the table fails loudly rather than silently
    // disabling synthesis.
    expect(gap.testCases?.knownGood.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(gap.testCases?.knownBad.length ?? 0).toBeGreaterThanOrEqual(1);

    // A decoy is only a decoy if the implementation has not already been shown
    // the answer. If a decoy input also appears in known-good, a memoriser
    // sails through and the defence is theatre.
    const goodInputs = new Set(
      (gap.testCases?.knownGood ?? []).map((sample) => JSON.stringify(sample.input)),
    );
    for (const decoy of gap.testCases?.knownBad ?? []) {
      expect(goodInputs.has(JSON.stringify(decoy.input))).toBe(false);
    }
  });

  it("only advertises a capability as synthesisable when the sandbox could build it", () => {
    // pdf_parsing was marked synthesisable and is not: the sandbox has no
    // filesystem and no binary decoding, so generated code could only fake it.
    const { gaps } = detectGaps({
      goal: "Parse the PDF and extract its tables",
      failures: [],
      inventory: { capabilityIds: [], descriptions: [] },
    });
    const pdf = gaps.find((item) => item.missing === "pdf_parsing");
    expect(pdf).toBeDefined();
    expect(pdf?.synthesisable).toBe(false);
  });

  it("builds a real implementation from the detector's own contract", async () => {
    const gap = visualDiffGap();
    const acquisition = new CapabilityAcquisition(
      new CapabilitySynthesisPipeline(),
      async () => REAL_DIFF,
    );

    const result = await acquisition.acquire(gap, contractFor(gap));

    expect(result.acquired).toBe(true);
    expect(result.state).toBe("verified");
    const names = result.steps.filter((step) => step.passed).map((step) => step.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "contract",
        "static-analysis",
        "sandbox",
        "known-good",
        "known-bad-decoys",
        "adversarial",
      ]),
    );
  }, 60_000);

  it("rejects an implementation that memorises the known-good cases", async () => {
    const gap = visualDiffGap();
    const acquisition = new CapabilityAcquisition(
      new CapabilitySynthesisPipeline(),
      async () => MEMORISER,
    );

    const result = await acquisition.acquire(gap, contractFor(gap));

    // It must reach the decoy step: passing known-good is exactly how this
    // cheat disguises itself.
    const knownGood = result.steps.find((step) => step.name === "known-good");
    expect(knownGood?.passed).toBe(true);

    expect(result.acquired).toBe(false);
    expect(result.state).toBe("quarantined");
    expect(result.steps.find((step) => step.name === "known-bad-decoys")?.passed).toBe(false);
  }, 60_000);

  it("closes the loop: the failed task succeeds on retry using what was built", async () => {
    const acquired: string[] = [];

    const loop = new UnifiedExecutionLoop({
      runAgent: async () =>
        acquired.includes("visual_diff")
          ? { completed: true, summary: "Compared using visual_diff: 2 pixels differ" }
          : {
              completed: false,
              summary: "no tool for comparing images",
              error: "no tool available: visual_diff is not installed",
            },
      inventory: async () => ({
        capabilityIds: acquired.includes("visual_diff") ? ["visual_diff"] : [],
      }),
      // An honest verifier: it fails while the capability is missing and
      // passes once it exists. A verifier that always passes would have marked
      // the FIRST, failed attempt as succeeded — measured while writing this.
      verifiersFor: async () => [
        {
          name: "visual-diff-check",
          tier: "V1_formal" as const,
          run: async () =>
            acquired.includes("visual_diff")
              ? {
                  verdict: "pass" as const,
                  evidence: "visual_diff ran: pixel indices compared",
                  confidence: 0.9,
                }
              : {
                  verdict: "fail" as const,
                  evidence: "no visual_diff capability exists to compare with",
                  confidence: 0.9,
                },
        },
      ],
      acquireCapability: async (gap) => {
        const acquisition = new CapabilityAcquisition(
          new CapabilitySynthesisPipeline(),
          async () => REAL_DIFF,
        );
        const result = await acquisition.acquire(gap, contractFor(gap));
        if (result.acquired) acquired.push(gap.missing);
        return result.acquired;
      },
      maxAttempts: 3,
    });

    const report = await loop.run({
      tenantId: "local",
      goal: GOAL,
      budget: { timeMs: 60_000 },
    });

    expect(acquired).toContain("visual_diff");
    expect(report.status).toBe("succeeded");
    // Two attempts, not one: the first had to fail for the gap to be found.
    expect(report.attempts).toBe(2);

    const evidence = report.outcomes.map((item) => item.evidence).join(" | ");
    expect(evidence).toContain("Acquired capability 'visual_diff'");
  }, 90_000);

  it("stops honestly when the gap has no examples to verify against", async () => {
    const gap = visualDiffGap();
    let generatorCalls = 0;

    const acquisition = new CapabilityAcquisition(
      new CapabilitySynthesisPipeline(),
      async () => {
        generatorCalls += 1;
        return REAL_DIFF;
      },
    );

    // Same gap, examples stripped: this is every requirement rule that has no
    // test cases yet.
    const result = await acquisition.acquire(gap, contractFromGap(gap));

    expect(result.acquired).toBe(false);
    expect(result.state).toBe("draft");
    // The point: it does not write code it cannot check.
    expect(generatorCalls).toBe(0);
    expect(result.summary).toContain("too few known-good cases");
  }, 30_000);
});
