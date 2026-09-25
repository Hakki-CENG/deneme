import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { AutoApprovalService } from "../src/policy/auto-approval.js";
import type { ApprovalRequest } from "../src/types.js";

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1", tenantId: "tenant", sessionId: "session", turnId: "turn", toolCallId: "call",
    capabilityId: "git.status", risk: "process", argumentsPreview: { path: "." },
    reason: "process risk", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "pending", ...overrides,
  };
}

async function service() {
  return new AutoApprovalService(await mkdtemp(join(tmpdir(), "haf-auto-approve-")));
}

describe("Reviewed automatic approvals", () => {
  it("escalates everything until an operator writes a rule, and records the refusal", async () => {
    const autoApprovals = await service();
    const review = await autoApprovals.review(request());
    expect(review.autoApproved).toBe(false);
    expect(review.rationale).toMatch(/no reviewed rule/i);

    const decisions = await autoApprovals.listDecisions({ tenantId: "tenant" });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.outcome).toBe("escalated");
  });

  it("answers a named family with the stored rationale and counts the use", async () => {
    const autoApprovals = await service();
    const rule = await autoApprovals.upsertRule({
      tenantId: "tenant", capabilityPattern: "git.*", rationale: "Read-only git inspection was reviewed on 2026-08-20.",
      maxUses: 2,
    });
    const first = await autoApprovals.review(request());
    expect(first.autoApproved).toBe(true);
    expect(first.ruleId).toBe(rule.id);
    expect(first.rationale).toContain("reviewed on 2026-08-20");

    expect((await autoApprovals.review(request())).autoApproved).toBe(true);
    // The budget is spent: the third request goes back to a human.
    const third = await autoApprovals.review(request());
    expect(third.autoApproved).toBe(false);

    const decisions = await autoApprovals.listDecisions({ tenantId: "tenant" });
    expect(decisions.filter((item) => item.outcome === "auto-approved")).toHaveLength(2);
    expect((await autoApprovals.listRules("tenant"))[0]!.uses).toBe(2);
  });

  it("refuses rules that cover everything, and never answers a privileged request", async () => {
    const autoApprovals = await service();
    await expect(autoApprovals.upsertRule({ tenantId: "tenant", capabilityPattern: "*", rationale: "everything is fine" }))
      .rejects.toThrow(/never everything/i);
    await expect(autoApprovals.upsertRule({ tenantId: "tenant", capabilityPattern: "git.*", rationale: "x", riskClasses: ["privileged"] }))
      .rejects.toThrow(/never be answered automatically/i);

    await autoApprovals.upsertRule({ tenantId: "tenant", capabilityPattern: "aurora.*", rationale: "Reviewed governance actions." });
    const review = await autoApprovals.review(request({ capabilityId: "aurora.constitution.amend", risk: "privileged" }));
    expect(review.autoApproved).toBe(false);
    expect(review.rationale).toMatch(/always needs a human/i);
  });

  it("honours argument patterns, refusal patterns, session scope and expiry", async () => {
    const autoApprovals = await service();
    await autoApprovals.upsertRule({
      tenantId: "tenant", capabilityPattern: "process.exec", rationale: "Test runs in this session only.",
      argumentPatterns: ["npm (run )?test"], refusePatterns: ["--force|rm -rf"], sessionIds: ["session"],
    });

    expect((await autoApprovals.review(request({ capabilityId: "process.exec", argumentsPreview: { command: "npm test" } }))).autoApproved).toBe(true);
    expect((await autoApprovals.review(request({ capabilityId: "process.exec", argumentsPreview: { command: "npm run build" } }))).autoApproved).toBe(false);

    const refused = await autoApprovals.review(request({ capabilityId: "process.exec", argumentsPreview: { command: "npm test -- --force" } }));
    expect(refused.autoApproved).toBe(false);
    expect(refused.rationale).toMatch(/refusal pattern/i);

    const otherSession = await autoApprovals.review(request({ sessionId: "elsewhere", capabilityId: "process.exec", argumentsPreview: { command: "npm test" } }));
    expect(otherSession.autoApproved).toBe(false);

    await autoApprovals.upsertRule({
      tenantId: "tenant", capabilityPattern: "web.fetch", rationale: "Expired allowance.",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    expect((await autoApprovals.review(request({ capabilityId: "web.fetch", risk: "network" }))).autoApproved).toBe(false);
  });

  it("keeps an agent proposal disabled until an operator enables it", async () => {
    const autoApprovals = await service();
    const proposed = await autoApprovals.upsertRule({
      tenantId: "tenant", capabilityPattern: "git.*", rationale: "I keep asking for this.",
      enabled: true, proposedByAgent: true,
    });
    expect(proposed.enabled).toBe(false);
    expect(proposed.proposedByAgent).toBe(true);
    expect((await autoApprovals.review(request())).autoApproved).toBe(false);

    await autoApprovals.setEnabled("tenant", proposed.id, true);
    expect((await autoApprovals.review(request())).autoApproved).toBe(true);
  });

  it("stops answering when the mechanism is switched off for the tenant", async () => {
    const autoApprovals = await service();
    await autoApprovals.upsertRule({ tenantId: "tenant", capabilityPattern: "git.*", rationale: "Reviewed." });
    autoApprovals.bindEnabled(async () => false);
    const review = await autoApprovals.review(request());
    expect(review.autoApproved).toBe(false);
    expect(review.rationale).toMatch(/disabled/i);
  });

  it("answers a live approval before it reaches a human, and shows why on the request", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-auto-engine-"));
    const engine = new HybridAgentEngine({
      homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local", model: { provider: "mock" },
    });
    const session = await engine.createSession({ tenantId: "tenant", name: "worker" });
    const snapshot = await engine.session(session.sessionId);
    const context = {
      tenantId: "tenant", sessionId: session.sessionId, familyId: session.sessionId, turnId: "turn-1",
      toolCallId: "call-1", source: "api" as const, workspacePath: snapshot.workspacePath, idempotencyKey: "auto-1",
    };

    await engine.autoApprovals.upsertRule({
      tenantId: "tenant", capabilityPattern: "filesystem.write",
      rationale: "Workspace writes in this tenant were reviewed and are confined to the sandbox.",
      createdBy: "operator:test",
    });
    const resolutions: Array<{ status: string; rationale?: string }> = [];
    engine.approvals.subscribe((item) => resolutions.push({ status: item.status, ...(item.autoApproval ? { rationale: item.autoApproval.rationale } : {}) }));

    await engine.capabilities.execute("filesystem.write", { path: "notes.txt", content: "hello" }, context);
    expect(engine.approvals.list(session.sessionId)).toHaveLength(0);
    expect(resolutions.some((item) => item.status === "approved" && item.rationale?.includes("were reviewed"))).toBe(true);

    const decisions = await engine.autoApprovals.listDecisions({ tenantId: "tenant" });
    expect(decisions[0]!.outcome).toBe("auto-approved");
    expect(decisions[0]!.capabilityId).toBe("filesystem.write");
    await engine.shutdown();
  }, 60_000);

  it("lets managed settings switch the whole mechanism off", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-auto-managed-"));
    const managedDir = join(homePath, "managed");
    await mkdir(managedDir, { recursive: true });
    const managedPath = join(managedDir, "managed-settings.json");
    await writeFile(managedPath, JSON.stringify({ allowAutoApprovals: false }), "utf8");

    const engine = new HybridAgentEngine({
      homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local", model: { provider: "mock" }, managedSettingsPath: managedPath,
    });
    await engine.autoApprovals.upsertRule({ tenantId: "tenant", capabilityPattern: "filesystem.*", rationale: "Reviewed anyway." });
    const review = await engine.autoApprovals.review(request({ capabilityId: "filesystem.write", risk: "workspace_write" }));
    expect(review.autoApproved).toBe(false);
    expect(review.rationale).toMatch(/disabled/i);
    await engine.shutdown();
  }, 60_000);
});
