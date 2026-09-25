import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { auroraRound, DurableJsonState } from "../util/aurora-state.js";

type SpanKind = "observe" | "think" | "decide" | "plan" | "execute" | "verify" | "learn" | "reflect" | "simulate" | "recover";
interface TelemetrySpan { id: string; traceId: string; parentSpanId: string; kind: SpanKind; operation: string; reasoning: string; inputs: Record<string, unknown>; outputs: Record<string, unknown>; confidence: number; alternatives: Array<{ option: string; reason: string }>; startedAt: string; endedAt: string; durationMs: number; status: "ok" | "error" | "skipped"; errorDetail: string; tokensUsed: number; costUsd: number; modelUsed: string; }
interface DecisionTrace { id: string; tenantId: string; sessionId: string; goal: string; spans: TelemetrySpan[]; outcome: "success" | "failure" | "partial" | "abandoned"; outcomeDetail: string; totalDurationMs: number; totalTokensUsed: number; totalCostUsd: number; modelsUsed: string[]; decisionCount: number; strategySwitches: number; confidenceAtStart: number; confidenceAtEnd: number; lessonsExtracted: string[]; startedAt: string; endedAt: string; }

interface TelemetryStateShape { schemaVersion: number; traces: DecisionTrace[]; }

/** Narrow an untyped stored record to a DecisionTrace, for `why()`. */
function isDecisionTrace(value: unknown): value is DecisionTrace {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DecisionTrace>;
  return (
    typeof candidate.goal === "string" &&
    typeof candidate.outcome === "string" &&
    Array.isArray(candidate.spans) &&
    Array.isArray(candidate.lessonsExtracted)
  );
}

