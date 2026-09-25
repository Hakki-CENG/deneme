/**
 * Skill Promotion Gate — FAZ 22
 *
 * A synthesised skill does NOT become trusted because it exists, and it does
 * not become trusted because it says so. It has to earn each trust level by
 * clearing a measurable gate, and the evidence has to come from somewhere
 * other than the skill's own author.
 *
 * Design constraints (all of these are hard requirements, not preferences):
 *
 *   1. **No self-promotion.** The identity that authored or synthesised a skill
 *      may not be the identity that promotes it, and may not be the source of
 *      the evaluation evidence. "Model writes a test for its own solution and
 *      then accepts its own solution" is precisely the loop this blocks.
 *
 *   2. **`skipped` is never `success`.** Skipped executions are counted
 *      separately and excluded from the denominator rather than silently
 *      inflating the success rate.
 *
 *   3. **One level at a time.** quarantine -> supervised -> trusted. No
 *      skipping, no demote-by-promote, no cycles.
 *
 *   4. **Evidence must be fresh and independent.** Stale evidence, evidence
 *      produced by the author, and evidence from too few distinct evaluators
 *      are all rejected.
 *
 *   5. **Regressions block promotion** even when the aggregate rate looks fine.
 *
 * Every rejection returns a machine-readable reason so a caller can explain to
 * a human exactly which gate failed, rather than an opaque `false`.
 */

import { randomUUID } from "node:crypto";

/** Trust levels a skill can hold. Mirrors `CapabilityTrustLevel`. */
export type SkillTrustLevel = "quarantine" | "supervised" | "trusted";

/** Why a promotion attempt was refused. */
export type PromotionRejectionCode =
  | "unknown_skill"
  | "invalid_transition"
  | "self_promotion"
  | "insufficient_executions"
  | "success_rate_below_threshold"
  | "insufficient_independent_evidence"
  | "evidence_from_author"
  | "stale_evidence"
  | "regression_detected"
  | "skill_deprecated";

/** A single recorded execution of a skill, used as promotion evidence. */
export interface SkillExecutionRecord {
  skillId: string;
  /** Who ran it. Used to enforce evaluator independence. */
  evaluatedBy: string;
  /**
   * `skipped` is deliberately its own outcome. It is NOT success: a skipped
   * run proves nothing and must never count toward the success rate.
   */
  outcome: "success" | "failure" | "skipped";
  durationMs: number;
  executedAt: string;
  /** Optional free-text note for audit trails. */
  note?: string | undefined;
}

/** Thresholds a skill must clear to reach a given level. */
export interface PromotionThreshold {
  /** Minimum non-skipped executions. */
  minExecutions: number;
  /** Minimum success rate over non-skipped executions, 0-1. */
  minSuccessRate: number;
  /** Minimum number of DISTINCT evaluators, excluding the author. */
  minIndependentEvaluators: number;
  /** Evidence older than this is ignored. */
  maxEvidenceAgeMs: number;
  /** Consecutive failures at the tail that block promotion. */
  maxTrailingFailures: number;
}

/**
 * Default gates. `trusted` is deliberately much harder than `supervised`.
 */
export const DEFAULT_PROMOTION_THRESHOLDS: Readonly<Record<
  Exclude<SkillTrustLevel, "quarantine">,
  PromotionThreshold
>> = {
  supervised: {
    minExecutions: 5,
    minSuccessRate: 0.8,
    minIndependentEvaluators: 1,
    maxEvidenceAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    maxTrailingFailures: 1,
  },
  trusted: {
    minExecutions: 20,
    minSuccessRate: 0.95,
    minIndependentEvaluators: 2,
    maxEvidenceAgeMs: 14 * 24 * 60 * 60 * 1000, // 14 days
    maxTrailingFailures: 0,
  },
};

/** Registration record for a skill under trust management. */
export interface SkillTrustRecord {
  skillId: string;
  /** Identity that authored/synthesised the skill. May never self-promote. */
  authoredBy: string;
  level: SkillTrustLevel;
  deprecated: boolean;
  registeredAt: string;
}

/** Evidence summary computed from execution records. */
export interface PromotionEvidence {
  /** Executions counted toward the gate (skipped excluded). */
  countedExecutions: number;
  successes: number;
  failures: number;
  /** Tracked separately — never folded into the success rate. */
  skipped: number;
  successRate: number;
  independentEvaluators: string[];
  trailingFailures: number;
  staleRecords: number;
}

