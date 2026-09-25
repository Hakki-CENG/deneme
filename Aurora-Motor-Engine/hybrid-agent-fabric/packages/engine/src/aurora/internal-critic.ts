import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type CriticDomain = "logic" | "evidence" | "bias" | "completeness" | "feasibility" | "ethics" | "consistency" | "clarity";
type Severity = "info" | "warning" | "critical" | "fatal";

interface Critique { id: string; domain: CriticDomain; severity: Severity; description: string; suggestion: string; autoResolvable: boolean; resolved: boolean; resolvedBy: string; }
interface Review { id: string; tenantId: string; targetId: string; targetType: string; summary: string; critiques: Critique[]; overallScore: number; recommendation: "approve" | "revise" | "reject"; createdAt: string; }
interface CriticProfile { domain: CriticDomain; reviewsCount: number; avgFindings: number; avgScore: number; effectiveness: number; }

interface CriticState { schemaVersion: number; reviews: Review[]; profiles: CriticProfile[]; }

export class InternalCriticService {
  private store: DurableJsonState<CriticState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<CriticState>(
      join(baseDir, "internal-critic.json"),
      () => ({ schemaVersion: 1, reviews: [], profiles: [] }),
      (v) => { const s = v as CriticState; return !!s && s.schemaVersion === 1; },
      "Aurora internal critic",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async review(tenantId: string, targetId: string, targetType: string, content: string, context?: string): Promise<Review> {
    const critiques: Critique[] = [];
    const text = (content + " " + (context ?? "")).toLowerCase();
    // Logic check
    if (text.includes("always") || text.includes("never") || text.includes("her zaman") || text.includes("asla")) critiques.push({ id: randomUUID(), domain: "logic", severity: "warning", description: "Absolute claim detected — may be over-generalization", suggestion: "Qualify the claim with conditions or scope", autoResolvable: false, resolved: false, resolvedBy: "" });
    if (text.includes("because") && !text.includes("evidence") && !text.includes("kanıt")) critiques.push({ id: randomUUID(), domain: "evidence", severity: "warning", description: "Causal claim without cited evidence", suggestion: "Add supporting evidence or mark as hypothesis", autoResolvable: false, resolved: false, resolvedBy: "" });
    // Completeness
    if (content.length < 50) critiques.push({ id: randomUUID(), domain: "completeness", severity: "info", description: "Very brief content — may lack detail", suggestion: "Expand with specifics, examples, or edge cases", autoResolvable: false, resolved: false, resolvedBy: "" });
    // Consistency
    const contradictions = ["but", "however", "although", "fakat", "ancak"];
    if (contradictions.some(c => text.includes(c)) && text.includes("definitely")) critiques.push({ id: randomUUID(), domain: "consistency", severity: "warning", description: "Contains both hedging and certainty language", suggestion: "Resolve the apparent contradiction", autoResolvable: false, resolved: false, resolvedBy: "" });
    // Feasibility
    if (text.includes("impossible") || text.includes("imkansız")) critiques.push({ id: randomUUID(), domain: "feasibility", severity: "info", description: "Contains impossibility claim — verify", suggestion: "Consider if this is truly impossible or just difficult", autoResolvable: false, resolved: false, resolvedBy: "" });
    // Scoring
    const criticalCount = critiques.filter(c => c.severity === "critical" || c.severity === "fatal").length;
    const warningCount = critiques.filter(c => c.severity === "warning").length;
    const score = Math.max(0, 1 - criticalCount * 0.3 - warningCount * 0.1);
    const recommendation: Review["recommendation"] = criticalCount > 0 ? "reject" : warningCount > 2 ? "revise" : "approve";
    const review: Review = { id: randomUUID(), tenantId, targetId, targetType, summary: `Reviewed ${targetType} — ${critiques.length} finding(s)`, critiques, overallScore: score, recommendation, createdAt: new Date().toISOString() };
    await this.store.mutate(s => { s.reviews.push(review); });
    return review;
  }

  async resolveCritique(reviewId: string, critiqueId: string, resolvedBy: string): Promise<void> {
    await this.store.mutate(s => {
      const review = s.reviews.find(r => r.id === reviewId);
      if (!review) return;
      const critique = review.critiques.find(c => c.id === critiqueId);
      if (critique) { critique.resolved = true; critique.resolvedBy = resolvedBy; }
    });
  }

  async getReviews(tenantId: string, limit = 30): Promise<Review[]> {
    const s = await this.store.read();
    return s.reviews.filter(r => r.tenantId === tenantId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const tr = s.reviews.filter(r => r.tenantId === tenantId);
    const approved = tr.filter(r => r.recommendation === "approve").length;
    const rejected = tr.filter(r => r.recommendation === "reject").length;
    const avgScore = tr.length ? tr.reduce((sum, r) => sum + r.overallScore, 0) / tr.length : 0;
    const totalCritiques = tr.reduce((sum, r) => sum + r.critiques.length, 0);
    const byDomain: Record<string, number> = {};
    for (const r of tr) for (const c of r.critiques) byDomain[c.domain] = (byDomain[c.domain] ?? 0) + 1;
    return { totalReviews: tr.length, approved, revised: tr.length - approved - rejected, rejected, avgScore, totalCritiques, critiquesByDomain: byDomain };
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
