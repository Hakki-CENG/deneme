/**
 * Eval Integration
 * Wires the eval system to the engine's cognitive services.
 * Creates the self-improvement loop: eval → trajectory → analysis → improvement.
 */

import type { HybridAgentEngine } from "@haf/engine";
import type { EvalSuiteResult, EvalResult, TaskMetrics } from "../tasks/types.js";
import { TrajectoryAnalyzer } from "../trajectory/trajectory-analyzer.js";
import { TrajectoryStore } from "../trajectory/trajectory-store.js";
import { TrajectoryComparator } from "../trajectory/trajectory-comparator.js";
import type { Trajectory, TrajectoryAnalysis } from "../trajectory/types.js";

/** Self-improvement recommendation */
export interface ImprovementRecommendation {
  /** Category: cognitive, tool, memory, planning, etc. */
  category: string;
  /** Priority: critical, high, medium, low */
  priority: "critical" | "high" | "medium" | "low";
  /** What needs to improve */
  finding: string;
  /** Specific action to take */
  action: string;
  /** Expected impact */
  impact: string;
  /** Evidence from eval results */
  evidence: string[];
}

/** Self-improvement report */
export interface SelfImprovementReport {
  /** Report timestamp */
  timestamp: string;
  /** Overall score 0-1 */
  overallScore: number;
  /** Score by category */
  scoresByCategory: Record<string, number>;
  /** Improvement from last run */
  improvementDelta: number;
  /** Recommendations */
  recommendations: ImprovementRecommendation[];
  /** Cognitive service health */
  serviceHealth: Record<string, { status: "healthy" | "degraded" | "unhealthy"; details: string }>;
  /** Trajectory quality trends */
  trajectoryTrends: { category: string; trend: "improving" | "stable" | "declining"; details: string }[];
}

export class EvalIntegration {
  private analyzer = new TrajectoryAnalyzer();
  private comparator = new TrajectoryComparator();

  constructor(
    private store: TrajectoryStore,
  ) {}

  /** Generate a self-improvement report from eval results */
  async generateReport(
    suiteResult: EvalSuiteResult,
    previousResult?: EvalSuiteResult,
  ): Promise<SelfImprovementReport> {
    const scoresByCategory = this.calculateCategoryScores(suiteResult);
    const overallScore = suiteResult.overallScore;
    const improvementDelta = previousResult
      ? overallScore - previousResult.overallScore
      : 0;

    // Analyze trajectories for each task
    const trajectoryAnalyses: TrajectoryAnalysis[] = [];
    for (const result of suiteResult.results) {
      const trajectories = await this.store.listByTask(result.taskId);
      if (trajectories.length > 0) {
        const latest = trajectories[trajectories.length - 1];
        if (latest) {
          trajectoryAnalyses.push(this.analyzer.analyze(latest));
        }
      }
    }

    const recommendations = this.generateRecommendations(suiteResult, trajectoryAnalyses, scoresByCategory);
    const serviceHealth = this.checkServiceHealth(suiteResult);
    const trajectoryTrends = this.analyzeTrends(trajectoryAnalyses);

    return {
      timestamp: new Date().toISOString(),
      overallScore,
      scoresByCategory,
      improvementDelta,
      recommendations,
      serviceHealth,
      trajectoryTrends,
    };
  }

  /** Calculate scores by category */
  private calculateCategoryScores(result: EvalSuiteResult): Record<string, number> {
    const byCategory = new Map<string, { total: number; passed: number }>();

    for (const r of result.results) {
      const task = r.taskId.split("-")[0] ?? "unknown";
      const existing = byCategory.get(task) ?? { total: 0, passed: 0 };
      existing.total++;
      if (r.status === "pass") existing.passed++;
      byCategory.set(task, existing);
    }

    const scores: Record<string, number> = {};
    for (const [category, stats] of byCategory) {
      scores[category] = stats.total > 0 ? stats.passed / stats.total : 0;
    }
    return scores;
  }

