/**
 * Performance Benchmark
 * Tracks task execution times, identifies bottlenecks, and monitors performance trends.
 * 
 * Features:
 *   - Execution time tracking per task/category/difficulty
 *   - Bottleneck detection (slow tasks)
 *   - Performance regression detection
 *   - Resource usage analysis
 *   - Optimization recommendations
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let RESULTS_DIR: string;
let BENCHMARKS_DIR: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  RESULTS_DIR = resolve(__dirname, "../../results");
  BENCHMARKS_DIR = resolve(__dirname, "../../results/benchmarks");
} catch {
  RESULTS_DIR = resolve(process.cwd(), "packages/eval/results");
  BENCHMARKS_DIR = resolve(process.cwd(), "packages/eval/results/benchmarks");
}

export interface BenchmarkResult {
  taskId: string;
  category: string;
  difficulty: number;
  durationMs: number;
  trajectoryEvents: number;
  /**
   * Trajectory quality, or `undefined` when the run did not measure it.
   *
   * Never defaulted to 1.0: treating an unmeasured task as perfect inflates
   * every average that includes it, and the inflation grows with the number of
   * runs that skipped measurement.
   */
  qualityScore: number | undefined;
  status: string;
  timestamp: string;
}

export interface PerformanceStats {
  /** Total tasks benchmarked */
  totalTasks: number;
  /** Total execution time */
  totalDurationMs: number;
  /** Average execution time */
  avgDurationMs: number;
  /** Median execution time */
  medianDurationMs: number;
  /** P95 execution time */
  p95DurationMs: number;
  /** P99 execution time */
  p99DurationMs: number;
  /** Min execution time */
  minDurationMs: number;
  /** Max execution time */
  maxDurationMs: number;
  /** Standard deviation */
  stdDevMs: number;
  /** Tasks per second throughput */
  throughput: number;
}

export interface CategoryPerformance {
  category: string;
  stats: PerformanceStats;
  taskCount: number;
  /** Mean of the tasks that reported a quality score; `undefined` if none did. */
  avgQuality: number | undefined;
}

/**
 * Mean quality over the tasks that actually measured it.
 *
 * Returns `undefined` rather than 0 or 1 when nothing was measured: a missing
 * measurement is not a bad score and it is not a perfect one.
 */
/** Render a quality average, saying so plainly when nothing was measured. */
export function formatQuality(value: number | undefined): string {
  return typeof value === "number" ? value.toFixed(2) : "n/a (unmeasured)";
}

export function averageQuality(results: readonly BenchmarkResult[]): number | undefined {
  const measured = results
    .map((result) => result.qualityScore)
    .filter((score): score is number => typeof score === "number");
  if (measured.length === 0) return undefined;
  return measured.reduce((sum, score) => sum + score, 0) / measured.length;
}

export interface DifficultyPerformance {
  difficulty: number;
  label: string;
  stats: PerformanceStats;
  taskCount: number;
  /** Mean of the tasks that reported a quality score; `undefined` if none did. */
  avgQuality: number | undefined;
}

export interface Bottleneck {
  taskId: string;
  category: string;
  difficulty: number;
  durationMs: number;
  avgForCategory: number;
  avgForDifficulty: number;
  slowdownFactor: number;
  severity: "critical" | "high" | "medium" | "low";
  recommendation: string;
}

export interface BenchmarkReport {
  timestamp: string;
  overall: PerformanceStats;
  byCategory: CategoryPerformance[];
  byDifficulty: DifficultyPerformance[];
  bottlenecks: Bottleneck[];
  recommendations: string[];
  trend: {
    direction: "improving" | "stable" | "declining";
    details: string;
  };
}

const DIFFICULTY_LABELS: Record<number, string> = {
  1: "Trivial", 2: "Easy", 3: "Medium", 4: "Hard", 5: "Expert",
};

/**
 * Calculate performance statistics for a set of durations.
 */
