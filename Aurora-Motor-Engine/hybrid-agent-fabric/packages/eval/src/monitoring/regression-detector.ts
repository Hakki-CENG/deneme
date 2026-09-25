/**
 * Regression Detector
 * Compares eval runs and detects regressions (score drops).
 * 
 * Features:
 *   - Detects overall score regressions
 *   - Identifies category-level regressions
 *   - Tracks individual task regressions
 *   - Severity classification (critical/high/medium/low)
 *   - Historical trend analysis
 *   - Alert generation
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let RESULTS_DIR: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  RESULTS_DIR = resolve(__dirname, "../../results");
} catch {
  RESULTS_DIR = resolve(process.cwd(), "packages/eval/results");
}

export interface EvalRunSummary {
  timestamp: string;
  totalTasks: number;
  passed: number;
  failed: number;
  errors: number;
  overallScore: number;
  durationMs: number;
  results: { taskId: string; status: string; score: number; category?: string }[];
  trajectoriesSaved?: number;
}

export interface Regression {
  /** What regressed */
  type: "overall" | "category" | "task";
  /** Severity level */
  severity: "critical" | "high" | "medium" | "low";
  /** Category or task ID */
  area: string;
  /** Previous score */
  previousScore: number;
  /** Current score */
  currentScore: number;
  /** Score drop */
  delta: number;
  /** Human-readable description */
  description: string;
  /** Affected tasks */
  affectedTasks: string[];
}

export interface RegressionReport {
  timestamp: string;
  currentRun: string;
  previousRun: string;
  /** Whether any regressions were detected */
  hasRegressions: boolean;
  /** Overall score change */
  overallDelta: number;
  /** Detected regressions */
  regressions: Regression[];
  /** Improvements detected */
  improvements: Regression[];
  /** Summary statistics */
  stats: {
    totalRegressions: number;
    criticalRegressions: number;
    highRegressions: number;
    mediumRegressions: number;
    lowRegressions: number;
    totalImprovements: number;
  };
  /** Trend over last N runs */
  trend: "improving" | "stable" | "declining";
  /** Trend details */
  trendDetails: string;
}

