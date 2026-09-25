/**
 * Eval Dashboard
 * Tracks eval results over time and generates progress reports.
 * This is the self-improvement feedback loop.
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

interface EvalRun {
  timestamp: string;
  totalTasks: number;
  passed: number;
  failed: number;
  errors: number;
  overallScore: number;
  durationMs: number;
  results: any[];
}

interface ProgressEntry {
  date: string;
  score: number;
  passed: number;
  total: number;
  passRate: number;
}

/** Load all eval runs from results directory */
async function loadEvalRuns(): Promise<EvalRun[]> {
  const runs: EvalRun[] = [];
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
      } catch { /* skip invalid files */ }
    }
  } catch { /* results dir doesn't exist */ }

  // Sort by timestamp
  runs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return runs;
}

/** Generate progress chart (ASCII) */
function generateProgressChart(entries: ProgressEntry[]): string {
  if (entries.length === 0) return "No data yet.";

  const lines: string[] = [];
  const maxBarWidth = 40;

  lines.push("Progress Over Time:");
  lines.push("");

  for (const entry of entries) {
    const barWidth = Math.round(entry.passRate * maxBarWidth);
    const bar = "█".repeat(barWidth) + "░".repeat(maxBarWidth - barWidth);
    const date = entry.date.slice(0, 10);
    lines.push(`  ${date} |${bar}| ${(entry.passRate * 100).toFixed(0)}% (${entry.passed}/${entry.total})`);
  }

  return lines.join("\n");
}

/** Generate category comparison */
function generateCategoryComparison(runs: EvalRun[]): string {
  if (runs.length < 2) return "Need at least 2 runs for comparison.";

  const latest = runs[runs.length - 1]!;
  const previous = runs[runs.length - 2]!;

  const categories = new Map<string, { current: number; previous: number; total: number }>();

  for (const r of latest.results) {
    const cat = r.taskId.split("-")[0];
    const existing = categories.get(cat) ?? { current: 0, previous: 0, total: 0 };
    existing.total++;
    if (r.status === "pass") existing.current++;
    categories.set(cat, existing);
  }

  for (const r of previous.results) {
    const cat = r.taskId.split("-")[0];
    const existing = categories.get(cat);
    if (existing && r.status === "pass") existing.previous++;
  }

  const lines: string[] = [];
  lines.push("Category Progress:");
  lines.push("");
  lines.push("  Category      | Current | Previous | Change");
  lines.push("  --------------|---------|----------|-------");

  for (const [cat, stats] of categories) {
    const currentRate = stats.total > 0 ? stats.current / stats.total : 0;
    const previousRate = stats.total > 0 ? stats.previous / stats.total : 0;
    const change = currentRate - previousRate;
    const changeStr = change > 0 ? `+${(change * 100).toFixed(0)}%` : change < 0 ? `${(change * 100).toFixed(0)}%` : "0%";
    const arrow = change > 0 ? "↑" : change < 0 ? "↓" : "→";

    lines.push(`  ${cat.padEnd(14)}| ${stats.current.toString().padStart(7)} | ${stats.previous.toString().padStart(8)} | ${arrow} ${changeStr}`);
  }

  return lines.join("\n");
}

