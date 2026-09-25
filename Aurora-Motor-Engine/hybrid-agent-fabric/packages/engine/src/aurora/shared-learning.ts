import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type LearningType = "pattern" | "technique" | "optimization" | "avoidance" | "integration";
type Quality = "unvalidated" | "promising" | "validated" | "canonical";

interface SharedLesson { id: string; tenantId: string; fromAgentId: string; domain: string; type: LearningType; title: string; description: string; context: string; quality: Quality; usageCount: number; successWhenApplied: number; failureWhenApplied: number; applicabilityScore: number; tags: string[]; createdAt: string; }
interface AdoptionRecord { lessonId: string; agentId: string; result: "success" | "failure" | "neutral"; context: string; timestamp: string; }

interface SharedLearningState { schemaVersion: number; lessons: SharedLesson[]; adoptions: AdoptionRecord[]; }

export class SharedLearningService {
  private store: DurableJsonState<SharedLearningState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<SharedLearningState>(
      join(baseDir, "shared-learning.json"),
      () => ({ schemaVersion: 1, lessons: [], adoptions: [] }),
      (v) => { const s = v as SharedLearningState; return !!s && s.schemaVersion === 1; },
      "Aurora shared learning",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async shareLesson(tenantId: string, fromAgentId: string, domain: string, type: LearningType, title: string, description: string, context: string, tags: string[] = []): Promise<SharedLesson> {
    const lesson: SharedLesson = { id: randomUUID(), tenantId, fromAgentId, domain, type, title, description, context, quality: "unvalidated", usageCount: 0, successWhenApplied: 0, failureWhenApplied: 0, applicabilityScore: 0.5, tags, createdAt: new Date().toISOString() };
    await this.store.mutate(s => { s.lessons.push(lesson); });
    return lesson;
  }

  async adoptLesson(lessonId: string, agentId: string, result: "success" | "failure" | "neutral", context: string): Promise<void> {
    await this.store.mutate(s => {
      const lesson = s.lessons.find(l => l.id === lessonId);
      if (!lesson) return;
      lesson.usageCount++;
      if (result === "success") lesson.successWhenApplied++;
      if (result === "failure") lesson.failureWhenApplied++;
      const successRate = lesson.usageCount > 0 ? lesson.successWhenApplied / lesson.usageCount : 0;
      lesson.quality = successRate > 0.8 && lesson.usageCount > 3 ? "canonical" : successRate > 0.6 && lesson.usageCount > 1 ? "validated" : lesson.usageCount > 0 ? "promising" : "unvalidated";
      lesson.applicabilityScore = successRate * 0.7 + (lesson.usageCount > 5 ? 0.3 : lesson.usageCount * 0.06);
      s.adoptions.push({ lessonId, agentId, result, context, timestamp: new Date().toISOString() });
    });
  }

  async searchLessons(tenantId: string, query: string, domain?: string, type?: LearningType): Promise<SharedLesson[]> {
    const s = await this.store.read();
    const q = query.toLowerCase();
    return s.lessons.filter(l => l.tenantId === tenantId && (!domain || l.domain === domain) && (!type || l.type === type) && (l.title.toLowerCase().includes(q) || l.description.toLowerCase().includes(q) || l.tags.some(t => t.toLowerCase().includes(q)))).sort((a, b) => b.applicabilityScore - a.applicabilityScore).slice(0, 20);
  }

  async getLessons(tenantId: string, limit = 30): Promise<SharedLesson[]> {
    const s = await this.store.read();
    return s.lessons.filter(l => l.tenantId === tenantId).sort((a, b) => b.applicabilityScore - a.applicabilityScore).slice(0, limit);
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const tl = s.lessons.filter(l => l.tenantId === tenantId);
    const qualityDist: Record<string, number> = {};
    for (const l of tl) qualityDist[l.quality] = (qualityDist[l.quality] ?? 0) + 1;
    const typeDist: Record<string, number> = {};
    for (const l of tl) typeDist[l.type] = (typeDist[l.type] ?? 0) + 1;
    return { totalLessons: tl.length, totalAdoptions: s.adoptions.filter(a => tl.some(l => l.id === a.lessonId)).length, avgApplicability: tl.length ? tl.reduce((sum, l) => sum + l.applicabilityScore, 0) / tl.length : 0, qualityDistribution: qualityDist, typeDistribution: typeDist };
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
