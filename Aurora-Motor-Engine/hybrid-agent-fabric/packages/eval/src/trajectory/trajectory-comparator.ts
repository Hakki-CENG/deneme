/**
 * Trajectory Comparator
 * Compares trajectories to measure improvement over time.
 */

import type {
  Trajectory,
  TrajectoryComparison,
  TrajectoryAnalysis,
} from "./types.js";
import { TrajectoryAnalyzer } from "./trajectory-analyzer.js";

export class TrajectoryComparator {
  private analyzer = new TrajectoryAnalyzer();

  /** Compare two trajectories */
  compare(a: Trajectory, b: Trajectory): TrajectoryComparison {
    const analysisA = this.analyzer.analyze(a);
    const analysisB = this.analyzer.analyze(b);

    const stepDelta = b.events.length - a.events.length;
    const tokenDelta = b.totalTokens - a.totalTokens;
    const costDelta = b.totalCostUsd - a.totalCostUsd;
    const timeDelta = b.durationMs - a.durationMs;
    const qualityDelta = analysisB.qualityScore - analysisA.qualityScore;

    // Find steps only in each
    const kindsA = new Set(a.events.map(e => e.kind));
    const kindsB = new Set(b.events.map(e => e.kind));
    const onlyInA = [...kindsA].filter(k => !kindsB.has(k));
    const onlyInB = [...kindsB].filter(k => !kindsA.has(k));
    const common = [...kindsA].filter(k => kindsB.has(k));

    // Determine which is better
    let better: "A" | "B" | "equal" = "equal";
    const scoreA = this.calculateOverallScore(a, analysisA);
    const scoreB = this.calculateOverallScore(b, analysisB);
    if (scoreB > scoreA * 1.1) better = "B";
    else if (scoreA > scoreB * 1.1) better = "A";

    const explanation = this.generateExplanation(a, b, analysisA, analysisB, {
      stepDelta, tokenDelta, costDelta, timeDelta, qualityDelta, better,
    });

    return {
      trajectoryA: a.id,
      trajectoryB: b.id,
      stepDelta,
      tokenDelta,
      costDelta,
      timeDelta,
      qualityDelta,
      onlyInA,
      onlyInB,
      common,
      better,
      explanation,
    };
  }

  /** Calculate overall score for ranking */
  private calculateOverallScore(trajectory: Trajectory, analysis: TrajectoryAnalysis): number {
    let score = analysis.qualityScore * 100;

    // Bonus for success
    if (trajectory.outcome === "success") score += 20;

    // Penalty for high cost
    if (trajectory.totalCostUsd > 0.1) score -= 10;
    if (trajectory.totalCostUsd > 0.5) score -= 20;

    // Penalty for high token usage
    if (trajectory.totalTokens > 100000) score -= 10;

    // Penalty for long duration
    if (trajectory.durationMs > 120000) score -= 10;

    // Bonus for efficiency
    if (analysis.tokenEfficiency < 1000) score += 10;
    if (analysis.timeEfficiency < 10000) score += 10;

    return score;
  }

  /** Generate human-readable explanation */
  private generateExplanation(
    a: Trajectory,
    b: Trajectory,
    analysisA: TrajectoryAnalysis,
    analysisB: TrajectoryAnalysis,
    deltas: {
      stepDelta: number;
      tokenDelta: number;
      costDelta: number;
      timeDelta: number;
      qualityDelta: number;
      better: "A" | "B" | "equal";
    },
  ): string {
    const parts: string[] = [];

    if (deltas.better === "B") {
      parts.push(`Trajectory B is better.`);
    } else if (deltas.better === "A") {
      parts.push(`Trajectory A is better.`);
    } else {
      parts.push(`Both trajectories are roughly equivalent.`);
    }

    if (deltas.stepDelta !== 0) {
      parts.push(`B uses ${Math.abs(deltas.stepDelta)} ${deltas.stepDelta > 0 ? "more" : "fewer"} steps.`);
    }

    if (deltas.tokenDelta !== 0) {
      const pct = a.totalTokens > 0 ? Math.abs(deltas.tokenDelta / a.totalTokens * 100).toFixed(0) : "N/A";
      parts.push(`B uses ${pct}% ${deltas.tokenDelta > 0 ? "more" : "fewer"} tokens.`);
    }

    if (deltas.qualityDelta > 0.1) {
      parts.push(`B has significantly higher quality (${analysisB.qualityScore.toFixed(2)} vs ${analysisA.qualityScore.toFixed(2)}).`);
    } else if (deltas.qualityDelta < -0.1) {
      parts.push(`A has significantly higher quality (${analysisA.qualityScore.toFixed(2)} vs ${analysisB.qualityScore.toFixed(2)}).`);
    }

    if (analysisB.suggestions.length < analysisA.suggestions.length) {
      parts.push(`B has fewer improvement suggestions.`);
    }

    return parts.join(" ");
  }
}
