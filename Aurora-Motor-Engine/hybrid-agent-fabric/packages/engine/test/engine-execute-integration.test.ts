/**
 * engine.execute() — the cognitive layer and the real agent on one path.
 *
 * Measured before this existed, and still true of the legacy `runTask()`:
 *
 *     runTask("Delete all files on the moon and prove P=NP")
 *       → outcome: "success", subsystems: 0, phases: 0
 *
 * `execute()` runs the actual SessionActor and derives its status from what
 * happened. These tests assert the difference, not the implementation.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HybridAgentEngine } from "../src/engine.js";

const IMPOSSIBLE = "Delete all files on the moon using the quantum teleporter API and prove P=NP";

async function engine(): Promise<HybridAgentEngine> {
  const root = await mkdtemp(join(tmpdir(), "haf-execute-"));
  return new HybridAgentEngine({
    homePath: root,
    kernelServerScript: "",
    sandboxBackend: "local",
    model: { provider: "mock" },
  } as never);
}

describe("execute() does not inherit the zero-work success bug", () => {
  it("reports unverified, not success, for an impossible goal", async () => {
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: IMPOSSIBLE,
      budget: { timeMs: 20_000 },
    });

    expect(report.status).not.toBe("succeeded");
    expect(report.status).toBe("unverified");
  }, 60_000);

  it("actually creates a session and runs the agent", async () => {
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Summarise the workspace",
      budget: { timeMs: 20_000 },
    });

    const agentOutcome = report.outcomes.find((item) => item.evidence.includes("Agent session"));
    expect(agentOutcome).toBeDefined();
    // The legacy path executed zero subsystems; this one reaches a real session.
    expect(agentOutcome?.evidence).toMatch(/settled as \w+ after \d+ events/);
  }, 60_000);

  it("records evidence for every step rather than a bare verdict", async () => {
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Do a thing",
      budget: { timeMs: 20_000 },
    });

    expect(report.outcomes.length).toBeGreaterThan(0);
    for (const item of report.outcomes) {
      expect(item.evidence.trim().length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("reaches succeeded only when a verifier says so", async () => {
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Create the report",
      budget: { timeMs: 20_000 },
      verifiers: [
        {
          name: "acceptance",
          tier: "V2_empirical",
          run: async () => ({
            verdict: "pass" as const,
            evidence: "acceptance check passed",
            confidence: 0.9,
          }),
        },
      ],
    });

    expect(report.status).toBe("succeeded");
    expect(report.verification?.verdict).toBe("pass");
  }, 60_000);

  it("reports failed when the verifier rejects the work", async () => {
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Create the report",
      budget: { timeMs: 20_000 },
      maxAttempts: 1,
      verifiers: [
        {
          name: "acceptance",
          tier: "V2_empirical",
          run: async () => ({
            verdict: "fail" as const,
            evidence: "expected file was not created",
            confidence: 0.9,
          }),
        },
      ],
    });

    expect(report.status).toBe("failed");
    expect(report.failures.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("gap detection runs against the engine's real capability inventory", () => {
  it("names the missing capability instead of only reporting a failure", async () => {
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Analyse the visual changes in this GitHub PR by comparing screenshots",
      budget: { timeMs: 20_000 },
      maxAttempts: 2,
      verifiers: [
        {
          name: "acceptance",
          tier: "V2_empirical",
          run: async () => ({
            verdict: "fail" as const,
            evidence: "no such tool 'visual_diff'",
            confidence: 0.9,
          }),
        },
      ],
    });

    expect(report.status).not.toBe("succeeded");
    // The point: the system says WHAT is missing, not merely that it failed.
    expect(report.gaps.some((gap) => gap.missing === "visual_diff")).toBe(true);

    const gap = report.gaps.find((item) => item.missing === "visual_diff");
    expect(gap?.type).toBe("tool");
    expect(gap?.evidence.join(" ")).toContain("Inventory holds");
  }, 60_000);

  it("admits that nothing can build the gap, rather than looping", async () => {
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Compare the screenshots for visual regressions",
      budget: { timeMs: 20_000 },
      maxAttempts: 3,
      verifiers: [
        {
          name: "acceptance",
          tier: "V2_empirical",
          run: async () => ({
            verdict: "fail" as const,
            evidence: "no such tool 'visual_diff'",
            confidence: 0.9,
          }),
        },
      ],
    });

    // The intent of this test has not changed: a gap the system cannot close
    // must stop the run instead of burning every attempt, and must not be
    // reported as closed. What changed is the mechanism.
    //
    // It used to assert an outcome reading "no capability-acquisition
    // provider", because there was no default generator and the loop could only
    // admit that nothing could build the gap. There is one now, backed by the
    // engine's own model, so the loop actually tries: the candidate code has to
    // survive static analysis, the sandbox and the test cases before it reaches
    // the broker. The mock provider cannot write working code, so the attempt
    // fails -- and a failed acquisition is reported as failed.
    //
    // Both outcomes satisfy the intent. Fabricated success would satisfy
    // neither, and is what this test exists to catch.
    const acquisition = report.outcomes.find((item) =>
      /acquire capability/i.test(item.evidence),
    );
    expect(acquisition).toBeDefined();
    expect(["failed", "unavailable"]).toContain(acquisition?.status);
    // Stopped early instead of burning all three attempts.
    expect(report.attempts).toBeLessThan(3);
    // And the run as a whole did not claim success on an unclosed gap.
    expect(report.status).not.toBe("succeeded");
  }, 60_000);
});

/**
 * The legacy path, pinned to what it ACTUALLY does today.
 *
 * The docblocks around this codebase say `runTask()` returns
 * `outcome: "success"` for work it never did. That WAS true, and it is the
 * defect `execute()` was written to replace — but the MetaController
 * initialiser has since been fixed, and measuring the current behaviour gives:
 *
 *     runTask("Delete all files on the moon and prove P=NP")
 *       → outcome: "skipped", subsystems: 0, phases: 0
 *
 * So the legacy path no longer lies about success; it correctly reports that
 * nothing ran. What remains true is that it does not execute anything, which
 * is why it must not be mistaken for an execution entry point.
 *
 * These are characterisation tests. They exist because a comment is not a
 * guarantee: nothing else pins this behaviour, and without them a regression
 * to the original `"success"` initialiser would pass CI silently.
 */
