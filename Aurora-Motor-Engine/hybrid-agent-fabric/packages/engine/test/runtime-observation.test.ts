import { describe, expect, it } from "vitest";

import { MODULE_MATURITY } from "../src/experimental/maturity.js";
import {
  RUNTIME_OBSERVATIONS,
  observationOf,
  observationSummary,
} from "../src/experimental/runtime-observation.js";
import { fileURLToPath } from "node:url";

import {
  capabilityModules,
  classifyOutcomes,
  judgeDepth,
} from "../src/experimental/observe-runtime-cli.js";

/**
 * `wiredToEngine` was a hand-written boolean that said `true` for all 30
 * modules and `false` for none. A field that never discriminates is not
 * measuring anything.
 *
 * These tests hold the measured number in place so the gap between "declared
 * wired" and "observed doing work" cannot quietly close on paper.
 */
describe("runtime observation", () => {
  it("covers every module in the maturity registry", () => {
    // An unobserved module is the easiest place for the old habit to return.
    const missing = MODULE_MATURITY.filter((entry) => !observationOf(entry.module));
    expect(missing.map((entry) => entry.module)).toEqual([]);
  });

  it("records that most modules are constructed but not exercised", () => {
    const summary = observationSummary();

    // The honest headline: 28 of 30 did work during a real task.
    //
    // This was 5 of 30. It moved for two reasons that pull in opposite
    // directions, which is worth keeping visible rather than smoothing over:
    //
    //   - The measured task used to return `unverified` on every run, because
    //     verifiers are built from a toolchain detected in the workspace and the
    //     observation ran without one. It now runs against a real workspace and
    //     completes verification. Two of the old five -- `gap-detection` and
    //     `failure-taxonomy` -- only ran *because* the task was failing, so they
    //     dropped out. Counting failure handling as integration work was the
    //     misleading part of the old number.
    //   - The loop's `learn` hook now consults the cognitive runtime, which
    //     brought skill synthesis, skill promotion, production persistence and
    //     integration verification onto the path. That is five new call sites,
    //     not a reclassification.
    //
    //   - The goal is now screened before the agent runs and the verdict is
    //     audited before it is trusted, which brought in the security system
    //     and both reward-hacking modules.
    //   - The loop now asks the model router which model fits the task.
    //
    // The measurement is now a two-task suite rather than one goal, which is
    // what made `gap-detection` and `failure-taxonomy` reachable again: they
    // only run when a task fails, and a task that verifies never fails.
    //
    // A third task, failing on a verifier that names a missing tool, is what
    // makes a *capability* gap -- the only kind that triggers acquisition --
    // and took the never-loaded count to zero.
    //
    // The loop now predicts before the agent acts and records the outcome
    // afterwards, which is what makes the world model compute surprise.
    //
    // The loop now analyses the caller's workspace and records what goal
    // discovery proposes, without acting on any of it.
    //
    // The learn path now evaluates the engine's own agent against what the
    // task actually produced. That also removed a fabrication:
    // `AgentSocietyPipeline.evaluateAgent` used to return the same four
    // hardcoded scores for every agent and every outcome.
    //
    // The loop now matches the goal against cognitive patterns learned from
    // earlier verified tasks, and grades the match against the outcome.
    //
    // Every stored lesson is now embedded in the cross-layer fusion index,
    // which memory maintenance then deduplicates.
    //
    // Maintenance now evolves the capability-generation prompt against
    // measured fitness. That also removed a second fabrication:
    // `evolvePrompts` used to generate mutations and never evaluate one, so
    // it ranked variants by the placeholder fitness they were born with.
    //
    // A fourth task asks about tax and VAT, which is what the domain experts
    // are for: the classifier is deliberately narrow, so an ordinary task
    // gets no consultation at all.
    //
    // Net: 23 of 30. This stays a hardcoded number on purpose: it is a
    // tripwire, so the next change to the execution path has to state what it
    // did rather than silently moving the headline.
    expect(summary.exercised).toBe(28);
    expect(summary.constructed).toBe(2);
    expect(summary.total).toBe(MODULE_MATURITY.length);
  });

  it("keeps the declaration and the observation visibly different", () => {
    const declaredWired = MODULE_MATURITY.filter((entry) => entry.wiredToEngine).length;
    const observedWorking = observationSummary().exercised;

    // If these ever match, it should be because the system changed, not
    // because someone edited the registry. The assertion is deliberately an
    // inequality: closing this gap is a real engineering result, and it should
    // require deleting this test on purpose.
    expect(declaredWired).toBeGreaterThan(observedWorking);
  });

  it("names the methods it saw, not just a boolean", () => {
    // "Exercised" has to be auditable, otherwise it is the same unfalsifiable
    // claim as `wiredToEngine: true` with a longer name.
    const loop = observationOf("execution/unified-execution-loop");
    expect(loop?.depth).toBe("exercised");
    expect(loop?.methodsDuringTask).toContain("run");

    for (const entry of RUNTIME_OBSERVATIONS) {
      if (entry.depth === "exercised") {
        expect(entry.methodsDuringTask.length).toBeGreaterThan(0);
      } else {
        expect(entry.methodsDuringTask).toEqual([]);
      }
    }
  });

  it("records the goal it was measured under", () => {
    // One task exercises one path. Without the goal, `constructed` reads as
    // "dead code" when it often means "not reachable from this goal".
    for (const entry of RUNTIME_OBSERVATIONS) {
      expect(entry.underGoal.length).toBeGreaterThan(0);
      expect(entry.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("does not count startup work as task work", () => {
    // `capability-synthesis` is constructed during initialize() and nothing on
    // this path asks it for anything, so it stays `constructed`. Marking a
    // module "exercised" because it was built would make the measurement
    // flattering and wrong -- which is the failure this assertion guards.
    expect(observationOf("capabilities/capability-synthesis")?.depth).toBe("constructed");

    // `security-system` used to sit here too, and the reason given was that its
    // guard "only runs when a capability executes, which this goal never
    // reached". That stopped being true when the loop began screening the goal
    // before the agent runs. It is listed as exercised for `detect` and
    // `screenText` -- the injection scan of this task's goal -- not for
    // `initialize`, which the measurement excludes as startup work. If a future
    // change ever wires the guard back out, this assertion should fail.
    expect(observationOf("security/security-system")?.depth).toBe("exercised");
    expect(observationOf("security/security-system")?.methodsDuringTask).toContain("screenText");
  });
});

describe("capability outcome classification", () => {
  // Coverage cannot distinguish a capability that worked from one that threw on
  // its first line: both execute that line, so the module is "exercised" either
  // way. This is the judgement that keeps a false positive out of the record --
  // embodiment.fs.* was reported as working while every call threw ENOENT.
  it("flags a capability whose only invocations threw", () => {
    const byId = classifyOutcomes([
      { capabilityId: "embodiment.fs.info", status: "error", error: "ENOENT: package.json" },
      { capabilityId: "embodiment.fs.info", status: "error", error: "ENOENT: package.json" },
    ]);
    const entry = byId.get("embodiment.fs.info");
    expect(entry?.onlyErrors).toBe(true);
    expect(entry?.error).toBe(2);
    expect(entry?.lastError).toBe("ENOENT: package.json");
  });

  it("does not flag a capability that ever succeeded", () => {
    const byId = classifyOutcomes([
      { capabilityId: "filesystem.write", status: "error", error: "locked" },
      { capabilityId: "filesystem.write", status: "ok" },
    ]);
    const entry = byId.get("filesystem.write");
    expect(entry?.onlyErrors).toBe(false);
    expect(entry?.ok).toBe(1);
    expect(entry?.error).toBe(1);
  });

  it("treats a capability with no invocations as absent, not as failing", () => {
    // Nothing ran. Calling that "only errors" would invent a failure.
    expect(classifyOutcomes([]).size).toBe(0);
  });

  it("counts per capability rather than in aggregate", () => {
    const byId = classifyOutcomes([
      { capabilityId: "a", status: "ok" },
      { capabilityId: "b", status: "error", error: "boom" },
    ]);
    expect(byId.get("a")?.onlyErrors).toBe(false);
    expect(byId.get("b")?.onlyErrors).toBe(true);
  });
});

/**
 * A10 — the measurement tool has to test itself.
 *
 * The tool's whole purpose is to catch modules that look wired but do nothing.
 * Its own judgement was untested: a coverage-based depth that ignored whether
 * the calls worked was shipped and reported `embodiment.fs.*` as healthy while
 * every invocation threw ENOENT. The plan's words: "Ölçüm tool'u kendi ölçümünü
 * doğrulayan bir self-test içersin." These tests exercise the same pure
 * functions the CLI uses to build its headline, so the headline cannot drift
 * from the judgement without a test failing.
 */
describe("the measurement tool judges itself", () => {
  const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

  it("attributes a capability to the file that declares it, read from source", () => {
    const map = capabilityModules(sourceRoot);
    // Both of these were seen in the measured run; the attribution is read out
    // of the capability definitions rather than maintained by hand, so it cannot
    // decay when a capability moves.
    expect(map.get("embodiment.fs.info")).toBe("capabilities/embodiment");
    expect(map.get("filesystem.write")).toBe("capabilities/filesystem");
    // A capability id that does not exist is not invented.
    expect(map.get("does.not.exist")).toBeUndefined();
    expect(map.size).toBeGreaterThan(20);
  });

  const capabilityToModule = new Map([
    ["embodiment.fs.info", "capabilities/embodiment"],
    ["filesystem.write", "capabilities/filesystem"],
  ]);

  it("does not count a module as working when every recorded call failed", () => {
    // Coverage says these methods ran. They did — and threw. "did work" would be
    // a lie, which is the exact failure this tool exists to catch.
    const judged = judgeDepth("capabilities/embodiment", {
      methodsDuringTask: ["listDirectory", "readFile"],
      loaded: true,
      outcomes: [
        { capabilityId: "embodiment.fs.info", status: "error", error: "ENOENT: no such file" },
        { capabilityId: "embodiment.fs.info", status: "error", error: "ENOENT: no such file" },
      ],
      capabilityToModule,
    });
    expect(judged.depth).toBe("failed");
    expect(judged.failingCapability).toContain("ENOENT");
  });

  it("keeps a module exercised when at least one call succeeded", () => {
    // One success is proof the module can work; demoting it would understate the
    // measurement as much as counting a failure as work overstates it.
    const judged = judgeDepth("capabilities/embodiment", {
      methodsDuringTask: ["listDirectory"],
      loaded: true,
      outcomes: [
        { capabilityId: "embodiment.fs.info", status: "error", error: "ENOENT" },
        { capabilityId: "embodiment.fs.info", status: "ok" },
      ],
      capabilityToModule,
    });
    expect(judged.depth).toBe("exercised");
    expect(judged.failingCapability).toBeUndefined();
  });

  it("does not demote a module that has no outcome evidence", () => {
    // Most modules are not reached through the capability broker at all.
    // "No recorded call" is not evidence of failure, and treating it as such
    // would demote every module the tool cannot observe.
    const judged = judgeDepth("aurora/introspection", {
      methodsDuringTask: ["summarise"],
      loaded: true,
      outcomes: [{ capabilityId: "filesystem.write", status: "error", error: "locked" }],
      capabilityToModule,
    });
    expect(judged.depth).toBe("exercised");
  });

  it("still separates loaded-but-idle from never-loaded", () => {
    const idle = judgeDepth("routing/model-routing", {
      methodsDuringTask: [],
      loaded: true,
      outcomes: [],
      capabilityToModule,
    });
    const neverLoaded = judgeDepth("routing/model-routing", {
      methodsDuringTask: [],
      loaded: false,
      outcomes: [],
      capabilityToModule,
    });
    expect(idle.depth).toBe("idle");
    expect(neverLoaded.depth).toBe("never-loaded");
  });

  it("only attributes outcomes recorded against the module's own capabilities", () => {
    // A failure in `filesystem.write` belongs to capabilities/filesystem. Letting
    // it demote capabilities/embodiment would move blame by filename similarity.
    const judged = judgeDepth("capabilities/embodiment", {
      methodsDuringTask: ["listDirectory"],
      loaded: true,
      outcomes: [{ capabilityId: "filesystem.write", status: "error", error: "locked" }],
      capabilityToModule,
    });
    expect(judged.depth).toBe("exercised");
  });
});
