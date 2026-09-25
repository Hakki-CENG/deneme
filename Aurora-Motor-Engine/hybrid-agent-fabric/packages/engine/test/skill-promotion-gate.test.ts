/**
 * FAZ 22 gate — skill promotion.
 *
 * The gate exists to make one class of failure impossible: a skill becoming
 * trusted without independent evidence that it works. These tests are written
 * adversarially — most of them try to sneak a promotion through.
 */

import { describe, expect, it } from "vitest";
import {
  SkillPromotionGate,
  DEFAULT_PROMOTION_THRESHOLDS,
  type SkillExecutionRecord,
} from "../src/skills/skill-promotion.js";

const AUTHOR = "synthesizer-agent";
const REVIEWER = "eval-harness";
const REVIEWER_2 = "human-operator";

/** Build `count` execution records at a fixed recency. */
function evidence(params: {
  skillId: string;
  count: number;
  outcome: SkillExecutionRecord["outcome"];
  evaluatedBy: string;
  ageMs?: number;
  startIndex?: number;
}): SkillExecutionRecord[] {
  const ageMs = params.ageMs ?? 1000;
  const start = params.startIndex ?? 0;
  return Array.from({ length: params.count }, (_, index) => ({
    skillId: params.skillId,
    evaluatedBy: params.evaluatedBy,
    outcome: params.outcome,
    durationMs: 10,
    // Spread records so ordering is deterministic.
    executedAt: new Date(Date.now() - ageMs + (start + index) * 10).toISOString(),
  }));
}

/** A gate with a skill registered and `n` independent successes recorded. */
function gateWith(successes: number, evaluatedBy = REVIEWER) {
  const gate = new SkillPromotionGate();
  gate.register({ skillId: "skill-1", authoredBy: AUTHOR });
  for (const record of evidence({ skillId: "skill-1", count: successes, outcome: "success", evaluatedBy })) {
    gate.recordExecution(record);
  }
  return gate;
}

describe("registration", () => {
  it("always starts a skill in quarantine", () => {
    const gate = new SkillPromotionGate();
    const record = gate.register({ skillId: "s", authoredBy: AUTHOR });

    expect(record.level).toBe("quarantine");
    expect(gate.levelOf("s")).toBe("quarantine");
  });

  it("cannot accumulate evidence for an unregistered skill", () => {
    const gate = new SkillPromotionGate();
    const accepted = gate.recordExecution({
      skillId: "ghost",
      evaluatedBy: REVIEWER,
      outcome: "success",
      durationMs: 1,
      executedAt: new Date().toISOString(),
    });

    expect(accepted).toBe(false);
    expect(gate.evidenceRecords("ghost")).toHaveLength(0);
  });

  it("refuses to promote a skill it has never seen", () => {
    const gate = new SkillPromotionGate();
    const decision = gate.promote({ skillId: "ghost", to: "supervised", promotedBy: REVIEWER });

    expect(decision.promoted).toBe(false);
    expect(decision.code).toBe("unknown_skill");
  });
});

describe("self-promotion is impossible", () => {
  it("rejects promotion requested by the skill's own author", () => {
    const gate = gateWith(50);
    const decision = gate.promote({ skillId: "skill-1", to: "supervised", promotedBy: AUTHOR });

    expect(decision.promoted).toBe(false);
    expect(decision.code).toBe("self_promotion");
    expect(gate.levelOf("skill-1")).toBe("quarantine");
  });

  it("rejects promotion when ALL evidence was produced by the author", () => {
    const gate = new SkillPromotionGate();
    gate.register({ skillId: "skill-1", authoredBy: AUTHOR });
    // Plenty of successes, but the author graded every single one.
    for (const record of evidence({ skillId: "skill-1", count: 40, outcome: "success", evaluatedBy: AUTHOR })) {
      gate.recordExecution(record);
    }

    const decision = gate.promote({ skillId: "skill-1", to: "supervised", promotedBy: REVIEWER });

    expect(decision.promoted).toBe(false);
    expect(decision.code).toBe("evidence_from_author");
    expect(decision.evidence?.independentEvaluators).toHaveLength(0);
  });

  it("requires two distinct independent evaluators for `trusted`", () => {
    const gate = gateWith(40);
    gate.promote({ skillId: "skill-1", to: "supervised", promotedBy: REVIEWER_2 });

    // All 40 successes came from a single evaluator.
    const decision = gate.promote({ skillId: "skill-1", to: "trusted", promotedBy: REVIEWER_2 });

    expect(decision.promoted).toBe(false);
    expect(decision.code).toBe("insufficient_independent_evidence");
    expect(gate.levelOf("skill-1")).toBe("supervised");
  });
});

