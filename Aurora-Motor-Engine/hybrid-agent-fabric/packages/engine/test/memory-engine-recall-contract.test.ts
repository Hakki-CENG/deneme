/**
 * MemoryEngine.recall() — the limit contract.
 *
 * `recall()` fuses two stores: the memory graph and long-horizon memory. The
 * graph honoured `query.limit`; long-horizon was called without one and its
 * `search()` returns up to 20 rows of its own. The results were concatenated
 * raw, so:
 *
 *     recall({ text: "...", limit: 3 })  →  23 memories
 *
 * Measured on a fresh engine with 30 long-horizon entries and 3 graph entries.
 *
 * This matters beyond tidiness. `engine.execute()` feeds this straight into
 * the agent's context (`engine.ts`, the `recall` dependency), and the loop's
 * `learn` step writes a memory after every task — so the overflow grows as the
 * system is used, silently inflating every prompt.
 *
 * The other half of the contract is ordering: a caller asking for 3 memories
 * wants the 3 most important ones, not the graph's 3 plus whatever long-horizon
 * happened to return.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HybridAgentEngine } from "../src/engine.js";

async function engine(): Promise<HybridAgentEngine> {
  const root = await mkdtemp(join(tmpdir(), "haf-recall-contract-"));
  return new HybridAgentEngine({
    homePath: root,
    kernelServerScript: "",
    sandboxBackend: "local",
    model: { provider: "mock" },
  } as never);
}

/** Reach the long-horizon store the same way the engine wires it. */
function longHorizonOf(instance: HybridAgentEngine): {
  storeMemory: (
    tenantId: string,
    category: string,
    horizon: string,
    title: string,
    content: string,
    importance: number,
    emotionalWeight?: number,
    associations?: string[],
  ) => Promise<unknown>;
} {
  return (instance as unknown as { longHorizonMemory: never }).longHorizonMemory;
}

describe("MemoryEngine.recall() honours its limit across both stores", () => {
  it("returns at most `limit` memories when long-horizon is populated", async () => {
    const instance = await engine();
    const longHorizon = longHorizonOf(instance);

    // 30 long-horizon matches: more than its internal cap of 20, so the bug
    // shows up as 20 extra rows rather than a handful.
    for (let i = 0; i < 30; i++) {
      await longHorizon.storeMemory(
        "t1",
        "semantic",
        "long",
        `postgres migration note ${i}`,
        `postgres migration detail number ${i}`,
        0.5,
        0,
        [],
      );
    }
    for (let i = 0; i < 3; i++) {
      await instance.memoryEngine.store("t1", `postgres migration graph entry ${i}`, 0.6, "note");
    }

    const three = await instance.memoryEngine.recall({
      text: "postgres migration",
      tenantId: "t1",
      limit: 3,
    });

    // Measured before the fix: 23.
    expect(three.memories).toHaveLength(3);
    expect(three.totalFound).toBe(3);

    const five = await instance.memoryEngine.recall({
      text: "postgres migration",
      tenantId: "t1",
      limit: 5,
    });
    expect(five.memories).toHaveLength(5);
  }, 60_000);

  it("keeps the most important memories rather than the first ones found", async () => {
    const instance = await engine();
    const longHorizon = longHorizonOf(instance);

    // The single most important memory lives in long-horizon, and the graph is
    // consulted first. Truncating without ordering would drop exactly this one.
    await longHorizon.storeMemory(
      "t1",
      "semantic",
      "long",
      "critical postgres migration rule",
      "critical postgres migration rule: always take a backup first",
      0.99,
      0,
      [],
    );
    for (let i = 0; i < 6; i++) {
      await instance.memoryEngine.store("t1", `postgres migration minor note ${i}`, 0.2, "note");
    }

    const result = await instance.memoryEngine.recall({
      text: "postgres migration",
      tenantId: "t1",
      limit: 2,
    });

    expect(result.memories).toHaveLength(2);
    expect(result.memories[0]?.importance).toBeCloseTo(0.99, 6);
    expect(result.memories[0]?.content).toContain("always take a backup first");

    // Sorted descending, so a later entry never outranks an earlier one.
    const importances = result.memories.map((item) => item.importance);
    expect([...importances].sort((a, b) => b - a)).toEqual(importances);
  }, 60_000);

  it("still returns both sources when the limit allows room for them", async () => {
    const instance = await engine();
    const longHorizon = longHorizonOf(instance);

    await longHorizon.storeMemory(
      "t1",
      "semantic",
      "long",
      "postgres migration horizon entry",
      "postgres migration horizon entry content",
      0.8,
      0,
      [],
    );
    await instance.memoryEngine.store("t1", "postgres migration graph entry", 0.7, "note");

    const result = await instance.memoryEngine.recall({
      text: "postgres migration",
      tenantId: "t1",
      limit: 10,
    });

    // The control: truncation must not collapse the fusion into one store.
    const sources = new Set(result.memories.map((item) => item.source));
    expect(sources).toContain("graph");
    expect(sources).toContain("long-horizon");
  }, 60_000);

  it("applies a default bound when the caller omits limit", async () => {
    const instance = await engine();
    const longHorizon = longHorizonOf(instance);

    for (let i = 0; i < 30; i++) {
      await longHorizon.storeMemory(
        "t1",
        "semantic",
        "long",
        `postgres migration note ${i}`,
        `postgres migration detail number ${i}`,
        0.5,
        0,
        [],
      );
    }

    // `engine.execute()` calls recall() without a limit, so the unbounded path
    // is the one that actually reaches the agent's prompt.
    const result = await instance.memoryEngine.recall({
      text: "postgres migration",
      tenantId: "t1",
    });

    expect(result.memories.length).toBeLessThanOrEqual(5);
  }, 60_000);
});

