/**
 * The full capability-acquisition loop (specification items 16 and 53).
 *
 *     Task
 *      → FAIL
 *      → GAP detected
 *      → CAPABILITY GENERATED
 *      → VERIFIED (known-good, decoys, adversarial)
 *      → REGISTERED
 *      → RETRY ORIGINAL TASK
 *      → SUCCESS
 *
 * This is the benchmark the specification calls "what really shows Aurora's
 * difference": a baseline agent fails the task outright, while an agent that
 * can acquire the missing capability goes on to pass it.
 */

import { describe, expect, it, vi } from "vitest";

import { CapabilitySynthesisPipeline } from "../src/capabilities/capability-synthesis.js";
import {
  CapabilityAcquisition,
  contractFromGap,
  type CapabilityContract,
} from "../src/execution/capability-acquisition.js";
import type { DetectedGap } from "../src/execution/gap-detection.js";
import {
  UnifiedExecutionLoop,
  type AgentRunResult,
} from "../src/execution/unified-execution-loop.js";

const SLUGIFY = `
  const text = String(input ?? "");
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
`;

function contractFor(gap: DetectedGap): CapabilityContract {
  return {
    ...contractFromGap(gap),
    knownGood: [
      { input: "Hello World", expected: "hello-world" },
      { input: "  Trim  Me  ", expected: "trim-me" },
    ],
    knownBad: [{ input: "Something Else Entirely", mustNotEqual: "hello-world" }],
    adversarial: [{ input: null }],
  };
}

describe("task → gap → acquire → retry original task → success", () => {
  it("completes the whole loop against the real synthesis pipeline", async () => {
    const acquirer = new CapabilityAcquisition(new CapabilitySynthesisPipeline(), async () => SLUGIFY);

    // The tool registry the "agent" consults.
    const registry = new Set<string>();

    const runAgent = vi.fn(async (): Promise<AgentRunResult> =>
      registry.has("slugify")
        ? { completed: true, summary: "Generated slugs for every title" }
        : { completed: false, summary: "failed", error: "Error: no such tool 'slugify'" },
    );

    const acquireCapability = vi.fn(async (gap: DetectedGap) => {
      const result = await acquirer.acquire(gap, contractFor(gap));
      if (result.acquired) registry.add(gap.missing);
      return result.acquired;
    });

    const loop = new UnifiedExecutionLoop(
      {
        runAgent,
        inventory: async () => ({ capabilityIds: [...registry] }),
        acquireCapability,
        verifiersFor: async () =>
          registry.has("slugify")
            ? [
                {
                  name: "acceptance",
                  tier: "V2_empirical" as const,
                  run: async () => ({ verdict: "pass" as const, evidence: "slugs produced", confidence: 0.9 }),
                },
              ]
            : [],
      },
      { maxAttempts: 3 },
    );

    const report = await loop.run({ tenantId: "t", goal: "Slugify every article title" });

    // The gap was named...
    expect(report.gaps.some((gap) => gap.missing === "slugify")).toBe(true);
    // ...a capability was built and verified...
    expect(acquireCapability).toHaveBeenCalledTimes(1);
    // ...and the ORIGINAL task was retried, not a substitute.
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(report.status).toBe("succeeded");
  }, 120_000);

  it("does not claim success when the generated capability is a cheat", async () => {
    // An implementation that memorises the known-good answers.
    const cheat = `
      const table = { "Hello World": "hello-world", "  Trim  Me  ": "trim-me" };
      return table[input] ?? "hello-world";
    `;
    const acquirer = new CapabilityAcquisition(new CapabilitySynthesisPipeline(), async () => cheat);
    const registry = new Set<string>();

    const runAgent = vi.fn(async (): Promise<AgentRunResult> =>
      registry.has("slugify")
        ? { completed: true, summary: "done" }
        : { completed: false, summary: "failed", error: "Error: no such tool 'slugify'" },
    );

    const loop = new UnifiedExecutionLoop(
      {
        runAgent,
        inventory: async () => ({ capabilityIds: [...registry] }),
        acquireCapability: async (gap) => {
          const result = await acquirer.acquire(gap, contractFor(gap));
          if (result.acquired) registry.add(gap.missing);
          return result.acquired;
        },
      },
      { maxAttempts: 3 },
    );

    const report = await loop.run({ tenantId: "t", goal: "Slugify every article title" });

    // The decoy stopped it, so the capability was never registered and the
    // task must not report success.
    expect(registry.has("slugify")).toBe(false);
    expect(report.status).not.toBe("succeeded");
    expect(runAgent).toHaveBeenCalledTimes(1);
  }, 120_000);
});

describe("capability reuse (specification item 53, second encounter)", () => {
  it("skips acquisition entirely the second time the capability is needed", async () => {
    const acquirer = new CapabilityAcquisition(new CapabilitySynthesisPipeline(), async () => SLUGIFY);
    const registry = new Set<string>();
    const acquireCapability = vi.fn(async (gap: DetectedGap) => {
      const result = await acquirer.acquire(gap, contractFor(gap));
      if (result.acquired) registry.add(gap.missing);
      return result.acquired;
    });

    const build = (): UnifiedExecutionLoop =>
      new UnifiedExecutionLoop(
        {
          runAgent: async () =>
            registry.has("slugify")
              ? { completed: true, summary: "ok" }
              : { completed: false, summary: "failed", error: "Error: no such tool 'slugify'" },
          inventory: async () => ({ capabilityIds: [...registry] }),
          acquireCapability,
          verifiersFor: async () =>
            registry.has("slugify")
              ? [
                  {
                    name: "acceptance",
                    tier: "V2_empirical" as const,
                    run: async () => ({ verdict: "pass" as const, evidence: "ok", confidence: 0.9 }),
                  },
                ]
              : [],
        },
        { maxAttempts: 3 },
      );

    const first = await build().run({ tenantId: "t", goal: "Slugify the article titles" });
    const second = await build().run({ tenantId: "t", goal: "Slugify the product names" });

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");

    // Acquired once, reused thereafter — the measurable difference.
    expect(acquireCapability).toHaveBeenCalledTimes(1);
    expect(second.attempts).toBeLessThan(first.attempts);
    expect(second.gaps).toHaveLength(0);
  }, 120_000);
});
