import { z } from "zod";
import type { WebSearchService } from "../web/web-search.js";
import { defineCapability } from "./schema.js";

export function webSearchCapability(search: WebSearchService) {
  return defineCapability(
    {
      id: "web.search",
      version: "1.0.0",
      description: "Search the public web through a configured server-side provider and return normalized provenance-bearing results.",
      risk: "network",
      sideEffect: false,
      source: "core",
    },
    z.object({
      query: z.string().min(1).max(2000),
      count: z.number().int().min(1).max(20).default(8),
      providerId: z.string().optional(),
      freshness: z.enum(["day", "week", "month", "year"]).optional(),
    }),
    async ({ query, count, providerId, freshness }, context) => await search.search({
      query,
      count,
      ...(providerId ? { providerId } : {}),
      ...(freshness ? { freshness } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    }),
  );
}