  /** Generate improvement recommendations */
  private generateRecommendations(
    suiteResult: EvalSuiteResult,
    analyses: TrajectoryAnalysis[],
    scoresByCategory: Record<string, number>,
  ): ImprovementRecommendation[] {
    const recommendations: ImprovementRecommendation[] = [];

    // Check for low-scoring categories
    for (const [category, score] of Object.entries(scoresByCategory)) {
      if (score < 0.5) {
        recommendations.push({
          category,
          priority: "critical",
          finding: `${category} pass rate is ${(score * 100).toFixed(0)}%`,
          action: `Focus on improving ${category} capabilities — run targeted evals and analyze failures`,
          impact: `Could improve overall score by up to ${((1 - score) * 0.3 * 100).toFixed(0)}%`,
          evidence: suiteResult.results
            .filter(r => r.taskId.startsWith(category) && r.status !== "pass")
            .map(r => `${r.taskId}: ${r.error ?? "failed"}`),
        });
      } else if (score < 0.8) {
        recommendations.push({
          category,
          priority: "high",
          finding: `${category} pass rate is ${(score * 100).toFixed(0)}% — room for improvement`,
          action: `Analyze failing ${category} tasks and address root causes`,
          impact: `Could improve overall score by up to ${((1 - score) * 0.2 * 100).toFixed(0)}%`,
          evidence: suiteResult.results
            .filter(r => r.taskId.startsWith(category) && r.status !== "pass")
            .slice(0, 3)
            .map(r => `${r.taskId}: ${r.error ?? "failed"}`),
        });
      }
    }

    // Check trajectory quality
    const lowQuality = analyses.filter(a => a.qualityScore < 0.5);
    if (lowQuality.length > 0) {
      recommendations.push({
        category: "trajectory",
        priority: "high",
        finding: `${lowQuality.length} trajectories have quality score below 0.5`,
        action: "Improve task execution patterns — add verification, reduce errors, use memory",
        impact: "Higher quality trajectories correlate with better task outcomes",
        evidence: lowQuality.map(a => `Trajectory ${a.trajectoryId}: score ${a.qualityScore.toFixed(2)}`),
      });
    }

    // Check for common negative patterns
    const allPatterns = analyses.flatMap(a => a.patterns);
    const negativePatterns = allPatterns.filter(p => p.sentiment === "negative");
    const patternCounts = new Map<string, number>();
    for (const p of negativePatterns) {
      patternCounts.set(p.id, (patternCounts.get(p.id) ?? 0) + p.occurrences);
    }

    for (const [patternId, count] of patternCounts) {
      if (count >= 3) {
        const pattern = negativePatterns.find(p => p.id === patternId);
        if (pattern) {
          recommendations.push({
            category: "pattern",
            priority: "medium",
            finding: `Pattern "${pattern.name}" detected ${count} times`,
            action: `Address: ${pattern.description}`,
            impact: "Eliminating negative patterns improves reliability",
            evidence: [`Pattern: ${pattern.name} — ${pattern.description}`],
          });
        }
      }
    }

    // Check for high token usage
    const highTokenTasks = suiteResult.results.filter(r => r.metrics.totalTokens > 100000);
    if (highTokenTasks.length > 0) {
      recommendations.push({
        category: "efficiency",
        priority: "medium",
        finding: `${highTokenTasks.length} tasks used over 100K tokens`,
        action: "Optimize prompts and reduce unnecessary steps to lower token usage",
        impact: "Lower token usage reduces cost and improves response time",
        evidence: highTokenTasks.map(r => `${r.taskId}: ${r.metrics.totalTokens.toLocaleString()} tokens`),
      });
    }

    // Sort by priority
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return recommendations;
  }

