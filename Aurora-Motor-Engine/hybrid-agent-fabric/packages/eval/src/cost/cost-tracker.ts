/**
 * Cost Tracker
 * Monitors token usage and calculates costs for eval runs.
 * 
 * Features:
 *   - Token usage tracking per task/category/difficulty
 *   - Cost calculation (configurable pricing)
 *   - Budget monitoring and alerts
 *   - Cost efficiency analysis
 *   - Token optimization recommendations
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let RESULTS_DIR: string;
let COSTS_DIR: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  RESULTS_DIR = resolve(__dirname, "../../results");
  COSTS_DIR = resolve(__dirname, "../../results/costs");
} catch {
  RESULTS_DIR = resolve(process.cwd(), "packages/eval/results");
  COSTS_DIR = resolve(process.cwd(), "packages/eval/results/costs");
}

/** Pricing per 1M tokens (configurable) */
export interface ModelPricing {
  inputPricePer1M: number;   // USD per 1M input tokens
  outputPricePer1M: number;  // USD per 1M output tokens
  name: string;
}

/** Default pricing for common models */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "gpt-4": { inputPricePer1M: 30, outputPricePer1M: 60, name: "GPT-4" },
  "gpt-4-turbo": { inputPricePer1M: 10, outputPricePer1M: 30, name: "GPT-4 Turbo" },
  "gpt-3.5-turbo": { inputPricePer1M: 0.5, outputPricePer1M: 1.5, name: "GPT-3.5 Turbo" },
  "claude-3-opus": { inputPricePer1M: 15, outputPricePer1M: 75, name: "Claude 3 Opus" },
  "claude-3-sonnet": { inputPricePer1M: 3, outputPricePer1M: 15, name: "Claude 3 Sonnet" },
  "claude-3-haiku": { inputPricePer1M: 0.25, outputPricePer1M: 1.25, name: "Claude 3 Haiku" },
  "qwen-2.5-72b": { inputPricePer1M: 0.9, outputPricePer1M: 0.9, name: "Qwen 2.5 72B" },
  "mock": { inputPricePer1M: 0, outputPricePer1M: 0, name: "Mock (Testing)" },
};

export interface CostEntry {
  taskId: string;
  category: string;
  difficulty: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  model: string;
  timestamp: string;
}

export interface CostStats {
  totalTokens: number;
  totalCostUsd: number;
  avgTokensPerTask: number;
  avgCostPerTask: number;
  medianTokensPerTask: number;
  p95Tokens: number;
  p99Tokens: number;
}

export interface CategoryCost {
  category: string;
  taskCount: number;
  totalTokens: number;
  totalCostUsd: number;
  avgTokensPerTask: number;
  avgCostPerTask: number;
}

export interface DifficultyCost {
  difficulty: number;
  label: string;
  taskCount: number;
  totalTokens: number;
  totalCostUsd: number;
  avgTokensPerTask: number;
  avgCostPerTask: number;
}

export interface BudgetAlert {
  severity: "critical" | "warning" | "info";
  message: string;
  currentCost: number;
  budgetLimit: number;
  percentUsed: number;
}

export interface CostReport {
  timestamp: string;
  model: string;
  overall: CostStats;
  byCategory: CategoryCost[];
  byDifficulty: DifficultyCost[];
  budgetAlerts: BudgetAlert[];
  recommendations: string[];
  efficiency: {
    tokensPerSuccessfulStep: number;
    costPerSuccessfulTask: number;
    wastePercentage: number;
  };
}

const DIFFICULTY_LABELS: Record<number, string> = {
  1: "Trivial", 2: "Easy", 3: "Medium", 4: "Hard", 5: "Expert",
};

/**
 * Calculate cost statistics for a set of entries.
 */
