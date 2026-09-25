/**
 * Learning Gate Metrics — FAZ 30
 *
 * Gate: *"Aynı görev ailesi ikinci karşılaşmada daha az adımla / daha düşük
 * maliyetle tamamlandı."*
 *
 * The point of this file is to make that claim falsifiable. Saying "the agent
 * learned" is cheap; proving it requires showing that a *second* encounter with
 * the same task family was measurably cheaper than the first, and that the
 * saving did not come from cheating.
 *
 * Three traps this guards against, because each one produces a "cheaper"
 * second run while representing no learning at all:
 *
 *   1. **Getting cheaper by failing.** Bailing out early uses fewer steps.
 *      A cheaper run only counts if BOTH encounters actually succeeded.
 *
 *   2. **Getting cheaper by skipping.** A `skipped` outcome is not a success,
 *      and improvements measured against skipped runs are discarded.
 *
 *   3. **Noise dressed up as learning.** A single lucky family is not evidence.
 *      The gate requires improvement across a *majority* of families and a
 *      mean improvement above an explicit margin, and it reports regressions
 *      rather than averaging them away.
 *
 * All metrics are "lower is better" (steps, tokens, cost, wall-clock), so
 * improvement is expressed as a positive *reduction* ratio.
 */

/** Outcome of one attempt at a task. Mirrors the engine's outcome vocabulary. */
export type EncounterOutcome = "success" | "failure" | "skipped";

/** A single recorded attempt at a task belonging to a family. */
export interface TaskEncounter {
  /** Groups attempts that should benefit from one another. */
  familyId: string;
  /** Specific task attempted. May differ within a family. */
  taskId: string;
  /** 1 = first encounter, 2 = second, and so on. */
  encounterIndex: number;
  outcome: EncounterOutcome;
  /** Steps the agent took. Lower is better. */
  steps: number;
  /** Tokens consumed. Lower is better. */
  totalTokens: number;
  /** Cost in USD. Lower is better. */
  totalCostUsd: number;
  /** Wall-clock duration. Lower is better. */
  durationMs: number;
  recordedAt?: string | undefined;
}

/** Per-dimension comparison between two encounters. */
export interface DimensionDelta {
  first: number;
  second: number;
  /** Absolute reduction (positive = cheaper on the second encounter). */
  absolute: number;
  /** Fractional reduction, 0-1 (positive = cheaper). */
  ratio: number;
  improved: boolean;
}

/** Why a family could not contribute evidence. */
export type FamilyExclusionReason =
  | "missing_first_encounter"
  | "missing_second_encounter"
  | "first_encounter_not_successful"
  | "second_encounter_not_successful";

/** Result of comparing one family's first and second encounters. */
export interface FamilyLearningResult {
  familyId: string;
  /** False when the family was excluded; `exclusionReason` says why. */
  counted: boolean;
  exclusionReason?: FamilyExclusionReason | undefined;
  steps?: DimensionDelta | undefined;
  tokens?: DimensionDelta | undefined;
  cost?: DimensionDelta | undefined;
  duration?: DimensionDelta | undefined;
  /** True when the primary metric (steps) improved beyond the margin. */
  improved: boolean;
  /** True when the second encounter was measurably WORSE. */
  regressed: boolean;
}

/** Aggregate verdict for the learning gate. */
export interface LearningGateResult {
  passed: boolean;
  reason: string;
  /** Families that supplied a valid first+second successful pair. */
  countedFamilies: number;
  /** Families present in the data but unusable as evidence. */
  excludedFamilies: number;
  improvedFamilies: number;
  regressedFamilies: number;
  unchangedFamilies: number;
  /** Mean step reduction ratio across counted families, 0-1. */
  meanStepReduction: number;
  meanTokenReduction: number;
  meanCostReduction: number;
  families: FamilyLearningResult[];
}

/** Tunable gate thresholds. */
export interface LearningGateOptions {
  /** Minimum families that must supply valid evidence. Default 3. */
  minFamilies?: number | undefined;
  /**
   * Minimum fractional reduction in steps for a family to count as improved.
   * Default 0.10 (10% fewer steps).
   */
  improvementMargin?: number | undefined;
  /**
   * Fraction of counted families that must improve. Default 0.6.
   * A bare majority is not enough to call it learning.
   */
  minImprovedFraction?: number | undefined;
  /** Any regression worse than this fails the gate outright. Default 0.25. */
  maxRegressionRatio?: number | undefined;
}

