import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

async function setup() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-hooks-"));
  const engine = new HybridAgentEngine({
    homePath,
    kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local",
    model: { provider: "mock" },
    autoApproveWorkspaceWrites: true,
  });
  const session = await engine.createSession({ tenantId: "tenant" });
  const snapshot = await engine.session(session.sessionId);
  const context = {
    tenantId: "tenant",
    sessionId: session.sessionId,
    familyId: session.sessionId,
    turnId: "turn-1",
    toolCallId: "call-1",
    source: "api" as const,
    workspacePath: snapshot.workspacePath,
    idempotencyKey: "hook-test-1",
  };
  return { engine, session, snapshot, context };
}

describe("Deterministic lifecycle hooks", () => {
  it("denies a matching capability call at the boundary, with the rule named", async () => {
    const { engine, context } = await setup();
    await engine.lifecycleHooks.define({
      tenantId: "tenant",
      id: "no-production-writes",
      event: "tool.pre",
      description: "Never write to a production configuration file.",
      capabilityIds: ["filesystem.*"],
      argumentPattern: "production\\.env",
      action: "deny",
      reason: "Production configuration is changed through the deployment pipeline, not by an agent.",
    });

    await expect(engine.capabilities.execute("filesystem.write", { path: "production.env", content: "SECRET=1" }, { ...context, toolCallId: "call-2", idempotencyKey: "hook-test-2" }))
      .rejects.toThrow(/no-production-writes/);

    // A non-matching path is untouched by the hook.
    await engine.capabilities.execute("filesystem.write", { path: "notes.md", content: "fine" }, { ...context, toolCallId: "call-3", idempotencyKey: "hook-test-3" });
    expect(await readFile(join(context.workspacePath, "notes.md"), "utf8")).toBe("fine");

    const firings = await engine.lifecycleHooks.firings("tenant");
    expect(firings[0]).toMatchObject({ ruleId: "no-production-writes", action: "deny", subject: "filesystem.write" });
    await engine.shutdown();
  });

  it("is escalation-only: an allow rule cannot grant what policy withheld", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-hooks-deny-"));
    const engine = new HybridAgentEngine({
      homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local", model: { provider: "mock" },
      // Process execution stays disabled; a hook saying "allow" must not change that.
      allowProcessExecution: false,
    });
    const session = await engine.createSession({ tenantId: "tenant" });
    const snapshot = await engine.session(session.sessionId);
    await engine.lifecycleHooks.define({
      tenantId: "tenant", event: "tool.pre", description: "Bless shell commands.", capabilityIds: ["process.exec"],
      action: "allow", reason: "A hook cannot widen authority.",
    });
    const call = engine.capabilities.execute("process.exec", { command: "echo hi" }, {
      tenantId: "tenant", sessionId: session.sessionId, familyId: session.sessionId, turnId: "t", toolCallId: "c",
      source: "api", workspacePath: snapshot.workspacePath, idempotencyKey: "hook-allow-1",
    });
    // Either the base layer denies outright, or it escalates to approval — but the hook's "allow"
    // never turns process execution on by itself.
    let approvals = engine.approvals.list(session.sessionId);
    for (let wait = 0; wait < 100 && !approvals.length; wait++) {
      await new Promise((tick) => setTimeout(tick, 10));
      approvals = engine.approvals.list(session.sessionId);
    }
    if (approvals.length) engine.approvals.resolve(approvals[0]!.id, "deny");
    await expect(call).rejects.toThrow();
    await engine.shutdown();
  });

  it("can require approval instead of denying", async () => {
    const { engine, context } = await setup();
    await engine.lifecycleHooks.define({
      tenantId: "tenant", id: "confirm-deletes", event: "tool.pre", description: "Confirm deletions.",
      capabilityIds: ["filesystem.write"], argumentPattern: "DELETE", action: "require_approval",
      reason: "Deletions are confirmed by a human.",
    });
    const pending = engine.capabilities.execute("filesystem.write", { path: "danger.txt", content: "DELETE everything" }, { ...context, toolCallId: "call-4", idempotencyKey: "hook-test-4" });
    let approvals = engine.approvals.list(context.sessionId);
    for (let wait = 0; wait < 100 && !approvals.length; wait++) {
      await new Promise((tick) => setTimeout(tick, 10));
      approvals = engine.approvals.list(context.sessionId);
    }
    expect(approvals.length).toBe(1);
    expect(JSON.stringify(approvals[0])).toMatch(/confirm-deletes/);
    engine.approvals.resolve(approvals[0]!.id, "deny");
    await expect(pending).rejects.toThrow();
    await engine.shutdown();
  });

  it("keeps hook actions governed: they are inert until allowlisted, and they never shell out", async () => {
    const { engine, context } = await setup();
    await engine.lifecycleHooks.define({
      tenantId: "tenant", id: "note-on-write", event: "tool.pre", description: "Record a note when files change.",
      capabilityIds: ["filesystem.write"], action: "warn", reason: "Recording the change.",
      runCapability: { capabilityId: "memory.propose", input: { title: "workspace change", content: "A file was written by an agent.", kind: "episodic" } },
    });

    await engine.capabilities.execute("filesystem.write", { path: "one.txt", content: "1" }, { ...context, toolCallId: "call-5", idempotencyKey: "hook-test-5" });
    let firings = await engine.lifecycleHooks.firings("tenant");
    expect(firings[0]?.actionResult).toMatchObject({ status: "skipped" });
    expect(firings[0]?.actionResult?.detail).toMatch(/disabled|allowlist/);

    await engine.lifecycleHooks.configure({ tenantId: "tenant", allowCapabilityActions: true, actionAllowlist: ["memory.propose"] });
    await engine.capabilities.execute("filesystem.write", { path: "two.txt", content: "2" }, { ...context, toolCallId: "call-6", idempotencyKey: "hook-test-6" });
    firings = await engine.lifecycleHooks.firings("tenant");
    expect(firings[0]?.actionResult).toMatchObject({ capabilityId: "memory.propose", status: "ok" });
    await engine.shutdown();
  });

  it("does not let a hook action re-enter its own hook", async () => {
    const { engine, context } = await setup();
    await engine.lifecycleHooks.configure({ tenantId: "tenant", allowCapabilityActions: true, actionAllowlist: ["memory.propose"] });
    await engine.lifecycleHooks.define({
      tenantId: "tenant", id: "recursive", event: "tool.pre", description: "Fires on everything.",
      action: "warn", reason: "Observing.",
      runCapability: { capabilityId: "memory.propose", input: { title: "loop probe", content: "probe", kind: "episodic" } },
    });
    await engine.capabilities.execute("filesystem.write", { path: "three.txt", content: "3" }, { ...context, toolCallId: "call-7", idempotencyKey: "hook-test-7" });
    const firings = await engine.lifecycleHooks.firings("tenant", 100);
    // Exactly one firing: the hook's own capability call did not trigger the hook again.
    expect(firings.filter((item) => item.ruleId === "recursive").length).toBe(1);
    await engine.shutdown();
  });

  it("records session lifecycle events and can be disabled per tenant", async () => {
    const { engine, session } = await setup();
    await engine.lifecycleHooks.define({
      tenantId: "tenant", id: "session-audit", event: "session.stop", description: "Note when sessions close.",
      action: "warn", reason: "Session closed.",
    });
    await engine.command({
      protocolVersion: 1, commandId: randomUUID(), clientId: "test", tenantId: "tenant", sessionId: session.sessionId,
      kind: "session.close", source: "api", issuedAt: new Date().toISOString(), payload: {},
    });
    await new Promise((wait) => setTimeout(wait, 100));
    let firings = await engine.lifecycleHooks.firings("tenant");
    expect(firings.some((item) => item.ruleId === "session-audit")).toBe(true);

    await engine.lifecycleHooks.configure({ tenantId: "tenant", enabled: false });
    const result = await engine.lifecycleHooks.run({ tenantId: "tenant", event: "session.stop", subject: "another" });
    expect(result.matched).toEqual([]);
    await engine.shutdown();
  });

  it("keeps rules and firings tenant-scoped and supports enable/disable and removal", async () => {
    const { engine } = await setup();
    const rule = await engine.lifecycleHooks.define({
      tenantId: "tenant", event: "prompt.submit", description: "Watch prompts.", action: "warn", reason: "Observed.",
    });
    expect((await engine.lifecycleHooks.rules("other")).length).toBe(0);
    await engine.lifecycleHooks.setEnabled("tenant", rule.id, false);
    expect((await engine.lifecycleHooks.rules("tenant"))[0]?.enabled).toBe(false);
    expect(await engine.lifecycleHooks.remove("tenant", rule.id)).toEqual({ ruleId: rule.id, removed: true });
    expect(await engine.lifecycleHooks.remove("tenant", rule.id)).toEqual({ ruleId: rule.id, removed: false });
    await expect(engine.lifecycleHooks.setEnabled("other", rule.id, true)).rejects.toThrow(/not found in tenant/);
    await engine.shutdown();
  });
});
