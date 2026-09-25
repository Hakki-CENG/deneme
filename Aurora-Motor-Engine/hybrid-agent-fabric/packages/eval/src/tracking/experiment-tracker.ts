/**
 * Experiment Tracker
 * Centralized tracking and history for all eval experiments.
 * 
 * Features:
 *   - Unified experiment registry
 *   - Version tracking for experiments
 *   - Experiment comparison
 *   - Tag-based filtering
 *   - Export/import capabilities
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let RESULTS_DIR: string;
let EXPERIMENTS_DIR: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  RESULTS_DIR = resolve(__dirname, "../../results");
  EXPERIMENTS_DIR = resolve(__dirname, "../../results/experiments");
} catch {
  RESULTS_DIR = resolve(process.cwd(), "packages/eval/results");
  EXPERIMENTS_DIR = resolve(process.cwd(), "packages/eval/results/experiments");
}

export interface Experiment {
  /** Unique experiment ID */
  id: string;
  /** Experiment name */
  name: string;
  /** Description */
  description: string;
  /** Version */
  version: string;
  /** Tags for filtering */
  tags: string[];
  /** Creation timestamp */
  createdAt: string;
  /** Last updated timestamp */
  updatedAt: string;
  /** Experiment status */
  status: "draft" | "running" | "completed" | "failed" | "archived";
  /** Configuration */
  config: Record<string, unknown>;
  /** Results summary */
  results?: ExperimentResults;
  /** Notes */
  notes: string[];
}

export interface ExperimentResults {
  /** Total tasks run */
  totalTasks: number;
  /** Tasks passed */
  passed: number;
  /** Tasks failed */
  failed: number;
  /** Overall score */
  score: number;
  /** Duration in ms */
  durationMs: number;
  /** Timestamp of results */
  timestamp: string;
  /** Detailed results path */
  resultsPath?: string;
}

export interface ExperimentComparison {
  /** Experiment A */
  experimentA: Experiment;
  /** Experiment B */
  experimentB: Experiment;
  /** Score difference */
  scoreDelta: number;
  /** Speed difference */
  speedDelta: number;
  /** Winner */
  winner: string;
  /** Confidence */
  confidence: number;
}

export interface ExperimentSummary {
  /** Total experiments */
  total: number;
  /** By status */
  byStatus: Record<string, number>;
  /** By tag */
  byTag: Record<string, number>;
  /** Recent experiments */
  recent: Experiment[];
  /** Best performing */
  best: Experiment | null;
}

/**
 * Create a new experiment.
 */
export async function createExperiment(experiment: Omit<Experiment, "id" | "createdAt" | "updatedAt" | "notes">): Promise<Experiment> {
  const id = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const fullExperiment: Experiment = {
    ...experiment,
    id,
    createdAt: now,
    updatedAt: now,
    notes: [],
  };

  await saveExperiment(fullExperiment);
  return fullExperiment;
}

/**
 * Save an experiment to disk.
 */
export async function saveExperiment(experiment: Experiment): Promise<void> {
  await mkdir(EXPERIMENTS_DIR, { recursive: true });
  const filePath = join(EXPERIMENTS_DIR, `${experiment.id}.json`);
  await writeFile(filePath, JSON.stringify(experiment, null, 2));
}

/**
 * Load an experiment by ID.
 */
export async function loadExperiment(id: string): Promise<Experiment | null> {
  try {
    const filePath = join(EXPERIMENTS_DIR, `${id}.json`);
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as Experiment;
  } catch {
    return null;
  }
}

/**
 * Load all experiments.
 */
