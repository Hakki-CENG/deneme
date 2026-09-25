/**
 * P1, skill formation: what does "verified" mean for a skill?
 *
 * Two things were measured before writing this:
 *
 * 1. `LearningEngine.consolidate()` passes `extractSkills: async () => 0` into
 *    the sleep cycle. The cycle then reports `skillsExtracted: 0` forever,
 *    while `TrajectoryMiner` — which does real pattern mining — sits unused.
 *    The interface looks like skill extraction; the number is a constant.
 *
 * 2. `SkillSynthesizer.verifySkill()` stamps `status = "verified"` after
 *    checking that the name is non-empty, the description is non-empty, and
 *    there is at least one step. It never runs the skill. A skill whose steps
 *    are nonsense passes.
 *
 * (2) is the dangerous one: "verified" is the word the rest of the system
 * trusts. These tests pin what the label is allowed to mean.
 */
import { describe, expect, it } from "vitest";
import { SkillLibraryManager, SkillSynthesizer, TrajectoryMiner } from "../src/skills/skill-synthesis.js";

function makeSkill(overrides: Record<string, unknown> = {}) {
  return {
    name: "deploy-service",
    description: "Deploy a service to staging",
    category: "automation" as const,
    status: "draft" as const,
    version: "1.0.0",
    steps: [{ order: 1, action: "run", description: "run the deploy script" }],
    parameters: [],
    examples: [],
    ...overrides,
  };
}

describe("skill verification must mean more than 'the fields are filled in'", () => {
  it("a structurally complete but never-executed skill is not 'verified'", () => {
    const library = new SkillLibraryManager();
    const synth = new SkillSynthesizer(library);

    const { id } = library.addSkill(makeSkill() as never);
    const passed = synth.verifySkill(id);

    // Structural checks may pass...
    expect(passed).toBe(true);

    // ...but the recorded status must not claim empirical verification, because
    // nothing was run. `structurally_valid` is the honest word.
    const skill = library.getSkill(id);
    expect(skill?.status).not.toBe("verified");
    expect(skill?.status).toBe("structurally_valid");
  });

  it("only an executed skill with passing test cases earns 'verified'", async () => {
    const library = new SkillLibraryManager();
    const synth = new SkillSynthesizer(library);
    const { id } = library.addSkill(makeSkill() as never);

    synth.verifySkill(id);
    expect(library.getSkill(id)?.status).toBe("structurally_valid");

    const result = await synth.evaluateSkill(id, [
      { input: { env: "staging" }, expectedOutput: { ok: true } },
    ]);

    // Whatever the outcome, the status must now reflect real execution.
    const status = library.getSkill(id)?.status;
    if (result.successRate === 1) {
      expect(status).toBe("verified");
    } else {
      expect(status).not.toBe("verified");
    }
  });

  it("a skill with no steps fails structural validation outright", () => {
    const library = new SkillLibraryManager();
    const synth = new SkillSynthesizer(library);

    const { id } = library.addSkill(makeSkill({ steps: [] }) as never);
    expect(synth.verifySkill(id)).toBe(false);
    expect(library.getSkill(id)?.status).not.toBe("verified");
  });
});

describe("trajectory mining produces candidates from real event sequences", () => {
  it("mines a candidate from a repeated sequence", () => {
    const miner = new TrajectoryMiner();

    const events = [
      { id: "1", type: "action", content: "git.status", timestamp: "2026-01-01T00:00:00Z" },
      { id: "2", type: "action", content: "git.add", timestamp: "2026-01-01T00:00:01Z" },
      { id: "3", type: "action", content: "git.commit", timestamp: "2026-01-01T00:00:02Z" },
      { id: "4", type: "action", content: "git.push", timestamp: "2026-01-01T00:00:03Z" },
    ];
    miner.addTrajectory(events as never);

    const candidates = miner.mineCandidates({ minEvents: 3, minConfidence: 0 });
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("a trajectory shorter than the threshold yields nothing", () => {
    const miner = new TrajectoryMiner();
    miner.addTrajectory([
      { id: "1", type: "action", content: "ls", timestamp: "2026-01-01T00:00:00Z" },
    ] as never);

    // Two events are not a pattern; inventing a skill from them would fill the
    // library with noise that later looks like learned competence.
    expect(miner.mineCandidates({ minEvents: 3 })).toEqual([]);
  });
});

describe("the sleep cycle does not report work it never did", () => {
  it("reports null, not 0, when skill extraction is not wired", async () => {
    const { SleepCycleService } = await import("../src/aurora/sleep-cycle.js");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const service = new SleepCycleService(await mkdtemp(join(tmpdir(), "sleep-")));
    await service.init();

    const result = await service.runCycle("t", "deep", {
      consolidateMemory: async () => ({ compressed: 3, duplicates: 0 }),
      discoverPatterns: async () => 1,
      generateHypotheses: async () => [],
      // resolveContradictions and extractSkills deliberately omitted.
    });

    // 0 would say "we looked and found none". null says "we did not look".
    expect(result.skillsExtracted).toBeNull();
    expect(result.contradictionsResolved).toBeNull();
    // Real work is still reported as a number.
    expect(result.memoriesConsolidated).toBe(3);
    expect(result.patternsDiscovered).toBe(1);
    // And the gap is named rather than left silent.
    expect(result.insights.join(" ")).toMatch(/not attempted/i);
  });

  it("reports 0 when extraction ran and genuinely found nothing", async () => {
    const { SleepCycleService } = await import("../src/aurora/sleep-cycle.js");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const service = new SleepCycleService(await mkdtemp(join(tmpdir(), "sleep-")));
    await service.init();

    const result = await service.runCycle("t", "deep", {
      consolidateMemory: async () => ({ compressed: 0, duplicates: 0 }),
      discoverPatterns: async () => 0,
      extractSkills: async () => 0,
      generateHypotheses: async () => [],
    });

    expect(result.skillsExtracted).toBe(0);
    expect(result.insights.join(" ")).not.toMatch(/not attempted/i);
  });
});
