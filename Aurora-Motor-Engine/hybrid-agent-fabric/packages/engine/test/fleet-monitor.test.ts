import { describe, expect, it } from "vitest";
import { FleetMonitor } from "../src/observability/fleet-monitor.js";
import { OperationalMetrics } from "../src/observability/operational-metrics.js";
import { MemoryEventStore } from "../src/persistence/event-store.js";
import { ApprovalService } from "../src/policy/approval-service.js";
import type { EventEnvelope } from "../src/types.js";
import type { DurableScheduler } from "../src/scheduler/scheduler.js";

describe("content-free fleet monitoring and alerts", () => {
  it("derives bounded alerts without resource identifiers or content", async () => {
    const events = new MemoryEventStore();
    const metrics = new OperationalMetrics(events);
    const base = { schemaVersion: 1 as const, tenantId: "secret-tenant", sessionId: "secret-session", familyId: "family", generation: 1, traceId: "trace", timestamp: new Date().toISOString(), visibility: "audit" as const, redactionClass: "metadata-only" as const };
    await events.append({ ...base, eventId: "1", sequence: 1, type: "capability.started", payload: { capabilityId: "x" } });
    await events.append({ ...base, eventId: "2", sequence: 2, type: "capability.finished", payload: { status: "error" } });
    const approvals = new ApprovalService(60 * 60_000);
    void approvals.request(
      { id: "x", version: "1", description: "x", risk: "external_side_effect", sideEffect: true, inputSchema: {}, source: "core" },
      {},
      { tenantId: "secret-tenant", sessionId: "secret-session", familyId: "family", turnId: "turn", toolCallId: "tool", source: "api", workspacePath: "/tmp", idempotencyKey: "id" },
      "secret reason",
    );
    const scheduler = {
      list: async () => [{ id: "secret-job", tenantId: "secret-tenant", sessionId: "secret-session", prompt: "secret prompt", schedule: { kind: "once", at: new Date().toISOString() }, status: "active", nextRunAt: new Date(Date.now() - 1000).toISOString(), runCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    } as unknown as DurableScheduler;
    const monitor = new FleetMonitor(metrics, scheduler, approvals, {
      workerProbe: async () => ({ running: 1, recovered: 0, stale: 1, unreachable: 0 }),
      capabilityFailureRateWarning: 0.1,
      approvalAgeWarningSeconds: 1,
    });
    const snapshot = await monitor.snapshot(new Date(Date.now() + 5000));
    expect(snapshot.alerts.map((alert) => alert.code)).toEqual(expect.arrayContaining([
      "capability_failure_rate", "approval_wait_age", "scheduler_overdue", "worker_unreachable",
    ]));
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("secret-tenant");
    expect(serialized).not.toContain("secret-session");
    expect(serialized).not.toContain("secret prompt");
    approvals.resolve(approvals.list()[0]!.id, "deny");
    metrics.close();
  });
});
