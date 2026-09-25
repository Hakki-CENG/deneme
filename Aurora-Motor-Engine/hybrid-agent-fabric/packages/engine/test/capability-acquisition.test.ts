/**
 * Capability acquisition — closing a gap, with proof.
 *
 * The test that matters most is the decoy test. A capability that passes every
 * known-good case may still be a cheat: `return true`, or a lookup table of the
 * test inputs. Known-bad decoys are inputs where the correct behaviour is to
 * produce something *different* from a stated wrong answer. An implementation
 * that "passes" a decoy has been caught pattern-matching its tests.
 *
 * Without that check, capability synthesis is a reward-hacking machine: the
 * agent learns to satisfy the grader rather than to do the work.
 */

import { describe, expect, it, vi } from "vitest";

import { CapabilitySynthesisPipeline } from "../src/capabilities/capability-synthesis.js";
import {
  CapabilityAcquisition,
  analyseStatically,
  contractFromGap,
  type CapabilityContract,
} from "../src/execution/capability-acquisition.js";
import type { DetectedGap } from "../src/execution/gap-detection.js";

const GAP: DetectedGap = {
  type: "tool",
  missing: "slugify",
  description: "Turn a title into a URL slug",
  confidence: 0.93,
  tier: "deterministic",
  evidence: ["test"],
  synthesisable: true,
};

/** A contract with real cases, decoys and hostile input. */
const CONTRACT: CapabilityContract = {
  ...contractFromGap(GAP),
  inputSchema: "string",
  outputSchema: "string",
  knownGood: [
    { input: "Hello World", expected: "hello-world" },
    { input: "  Trim  Me  ", expected: "trim-me" },
    { input: "Already-Slugged", expected: "already-slugged" },
  ],
  knownBad: [
    {
      input: "Completely Different Input",
      mustNotEqual: "hello-world",
      note: "a hard-coded implementation returns the first known-good answer",
    },
  ],
  adversarial: [
    { input: "a".repeat(10_000), note: "very long input" },
    { input: null, note: "null input" },
  ],
};

const HONEST = `
  const text = String(input ?? "");
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
`;

/** Returns the right answers by memorising them. Passes known-good, fails decoys. */
const CHEAT = `
  const table = {
    "Hello World": "hello-world",
    "  Trim  Me  ": "trim-me",
    "Already-Slugged": "already-slugged"
  };
  return table[input] ?? "hello-world";
`;

function acquisition(code: string, options = {}): CapabilityAcquisition {
  return new CapabilityAcquisition(new CapabilitySynthesisPipeline(), async () => code, options);
}

describe("a correct implementation is acquired", () => {
  it("passes known-good, rejects the decoy, survives hostile input", async () => {
    const result = await acquisition(HONEST).acquire(GAP, CONTRACT);

    expect(result.acquired).toBe(true);
    expect(result.state).toBe("verified");
    expect(result.capabilityId).toBeTruthy();

    const names = result.steps.filter((step) => step.passed).map((step) => step.name);
    expect(names).toContain("known-good");
    expect(names).toContain("known-bad-decoys");
    expect(names).toContain("adversarial");
  }, 60_000);
});

describe("a test-matching cheat is caught", () => {
  it("rejects an implementation that memorises the known-good answers", async () => {
    const result = await acquisition(CHEAT).acquire(GAP, CONTRACT);

    // It would have passed every known-good case.
    const knownGood = result.steps.find((step) => step.name === "known-good");
    expect(knownGood?.passed).toBe(true);

    // The decoy is what catches it.
    const decoys = result.steps.find((step) => step.name === "known-bad-decoys");
    expect(decoys?.passed).toBe(false);
    expect(decoys?.detail).toContain("could not produce");

    expect(result.acquired).toBe(false);
    expect(result.state).toBe("quarantined");
    expect(result.summary).toContain("pattern-match");
  }, 60_000);

  it("rejects a constant-returning implementation", async () => {
    const result = await acquisition(`return "hello-world";`).acquire(GAP, CONTRACT);
    expect(result.acquired).toBe(false);
  }, 60_000);
});

