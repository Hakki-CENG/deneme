/**
 * A/B Testing Framework
 * Compare different models, prompts, and configurations.
 * 
 * Features:
 *   - Run same tasks with different configurations
 *   - Statistical significance testing
 *   - Performance comparison (score, speed, cost)
 *   - Winner determination
 *   - Experiment tracking
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let RESULTS_DIR: string;
let AB_DIR: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  RESULTS_DIR = resolve(__dirname, "../../results");
  AB_DIR = resolve(__dirname, "../../results/ab-tests");
} catch {
  RESULTS_DIR = resolve(process.cwd(), "packages/eval/results");
  AB_DIR = resolve(process.cwd(), "packages/eval/results/ab-tests");
}

export interface ExperimentConfig {
  /** Experiment ID */
  id: string;
  /** Experiment name */
  name: string;
  /** Description */
  description: string;
  /** Variants to compare */
  variants: VariantConfig[];
  /** Number of tasks to run per variant */
  tasksPerVariant: number;
  /** Task categories to include (empty = all) */
  categories: string[];
  /** Minimum tasks for statistical significance */
  minTasksForSignificance: number;
}

export interface VariantConfig {
  /** Variant ID */
  id: string;
  /** Variant name */
  name: string;
  /** Description */
  description: string;
  /** Configuration overrides */
  config: Record<string, unknown>;
}

export interface VariantResult {
  variantId: string;
  variantName: string;
  tasksRun: number;
  passed: number;
  failed: number;
  errors: number;
  score: number;
  avgDurationMs: number;
  medianDurationMs: number;
  p95DurationMs: number;
  totalTokens: number;
  totalCostUsd: number;
  qualityScore: number;
}

export interface ABTestResult {
  timestamp: string;
  experiment: ExperimentConfig;
  variants: VariantResult[];
  comparison: ComparisonResult;
  winner: {
    variantId: string;
    variantName: string;
    reason: string;
    confidence: number;
  };
  recommendations: string[];
}

export interface ComparisonResult {
  /** Score difference between best and worst */
  scoreDelta: number;
  /** Speed difference (ms) */
  speedDelta: number;
  /** Cost difference (USD) */
  costDelta: number;
  /** Whether difference is statistically significant */
  significant: boolean;
  /** Confidence level (0-1) */
  confidence: number;
  /** P-value (if calculable) */
  pValue?: number;
}

/**
 * Compare two variant results.
 */
function compareVariants(a: VariantResult, b: VariantResult): ComparisonResult {
  const scoreDelta = a.score - b.score;
  const speedDelta = b.avgDurationMs - a.avgDurationMs; // Positive = a is faster
  const costDelta = b.totalCostUsd - a.totalCostUsd; // Positive = a is cheaper

  // Simple significance check (would need proper stats in production)
  const totalTasks = a.tasksRun + b.tasksRun;
  const significant = totalTasks >= 20 && Math.abs(scoreDelta) > 0.05;

  // Confidence based on task count and score difference
  const taskConfidence = Math.min(totalTasks / 50, 1); // Max confidence at50 tasks
  const scoreConfidence = Math.min(Math.abs(scoreDelta) / 0.2, 1); // Max confidence at20% difference
  const confidence = (taskConfidence + scoreConfidence) / 2;

  return {
    scoreDelta,
    speedDelta,
    costDelta,
    significant,
    confidence,
  };
}

/**
 * Determine winner between variants.
 */
function determineWinner(
  variants: VariantResult[],
  comparison: ComparisonResult,
): { variantId: string; variantName: string; reason: string; confidence: number } {
  if (variants.length < 2) {
    return {
      variantId: variants[0]?.variantId ?? "none",
      variantName: variants[0]?.variantName ?? "None",
      reason: "Only one variant",
      confidence: 1,
    };
  }

  // Sort by score (primary), then speed (secondary), then cost (tertiary)
  const sorted = [...variants].sort((a, b) => {
    if (Math.abs(a.score - b.score) > 0.01) return b.score - a.score;
    if (Math.abs(a.avgDurationMs - b.avgDurationMs) > 10) return a.avgDurationMs - b.avgDurationMs;
    return a.totalCostUsd - b.totalCostUsd;
  });

  const best = sorted[0]!;
  const reasons: string[] = [];

  // Explain why this variant won
  if (comparison.scoreDelta > 0.01) {
    reasons.push(`${(comparison.scoreDelta * 100).toFixed(1)}% higher score`);
  }
  if (comparison.speedDelta > 10) {
    reasons.push(`${comparison.speedDelta.toFixed(0)}ms faster`);
  }
  if (comparison.costDelta > 0.001) {
    reasons.push(`$${comparison.costDelta.toFixed(4)} cheaper`);
  }

  return {
    variantId: best.variantId,
    variantName: best.variantName,
    reason: reasons.length > 0 ? reasons.join(", ") : "Best overall performance",
    confidence: comparison.confidence,
  };
}

