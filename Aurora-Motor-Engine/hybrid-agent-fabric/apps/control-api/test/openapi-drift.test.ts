/**
 * OpenAPI spec ↔ registered routes drift guard.
 *
 * `docs/openapi.yaml` used to describe 7 paths while the control API registers
 * 844, and four of those seven documented operations that do not exist at all:
 *
 *   DELETE /v1/sessions/{sessionId}
 *   POST   /v1/sessions/{sessionId}/chat
 *   GET    /v1/memory-graph/search
 *   GET    /v1/initiative
 *
 * Each was verified against a running server (the two under `/v1/sessions/…`
 * were masked by a 500 from the tenant-resolution hook; the other two answered
 * 404 outright). Nothing failed when the spec and the router disagreed, so an
 * integrator coding against the spec got endpoints that could never work.
 *
 * This test parses the spec with a line scan rather than a YAML library, so it
 * does not share an implementation with `scripts/generate-openapi.mjs` — if the
 * generator regresses, this still catches it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const SPEC = resolve(ROOT, "docs", "openapi.yaml");
// main.ts plus EVERY module under routes/. A hardcoded list here silently
// excluded route modules extracted later (T5): the spec advertised their
// paths and this test called them nonexistent. Directory discovery keeps
// the guard honest without sharing an implementation with the generator.
const ROUTES_DIR = join(ROOT, "apps/control-api/src/routes");
const SOURCES = [
  "apps/control-api/src/main.ts",
  ...readdirSync(ROUTES_DIR)
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map((file) => `apps/control-api/src/routes/${file}`),
];

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "all"] as const;

/** Fastify `/v1/sessions/:id/chat` -> OpenAPI `/v1/sessions/{id}/chat`. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function registeredOperations(): Set<string> {
  const found = new Set<string>();
  const pattern = new RegExp(`\\bapp\\.(${METHODS.join("|")})\\(\\s*(["'\`])([^"'\`]+)\\2`, "g");
  for (const source of SOURCES) {
    const text = readFileSync(resolve(ROOT, source), "utf8");
    // If routes are ever registered through the object form, this test would
    // silently understate the surface. Fail loudly instead.
    expect(text, `${source} uses app.route({...}), which this scan cannot read`).not.toMatch(
      /\bapp\.route\(\s*\{/,
    );
    for (const match of text.matchAll(pattern)) {
      found.add(`${match[1]} ${toOpenApiPath(match[3])}`);
    }
  }
  return found;
}

/** Minimal structural scan: top-level `paths:` keys and their operation keys. */
function documentedOperations(): Set<string> {
  const lines = readFileSync(SPEC, "utf8").split("\n");
  const start = lines.findIndex((line) => line === "paths:");
  const end = lines.findIndex((line) => line === "components:");
  expect(start, "docs/openapi.yaml has no top-level `paths:`").toBeGreaterThanOrEqual(0);
  expect(end, "docs/openapi.yaml has no top-level `components:`").toBeGreaterThan(start);

  const found = new Set<string>();
  let currentPath: string | undefined;
  for (const line of lines.slice(start + 1, end)) {
    const pathMatch = /^ {2}(\/\S*):$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    const methodMatch = /^ {4}(get|post|put|patch|delete|head|options|all):$/.exec(line);
    if (methodMatch && currentPath) found.add(`${methodMatch[1]} ${currentPath}`);
  }
  return found;
}

describe("docs/openapi.yaml", () => {
  const registered = registeredOperations();
  const documented = documentedOperations();

  it("documents every route the control API registers", () => {
    const missing = [...registered].filter((operation) => !documented.has(operation)).sort();
    expect(missing, `undocumented routes:\n  ${missing.slice(0, 20).join("\n  ")}`).toEqual([]);
  });

  it("documents no route that the control API does not register", () => {
    // These are the phantom endpoints: documented, unreachable, 404 in practice.
    const phantom = [...documented].filter((operation) => !registered.has(operation)).sort();
    expect(phantom, `spec advertises routes that do not exist:\n  ${phantom.join("\n  ")}`).toEqual([]);
  });

  it("covers the whole surface, not a hand-picked subset", () => {
    // Regression guard on the original failure: 7 documented against 844 real.
    expect(registered.size).toBeGreaterThan(800);
    expect(documented.size).toBe(registered.size);
  });

  it("keeps hand-written schemas distinguishable from generated stubs", () => {
    const text = readFileSync(SPEC, "utf8");
    expect(text).toContain("# ── BEGIN GENERATED (npm run docs:openapi) ──");
    expect(text).toContain("# ── END GENERATED ──");
    // A generated stub claims no schema; a curated path does.
    expect(text).toContain("x-schema-status: unspecified");
    const health = text.slice(text.indexOf("  /health:"), text.indexOf("  /v1/sessions:"));
    expect(health).toContain("schema:");
    expect(health).not.toContain("x-schema-status: unspecified");
  });
});
