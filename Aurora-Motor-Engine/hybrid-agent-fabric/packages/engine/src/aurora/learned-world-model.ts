import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type WorldEntity = "user" | "system" | "environment" | "tool" | "concept";
type RelationType = "uses" | "depends_on" | "conflicts_with" | "enhances" | "replaces" | "part_of" | "related_to";

interface Entity { id: string; name: string; type: WorldEntity; properties: Record<string, string>; confidence: number; observationCount: number; lastObservedAt: string; }
interface Relation { id: string; fromId: string; toId: string; type: RelationType; strength: number; evidenceCount: number; discoveredAt: string; }
interface WorldRule { id: string; condition: string; consequence: string; confidence: number; examples: string[]; }
interface LearningEvent { id: string; tenantId: string; description: string; entitiesAffected: string[]; relationsAffected: string[]; timestamp: string; }

interface WorldModelState { schemaVersion: number; entities: Entity[]; relations: Relation[]; rules: WorldRule[]; learningEvents: LearningEvent[]; }

export class LearnedWorldModelService {
  private store: DurableJsonState<WorldModelState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<WorldModelState>(
      join(baseDir, "learned-world-model.json"),
      () => ({ schemaVersion: 1, entities: [], relations: [], rules: [], learningEvents: [] }),
      (v) => { const s = v as WorldModelState; return !!s && s.schemaVersion === 1; },
      "Aurora learned world model",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async observeEntity(name: string, type: WorldEntity, properties: Record<string, string> = {}): Promise<Entity> {
    return await this.store.mutate(s => {
      const existing = s.entities.find(e => e.name === name && e.type === type);
      if (existing) { existing.observationCount++; existing.confidence = Math.min(1, existing.confidence + 0.05); Object.assign(existing.properties, properties); existing.lastObservedAt = new Date().toISOString(); return existing; }
      const e: Entity = { id: randomUUID(), name, type, properties, confidence: 0.3, observationCount: 1, lastObservedAt: new Date().toISOString() };
      s.entities.push(e);
      return e;
    });
  }

  async addRelation(fromId: string, toId: string, type: RelationType, strength: number): Promise<Relation> {
    return await this.store.mutate(s => {
      const existing = s.relations.find(r => r.fromId === fromId && r.toId === toId && r.type === type);
      if (existing) { existing.evidenceCount++; existing.strength = Math.min(1, (existing.strength * (existing.evidenceCount - 1) + strength) / existing.evidenceCount); return existing; }
      const r: Relation = { id: randomUUID(), fromId, toId, type, strength, evidenceCount: 1, discoveredAt: new Date().toISOString() };
      s.relations.push(r);
      return r;
    });
  }

  async addRule(condition: string, consequence: string, example: string): Promise<WorldRule> {
    return await this.store.mutate(s => {
      const existing = s.rules.find(r => r.condition === condition && r.consequence === consequence);
      if (existing) { existing.confidence = Math.min(1, existing.confidence + 0.05); if (!existing.examples.includes(example)) existing.examples.push(example); return existing; }
      const r: WorldRule = { id: randomUUID(), condition, consequence, confidence: 0.3, examples: [example] };
      s.rules.push(r);
      return r;
    });
  }

  async recordLearningEvent(tenantId: string, description: string, entityIds: string[], relationIds: string[]): Promise<LearningEvent> {
    const ev: LearningEvent = { id: randomUUID(), tenantId, description, entitiesAffected: entityIds, relationsAffected: relationIds, timestamp: new Date().toISOString() };
    await this.store.mutate(s => { s.learningEvents.push(ev); });
    return ev;
  }

  async queryEntities(type?: WorldEntity, nameContains?: string): Promise<Entity[]> {
    const s = await this.store.read();
    return s.entities.filter(e => (!type || e.type === type) && (!nameContains || e.name.toLowerCase().includes(nameContains.toLowerCase()))).sort((a, b) => b.confidence - a.confidence);
  }

  async queryRelations(entityId?: string, type?: RelationType): Promise<Relation[]> {
    const s = await this.store.read();
    return s.relations.filter(r => (!entityId || r.fromId === entityId || r.toId === entityId) && (!type || r.type === type));
  }

  async getRelevantRules(context: string): Promise<WorldRule[]> {
    const s = await this.store.read();
    const ctx = context.toLowerCase();
    return s.rules.filter(r => ctx.includes(r.condition.toLowerCase()) || r.examples.some(e => ctx.includes(e.toLowerCase()))).sort((a, b) => b.confidence - a.confidence);
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const entityTypeDist: Record<string, number> = {};
    for (const e of s.entities) entityTypeDist[e.type] = (entityTypeDist[e.type] ?? 0) + 1;
    const relTypeDist: Record<string, number> = {};
    for (const r of s.relations) relTypeDist[r.type] = (relTypeDist[r.type] ?? 0) + 1;
    return { totalEntities: s.entities.length, totalRelations: s.relations.length, totalRules: s.rules.length, avgEntityConfidence: s.entities.length ? s.entities.reduce((sum, e) => sum + e.confidence, 0) / s.entities.length : 0, entityTypes: entityTypeDist, relationTypes: relTypeDist, learningEvents: s.learningEvents.filter(e => e.tenantId === tenantId).length };
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

