import type { EventStore } from "../persistence/event-store.js";
import type { EventEnvelope } from "../types.js";

/**
 * P2.46 SLOs — measured from the event stream, stated with sample counts.
 *
 * What is measured, and from which real events:
 *
 *  - task success rate: `task.completed` (status "succeeded") vs
 *    `task.failed` — emitted by the unified execution loop for every task.
 *  - tool success rate: `capability.finished` with status ok/error —
 *    emitted by the capability broker for every call.
 *  - p95 model turn latency: `model.request.started` paired with
 *    `model.request.finished` on (sessionId, turnId, iteration) — the
 *    session actor emits both for every model turn.
 *
 * What is NOT measured, and says so: recovery success (failure
 * classifications are not on the event stream) and memory retrieval quality
 * (no relevance feedback exists). Both are reported as `null` with the
 * reason, never as a guessed number.
 *
 * Honesty rules:
 *  - Every indicator carries its sample count. A success rate from 2
 *    samples is labelled as such; the caller decides what to trust.
 *  - Targets are OPTIONAL and supplied by the operator. Without a target
 *    there is no error budget — just the measurement.
 *  - The window is in-memory and bounded; after a restart the counters
 *    start from zero, and the report says when it started measuring.
 */

export interface SloIndicator {
  name: string;
  value: number | null;
  sampleCount: number;
  unit: "ratio" | "milliseconds";
  notMeasuredReason?: string;
  target?: number;
  errorBudgetRemaining?: number;
}

export interface SloReport {
  measuredSince: string;
  windowEvents: number;
  indicators: SloIndicator[];
}

interface ModelTurn {
  startedAt: number;
}

export interface SloTargets {
  taskSuccessRate?: number;
  toolSuccessRate?: number;
  p95ModelLatencyMs?: number;
}

const WINDOW_EVENTS = 5_000;
const LATENCY_CAP_MS = 10 * 60_000;

export class SloService {
  private readonly targets: SloTargets;
  private readonly startedAt = new Date().toISOString();

  private taskCompleted = 0;
  private taskSucceeded = 0;
  private toolFinished = 0;
  private toolOk = 0;
  private readonly modelTurns = new Map<string, ModelTurn>();
  private readonly modelLatencies: number[] = [];
  private windowEvents = 0;
  private readonly unsubscribe: () => void;

  constructor(events: EventStore, targets: SloTargets = {}) {
    this.targets = targets;
    this.unsubscribe = events.subscribeAll((event) => this.observe(event));
  }

  dispose(): void {
    this.unsubscribe();
  }

  private observe(event: EventEnvelope): void {
    this.windowEvents++;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === "task.completed") {
      this.taskCompleted++;
      if (payload.status === "succeeded") this.taskSucceeded++;
    } else if (event.type === "task.failed") {
      this.taskCompleted++;
    } else if (event.type === "capability.finished") {
      this.toolFinished++;
      if (payload.status !== "error") this.toolOk++;
    } else if (event.type === "model.request.started") {
      const key = `${event.sessionId}:${event.turnId ?? ""}:${String(payload.iteration ?? "")}`;
      this.modelTurns.set(key, { startedAt: Date.parse(event.timestamp) || Date.now() });
    } else if (event.type === "model.request.finished") {
      const key = `${event.sessionId}:${event.turnId ?? ""}:${String(payload.iteration ?? "")}`;
      const turn = this.modelTurns.get(key);
      if (turn) {
        this.modelTurns.delete(key);
        const finishedAt = Date.parse(event.timestamp) || Date.now();
        const duration = finishedAt - turn.startedAt;
        if (duration >= 0 && duration <= LATENCY_CAP_MS) this.modelLatencies.push(duration);
      }
    }
    if (this.modelLatencies.length > WINDOW_EVENTS) this.modelLatencies.splice(0, this.modelLatencies.length - WINDOW_EVENTS);
  }

  private budget(value: number, target: number, higherIsBetter: boolean): number {
    // Error budget remaining: 1 = fully within budget, <=0 = exhausted.
    return higherIsBetter ? (value - target) / (1 - target) : (target - value) / target;
  }

  report(): SloReport {
    const taskRate = this.taskCompleted > 0 ? this.taskSucceeded / this.taskCompleted : null;
    const toolRate = this.toolFinished > 0 ? this.toolOk / this.toolFinished : null;
    const p95 = this.modelLatencies.length > 0
      ? [...this.modelLatencies].sort((a, b) => a - b)[Math.min(this.modelLatencies.length - 1, Math.floor(this.modelLatencies.length * 0.95))]!
      : null;

    const indicators: SloIndicator[] = [
      {
        name: "task_success_rate",
        value: taskRate,
        sampleCount: this.taskCompleted,
        unit: "ratio",
        ...(taskRate === null ? { notMeasuredReason: "No task completion events observed in this window." } : {}),
        ...(this.targets.taskSuccessRate !== undefined && taskRate !== null
          ? { target: this.targets.taskSuccessRate, errorBudgetRemaining: this.budget(taskRate, this.targets.taskSuccessRate, true) }
          : {}),
      },
      {
        name: "tool_success_rate",
        value: toolRate,
        sampleCount: this.toolFinished,
        unit: "ratio",
        ...(toolRate === null ? { notMeasuredReason: "No capability completion events observed in this window." } : {}),
        ...(this.targets.toolSuccessRate !== undefined && toolRate !== null
          ? { target: this.targets.toolSuccessRate, errorBudgetRemaining: this.budget(toolRate, this.targets.toolSuccessRate, true) }
          : {}),
      },
      {
        name: "p95_model_turn_latency",
        value: p95,
        sampleCount: this.modelLatencies.length,
        unit: "milliseconds",
        ...(p95 === null ? { notMeasuredReason: "No paired model request start/finish events observed in this window." } : {}),
        ...(this.targets.p95ModelLatencyMs !== undefined && p95 !== null
          ? { target: this.targets.p95ModelLatencyMs, errorBudgetRemaining: this.budget(p95, this.targets.p95ModelLatencyMs, false) }
          : {}),
      },
      {
        name: "recovery_success_rate",
        value: null,
        sampleCount: 0,
        unit: "ratio",
        notMeasuredReason: "Failure classifications and recovery outcomes are not emitted on the event stream; measuring this would require inventing it.",
      },
      {
        name: "memory_retrieval_quality",
        value: null,
        sampleCount: 0,
        unit: "ratio",
        notMeasuredReason: "No relevance feedback signal exists for memory retrieval; measuring this would require inventing it.",
      },
    ];

    return {
      measuredSince: this.startedAt,
      windowEvents: this.windowEvents,
      indicators,
    };
  }
}
