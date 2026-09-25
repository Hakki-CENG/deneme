import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { auroraRound, DurableJsonState } from "../util/aurora-state.js";

type FailureCategory = "knowledge-gap" | "reasoning-error" | "tool-failure" | "environment-failure" | "planning-failure" | "memory-failure" | "hallucination" | "permission-failure" | "resource-failure" | "model-limitation" | "strategy-error" | "communication-error";
type FailureSeverity = "low" | "medium" | "high" | "critical";

interface ClassifiedFailure { id: string; tenantId: string; sessionId: string; taskId: string; description: string; category: FailureCategory; severity: FailureSeverity; rootCause: string; contributingFactors: string[]; evidenceEventIds: string[]; capabilityGap: string; suggestedFix: string; recurrenceCount: number; firstSeenAt: string; lastSeenAt: string; resolvedAt?: string; resolvedBy?: string; }
interface FailurePattern { id: string; tenantId: string; category: FailureCategory; signature: string; description: string; occurrences: number; affectedSessions: string[]; commonRootCause: string; suggestedMitigation: string; confidence: number; firstSeenAt: string; lastSeenAt: string; }

interface FailureStateShape { schemaVersion: number; failures: ClassifiedFailure[]; patterns: FailurePattern[]; }

export class FailureTaxonomyService {
  private store: DurableJsonState<FailureStateShape>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<FailureStateShape>(join(baseDir, "failure-taxonomy.json"), () => ({ schemaVersion: 1, failures: [], patterns: [] }), (v) => { const s = v as FailureStateShape; return !!s && s.schemaVersion === 1; }, "Aurora failure taxonomy");
  }
  async init(): Promise<void> { await this.store.read(); }

  async classify(tenantId: string, description: string, category: FailureCategory, severity: FailureSeverity, rootCause: string, opts?: { sessionId?: string; taskId?: string; contributingFactors?: string[]; evidenceEventIds?: string[]; capabilityGap?: string; suggestedFix?: string }): Promise<ClassifiedFailure> {
    return await this.store.mutate(s => {
      const existing = s.failures.find(f => f.tenantId === tenantId && f.category === category && f.rootCause === rootCause && !f.resolvedAt);
      if (existing) { existing.recurrenceCount++; existing.lastSeenAt = new Date().toISOString(); existing.description = description; this.updatePattern(s, existing); return existing; }
      const failure: ClassifiedFailure = { id: randomUUID(), tenantId, sessionId: opts?.sessionId ?? "", taskId: opts?.taskId ?? "", description, category, severity, rootCause, contributingFactors: opts?.contributingFactors ?? [], evidenceEventIds: opts?.evidenceEventIds ?? [], capabilityGap: opts?.capabilityGap ?? "", suggestedFix: opts?.suggestedFix ?? "", recurrenceCount: 1, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
      s.failures.push(failure);
      this.updatePattern(s, failure);
      return failure;
    });
  }

  async resolve(failureId: string, resolvedBy: string): Promise<void> {
    await this.store.mutate(s => { const f = s.failures.find(x => x.id === failureId); if (f) { f.resolvedAt = new Date().toISOString(); f.resolvedBy = resolvedBy; } });
  }

  private updatePattern(s: FailureStateShape, failure: ClassifiedFailure): void {
    const sig = `${failure.category}:${failure.rootCause.slice(0, 80)}`;
    const existing = s.patterns.find(p => p.tenantId === failure.tenantId && p.signature === sig);
    if (existing) { existing.occurrences++; existing.lastSeenAt = new Date().toISOString(); if (failure.sessionId && !existing.affectedSessions.includes(failure.sessionId)) existing.affectedSessions.push(failure.sessionId); existing.confidence = auroraRound(Math.min(1, existing.occurrences / 10)); return; }
    s.patterns.push({ id: randomUUID(), tenantId: failure.tenantId, category: failure.category, signature: sig, description: failure.description, occurrences: 1, affectedSessions: failure.sessionId ? [failure.sessionId] : [], commonRootCause: failure.rootCause, suggestedMitigation: failure.suggestedFix || "investigate", confidence: 0.1, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() });
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const tf = s.failures.filter(f => f.tenantId === tenantId);
    const tp = s.patterns.filter(p => p.tenantId === tenantId);
    const byCat: Record<string, number> = {}; const bySev: Record<string, number> = {};
    for (const f of tf) { byCat[f.category] = (byCat[f.category] ?? 0) + 1; bySev[f.severity] = (bySev[f.severity] ?? 0) + 1; }
    const resolved = tf.filter(f => f.resolvedAt).length;
    const now = Date.now(); const d30 = 30 * 86400000;
    const recent = tf.filter(f => now - new Date(f.lastSeenAt).getTime() < d30).length;
    const older = tf.filter(f => { const t = now - new Date(f.lastSeenAt).getTime(); return t >= d30 && t < d30 * 2; }).length;
    return { totalFailures: tf.length, byCategory: byCat, bySeverity: bySev, topPatterns: tp.sort((a, b) => b.occurrences - a.occurrences).slice(0, 10), resolutionRate: auroraRound(tf.length > 0 ? resolved / tf.length : 0), trendDirection: (recent < older ? "improving" : recent > older ? "worsening" : "stable") as string };
  }

  async getRecommendations(tenantId: string) {
    const stats = await this.getStats(tenantId);
    const recs: Array<{ category: string; recommendation: string; priority: number }> = [];
    for (const [cat, count] of Object.entries(stats.byCategory)) {
      const c = count as number;
      if (cat === "knowledge-gap" && c > 3) recs.push({ category: cat, recommendation: "Knowledge search ve microagent coverage artır", priority: c });
      if (cat === "reasoning-error" && c > 3) recs.push({ category: cat, recommendation: "Multi-hypothesis reasoning ve internal critic devreye al", priority: c });
      if (cat === "planning-failure" && c > 3) recs.push({ category: cat, recommendation: "Contingency planning ve recovery plan ekle", priority: c });
      if (cat === "tool-failure" && c > 3) recs.push({ category: cat, recommendation: "Tool discovery ve alternatif araç araştırması yap", priority: c });
      if (cat === "hallucination" && c > 2) recs.push({ category: cat, recommendation: "Uncertainty engine ve verification pipeline güçlendir", priority: c });
      if (cat === "resource-failure" && c > 2) recs.push({ category: cat, recommendation: "Resource intelligence ve budget tracking ekle", priority: c });
    }
    return recs.sort((a, b) => b.priority - a.priority);
  }

  async getFailures(tenantId: string, category?: FailureCategory, unresolvedOnly: boolean = false): Promise<ClassifiedFailure[]> {
    const s = await this.store.read();
    return s.failures.filter(f => f.tenantId === tenantId && (!category || f.category === category) && (!unresolvedOnly || !f.resolvedAt));
  }

  async getPatterns(tenantId: string): Promise<FailurePattern[]> {
    const s = await this.store.read();
    return s.patterns.filter(p => p.tenantId === tenantId).sort((a, b) => b.occurrences - a.occurrences);
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
    const rationale: string[] = [`Found entity: ${entity.name ?? entity.title ?? entity.id ?? entityId}`];
    return { entity: entity.name ?? entity.title ?? entityId, summary: entity.description ?? entity.statement ?? "", rationale, details: entity };
  }
}
