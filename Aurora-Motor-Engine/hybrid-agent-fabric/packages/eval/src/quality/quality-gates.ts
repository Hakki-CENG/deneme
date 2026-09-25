/**
 * Quality Gates
 * CI/CD integration for enforcing quality standards before deployments.
 * 
 * Features:
 *   - Minimum score threshold
 *   - Maximum regression count
 *   - Budget limits
 *   - Performance thresholds
 *   - Category-specific gates
 *   - Pass/Fail verdict with detailed report
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let RESULTS_DIR: string;
let GATES_DIR: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  RESULTS_DIR = resolve(__dirname, "../../results");
  GATES_DIR = resolve(__dirname, "../../results/quality-gates");
} catch {
  RESULTS_DIR = resolve(process.cwd(), "packages/eval/results");
  GATES_DIR = resolve(process.cwd(), "packages/eval/results/quality-gates");
}

export interface QualityGateConfig {
  /** Minimum overall score (0-1) */
  minScore: number;
  /** Maximum allowed regressions */
  maxRegressions: number;
  /** Maximum budget in USD */
  maxBudgetUsd: number;
  /** Maximum avg duration in ms */
  maxAvgDurationMs: number;
  /** Minimum throughput (tasks/sec) */
  minThroughput: number;
  /** Category-specific gates */
  categoryGates: Record<string, { minScore: number }>;
  /** Difficulty-specific gates */
  difficultyGates: Record<number, { minScore: number }>;
}

export const DEFAULT_GATES: QualityGateConfig = {
  minScore: 0.95,           // 95% minimum score
  maxRegressions: 0,        // No regressions allowed
  maxBudgetUsd: 50,         // $50 max budget
  maxAvgDurationMs: 100,    // 100ms max avg duration
  minThroughput: 10,        // 10 tasks/sec minimum
  categoryGates: {
    coding: { minScore: 0.90 },
    memory: { minScore: 0.95 },
    planning: { minScore: 0.90 },
    reasoning: { minScore: 0.90 },
    security: { minScore: 1.0 },  // Security must be 100%
  },
  difficultyGates: {
    4: { minScore: 0.80 },  // Hard tasks: 80% minimum
    5: { minScore: 0.70 },  // Expert tasks: 70% minimum
  },
};

export interface GateCheck {
  name: string;
  passed: boolean;
  actual: number | string;
  threshold: number | string;
  severity: "critical" | "warning" | "info";
  message: string;
}

export interface QualityGateResult {
  timestamp: string;
  /** Overall verdict */
  passed: boolean;
  /** Total checks */
  totalChecks: number;
  /** Passed checks */
  passedChecks: number;
  /** Failed checks */
  failedChecks: number;
  /** Individual gate checks */
  checks: GateCheck[];
  /** Summary message */
  summary: string;
  /** Exit code for CI/CD (0 = pass, 1 = fail) */
  exitCode: number;
}

/**
 * Run quality gates on latest eval results.
 */
