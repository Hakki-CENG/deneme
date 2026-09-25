import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { SettingsResolver } from "../src/policy/settings-resolver.js";
import { UserQuestionService } from "../src/runtime/user-questions.js";

async function workspaceWithSettings(project: unknown, projectLocal?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "haf-settings-"));
  await mkdir(join(root, ".aurora"), { recursive: true });
  await writeFile(join(root, ".aurora", "settings.json"), JSON.stringify(project), "utf8");
  if (projectLocal !== undefined) await writeFile(join(root, ".aurora", "settings.local.json"), JSON.stringify(projectLocal), "utf8");
  return root;
}

describe("Layered settings", () => {
  it("merges layers in precedence order and reports where each value came from", async () => {
    const workspacePath = await workspaceWithSettings({ theme: "project", deniedCapabilities: ["process.exec"] }, { theme: "local" });
    const resolver = new SettingsResolver();
    const effective = await resolver.effective({
      tenantId: "tenant",
      workspacePath,
      settings: { defaults: { theme: "engine", retries: 3 }, user: { theme: "user" }, runtime: { retries: 5 } },
    });

    expect(effective.values.theme).toBe("local");
    expect(effective.values.retries).toBe(5);
    const theme = effective.provenance.find((item) => item.key === "theme")!;
    expect(theme.layer).toBe("project-local");
    expect(theme.contributions.map((item) => item.layer)).toEqual(["defaults", "user", "project", "project-local"]);
    expect(theme.contributions.filter((item) => item.overridden).length).toBe(3);
    expect(effective.layersPresent).toEqual(["defaults", "user", "project", "project-local", "runtime"]);
  });

  it("concatenates arrays across layers below managed", async () => {
    const workspacePath = await workspaceWithSettings({ deniedCapabilities: ["process.exec"] });
    const resolver = new SettingsResolver();
    const effective = await resolver.effective({
      tenantId: "tenant", workspacePath,
      settings: { defaults: { deniedCapabilities: ["checkpoint.restore"] } },
    });
    expect(effective.values.deniedCapabilities).toEqual(["checkpoint.restore", "process.exec"]);
  });

  it("locks anything the managed layer sets, and records the ignored override", async () => {
    const managedDir = await mkdtemp(join(tmpdir(), "haf-managed-"));
    const managedPath = join(managedDir, "managed-settings.json");
    await writeFile(managedPath, JSON.stringify({ allowBypass: false, deniedCapabilities: ["process.exec"], permissionModeCeiling: "acceptEdits" }), "utf8");
    const workspacePath = await workspaceWithSettings({ allowBypass: true, deniedCapabilities: ["nothing"] });

    const resolver = new SettingsResolver({ managedPath });
    const effective = await resolver.effective({
      tenantId: "tenant", workspacePath,
      settings: { runtime: { allowBypass: true } },
    });

    expect(effective.values.allowBypass).toBe(false);
    expect(effective.locked).toEqual(expect.arrayContaining(["allowBypass", "deniedCapabilities", "permissionModeCeiling"]));
    // The managed list replaces rather than merges: an admin deny list must not be shrinkable or extendable.
    expect(effective.values.deniedCapabilities).toEqual(["process.exec"]);
    // The developer's override is recorded, not silently dropped.
    const bypass = effective.provenance.find((item) => item.key === "allowBypass")!;
    expect(bypass.locked).toBe(true);
    expect(bypass.contributions.some((item) => item.layer === "runtime" && item.value === true && item.overridden)).toBe(true);
  });

  it("treats malformed or oversized project settings as warnings, never failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-settings-bad-"));
    await mkdir(join(root, ".aurora"), { recursive: true });
    await writeFile(join(root, ".aurora", "settings.json"), "{not json", "utf8");
    const resolver = new SettingsResolver();
    const effective = await resolver.effective({ tenantId: "tenant", workspacePath: root, settings: { defaults: { a: 1 } } });
    expect(effective.values.a).toBe(1);
    expect(effective.warnings.some((item) => item.includes("not valid JSON"))).toBe(true);
  });

  it("is reachable as a governed capability from a session", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-settings-engine-"));
    const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
    const session = await engine.createSession({ tenantId: "tenant" });
    const snapshot = await engine.session(session.sessionId);
    await mkdir(join(snapshot.workspacePath, ".aurora"), { recursive: true });
    await writeFile(join(snapshot.workspacePath, ".aurora", "settings.json"), JSON.stringify({ reviewBase: "main" }), "utf8");
    const effective = await engine.settings.effective({ tenantId: "tenant", workspacePath: snapshot.workspacePath });
    expect(effective.values.reviewBase).toBe("main");
    expect(effective.provenance[0]?.layer).toBe("project");
    await engine.shutdown();
  });
});

