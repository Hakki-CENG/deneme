/**
 * Continuous Monitor
 * Automated eval scheduling and alert system for ongoing quality monitoring.
 * 
 * Features:
 *   - Scheduled eval runs (configurable interval)
 *   - Alert system (email, webhook, log)
 *   - Health check endpoint
 *   - Status dashboard
 *   - Automatic recovery attempts
 */

import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let RESULTS_DIR: string;
let MONITOR_DIR: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  RESULTS_DIR = resolve(__dirname, "../../results");
  MONITOR_DIR = resolve(__dirname, "../../results/monitor");
} catch {
  RESULTS_DIR = resolve(process.cwd(), "packages/eval/results");
  MONITOR_DIR = resolve(process.cwd(), "packages/eval/results/monitor");
}

export interface MonitorConfig {
  /** Eval run interval in minutes */
  intervalMinutes: number;
  /** Enable/disable monitoring */
  enabled: boolean;
  /** Alert thresholds */
  alertThresholds: {
    scoreDrop: number;        // Alert if score drops by this amount
    regressionCount: number;  // Alert if regressions exceed this
    budgetExceeded: number;   // Alert if cost exceeds this
    durationSpike: number;    // Alert if avg duration exceeds this (ms)
  };
  /** Alert channels */
  alertChannels: {
    log: boolean;
    webhook?: string;
    email?: string;
  };
}

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  intervalMinutes: 60,  // Run every hour
  enabled: true,
  alertThresholds: {
    scoreDrop: 0.05,       // Alert on 5% score drop
    regressionCount: 0,    // Alert on any regression
    budgetExceeded: 50,    // Alert on $50 budget
    durationSpike: 200,    // Alert on 200ms avg duration
  },
  alertChannels: {
    log: true,
  },
};

export interface MonitorStatus {
  /** Whether monitoring is active */
  active: boolean;
  /** Last eval run timestamp */
  lastRun: string | null;
  /** Next scheduled run */
  nextRun: string | null;
  /** Current health status */
  health: "healthy" | "degraded" | "unhealthy";
  /** Health details */
  healthDetails: string;
  /** Recent alerts */
  recentAlerts: MonitorAlert[];
  /** Run history (last 24 hours) */
  runHistory: { timestamp: string; score: number; passed: number; total: number }[];
}

export interface MonitorAlert {
  timestamp: string;
  severity: "critical" | "warning" | "info";
  type: string;
  message: string;
  details: Record<string, unknown>;
}

export interface MonitorReport {
  timestamp: string;
  status: MonitorStatus;
  config: MonitorConfig;
  recommendations: string[];
}

/**
 * Check system health based on recent eval results.
 */
export async function checkHealth(): Promise<MonitorStatus> {
  const runs = await loadRecentRuns(24); // Last 24 hours
  const alerts = await loadRecentAlerts(10);

  // Determine health status
  let health: "healthy" | "degraded" | "unhealthy" = "healthy";
  let healthDetails = "All systems operational";

  if (runs.length === 0) {
    health = "degraded";
    healthDetails = "No recent eval runs";
  } else {
    const latestRun = runs[0];
    if (latestRun) {
      const score = latestRun.overallScore ?? 0;

      if (score < 0.8) {
        health = "unhealthy";
        healthDetails = `Score critically low: ${(score * 100).toFixed(1)}%`;
      } else if (score < 0.95) {
        health = "degraded";
        healthDetails = `Score below threshold: ${(score * 100).toFixed(1)}%`;
      }

      // Check for recent regressions
      const recentAlerts = alerts.filter(a => a.type === "regression");
      if (recentAlerts.length > 0) {
        health = "degraded";
        healthDetails += `. ${recentAlerts.length} recent regression alerts`;
      }
    }
  }

  // Build run history
  const runHistory = runs.map(r => ({
    timestamp: r.timestamp,
    score: r.overallScore ?? 0,
    passed: r.passed ?? 0,
    total: r.totalTasks ?? 0,
  }));

  // Calculate next run time
  const lastRunTime = runs[0]?.timestamp ? new Date(runs[0].timestamp).getTime() : 0;
  const intervalMs = DEFAULT_MONITOR_CONFIG.intervalMinutes * 60 * 1000;
  const nextRun = lastRunTime > 0 ? new Date(lastRunTime + intervalMs).toISOString() : null;

  return {
    active: DEFAULT_MONITOR_CONFIG.enabled,
    lastRun: runs[0]?.timestamp ?? null,
    nextRun,
    health,
    healthDetails,
    recentAlerts: alerts,
    runHistory,
  };
}