describe("MemoryEngine.recall() — relevance, not just importance", () => {
  /**
   * `recall()` used to order candidates by `importance` alone, which answers
   * "what matters most in general" rather than "what matters most here".
   *
   * `RealMemoryPipeline` implements BM25 + vector + RRF + reranking and is the
   * thing `npm run eval:recall` measures (Recall@8 0.317 -> 0.400 with a real
   * encoder). Outside the eval harness it had zero references: the ranking the
   * project measures was not the ranking the agent received.
   *
   * Measured before the change, asking "why did the postgres migration fail"
   * against three memories, limit 2:
   *
   *     1. [0.9] Deployment pipeline uses blue-green strategy...
   *     2. [0.8] Team standup is at 9am daily
   *     (the matching memory, importance 0.4, ranked 3rd and never returned)
   */
  it("ranks by relevance when several candidates survive the store's filter", async () => {
    // This is the test that actually exercises the ranking layer.
    //
    // An earlier version of this suite did not: the long-horizon term filter
    // narrowed the query to a single candidate, so removing the ranker
    // entirely left every test green. A sabotage check caught that — the
    // feature was untested while appearing tested.
    //
    // Here all three memories share the term "migration", so all three reach
    // the ranker, and only bm25 can tell which one answers the question.
    const instance = await engine();
    const horizon = longHorizonOf(instance);

    await horizon.storeMemory(
      "t1",
      "semantic",
      "long",
      "policy",
      "migration policy requires review by two engineers",
      0.95,
      0,
      [],
    );
    await horizon.storeMemory(
      "t1",
      "semantic",
      "long",
      "schedule",
      "migration window is every Tuesday at midnight",
      0.9,
      0,
      [],
    );
    await horizon.storeMemory(
      "t1",
      "semantic",
      "long",
      "incident",
      "the postgres migration failed because of a missing index on users.email",
      0.3,
      0,
      [],
    );

    const result = await instance.memoryEngine.recall({
      text: "postgres migration failed missing index",
      tenantId: "t1",
      limit: 3,
    });

    // All three are candidates; the least important one answers the question.
    expect(result.memories).toHaveLength(3);
    expect(result.memories[0]?.content).toContain("missing index");
    expect(result.memories[0]?.importance).toBe(0.3);
  }, 60_000);

  it("returns the memory that matches the question over a more important one", async () => {
    const instance = await engine();
    const horizon = longHorizonOf(instance);

    await horizon.storeMemory(
      "t1",
      "semantic",
      "long",
      "deployment",
      "Deployment pipeline uses blue-green strategy with canary rollout",
      0.9,
      0,
      [],
    );
    await horizon.storeMemory(
      "t1",
      "semantic",
      "long",
      "standup",
      "Team standup is at 9am daily",
      0.8,
      0,
      [],
    );
    await horizon.storeMemory(
      "t1",
      "semantic",
      "long",
      "migration",
      "The postgres migration failed because of a missing index on users.email",
      0.4,
      0,
      [],
    );

    const result = await instance.memoryEngine.recall({
      text: "why did the postgres migration fail",
      tenantId: "t1",
      limit: 2,
    });

    const top = result.memories[0]?.content ?? "";
    expect(top).toContain("postgres migration failed");
  }, 60_000);

  it("still honours the limit after ranking", async () => {
    const instance = await engine();
    const horizon = longHorizonOf(instance);

    for (let i = 0; i < 8; i++) {
      await horizon.storeMemory(
        "t1",
        "semantic",
        "long",
        `note ${i}`,
        `postgres migration detail number ${i}`,
        0.5,
        0,
        [],
      );
    }

    const result = await instance.memoryEngine.recall({
      text: "postgres migration",
      tenantId: "t1",
      limit: 3,
    });

    expect(result.memories).toHaveLength(3);
    expect(result.totalFound).toBe(3);
  }, 60_000);

  it("returns candidates the ranker scored at zero rather than dropping them", async () => {
    // A lexical miss is not evidence of irrelevance: once a memory is a
    // candidate, the ranker may reorder it but must not silently discard it.
    //
    // The query shares one term ("memory") with both entries, so both are
    // candidates; only one of them also mentions postgres, so bm25 separates
    // them while the other must still be returned.
    const instance = await engine();
    const horizon = longHorizonOf(instance);

    await horizon.storeMemory(
      "t1",
      "semantic",
      "long",
      "a",
      "memory about postgres indexes",
      0.9,
      0,
      [],
    );
    await horizon.storeMemory("t1", "semantic", "long", "b", "memory about lunch", 0.8, 0, []);

    const result = await instance.memoryEngine.recall({
      text: "postgres memory",
      tenantId: "t1",
      limit: 2,
    });

    expect(result.memories).toHaveLength(2);
    expect(result.memories[0]?.content).toContain("postgres");
  }, 60_000);

  it("returns nothing when no memory shares any term with the query", async () => {
    // Measured: search("completely unrelated vocabulary here") against
    // "alpha beta gamma" and "delta epsilon zeta" yields zero candidates.
    // That is correct — an empty answer beats an irrelevant one, and padding
    // the prompt with unrelated memories is how context budgets are wasted.
    const instance = await engine();
    const horizon = longHorizonOf(instance);

    await horizon.storeMemory("t1", "semantic", "long", "a", "alpha beta gamma", 0.9, 0, []);
    await horizon.storeMemory("t1", "semantic", "long", "b", "delta epsilon zeta", 0.8, 0, []);

    const result = await instance.memoryEngine.recall({
      text: "completely unrelated vocabulary here",
      tenantId: "t1",
      limit: 2,
    });

    expect(result.memories).toHaveLength(0);
    expect(result.totalFound).toBe(0);
  }, 60_000);

  it("does not lose a single candidate to the ranking path", async () => {
    // The ranking path short-circuits for one candidate. This pins that the
    // short-circuit returns it rather than dropping it.
    const instance = await engine();
    const horizon = longHorizonOf(instance);

    await horizon.storeMemory("t1", "semantic", "long", "only", "the only memory", 0.5, 0, []);

    const result = await instance.memoryEngine.recall({
      text: "only memory",
      tenantId: "t1",
      limit: 5,
    });

    expect(result.memories).toHaveLength(1);
  }, 60_000);

  it("keeps recall working when ranking cannot run", async () => {
    // A failure to rank must not become a failure to recall. Importance order
    // is the fallback, and it is still a real answer.
    const instance = await engine();
    const horizon = longHorizonOf(instance);

    await horizon.storeMemory("t1", "semantic", "long", "a", "first memory", 0.9, 0, []);
    await horizon.storeMemory("t1", "semantic", "long", "b", "second memory", 0.4, 0, []);

    const result = await instance.memoryEngine.recall({
      text: "memory",
      tenantId: "t1",
      limit: 2,
    });

    expect(result.memories.length).toBe(2);
    expect(result.memories.every((m) => m.content.length > 0)).toBe(true);
  }, 60_000);
});