function calculateCostStats(entries: CostEntry[]): CostStats {
  if (entries.length === 0) {
    return {
      totalTokens: 0, totalCostUsd: 0,
      avgTokensPerTask: 0, avgCostPerTask: 0,
      medianTokensPerTask: 0, p95Tokens: 0, p99Tokens: 0,
    };
  }

  const tokens = entries.map(e => e.totalTokens).sort((a, b) => a - b);
  const totalTokens = tokens.reduce((a, b) => a + b, 0);
  const totalCost = entries.reduce((sum, e) => sum + e.costUsd, 0);

  const p95Index = Math.floor(tokens.length * 0.95);
  const p99Index = Math.floor(tokens.length * 0.99);

  return {
    totalTokens,
    totalCostUsd: totalCost,
    avgTokensPerTask: totalTokens / entries.length,
    avgCostPerTask: totalCost / entries.length,
    medianTokensPerTask: tokens[Math.floor(tokens.length / 2)] ?? 0,
    p95Tokens: tokens[p95Index] ?? tokens[tokens.length - 1] ?? 0,
    p99Tokens: tokens[p99Index] ?? tokens[tokens.length - 1] ?? 0,
  };
}

/**
 * Run cost tracking on eval results.
 */
export async function runCostTracking(options?: {
  model?: string;
  budgetLimit?: number;
}): Promise<CostReport | null> {
  const model = options?.model ?? "mock";
  const budgetLimit = options?.budgetLimit ?? 100; // Default $100 budget

  // Load latest eval results
  const runs = await loadLatestEvalRuns(1);
  if (runs.length === 0) {
    console.log("No eval results found for cost tracking.");
    return null;
  }

  const latestRun = runs[0];
  if (!latestRun) return null;

  const pricing = DEFAULT_PRICING[model] ?? DEFAULT_PRICING["mock"]!;

  // Build cost entries from results
  const entries: CostEntry[] = latestRun.results.map((r: any) => {
    const inputTokens = r.inputTokens ?? r.metrics?.totalTokens ?? 0;
    const outputTokens = r.outputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;

    // Calculate cost
    const inputCost = (inputTokens / 1_000_000) * pricing.inputPricePer1M;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPricePer1M;
    const costUsd = inputCost + outputCost;

    return {
      taskId: r.taskId,
      category: r.category ?? r.taskId.split("-")[0] ?? "unknown",
      difficulty: r.difficulty ?? 3,
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd,
      model,
      timestamp: latestRun.timestamp,
    };
  });

  // Overall stats
  const overall = calculateCostStats(entries);

  // By category
  const categoryMap = new Map<string, CostEntry[]>();
  for (const e of entries) {
    const existing = categoryMap.get(e.category) ?? [];
    existing.push(e);
    categoryMap.set(e.category, existing);
  }

  const byCategory: CategoryCost[] = [];
  for (const [category, catEntries] of categoryMap) {
    const stats = calculateCostStats(catEntries);
    byCategory.push({
      category,
      taskCount: catEntries.length,
      totalTokens: stats.totalTokens,
      totalCostUsd: stats.totalCostUsd,
      avgTokensPerTask: stats.avgTokensPerTask,
      avgCostPerTask: stats.avgCostPerTask,
    });
  }

  // By difficulty
  const difficultyMap = new Map<number, CostEntry[]>();
  for (const e of entries) {
    const existing = difficultyMap.get(e.difficulty) ?? [];
    existing.push(e);
    difficultyMap.set(e.difficulty, existing);
  }

  const byDifficulty: DifficultyCost[] = [];
  for (const [difficulty, diffEntries] of difficultyMap) {
    const stats = calculateCostStats(diffEntries);
    byDifficulty.push({
      difficulty,
      label: DIFFICULTY_LABELS[difficulty] ?? "Unknown",
      taskCount: diffEntries.length,
      totalTokens: stats.totalTokens,
      totalCostUsd: stats.totalCostUsd,
      avgTokensPerTask: stats.avgTokensPerTask,
      avgCostPerTask: stats.avgCostPerTask,
    });
  }

  // Budget alerts
  const budgetAlerts = checkBudget(overall.totalCostUsd, budgetLimit);

  // Efficiency analysis
  const passedEntries = entries.filter((_, i) => latestRun.results[i]?.status === "pass");
  const failedEntries = entries.filter((_, i) => latestRun.results[i]?.status !== "pass");
  const passedTokens = passedEntries.reduce((sum, e) => sum + e.totalTokens, 0);
  const failedTokens = failedEntries.reduce((sum, e) => sum + e.totalTokens, 0);
  const totalTokens = passedTokens + failedTokens;

  const efficiency = {
    tokensPerSuccessfulStep: passedEntries.length > 0 ? passedTokens / passedEntries.length : 0,
    costPerSuccessfulTask: passedEntries.length > 0 ? passedEntries.reduce((s, e) => s + e.costUsd, 0) / passedEntries.length : 0,
    wastePercentage: totalTokens > 0 ? (failedTokens / totalTokens) * 100 : 0,
  };

  // Recommendations
  const recommendations = generateCostRecommendations(overall, byCategory, efficiency, budgetAlerts);

  const report: CostReport = {
    timestamp: new Date().toISOString(),
    model,
    overall,
    byCategory,
    byDifficulty,
    budgetAlerts,
    recommendations,
    efficiency,
  };

  // Save report
  await mkdir(COSTS_DIR, { recursive: true });
  const reportPath = join(COSTS_DIR, `cost-report-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  const markdownPath = join(COSTS_DIR, "cost-report.md");
  await writeFile(markdownPath, formatCostReport(report));

  console.log(`💰 Cost report saved to: ${markdownPath}`);

  return report;
}

/**
 * Check budget and generate alerts.
 */
function checkBudget(currentCost: number, budgetLimit: number): BudgetAlert[] {
  const alerts: BudgetAlert[] = [];
  const percentUsed = (currentCost / budgetLimit) * 100;

  if (percentUsed >= 100) {
    alerts.push({
      severity: "critical",
      message: `Budget exceeded! Current: $${currentCost.toFixed(4)}, Limit: $${budgetLimit.toFixed(2)}`,
      currentCost,
      budgetLimit,
      percentUsed,
    });
  } else if (percentUsed >= 80) {
    alerts.push({
      severity: "warning",
      message: `Budget at ${percentUsed.toFixed(0)}%. Current: $${currentCost.toFixed(4)}, Limit: $${budgetLimit.toFixed(2)}`,
      currentCost,
      budgetLimit,
      percentUsed,
    });
  } else if (percentUsed >= 50) {
    alerts.push({
      severity: "info",
      message: `Budget at ${percentUsed.toFixed(0)}%. Current: $${currentCost.toFixed(4)}, Limit: $${budgetLimit.toFixed(2)}`,
      currentCost,
      budgetLimit,
      percentUsed,
    });
  }

  return alerts;
}

/**
 * Generate cost optimization recommendations.
 */
function generateCostRecommendations(
  overall: CostStats,
  byCategory: CategoryCost[],
  efficiency: { tokensPerSuccessfulStep: number; costPerSuccessfulTask: number; wastePercentage: number },
  alerts: BudgetAlert[],
): string[] {
  const recommendations: string[] = [];

  // High token usage
  if (overall.avgTokensPerTask > 10000) {
    recommendations.push(`High average token usage (${overall.avgTokensPerTask.toFixed(0)} tokens/task). Consider optimizing prompts.`);
  }

  // Expensive categories
  const sortedByCost = [...byCategory].sort((a, b) => b.avgCostPerTask - a.avgCostPerTask);
  if (sortedByCost.length > 0 && sortedByCost[0]) {
    const expensive = sortedByCost[0];
    if (expensive.avgCostPerTask > overall.avgCostPerTask * 2) {
      recommendations.push(`${expensive.category} is ${(expensive.avgCostPerTask / overall.avgCostPerTask * 100).toFixed(0)}% more expensive than average. Optimize token usage.`);
    }
  }

  // Waste
  if (efficiency.wastePercentage > 20) {
    recommendations.push(`${efficiency.wastePercentage.toFixed(0)}% of tokens wasted on failed tasks. Improve task success rate.`);
  }

  // Budget alerts
  if (alerts.some(a => a.severity === "critical")) {
    recommendations.push("URGENT: Budget exceeded. Reduce task count or optimize token usage.");
  }

  return recommendations;
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
 * Format cost report as markdown.
 */
export function formatCostReport(report: CostReport): string {
  const lines: string[] = [];

  lines.push("# Cost Tracking Report");
  lines.push("");
  lines.push(`**Generated:** ${report.timestamp}`);
  lines.push(`**Model:** ${report.model}`);
  lines.push("");

  // Budget status
  if (report.budgetAlerts.length > 0) {
    for (const alert of report.budgetAlerts) {
      const icon = alert.severity === "critical" ? "🔴" : alert.severity === "warning" ? "🟠" : "🔵";
      lines.push(`${icon} **${alert.message}**`);
    }
    lines.push("");
  }

  // Overall stats
  lines.push("## Overall Cost Statistics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total Tokens | ${report.overall.totalTokens.toLocaleString()} |`);
  lines.push(`| Total Cost | $${report.overall.totalCostUsd.toFixed(4)} |`);
  lines.push(`| Avg Tokens/Task | ${report.overall.avgTokensPerTask.toFixed(0)} |`);
  lines.push(`| Avg Cost/Task | $${report.overall.avgCostPerTask.toFixed(6)} |`);
  lines.push(`| Median Tokens | ${report.overall.medianTokensPerTask.toFixed(0)} |`);
  lines.push(`| P95 Tokens | ${report.overall.p95Tokens.toLocaleString()} |`);
  lines.push(`| P99 Tokens | ${report.overall.p99Tokens.toLocaleString()} |`);
  lines.push("");

  // Efficiency
  lines.push("## Efficiency Metrics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Tokens/Successful Task | ${report.efficiency.tokensPerSuccessfulStep.toFixed(0)} |`);
  lines.push(`| Cost/Successful Task | $${report.efficiency.costPerSuccessfulTask.toFixed(6)} |`);
  lines.push(`| Token Waste | ${report.efficiency.wastePercentage.toFixed(1)}% |`);
  lines.push("");

  // By category
  lines.push("## Cost by Category");
  lines.push("");
  lines.push("| Category | Tasks | Total Tokens | Total Cost | Avg Tokens | Avg Cost |");
  lines.push("|----------|-------|--------------|------------|------------|----------|");
  for (const cat of report.byCategory.sort((a, b) => b.totalCostUsd - a.totalCostUsd)) {
    lines.push(`| ${cat.category} | ${cat.taskCount} | ${cat.totalTokens.toLocaleString()} | $${cat.totalCostUsd.toFixed(4)} | ${cat.avgTokensPerTask.toFixed(0)} | $${cat.avgCostPerTask.toFixed(6)} |`);
  }
  lines.push("");

  // By difficulty
  lines.push("## Cost by Difficulty");
  lines.push("");
  lines.push("| Level | Label | Tasks | Total Tokens | Total Cost | Avg Tokens | Avg Cost |");
  lines.push("|-------|-------|-------|--------------|------------|------------|----------|");
  for (const diff of report.byDifficulty.sort((a, b) => a.difficulty - b.difficulty)) {
    lines.push(`| ${diff.difficulty} | ${diff.label} | ${diff.taskCount} | ${diff.totalTokens.toLocaleString()} | $${diff.totalCostUsd.toFixed(4)} | ${diff.avgTokensPerTask.toFixed(0)} | $${diff.avgCostPerTask.toFixed(6)} |`);
  }
  lines.push("");

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
if (process.argv[1]?.includes("cost-tracker")) {
  const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] ?? "mock" : "mock";
  const budget = process.argv.includes("--budget") ? parseFloat(process.argv[process.argv.indexOf("--budget") + 1] ?? "100") : 100;

  const opts: { model?: string; budgetLimit?: number } = {};
  opts.model = model;
  opts.budgetLimit = budget;

  runCostTracking(opts).then(report => {
    if (report) {
      console.log("");
      console.log(formatCostReport(report));
    }
  }).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