const DEFAULTS = {
  minFamilies: 3,
  improvementMargin: 0.1,
  minImprovedFraction: 0.6,
  maxRegressionRatio: 0.25,
} as const;

/** Compute a lower-is-better delta between two measurements. */
function delta(first: number, second: number, margin: number): DimensionDelta {
  const absolute = first - second;
  // Guard against divide-by-zero: if the first run cost nothing, there is no
  // headroom to improve, so the ratio is 0.
  const ratio = first === 0 ? 0 : absolute / first;
  return {
    first,
    second,
    absolute,
    ratio,
    improved: ratio >= margin,
  };
}

/**
 * Pick the earliest encounter at a given index, so duplicate records do not
 * let a caller cherry-pick the most favourable attempt.
 */
function encounterAt(encounters: readonly TaskEncounter[], index: number): TaskEncounter | undefined {
  const matching = encounters
    .filter((item) => item.encounterIndex === index)
    .sort((a, b) => {
      const left = a.recordedAt ? new Date(a.recordedAt).getTime() : 0;
      const right = b.recordedAt ? new Date(b.recordedAt).getTime() : 0;
      return left - right;
    });
  return matching[0];
}

/** Compare the first and second encounters of a single family. */
export function evaluateFamily(
  familyId: string,
  encounters: readonly TaskEncounter[],
  options: LearningGateOptions = {},
): FamilyLearningResult {
  const margin = options.improvementMargin ?? DEFAULTS.improvementMargin;
  const maxRegression = options.maxRegressionRatio ?? DEFAULTS.maxRegressionRatio;

  const first = encounterAt(encounters, 1);
  const second = encounterAt(encounters, 2);

  const exclude = (reason: FamilyExclusionReason): FamilyLearningResult => ({
    familyId,
    counted: false,
    exclusionReason: reason,
    improved: false,
    regressed: false,
  });

  if (!first) return exclude("missing_first_encounter");
  if (!second) return exclude("missing_second_encounter");

  // Trap 1 and 2: a run that failed or was skipped proves nothing, and must
  // never be allowed to look like an efficiency win.
  if (first.outcome !== "success") return exclude("first_encounter_not_successful");
  if (second.outcome !== "success") return exclude("second_encounter_not_successful");

  const steps = delta(first.steps, second.steps, margin);
  const tokens = delta(first.totalTokens, second.totalTokens, margin);
  const cost = delta(first.totalCostUsd, second.totalCostUsd, margin);
  const duration = delta(first.durationMs, second.durationMs, margin);

  return {
    familyId,
    counted: true,
    steps,
    tokens,
    cost,
    duration,
    // Steps are the primary signal: the gate is about doing less work, not
    // about a cheaper model being swapped in underneath.
    improved: steps.improved,
    regressed: steps.ratio <= -maxRegression,
  };
}

/**
 * Evaluate the FAZ 30 learning gate over a set of encounters.
 *
 * Returns a verdict plus the full per-family breakdown, so a failure can be
 * explained precisely rather than asserted.
 */
