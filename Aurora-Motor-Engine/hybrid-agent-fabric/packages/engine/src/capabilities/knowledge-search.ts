import { z } from "zod";
import type { HybridSearchIndex } from "../search/hybrid-index.js";
import { defineCapability } from "./schema.js";

export function knowledgeSearchCapability(index: HybridSearchIndex) {
  return defineCapability(
    {
      id: "knowledge.search",
      version: "1.0.0",
      description: "Hybrid BM25/vector search across indexed session messages, memories, skills and artifacts.",
      risk: "pure",
      sideEffect: false,
      source: "core",
    },
    z.object({
      query: z.string().min(1).max(4000),
      kinds: z.array(z.enum(["session_message", "memory", "skill", "artifact"])).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
    async ({ query, kinds, limit }, context) => ({
      hits: await index.search({
        tenantId: context.tenantId,
        query,
        ...(kinds ? { kinds } : {}),
        ...(limit ? { limit } : {}),
      }),
    }),
  );
}