export async function runQualityGates(config: QualityGateConfig = DEFAULT_GATES): Promise<QualityGateResult> {
  const checks: GateCheck[] = [];

  // Load latest eval results
  const evalRuns = await loadLatestEvalRuns(1);
  const latestRun = evalRuns[0];

  // Load latest benchmark
  const benchmarks = await loadLatestBenchmarks(1);
  const latestBenchmark = benchmarks[0];

  // Load latest cost report
  const costReports = await loadLatestCostReports(1);
  const latestCost = costReports[0];

  // Load latest regression report
  const regressionReports = await loadLatestRegressionReports(1);
  const latestRegression = regressionReports[0];

  // === Gate 1: Minimum Score ===
  if (latestRun) {
    const score = latestRun.overallScore ?? 0;
    checks.push({
      name: "Overall Score",
      passed: score >= config.minScore,
      actual: score,
      threshold: config.minScore,
      severity: "critical",
      message: `Score ${(score * 100).toFixed(1)}% ${score >= config.minScore ? "≥" : "<"} ${(config.minScore * 100).toFixed(0)}% threshold`,
    });
  } else {
    checks.push({
      name: "Overall Score",
      passed: false,
      actual: "N/A",
      threshold: config.minScore,
      severity: "critical",
      message: "No eval results found",
    });
  }

  // === Gate 2: Max Regressions ===
  if (latestRegression) {
    const regressions = latestRegression.stats?.totalRegressions ?? latestRegression.regressions?.length ?? 0;
    checks.push({
      name: "Regressions",
      passed: regressions <= config.maxRegressions,
      actual: regressions,
      threshold: config.maxRegressions,
      severity: regressions > 0 ? "critical" : "info",
      message: `${regressions} regressions ${regressions <= config.maxRegressions ? "≤" : ">"} ${config.maxRegressions} allowed`,
    });
  }

  // === Gate 3: Budget ===
  if (latestCost) {
    const cost = latestCost.overall?.totalCostUsd ?? 0;
    checks.push({
      name: "Budget",
      passed: cost <= config.maxBudgetUsd,
      actual: cost,
      threshold: config.maxBudgetUsd,
      severity: cost > config.maxBudgetUsd ? "critical" : "info",
      message: `Cost $${cost.toFixed(4)} ${cost <= config.maxBudgetUsd ? "≤" : ">"} $${config.maxBudgetUsd} budget`,
    });
  }

  // === Gate 4: Performance ===
  if (latestBenchmark) {
    const avgDuration = latestBenchmark.overall?.avgDurationMs ?? 0;
    const throughput = latestBenchmark.overall?.throughput ?? 0;

    checks.push({
      name: "Avg Duration",
      passed: avgDuration <= config.maxAvgDurationMs,
      actual: avgDuration,
      threshold: config.maxAvgDurationMs,
      severity: avgDuration > config.maxAvgDurationMs ? "warning" : "info",
      message: `Avg ${avgDuration.toFixed(1)}ms ${avgDuration <= config.maxAvgDurationMs ? "≤" : ">"} ${config.maxAvgDurationMs}ms threshold`,
    });

    checks.push({
      name: "Throughput",
      passed: throughput >= config.minThroughput,
      actual: throughput,
      threshold: config.minThroughput,
      severity: throughput < config.minThroughput ? "warning" : "info",
      message: `${throughput.toFixed(1)} tasks/sec ${throughput >= config.minThroughput ? "≥" : "<"} ${config.minThroughput} tasks/sec threshold`,
    });
  }

  // === Gate 5: Category-specific gates ===
  if (latestRun?.results) {
    const categoryScores = calculateCategoryScores(latestRun.results);

    for (const [category, gate] of Object.entries(config.categoryGates)) {
      const score = categoryScores[category] ?? 0;
      checks.push({
        name: `Category: ${category}`,
        passed: score >= gate.minScore,
        actual: score,
        threshold: gate.minScore,
        severity: score < gate.minScore ? "critical" : "info",
        message: `${category} ${(score * 100).toFixed(0)}% ${score >= gate.minScore ? "≥" : "<"} ${(gate.minScore * 100).toFixed(0)}% threshold`,
      });
    }
  }

  // === Gate 6: Difficulty-specific gates ===
  if (latestRun?.results) {
    const difficultyScores = calculateDifficultyScores(latestRun.results);

    for (const [difficulty, gate] of Object.entries(config.difficultyGates)) {
      const diffNum = parseInt(difficulty);
      const score = difficultyScores[diffNum] ?? 0;
      const label = getDifficultyLabel(diffNum);
      checks.push({
        name: `Difficulty: ${label} (${difficulty})`,
        passed: score >= gate.minScore,
        actual: score,
        threshold: gate.minScore,
        severity: score < gate.minScore ? "warning" : "info",
        message: `${label} tasks ${(score * 100).toFixed(0)}% ${score >= gate.minScore ? "≥" : "<"} ${(gate.minScore * 100).toFixed(0)}% threshold`,
      });
    }
  }

  // Calculate verdict
  const passedChecks = checks.filter(c => c.passed).length;
  const failedChecks = checks.filter(c => !c.passed).length;
  const criticalFailures = checks.filter(c => !c.passed && c.severity === "critical").length;
  const passed = criticalFailures === 0;

  const summary = passed
    ? `✅ QUALITY GATES PASSED (${passedChecks}/${checks.length} checks passed)`
    : `❌ QUALITY GATES FAILED (${failedChecks}/${checks.length} checks failed, ${criticalFailures} critical)`;

  const result: QualityGateResult = {
    timestamp: new Date().toISOString(),
    passed,
    totalChecks: checks.length,
    passedChecks,
    failedChecks,
    checks,
    summary,
    exitCode: passed ? 0 : 1,
  };

  // Save report
  await mkdir(GATES_DIR, { recursive: true });
  const reportPath = join(GATES_DIR, "quality-gate-result.json");
  await writeFile(reportPath, JSON.stringify(result, null, 2));

  const markdownPath = join(GATES_DIR, "quality-gate-report.md");
  await writeFile(markdownPath, formatQualityGateReport(result));

  return result;
}

/**
 * Calculate scores by category.
 */
