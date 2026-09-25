/**
 * Report Generator
 * Generates human-readable and machine-readable reports from eval results.
 */

import type { EvalSuiteResult, EvalResult } from "../tasks/types.js";
import { formatMetrics } from "../metrics/metrics.js";

/** Generate a markdown report */
export function generateMarkdownReport(result: EvalSuiteResult): string {
  const lines: string[] = [];

  lines.push(`# Eval Report: ${result.suiteId}`);
  lines.push("");
  lines.push(`**Date:** ${result.startedAt}`);
  lines.push(`**Duration:** ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Tasks | ${result.totalTasks} |`);
  lines.push(`| Passed | ✅ ${result.passed} |`);
  lines.push(`| Failed | ❌ ${result.failed} |`);
  lines.push(`| Errors | 💥 ${result.errors} |`);
  lines.push(`| Timeouts | ⏰ ${result.timeouts} |`);
  lines.push(`| Overall Score | ${(result.overallScore * 100).toFixed(1)}% |`);
  lines.push(`| Pass Rate | ${((result.passed / result.totalTasks) * 100).toFixed(1)}% |`);
  lines.push("");

  // Aggregate metrics
  lines.push("## Aggregate Metrics");
  lines.push("");
  lines.push(formatMetrics(result.aggregateMetrics));
  lines.push("");

  // Per-task results
  lines.push("## Task Results");
  lines.push("");
  lines.push(`| # | Task | Status | Score | Duration | Tokens | Steps |`);
  lines.push(`|---|------|--------|-------|----------|--------|-------|`);

  result.results.forEach((r, i) => {
    const statusIcon = r.status === "pass" ? "✅" : r.status === "fail" ? "❌" : "💥";
    lines.push(
      `| ${i + 1} | ${r.taskId} | ${statusIcon} ${r.status} | ${(r.score * 100).toFixed(0)}% | ${(r.durationMs / 1000).toFixed(1)}s | ${r.metrics.totalTokens.toLocaleString()} | ${r.metrics.totalSteps} |`
    );
  });

  lines.push("");

  // Failed tasks details
  const failed = result.results.filter(r => r.status !== "pass");
  if (failed.length > 0) {
    lines.push("## Failed Tasks Detail");
    lines.push("");

    for (const r of failed) {
      lines.push(`### ${r.taskId}`);
      lines.push(`- **Status:** ${r.status}`);
      if (r.error) lines.push(`- **Error:** ${r.error}`);
      if (r.grades.length > 0) {
        lines.push(`- **Grades:**`);
        for (const g of r.grades) {
          lines.push(`  - ${g.criteria}: ${g.passed ? "✅" : "❌"} ${g.details}`);
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/** Generate a JSON report (already the result format) */
export function generateJsonReport(result: EvalSuiteResult): string {
  return JSON.stringify(result, null, 2);
}

/** Generate a summary string for logging */
export function generateSummary(result: EvalSuiteResult): string {
  const passRate = ((result.passed / result.totalTasks) * 100).toFixed(1);
  const score = (result.overallScore * 100).toFixed(1);
  const duration = (result.durationMs / 1000).toFixed(1);
  const cost = result.aggregateMetrics.totalCostUsd.toFixed(4);

  return [
    `${result.suiteId}: ${result.passed}/${result.totalTasks} passed (${passRate}%)`,
    `Score: ${score}% | Duration: ${duration}s | Cost: $${cost}`,
  ].join(" | ");
}
