import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

async function setup() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-role-authority-"));
  const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
  await engine.society.roles("tenant");
  return { engine };
}

describe("Aurora role authority templates", () => {
  it("resolves templates against the live catalog and never invents capability ids", async () => {
    const { engine } = await setup();
    const catalog = new Set(engine.capabilities.list().map((item) => item.id));
    for (const template of engine.roleAuthority.templates()) {
      const resolved = engine.roleAuthority.resolve(template.id);
      expect(resolved.capabilityIds.every((id) => catalog.has(id))).toBe(true);
      expect(resolved.capabilityIds.length).toBeLessThan(resolved.catalogSize);
      expect(resolved.reductionRatio).toBeGreaterThan(0);
      // A pattern that matches nothing means the template drifted away from the real catalog.
      expect(resolved.unmatchedPatterns).toEqual([]);
    }
    await engine.shutdown();
  });

  it("enforces the risk ceiling and reports what it removed", async () => {
    const { engine } = await setup();
    const guardian = engine.roleAuthority.resolve("guardian");
    const descriptors = new Map(engine.capabilities.list().map((item) => [item.id, item]));
    expect(guardian.maxRisk).toBe("pure");
    expect(guardian.capabilityIds.every((id) => descriptors.get(id)!.risk === "pure")).toBe(true);

    const coder = engine.roleAuthority.resolve("coder");
    // The coder may run a process and write files, but never reaches a privileged capability.
    expect(coder.capabilityIds).toContain("process.exec");
    expect(coder.capabilityIds).toContain("filesystem.write");
    expect(coder.capabilityIds).not.toContain("checkpoint.restore");
    expect(coder.capabilityIds.every((id) => descriptors.get(id)!.risk !== "privileged")).toBe(true);

    // Deny patterns remove capabilities the allow list did match, and the removal is reported.
    const planner = engine.roleAuthority.resolve("planner");
    expect(planner.droppedByDeny).toContain("plan.activate");
    expect(planner.capabilityIds).not.toContain("plan.activate");
    const evolver = engine.roleAuthority.resolve("evolver");
    expect(evolver.droppedByDeny).toContain("evolution.retire");
    expect(evolver.capabilityIds).not.toContain("harness.rollback");

    // The ceiling itself does work: Prime coordinates but cannot run privileged cycle control.
    const prime = engine.roleAuthority.resolve("prime");
    expect(prime.droppedByRisk).toContain("cognitive.attention.allocate");
    expect(prime.capabilityIds.every((id) => descriptors.get(id)!.risk !== "privileged")).toBe(true);
    await engine.shutdown();
  });

  it("keeps read-only review roles genuinely read-only", async () => {
    const { engine } = await setup();
    const descriptors = new Map(engine.capabilities.list().map((item) => [item.id, item]));
    const guardian = engine.roleAuthority.resolve("guardian");
    expect(guardian.capabilityIds.every((id) => descriptors.get(id)!.sideEffect === false)).toBe(true);
    await engine.shutdown();
  });

  it("creates an allowlisted profile and binds it to the roles it was written for", async () => {
    const { engine } = await setup();
    const applied = await engine.roleAuthority.apply({ tenantId: "tenant", templateId: "coder" });
    expect(applied.profile.name).toBe("aurora-coder");
    expect(applied.profile.allowedCapabilityIds?.length).toBe(applied.resolved.capabilityIds.length);
    expect(applied.boundRoleIds).toEqual(expect.arrayContaining(["coding-agent", "debug-agent"]));
    const role = (await engine.society.roles("tenant")).find((item) => item.id === "coding-agent");
    expect(role?.agentProfileId).toBe(applied.profile.id);

    // Applying again updates in place instead of creating a duplicate profile.
    const again = await engine.roleAuthority.apply({ tenantId: "tenant", templateId: "coder" });
    expect(again.profile.id).toBe(applied.profile.id);
    expect((await engine.agentProfiles.list("tenant")).filter((item) => item.name === "aurora-coder").length).toBe(1);
    await engine.shutdown();
  });

  it("actually constrains a session bound to the profile", async () => {
    const { engine } = await setup();
    const applied = await engine.roleAuthority.apply({ tenantId: "tenant", templateId: "guardian", bind: false });
    const session = await engine.createSession({ tenantId: "tenant", agentProfileId: applied.profile.id });
    const detail = await engine.session(session.sessionId);
    expect(detail.agentProfile?.allowedCapabilityIds).toContain("aurora.metrics");
    expect(detail.agentProfile?.allowedCapabilityIds).not.toContain("process.exec");
    await engine.shutdown();
  });

  it("audits roles that still inherit full authority and repairs the ratio when applied", async () => {
    const { engine } = await setup();
    const before = await engine.roleAuthority.audit("tenant");
    expect(before.boundRoles).toBe(0);
    expect(before.leastAuthorityRatio).toBe(0);
    expect(before.findings.some((item) => item.code === "role-inherits-full-authority")).toBe(true);

    const applied = await engine.roleAuthority.applyAll("tenant");
    expect(applied.length).toBeGreaterThan(4);
    const after = await engine.roleAuthority.audit("tenant");
    expect(after.boundRoles).toBeGreaterThan(before.boundRoles);
    expect(after.leastAuthorityRatio).toBeGreaterThan(0);
    await engine.shutdown();
  });

  it("flags a profile that drifted above its template", async () => {
    const { engine } = await setup();
    const applied = await engine.roleAuthority.apply({ tenantId: "tenant", templateId: "guardian" });
    await engine.agentProfiles.update(applied.profile.id, {
      allowedCapabilityIds: [...(applied.profile.allowedCapabilityIds ?? []), "process.exec"],
    });
    const audit = await engine.roleAuthority.audit("tenant");
    const drift = audit.findings.find((item) => item.code === "profile-drifted-above-template");
    expect(drift?.detail).toContain("process.exec");
    await engine.shutdown();
  });

  it("rejects unknown templates and refuses to create an empty profile", async () => {
    const { engine } = await setup();
    expect(() => engine.roleAuthority.resolve("does-not-exist")).toThrow(/Unknown role authority template/);
    await expect(engine.roleAuthority.apply({ tenantId: "tenant", templateId: "nope" })).rejects.toThrow(/Unknown role authority template/);
    await engine.shutdown();
  });

  it("keeps template application tenant-scoped", async () => {
    const { engine } = await setup();
    await engine.roleAuthority.apply({ tenantId: "tenant", templateId: "planner" });
    expect((await engine.agentProfiles.list("other-tenant")).length).toBe(0);
    const otherAudit = await engine.roleAuthority.audit("other-tenant");
    expect(otherAudit.boundRoles).toBe(0);
    await engine.shutdown();
  });
});
