import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  auroraDay, auroraDigest, auroraIds, auroraInteger, auroraMonth, auroraRound, auroraTags, auroraText,
  auroraTimestamp, auroraUnit, auroraWeek, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_WATCHERS = 1_000;
const MAX_INTAKE = 100_000;
const MAX_INITIATIVES = 100_000;
const MAX_DIGESTS = 10_000;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60_000;

export type InitiativeSource =
  | "memory" | "world-model" | "git" | "calendar" | "filesystem" | "weather" | "research"
  | "location" | "notification" | "cognitive" | "society" | "skill" | "system"
  | "tasks" | "schedules";
export type InitiativeKind = "opportunity" | "risk" | "reminder" | "insight" | "intervention" | "briefing";
export type InitiativePriority = "P0" | "P1" | "P2" | "P3" | "P4";
export type InitiativeChannel = "immediate" | "message" | "daily-digest" | "weekly-digest" | "archive";
export type InitiativeMode = "guardian" | "assistant";

export interface InitiativeWatcher {
  id: string;
  tenantId: string;
  kind: "research" | "project" | "skill" | "risk" | "opportunity" | "pattern" | "schedule";
  name: string;
  target: string;
  keywords: string[];
  enabled: boolean;
  intervalMinutes: number;
  mode: InitiativeMode;
  minWorthiness: number;
  lastRunAt?: string;
  matches: number;
  createdAt: string;
  updatedAt: string;
}

export interface InitiativeIntakeEvent {
  id: string;
  tenantId: string;
  source: InitiativeSource;
  summary: string;
  payloadDigest: string;
  occurredAt: string;
  tags: string[];
  entityRefs: string[];
  processed: boolean;
  createdAt: string;
}

export interface Initiative {
  id: string;
  tenantId: string;
  kind: InitiativeKind;
  mode: InitiativeMode;
  title: string;
  message: string;
  importance: number;
  urgency: number;
  impact: number;
  confidence: number;
  userRelevance: number;
  worthiness: number;
  goalAlignment: number;
  priority: InitiativePriority;
  channel: InitiativeChannel;
  state: "candidate" | "queued" | "delivered" | "suppressed" | "digested" | "expired" | "dismissed";
  suppressionReason?: string;
  escalations: Array<{ from: InitiativePriority; to: InitiativePriority; reason: string; at: string }>;
  intakeEventIds: string[];
  watcherId?: string;
  evidenceRefs: string[];
  dedupeDigest: string;
  expiresAt?: string;
  deliveredAt?: string;
  deliveredChannel?: string;
  feedback?: { useful: boolean; actedOn: boolean; note?: string; ratedAt: string };
  /** P1.54: why this initiative got its priority, channel and verdict. */
  decision?: InitiativeDecision;
  createdAt: string;
  updatedAt: string;
}

export interface InitiativeDecision {
  scoredPriority: InitiativePriority;
  effectiveScore: number;
  thresholds: { p0: number; p1: number; p2: number };
  trustFactor: number;
  contextFit?: { state: string; applied: boolean };
  muted?: boolean;
  reason: string;
}

export interface InitiativeChannelPreferences {
  orderedChannels: string[];
  destination?: string;
}

export interface InitiativeKindMute {
  tenantId: string;
  kind: InitiativeKind;
  until: string;
  reason?: string;
}

export interface InitiativeBudget {
  tenantId: string;
  date: string;
  dailyImmediateLimit: number;
  dailyMessageLimit: number;
  usedImmediate: number;
  usedMessage: number;
  minWorthinessP0: number;
  minWorthinessP1: number;
  minWorthinessP2: number;
  quietHoursUtc: { startHour: number; endHour: number } | null;
  trustScore: number;
  deliveredTotal: number;
  usefulTotal: number;
}

export interface InitiativeDigest {
  id: string;
  tenantId: string;
  period: "daily" | "weekly" | "monthly";
  periodKey: string;
  title: string;
  initiativeIds: string[];
  sections: Array<{ heading: string; items: string[] }>;
  createdAt: string;
}

export interface InitiativeEvaluation {
  tenantId: string;
  evaluated: number;
  queued: Array<{ id: string; priority: InitiativePriority; channel: InitiativeChannel; worthiness: number }>;
  suppressed: Array<{ id: string; reason: string }>;
  digested: string[];
  budget: InitiativeBudget;
  generatedAt: string;
}

/** Optional real-data providers wired by the engine; every one of them is allowed to be absent. */
export interface InitiativeProviders {
  /** P1.50 context fit: current user state ("busy" demotes P1 to a digest). */
  contextState?: (tenantId: string) => Promise<{ state: string; confidence: number } | undefined>;
  /** P1.50 goal alignment: score a text against the user's active goals (0-1). */
  goalAlignment?: (tenantId: string, text: string) => Promise<number | undefined>;
  /** P1.52 communication selector: which outbound channels actually exist right now. */
  availableChannels?: () => string[];
  /** P1.52 delivery sender: send one initiative over one channel. */
  sendChannel?: (channel: string, initiative: Initiative, destination?: string) => Promise<{ messageId?: string } | void>;
  /** P1.53 briefing sections sourced from live subsystems (projects, goals, memory). */
  digestSections?: Array<{ heading: string; items: (tenantId: string) => Promise<string[]> }>;
}

