/**
 * V3 consensus, and the ways agreement can be fake.
 *
 * `VerificationFactory` could consume V3 results from the day it was written
 * and nothing ever produced one: the tier was declared, handled, documented and
 * unreachable. These tests pin the conditions that make a produced consensus
 * worth the `pass` it can grant.
 *
 * The failure mode being designed against is not "the evaluators are wrong" —
 * it is "the evaluators were never independent, so their agreement carried no
 * information and we treated it as verification anyway".
 */
import { describe, it, expect } from "vitest";

import {
  consensusVerifier,
  independentSources,
  MIN_INDEPENDENT_EVALUATORS,
  type Evaluator,
} from "../src/execution/consensus-verifier.js";
import { VerificationFactory } from "../src/execution/verification-factory.js";

const judge = (
  name: string,
  source: string,
  verdict: "pass" | "fail" | "uncertain",
  confidence = 0.8,
): Evaluator => ({
  name,
  source,
  judge: async () => ({ verdict, reasoning: `${name} says ${verdict}`, confidence }),
});

const CLAIM = "the migration runs cleanly";

describe("independence", () => {
  it("counts distinct sources, not evaluators", () => {
    expect(
      independentSources([
        judge("a", "gpt", "pass"),
        judge("b", "gpt", "pass"),
        judge("c", "claude", "pass"),
      ]),
    ).toBe(2);
  });

  it("refuses to run when every evaluator shares one source", async () => {
    // Three prompts against one model is one evaluator with three chances to
    // repeat the same mistake. Running the panel would produce agreement that
    // looks like consensus and is not.
    const verifier = consensusVerifier(
      "panel",
      CLAIM,
      [judge("a", "gpt", "pass"), judge("b", "gpt", "pass"), judge("c", "gpt", "pass")],
    );

    const result = await verifier.run();

    expect(result.verdict).toBe("uncertain");
    expect(result.verdict).not.toBe("pass");
    expect(result.evidence).toContain("independent sources");
    expect(result.confidence).toBe(0);
  });

  it("does not let one source vote twice", async () => {
    // Two gpt judges plus one claude judge is two independent sources, not
    // three, so confidence must not be inflated by the duplicate.
    const verifier = consensusVerifier("panel", CLAIM, [
      judge("a", "gpt", "pass"),
      judge("b", "gpt", "pass"),
      judge("c", "claude", "pass"),
    ]);

    const result = await verifier.run();

    expect(result.verdict).toBe("pass");
    expect(result.evidence).toContain("2 independent evaluator(s) agreed");
  });

  it("keeps a dissent when one source disagrees with itself", async () => {
    // If the same model passes on one prompt and fails on another, the failure
    // is the informative half: it found something.
    const verifier = consensusVerifier("panel", CLAIM, [
      judge("a", "gpt", "pass"),
      judge("b", "gpt", "fail"),
      judge("c", "claude", "pass"),
    ]);

    const result = await verifier.run();

    expect(result.verdict).toBe("fail");
  });

  it("honours a stricter source requirement", async () => {
    const verifier = consensusVerifier(
      "panel",
      CLAIM,
      [judge("a", "gpt", "pass"), judge("b", "claude", "pass")],
      { minSources: 3 },
    );

    const result = await verifier.run();

    expect(result.verdict).toBe("uncertain");
    expect(result.evidence).toContain("needs 3 independent sources");
  });
});

describe("dissent", () => {
  it("blocks the claim on a single objection among many approvals", async () => {
    // Majority voting would outvote the one verdict that came with a reason to
    // doubt the claim.
    const verifier = consensusVerifier("panel", CLAIM, [
      judge("a", "gpt", "pass"),
      judge("b", "claude", "pass"),
      judge("c", "gemini", "pass"),
      judge("d", "llama", "fail"),
    ]);

    const result = await verifier.run();

    expect(result.verdict).toBe("fail");
    expect(result.evidence).toContain("1 of 4 independent evaluator(s) rejected");
  });

  it("includes every judge's reasoning in the evidence", async () => {
    // A verdict with no reasoning cannot be reviewed by the person who has to
    // act on it.
    const verifier = consensusVerifier("panel", CLAIM, [
      judge("alice", "gpt", "pass"),
      judge("bob", "claude", "fail"),
    ]);

    const result = await verifier.run();

    expect(result.evidence).toContain("alice");
    expect(result.evidence).toContain("bob");
    expect(result.evidence).toContain("says fail");
  });
});

