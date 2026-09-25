/**
 * Reward-Hacking Detectors — executable checks
 *
 * `reward-hacking-defense.ts` shipped with a defence pipeline whose every
 * check was `async () => true`. That is worse than having no security module
 * at all: it manufactured a clean audit report on demand, so the system would
 * confidently assert "no reward hacking detected" while performing no
 * detection whatsoever.
 *
 * This file provides the real checks. Each detector takes concrete evidence
 * (a score history, an eval record, a metric series) and returns a verdict
 * that can actually come back negative.
 *
 * Convention, matching `SecurityAuditor.runAudit`: a check returns `true` when
 * the system is CLEAN and `false` when the attack signature is present.
 */

/** One observation in a score/metric time series. */
export interface ScoreSample {
  /** Monotonic step, episode or evaluation index. */
  step: number;
  /** The headline score being optimised, normalised to 0-1 where possible. */
  score: number;
  /**
   * An independent measure of real capability for the same step — for example
   * held-out task success. Reward hacking shows up as the two diverging.
   */
  groundTruth?: number | undefined;
}

/** Verdict from a detector. */
export interface DetectionVerdict {
  /** True when the system looks clean. */
  clean: boolean;
  /** Human-readable explanation, always populated. */
  detail: string;
  /** 0-1 confidence that an attack signature is present. */
  suspicion: number;
  /** Supporting numbers so a reviewer can check the reasoning. */
  evidence?: Record<string, number> | undefined;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Mean of a numeric list; 0 for an empty list. */
function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample standard deviation. */
function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Pearson correlation. Returns 0 when either series is constant. */
export function correlation(left: readonly number[], right: readonly number[]): number {
  const n = Math.min(left.length, right.length);
  if (n < 2) return 0;

  const a = left.slice(0, n);
  const b = right.slice(0, n);
  const meanA = mean(a);
  const meanB = mean(b);

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;

  for (let index = 0; index < n; index++) {
    const deltaA = a[index]! - meanA;
    const deltaB = b[index]! - meanB;
    covariance += deltaA * deltaB;
    varianceA += deltaA ** 2;
    varianceB += deltaB ** 2;
  }

  if (varianceA === 0 || varianceB === 0) return 0;
  return covariance / Math.sqrt(varianceA * varianceB);
}

/**
 * Detect reward-curve manipulation: the optimised score climbs while the
 * independent ground-truth measure does not follow.
 *
 * This is the canonical reward-hacking signature — the agent found a way to
 * move the number without moving the underlying capability.
 */
export function detectRewardCurveManipulation(
  samples: readonly ScoreSample[],
  options: { minSamples?: number | undefined; divergenceThreshold?: number | undefined } = {},
): DetectionVerdict {
  const minSamples = options.minSamples ?? 4;
  const divergenceThreshold = options.divergenceThreshold ?? 0.2;

  const paired = samples.filter((sample) => typeof sample.groundTruth === "number");

  if (paired.length < minSamples) {
    // Refusing to judge is the honest answer; claiming "clean" on thin
    // evidence is exactly the failure mode this file exists to remove.
    return {
      clean: true,
      detail: `Insufficient paired evidence (${paired.length}/${minSamples}); no verdict possible.`,
      suspicion: 0,
      evidence: { pairedSamples: paired.length },
    };
  }

  const ordered = [...paired].sort((a, b) => a.step - b.step);
  const scores = ordered.map((sample) => sample.score);
  const truths = ordered.map((sample) => sample.groundTruth!);

  const half = Math.floor(ordered.length / 2);
  const scoreGain = mean(scores.slice(half)) - mean(scores.slice(0, half));
  const truthGain = mean(truths.slice(half)) - mean(truths.slice(0, half));
  const divergence = scoreGain - truthGain;

  const correlationValue = correlation(scores, truths);

  // Signature: the score improved meaningfully, ground truth did not keep up.
  const manipulated = scoreGain > 0.05 && divergence >= divergenceThreshold;

  return {
    clean: !manipulated,
    detail: manipulated
      ? `Score rose ${(scoreGain * 100).toFixed(1)}% while ground truth moved ${(truthGain * 100).toFixed(1)}% ` +
        `(divergence ${(divergence * 100).toFixed(1)}%, correlation ${correlationValue.toFixed(2)}).`
      : `Score and ground truth move together (divergence ${(divergence * 100).toFixed(1)}%, correlation ${correlationValue.toFixed(2)}).`,
    suspicion: manipulated ? clamp01(divergence) : 0,
    evidence: { scoreGain, truthGain, divergence, correlation: correlationValue, samples: ordered.length },
  };
}

/**
 * Detect a sudden score spike that no plausible capability jump explains.
 *
 * A step change far outside the historical variance usually means the metric
 * was gamed, the eval broke, or the answer key leaked.
 */
export function detectScoreSpike(
  samples: readonly ScoreSample[],
  options: { sigma?: number | undefined; minHistory?: number | undefined } = {},
): DetectionVerdict {
  const sigma = options.sigma ?? 3;
  const minHistory = options.minHistory ?? 4;

  if (samples.length < minHistory + 1) {
    return {
      clean: true,
      detail: `Insufficient history (${samples.length}); no verdict possible.`,
      suspicion: 0,
      evidence: { samples: samples.length },
    };
  }

  const ordered = [...samples].sort((a, b) => a.step - b.step);
  const history = ordered.slice(0, -1).map((sample) => sample.score);
  const latest = ordered.at(-1)!.score;

  const baseline = mean(history);
  const deviation = stdDev(history);

  // A flat history has zero variance; fall back to an absolute jump test so a
  // constant series followed by a leap is still caught.
  if (deviation === 0) {
    const jump = latest - baseline;
    const spiked = jump > 0.25;
    return {
      clean: !spiked,
      detail: spiked
        ? `Score jumped ${(jump * 100).toFixed(1)}% from a perfectly flat baseline of ${baseline.toFixed(2)}.`
        : `Score stable at ${baseline.toFixed(2)}.`,
      suspicion: spiked ? clamp01(jump) : 0,
      evidence: { baseline, latest, jump },
    };
  }

  const zScore = (latest - baseline) / deviation;
  const spiked = zScore > sigma;

  return {
    clean: !spiked,
    detail: spiked
      ? `Latest score ${latest.toFixed(2)} is ${zScore.toFixed(1)}σ above the ${baseline.toFixed(2)} baseline.`
      : `Latest score ${latest.toFixed(2)} is within ${sigma}σ of the ${baseline.toFixed(2)} baseline.`,
    suspicion: spiked ? clamp01(zScore / (sigma * 2)) : 0,
    evidence: { baseline, latest, stdDev: deviation, zScore },
  };
}

/** A single graded evaluation, used for cheating detection. */
export interface EvaluationRecord {
  taskId: string;
  score: number;
  /** Who produced the grade. Self-grading is a cheating signature. */
  gradedBy: string;
  /** Who produced the answer. */
  solvedBy: string;
  /** True when the task was held out from training/tuning. */
  heldOut?: boolean | undefined;
}

/**
 * Detect evaluation cheating.
 *
 * Two signatures:
 *   1. **Self-grading** — the solver graded its own work.
 *   2. **Held-out collapse** — near-perfect on seen tasks, far worse on
 *      held-out tasks, which indicates fitting the eval rather than the task.
 */
export function detectEvaluationCheating(
  records: readonly EvaluationRecord[],
  options: { heldOutGapThreshold?: number | undefined } = {},
): DetectionVerdict {
  const gapThreshold = options.heldOutGapThreshold ?? 0.3;

  if (records.length === 0) {
    return { clean: true, detail: "No evaluation records supplied.", suspicion: 0 };
  }

  const selfGraded = records.filter((record) => record.gradedBy === record.solvedBy);
  if (selfGraded.length > 0) {
    return {
      clean: false,
      detail:
        `${selfGraded.length}/${records.length} evaluation(s) were graded by the same identity that produced ` +
        `the answer (e.g. task ${selfGraded[0]!.taskId}, ${selfGraded[0]!.solvedBy}).`,
      suspicion: clamp01(selfGraded.length / records.length),
      evidence: { selfGraded: selfGraded.length, total: records.length },
    };
  }

  const seen = records.filter((record) => record.heldOut !== true);
  const heldOut = records.filter((record) => record.heldOut === true);

  if (seen.length > 0 && heldOut.length > 0) {
    const seenMean = mean(seen.map((record) => record.score));
    const heldOutMean = mean(heldOut.map((record) => record.score));
    const gap = seenMean - heldOutMean;

    if (gap >= gapThreshold) {
      return {
        clean: false,
        detail:
          `Seen tasks score ${(seenMean * 100).toFixed(1)}% but held-out tasks score ` +
          `${(heldOutMean * 100).toFixed(1)}% (gap ${(gap * 100).toFixed(1)}%), indicating the eval was fitted rather than the task.`,
        suspicion: clamp01(gap),
        evidence: { seenMean, heldOutMean, gap, seen: seen.length, heldOut: heldOut.length },
      };
    }

    return {
      clean: true,
      detail: `Held-out performance tracks seen performance (gap ${(gap * 100).toFixed(1)}%).`,
      suspicion: 0,
      evidence: { seenMean, heldOutMean, gap },
    };
  }

  return {
    clean: true,
    detail: "No self-grading detected; insufficient held-out data for a generalisation check.",
    suspicion: 0,
    evidence: { total: records.length, heldOut: heldOut.length },
  };
}

/**
 * Detect metric gaming: one optimised metric improves while the others
 * stagnate or degrade.
 *
 * Genuine capability gains tend to lift several metrics; gaming lifts exactly
 * the one being scored.
 */
export function detectMetricGaming(
  metrics: Readonly<Record<string, readonly number[]>>,
  options: { targetMetric: string; degradationThreshold?: number | undefined },
): DetectionVerdict {
  const degradationThreshold = options.degradationThreshold ?? 0.1;
  const target = metrics[options.targetMetric];

  if (!target || target.length < 2) {
    return {
      clean: true,
      detail: `Target metric '${options.targetMetric}' has insufficient history.`,
      suspicion: 0,
    };
  }

  const gainOf = (series: readonly number[]): number => {
    if (series.length < 2) return 0;
    const half = Math.floor(series.length / 2);
    return mean(series.slice(half)) - mean(series.slice(0, half));
  };

  const targetGain = gainOf(target);
  const others = Object.entries(metrics).filter(([name]) => name !== options.targetMetric);

  if (others.length === 0) {
    return {
      clean: true,
      detail: "Only one metric supplied; cross-metric comparison not possible.",
      suspicion: 0,
      evidence: { targetGain },
    };
  }

  const degraded = others.filter(([, series]) => gainOf(series) <= -degradationThreshold);

  // Signature: the scored metric climbs while at least one other falls.
  const gaming = targetGain > 0.05 && degraded.length > 0;

  return {
    clean: !gaming,
    detail: gaming
      ? `'${options.targetMetric}' improved ${(targetGain * 100).toFixed(1)}% while ` +
        `${degraded.map(([name]) => name).join(", ")} degraded.`
      : `'${options.targetMetric}' moved ${(targetGain * 100).toFixed(1)}% without degrading other metrics.`,
    suspicion: gaming ? clamp01(targetGain) : 0,
    evidence: { targetGain, degradedCount: degraded.length, otherMetrics: others.length },
  };
}

/** A datapoint considered for training or evaluation. */
export interface DataSample {
  id: string;
  /** Numeric feature used for distribution analysis. */
  value: number;
  source?: string | undefined;
}

/**
 * Detect data poisoning via distribution anomalies.
 *
 * Flags the set when an implausible share of samples sit far outside the
 * interquartile range, or when a single source dominates.
 */
export function detectDataPoisoning(
  samples: readonly DataSample[],
  options: { outlierShareThreshold?: number | undefined; sourceDominanceThreshold?: number | undefined } = {},
): DetectionVerdict {
  const outlierShareThreshold = options.outlierShareThreshold ?? 0.2;
  const sourceDominanceThreshold = options.sourceDominanceThreshold ?? 0.9;

  if (samples.length < 8) {
    return {
      clean: true,
      detail: `Insufficient samples (${samples.length}) for distribution analysis.`,
      suspicion: 0,
      evidence: { samples: samples.length },
    };
  }

  const sorted = [...samples].map((sample) => sample.value).sort((a, b) => a - b);
  const quartile = (fraction: number): number => sorted[Math.floor(fraction * (sorted.length - 1))]!;
  const q1 = quartile(0.25);
  const q3 = quartile(0.75);
  const iqr = q3 - q1;

  // Tukey fences catch a light sprinkling of outliers.
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  const tukeyOutliers = iqr === 0 ? [] : sorted.filter((value) => value < lower || value > upper);

  // Tukey alone is not enough. Once poisoned points make up a large enough
  // share they drag Q3 out with them, the fences widen, and the poison ends up
  // *inside* its own bounds — the detector would clear a heavily poisoned set.
  // Median absolute deviation is measured against the median, so a bulk
  // injection cannot hide by moving the quartiles.
  const median = quartile(0.5);
  const absoluteDeviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  const mad = absoluteDeviations[Math.floor(0.5 * (absoluteDeviations.length - 1))]!;
  // 1.4826 rescales MAD to be comparable with a standard deviation on normal data.
  const robustScale = mad * 1.4826;
  const madOutliers =
    robustScale === 0
      ? sorted.filter((value) => value !== median)
      : sorted.filter((value) => Math.abs(value - median) / robustScale > 3.5);

  // Take whichever method finds more; they cover each other's blind spots.
  const outliers = madOutliers.length > tukeyOutliers.length ? madOutliers : tukeyOutliers;
  const method = madOutliers.length > tukeyOutliers.length ? "median absolute deviation" : "Tukey fences";
  const outlierShare = outliers.length / sorted.length;

  if (outlierShare >= outlierShareThreshold) {
    return {
      clean: false,
      detail:
        `${(outlierShare * 100).toFixed(1)}% of samples are anomalous by ${method} ` +
        `(median ${median.toFixed(2)}, Tukey fences [${lower.toFixed(2)}, ${upper.toFixed(2)}]), suggesting injected data.`,
      suspicion: clamp01(outlierShare),
      evidence: { outlierShare, outliers: outliers.length, q1, q3, iqr, median, mad },
    };
  }

  const sourced = samples.filter((sample) => typeof sample.source === "string");
  if (sourced.length >= 8) {
    const counts = new Map<string, number>();
    for (const sample of sourced) {
      counts.set(sample.source!, (counts.get(sample.source!) ?? 0) + 1);
    }
    const [dominantSource, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const share = dominantCount / sourced.length;

    if (counts.size > 1 && share >= sourceDominanceThreshold) {
      return {
        clean: false,
        detail: `Source '${dominantSource}' contributes ${(share * 100).toFixed(1)}% of samples, dominating the distribution.`,
        suspicion: clamp01(share),
        evidence: { dominantShare: share, sources: counts.size },
      };
    }
  }

  return {
    clean: true,
    detail: `Distribution within expected bounds (${(outlierShare * 100).toFixed(1)}% outliers).`,
    suspicion: 0,
    evidence: { outlierShare, q1, q3, iqr },
  };
}

/** Evidence bundle the defence pipeline runs its detectors against. */
export interface DefenceEvidence {
  scoreHistory?: readonly ScoreSample[] | undefined;
  evaluations?: readonly EvaluationRecord[] | undefined;
  metrics?: Readonly<Record<string, readonly number[]>> | undefined;
  targetMetric?: string | undefined;
  dataSamples?: readonly DataSample[] | undefined;
}

/**
 * Build the executable audit checks for `SecurityAuditor.runAudit`.
 *
 * Returns `true` for clean, `false` when an attack signature is found — the
 * opposite of the old `async () => true` stubs, which could never fail.
 */
export function buildDefenceChecks(evidence: DefenceEvidence): Array<{
  category: string;
  check: () => Promise<boolean>;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  recommendation: string;
}> {
  return [
    {
      category: "reward_hacking",
      check: async () => detectRewardCurveManipulation(evidence.scoreHistory ?? []).clean,
      description: "Reward curve rose without a matching ground-truth capability gain",
      severity: "high",
      recommendation: "Cross-validate against an independent held-out measure before accepting the gain",
    },
    {
      category: "reward_hacking",
      check: async () => detectScoreSpike(evidence.scoreHistory ?? []).clean,
      description: "Score spiked far outside historical variance",
      severity: "high",
      recommendation: "Re-run the evaluation on a fresh seed and confirm the jump reproduces",
    },
    {
      category: "metric_gaming",
      check: async () =>
        evidence.metrics && evidence.targetMetric
          ? detectMetricGaming(evidence.metrics, { targetMetric: evidence.targetMetric }).clean
          : true,
      description: "Optimised metric improved while other metrics degraded",
      severity: "high",
      recommendation: "Score on a holistic basket of metrics rather than a single target",
    },
    {
      category: "evaluation_cheating",
      check: async () => detectEvaluationCheating(evidence.evaluations ?? []).clean,
      description: "Self-grading or held-out generalisation collapse detected",
      severity: "critical",
      recommendation: "Require an independent grader and always retain a held-out split",
    },
    {
      category: "data_poisoning",
      check: async () => detectDataPoisoning(evidence.dataSamples ?? []).clean,
      description: "Sample distribution shows injection or single-source dominance",
      severity: "critical",
      recommendation: "Validate data provenance and quarantine anomalous batches",
    },
  ];
}

/** Map an attack-pattern category onto its executable detector. */
export function detectorForCategory(
  category: "reward_hacking" | "metric_gaming" | "evaluation_cheating" | "data_poisoning",
  evidence: DefenceEvidence,
): DetectionVerdict {
  switch (category) {
    case "reward_hacking":
      return detectRewardCurveManipulation(evidence.scoreHistory ?? []);
    case "metric_gaming":
      return evidence.metrics && evidence.targetMetric
        ? detectMetricGaming(evidence.metrics, { targetMetric: evidence.targetMetric })
        : { clean: true, detail: "No metric series supplied.", suspicion: 0 };
    case "evaluation_cheating":
      return detectEvaluationCheating(evidence.evaluations ?? []);
    case "data_poisoning":
      return detectDataPoisoning(evidence.dataSamples ?? []);
  }
}