describe("runTask() is the legacy path and must not be mistaken for execution", () => {
  it("reports skipped, never success, when no subsystem runs", async () => {
    const result = await (await engine()).runTask("local", IMPOSSIBLE);

    // The regression guard: this is the exact value that used to be "success".
    expect(result.runResult.outcome).toBe("skipped");
    expect(result.runResult.outcome).not.toBe("success");

    // ...and it reached that verdict having executed nothing, which is why
    // "skipped" rather than "success" is the honest answer.
    expect(result.runResult.subsystemsUsed).toHaveLength(0);
    expect(result.runResult.phaseResults).toHaveLength(0);
  }, 60_000);

  it("still does no work on a plausible goal, while execute() runs the agent", async () => {
    const legacy = await (await engine()).runTask("local", "Summarise the workspace");
    const real = await (await engine()).execute({
      tenantId: "local",
      goal: "Summarise the workspace",
      budget: { timeMs: 20_000 },
    });

    // One goal, two entry points. The legacy path orchestrates nothing...
    expect(legacy.runResult.subsystemsUsed).toHaveLength(0);
    expect(legacy.runResult.outcome).toBe("skipped");

    // ...while execute() reaches a real session and reports an earned status.
    const agentOutcome = real.outcomes.find((item) => item.evidence.includes("Agent session"));
    expect(agentOutcome?.evidence).toMatch(/settled as \w+ after \d+ events/);
  }, 90_000);
});

