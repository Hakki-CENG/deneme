import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceCheckpointService } from "../src/aurora/workspace-checkpoint-service.js";
import { HybridAgentEngine } from "../src/engine.js";

async function fixture(limits?: { maxFiles?: number; maxTotalBytes?: number; maxFileBytes?: number }) {
  const root = await mkdtemp(join(tmpdir(), "haf-aurora-checkpoint-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await writeFile(join(workspace, "README.md"), "# Project\n", "utf8");
  await mkdir(join(workspace, "node_modules", "junk"), { recursive: true });
  await writeFile(join(workspace, "node_modules", "junk", "big.js"), "x".repeat(5000), "utf8");
  return { service: new WorkspaceCheckpointService(join(root, "data"), limits ?? {}), workspace };
}

describe("Aurora workspace checkpoints", () => {
  it("captures a bounded snapshot, excluding dependency directories", async () => {
    const { service, workspace } = await fixture();
    const checkpoint = await service.capture({ tenantId: "tenant", workspacePath: workspace, label: "before migration", reason: "Zone 3 action." });
    expect(checkpoint.files.map((item) => item.path).sort()).toEqual(["README.md", "src/index.ts"]);
    expect(checkpoint.skipped.some((item) => item.reason === "excluded")).toBe(true);
    expect(checkpoint.workspaceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(checkpoint.totalBytes).toBeGreaterThan(0);
  });

  it("diffs added, modified and removed files without touching the workspace", async () => {
    const { service, workspace } = await fixture();
    const checkpoint = await service.capture({ tenantId: "tenant", workspacePath: workspace, label: "base", reason: "baseline" });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 2;\n", "utf8");
    await writeFile(join(workspace, "src", "extra.ts"), "export const extra = true;\n", "utf8");
    await rm(join(workspace, "README.md"));
    const diff = await service.diff("tenant", checkpoint.id, workspace);
    const changes = Object.fromEntries(diff.changed.map((item) => [item.path, item.change]));
    expect(changes["src/index.ts"]).toBe("modified");
    expect(changes["src/extra.ts"]).toBe("added");
    expect(changes["README.md"]).toBe("removed");
    expect(await readFile(join(workspace, "src", "index.ts"), "utf8")).toBe("export const value = 2;\n");
  });

  it("restores exactly, takes a safety checkpoint and can undo the rollback", async () => {
    const { service, workspace } = await fixture();
    const original = await service.capture({ tenantId: "tenant", workspacePath: workspace, label: "before", reason: "baseline" });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 999;\n", "utf8");
    await writeFile(join(workspace, "src", "generated.ts"), "// generated\n", "utf8");

    const restore = await service.restore({ tenantId: "tenant", checkpointId: original.id, workspacePath: workspace, removeAddedFiles: true });
    expect(restore.restored).toBeGreaterThan(0);
    expect(restore.removed).toBe(1);
    expect(restore.safetyCheckpointId).toBeTruthy();
    expect(await readFile(join(workspace, "src", "index.ts"), "utf8")).toBe("export const value = 1;\n");

    // The rollback is itself reversible through the automatic safety checkpoint.
    await service.restore({ tenantId: "tenant", checkpointId: restore.safetyCheckpointId!, workspacePath: workspace, safetyCheckpoint: false });
    expect(await readFile(join(workspace, "src", "index.ts"), "utf8")).toBe("export const value = 999;\n");
    expect(await readFile(join(workspace, "src", "generated.ts"), "utf8")).toBe("// generated\n");
  });

  it("enforces file, size and traversal bounds", async () => {
    const { service, workspace } = await fixture({ maxFiles: 1 });
    const limited = await service.capture({ tenantId: "tenant", workspacePath: workspace, label: "tiny", reason: "bounded" });
    expect(limited.files).toHaveLength(1);
    expect(limited.skipped.some((item) => item.reason === "file-limit")).toBe(true);

    const { service: sized, workspace: sizedWorkspace } = await fixture({ maxFileBytes: 5 });
    const small = await sized.capture({ tenantId: "tenant", workspacePath: sizedWorkspace, label: "small", reason: "bounded" });
    expect(small.files).toHaveLength(0);
    expect(small.skipped.every((item) => ["file-too-large", "excluded"].includes(item.reason))).toBe(true);

    await expect(service.capture({ tenantId: "tenant", workspacePath: join(workspace, "missing"), label: "x", reason: "y" })).rejects.toThrow("not a directory");
  });

  it("deduplicates content and reclaims blobs only when unreferenced", async () => {
    const { service, workspace } = await fixture();
    const first = await service.capture({ tenantId: "tenant", workspacePath: workspace, label: "one", reason: "r" });
    const second = await service.capture({ tenantId: "tenant", workspacePath: workspace, label: "two", reason: "r" });
    const usage = await service.usage("tenant");
    expect(usage.checkpoints).toBe(2);
    expect(usage.uniqueBlobs).toBe(2);
    expect(usage.files).toBe(4);

    const removedFirst = await service.remove("tenant", first.id);
    expect(removedFirst.removedBlobs).toBe(0);
    // Content is still referenced by the second checkpoint, which must still restore.
    const restore = await service.restore({ tenantId: "tenant", checkpointId: second.id, workspacePath: workspace, safetyCheckpoint: false });
    expect(restore.unchanged).toBe(2);
    const removedSecond = await service.remove("tenant", second.id);
    expect(removedSecond.removedBlobs).toBeGreaterThan(0);
  });

  it("keeps tenants isolated", async () => {
    const { service, workspace } = await fixture();
    const checkpoint = await service.capture({ tenantId: "tenant", workspacePath: workspace, label: "one", reason: "r" });
    await expect(service.get("other", checkpoint.id)).rejects.toThrow("not found");
    expect(await service.list("other")).toHaveLength(0);
  });
});

describe("Aurora operations: telemetry, governance and integrity", () => {
  async function engineFixture(): Promise<HybridAgentEngine> {
    const homePath = await mkdtemp(join(tmpdir(), "haf-aurora-ops-"));
    return new HybridAgentEngine({
      homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local", model: { provider: "mock" },
    });
  }

  it("produces content-free telemetry and Prometheus output", async () => {
    const engine = await engineFixture();
    await engine.memoryGraph.remember({
      tenantId: "local", layer: "semantic", claimType: "observation", title: "Secret project codename",
      content: "The internal codename is Nightingale.", sourceType: "user", confidence: 0.9, importance: 0.9,
    });
    await engine.initiative.propose({
      tenantId: "local", kind: "risk", title: "Credential rotation overdue", message: "Rotate the deploy key.",
      importance: 0.8, urgency: 0.8, impact: 0.8, confidence: 0.8, userRelevance: 0.8,
    });
    const snapshot = await engine.auroraMetrics.snapshot("local");
    expect(snapshot.memory.total).toBe(1);
    expect(snapshot.cognitive.health).toBeGreaterThan(0);
    expect(snapshot.constitution.identityVersion).toBe(1);

    const exposition = await engine.auroraMetrics.prometheus("local");
    expect(exposition).toContain('haf_aurora_health{tenant="local",subsystem="memory"}');
    expect(exposition).toContain("haf_aurora_evolution_index");
    // Content-free: no titles, contents or codenames may appear in telemetry.
    expect(exposition).not.toContain("Nightingale");
    expect(exposition).not.toContain("Credential rotation");
    expect(JSON.stringify(snapshot)).not.toContain("Nightingale");
    await engine.shutdown();
  }, 30_000);

  it("raises operational alerts from real conditions", async () => {
    const engine = await engineFixture();
    const resource = await engine.environment.registerResource({ tenantId: "local", kind: "api", name: "Flaky", locator: "https://api.example.com", zone: 2 });
    const action = await engine.environment.planAction({ tenantId: "local", resourceId: resource.id, goal: "Call API", plan: ["call"], action: "api.call", expectedOutcome: "200" });
    await engine.environment.startAction("local", action.id);
    await engine.environment.completeAction({ tenantId: "local", actionId: action.id, success: true, summary: "ok", durationMs: 100 });
    const alerts = await engine.auroraMetrics.alerts("local");
    expect(alerts.map((item) => item.code)).toContain("verification-debt");
    await engine.environment.verifyAction({ tenantId: "local", actionId: action.id, method: "status check", passed: true });
    expect((await engine.auroraMetrics.alerts("local")).map((item) => item.code)).not.toContain("verification-debt");
    await engine.shutdown();
  }, 30_000);

  it("exports every store and purges a user with an explicit retention statement", async () => {
    const engine = await engineFixture();
    await engine.userModel.observeClaim({ tenantId: "local", userId: "primary", category: "habit", key: "morning", value: "Works best before noon.", confidence: 0.7, source: "user-stated" });
    await engine.userModel.upsertGoal({ tenantId: "local", userId: "primary", horizon: "long", title: "Ship Aurora" });
    await engine.memoryGraph.remember({
      tenantId: "local", layer: "user", claimType: "observation", title: "User preference",
      content: "Prefers short answers.", sourceType: "user", confidence: 0.9, importance: 0.6, userId: "primary",
    });

    const tenantExport = await engine.dataGovernance.export({ tenantId: "local", includeContent: false });
    expect(tenantExport.sections.some((item) => item.section === "memories")).toBe(true);
    expect(tenantExport.sections.some((item) => item.section === "constitution-principles")).toBe(true);
    expect(tenantExport.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(tenantExport.data).toEqual({});

    const userExport = await engine.dataGovernance.export({ tenantId: "local", userId: "primary" });
    expect(userExport.scope).toBe("user");
    expect(userExport.totalRecords).toBeGreaterThan(0);

    const dryRun = await engine.dataGovernance.purgeUser({ tenantId: "local", userId: "primary" });
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.totalRemoved).toBeGreaterThan(0);
    expect(await engine.userModel.claims("local", "primary")).toHaveLength(1);

    const purge = await engine.dataGovernance.purgeUser({ tenantId: "local", userId: "primary", dryRun: false });
    expect(purge.dryRun).toBe(false);
    expect(purge.retained.length).toBeGreaterThan(0);
    expect(await engine.userModel.claims("local", "primary")).toHaveLength(0);
    expect((await engine.memoryGraph.list("local")).filter((item) => item.userId === "primary")).toHaveLength(0);
    await engine.shutdown();
  }, 30_000);

  it("detects cross-store integrity problems that no single service can see", async () => {
    const engine = await engineFixture();
    const clean = await engine.dataGovernance.selfCheck("local");
    expect(clean.healthy).toBe(true);
    expect(clean.checks).toBeGreaterThan(8);
    expect(clean.score).toBe(1);

    // Verification debt and a dangling memory relation are both cross-store conditions.
    const left = await engine.memoryGraph.remember({ tenantId: "local", layer: "semantic", claimType: "observation", title: "A", content: "Alpha.", sourceType: "system", confidence: 0.8, importance: 0.5 });
    const right = await engine.memoryGraph.remember({ tenantId: "local", layer: "semantic", claimType: "observation", title: "B", content: "Beta.", sourceType: "system", confidence: 0.8, importance: 0.5 });
    await engine.memoryGraph.relate({ tenantId: "local", fromId: left.id, toId: right.id, type: "relates" });
    const resource = await engine.environment.registerResource({ tenantId: "local", kind: "api", name: "API", locator: "https://api.example.com", zone: 2 });
    const action = await engine.environment.planAction({ tenantId: "local", resourceId: resource.id, goal: "Call", plan: ["call"], action: "api.call", expectedOutcome: "200" });
    await engine.environment.startAction("local", action.id);
    await engine.environment.completeAction({ tenantId: "local", actionId: action.id, success: true, summary: "ok", durationMs: 50 });

    const report = await engine.dataGovernance.selfCheck("local");
    expect(report.findings.map((item) => item.code)).toContain("verification-debt");
    expect(report.score).toBeLessThan(1);
    expect(report.healthy).toBe(true);
    await engine.shutdown();
  }, 30_000);

  it("binds a checkpoint to a high-zone action as its concrete recovery path", async () => {
    const engine = await engineFixture();
    const session = await engine.createSession({ tenantId: "local", name: "risky" });
    await writeFile(join(session.workspacePath, "data.txt"), "original\n", "utf8");
    const checkpoint = await engine.checkpoints.capture({
      tenantId: "local", workspacePath: session.workspacePath, sessionId: session.sessionId,
      label: "before destructive migration", reason: "Zone 4 action about to run.",
    });
    const resource = await engine.environment.registerResource({ tenantId: "local", kind: "database", name: "Prod", locator: "postgres://prod", zone: 4 });
    const action = await engine.environment.planAction({
      tenantId: "local", resourceId: resource.id, goal: "Migrate schema", plan: ["backup", "migrate"],
      action: "sql.execute", expectedOutcome: "Schema migrated.",
      rollbackPlan: "Restore the pre-action workspace checkpoint and re-run the previous migration.",
      rollbackCheckpointId: checkpoint.id,
    });
    expect(action.rollbackCheckpointId).toBe(checkpoint.id);
    await engine.environment.approveAction({ tenantId: "local", actionId: action.id, actor: "operator", reason: "Reviewed the migration." });
    await engine.environment.startAction("local", action.id);
    await writeFile(join(session.workspacePath, "data.txt"), "corrupted\n", "utf8");
    await engine.environment.completeAction({ tenantId: "local", actionId: action.id, success: false, summary: "Constraint violation.", durationMs: 900, unexpected: true });

    const restore = await engine.checkpoints.restore({ tenantId: "local", checkpointId: checkpoint.id, workspacePath: session.workspacePath });
    expect(await readFile(join(session.workspacePath, "data.txt"), "utf8")).toBe("original\n");
    const rolled = await engine.environment.rollbackAction({ tenantId: "local", actionId: action.id, reason: "Restored the pre-action checkpoint.", restoredCheckpointId: checkpoint.id });
    expect(rolled.status).toBe("rolled-back");
    expect(rolled.verification?.method).toContain(`checkpoint:${checkpoint.id}`);
    expect(restore.restored).toBeGreaterThan(0);
    await engine.shutdown();
  }, 30_000);

  it("feeds integrity findings into the ACOS evaluate phase", async () => {
    const engine = await engineFixture();
    const resource = await engine.environment.registerResource({ tenantId: "local", kind: "api", name: "API", locator: "https://api.example.com", zone: 2 });
    const action = await engine.environment.planAction({ tenantId: "local", resourceId: resource.id, goal: "Call", plan: ["call"], action: "api.call", expectedOutcome: "200" });
    await engine.environment.startAction("local", action.id);
    await engine.environment.completeAction({ tenantId: "local", actionId: action.id, success: true, summary: "ok", durationMs: 50 });
    const cycle = await engine.acos.tick("local");
    const evaluate = cycle.phases.find((item) => item.phase === "evaluate")!;
    expect(evaluate.detail["integrityScore"]).toBeLessThan(1);
    expect(cycle.recommendations.some((item) => item.startsWith("Integrity:"))).toBe(true);
    await engine.shutdown();
  }, 30_000);
});
