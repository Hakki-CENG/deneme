/**
 * A6: recovery must not repeat work that already landed.
 *
 * Two halves, both measured before the fix:
 *
 * 1. **Capability acquisition was not idempotent.** The execution loop calls
 *    `acquireCapability` from a recovery path, so the same gap can be asked for
 *    more than once. `synthesizeCapability` mints a `randomUUID()` id, so the
 *    second request registered a *second* capability and paid for a second
 *    sandbox run to reach a verdict that was already recorded.
 *
 * 2. **Side-effect keys were per-call, not per-effect.** The capability context
 *    carries `${commandId}:${toolCallId}`, both fresh on every attempt, so the
 *    effect journal — which already dedupes by that key — could never recognise
 *    a repeated effect. `TaskContext.effectKey` gives a key that is stable
 *    within an attempt and different across attempts.
 */
import { describe, expect, it } from "vitest";
import { AuroraCognitiveRuntime } from "../src/aurora/cognitive-runtime.js";
import { TaskContext } from "../src/execution/task-context.js";

describe("TaskContext.effectKey", () => {
  it("is stable for the same effect within an attempt", () => {
    const context = new TaskContext({ tenantId: "t", goal: "ship it" });
    const a = context.effectKey({ capability: "filesystem.write", path: "/a.txt", bytes: 12 });
    const b = context.effectKey({ capability: "filesystem.write", path: "/a.txt", bytes: 12 });
    expect(a).toBe(b);
    expect(a).toContain(context.taskId);
  });

  it("does not depend on the order the arguments were written in", () => {
    const context = new TaskContext({ tenantId: "t", goal: "ship it" });
    const a = context.effectKey({ capability: "http.post", url: "https://x", body: { a: 1, b: 2 } });
    const b = context.effectKey({ url: "https://x", body: { b: 2, a: 1 }, capability: "http.post" });
    expect(a).toBe(b);
  });

  it("distinguishes two different effects, including nested ones", () => {
    const context = new TaskContext({ tenantId: "t", goal: "ship it" });
    const a = context.effectKey({ capability: "filesystem.write", path: "/a.txt" });
    const b = context.effectKey({ capability: "filesystem.write", path: "/b.txt" });
    const nestedA = context.effectKey({ capability: "x", payload: { inner: { n: 1 } } });
    const nestedB = context.effectKey({ capability: "x", payload: { inner: { n: 2 } } });
    expect(a).not.toBe(b);
    expect(nestedA).not.toBe(nestedB);
  });

  it("changes with the attempt, so a deliberate second try is not a silent no-op", () => {
    const context = new TaskContext({ tenantId: "t", goal: "ship it" });
    const scope = { capability: "channel.send", destination: "ops" };
    const first = context.effectKey(scope);
    context.attempt = 2;
    const second = context.effectKey(scope);
    expect(first).not.toBe(second);
  });

  it("is separate per task", () => {
    const a = new TaskContext({ tenantId: "t", goal: "A" });
    const b = new TaskContext({ tenantId: "t", goal: "B" });
    const scope = { capability: "filesystem.write", path: "/shared.txt" };
    expect(a.effectKey(scope)).not.toBe(b.effectKey(scope));
  });
});

describe("capability acquisition is idempotent per request", () => {
  const request = {
    name: "adder",
    description: "adds two numbers",
    code: "return input.a + input.b;",
    testInput: { a: 20, b: 22 },
    expectedOutput: 42,
  };

  it("answers a repeated request with the recorded capability instead of making another", async () => {
    const runtime = new AuroraCognitiveRuntime();
    const before = runtime.capabilitySynthesis.getStats().synthesis.totalCapabilities;

    const first = await runtime.acquireCapability(request);
    const second = await runtime.acquireCapability(request);

    expect(first.verified).toBe(true);
    expect(first.replayed).toBeUndefined();

    expect(second.capabilityId).toBe(first.capabilityId);
    expect(second.verified).toBe(true);
    expect(second.replayed).toBe(true);

    // The duplicate is what actually mattered: two capabilities with different
    // ids means the registry holds two entries for one gap, and the second is
    // the one a later lookup is most likely to find. Without the fix this is 2.
    expect(runtime.capabilitySynthesis.getStats().synthesis.totalCapabilities).toBe(before + 1);
  }, 120_000);

  it("replays a rejection too, rather than giving it a second unasked-for chance", async () => {
    const runtime = new AuroraCognitiveRuntime();
    const broken = { name: "broken-adder", description: "claims to add", code: "return 0;", testInput: { a: 20, b: 22 }, expectedOutput: 42 };

    const first = await runtime.acquireCapability(broken);
    const second = await runtime.acquireCapability(broken);

    expect(first.verified).toBe(false);
    expect(second.verified).toBe(false);
    expect(second.capabilityId).toBe(first.capabilityId);
    expect(second.replayed).toBe(true);
  }, 120_000);

  it("still synthesises separately when the request actually differs", async () => {
    const runtime = new AuroraCognitiveRuntime();
    const a = await runtime.acquireCapability({ ...request, name: "adder-a" });
    const b = await runtime.acquireCapability({ ...request, name: "adder-b" });

    expect(a.capabilityId).not.toBe(b.capabilityId);
    expect(a.replayed).toBeUndefined();
    expect(b.replayed).toBeUndefined();
  }, 120_000);
});