describe("transition rules", () => {
  it("promotes quarantine -> supervised when the gate is cleared", () => {
    const gate = gateWith(10);
    const decision = gate.promote({ skillId: "skill-1", to: "supervised", promotedBy: REVIEWER_2 });

    expect(decision.promoted).toBe(true);
    expect(decision.from).toBe("quarantine");
    expect(decision.to).toBe("supervised");
    expect(gate.levelOf("skill-1")).toBe("supervised");
  });

  it("refuses to skip a level (quarantine -> trusted)", () => {
    const gate = gateWith(100);
    const decision = gate.promote({ skillId: "skill-1", to: "trusted", promotedBy: REVIEWER_2 });

    expect(decision.promoted).toBe(false);
    expect(decision.code).toBe("invalid_transition");
    expect(gate.levelOf("skill-1")).toBe("quarantine");
  });

  it("refuses to promote beyond trusted", () => {
    const gate = new SkillPromotionGate();
    gate.register({ skillId: "skill-1", authoredBy: AUTHOR });
    for (const who of [REVIEWER, REVIEWER_2]) {
      for (const record of evidence({ skillId: "skill-1", count: 20, outcome: "success", evaluatedBy: who })) {
        gate.recordExecution(record);
      }
    }
    gate.promote({ skillId: "skill-1", to: "supervised", promotedBy: REVIEWER_2 });
    gate.promote({ skillId: "skill-1", to: "trusted", promotedBy: REVIEWER_2 });
    expect(gate.levelOf("skill-1")).toBe("trusted");

    const decision = gate.promote({ skillId: "skill-1", to: "trusted", promotedBy: REVIEWER_2 });
    expect(decision.promoted).toBe(false);
    expect(decision.code).toBe("invalid_transition");
  });

  it("never promotes a deprecated skill", () => {
    const gate = gateWith(50);
    gate.deprecate("skill-1");

    const decision = gate.promote({ skillId: "skill-1", to: "supervised", promotedBy: REVIEWER_2 });
    expect(decision.promoted).toBe(false);
    expect(decision.code).toBe("skill_deprecated");
  });
});

describe("`skipped` is never `success`", () => {
  it("excludes skipped runs from the success-rate denominator", () => {
    const gate = new SkillPromotionGate();
    gate.register({ skillId: "skill-1", authoredBy: AUTHOR });
    for (const record of evidence({ skillId: "skill-1", count: 5, outcome: "success", evaluatedBy: REVIEWER })) {
      gate.recordExecution(record);
    }
    for (const record of evidence({ skillId: "skill-1", count: 95, outcome: "skipped", evaluatedBy: REVIEWER, startIndex: 5 })) {
      gate.recordExecution(record);
    }

    const summary = gate.summariseEvidence({
      skillId: "skill-1",
      maxEvidenceAgeMs: DEFAULT_PROMOTION_THRESHOLDS.supervised.maxEvidenceAgeMs,
      excludeEvaluator: AUTHOR,
    });

    expect(summary.countedExecutions).toBe(5);
    expect(summary.skipped).toBe(95);
    // 5/5, NOT 5/100 and NOT 100/100.
    expect(summary.successRate).toBe(1);
  });

  it("cannot reach the execution threshold using skipped runs", () => {
    const gate = new SkillPromotionGate();
    gate.register({ skillId: "skill-1", authoredBy: AUTHOR });
    // 1 real success + 99 skips must NOT satisfy minExecutions: 5.
    for (const record of evidence({ skillId: "skill-1", count: 1, outcome: "success", evaluatedBy: REVIEWER })) {
      gate.recordExecution(record);
    }
    for (const record of evidence({ skillId: "skill-1", count: 99, outcome: "skipped", evaluatedBy: REVIEWER, startIndex: 1 })) {
      gate.recordExecution(record);
    }

    const decision = gate.promote({ skillId: "skill-1", to: "supervised", promotedBy: REVIEWER_2 });

    expect(decision.promoted).toBe(false);
    expect(decision.code).toBe("insufficient_executions");
    expect(decision.reason).toContain("skipped");
  });
});

