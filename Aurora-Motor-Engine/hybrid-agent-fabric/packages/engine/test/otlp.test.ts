import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryEventStore } from "../src/persistence/event-store.js";
import { OperationalMetrics } from "../src/observability/operational-metrics.js";
import { OtlpMetricsExporter, buildOtlpMetricPayload } from "../src/observability/otlp-exporter.js";
import type { EventEnvelope } from "../src/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("OTLP JSON metrics exporter", () => {
  it("exports only the content-free operational projection", async () => {
    const events = new MemoryEventStore();
    const metrics = new OperationalMetrics(events);
    const event: EventEnvelope = {
      schemaVersion: 1,
      eventId: "event",
      tenantId: "raw-tenant-must-not-export",
      sessionId: "raw-session-must-not-export",
      familyId: "family",
      generation: 1,
      sequence: 1,
      traceId: "trace",
      type: "model.request.finished",
      timestamp: new Date().toISOString(),
      visibility: "audit",
      redactionClass: "metadata-only",
      payload: { usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 } },
    };
    await events.append(event);
    let body = "";
    globalThis.fetch = vi.fn(async (_url, init) => {
      body = String(init?.body);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const exporter = new OtlpMetricsExporter(metrics, { endpoint: "https://collector.example.test/v1/metrics", serviceVersion: "test" });
    expect(await exporter.exportNow()).toBe(true);
    const parsed = JSON.parse(body);
    expect(parsed.resourceMetrics[0].scopeMetrics[0].metrics.length).toBeGreaterThan(5);
    expect(body).not.toContain("raw-tenant-must-not-export");
    expect(body).not.toContain("raw-session-must-not-export");
    expect(exporter.status().exportsTotal).toBe(1);
    metrics.close();
  });

  it("fails open and records only the error class", async () => {
    const metrics = new OperationalMetrics(new MemoryEventStore());
    globalThis.fetch = vi.fn(async () => { throw new TypeError("secret raw network detail"); }) as typeof fetch;
    const exporter = new OtlpMetricsExporter(metrics, { endpoint: "https://collector.example.test/v1/metrics" });
    expect(await exporter.exportNow()).toBe(false);
    expect(exporter.status().lastFailureClass).toBe("TypeError");
    expect(JSON.stringify(exporter.status())).not.toContain("secret raw network detail");
    metrics.close();
  });
});
