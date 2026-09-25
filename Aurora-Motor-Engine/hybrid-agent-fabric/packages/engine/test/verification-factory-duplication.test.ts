/**
 * Two files were named `verification-factory.ts`. Only one was reachable.
 *
 *   packages/engine/src/execution/verification-factory.ts  — live, 393 lines
 *   packages/engine/src/harness/verification-factory.ts    — 548 lines, zero imports
 *
 * Deleting the unreachable one is easy. The reason it must not simply be
 * *promoted* instead is what these tests record, so the decision survives the
 * next person who finds it and thinks "V3 consensus already exists".
 *
 * The harness version's `ConsensusVerification` runs every judge against the
 * same `criterion.check(target)` callback. The judge is never passed to the
 * check, so N judges produce N identical scores and the "weighted consensus"
 * is one opinion multiplied by its own weight. That is not consensus; it is a
 * single computation wearing a quorum's name — the failure mode this codebase
 * already fixed in `retry_with_backoff`.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const LIVE = new URL("../src/execution/verification-factory.ts", import.meta.url);
const DEAD = new URL("../src/harness/verification-factory.ts", import.meta.url);

describe("only one verification factory is reachable", () => {
  it("the live one exposes the tiers the loop uses", async () => {
    const mod = await import("../src/execution/verification-factory.js");

    expect(typeof mod.VerificationFactory).toBe("function");
    expect(typeof mod.autonomyFor).toBe("function");
    expect(typeof mod.formalVerifier).toBe("function");
    expect(typeof mod.empiricalVerifier).toBe("function");

    // Autonomy is graded by how checkable the claim is, not by confidence.
    expect(mod.autonomyFor("V1_formal")).toBe("high");
    expect(mod.autonomyFor("V4_unverifiable")).toBe("approval_required");
  });

  it("the duplicate file is gone", async () => {
    await expect(readFile(DEAD, "utf8")).rejects.toThrow();
  });

  it("nothing imports a harness verification factory", async () => {
    const live = await readFile(LIVE, "utf8");
    expect(live).not.toContain("harness/verification-factory");
  });
});

describe("V3 consensus is absent on purpose, not by oversight", () => {
  it("the live factory does not claim a consensus tier it cannot deliver", async () => {
    const live = await readFile(LIVE, "utf8");

    // The tier name exists in the type union (the taxonomy is complete)...
    expect(live).toContain("V3_consensus");

    // ...but there is no `consensusVerifier()` factory pretending to run one.
    // Real consensus needs independent judges; a single scoring function run
    // N times is one opinion, whatever the quorum arithmetic says.
    expect(live).not.toMatch(/export function consensusVerifier/);
  });

  it("V3 requires controlled autonomy, so it can never self-approve", async () => {
    const mod = await import("../src/execution/verification-factory.js");
    expect(mod.autonomyFor("V3_consensus")).toBe("controlled");
  });
});