/** Generate recommendations */
function generateRecommendations(runs: EvalRun[]): string[] {
  const recommendations: string[] = [];

  if (runs.length === 0) {
    recommendations.push("Run the eval system to establish a baseline.");
    return recommendations;
  }

  const latest = runs[runs.length - 1]!;

  // Check for failing categories
  const categories = new Map<string, { pass: number; total: number }>();
  for (const r of latest.results) {
    const cat = r.taskId.split("-")[0];
    const existing = categories.get(cat) ?? { pass: 0, total: 0 };
    existing.total++;
    if (r.status === "pass") existing.pass++;
    categories.set(cat, existing);
  }

  for (const [cat, stats] of categories) {
    const passRate = stats.total > 0 ? stats.pass / stats.total : 0;
    if (passRate < 1.0) {
      recommendations.push(`Improve ${cat}: ${(passRate * 100).toFixed(0)}% pass rate (${stats.pass}/${stats.total})`);
    }
  }

  // Check for regressions
  if (runs.length >= 2) {
    const previous = runs[runs.length - 2]!;
    if (latest.overallScore < previous.overallScore) {
      recommendations.push(`Regression detected: score dropped from ${(previous.overallScore * 100).toFixed(0)}% to ${(latest.overallScore * 100).toFixed(0)}%`);
    }
  }

  // General recommendations
  if (latest.overallScore < 0.8) {
    recommendations.push("Focus on improving failing categories before adding new features.");
  }

  if (latest.overallScore >= 0.95) {
    recommendations.push("Excellent performance! Consider adding more challenging tasks.");
  }

  return recommendations;
}

/** Generate full dashboard */
export async function generateDashboard(): Promise<string> {
  const runs = await loadEvalRuns();

  const lines: string[] = [];
  lines.push("# Aurora Eval Dashboard");
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Total Runs:** ${runs.length}`);
  lines.push("");

  if (runs.length === 0) {
    lines.push("No eval runs found. Run the eval system to see results here.");
    return lines.join("\n");
  }

  // Latest stats
  const latest = runs[runs.length - 1]!;
  lines.push("## Latest Results");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Date | ${latest.timestamp} |`);
  lines.push(`| Score | ${(latest.overallScore * 100).toFixed(1)}% |`);
  lines.push(`| Passed | ${latest.passed}/${latest.totalTasks} |`);
  lines.push(`| Pass Rate | ${(latest.passed / latest.totalTasks * 100).toFixed(1)}% |`);
  lines.push(`| Duration | ${(latest.durationMs / 1000).toFixed(1)}s |`);
  lines.push("");

  // Progress chart
  const progressEntries: ProgressEntry[] = runs
    .filter(r => r.timestamp && r.overallScore !== undefined)
    .map(r => ({
      date: r.timestamp,
      score: r.overallScore,
      passed: r.passed,
      total: r.totalTasks,
      passRate: r.passed / r.totalTasks,
    }));

  lines.push("## Progress");
  lines.push("");
  lines.push("```");
  lines.push(generateProgressChart(progressEntries));
  lines.push("```");
  lines.push("");

  // Category comparison
  if (runs.length >= 2) {
    lines.push("## Category Comparison");
    lines.push("");
    lines.push("```");
    lines.push(generateCategoryComparison(runs));
    lines.push("```");
    lines.push("");
  }

  // Recommendations
  const recommendations = generateRecommendations(runs);
  if (recommendations.length > 0) {
    lines.push("## Recommendations");
    lines.push("");
    for (const rec of recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push("");
  }

  // History
  if (runs.length > 1) {
    lines.push("## Run History");
    lines.push("");
    lines.push("| Date | Score | Passed | Total | Duration |");
    lines.push("|------|-------|--------|-------|----------|");
    for (const run of runs.filter(r => r.timestamp).slice(-10).reverse()) {
      lines.push(`| ${run.timestamp.slice(0, 10)} | ${(run.overallScore * 100).toFixed(0)}% | ${run.passed} | ${run.totalTasks} | ${(run.durationMs / 1000).toFixed(1)}s |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Save dashboard to file */
export async function saveDashboard(): Promise<string> {
  const dashboard = await generateDashboard();
  const dashboardPath = join(RESULTS_DIR, "dashboard.md");
  await writeFile(dashboardPath, dashboard);
  return dashboardPath;
}

// Run if executed directly
if (process.argv[1]?.includes("eval-dashboard")) {
  generateDashboard().then(dashboard => {
    console.log(dashboard);
    return saveDashboard();
  }).then(path => {
    console.log(`\n📄 Dashboard saved to: ${path}`);
  }).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
