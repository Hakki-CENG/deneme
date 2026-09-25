/**
 * D6 (P1.18): contradiction management — the missing middle.
 *
 * What was measured before this existed. The graph had both ends of the chain:
 * `detectContradictions` (active claims with opposite polarity → `contradicts`
 * relations + mutual flags) and `supersede` (loser marked, retained for
 * provenance, excluded from recall). Between them, nothing: a detected
 * contradiction sat there forever with BOTH sides active and BOTH sides
 * recalled into every prompt, and the only resolution path was a caller
 * hand-picking ids — which no caller did, because none was in a position to
 * judge.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  adjudicate,
  evidenceStrength,
  MemoryContradictionService,
} from "../src/memory/contradiction-service.js";
import { MemoryGraphService } from "../src/memory/memory-graph-service.js";

function memory(partial: Partial<Parameters<MemoryGraphService["remember"]>[0]> & { content: string }) {
  return {
    tenantId: "t",
    layer: "semantic" as const,
    claimType: "observation" as const,
    title: partial.content.slice(0, 30),
    sourceType: "agent" as const,
    confidence: 0.8,
    importance: 0.5,
    ...partial,
  };
}

async function graph(): Promise<MemoryGraphService> {
  const root = await mkdtemp(join(tmpdir(), "haf-contradiction-"));
  return new MemoryGraphService(root);
}

const healthy = { content: "the postgres replica is healthy and keeping up", tags: ["postgres", "replica"] };
const broken = { content: "the postgres replica is not healthy and falling behind", tags: ["postgres", "replica"] };

describe("evidence strength (pure)", () => {
  it("weighs who is speaking, how direct the claim is, confidence and corroboration", () => {
    const weak = evidenceStrength({ sourceType: "external", claimType: "hypothesis", confidence: 0.3, evidenceRefs: [] });
    const strong = evidenceStrength({ sourceType: "user", claimType: "observation", confidence: 0.95, evidenceRefs: ["a", "b", "c"] });
    expect(strong).toBeGreaterThan(weak);

    // Corroboration helps with diminishing returns.
    const three = evidenceStrength({ sourceType: "agent", claimType: "inference", confidence: 0.8, evidenceRefs: ["a", "b", "c"] });
    const ten = evidenceStrength({ sourceType: "agent", claimType: "inference", confidence: 0.8, evidenceRefs: Array.from({ length: 10 }, (_, i) => String(i)) });
    expect(ten - three).toBeCloseTo(0.1, 10); // capped at 5 refs
  });
});

describe("adjudication rules (pure)", () => {
  const base = { tenantId: "t", id: "", layer: "semantic" as const, claimType: "observation" as const, sourceType: "agent" as const, confidence: 0.8, importance: 0.5, evidenceRefs: [] };

  it("a user correction beats a machine belief without a margin requirement", () => {
    const verdict = adjudicate(
      { ...base, id: "old", sourceType: "agent", confidence: 0.95 },
      { ...base, id: "correction", sourceType: "user", confidence: 0.4 },
    );
    expect(verdict.resolution).toBe("supersede");
    expect(verdict.winnerId).toBe("correction");
    expect(verdict.reason).toContain("user");
  });

  it("a clear evidence gap decides between two machine claims", () => {
    const verdict = adjudicate(
      { ...base, id: "weak", sourceType: "external", confidence: 0.3, evidenceRefs: [] },
      { ...base, id: "strong", sourceType: "event", confidence: 0.9, evidenceRefs: ["x"] },
    );
    expect(verdict.resolution).toBe("supersede");
    expect(verdict.winnerId).toBe("strong");
  });

  it("a close call stays a contradiction — recency does NOT break ties", () => {
    // Identical strength, different ids: the newest claim must not win just
    // for being newest. "The last thing written is true" is the assumption
    // the verification layer exists to reject.
    const verdict = adjudicate(
      { ...base, id: "first" },
      { ...base, id: "second" },
    );
    expect(verdict.resolution).toBe("unresolved");
    expect(verdict.reason).toContain("margin");
  });
});

describe("the engine resolves detected contradictions end to end", () => {
  it("detects, adjudicates by evidence, supersedes the loser — and recall stops returning it", async () => {
    const g = await graph();
    const service = new MemoryContradictionService(g);

    // Same subject, opposite polarity, very different evidence.
    const weak = await g.remember(memory({ ...broken, sourceType: "external", confidence: 0.4 }));
    const strong = await g.remember(memory({ ...healthy, sourceType: "event", confidence: 0.95, evidenceRefs: ["metrics", "alert"] }));

    const result = await service.resolveDetected("t");
    expect(result.detected).toBe(1);
    expect(result.resolved).toBe(1);
    expect(result.resolutions[0]?.winnerId).toBe(strong.id);
    expect(result.resolutions[0]?.loserId).toBe(weak.id);

    // The loser is superseded, retained for provenance, linked to the winner.
    const loser = await g.get("t", weak.id);
    expect(loser?.state).toBe("superseded");
    expect(loser?.supersededById).toBe(strong.id);

    // Recall's active filter already excludes the superseded side — the whole
    // point of resolving instead of merely flagging.
    const recalled = await g.recall("t", "postgres replica status");
    expect(recalled.map((item) => item.memory.id)).not.toContain(weak.id);

    // Idempotent: nothing active contradicts anything any more.
    const second = await service.resolveDetected("t");
    expect(second.detected).toBe(0);
  });

  it("a user correction supersedes the machine's confident-but-wrong claim", async () => {
    const g = await graph();
    const service = new MemoryContradictionService(g);

    const machine = await g.remember(memory({ ...broken, sourceType: "agent", confidence: 0.95, evidenceRefs: ["log"] }));
    const correction = await g.remember(memory({ ...healthy, sourceType: "user", confidence: 0.4 }));

    const result = await service.resolveDetected("t");
    expect(result.resolutions[0]?.winnerId).toBe(correction.id);

    const loser = await g.get("t", machine.id);
    expect(loser?.state).toBe("superseded");
    expect(loser?.supersededById).toBe(correction.id);
  });

  it("an even contradiction leaves both sides active and flagged, nobody promoted", async () => {
    const g = await graph();
    const service = new MemoryContradictionService(g);

    const a = await g.remember(memory(broken));
    const b = await g.remember(memory(healthy));

    const result = await service.resolveDetected("t");
    expect(result.detected).toBe(1);
    expect(result.resolved).toBe(0);
    expect(result.resolutions[0]?.resolution).toBe("unresolved");

    // Both still active, both still flagged — the health report's
    // "contradicted" list is where a human picks this up.
    const left = await g.get("t", a.id);
    const right = await g.get("t", b.id);
    expect(left?.state).toBe("active");
    expect(right?.state).toBe("active");
    expect(left?.contradictionIds).toContain(b.id);
    expect(right?.contradictionIds).toContain(a.id);
  });

  it("resolving a pair that does not exist is an error, not a silent skip", async () => {
    const g = await graph();
    const service = new MemoryContradictionService(g);
    await expect(service.resolvePair("t", "nope-1", "nope-2")).rejects.toThrow();
  });
});
