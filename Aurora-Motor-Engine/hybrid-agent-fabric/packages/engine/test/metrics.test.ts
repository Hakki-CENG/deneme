import { describe, expect, it } from "vitest";
import { MemoryEventStore } from "../src/persistence/event-store.js";
import { OperationalMetrics } from "../src/observability/operational-metrics.js";
import type { EventEnvelope, JsonValue } from "../src/types.js";

function event(sequence: number, type: string, payload: JsonValue): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `e-${sequence}`,
    tenantId: "sensitive-tenant-name",
    sessionId: "sensitive-session-id",
    familyId: "family",
    generation: 1,
    sequence,
    traceId: "trace",
    type,
    timestamp: new Date().toISOString(),
    visibility: "audit",
    redactionClass: "metadata-only",
    payload,
  };
}

describe("content-free operational metrics", () => {
  it("projects bounded counters without tenant/session/content labels", async () => {
    const store = new MemoryEventStore();
    const metrics = new OperationalMetrics(store);
    await store.append(event(1, "session.created", {}));
    await store.append(event(2, "session.status.changed", { status: "running" }));
    await store.append(event(3, "model.request.started", {}));
    await store.append(event(4, "model.request.finished", {
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
    }));
    await store.append(event(5, "capability.started", { capabilityId: "filesystem.read" }));
    const snapshot = metrics.snapshot();
    expect(snapshot.modelRequestsTotal).toBe(1);
    expect(snapshot.inputTokensTotal).toBe(10);
    expect(snapshot.sessionsByStatus.running).toBe(1);
    const prometheus = metrics.prometheus();
    expect(prometheus).toContain('haf_capability_calls_by_id_total{capability="filesystem.read"} 1');
    expect(prometheus).not.toContain("sensitive-tenant-name");
    expect(prometheus).not.toContain("sensitive-session-id");
    metrics.close();
  });
});