  /** Check cognitive service health based on eval results */
  private checkServiceHealth(
    suiteResult: EvalSuiteResult,
  ): Record<string, { status: "healthy" | "degraded" | "unhealthy"; details: string }> {
    const health: Record<string, { status: "healthy" | "degraded" | "unhealthy"; details: string }> = {};

    // Memory service health
    const memoryResults = suiteResult.results.filter(r => r.taskId.startsWith("memory"));
    const memoryPassRate = memoryResults.length > 0
      ? memoryResults.filter(r => r.status === "pass").length / memoryResults.length
      : 1;
    health["memory"] = {
      status: memoryPassRate >= 0.8 ? "healthy" : memoryPassRate >= 0.5 ? "degraded" : "unhealthy",
      details: `${(memoryPassRate * 100).toFixed(0)}% pass rate on memory tasks`,
    };

    // Planning service health
    const planningResults = suiteResult.results.filter(r => r.taskId.startsWith("planning"));
    const planningPassRate = planningResults.length > 0
      ? planningResults.filter(r => r.status === "pass").length / planningResults.length
      : 1;
    health["planning"] = {
      status: planningPassRate >= 0.8 ? "healthy" : planningPassRate >= 0.5 ? "degraded" : "unhealthy",
      details: `${(planningPassRate * 100).toFixed(0)}% pass rate on planning tasks`,
    };

    // Reasoning service health
    const reasoningResults = suiteResult.results.filter(r => r.taskId.startsWith("reasoning"));
    const reasoningPassRate = reasoningResults.length > 0
      ? reasoningResults.filter(r => r.status === "pass").length / reasoningResults.length
      : 1;
    health["reasoning"] = {
      status: reasoningPassRate >= 0.8 ? "healthy" : reasoningPassRate >= 0.5 ? "degraded" : "unhealthy",
      details: `${(reasoningPassRate * 100).toFixed(0)}% pass rate on reasoning tasks`,
    };

    // Security service health
    const securityResults = suiteResult.results.filter(r => r.taskId.startsWith("security"));
    const securityPassRate = securityResults.length > 0
      ? securityResults.filter(r => r.status === "pass").length / securityResults.length
      : 1;
    health["security"] = {
      status: securityPassRate >= 0.9 ? "healthy" : securityPassRate >= 0.7 ? "degraded" : "unhealthy",
      details: `${(securityPassRate * 100).toFixed(0)}% pass rate on security tasks`,
    };

    // Tool use service health
    const toolResults = suiteResult.results.filter(r => r.taskId.startsWith("tool"));
    const toolPassRate = toolResults.length > 0
      ? toolResults.filter(r => r.status === "pass").length / toolResults.length
      : 1;
    health["tool_use"] = {
      status: toolPassRate >= 0.8 ? "healthy" : toolPassRate >= 0.5 ? "degraded" : "unhealthy",
      details: `${(toolPassRate * 100).toFixed(0)}% pass rate on tool use tasks`,
    };

    // Coding service health
    const codingResults = suiteResult.results.filter(r => r.taskId.startsWith("coding"));
    const codingPassRate = codingResults.length > 0
      ? codingResults.filter(r => r.status === "pass").length / codingResults.length
      : 1;
    health["coding"] = {
      status: codingPassRate >= 0.8 ? "healthy" : codingPassRate >= 0.5 ? "degraded" : "unhealthy",
      details: `${(codingPassRate * 100).toFixed(0)}% pass rate on coding tasks`,
    };

    return health;
  }