/** Load all eval runs sorted by timestamp */
async function loadEvalRuns(): Promise<EvalRunSummary[]> {
  const runs: EvalRunSummary[] = [];
  try {
    const files = await readdir(RESULTS_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await readFile(join(RESULTS_DIR, file), "utf-8");
        const data = JSON.parse(content);
        if (data.totalTasks !== undefined && data.overallScore !== undefined) {
          runs.push(data);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  runs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return runs;
}

/**
 * Compare two eval runs and detect regressions.
 */
export function detectRegressions(
  current: EvalRunSummary,
  previous: EvalRunSummary,
): RegressionReport {
  const regressions: Regression[] = [];
  const improvements: Regression[] = [];

  // Overall score regression
  const overallDelta = current.overallScore - previous.overallScore;
  if (overallDelta < -0.01) {
    regressions.push({
      type: "overall",
      severity: overallDelta < -0.2 ? "critical" : overallDelta < -0.1 ? "high" : overallDelta < -0.05 ? "medium" : "low",
      area: "overall",
      previousScore: previous.overallScore,
      currentScore: current.overallScore,
      delta: overallDelta,
      description: `Overall score dropped from ${(previous.overallScore * 100).toFixed(1)}% to ${(current.overallScore * 100).toFixed(1)}%`,
      affectedTasks: [],
    });
  } else if (overallDelta > 0.01) {
    improvements.push({
      type: "overall",
      severity: "low",
      area: "overall",
      previousScore: previous.overallScore,
      currentScore: current.overallScore,
      delta: overallDelta,
      description: `Overall score improved from ${(previous.overallScore * 100).toFixed(1)}% to ${(current.overallScore * 100).toFixed(1)}%`,
      affectedTasks: [],
    });
  }

  // Category-level comparison
  const currentByCategory = groupByCategory(current.results);
  const previousByCategory = groupByCategory(previous.results);

  for (const [category, currentStats] of currentByCategory) {
    const previousStats = previousByCategory.get(category);
    if (!previousStats) continue;

    const currentRate = currentStats.total > 0 ? currentStats.passed / currentStats.total : 0;
    const previousRate = previousStats.total > 0 ? previousStats.passed / previousStats.total : 0;
    const delta = currentRate - previousRate;

    if (delta < -0.01) {
      // Find which tasks regressed
      const regressedTasks = findRegressedTasks(current, previous, category);

      regressions.push({
        type: "category",
        severity: delta < -0.5 ? "critical" : delta < -0.3 ? "high" : delta < -0.1 ? "medium" : "low",
        area: category,
        previousScore: previousRate,
        currentScore: currentRate,
        delta,
        description: `${category} dropped from ${(previousRate * 100).toFixed(0)}% to ${(currentRate * 100).toFixed(0)}% (${regressedTasks.length} tasks regressed)`,
        affectedTasks: regressedTasks,
      });
    } else if (delta > 0.01) {
      improvements.push({
        type: "category",
        severity: "low",
        area: category,
        previousScore: previousRate,
        currentScore: currentRate,
        delta,
        description: `${category} improved from ${(previousRate * 100).toFixed(0)}% to ${(currentRate * 100).toFixed(0)}%`,
        affectedTasks: [],
      });
    }
  }

  // Task-level regressions (tasks that passed before but fail now)
  const currentTaskMap = new Map(current.results.map(r => [r.taskId, r]));
  const previousTaskMap = new Map(previous.results.map(r => [r.taskId, r]));

  for (const [taskId, prevResult] of previousTaskMap) {
    const currResult = currentTaskMap.get(taskId);
    if (!currResult) continue;

    if (prevResult.status === "pass" && currResult.status !== "pass") {
      regressions.push({
        type: "task",
        severity: "medium",
        area: taskId,
        previousScore: prevResult.score,
        currentScore: currResult.score,
        delta: currResult.score - prevResult.score,
        description: `Task ${taskId} regressed: PASS → ${currResult.status.toUpperCase()}`,
        affectedTasks: [taskId],
      });
    } else if (prevResult.status !== "pass" && currResult.status === "pass") {
      improvements.push({
        type: "task",
        severity: "low",
        area: taskId,
        previousScore: prevResult.score,
        currentScore: currResult.score,
        delta: currResult.score - prevResult.score,
        description: `Task ${taskId} improved: ${prevResult.status.toUpperCase()} → PASS`,
        affectedTasks: [taskId],
      });
    }
  }

  // Sort by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  regressions.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  // Calculate stats
  const stats = {
    totalRegressions: regressions.length,
    criticalRegressions: regressions.filter(r => r.severity === "critical").length,
    highRegressions: regressions.filter(r => r.severity === "high").length,
    mediumRegressions: regressions.filter(r => r.severity === "medium").length,
    lowRegressions: regressions.filter(r => r.severity === "low").length,
    totalImprovements: improvements.length,
  };

  // Determine trend
  const trend = regressions.length > 0 ? "declining" : improvements.length > 0 ? "improving" : "stable";
  const trendDetails = trend === "declining"
    ? `${stats.totalRegressions} regressions detected (${stats.criticalRegressions} critical)`
    : trend === "improving"
    ? `${stats.totalImprovements} improvements detected`
    : "No significant changes";

  return {
    timestamp: new Date().toISOString(),
    currentRun: current.timestamp,
    previousRun: previous.timestamp,
    hasRegressions: regressions.length > 0,
    overallDelta,
    regressions,
    improvements,
    stats,
    trend,
    trendDetails,
  };
}

/**
 * Analyze trend over multiple runs.
 */
export function analyzeTrend(runs: EvalRunSummary[], windowSize: number = 5): {
  direction: "improving" | "stable" | "declining";
  details: string;
  scores: number[];
  movingAverage: number[];
} {
  if (runs.length < 2) {
    return { direction: "stable", details: "Not enough data", scores: [], movingAverage: [] };
  }

  const scores = runs.map(r => r.overallScore);

  // Calculate moving average
  const movingAverage: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    const window = scores.slice(Math.max(0, i - windowSize + 1), i + 1);
    const avg = window.reduce((a, b) => a + b, 0) / window.length;
    movingAverage.push(avg);
  }

  // Compare first half vs second half
  const mid = Math.floor(scores.length / 2);
  const firstHalf = scores.slice(0, mid);
  const secondHalf = scores.slice(mid);
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  const delta = avgSecond - avgFirst;

  const direction = delta > 0.05 ? "improving" : delta < -0.05 ? "declining" : "stable";
  const details = direction === "improving"
    ? `Score trending up: ${(avgFirst * 100).toFixed(0)}% → ${(avgSecond * 100).toFixed(0)}%`
    : direction === "declining"
    ? `Score trending down: ${(avgFirst * 100).toFixed(0)}% → ${(avgSecond * 100).toFixed(0)}%`
    : `Score stable at ${(avgSecond * 100).toFixed(0)}%`;

  return { direction, details, scores, movingAverage };
}

/**
 * Generate regression report as markdown.
 */
export function formatRegressionReport(report: RegressionReport): string {
  const lines: string[] = [];

  lines.push("# Regression Detection Report");
  lines.push("");
  lines.push(`**Generated:** ${report.timestamp}`);
  lines.push(`**Current Run:** ${report.currentRun}`);
  lines.push(`**Previous Run:** ${report.previousRun}`);
  lines.push("");

  // Status banner
  if (report.hasRegressions) {
    lines.push(`⚠️ **${report.stats.totalRegressions} REGRESSIONS DETECTED**`);
  } else {
    lines.push("✅ **NO REGRESSIONS DETECTED**");
  }
  lines.push("");

  // Overall change
  const deltaIcon = report.overallDelta > 0 ? "📈" : report.overallDelta < 0 ? "📉" : "➡️";
  lines.push(`**Overall Change:** ${deltaIcon} ${(report.overallDelta * 100).toFixed(1)}%`);
  lines.push(`**Trend:** ${report.trend} — ${report.trendDetails}`);
  lines.push("");

  // Regressions
  if (report.regressions.length > 0) {
    lines.push("## Regressions");
    lines.push("");
    lines.push("| Severity | Area | Previous | Current | Delta | Description |");
    lines.push("|----------|------|----------|---------|-------|-------------|");
    for (const reg of report.regressions) {
      const icon = reg.severity === "critical" ? "🔴" : reg.severity === "high" ? "🟠" : reg.severity === "medium" ? "🟡" : "🟢";
      lines.push(`| ${icon} ${reg.severity} | ${reg.area} | ${(reg.previousScore * 100).toFixed(0)}% | ${(reg.currentScore * 100).toFixed(0)}% | ${(reg.delta * 100).toFixed(1)}% | ${reg.description} |`);
    }
    lines.push("");

    // Affected tasks detail
    const criticalRegressions = report.regressions.filter(r => r.severity === "critical" || r.severity === "high");
    if (criticalRegressions.length > 0) {
      lines.push("### Critical/High Regression Details");
      lines.push("");
      for (const reg of criticalRegressions) {
        if (reg.affectedTasks.length > 0) {
          lines.push(`**${reg.area}:**`);
          for (const task of reg.affectedTasks) {
            lines.push(`  - ${task}`);
          }
          lines.push("");
        }
      }
    }
  }

  // Improvements
  if (report.improvements.length > 0) {
    lines.push("## Improvements");
    lines.push("");
    for (const imp of report.improvements) {
      lines.push(`- ✅ ${imp.description}`);
    }
    lines.push("");
  }

  // Stats summary
  lines.push("## Summary Statistics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total Regressions | ${report.stats.totalRegressions} |`);
  lines.push(`| Critical | ${report.stats.criticalRegressions} |`);
  lines.push(`| High | ${report.stats.highRegressions} |`);
  lines.push(`| Medium | ${report.stats.mediumRegressions} |`);
  lines.push(`| Low | ${report.stats.lowRegressions} |`);
  lines.push(`| Improvements | ${report.stats.totalImprovements} |`);
  lines.push("");

  return lines.join("\n");
}

// Helper functions

function groupByCategory(results: { taskId: string; status: string; score: number }[]): Map<string, { passed: number; total: number }> {
  const map = new Map<string, { passed: number; total: number }>();
  for (const r of results) {
    const cat = r.taskId.split("-")[0] ?? "unknown";
    const existing = map.get(cat) ?? { passed: 0, total: 0 };
    existing.total++;
    if (r.status === "pass") existing.passed++;
    map.set(cat, existing);
  }
  return map;
}

function findRegressedTasks(
  current: EvalRunSummary,
  previous: EvalRunSummary,
  category: string,
): string[] {
  const regressed: string[] = [];
  const currentMap = new Map(current.results.map(r => [r.taskId, r]));
  const previousMap = new Map(previous.results.map(r => [r.taskId, r]));

  for (const [taskId, prevResult] of previousMap) {
    if (!taskId.startsWith(category)) continue;
    const currResult = currentMap.get(taskId);
    if (!currResult) continue;
    if (prevResult.status === "pass" && currResult.status !== "pass") {
      regressed.push(taskId);
    }
  }
  return regressed;
}

/**
 * Run regression detection on the latest eval results.
 */
export async function runRegressionDetection(): Promise<RegressionReport | null> {
  const runs = await loadEvalRuns();
  if (runs.length < 2) {
    console.log("Need at least 2 eval runs for regression detection.");
    return null;
  }

  const current = runs[runs.length - 1]!;
  const previous = runs[runs.length - 2]!;

  const report = detectRegressions(current, previous);

  // Save report
  await mkdir(RESULTS_DIR, { recursive: true });
  const reportPath = join(RESULTS_DIR, "regression-report.md");
  await writeFile(reportPath, formatRegressionReport(report));

  // Also save JSON
  const jsonPath = join(RESULTS_DIR, "regression-report.json");
  await writeFile(jsonPath, JSON.stringify(report, null, 2));

  console.log(`📊 Regression report saved to: ${reportPath}`);

  // Also analyze trend
  const trend = analyzeTrend(runs);
  console.log(`📈 Trend: ${trend.details}`);

  return report;
}

// Run if executed directly
if (process.argv[1]?.includes("regression-detector")) {
  runRegressionDetection().then(report => {
    if (report) {
      console.log("");
      console.log(formatRegressionReport(report));
    }
  }).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
