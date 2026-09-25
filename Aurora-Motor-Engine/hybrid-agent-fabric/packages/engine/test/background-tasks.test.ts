import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-tasks-"));
  const engine = new HybridAgentEngine({
    homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local", model: { provider: "mock" }, autoApproveWorkspaceWrites: true, allowProcessExecution: true,
  });
  const parent = await engine.createSession({ tenantId: "tenant", name: "lead" });
  const snapshot = await engine.session(parent.sessionId);
  const context = (suffix: string, sessionId = parent.sessionId, workspacePath = snapshot.workspacePath) => ({
    tenantId: "tenant", sessionId, familyId: parent.sessionId, turnId: `turn-${suffix}`, toolCallId: `call-${suffix}`,
    source: "api" as const, workspacePath, idempotencyKey: `task-${suffix}`,
  });
  return { engine, parent, snapshot, context };
}

/** Approve the next pending approval for a session, so a privileged capability can complete. */
async function approveNext(engine: HybridAgentEngine, sessionId: string, optional = false): Promise<void> {
  for (let wait = 0; wait < 200; wait++) {
    const pending = engine.approvals.list(sessionId).filter((item) => item.status === "pending");
    if (pending.length) { engine.approvals.resolve(pending[0]!.id, "approve_once"); return; }
    await new Promise((tick) => setTimeout(tick, 10));
  }
  if (!optional) throw new Error("No approval appeared to resolve.");
}

async function spawnChild(engine: HybridAgentEngine, context: any) {
  const spawned = await engine.capabilities.execute("agent.spawn", { name: "worker", task: "Do a small thing." }, context) as { childSessionId: string };
  for (let wait = 0; wait < 200; wait++) {
    const child = await engine.session(spawned.childSessionId).catch(() => undefined);
    if (child && child.status !== "provisioning") break;
    await new Promise((tick) => setTimeout(tick, 10));
  }
  return spawned.childSessionId;
}

describe("Background task control", () => {
  it("monitors reachable agents with status, usage and open questions", async () => {
    const { engine, parent, context } = await fixture();
    const childId = await spawnChild(engine, context("spawn"));

    const monitor = await engine.capabilities.execute("tasks.monitor", {}, context("monitor")) as any;
    expect(monitor.currentSessionId).toBe(parent.sessionId);
    const child = monitor.agents.find((item: any) => item.sessionId === childId);
    expect(child).toBeDefined();
    expect(child.relationship).toBe("child");
    expect(typeof child.busy).toBe("boolean");
    expect(child.mode).toBe("manual");
    expect(child.effort).toBe("medium");
    expect(child.openQuestions).toBe(0);

    const withSelf = await engine.capabilities.execute("tasks.monitor", { includeSelf: true }, context("monitor-2")) as any;
    expect(withSelf.agents.some((item: any) => item.sessionId === parent.sessionId && item.relationship === "self")).toBe(true);
    await engine.shutdown();
  });

  it("stops a child agent and distinguishes cancel from close", async () => {
    const { engine, context } = await fixture();
    const childId = await spawnChild(engine, context("spawn"));

    const cancelled = await engine.capabilities.execute("tasks.stop", { sessionId: childId, reason: "Wrong approach." }, context("cancel")) as any;
    expect(cancelled).toMatchObject({ sessionId: childId, mode: "cancel", relationship: "child" });
    // Cancel ends the turn but leaves the agent alive.
    expect((await engine.session(childId)).status).not.toBe("closed");

    const closed = await engine.capabilities.execute("tasks.stop", { sessionId: childId, mode: "close", reason: "No longer needed." }, context("close")) as any;
    expect(closed).toMatchObject({ mode: "close", status: "completed" });
    // The close is recorded on the child's own event stream. (Reading a closed session re-hydrates it,
    // so the event log is the honest evidence, not the live status field.)
    const events = await engine.readEvents(childId, 0, 500);
    const statusChanges = events.filter((item) => item.type === "session.status.changed");
    expect(statusChanges.some((item) => (item.payload as { status?: string }).status === "closed")).toBe(true);
    await engine.shutdown();
  });

  it("refuses to stop itself or an agent outside family reach", async () => {
    const { engine, parent, context } = await fixture();
    const stranger = await engine.createSession({ tenantId: "tenant", name: "stranger" });
    await expect(engine.capabilities.execute("tasks.stop", { sessionId: parent.sessionId, reason: "self" }, context("self")))
      .rejects.toThrow(/cannot stop itself/);
    await expect(engine.capabilities.execute("tasks.stop", { sessionId: stranger.sessionId, reason: "not mine" }, context("stranger")))
      .rejects.toThrow(/family reach/);
    await engine.shutdown();
  });

  it("resumes a child through the durable inbox", async () => {
    const { engine, context } = await fixture();
    const childId = await spawnChild(engine, context("spawn"));
    const resumed = await engine.capabilities.execute("tasks.resume", { sessionId: childId, text: "Carry on with the second half." }, context("resume")) as any;
    expect(resumed).toMatchObject({ sessionId: childId, mode: "follow_up" });
    expect(Array.isArray(resumed.receipts)).toBe(true);
    await engine.shutdown();
  });
});

