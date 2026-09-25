import { z } from "zod";
import type { ResearchEngineService } from "../research/research-engine-service.js";
import { defineCapability } from "./schema.js";

/**
 * Research Director surface (P1.40–P1.43): question → search → collect →
 * compare → verify → synthesize → cite → report → remember, plus watchers
 * that follow topics/projects/repositories/papers/technologies.
 */
export function researchCapabilities(engine: ResearchEngineService) {
  return [
    defineCapability(
      {
        id: "research.query",
        version: "1.0.0",
        description:
          "Run a research pass: search configured backends, fetch and extract sources, deduplicate, score trust/freshness, extract citation quotes with verified spans and detect contradictions. Web scope leaves the machine through the configured search provider.",
        risk: "network",
        sideEffect: false,
        source: "core",
      },
      z.object({
        question: z.string().min(1).max(2000),
        scope: z.enum(["academic", "web", "internal", "hybrid"]).default("hybrid"),
        maxSources: z.number().int().min(1).max(30).optional(),
        minTrustScore: z.number().min(0).max(1).optional(),
        dateFrom: z.string().datetime().optional(),
        dateTo: z.string().datetime().optional(),
        remember: z.boolean().default(false),
      }),
      async ({ question, scope, maxSources, minTrustScore, dateFrom, dateTo, remember }, context) =>
        await engine.research(
          context.tenantId,
          question,
          scope,
          {
            ...(maxSources ? { maxResults: maxSources } : {}),
            ...(minTrustScore !== undefined ? { minTrustScore } : {}),
            ...(dateFrom || dateTo ? { dateRange: { ...(dateFrom ? { from: dateFrom } : {}), ...(dateTo ? { to: dateTo } : {}) } } : {}),
          },
          { remember },
        ),
    ),
    defineCapability(
      {
        id: "research.report",
        version: "1.0.0",
        description:
          "Synthesize a research report from a completed result: every factual finding is a quoted span bound to a source citation; unsupported findings are counted, not written.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({
        resultId: z.string().min(1),
        title: z.string().min(1).max(500).optional(),
      }),
      async ({ resultId, title }) => await engine.generateReport(resultId, title),
    ),
    defineCapability(
      {
        id: "research.remember",
        version: "1.0.0",
        description:
          "Persist a research result into long-term memory with its citations as evidence refs and the top source as provenance (P1.41 citation preservation).",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({ resultId: z.string().min(1) }),
      async ({ resultId }, context) => await engine.rememberResult(context.tenantId, resultId),
    ),
    defineCapability(
      {
        id: "research.watcher.add",
        version: "1.0.0",
        description: "Follow a topic, project, repository, paper or technology by observing a search query or an https URL on an interval.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({
        kind: z.enum(["topic", "project", "repository", "paper", "technology"]),
        name: z.string().min(1).max(200),
        query: z.string().min(1).max(500).optional(),
        targetUrl: z.string().url().optional(),
        keywords: z.array(z.string().min(1).max(100)).max(20).optional(),
        intervalMinutes: z.number().int().min(5).max(43_200).optional(),
      }),
      async (input, context) => await engine.addWatcher({
        tenantId: context.tenantId,
        kind: input.kind,
        name: input.name,
        ...(input.query ? { query: input.query } : {}),
        ...(input.targetUrl ? { targetUrl: input.targetUrl } : {}),
        ...(input.keywords ? { keywords: input.keywords } : {}),
        ...(input.intervalMinutes ? { intervalMinutes: input.intervalMinutes } : {}),
      }),
    ),
    defineCapability(
      {
        id: "research.watcher.list",
        version: "1.0.0",
        description: "List research watchers with their last snapshot state and change counters.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      async (_input, context) => ({ watchers: await engine.watchers(context.tenantId) }),
    ),
    defineCapability(
      {
        id: "research.watcher.remove",
        version: "1.0.0",
        description: "Stop following a watched topic/URL.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({ watcherId: z.string().min(1) }),
      async ({ watcherId }, context) => await engine.removeWatcher(context.tenantId, watcherId),
    ),
    defineCapability(
      {
        id: "research.watcher.run",
        version: "1.0.0",
        description:
          "Check due watchers now: materialise the observed surface, compare fingerprints against the previous snapshot and propose an initiative for real changes (the proactive attention budget decides delivery).",
        risk: "network",
        sideEffect: true,
        source: "core",
      },
      z.object({
        watcherId: z.string().min(1).optional(),
        force: z.boolean().default(false),
      }),
      async ({ watcherId, force }, context) => ({
        outcomes: await engine.runWatchers(context.tenantId, {
          ...(watcherId ? { watcherId } : {}),
          force,
        }),
      }),
    ),
  ];
}