function calculateStats(durations: number[], totalMs?: number): PerformanceStats {
  if (durations.length === 0) {
    return {
      totalTasks: 0, totalDurationMs: 0, avgDurationMs: 0,
      medianDurationMs: 0, p95DurationMs: 0, p99DurationMs: 0,
      minDurationMs: 0, maxDurationMs: 0, stdDevMs: 0, throughput: 0,
    };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const total = totalMs ?? sorted.reduce((a, b) => a + b, 0);
  const avg = total / sorted.length;

  // Standard deviation
  const variance = sorted.reduce((sum, d) => sum + Math.pow(d - avg, 2), 0) / sorted.length;
  const stdDev = Math.sqrt(variance);

  // Percentiles
  const p95Index = Math.floor(sorted.length * 0.95);
  const p99Index = Math.floor(sorted.length * 0.99);

  return {
    totalTasks: sorted.length,
    totalDurationMs: total,
    avgDurationMs: avg,
    medianDurationMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95DurationMs: sorted[p95Index] ?? sorted[sorted.length - 1] ?? 0,
    p99DurationMs: sorted[p99Index] ?? sorted[sorted.length - 1] ?? 0,
    minDurationMs: sorted[0] ?? 0,
    maxDurationMs: sorted[sorted.length - 1] ?? 0,
    stdDevMs: stdDev,
    throughput: total > 0 ? (sorted.length / total) * 1000 : 0,
  };
}

/**
 * Run performance benchmark on eval results.
 */
export async function runBenchmark(): Promise<BenchmarkReport | null> {
  // Load latest eval results
  const runs = await loadLatestEvalRuns(1);
  if (runs.length === 0) {
    console.log("No eval results found for benchmarking.");
    return null;
  }

  const latestRun = runs[0];
  if (!latestRun) return null;

  const results: BenchmarkResult[] = latestRun.results.map((r: any) => ({
    taskId: r.taskId,
    category: r.category ?? r.taskId.split("-")[0] ?? "unknown",
    difficulty: r.difficulty ?? 3,
    durationMs: r.durationMs ?? 0,
    trajectoryEvents: r.trajectoryEvents ?? 0,
    qualityScore: typeof r.qualityScore === "number" ? r.qualityScore : undefined,
    status: r.status,
    timestamp: latestRun.timestamp,
  }));

  // Overall stats
  const allDurations = results.map(r => r.durationMs);
  const overall = calculateStats(allDurations, latestRun.durationMs);

  // By category
  const categoryMap = new Map<string, BenchmarkResult[]>();
  for (const r of results) {
    const existing = categoryMap.get(r.category) ?? [];
    existing.push(r);
    categoryMap.set(r.category, existing);
  }

  const byCategory: CategoryPerformance[] = [];
  for (const [category, catResults] of categoryMap) {
    const durations = catResults.map(r => r.durationMs);
    const avgQuality = averageQuality(catResults);
    byCategory.push({
      category,
      stats: calculateStats(durations),
      taskCount: catResults.length,
      avgQuality,
    });
  }

  // By difficulty
  const difficultyMap = new Map<number, BenchmarkResult[]>();
  for (const r of results) {
    const existing = difficultyMap.get(r.difficulty) ?? [];
    existing.push(r);
    difficultyMap.set(r.difficulty, existing);
  }

  const byDifficulty: DifficultyPerformance[] = [];
  for (const [difficulty, diffResults] of difficultyMap) {
    const durations = diffResults.map(r => r.durationMs);
    const avgQuality = averageQuality(diffResults);
    byDifficulty.push({
      difficulty,
      label: DIFFICULTY_LABELS[difficulty] ?? "Unknown",
      stats: calculateStats(durations),
      taskCount: diffResults.length,
      avgQuality,
    });
  }

  // Detect bottlenecks
  const bottlenecks = detectBottlenecks(results, byCategory, byDifficulty);

  // Generate recommendations
  const recommendations = generateRecommendations(overall, byCategory, bottlenecks);

  // Analyze trend
  const trend = await analyzePerformanceTrend();

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    overall,
    byCategory,
    byDifficulty,
    bottlenecks,
    recommendations,
    trend,
  };

  // Save report
  await mkdir(BENCHMARKS_DIR, { recursive: true });
  const reportPath = join(BENCHMARKS_DIR, `benchmark-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  const markdownPath = join(BENCHMARKS_DIR, "benchmark-report.md");
  await writeFile(markdownPath, formatBenchmarkReport(report));

  console.log(`📊 Benchmark report saved to: ${markdownPath}`);

  return report;
}

/**
 * Detect bottleneck tasks (significantly slower than average).
 */
function detectBottlenecks(
  results: BenchmarkResult[],
  byCategory: CategoryPerformance[],
  byDifficulty: DifficultyPerformance[],
): Bottleneck[] {
  const bottlenecks: Bottleneck[] = [];
  const categoryAvgMap = new Map(byCategory.map(c => [c.category, c.stats.avgDurationMs]));
  const difficultyAvgMap = new Map(byDifficulty.map(d => [d.difficulty, d.stats.avgDurationMs]));

  // Calculate overall average for fallback
  const allDurations = results.map(r => r.durationMs);
  const overallAvg = allDurations.length > 0 ? allDurations.reduce((a, b) => a + b, 0) / allDurations.length : 1;

  for (const result of results) {
    const catAvg = categoryAvgMap.get(result.category) ?? overallAvg;
    const diffAvg = difficultyAvgMap.get(result.difficulty) ?? overallAvg;

    // Use the higher of category or difficulty average as baseline
    const baseline = Math.max(catAvg, diffAvg, 1);
    const slowdownFactor = result.durationMs / baseline;

    if (slowdownFactor > 3.0) {
      bottlenecks.push({
        taskId: result.taskId,
        category: result.category,
        difficulty: result.difficulty,
        durationMs: result.durationMs,
        avgForCategory: catAvg,
        avgForDifficulty: diffAvg,
        slowdownFactor,
        severity: slowdownFactor > 10 ? "critical" : slowdownFactor > 5 ? "high" : slowdownFactor > 3 ? "medium" : "low",
        recommendation: `Task ${result.taskId} is ${slowdownFactor.toFixed(1)}x slower than average. Consider optimizing or increasing timeout.`,
      });
    }
  }

  bottlenecks.sort((a, b) => b.slowdownFactor - a.slowdownFactor);
  return bottlenecks;
}

// Need to declare overall for the detectBottlenecks function
let overall: PerformanceStats;

/**
 * Generate optimization recommendations.
 */
function generateRecommendations(
  stats: PerformanceStats,
  byCategory: CategoryPerformance[],
  bottlenecks: Bottleneck[],
): string[] {
  const recommendations: string[] = [];

  // High variance
  if (stats.stdDevMs > stats.avgDurationMs * 2) {
    recommendations.push(`High execution time variance (σ=${stats.stdDevMs.toFixed(0)}ms vs avg=${stats.avgDurationMs.toFixed(0)}ms). Investigate outlier tasks.`);
  }

  // Slow categories
  for (const cat of byCategory) {
    if (cat.stats.avgDurationMs > stats.avgDurationMs * 2) {
      recommendations.push(`${cat.category} is ${((cat.stats.avgDurationMs / stats.avgDurationMs) * 100).toFixed(0)}% slower than average. Focus on optimization.`);
    }
  }

  // Bottlenecks
  if (bottlenecks.length > 0) {
    recommendations.push(`${bottlenecks.length} bottleneck tasks detected. Top: ${bottlenecks[0]?.taskId} (${bottlenecks[0]?.slowdownFactor.toFixed(1)}x slower).`);
  }

  // Throughput
  if (stats.throughput < 10) {
    recommendations.push(`Low throughput (${stats.throughput.toFixed(1)} tasks/sec). Consider parallel execution or caching.`);
  }

  return recommendations;
}

/**
 * Analyze performance trend over multiple runs.
 */
async function analyzePerformanceTrend(): Promise<{ direction: "improving" | "stable" | "declining"; details: string }> {
  const runs = await loadLatestEvalRuns(5);
  if (runs.length < 2) {
    return { direction: "stable", details: "Not enough data for trend analysis" };
  }

  const avgDurations = runs.map(r => {
    const durations = r.results.map((x: any) => x.durationMs ?? 0);
    return durations.reduce((a: number, b: number) => a + b, 0) / durations.length;
  });

  const firstHalf = avgDurations.slice(0, Math.floor(avgDurations.length / 2));
  const secondHalf = avgDurations.slice(Math.floor(avgDurations.length / 2));
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  const change = ((avgSecond - avgFirst) / avgFirst) * 100;

  if (change < -10) {
    return { direction: "improving", details: `Execution time improved by ${Math.abs(change).toFixed(0)}%` };
  } else if (change > 10) {
    return { direction: "declining", details: `Execution time regressed by ${change.toFixed(0)}%` };
  }
  return { direction: "stable", details: `Execution time stable (±${Math.abs(change).toFixed(0)}%)` };
}

/**
 * Load latest eval runs from results directory.
 */
async function loadLatestEvalRuns(count: number): Promise<any[]> {
  const runs: any[] = [];
  try {
    const files = await readdir(RESULTS_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await readFile(join(RESULTS_DIR, file), "utf-8");
        const data = JSON.parse(content);
        if (data.totalTasks !== undefined && data.results !== undefined) {
          runs.push(data);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  runs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return runs.slice(0, count);
}

/**
 * Format benchmark report as markdown.
 */
export function formatBenchmarkReport(report: BenchmarkReport): string {
  const lines: string[] = [];

  lines.push("# Performance Benchmark Report");
  lines.push("");
  lines.push(`**Generated:** ${report.timestamp}`);
  lines.push(`**Tasks Benchmarked:** ${report.overall.totalTasks}`);
  lines.push("");

  // Overall stats
  lines.push("## Overall Performance");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Avg Duration | ${report.overall.avgDurationMs.toFixed(1)}ms |`);
  lines.push(`| Median Duration | ${report.overall.medianDurationMs.toFixed(1)}ms |`);
  lines.push(`| P95 Duration | ${report.overall.p95DurationMs.toFixed(1)}ms |`);
  lines.push(`| P99 Duration | ${report.overall.p99DurationMs.toFixed(1)}ms |`);
  lines.push(`| Min Duration | ${report.overall.minDurationMs.toFixed(1)}ms |`);
  lines.push(`| Max Duration | ${report.overall.maxDurationMs.toFixed(1)}ms |`);
  lines.push(`| Std Deviation | ${report.overall.stdDevMs.toFixed(1)}ms |`);
  lines.push(`| Throughput | ${report.overall.throughput.toFixed(1)} tasks/sec |`);
  lines.push("");

  // Trend
  const trendIcon = report.trend.direction === "improving" ? "📈" : report.trend.direction === "declining" ? "📉" : "➡️";
  lines.push(`**Trend:** ${trendIcon} ${report.trend.details}`);
  lines.push("");

  // By category
  lines.push("## Performance by Category");
  lines.push("");
  lines.push("| Category | Tasks | Avg (ms) | Median (ms) | P95 (ms) | Quality |");
  lines.push("|----------|-------|----------|-------------|----------|---------|");
  for (const cat of report.byCategory.sort((a, b) => b.stats.avgDurationMs - a.stats.avgDurationMs)) {
    lines.push(`| ${cat.category} | ${cat.taskCount} | ${cat.stats.avgDurationMs.toFixed(1)} | ${cat.stats.medianDurationMs.toFixed(1)} | ${cat.stats.p95DurationMs.toFixed(1)} | ${formatQuality(cat.avgQuality)} |`);
  }
  lines.push("");

  // By difficulty
  lines.push("## Performance by Difficulty");
  lines.push("");
  lines.push("| Level | Label | Tasks | Avg (ms) | Median (ms) | P95 (ms) | Quality |");
  lines.push("|-------|-------|-------|----------|-------------|----------|---------|");
  for (const diff of report.byDifficulty.sort((a, b) => a.difficulty - b.difficulty)) {
    lines.push(`| ${diff.difficulty} | ${diff.label} | ${diff.taskCount} | ${diff.stats.avgDurationMs.toFixed(1)} | ${diff.stats.medianDurationMs.toFixed(1)} | ${diff.stats.p95DurationMs.toFixed(1)} | ${formatQuality(diff.avgQuality)} |`);
  }
  lines.push("");

  // Bottlenecks
  if (report.bottlenecks.length > 0) {
    lines.push("## Bottlenecks");
    lines.push("");
    lines.push("| Task | Category | Duration | Avg | Slowdown | Severity |");
    lines.push("|------|----------|----------|-----|----------|----------|");
    for (const bn of report.bottlenecks.slice(0, 10)) {
      const icon = bn.severity === "critical" ? "🔴" : bn.severity === "high" ? "🟠" : bn.severity === "medium" ? "🟡" : "🟢";
      lines.push(`| ${bn.taskId} | ${bn.category} | ${bn.durationMs.toFixed(0)}ms | ${bn.avgForCategory.toFixed(0)}ms | ${bn.slowdownFactor.toFixed(1)}x | ${icon} ${bn.severity} |`);
    }
    lines.push("");
  }

  // Recommendations
  if (report.recommendations.length > 0) {
    lines.push("## Recommendations");
    lines.push("");
    for (const rec of report.recommendations) {
      lines.push(`- 💡 ${rec}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Run if executed directly
if (process.argv[1]?.includes("performance-benchmark")) {
  runBenchmark().then(report => {
    if (report) {
      console.log("");
      console.log(formatBenchmarkReport(report));
    }
  }).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