/**
 * Generate recommendations based on A/B test results.
 */
function generateRecommendations(
  variants: VariantResult[],
  comparison: ComparisonResult,
): string[] {
  const recommendations: string[] = [];

  if (!comparison.significant) {
    recommendations.push("Results are not statistically significant. Run more tasks for conclusive results.");
  }

  if (comparison.confidence < 0.5) {
    recommendations.push("Low confidence in results. Consider running more tasks or increasing task diversity.");
  }

  // Check for big score differences
  if (comparison.scoreDelta > 0.2) {
    recommendations.push("Large score difference detected. The winning variant is significantly better.");
  }

  // Check for cost efficiency
  const bestVariant = variants.reduce((best, v) => v.score > best.score ? v : best);
  const costEfficient = variants.reduce((best, v) => (v.score / Math.max(v.totalCostUsd, 0.001)) > (best.score / Math.max(best.totalCostUsd, 0.001)) ? v : best);

  if (bestVariant.variantId !== costEfficient.variantId) {
    recommendations.push(`Cost-efficient option: ${costEfficient.variantName} offers similar score at lower cost.`);
  }

  return recommendations;
}

/**
 * Run A/B test with provided results.
 */
export async function runABTest(
  experiment: ExperimentConfig,
  variantResults: VariantResult[],
): Promise<ABTestResult> {
  // Compare variants
  let comparison: ComparisonResult = {
    scoreDelta: 0,
    speedDelta: 0,
    costDelta: 0,
    significant: false,
    confidence: 0,
  };

  if (variantResults.length >= 2) {
    // Compare all pairs and take the best comparison
    for (let i = 0; i < variantResults.length; i++) {
      for (let j = i + 1; j < variantResults.length; j++) {
        const pairComparison = compareVariants(variantResults[i]!, variantResults[j]!);
        if (pairComparison.confidence > comparison.confidence) {
          comparison = pairComparison;
        }
      }
    }
  }

  // Determine winner
  const winner = determineWinner(variantResults, comparison);

  // Generate recommendations
  const recommendations = generateRecommendations(variantResults, comparison);

  const result: ABTestResult = {
    timestamp: new Date().toISOString(),
    experiment,
    variants: variantResults,
    comparison,
    winner,
    recommendations,
  };

  // Save result
  await mkdir(AB_DIR, { recursive: true });
  const resultPath = join(AB_DIR, `ab-test-${experiment.id}-${Date.now()}.json`);
  await writeFile(resultPath, JSON.stringify(result, null, 2));

  const markdownPath = join(AB_DIR, `ab-test-${experiment.id}.md`);
  await writeFile(markdownPath, formatABTestReport(result));

  return result;
}

/**
 * Format A/B test report as markdown.
 */
