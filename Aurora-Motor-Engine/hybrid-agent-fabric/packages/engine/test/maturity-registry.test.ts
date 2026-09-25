import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODULE_MATURITY,
  effectiveLevelOf,
  evidenceLevelOf,
  maturityOf,
  maturitySummary,
  mislabelledModules,
  modulesAtLevel,
  stableWithoutProductionEvidence,
} from "../src/experimental/maturity.js";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

describe("capability maturity registry", () => {
  it("declares a level for every registered module", () => {
    expect(MODULE_MATURITY.length).toBeGreaterThan(0);
    for (const entry of MODULE_MATURITY) {
      expect(["stable", "beta", "experimental"]).toContain(entry.level);
    }
  });

  it("points at modules that actually exist on disk", () => {
    for (const entry of MODULE_MATURITY) {
      const asFile = resolve(SRC_ROOT, `${entry.module}.ts`);
      const asDir = resolve(SRC_ROOT, entry.module);
      expect(
        existsSync(asFile) || existsSync(asDir),
        `${entry.module} does not exist`
      ).toBe(true);
    }
  });

  it("never labels an untested or unwired module as stable", () => {
    // This is the guard rail: a module cannot claim stability it has not earned.
    expect(mislabelledModules()).toHaveLength(0);
  });

  it("documents the gap for everything that is not stable", () => {
    for (const entry of MODULE_MATURITY) {
      if (entry.level === "stable") continue;
      expect(entry.gapToStable, `${entry.module} must state its gap`).toBeTruthy();
    }
  });

  it("states both promised and actual behaviour for every module", () => {
    for (const entry of MODULE_MATURITY) {
      expect(entry.promisedBehaviour.length).toBeGreaterThan(10);
      expect(entry.actualBehaviour.length).toBeGreaterThan(10);
    }
  });

  it("keeps aspirationally-named modules out of the stable tier", () => {
    // Names that promise more than the code delivers must stay experimental.
    for (const name of ["digital-twin", "embodiment", "federated", "domain-experts"]) {
      expect(maturityOf(name)?.level, `${name} should not be stable`).toBe("experimental");
    }
  });

  it("marks the real sandbox-backed subsystems as stable", () => {
    expect(maturityOf("capabilities/capability-synthesis")?.level).toBe("stable");
    expect(maturityOf("skills/skill-synthesis")?.level).toBe("stable");
  });

  it("keeps the security system at beta now that its remaining gap is the model path", () => {
    // History: it was listed stable alongside the sandbox-backed subsystems
    // and was not one — its protections lived in `initialize()`, which nothing
    // invoked until 2026-09, so the runtime held a pipeline with zero
    // injection patterns and zero kill switches (M9 armed it), and then
    // nothing asked it anything (N4 wired it to the broker's pre_capability
    // guard).
    //
    // Still beta, for a smaller and different reason: the guard reads
    // capability arguments, and a real injection most likely arrives in model
    // output. Mock providers cannot close that. The record must say which gap
    // is open, not keep citing the one that was fixed.
    const security = maturityOf("security/security-system");
    expect(security?.level).toBe("beta");
    expect(security?.gapToStable).not.toMatch(/no caller/i);
    expect(security?.gapToStable).toMatch(/real model/i);
    expect(security?.actualBehaviour).toMatch(/kill switch/i);
  });

  it("summarises the registry", () => {
    const summary = maturitySummary();
    expect(summary.total).toBe(MODULE_MATURITY.length);
    expect(summary.stable + summary.beta + summary.experimental).toBe(summary.total);
    expect(summary.mislabelled).toBe(0);
    expect(modulesAtLevel("experimental").length).toBeGreaterThan(0);
  });

  it("returns undefined for unknown modules", () => {
    expect(maturityOf("no/such/module")).toBeUndefined();
  });
});

/**
 * A10 — `stable` has to mean something the evidence supports.
 *
 * Until now the only rule was "has tests and is wired" (`mislabelledModules`),
 * which is a statement about the build, not about the module working in use.
 * These tests pin the new rule: a declared level is capped by the evidence, and
 * the evidence for "exercised in a real task" comes from the runtime
 * observation rather than from a field someone can fill in by hand.
 */
describe("maturity is capped by evidence (A10)", () => {
  it("caps a declared stable module at beta while it has no production evidence", () => {
    const entry = maturityOf("capabilities/capability-synthesis");
    expect(entry?.level).toBe("stable");
    expect(entry?.productionEvidence).toBeUndefined();
    expect(effectiveLevelOf(entry!)).toBe("beta");
  });

  it("reports every declared-stable module that is missing production evidence", () => {
    // Measured at the time of writing: 6 modules declare `stable`, none of them
    // records having been seen working in production, so the effective count of
    // stable modules is zero. If this number changes, it should change because
    // somebody recorded real evidence, not because the rule was loosened.
    const unproven = stableWithoutProductionEvidence();
    expect(unproven.length).toBe(modulesAtLevel("stable").length);
    expect(unproven.length).toBe(6);
    for (const entry of unproven) expect(entry.level).toBe("stable");
  });

  it("takes 'exercised' from the measurement, not from a declaration", () => {
    // `routing/model-routing` is constructed at startup and never consulted, so
    // the observation says so and the evidence level follows. A module cannot
    // reach `verified` here by being described as verified.
    expect(evidenceLevelOf(maturityOf("routing/model-routing")!)).toBe("unproven");
    const worked = MODULE_MATURITY.filter((entry) => evidenceLevelOf(entry) === "verified");
    expect(worked.length).toBe(maturitySummary().observedExercised);
    expect(worked.length).toBeGreaterThan(0);
  });

  it("never raises an experimental module", () => {
    // `experimental` means the name promises more than the code delivers. Runtime
    // coverage does not change that; only the implementation does.
    for (const entry of modulesAtLevel("experimental")) {
      expect(effectiveLevelOf(entry)).toBe("experimental");
    }
  });

  it("summarises the claim and the evidence side by side", () => {
    const summary = maturitySummary();
    expect(summary.effective.stable + summary.effective.beta + summary.effective.experimental).toBe(
      summary.total,
    );
    // The declaration says 6 are stable; the evidence supports none of them yet.
    expect(summary.stable).toBe(6);
    expect(summary.effective.stable).toBe(0);
    expect(summary.unprovenStable).toBe(6);
    // Measured, and it is not the same as "no failures recorded" — see
    // `observe:runtime`, which demotes a module whose every call threw.
    expect(summary.observedFailed).toBe(0);
  });
});
