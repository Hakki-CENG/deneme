import { z } from "zod";
import type { CapabilityDescriptor } from "../types.js";
import { defineCapability } from "./schema.js";

const RISKS = ["pure", "workspace_read", "workspace_write", "process", "network", "external_side_effect", "privileged"] as const;

function tokens(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((item) => item.length > 1))];
}

/** Deterministic lexical scoring: exact id, id prefix, then token overlap over id and description. */
export function searchCapabilities(
  catalog: CapabilityDescriptor[],
  input: { query: string; risk?: string | undefined; sideEffect?: boolean | undefined; source?: string | undefined; limit?: number | undefined },
): Array<{ id: string; description: string; risk: string; sideEffect: boolean; source: string; score: number }> {
  const query = input.query.trim().toLowerCase();
  const queryTokens = tokens(query);
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 10)));
  return catalog
    .filter((item) => (input.risk ? item.risk === input.risk : true))
    .filter((item) => (input.sideEffect === undefined ? true : item.sideEffect === input.sideEffect))
    .filter((item) => (input.source ? item.source === input.source : true))
    .map((item) => {
      const idTokens = tokens(item.id);
      const descriptionTokens = tokens(item.description);
      const overlapId = queryTokens.filter((token) => idTokens.includes(token)).length;
      const overlapDescription = queryTokens.filter((token) => descriptionTokens.includes(token)).length;
      const substring = query && item.id.toLowerCase().includes(query) ? 1 : 0;
      const exact = item.id.toLowerCase() === query ? 1 : 0;
      const denominator = Math.max(1, queryTokens.length);
      const score = Number((exact * 4 + substring * 2 + (overlapId / denominator) * 2 + (overlapDescription / denominator)).toFixed(6));
      return {
        id: item.id,
        description: item.description,
        risk: item.risk as string,
        sideEffect: item.sideEffect,
        source: item.source as string,
        score,
      };
    })
    .filter((item) => item.score > 0 || !queryTokens.length)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/**
 * Progressive tool disclosure.
 *
 * A catalog of 275 capabilities cannot be pushed at a model in full: it burns context and measurably
 * degrades tool selection. Peers solved this with a tool-search tool; Aurora does the same, but with
 * deterministic lexical ranking (no embedding call on the hot path), risk and side-effect filters so a
 * read-only session can look for read-only tools, and a separate `describe` step that returns the full
 * schema only for the capability actually chosen.
 */
export function discoveryCapabilities(catalog: () => CapabilityDescriptor[]) {
  return [
    defineCapability(
      { id: "tool.search", version: "1.0.0", description: "Search the capability catalog by name and description, filtered by risk, side effect and source. Use this before assuming a tool does not exist.", risk: "pure", sideEffect: false, source: "core" },
      z.object({
        query: z.string().min(1).max(200),
        risk: z.enum(RISKS).optional(),
        sideEffect: z.boolean().optional(),
        source: z.enum(["core", "skill", "mcp", "plugin"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      async (input) => {
        const all = catalog();
        const results = searchCapabilities(all, input);
        return { query: input.query, catalogSize: all.length, matches: results.length, results };
      },
    ),
    defineCapability(
      { id: "tool.describe", version: "1.0.0", description: "Return the full descriptor and input schema for one capability id.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ capabilityId: z.string().min(1).max(200) }),
      async (input) => {
        const found = catalog().find((item) => item.id === input.capabilityId.trim());
        if (!found) throw new Error(`Capability "${input.capabilityId}" is not registered.`);
        return found as unknown as Record<string, unknown>;
      },
    ),
    defineCapability(
      { id: "tool.catalog", version: "1.0.0", description: "Compact catalog overview: counts by risk, side effect and source, with the capability id prefixes in use.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async () => {
        const all = catalog();
        const byRisk: Record<string, number> = {};
        const bySource: Record<string, number> = {};
        const prefixes = new Map<string, number>();
        for (const item of all) {
          byRisk[item.risk] = (byRisk[item.risk] ?? 0) + 1;
          bySource[item.source] = (bySource[item.source] ?? 0) + 1;
          const prefix = item.id.split(".")[0] ?? item.id;
          prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
        }
        return {
          total: all.length,
          sideEffecting: all.filter((item) => item.sideEffect).length,
          byRisk,
          bySource,
          families: [...prefixes.entries()].map(([prefix, count]) => ({ prefix, count })).sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix)),
        };
      },
    ),
  ];
}