export function formatABTestReport(result: ABTestResult): string {
  const lines: string[] = [];

  lines.push("# A/B Test Report");
  lines.push("");
  lines.push(`**Generated:** ${result.timestamp}`);
  lines.push(`**Experiment:** ${result.experiment.name}`);
  lines.push(`**Description:** ${result.experiment.description}`);
  lines.push("");

  // Winner
  lines.push("## 🏆 Winner");
  lines.push("");
  lines.push(`**${result.winner.variantName}**`);
  lines.push(`- Reason: ${result.winner.reason}`);
  lines.push(`- Confidence: ${(result.winner.confidence * 100).toFixed(1)}%`);
  lines.push("");

  // Comparison summary
  lines.push("## Comparison Summary");
  lines.push("");
  lines.push(`| Metric | Delta | Significant |`);
  lines.push(`|--------|-------|-------------|`);
  lines.push(`| Score | ${(result.comparison.scoreDelta * 100).toFixed(1)}% | ${result.comparison.significant ? "✅ Yes" : "❌ No"} |`);
  lines.push(`| Speed | ${result.comparison.speedDelta.toFixed(0)}ms | - |`);
  lines.push(`| Cost | $${result.comparison.costDelta.toFixed(4)} | - |`);
  lines.push(`| Confidence | ${(result.comparison.confidence * 100).toFixed(1)}% | - |`);
  lines.push("");

  // Variants comparison
  lines.push("## Variants Comparison");
  lines.push("");
  lines.push("| Variant | Tasks | Score | Passed | Avg Duration | P95 Duration | Tokens | Cost | Quality |");
  lines.push("|---------|-------|-------|--------|--------------|--------------|--------|------|---------|");

  for (const variant of result.variants) {
    const isWinner = variant.variantId === result.winner.variantId;
    const prefix = isWinner ? "🏆 " : "";
    lines.push(`| ${prefix}${variant.variantName} | ${variant.tasksRun} | ${(variant.score * 100).toFixed(1)}% | ${variant.passed}/${variant.tasksRun} | ${variant.avgDurationMs.toFixed(0)}ms | ${variant.p95DurationMs.toFixed(0)}ms | ${variant.totalTokens.toLocaleString()} | $${variant.totalCostUsd.toFixed(4)} | ${variant.qualityScore.toFixed(2)} |`);
  }
  lines.push("");

  // Detailed comparison
  if (result.variants.length >= 2) {
    lines.push("## Detailed Analysis");
    lines.push("");

    const sorted = [...result.variants].sort((a, b) => b.score - a.score);
    const best = sorted[0]!;
    const worst = sorted[sorted.length - 1]!;

    lines.push(`**Best Variant:** ${best.variantName}`);
    lines.push(`- Score: ${(best.score * 100).toFixed(1)}%`);
    lines.push(`- Avg Duration: ${best.avgDurationMs.toFixed(0)}ms`);
    lines.push(`- Cost: $${best.totalCostUsd.toFixed(4)}`);
    lines.push("");

    lines.push(`**Worst Variant:** ${worst.variantName}`);
    lines.push(`- Score: ${(worst.score * 100).toFixed(1)}%`);
    lines.push(`- Avg Duration: ${worst.avgDurationMs.toFixed(0)}ms`);
    lines.push(`- Cost: $${worst.totalCostUsd.toFixed(4)}`);
    lines.push("");

    // Differences
    lines.push("**Differences:**");
    lines.push(`- Score: ${((best.score - worst.score) * 100).toFixed(1)}% higher`);
    lines.push(`- Speed: ${(worst.avgDurationMs - best.avgDurationMs).toFixed(0)}ms faster`);
    lines.push(`- Cost: $${(worst.totalCostUsd - best.totalCostUsd).toFixed(4)} cheaper`);
    lines.push("");
  }

  // Recommendations
  if (result.recommendations.length > 0) {
    lines.push("## Recommendations");
    lines.push("");
    for (const rec of result.recommendations) {
      lines.push(`- 💡 ${rec}`);
    }
    lines.push("");
  }

  // Experiment config
  lines.push("## Experiment Configuration");
  lines.push("");
  lines.push(`| Setting | Value |`);
  lines.push(`|---------|-------|`);
  lines.push(`| Tasks per Variant | ${result.experiment.tasksPerVariant} |`);
  lines.push(`| Categories | ${result.experiment.categories.length > 0 ? result.experiment.categories.join(", ") : "All"} |`);
  lines.push(`| Min Tasks for Significance | ${result.experiment.minTasksForSignificance} |`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Create a sample A/B test experiment.
 */
export function createSampleExperiment(): ExperimentConfig {
  return {
    id: "sample-comparison",
    name: "Model Comparison",
    description: "Compare different model configurations for task execution",
    variants: [
      {
        id: "baseline",
        name: "Baseline",
        description: "Current default configuration",
        config: { model: "default", temperature: 0.7 },
      },
      {
        id: "optimized",
        name: "Optimized",
        description: "Optimized configuration with lower temperature",
        config: { model: "default", temperature: 0.3 },
      },
    ],
    tasksPerVariant: 20,
    categories: [],
    minTasksForSignificance: 10,
  };
}

/**
 * Load A/B test results from disk.
 */
export async function loadABTestResults(): Promise<ABTestResult[]> {
  const results: ABTestResult[] = [];

  try {
    const files = await readdir(AB_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await readFile(join(AB_DIR, file), "utf-8");
        results.push(JSON.parse(content));
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

/**
 * Run A/B test analysis on existing results.
 */
export async function runABTestAnalysis(): Promise<void> {
  console.log("🧪 Running A/B test analysis...");

  const results = await loadABTestResults();

  if (results.length === 0) {
    console.log("No A/B test results found.");
    return;
  }

  const latest = results[0]!;

  console.log(`📊 Latest A/B test: ${latest.experiment.name}`);
  console.log(`   Winner: ${latest.winner.variantName}`);
  console.log(`   Confidence: ${(latest.winner.confidence * 100).toFixed(1)}%`);
  console.log(`   Variants: ${latest.variants.length}`);

  // Generate summary report
  const summaryPath = join(AB_DIR, "ab-test-summary.md");
  const lines: string[] = [];

  lines.push("# A/B Test Summary");
  lines.push("");
  lines.push(`**Total Experiments:** ${results.length}`);
  lines.push("");

  lines.push("## Recent Experiments");
  lines.push("");
  lines.push("| Date | Experiment | Winner | Confidence | Variants |");
  lines.push("|------|------------|--------|------------|----------|");

  for (const result of results.slice(0, 10)) {
    const date = new Date(result.timestamp).toLocaleDateString();
    lines.push(`| ${date} | ${result.experiment.name} | ${result.winner.variantName} | ${(result.winner.confidence * 100).toFixed(0)}% | ${result.variants.length} |`);
  }

  lines.push("");
  await writeFile(summaryPath, lines.join("\n"));

  console.log(`📊 Summary saved to: ${summaryPath}`);
}

// Run if executed directly
if (process.argv[1]?.includes("ab-testing")) {
  runABTestAnalysis().then(() => {
    console.log("Done.");
  }).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