  /** Analyze trajectory quality trends */
  private analyzeTrends(
    analyses: TrajectoryAnalysis[],
  ): { category: string; trend: "improving" | "stable" | "declining"; details: string }[] {
    const trends: { category: string; trend: "improving" | "stable" | "declining"; details: string }[] = [];

    if (analyses.length < 2) {
      trends.push({
        category: "overall",
        trend: "stable",
        details: "Not enough data for trend analysis",
      });
      return trends;
    }

    // Compare first half vs second half
    const mid = Math.floor(analyses.length / 2);
    const firstHalf = analyses.slice(0, mid);
    const secondHalf = analyses.slice(mid);

    const avgQualityFirst = firstHalf.reduce((sum, a) => sum + a.qualityScore, 0) / firstHalf.length;
    const avgQualitySecond = secondHalf.reduce((sum, a) => sum + a.qualityScore, 0) / secondHalf.length;

    const qualityDelta = avgQualitySecond - avgQualityFirst;
    if (qualityDelta > 0.1) {
      trends.push({
        category: "quality",
        trend: "improving",
        details: `Quality improved from ${avgQualityFirst.toFixed(2)} to ${avgQualitySecond.toFixed(2)}`,
      });
    } else if (qualityDelta < -0.1) {
      trends.push({
        category: "quality",
        trend: "declining",
        details: `Quality declined from ${avgQualityFirst.toFixed(2)} to ${avgQualitySecond.toFixed(2)}`,
      });
    } else {
      trends.push({
        category: "quality",
        trend: "stable",
        details: `Quality stable at ${avgQualitySecond.toFixed(2)}`,
      });
    }

    // Token efficiency trend
    const avgTokensFirst = firstHalf.reduce((sum, a) => sum + a.tokenEfficiency, 0) / firstHalf.length;
    const avgTokensSecond = secondHalf.reduce((sum, a) => sum + a.tokenEfficiency, 0) / secondHalf.length;

    if (avgTokensSecond < avgTokensFirst * 0.9) {
      trends.push({
        category: "efficiency",
        trend: "improving",
        details: `Token efficiency improved (lower is better)`,
      });
    } else if (avgTokensSecond > avgTokensFirst * 1.1) {
      trends.push({
        category: "efficiency",
        trend: "declining",
        details: `Token efficiency declined (higher token usage per step)`,
      });
    }

    return trends;
  }

  /** Format report as markdown */
  formatReport(report: SelfImprovementReport): string {
    const lines: string[] = [];

    lines.push("# Aurora Self-Improvement Report");
    lines.push("");
    lines.push(`**Generated:** ${report.timestamp}`);
    lines.push(`**Overall Score:** ${(report.overallScore * 100).toFixed(1)}%`);
    if (report.improvementDelta !== 0) {
      const delta = report.improvementDelta > 0 ? `+${(report.improvementDelta * 100).toFixed(1)}` : (report.improvementDelta * 100).toFixed(1);
      lines.push(`**Improvement:** ${delta}%`);
    }
    lines.push("");

    // Scores by category
    lines.push("## Scores by Category");
    lines.push("");
    lines.push("| Category | Score | Status |");
    lines.push("|----------|-------|--------|");
    for (const [category, score] of Object.entries(report.scoresByCategory).sort((a, b) => b[1] - a[1])) {
      const status = score >= 0.8 ? "✅" : score >= 0.5 ? "⚠️" : "❌";
      lines.push(`| ${category} | ${(score * 100).toFixed(0)}% | ${status} |`);
    }
    lines.push("");

    // Service health
    lines.push("## Cognitive Service Health");
    lines.push("");
    lines.push("| Service | Status | Details |");
    lines.push("|---------|--------|---------|");
    for (const [service, health] of Object.entries(report.serviceHealth)) {
      const icon = health.status === "healthy" ? "🟢" : health.status === "degraded" ? "🟡" : "🔴";
      lines.push(`| ${service} | ${icon} ${health.status} | ${health.details} |`);
    }
    lines.push("");

    // Recommendations
    if (report.recommendations.length > 0) {
      lines.push("## Recommendations");
      lines.push("");
      for (const rec of report.recommendations) {
        const icon = rec.priority === "critical" ? "🔴" : rec.priority === "high" ? "🟠" : rec.priority === "medium" ? "🟡" : "🟢";
        lines.push(`### ${icon} ${rec.finding}`);
        lines.push(`- **Category:** ${rec.category}`);
        lines.push(`- **Action:** ${rec.action}`);
        lines.push(`- **Impact:** ${rec.impact}`);
        if (rec.evidence.length > 0) {
          lines.push(`- **Evidence:**`);
          for (const e of rec.evidence.slice(0, 3)) {
            lines.push(`  - ${e}`);
          }
        }
        lines.push("");
      }
    }

    // Trajectory trends
    if (report.trajectoryTrends.length > 0) {
      lines.push("## Trajectory Trends");
      lines.push("");
      for (const trend of report.trajectoryTrends) {
        const icon = trend.trend === "improving" ? "📈" : trend.trend === "declining" ? "📉" : "➡️";
        lines.push(`- ${icon} **${trend.category}:** ${trend.details}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
