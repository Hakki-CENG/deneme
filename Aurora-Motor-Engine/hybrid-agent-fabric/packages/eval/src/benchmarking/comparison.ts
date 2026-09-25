/**
 * P3.2 competitor comparison, without fabricated competitors.
 *
 * The master plan asks for a metric set on a shared benchmark: task success,
 * verified success, task completion, recovery success, latency, cost,
 * interventions, memory retention and false-success rate. What it cannot ask
 * for honestly is numbers for agents that were never run: a comparison table
 * with invented competitor scores is fabricated evidence.
 *
 * So this module defines the metric set and computes it from recorded run
 * results — ours from the engine, any external agent's from a result file in
 * the same shape. Metrics a run did not record are reported as
 * `notProvided` with the count of runs that did have them; they are never
 * zero-filled, because "0 ms latency" and "latency was not measured" are
 * different claims.
 */

export interface ComparisonTaskResult {
  taskId: string;
  /** Whether the task's own completion criteria were met. */
  success?: boolean;
  /** Whether an independent verifier confirmed the outcome. */
  verified?: boolean;
  /** Whether the task reached a terminal state (any verdict). */
  completed?: boolean;
  /** Whether a failed attempt was recovered and the task still finished. */
  recovered?: boolean;
  latencyMs?: number;
  costUsd?: number;
  /** Human interventions required during the run. */
  interventions?: number;
  /** 0..1 fraction of required context retained across the run's sessions. */
  memoryRetention?: number;
}

export interface ComparisonRun {
  /** The agent or runtime that produced these results. */
  agent: string;
  results: ComparisonTaskResult[];
  /** Provenance note: how these numbers were obtained. */
  source?: string;
}

export interface ComparisonMetric {
  name: string;
  /** The per-agent values in the order the runs were given. */
  values: Array<number | "not-provided">;
  unit: "ratio" | "milliseconds" | "usd" | "count";
  /** How many runs actually recorded this metric. */
  providedRuns: number;
}

export interface ComparisonReport {
  agents: string[];
  metrics: ComparisonMetric[];
  /** Tasks only one agent ran are excluded from ratios and named here. */
  nonOverlappingTaskIds: string[];
  honestNotes: string[];
}

function ratio(values: Array<boolean | undefined>): number | "not-provided" {
  const present = values.filter((value) => value !== undefined) as boolean[];
  if (present.length === 0) return "not-provided";
  return present.filter(Boolean).length / present.length;
}

function average(values: Array<number | undefined>): number | "not-provided" {
  const present = values.filter((value) => value !== undefined) as number[];
  if (present.length === 0) return "not-provided";
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

/**
 * False-success rate: the agent claimed success on a task that independent
 * verification did not confirm. Only computable for tasks where BOTH success
 * and verified were recorded; the report says how many tasks that was.
 */
function falseSuccessRate(results: ComparisonTaskResult[]): { value: number | "not-provided"; basis: number } {
  const both = results.filter((result) => result.success !== undefined && result.verified !== undefined);
  if (both.length === 0) return { value: "not-provided", basis: 0 };
  const claimed = both.filter((result) => result.success === true);
  if (claimed.length === 0) return { value: 0, basis: both.length };
  return { value: claimed.filter((result) => result.verified !== true).length / claimed.length, basis: both.length };
}

export function compareRuns(runs: readonly ComparisonRun[]): ComparisonReport {
  if (runs.length === 0) {
    return { agents: [], metrics: [], nonOverlappingTaskIds: [], honestNotes: ["No runs were provided."] };
  }

  // Shared task set: a ratio over different task sets is not a comparison.
  const taskIds = [...new Set(runs.flatMap((run) => run.results.map((result) => result.taskId)))];
  const appearances = new Map(taskIds.map((taskId) => [taskId, 0]));
  for (const run of runs) {
    for (const result of run.results) {
      appearances.set(result.taskId, (appearances.get(result.taskId) ?? 0) + 1);
    }
  }
  const sharedTaskIds = taskIds.filter((taskId) => appearances.get(taskId) === runs.length);
  const nonOverlappingTaskIds = taskIds.filter((taskId) => appearances.get(taskId) !== runs.length);

  const pick = (run: ComparisonRun, taskId: string) => run.results.find((result) => result.taskId === taskId);

  const metric = (
    name: string,
    unit: ComparisonMetric["unit"],
    extract: (results: ComparisonTaskResult[]) => number | "not-provided",
  ): ComparisonMetric => {
    const values = runs.map((run) => {
      const shared = sharedTaskIds.map((taskId) => pick(run, taskId)!).filter((result) => result !== undefined);
      return extract(shared);
    });
    return { name, values, unit, providedRuns: values.filter((value) => value !== "not-provided").length };
  };

  const falseSuccess = metric("false_success_rate", "ratio", (results) => falseSuccessRate(results).value);

  const metrics: ComparisonMetric[] = [
    metric("task_success_rate", "ratio", (results) => ratio(results.map((result) => result.success))),
    metric("verified_success_rate", "ratio", (results) => ratio(results.map((result) => result.verified))),
    metric("task_completion_rate", "ratio", (results) => ratio(results.map((result) => result.completed))),
    metric("recovery_success_rate", "ratio", (results) => ratio(results.map((result) => result.recovered))),
    metric("average_latency_ms", "milliseconds", (results) => average(results.map((result) => result.latencyMs))),
    metric("average_cost_usd", "usd", (results) => average(results.map((result) => result.costUsd))),
    metric("average_interventions", "count", (results) => average(results.map((result) => result.interventions))),
    metric("average_memory_retention", "ratio", (results) => average(results.map((result) => result.memoryRetention))),
    falseSuccess,
  ];

  const honestNotes: string[] = [];
  if (nonOverlappingTaskIds.length > 0) {
    honestNotes.push(
      `${nonOverlappingTaskIds.length} task(s) were not run by every agent and are excluded from every ratio: ${nonOverlappingTaskIds.join(", ")}.`,
    );
  }
  for (const run of runs) {
    if (run.source) honestNotes.push(`${run.agent}: ${run.source}`);
  }
  const falseSuccessBasis = Math.min(
    ...runs.map((run) => run.results.filter((result) => result.success !== undefined && result.verified !== undefined).length),
  );
  if (falseSuccessBasis === 0) {
    honestNotes.push("false_success_rate needs both `success` and `verified` on the same task; no run recorded both.");
  } else {
    honestNotes.push(`false_success_rate computed over ${falseSuccessBasis} task(s) with both success and verification recorded.`);
  }
  honestNotes.push("Metrics a run did not record are 'not-provided', never zero-filled: 'not measured' is not 'zero'.");

  return {
    agents: runs.map((run) => run.agent),
    metrics,
    nonOverlappingTaskIds,
    honestNotes,
  };
}