describe("Model-callable plan mode", () => {
  it("enters plan mode and refuses to leave without saying what it produced", async () => {
    const { engine, parent, context } = await fixture();
    const entered = await engine.capabilities.execute("session.plan.enter", { reason: "Explore the migration first." }, context("enter")) as any;
    expect(entered.permissionMode).toBe("plan");
    expect(entered.updatedBy).toBe("agent");

    const empty = engine.capabilities.execute("session.plan.exit", {}, context("exit-empty"));
    await approveNext(engine, parent.sessionId, true);
    await expect(empty).rejects.toThrow(/requires the plan id/);

    const plan = await engine.planning.create({
      tenantId: "tenant", title: "Migration", objective: "Do it safely.",
      steps: [{ key: "one", title: "Step one", verification: "checked" }],
    });
    const exiting = engine.capabilities.execute("session.plan.exit", { planId: plan.id }, context("exit"));
    await approveNext(engine, parent.sessionId);
    const exited = await exiting as any;
    // Leaving plan mode lands in manual: exploration earns execution, not unattended authority.
    expect(exited.permissionMode).toBe("manual");

    const history = await engine.sessionModes.transitions("tenant", { sessionId: parent.sessionId });
    expect(history[0]?.reason).toContain(plan.id);
    expect(history[0]?.actor).toBe("agent");
    await engine.shutdown();
  });

  it("refuses to exit a mode it is not in", async () => {
    const { engine, parent, context } = await fixture();
    const wrong = engine.capabilities.execute("session.plan.exit", { summary: "nothing" }, context("exit-wrong"));
    await approveNext(engine, parent.sessionId, true);
    await expect(wrong).rejects.toThrow(/not plan mode/);
    await engine.shutdown();
  });

  it("cannot climb above a managed ceiling when leaving plan mode", async () => {
    const managedDir = await mkdtemp(join(tmpdir(), "haf-tasks-managed-"));
    const managedSettingsPath = join(managedDir, "managed-settings.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(managedSettingsPath, JSON.stringify({ permissionModeCeiling: "manual" }), "utf8");
    const homePath = await mkdtemp(join(tmpdir(), "haf-tasks-managed-home-"));
    const engine = new HybridAgentEngine({
      homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local", model: { provider: "mock" }, managedSettingsPath,
    });
    const session = await engine.createSession({ tenantId: "tenant" });
    const snapshot = await engine.session(session.sessionId);
    const context = {
      tenantId: "tenant", sessionId: session.sessionId, familyId: session.sessionId, turnId: "t",
      toolCallId: "c", source: "api" as const, workspacePath: snapshot.workspacePath, idempotencyKey: "ceiling-1",
    };
    await engine.capabilities.execute("session.plan.enter", { reason: "Explore." }, context);
    const climbing = engine.capabilities.execute("session.plan.exit", { planId: "plan-x", permissionMode: "auto" }, { ...context, toolCallId: "c2", idempotencyKey: "ceiling-2" });
    await approveNext(engine, session.sessionId, true);
    await expect(climbing).rejects.toThrow(/managed ceiling/);
    await engine.shutdown();
  });
});
