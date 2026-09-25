/**
 * Trajectory Analyzer
 * Analyzes trajectories to extract patterns, quality scores, and suggestions.
 */

import type {
  Trajectory,
  TrajectoryAnalysis,
  TrajectoryPattern,
  TrajectoryEvent,
} from "./types.js";

/** Known positive patterns */
const POSITIVE_PATTERNS: Omit<TrajectoryPattern, "occurrences" | "exampleSequences">[] = [
  {
    id: "verify-before-complete",
    name: "Verify Before Complete",
    description: "Agent verifies its work before declaring completion",
    sentiment: "positive",
  },
  {
    id: "incremental-progress",
    name: "Incremental Progress",
    description: "Agent makes steady progress without large jumps",
    sentiment: "positive",
  },
  {
    id: "error-recovery",
    name: "Error Recovery",
    description: "Agent detects and recovers from errors gracefully",
    sentiment: "positive",
  },
  {
    id: "memory-recall",
    name: "Memory Recall",
    description: "Agent recalls relevant memories before acting",
    sentiment: "positive",
  },
  {
    id: "plan-then-execute",
    name: "Plan Then Execute",
    description: "Agent creates a plan before executing steps",
    sentiment: "positive",
  },
  {
    id: "tool-diversity",
    name: "Tool Diversity",
    description: "Agent uses multiple different tools appropriately",
    sentiment: "positive",
  },
];

/** Known negative patterns */
const NEGATIVE_PATTERNS: Omit<TrajectoryPattern, "occurrences" | "exampleSequences">[] = [
  {
    id: "repeated-failure",
    name: "Repeated Failure",
    description: "Agent repeats the same failing action multiple times",
    sentiment: "negative",
  },
  {
    id: "no-verification",
    name: "No Verification",
    description: "Agent completes task without verifying the result",
    sentiment: "negative",
  },
  {
    id: "excessive-retry",
    name: "Excessive Retry",
    description: "Agent retries too many times before finding an alternative",
    sentiment: "negative",
  },
  {
    id: "token-waste",
    name: "Token Waste",
    description: "Agent uses significantly more tokens than expected",
    sentiment: "negative",
  },
  {
    id: "no-planning",
    name: "No Planning",
    description: "Agent starts executing without planning",
    sentiment: "negative",
  },
  {
    id: "context-loss",
    name: "Context Loss",
    description: "Agent loses context and repeats earlier work",
    sentiment: "negative",
  },
];

export class TrajectoryAnalyzer {
  /** Analyze a trajectory */
  analyze(trajectory: Trajectory): TrajectoryAnalysis {
    const stepsByCategory = this.categorizeSteps(trajectory.events);
    const toolCalls = this.analyzeToolCalls(trajectory.events);
    const memoryOps = this.analyzeMemoryOps(trajectory.events);
    const planningOps = this.analyzePlanningOps(trajectory.events);
    const errors = this.findErrors(trajectory.events);
    const replans = this.findReplans(trajectory.events);
    const verifications = this.findVerifications(trajectory.events);
    const patterns = this.detectPatterns(trajectory);

    const successfulSteps = trajectory.events.filter(e => e.success !== false).length;
    const tokenEfficiency = successfulSteps > 0 ? trajectory.totalTokens / successfulSteps : 0;
    const costEfficiency = successfulSteps > 0 ? trajectory.totalCostUsd / successfulSteps : 0;
    const timeEfficiency = successfulSteps > 0 ? trajectory.durationMs / successfulSteps : 0;

    const qualityScore = this.calculateQualityScore(trajectory, {
      errors,
      replans,
      verifications,
      patterns,
      toolCalls,
    });

    const suggestions = this.generateSuggestions(trajectory, {
      errors,
      replans,
      verifications,
      patterns,
      qualityScore,
    });

    return {
      trajectoryId: trajectory.id,
      stepCount: trajectory.events.length,
      stepsByCategory,
      toolCalls,
      memoryOps,
      planningOps,
      errors,
      replans,
      verifications,
      tokenEfficiency,
      costEfficiency,
      timeEfficiency,
      patterns,
      qualityScore,
      suggestions,
    };
  }

  /** Categorize steps by type */
  private categorizeSteps(events: TrajectoryEvent[]): Record<string, number> {
    const categories: Record<string, number> = {};
    for (const event of events) {
      const category = this.categorizeEvent(event);
      categories[category] = (categories[category] ?? 0) + 1;
    }
    return categories;
  }

  /** Categorize a single event */
  private categorizeEvent(event: TrajectoryEvent): string {
    const kind = event.kind.toLowerCase();
    if (kind.includes("tool")) return "tool";
    if (kind.includes("memory") || kind.includes("recall")) return "memory";
    if (kind.includes("plan")) return "planning";
    if (kind.includes("verify") || kind.includes("check")) return "verification";
    if (kind.includes("error") || kind.includes("fail")) return "error";
    if (kind.includes("reason") || kind.includes("think")) return "reasoning";
    if (kind.includes("search") || kind.includes("research")) return "research";
    if (kind.includes("task")) return "task-management";
    return "other";
  }

