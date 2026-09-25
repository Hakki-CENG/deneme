import { describe, expect, it } from "vitest";

import { CapabilityBroker } from "../src/capabilities/capability-broker.js";
import { CapabilitySynthesisPipeline } from "../src/capabilities/capability-synthesis.js";
import {
  acquiredCapabilityId,
  publishAcquiredCapability,
} from "../src/execution/acquired-capability-adapter.js";
import {
  CapabilityAcquisition,
  contractFromGap,
} from "../src/execution/capability-acquisition.js";
import { detectGaps } from "../src/execution/gap-detection.js";

/**
 * The last link of the acquisition chain.
 *
 * An external audit put it precisely: "CAPABILITY GENERATED" and "CAPABILITY
 * AVAILABLE TO REAL AGENT" were different statements, and only the first was
 * true. `acquire()` returned `acquired: true` while the implementation stayed
 * in the synthesis pipeline's private map, so the loop retried the original
 * task against an inventory that had never heard of what was just built.
 */

const REAL_DIFF = `const a = input.a ?? []; const b = input.b ?? [];
const out = []; const n = Math.max(a.length, b.length);
for (let i = 0; i < n; i++) { if (a[i] !== b[i]) out.push(i); }
return out;`;

function broker(): CapabilityBroker {
  return new CapabilityBroker(
    { decide: async () => ({ decision: "allow", reasonCode: "ok", message: "" }) } as never,
    {} as never,
    { append: async () => undefined } as never,
  );
}

function context() {
  return {
    tenantId: "local",
    sessionId: "s",
    familyId: "f",
    turnId: "t",
    toolCallId: "c",
    source: "user",
  } as never;
}

function visualDiffGap() {
  const { gaps } = detectGaps({
    goal: "Compare the screenshot with the baseline and report visual differences",
    failures: [],
    inventory: { capabilityIds: [], descriptions: [] },
  });
  return gaps.find((item) => item.missing === "visual_diff")!;
}

async function acquire(pipeline: CapabilitySynthesisPipeline, code = REAL_DIFF) {
  const gap = visualDiffGap();
  const acquisition = new CapabilityAcquisition(pipeline, async () => code);
  const result = await acquisition.acquire(
    gap,
    contractFromGap(gap, {
      knownGood: gap.testCases?.knownGood ?? [],
      knownBad: gap.testCases?.knownBad ?? [],
      adversarial: gap.testCases?.adversarial ?? [],
    }),
  );
  return { gap, result };
}

describe("publishing an acquired capability to the real broker", () => {
  it("makes a verified capability appear in the broker inventory", async () => {
    const registry = broker();
    const pipeline = new CapabilitySynthesisPipeline();
    const { gap, result } = await acquire(pipeline);

    expect(result.acquired).toBe(true);
    expect(registry.list()).toHaveLength(0);

    const published = publishAcquiredCapability(registry, {
      name: gap.missing,
      description: gap.description,
      synthesisedId: result.capabilityId!,
      pipeline,
    });

    expect(published.published).toBe(true);
    const ids = registry.list().map((item) => item.id);
    expect(ids).toContain("acquired.visual_diff");
  }, 60_000);

  it("actually runs, delegating to the sandbox rather than this process", async () => {
    const registry = broker();
    const pipeline = new CapabilitySynthesisPipeline();
    const { gap, result } = await acquire(pipeline);

    const published = publishAcquiredCapability(registry, {
      name: gap.missing,
      description: gap.description,
      synthesisedId: result.capabilityId!,
      pipeline,
    });

    // The point of the whole chain: a real broker call produces a real answer.
    const output = await registry.execute(
      published.capabilityId,
      { a: [1, 2, 3], b: [1, 9, 3] },
      context(),
    );
    expect(output).toEqual([1]);

    // And it is genuinely computing, not replaying the verification case.
    const second = await registry.execute(
      published.capabilityId,
      { a: [4, 4, 4, 4], b: [4, 0, 4, 0] },
      context(),
    );
    expect(second).toEqual([1, 3]);
  }, 60_000);

  it("namespaces the id so nothing generated can shadow a core capability", () => {
    expect(acquiredCapabilityId("fs.write")).toBe("acquired.fs.write");
    expect(acquiredCapabilityId("visual_diff")).toBe("acquired.visual_diff");
  });

  it("declares what the sandbox actually permits", async () => {
    const registry = broker();
    const pipeline = new CapabilitySynthesisPipeline();
    const { gap, result } = await acquire(pipeline);

    publishAcquiredCapability(registry, {
      name: gap.missing,
      description: gap.description,
      synthesisedId: result.capabilityId!,
      pipeline,
    });

    const descriptor = registry.list().find((item) => item.id === "acquired.visual_diff");
    // `pure` is a statement about reach, not about trust: the sandbox has no
    // filesystem, network or process access. The youth of the implementation
    // is carried by the description and the `acquired.` namespace instead.
    expect(descriptor?.risk).toBe("pure");
    expect(descriptor?.sideEffect).toBe(false);
    expect(descriptor?.description).toMatch(/sandbox/i);
  }, 60_000);

  it("reports a duplicate instead of throwing inside the broker", async () => {
    const registry = broker();
    const pipeline = new CapabilitySynthesisPipeline();
    const { gap, result } = await acquire(pipeline);

    const input = {
      name: gap.missing,
      description: gap.description,
      synthesisedId: result.capabilityId!,
      pipeline,
    };

    expect(publishAcquiredCapability(registry, input).published).toBe(true);

    // Closing the same gap twice in one process is normal; the broker throws
    // on re-registration, so this must be handled rather than propagated.
    const again = publishAcquiredCapability(registry, input);
    expect(again.published).toBe(false);
    expect(again.reason).toMatch(/already registered/i);
    expect(registry.list()).toHaveLength(1);
  }, 60_000);

  it("surfaces a sandbox failure as an error rather than a null result", async () => {
    const registry = broker();
    const pipeline = new CapabilitySynthesisPipeline();
    const { gap, result } = await acquire(pipeline);

    const published = publishAcquiredCapability(registry, {
      name: gap.missing,
      description: gap.description,
      synthesisedId: result.capabilityId!,
      pipeline,
    });

    // A non-object input is rejected by validate() before anything runs.
    await expect(
      registry.execute(published.capabilityId, "not an object" as never, context()),
    ).rejects.toThrow(/expects an object/i);
  }, 60_000);
});
