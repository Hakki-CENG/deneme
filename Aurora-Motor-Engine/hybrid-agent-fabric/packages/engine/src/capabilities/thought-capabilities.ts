import type { Capability } from "../types.js";
import type { ThoughtCoreService } from "../thought/thought-core-service.js";
import type { BackgroundThinkingService } from "../thought/background-thinking-service.js";
import { z } from "zod";
import { defineCapability } from "./schema.js";

export interface ThoughtCapabilitiesOptions {
  thoughtCore: ThoughtCoreService;
  backgroundThinking: BackgroundThinkingService;
}

// Basic thought capabilities using defineCapability helper

const thoughtCreateCapability = (options: ThoughtCapabilitiesOptions): Capability =>
  defineCapability(
    {
      id: "thought.create",
      version: "1.0.0",
      description: "Create a new thought",
      risk: "workspace_write",
      sideEffect: true,
      source: "core",
    },
    z.object({
      tenantId: z.string(),
      title: z.string(),
      content: z.string(),
      type: z.enum(["problem", "hypothesis", "insight", "question", "opportunity", "risk", "decision"]),
      sourceType: z.enum(["user", "agent", "event", "memory", "system"]),
      priority: z.enum(["P0", "P1", "P2", "P3", "P4"]).optional(),
      importance: z.number().min(0).max(1).optional(),
      urgency: z.number().min(0).max(1).optional(),
      impact: z.number().min(0).max(1).optional(),
      confidence: z.number().min(0).max(1).optional(),
      userRelevance: z.number().min(0).max(1).optional(),
      tags: z.array(z.string()).optional(),
    }),
    async (input) => {
      const thought = await options.thoughtCore.createThought({
        tenantId: input.tenantId,
        title: input.title,
        content: input.content,
        type: input.type,
        sourceType: input.sourceType,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.importance !== undefined ? { importance: input.importance } : {}),
        ...(input.urgency !== undefined ? { urgency: input.urgency } : {}),
        ...(input.impact !== undefined ? { impact: input.impact } : {}),
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(input.userRelevance !== undefined ? { userRelevance: input.userRelevance } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      });
      return { thought };
    },
  );

const thoughtListCapability = (options: ThoughtCapabilitiesOptions): Capability =>
  defineCapability(
    {
      id: "thought.list",
      version: "1.0.0",
      description: "List thoughts",
      risk: "workspace_read",
      sideEffect: false,
      source: "core",
    },
    z.object({
      tenantId: z.string(),
      limit: z.number().min(1).max(1000).optional(),
    }),
    async (input) => {
      const thoughts = await options.thoughtCore.listThoughts(input.tenantId, {
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return { thoughts };
    },
  );

const thoughtMetricsCapability = (options: ThoughtCapabilitiesOptions): Capability =>
  defineCapability(
    {
      id: "thought.metrics",
      version: "1.0.0",
      description: "Get thought system metrics",
      risk: "workspace_read",
      sideEffect: false,
      source: "core",
    },
    z.object({
      tenantId: z.string(),
    }),
    async (input) => {
      const metrics = await options.thoughtCore.getMetrics(input.tenantId);
      return { metrics };
    },
  );

const backgroundThinkingRunCycleCapability = (options: ThoughtCapabilitiesOptions): Capability =>
  defineCapability(
    {
      id: "backgroundThinking.runCycle",
      version: "1.0.0",
      description: "Run a background thinking cycle",
      risk: "workspace_read",
      sideEffect: false,
      source: "core",
    },
    z.object({
      tenantId: z.string(),
    }),
    async (input) => {
      const result = await options.thoughtCore.runBackgroundThinking(input.tenantId);
      return result;
    },
  );

const backgroundThinkingScanMemoryCapability = (options: ThoughtCapabilitiesOptions): Capability =>
  defineCapability(
    {
      id: "backgroundThinking.scanMemory",
      version: "1.0.0",
      description: "Scan memory for connections",
      risk: "workspace_read",
      sideEffect: false,
      source: "core",
    },
    z.object({
      tenantId: z.string(),
    }),
    async (input) => {
      const result = await options.backgroundThinking.scanMemoryForConnections(input.tenantId);
      return result;
    },
  );

export const thoughtCapabilities = (options: ThoughtCapabilitiesOptions): Capability[] => [
  thoughtCreateCapability(options),
  thoughtListCapability(options),
  thoughtMetricsCapability(options),
  backgroundThinkingRunCycleCapability(options),
  backgroundThinkingScanMemoryCapability(options),
];

export const thoughtCapabilityIds = thoughtCapabilities({} as ThoughtCapabilitiesOptions).map((c) => c.descriptor.id);
