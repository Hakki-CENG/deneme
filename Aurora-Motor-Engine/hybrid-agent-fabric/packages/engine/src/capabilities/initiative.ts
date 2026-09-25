import { z } from "zod";
import type { ProactiveInitiativeService } from "../initiative/proactive-initiative-service.js";
import { defineCapability } from "./schema.js";

const unit = z.number().min(0).max(1);
const source = z.enum(["memory", "world-model", "git", "calendar", "filesystem", "weather", "research", "location", "notification", "cognitive", "society", "skill", "system", "tasks", "schedules"]);
const kind = z.enum(["opportunity", "risk", "reminder", "insight", "intervention", "briefing"]);

/** Aurora Phase E capabilities: watchers, worthiness scoring, attention budget, digests and trust feedback. */
export function initiativeCapabilities(service: ProactiveInitiativeService) {
  return [
    defineCapability(
      { id: "initiative.watcher.register", version: "1.0.0", description: "Register a bounded research/project/skill/risk watcher that turns intake events into initiative candidates.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ kind: z.enum(["research", "project", "skill", "risk", "opportunity", "pattern", "schedule"]), name: z.string().min(1).max(200), target: z.string().min(1).max(1000), keywords: z.array(z.string()).max(100).optional(), intervalMinutes: z.number().int().min(1).max(43_200).optional(), mode: z.enum(["guardian", "assistant"]).optional(), minWorthiness: unit.optional() }),
      async (input, ctx) => await service.registerWatcher({
        tenantId: ctx.tenantId, kind: input.kind, name: input.name, target: input.target,
        ...(input.keywords ? { keywords: input.keywords } : {}), ...(input.intervalMinutes !== undefined ? { intervalMinutes: input.intervalMinutes } : {}),
        ...(input.mode ? { mode: input.mode } : {}), ...(input.minWorthiness !== undefined ? { minWorthiness: input.minWorthiness } : {}),
      }),
    ),
    defineCapability(
      { id: "initiative.watchers.list", version: "1.0.0", description: "List initiative watchers with their match counts.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => ({ watchers: await service.watchers(ctx.tenantId) }),
    ),
    defineCapability(
      { id: "initiative.intake", version: "1.0.0", description: "Record a proactive intake event (memory, world model, git, calendar, files, research, notifications). Payloads are stored as digests, not raw content.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ source, summary: z.string().min(1).max(5000), occurredAt: z.string().datetime().optional(), tags: z.array(z.string()).max(100).optional(), entityRefs: z.array(z.string()).max(50).optional() }),
      async (input, ctx) => await service.ingest({
        tenantId: ctx.tenantId, source: input.source, summary: input.summary,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}), ...(input.tags ? { tags: input.tags } : {}), ...(input.entityRefs ? { entityRefs: input.entityRefs } : {}),
      }),
    ),
    defineCapability(
      { id: "initiative.watchers.run", version: "1.0.0", description: "Run due watchers against unprocessed intake events and open initiative candidates.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.runWatchers(ctx.tenantId),
    ),
    defineCapability(
      { id: "initiative.propose", version: "1.0.0", description: "Propose an initiative candidate with importance, urgency, impact, confidence and user relevance. Proposing never notifies the user by itself.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ kind, title: z.string().min(1).max(300), message: z.string().min(1).max(20_000), importance: unit, urgency: unit, impact: unit, confidence: unit, userRelevance: unit, goalAlignment: unit.optional(), mode: z.enum(["guardian", "assistant"]).optional(), intakeEventIds: z.array(z.string()).max(100).optional(), evidenceRefs: z.array(z.string()).max(200).optional(), expiresAt: z.string().datetime().optional() }),
      async (input, ctx) => await service.propose({
        tenantId: ctx.tenantId, kind: input.kind, title: input.title, message: input.message, importance: input.importance, urgency: input.urgency,
        impact: input.impact, confidence: input.confidence, userRelevance: input.userRelevance,
        ...(input.goalAlignment !== undefined ? { goalAlignment: input.goalAlignment } : {}), ...(input.mode ? { mode: input.mode } : {}),
        ...(input.intakeEventIds ? { intakeEventIds: input.intakeEventIds } : {}), ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      }),
    ),
    defineCapability(
      { id: "initiative.evaluate", version: "1.0.0", description: "Classify candidates into P0-P4, apply attention budget, quiet hours, duplicate suppression and silence rules, and decide channels.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.evaluate(ctx.tenantId),
    ),
    defineCapability(
      { id: "initiative.list", version: "1.0.0", description: "List initiatives with worthiness, priority class, channel and delivery state.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ state: z.enum(["candidate", "queued", "delivered", "suppressed", "digested", "expired", "dismissed"]).optional(), priority: z.enum(["P0", "P1", "P2", "P3", "P4"]).optional(), limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ initiatives: await service.initiatives(ctx.tenantId, { ...(input.state ? { state: input.state } : {}), ...(input.priority ? { priority: input.priority } : {}), ...(input.limit ? { limit: input.limit } : {}) }) }),
    ),
    defineCapability(
      { id: "initiative.delivered", version: "1.0.0", description: "Mark a queued initiative as delivered on a concrete channel.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ initiativeId: z.string(), channel: z.string().min(1).max(100) }),
      async (input, ctx) => await service.markDelivered(ctx.tenantId, input.initiativeId, input.channel),
    ),
    defineCapability(
      { id: "initiative.feedback", version: "1.0.0", description: "Record user feedback on a notification; useless notifications lower trust and raise future thresholds.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ initiativeId: z.string(), useful: z.boolean(), actedOn: z.boolean(), note: z.string().max(2000).optional() }),
      async (input, ctx) => await service.recordFeedback({ tenantId: ctx.tenantId, initiativeId: input.initiativeId, useful: input.useful, actedOn: input.actedOn, ...(input.note ? { note: input.note } : {}) }),
    ),
    defineCapability(
      { id: "initiative.escalate", version: "1.0.0", description: "Escalate an initiative one priority class with a durable reason.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ initiativeId: z.string(), reason: z.string().min(1).max(1000) }),
      async (input, ctx) => await service.escalate(ctx.tenantId, input.initiativeId, input.reason),
    ),
    defineCapability(
      { id: "initiative.digest", version: "1.0.0", description: "Build the daily briefing, weekly review or monthly strategic review from digested initiatives.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ period: z.enum(["daily", "weekly", "monthly"]) }),
      async (input, ctx) => await service.buildDigest(ctx.tenantId, input.period),
    ),
    defineCapability(
      { id: "initiative.channel.preferences", version: "1.0.0", description: "Set the ordered channel preference used to route queued initiatives (in-app, telegram, email, …). The first available preference wins; in-app always exists.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ orderedChannels: z.array(z.string().min(1).max(50)).min(1).max(10), destination: z.string().min(1).max(500).optional() }),
      async (input, ctx) => await service.setChannelPreferences(ctx.tenantId, { orderedChannels: input.orderedChannels, ...(input.destination ? { destination: input.destination } : {}) }),
    ),
    defineCapability(
      { id: "initiative.channel.select", version: "1.0.0", description: "Select the delivery channel for a queued initiative from the user's preference and the channels that currently exist, with the reason stated.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ initiativeId: z.string().min(1) }),
      async (input, ctx) => await service.selectChannel(ctx.tenantId, input.initiativeId),
    ),
    defineCapability(
      { id: "initiative.deliver", version: "1.0.0", description: "Deliver a queued initiative over its selected channel and record the delivery. In-app delivery needs no outbound sender; every other channel requires a configured adapter.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ initiativeId: z.string().min(1), destination: z.string().min(1).max(500).optional() }),
      async (input, ctx) => await service.deliver(ctx.tenantId, input.initiativeId, ...(input.destination ? [{ destination: input.destination }] : [])),
    ),
    defineCapability(
      { id: "initiative.mute", version: "1.0.0", description: "Mute one initiative kind until a deadline (user override, P1.54). Muted kinds are archived, never delivered; expired mutes lapse automatically.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ kind, until: z.string().datetime(), reason: z.string().max(1000).optional() }),
      async (input, ctx) => await service.muteKind(ctx.tenantId, input.kind, input.until, ...(input.reason ? [input.reason] : [])),
    ),
    defineCapability(
      { id: "initiative.mutes.list", version: "1.0.0", description: "List the active initiative-kind mutes for this tenant.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => ({ mutes: await service.mutes(ctx.tenantId) }),
    ),
    defineCapability(
      { id: "initiative.cycle.run", version: "1.0.0", description: "Run one full proactive cycle now: due watchers, attention-budget evaluation and period digests. The same cycle the durable timer runs on an interval.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.runProactiveCycle(ctx.tenantId),
    ),
    defineCapability(
      { id: "initiative.budget.get", version: "1.0.0", description: "Read the proactive attention budget, thresholds, quiet hours and trust score.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.budget(ctx.tenantId),
    ),
    defineCapability(
      { id: "initiative.budget.configure", version: "1.0.0", description: "Configure daily notification limits, worthiness thresholds and quiet hours.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ dailyImmediateLimit: z.number().int().min(0).max(100).optional(), dailyMessageLimit: z.number().int().min(0).max(200).optional(), minWorthinessP0: unit.optional(), minWorthinessP1: unit.optional(), minWorthinessP2: unit.optional(), quietHoursUtc: z.object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) }).nullable().optional() }),
      async (input, ctx) => await service.configureBudget({
        tenantId: ctx.tenantId,
        ...(input.dailyImmediateLimit !== undefined ? { dailyImmediateLimit: input.dailyImmediateLimit } : {}),
        ...(input.dailyMessageLimit !== undefined ? { dailyMessageLimit: input.dailyMessageLimit } : {}),
        ...(input.minWorthinessP0 !== undefined ? { minWorthinessP0: input.minWorthinessP0 } : {}),
        ...(input.minWorthinessP1 !== undefined ? { minWorthinessP1: input.minWorthinessP1 } : {}),
        ...(input.minWorthinessP2 !== undefined ? { minWorthinessP2: input.minWorthinessP2 } : {}),
        ...(input.quietHoursUtc !== undefined ? { quietHoursUtc: input.quietHoursUtc } : {}),
      }),
    ),
  ];
}