describe("evidence quality gates", () => {
  it("rejects promotion below the execution threshold", () => {
    const gate = gateWith(2);
    const decision = gate.promote({ skillId: "skill-1", to: "supervised", promotedBy: REVIEWER_2 });

    expect(decision.promoted).toBe(false);
    expect(decision.code).toBe("insufficient_executions");
  });

  it("rejects promotion below the success-rate threshold", () => {
    const gate = new SkillPromotionGate();
    gate.register({ skillId: "skill-1", authoredBy: AUTHOR });
    // 6 successes, 4 failures = 60%, below the 80% bar. Failures first so the
    // tail is clean and only the RATE gate trips.
    for (const record of evidence({ skillId: "skill-1", count: 4, outcome: "failure", evaluatedBy: REVIEWER })) {
      gate.recordExecution(record);
    }
    for (const record of evidence({ skillId: "skill-1", count: 6, outcome: "success", evaluatedBy: REVIEWER, startIndex: 4 })) {
      gate.recordExecution(record);
    }

    const decision = gate.promote({ skillId: "skill-1", to: "supervised", promotedBy: REVIEWER_2 });

    expect(decision.promoted).toBe(false);
    expect(decision.code).toBe("success_rate_below_threshold");
    expect(decision.evidence?.successRate).toBeCloseTo(0.6, 5);
  });

  it("blocks promotion on a trailing regression even when the aggregate rate passes", () => {
    const gate = new SkillPromotionGate();
    gate.register({ skillId: "skill-1", authoredBy: AUTHOR });
    // 30 successes then 3 fresh failures: aggregate is ~91% but the skill is
    // currently broken.
    for (const record of evidence({ skillId: "skill-1", count: 30, outcome: "success", evaluatedBy: REVIEWER })) {
      gate.recordExecution(record);
    }
    for (const record of evidence({ skillId: "skill-1", count: 3, outcome: "failure", evaluatedBy: REVIEWER, startIndex: 30 })) {
      gate.recordExecution(record);
    }

    const decision = gate.promote({ skillId: "skill-1", to: "supervised", promotedBy: REVIEWER_2 });

    expect(decision.promoted).toBe(false);
    expect(decision.code).toBe("regression_detected");
    expect(decision.evidence?.trailingFailures).toBe(3);
  });

  it("ignores evidence older than the freshness window", () => {
    const gate = new SkillPromotionGate();
    gate.register({ skillId: "skill-1", authoredBy: AUTHOR });
    const ancient = DEFAULT_PROMOTION_THRESHOLDS.supervised.maxEvidenceAgeMs + 60_000;
    for (const record of evidence({ skillId: "skill-1", count: 50, outcome: "success", evaluatedBy: REVIEWER, ageMs: ancient })) {
      gate.recordExecution(record);
    }

    const decision = gate.promote({ skillId: "skill-1", to: "supervised", promotedBy: REVIEWER_2 });

    expect(decision.promoted).toBe(false);
    expect(decision.code).toBe("stale_evidence");
    expect(decision.evidence?.staleRecords).toBe(50);
  });
});

describe("full promotion ladder", () => {
  it("walks quarantine -> supervised -> trusted with independent evidence", () => {
    const gate = new SkillPromotionGate();
    gate.register({ skillId: "skill-1", authoredBy: AUTHOR });

    for (const who of [REVIEWER, REVIEWER_2]) {
      for (const record of evidence({ skillId: "skill-1", count: 15, outcome: "success", evaluatedBy: who })) {
        gate.recordExecution(record);
      }
    }

    const first = gate.promote({ skillId: "skill-1", to: "supervised", promotedBy: REVIEWER_2 });
    expect(first.promoted).toBe(true);

    const second = gate.promote({ skillId: "skill-1", to: "trusted", promotedBy: REVIEWER_2 });
    expect(second.promoted).toBe(true);
    expect(gate.levelOf("skill-1")).toBe("trusted");

    const history = gate.promotionHistory("skill-1");
    expect(history).toHaveLength(2);
    expect(history[0]?.from).toBe("quarantine");
    expect(history[1]?.to).toBe("trusted");
    // Evidence is captured in the audit trail, not just the decision.
    expect(history[1]?.evidence.countedExecutions).toBeGreaterThanOrEqual(20);
  });

  it("demotes to quarantine without requiring evidence (fail safe, not open)", () => {
    const gate = gateWith(10);
    gate.promote({ skillId: "skill-1", to: "supervised", promotedBy: REVIEWER_2 });
    expect(gate.levelOf("skill-1")).toBe("supervised");

    const decision = gate.demote({
      skillId: "skill-1",
      demotedBy: "incident-response",
      reason: "produced a destructive command in production",
    });

    expect(decision.from).toBe("supervised");
    expect(decision.to).toBe("quarantine");
    expect(gate.levelOf("skill-1")).toBe("quarantine");
    expect(decision.reason).toContain("incident-response");
  });
});

describe("evaluate() is side-effect free", () => {
  it("reports the same verdict as promote() without changing state", () => {
    const gate = gateWith(10);

    const preview = gate.evaluate({ skillId: "skill-1", to: "supervised", promotedBy: REVIEWER_2 });
    expect(preview.promoted).toBe(true);
    // Still quarantined: evaluate() must not mutate.
    expect(gate.levelOf("skill-1")).toBe("quarantine");
    expect(gate.promotionHistory()).toHaveLength(0);

    const applied = gate.promote({ skillId: "skill-1", to: "supervised", promotedBy: REVIEWER_2 });
    expect(applied.promoted).toBe(true);
    expect(gate.levelOf("skill-1")).toBe("supervised");
  });
});

describe("stats", () => {
  it("tracks the trust distribution", () => {
    const gate = new SkillPromotionGate();
    gate.register({ skillId: "a", authoredBy: AUTHOR });
    gate.register({ skillId: "b", authoredBy: AUTHOR });
    for (const record of evidence({ skillId: "a", count: 10, outcome: "success", evaluatedBy: REVIEWER })) {
      gate.recordExecution(record);
    }
    gate.promote({ skillId: "a", to: "supervised", promotedBy: REVIEWER_2 });
    gate.deprecate("b");

    const stats = gate.getStats();
    expect(stats.total).toBe(2);
    expect(stats.supervised).toBe(1);
    expect(stats.quarantine).toBe(1);
    expect(stats.deprecated).toBe(1);
    expect(stats.promotions).toBe(1);
  });
});
