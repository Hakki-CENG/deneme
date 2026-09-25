import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type TrustLevel = "untrusted" | "new" | "established" | "trusted" | "verified";

interface ReputationEntry { id: string; tenantId: string; agentId: string; score: number; trustLevel: TrustLevel; interactions: number; successRate: number; reliability: number; helpfulness: number; expertise: Record<string, number>; endorsements: { fromAgentId: string; domain: string; weight: number; timestamp: string; }[]; incidents: { description: string; severity: number; timestamp: string; }[]; lastUpdated: string; }

interface ReputationState { schemaVersion: number; entries: ReputationEntry[]; }

export class ReputationService {
  private store: DurableJsonState<ReputationState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<ReputationState>(
      join(baseDir, "reputation-system.json"),
      () => ({ schemaVersion: 1, entries: [] }),
      (v) => { const s = v as ReputationState; return !!s && s.schemaVersion === 1; },
      "Aurora reputation system",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  /**
   * S7: list a tenant's reputation entries. The service existed but nothing
   * recorded into it and nothing could read it back — an unwired gauge.
   */
  async entries(tenantId: string): Promise<ReputationEntry[]> {
    const state = await this.store.read();
    return state.entries.filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item));
  }

  async getOrCreate(tenantId: string, agentId: string): Promise<ReputationEntry> {
    return await this.store.mutate(s => {
      let e = s.entries.find(x => x.agentId === agentId && x.tenantId === tenantId);
      if (e) return e;
      e = { id: randomUUID(), tenantId, agentId, score: 0.5, trustLevel: "new", interactions: 0, successRate: 0, reliability: 0.5, helpfulness: 0.5, expertise: {}, endorsements: [], incidents: [], lastUpdated: new Date().toISOString() };
      s.entries.push(e);
      return e;
    });
  }

  async recordInteraction(tenantId: string, agentId: string, success: boolean, domain: string, helpful: boolean): Promise<void> {
    await this.store.mutate(s => {
      let e = s.entries.find(x => x.agentId === agentId && x.tenantId === tenantId);
      if (!e) { e = { id: randomUUID(), tenantId, agentId, score: 0.5, trustLevel: "new", interactions: 0, successRate: 0, reliability: 0.5, helpfulness: 0.5, expertise: {}, endorsements: [], incidents: [], lastUpdated: new Date().toISOString() }; s.entries.push(e); }
      e.interactions++;
      const prevSuccesses = e.successRate * (e.interactions - 1);
      e.successRate = (prevSuccesses + (success ? 1 : 0)) / e.interactions;
      e.helpfulness = (e.helpfulness * 0.9) + (helpful ? 0.1 : 0);
      e.reliability = Math.min(1, e.reliability + (success ? 0.02 : -0.05));
      e.expertise[domain] = (e.expertise[domain] ?? 0) + 1;
      e.score = e.successRate * 0.4 + e.reliability * 0.3 + e.helpfulness * 0.3;
      e.trustLevel = e.score > 0.9 ? "verified" : e.score > 0.75 ? "trusted" : e.score > 0.5 ? "established" : e.score > 0.25 ? "new" : "untrusted";
      e.lastUpdated = new Date().toISOString();
    });
  }

  async endorse(fromAgentId: string, tenantId: string, targetAgentId: string, domain: string, weight: number): Promise<void> {
    await this.store.mutate(s => {
      const e = s.entries.find(x => x.agentId === targetAgentId && x.tenantId === tenantId);
      if (!e) return;
      e.endorsements.push({ fromAgentId, domain, weight: Math.min(1, Math.max(0, weight)), timestamp: new Date().toISOString() });
      const endorsementBoost = e.endorsements.reduce((sum, en) => sum + en.weight, 0) * 0.02;
      e.score = Math.min(1, e.score + endorsementBoost);
      e.lastUpdated = new Date().toISOString();
    });
  }

  async recordIncident(tenantId: string, agentId: string, description: string, severity: number): Promise<void> {
    await this.store.mutate(s => {
      const e = s.entries.find(x => x.agentId === agentId && x.tenantId === tenantId);
      if (!e) return;
      e.incidents.push({ description, severity: Math.min(1, Math.max(0, severity)), timestamp: new Date().toISOString() });
      e.score = Math.max(0, e.score - severity * 0.1);
      e.reliability = Math.max(0, e.reliability - severity * 0.05);
      e.lastUpdated = new Date().toISOString();
    });
  }

  async getEntries(tenantId: string): Promise<ReputationEntry[]> {
    const s = await this.store.read();
    return s.entries.filter(e => e.tenantId === tenantId).sort((a, b) => b.score - a.score);
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const te = s.entries.filter(e => e.tenantId === tenantId);
    const trustDist: Record<string, number> = {};
    for (const e of te) trustDist[e.trustLevel] = (trustDist[e.trustLevel] ?? 0) + 1;
    return { totalAgents: te.length, avgScore: te.length ? te.reduce((sum, e) => sum + e.score, 0) / te.length : 0, avgInteractions: te.length ? te.reduce((sum, e) => sum + e.interactions, 0) / te.length : 0, totalEndorsements: te.reduce((sum, e) => sum + e.endorsements.length, 0), totalIncidents: te.reduce((sum, e) => sum + e.incidents.length, 0), trustDistribution: trustDist };
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
