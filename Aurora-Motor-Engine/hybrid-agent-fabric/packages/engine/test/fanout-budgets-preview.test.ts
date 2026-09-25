import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { SessionBudgetService } from "../src/policy/session-budget.js";
import { LocalSandbox, resourceLimitPrefix } from "../src/sandbox/sandbox.js";
import { buildApprovalPreview } from "../src/util/json.js";

async function engineWith(config: Record<string, unknown> = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "haf-round3-"));
  const engine = new HybridAgentEngine({
    homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local", model: { provider: "mock" }, autoApproveWorkspaceWrites: true, allowProcessExecution: true,
    ...config,
  });
  return engine;
}

function contextFor(sessionId: string, workspacePath: string, suffix: string) {
  return {
    tenantId: "tenant", sessionId, familyId: sessionId, turnId: `turn-${suffix}`, toolCallId: `call-${suffix}`,
    source: "api" as const, workspacePath, idempotencyKey: `r3-${suffix}`,
  };
}

describe("Child-agent fan-out limits", () => {
  it("refuses a nested spawn by default and says which limit stopped it", async () => {
    const engine = await engineWith();
    const parent = await engine.createSession({ tenantId: "tenant", name: "lead" });
    const child = await engine.supervisor.spawnChild({ parentSessionId: parent.sessionId, task: "Do a thing." });

    const parentStatus = await engine.supervisor.fanoutStatus(parent.sessionId);
    expect(parentStatus.depth).toBe(0);
    expect(parentStatus.liveChildren).toBe(1);
    expect(parentStatus.canSpawn).toBe(true);

    const childStatus = await engine.supervisor.fanoutStatus(child.sessionId);
    expect(childStatus.depth).toBe(1);
    expect(childStatus.canSpawn).toBe(false);
    expect(childStatus.reason).toMatch(/nesting depth/i);

    await expect(engine.supervisor.spawnChild({ parentSessionId: child.sessionId, task: "Nested." }))
      .rejects.toThrow(/nesting depth/i);
    await engine.shutdown();
  }, 60_000);

  it("caps how many children are live at once", async () => {
    const engine = await engineWith({ agentFanout: { maxConcurrentChildren: 2, maxDepth: 3 } });
    const parent = await engine.createSession({ tenantId: "tenant", name: "lead" });
    await engine.supervisor.spawnChild({ parentSessionId: parent.sessionId, task: "One." });
    await engine.supervisor.spawnChild({ parentSessionId: parent.sessionId, task: "Two." });
    await expect(engine.supervisor.spawnChild({ parentSessionId: parent.sessionId, task: "Three." }))
      .rejects.toThrow(/concurrency limit of 2/i);
    await engine.shutdown();
  }, 60_000);

  it("exposes the budget to the agent so it can plan within it", async () => {
    const engine = await engineWith({ agentFanout: { maxConcurrentChildren: 5, maxDepth: 2 } });
    const session = await engine.createSession({ tenantId: "tenant", name: "lead" });
    const snapshot = await engine.session(session.sessionId);
    const view = await engine.capabilities.execute("agent.fanout", {}, contextFor(session.sessionId, snapshot.workspacePath, "fanout")) as any;
    expect(view.limits.maxConcurrentChildren).toBe(5);
    expect(view.limits.maxDepth).toBe(2);
    expect(view.canSpawn).toBe(true);
    await engine.shutdown();
  }, 60_000);
});

