import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

const run = promisify(execFile);

async function fixture(options: { effort?: "low" | "medium" | "high" | "xhigh" | "max" } = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "haf-effort-"));
  const engine = new HybridAgentEngine({
    homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local", model: { provider: "mock" },
    ...(options.effort ? { effort: { defaultLevel: options.effort } } : {}),
  });
  const session = await engine.createSession({ tenantId: "tenant", name: "worker" });
  const snapshot = await engine.session(session.sessionId);
  return { engine, session, workspace: snapshot.workspacePath };
}

describe("Session effort", () => {
  it("publishes the exact budgets each level selects", async () => {
    const { engine } = await fixture();
    const levels = engine.sessionEffort.levels();
    expect(levels.map((item) => item.level)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // Monotonic: a higher level never buys fewer iterations or a smaller context.
    for (let index = 1; index < levels.length; index++) {
      expect(levels[index]!.toolIterations).toBeGreaterThan(levels[index - 1]!.toolIterations);
      expect(levels[index]!.contextScale).toBeGreaterThanOrEqual(levels[index - 1]!.contextScale);
    }
    expect(() => engine.sessionEffort.profile("turbo" as never)).toThrow(/Unknown effort level/);
    await engine.shutdown();
  });

  it("defaults per tenant, overrides per session and reports who changed it", async () => {
    const { engine, session } = await fixture();
    expect((await engine.sessionEffort.get("tenant", session.sessionId)).level).toBe("medium");

    await engine.sessionEffort.setDefault("tenant", "low");
    const fresh = await engine.createSession({ tenantId: "tenant" });
    expect((await engine.sessionEffort.get("tenant", fresh.sessionId)).level).toBe("low");

    const updated = await engine.sessionEffort.set({ tenantId: "tenant", sessionId: session.sessionId, level: "xhigh", actor: "operator", note: "Hard refactor." });
    expect(updated).toMatchObject({ level: "xhigh", updatedBy: "operator", note: "Hard refactor." });
    expect(updated.profile.toolIterations).toBe(20);
    expect(updated.profile.reasoningEffort).toBe("high");
    // The other session is untouched by a per-session change.
    expect((await engine.sessionEffort.get("tenant", fresh.sessionId)).level).toBe("low");
    await expect(engine.sessionEffort.set({ tenantId: "tenant", sessionId: session.sessionId, level: "turbo" as never })).rejects.toThrow(/Unknown effort level/);
    await engine.shutdown();
  });

  it("applies the tool-iteration ceiling to a real turn", async () => {
    const { engine, session } = await fixture({ effort: "low" });
    const { randomUUID } = await import("node:crypto");
    // The mock provider keeps asking for a tool, so the loop guard is what stops the turn.
    await engine.command({
      protocolVersion: 1, commandId: randomUUID(), clientId: "test", tenantId: "tenant", sessionId: session.sessionId,
      kind: "session.prompt", source: "api", issuedAt: new Date().toISOString(),
      payload: { text: '[loop tool filesystem.list {"path":"."}]' },
    });
    const events = await engine.readEvents(session.sessionId, 0, 500);
    const guardrail = events.find((item) => item.type === "guardrail.tool_loop_limit");
    if (guardrail) {
      expect((guardrail.payload as { maxIterations?: number }).maxIterations).toBe(4);
      expect((guardrail.payload as { effort?: string }).effort).toBe("low");
    }
    const starts = events.filter((item) => item.type === "model.request.started");
    expect(starts.length).toBeLessThanOrEqual(4);
    await engine.shutdown();
  });

  it("falls back to the runtime default when effort cannot be resolved", async () => {
    const { engine } = await fixture();
    expect(await engine.sessionEffort.toolIterations("tenant", "missing-session", 7)).toBe(8);
    await engine.shutdown();
  });
});

describe("Worktrees for the main session", () => {
  async function repo() {
    const { engine, session, workspace } = await fixture();
    await run("git", ["-C", workspace, "init", "-q"]).catch(() => undefined);
    await run("git", ["-C", workspace, "config", "user.email", "t@example.com"]);
    await run("git", ["-C", workspace, "config", "user.name", "T"]);
    await writeFile(join(workspace, "file.txt"), "one\n", "utf8");
    await run("git", ["-C", workspace, "add", "."]);
    await run("git", ["-C", workspace, "commit", "-qm", "base"]);
    return { engine, session, workspace };
  }

  it("creates a branch in an isolated worktree inside the engine workspace root", async () => {
    const { engine, workspace } = await repo();
    const created = await engine.worktrees.create({ workspacePath: workspace, branch: "experiment" });
    expect(created.branch).toBe("experiment");
    expect(created.path).toContain("worktree-experiment");

    const worktrees = await engine.worktrees.list(workspace);
    expect(worktrees.some((item) => item.path === created.path)).toBe(true);

    // A session can be bound to the new tree, which is the whole point of creating it.
    const spawned = await engine.createSession({ tenantId: "tenant", name: "experiment", workspacePath: created.path });
    expect((await engine.session(spawned.sessionId)).workspacePath).toBe(created.path);
    await engine.shutdown();
  });

  it("refuses unsafe references, outside paths and self-removal", async () => {
    const { engine, workspace } = await repo();
    await expect(engine.worktrees.create({ workspacePath: workspace, branch: "main; rm -rf /" })).rejects.toThrow(/plain git reference/);
    await expect(engine.worktrees.create({ workspacePath: workspace, branch: "ok", base: "../escape" })).rejects.toThrow(/plain git reference/);
    await expect(engine.worktrees.remove({ workspacePath: workspace, path: "/etc" })).rejects.toThrow(/inside the engine workspace root/);
    await expect(engine.worktrees.remove({ workspacePath: workspace, path: workspace })).rejects.toThrow(/cannot remove the worktree it is running in|inside the engine workspace root/);
    await engine.shutdown();
  });

  it("removes a worktree it created", async () => {
    const { engine, workspace } = await repo();
    const created = await engine.worktrees.create({ workspacePath: workspace, branch: "temporary" });
    const removed = await engine.worktrees.remove({ workspacePath: workspace, path: created.path });
    expect(removed.removed).toBe(true);
    expect((await engine.worktrees.list(workspace)).some((item) => item.path === created.path)).toBe(false);
    await engine.shutdown();
  });
});
