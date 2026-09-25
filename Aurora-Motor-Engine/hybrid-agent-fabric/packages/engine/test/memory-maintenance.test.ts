/**
 * Memory maintenance: decay, consolidation, promotion.
 *
 * `autoConsolidate` used to report work it had not done. Measured before the
 * fix, on a store holding one short-term memory of importance 9:
 *
 *     autoConsolidate() -> { promoted: 1, insights: ["Promoted 'hot' from
 *                            short to long-term (importance: 9)"] }
 *     memories.find(m => m.title === "hot").horizon -> "short"
 *
 * The prose said promoted, the store said short, and nothing reconciled them.
 * A maintenance routine that reports work it did not do is worse than one that
 * does nothing, because the caller stops checking.
 *
 * Every test here compares a reported number against the state it claims to
 * describe. That is the only way this class of bug shows up.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LongHorizonMemoryService,
  MAX_IMPORTANCE,
  PRUNE_THRESHOLD,
} from "../src/aurora/long-horizon-memory.js";

const TENANT = "t1";

function service(): LongHorizonMemoryService {
  return new LongHorizonMemoryService(mkdtempSync(join(tmpdir(), "mem-maint-")));
}

describe("consolidate", () => {
  let memory: LongHorizonMemoryService;

  beforeEach(async () => {
    memory = service();
    await memory.init();
  });

  it("does not demote merged knowledge to importance 1", async () => {
    // The formula was `Math.min(1, maxImportance + 0.1)` on a 0..10 scale, so
    // merging two memories of importance 9 produced one of importance 1. The
    // clamp always landed on a plausible number, which is why it survived.
    const a = await memory.storeMemory(TENANT, "semantic", "short", "A", "x", 9, 0, []);
    const b = await memory.storeMemory(TENANT, "semantic", "short", "B", "y", 8, 0, []);

    const merged = await memory.consolidate([a.id, b.id], "merged", "z");

    expect(merged.importance).toBeGreaterThan(9);
    expect(merged.importance).toBeLessThanOrEqual(MAX_IMPORTANCE);
  });

  it("never exceeds the top of the scale", async () => {
    const a = await memory.storeMemory(TENANT, "semantic", "short", "A", "x", 10, 0, []);

    const merged = await memory.consolidate([a.id], "merged", "z");

    expect(merged.importance).toBeLessThanOrEqual(MAX_IMPORTANCE);
  });

  it("records lineage so a consolidation can be audited", async () => {
    const a = await memory.storeMemory(TENANT, "semantic", "short", "A", "x", 5, 0, []);
    const b = await memory.storeMemory(TENANT, "semantic", "short", "B", "y", 5, 0, []);

    const merged = await memory.consolidate([a.id, b.id], "merged", "z");

    expect(merged.consolidatedFrom).toEqual([a.id, b.id]);
  });

  it("keeps the sources rather than destroying them", async () => {
    // Pruning is decay's job, and only once they have actually faded.
    const a = await memory.storeMemory(TENANT, "semantic", "short", "A", "x", 5, 0, []);

    await memory.consolidate([a.id], "merged", "z");
    const all = await memory.getMemories(TENANT, 100);

    expect(all.find((m) => m.id === a.id)).toBeDefined();
  });
});

describe("decay", () => {
  let memory: LongHorizonMemoryService;

  beforeEach(async () => {
    memory = service();
    await memory.init();
  });

  it("reports what it did instead of returning void", async () => {
    // The old signature was `Promise<void>`, so a caller could not distinguish
    // a run that pruned half the store from one that touched nothing. That is
    // part of why nothing ever called it.
    await memory.storeMemory(TENANT, "episodic", "short", "A", "x", 5, 0, []);

    const result = await memory.decay();

    expect(result).toHaveProperty("aged");
    expect(result).toHaveProperty("pruned");
    expect(result.aged).toBeGreaterThanOrEqual(0);
  });

  it("never ages a permanent memory", async () => {
    const permanent = await memory.storeMemory(TENANT, "semantic", "permanent", "P", "x", 5, 0, []);

    await memory.decay();
    const all = await memory.getMemories(TENANT, 100);

    expect(all.find((m) => m.id === permanent.id)?.importance).toBe(5);
  });

  it("prunes a memory that has faded below the threshold", async () => {
    const doomed = await memory.storeMemory(
      TENANT,
      "episodic",
      "short",
      "faded",
      "x",
      PRUNE_THRESHOLD / 2,
      0,
      [],
    );

    const result = await memory.decay();
    const all = await memory.getMemories(TENANT, 100);

    expect(result.pruned).toBe(1);
    expect(result.prunedTitles).toContain("faded");
    expect(all.find((m) => m.id === doomed.id)).toBeUndefined();
  });

  it("keeps a faded permanent memory", async () => {
    // Permanence outranks importance: a permanent memory is kept because
    // someone decided it must be, not because it scored well.
    const kept = await memory.storeMemory(TENANT, "semantic", "permanent", "P", "x", 0, 0, []);

    const result = await memory.decay();
    const all = await memory.getMemories(TENANT, 100);

    expect(result.pruned).toBe(0);
    expect(all.find((m) => m.id === kept.id)).toBeDefined();
  });

  it("reported prune count matches what actually left the store", async () => {
    for (let i = 0; i < 3; i++) {
      await memory.storeMemory(TENANT, "episodic", "short", `gone-${i}`, "x", 0.001, 0, []);
    }
    await memory.storeMemory(TENANT, "episodic", "short", "stays", "x", 8, 0, []);

    const before = (await memory.getMemories(TENANT, 100)).length;
    const result = await memory.decay();
    const after = (await memory.getMemories(TENANT, 100)).length;

    expect(result.pruned).toBe(before - after);
    expect(result.pruned).toBe(3);
  });
});

describe("autoConsolidate", () => {
  let memory: LongHorizonMemoryService;

  beforeEach(async () => {
    memory = service();
    await memory.init();
  });

  it("actually promotes, instead of only counting candidates", async () => {
    // The exact bug: reported promoted: 1 while the memory stayed short-term.
    const hot = await memory.storeMemory(TENANT, "semantic", "short", "hot", "x", 9, 0, []);

    const result = await memory.autoConsolidate(TENANT);
    const all = await memory.getMemories(TENANT, 100);
    const stored = all.find((m) => m.id === hot.id);

    expect(result.promoted).toBe(1);
    expect(stored?.horizon).toBe("long");
    expect(stored?.horizon).not.toBe("short");
  });

  it("moves decayFactor with the horizon on promotion", async () => {
    // A promoted memory that kept its short-term decay rate would fall
    // straight back out, making the promotion cosmetic.
    const hot = await memory.storeMemory(TENANT, "semantic", "short", "hot", "x", 9, 0, []);

    await memory.autoConsolidate(TENANT);
    const stored = (await memory.getMemories(TENANT, 100)).find((m) => m.id === hot.id);

    expect(stored?.decayFactor).toBe(0.001);
  });

  it("does not promote a memory that has not earned it", async () => {
    const cool = await memory.storeMemory(TENANT, "semantic", "short", "cool", "x", 3, 0, []);

    const result = await memory.autoConsolidate(TENANT);
    const stored = (await memory.getMemories(TENANT, 100)).find((m) => m.id === cool.id);

    expect(result.promoted).toBe(0);
    expect(stored?.horizon).toBe("short");
  });

  it("consolidates a cluster and links the sources to the summary", async () => {
    for (const name of ["a", "b", "c"]) {
      await memory.storeMemory(TENANT, "semantic", "short", name, "x", 5, 0, ["topic"]);
    }

    const result = await memory.autoConsolidate(TENANT);
    const all = await memory.getMemories(TENANT, 100);
    const merged = all.find((m) => m.title === "Consolidated: topic");

    expect(result.consolidated).toBe(1);
    expect(merged).toBeDefined();
    expect(merged?.consolidatedFrom).toHaveLength(3);
  });

  it("is idempotent: a second pass consolidates nothing new", async () => {
    // Without back-links the same cluster is re-consolidated on every run,
    // growing one summary per pass. A second call is what exposed it.
    for (const name of ["a", "b", "c"]) {
      await memory.storeMemory(TENANT, "semantic", "short", name, "x", 5, 0, ["topic"]);
    }

    const first = await memory.autoConsolidate(TENANT);
    const second = await memory.autoConsolidate(TENANT);

    expect(first.consolidated).toBe(1);
    expect(second.consolidated).toBe(0);
  });

  it("does not claim the same memory for two clusters", async () => {
    // A memory in several association groups must be consolidated once, or the
    // same knowledge is duplicated under two titles.
    for (const name of ["a", "b"]) {
      await memory.storeMemory(TENANT, "semantic", "short", name, "x", 5, 0, ["one", "two"]);
    }
    await memory.storeMemory(TENANT, "semantic", "short", "c", "x", 5, 0, ["one"]);
    await memory.storeMemory(TENANT, "semantic", "short", "d", "x", 5, 0, ["two"]);

    const result = await memory.autoConsolidate(TENANT);

    expect(result.consolidated).toBe(1);
  });

  it("does not consolidate clusters below the minimum size", async () => {
    for (const name of ["a", "b"]) {
      await memory.storeMemory(TENANT, "semantic", "short", name, "x", 5, 0, ["topic"]);
    }

    const result = await memory.autoConsolidate(TENANT);

    expect(result.consolidated).toBe(0);
  });

  it("uses one definition of decay rather than a second threshold", async () => {
    // The method used to count memories older than 30 days with importance < 3
    // — a threshold on a different scale from `decayFactor`, reachable only
    // after roughly 100 days of real decay. The two never agreed and neither
    // drove the other.
    await memory.storeMemory(TENANT, "episodic", "short", "faded", "x", 0.001, 0, []);

    const result = await memory.autoConsolidate(TENANT);
    const all = await memory.getMemories(TENANT, 100);

    expect(result.pruned).toBe(1);
    expect(all.find((m) => m.title === "faded")).toBeUndefined();
  });

  it("leaves another tenant's memories alone", async () => {
    await memory.storeMemory("other", "semantic", "short", "theirs", "x", 9, 0, []);

    const result = await memory.autoConsolidate(TENANT);
    const theirs = (await memory.getMemories("other", 100)).find((m) => m.title === "theirs");

    expect(result.promoted).toBe(0);
    expect(theirs?.horizon).toBe("short");
  });

  it("reports insights that match the numbers", async () => {
    // Prose and counters coming from different code paths is how the original
    // bug stayed invisible.
    const hot = await memory.storeMemory(TENANT, "semantic", "short", "hot", "x", 9, 0, []);

    const result = await memory.autoConsolidate(TENANT);
    const promotionInsights = result.insights.filter((line) => line.startsWith("Promoted"));

    expect(promotionInsights).toHaveLength(result.promoted);
    expect(promotionInsights[0]).toContain("hot");
    expect(hot.id).toBeDefined();
  });
});
