/**
 * Eval Metrics
 * Aggregates and analyzes evaluation metrics.
 */

import type { TaskMetrics, EvalResult } from "../tasks/types.js";

/** Calculate aggregate metrics from multiple task metrics */
export function calculateAggregateMetrics(metrics: TaskMetrics[]): TaskMetrics {
  if (metrics.length === 0) {
    return {
      totalTokens: 0,
      totalCostUsd: 0,
      totalSteps: 0,
      toolCalls: 0,
      toolFailures: 0,
      replans: 0,
      memoryRecalls: 0,
      verificationAttempts: 0,
    };
  }

  return {
    totalTokens: metrics.reduce((sum, m) => sum + m.totalTokens, 0),
    totalCostUsd: metrics.reduce((sum, m) => sum + m.totalCostUsd, 0),
    totalSteps: metrics.reduce((sum, m) => sum + m.totalSteps, 0),
    toolCalls: metrics.reduce((sum, m) => sum + m.toolCalls, 0),
    toolFailures: metrics.reduce((sum, m) => sum + m.toolFailures, 0),
    replans: metrics.reduce((sum, m) => sum + m.replans, 0),
    memoryRecalls: metrics.reduce((sum, m) => sum + m.memoryRecalls, 0),
    verificationAttempts: metrics.reduce((sum, m) => sum + m.verificationAttempts, 0),
  };
}

// `compareResults()` used to live here: it diffed two EvalSuiteResults into
// score/pass-rate/cost/step deltas plus an `improved` boolean. It was deleted
// because nothing called it — not a runner, not a report, not a test. Two
// reasons not to keep it "just in case":
//
//   1. Dead measurement code reads as coverage. A reviewer scanning this file
//      sees regression comparison and assumes regressions are compared.
//   2. It expected fields (`overallScore`, `aggregateMetrics`) that the suite
//      JSON on disk does not even carry, so it could not have run correctly
//      against real results without being rewritten anyway.
//
// The live equivalent is in `dashboard/eval-dashboard.ts`, which compares
// consecutive runs and reports regressions from the same on-disk history.

/** Format metrics as human-readable string */
export function formatMetrics(metrics: TaskMetrics): string {
  return [
    `Tokens: ${metrics.totalTokens.toLocaleString()}`,
    `Cost: $${metrics.totalCostUsd.toFixed(4)}`,
    `Steps: ${metrics.totalSteps}`,
    `Tools: ${metrics.toolCalls} (${metrics.toolFailures} failures)`,
    `Replans: ${metrics.replans}`,
    `Memory: ${metrics.memoryRecalls} recalls`,
    `Verification: ${metrics.verificationAttempts} attempts`,
  ].join(" | ");
}