describe("abstention", () => {
  it("never counts an uncertain judge as agreement", async () => {
    const verifier = consensusVerifier("panel", CLAIM, [
      judge("a", "gpt", "pass"),
      judge("b", "claude", "uncertain"),
    ]);

    const result = await verifier.run();

    expect(result.verdict).toBe("uncertain");
    expect(result.evidence).toContain("Only 1 independent source");
  });

  it("never counts a crashed judge as agreement", async () => {
    // An evaluator that throws has said nothing. Treating silence as assent is
    // how a panel passes a claim nobody actually approved.
    const exploding: Evaluator = {
      name: "broken",
      source: "claude",
      judge: async () => {
        throw new Error("model unavailable");
      },
    };
    const verifier = consensusVerifier("panel", CLAIM, [judge("a", "gpt", "pass"), exploding]);

    const result = await verifier.run();

    expect(result.verdict).toBe("uncertain");
    expect(result.verdict).not.toBe("pass");
    expect(result.evidence).toContain("abstained or errored");
  });

  it("still passes when enough independent judges remain", async () => {
    const flaky: Evaluator = {
      name: "flaky",
      source: "llama",
      judge: async () => {
        throw new Error("timeout");
      },
    };
    const verifier = consensusVerifier("panel", CLAIM, [
      judge("a", "gpt", "pass"),
      judge("b", "claude", "pass"),
      flaky,
    ]);

    const result = await verifier.run();

    expect(result.verdict).toBe("pass");
    expect(result.evidence).toContain("1 abstained");
  });
});

describe("confidence", () => {
  it("stays below what an objective verifier would claim", async () => {
    // Agreement between evaluators is evidence about evaluators, never ground
    // truth, so V3 must not report V1/V2-level confidence.
    const verifier = consensusVerifier("panel", CLAIM, [
      judge("a", "gpt", "pass", 1),
      judge("b", "claude", "pass", 1),
      judge("c", "gemini", "pass", 1),
      judge("d", "llama", "pass", 1),
    ]);

    const result = await verifier.run();

    expect(result.verdict).toBe("pass");
    expect(result.confidence).toBeLessThanOrEqual(0.75);
  });

  it("rises with the number of independent sources", async () => {
    const two = await consensusVerifier("two", CLAIM, [
      judge("a", "gpt", "pass", 0.9),
      judge("b", "claude", "pass", 0.9),
    ]).run();

    const three = await consensusVerifier("three", CLAIM, [
      judge("a", "gpt", "pass", 0.9),
      judge("b", "claude", "pass", 0.9),
      judge("c", "gemini", "pass", 0.9),
    ]).run();

    expect(three.confidence).toBeGreaterThan(two.confidence);
  });
});

describe("integration with VerificationFactory", () => {
  it("reaches a verified status through the factory", async () => {
    // The point of the whole exercise: a tier the factory could always consume
    // and nothing could produce is now reachable end to end.
    const factory = new VerificationFactory();
    factory.register(
      consensusVerifier("panel", CLAIM, [judge("a", "gpt", "pass"), judge("b", "claude", "pass")]),
    );
    const report = await factory.verify(CLAIM);

    expect(report.verdict).toBe("pass");
    expect(report.strongestTier).toBe("V3_consensus");
    // Consensus never grants full autonomy.
    expect(report.autonomy).toBe("controlled");
    expect(report.status).toBe("succeeded");
  });

  it("reports unverified, not failed, when the panel cannot conclude", async () => {
    const factory = new VerificationFactory();
    factory.register(
      consensusVerifier("panel", CLAIM, [judge("a", "gpt", "pass"), judge("b", "gpt", "pass")]),
    );
    const report = await factory.verify(CLAIM);

    expect(report.status).toBe("unverified");
    expect(report.verdict).toBe("uncertain");
  });

  it("lets a dissenting panel fail the claim", async () => {
    const factory = new VerificationFactory();
    factory.register(
      consensusVerifier("panel", CLAIM, [judge("a", "gpt", "pass"), judge("b", "claude", "fail")]),
    );
    const report = await factory.verify(CLAIM);

    expect(report.verdict).toBe("fail");
    expect(report.status).toBe("failed");
  });

  it("exposes a minimum that matches the factory's own threshold", () => {
    // The factory requires >= 2 non-uncertain V3 results. If these two numbers
    // drift apart, a verifier could pass its own bar and be ignored.
    expect(MIN_INDEPENDENT_EVALUATORS).toBe(2);
  });
});
