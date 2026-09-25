import type { EventEnvelope, JsonValue } from "../types.js";
import type { EventStore } from "../persistence/event-store.js";

export interface OperationalSnapshot {
  uptimeSeconds: number;
  eventsTotal: number;
  modelRequestsTotal: number;
  capabilityCallsTotal: number;
  capabilityFailuresTotal: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  cacheReadTokensTotal: number;
  cacheWriteTokensTotal: number;
  sessionsByStatus: Record<string, number>;
  capabilityCallsById: Record<string, number>;
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function number(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 160);
}

export class OperationalMetrics {
  private readonly startedAt = Date.now();
  private eventsTotal = 0;
  private modelRequestsTotal = 0;
  private capabilityCallsTotal = 0;
  private capabilityFailuresTotal = 0;
  private inputTokensTotal = 0;
  private outputTokensTotal = 0;
  private cacheReadTokensTotal = 0;
  private cacheWriteTokensTotal = 0;
  private readonly sessionStatuses = new Map<string, string>();
  private readonly capabilityCalls = new Map<string, number>();
  private readonly unsubscribe: () => void;

  constructor(events: EventStore) {
    this.unsubscribe = events.subscribeAll((event) => this.observe(event));
  }

  observe(event: EventEnvelope): void {
    this.eventsTotal++;
    const payload = record(event.payload);
    if (event.type === "session.created") this.sessionStatuses.set(event.sessionId, "ready");
    if (event.type === "session.status.changed" && typeof payload.status === "string") {
      this.sessionStatuses.set(event.sessionId, safeLabel(payload.status));
    }
    if (event.type === "model.request.started") this.modelRequestsTotal++;
    if (event.type === "model.request.finished") {
      const usage = record(payload.usage ?? null);
      this.inputTokensTotal += number(usage.inputTokens);
      this.outputTokensTotal += number(usage.outputTokens);
      this.cacheReadTokensTotal += number(usage.cacheReadTokens);
      this.cacheWriteTokensTotal += number(usage.cacheWriteTokens);
    }
    if (event.type === "capability.started") {
      this.capabilityCallsTotal++;
      if (typeof payload.capabilityId === "string") {
        const id = safeLabel(payload.capabilityId);
        this.capabilityCalls.set(id, (this.capabilityCalls.get(id) ?? 0) + 1);
      }
    }
    if (event.type === "capability.finished" && payload.status === "error") this.capabilityFailuresTotal++;
  }

  snapshot(): OperationalSnapshot {
    const sessionsByStatus: Record<string, number> = {};
    for (const status of this.sessionStatuses.values()) sessionsByStatus[status] = (sessionsByStatus[status] ?? 0) + 1;
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      eventsTotal: this.eventsTotal,
      modelRequestsTotal: this.modelRequestsTotal,
      capabilityCallsTotal: this.capabilityCallsTotal,
      capabilityFailuresTotal: this.capabilityFailuresTotal,
      inputTokensTotal: this.inputTokensTotal,
      outputTokensTotal: this.outputTokensTotal,
      cacheReadTokensTotal: this.cacheReadTokensTotal,
      cacheWriteTokensTotal: this.cacheWriteTokensTotal,
      sessionsByStatus,
      capabilityCallsById: Object.fromEntries(this.capabilityCalls),
    };
  }

  prometheus(): string {
    const snapshot = this.snapshot();
    const lines = [
      "# HELP haf_uptime_seconds Process uptime.",
      "# TYPE haf_uptime_seconds gauge",
      `haf_uptime_seconds ${snapshot.uptimeSeconds}`,
      "# TYPE haf_events_total counter",
      `haf_events_total ${snapshot.eventsTotal}`,
      "# TYPE haf_model_requests_total counter",
      `haf_model_requests_total ${snapshot.modelRequestsTotal}`,
      "# TYPE haf_capability_calls_total counter",
      `haf_capability_calls_total ${snapshot.capabilityCallsTotal}`,
      "# TYPE haf_capability_failures_total counter",
      `haf_capability_failures_total ${snapshot.capabilityFailuresTotal}`,
      "# TYPE haf_model_tokens_total counter",
      `haf_model_tokens_total{kind=\"input\"} ${snapshot.inputTokensTotal}`,
      `haf_model_tokens_total{kind=\"output\"} ${snapshot.outputTokensTotal}`,
      `haf_model_tokens_total{kind=\"cache_read\"} ${snapshot.cacheReadTokensTotal}`,
      `haf_model_tokens_total{kind=\"cache_write\"} ${snapshot.cacheWriteTokensTotal}`,
      "# TYPE haf_sessions gauge",
      ...Object.entries(snapshot.sessionsByStatus).map(([status, count]) => `haf_sessions{status=\"${safeLabel(status)}\"} ${count}`),
      "# TYPE haf_capability_calls_by_id_total counter",
      ...Object.entries(snapshot.capabilityCallsById).map(([id, count]) => `haf_capability_calls_by_id_total{capability=\"${safeLabel(id)}\"} ${count}`),
    ];
    return `${lines.join("\n")}\n`;
  }

  close(): void {
    this.unsubscribe();
  }
}
