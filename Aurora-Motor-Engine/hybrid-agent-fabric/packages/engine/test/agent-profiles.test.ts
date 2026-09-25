import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

const engines: HybridAgentEngine[] = [];
afterEach(async () => await Promise.all(engines.splice(0).map((engine) => engine.shutdown())));

function prompt(sessionId: string, text: string) {
  return {
    protocolVersion: 1 as const,
    commandId: crypto.randomUUID(),
    clientId: "profile-test",
    tenantId: "tenant",
    sessionId,
    kind: "session.prompt" as const,
    source: "api" as const,
    issuedAt: new Date().toISOString(),
    payload: { text },
  };
}

describe("persistent agent profiles", () => {
  it("freezes profile versions and enforces capability visibility through the Python bridge", async () => {
    const engine = new HybridAgentEngine({
      homePath: await mkdtemp(join(tmpdir(), "haf-agent-profile-")),
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      autoApproveWorkspaceWrites: true,
      allowProcessExecution: true,
      model: { provider: "mock" },
    });
    engines.push(engine);
    const profile = await engine.agentProfiles.add({
      tenantId: "tenant",
      name: "read-only analyst",
      description: "No workspace mutation",
      instructions: "Analyze evidence and do not modify the workspace.",
      allowedCapabilityIds: ["python.execute"],
      modelRoute: "mock:profile-model",
    });
    const session = await engine.createSession({ tenantId: "tenant", name: "profiled", agentProfileId: profile.id });
    expect(session.agentProfile).toEqual(expect.objectContaining({ id: profile.id, version: 1, name: "read-only analyst" }));
    expect(session.modelName).toBe("mock:profile-model");

    const direct = await engine.command(prompt(session.sessionId, '[tool filesystem.write {"path":"forbidden.txt","content":"no"}]'));
    expect(direct.status).toBe("completed");
    await expect(access(join(session.workspacePath, "forbidden.txt"))).rejects.toThrow();
    expect(JSON.stringify((await engine.session(session.sessionId)).messages)).toContain("not available to this session's agent profile");

    await engine.command(prompt(session.sessionId, '[tool python.execute {"code":"haf.call(\\"filesystem.write\\", {\\"path\\": \\"python-forbidden.txt\\", \\"content\\": \\"no\\"})"}]'));
    await expect(access(join(session.workspacePath, "python-forbidden.txt"))).rejects.toThrow();
    expect(JSON.stringify((await engine.session(session.sessionId)).messages)).toContain("not allowed by this session's agent profile");

    await engine.agentProfiles.update(profile.id, { instructions: "Updated instructions." });
    expect((await engine.session(session.sessionId)).agentProfile?.version).toBe(1);
    const next = await engine.createSession({ tenantId: "tenant", agentProfileId: profile.id });
    expect(next.agentProfile?.version).toBe(2);
    const child = await engine.supervisor.createSession({
      tenantId: "tenant", familyId: session.familyId, parentSessionId: session.sessionId,
      name: "profile-child", agentProfile: session.agentProfile,
    });
    expect(child.agentProfile?.id).toBe(profile.id);
    expect(child.agentProfile?.allowedCapabilityIds).toEqual(["python.execute"]);
  });

  it("isolates profiles by tenant and rejects invalid routes", async () => {
    const engine = new HybridAgentEngine({
      homePath: await mkdtemp(join(tmpdir(), "haf-agent-profile-tenant-")),
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
    });
    engines.push(engine);
    await expect(engine.agentProfiles.add({ tenantId: "tenant", name: "bad", instructions: "x", modelRoute: "not-a-route" })).rejects.toThrow("provider:model");
    const profile = await engine.agentProfiles.add({ tenantId: "tenant", name: "safe", instructions: "x" });
    await expect(engine.createSession({ tenantId: "other", agentProfileId: profile.id })).rejects.toThrow("does not belong");
    expect(await engine.agentProfiles.list("other")).toEqual([]);
  });
});
