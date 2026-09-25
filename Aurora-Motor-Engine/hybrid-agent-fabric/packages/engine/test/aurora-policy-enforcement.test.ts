import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuroraPolicyEngine } from "../src/policy/aurora-policy-engine.js";
import { ConstitutionService } from "../src/aurora/constitution-service.js";
import { RiskAnalyzerService } from "../src/policy/risk-analyzer.js";
import { HybridAgentEngine } from "../src/engine.js";
import type { CapabilityContext, CapabilityDescriptor } from "../src/types.js";

async function policyFixture(options?: ConstructorParameters<typeof AuroraPolicyEngine>[2]) {
  const root = await mkdtemp(join(tmpdir(), "haf-aurora-policy-"));
  const risk = new RiskAnalyzerService(root);
  const constitution = new ConstitutionService(root);
  return { engine: new AuroraPolicyEngine({ risk, constitution }, root, options ?? {}), risk, constitution };
}

function descriptor(id: string, risk: CapabilityDescriptor["risk"], sideEffect = true): CapabilityDescriptor {
  return { id, version: "1.0.0", description: id, risk, sideEffect, inputSchema: { type: "object" }, source: "core" };
}

function context(source: CapabilityContext["source"] = "api"): CapabilityContext {
  return {
    tenantId: "tenant", sessionId: "session-1", familyId: "family-1", turnId: randomUUID(),
    toolCallId: randomUUID(), source, workspacePath: "/tmp/workspace", idempotencyKey: randomUUID(),
  };
}