  /** Analyze tool calls */
  private analyzeToolCalls(events: TrajectoryEvent[]): { tool: string; count: number; successRate: number }[] {
    const toolMap = new Map<string, { total: number; success: number }>();
    for (const event of events) {
      if (!event.kind.includes("tool")) continue;
      const tool = event.kind.replace("tool.", "").replace(".execute", "").replace(".result", "");
      const existing = toolMap.get(tool) ?? { total: 0, success: 0 };
      existing.total++;
      if (event.success !== false) existing.success++;
      toolMap.set(tool, existing);
    }
    return Array.from(toolMap.entries()).map(([tool, stats]) => ({
      tool,
      count: stats.total,
      successRate: stats.total > 0 ? stats.success / stats.total : 0,
    }));
  }

  /** Analyze memory operations */
  private analyzeMemoryOps(events: TrajectoryEvent[]): { type: string; count: number }[] {
    const ops = new Map<string, number>();
    for (const event of events) {
      if (!event.kind.includes("memory")) continue;
      const type = event.kind;
      ops.set(type, (ops.get(type) ?? 0) + 1);
    }
    return Array.from(ops.entries()).map(([type, count]) => ({ type, count }));
  }

  /** Analyze planning operations */
  private analyzePlanningOps(events: TrajectoryEvent[]): { type: string; count: number }[] {
    const ops = new Map<string, number>();
    for (const event of events) {
      if (!event.kind.includes("plan")) continue;
      const type = event.kind;
      ops.set(type, (ops.get(type) ?? 0) + 1);
    }
    return Array.from(ops.entries()).map(([type, count]) => ({ type, count }));
  }

  /** Find error events */
  private findErrors(events: TrajectoryEvent[]): { kind: string; message: string; sequence: number }[] {
    return events
      .filter(e => e.kind.includes("error") || e.kind.includes("fail") || e.success === false)
      .map(e => ({
        kind: e.kind,
        message: String(e.error ?? e.payload ?? "Unknown error"),
        sequence: e.sequence,
      }));
  }

  /** Find replan events */
  private findReplans(events: TrajectoryEvent[]): { from: string; to: string; reason: string; sequence: number }[] {
    return events
      .filter(e => e.kind.includes("replan") || e.kind.includes("plan.fail"))
      .map(e => {
        const payload = e.payload as any;
        return {
          from: String(payload?.from ?? "unknown"),
          to: String(payload?.to ?? "unknown"),
          reason: String(payload?.reason ?? "No reason given"),
          sequence: e.sequence,
        };
      });
  }

  /** Find verification events */
  private findVerifications(events: TrajectoryEvent[]): { passed: boolean; sequence: number }[] {
    return events
      .filter(e => e.kind.includes("verify") || e.kind.includes("check") || e.kind.includes("test"))
      .map(e => ({
        passed: e.success !== false,
        sequence: e.sequence,
      }));
  }

