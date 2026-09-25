import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type HypothesisStatus = "proposed" | "testing" | "confirmed" | "refuted" | "superseded" | "stale";
type EvidenceStrength = "weak" | "moderate" | "strong" | "conclusive";

interface Evidence { id: string; source: string; description: string; supportsHypothesis: boolean; strength: EvidenceStrength; timestamp: string; }
interface Hypothesis {
  id: string;
  tenantId: string;
  statement: string;
  domain: string;
  status: HypothesisStatus;
  confidence: number;
  evidence: Evidence[];
  competingHypotheses: string[];
  assumptions: string[];
  implications: string[];
  testResults: { testId: string; result: string; supported: boolean; }[];
  supersededBy: string | null;
  supersedes: string[];
  createdAt: string;
  updatedAt: string;
}
interface ReasoningChain { id: string; tenantId: string; question: string; hypotheses: string[]; selectedHypothesisId: string; reasoning: string; conclusion: string; confidence: number; alternativesConsidered: number; createdAt: string; }

interface MultiHypState { schemaVersion: number; hypotheses: Hypothesis[]; reasoningChains: ReasoningChain[]; }

export class MultiHypothesisReasoningService {
  private store: DurableJsonState<MultiHypState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<MultiHypState>(
      join(baseDir, "multi-hypothesis-reasoning.json"),
      () => ({ schemaVersion: 1, hypotheses: [], reasoningChains: [] }),
      (v) => { const s = v as MultiHypState; return !!s && s.schemaVersion === 1; },
      "Aurora multi-hypothesis reasoning",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async proposeHypothesis(tenantId: string, statement: string, domain: string, assumptions: string[] = [], implications: string[] = []): Promise<Hypothesis> {
    const h: Hypothesis = { id: randomUUID(), tenantId, statement, domain, status: "proposed", confidence: 0.3, evidence: [], competingHypotheses: [], assumptions, implications, testResults: [], supersededBy: null, supersedes: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await this.store.mutate(s => { s.hypotheses.push(h); });
    return h;
  }

  async addEvidence(hypothesisId: string, source: string, description: string, supports: boolean, strength: EvidenceStrength): Promise<Evidence> {
    const e: Evidence = { id: randomUUID(), source, description, supportsHypothesis: supports, strength, timestamp: new Date().toISOString() };
    await this.store.mutate(s => {
      const h = s.hypotheses.find(x => x.id === hypothesisId);
      if (!h) return;
      h.evidence.push(e);
      const strengthMultiplier: Record<EvidenceStrength, number> = { weak: 0.05, moderate: 0.1, strong: 0.2, conclusive: 0.35 };
      const delta = strengthMultiplier[e.strength] * (supports ? 1 : -1);
      h.confidence = Math.max(0, Math.min(1, h.confidence + delta));
      h.updatedAt = new Date().toISOString();
    });
    return e;
  }

  async recordTest(hypothesisId: string, testId: string, result: string, supported: boolean): Promise<void> {
    await this.store.mutate(s => {
      const h = s.hypotheses.find(x => x.id === hypothesisId);
      if (!h) return;
      h.testResults.push({ testId, result, supported });
      h.status = supported ? "confirmed" : "refuted";
      h.confidence = supported ? Math.min(1, h.confidence + 0.2) : Math.max(0, h.confidence - 0.3);
      h.updatedAt = new Date().toISOString();
    });
  }

  async reason(tenantId: string, question: string, candidateHypothesisIds: string[]): Promise<ReasoningChain> {
    return await this.store.mutate(s => {
      const candidates = s.hypotheses.filter(h => candidateHypothesisIds.includes(h.id) && h.tenantId === tenantId);
      if (!candidates.length) {
        const chain: ReasoningChain = { id: randomUUID(), tenantId, question, hypotheses: [], selectedHypothesisId: "", reasoning: "No candidates", conclusion: "Insufficient data", confidence: 0, alternativesConsidered: 0, createdAt: new Date().toISOString() };
        s.reasoningChains.push(chain);
        return chain;
      }
      let best = candidates[0]!;
      for (const h of candidates) { if (h.confidence > best.confidence) best = h; }
      const chain: ReasoningChain = { id: randomUUID(), tenantId, question, hypotheses: candidateHypothesisIds, selectedHypothesisId: best.id, reasoning: `Selected "${best.statement}" with confidence ${best.confidence.toFixed(2)} based on ${best.evidence.length} evidence items and ${best.testResults.length} tests.`, conclusion: best.statement, confidence: best.confidence, alternativesConsidered: candidates.length, createdAt: new Date().toISOString() };
      s.reasoningChains.push(chain);
      return chain;
    });
  }

  async getHypotheses(tenantId: string): Promise<Hypothesis[]> {
    const s = await this.store.read();
    return s.hypotheses.filter(h => h.tenantId === tenantId).sort((a, b) => b.confidence - a.confidence);
  }

  async getReasoningChains(tenantId: string, limit = 20): Promise<ReasoningChain[]> {
    const s = await this.store.read();
    return s.reasoningChains.filter(c => c.tenantId === tenantId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const th = s.hypotheses.filter(h => h.tenantId === tenantId);
    const confirmed = th.filter(h => h.status === "confirmed").length;
    const refuted = th.filter(h => h.status === "refuted").length;
    const superseded = th.filter(h => h.status === "superseded").length;
    const avgConfidence = th.length ? th.reduce((sum, h) => sum + h.confidence, 0) / th.length : 0;
    return {
      totalHypotheses: th.length,
      confirmed, refuted, superseded,
      testing: th.filter(h => h.status === "testing").length,
      proposed: th.filter(h => h.status === "proposed").length,
      pending: th.length - confirmed - refuted - superseded,
      avgConfidence,
      totalReasoningChains: s.reasoningChains.filter(c => c.tenantId === tenantId).length,
    };
  }

  // ═══ P1-30: Enhanced Lifecycle Methods ═══

  async startTesting(hypothesisId: string): Promise<void> {
    await this.store.mutate(s => {
      const h = s.hypotheses.find(x => x.id === hypothesisId);
      if (!h) return;
      if (h.status === "proposed") {
        h.status = "testing";
        h.updatedAt = new Date().toISOString();
      }
    });
  }

  async supersedeHypothesis(oldId: string, newId: string): Promise<void> {
    await this.store.mutate(s => {
      const old = s.hypotheses.find(x => x.id === oldId);
      const newH = s.hypotheses.find(x => x.id === newId);
      if (!old || !newH) return;
      old.status = "superseded";
      old.supersededBy = newId;
      old.updatedAt = new Date().toISOString();
      if (!newH.supersedes.includes(oldId)) {
        newH.supersedes.push(oldId);
      }
      newH.confidence = Math.min(1, newH.confidence + 0.1);
      newH.updatedAt = new Date().toISOString();
    });
  }

  /**
   * E1 / P1.9: link two hypotheses as competitors. The field existed on every
   * hypothesis since this service was written and nothing could ever populate
   * it — competing explanations were indistinguishable from unrelated ones.
   * One outcome should confirm one competitor and refute the other; marking
   * them is what makes that relationship durable and queryable.
   */
  async markCompeting(hypothesisIdA: string, hypothesisIdB: string): Promise<void> {
    if (hypothesisIdA === hypothesisIdB) throw new Error("A hypothesis cannot compete with itself.");
    await this.store.mutate(s => {
      const a = s.hypotheses.find(x => x.id === hypothesisIdA);
      const b = s.hypotheses.find(x => x.id === hypothesisIdB);
      if (!a || !b) throw new Error("Competing hypothesis not found.");
      if (!a.competingHypotheses.includes(b.id)) a.competingHypotheses.push(b.id);
      if (!b.competingHypotheses.includes(a.id)) b.competingHypotheses.push(a.id);
      a.updatedAt = new Date().toISOString();
      b.updatedAt = a.updatedAt;
    });
  }

  async getEvidenceGraph(tenantId: string): Promise<{
    nodes: Array<{ id: string; statement: string; status: HypothesisStatus; confidence: number; evidenceCount: number }>;
    edges: Array<{ from: string; to: string; type: "supersedes" | "competes" | "supports"; weight: number }>;
  }> {
    const s = await this.store.read();
    const th = s.hypotheses.filter(h => h.tenantId === tenantId);
    const nodes = th.map(h => ({
      id: h.id, statement: h.statement, status: h.status, confidence: h.confidence, evidenceCount: h.evidence.length,
    }));
    const edges: Array<{ from: string; to: string; type: "supersedes" | "competes" | "supports"; weight: number }> = [];
    for (const h of th) {
      for (const supId of h.supersedes) edges.push({ from: h.id, to: supId, type: "supersedes", weight: 1.0 });
      for (const compId of h.competingHypotheses) {
        if (th.some(x => x.id === compId)) edges.push({ from: h.id, to: compId, type: "competes", weight: 0.5 });
      }
    }
    return { nodes, edges };
  }

  async calibrateConfidence(hypothesisId: string): Promise<number> {
    return await this.store.mutate(s => {
      const h = s.hypotheses.find(x => x.id === hypothesisId);
      if (!h) return 0;
      let calibrated = h.confidence;
      const sup = h.evidence.filter(e => e.supportsHypothesis);
      const ref = h.evidence.filter(e => !e.supportsHypothesis);
      const ratio = sup.length / Math.max(1, sup.length + ref.length);
      calibrated = calibrated * 0.7 + ratio * 0.3;
      if (h.testResults.length > 0) {
        const testRate = h.testResults.filter(t => t.supported).length / h.testResults.length;
        calibrated = calibrated * 0.8 + testRate * 0.2;
      }
      const ageDays = (Date.now() - new Date(h.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > 30 && h.testResults.length === 0) calibrated *= 0.9;
      h.confidence = Math.max(0, Math.min(1, calibrated));
      h.updatedAt = new Date().toISOString();
      return h.confidence;
    });
  }

  // ═══ P2: Explainability ═══

  async why(tenantId: string, hypothesisId: string): Promise<{
    hypothesis: string; confidence: number; status: string;
    rationale: string[]; evidenceSummary: { supporting: number; refuting: number; neutral: number };
    calibrationScore: number; supersededBy: string | null;
  }> {
    const s = await this.store.read();
    const h = s.hypotheses.find((x) => x.tenantId === tenantId && x.id === hypothesisId);
    if (!h) throw new Error("Aurora hypothesis not found");
    const sup = h.evidence.filter(e => e.supportsHypothesis).length;
    const ref = h.evidence.filter(e => !e.supportsHypothesis).length;
    const strong = h.evidence.filter(e => e.strength === "strong").length;
    const rationale = [`Confidence: ${(h.confidence * 100).toFixed(1)}%`, `Evidence pieces: ${h.evidence.length}`];
    if (sup > ref) rationale.push("More supporting than refuting evidence");
    if (ref > sup) rationale.push("More refuting than supporting evidence — consider rejecting");
    if (strong === 0) rationale.push("WARNING: No strong evidence — hypothesis needs better support");
    return { hypothesis: h.statement, confidence: h.confidence, status: h.status, rationale, evidenceSummary: { supporting: sup, refuting: ref, neutral: 0 }, calibrationScore: h.confidence, supersededBy: h.supersededBy ?? null };
  }
}
