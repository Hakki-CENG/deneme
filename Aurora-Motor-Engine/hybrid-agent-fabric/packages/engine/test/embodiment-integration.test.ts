import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileSystemAgent } from "../src/embodiment/filesystem-agent.js";
import { ActionFramework } from "../src/embodiment/action-framework.js";
import { fileSystemAgentCapabilities, actionFrameworkCapabilities } from "../src/capabilities/embodiment.js";
import { resolve, join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { mkdir, writeFile, rm } from "node:fs/promises";

const TEST_WORKSPACE = resolve(import.meta.dirname, "..", ".test-embodiment-workspace");

async function setupWorkspace() {
  await rm(TEST_WORKSPACE, { recursive: true, force: true });
  await mkdir(TEST_WORKSPACE, { recursive: true });
  await mkdir(resolve(TEST_WORKSPACE, "src"), { recursive: true });
  await writeFile(resolve(TEST_WORKSPACE, "src", "index.ts"), "console.log('hello');");
  await writeFile(resolve(TEST_WORKSPACE, "src", "utils.ts"), "export const add = (a: number, b: number) => a + b;");
  await writeFile(resolve(TEST_WORKSPACE, "README.md"), "# Test Project\nThis is a test.");
}

async function cleanupWorkspace() {
  await rm(TEST_WORKSPACE, { recursive: true, force: true });
}

describe("FileSystemAgent", () => {
  it("reads a file", async () => {
    await setupWorkspace();
    try {
      const agent = new FileSystemAgent(TEST_WORKSPACE);
      const result = await agent.readFile("src/index.ts");
      expect(result.content).toContain("hello");
      expect(result.info.name).toBe("index.ts");
      expect(result.info.extension).toBe(".ts");
    } finally {
      await cleanupWorkspace();
    }
  });

  it("writes a file", async () => {
    await setupWorkspace();
    try {
      const agent = new FileSystemAgent(TEST_WORKSPACE);
      const info = await agent.writeFile("src/new.ts", "export const x = 1;");
      expect(info.name).toBe("new.ts");
    } finally {
      await cleanupWorkspace();
    }
  });

  it("lists directory contents", async () => {
    await setupWorkspace();
    try {
      const agent = new FileSystemAgent(TEST_WORKSPACE);
      const entries = await agent.listDirectory("src");
      expect(entries.length).toBe(2);
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(["index.ts", "utils.ts"]);
    } finally {
      await cleanupWorkspace();
    }
  });

  it("finds files by pattern", async () => {
    await setupWorkspace();
    try {
      const agent = new FileSystemAgent(TEST_WORKSPACE);
      const results = await agent.findFiles("**/*.ts");
      expect(results.length).toBe(2);
    } finally {
      await cleanupWorkspace();
    }
  });

  it("searches content", async () => {
    await setupWorkspace();
    try {
      const agent = new FileSystemAgent(TEST_WORKSPACE);
      const results = await agent.searchContent("hello", "src");
      expect(results.length).toBeGreaterThanOrEqual(1);
      if (results.length > 0) {
        expect(results[0].match).toContain("hello");
      }
    } finally {
      await cleanupWorkspace();
    }
  });

  it("gets file info", async () => {
    await setupWorkspace();
    try {
      const agent = new FileSystemAgent(TEST_WORKSPACE);
      const info = await agent.getFileInfo("README.md");
      expect(info.name).toBe("README.md");
      expect(info.isDirectory).toBe(false);
      expect(info.size).toBeGreaterThan(0);
    } finally {
      await cleanupWorkspace();
    }
  });

  it("creates directory", async () => {
    await setupWorkspace();
    try {
      const agent = new FileSystemAgent(TEST_WORKSPACE);
      await agent.createDirectory("src/deep/nested");
      const info = await agent.getFileInfo("src/deep/nested");
      expect(info.isDirectory).toBe(true);
    } finally {
      await cleanupWorkspace();
    }
  });

  it("deletes a file", async () => {
    await setupWorkspace();
    try {
      const agent = new FileSystemAgent(TEST_WORKSPACE);
      await agent.writeFile("to-delete.txt", "delete me");
      await agent.deleteFile("to-delete.txt");
      await expect(agent.getFileInfo("to-delete.txt")).rejects.toThrow();
    } finally {
      await cleanupWorkspace();
    }
  });

  it("renames a file", async () => {
    await setupWorkspace();
    try {
      const agent = new FileSystemAgent(TEST_WORKSPACE);
      await agent.writeFile("old-name.txt", "content");
      await agent.renameFile("old-name.txt", "new-name.txt");
      const info = await agent.getFileInfo("new-name.txt");
      expect(info.name).toBe("new-name.txt");
    } finally {
      await cleanupWorkspace();
    }
  });

  it("copies a file", async () => {
    await setupWorkspace();
    try {
      const agent = new FileSystemAgent(TEST_WORKSPACE);
      await agent.writeFile("original.txt", "content");
      await agent.copyFile("original.txt", "copy.txt");
      const result = await agent.readFile("copy.txt");
      expect(result.content).toBe("content");
    } finally {
      await cleanupWorkspace();
    }
  });

  it("blocks access to forbidden paths", async () => {
    await setupWorkspace();
    try {
      const agent = new FileSystemAgent(TEST_WORKSPACE);
      await expect(agent.readFile("../outside.txt")).rejects.toThrow();
    } finally {
      await cleanupWorkspace();
    }
  });
});

describe("ActionFramework", () => {
  const mockEngine = {} as any;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(process.cwd(), '.test-af-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("creates a goal", async () => {
    const framework = new ActionFramework(mockEngine, {}, testDir);
    await framework.init();
    const goal = await framework.createGoal({ tenantId: "test", title: "Test Goal", description: "A test" });
    expect(goal.title).toBe("Test Goal");
    expect(goal.status).toBe("proposed");
    expect(goal.priority).toBe("P2");
  });

  it("accepts a goal", async () => {
    const framework = new ActionFramework(mockEngine, {}, testDir);
    await framework.init();
    const goal = await framework.createGoal({ tenantId: "test", title: "G1", description: "D1" });
    const accepted = await framework.acceptGoal(goal.id);
    expect(accepted.status).toBe("accepted");
  });

  it("creates and approves a plan", async () => {
    const framework = new ActionFramework(mockEngine, {}, testDir);
    await framework.init();
    const goal = await framework.createGoal({ tenantId: "test", title: "G1", description: "D1" });
    await framework.acceptGoal(goal.id);
    const plan = await framework.createPlan({
      tenantId: "test",
      goalId: goal.id,
      title: "Plan 1",
      description: "Execute steps",
      steps: [
        { title: "Step 1", description: "First", actionType: "test" },
        { title: "Step 2", description: "Second", actionType: "test", dependsOn: [0] },
      ],
    });
    expect(plan.status).toBe("draft");
    expect(plan.steps.length).toBe(2);
    const approved = await framework.approvePlan(plan.id);
    expect(approved.status).toBe("approved");
  });

  it("records step results and completes plan", async () => {
    const framework = new ActionFramework(mockEngine, {}, testDir);
    await framework.init();
    const goal = await framework.createGoal({ tenantId: "test", title: "G1", description: "D1" });
    await framework.acceptGoal(goal.id);
    const plan = await framework.createPlan({
      tenantId: "test",
      goalId: goal.id,
      title: "Plan 1",
      description: "Execute",
      steps: [
        { title: "Step 1", description: "First", actionType: "test" },
      ],
    });
    await framework.approvePlan(plan.id);
    await framework.recordStepResult(plan.id, plan.steps[0]!.id, {
      success: true,
      output: "done",
      durationMs: 100,
      tokensUsed: 50,
      sideEffects: [],
      verificationNeeded: false,
      evidence: [],
    });
    const plans = await framework.getPlans();
    expect(plans[0]!.status).toBe("completed");
  });

  it("lists goals and plans", async () => {
    const framework = new ActionFramework(mockEngine, {}, testDir);
    await framework.init();
    await framework.createGoal({ tenantId: "test", title: "G1", description: "D1" });
    await framework.createGoal({ tenantId: "test", title: "G2", description: "D2" });
    const goals = await framework.getGoals();
    expect(goals.length).toBe(2);
  });

  it("returns stats", async () => {
    const framework = new ActionFramework(mockEngine, {}, testDir);
    await framework.init();
    await framework.createGoal({ tenantId: "test", title: "G1", description: "D1" });
    const stats = await framework.getStats();
    expect(stats.totalGoals).toBe(1);
    expect(stats.totalPlans).toBe(0);
  });
});