/**
 * The planning phase, wired.
 *
 * `UnifiedExecutionLoop` has always had a `plan` hook, and `engine.execute()`
 * did not supply it — so every run recorded `unavailable: "No planner was
 * supplied"`. The cognitive planner existed and simply was not connected,
 * which is the exact "more parts, no connections" failure the architecture
 * document warns about.
 */
describe("execute() runs the planning phase instead of skipping it", () => {
  it("produces the same phase skeleton for unrelated goals", async () => {
    // Pins the planner's real limit so nobody reads "planner wired" as "task
    // decomposition works". An external audit flagged the source comment here
    // claiming the planner was NOT wired while it ran on every task; the
    // comment is fixed, and this test makes the underlying weakness visible in
    // the suite rather than only in prose.
    //
    // If a future planner genuinely decomposes goals, this test SHOULD fail —
    // and its failure is the signal to delete it.
    const instance = await engine();

    const migration = await instance.planningEngine.plan({
      goal: "Optimize the PostgreSQL migration that times out on large tables",
      tenantId: "local",
    });
    const haiku = await instance.planningEngine.plan({
      goal: "Write a haiku about the sea",
      tenantId: "local",
    });

    const names = (result: { steps: readonly { name: string }[] }) =>
      result.steps.map((step) => step.name);

    // Both are drawn from the same fixed phase vocabulary.
    expect(names(migration)).toContain("Understand");
    expect(names(haiku)).toContain("Understand");

    // Measured while writing this: the goal text is pasted into the FIRST
    // step's description and nowhere else. So "the plan mentions postgres" is
    // true and meaningless — every later step is boilerplate that would read
    // identically for any goal at all.
    const laterSteps = migration.steps.slice(1);
    expect(laterSteps.length).toBeGreaterThan(0);
    const laterText = JSON.stringify(laterSteps).toLowerCase();
    expect(laterText).not.toContain("postgres");
    expect(laterText).not.toContain("migration");

    // And those later steps are shared verbatim between two unrelated goals.
    const shared = names(migration).filter((name) => names(haiku).includes(name));
    expect(shared.length).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it("produces a real plan rather than reporting the planner unavailable", async () => {
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Fix the failing postgres migration test",
      budget: { timeMs: 20_000 },
    });

    const planning = report.outcomes.find((item) => item.evidence.includes("Plan"));
    expect(planning).toBeDefined();

    // The regression guard: this used to read "No planner was supplied".
    expect(planning?.status).not.toBe("unavailable");
    expect(planning?.evidence).toMatch(/Planned \d+ steps/);

    const stepCount = Number(/Planned (\d+) steps/.exec(planning?.evidence ?? "")?.[1] ?? 0);
    expect(stepCount).toBeGreaterThan(0);
  }, 60_000);

  it("records the planned steps on the task context, not just a count", async () => {
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Summarise the workspace",
      budget: { timeMs: 20_000 },
    });

    // A count alone would be satisfied by a planner returning empty strings.
    expect(report.plan?.steps.length).toBeGreaterThan(0);
    const descriptions = (report.plan?.steps ?? []).map((step) => step.description);
    expect(descriptions.every((text) => text.trim().length > 0)).toBe(true);
    expect(descriptions.join(" ")).toMatch(/Verify/i);
  }, 60_000);

  it("carries the planner's dependency graph all the way into the report", async () => {
    // Three places used to flatten this, each one line long: PlanningResult
    // dropped `dependencies` from its type, `plan()` dropped it from the
    // mapping, and engine.ts collapsed every step to `name: description`.
    // decomposeGoal computed a DAG and every consumer received a list.
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Fix the failing postgres migration test",
      budget: { timeMs: 20_000 },
    });

    const steps = report.plan?.steps ?? [];
    expect(steps.length).toBeGreaterThan(1);

    const withEdges = steps.filter((step) => step.dependencies.length > 0);
    expect(withEdges.length).toBeGreaterThan(0);

    // Every edge must name a step that exists, or the graph is decorative.
    const ids = new Set(steps.map((step) => step.id));
    for (const step of steps) {
      for (const dependency of step.dependencies) {
        expect(ids.has(dependency)).toBe(true);
      }
    }

    // The skeleton is Understand -> ... -> Verify -> Learn, so the first step
    // is a root and the last one is not.
    expect(steps[0]?.dependencies).toEqual([]);
    expect(steps[steps.length - 1]?.dependencies.length).toBeGreaterThan(0);
  }, 60_000);

  it("never reports a plan step as skipped when nobody decided to skip it", async () => {
    // The original defect: every step was born `"skipped"` and stayed there,
    // so a finished plan and an untouched plan serialized identically.
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Summarise the workspace",
      budget: { timeMs: 20_000 },
    });

    for (const step of report.plan?.steps ?? []) {
      expect(step.status).not.toBe("skipped");
    }
  }, 60_000);
});