/** Outcome of a promotion attempt. */
export interface PromotionDecision {
  promoted: boolean;
  skillId: string;
  from: SkillTrustLevel;
  to: SkillTrustLevel;
  reason: string;
  code?: PromotionRejectionCode | undefined;
  evidence?: PromotionEvidence | undefined;
  decidedAt: string;
}

/** An entry in the immutable promotion audit log. */
export interface PromotionHistoryEntry {
  id: string;
  skillId: string;
  from: SkillTrustLevel;
  to: SkillTrustLevel;
  promotedBy: string;
  evidence: PromotionEvidence;
  promotedAt: string;
}

/** Legal single-step transitions. */
const VALID_TRANSITIONS: Readonly<Record<SkillTrustLevel, readonly SkillTrustLevel[]>> = {
  quarantine: ["supervised"],
  supervised: ["trusted"],
  trusted: [],
};

/**
 * Enforces the FAZ 22 promotion gate.
 *
 * The manager owns trust state and the evidence ledger. It never promotes on
 * its own: a caller must explicitly request a promotion, and the request is
 * granted only if the evidence clears the gate.
 */
export class SkillPromotionGate {
  private readonly records = new Map<string, SkillTrustRecord>();
  private readonly executions = new Map<string, SkillExecutionRecord[]>();
  private readonly history: PromotionHistoryEntry[] = [];
  private readonly thresholds: Record<Exclude<SkillTrustLevel, "quarantine">, PromotionThreshold>;

  constructor(thresholds?: Partial<Record<Exclude<SkillTrustLevel, "quarantine">, Partial<PromotionThreshold>>>) {
    this.thresholds = {
      supervised: { ...DEFAULT_PROMOTION_THRESHOLDS.supervised, ...(thresholds?.supervised ?? {}) },
      trusted: { ...DEFAULT_PROMOTION_THRESHOLDS.trusted, ...(thresholds?.trusted ?? {}) },
    };
  }

  /**
   * Put a skill under trust management. New skills always start in
   * `quarantine` — there is no way to register something as already trusted.
   */
  register(params: { skillId: string; authoredBy: string }): SkillTrustRecord {
    const existing = this.records.get(params.skillId);
    if (existing) return existing;

    const record: SkillTrustRecord = {
      skillId: params.skillId,
      authoredBy: params.authoredBy,
      level: "quarantine",
      deprecated: false,
      registeredAt: new Date().toISOString(),
    };
    this.records.set(params.skillId, record);
    return record;
  }

  /** Current trust level, or undefined when the skill is unknown. */
  levelOf(skillId: string): SkillTrustLevel | undefined {
    return this.records.get(skillId)?.level;
  }

  /** Full trust record. */
  recordFor(skillId: string): SkillTrustRecord | undefined {
    return this.records.get(skillId);
  }

  /** Mark a skill deprecated. Deprecated skills can never be promoted. */
  deprecate(skillId: string): boolean {
    const record = this.records.get(skillId);
    if (!record) return false;
    record.deprecated = true;
    return true;
  }

  /**
   * Record one execution as promotion evidence.
   *
   * Returns false for unknown skills so evidence can never accumulate against
   * a skill that was never registered.
   */
  recordExecution(execution: SkillExecutionRecord): boolean {
    if (!this.records.has(execution.skillId)) return false;
    const list = this.executions.get(execution.skillId) ?? [];
    list.push(execution);
    this.executions.set(execution.skillId, list);
    return true;
  }

  /** All evidence held for a skill. */
  evidenceRecords(skillId: string): SkillExecutionRecord[] {
    return [...(this.executions.get(skillId) ?? [])];
  }