  /** Detect patterns in trajectory */
  private detectPatterns(trajectory: Trajectory): TrajectoryPattern[] {
    const patterns: TrajectoryPattern[] = [];
    const events = trajectory.events;

    // Check for verify-before-complete
    const hasVerify = events.some(e => e.kind.includes("verify"));
    const hasComplete = events.some(e => e.kind.includes("complete") || e.kind.includes("success"));
    if (hasVerify && hasComplete) {
      const verifyIdx = events.findIndex(e => e.kind.includes("verify"));
      const completeIdx = events.findIndex(e => e.kind.includes("complete") || e.kind.includes("success"));
      if (verifyIdx >= 0 && completeIdx >= 0 && verifyIdx < completeIdx) {
        const pattern = POSITIVE_PATTERNS.find(p => p.id === "verify-before-complete");
        if (pattern) {
          patterns.push({
            ...pattern,
            occurrences: 1,
            exampleSequences: [[verifyIdx, completeIdx]],
          });
        }
      }
    }

    // Check for plan-then-execute
    const hasPlan = events.some(e => e.kind.includes("plan.create") || e.kind.includes("plan.generate"));
    const hasExecute = events.some(e => e.kind.includes("execute") || e.kind.includes("tool"));
    if (hasPlan && hasExecute) {
      const planIdx = events.findIndex(e => e.kind.includes("plan.create") || e.kind.includes("plan.generate"));
      const execIdx = events.findIndex(e => e.kind.includes("execute") || e.kind.includes("tool"));
      if (planIdx >= 0 && execIdx >= 0 && planIdx < execIdx) {
        const pattern = POSITIVE_PATTERNS.find(p => p.id === "plan-then-execute");
        if (pattern) {
          patterns.push({
            ...pattern,
            occurrences: 1,
            exampleSequences: [[planIdx, execIdx]],
          });
        }
      }
    }

    // Check for error-recovery
    for (let i = 0; i < events.length - 1; i++) {
      const current = events[i];
      const next = events[i + 1];
      if (current && current.success === false && next && next.success !== false) {
        const existing = patterns.find(p => p.id === "error-recovery");
        if (existing) {
          existing.occurrences++;
          existing.exampleSequences.push([i, i + 1]);
        } else {
          const errorRecoveryPattern = POSITIVE_PATTERNS.find(p => p.id === "error-recovery");
          if (errorRecoveryPattern) {
            patterns.push({
              ...errorRecoveryPattern,
              occurrences: 1,
              exampleSequences: [[i, i + 1]],
            });
          }
        }
      }
    }

    // Check for repeated-failure
    const failureRuns: number[] = [];
    let consecutiveFailures = 0;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event && event.success === false) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) failureRuns.push(i);
      } else {
        consecutiveFailures = 0;
      }
    }
    if (failureRuns.length > 0) {
      const repeatedFailurePattern = NEGATIVE_PATTERNS.find(p => p.id === "repeated-failure");
      if (repeatedFailurePattern) {
        patterns.push({
          ...repeatedFailurePattern,
          occurrences: failureRuns.length,
          exampleSequences: failureRuns.map(i => [i - 2, i - 1, i]),
        });
      }
    }

    // Check for memory-recall
    const hasMemoryRecall = events.some(e => e.kind.includes("memory.recall") || e.kind.includes("memory.search"));
    if (hasMemoryRecall) {
      patterns.push({
        ...POSITIVE_PATTERNS.find(p => p.id === "memory-recall")!,
        occurrences: events.filter(e => e.kind.includes("memory.recall") || e.kind.includes("memory.search")).length,
        exampleSequences: events
          .map((e, i) => e.kind.includes("memory.recall") || e.kind.includes("memory.search") ? [i] : null)
          .filter(Boolean) as number[][],
      });
    }

    // Check for tool-diversity
    const uniqueTools = new Set(events.filter(e => e.kind.includes("tool")).map(e => e.kind));
    if (uniqueTools.size >= 3) {
      patterns.push({
        ...POSITIVE_PATTERNS.find(p => p.id === "tool-diversity")!,
        occurrences: uniqueTools.size,
        exampleSequences: [],
      });
    }

    return patterns;
  }

  /** Calculate quality score (0-1) */
  private calculateQualityScore(
    trajectory: Trajectory,
    context: {
      errors: TrajectoryAnalysis["errors"];
      replans: TrajectoryAnalysis["replans"];
      verifications: TrajectoryAnalysis["verifications"];
      patterns: TrajectoryPattern[];
      toolCalls: TrajectoryAnalysis["toolCalls"];
    },
  ): number {
    let score = 1.0;

    // Penalty for errors
    score -= context.errors.length * 0.1;

    // Penalty for replans
    score -= context.replans.length * 0.05;

    // Bonus for verifications
    const verifyPassRate = context.verifications.length > 0
      ? context.verifications.filter(v => v.passed).length / context.verifications.length
      : 0;
    score += verifyPassRate * 0.1;

    // Bonus for positive patterns
    const positivePatterns = context.patterns.filter(p => p.sentiment === "positive");
    score += positivePatterns.length * 0.05;

    // Penalty for negative patterns
    const negativePatterns = context.patterns.filter(p => p.sentiment === "negative");
    score -= negativePatterns.length * 0.1;

    // Penalty for high tool failure rate
    const toolFailures = context.toolCalls.filter(t => t.successRate < 0.5);
    score -= toolFailures.length * 0.05;

    // Bonus for success
    if (trajectory.outcome === "success") score += 0.1;

    return Math.max(0, Math.min(1, score));
  }

  /** Generate improvement suggestions */
  private generateSuggestions(
    trajectory: Trajectory,
    context: {
      errors: TrajectoryAnalysis["errors"];
      replans: TrajectoryAnalysis["replans"];
      verifications: TrajectoryAnalysis["verifications"];
      patterns: TrajectoryPattern[];
      qualityScore: number;
    },
  ): string[] {
    const suggestions: string[] = [];

    if (context.errors.length > 2) {
      suggestions.push("Consider adding more error handling and retry logic");
    }

    if (context.replans.length > 1) {
      suggestions.push("Improve initial planning to reduce need for replanning");
    }

    if (context.verifications.length === 0) {
      suggestions.push("Add verification steps to ensure quality");
    }

    const negativePatterns = context.patterns.filter(p => p.sentiment === "negative");
    for (const pattern of negativePatterns) {
      suggestions.push(`Address pattern: ${pattern.name} — ${pattern.description}`);
    }

    if (context.qualityScore < 0.5) {
      suggestions.push("Overall quality is low — consider breaking task into smaller steps");
    }

    if (trajectory.totalTokens > 100000) {
      suggestions.push("High token usage — consider optimizing prompt and reducing unnecessary steps");
    }

    if (trajectory.durationMs > 120000) {
      suggestions.push("Long execution time — consider parallel operations or simpler approach");
    }

    return suggestions;
  }
}