export function evaluateLearningGate(
  encounters: readonly TaskEncounter[],
  options: LearningGateOptions = {},
): LearningGateResult {
  const minFamilies = options.minFamilies ?? DEFAULTS.minFamilies;
  const minImprovedFraction = options.minImprovedFraction ?? DEFAULTS.minImprovedFraction;

  const byFamily = new Map<string, TaskEncounter[]>();
  for (const encounter of encounters) {
    const list = byFamily.get(encounter.familyId) ?? [];
    list.push(encounter);
    byFamily.set(encounter.familyId, list);
  }

  const families = [...byFamily.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([familyId, list]) => evaluateFamily(familyId, list, options));

  const counted = families.filter((family) => family.counted);
  const improvedFamilies = counted.filter((family) => family.improved).length;
  const regressedFamilies = counted.filter((family) => family.regressed).length;
  const unchangedFamilies = counted.length - improvedFamilies - regressedFamilies;

  const mean = (pick: (family: FamilyLearningResult) => number | undefined): number => {
    if (counted.length === 0) return 0;
    const total = counted.reduce((sum, family) => sum + (pick(family) ?? 0), 0);
    return total / counted.length;
  };

  const meanStepReduction = mean((family) => family.steps?.ratio);
  const meanTokenReduction = mean((family) => family.tokens?.ratio);
  const meanCostReduction = mean((family) => family.cost?.ratio);

  const result = (passed: boolean, reason: string): LearningGateResult => ({
    passed,
    reason,
    countedFamilies: counted.length,
    excludedFamilies: families.length - counted.length,
    improvedFamilies,
    regressedFamilies,
    unchangedFamilies,
    meanStepReduction,
    meanTokenReduction,
    meanCostReduction,
    families,
  });

  if (counted.length < minFamilies) {
    return result(
      false,
      `Only ${counted.length} family/families supplied a valid first+second successful pair; ${minFamilies} required. ` +
        `${families.length - counted.length} excluded (failed, skipped or incomplete).`,
    );
  }

  // Trap 3: a single severe regression fails the gate even if the mean looks
  // acceptable, because it means the "learning" is not reliable.
  if (regressedFamilies > 0) {
    const worst = counted
      .filter((family) => family.regressed)
      .map((family) => `${family.familyId} (${((family.steps?.ratio ?? 0) * 100).toFixed(1)}%)`)
      .join(", ");
    return result(false, `Regression detected in ${regressedFamilies} family/families: ${worst}.`);
  }

  const improvedFraction = improvedFamilies / counted.length;
  if (improvedFraction < minImprovedFraction) {
    return result(
      false,
      `Only ${improvedFamilies}/${counted.length} families improved ` +
        `(${(improvedFraction * 100).toFixed(0)}%); ${(minImprovedFraction * 100).toFixed(0)}% required.`,
    );
  }

  return result(
    true,
    `${improvedFamilies}/${counted.length} families completed the second encounter in fewer steps ` +
      `(mean reduction ${(meanStepReduction * 100).toFixed(1)}% steps, ` +
      `${(meanCostReduction * 100).toFixed(1)}% cost).`,
  );
}

/** Render the gate result as a markdown report. */
export function formatLearningReport(result: LearningGateResult): string {
  const lines: string[] = [];
  lines.push("# Learning Gate — FAZ 30");
  lines.push("");
  lines.push(`**Verdict:** ${result.passed ? "✅ PASS" : "❌ FAIL"}`);
  lines.push("");
  lines.push(result.reason);
  lines.push("");
  lines.push("Gate: *the same task family, encountered a second time, completes in fewer steps or at lower cost.*");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Counted families | ${result.countedFamilies} |`);
  lines.push(`| Excluded (failed/skipped/incomplete) | ${result.excludedFamilies} |`);
  lines.push(`| Improved | ${result.improvedFamilies} |`);
  lines.push(`| Unchanged | ${result.unchangedFamilies} |`);
  lines.push(`| Regressed | ${result.regressedFamilies} |`);
  lines.push(`| Mean step reduction | ${(result.meanStepReduction * 100).toFixed(1)}% |`);
  lines.push(`| Mean token reduction | ${(result.meanTokenReduction * 100).toFixed(1)}% |`);
  lines.push(`| Mean cost reduction | ${(result.meanCostReduction * 100).toFixed(1)}% |`);
  lines.push("");

  lines.push("### Per-family detail");
  lines.push("");
  lines.push("| Family | Counted | Steps 1st → 2nd | Step Δ | Cost Δ | Verdict |");
  lines.push("|---|---|---|---|---|---|");
  for (const family of result.families) {
    if (!family.counted) {
      lines.push(`| \`${family.familyId}\` | ❌ | — | — | — | excluded: ${family.exclusionReason} |`);
      continue;
    }
    const steps = family.steps!;
    const verdict = family.regressed ? "❌ regressed" : family.improved ? "✅ improved" : "➖ unchanged";
    lines.push(
      `| \`${family.familyId}\` | ✅ | ${steps.first} → ${steps.second} | ` +
        `${(steps.ratio * 100).toFixed(1)}% | ${((family.cost?.ratio ?? 0) * 100).toFixed(1)}% | ${verdict} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