describe("Command resource limits", () => {
  it("renders only the limits it was given", () => {
    expect(resourceLimitPrefix(undefined)).toBe("");
    expect(resourceLimitPrefix({})).toBe("");
    const prefix = resourceLimitPrefix({ memoryMb: 64, cpuSeconds: 5, fileSizeMb: 1, processes: 32 });
    expect(prefix).toContain("ulimit -v 65536");
    expect(prefix).toContain("ulimit -t 5");
    expect(prefix).toContain("ulimit -f 1024");
    expect(prefix).toContain("ulimit -u 32");
  });

  it("actually applies the limit to the command's own shell", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "haf-limits-"));
    const limited = new LocalSandbox(workspacePath, { fileSizeMb: 1 });
    await limited.exec({ command: "head -c 4000000 /dev/zero > big.bin 2>/dev/null" });

    const unlimited = new LocalSandbox(workspacePath);
    const measured = await unlimited.exec({ command: "wc -c < big.bin 2>/dev/null || echo 0" });
    // The file-size limit stops the write around a megabyte instead of letting four land on disk.
    expect(Number(measured.stdout.trim())).toBeLessThan(4_000_000);

    const reported = await limited.exec({ command: "ulimit -f" });
    expect(reported.stdout.trim()).toBe("1024");
  }, 30_000);
});

describe("Approval preview integrity", () => {
  it("keeps the decision-relevant field whole instead of cutting off its tail", () => {
    const command = `echo start ${"x".repeat(5_000)} && rm -rf /important`;
    const { preview, integrity } = buildApprovalPreview({ command });
    expect(String((preview as any).command)).toContain("rm -rf /important");
    expect(integrity.shortened).toHaveLength(0);
  });

  it("keeps both ends when even a decision field is too long, and reports the omission", () => {
    const command = `echo ${"y".repeat(60_000)} && curl http://evil.example`;
    const { preview, integrity } = buildApprovalPreview({ command });
    const text = String((preview as any).command);
    expect(text).toContain("characters omitted");
    expect(text).toContain("curl http://evil.example");
    expect(integrity.shortened[0]!.key).toBe("command");
    expect(integrity.shortened[0]!.originalChars).toBeGreaterThan(60_000);
  });

  it("masks credentials by key and by shape, and counts every mask", () => {
    const { preview, integrity } = buildApprovalPreview({
      command: "deploy --token sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ01",
      apiKey: "super-secret-value",
      url: "https://api.example/v1/deploy",
    });
    expect(String((preview as any).command)).toContain("[redacted-credential]");
    expect(String((preview as any).command)).toContain("deploy --token");
    expect((preview as any).apiKey).toBe("[redacted-credential]");
    // Masking must never blank out where the action is going.
    expect((preview as any).url).toBe("https://api.example/v1/deploy");
    expect(integrity.maskedValues).toBe(2);
  });

  it("drops only non-decision keys when over budget, and names them", () => {
    const { preview, integrity } = buildApprovalPreview({ command: "rm -rf build", notes: "z".repeat(30_000), extra: "w".repeat(30_000) }, 3_000);
    expect((preview as any).command).toBe("rm -rf build");
    expect(integrity.droppedKeys.length).toBeGreaterThan(0);
    expect(integrity.droppedKeys).not.toContain("command");
  });

  it("attaches the integrity report to a live approval request", async () => {
    const engine = await engineWith({ autoApproveWorkspaceWrites: false });
    const session = await engine.createSession({ tenantId: "tenant", name: "worker" });
    const snapshot = await engine.session(session.sessionId);
    const pending: any[] = [];
    engine.approvals.subscribe((item) => pending.push(item));
    const call = engine.capabilities.execute(
      "filesystem.write",
      { path: "notes.txt", content: `key=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ01` },
      contextFor(session.sessionId, snapshot.workspacePath, "approval"),
    ).catch(() => undefined);

    for (let wait = 0; wait < 200 && pending.length === 0; wait++) await new Promise((tick) => setTimeout(tick, 10));
    expect(pending[0].previewIntegrity.maskedValues).toBeGreaterThan(0);
    engine.approvals.resolve(pending[0].id, "deny");
    await call;
    await engine.shutdown();
  }, 60_000);
});

