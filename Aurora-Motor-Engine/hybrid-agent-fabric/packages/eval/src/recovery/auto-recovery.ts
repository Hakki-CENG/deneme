/**
 * Auto-Recovery
 * Automatic recovery mechanisms for failed eval runs.
 * 
 * Features:
 *   - Automatic retry on transient failures
 *   - Fallback strategies for different failure types
 *   - Circuit breaker pattern
 *   - Recovery history tracking
 *   - Self-healing recommendations
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let RESULTS_DIR: string;
let RECOVERY_DIR: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  RESULTS_DIR = resolve(__dirname, "../../results");
  RECOVERY_DIR = resolve(__dirname, "../../results/recovery");
} catch {
  RESULTS_DIR = resolve(process.cwd(), "packages/eval/results");
  RECOVERY_DIR = resolve(process.cwd(), "packages/eval/results/recovery");
}

export interface RecoveryConfig {
  /** Max retry attempts */
  maxRetries: number;
  /** Delay between retries (ms) */
  retryDelayMs: number;
  /** Enable circuit breaker */
  circuitBreaker: {
    enabled: boolean;
    failureThreshold: number;    // Open circuit after N failures
    resetTimeoutMs: number;      // Try again after this time
  };
  /** Recovery strategies */
  strategies: {
    /** Retry on timeout */
    retryOnTimeout: boolean;
    /** Retry on error */
    retryOnError: boolean;
    /** Reduce task count on budget exceeded */
    reduceOnBudgetExceeded: boolean;
    /** Skip failing categories */
    skipFailingCategories: boolean;
  };
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  maxRetries: 3,
  retryDelayMs: 5000,
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,
    resetTimeoutMs: 300000, // 5 minutes
  },
  strategies: {
    retryOnTimeout: true,
    retryOnError: true,
    reduceOnBudgetExceeded: true,
    skipFailingCategories: false,
  },
};

export interface RecoveryAttempt {
  timestamp: string;
  trigger: string;
  strategy: string;
  success: boolean;
  details: string;
  durationMs: number;
}

export interface CircuitBreakerState {
  state: "closed" | "open" | "half-open";
  failures: number;
  lastFailure: string | null;
  lastSuccess: string | null;
  nextRetry: string | null;
}

export interface RecoveryReport {
  timestamp: string;
  config: RecoveryConfig;
  circuitBreaker: CircuitBreakerState;
  recentAttempts: RecoveryAttempt[];
  recommendations: string[];
  stats: {
    totalAttempts: number;
    successfulRecoveries: number;
    failedRecoveries: number;
    successRate: number;
  };
}

/**
 * Circuit breaker for eval runs.
 */
class CircuitBreaker {
  private state: CircuitBreakerState = {
    state: "closed",
    failures: 0,
    lastFailure: null,
    lastSuccess: null,
    nextRetry: null,
  };

  constructor(private config: RecoveryConfig["circuitBreaker"]) {}

  /** Check if circuit is open (blocking requests) */
  isOpen(): boolean {
    if (this.state.state === "open") {
      // Check if reset timeout has passed
      if (this.state.nextRetry && new Date(this.state.nextRetry).getTime() <= Date.now()) {
        this.state.state = "half-open";
        return false;
      }
      return true;
    }
    return false;
  }

  /** Record a success */
  recordSuccess(): void {
    this.state.state = "closed";
    this.state.failures = 0;
    this.state.lastSuccess = new Date().toISOString();
  }

  /** Record a failure */
  recordFailure(): void {
    this.state.failures++;
    this.state.lastFailure = new Date().toISOString();

    if (this.state.failures >= this.config.failureThreshold) {
      this.state.state = "open";
      this.state.nextRetry = new Date(Date.now() + this.config.resetTimeoutMs).toISOString();
    }
  }

  /** Get current state */
  getState(): CircuitBreakerState {
    return { ...this.state };
  }

  /** Reset circuit breaker */
  reset(): void {
    this.state = {
      state: "closed",
      failures: 0,
      lastFailure: null,
      lastSuccess: null,
      nextRetry: null,
    };
  }
}

/** Global circuit breaker instance */
let circuitBreaker: CircuitBreaker | null = null;

/**
 * Get or create circuit breaker.
 */
function getCircuitBreaker(): CircuitBreaker {
  if (!circuitBreaker) {
    circuitBreaker = new CircuitBreaker(DEFAULT_RECOVERY_CONFIG.circuitBreaker);
  }
  return circuitBreaker;
}

/**
 * Attempt recovery with retry logic.
 */
