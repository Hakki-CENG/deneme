/**
 * Trajectory Types
 * Core types for the trajectory system.
 */

/** A single event in a trajectory */
export interface TrajectoryEvent {
  sequence: number;
  kind: string;
  timestamp: string;
  source?: string;
  payload?: unknown;
  /** Duration of this step in ms */
  durationMs?: number;
  /** Token usage for this step */
  tokens?: number;
  /** Cost in USD for this step */
  costUsd?: number;
  /** Whether this step succeeded */
  success?: boolean;
  /** Error message if failed */
  error?: string;
  /** Metadata attached to this event */
  metadata?: Record<string, unknown>;
}

/** A complete trajectory for a task execution */
export interface Trajectory {
  /** Unique trajectory ID */
  id: string;
  /** Task ID this trajectory belongs to */
  taskId: string;
  /** Tenant ID */
  tenantId: string;
  /** Session ID */
  sessionId: string;
  /** All events in order */
  events: TrajectoryEvent[];
  /** Start time */
  startedAt: string;
  /** End time */
  completedAt: string;
  /** Total duration in ms */
  durationMs: number;
  /** Total tokens used */
  totalTokens: number;
  /** Total cost in USD */
  totalCostUsd: number;
  /** Overall outcome */
  outcome: "success" | "failure" | "timeout" | "budget_exceeded" | "error";
  /** Tags for filtering */
  tags: string[];
  /** Summary of what happened */
  summary?: string;
}

/** Analysis of a trajectory */
export interface TrajectoryAnalysis {
  /** Trajectory ID */
  trajectoryId: string;
  /** Step count */
  stepCount: number;
  /** Steps by category */
  stepsByCategory: Record<string, number>;
  /** Tool calls breakdown */
  toolCalls: { tool: string; count: number; successRate: number }[];
  /** Memory operations */
  memoryOps: { type: string; count: number }[];
  /** Planning operations */
  planningOps: { type: string; count: number }[];
  /** Error events */
  errors: { kind: string; message: string; sequence: number }[];
  /** Replan events */
  replans: { from: string; to: string; reason: string; sequence: number }[];
  /** Verification attempts */
  verifications: { passed: boolean; sequence: number }[];
  /** Token efficiency (tokens per successful step) */
  tokenEfficiency: number;
  /** Cost efficiency (cost per successful step) */
  costEfficiency: number;
  /** Time efficiency (ms per successful step) */
  timeEfficiency: number;
  /** Patterns detected */
  patterns: TrajectoryPattern[];
  /** Quality score 0-1 */
  qualityScore: number;
  /** Suggestions for improvement */
  suggestions: string[];
}

/** A pattern detected in trajectories */
export interface TrajectoryPattern {
  /** Pattern ID */
  id: string;
  /** Pattern name */
  name: string;
  /** Pattern description */
  description: string;
  /** How many times this pattern was seen */
  occurrences: number;
  /** Whether this pattern is good or bad */
  sentiment: "positive" | "negative" | "neutral";
  /** Example events that match this pattern */
  exampleSequences: number[][];
}

/** Comparison between two trajectories */
export interface TrajectoryComparison {
  /** First trajectory ID */
  trajectoryA: string;
  /** Second trajectory ID */
  trajectoryB: string;
  /** Step count difference */
  stepDelta: number;
  /** Token difference */
  tokenDelta: number;
  /** Cost difference */
  costDelta: number;
  /** Time difference in ms */
  timeDelta: number;
  /** Quality score difference */
  qualityDelta: number;
  /** Steps only in A */
  onlyInA: string[];
  /** Steps only in B */
  onlyInB: string[];
  /** Common steps */
  common: string[];
  /** Which trajectory is better */
  better: "A" | "B" | "equal";
  /** Explanation of why */
  explanation: string;
}
