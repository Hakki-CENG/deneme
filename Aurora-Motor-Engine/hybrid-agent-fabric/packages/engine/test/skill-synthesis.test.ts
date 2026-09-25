import { describe, it, expect } from "vitest";

import {
  SkillLibraryManager,
  TrajectoryMiner,
  SkillSynthesizer,
  SkillExecutor,
  SkillSynthesisPipeline,
} from "../src/skills/skill-synthesis.js";
import {
  DependencyGraph,
  SkillCompositionManager,
} from "../src/skills/skill-composition.js";

describe("SkillLibraryManager", () => {
  it("adds and retrieves skills", () => {
    const lib = new SkillLibraryManager();
    const skill = lib.addSkill({
      name: "normalize",
      description: "normalizes text",
      category: "coding",
      status: "draft",
      parameters: [],
      steps: [],
      examples: [],
      tags: [],
    });

    expect(lib.getSkill(skill.id)?.name).toBe("normalize");
    expect(lib.getSkills()).toHaveLength(1);
  });

  it("tracks execution metrics", () => {
    const lib = new SkillLibraryManager();
    const skill = lib.addSkill({
      name: "s",
      description: "d",
      category: "other",
      status: "draft",
      parameters: [],
      steps: [],
      examples: [],
      tags: [],
    });

    lib.recordExecution(skill.id, true, 100);
    lib.recordExecution(skill.id, false, 200);

    const updated = lib.getSkill(skill.id);
    expect(updated?.metrics.executionCount).toBe(2);
    expect(updated?.metrics.successCount).toBe(1);
    expect(updated?.metrics.failureCount).toBe(1);
  });

  it("filters by category and status", () => {
    const lib = new SkillLibraryManager();
    lib.addSkill({
      name: "a", description: "", category: "coding", status: "draft",
      parameters: [], steps: [], examples: [], tags: [],
    });
    lib.addSkill({
      name: "b", description: "", category: "research", status: "draft",
      parameters: [], steps: [], examples: [], tags: [],
    });

    expect(lib.getSkillsByCategory("coding")).toHaveLength(1);
    expect(lib.getSkillsByStatus("draft")).toHaveLength(2);
  });
});

describe("SkillExecutor (real execution, no dice rolls)", () => {
  it("executes a single-step skill through the sandbox", async () => {
    const executor = new SkillExecutor();
    executor.registerCapability("cap-double", "return input.n * 2;");

    const lib = new SkillLibraryManager();
    const skill = lib.addSkill({
      name: "double",
      description: "doubles n",
      category: "coding",
      status: "draft",
      parameters: [],
      steps: [
        {
          id: "s1",
          name: "double",
          description: "",
          capabilityId: "cap-double",
          input: {},
          output: {},
          optional: false,
        },
      ],
      examples: [],
      tags: [],
    });

    const outcome = await executor.runSkill(skill, { n: 21 });
    expect(outcome.success).toBe(true);
    expect(outcome.output).toBe(42);
    expect(outcome.stepsRun).toBe(1);
  });

  it("pipes output from one step into the next", async () => {
    const executor = new SkillExecutor();
    executor.registerCapability("cap-inc", "return { n: input.n + 1 };");
    executor.registerCapability("cap-square", "return input.n * input.n;");

    const lib = new SkillLibraryManager();
    const skill = lib.addSkill({
      name: "inc-then-square",
      description: "",
      category: "coding",
      status: "draft",
      parameters: [],
      steps: [
        { id: "s1", name: "inc", description: "", capabilityId: "cap-inc", input: {}, output: {}, optional: false },
        { id: "s2", name: "square", description: "", capabilityId: "cap-square", input: {}, output: {}, optional: false },
      ],
      examples: [],
      tags: [],
    });

    const outcome = await executor.runSkill(skill, { n: 5 });
    expect(outcome.success).toBe(true);
    expect(outcome.output).toBe(36);
    expect(outcome.stepsRun).toBe(2);
  });

  it("fails loudly when a required capability is missing", async () => {
    const executor = new SkillExecutor();
    const lib = new SkillLibraryManager();
    const skill = lib.addSkill({
      name: "orphan-step",
      description: "",
      category: "other",
      status: "draft",
      parameters: [],
      steps: [
        { id: "s1", name: "ghost", description: "", capabilityId: "nope", input: {}, output: {}, optional: false },
      ],
      examples: [],
      tags: [],
    });

    const outcome = await executor.runSkill(skill, {});
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("not executable");
  });

  it("skips optional steps whose capability is unavailable", async () => {
    const executor = new SkillExecutor();
    executor.registerCapability("cap-ok", "return 7;");

    const lib = new SkillLibraryManager();
    const skill = lib.addSkill({
      name: "with-optional",
      description: "",
      category: "other",
      status: "draft",
      parameters: [],
      steps: [
        { id: "s1", name: "missing", description: "", capabilityId: "absent", input: {}, output: {}, optional: true },
        { id: "s2", name: "ok", description: "", capabilityId: "cap-ok", input: {}, output: {}, optional: false },
      ],
      examples: [],
      tags: [],
    });

    const outcome = await executor.runSkill(skill, {});
    expect(outcome.success).toBe(true);
    expect(outcome.output).toBe(7);
  });

  it("rejects a skill with no steps instead of reporting success", async () => {
    const executor = new SkillExecutor();
    const lib = new SkillLibraryManager();
    const skill = lib.addSkill({
      name: "empty", description: "", category: "other", status: "draft",
      parameters: [], steps: [], examples: [], tags: [],
    });

    const outcome = await executor.runSkill(skill, {});
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("no executable steps");
  });
});