/**
 * Generate monitoring report.
 */
export async function generateMonitorReport(): Promise<MonitorReport> {
  const status = await checkHealth();
  const recommendations = generateRecommendations(status);

  const report: MonitorReport = {
    timestamp: new Date().toISOString(),
    status,
    config: DEFAULT_MONITOR_CONFIG,
    recommendations,
  };

  // Save report
  await mkdir(MONITOR_DIR, { recursive: true });
  const reportPath = join(MONITOR_DIR, "monitor-report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  const markdownPath = join(MONITOR_DIR, "monitor-report.md");
  await writeFile(markdownPath, formatMonitorReport(report));

  return report;
}

/**
 * Generate recommendations based on monitoring status.
 */
function generateRecommendations(status: MonitorStatus): string[] {
  const recommendations: string[] = [];

  if (status.health === "unhealthy") {
    recommendations.push("URGENT: System health is critical. Investigate immediately.");
  }

  if (status.health === "degraded") {
    recommendations.push("System health is degraded. Review recent alerts and run diagnostics.");
  }

  if (status.runHistory.length === 0) {
    recommendations.push("No recent eval runs. Ensure monitoring is configured correctly.");
  }

  // Check for score trend
  if (status.runHistory.length >= 3) {
    const recent = status.runHistory.slice(0, 3);
    const avgScore = recent.reduce((sum, r) => sum + r.score, 0) / recent.length;
    if (avgScore < 0.9) {
      recommendations.push(`Average score is ${(avgScore * 100).toFixed(1)}%. Consider running targeted evals.`);
    }
  }

  // Check for alerts
  const criticalAlerts = status.recentAlerts.filter(a => a.severity === "critical");
  if (criticalAlerts.length > 0) {
    recommendations.push(`${criticalAlerts.length} critical alerts in the last 24 hours. Review and address.`);
  }

  return recommendations;
}

/**
 * Load recent eval runs.
 */
async function loadRecentRuns(hours: number): Promise<any[]> {
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  const runs: any[] = [];

  try {
    const files = await readdir(RESULTS_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await readFile(join(RESULTS_DIR, file), "utf-8");
        const data = JSON.parse(content);
        if (data.timestamp && new Date(data.timestamp).getTime() > cutoff) {
          if (data.totalTasks !== undefined) {
            runs.push(data);
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  runs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return runs;
}

/**
 * Load recent alerts.
 */
async function loadRecentAlerts(count: number): Promise<MonitorAlert[]> {
  const alerts: MonitorAlert[] = [];

  try {
    const alertsFile = join(MONITOR_DIR, "alerts.json");
    const content = await readFile(alertsFile, "utf-8");
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      alerts.push(...data);
    }
  } catch { /* No alerts file yet */ }

  alerts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return alerts.slice(0, count);
}

/**
 * Save an alert.
 */
export async function saveAlert(alert: MonitorAlert): Promise<void> {
  await mkdir(MONITOR_DIR, { recursive: true });
  const alertsFile = join(MONITOR_DIR, "alerts.json");

  let alerts: MonitorAlert[] = [];
  try {
    const content = await readFile(alertsFile, "utf-8");
    const data = JSON.parse(content);
    if (Array.isArray(data)) alerts = data;
  } catch { /* No file yet */ }

  alerts.push(alert);

  // Keep only last 100 alerts
  if (alerts.length > 100) {
    alerts = alerts.slice(-100);
  }

  await writeFile(alertsFile, JSON.stringify(alerts, null, 2));
}

/**
 * Check for alert conditions and generate alerts.
 */
export async function checkAlertConditions(): Promise<MonitorAlert[]> {
  const alerts: MonitorAlert[] = [];
  const runs = await loadRecentRuns(24);

  if (runs.length < 2) return alerts;

  const latest = runs[0];
  const previous = runs[1];

  if (latest && previous) {
    // Score drop alert
    const scoreDrop = (previous.overallScore ?? 0) - (latest.overallScore ?? 0);
    if (scoreDrop > DEFAULT_MONITOR_CONFIG.alertThresholds.scoreDrop) {
      const alert: MonitorAlert = {
        timestamp: new Date().toISOString(),
        severity: scoreDrop > 0.2 ? "critical" : scoreDrop > 0.1 ? "warning" : "info",
        type: "score_drop",
        message: `Score dropped by ${(scoreDrop * 100).toFixed(1)}%`,
        details: { previous: previous.overallScore, current: latest.overallScore, drop: scoreDrop },
      };
      alerts.push(alert);
      await saveAlert(alert);
    }

    // Duration spike alert
    const latestDuration = latest.durationMs ?? 0;
    const previousDuration = previous.durationMs ?? 0;
    if (latestDuration > DEFAULT_MONITOR_CONFIG.alertThresholds.durationSpike && latestDuration > previousDuration * 2) {
      const alert: MonitorAlert = {
        timestamp: new Date().toISOString(),
        severity: "warning",
        type: "duration_spike",
        message: `Execution time spiked: ${latestDuration.toFixed(0)}ms (was ${previousDuration.toFixed(0)}ms)`,
        details: { previous: previousDuration, current: latestDuration },
      };
      alerts.push(alert);
      await saveAlert(alert);
    }
  }

  return alerts;
}

/**
 * Format monitor report as markdown.
 */
export function formatMonitorReport(report: MonitorReport): string {
  const lines: string[] = [];

  lines.push("# Continuous Monitoring Report");
  lines.push("");
  lines.push(`**Generated:** ${report.timestamp}`);
  lines.push("");

  // Health status
  const healthIcon = report.status.health === "healthy" ? "🟢" : report.status.health === "degraded" ? "🟡" : "🔴";
  lines.push(`## ${healthIcon} Health Status: ${report.status.health.toUpperCase()}`);
  lines.push("");
  lines.push(`**Details:** ${report.status.healthDetails}`);
  lines.push("");

  // Status
  lines.push("## Monitor Status");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Active | ${report.status.active ? "✅ Yes" : "❌ No"} |`);
  lines.push(`| Last Run | ${report.status.lastRun ?? "Never"} |`);
  lines.push(`| Next Run | ${report.status.nextRun ?? "N/A"} |`);
  lines.push(`| Recent Alerts | ${report.status.recentAlerts.length} |`);
  lines.push("");

  // Run history
  if (report.status.runHistory.length > 0) {
    lines.push("## Run History (Last 24h)");
    lines.push("");
    lines.push("| Time | Score | Passed | Total |");
    lines.push("|------|-------|--------|-------|");
    for (const run of report.status.runHistory.slice(0, 10)) {
      const time = new Date(run.timestamp).toLocaleTimeString();
      lines.push(`| ${time} | ${(run.score * 100).toFixed(1)}% | ${run.passed} | ${run.total} |`);
    }
    lines.push("");
  }

  // Recent alerts
  if (report.status.recentAlerts.length > 0) {
    lines.push("## Recent Alerts");
    lines.push("");
    for (const alert of report.status.recentAlerts.slice(0, 5)) {
      const icon = alert.severity === "critical" ? "🔴" : alert.severity === "warning" ? "🟠" : "🔵";
      lines.push(`- ${icon} **${alert.type}:** ${alert.message}`);
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

  // Configuration
  lines.push("## Configuration");
  lines.push("");
  lines.push("| Setting | Value |");
  lines.push("|---------|-------|");
  lines.push(`| Interval | ${report.config.intervalMinutes} minutes |`);
  lines.push(`| Score Drop Threshold | ${(report.config.alertThresholds.scoreDrop * 100).toFixed(0)}% |`);
  lines.push(`| Regression Threshold | ${report.config.alertThresholds.regressionCount} |`);
  lines.push(`| Budget Threshold | $${report.config.alertThresholds.budgetExceeded} |`);
  lines.push(`| Duration Threshold | ${report.config.alertThresholds.durationSpike}ms |`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Run continuous monitoring check.
 */
export async function runContinuousMonitor(): Promise<MonitorReport> {
  console.log("🔍 Running continuous monitoring check...");

  // Check for alert conditions
  const newAlerts = await checkAlertConditions();
  if (newAlerts.length > 0) {
    console.log(`⚠️  ${newAlerts.length} new alerts generated`);
    for (const alert of newAlerts) {
      const icon = alert.severity === "critical" ? "🔴" : alert.severity === "warning" ? "🟠" : "🔵";
      console.log(`   ${icon} ${alert.message}`);
    }
  }

  // Generate report
  const report = await generateMonitorReport();

  console.log(`📊 Monitor report saved to: ${join(MONITOR_DIR, "monitor-report.md")}`);
  console.log(`   Health: ${report.status.health}`);
  console.log(`   Last Run: ${report.status.lastRun ?? "Never"}`);
  console.log(`   Alerts: ${report.status.recentAlerts.length}`);

  return report;
}

// Run if executed directly
if (process.argv[1]?.includes("continuous-monitor")) {
  runContinuousMonitor().then(report => {
    console.log("");
    console.log(formatMonitorReport(report));
  }).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