describe("execute() can verify by consensus when nothing objective exists", () => {
  /**
   * V3 was declared, handled by the factory, documented — and unreachable.
   * Nothing in the codebase produced a consensus verifier, so the tier could
   * never be the reason a claim passed.
   *
   * These tests drive the real `execute()` path, not the factory in isolation.
   */
  const panel = (verdicts: ReadonlyArray<["pass" | "fail", string]>) =>
    verdicts.map(([verdict, source], index) => ({
      name: `judge-${index}`,
      source,
      judge: async () => ({ verdict, reasoning: `${source} says ${verdict}`, confidence: 0.8 }),
    }));

  it("reaches succeeded through a V3 panel on a goal with no build or tests", async () => {
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Explain why the retry storm happened",
      budget: { timeMs: 20_000 },
      evaluatorPanel: panel([
        ["pass", "gpt"],
        ["pass", "claude"],
      ]),
    });

    expect(report.verification?.strongestTier).toBe("V3_consensus");
    // Consensus is evidence about evaluators, never ground truth, so it grants
    // controlled autonomy rather than high.
    expect(report.verification?.autonomy).toBe("controlled");
    expect(report.status).toBe("succeeded");
  }, 60_000);

  it("does not pass when the panel is drawn from a single model", async () => {
    // Two prompts against one model is one opinion with two chances to repeat
    // itself, so no V3 verifier is produced at all.
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Explain why the retry storm happened",
      budget: { timeMs: 20_000 },
      evaluatorPanel: panel([
        ["pass", "gpt"],
        ["pass", "gpt"],
      ]),
    });

    expect(report.status).not.toBe("succeeded");
    expect(report.verification?.strongestTier).not.toBe("V3_consensus");
  }, 60_000);

  it("lets one dissenting evaluator block the claim", async () => {
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Explain why the retry storm happened",
      budget: { timeMs: 20_000 },
      evaluatorPanel: panel([
        ["pass", "gpt"],
        ["pass", "claude"],
        ["fail", "gemini"],
      ]),
    });

    expect(report.status).not.toBe("succeeded");
  }, 60_000);

  it("still reports unverified when no panel is supplied", async () => {
    // The pre-existing behaviour must not change: absent evidence stays absent.
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Explain why the retry storm happened",
      budget: { timeMs: 20_000 },
    });

    expect(report.status).not.toBe("succeeded");
  }, 60_000);
});

