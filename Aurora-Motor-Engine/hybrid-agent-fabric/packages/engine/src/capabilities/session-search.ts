import { z } from "zod";
import type { SessionSearchService } from "../search/session-search.js";
import { defineCapability } from "./schema.js";

export function sessionSearchCapability(search: SessionSearchService) {
  return defineCapability(
    {
      id: "session.search",
      version: "1.0.0",
      description: "Search this tenant's prior session messages and return bounded snippets.",
      risk: "pure",
      sideEffect: false,
      source: "core",
    },
    z.object({ query: z.string().min(1).max(1000), limit: z.number().int().positive().max(50).optional() }),
    async ({ query, limit }, context) => ({
      hits: await search.search(context.tenantId, query, limit ?? 20),
    }),
  );
}
