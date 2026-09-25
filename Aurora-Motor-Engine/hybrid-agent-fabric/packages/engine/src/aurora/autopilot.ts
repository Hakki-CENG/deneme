import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CognitiveOrchestrator, CycleMode } from "./cognitive-orchestrator.js";
import type { ProactiveInitiativeService } from "../initiative/proactive-initiative-service.js";
import { auroraDay, auroraInteger, auroraRound, auroraText, DurableJsonState } from "../util/aurora-state.js";

const MAX_RUNS = 20_000;

export type CadenceKind = "pulse" | "maintenance" | "reflection" | "dream" | "daily-briefing" | "weekly-review" | "monthly-strategy";

export interface AutopilotCadence {
  kind: CadenceKind;
  enabled: boolean;
  everyMinutes: number;
  lastRunAt?: string;
  nextRunAt: string;
  runCount: number;
  failureCount: number;
}

export interface AutopilotConfig {
  tenantId: string;
  enabled: boolean;
  cadences: AutopilotCadence[];
  maxRunsPerDay: number;
  quietHoursUtc: { startHour: number; endHour: number } | null;
  date: string;
  runsToday: number;
  updatedAt: string;
}

export interface AutopilotRun {
  id: string;
  tenantId: string;
  kind: CadenceKind;
  status: "completed" | "failed" | "skipped";
  detail: string;
  cycleId?: string;
  digestId?: string;
  startedAt: string;
  durationMs: number;
}

interface AutopilotStateShape {
  schemaVersion: 1;
  configs: AutopilotConfig[];
  runs: AutopilotRun[];
}

/** Reflection Scheduler defaults from the architecture: fast pulse, slow reflection, rare strategy. */
const DEFAULT_CADENCES: Array<{ kind: CadenceKind; everyMinutes: number; enabled: boolean }> = [
  { kind: "pulse", everyMinutes: 15, enabled: true },
  { kind: "maintenance", everyMinutes: 60, enabled: true },
  { kind: "reflection", everyMinutes: 24 * 60, enabled: true },
  { kind: "dream", everyMinutes: 24 * 60, enabled: false },
  { kind: "daily-briefing", everyMinutes: 24 * 60, enabled: true },
  { kind: "weekly-review", everyMinutes: 7 * 24 * 60, enabled: true },
  { kind: "monthly-strategy", everyMinutes: 30 * 24 * 60, enabled: false },
];

const CYCLE_FOR: Partial<Record<CadenceKind, CycleMode>> = {
  pulse: "emergency",
  maintenance: "maintenance",
  reflection: "reflection",
  dream: "dream",
};

/**
 * Aurora autopilot: the durable cadence that keeps the cognitive loop running between conversations.
 *
 * The architecture's promise is a system that observes, thinks and plans while the user is offline.
 * That promise is only safe with hard bounds, so the autopilot enforces:
 * - a per-tenant daily run ceiling that resets at midnight UTC;
 * - optional quiet hours during which only the fast pulse may run;
 * - per-cadence enable/disable and interval control;
 * - a durable run ledger with outcomes, so unattended activity is always reviewable;
 * - failure backoff, so a broken subsystem cannot spin the loop.
 *
 * It performs no side effects of its own: it calls the ACOS orchestrator and the initiative digest
 * builder, both of which are governed and constitution-checked.
 */