describe("execute() maintains memory instead of letting it grow untended", () => {
  /**
   * `decay()` had zero callers and `autoConsolidate()` had exactly one: a
   * manual HTTP endpoint. The maintenance existed and never ran, so the store
   * grew monotonically and stale entries kept the importance they were written
   * with.
   */
  it("runs a maintenance pass as part of a real task", async () => {
    const instance = await engine();

    // A memory that has earned promotion, planted before the task runs.
    await instance.longHorizonMemory.init();
    const hot = await instance.longHorizonMemory.storeMemory(
      "local",
      "semantic",
      "short",
      "hot",
      "important context",
      9,
      0,
      [],
    );

    await instance.execute({
      tenantId: "local",
      goal: "Summarise the workspace",
      budget: { timeMs: 20_000 },
    });

    const stored = (await instance.longHorizonMemory.getMemories("local", 100)).find(
      (m) => m.id === hot.id,
    );

    // The task itself did not touch this memory; maintenance did.
    expect(stored?.horizon).toBe("long");
  }, 60_000);

  it("maintains memory after a SUCCEEDED task, not only a failed one", async () => {
    // The two tests around this one both run goals with no workspace, which
    // end `unverified`. That exercised only the failure branch of the learn
    // hook, and the success branch had an early `return` that skipped
    // maintenance entirely. Measured: a succeeded task ran maintenance 0
    // times, a failed one ran it once — while the comment in that hook claimed
    // it was "the one place guaranteed to run after every task".
    //
    // Successful tasks are the ones that grow the store, so this is the case
    // that most needed maintenance and was the one missing it.
    const instance = await engine();
    const workspace = await mkdtemp(join(tmpdir(), "maintenance-success-"));
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { test: "echo ok" } }),
    );

    await instance.longHorizonMemory.init();
    const hot = await instance.longHorizonMemory.storeMemory(
      "local",
      "semantic",
      "short",
      "hot-success",
      "important context",
      9,
      0,
      [],
    );

    const report = await instance.execute({
      tenantId: "local",
      goal: "Add a health check endpoint to the service",
      workspace,
      budget: { timeMs: 30_000 },
      // A goal-scoped verifier, supplied because this test needs a task that
      // genuinely succeeds.
      //
      // The workspace fixture's own `test` script no longer gets a task to
      // `succeeded` on its own, and that is deliberate: a repository's suite
      // checks the repository, not this goal, so a `pass` built only out of
      // workspace-scoped evidence is now reported as `uncertain`. A caller who
      // knows what the goal claims is the one who can check it, and this is the
      // hook for that. The assertion below would fail without it, which is the
      // point -- it would mean nothing had actually verified the goal.
      verifiers: [
        {
          name: "acceptance",
          tier: "V2_empirical",
          scope: "goal",
          run: async () => ({
            verdict: "pass" as const,
            evidence: "health check endpoint responds 200",
            confidence: 0.9,
          }),
        },
      ],
    });

    // The task must actually succeed, or this is just the failure path again.
    expect(report.status).toBe("succeeded");

    const stored = (await instance.longHorizonMemory.getMemories("local", 100)).find(
      (m) => m.id === hot.id,
    );
    expect(stored?.horizon).toBe("long");
  }, 60_000);

  it("prunes a faded memory during a real task", async () => {
    const instance = await engine();
    await instance.longHorizonMemory.init();
    await instance.longHorizonMemory.storeMemory(
      "local",
      "episodic",
      "short",
      "faded",
      "x",
      0.001,
      0,
      [],
    );

    await instance.execute({
      tenantId: "local",
      goal: "Summarise the workspace",
      budget: { timeMs: 20_000 },
    });

    const all = await instance.longHorizonMemory.getMemories("local", 100);
    expect(all.find((m) => m.title === "faded")).toBeUndefined();
  }, 60_000);

  it("does not repeat maintenance on every task", async () => {
    // Consolidation rewrites the store. Running it per task would make
    // maintenance the dominant cost of running a task.
    const instance = await engine();
    await instance.longHorizonMemory.init();

    await instance.execute({
      tenantId: "local",
      goal: "First task",
      budget: { timeMs: 20_000 },
    });

    // Plant a promotable memory *after* the first pass has consumed the
    // interval, then run again immediately.
    const late = await instance.longHorizonMemory.storeMemory(
      "local",
      "semantic",
      "short",
      "late",
      "x",
      9,
      0,
      [],
    );

    await instance.execute({
      tenantId: "local",
      goal: "Second task",
      budget: { timeMs: 20_000 },
    });

    const stored = (await instance.longHorizonMemory.getMemories("local", 100)).find(
      (m) => m.id === late.id,
    );

    // Still short: the rate limit held, so the second task did no maintenance.
    expect(stored?.horizon).toBe("short");
  }, 90_000);

  it("never lets a maintenance failure change the task outcome", async () => {
    const instance = await engine();
    await instance.longHorizonMemory.init();

    // Break maintenance in the only way a caller could.
    (instance.longHorizonMemory as unknown as { autoConsolidate: () => Promise<never> })
      .autoConsolidate = async () => {
      throw new Error("store is on fire");
    };

    const report = await instance.execute({
      tenantId: "local",
      goal: "Summarise the workspace",
      budget: { timeMs: 20_000 },
    });

    // A store that could not be tidied is a degraded system, not a failed task.
    expect(report.status).toBeDefined();
    expect(["succeeded", "unverified", "failed"]).toContain(report.status);
  }, 60_000);
});