  /**
   * Summarise evidence for a skill, relative to `now`.
   *
   * `skipped` runs are counted but excluded from the success-rate denominator.
   * Evidence authored by `excludeEvaluator` (the skill's author) does not count
   * toward evaluator independence.
   */
  summariseEvidence(params: {
    skillId: string;
    maxEvidenceAgeMs: number;
    excludeEvaluator: string;
    now?: number | undefined;
  }): PromotionEvidence {
    const now = params.now ?? Date.now();
    const all = this.executions.get(params.skillId) ?? [];

    const fresh: SkillExecutionRecord[] = [];
    let staleRecords = 0;

    for (const record of all) {
      const age = now - new Date(record.executedAt).getTime();
      if (Number.isNaN(age) || age > params.maxEvidenceAgeMs) {
        staleRecords++;
        continue;
      }
      fresh.push(record);
    }

    const skipped = fresh.filter((item) => item.outcome === "skipped").length;
    // `skipped` is excluded here on purpose — see the class docblock.
    const counted = fresh.filter((item) => item.outcome !== "skipped");
    const successes = counted.filter((item) => item.outcome === "success").length;
    const failures = counted.filter((item) => item.outcome === "failure").length;

    const independentEvaluators = [
      ...new Set(
        counted
          .filter((item) => item.evaluatedBy !== params.excludeEvaluator)
          .map((item) => item.evaluatedBy),
      ),
    ];

    // Count consecutive failures at the tail of the counted timeline.
    const chronological = [...counted].sort(
      (a, b) => new Date(a.executedAt).getTime() - new Date(b.executedAt).getTime(),
    );
    let trailingFailures = 0;
    for (let index = chronological.length - 1; index >= 0; index--) {
      if (chronological[index]!.outcome === "failure") trailingFailures++;
      else break;
    }

    return {
      countedExecutions: counted.length,
      successes,
      failures,
      skipped,
      successRate: counted.length === 0 ? 0 : successes / counted.length,
      independentEvaluators,
      trailingFailures,
      staleRecords,
    };
  }

  /**
   * Evaluate the gate WITHOUT mutating state.
   *
   * Useful for dashboards and for explaining to a user why a skill is stuck.
   */
  evaluate(params: {
    skillId: string;
    to: SkillTrustLevel;
    promotedBy: string;
    now?: number | undefined;
  }): PromotionDecision {
    const decidedAt = new Date(params.now ?? Date.now()).toISOString();
    const record = this.records.get(params.skillId);

    const reject = (
      code: PromotionRejectionCode,
      reason: string,
      from: SkillTrustLevel,
      evidence?: PromotionEvidence,
    ): PromotionDecision => ({
      promoted: false,
      skillId: params.skillId,
      from,
      to: params.to,
      reason,
      code,
      evidence,
      decidedAt,
    });

    if (!record) {
      return reject("unknown_skill", `Skill ${params.skillId} is not under trust management.`, "quarantine");
    }

    const from = record.level;

    if (record.deprecated) {
      return reject("skill_deprecated", "Deprecated skills cannot be promoted.", from);
    }

    if (!VALID_TRANSITIONS[from].includes(params.to)) {
      return reject(
        "invalid_transition",
        `Illegal transition ${from} -> ${params.to}. Promotion advances exactly one level.`,
        from,
      );
    }

    // No self-promotion: the author cannot sign off on their own work.
    if (params.promotedBy === record.authoredBy) {
      return reject(
        "self_promotion",
        `${params.promotedBy} authored this skill and may not promote it.`,
        from,
      );
    }

    // `to` is necessarily supervised or trusted here, since quarantine is not a
    // legal destination in VALID_TRANSITIONS.
    const threshold = this.thresholds[params.to as Exclude<SkillTrustLevel, "quarantine">];

    const evidence = this.summariseEvidence({
      skillId: params.skillId,
      maxEvidenceAgeMs: threshold.maxEvidenceAgeMs,
      excludeEvaluator: record.authoredBy,
      now: params.now,
    });

    if (evidence.countedExecutions === 0 && evidence.staleRecords > 0) {
      return reject(
        "stale_evidence",
        `All ${evidence.staleRecords} execution record(s) are older than the ${threshold.maxEvidenceAgeMs}ms evidence window.`,
        from,
        evidence,
      );
    }

    if (evidence.countedExecutions < threshold.minExecutions) {
      return reject(
        "insufficient_executions",
        `Needs ${threshold.minExecutions} non-skipped executions, has ${evidence.countedExecutions}` +
          (evidence.skipped > 0 ? ` (${evidence.skipped} skipped run(s) do not count).` : "."),
        from,
        evidence,
      );
    }

    if (evidence.successRate < threshold.minSuccessRate) {
      return reject(
        "success_rate_below_threshold",
        `Success rate ${(evidence.successRate * 100).toFixed(1)}% is below the required ${(threshold.minSuccessRate * 100).toFixed(1)}%.`,
        from,
        evidence,
      );
    }

    if (evidence.independentEvaluators.length < threshold.minIndependentEvaluators) {
      const code: PromotionRejectionCode =
        evidence.independentEvaluators.length === 0 ? "evidence_from_author" : "insufficient_independent_evidence";
      return reject(
        code,
        `Needs ${threshold.minIndependentEvaluators} independent evaluator(s), has ${evidence.independentEvaluators.length}. ` +
          "Evidence produced by the skill's author does not count.",
        from,
        evidence,
      );
    }

    if (evidence.trailingFailures > threshold.maxTrailingFailures) {
      return reject(
        "regression_detected",
        `${evidence.trailingFailures} consecutive failure(s) at the tail exceed the limit of ${threshold.maxTrailingFailures}.`,
        from,
        evidence,
      );
    }

    return {
      promoted: true,
      skillId: params.skillId,
      from,
      to: params.to,
      reason:
        `Gate cleared: ${evidence.successes}/${evidence.countedExecutions} successes ` +
        `(${(evidence.successRate * 100).toFixed(1)}%) verified by ${evidence.independentEvaluators.length} independent evaluator(s).`,
      evidence,
      decidedAt,
    };
  }