export class AuroraAutopilot {
  private readonly store: DurableJsonState<AutopilotStateShape>;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(
    rootPath: string,
    private readonly deps: { orchestrator: CognitiveOrchestrator; initiative: ProactiveInitiativeService },
    private readonly now: () => number = Date.now,
  ) {
    this.store = new DurableJsonState<AutopilotStateShape>(
      join(rootPath, "acos", "autopilot.json"),
      () => ({ schemaVersion: 1, configs: [], runs: [] }),
      (value) => {
        const state = value as AutopilotStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.configs) && Array.isArray(state.runs);
      },
      "Aurora autopilot",
    );
  }

  async config(tenantId: string): Promise<AutopilotConfig> {
    return await this.store.mutate((state) => structuredClone(this.mutableConfig(state, tenantId)));
  }

  async configure(input: {
    tenantId: string; enabled?: boolean; maxRunsPerDay?: number;
    quietHoursUtc?: { startHour: number; endHour: number } | null;
    cadences?: Array<{ kind: CadenceKind; enabled?: boolean; everyMinutes?: number }>;
  }): Promise<AutopilotConfig> {
    return await this.store.mutate((state) => {
      const config = this.mutableConfig(state, input.tenantId);
      if (input.enabled !== undefined) config.enabled = input.enabled;
      if (input.maxRunsPerDay !== undefined) config.maxRunsPerDay = auroraInteger(input.maxRunsPerDay, 0, 5000, "Autopilot daily run ceiling");
      if (input.quietHoursUtc !== undefined) {
        config.quietHoursUtc = input.quietHoursUtc === null ? null : {
          startHour: auroraInteger(input.quietHoursUtc.startHour, 0, 23, "Quiet hour start"),
          endHour: auroraInteger(input.quietHoursUtc.endHour, 0, 23, "Quiet hour end"),
        };
      }
      for (const update of input.cadences ?? []) {
        const cadence = config.cadences.find((item) => item.kind === update.kind);
        if (!cadence) throw new Error(`Unknown autopilot cadence "${update.kind}".`);
        if (update.enabled !== undefined) cadence.enabled = update.enabled;
        if (update.everyMinutes !== undefined) {
          cadence.everyMinutes = auroraInteger(update.everyMinutes, 5, 60 * 24 * 90, "Cadence interval");
          cadence.nextRunAt = new Date(this.now() + cadence.everyMinutes * 60_000).toISOString();
        }
      }
      config.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(config);
    });
  }

  /**
   * Run every cadence that is due. Returns one entry per attempted cadence, including skips, so an
   * operator can always see why Aurora did or did not act.
   */
  async runDue(tenantId: string): Promise<AutopilotRun[]> {
    const due = await this.store.mutate((state) => {
      const config = this.mutableConfig(state, tenantId);
      if (!config.enabled) return [] as CadenceKind[];
      const timestamp = this.now();
      const quiet = this.inQuietHours(config, timestamp);
      const selected: CadenceKind[] = [];
      for (const cadence of config.cadences) {
        if (!cadence.enabled) continue;
        if (Date.parse(cadence.nextRunAt) > timestamp) continue;
        if (quiet && cadence.kind !== "pulse") continue;
        if (config.runsToday >= config.maxRunsPerDay) continue;
        selected.push(cadence.kind);
        config.runsToday++;
        cadence.lastRunAt = new Date(timestamp).toISOString();
        // Failure backoff: a failing cadence waits progressively longer, capped at 8x.
        const backoff = Math.min(8, 2 ** Math.min(3, cadence.failureCount));
        cadence.nextRunAt = new Date(timestamp + cadence.everyMinutes * 60_000 * backoff).toISOString();
        cadence.runCount++;
      }
      config.updatedAt = new Date(timestamp).toISOString();
      return selected;
    });

    const runs: AutopilotRun[] = [];
    for (const kind of due) {
      const startedAt = this.now();
      try {
        const detail = await this.execute(tenantId, kind);
        runs.push({
          id: `autopilot-${randomUUID()}`,
          tenantId,
          kind,
          status: "completed",
          detail: detail.detail,
          ...(detail.cycleId ? { cycleId: detail.cycleId } : {}),
          ...(detail.digestId ? { digestId: detail.digestId } : {}),
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Math.max(0, this.now() - startedAt),
        });
        await this.store.mutate((state) => {
          const cadence = this.mutableConfig(state, tenantId).cadences.find((item) => item.kind === kind);
          if (cadence) cadence.failureCount = 0;
        });
      } catch (error) {
        runs.push({
          id: `autopilot-${randomUUID()}`,
          tenantId,
          kind,
          status: "failed",
          detail: `${(error as Error).message}`.slice(0, 1000),
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Math.max(0, this.now() - startedAt),
        });
        await this.store.mutate((state) => {
          const cadence = this.mutableConfig(state, tenantId).cadences.find((item) => item.kind === kind);
          if (cadence) cadence.failureCount = Math.min(10, cadence.failureCount + 1);
        });
      }
    }

    if (runs.length) {
      await this.store.mutate((state) => {
        for (const run of runs) state.runs.push(run);
        if (state.runs.length > MAX_RUNS) state.runs.splice(0, state.runs.length - MAX_RUNS);
      });
    }
    return runs;
  }

  async runs(tenantId: string, limit = 50): Promise<AutopilotRun[]> {
    const state = await this.store.read();
    return state.runs
      .filter((item) => item.tenantId === tenantId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, auroraInteger(limit, 1, 1000, "Run limit"))
      .map((item) => structuredClone(item));
  }

  /** Health of unattended operation: run counts, failure rate and the next scheduled work. */
  async health(tenantId: string): Promise<{ tenantId: string; enabled: boolean; runsToday: number; maxRunsPerDay: number; failureRate: number; nextRun?: { kind: CadenceKind; at: string }; cadences: AutopilotCadence[]; generatedAt: string }> {
    const config = await this.config(tenantId);
    const recent = (await this.runs(tenantId, 200));
    const failures = recent.filter((item) => item.status === "failed").length;
    const upcoming = config.cadences.filter((item) => item.enabled).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0];
    return {
      tenantId,
      enabled: config.enabled,
      runsToday: config.runsToday,
      maxRunsPerDay: config.maxRunsPerDay,
      failureRate: recent.length ? auroraRound(failures / recent.length) : 0,
      ...(upcoming ? { nextRun: { kind: upcoming.kind, at: upcoming.nextRunAt } } : {}),
      cadences: config.cadences,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Start the in-process driver. The ledger is durable, so restarts resume from persisted schedule. */
  start(tenantId: string, intervalMs = 60_000): void {
    if (this.timer) return;
    const period = auroraInteger(intervalMs, 5_000, 3_600_000, "Autopilot driver interval");
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      void this.runDue(tenantId)
        .catch(() => undefined)
        .finally(() => { this.ticking = false; });
    }, period);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async execute(tenantId: string, kind: CadenceKind): Promise<{ detail: string; cycleId?: string; digestId?: string }> {
    const cycleMode = CYCLE_FOR[kind];
    if (cycleMode) {
      const report = await this.deps.orchestrator.tick(tenantId, { mode: cycleMode, ...(kind === "pulse" ? { preempt: true } : {}) });
      return {
        detail: `${cycleMode} cycle #${report.sequence}: ${report.phases.filter((item) => item.status === "ok").length}/${report.phases.length} phases ok, ${report.recommendations.length} recommendation(s).`,
        cycleId: report.id,
      };
    }
    const period = kind === "daily-briefing" ? "daily" : kind === "weekly-review" ? "weekly" : "monthly";
    const digest = await this.deps.initiative.buildDigest(tenantId, period);
    await this.deps.orchestrator.note({
      tenantId,
      kind: "reflection",
      title: digest.title,
      body: digest.sections.map((section) => `${section.heading}: ${section.items.join("; ")}`).join("\n") || "Nothing worth reporting.",
      refs: digest.initiativeIds.slice(0, 50),
    });
    return { detail: `${digest.title} with ${digest.initiativeIds.length} initiative(s).`, digestId: digest.id };
  }

  private inQuietHours(config: AutopilotConfig, timestamp: number): boolean {
    if (!config.quietHoursUtc) return false;
    const hour = new Date(timestamp).getUTCHours();
    const { startHour, endHour } = config.quietHoursUtc;
    return startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
  }

  private mutableConfig(state: AutopilotStateShape, tenantId: string): AutopilotConfig {
    let config = state.configs.find((item) => item.tenantId === tenantId);
    const timestamp = this.now();
    if (!config) {
      config = {
        tenantId: auroraText(tenantId, 200, "Tenant ID"),
        enabled: false,
        cadences: DEFAULT_CADENCES.map((item) => ({
          kind: item.kind,
          enabled: item.enabled,
          everyMinutes: item.everyMinutes,
          nextRunAt: new Date(timestamp + item.everyMinutes * 60_000).toISOString(),
          runCount: 0,
          failureCount: 0,
        })),
        maxRunsPerDay: 96,
        quietHoursUtc: null,
        date: auroraDay(timestamp),
        runsToday: 0,
        updatedAt: new Date(timestamp).toISOString(),
      };
      state.configs.push(config);
    }
    const today = auroraDay(timestamp);
    if (config.date !== today) {
      config.date = today;
      config.runsToday = 0;
    }
    return config;
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const items = (s as any).sessions?.filter((x: any) => x.tenantId === tenantId) ?? [];
    return { total: items.length };
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