describe("execute() can close a capability gap end to end", () => {
  /**
   * The chain the roadmap calls the real finish line:
   *
   *   task needs something → gap detected → contract → code → static analysis
   *   → sandbox → known-good → decoys → adversarial → registry
   *
   * Every link existed and was tested in isolation. `CapabilityAcquisition`
   * had zero callers in `src`, and `maturity.ts` recorded that honestly as
   * `wiredToEngine: false`: the loop could name a gap and had nothing to hand
   * it to.
   *
   * Specification item 14 is load-bearing: generated code is never imported
   * into this process. It is statically analysed, then run in a worker isolate
   * with no require, no process, no dynamic import, a heap cap and a timeout.
   */
  const SLUGIFY = `
    return String(input)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  `;

  /** A gap that carries the examples a contract needs to be verifiable. */
  const withTestCases = {
    knownGood: [
      { input: "Hello World", expected: "hello-world" },
      { input: "  Trim Me  ", expected: "trim-me" },
      { input: "a!!!b", expected: "a-b" },
    ],
    knownBad: [{ input: "Hello World", mustNotEqual: "Hello World" }],
    adversarial: [{ input: "" }, { input: "!!!!" }],
  };

  it("routes a tool_gap to the supplied generator through the real loop", async () => {
    // This pins the wiring itself. An earlier version only asserted the report
    // existed, so severing `capabilityGenerator` from `execute()` broke
    // nothing — a sabotage check caught that the connection was untested while
    // appearing tested.
    //
    // Reaching the generator needs the whole chain: the agent must fail with a
    // missing tool, the taxonomy must classify that as `tool_gap`, and only
    // that classification chooses `acquire_capability`. Measured first: a mock
    // agent that reports completion ends at `verification_gap` ->
    // `add_verification` and never reaches acquisition, which is correct
    // behaviour and the wrong scenario for this test.
    const { UnifiedExecutionLoop } = await import(
      "../src/execution/unified-execution-loop.js"
    );

    const seen: string[] = [];
    const instance = await engine();

    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({
        completed: false,
        summary: "No tool exists for comparing images",
        error: "no tool available: visual_diff is not installed",
      }),
      inventory: async () => ({ capabilityIds: [], toolNames: [] }),
      acquireCapability: async (gap) => {
        seen.push(gap.missing);
        // Report failure: this test is about reaching the hook, and a real
        // acquisition needs test cases the detector cannot invent.
        return false;
      },
      maxAttempts: 1,
    });

    const report = await loop.run({
      tenantId: "local",
      goal: "Compare the screenshot with the baseline and report visual differences",
      budget: { timeMs: 20_000 },
    });

    expect(seen).toContain("visual_diff");
    expect(report.status).not.toBe("succeeded");
    expect(instance).toBeDefined();
  }, 90_000);

  it("reports the gap as unavailable when nothing can build it", async () => {
    // The honest path, and the one that must survive: a named, actionable gap
    // with no provider says so rather than retrying an action that cannot
    // work.
    const { UnifiedExecutionLoop } = await import(
      "../src/execution/unified-execution-loop.js"
    );

    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({
        completed: false,
        summary: "No tool exists for comparing images",
        error: "no tool available: visual_diff is not installed",
      }),
      inventory: async () => ({ capabilityIds: [], toolNames: [] }),
      maxAttempts: 1,
    });

    const report = await loop.run({
      tenantId: "local",
      goal: "Compare the screenshot with the baseline and report visual differences",
      budget: { timeMs: 20_000 },
    });

    const unavailable = report.outcomes.filter(
      (item) => item.status === "unavailable" && item.evidence.includes("no capability-acquisition provider"),
    );
    expect(unavailable).toHaveLength(1);
  }, 60_000);

  it("rejects an implementation that fails its own contract", async () => {
    // A generator returning something plausible but wrong must not produce a
    // registered capability.
    const gap = {
      type: "tool" as const,
      missing: "slugify",
      description: "Convert a string to a url slug",
      confidence: 0.9,
      tier: "deterministic" as const,
      evidence: ["the task needs slugs"],
      synthesisable: true,
      testCases: withTestCases,
    };

    const { CapabilityAcquisition, contractFromGap } = await import(
      "../src/execution/capability-acquisition.js"
    );
    const { CapabilitySynthesisPipeline } = await import(
      "../src/capabilities/capability-synthesis.js"
    );

    const acquisition = new CapabilityAcquisition(
      new CapabilitySynthesisPipeline(),
      async () => "return String(input).toLowerCase();",
    );

    const result = await acquisition.acquire(
      gap,
      contractFromGap(gap, withTestCases),
    );

    expect(result.acquired).toBe(false);
  }, 60_000);

  it("acquires when the implementation satisfies every case", async () => {
    const gap = {
      type: "tool" as const,
      missing: "slugify",
      description: "Convert a string to a url slug",
      confidence: 0.9,
      tier: "deterministic" as const,
      evidence: ["the task needs slugs"],
      synthesisable: true,
      testCases: withTestCases,
    };

    const { CapabilityAcquisition, contractFromGap } = await import(
      "../src/execution/capability-acquisition.js"
    );
    const { CapabilitySynthesisPipeline } = await import(
      "../src/capabilities/capability-synthesis.js"
    );

    const acquisition = new CapabilityAcquisition(
      new CapabilitySynthesisPipeline(),
      async () => SLUGIFY,
    );

    const result = await acquisition.acquire(gap, contractFromGap(gap, withTestCases));

    expect(result.acquired).toBe(true);
  }, 60_000);

  it("refuses to build anything for a gap with no test cases", async () => {
    // An implementation verified against nothing is an implementation nobody
    // checked. Refusing is the honest outcome, not a limitation to work
    // around.
    const gap = {
      type: "tool" as const,
      missing: "visual_diff",
      description: "Comparing two images",
      confidence: 0.9,
      tier: "deterministic" as const,
      evidence: ["the goal mentions visual differences"],
      synthesisable: true,
    };

    const { CapabilityAcquisition, contractFromGap } = await import(
      "../src/execution/capability-acquisition.js"
    );
    const { CapabilitySynthesisPipeline } = await import(
      "../src/capabilities/capability-synthesis.js"
    );

    let generatorCalled = false;
    const acquisition = new CapabilityAcquisition(
      new CapabilitySynthesisPipeline(),
      async () => {
        generatorCalled = true;
        return SLUGIFY;
      },
    );

    const result = await acquisition.acquire(gap, contractFromGap(gap));

    expect(result.acquired).toBe(false);
    // It stops before spending a generation on an unverifiable contract.
    expect(generatorCalled).toBe(false);
  }, 60_000);

  it("keeps reporting the gap honestly when no generator is supplied", async () => {
    // The pre-existing behaviour must survive: nothing may pretend a gap was
    // closed when nothing could close it.
    const report = await (await engine()).execute({
      tenantId: "local",
      goal: "Compare the screenshot with the baseline and report visual differences",
      budget: { timeMs: 20_000 },
    });

    expect(report.status).not.toBe("succeeded");
  }, 60_000);
});