  /**
   * Evaluate the gate and, if it passes, apply the promotion.
   *
   * This is the ONLY way a skill's trust level increases.
   */
  promote(params: {
    skillId: string;
    to: SkillTrustLevel;
    promotedBy: string;
    now?: number | undefined;
  }): PromotionDecision {
    const decision = this.evaluate(params);
    if (!decision.promoted) return decision;

    const record = this.records.get(params.skillId)!;
    record.level = params.to;

    this.history.push({
      id: randomUUID(),
      skillId: params.skillId,
      from: decision.from,
      to: decision.to,
      promotedBy: params.promotedBy,
      evidence: decision.evidence!,
      promotedAt: decision.decidedAt,
    });

    return decision;
  }

  /**
   * Immediately drop a skill to quarantine.
   *
   * Demotion is intentionally asymmetric with promotion: it needs no evidence
   * and no independent evaluator, because failing safe must always be cheaper
   * than failing open.
   */
  demote(params: { skillId: string; demotedBy: string; reason: string }): PromotionDecision {
    const decidedAt = new Date().toISOString();
    const record = this.records.get(params.skillId);

    if (!record) {
      return {
        promoted: false,
        skillId: params.skillId,
        from: "quarantine",
        to: "quarantine",
        reason: `Skill ${params.skillId} is not under trust management.`,
        code: "unknown_skill",
        decidedAt,
      };
    }

    const from = record.level;
    record.level = "quarantine";

    this.history.push({
      id: randomUUID(),
      skillId: params.skillId,
      from,
      to: "quarantine",
      promotedBy: params.demotedBy,
      evidence: this.summariseEvidence({
        skillId: params.skillId,
        maxEvidenceAgeMs: Number.MAX_SAFE_INTEGER,
        excludeEvaluator: record.authoredBy,
      }),
      promotedAt: decidedAt,
    });

    return {
      promoted: false,
      skillId: params.skillId,
      from,
      to: "quarantine",
      reason: `Demoted to quarantine by ${params.demotedBy}: ${params.reason}`,
      decidedAt,
    };
  }

  /** Immutable audit log of every trust change. */
  promotionHistory(skillId?: string): PromotionHistoryEntry[] {
    return skillId ? this.history.filter((entry) => entry.skillId === skillId) : [...this.history];
  }

  /** Skills currently at a given trust level. */
  skillsAtLevel(level: SkillTrustLevel): SkillTrustRecord[] {
    return [...this.records.values()].filter((record) => record.level === level);
  }

  /** Aggregate view for dashboards and health checks. */
  getStats(): {
    total: number;
    quarantine: number;
    supervised: number;
    trusted: number;
    deprecated: number;
    promotions: number;
  } {
    const all = [...this.records.values()];
    return {
      total: all.length,
      quarantine: all.filter((record) => record.level === "quarantine").length,
      supervised: all.filter((record) => record.level === "supervised").length,
      trusted: all.filter((record) => record.level === "trusted").length,
      deprecated: all.filter((record) => record.deprecated).length,
      promotions: this.history.filter((entry) => entry.to !== "quarantine").length,
    };
  }
}
