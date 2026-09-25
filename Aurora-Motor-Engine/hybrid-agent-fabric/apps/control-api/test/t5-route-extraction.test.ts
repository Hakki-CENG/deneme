/**
 * T5 — the observability route extraction stays wired.
 *
 * main.ts delegates the observability group (health, SLO, explain, metrics,
 * fleet) to ./routes/observability.ts. Two things must stay true, and both
 * are invisible to the OpenAPI sync check (which happily regenerates a
 * smaller spec):
 *
 *   1. main.ts actually CALLS registerObservabilityRoutes — a module whose
 *      registration is voided keeps its file, its types and its static
 *      routes, while serving nothing.
 *   2. The module defines the paths the extraction promised to carry.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MAIN = join(__dirname, "../src/main.ts");
const OBSERVABILITY = join(__dirname, "../src/routes/observability.ts");
const SPEC = join(__dirname, "../../../docs/openapi.yaml");

const OBSERVABILITY_PATHS = [
  "/health",
  "/v1/health/report",
  "/v1/slo",
  "/v1/explain/task",
  "/metrics",
  "/v1/metrics",
  "/v1/fleet/status",
  "/v1/fleet/alerts",
];

describe("T5 — observability route extraction", () => {
  it("main.ts registers the extracted module", async () => {
    const main = await readFile(MAIN, "utf8");
    expect(main).toMatch(/registerObservabilityRoutes\(\s*app,\s*engine,\s*z,/);
  });

  it("the module defines every observability path it owns", async () => {
    const moduleText = await readFile(OBSERVABILITY, "utf8");
    for (const path of OBSERVABILITY_PATHS) {
      expect(moduleText).toContain(`"${path}"`);
    }
  });

  it("the generated spec still carries all eight paths", async () => {
    const spec = await readFile(SPEC, "utf8");
    for (const path of OBSERVABILITY_PATHS) {
      expect(spec).toContain(`  ${path}:`);
    }
  });

  it("the module never re-declares a route main.ts still owns", async () => {
    // A path defined in BOTH places would double-register at boot (or shadow
    // silently). The extraction must move, not copy.
    const main = await readFile(MAIN, "utf8");
    for (const path of OBSERVABILITY_PATHS) {
      expect(main).not.toContain(`app.get("${path}"`);
      expect(main).not.toContain(`app.post("${path}"`);
    }
  });
});
