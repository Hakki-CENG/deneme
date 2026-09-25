import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { auroraRound, DurableJsonState } from "../util/aurora-state.js";

interface FusionEmbedding { id: string; memoryId: string; tenantId: string; layer: string; contentDigest: string; embedding: number[]; keywords: string[]; patterns: string[]; accessCount: number; lastAccessedAt: string; createdAt: string; }
interface MemoryPattern { id: string; tenantId: string; pattern: string; description: string; occurrences: number; memoryIds: string[]; confidence: number; discoveredAt: string; lastSeenAt: string; }
interface SimilarMemory { memoryId: string; similarity: number; layer: string; title: string; patterns: string[]; }

interface FusionStateShape { schemaVersion: number; embeddings: FusionEmbedding[]; patterns: MemoryPattern[]; }

export class NeuralMemoryFusionService {
  private store: DurableJsonState<FusionStateShape>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<FusionStateShape>(join(baseDir, "neural-memory-fusion.json"), () => ({ schemaVersion: 1, embeddings: [], patterns: [] }), (v) => { const s = v as FusionStateShape; return !!s && s.schemaVersion === 1; }, "Aurora neural memory fusion");
  }
  async init(): Promise<void> { await this.store.read(); }

  async embed(memoryId: string, tenantId: string, layer: string, content: string, title: string): Promise<FusionEmbedding> {
    const keywords = this.extractKeywords(content + " " + title);
    const embedding = this.generateDenseVector(content);
    const patterns = this.extractPatterns(content);
    return await this.store.mutate(s => {
      const existing = s.embeddings.find(e => e.memoryId === memoryId);
      if (existing) { existing.embedding = embedding; existing.keywords = keywords; existing.patterns = patterns; existing.contentDigest = this.digest(content); return existing; }
      const e: FusionEmbedding = { id: randomUUID(), memoryId, tenantId, layer, contentDigest: this.digest(content), embedding, keywords, patterns, accessCount: 0, lastAccessedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
      s.embeddings.push(e);
      return e;
    });
  }

  async findSimilar(tenantId: string, query: string, limit: number = 10, layerFilter?: string): Promise<SimilarMemory[]> {
    const s = await this.store.read();
    const qEmb = this.generateDenseVector(query);
    const qKw = this.extractKeywords(query);
    const candidates = s.embeddings.filter(e => e.tenantId === tenantId && (!layerFilter || e.layer === layerFilter));
    const scored = candidates.map(c => {
      const embSim = this.cosineSimilarity(qEmb, c.embedding);
      const kwSim = this.jaccardSimilarity(qKw, c.keywords);
      const combined = embSim * 0.6 + kwSim * 0.4;
      return { memoryId: c.memoryId, similarity: auroraRound(combined), layer: c.layer, title: c.keywords.slice(0, 5).join(", "), patterns: c.patterns };
    }).sort((a, b) => b.similarity - a.similarity).slice(0, limit);
    await this.store.mutate(st => { for (const s2 of scored) { const emb = st.embeddings.find(e => e.memoryId === s2.memoryId); if (emb) { emb.accessCount++; emb.lastAccessedAt = new Date().toISOString(); } } });
    return scored;
  }

  async discoverPatterns(tenantId: string): Promise<MemoryPattern[]> {
    return await this.store.mutate(s => {
      const embeddings = s.embeddings.filter(e => e.tenantId === tenantId);
      const pCounts = new Map<string, { count: number; memIds: string[] }>();
      for (const e of embeddings) for (const p of e.patterns) { const d = pCounts.get(p) ?? { count: 0, memIds: [] }; d.count++; d.memIds.push(e.memoryId); pCounts.set(p, d); }
      const discovered: MemoryPattern[] = [];
      for (const [pattern, data] of pCounts) {
        if (data.count < 3) continue;
        const existing = s.patterns.find(p => p.tenantId === tenantId && p.pattern === pattern);
        if (existing) { existing.occurrences = data.count; existing.memoryIds = data.memIds; existing.confidence = auroraRound(Math.min(1, data.count / 20)); existing.lastSeenAt = new Date().toISOString(); }
        else { const np: MemoryPattern = { id: randomUUID(), tenantId, pattern, description: `Pattern found in ${data.count} memories`, occurrences: data.count, memoryIds: data.memIds, confidence: auroraRound(Math.min(1, data.count / 20)), discoveredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }; s.patterns.push(np); discovered.push(np); }
      }
      return discovered;
    });
  }

  async consolidate(tenantId: string): Promise<{ compressedCount: number; patternsDiscovered: number; contradictionsFound: number; duplicatesRemoved: number; newInsights: string[] }> {
    return await this.store.mutate(s => {
      const embeddings = s.embeddings.filter(e => e.tenantId === tenantId);
      let dupRemoved = 0;
      const seen = new Map<string, FusionEmbedding[]>();
      for (const e of embeddings) { const arr = seen.get(e.contentDigest) ?? []; arr.push(e); seen.set(e.contentDigest, arr); }
      for (const [, group] of seen) { if (group.length > 1) { dupRemoved += group.length - 1; for (const d of group.slice(1)) { const idx = s.embeddings.indexOf(d); if (idx >= 0) s.embeddings.splice(idx, 1); } } }
      const newInsights: string[] = [];
      return { compressedCount: 0, patternsDiscovered: 0, contradictionsFound: 0, duplicatesRemoved: dupRemoved, newInsights };
    });
  }

  async getPatterns(tenantId: string): Promise<MemoryPattern[]> { const s = await this.store.read(); return s.patterns.filter(p => p.tenantId === tenantId).sort((a, b) => b.occurrences - a.occurrences); }
  async getStats(tenantId: string) { const s = await this.store.read(); const emb = s.embeddings.filter(e => e.tenantId === tenantId); const byLayer: Record<string, number> = {}; for (const e of emb) byLayer[e.layer] = (byLayer[e.layer] ?? 0) + 1; return { totalEmbeddings: emb.length, totalPatterns: s.patterns.filter(p => p.tenantId === tenantId).length, byLayer }; }

  private extractKeywords(text: string): string[] { return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2).reduce<string[]>((a, w) => a.includes(w) ? a : [...a, w], []).slice(0, 50); }
  private generateDenseVector(text: string): number[] { const dim = 64; const vec = new Array(dim).fill(0); const kw = this.extractKeywords(text); for (let i = 0; i < kw.length; i++) { const h = this.hash(kw[i]!); for (let j = 0; j < dim; j++) vec[j] += Math.sin(h * (j + 1)) * 0.1; } const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1; return vec.map(v => v / norm); }
  private extractPatterns(text: string): string[] { const lower = text.toLowerCase(); return ["failed", "error", "success", "approach", "method", "solution", "problem", "pattern", "retry", "optimize", "refactor", "migrate", "deploy", "test", "debug"].filter(t => lower.includes(t)); }
  private cosineSimilarity(a: number[], b: number[]): number { let dot = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0; }
  private jaccardSimilarity(a: string[], b: string[]): number { const sA = new Set(a), sB = new Set(b); const inter = [...sA].filter(x => sB.has(x)).length; const union = new Set([...a, ...b]).size; return union > 0 ? inter / union : 0; }
  private hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h); }
  private digest(text: string): string { return this.hash(text).toString(36); }

  // ═══ P3: Explainability ═══

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