export async function attemptRecovery<T>(
  operation: () => Promise<T>,
  options: {
    trigger: string;
    maxRetries?: number;
    retryDelayMs?: number;
  },
): Promise<{ success: boolean; result?: T; attempts: RecoveryAttempt[] }> {
  const maxRetries = options.maxRetries ?? DEFAULT_RECOVERY_CONFIG.maxRetries;
  const retryDelay = options.retryDelayMs ?? DEFAULT_RECOVERY_CONFIG.retryDelayMs;
  const attempts: RecoveryAttempt[] = [];
  const cb = getCircuitBreaker();

  // Check circuit breaker
  if (cb.isOpen()) {
    attempts.push({
      timestamp: new Date().toISOString(),
      trigger: options.trigger,
      strategy: "circuit_breaker",
      success: false,
      details: "Circuit breaker is open. Waiting for reset.",
      durationMs: 0,
    });
    return { success: false, attempts };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const startTime = Date.now();

    try {
      const result = await operation();

      // Success
      cb.recordSuccess();
      attempts.push({
        timestamp: new Date().toISOString(),
        trigger: options.trigger,
        strategy: attempt > 0 ? "retry" : "direct",
        success: true,
        details: `Succeeded on attempt ${attempt + 1}`,
        durationMs: Date.now() - startTime,
      });

      return { success: true, result, attempts };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;

      cb.recordFailure();
      attempts.push({
        timestamp: new Date().toISOString(),
        trigger: options.trigger,
        strategy: "retry",
        success: false,
        details: `Attempt ${attempt + 1} failed: ${err.message?.slice(0, 100)}`,
        durationMs,
      });

      // Wait before retry (except on last attempt)
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  return { success: false, attempts };
}

/**
 * Analyze failure and suggest recovery strategy.
 */
export function analyzeFailure(error: {
  type: string;
  message: string;
  category?: string;
}): {
  strategy: string;
  action: string;
  autoRecoverable: boolean;
} {
  const { type, message, category } = error;

  // Timeout errors
  if (type === "timeout" || message.includes("timeout") || message.includes("ETIMEDOUT")) {
    return {
      strategy: "retry_with_backoff",
      action: "Retry with exponential backoff. Increase timeout if persistent.",
      autoRecoverable: true,
    };
  }

  // Memory errors
  if (message.includes("ENOMEM") || message.includes("out of memory")) {
    return {
      strategy: "reduce_load",
      action: "Reduce task count or increase memory limits.",
      autoRecoverable: false,
    };
  }

  // Budget exceeded
  if (type === "budget_exceeded" || message.includes("budget")) {
    return {
      strategy: "reduce_tasks",
      action: "Reduce task count or switch to cheaper model.",
      autoRecoverable: true,
    };
  }

  // Connection errors
  if (message.includes("ECONNREFUSED") || message.includes("ECONNRESET")) {
    return {
      strategy: "retry_with_delay",
      action: "Wait and retry. Check service health.",
      autoRecoverable: true,
    };
  }

  // Category-specific failures
  if (category) {
    return {
      strategy: "skip_category",
      action: `Skip ${category} tasks temporarily and retry other categories.`,
      autoRecoverable: true,
    };
  }

  // Unknown errors
  return {
    strategy: "manual_review",
    action: "Manual investigation required.",
    autoRecoverable: false,
  };
}

/**
 * Generate recovery report.
 */
export async function generateRecoveryReport(): Promise<RecoveryReport> {
  const cb = getCircuitBreaker();
  const recentAttempts = await loadRecentAttempts(20);

  // Calculate stats
  const totalAttempts = recentAttempts.length;
  const successfulRecoveries = recentAttempts.filter(a => a.success).length;
  const failedRecoveries = totalAttempts - successfulRecoveries;
  const successRate = totalAttempts > 0 ? successfulRecoveries / totalAttempts : 0;

  // Generate recommendations
  const recommendations = generateRecoveryRecommendations(cb.getState(), recentAttempts, successRate);

  const report: RecoveryReport = {
    timestamp: new Date().toISOString(),
    config: DEFAULT_RECOVERY_CONFIG,
    circuitBreaker: cb.getState(),
    recentAttempts,
    recommendations,
    stats: {
      totalAttempts,
      successfulRecoveries,
      failedRecoveries,
      successRate,
    },
  };

  // Save report
  await mkdir(RECOVERY_DIR, { recursive: true });
  const reportPath = join(RECOVERY_DIR, "recovery-report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  const markdownPath = join(RECOVERY_DIR, "recovery-report.md");
  await writeFile(markdownPath, formatRecoveryReport(report));

  return report;
}

/**
 * Generate recovery recommendations.
 */
function generateRecoveryRecommendations(
  circuitState: CircuitBreakerState,
  attempts: RecoveryAttempt[],
  successRate: number,
): string[] {
  const recommendations: string[] = [];

  // Circuit breaker open
  if (circuitState.state === "open") {
    recommendations.push("Circuit breaker is OPEN. Wait for reset or manually reset it.");
  }

  // Low success rate
  if (successRate < 0.5 && attempts.length > 3) {
    recommendations.push(`Low recovery success rate (${(successRate * 100).toFixed(0)}%). Investigate root cause.`);
  }

  // Frequent failures
  const recentFailures = attempts.filter(a => !a.success).slice(0, 5);
  if (recentFailures.length >= 3) {
    recommendations.push("Multiple recent failures detected. Consider reducing load or checking dependencies.");
  }

  // Timeout pattern
  const timeoutFailures = attempts.filter(a => a.details.includes("timeout"));
  if (timeoutFailures.length > 2) {
    recommendations.push("Repeated timeouts. Increase timeout limits or optimize task execution.");
  }

  return recommendations;
}

/**
 * Load recent recovery attempts.
 */
async function loadRecentAttempts(count: number): Promise<RecoveryAttempt[]> {
  const attempts: RecoveryAttempt[] = [];

  try {
    const attemptsFile = join(RECOVERY_DIR, "attempts.json");
    const content = await readFile(attemptsFile, "utf-8");
    const data = JSON.parse(content);
    if (Array.isArray(data)) attempts.push(...data);
  } catch { /* No file yet */ }

  attempts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return attempts.slice(0, count);
}

/**
 * Save a recovery attempt.
 */
export async function saveRecoveryAttempt(attempt: RecoveryAttempt): Promise<void> {
  await mkdir(RECOVERY_DIR, { recursive: true });
  const attemptsFile = join(RECOVERY_DIR, "attempts.json");

  let attempts: RecoveryAttempt[] = [];
  try {
    const content = await readFile(attemptsFile, "utf-8");
    const data = JSON.parse(content);
    if (Array.isArray(data)) attempts = data;
  } catch { /* No file yet */ }

  attempts.push(attempt);

  // Keep only last 50 attempts
  if (attempts.length > 50) {
    attempts = attempts.slice(-50);
  }

  await writeFile(attemptsFile, JSON.stringify(attempts, null, 2));
}

/**
 * Format recovery report as markdown.
 */
export function formatRecoveryReport(report: RecoveryReport): string {
  const lines: string[] = [];

  lines.push("# Auto-Recovery Report");
  lines.push("");
  lines.push(`**Generated:** ${report.timestamp}`);
  lines.push("");

  // Circuit breaker status
  const cbIcon = report.circuitBreaker.state === "closed" ? "🟢" : report.circuitBreaker.state === "open" ? "🔴" : "🟡";
  lines.push(`## ${cbIcon} Circuit Breaker: ${report.circuitBreaker.state.toUpperCase()}`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| State | ${report.circuitBreaker.state} |`);
  lines.push(`| Failures | ${report.circuitBreaker.failures} |`);
  lines.push(`| Last Failure | ${report.circuitBreaker.lastFailure ?? "None"} |`);
  lines.push(`| Last Success | ${report.circuitBreaker.lastSuccess ?? "None"} |`);
  if (report.circuitBreaker.nextRetry) {
    lines.push(`| Next Retry | ${report.circuitBreaker.nextRetry} |`);
  }
  lines.push("");

  // Stats
  lines.push("## Recovery Statistics");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Attempts | ${report.stats.totalAttempts} |`);
  lines.push(`| Successful | ${report.stats.successfulRecoveries} |`);
  lines.push(`| Failed | ${report.stats.failedRecoveries} |`);
  lines.push(`| Success Rate | ${(report.stats.successRate * 100).toFixed(1)}% |`);
  lines.push("");

  // Recent attempts
  if (report.recentAttempts.length > 0) {
    lines.push("## Recent Recovery Attempts");
    lines.push("");
    lines.push("| Time | Trigger | Strategy | Result | Duration |");
    lines.push("|------|---------|----------|--------|----------|");
    for (const attempt of report.recentAttempts.slice(0, 10)) {
      const icon = attempt.success ? "✅" : "❌";
      const time = new Date(attempt.timestamp).toLocaleTimeString();
      lines.push(`| ${time} | ${attempt.trigger} | ${attempt.strategy} | ${icon} | ${attempt.durationMs}ms |`);
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
  lines.push(`| Setting | Value |`);
  lines.push(`|---------|-------|`);
  lines.push(`| Max Retries | ${report.config.maxRetries} |`);
  lines.push(`| Retry Delay | ${report.config.retryDelayMs}ms |`);
  lines.push(`| Circuit Breaker | ${report.config.circuitBreaker.enabled ? "Enabled" : "Disabled"} |`);
  lines.push(`| Failure Threshold | ${report.config.circuitBreaker.failureThreshold} |`);
  lines.push(`| Reset Timeout | ${report.config.circuitBreaker.resetTimeoutMs / 1000}s |`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Run auto-recovery check and generate report.
 */
export async function runAutoRecovery(): Promise<RecoveryReport> {
  console.log("🔧 Running auto-recovery check...");

  const report = await generateRecoveryReport();

  console.log(`📊 Recovery report saved to: ${join(RECOVERY_DIR, "recovery-report.md")}`);
  console.log(`   Circuit Breaker: ${report.circuitBreaker.state}`);
  console.log(`   Success Rate: ${(report.stats.successRate * 100).toFixed(1)}%`);
  console.log(`   Recent Attempts: ${report.recentAttempts.length}`);

  if (report.recommendations.length > 0) {
    console.log(`   Recommendations: ${report.recommendations.length}`);
  }

  return report;
}

// Run if executed directly
if (process.argv[1]?.includes("auto-recovery")) {
  runAutoRecovery().then(report => {
    console.log("");
    console.log(formatRecoveryReport(report));
  }).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