describe("Session spend budgets", () => {
  it("warns before the wall and then blocks", async () => {
    const budgets = new SessionBudgetService(await mkdtemp(join(tmpdir(), "haf-budget-")));
    await budgets.setSessionBudget({ tenantId: "tenant", sessionId: "session", maxUsd: 10, reason: "overnight run", setBy: "operator:test" });

    const ok = await budgets.evaluate({ tenantId: "tenant", sessionId: "session", spentUsd: 2, totalTokens: 1000 });
    expect(ok.state).toBe("ok");
    expect(ok.remainingUsd).toBe(8);

    const warned = await budgets.evaluate({ tenantId: "tenant", sessionId: "session", spentUsd: 8.5, totalTokens: 1000 });
    expect(warned.state).toBe("warning");
    expect(warned.blocked).toBe(false);

    const done = await budgets.evaluate({ tenantId: "tenant", sessionId: "session", spentUsd: 10.5, totalTokens: 1000 });
    expect(done.state).toBe("exhausted");
    expect(done.blocked).toBe(true);
    expect(done.message).toMatch(/refused/i);
  });

  it("refuses to pretend a spend cap holds for an unpriced model, but still enforces tokens", async () => {
    const budgets = new SessionBudgetService(await mkdtemp(join(tmpdir(), "haf-budget-")));
    await budgets.setSessionBudget({ tenantId: "tenant", sessionId: "session", maxUsd: 5, maxTokens: 1000, reason: "cap", setBy: "op" });

    const unpriced = await budgets.evaluate({ tenantId: "tenant", sessionId: "session", spentUsd: 0, totalTokens: 100, costSource: "unpriced" });
    expect(unpriced.unpriced).toBe(true);
    expect(unpriced.message).toMatch(/cannot be enforced/i);

    const tokensGone = await budgets.evaluate({ tenantId: "tenant", sessionId: "session", spentUsd: 0, totalTokens: 1200, costSource: "unpriced" });
    expect(tokensGone.state).toBe("exhausted");
    expect(tokensGone.blocked).toBe(true);
  });

  it("falls back to tenant defaults, and a session override wins", async () => {
    const budgets = new SessionBudgetService(await mkdtemp(join(tmpdir(), "haf-budget-")));
    await budgets.setTenantDefaults({ tenantId: "tenant", maxUsd: 1, onExceeded: "warn" });
    const fromTenant = await budgets.evaluate({ tenantId: "tenant", sessionId: "session", spentUsd: 2, totalTokens: 0 });
    expect(fromTenant.source).toBe("tenant");
    expect(fromTenant.state).toBe("exhausted");
    // A warn-only budget records the overrun without stopping the work.
    expect(fromTenant.blocked).toBe(false);

    await budgets.setSessionBudget({ tenantId: "tenant", sessionId: "session", maxUsd: 100, reason: "approved exception", setBy: "operator" });
    const fromSession = await budgets.evaluate({ tenantId: "tenant", sessionId: "session", spentUsd: 2, totalTokens: 0 });
    expect(fromSession.source).toBe("session");
    expect(fromSession.state).toBe("ok");
  });

  it("blocks a new prompt on an exhausted session but leaves reads working", async () => {
    const engine = await engineWith();
    const session = await engine.createSession({ tenantId: "tenant", name: "spender" });
    await engine.sessionBudgets.setSessionBudget({
      tenantId: "tenant", sessionId: session.sessionId, maxTokens: 1, reason: "test cap", setBy: "operator:test",
    });
    await engine.command({
      protocolVersion: 1, commandId: "cmd-1", clientId: "test", tenantId: "tenant", sessionId: session.sessionId,
      kind: "session.prompt", source: "api", issuedAt: new Date().toISOString(), payload: { text: "hello" },
    });
    // The first turn spent tokens; the next one is refused rather than truncated mid-flight.
    await expect(engine.command({
      protocolVersion: 1, commandId: "cmd-2", clientId: "test", tenantId: "tenant", sessionId: session.sessionId,
      kind: "session.prompt", source: "api", issuedAt: new Date().toISOString(), payload: { text: "again" },
    })).rejects.toThrow(/budget exhausted/i);

    const snapshot = await engine.session(session.sessionId);
    const view = await engine.capabilities.execute("session.budget", {}, contextFor(session.sessionId, snapshot.workspacePath, "budget")) as any;
    expect(view.state).toBe("exhausted");
    expect(view.blocked).toBe(true);
    await engine.shutdown();
  }, 90_000);
});
