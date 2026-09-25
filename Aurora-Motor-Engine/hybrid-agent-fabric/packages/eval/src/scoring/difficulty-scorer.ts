/**
 * Difficulty Scorer
 * Weights eval tasks by difficulty level and provides adaptive task selection.
 * 
 * Difficulty levels:
 *   1 = Trivial (basic operations)
 *   2 = Easy (single-step tasks)
 *   3 = Medium (multi-step, some complexity)
 *   4 = Hard (complex reasoning, multiple subsystems)
 *   5 = Expert (long-horizon, adversarial, edge cases)
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let TASKS_DIR: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  TASKS_DIR = resolve(__dirname, "../../tasks");
} catch {
  TASKS_DIR = resolve(process.cwd(), "packages/eval/tasks");
}

const DIFFICULTY_WEIGHTS: Record<number, number> = { 1: 0.5, 2: 0.75, 3: 1.0, 4: 1.5, 5: 2.0 };
const DIFFICULTY_LABELS: Record<number, string> = { 1: "Trivial", 2: "Easy", 3: "Medium", 4: "Hard", 5: "Expert" };

export interface TaskDifficulty {
  taskId: string;
  category: string;
  difficulty: number;
  weight: number;
  label: string;
}

export interface DifficultyScore {
  weightedScore: number;
  rawScore: number;
  byDifficulty: Record<number, { passed: number; total: number; rate: number; weight: number }>;
  byCategory: Record<string, { passed: number; total: number; rate: number; weightedRate: number }>;
  failuresByDifficulty: Record<number, string[]>;
  recommendations: DifficultyRecommendation[];
}

export interface DifficultyRecommendation {
  priority: "critical" | "high" | "medium" | "low";
  area: string;
  finding: string;
  action: string;
  impact: number;
}

export async function loadTaskDifficulties(): Promise<TaskDifficulty[]> {
  const tasks: TaskDifficulty[] = [];
  try {
    const categories = await readdir(TASKS_DIR);
    for (const category of categories) {
      const catDir = join(TASKS_DIR, category);
      try {
        const files = await readdir(catDir);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          try {
            const content = await readFile(join(catDir, file), "utf-8");
            const data = JSON.parse(content);
            const difficulty: number = data.difficulty ?? 3;
            tasks.push({
              taskId: data.id,
              category: data.category ?? category,
              difficulty,
              weight: DIFFICULTY_WEIGHTS[difficulty] ?? 1.0,
              label: DIFFICULTY_LABELS[difficulty] ?? "Unknown",
            });
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return tasks;
}

export function calculateDifficultyScore(
  results: { taskId: string; status: string; score: number }[],
  taskDifficulties: TaskDifficulty[],
): DifficultyScore {
  const difficultyMap = new Map(taskDifficulties.map(t => [t.taskId, t]));

  const byDifficulty: Record<number, { passed: number; total: number; rate: number; weight: number }> = {};
  for (let d = 1; d <= 5; d++) {
    byDifficulty[d] = { passed: 0, total: 0, rate: 0, weight: DIFFICULTY_WEIGHTS[d] ?? 1.0 };
  }

  const byCategory: Record<string, { passed: number; total: number; rate: number; weightedRate: number }> = {};
  const failuresByDifficulty: Record<number, string[]> = {};
  for (let d = 1; d <= 5; d++) failuresByDifficulty[d] = [];

  let totalWeightedScore = 0;
  let totalWeight = 0;
  let totalRawScore = 0;

  for (const result of results) {
    const taskInfo = difficultyMap.get(result.taskId);
    const difficulty = taskInfo?.difficulty ?? 3;
    const weight = taskInfo?.weight ?? 1.0;
    const category = taskInfo?.category ?? result.taskId.split("-")[0] ?? "unknown";

    const diffBucket = byDifficulty[difficulty];
    if (diffBucket) {
      diffBucket.total++;
      if (result.status === "pass") diffBucket.passed++;
    }

    const catStats = byCategory[category];
    if (catStats) {
      catStats.total++;
      if (result.status === "pass") catStats.passed++;
    } else {
      byCategory[category] = { passed: result.status === "pass" ? 1 : 0, total: 1, rate: 0, weightedRate: 0 };
    }

    totalWeightedScore += result.score * weight;
    totalWeight += weight;
    totalRawScore += result.score;

    if (result.status !== "pass" && failuresByDifficulty[difficulty]) {
      failuresByDifficulty[difficulty].push(result.taskId);
    }
  }

  // Calculate rates
  for (let d = 1; d <= 5; d++) {
    const bucket = byDifficulty[d];
    if (bucket) bucket.rate = bucket.total > 0 ? bucket.passed / bucket.total : 0;
  }

  for (const cat of Object.keys(byCategory)) {
    const stats = byCategory[cat];
    if (!stats) continue;
    stats.rate = stats.total > 0 ? stats.passed / stats.total : 0;
    const catResults = results.filter(r => {
      const info = difficultyMap.get(r.taskId);
      return (info?.category ?? r.taskId.split("-")[0]) === cat;
    });
    let catWeightedScore = 0;
    let catTotalWeight = 0;
    for (const r of catResults) {
      const info = difficultyMap.get(r.taskId);
      const w = info?.weight ?? 1.0;
      catWeightedScore += r.score * w;
      catTotalWeight += w;
    }
    stats.weightedRate = catTotalWeight > 0 ? catWeightedScore / catTotalWeight : 0;
  }

  const weightedScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;
  const rawScore = results.length > 0 ? totalRawScore / results.length : 0;

  const recommendations = generateDifficultyRecommendations(byDifficulty, byCategory, failuresByDifficulty, weightedScore);

  return { weightedScore, rawScore, byDifficulty, byCategory, failuresByDifficulty, recommendations };
}

function generateDifficultyRecommendations(
  byDifficulty: Record<number, { passed: number; total: number; rate: number; weight: number }>,
  byCategory: Record<string, { passed: number; total: number; rate: number; weightedRate: number }>,
  failuresByDifficulty: Record<number, string[]>,
  _currentScore: number,
): DifficultyRecommendation[] {
  const recommendations: DifficultyRecommendation[] = [];

  for (let d = 5; d >= 1; d--) {
    const stats = byDifficulty[d];
    if (!stats || stats.total === 0) continue;
    const failureRate = 1 - stats.rate;
    const impact = failureRate * stats.weight * 0.2;
    if (stats.rate < 0.5 && d >= 4) {
      recommendations.push({
        priority: "critical",
        area: `${DIFFICULTY_LABELS[d] ?? "Unknown"} (Level ${d})`,
        finding: `${(stats.rate * 100).toFixed(0)}% pass rate on ${DIFFICULTY_LABELS[d] ?? "Unknown"} tasks (${stats.passed}/${stats.total})`,
        action: `Focus on ${(DIFFICULTY_LABELS[d] ?? "unknown").toLowerCase()} tasks — ${stats.weight}x weight. Failed: ${(failuresByDifficulty[d] ?? []).slice(0, 3).join(", ")}`,
        impact,
      });
    } else if (stats.rate < 0.8 && d >= 3) {
      recommendations.push({
        priority: "high",
        area: `${DIFFICULTY_LABELS[d] ?? "Unknown"} (Level ${d})`,
        finding: `${(stats.rate * 100).toFixed(0)}% pass rate on ${DIFFICULTY_LABELS[d] ?? "Unknown"} tasks`,
        action: `Improve ${(DIFFICULTY_LABELS[d] ?? "unknown").toLowerCase()} task handling — ${stats.weight}x weight multiplier`,
        impact,
      });
    }
  }

  for (const [cat, stats] of Object.entries(byCategory)) {
    if (!stats || stats.total === 0) continue;
    if (stats.weightedRate < 0.5) {
      recommendations.push({ priority: "critical", area: cat, finding: `${cat} weighted score is ${(stats.weightedRate * 100).toFixed(0)}%`, action: `Prioritize ${cat}`, impact: (1 - stats.weightedRate) * 0.15 });
    } else if (stats.weightedRate < 0.8) {
      recommendations.push({ priority: "high", area: cat, finding: `${cat} weighted score is ${(stats.weightedRate * 100).toFixed(0)}%`, action: `Improve ${cat}`, impact: (1 - stats.weightedRate) * 0.1 });
    }
  }

  recommendations.sort((a, b) => b.impact - a.impact);
  return recommendations;
}

export function selectAdaptiveTasks(
  allTasks: TaskDifficulty[],
  previousResults: { taskId: string; status: string }[],
  options: { maxTasks?: number; focusOnFailures?: boolean; minDifficulty?: number; categories?: string[] } = {},
): TaskDifficulty[] {
  const { maxTasks = 75, focusOnFailures = true, minDifficulty = 1, categories } = options;

  let candidates = allTasks;
  if (categories && categories.length > 0) {
    candidates = candidates.filter(t => categories.includes(t.category));
  }
  candidates = candidates.filter(t => t.difficulty >= minDifficulty);

  const scored = candidates.map(task => {
    const prevResult = previousResults.find(r => r.taskId === task.taskId);
    let priority = task.weight;
    if (focusOnFailures && prevResult) {
      priority = prevResult.status !== "pass" ? priority * 3.0 : priority * 0.5;
    }
    return { ...task, priority };
  });

  scored.sort((a, b) => b.priority - a.priority);
  return scored.slice(0, maxTasks);
}

export function formatDifficultyReport(score: DifficultyScore): string {
  const lines: string[] = [];
  lines.push("# Difficulty Analysis Report");
  lines.push("");
  lines.push(`**Weighted Score:** ${(score.weightedScore * 100).toFixed(1)}%`);
  lines.push(`**Raw Score:** ${(score.rawScore * 100).toFixed(1)}%`);
  lines.push(`**Difficulty Bonus:** ${((score.weightedScore - score.rawScore) * 100).toFixed(1)}%`);
  lines.push("");

  lines.push("## Score by Difficulty Level");
  lines.push("");
  lines.push("| Level | Label | Passed | Total | Rate | Weight | Weighted Rate |");
  lines.push("|-------|-------|--------|-------|------|--------|---------------|");
  for (let d = 1; d <= 5; d++) {
    const stats = score.byDifficulty[d];
    if (!stats || stats.total === 0) continue;
    const weightedRate = stats.rate * stats.weight;
    const icon = stats.rate >= 0.8 ? "✅" : stats.rate >= 0.5 ? "⚠️" : "❌";
    lines.push(`| ${d} | ${DIFFICULTY_LABELS[d] ?? "?"} | ${stats.passed} | ${stats.total} | ${(stats.rate * 100).toFixed(0)}% | ${stats.weight}x | ${icon} ${(weightedRate * 100).toFixed(0)}% |`);
  }
  lines.push("");

  lines.push("## Score by Category (Weighted)");
  lines.push("");
  lines.push("| Category | Passed | Total | Raw Rate | Weighted Rate |");
  lines.push("|----------|--------|-------|----------|---------------|");
  for (const [cat, stats] of Object.entries(score.byCategory).sort((a, b) => b[1].weightedRate - a[1].weightedRate)) {
    if (!stats) continue;
    const icon = stats.weightedRate >= 0.8 ? "✅" : stats.weightedRate >= 0.5 ? "⚠️" : "❌";
    lines.push(`| ${cat} | ${stats.passed} | ${stats.total} | ${(stats.rate * 100).toFixed(0)}% | ${icon} ${(stats.weightedRate * 100).toFixed(0)}% |`);
  }
  lines.push("");

  if (score.recommendations.length > 0) {
    lines.push("## Recommendations");
    lines.push("");
    for (const rec of score.recommendations) {
      const icon = rec.priority === "critical" ? "🔴" : rec.priority === "high" ? "🟠" : rec.priority === "medium" ? "🟡" : "🟢";
      lines.push(`### ${icon} ${rec.area}`);
      lines.push(`- **Finding:** ${rec.finding}`);
      lines.push(`- **Action:** ${rec.action}`);
      lines.push(`- **Impact:** +${(rec.impact * 100).toFixed(1)}% potential improvement`);
      lines.push("");
    }
  }

  return lines.join("\n");
}
