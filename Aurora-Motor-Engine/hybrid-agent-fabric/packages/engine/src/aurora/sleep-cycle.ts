import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

interface SleepCycleResult { id: string; tenantId: string; kind: "light" | "deep" | "rem"; startedAt: string; endedAt: string; durationMs: number; memoriesConsolidated: number; patternsDiscovered: number; duplicatesRemoved: number; contradictionsResolved: number | null; skillsExtracted: number | null; hypothesesGenerated: number; insights: string[]; nextCycleRecommendation: string; }
interface SleepSchedule { tenantId: string; lightCycleMinutes: number; deepCycleMinutes: number; remCycleMinutes: number; lastLightAt: string; lastDeepAt: string; lastRemAt: string; enabled: boolean; }

interface SleepStateShape { schemaVersion: number; cycles: SleepCycleResult[]; schedules: SleepSchedule[]; }

export class SleepCycleService {
  private store: DurableJsonState<SleepStateShape>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<SleepStateShape>(join(baseDir, "sleep-cycle.json"), () => ({ schemaVersion: 1, cycles: [], schedules: [] }), (v) => { const s = v as SleepStateShape; return !!s && s.schemaVersion === 1; }, "Aurora sleep cycle");
  }
  async init(): Promise<void> { await this.store.read(); }

  async setSchedule(tenantId: string, patch: Partial<SleepSchedule>): Promise<SleepSchedule> {
    return await this.store.mutate(s => {
      let sched = s.schedules.find(x => x.tenantId === tenantId);
      if (!sched) { sched = { tenantId, lightCycleMinutes: 30, deepCycleMinutes: 240, remCycleMinutes: 1440, lastLightAt: "", lastDeepAt: "", lastRemAt: "", enabled: true }; s.schedules.push(sched); }
      Object.assign(sched, patch);
      return sched;
    });
  }

  async runCycle(tenantId: string, kind: SleepCycleResult["kind"], deps: {
    consolidateMemory: () => Promise<{ compressed: number; duplicates: number }>;
    discoverPatterns: () => Promise<number>;
    /**
     * Omit when contradiction resolution is not wired.
     *
     * A supplied function returning 0 means "looked, found none". Omitting it
     * reports `null` — "not attempted". Collapsing both into 0 let the cycle
     * advertise work it never did.
     */
    resolveContradictions?: (() => Promise<number>) | undefined;
    /** Omit when no trajectory source is wired. See `resolveContradictions`. */
    extractSkills?: (() => Promise<number>) | undefined;
    generateHypotheses: () => Promise<string[]>;
  }): Promise<SleepCycleResult> {
    const startedAt = new Date().toISOString();
    const insights: string[] = [];
    const memResult = await deps.consolidateMemory();
    if (memResult.compressed > 0) insights.push(`Consolidated ${memResult.compressed} memories`);
    if (memResult.duplicates > 0) insights.push(`Removed ${memResult.duplicates} duplicates`);
    const patterns = await deps.discoverPatterns();
    if (patterns > 0) insights.push(`Discovered ${patterns} new patterns`);
    const contradictions = deps.resolveContradictions ? await deps.resolveContradictions() : null;
    if (contradictions !== null && contradictions > 0) {
      insights.push(`Resolved ${contradictions} contradictions`);
    }
    const skillsAttempted = (kind === "deep" || kind === "rem") && deps.extractSkills !== undefined;
    const skills = skillsAttempted ? await deps.extractSkills!() : null;
    if (skills !== null && skills > 0) insights.push(`Extracted ${skills} skill candidates`);
    // Name the gap rather than letting a silent 0 read as a clean result.
    if (skills === null && (kind === "deep" || kind === "rem")) {
      insights.push("Skill extraction not attempted: no trajectory source is wired");
    }
    const hypotheses = kind === "rem" ? await deps.generateHypotheses() : [];
    if (hypotheses.length > 0) insights.push(`Generated ${hypotheses.length} hypotheses`);
    const endedAt = new Date().toISOString();
    const result: SleepCycleResult = { id: randomUUID(), tenantId, kind, startedAt, endedAt, durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(), memoriesConsolidated: memResult.compressed, patternsDiscovered: patterns, duplicatesRemoved: memResult.duplicates, contradictionsResolved: contradictions, skillsExtracted: skills, hypothesesGenerated: hypotheses.length, insights, nextCycleRecommendation: kind === "light" ? "Next light in 30m" : kind === "deep" ? "Next deep in 4h" : "Next REM in 24h" };
    await this.store.mutate(s => {
      s.cycles.push(result); if (s.cycles.length > 5000) s.cycles.splice(0, s.cycles.length - 5000);
      const sched = s.schedules.find(x => x.tenantId === tenantId);
      if (sched) { if (kind === "light") sched.lastLightAt = endedAt; if (kind === "deep") sched.lastDeepAt = endedAt; if (kind === "rem") sched.lastRemAt = endedAt; }
    });
    return result;
  }

  getNextCycleNeeded(tenantId: string): SleepCycleResult["kind"] | null {
    return null; // sync read-only; callers use store.read()
  }

  async getCycles(tenantId: string, limit: number = 20): Promise<SleepCycleResult[]> {
    const s = await this.store.read();
    return s.cycles.filter(c => c.tenantId === tenantId).slice(-limit).reverse();
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const items = (s as any).cycles?.filter((x: any) => x.tenantId === tenantId) ?? [];
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