function calculateCategoryScores(results: any[]): Record<string, number> {
  const categories = new Map<string, { passed: number; total: number }>();

  for (const r of results) {
    const cat = r.taskId?.split("-")[0] ?? "unknown";
    const existing = categories.get(cat) ?? { passed: 0, total: 0 };
    existing.total++;
    if (r.status === "pass") existing.passed++;
    categories.set(cat, existing);
  }

  const scores: Record<string, number> = {};
  for (const [cat, stats] of categories) {
    scores[cat] = stats.total > 0 ? stats.passed / stats.total : 0;
  }
  return scores;
}

/**
 * Calculate scores by difficulty.
 */
function calculateDifficultyScores(results: any[]): Record<number, number> {
  const difficulties = new Map<number, { passed: number; total: number }>();

  for (const r of results) {
    const diff = r.difficulty ?? 3;
    const existing = difficulties.get(diff) ?? { passed: 0, total: 0 };
    existing.total++;
    if (r.status === "pass") existing.passed++;
    difficulties.set(diff, existing);
  }

  const scores: Record<number, number> = {};
  for (const [diff, stats] of difficulties) {
    scores[diff] = stats.total > 0 ? stats.passed / stats.total : 0;
  }
  return scores;
}

function getDifficultyLabel(d: number): string {
  const labels: Record<number, string> = { 1: "Trivial", 2: "Easy", 3: "Medium", 4: "Hard", 5: "Expert" };
  return labels[d] ?? "Unknown";
}

// Load helpers
async function loadLatestEvalRuns(count: number): Promise<any[]> {
  const runs: any[] = [];
  try {
    const files = await readdir(RESULTS_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await readFile(join(RESULTS_DIR, file), "utf-8");
        const data = JSON.parse(content);
        if (data.totalTasks !== undefined && data.results !== undefined) runs.push(data);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  runs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return runs.slice(0, count);
}

async function loadLatestBenchmarks(count: number): Promise<any[]> {
  const runs: any[] = [];
  try {
    const files = await readdir(join(RESULTS_DIR, "benchmarks"));
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await readFile(join(RESULTS_DIR, "benchmarks", file), "utf-8");
        runs.push(JSON.parse(content));
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  runs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return runs.slice(0, count);
}

async function loadLatestCostReports(count: number): Promise<any[]> {
  const runs: any[] = [];
  try {
    const files = await readdir(join(RESULTS_DIR, "costs"));
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await readFile(join(RESULTS_DIR, "costs", file), "utf-8");
        runs.push(JSON.parse(content));
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  runs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return runs.slice(0, count);
}

async function loadLatestRegressionReports(count: number): Promise<any[]> {
  const runs: any[] = [];
  try {
    const files = await readdir(RESULTS_DIR);
    for (const file of files) {
      if (file.includes("regression") && file.endsWith(".json")) {
        try {
          const content = await readFile(join(RESULTS_DIR, file), "utf-8");
          runs.push(JSON.parse(content));
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  runs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return runs.slice(0, count);
}

/**
 * Format quality gate report as markdown.
 */
export function formatQualityGateReport(result: QualityGateResult): string {
  const lines: string[] = [];

  lines.push("# Quality Gate Report");
  lines.push("");
  lines.push(`**Generated:** ${result.timestamp}`);
  lines.push("");

  // Verdict banner
  if (result.passed) {
    lines.push("## ✅ QUALITY GATES PASSED");
  } else {
    lines.push("## ❌ QUALITY GATES FAILED");
  }
  lines.push("");
  lines.push(`**Checks:** ${result.passedChecks}/${result.totalChecks} passed`);
  lines.push(`**Failed:** ${result.failedChecks}`);
  lines.push(`**Exit Code:** ${result.exitCode}`);
  lines.push("");

  // Checks table
  lines.push("## Gate Checks");
  lines.push("");
  lines.push("| Status | Gate | Actual | Threshold | Message |");
  lines.push("|--------|------|--------|-----------|---------|");
  for (const check of result.checks) {
    const icon = check.passed ? "✅" : check.severity === "critical" ? "❌" : "⚠️";
    const actual = typeof check.actual === "number" ? check.actual.toFixed(4) : check.actual;
    const threshold = typeof check.threshold === "number" ? check.threshold.toFixed(4) : check.threshold;
    lines.push(`| ${icon} | ${check.name} | ${actual} | ${threshold} | ${check.message} |`);
  }
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(result.summary);
  lines.push("");

  return lines.join("\n");
}

// Run if executed directly
if (process.argv[1]?.includes("quality-gates")) {
  runQualityGates().then(result => {
    console.log("");
    console.log(formatQualityGateReport(result));
    console.log("");
    console.log(result.summary);
    process.exit(result.exitCode);
  }).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
