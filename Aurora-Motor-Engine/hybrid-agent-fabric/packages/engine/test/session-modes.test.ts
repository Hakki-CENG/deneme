import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { SessionModeService } from "../src/policy/session-modes.js";

async function setup(options: { allowBypass?: boolean } = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "haf-modes-"));
  const engine = new HybridAgentEngine({
    homePath,
    kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local",
    model: { provider: "mock" },
    ...(options.allowBypass ? { sessionModes: { allowBypass: true } } : {}),
  });
  const session = await engine.createSession({ tenantId: "tenant" });
  const snapshot = await engine.session(session.sessionId);
  const context = (suffix: string) => ({
    tenantId: "tenant",
    sessionId: session.sessionId,
    familyId: session.sessionId,
    turnId: `turn-${suffix}`,
    toolCallId: `call-${suffix}`,
    source: "api" as const,
    workspacePath: snapshot.workspacePath,
    idempotencyKey: `mode-${suffix}`,
  });
  return { engine, session, snapshot, context };
}

describe("Session permission modes", () => {
  it("plan mode allows reading and planning but refuses to touch the workspace", async () => {
    const { engine, session, context } = await setup();
    await engine.sessionModes.set({ tenantId: "tenant", sessionId: session.sessionId, permissionMode: "plan", reason: "Explore before acting.", actor: "operator" });

    // Reading is fine.
    await engine.capabilities.execute("filesystem.list", { path: "." }, context("read"));
    // Planning about the work is fine: that is the point of plan mode.
    const plan = await engine.planning.create({
      tenantId: "tenant", title: "Proposed plan", objective: "What I would do.",
      steps: [{ key: "one", title: "Step one", verification: "checked" }],
    });
    expect(plan.id).toBeTruthy();
    // Touching the world is not.
    await expect(engine.capabilities.execute("filesystem.write", { path: "x.txt", content: "no" }, context("write")))
      .rejects.toThrow(/Plan mode is read-only/);

    await engine.sessionModes.set({ tenantId: "tenant", sessionId: session.sessionId, permissionMode: "acceptEdits", reason: "Plan approved.", actor: "operator" });
    await engine.capabilities.execute("filesystem.write", { path: "x.txt", content: "yes" }, context("write-2"));
    expect(await readFile(join(context("x").workspacePath, "x.txt"), "utf8")).toBe("yes");
    await engine.shutdown();
  });

  it("acceptEdits waives the workspace prompt without touching anything riskier", async () => {
    const { engine, session, context } = await setup();
    await engine.sessionModes.set({ tenantId: "tenant", sessionId: session.sessionId, permissionMode: "acceptEdits", reason: "Trusted edit session.", actor: "operator" });
    await engine.capabilities.execute("filesystem.write", { path: "ok.txt", content: "written" }, context("edit"));

    // Process execution is a different risk class and still needs approval, so the call blocks.
    const call = engine.capabilities.execute("process.exec", { command: "echo hi" }, context("process"));
    let approvals = engine.approvals.list(session.sessionId);
    for (let wait = 0; wait < 100 && !approvals.length; wait++) {
      await new Promise((tick) => setTimeout(tick, 10));
      approvals = engine.approvals.list(session.sessionId);
    }
    expect(approvals.length).toBe(1);
    engine.approvals.resolve(approvals[0]!.id, "deny");
    await expect(call).rejects.toThrow();
    await engine.shutdown();
  });

  it("dontAsk denies instead of prompting, so an unattended run never hangs", async () => {
    const { engine, session, context } = await setup();
    await engine.sessionModes.set({ tenantId: "tenant", sessionId: session.sessionId, permissionMode: "dontAsk", reason: "Unattended run.", actor: "operator" });
    await expect(engine.capabilities.execute("filesystem.write", { path: "y.txt", content: "no" }, context("dontask")))
      .rejects.toThrow(/dontAsk/);
    expect(engine.approvals.list(session.sessionId).length).toBe(0);
    await engine.shutdown();
  });

  it("read-only sandbox refuses side effects whatever the permission mode says", async () => {
    const { engine, session, context } = await setup({ allowBypass: true });
    await engine.sessionModes.set({
      tenantId: "tenant", sessionId: session.sessionId, permissionMode: "bypass", sandboxMode: "read-only",
      reason: "Observation only.", actor: "operator",
    });
    await expect(engine.capabilities.execute("filesystem.write", { path: "z.txt", content: "no" }, context("sandbox")))
      .rejects.toThrow(/read-only/);
    await engine.capabilities.execute("filesystem.list", { path: "." }, context("sandbox-read"));
    await engine.shutdown();
  });

  it("refuses bypass unless the deployment enabled it", async () => {
    const { engine, session } = await setup();
    await expect(engine.sessionModes.set({ tenantId: "tenant", sessionId: session.sessionId, permissionMode: "bypass", reason: "Nope.", actor: "operator" }))
      .rejects.toThrow(/not enabled/);
    await engine.sessionModes.setDefaults({ tenantId: "tenant", allowBypass: true });
    const updated = await engine.sessionModes.set({ tenantId: "tenant", sessionId: session.sessionId, permissionMode: "bypass", reason: "Enabled deliberately.", actor: "operator" });
    expect(updated.permissionMode).toBe("bypass");
    await engine.shutdown();
  });

  it("records every transition with an actor and a reason", async () => {
    const { engine, session } = await setup();
    await engine.sessionModes.set({ tenantId: "tenant", sessionId: session.sessionId, permissionMode: "plan", reason: "Explore first.", actor: "operator" });
    await engine.sessionModes.set({ tenantId: "tenant", sessionId: session.sessionId, permissionMode: "auto", reason: "Plan approved by the reviewer.", actor: "reviewer" });
    const history = await engine.sessionModes.transitions("tenant", { sessionId: session.sessionId });
    expect(history.length).toBe(2);
    expect(history[0]).toMatchObject({ actor: "reviewer", reason: "Plan approved by the reviewer." });
    expect(history[0]?.from.permissionMode).toBe("plan");
    expect(history[0]?.to.permissionMode).toBe("auto");
    expect(await engine.sessionModes.transitions("other")).toEqual([]);
    await engine.shutdown();
  });

  it("uses the tenant default for a session that never set a mode", async () => {
    const { engine, session } = await setup();
    expect((await engine.sessionModes.get("tenant", session.sessionId)).permissionMode).toBe("manual");
    await engine.sessionModes.setDefaults({ tenantId: "tenant", permissionMode: "plan", sandboxMode: "read-only" });
    const fresh = await engine.createSession({ tenantId: "tenant" });
    const mode = await engine.sessionModes.get("tenant", fresh.sessionId);
    expect(mode).toMatchObject({ permissionMode: "plan", sandboxMode: "read-only", updatedBy: "default" });
    await engine.shutdown();
  });
});

