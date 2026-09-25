import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AuroraAutopilot, AutopilotRun } from "./autopilot.js";
import { auroraDay, auroraInteger, auroraOptionalText, auroraRound, auroraText, DurableJsonState } from "../util/aurora-state.js";

const MAX_MEMBERS = 500;
const MAX_SWEEPS = 5_000;
const FAILURES_BEFORE_PAUSE = 3;
const MAX_PAUSE_MINUTES = 240;

export interface FleetMember {
  tenantId: string;
  enabled: boolean;
  /** 1 (background) to 5 (front of the queue). Higher priority tenants are swept first. */
  priority: number;
  /** Upper bound on autopilot runs accepted from one sweep of this tenant. */
  maxRunsPerSweep: number;
  note?: string;
  enrolledAt: string;
  updatedAt: string;
  lastSweepAt?: string;
  lastOutcome?: "ran" | "idle" | "failed" | "paused";
  lastDetail?: string;
  consecutiveFailures: number;
  pausedUntil?: string;
  pauseReason?: string;
  totalSweeps: number;
  totalRuns: number;
  totalFailures: number;
}

export interface FleetSweepTenantResult {
  tenantId: string;
  outcome: "ran" | "idle" | "failed" | "skipped";
  runs: number;
  failedRuns: number;
  detail: string;
  durationMs: number;
}

export interface FleetSweep {
  id: string;
  startedAt: string;
  durationMs: number;
  consideredTenants: number;
  sweptTenants: number;
  totalRuns: number;
  failedRuns: number;
  results: FleetSweepTenantResult[];
}

interface FleetStateShape {
  schemaVersion: 1;
  members: FleetMember[];
  sweeps: FleetSweep[];
  date: string;
  sweepsToday: number;
}

export interface FleetSupervisorOptions {
  /** How many tenants a single sweep may touch. Keeps one large fleet from monopolising the loop. */
  maxTenantsPerSweep?: number;
  /** Hard ceiling on sweeps per UTC day, so a misconfigured driver cannot spin forever. */
  maxSweepsPerDay?: number;
}

/**
 * Aurora fleet supervisor: the multi-tenant driver above the per-tenant autopilot.
 *
 * The autopilot already knows how to run one tenant's cadences safely. What was missing was the
 * layer that keeps *many* tenants running unattended without letting one of them starve or poison
 * the others. The supervisor adds exactly that and nothing more:
 *
 * - explicit enrollment: a tenant is only driven after someone opts it in, so multi-tenancy never
 *   becomes accidental background compute;
 * - fair round-robin within priority bands (least-recently-swept first), so a busy tenant cannot
 *   starve a quiet one;
 * - per-sweep bounds (tenants per sweep, runs accepted per tenant) and a daily sweep ceiling;
 * - failure isolation: one tenant throwing never aborts the sweep;
 * - a circuit breaker with exponential pause, so a broken tenant backs off instead of burning the
 *   fleet's budget;
 * - a durable sweep ledger, so unattended cross-tenant activity is always reviewable.
 *
 * It performs no work of its own: every side effect flows through `AuroraAutopilot.runDue`, which is
 * itself constitution-checked and governed at the capability boundary.
 */
