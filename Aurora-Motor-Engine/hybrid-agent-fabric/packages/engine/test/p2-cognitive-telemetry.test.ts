/**
 * Cognitive telemetry — cost and decision accounting.
 *
 * These tests previously asserted `typeof stats.totalCostUsd === "number"`,
 * which the service satisfies by returning zero forever: the suite never
 * recorded a cost, so nothing distinguished working accounting from an
 * accumulator that was never wired. Same pattern as the FAZ 11 gate that
 * "passed" while measuring nothing.
 *
 * They now record known amounts and assert the arithmetic — totals, the
 * per-model and per-operation breakdown, and cost-per-success — so the numbers
 * are pinned to values only correct summation can produce.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CognitiveTelemetryService } from "../src/aurora/cognitive-telemetry.js";

async function telemetry(): Promise<CognitiveTelemetryService> {
  const root = await mkdtemp(join(tmpdir(), "haf-telemetry-"));
  return new CognitiveTelemetryService(root);
}

/** Record one span with a known cost, so totals are predictable. */
async function costedSpan(
  service: CognitiveTelemetryService,
  traceId: string,
  operation: string,
  model: string,
  tokens: number,
  costUsd: number,
): Promise<void> {
  const spanId = service.startSpan(traceId, "model-call", operation, `Running ${operation}`);
  service.recordSpanCost(spanId, tokens, costUsd, model);
  await service.endSpan(spanId, { result: "ok" }, "ok");
}

describe("P2: Cognitive Telemetry — Cost Intelligence", () => {
  it("sums recorded span costs into the trace total", async () => {
    const service = await telemetry();

    const traceId = await service.startTrace("tenant1", "test-operation");
    await costedSpan(service, traceId, "draft", "gpt-4", 1_000, 0.03);
    await costedSpan(service, traceId, "review", "gpt-4", 500, 0.015);
    await service.endTrace(traceId, "success", "Completed successfully", 0.9, ["lesson1"]);

    const stats = await service.getCostStats("tenant1");

    // The exact arithmetic, not its type: 0.03 + 0.015, 1000 + 500.
    expect(stats.totalCostUsd).toBeCloseTo(0.045, 6);
    expect(stats.totalTokens).toBe(1_500);
    expect(stats.avgCostPerTrace).toBeCloseTo(0.045, 6);

    // One successful trace carried the whole cost.
    expect(stats.costPerSuccess).toBeCloseTo(0.045, 6);
  });

  it("attributes cost to the model and operation that incurred it", async () => {
    const service = await telemetry();

    const traceId = await service.startTrace("tenant1", "mixed-models");
    await costedSpan(service, traceId, "draft", "gpt-4", 1_000, 0.04);
    await costedSpan(service, traceId, "summarise", "haiku", 2_000, 0.001);
    await service.endTrace(traceId, "success", "Done", 0.8);

    const stats = await service.getCostStats("tenant1");

    // Sorted by cost descending, so the expensive model leads.
    expect(stats.byModel.map((m) => m.model)).toEqual(["gpt-4", "haiku"]);
    expect(stats.byModel[0]?.costUsd).toBeCloseTo(0.04, 6);
    expect(stats.byModel[0]?.tokens).toBe(1_000);
    expect(stats.byModel[1]?.costUsd).toBeCloseTo(0.001, 6);

    // The cheap model processed MORE tokens — a breakdown that merely echoed
    // the total could not show this.
    expect(stats.byModel[1]?.tokens).toBe(2_000);

    expect(stats.byOperation.map((o) => o.operation)).toEqual(["draft", "summarise"]);
    expect(stats.byOperation[0]?.count).toBe(1);
  });

  it("separates tenants rather than pooling every cost", async () => {
    const service = await telemetry();

    const mine = await service.startTrace("tenant1", "mine");
    await costedSpan(service, mine, "work", "gpt-4", 100, 0.01);
    await service.endTrace(mine, "success", "Done", 0.9);

    const theirs = await service.startTrace("tenant2", "theirs");
    await costedSpan(service, theirs, "work", "gpt-4", 9_999, 9.99);
    await service.endTrace(theirs, "success", "Done", 0.9);

    const stats = await service.getCostStats("tenant1");
    expect(stats.totalCostUsd).toBeCloseTo(0.01, 6);
    expect(stats.totalTokens).toBe(100);
  });

  it("reports zero for a tenant that has no traces", async () => {
    const service = await telemetry();
    const stats = await service.getCostStats("nobody");

    // Zero is the honest answer here — and it is only meaningful because the
    // tests above prove a non-zero cost would have been counted.
    expect(stats.totalCostUsd).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.byModel).toEqual([]);
  });

  it("provides getStats summary with real counts and success rate", async () => {
    const service = await telemetry();

    const ok = await service.startTrace("tenant1", "good");
    await costedSpan(service, ok, "work", "gpt-4", 10, 0.001);
    await service.endTrace(ok, "success", "Fine", 0.9);

    const bad = await service.startTrace("tenant1", "bad");
    await costedSpan(service, bad, "work", "gpt-4", 10, 0.001);
    await service.endTrace(bad, "failure", "Broke", 0.2);

    const stats = await service.getStats("tenant1");

    expect(stats.totalTraces).toBe(2);
    expect(stats.successRate).toBeCloseTo(0.5, 6);
    expect(stats.byOutcome).toMatchObject({ success: 1, failure: 1 });
    expect(stats.topOperations[0]?.operation).toBe("work");
    expect(stats.topOperations[0]?.count).toBe(2);
  });

  it("why() explains a trace that exists", async () => {
    const service = await telemetry();

    const traceId = await service.startTrace("tenant1", "test-why");
    const spanId = service.startSpan(traceId, "analysis", "reasoning", "Analyzing");
    await service.endSpan(spanId, { result: "ok" }, "ok");
    await service.endTrace(traceId, "success", "Done", 0.8);

    // Previously wrapped in try/catch that accepted the error path too, so a
    // service that always threw would have passed. The trace was just created;
    // an explanation is required.
    const explanation = await service.why("tenant1", traceId);
    expect(explanation.rationale).toBeInstanceOf(Array);
    expect(explanation.summary).toBeTruthy();
  });

  it("getInsightfulTraces surfaces the trace carrying lessons", async () => {
    const service = await telemetry();

    const withLesson = await service.startTrace("tenant1", "learning-task");
    await service.endTrace(withLesson, "success", "Learned something", 0.9, [
      "Always validate input",
    ]);

    const withoutLesson = await service.startTrace("tenant1", "routine-task");
    await service.endTrace(withoutLesson, "success", "Nothing new", 0.9);

    const insightful = await service.getInsightfulTraces("tenant1", 10);

    // Asserting *which* trace comes back, not merely that an array does.
    const ids = insightful.map((t: { id: string }) => t.id);
    expect(ids).toContain(withLesson);
    expect(insightful.find((t: { id: string }) => t.id === withLesson)?.lessonsExtracted).toEqual([
      "Always validate input",
    ]);
  });
});
