import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

interface CausalNode { id: string; name: string; type: "event" | "state" | "action" | "outcome"; description: string; }
interface CausalEdge { id: string; fromId: string; toId: string; strength: number; confidence: number; type: "causes" | "enables" | "prevents" | "correlates" | "inhibits"; evidenceCount: number; }
interface CausalPath { nodes: string[]; edges: string[]; totalStrength: number; description: string; }

interface CausalState { schemaVersion: number; nodes: CausalNode[]; edges: CausalEdge[]; }

export class CausalGraphService {
  private store: DurableJsonState<CausalState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<CausalState>(
      join(baseDir, "causal-graph.json"),
      () => ({ schemaVersion: 1, nodes: [], edges: [] }),
      (v) => { const s = v as CausalState; return !!s && s.schemaVersion === 1; },
      "Aurora causal graph",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async addNode(name: string, type: CausalNode["type"], description: string): Promise<CausalNode> {
    const n: CausalNode = { id: randomUUID(), name, type, description };
    await this.store.mutate(s => { s.nodes.push(n); });
    return n;
  }

  async addEdge(fromId: string, toId: string, type: CausalEdge["type"], strength: number, confidence: number): Promise<CausalEdge> {
    return await this.store.mutate(s => {
      const existing = s.edges.find(e => e.fromId === fromId && e.toId === toId);
      if (existing) { existing.strength = Math.min(1, (existing.strength * existing.evidenceCount + strength) / (existing.evidenceCount + 1)); existing.evidenceCount++; existing.confidence = Math.max(existing.confidence, confidence); return existing; }
      const e: CausalEdge = { id: randomUUID(), fromId, toId, strength: Math.min(1, strength), confidence, type, evidenceCount: 1 };
      s.edges.push(e);
      return e;
    });
  }

  async findPaths(fromId: string, toId: string, maxDepth: number = 5): Promise<CausalPath[]> {
    const s = await this.store.read();
    const paths: CausalPath[] = [];
    const visited = new Set<string>();
    const dfs = (current: string, path: string[], edgePath: string[], depth: number) => {
      if (depth > maxDepth) return;
      if (current === toId) { paths.push({ nodes: [...path], edges: [...edgePath], totalStrength: edgePath.reduce((sum, eId) => { const edge = s.edges.find(e => e.id === eId); return sum + (edge?.strength ?? 0); }, 0) / (edgePath.length || 1), description: path.map(id => s.nodes.find(n => n.id === id)?.name ?? id).join(" → ") }); return; }
      if (visited.has(current)) return;
      visited.add(current);
      for (const edge of s.edges.filter(e => e.fromId === current)) { dfs(edge.toId, [...path, edge.toId], [...edgePath, edge.id], depth + 1); }
      visited.delete(current);
    };
    dfs(fromId, [fromId], [], 0);
    return paths.sort((a, b) => b.totalStrength - a.totalStrength);
  }

  async getRootCauses(nodeId: string): Promise<CausalNode[]> {
    const s = await this.store.read();
    const incoming = s.edges.filter(e => e.toId === nodeId);
    const roots: CausalNode[] = [];
    for (const edge of incoming) {
      const hasIncoming = s.edges.some(e => e.toId === edge.fromId);
      if (!hasIncoming) { const n = s.nodes.find(x => x.id === edge.fromId); if (n) roots.push(n); }
    }
    return roots;
  }

  async getDownstreamEffects(nodeId: string): Promise<{ node: CausalNode; edge: CausalEdge }[]> {
    const s = await this.store.read();
    return s.edges.filter(e => e.fromId === nodeId).map(e => ({ node: s.nodes.find(n => n.id === e.toId)!, edge: e })).filter(x => x.node);
  }

  // ═══ P2: Causal Impact Analysis ═══

  async analyzeImpact(nodeId: string): Promise<{
node: CausalNode | null;
    rootCauses: CausalNode[];
    downstreamEffects: Array<{ node: CausalNode; edge: CausalEdge }>;
    impactScore: number;
    riskLevel: "low" | "medium" | "high" | "critical";
    recommendations: string[];
    }> {
    const s = await this.store.read();
    const node = s.nodes.find(n => n.id === nodeId) ?? null;
    if (!node) return { node: null, rootCauses: [], downstreamEffects: [], impactScore: 0, riskLevel: "low", recommendations: ["Node not found"] };

    const rootCauses = await this.getRootCauses(nodeId);
    const downstream = await this.getDownstreamEffects(nodeId);
    
    // Calculate impact score based on downstream effects
    const impactScore = Math.min(1, downstream.length * 0.1 + rootCauses.length * 0.05);
    const riskLevel = impactScore > 0.7 ? "critical" : impactScore > 0.5 ? "high" : impactScore > 0.3 ? "medium" : "low";
    
    const recommendations: string[] = [];
    if (rootCauses.length > 3) recommendations.push("Multiple root causes detected — investigate systemic issues");
    if (downstream.length > 5) recommendations.push("High downstream impact — changes here affect many nodes");
    if (riskLevel === "critical") recommendations.push("CRITICAL: This node has cascading effects — proceed with caution");
    
    return { node, rootCauses, downstreamEffects: downstream, impactScore, riskLevel, recommendations };
  }

  async getStats() {
    const s = await this.store.read();
    const typeDist: Record<string, number> = {};
    for (const n of s.nodes) typeDist[n.type] = (typeDist[n.type] ?? 0) + 1;
    const edgeTypeDist: Record<string, number> = {};
    for (const e of s.edges) edgeTypeDist[e.type] = (edgeTypeDist[e.type] ?? 0) + 1;
    return { totalNodes: s.nodes.length, totalEdges: s.edges.length, nodeTypes: typeDist, edgeTypes: edgeTypeDist, avgConfidence: s.edges.length ? s.edges.reduce((sum, e) => sum + e.confidence, 0) / s.edges.length : 0 };
  }

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

