/**
 * Trajectory Bridge
 * Connects the engine's EventBus to the trajectory recorder.
 * This is the integration layer that makes trajectories real —
 * every cognitive event flows through here into the trajectory system.
 */

import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { TrajectoryStore } from "../trajectory/trajectory-store.js";
import type { TrajectoryEvent, Trajectory } from "../trajectory/types.js";

export interface TrajectoryBridgeConfig {
  /** Whether to auto-save trajectories */
  autoSave: boolean;
  /** Max events per trajectory before flushing */
  maxEventsBeforeFlush: number;
  /** Event kinds to capture (empty = all) */
  captureKinds: string[];
  /** Event kinds to ignore */
  ignoreKinds: string[];
}

const DEFAULT_CONFIG: TrajectoryBridgeConfig = {
  autoSave: true,
  maxEventsBeforeFlush: 500,
  captureKinds: [],
  ignoreKinds: ["heartbeat", "ping"],
};

/**
 * Bridges the engine's EventBus to the trajectory system.
 * Subscribes to cognitive events and records them as trajectory events.
 */
export class TrajectoryBridge {
  private config: TrajectoryBridgeConfig;
  private activeTrajectories = new Map<string, TrajectoryContext>();
  private sequence = 0;

  constructor(
    private recorder: TrajectoryRecorder,
    private store: TrajectoryStore,
    config: Partial<TrajectoryBridgeConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Start recording a trajectory for a task */
  startTrajectory(taskId: string, tenantId: string, sessionId: string): string {
    const trajectoryId = `traj-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.activeTrajectories.set(trajectoryId, {
      id: trajectoryId,
      taskId,
      tenantId,
      sessionId,
      events: [],
      startedAt: new Date().toISOString(),
      tags: [],
    });
    this.sequence = 0;
    return trajectoryId;
  }

  /** Record a cognitive event into the active trajectory */
  recordEvent(trajectoryId: string, event: {
    kind: string;
    source?: string;
    payload?: unknown;
    success?: boolean;
    error?: string;
    tokens?: number;
    costUsd?: number;
    durationMs?: number;
  }): void {
    const ctx = this.activeTrajectories.get(trajectoryId);
    if (!ctx) return;

    // Filter events
    if (this.config.ignoreKinds.some(k => event.kind.includes(k))) return;
    if (this.config.captureKinds.length > 0 && !this.config.captureKinds.some(k => event.kind.includes(k))) return;

    const trajectoryEvent: TrajectoryEvent = {
      sequence: this.sequence++,
      kind: event.kind,
      timestamp: new Date().toISOString(),
      ...(event.source !== undefined ? { source: event.source } : {}),
      ...(event.payload !== undefined ? { payload: event.payload } : {}),
      ...(event.success !== undefined ? { success: event.success } : {}),
      ...(event.error !== undefined ? { error: event.error } : {}),
      ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
      ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    };

    ctx.events.push(trajectoryEvent);

    // Auto-flush if too many events
    if (ctx.events.length >= this.config.maxEventsBeforeFlush) {
      void this.flush(trajectoryId);
    }
  }

  /** Record an EventBus event */
  recordBusEvent(trajectoryId: string, kind: string, source: string, payload: unknown, metadata?: Record<string, unknown>): void {
    this.recordEvent(trajectoryId, {
      kind: `bus.${kind}`,
      source,
      payload: { data: payload, ...metadata },
    });
  }

  /** Record a tool call */
  recordToolCall(trajectoryId: string, tool: string, input: unknown, output: unknown, success: boolean, durationMs?: number): void {
    this.recordEvent(trajectoryId, {
      kind: `tool.${tool}`,
      source: "engine",
      payload: { input, output },
      success,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }

  /** Record a memory operation */
  recordMemoryOp(trajectoryId: string, op: "store" | "recall" | "consolidate" | "forget", details: unknown): void {
    this.recordEvent(trajectoryId, {
      kind: `memory.${op}`,
      source: "memory-engine",
      payload: details,
    });
  }

  /** Record a planning operation */
  recordPlanningOp(trajectoryId: string, op: "create" | "execute" | "replan" | "complete" | "fail", details: unknown): void {
    this.recordEvent(trajectoryId, {
      kind: `plan.${op}`,
      source: "planning-engine",
      payload: details,
    });
  }

  /** Record a reasoning step */
  recordReasoningStep(trajectoryId: string, step: string, details: unknown): void {
    this.recordEvent(trajectoryId, {
      kind: `reasoning.${step}`,
      source: "reasoning-engine",
      payload: details,
    });
  }

  /** Record a verification */
  recordVerification(trajectoryId: string, passed: boolean, details: unknown): void {
    this.recordEvent(trajectoryId, {
      kind: "verification.check",
      source: "verification-service",
      payload: details,
      success: passed,
    });
  }

  /** Complete a trajectory */
  async completeTrajectory(
    trajectoryId: string,
    outcome: "success" | "failure" | "timeout" | "budget_exceeded" | "error",
    summary?: string,
  ): Promise<Trajectory> {
    const ctx = this.activeTrajectories.get(trajectoryId);
    if (!ctx) throw new Error(`Trajectory ${trajectoryId} not found`);

    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(ctx.startedAt).getTime();

    const totalTokens = ctx.events.reduce((sum, e) => sum + (e.tokens ?? 0), 0);
    const totalCostUsd = ctx.events.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);

    const trajectory: Trajectory = {
      id: ctx.id,
      taskId: ctx.taskId,
      tenantId: ctx.tenantId,
      sessionId: ctx.sessionId,
      events: ctx.events,
      startedAt: ctx.startedAt,
      completedAt,
      durationMs,
      totalTokens,
      totalCostUsd,
      outcome,
      tags: ctx.tags,
      ...(summary !== undefined ? { summary } : {}),
    };

    if (this.config.autoSave) {
      await this.store.save(trajectory);
    }

    this.activeTrajectories.delete(trajectoryId);
    return trajectory;
  }

  /** Flush intermediate trajectory state to disk */
  async flush(trajectoryId: string): Promise<void> {
    const ctx = this.activeTrajectories.get(trajectoryId);
    if (!ctx) return;

    const partial: Trajectory = {
      id: ctx.id,
      taskId: ctx.taskId,
      tenantId: ctx.tenantId,
      sessionId: ctx.sessionId,
      events: ctx.events,
      startedAt: ctx.startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(ctx.startedAt).getTime(),
      totalTokens: ctx.events.reduce((sum, e) => sum + (e.tokens ?? 0), 0),
      totalCostUsd: ctx.events.reduce((sum, e) => sum + (e.costUsd ?? 0), 0),
      outcome: "success", // placeholder
      tags: ctx.tags,
    };

    await this.store.save(partial);
  }

  /** Get active trajectory count */
  get activeCount(): number {
    return this.activeTrajectories.size;
  }

  /** Check if a trajectory is active */
  isActive(trajectoryId: string): boolean {
    return this.activeTrajectories.has(trajectoryId);
  }
}

interface TrajectoryContext {
  id: string;
  taskId: string;
  tenantId: string;
  sessionId: string;
  events: TrajectoryEvent[];
  startedAt: string;
  tags: string[];
}
