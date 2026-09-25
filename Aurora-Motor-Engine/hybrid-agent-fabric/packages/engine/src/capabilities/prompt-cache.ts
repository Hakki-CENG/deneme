import { z } from "zod";
import type { PromptCacheService } from "../prompt-cache/prompt-cache-service.js";
import { defineCapability } from "./schema.js";

/**
 * Prompt-cache visibility and control as capabilities.
 *
 * `session.cache.plan` answers "what did the last request pay for, and would
 * the next one hit cache?" from durable evidence. `session.cache.config`
 * changes the per-session cache policy (enable/disable, TTL), which is why it
 * carries the same `privileged` risk class as `session.mode.set`: a marker
 * placed at the wrong boundary changes what a request costs.
 */
export function promptCacheCapabilities(promptCache: PromptCacheService) {
  return [
    defineCapability(
      {
        id: "session.cache.plan",
        version: "1.0.0",
        description: "The prompt-cache plan for this session: stable and volatile regions, breakpoint markers, whether the last request hit or missed cache, and the durable history.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({ limit: z.number().int().min(1).max(50).optional() }),
      async (input, context) => {
        const latest = await promptCache.latest(context.tenantId, context.sessionId);
        return {
          latest,
          history: await promptCache.list({
            tenantId: context.tenantId,
            sessionId: context.sessionId,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          }),
        };
      },
    ),
    defineCapability(
      {
        id: "session.cache.config",
        version: "1.0.0",
        description: "Enable or disable prompt-cache markers for this session and choose the TTL (5m or 1h). The managed configuration floor still applies.",
        risk: "privileged",
        sideEffect: true,
        source: "core",
      },
      z.object({
        enabled: z.boolean().optional(),
        ttlMs: z.union([z.literal(300_000), z.literal(3_600_000)]).optional(),
      }),
      async (input, context) => await promptCache.config(context.tenantId, context.sessionId, {
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      }),
    ),
  ];
}