describe("Structured user questions", () => {
  it("resolves with the human's choice", async () => {
    const service = new UserQuestionService();
    const asking = service.ask({
      tenantId: "tenant", sessionId: "session", question: "Which database should I migrate first?",
      options: [{ label: "orders" }, { label: "users" }],
    });
    const pending = service.list({ pendingOnly: true });
    expect(pending.length).toBe(1);
    service.answer({ questionId: pending[0]!.id, optionId: "option-2", answeredBy: "alice" });
    const answered = await asking;
    expect(answered.status).toBe("answered");
    expect(answered.answer).toMatchObject({ optionId: "option-2", answeredBy: "alice" });
  });

  it("times out without inventing an answer", async () => {
    const service = new UserQuestionService();
    const result = await service.ask({
      tenantId: "tenant", sessionId: "session", question: "Still there?",
      options: [{ label: "yes" }, { label: "no" }], timeoutMs: 5000,
    });
    expect(result.status).toBe("timed-out");
    expect(result.answer).toBeUndefined();
  }, 10_000);

  it("refuses a single option, free text it was not offered, and too many outstanding questions", async () => {
    const service = new UserQuestionService();
    await expect(service.ask({ tenantId: "t", sessionId: "s", question: "One?", options: [{ label: "only" }] }))
      .rejects.toThrow(/2 to 6 options/);

    const first = service.ask({ tenantId: "t", sessionId: "s", question: "A?", options: [{ label: "x" }, { label: "y" }] });
    const second = service.ask({ tenantId: "t", sessionId: "s", question: "B?", options: [{ label: "x" }, { label: "y" }] });
    const third = service.ask({ tenantId: "t", sessionId: "s", question: "C?", options: [{ label: "x" }, { label: "y" }] });
    await new Promise((wait) => setTimeout(wait, 10));
    await expect(service.ask({ tenantId: "t", sessionId: "s", question: "D?", options: [{ label: "x" }, { label: "y" }] }))
      .rejects.toThrow(/unanswered question/);

    const pending = service.list({ pendingOnly: true });
    await expect(async () => service.answer({ questionId: pending[0]!.id, text: "free" })).rejects.toThrow(/free text/);
    service.cancelForSession("s", "test over");
    await Promise.all([first, second, third]);
    expect(service.list({ pendingOnly: true })).toEqual([]);
  });

  it("notifies subscribers and keeps questions session-scoped", async () => {
    const service = new UserQuestionService();
    const seen: string[] = [];
    const unsubscribe = service.subscribe((question) => seen.push(`${question.status}:${question.id.slice(0, 12)}`));
    const asking = service.ask({ tenantId: "t", sessionId: "s1", question: "Pick", options: [{ label: "a" }, { label: "b" }] });
    const [pending] = service.list({ sessionId: "s1", pendingOnly: true });
    expect(service.list({ sessionId: "s2" })).toEqual([]);
    service.answer({ questionId: pending!.id, optionId: "option-1" });
    await asking;
    expect(seen.length).toBe(2);
    expect(seen[0]?.startsWith("pending:")).toBe(true);
    expect(seen[1]?.startsWith("answered:")).toBe(true);
    unsubscribe();
  });

  it("is denied in dontAsk mode and allowed in plan mode", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-question-engine-"));
    const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
    const session = await engine.createSession({ tenantId: "tenant" });
    const snapshot = await engine.session(session.sessionId);
    const context = {
      tenantId: "tenant", sessionId: session.sessionId, familyId: session.sessionId, turnId: "t",
      toolCallId: "c1", source: "api" as const, workspacePath: snapshot.workspacePath, idempotencyKey: "ask-1",
    };

    await engine.sessionModes.set({ tenantId: "tenant", sessionId: session.sessionId, permissionMode: "dontAsk", reason: "Unattended.", actor: "test" });
    await expect(engine.capabilities.execute("user.ask", { question: "Which one?", options: [{ label: "a" }, { label: "b" }] }, context))
      .rejects.toThrow(/dontAsk/);

    await engine.sessionModes.set({ tenantId: "tenant", sessionId: session.sessionId, permissionMode: "plan", reason: "Explore.", actor: "test" });
    const asking = engine.capabilities.execute("user.ask", { question: "Which one?", options: [{ label: "a" }, { label: "b" }], timeoutMs: 10_000 }, { ...context, toolCallId: "c2", idempotencyKey: "ask-2" });
    let pending = engine.userQuestions.list({ pendingOnly: true });
    for (let wait = 0; wait < 100 && !pending.length; wait++) {
      await new Promise((tick) => setTimeout(tick, 10));
      pending = engine.userQuestions.list({ pendingOnly: true });
    }
    expect(pending.length).toBe(1);
    engine.userQuestions.answer({ questionId: pending[0]!.id, optionId: "option-1", answeredBy: "operator" });
    expect(await asking).toMatchObject({ status: "answered", chosen: { id: "option-1", label: "a" } });
    await engine.shutdown();
  });
});