describe("Session mode adjustment rules", () => {
  const service = new SessionModeService("/tmp/haf-mode-rules-unused");
  const mode = (permissionMode: any, sandboxMode: any = "workspace-write") => ({
    sessionId: "s", tenantId: "t", permissionMode, sandboxMode, updatedAt: new Date().toISOString(), updatedBy: "test",
  });
  const approval = { decision: "require_approval" as const, reasonCode: "workspace_mutation", message: "This action modifies the assigned workspace." };

  it("never un-denies a denial", () => {
    const denied = { decision: "deny" as const, reasonCode: "aurora_risk_denied", message: "Destructive." };
    for (const permission of ["plan", "manual", "acceptEdits", "auto", "dontAsk", "bypass"] as const) {
      expect(service.adjust({ mode: mode(permission), risk: "workspace_write", sideEffect: true, capabilityId: "filesystem.write", decision: denied }).decision).toBe("deny");
    }
  });

  it("relaxes only base-policy approvals, never governance decisions", () => {
    expect(service.adjust({ mode: mode("acceptEdits"), risk: "workspace_write", sideEffect: true, capabilityId: "filesystem.write", decision: approval }).decision).toBe("allow");

    const governed = { decision: "require_approval" as const, reasonCode: "aurora_risk_confirm", message: "Destructive pattern matched." };
    expect(service.adjust({ mode: mode("bypass"), risk: "workspace_write", sideEffect: true, capabilityId: "filesystem.write", decision: governed }).decision).toBe("require_approval");

    const hooked = { decision: "require_approval" as const, reasonCode: "lifecycle_hook_confirm", message: "Hook wants confirmation." };
    expect(service.adjust({ mode: mode("bypass"), risk: "process", sideEffect: true, capabilityId: "process.exec", decision: hooked }).decision).toBe("require_approval");
  });

  it("keeps each mode inside its own risk classes", () => {
    const processApproval = { decision: "require_approval" as const, reasonCode: "process_execution", message: "Runs a process." };
    expect(service.adjust({ mode: mode("acceptEdits"), risk: "process", sideEffect: true, capabilityId: "process.exec", decision: processApproval }).decision).toBe("require_approval");
    expect(service.adjust({ mode: mode("auto"), risk: "process", sideEffect: true, capabilityId: "process.exec", decision: processApproval }).decision).toBe("allow");

    const networkApproval = { decision: "require_approval" as const, reasonCode: "network_access", message: "Uses the network." };
    expect(service.adjust({ mode: mode("auto"), risk: "network", sideEffect: true, capabilityId: "web.fetch", decision: networkApproval }).decision).toBe("require_approval");
  });

  it("asks for confirmation before an external effect in a workspace-write sandbox", () => {
    const allowed = { decision: "allow" as const, reasonCode: "low_risk", message: "Allowed." };
    const result = service.adjust({ mode: mode("auto", "workspace-write"), risk: "external_side_effect", sideEffect: true, capabilityId: "channel.send", decision: allowed });
    expect(result.decision).toBe("require_approval");
    expect(result.reasonCode).toBe("sandbox_workspace_write");
  });
});