interface InitiativeStateShape {
  schemaVersion: 1;
  watchers: InitiativeWatcher[];
  intake: InitiativeIntakeEvent[];
  initiatives: Initiative[];
  budgets: InitiativeBudget[];
  digests: InitiativeDigest[];
  channelPreferences?: Array<InitiativeChannelPreferences & { tenantId: string }>;
  mutes?: InitiativeKindMute[];
}

const PRIORITY_ORDER: InitiativePriority[] = ["P0", "P1", "P2", "P3", "P4"];
const CHANNEL_BY_PRIORITY: Record<InitiativePriority, InitiativeChannel> = {
  P0: "immediate",
  P1: "message",
  P2: "daily-digest",
  P3: "weekly-digest",
  P4: "archive",
};

/**
 * Aurora Phase E — Proactive Initiative Engine.
 *
 * Detection is cheap; silence is the hard part. Every initiative is scored with
 * importance x urgency x impact x confidence x user relevance, classified P0-P4, bounded by a daily
 * attention budget, de-duplicated, quiet-hour aware and trust-adaptive: bad notifications make the
 * engine quieter, useful ones earn back bandwidth.
 */
export class ProactiveInitiativeService {
  private readonly store: DurableJsonState<InitiativeStateShape>;

  constructor(
    rootPath: string,
    private readonly now: () => number = Date.now,
    private readonly hooks: { onQueued?: (initiative: Initiative) => Promise<void> | void } = {},
    private readonly providers: InitiativeProviders = {},
  ) {
    this.store = new DurableJsonState<InitiativeStateShape>(
      join(rootPath, "initiative", "state.json"),
      () => ({ schemaVersion: 1, watchers: [], intake: [], initiatives: [], budgets: [], digests: [] }),
      (value) => {
        const state = value as InitiativeStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.watchers) && Array.isArray(state.intake)
          && Array.isArray(state.initiatives) && Array.isArray(state.budgets) && Array.isArray(state.digests);
      },
      "Aurora initiative state",
    );
  }

  async registerWatcher(input: {
    tenantId: string; kind: InitiativeWatcher["kind"]; name: string; target: string; keywords?: string[];
    intervalMinutes?: number; mode?: InitiativeMode; minWorthiness?: number;
  }): Promise<InitiativeWatcher> {
    return await this.store.mutate((state) => {
      if (state.watchers.filter((item) => item.tenantId === input.tenantId).length >= MAX_WATCHERS) throw new Error("Initiative watcher limit reached.");
      const nowIso = new Date(this.now()).toISOString();
      const watcher: InitiativeWatcher = {
        id: `watch-${randomUUID()}`,
        tenantId: input.tenantId,
        kind: input.kind,
        name: auroraText(input.name, 200, "Watcher name"),
        target: auroraText(input.target, 1000, "Watcher target"),
        keywords: auroraTags(input.keywords, "Watcher keywords"),
        enabled: true,
        intervalMinutes: auroraInteger(input.intervalMinutes ?? 60, 1, 60 * 24 * 30, "Watcher interval"),
        mode: input.mode ?? "assistant",
        minWorthiness: input.minWorthiness === undefined ? 0.05 : auroraUnit(input.minWorthiness, "Watcher minimum worthiness"),
        matches: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.watchers.push(watcher);
      return structuredClone(watcher);
    });
  }

  async setWatcherEnabled(tenantId: string, watcherId: string, enabled: boolean): Promise<InitiativeWatcher> {
    return await this.store.mutate((state) => {
      const watcher = this.mutableWatcher(state, tenantId, watcherId);
      watcher.enabled = enabled;
      watcher.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(watcher);
    });
  }

  async watchers(tenantId: string): Promise<InitiativeWatcher[]> {
    const state = await this.store.read();
    return state.watchers.filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item));
  }

  /** Continuous event intake. Content is stored as a summary plus a digest, never as a raw payload dump. */
  async ingest(input: { tenantId: string; source: InitiativeSource; summary: string; payload?: unknown; occurredAt?: string; tags?: string[]; entityRefs?: string[] }): Promise<InitiativeIntakeEvent> {
    return await this.store.mutate((state) => {
      const tenantEvents = state.intake.filter((item) => item.tenantId === input.tenantId);
      if (tenantEvents.length >= MAX_INTAKE) {
        const oldest = tenantEvents.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).slice(0, Math.ceil(MAX_INTAKE * 0.1)).map((item) => item.id);
        state.intake = state.intake.filter((item) => !oldest.includes(item.id));
      }
      const timestamp = this.now();
      const event: InitiativeIntakeEvent = {
        id: `intake-${randomUUID()}`,
        tenantId: input.tenantId,
        source: input.source,
        summary: auroraText(input.summary, 5000, "Intake summary"),
        payloadDigest: auroraDigest(input.payload === undefined ? input.summary : input.payload),
        occurredAt: auroraTimestamp(input.occurredAt, timestamp, "Intake occurredAt"),
        tags: auroraTags(input.tags, "Intake tags"),
        entityRefs: auroraIds(input.entityRefs, 50, "Intake entity refs"),
        processed: false,
        createdAt: new Date(timestamp).toISOString(),
      };
      state.intake.push(event);
      return structuredClone(event);
    });
  }

  async intakeEvents(tenantId: string, options?: { processed?: boolean; limit?: number }): Promise<InitiativeIntakeEvent[]> {
    const state = await this.store.read();
    return state.intake
      .filter((item) => item.tenantId === tenantId && (options?.processed === undefined || item.processed === options.processed))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, auroraInteger(options?.limit ?? 100, 1, 1000, "Intake limit"))
      .map((item) => structuredClone(item));
  }

  /**
   * Match unprocessed intake events against enabled watchers and open initiative candidates.
   * Nothing is delivered here: candidates still have to survive worthiness, budget and silence rules.
   */
  async runWatchers(tenantId: string): Promise<{ matched: Array<{ watcherId: string; initiativeId: string }>; scanned: number }> {
    return await this.store.mutate((state) => {
      const timestamp = this.now();
      const nowIso = new Date(timestamp).toISOString();
      const watchers = state.watchers.filter((item) => item.tenantId === tenantId && item.enabled
        && (!item.lastRunAt || timestamp - Date.parse(item.lastRunAt) >= item.intervalMinutes * 60_000));
      const pending = state.intake.filter((item) => item.tenantId === tenantId && !item.processed);
      const matched: Array<{ watcherId: string; initiativeId: string }> = [];
      for (const watcher of watchers) {
        watcher.lastRunAt = nowIso;
        watcher.updatedAt = nowIso;
        const hits = pending.filter((event) => {
          const haystack = `${event.summary} ${event.tags.join(" ")}`.toLowerCase();
          return watcher.keywords.length ? watcher.keywords.some((keyword) => haystack.includes(keyword)) : haystack.includes(watcher.target.toLowerCase());
        });
        for (const hit of hits) {
          const kind: InitiativeKind = watcher.kind === "risk" ? "risk" : watcher.kind === "opportunity" ? "opportunity" : watcher.kind === "skill" ? "insight" : watcher.kind === "project" ? "reminder" : "insight";
          const initiative = this.buildInitiative(state, {
            tenantId,
            kind,
            mode: watcher.mode,
            title: `${watcher.name}: ${hit.summary}`.slice(0, 300),
            message: hit.summary,
            importance: 0.5,
            urgency: watcher.kind === "risk" ? 0.7 : 0.4,
            impact: 0.5,
            confidence: 0.6,
            userRelevance: 0.6,
            intakeEventIds: [hit.id],
            watcherId: watcher.id,
            evidenceRefs: [],
          }, timestamp);
          hit.processed = true;
          watcher.matches++;
          if (initiative) matched.push({ watcherId: watcher.id, initiativeId: initiative.id });
        }
      }
      return { matched, scanned: pending.length };
    });
  }

  /** Create an initiative candidate directly (guardian alerts, agent insights, interventions). */
  async propose(input: {
    tenantId: string; kind: InitiativeKind; title: string; message: string; importance: number; urgency: number;
    impact: number; confidence: number; userRelevance: number; goalAlignment?: number; mode?: InitiativeMode;
    intakeEventIds?: string[]; evidenceRefs?: string[]; expiresAt?: string; watcherId?: string;
  }): Promise<Initiative> {
    // P1.50 goal alignment: an explicit score wins; otherwise the provider
    // scores the text against the user's real active goals; with no provider
    // the alignment stays what userRelevance implied — never invented.
    let goalAlignment = input.goalAlignment;
    if (goalAlignment === undefined && this.providers.goalAlignment) {
      const scored = await this.providers.goalAlignment(input.tenantId, `${input.title} ${input.message}`).catch(() => undefined);
      if (scored !== undefined) goalAlignment = auroraUnit(scored, "Goal alignment score");
    }
    const created = await this.store.mutate((state) => {
      const timestamp = this.now();
      const initiative = this.buildInitiative(state, {
        tenantId: input.tenantId,
        kind: input.kind,
        mode: input.mode ?? (input.kind === "risk" ? "guardian" : "assistant"),
        title: input.title,
        message: input.message,
        importance: input.importance,
        urgency: input.urgency,
        impact: input.impact,
        confidence: input.confidence,
        userRelevance: input.userRelevance,
        ...(goalAlignment !== undefined ? { goalAlignment } : {}),
        intakeEventIds: input.intakeEventIds ?? [],
        ...(input.watcherId ? { watcherId: input.watcherId } : {}),
        evidenceRefs: input.evidenceRefs ?? [],
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      }, timestamp);
      if (!initiative) throw new Error("Initiative was suppressed as a duplicate of a recent notification.");
      return structuredClone(initiative);
    });
    return created;
  }

  async configureBudget(input: {
    tenantId: string; dailyImmediateLimit?: number; dailyMessageLimit?: number;
    minWorthinessP0?: number; minWorthinessP1?: number; minWorthinessP2?: number;
    quietHoursUtc?: { startHour: number; endHour: number } | null;
  }): Promise<InitiativeBudget> {
    return await this.store.mutate((state) => {
      const budget = this.mutableBudget(state, input.tenantId);
      if (input.dailyImmediateLimit !== undefined) budget.dailyImmediateLimit = auroraInteger(input.dailyImmediateLimit, 0, 100, "Immediate notification limit");
      if (input.dailyMessageLimit !== undefined) budget.dailyMessageLimit = auroraInteger(input.dailyMessageLimit, 0, 200, "Message notification limit");
      if (input.minWorthinessP0 !== undefined) budget.minWorthinessP0 = auroraUnit(input.minWorthinessP0, "P0 worthiness threshold");
      if (input.minWorthinessP1 !== undefined) budget.minWorthinessP1 = auroraUnit(input.minWorthinessP1, "P1 worthiness threshold");
      if (input.minWorthinessP2 !== undefined) budget.minWorthinessP2 = auroraUnit(input.minWorthinessP2, "P2 worthiness threshold");
      if (input.quietHoursUtc !== undefined) {
        if (input.quietHoursUtc === null) budget.quietHoursUtc = null;
        else {
          budget.quietHoursUtc = {
            startHour: auroraInteger(input.quietHoursUtc.startHour, 0, 23, "Quiet hour start"),
            endHour: auroraInteger(input.quietHoursUtc.endHour, 0, 23, "Quiet hour end"),
          };
        }
      }
      return structuredClone(budget);
    });
  }

  async budget(tenantId: string): Promise<InitiativeBudget> {
    return await this.store.mutate((state) => structuredClone(this.mutableBudget(state, tenantId)));
  }

  /**
   * Classify and route candidates. Trust-adaptive thresholds, attention budget, quiet hours and
   * silence rules decide whether something is delivered now, digested later or suppressed.
   */
  async evaluate(tenantId: string): Promise<InitiativeEvaluation> {
    // P1.50 context fit: what the user is doing right now, if anyone can tell.
    // A provider miss is not "idle": without evidence nothing is demoted.
    const context = await (this.providers.contextState?.(tenantId).catch(() => undefined) ?? undefined);
    const busy = context !== undefined && ["busy", "working"].includes(context.state);
    const evaluation = await this.store.mutate((state) => {
      const timestamp = this.now();
      const nowIso = new Date(timestamp).toISOString();
      const budget = this.mutableBudget(state, tenantId);
      const trustFactor = 2 - budget.trustScore; // low trust => higher bar
      // P1.54 user override: expired mutes are pruned, active ones silence a kind.
      state.mutes = (state.mutes ?? []).filter((mute) => mute.tenantId !== tenantId || Date.parse(mute.until) > timestamp);
      const mutedKinds = new Set((state.mutes ?? []).filter((mute) => mute.tenantId === tenantId).map((mute) => mute.kind));
      const candidates = state.initiatives
        .filter((item) => item.tenantId === tenantId && item.state === "candidate")
        .sort((a, b) => b.worthiness - a.worthiness || a.createdAt.localeCompare(b.createdAt));
      const queued: InitiativeEvaluation["queued"] = [];
      const suppressed: InitiativeEvaluation["suppressed"] = [];
      const digested: string[] = [];
      const quiet = this.inQuietHours(budget, timestamp);
      for (const initiative of candidates) {
        if (initiative.expiresAt && Date.parse(initiative.expiresAt) < timestamp) {
          initiative.state = "expired";
          initiative.updatedAt = nowIso;
          suppressed.push({ id: initiative.id, reason: "expired" });
          continue;
        }
        const priority = this.classify(initiative, budget, trustFactor);
        initiative.priority = priority;
        initiative.channel = CHANNEL_BY_PRIORITY[priority];
        const effective = this.effectiveScore(initiative, trustFactor);
        const muted = mutedKinds.has(initiative.kind);
        // P1.54: every verdict carries its arithmetic, so "why did Aurora
        // interrupt me" is a read, not an investigation.
        const decisionBase = {
          scoredPriority: priority,
          effectiveScore: effective,
          thresholds: { p0: budget.minWorthinessP0, p1: budget.minWorthinessP1, p2: budget.minWorthinessP2 },
          trustFactor,
          ...(context !== undefined ? { contextFit: { state: context.state, applied: false } } : {}),
          ...(muted ? { muted: true } : {}),
        };
        if (muted) {
          initiative.state = "digested";
          initiative.channel = "archive";
          initiative.suppressionReason = "kind-muted";
          initiative.decision = { ...decisionBase, reason: `initiatives of kind "${initiative.kind}" are muted by the user; routed to the archive` };
          initiative.updatedAt = nowIso;
          digested.push(initiative.id);
          continue;
        }
        if (priority === "P4") {
          initiative.state = "digested";
          initiative.channel = "archive";
          initiative.decision = { ...decisionBase, reason: `effective score ${effective.toFixed(3)} below the P3 floor; silence (archive) rather than interrupt` };
          initiative.updatedAt = nowIso;
          digested.push(initiative.id);
          continue;
        }
        if (priority === "P2" || priority === "P3") {
          initiative.state = "digested";
          initiative.decision = { ...decisionBase, reason: `effective score ${effective.toFixed(3)} lands in digest territory (${priority}); not worth an interruption` };
          initiative.updatedAt = nowIso;
          digested.push(initiative.id);
          continue;
        }
        if (priority === "P1" && busy && !(initiative.mode === "guardian" && initiative.kind === "risk")) {
          initiative.state = "digested";
          initiative.channel = "daily-digest";
          initiative.suppressionReason = "context-fit-busy";
          initiative.decision = {
            ...decisionBase,
            ...(context !== undefined ? { contextFit: { state: context.state, applied: true } } : {}),
            reason: `user state estimated "${context?.state ?? "unknown"}"; P1 deferred to the digest instead of interrupting`,
          };
          initiative.updatedAt = nowIso;
          digested.push(initiative.id);
          continue;
        }
        if (priority === "P1" && quiet) {
          initiative.state = "digested";
          initiative.channel = "daily-digest";
          initiative.suppressionReason = "quiet-hours";
          initiative.decision = { ...decisionBase, reason: "quiet hours are active; P1 deferred to the daily digest" };
          initiative.updatedAt = nowIso;
          digested.push(initiative.id);
          continue;
        }
        const limit = priority === "P0" ? budget.dailyImmediateLimit : budget.dailyMessageLimit;
        const used = priority === "P0" ? budget.usedImmediate : budget.usedMessage;
        if (used >= limit) {
          initiative.state = "digested";
          initiative.channel = "daily-digest";
          initiative.suppressionReason = "attention-budget-exhausted";
          initiative.decision = { ...decisionBase, reason: `daily ${priority === "P0" ? "immediate" : "message"} budget exhausted (${used}/${limit}); deferred to the digest` };
          initiative.updatedAt = nowIso;
          digested.push(initiative.id);
          continue;
        }
        initiative.state = "queued";
        initiative.decision = { ...decisionBase, reason: `effective score ${effective.toFixed(3)} justified ${priority}; queued for delivery on channel "${initiative.channel}"` };
        initiative.updatedAt = nowIso;
        if (priority === "P0") budget.usedImmediate++; else budget.usedMessage++;
        queued.push({ id: initiative.id, priority, channel: initiative.channel, worthiness: initiative.worthiness });
      }
      return {
        tenantId,
        evaluated: candidates.length,
        queued,
        suppressed,
        digested,
        budget: structuredClone(budget),
        generatedAt: nowIso,
      } satisfies InitiativeEvaluation;
    });
    if (this.hooks.onQueued && evaluation.queued.length) {
      const state = await this.store.read();
      for (const item of evaluation.queued) {
        const initiative = state.initiatives.find((entry) => entry.tenantId === tenantId && entry.id === item.id);
        if (initiative) await this.hooks.onQueued(structuredClone(initiative));
      }
    }
    return evaluation;
  }

  /** Mark a queued initiative as actually delivered on a concrete channel. */
  async markDelivered(tenantId: string, initiativeId: string, channel: string): Promise<Initiative> {
    return await this.store.mutate((state) => {
      const initiative = this.mutableInitiative(state, tenantId, initiativeId);
      if (initiative.state !== "queued") throw new Error("Only queued initiatives can be delivered.");
      const nowIso = new Date(this.now()).toISOString();
      initiative.state = "delivered";
      initiative.deliveredAt = nowIso;
      initiative.deliveredChannel = auroraText(channel, 100, "Delivery channel");
      initiative.updatedAt = nowIso;
      const budget = this.mutableBudget(state, tenantId);
      budget.deliveredTotal++;
      return structuredClone(initiative);
    });
  }

  async dismiss(tenantId: string, initiativeId: string, reason: string): Promise<Initiative> {
    return await this.store.mutate((state) => {
      const initiative = this.mutableInitiative(state, tenantId, initiativeId);
      initiative.state = "dismissed";
      initiative.suppressionReason = auroraText(reason, 500, "Dismiss reason");
      initiative.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(initiative);
    });
  }

  /** Trust preservation: useless notifications reduce trust and therefore raise future thresholds. */
  async recordFeedback(input: { tenantId: string; initiativeId: string; useful: boolean; actedOn: boolean; note?: string }): Promise<{ initiative: Initiative; budget: InitiativeBudget }> {
    return await this.store.mutate((state) => {
      const initiative = this.mutableInitiative(state, input.tenantId, input.initiativeId);
      if (initiative.state !== "delivered" && initiative.state !== "digested") throw new Error("Feedback requires a delivered or digested initiative.");
      const nowIso = new Date(this.now()).toISOString();
      initiative.feedback = {
        useful: input.useful,
        actedOn: input.actedOn,
        ...(input.note ? { note: auroraText(input.note, 2000, "Feedback note") } : {}),
        ratedAt: nowIso,
      };
      initiative.updatedAt = nowIso;
      const budget = this.mutableBudget(state, input.tenantId);
      if (input.useful) budget.usefulTotal++;
      const reward = input.useful ? (input.actedOn ? 1 : 0.75) : 0;
      budget.trustScore = auroraRound(Math.max(0.05, Math.min(1, budget.trustScore * 0.8 + reward * 0.2)));
      return { initiative: structuredClone(initiative), budget: structuredClone(budget) };
    });
  }

  /** Escalate an initiative one priority class with a durable audit trail. */
  async escalate(tenantId: string, initiativeId: string, reason: string): Promise<Initiative> {
    return await this.store.mutate((state) => {
      const initiative = this.mutableInitiative(state, tenantId, initiativeId);
      const index = PRIORITY_ORDER.indexOf(initiative.priority);
      if (index <= 0) throw new Error("Initiative is already at the highest priority class.");
      const target = PRIORITY_ORDER[index - 1]!;
      if (initiative.escalations.length >= 5) throw new Error("Initiative escalation limit reached.");
      const nowIso = new Date(this.now()).toISOString();
      initiative.escalations.push({ from: initiative.priority, to: target, reason: auroraText(reason, 1000, "Escalation reason"), at: nowIso });
      initiative.priority = target;
      initiative.channel = CHANNEL_BY_PRIORITY[target];
      initiative.state = "candidate";
      initiative.updatedAt = nowIso;
      return structuredClone(initiative);
    });
  }

  async initiatives(tenantId: string, filter?: { state?: Initiative["state"]; priority?: InitiativePriority; limit?: number }): Promise<Initiative[]> {
    const state = await this.store.read();
    return state.initiatives
      .filter((item) => item.tenantId === tenantId && (!filter?.state || item.state === filter.state) && (!filter?.priority || item.priority === filter.priority))
      .sort((a, b) => b.worthiness - a.worthiness || b.createdAt.localeCompare(a.createdAt))
      .slice(0, auroraInteger(filter?.limit ?? 200, 1, 1000, "Initiative limit"))
      .map((item) => structuredClone(item));
  }

  // ─── P1.51: durable proactive cycle ───

  /** Every tenant that has proactive state; the tick loop iterates exactly these. */
  async tenants(): Promise<string[]> {
    const state = await this.store.read();
    const ids = new Set<string>();
    for (const item of state.watchers) ids.add(item.tenantId);
    for (const item of state.intake) ids.add(item.tenantId);
    for (const item of state.initiatives) ids.add(item.tenantId);
    ids.delete("");
    return [...ids].sort();
  }

  /**
   * One full proactive cycle for a tenant: run due watchers (their state,
   * cooldowns and dedup live in durable state, so a missed tick costs nothing),
   * evaluate candidates under the attention budget, and build the daily /
   * weekly / monthly digest when a new period has actually started.
   */
  async runProactiveCycle(tenantId: string): Promise<{
    watchers: { matched: Array<{ watcherId: string; initiativeId: string }>; scanned: number };
    evaluation: InitiativeEvaluation;
    digestsBuilt: InitiativeDigest[];
  }> {
    const watchers = await this.runWatchers(tenantId);
    const evaluation = await this.evaluate(tenantId);
    const timestamp = this.now();
    const digestsBuilt: InitiativeDigest[] = [];
    const existing = await this.digests(tenantId);
    const hasPeriod = (period: InitiativeDigest["period"], periodKey: string) =>
      existing.some((digest) => digest.period === period && digest.periodKey === periodKey);
    const dailyKey = auroraDay(timestamp);
    if (!hasPeriod("daily", dailyKey)) digestsBuilt.push(await this.buildDigest(tenantId, "daily"));
    const weeklyKey = auroraWeek(timestamp);
    if (!hasPeriod("weekly", weeklyKey)) digestsBuilt.push(await this.buildDigest(tenantId, "weekly"));
    const monthlyKey = auroraMonth(timestamp);
    if (!hasPeriod("monthly", monthlyKey)) digestsBuilt.push(await this.buildDigest(tenantId, "monthly"));
    return { watchers, evaluation, digestsBuilt };
  }

  // ─── P1.52: communication selector ───

  async setChannelPreferences(tenantId: string, input: { orderedChannels: string[]; destination?: string }): Promise<InitiativeChannelPreferences> {
    return await this.store.mutate((state) => {
      state.channelPreferences = state.channelPreferences ?? [];
      const channels = [...new Set(input.orderedChannels.map((channel) => auroraText(channel, 50, "Channel id")))].slice(0, 10);
      if (!channels.length) throw new Error("Channel preferences need at least one channel.");
      let record = state.channelPreferences.find((item) => item.tenantId === tenantId);
      if (!record) {
        record = { tenantId, orderedChannels: channels };
        state.channelPreferences.push(record);
      }
      record.orderedChannels = channels;
      if (input.destination === undefined) delete record.destination;
      else record.destination = auroraText(input.destination, 500, "Channel destination");
      const preferences: InitiativeChannelPreferences = { orderedChannels: record.orderedChannels, ...(record.destination ? { destination: record.destination } : {}) };
      return structuredClone(preferences);
    });
  }

  async channelPreferences(tenantId: string): Promise<InitiativeChannelPreferences> {
    const state = await this.store.read();
    const record = (state.channelPreferences ?? []).find((item) => item.tenantId === tenantId);
    return record
      ? { orderedChannels: record.orderedChannels, ...(record.destination ? { destination: record.destination } : {}) }
      : { orderedChannels: ["in-app"] };
  }

  /**
   * Pick the delivery channel for a queued initiative: the user's ordered
   * preference intersected with the channels that actually exist right now.
   * "in-app" always exists (it is the product surface itself); nothing else is
   * assumed. Falls back to in-app with the reason stated.
   */
  async selectChannel(tenantId: string, initiativeId: string): Promise<{ channel: string; reason: string; alternatives: string[] }> {
    const state = await this.store.read();
    const initiative = state.initiatives.find((item) => item.tenantId === tenantId && item.id === initiativeId);
    if (!initiative) throw new Error("Initiative not found in tenant.");
    if (initiative.state !== "queued") throw new Error("Only queued initiatives can be routed to a channel.");
    const preferences = await this.channelPreferences(tenantId);
    const available = new Set<string>(["in-app", ...(this.providers.availableChannels?.() ?? [])]);
    const usable = preferences.orderedChannels.filter((channel) => available.has(channel));
    const chosen = usable[0];
    if (!chosen) {
      return { channel: "in-app", reason: `none of the preferred channels (${preferences.orderedChannels.join(", ")}) are available right now; falling back to in-app`, alternatives: [] };
    }
    if (chosen === "in-app") {
      return { channel: "in-app", reason: "in-app is the highest available preference", alternatives: usable.slice(1) };
    }
    return { channel: chosen, reason: `${chosen} is the highest preference that is currently available`, alternatives: usable.slice(1) };
  }

  /** Deliver a queued initiative over its selected channel and record the outcome. */
  async deliver(tenantId: string, initiativeId: string, options: { destination?: string; signal?: AbortSignal } = {}): Promise<Initiative> {
    const routing = await this.selectChannel(tenantId, initiativeId);
    const state = await this.store.read();
    const initiative = state.initiatives.find((item) => item.tenantId === tenantId && item.id === initiativeId);
    if (!initiative) throw new Error("Initiative not found in tenant.");
    if (initiative.state !== "queued") throw new Error("Only queued initiatives can be delivered.");
    if (routing.channel !== "in-app") {
      if (!this.providers.sendChannel) throw new Error(`Channel ${routing.channel} requires a delivery sender, which is not configured.`);
      const destination = options.destination
        ?? (await this.channelPreferences(tenantId)).destination;
      await this.providers.sendChannel(routing.channel, initiative, destination);
    }
    return await this.markDelivered(tenantId, initiativeId, routing.channel);
  }

  // ─── P1.54: user override (kind mute) ───

  async muteKind(tenantId: string, kind: InitiativeKind, until: string, reason?: string): Promise<Array<{ kind: string; until: string }>> {
    return await this.store.mutate((state) => {
      const untilIso = auroraTimestamp(until, this.now(), "Mute until");
      if (Date.parse(untilIso) <= this.now()) throw new Error("Mute end must be in the future.");
      state.mutes = [...(state.mutes ?? []).filter((mute) => !(mute.tenantId === tenantId && mute.kind === kind)), {
        tenantId,
        kind,
        until: untilIso,
        ...(reason ? { reason: auroraText(reason, 1000, "Mute reason") } : {}),
      }];
      return (state.mutes ?? []).filter((mute) => mute.tenantId === tenantId).map((mute) => ({ kind: mute.kind, until: mute.until }));
    });
  }

  async mutes(tenantId: string): Promise<Array<{ kind: InitiativeKind; until: string; reason?: string }>> {
    const state = await this.store.read();
    const timestamp = this.now();
    return (state.mutes ?? [])
      .filter((mute) => mute.tenantId === tenantId && Date.parse(mute.until) > timestamp)
      .map((mute) => ({ kind: mute.kind, until: mute.until, ...(mute.reason ? { reason: mute.reason } : {}) }));
  }

  /** Daily briefing, weekly review or monthly strategic review built from digested initiatives. */
  async buildDigest(tenantId: string, period: InitiativeDigest["period"]): Promise<InitiativeDigest> {
    const digest = await this.store.mutate((state) => {
      if (state.digests.length >= MAX_DIGESTS) state.digests.splice(0, Math.ceil(MAX_DIGESTS * 0.1));
      const timestamp = this.now();
      const nowIso = new Date(timestamp).toISOString();
      const window = period === "daily" ? 86_400_000 : period === "weekly" ? 7 * 86_400_000 : 30 * 86_400_000;
      const items = state.initiatives.filter((item) => item.tenantId === tenantId
        && ["digested", "queued", "delivered"].includes(item.state)
        && timestamp - Date.parse(item.createdAt) <= window);
      const grouping: Record<string, string[]> = { Risks: [], Opportunities: [], Reminders: [], Insights: [], Interventions: [] };
      for (const item of items.sort((a, b) => b.worthiness - a.worthiness)) {
        const heading = item.kind === "risk" ? "Risks" : item.kind === "opportunity" ? "Opportunities" : item.kind === "reminder" ? "Reminders" : item.kind === "intervention" ? "Interventions" : "Insights";
        grouping[heading]!.push(`[${item.priority} · ${item.worthiness}] ${item.title}`);
      }
      const digest: InitiativeDigest = {
        id: `digest-${randomUUID()}`,
        tenantId,
        period,
        periodKey: period === "daily" ? auroraDay(timestamp) : period === "weekly" ? auroraWeek(timestamp) : auroraMonth(timestamp),
        title: period === "daily" ? "Daily briefing" : period === "weekly" ? "Weekly review" : "Monthly strategic review",
        initiativeIds: items.map((item) => item.id),
        sections: Object.entries(grouping).filter(([, values]) => values.length > 0).map(([heading, values]) => ({ heading, items: values.slice(0, 50) })),
        createdAt: nowIso,
      };
      state.digests.push(digest);
      return digest;
    });
    // P1.53: briefing sections sourced from live subsystems (project risks,
    // goal changes, memory changes). Providers answer inside their own store
    // transaction above is NOT required — they run after the digest exists and
    // the digest is amended once with their real, current answers. A provider
    // that returns nothing contributes no section, never a placeholder.
    if (this.providers.digestSections?.length) {
      for (const section of this.providers.digestSections) {
        let items: string[] = [];
        try {
          items = (await section.items(tenantId)).slice(0, 50);
        } catch {
          continue; // a broken provider must not break the briefing
        }
        if (!items.length) continue;
        await this.store.mutate((state) => {
          const target = state.digests.find((entry) => entry.id === digest.id);
          if (!target) return;
          target.sections = [...target.sections.filter((existing) => existing.heading !== section.heading), { heading: section.heading, items }];
        });
        digest.sections = [...digest.sections.filter((existing) => existing.heading !== section.heading), { heading: section.heading, items }];
      }
    }
    return structuredClone(digest);
  }

  async digests(tenantId: string, period?: InitiativeDigest["period"]): Promise<InitiativeDigest[]> {
    const state = await this.store.read();
    return state.digests
      .filter((item) => item.tenantId === tenantId && (!period || item.period === period))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => structuredClone(item));
  }

  private buildInitiative(
    state: InitiativeStateShape,
    input: {
      tenantId: string; kind: InitiativeKind; mode: InitiativeMode; title: string; message: string;
      importance: number; urgency: number; impact: number; confidence: number; userRelevance: number;
      goalAlignment?: number; intakeEventIds: string[]; watcherId?: string; evidenceRefs: string[]; expiresAt?: string;
    },
    timestamp: number,
  ): Initiative | undefined {
    if (state.initiatives.length >= MAX_INITIATIVES) throw new Error("Initiative limit reached.");
    const nowIso = new Date(timestamp).toISOString();
    const title = auroraText(input.title, 300, "Initiative title");
    const message = auroraText(input.message, 20_000, "Initiative message");
    const dedupeDigest = auroraDigest(`${input.kind}:${title.toLowerCase()}`);
    const duplicate = state.initiatives.find((item) => item.tenantId === input.tenantId && item.dedupeDigest === dedupeDigest
      && timestamp - Date.parse(item.createdAt) < DUPLICATE_WINDOW_MS && item.state !== "dismissed");
    if (duplicate) return undefined;
    const importance = auroraUnit(input.importance, "Initiative importance");
    const urgency = auroraUnit(input.urgency, "Initiative urgency");
    const impact = auroraUnit(input.impact, "Initiative impact");
    const confidence = auroraUnit(input.confidence, "Initiative confidence");
    const relevance = auroraUnit(input.userRelevance, "Initiative user relevance");
    const alignment = auroraUnit(input.goalAlignment ?? relevance, "Initiative goal alignment");
    const initiative: Initiative = {
      id: `init-${randomUUID()}`,
      tenantId: input.tenantId,
      kind: input.kind,
      mode: input.mode,
      title,
      message,
      importance,
      urgency,
      impact,
      confidence,
      userRelevance: relevance,
      worthiness: auroraRound(importance * urgency * impact * confidence * relevance),
      goalAlignment: alignment,
      priority: "P3",
      channel: "weekly-digest",
      state: "candidate",
      escalations: [],
      intakeEventIds: auroraIds(input.intakeEventIds, 100, "Initiative intake IDs"),
      ...(input.watcherId ? { watcherId: input.watcherId } : {}),
      evidenceRefs: auroraIds(input.evidenceRefs, 200, "Initiative evidence refs"),
      dedupeDigest,
      ...(input.expiresAt ? { expiresAt: auroraTimestamp(input.expiresAt, timestamp, "Initiative expiry") } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    state.initiatives.push(initiative);
    return initiative;
  }

  /** The classify() arithmetic, extracted so the decision trace can quote it. */
  private effectiveScore(initiative: Initiative, _trustFactor: number): number {
    const score = initiative.worthiness * (0.5 + initiative.goalAlignment / 2);
    const guardianBoost = initiative.mode === "guardian" && initiative.kind === "risk" ? 1.25 : 1;
    return auroraRound(score * guardianBoost);
  }

  private classify(initiative: Initiative, budget: InitiativeBudget, trustFactor: number): InitiativePriority {
    const score = initiative.worthiness * (0.5 + initiative.goalAlignment / 2);
    const guardianBoost = initiative.mode === "guardian" && initiative.kind === "risk" ? 1.25 : 1;
    const effective = score * guardianBoost;
    if (effective >= budget.minWorthinessP0 * trustFactor) return "P0";
    if (effective >= budget.minWorthinessP1 * trustFactor) return "P1";
    if (effective >= budget.minWorthinessP2 * trustFactor) return "P2";
    if (effective >= budget.minWorthinessP2 * trustFactor * 0.25) return "P3";
    return "P4";
  }

  private inQuietHours(budget: InitiativeBudget, timestamp: number): boolean {
    if (!budget.quietHoursUtc) return false;
    const hour = new Date(timestamp).getUTCHours();
    const { startHour, endHour } = budget.quietHoursUtc;
    return startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
  }

  private mutableBudget(state: InitiativeStateShape, tenantId: string): InitiativeBudget {
    let budget = state.budgets.find((item) => item.tenantId === tenantId);
    if (!budget) {
      budget = {
        tenantId,
        date: auroraDay(this.now()),
        dailyImmediateLimit: 3,
        dailyMessageLimit: 5,
        usedImmediate: 0,
        usedMessage: 0,
        minWorthinessP0: 0.35,
        minWorthinessP1: 0.15,
        minWorthinessP2: 0.05,
        quietHoursUtc: null,
        trustScore: 0.7,
        deliveredTotal: 0,
        usefulTotal: 0,
      };
      state.budgets.push(budget);
    }
    const today = auroraDay(this.now());
    if (budget.date !== today) {
      budget.date = today;
      budget.usedImmediate = 0;
      budget.usedMessage = 0;
    }
    return budget;
  }

  private mutableWatcher(state: InitiativeStateShape, tenantId: string, id: string): InitiativeWatcher {
    const watcher = state.watchers.find((item) => item.tenantId === tenantId && item.id === id);
    if (!watcher) throw new Error("Initiative watcher not found in tenant.");
    return watcher;
  }

  private mutableInitiative(state: InitiativeStateShape, tenantId: string, id: string): Initiative {
    const initiative = state.initiatives.find((item) => item.tenantId === tenantId && item.id === id);
    if (!initiative) throw new Error("Initiative not found in tenant.");
    return initiative;
  }
}