describe("Embodiment Capabilities", () => {
  it("fileSystemAgentCapabilities returns 6 capabilities", () => {
    const agent = new FileSystemAgent("/tmp");
    const caps = fileSystemAgentCapabilities(agent);
    // `embodiment.fs.search` was removed: `filesystem.grep` is a strict superset
    // of it, and two content-search capabilities let an agent pick the weaker one.
    expect(caps.length).toBe(6);
    const ids = caps.map((c) => c.descriptor.id);
    expect(ids).not.toContain("embodiment.fs.search");
    expect(ids).toContain("embodiment.fs.find");
    expect(ids).toContain("embodiment.fs.info");
    expect(ids).toContain("embodiment.fs.mkdir");
    expect(ids).toContain("embodiment.fs.delete");
    expect(ids).toContain("embodiment.fs.rename");
    expect(ids).toContain("embodiment.fs.copy");
  });

  it("actionFrameworkCapabilities returns 8 capabilities", () => {
    const framework = new ActionFramework({} as any);
    const caps = actionFrameworkCapabilities(framework);
    expect(caps.length).toBe(8);
    const ids = caps.map((c) => c.descriptor.id);
    expect(ids).toContain("embodiment.action.create_goal");
    expect(ids).toContain("embodiment.action.accept_goal");
    expect(ids).toContain("embodiment.action.create_plan");
    expect(ids).toContain("embodiment.action.approve_plan");
    expect(ids).toContain("embodiment.action.record_result");
    expect(ids).toContain("embodiment.action.list_goals");
    expect(ids).toContain("embodiment.action.list_plans");
    expect(ids).toContain("embodiment.action.stats");
  });

  it("embodiment.fs.find capability validates input", () => {
    const agent = new FileSystemAgent("/tmp");
    const caps = fileSystemAgentCapabilities(agent);
    const find = caps.find((c) => c.descriptor.id === "embodiment.fs.find")!;
    const validated = find.validate({ pattern: "*.ts" });
    expect(validated.pattern).toBe("*.ts");
  });
});