export async function loadAllExperiments(): Promise<Experiment[]> {
  const experiments: Experiment[] = [];

  try {
    const files = await readdir(EXPERIMENTS_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await readFile(join(EXPERIMENTS_DIR, file), "utf-8");
        experiments.push(JSON.parse(content) as Experiment);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return experiments.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

/**
 * Update experiment status.
 */
export async function updateExperimentStatus(
  id: string,
  status: Experiment["status"],
  notes?: string,
): Promise<Experiment | null> {
  const experiment = await loadExperiment(id);
  if (!experiment) return null;

  experiment.status = status;
  experiment.updatedAt = new Date().toISOString();
  if (notes) experiment.notes.push(`[${new Date().toISOString()}] ${notes}`);

  await saveExperiment(experiment);
  return experiment;
}

/**
 * Add results to an experiment.
 */
export async function addExperimentResults(
  id: string,
  results: ExperimentResults,
): Promise<Experiment | null> {
  const experiment = await loadExperiment(id);
  if (!experiment) return null;

  experiment.results = results;
  experiment.status = "completed";
  experiment.updatedAt = new Date().toISOString();
  experiment.notes.push(`[${new Date().toISOString()}] Results added: ${(results.score * 100).toFixed(1)}% score`);

  await saveExperiment(experiment);
  return experiment;
}

/**
 * Compare two experiments.
 */
export async function compareExperiments(
  idA: string,
  idB: string,
): Promise<ExperimentComparison | null> {
  const expA = await loadExperiment(idA);
  const expB = await loadExperiment(idB);

  if (!expA || !expB || !expA.results || !expB.results) return null;

  const scoreDelta = expA.results.score - expB.results.score;
  const speedDelta = expB.results.durationMs - expA.results.durationMs; // Positive = A is faster

  const winner = scoreDelta > 0 ? expA.name : expB.name;
  const confidence = Math.min(Math.abs(scoreDelta) / 0.1, 1); // Simplified confidence

  return {
    experimentA: expA,
    experimentB: expB,
    scoreDelta,
    speedDelta,
    winner,
    confidence,
  };
}

/**
 * Filter experiments by tags.
 */
export async function filterExperimentsByTag(tag: string): Promise<Experiment[]> {
  const all = await loadAllExperiments();
  return all.filter(e => e.tags.includes(tag));
}

/**
 * Get experiment summary statistics.
 */
export async function getExperimentSummary(): Promise<ExperimentSummary> {
  const experiments = await loadAllExperiments();

  const byStatus: Record<string, number> = {};
  const byTag: Record<string, number> = {};

  for (const exp of experiments) {
    byStatus[exp.status] = (byStatus[exp.status] ?? 0) + 1;
    for (const tag of exp.tags) {
      byTag[tag] = (byTag[tag] ?? 0) + 1;
    }
  }

  // Find best performing experiment
  const completed = experiments.filter(e => e.results && e.status === "completed");
  const best = completed.length > 0
    ? completed.reduce((best, e) => (e.results!.score > (best.results?.score ?? 0)) ? e : best)
    : null;

  return {
    total: experiments.length,
    byStatus,
    byTag,
    recent: experiments.slice(0, 10),
    best,
  };
}

/**
 * Generate experiment tracker report.
 */
export async function generateExperimentReport(): Promise<string> {
  await mkdir(EXPERIMENTS_DIR, { recursive: true });
  const summary = await getExperimentSummary();

  const lines: string[] = [];

  lines.push("# Experiment Tracker Report");
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Total Experiments:** ${summary.total}`);
  lines.push("");

  // Status breakdown
  lines.push("## Experiments by Status");
  lines.push("");
  lines.push("| Status | Count |");
  lines.push("|--------|-------|");
  for (const [status, count] of Object.entries(summary.byStatus)) {
    const icon = status === "completed" ? "✅" : status === "running" ? "🔄" : status === "failed" ? "❌" : "📝";
    lines.push(`| ${icon} ${status} | ${count} |`);
  }
  lines.push("");

  // Tag breakdown
  if (Object.keys(summary.byTag).length > 0) {
    lines.push("## Experiments by Tag");
    lines.push("");
    lines.push("| Tag | Count |");
    lines.push("|-----|-------|");
    for (const [tag, count] of Object.entries(summary.byTag).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${tag} | ${count} |`);
    }
    lines.push("");
  }

  // Best experiment
  if (summary.best) {
    lines.push("## 🏆 Best Performing Experiment");
    lines.push("");
    lines.push(`**${summary.best.name}**`);
    lines.push(`- Score: ${(summary.best.results!.score * 100).toFixed(1)}%`);
    lines.push(`- Tasks: ${summary.best.results!.passed}/${summary.best.results!.totalTasks} passed`);
    lines.push(`- Duration: ${(summary.best.results!.durationMs / 1000).toFixed(1)}s`);
    lines.push(`- Tags: ${summary.best.tags.join(", ")}`);
    lines.push("");
  }

  // Recent experiments
  lines.push("## Recent Experiments");
  lines.push("");
  lines.push("| Date | Name | Status | Score | Tags |");
  lines.push("|------|------|--------|-------|------|");

  for (const exp of summary.recent.slice(0, 10)) {
    const date = new Date(exp.updatedAt).toLocaleDateString();
    const statusIcon = exp.status === "completed" ? "✅" : exp.status === "running" ? "🔄" : exp.status === "failed" ? "❌" : "📝";
    const score = exp.results ? `${(exp.results.score * 100).toFixed(1)}%` : "-";
    lines.push(`| ${date} | ${exp.name} | ${statusIcon} ${exp.status} | ${score} | ${exp.tags.slice(0, 2).join(", ")} |`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Run experiment tracking analysis.
 */
export async function runExperimentTracking(): Promise<void> {
  console.log("📋 Running experiment tracking analysis...");

  const summary = await getExperimentSummary();

  console.log(`📊 Total experiments: ${summary.total}`);
  console.log(`   By status: ${Object.entries(summary.byStatus).map(([s, c]) => `${s}=${c}`).join(", ")}`);

  if (summary.best) {
    console.log(`   🏆 Best: ${summary.best.name} (${(summary.best.results!.score * 100).toFixed(1)}%)`);
  }

  // Generate and save report
  const report = await generateExperimentReport();
  const reportPath = join(EXPERIMENTS_DIR, "experiment-tracker-report.md");
  await writeFile(reportPath, report);

  console.log(`📊 Report saved to: ${reportPath}`);
}

// Run if executed directly
if (process.argv[1]?.includes("experiment-tracker")) {
  runExperimentTracking().then(() => {
    console.log("Done.");
  }).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
