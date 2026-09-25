/**
 * P0-7 gate — failure taxonomy + bounded recovery.
 *
 * The plan asks for 15 failure types and a recovery loop limited by budget and
 * attempts. Both exist. What did not exist was evidence that the taxonomy
 * actually DISCRIMINATES: 15 kinds are only worth having if a message can reach
 * each of them and each leads somewhere different. Before this file, the whole
 * engine test suite mentioned exactly one of the fifteen (`timeout`), so a rule
 * could have rotted — or every message could have collapsed into one bucket —
 * without a single test noticing.
 *
 * The security case is the one that actually matters at runtime: a refusal by a
 * safety gate must never be retried. That is asserted explicitly here rather
 * than left to inspection.
 */

import { describe, it, expect } from "vitest";
import {
  FAILURE_KINDS,
  classifyFailure,
  chooseRecovery,
  type FailureKind,
} from "../src/execution/failure-taxonomy.js";

/**
 * One realistic message per kind.
 *
 * These are wired to the classifier's actual patterns on purpose: the point is
 * to prove every branch is reachable, and to fail loudly if a pattern is
 * deleted or a kind is added without a way to reach it.
 */
const MESSAGE_FOR: Record<FailureKind, string> = {
  knowledge_gap: "I don't know the schema for the billing table",
  tool_gap: "no tool available to send an SMS",
  skill_gap: "repeatedly failed with the same error",
  interface_gap: "unexpected field 'user_id' in response",
  permission_gap: "403 Forbidden: insufficient scope",
  verification_gap: "cannot verify the deployment succeeded",
  planning_failure: "plan was incoherent",
  reasoning_failure: "incorrect inference drawn",
  execution_failure: "process crashed",
  environment_failure: "ECONNREFUSED connecting to sandbox",
  resource_failure: "budget exhausted",
  model_failure: "model refused to answer",
  timeout: "operation timed out after 30s",
  security_block: "blocked by policy",
  fundamental_unknown: "zzz unparseable gibberish qqq",
};

describe("failure taxonomy discriminates, it does not just exist", () => {
  it("declares exactly the fifteen kinds the plan calls for", () => {
    expect(FAILURE_KINDS).toHaveLength(15);
    expect(new Set(FAILURE_KINDS).size).toBe(15);
  });

  it("can reach every one of the fifteen kinds from a realistic message", () => {
    const reached = new Map<FailureKind, FailureKind>();

    for (const kind of FAILURE_KINDS) {
      const classification = classifyFailure(MESSAGE_FOR[kind], {
        attemptCount: 1,
        phase: "verifying",
      });
      reached.set(kind, classification.kind);
    }

    // Report all mismatches at once rather than dying on the first.
    const wrong = [...reached.entries()]
      .filter(([expected, actual]) => expected !== actual)
      .map(([expected, actual]) => `${expected} -> ${actual}`);

    expect(wrong, `misclassified: ${wrong.join(", ")}`).toEqual([]);
    expect(new Set(reached.values()).size).toBe(15);
  });

  it("routes each kind to a recovery strategy, and does not send everything to one", () => {
    const strategies = new Set<string>();

    for (const kind of FAILURE_KINDS) {
      const classification = classifyFailure(MESSAGE_FOR[kind], { attemptCount: 1 });
      const decision = chooseRecovery(classification, { attemptsUsed: 0, maxAttempts: 3 });
      expect(decision.strategy, `${kind} produced no strategy`).toBeTruthy();
      strategies.add(decision.strategy);
    }

    // A taxonomy that maps fifteen diagnoses onto one treatment is decoration.
    // Measured at the time of writing: 11 distinct strategies.
    expect(strategies.size).toBeGreaterThanOrEqual(8);
  });

  it("never auto-retries a security block, at any attempt count or budget", () => {
    const classification = classifyFailure("blocked by policy", { attemptCount: 1 });
    expect(classification.kind).toBe("security_block");
    // A safety refusal is not ambiguous; treating it as uncertain would invite
    // a retry.
    expect(classification.confidence).toBeGreaterThanOrEqual(0.9);

    for (const attemptsUsed of [0, 1, 2, 5]) {
      const decision = chooseRecovery(classification, { attemptsUsed, maxAttempts: 10 });
      expect(decision.strategy, `retried a security block at attempt ${attemptsUsed}`).toBe(
        "abort",
      );
      expect(decision.canContinue).toBe(false);
    }
  });

  it("refuses to guess when nothing matches, instead of inventing a recovery path", () => {
    const classification = classifyFailure("zzz unparseable gibberish qqq", { attemptCount: 1 });

    expect(classification.kind).toBe("fundamental_unknown");
    // Low confidence is the honest signal here, and it must stay low: a
    // confident "unknown" would let downstream logic act on a non-diagnosis.
    expect(classification.confidence).toBeLessThanOrEqual(0.3);
    expect(chooseRecovery(classification, { attemptsUsed: 0, maxAttempts: 3 }).strategy).toBe(
      "ask_human",
    );
  });

  it("treats an unrecognised error that keeps repeating as a skill gap", () => {
    // Same unmatched message, but now it has failed more than once. Repetition
    // is itself evidence: the agent can issue the action and cannot get it
    // right.
    const first = classifyFailure("zzz unparseable gibberish qqq", { attemptCount: 1 });
    const repeated = classifyFailure("zzz unparseable gibberish qqq", { attemptCount: 3 });

    expect(first.kind).toBe("fundamental_unknown");
    expect(repeated.kind).toBe("skill_gap");
    expect(repeated.confidence).toBeGreaterThan(first.confidence);
  });

  it("lowers confidence when several categories match the same message", () => {
    // A message carrying two independent signatures is genuinely more
    // ambiguous, and the classifier must say so rather than pick a winner at
    // full confidence.
    const single = classifyFailure("operation timed out after 30s", { attemptCount: 1 });
    const mixed = classifyFailure("operation timed out after 30s; quota exceeded", {
      attemptCount: 1,
    });

    expect(mixed.confidence).toBeLessThan(single.confidence);
    expect(mixed.rationale).toContain("categories");
  });
});

describe("recovery is bounded", () => {
  it("escalates to a human once the attempt budget is spent", () => {
    const classification = classifyFailure("ECONNREFUSED connecting to sandbox", {
      attemptCount: 3,
    });
    // Retryable in principle...
    expect(chooseRecovery(classification, { attemptsUsed: 0, maxAttempts: 3 }).canContinue).toBe(
      true,
    );
    // ...but not forever.
    const exhausted = chooseRecovery(classification, { attemptsUsed: 3, maxAttempts: 3 });
    expect(exhausted.strategy).toBe("ask_human");
    expect(exhausted.canContinue).toBe(false);
  });

  it("aborts immediately when the budget itself is blown, whatever the failure", () => {
    for (const kind of FAILURE_KINDS) {
      const classification = classifyFailure(MESSAGE_FOR[kind], { attemptCount: 1 });
      const decision = chooseRecovery(classification, {
        attemptsUsed: 0,
        maxAttempts: 5,
        budgetExceeded: "token budget exhausted",
      });
      expect(decision.strategy, `${kind} kept going past the budget`).toBe("abort");
      expect(decision.canContinue).toBe(false);
    }
  });
});
