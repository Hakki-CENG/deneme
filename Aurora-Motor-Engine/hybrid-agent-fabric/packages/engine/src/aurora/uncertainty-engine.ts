import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { auroraRound, DurableJsonState } from "../util/aurora-state.js";

type EvidenceType = "observation" | "test-result" | "user-confirm" | "documentation" | "analogy" | "inference" | "experiment" | "model-output";
type UncertaintySource = "incomplete-info" | "model-limitation" | "temporal-drift" | "domain-novelty" | "conflicting-evidence" | "measurement-error";

interface Evidence { id: string; type: EvidenceType; description: string; strength: number; source: string; timestamp: string; ref?: string; }
interface UncertainClaim { id: string; tenantId: string; claim: string; domain: string; confidence: number; calibratedConfidence: number; evidence: Evidence[]; assumptions: string[]; uncertaintySources: UncertaintySource[]; requiredVerification: string[]; status: "proposed" | "supported" | "contested" | "verified" | "refuted"; createdAt: string; updatedAt: string; verifiedAt?: string; verifiedBy?: string; }
interface CalibEntry { predicted: number; actual: number; domain: string; at: string; }

interface UncertaintyStateShape { schemaVersion: number; claims: UncertainClaim[]; calibrationHistory: CalibEntry[]; }

export class UncertaintyEngine {
  private store: DurableJsonState<UncertaintyStateShape>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<UncertaintyStateShape>(join(baseDir, "uncertainty-engine.json"), () => ({ schemaVersion: 1, claims: [], calibrationHistory: [] }), (v) => { const s = v as UncertaintyStateShape; return !!s && s.schemaVersion === 1; }, "Aurora uncertainty engine");
  }
  async init(): Promise<void> { await this.store.read(); }

  async assert(tenantId: string, claim: string, domain: string, confidence: number, opts?: { evidence?: Evidence[]; assumptions?: string[]; uncertaintySources?: UncertaintySource[]; requiredVerification?: string[] }): Promise<UncertainClaim> {
    const calibrated = await this.calibrate(confidence, domain);
    const c: UncertainClaim = { id: randomUUID(), tenantId, claim, domain, confidence: auroraRound(confidence), calibratedConfidence: auroraRound(calibrated), evidence: opts?.evidence ?? [], assumptions: opts?.assumptions ?? [], uncertaintySources: opts?.uncertaintySources ?? [], requiredVerification: opts?.requiredVerification ?? [], status: "proposed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await this.store.mutate(s => { s.claims.push(c); });
    return c;
  }

  async addEvidence(claimId: string, evidence: Evidence): Promise<void> {
    await this.store.mutate(s => {
      const c = s.claims.find(x => x.id === claimId);
      if (!c) return;
      c.evidence.push(evidence);
      const avgStr = c.evidence.reduce((sum, e) => sum + e.strength, 0) / c.evidence.length;
      c.confidence = auroraRound(Math.min(1, c.confidence * 0.7 + avgStr * 0.3));
      c.updatedAt = new Date().toISOString();
    });
  }

  async verify(claimId: string, actuallyTrue: boolean, verifiedBy: string): Promise<void> {
    await this.store.mutate(s => {
      const c = s.claims.find(x => x.id === claimId);
      if (!c) return;
      c.status = actuallyTrue ? "verified" : "refuted";
      c.verifiedAt = new Date().toISOString();
      c.verifiedBy = verifiedBy;
      c.updatedAt = new Date().toISOString();
      s.calibrationHistory.push({ predicted: c.calibratedConfidence, actual: actuallyTrue ? 1 : 0, domain: c.domain, at: new Date().toISOString() });
    });
  }

  private async calibrate(confidence: number, domain: string): Promise<number> {
    const s = await this.store.read();
    const domainHistory = s.calibrationHistory.filter(h => h.domain === domain);
    if (domainHistory.length < 5) return confidence;
    const recent = domainHistory.slice(-100);
    const avgPred = recent.reduce((sum, h) => sum + h.predicted, 0) / recent.length;
    const avgActual = recent.reduce((sum, h) => sum + h.actual, 0) / recent.length;
    const bias = avgPred - avgActual;
    return auroraRound(Math.max(0, Math.min(1, confidence - bias * 0.3)));
  }

  async getConfident(tenantId: string, threshold: number = 0.7): Promise<UncertainClaim[]> {
    const s = await this.store.read();
    return s.claims.filter(c => c.tenantId === tenantId && c.calibratedConfidence >= threshold && c.status !== "refuted");
  }

  async getUncertain(tenantId: string, threshold: number = 0.4): Promise<UncertainClaim[]> {
    const s = await this.store.read();
    return s.claims.filter(c => c.tenantId === tenantId && c.calibratedConfidence < threshold && c.status === "proposed");
  }

  async getCalibrationStats(): Promise<{ totalClaims: number; averageConfidence: number; calibrationError: number; overconfidenceRate: number; underconfidenceRate: number; byDomain: Record<string, { count: number; avgConfidence: number; accuracy: number }> }> {
    const s = await this.store.read();
    if (!s.calibrationHistory.length) return { totalClaims: 0, averageConfidence: 0, calibrationError: 0, overconfidenceRate: 0, underconfidenceRate: 0, byDomain: {} };
    const avgPred = s.calibrationHistory.reduce((sum, h) => sum + h.predicted, 0) / s.calibrationHistory.length;
    const calErr = s.calibrationHistory.reduce((sum, h) => sum + Math.abs(h.predicted - h.actual), 0) / s.calibrationHistory.length;
    const over = s.calibrationHistory.filter(h => h.predicted > h.actual + 0.1).length;
    const under = s.calibrationHistory.filter(h => h.predicted < h.actual - 0.1).length;
    const byDomain: Record<string, { count: number; avgConfidence: number; accuracy: number }> = {};
    for (const h of s.calibrationHistory) { const d = byDomain[h.domain] ?? { count: 0, avgConfidence: 0, accuracy: 0 }; d.count++; d.avgConfidence += h.predicted; d.accuracy += h.actual > 0.5 ? 1 : 0; byDomain[h.domain] = d; }
    for (const d of Object.values(byDomain)) { d.avgConfidence = auroraRound(d.avgConfidence / d.count); d.accuracy = auroraRound(d.accuracy / d.count); }
    return { totalClaims: s.claims.length, averageConfidence: auroraRound(avgPred), calibrationError: auroraRound(calErr), overconfidenceRate: auroraRound(over / s.calibrationHistory.length), underconfidenceRate: auroraRound(under / s.calibrationHistory.length), byDomain };
  }

  async getClaims(tenantId: string, domain?: string, status?: string): Promise<UncertainClaim[]> {
    const s = await this.store.read();
    return s.claims.filter(c => c.tenantId === tenantId && (!domain || c.domain === domain) && (!status || c.status === status));
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const items = (s as any).claims?.filter((x: any) => x.tenantId === tenantId) ?? [];
    return { total: items.length };
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