describe("Managed settings enforcement", () => {
  async function managedEngine(managed: Record<string, unknown>) {
    const managedDir = await mkdtemp(join(tmpdir(), "haf-managed-engine-"));
    const managedSettingsPath = join(managedDir, "managed-settings.json");
    await writeFile(managedSettingsPath, JSON.stringify(managed), "utf8");
    const homePath = await mkdtemp(join(tmpdir(), "haf-managed-home-"));
    const engine = new HybridAgentEngine({
      homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local", model: { provider: "mock" }, managedSettingsPath,
      autoApproveWorkspaceWrites: true,
    });
    const session = await engine.createSession({ tenantId: "tenant" });
    const snapshot = await engine.session(session.sessionId);
    return { engine, session, snapshot };
  }

  it("refuses a permission mode above the managed ceiling", async () => {
    const { engine, session } = await managedEngine({ permissionModeCeiling: "acceptEdits" });
    await engine.sessionModes.setDefaults({ tenantId: "tenant", allowBypass: true });
    await expect(engine.sessionModes.set({ tenantId: "tenant", sessionId: session.sessionId, permissionMode: "bypass", reason: "Try to climb.", actor: "dev" }))
      .rejects.toThrow(/exceeds the managed ceiling/);
    // Anything at or below the ceiling is still allowed.
    const allowed = await engine.sessionModes.set({ tenantId: "tenant", sessionId: session.sessionId, permissionMode: "acceptEdits", reason: "Within policy.", actor: "dev" });
    expect(allowed.permissionMode).toBe("acceptEdits");
    await engine.shutdown();
  });

  it("denies a capability the managed layer forbids, and says so", async () => {
    const { engine, session, snapshot } = await managedEngine({ deniedCapabilities: ["filesystem.write"] });
    await expect(engine.capabilities.execute("filesystem.write", { path: "a.txt", content: "no" }, {
      tenantId: "tenant", sessionId: session.sessionId, familyId: session.sessionId, turnId: "t", toolCallId: "c",
      source: "api", workspacePath: snapshot.workspacePath, idempotencyKey: "managed-deny-1",
    })).rejects.toThrow(/denied by managed settings/);
    // A capability outside the list is unaffected.
    await engine.capabilities.execute("filesystem.list", { path: "." }, {
      tenantId: "tenant", sessionId: session.sessionId, familyId: session.sessionId, turnId: "t", toolCallId: "c2",
      source: "api", workspacePath: snapshot.workspacePath, idempotencyKey: "managed-deny-2",
    });
    await engine.shutdown();
  });
});
