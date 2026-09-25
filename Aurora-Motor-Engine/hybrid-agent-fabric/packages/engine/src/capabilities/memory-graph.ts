import { z } from "zod";
import type { MemoryGraphService } from "../memory/memory-graph-service.js";
import { defineCapability } from "./schema.js";

const unit = z.number().min(0).max(1);
const layer = z.enum(["working", "session", "episodic", "semantic", "procedural", "user", "palace"]);
const claimType = z.enum(["observation", "inference", "hypothesis", "prediction"]);
const relationType = z.enum(["relates", "causes", "supports", "contradicts", "part-of", "derived-from", "precedes"]);

/** Aurora Phase C capabilities: typed memory pyramid, relation graph, consolidation and thought anchors. */
export function memoryGraphCapabilities(service: MemoryGraphService) {
  return [
    defineCapability(
      { id: "memory.graph.remember", version: "1.0.0", description: "Store an Aurora memory object with layer, claim type, source, confidence, importance, tags and temporal validity. Identical content reinforces the existing object instead of duplicating it.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({
        layer, claimType, title: z.string().min(1).max(500), content: z.string().min(1).max(100_000),
        sourceType: z.enum(["user", "agent", "event", "memory", "system", "external"]), sourceId: z.string().max(300).optional(),
        confidence: unit, importance: unit, emotionalImpact: unit.optional(), tags: z.array(z.string()).max(100).optional(),
        goalIds: z.array(z.string()).max(50).optional(), userId: z.string().max(200).optional(),
        validFrom: z.string().datetime().optional(), validTo: z.string().datetime().optional(),
        evidenceRefs: z.array(z.string()).max(200).optional(), relatedMemoryIds: z.array(z.string()).max(50).optional(),
      }),
      async (input, context) => await service.remember({
        tenantId: context.tenantId, sessionId: context.sessionId, layer: input.layer, claimType: input.claimType,
        title: input.title, content: input.content, sourceType: input.sourceType, confidence: input.confidence, importance: input.importance,
        ...(input.sourceId ? { sourceId: input.sourceId } : {}), ...(input.emotionalImpact !== undefined ? { emotionalImpact: input.emotionalImpact } : {}),
        ...(input.tags ? { tags: input.tags } : {}), ...(input.goalIds ? { goalIds: input.goalIds } : {}), ...(input.userId ? { userId: input.userId } : {}),
        ...(input.validFrom ? { validFrom: input.validFrom } : {}), ...(input.validTo ? { validTo: input.validTo } : {}),
        ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}), ...(input.relatedMemoryIds ? { relatedMemoryIds: input.relatedMemoryIds } : {}),
      }),
    ),
    defineCapability(
      { id: "memory.graph.recall", version: "1.0.0", description: "Multi-strategy recall over the Aurora memory pyramid: semantic, graph, temporal, goal-scoped or user-scoped.", risk: "pure", sideEffect: false, source: "core" },
      z.object({
        query: z.string().min(1).max(2000), strategy: z.enum(["semantic", "graph", "temporal", "goal", "user"]).optional(),
        layers: z.array(layer).max(7).optional(), claimTypes: z.array(claimType).max(4).optional(), minConfidence: unit.optional(),
        goalId: z.string().optional(), userId: z.string().optional(), at: z.string().datetime().optional(),
        seedMemoryId: z.string().optional(), limit: z.number().int().min(1).max(100).optional(),
      }),
      async (input, context) => ({
        results: await service.recall(context.tenantId, input.query, {
          ...(input.strategy ? { strategy: input.strategy } : {}), ...(input.layers ? { layers: input.layers } : {}),
          ...(input.claimTypes ? { claimTypes: input.claimTypes } : {}), ...(input.minConfidence !== undefined ? { minConfidence: input.minConfidence } : {}),
          ...(input.goalId ? { goalId: input.goalId } : {}), ...(input.userId ? { userId: input.userId } : {}),
          ...(input.at ? { at: input.at } : {}), ...(input.seedMemoryId ? { seedMemoryId: input.seedMemoryId } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        }),
      }),
    ),
    defineCapability(
      { id: "memory.graph.relate", version: "1.0.0", description: "Create or strengthen a typed relation between two memory objects. Contradiction edges also flag both objects for memory health.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ fromId: z.string(), toId: z.string(), type: relationType, strength: unit.optional(), evidenceRefs: z.array(z.string()).max(200).optional() }),
      async (input, context) => await service.relate({
        tenantId: context.tenantId, fromId: input.fromId, toId: input.toId, type: input.type,
        ...(input.strength !== undefined ? { strength: input.strength } : {}), ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
      }),
    ),
    defineCapability(
      { id: "memory.graph.neighborhood", version: "1.0.0", description: "Bounded knowledge-graph traversal around one memory object.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ memoryId: z.string(), depth: z.number().int().min(1).max(4).optional(), limit: z.number().int().min(1).max(500).optional() }),
      async (input, context) => await service.neighborhood(context.tenantId, input.memoryId, input.depth ?? 1, input.limit ?? 50),
    ),
    defineCapability(
      { id: "memory.graph.consolidate", version: "1.0.0", description: "Sleep-like consolidation: compress near-duplicate memories in one layer into a summary object, archive the sources and strengthen their relations.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ layer: layer.optional(), similarityThreshold: unit.optional(), minClusterSize: z.number().int().min(2).max(100).optional(), maxClusters: z.number().int().min(1).max(200).optional() }),
      async (input, context) => await service.consolidate(context.tenantId, {
        ...(input.layer ? { layer: input.layer } : {}), ...(input.similarityThreshold !== undefined ? { similarityThreshold: input.similarityThreshold } : {}),
        ...(input.minClusterSize !== undefined ? { minClusterSize: input.minClusterSize } : {}), ...(input.maxClusters !== undefined ? { maxClusters: input.maxClusters } : {}),
      }),
    ),
    defineCapability(
      { id: "memory.graph.health", version: "1.0.0", description: "Memory health audit: staleness, contradictions, low usage, low confidence, expiry and duplicate clusters.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, context) => await service.health(context.tenantId),
    ),
    defineCapability(
      { id: "memory.graph.contradictions", version: "1.0.0", description: "Scan active memories for overlapping claims with opposite polarity and record contradiction edges.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ similarityThreshold: unit.optional() }),
      async (input, context) => ({ contradictions: await service.detectContradictions(context.tenantId, input.similarityThreshold === undefined ? {} : { similarityThreshold: input.similarityThreshold }) }),
    ),
    defineCapability(
      { id: "memory.graph.supersede", version: "1.0.0", description: "Replace an outdated memory with a newer one while preserving provenance and temporal history.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ memoryId: z.string(), replacementId: z.string() }),
      async (input, context) => await service.supersede(context.tenantId, input.memoryId, input.replacementId),
    ),
    defineCapability(
      { id: "memory.anchor.create", version: "1.0.0", description: "Open a long-term thought anchor so Aurora can track an unsolved problem across months.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ title: z.string().min(1).max(300), question: z.string().min(1).max(5000), importance: unit, confidence: unit.optional(), nextStep: z.string().min(1).max(2000), reviewIntervalDays: z.number().int().min(1).max(365).optional(), memoryIds: z.array(z.string()).max(500).optional() }),
      async (input, context) => await service.createAnchor({
        tenantId: context.tenantId, title: input.title, question: input.question, importance: input.importance, nextStep: input.nextStep,
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}), ...(input.reviewIntervalDays !== undefined ? { reviewIntervalDays: input.reviewIntervalDays } : {}),
        ...(input.memoryIds ? { memoryIds: input.memoryIds } : {}),
      }),
    ),
    defineCapability(
      { id: "memory.anchor.progress", version: "1.0.0", description: "Append an evidence-bound finding to a thought anchor and schedule its next review.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ anchorId: z.string(), summary: z.string().min(1).max(10_000), confidence: unit, memoryIds: z.array(z.string()).max(200).optional(), nextStep: z.string().max(2000).optional(), status: z.enum(["active", "paused", "resolved", "abandoned"]).optional() }),
      async (input, context) => await service.recordAnchorProgress({
        tenantId: context.tenantId, anchorId: input.anchorId, summary: input.summary, confidence: input.confidence,
        ...(input.memoryIds ? { memoryIds: input.memoryIds } : {}), ...(input.nextStep ? { nextStep: input.nextStep } : {}), ...(input.status ? { status: input.status } : {}),
      }),
    ),
    defineCapability(
      { id: "memory.anchor.due", version: "1.0.0", description: "List thought anchors whose review window has elapsed.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, context) => ({ anchors: await service.dueAnchors(context.tenantId) }),
    ),
  ];
}