export class AuroraFleetSupervisor {
  private readonly store: DurableJsonState<FleetStateShape>;
  private readonly maxTenantsPerSweep: number;
  private readonly maxSweepsPerDay: number;
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor(
    rootPath: string,
    private readonly deps: { autopilot: AuroraAutopilot },
    options: FleetSupervisorOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.maxTenantsPerSweep = auroraInteger(options.maxTenantsPerSweep ?? 25, 1, MAX_MEMBERS, "Fleet tenants per sweep");
    this.maxSweepsPerDay = auroraInteger(options.maxSweepsPerDay ?? 2_000, 1, 100_000, "Fleet sweeps per day");
    this.store = new DurableJsonState<FleetStateShape>(
      join(rootPath, "acos", "fleet.json"),
      () => ({ schemaVersion: 1, members: [], sweeps: [], date: auroraDay(this.now()), sweepsToday: 0 }),
      (value) => {
        const state = value as FleetStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.members) && Array.isArray(state.sweeps);
      },
      "Aurora fleet supervisor",
    );
  }

  /** Opt a tenant into unattended fleet operation. Idempotent: re-enrolling updates the settings. */
  async enroll(input: { tenantId: string; priority?: number; maxRunsPerSweep?: number; note?: string; enabled?: boolean }): Promise<FleetMember> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    return await this.store.mutate((state) => {
      const timestamp = new Date(this.now()).toISOString();
      let member = state.members.find((item) => item.tenantId === tenantId);
      if (!member) {
        if (state.members.length >= MAX_MEMBERS) throw new Error(`Fleet is limited to ${MAX_MEMBERS} tenants.`);
        member = {
          tenantId,
          enabled: true,
          priority: 3,
          maxRunsPerSweep: 4,
          enrolledAt: timestamp,
          updatedAt: timestamp,
          consecutiveFailures: 0,
          totalSweeps: 0,
          totalRuns: 0,
          totalFailures: 0,
        };
        state.members.push(member);
      }
      this.applySettings(member, input);
      member.updatedAt = timestamp;
      return structuredClone(member);
    });
  }

  /** Change enrollment settings without re-enrolling. Throws for unknown tenants. */
  async update(input: { tenantId: string; enabled?: boolean; priority?: number; maxRunsPerSweep?: number; note?: string }): Promise<FleetMember> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    return await this.store.mutate((state) => {
      const member = state.members.find((item) => item.tenantId === tenantId);
      if (!member) throw new Error(`Tenant "${tenantId}" is not enrolled in the Aurora fleet.`);
      this.applySettings(member, input);
      member.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(member);
    });
  }

  /** Remove a tenant from unattended operation. Its own autopilot config and ledger are untouched. */
  async withdraw(tenantId: string): Promise<{ tenantId: string; withdrawn: boolean }> {
    const id = auroraText(tenantId, 200, "Tenant ID");
    return await this.store.mutate((state) => {
      const index = state.members.findIndex((item) => item.tenantId === id);
      if (index < 0) return { tenantId: id, withdrawn: false };
      state.members.splice(index, 1);
      return { tenantId: id, withdrawn: true };
    });
  }

  /** Clear a circuit-breaker pause after an operator has fixed the underlying problem. */
  async resume(tenantId: string): Promise<FleetMember> {
    const id = auroraText(tenantId, 200, "Tenant ID");
    return await this.store.mutate((state) => {
      const member = state.members.find((item) => item.tenantId === id);
      if (!member) throw new Error(`Tenant "${id}" is not enrolled in the Aurora fleet.`);
      delete member.pausedUntil;
      delete member.pauseReason;
      member.consecutiveFailures = 0;
      member.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(member);
    });
  }

  async members(): Promise<FleetMember[]> {
    const state = await this.store.read();
    return state.members.map((item) => structuredClone(item)).sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  }

  async member(tenantId: string): Promise<FleetMember | undefined> {
    const state = await this.store.read();
    const found = state.members.find((item) => item.tenantId === tenantId);
    return found ? structuredClone(found) : undefined;
  }

  /**
   * Sweep the fleet once: every enrolled, enabled, unpaused tenant that fits the bounds gets its due
   * cadences run. Failures are contained per tenant and recorded, never thrown to the caller.
   */
  async sweep(options: { limit?: number; tenantId?: string } = {}): Promise<FleetSweep> {
    const startedAt = this.now();
    const limit = options.limit === undefined
      ? this.maxTenantsPerSweep
      : auroraInteger(options.limit, 1, this.maxTenantsPerSweep, "Fleet sweep limit");
    const only = auroraOptionalText(options.tenantId, 200, "Tenant ID");

    const selection = await this.store.mutate((state) => {
      this.rollDay(state);
      if (state.sweepsToday >= this.maxSweepsPerDay) return { budgetExhausted: true, considered: 0, chosen: [] as Array<{ tenantId: string; maxRuns: number }> };
      state.sweepsToday++;
      const candidates = state.members.filter((item) => (only ? item.tenantId === only : true));
      const eligible = candidates.filter((item) => item.enabled && !this.isPaused(item));
      const ordered = eligible.sort((a, b) =>
        b.priority - a.priority || (a.lastSweepAt ?? "").localeCompare(b.lastSweepAt ?? "") || a.tenantId.localeCompare(b.tenantId));
      return {
        budgetExhausted: false,
        considered: candidates.length,
        chosen: ordered.slice(0, limit).map((item) => ({ tenantId: item.tenantId, maxRuns: item.maxRunsPerSweep })),
      };
    });

    const results: FleetSweepTenantResult[] = [];
    for (const target of selection.chosen) {
      const tenantStart = this.now();
      let runs: AutopilotRun[] = [];
      let failure: string | undefined;
      try {
        runs = await this.deps.autopilot.runDue(target.tenantId);
      } catch (error) {
        failure = `${(error as Error).message}`.slice(0, 500);
      }
      const accepted = runs.slice(0, target.maxRuns);
      const failedRuns = accepted.filter((item) => item.status === "failed").length;
      const outcome: FleetSweepTenantResult["outcome"] = failure ? "failed" : accepted.length ? "ran" : "idle";
      results.push({
        tenantId: target.tenantId,
        outcome,
        runs: accepted.length,
        failedRuns,
        detail: failure
          ?? (accepted.length
            ? accepted.map((item) => `${item.kind}:${item.status}`).join(", ") + (runs.length > accepted.length ? ` (+${runs.length - accepted.length} beyond sweep cap)` : "")
            : "no cadence was due"),
        durationMs: Math.max(0, this.now() - tenantStart),
      });
    }

    const sweep: FleetSweep = {
      id: `fleet-sweep-${randomUUID()}`,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Math.max(0, this.now() - startedAt),
      consideredTenants: selection.considered,
      sweptTenants: results.length,
      totalRuns: results.reduce((total, item) => total + item.runs, 0),
      failedRuns: results.reduce((total, item) => total + item.failedRuns, 0),
      results,
    };

    await this.store.mutate((state) => {
      const timestamp = new Date(this.now()).toISOString();
      for (const result of results) {
        const member = state.members.find((item) => item.tenantId === result.tenantId);
        if (!member) continue;
        member.lastSweepAt = timestamp;
        member.lastOutcome = result.outcome === "skipped" ? "paused" : result.outcome;
        member.lastDetail = result.detail.slice(0, 500);
        member.totalSweeps++;
        member.totalRuns += result.runs;
        member.totalFailures += result.failedRuns + (result.outcome === "failed" ? 1 : 0);
        if (result.outcome === "failed" || result.failedRuns > 0) {
          member.consecutiveFailures = Math.min(20, member.consecutiveFailures + 1);
          if (member.consecutiveFailures >= FAILURES_BEFORE_PAUSE) {
            const minutes = Math.min(MAX_PAUSE_MINUTES, 15 * 2 ** (member.consecutiveFailures - FAILURES_BEFORE_PAUSE));
            member.pausedUntil = new Date(this.now() + minutes * 60_000).toISOString();
            member.pauseReason = `Circuit breaker: ${member.consecutiveFailures} consecutive failing sweeps.`;
          }
        } else {
          member.consecutiveFailures = 0;
          delete member.pausedUntil;
          delete member.pauseReason;
        }
      }
      state.sweeps.push(sweep);
      if (state.sweeps.length > MAX_SWEEPS) state.sweeps.splice(0, state.sweeps.length - MAX_SWEEPS);
    });

    return sweep;
  }

  async sweeps(limit = 20): Promise<FleetSweep[]> {
    const state = await this.store.read();
    return state.sweeps
      .slice(-auroraInteger(limit, 1, 500, "Sweep limit"))
      .reverse()
      .map((item) => structuredClone(item));
  }

  /** Fleet-wide health. Cross-tenant, so it is exposed to operators rather than to tenant agents. */
  async status(): Promise<{
    enrolled: number; enabled: number; paused: number; driverRunning: boolean;
    maxTenantsPerSweep: number; sweepsToday: number; maxSweepsPerDay: number;
    runsLastSweeps: number; failureRate: number;
    nextTenant?: { tenantId: string; priority: number; lastSweepAt?: string };
    lastSweep?: { id: string; startedAt: string; sweptTenants: number; totalRuns: number; failedRuns: number };
    generatedAt: string;
  }> {
    const state = await this.store.read();
    const recent = state.sweeps.slice(-50);
    const runs = recent.reduce((total, item) => total + item.totalRuns, 0);
    const failed = recent.reduce((total, item) => total + item.failedRuns, 0);
    const upcoming = state.members
      .filter((item) => item.enabled && !this.isPaused(item))
      .sort((a, b) => b.priority - a.priority || (a.lastSweepAt ?? "").localeCompare(b.lastSweepAt ?? "") || a.tenantId.localeCompare(b.tenantId))[0];
    const last = state.sweeps[state.sweeps.length - 1];
    return {
      enrolled: state.members.length,
      enabled: state.members.filter((item) => item.enabled).length,
      paused: state.members.filter((item) => this.isPaused(item)).length,
      driverRunning: this.timer !== undefined,
      maxTenantsPerSweep: this.maxTenantsPerSweep,
      sweepsToday: state.date === auroraDay(this.now()) ? state.sweepsToday : 0,
      maxSweepsPerDay: this.maxSweepsPerDay,
      runsLastSweeps: runs,
      failureRate: runs ? auroraRound(failed / runs) : 0,
      ...(upcoming
        ? { nextTenant: { tenantId: upcoming.tenantId, priority: upcoming.priority, ...(upcoming.lastSweepAt ? { lastSweepAt: upcoming.lastSweepAt } : {}) } }
        : {}),
      ...(last
        ? { lastSweep: { id: last.id, startedAt: last.startedAt, sweptTenants: last.sweptTenants, totalRuns: last.totalRuns, failedRuns: last.failedRuns } }
        : {}),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /** One tenant's fleet membership joined with its own autopilot health. Tenant-scoped and safe. */
  async tenantStatus(tenantId: string): Promise<{ tenantId: string; enrolled: boolean; member?: FleetMember; paused: boolean; autopilot: Awaited<ReturnType<AuroraAutopilot["health"]>> }> {
    const member = await this.member(tenantId);
    return {
      tenantId,
      enrolled: member !== undefined,
      ...(member ? { member } : {}),
      paused: member ? this.isPaused(member) : false,
      autopilot: await this.deps.autopilot.health(tenantId),
    };
  }

  /** Start the in-process fleet driver. The ledger is durable, so restarts resume the schedule. */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    const period = auroraInteger(intervalMs, 5_000, 3_600_000, "Fleet driver interval");
    this.timer = setInterval(() => {
      if (this.sweeping) return;
      this.sweeping = true;
      void this.sweep()
        .catch(() => undefined)
        .finally(() => { this.sweeping = false; });
    }, period);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private applySettings(member: FleetMember, input: { enabled?: boolean; priority?: number; maxRunsPerSweep?: number; note?: string }): void {
    if (input.enabled !== undefined) member.enabled = input.enabled;
    if (input.priority !== undefined) member.priority = auroraInteger(input.priority, 1, 5, "Fleet priority");
    if (input.maxRunsPerSweep !== undefined) member.maxRunsPerSweep = auroraInteger(input.maxRunsPerSweep, 1, 50, "Fleet runs per sweep");
    if (input.note !== undefined) {
      if (input.note.trim()) member.note = auroraText(input.note, 500, "Fleet note");
      else delete member.note;
    }
  }

  private isPaused(member: FleetMember): boolean {
    return member.pausedUntil !== undefined && Date.parse(member.pausedUntil) > this.now();
  }

  private rollDay(state: FleetStateShape): void {
    const today = auroraDay(this.now());
    if (state.date !== today) {
      state.date = today;
      state.sweepsToday = 0;
    }
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const items = (s as any).fleet?.filter((x: any) => x.tenantId === tenantId) ?? [];
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