describe("SkillSynthesizer.evaluateSkill (measured, not simulated)", () => {
  it("marks a skill verified only when every case passes", async () => {
    const lib = new SkillLibraryManager();
    const miner = new TrajectoryMiner();
    const executor = new SkillExecutor();
    executor.registerCapability("cap-id", "return input;");

    const synth = new SkillSynthesizer(lib, miner, executor);

    const skill = lib.addSkill({
      name: "identity",
      description: "",
      category: "other",
      status: "draft",
      parameters: [],
      steps: [
        { id: "s1", name: "id", description: "", capabilityId: "cap-id", input: {}, output: {}, optional: false },
      ],
      examples: [],
      tags: [],
    });

    const good = await synth.evaluateSkill(skill.id, [
      { input: { a: 1 }, expectedOutput: { a: 1 } },
      { input: { b: 2 }, expectedOutput: { b: 2 } },
    ]);

    expect(good.passed).toBe(2);
    expect(good.failed).toBe(0);
    expect(good.successRate).toBe(1);
    expect(lib.getSkill(skill.id)?.status).toBe("verified");
  });

  it("does not mark a skill verified when a case fails", async () => {
    const lib = new SkillLibraryManager();
    const miner = new TrajectoryMiner();
    const executor = new SkillExecutor();
    executor.registerCapability("cap-id", "return input;");

    const synth = new SkillSynthesizer(lib, miner, executor);
    const skill = lib.addSkill({
      name: "identity2",
      description: "",
      category: "other",
      status: "draft",
      parameters: [],
      steps: [
        { id: "s1", name: "id", description: "", capabilityId: "cap-id", input: {}, output: {}, optional: false },
      ],
      examples: [],
      tags: [],
    });

    const result = await synth.evaluateSkill(skill.id, [
      { input: { a: 1 }, expectedOutput: { a: 1 } },
      { input: { b: 2 }, expectedOutput: { WRONG: 9 } },
    ]);

    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toContain("mismatch");
    expect(lib.getSkill(skill.id)?.status).not.toBe("verified");
  });

  it("is deterministic across repeated runs", async () => {
    const lib = new SkillLibraryManager();
    const miner = new TrajectoryMiner();
    const executor = new SkillExecutor();
    executor.registerCapability("cap-id", "return input;");
    const synth = new SkillSynthesizer(lib, miner, executor);

    const skill = lib.addSkill({
      name: "det", description: "", category: "other", status: "draft",
      parameters: [],
      steps: [{ id: "s1", name: "id", description: "", capabilityId: "cap-id", input: {}, output: {}, optional: false }],
      examples: [], tags: [],
    });

    const cases = [{ input: { x: 1 }, expectedOutput: { x: 1 } }];
    const runs = await Promise.all([
      synth.evaluateSkill(skill.id, cases),
      synth.evaluateSkill(skill.id, cases),
      synth.evaluateSkill(skill.id, cases),
    ]);

    // With the old Math.random() implementation this would flake.
    expect(runs.every((r) => r.successRate === 1)).toBe(true);
  });

  it("reports a missing skill as total failure", async () => {
    const lib = new SkillLibraryManager();
    const synth = new SkillSynthesizer(lib, new TrajectoryMiner());
    const result = await synth.evaluateSkill("does-not-exist", [
      { input: {}, expectedOutput: {} },
    ]);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
  });
});

describe("DependencyGraph", () => {
  it("detects cycles", () => {
    const graph = new DependencyGraph();
    const a = graph.addNode("a");
    const b = graph.addNode("b");
    graph.addEdge(a, b, "requires");
    graph.addEdge(b, a, "requires");

    expect(graph.detectCycles().hasCycle).toBe(true);
  });

  it("topologically sorts an acyclic graph", () => {
    const graph = new DependencyGraph();
    const a = graph.addNode("a");
    const b = graph.addNode("b");
    const c = graph.addNode("c");
    graph.addEdge(a, b, "requires");
    graph.addEdge(b, c, "requires");

    const result = graph.topologicalSort();
    expect(result.hasCycle).toBe(false);
    expect(result.sorted.indexOf(a)).toBeLessThan(result.sorted.indexOf(c));
  });

  it("refuses to sort a cyclic graph", () => {
    const graph = new DependencyGraph();
    const a = graph.addNode("a");
    const b = graph.addNode("b");
    graph.addEdge(a, b, "requires");
    graph.addEdge(b, a, "requires");

    const result = graph.topologicalSort();
    expect(result.hasCycle).toBe(true);
    expect(result.sorted).toHaveLength(0);
  });
});

describe("SkillCompositionManager", () => {
  it("creates a composite skill", () => {
    const manager = new SkillCompositionManager();
    const composite = manager.createCompositeSkill({
      name: "pipeline",
      description: "two-stage",
      skills: ["s1", "s2"],
    });

    expect(composite).toBeTruthy();
    expect(manager.getCompositeSkills()).toHaveLength(1);
  });
});

describe("SkillSynthesisPipeline", () => {
  it("exposes a working library and miner", () => {
    const pipeline = new SkillSynthesisPipeline();
    const stats = pipeline.getStats();
    expect(stats).toBeDefined();
    expect(stats.skillLibrary.totalSkills).toBe(0);
    expect(stats.trajectoryMiner).toBeDefined();
    expect(stats.skillSynthesizer).toBeDefined();
  });
});