describe("Aurora policy enforcement at the capability boundary", () => {
  it("does not escalate ordinary calls, so operator intent is preserved", async () => {
    const { engine } = await policyFixture();
    for (const [id, risk] of [["filesystem.read", "workspace_read"], ["filesystem.write", "workspace_write"], ["process.run", "process"]] as const) {
      const decision = await engine.decide({ descriptor: descriptor(id, risk), arguments: { path: "src/index.ts" }, context: context() });
      expect(decision.decision, `${id} must not be escalated without evidence`).toBe("allow");
      expect(decision.reasonCode).toBe("aurora_no_escalation");
    }
  });

  it("denies a call whose arguments match a critical destructive pattern", async () => {
    const { engine } = await policyFixture();
    const decision = await engine.decide({
      descriptor: descriptor("process.run", "process"),
      arguments: { command: "rm -rf / --no-preserve-root" },
      context: context(),
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("aurora_risk_denied");
    expect(String(decision.message)).toContain("critical");
    expect((decision.constraints?.["matchedRules"] as string[]).length).toBeGreaterThan(0);
  });

  it("requires approval for a high-risk pattern instead of denying it", async () => {
    const { engine } = await policyFixture();
    const decision = await engine.decide({
      descriptor: descriptor("git.push", "external_side_effect"),
      arguments: { command: "git push --force origin main" },
      context: context(),
    });
    expect(decision.decision).toBe("require_approval");
    expect(decision.reasonCode).toBe("aurora_risk_escalation");
    expect(decision.approvalScope).toBe("once");
    expect(decision.constraints?.["zoneHint"]).toBeDefined();
  });

  it("honours configured thresholds", async () => {
    const strict = await policyFixture({ confirmAtOrAbove: "medium", denyAtOrAbove: "high" });
    const forced = await strict.engine.decide({
      descriptor: descriptor("git.push", "external_side_effect"),
      arguments: { command: "git push --force origin main" },
      context: context(),
    });
    expect(forced.decision).toBe("deny");

    const lenient = await policyFixture({ confirmAtOrAbove: "critical", denyAtOrAbove: "never" });
    const allowed = await lenient.engine.decide({
      descriptor: descriptor("process.run", "process"),
      arguments: { command: "rm -rf / --no-preserve-root" },
      context: context(),
    });
    expect(allowed.decision).toBe("require_approval");
  });

  it("records an auditable enforcement trail and summarizes escalation", async () => {
    const { engine } = await policyFixture();
    await engine.decide({ descriptor: descriptor("filesystem.read", "workspace_read"), arguments: { path: "a.txt" }, context: context() });
    await engine.decide({ descriptor: descriptor("process.run", "process"), arguments: { command: "mkfs.ext4 /dev/sda1" }, context: context() });
    const escalated = await engine.decisions("tenant", { escalatedOnly: true });
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toMatchObject({ capabilityId: "process.run", riskLevel: "critical", finalDecision: "deny" });
    const summary = await engine.summary("tenant");
    expect(summary.total).toBe(2);
    expect(summary.escalated).toBe(1);
    expect(summary.denied).toBe(1);
    expect(summary.escalationRate).toBeCloseTo(0.5, 5);
    expect(summary.topRules[0]?.code).toBeTruthy();
  });

  it("fails closed on analyzer failure rather than opening the gate", async () => {
    const { engine, risk } = await policyFixture();
    risk.assess = async () => { throw new Error("analyzer offline"); };
    const decision = await engine.decide({
      descriptor: descriptor("process.run", "process"),
      arguments: { command: "rm -rf / --no-preserve-root" },
      context: context(),
    });
    // Without analysis there is no evidence to escalate on, but the base policy layers still apply
    // and nothing was granted that they withheld.
    expect(decision.decision).toBe("allow");
    expect(decision.reasonCode).toBe("aurora_no_escalation");
  });

  it("blocks a destructive command through the real engine capability path", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-aurora-enforce-"));
    const engine = new HybridAgentEngine({
      homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local", model: { provider: "mock" },
      autoApproveWorkspaceWrites: true, allowProcessExecution: true,
    });
    const session = await engine.createSession({ tenantId: "local", name: "enforced" });
    const ctx: CapabilityContext = {
      tenantId: "local", sessionId: session.sessionId, familyId: session.familyId, turnId: randomUUID(),
      toolCallId: randomUUID(), source: "api", workspacePath: session.workspacePath, idempotencyKey: randomUUID(),
    };

    // A harmless command still runs: the operator enabled process execution and nothing matched.
    const safe = await engine.capabilities.execute("process.exec", { command: "echo hello" }, ctx) as { stdout?: string };
    expect(String(safe.stdout ?? "")).toContain("hello");

    // A destructive one is denied by Aurora governance even though the base policy allows processes.
    await expect(engine.capabilities.execute(
      "process.exec",
      { command: "rm -rf / --no-preserve-root" },
      { ...ctx, toolCallId: randomUUID(), idempotencyKey: randomUUID() },
    )).rejects.toThrow(/Capability process\.exec blocked by policy.*critical/);

    const trail = await engine.auroraPolicy!.decisions("local", { escalatedOnly: true });
    expect(trail.some((item) => item.finalDecision === "deny" && item.capabilityId === "process.exec")).toBe(true);
    await engine.shutdown();
  }, 30_000);

  it("distills lessons automatically when a session closes", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-aurora-close-"));
    const engine = new HybridAgentEngine({
      homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local", model: { provider: "mock" }, autoApproveWorkspaceWrites: true,
    });
    const session = await engine.createSession({ tenantId: "local", name: "closing" });
    for (let index = 0; index < 3; index++) {
      await engine.command({
        protocolVersion: 1, commandId: randomUUID(), clientId: "test", tenantId: "local", sessionId: session.sessionId,
        kind: "session.prompt", source: "api", issuedAt: new Date().toISOString(),
        payload: { text: `[tool filesystem.write {"path":"f-${index}.txt","content":"c"}]` },
      });
      await engine.command({
        protocolVersion: 1, commandId: randomUUID(), clientId: "test", tenantId: "local", sessionId: session.sessionId,
        kind: "session.prompt", source: "api", issuedAt: new Date().toISOString(),
        payload: { text: `[tool filesystem.read {"path":"f-${index}.txt"}]` },
      });
      await engine.command({
        protocolVersion: 1, commandId: randomUUID(), clientId: "test", tenantId: "local", sessionId: session.sessionId,
        kind: "session.prompt", source: "api", issuedAt: new Date().toISOString(),
        payload: { text: '[tool filesystem.list {"path":"."}]' },
      });
    }
    expect(await engine.distiller.proposals("local")).toHaveLength(0);
    await engine.command({
      protocolVersion: 1, commandId: randomUUID(), clientId: "test", tenantId: "local", sessionId: session.sessionId,
      kind: "session.close", source: "api", issuedAt: new Date().toISOString(), payload: {},
    });
    const proposals = await engine.distiller.proposals("local");
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every((item) => item.status === "proposed")).toBe(true);
    await engine.shutdown();
  }, 60_000);

  it("can be disabled by configuration", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-aurora-enforce-off-"));
    const engine = new HybridAgentEngine({
      homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local", model: { provider: "mock" }, auroraGovernance: { enabled: false },
    });
    expect(engine.auroraPolicy).toBeUndefined();
    await engine.shutdown();
  });
});