export class CognitiveTelemetryService {
  private store: DurableJsonState<TelemetryStateShape>;
  private activeSpans: Map<string, TelemetrySpan> = new Map();
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<TelemetryStateShape>(join(baseDir, "cognitive-telemetry.json"), () => ({ schemaVersion: 1, traces: [] }), (v) => { const s = v as TelemetryStateShape; return !!s && s.schemaVersion === 1; }, "Aurora cognitive telemetry");
  }
  async init(): Promise<void> { await this.store.read(); }

  async startTrace(tenantId: string, goal: string, sessionId: string = "", initialConfidence: number = 0.5): Promise<string> {
    const trace: DecisionTrace = { id: randomUUID(), tenantId, sessionId, goal, spans: [], outcome: "abandoned", outcomeDetail: "", totalDurationMs: 0, totalTokensUsed: 0, totalCostUsd: 0, modelsUsed: [], decisionCount: 0, strategySwitches: 0, confidenceAtStart: initialConfidence, confidenceAtEnd: initialConfidence, lessonsExtracted: [], startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
    await this.store.mutate(s => { s.traces.push(trace); });
    return trace.id;
  }

  startSpan(traceId: string, kind: SpanKind, operation: string, reasoning: string, inputs: Record<string, unknown> = {}, parentSpanId: string = ""): string {
    const span: TelemetrySpan = { id: randomUUID(), traceId, parentSpanId, kind, operation, reasoning, inputs, outputs: {}, confidence: 0, alternatives: [], startedAt: new Date().toISOString(), endedAt: "", durationMs: 0, status: "ok", errorDetail: "", tokensUsed: 0, costUsd: 0, modelUsed: "" };
    this.activeSpans.set(span.id, span);
    return span.id;
  }

  async endSpan(spanId: string, outputs: Record<string, unknown> = {}, status: "ok" | "error" | "skipped" = "ok", errorDetail: string = ""): Promise<void> {
    const span = this.activeSpans.get(spanId);
    if (!span) return;
    span.outputs = outputs; span.status = status; span.errorDetail = errorDetail;
    span.endedAt = new Date().toISOString(); span.durationMs = new Date(span.endedAt).getTime() - new Date(span.startedAt).getTime();
    this.activeSpans.delete(spanId);
    await this.store.mutate(s => { const t = s.traces.find(x => x.id === span.traceId); if (t) { t.spans.push(span); if (span.kind === "decide") t.decisionCount++; if (span.kind === "recover") t.strategySwitches++; t.totalTokensUsed += span.tokensUsed; t.totalCostUsd += span.costUsd; if (span.modelUsed && !t.modelsUsed.includes(span.modelUsed)) t.modelsUsed.push(span.modelUsed); } });
  }

  setSpanConfidence(spanId: string, confidence: number): void { const s = this.activeSpans.get(spanId); if (s) s.confidence = auroraRound(confidence); }
  setSpanAlternatives(spanId: string, alts: Array<{ option: string; reason: string }>): void { const s = this.activeSpans.get(spanId); if (s) s.alternatives = alts; }

  async endTrace(traceId: string, outcome: DecisionTrace["outcome"], outcomeDetail: string, finalConfidence?: number, lessons?: string[]): Promise<void> {
    await this.store.mutate(s => {
      const t = s.traces.find(x => x.id === traceId);
      if (!t) return;
      t.outcome = outcome; t.outcomeDetail = outcomeDetail; t.endedAt = new Date().toISOString();
      t.totalDurationMs = new Date(t.endedAt).getTime() - new Date(t.startedAt).getTime();
      if (finalConfidence !== undefined) t.confidenceAtEnd = auroraRound(finalConfidence);
      if (lessons) t.lessonsExtracted = lessons;
    });
  }

  async getTraces(tenantId: string, sessionId?: string, outcome?: string, limit: number = 50): Promise<DecisionTrace[]> {
    const s = await this.store.read();
    return s.traces.filter(t => t.tenantId === tenantId && (!sessionId || t.sessionId === sessionId) && (!outcome || t.outcome === outcome)).sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()).slice(0, limit);
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const tt = s.traces.filter(t => t.tenantId === tenantId);
    if (!tt.length) return { totalTraces: 0, successRate: 0, avgDurationMs: 0, avgDecisionCount: 0, avgConfidenceChange: 0, topOperations: [] as Array<{ operation: string; count: number; avgDuration: number }>, byOutcome: {} as Record<string, number> };
    const successRate = tt.filter(t => t.outcome === "success").length / tt.length;
    const avgDur = tt.reduce((s, t) => s + t.totalDurationMs, 0) / tt.length;
    const avgDec = tt.reduce((s, t) => s + t.decisionCount, 0) / tt.length;
    const avgConf = tt.reduce((s, t) => s + (t.confidenceAtEnd - t.confidenceAtStart), 0) / tt.length;
    const opCounts = new Map<string, { count: number; total: number }>();
    for (const t of tt) for (const sp of t.spans) { const op = opCounts.get(sp.operation) ?? { count: 0, total: 0 }; op.count++; op.total += sp.durationMs; opCounts.set(sp.operation, op); }
    const topOps = [...opCounts.entries()].map(([op, d]) => ({ operation: op, count: d.count, avgDuration: Math.round(d.total / d.count) })).sort((a, b) => b.count - a.count).slice(0, 15);
    const byOutcome: Record<string, number> = {};
    for (const t of tt) byOutcome[t.outcome] = (byOutcome[t.outcome] ?? 0) + 1;
    return { totalTraces: tt.length, successRate: auroraRound(successRate), avgDurationMs: Math.round(avgDur), avgDecisionCount: Math.round(avgDec), avgConfidenceChange: auroraRound(avgConf), topOperations: topOps, byOutcome };
  }

  // ═══ P2: Explainability ═══

  async why(tenantId: string, entityId: string): Promise<{
entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
    }> {
    const s = await this.store.read();
    const keys = Object.keys(s);
    const arrayKey = keys.find(k => Array.isArray((s as any)[k]));
    const items: any[] = arrayKey ? ((s as any)[arrayKey] as any[]).filter((x: any) => x.tenantId === tenantId) : [];
    const entity = items.find((x: any) => x.id === entityId);
    if (!entity) throw new Error("Entity not found");

    // Decision traces are the entity this service actually stores, so explain
    // them properly instead of probing for `description`/`statement` fields a
    // DecisionTrace does not have — that returned an empty summary and a
    // single "Found entity" line, which is a lookup, not an explanation.
    if (isDecisionTrace(entity)) {
      const rationale: string[] = [
        `Goal: ${entity.goal}`,
        `Outcome: ${entity.outcome}${entity.outcomeDetail ? ` — ${entity.outcomeDetail}` : ""}`,
        `Confidence moved ${entity.confidenceAtStart} → ${entity.confidenceAtEnd}`,
        `${entity.spans.length} span(s), ${entity.decisionCount} decision(s), ${entity.strategySwitches} strategy switch(es)`,
      ];
      if (entity.modelsUsed.length > 0) rationale.push(`Models used: ${entity.modelsUsed.join(", ")}`);
      if (entity.totalCostUsd > 0) {
        rationale.push(`Cost: $${entity.totalCostUsd.toFixed(4)} over ${entity.totalTokensUsed} token(s)`);
      }
      for (const lesson of entity.lessonsExtracted) rationale.push(`Lesson: ${lesson}`);

      return {
        entity: entity.goal || entityId,
        summary:
          `${entity.outcome} after ${entity.totalDurationMs}ms` +
          `${entity.outcomeDetail ? `: ${entity.outcomeDetail}` : ""}`,
        rationale,
        details: entity as unknown as Record<string, unknown>,
      };
    }

    const rationale: string[] = [`Found entity: ${entity.name ?? entity.title ?? entity.id ?? entityId}`];
    return { entity: entity.name ?? entity.title ?? entityId, summary: entity.description ?? entity.statement ?? "", rationale, details: entity };
  }



  async getInsightfulTraces(tenantId: string, limit: number = 10): Promise<DecisionTrace[]> {
    const s = await this.store.read();
    return s.traces.filter(t => t.tenantId === tenantId && t.lessonsExtracted.length > 0).sort((a, b) => b.lessonsExtracted.length - a.lessonsExtracted.length).slice(0, limit);
  }

  // ═══ P2: Cost Intelligence ═══

  recordSpanCost(spanId: string, tokensUsed: number, costUsd: number, modelUsed: string): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;
    span.tokensUsed = tokensUsed;
    span.costUsd = costUsd;
    span.modelUsed = modelUsed;
  }

  async getCostStats(tenantId: string): Promise<{
totalCostUsd: number; totalTokens: number; avgCostPerTrace: number; costPerSuccess: number;
    byModel: Array<{ model: string; costUsd: number; tokens: number; traces: number }>;
    byOperation: Array<{ operation: string; costUsd: number; tokens: number; count: number }>;
    cheapestSuccessfulStrategy: string; mostExpensiveStrategy: string;
    }> {
    const s = await this.store.read();
    const tt = s.traces.filter(t => t.tenantId === tenantId);
    const totalCost = tt.reduce((sum, t) => sum + t.totalCostUsd, 0);
    const totalTokens = tt.reduce((sum, t) => sum + t.totalTokensUsed, 0);
    const successCount = tt.filter(t => t.outcome === "success").length;
    const byModel = new Map<string, { costUsd: number; tokens: number; traces: number }>();
    const byOp = new Map<string, { costUsd: number; tokens: number; count: number }>();
    for (const t of tt) {
      for (const sp of t.spans) {
        if (sp.modelUsed) { const m = byModel.get(sp.modelUsed) ?? { costUsd: 0, tokens: 0, traces: 0 }; m.costUsd += sp.costUsd; m.tokens += sp.tokensUsed; byModel.set(sp.modelUsed, m); }
        const o = byOp.get(sp.operation) ?? { costUsd: 0, tokens: 0, count: 0 }; o.costUsd += sp.costUsd; o.tokens += sp.tokensUsed; o.count++; byOp.set(sp.operation, o);
      }
    }
    for (const [model, data] of byModel) data.traces = tt.filter(t => t.modelsUsed.includes(model)).length;
    const modelArr = [...byModel.entries()].map(([model, d]) => ({ model, ...d })).sort((a, b) => b.costUsd - a.costUsd);
    const opArr = [...byOp.entries()].map(([operation, d]) => ({ operation, ...d })).sort((a, b) => b.costUsd - a.costUsd);
    return {
      totalCostUsd: totalCost, totalTokens, avgCostPerTrace: tt.length ? totalCost / tt.length : 0, costPerSuccess: successCount ? totalCost / successCount : 0,
      byModel: modelArr, byOperation: opArr.slice(0, 15),
      cheapestSuccessfulStrategy: modelArr.length ? modelArr.reduce((best, m) => m.costUsd / Math.max(1, m.traces) < best.costUsd / Math.max(1, best.traces) ? m : best).model : "none",
      mostExpensiveStrategy: modelArr.length ? modelArr[0]!.model : "none",
    };
  }
}