describe("a wrong implementation is rejected before the decoys", () => {
  it("fails the known-good checks", async () => {
    const result = await acquisition(`return String(input ?? "").toUpperCase();`).acquire(GAP, CONTRACT);

    expect(result.acquired).toBe(false);
    const knownGood = result.steps.find((step) => step.name === "known-good");
    expect(knownGood?.passed).toBe(false);
    expect(knownGood?.detail).toContain("expected");
  }, 60_000);
});

describe("static analysis runs before execution", () => {
  it("flags dangerous constructs", () => {
    expect(analyseStatically(`require('fs')`).safe).toBe(false);
    expect(analyseStatically(`process.exit(1)`).safe).toBe(false);
    expect(analyseStatically(`eval("x")`).safe).toBe(false);
    expect(analyseStatically(`fetch("http://x")`).safe).toBe(false);
    expect(analyseStatically(`return input;`).safe).toBe(true);
  });

  it("rejects an implementation that reaches for the filesystem, without running it", async () => {
    const result = await acquisition(`const fs = require('fs'); return fs.readFileSync('/etc/passwd');`)
      .acquire(GAP, CONTRACT);

    expect(result.acquired).toBe(false);
    const analysis = result.steps.find((step) => step.name === "static-analysis");
    expect(analysis?.passed).toBe(false);
    expect(analysis?.detail).toContain("requires a module");
    // It must never have reached the sandbox.
    expect(result.steps.some((step) => step.name === "sandbox")).toBe(false);
  }, 60_000);

  it("treats an empty implementation as unsafe", () => {
    expect(analyseStatically("   ").safe).toBe(false);
  });
});

describe("contracts that cannot be verified are refused", () => {
  it("refuses a contract with too few known-good cases", async () => {
    const thin: CapabilityContract = { ...CONTRACT, knownGood: [CONTRACT.knownGood[0]!] };
    const result = await acquisition(HONEST).acquire(GAP, thin);

    expect(result.acquired).toBe(false);
    expect(result.state).toBe("draft");
    expect(result.summary).toContain("too few known-good");
  });

  it("refuses a contract with no decoys", async () => {
    const undefended: CapabilityContract = { ...CONTRACT, knownBad: [] };
    const result = await acquisition(HONEST).acquire(GAP, undefended);

    expect(result.acquired).toBe(false);
    expect(result.summary).toContain("no decoys");
  });

  it("refuses to synthesise a gap that needs an external backend", async () => {
    const external: DetectedGap = { ...GAP, missing: "ocr", synthesisable: false };
    const result = await acquisition(HONEST).acquire(external, CONTRACT);

    expect(result.acquired).toBe(false);
    expect(result.summary).toContain("external backend");
  });
});

describe("the generator is mandatory", () => {
  it("cannot be constructed without one", () => {
    expect(() => new CapabilityAcquisition(new CapabilitySynthesisPipeline(), undefined as never)).toThrow(
      /requires an implementation generator/,
    );
  });

  it("reports honestly when the generator fails", async () => {
    const acquirer = new CapabilityAcquisition(new CapabilitySynthesisPipeline(), async () => {
      throw new Error("model refused");
    });

    const result = await acquirer.acquire(GAP, CONTRACT);
    expect(result.acquired).toBe(false);
    expect(result.steps.find((step) => step.name === "implementation")?.detail).toContain("model refused");
  });
});

describe("generated code stays out of the core process", () => {
  it("never imports the implementation, only runs it in the sandbox", async () => {
    // A capability that tried to mutate this process would have to get past
    // static analysis and then escape the worker isolate.
    const marker = (globalThis as Record<string, unknown>)["__acquisitionEscape"];
    expect(marker).toBeUndefined();

    await acquisition(`return String(input ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");`)
      .acquire(GAP, CONTRACT);

    expect((globalThis as Record<string, unknown>)["__acquisitionEscape"]).toBeUndefined();
  }, 60_000);
});

describe("acquisition plugs into the execution loop", () => {
  it("produces a provider shaped for UnifiedExecutionLoop.acquireCapability", async () => {
    const acquirer = acquisition(HONEST);
    const provider = vi.fn(async (gap: DetectedGap) => {
      const result = await acquirer.acquire(gap, CONTRACT);
      return result.acquired;
    });

    await expect(provider(GAP)).resolves.toBe(true);
  }, 60_000);
});
