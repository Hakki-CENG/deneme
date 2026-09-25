import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AutomationGitSyncService } from "../src/automation/automation-git-sync.js";
import { HybridAgentEngine } from "../src/engine.js";
import type { HostedRepositoryProviderRegistry } from "../src/repositories/hosted-repository-provider.js";

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }

async function setup(initialManifest: object) {
  const homePath = await mkdtemp(join(tmpdir(), "haf-automation-git-"));
  const engine = new HybridAgentEngine({
    homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local", model: { provider: "mock" },
  });
  const session = await engine.createSession({ tenantId: "tenant" });
  let manifest = JSON.stringify(initialManifest);
  let remoteVersion = "a".repeat(40);
  const hosted = {
    async repository() { return { providerId: "provider", repositoryId: "101", fullName: "org/automation", private: true, defaultBranch: "main", cloneUrl: "https://github.com/org/automation.git", webUrl: "https://github.com/org/automation" }; },
    async readFile() {
      return {
        providerId: "provider", repositoryId: "101", fullName: "org/automation",
        path: ".haf/automations.json", ref: "main", remoteVersion,
        contentSha256: sha(manifest), content: manifest, bytes: Buffer.byteLength(manifest),
      };
    },
  } as unknown as HostedRepositoryProviderRegistry;
  const service = new AutomationGitSyncService(resolve(homePath, "data"), hosted, engine.automations, engine.supervisor);
  return {
    homePath, engine, session, service,
    update(value: object) { manifest = JSON.stringify(value); remoteVersion = createHash("sha1").update(manifest).digest("hex"); },
  };
}

const firstManifest = {
  schemaVersion: 1,
  automations: [
    { key: "review", name: "Repository review", prompt: "Review the repository and report findings.", trigger: { kind: "manual" }, enabled: true },
    { key: "heartbeat", name: "Heartbeat", prompt: "Check repository health.", trigger: { kind: "schedule", schedule: { kind: "interval", everyMs: 60000 } }, enabled: true },
  ],
};

describe("automation Git manifest synchronization", () => {
  it("plans and explicitly applies a hash-bound manifest, updates entries and disables removed keys", async () => {
    const { homePath, engine, session, service, update } = await setup(firstManifest);
    const source = await service.add({
      tenantId: "tenant", name: "automation repo", providerId: "provider", repositoryId: "101",
      manifestPath: ".haf/automations.json", ref: "main", sessionId: session.sessionId,
    });
    const plan = await service.plan(source.id, "tenant");
    expect(plan.entries).toEqual([
      expect.objectContaining({ key: "review", action: "create", trigger: "manual" }),
      expect.objectContaining({ key: "heartbeat", action: "create", trigger: "schedule" }),
    ]);
    const applied = await service.apply(source.id, "tenant", plan.manifestSha256);
    expect(applied).toMatchObject({ status: "succeeded", created: 2, updated: 0, disabled: 0 });
    let automations = (await engine.automations.list("tenant")).filter((item) => item.managedBy?.sourceId === source.id);
    expect(automations).toHaveLength(2);
    expect(automations.find((item) => item.managedBy?.key === "heartbeat")?.schedulerJobId).toBeTruthy();
    expect(automations.every((item) => item.managedBy?.manifestSha256 === plan.manifestSha256)).toBe(true);

    const unchanged = await service.plan(source.id, "tenant");
    expect(unchanged.entries.every((item) => item.action === "unchanged")).toBe(true);
    update({
      schemaVersion: 1,
      automations: [
        { key: "review", name: "Repository review", prompt: "Review the repository, tests, and security posture.", trigger: { kind: "manual" }, enabled: true },
      ],
    });
    const changed = await service.plan(source.id, "tenant");
    expect(changed.entries).toEqual([expect.objectContaining({ key: "review", action: "update" })]);
    expect(changed.disableKeys).toEqual(["heartbeat"]);
    expect(await service.apply(source.id, "tenant", changed.manifestSha256)).toMatchObject({ status: "succeeded", updated: 1, disabled: 1 });
    automations = (await engine.automations.list("tenant")).filter((item) => item.managedBy?.sourceId === source.id);
    expect(automations.find((item) => item.managedBy?.key === "review")?.prompt).toContain("security posture");
    expect(automations.find((item) => item.managedBy?.key === "heartbeat")?.enabled).toBe(false);

    const disk = await readFile(join(homePath, "data", "automation", "git-sources.json"), "utf8");
    expect(disk).not.toContain("Review the repository");
    expect(disk).not.toContain("Check repository health");
    expect(disk).not.toContain("prompt");
    await engine.shutdown();
  });

  it("rejects branch movement after planning and requires a new explicit plan", async () => {
    const { engine, session, service, update } = await setup(firstManifest);
    const source = await service.add({ tenantId: "tenant", name: "source", providerId: "provider", repositoryId: "101", manifestPath: ".haf/automations.json", ref: "main", sessionId: session.sessionId });
    const plan = await service.plan(source.id, "tenant");
    update({ schemaVersion: 1, automations: [{ key: "changed", name: "Changed", prompt: "Different", trigger: { kind: "manual" }, enabled: true }] });
    await expect(service.apply(source.id, "tenant", plan.manifestSha256)).rejects.toThrow("changed after planning");
    expect((await engine.automations.list("tenant")).filter((item) => item.managedBy?.sourceId === source.id)).toHaveLength(0);
    await engine.shutdown();
  });

  it("keeps session, model and webhook-secret authority in administrator source configuration", async () => {
    const manifest = {
      schemaVersion: 1,
      automations: [{ key: "hook", name: "Hook", prompt: "Handle event", trigger: { kind: "webhook", eventType: "issue.created" }, enabled: true, model: "xai:grok" }],
    };
    const { engine, session, service } = await setup(manifest);
    const withoutAuthority = await service.add({ tenantId: "tenant", name: "restricted", providerId: "provider", repositoryId: "101", manifestPath: ".haf/automations.json", ref: "main", sessionId: session.sessionId });
    await expect(service.plan(withoutAuthority.id, "tenant")).rejects.toThrow("not allowlisted");
    const authorized = await service.add({
      tenantId: "tenant", name: "authorized", providerId: "provider", repositoryId: "101",
      manifestPath: ".haf/automations.json", ref: "main", sessionId: session.sessionId,
      webhookSecretEnvironmentVariable: "AUTOMATION_HOOK_SECRET", allowedModels: ["xai:grok"],
    });
    const plan = await service.plan(authorized.id, "tenant");
    expect(await service.apply(authorized.id, "tenant", plan.manifestSha256)).toMatchObject({ status: "succeeded", created: 1 });
    const automation = (await engine.automations.list("tenant")).find((item) => item.managedBy?.sourceId === authorized.id)!;
    expect(automation.sessionId).toBe(session.sessionId);
    expect(automation.model).toBe("xai:grok");
    expect(automation.trigger).toEqual({ kind: "webhook", eventType: "issue.created", secretEnvironmentVariable: "AUTOMATION_HOOK_SECRET" });
    await engine.shutdown();
  });

  it("durably marks an interrupted apply partial on restart without replay", async () => {
    const { homePath, engine, session, service } = await setup(firstManifest);
    const directory = join(homePath, "data", "automation");
    await mkdir(directory, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(join(directory, "git-sources.json"), JSON.stringify({ schemaVersion: 1, sources: [{
      id: "11111111-1111-4111-8111-111111111111", tenantId: "tenant", name: "interrupted",
      providerId: "provider", repositoryId: "101", manifestPath: ".haf/automations.json", ref: "main",
      sessionId: session.sessionId, allowedModels: [], enabled: true, status: "applying",
      lastPlanSha256: "a".repeat(64), lastPlanExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: now, updatedAt: now,
    }] }, null, 2));
    expect(await service.list("tenant")).toContainEqual(expect.objectContaining({ status: "partial", lastErrorCode: "restart_during_apply" }));
    const disk = await readFile(join(directory, "git-sources.json"), "utf8");
    expect(disk).toContain('"status": "partial"');
    expect(disk).not.toContain("lastPlanSha256");
    await engine.shutdown();
  });

  it("fails closed on traversal, duplicate keys, expired schedules and unplanned apply", async () => {
    const { engine, session, service, update } = await setup(firstManifest);
    await expect(service.add({ tenantId: "tenant", name: "bad", providerId: "provider", repositoryId: "101", manifestPath: "../secret.json", ref: "main", sessionId: session.sessionId })).rejects.toThrow("path is invalid");
    const source = await service.add({ tenantId: "tenant", name: "valid", providerId: "provider", repositoryId: "101", manifestPath: ".haf/automations.json", ref: "main", sessionId: session.sessionId });
    await expect(service.apply(source.id, "tenant", "a".repeat(64))).rejects.toThrow("current matching plan");
    update({ schemaVersion: 1, automations: [
      { key: "same", name: "One", prompt: "one", trigger: { kind: "manual" } },
      { key: "same", name: "Two", prompt: "two", trigger: { kind: "manual" } },
    ] });
    await expect(service.plan(source.id, "tenant")).rejects.toThrow("duplicate key");
    update({ schemaVersion: 1, automations: [{ key: "past", name: "Past", prompt: "past", trigger: { kind: "schedule", schedule: { kind: "once", at: "2020-01-01T00:00:00.000Z" } } }] });
    await expect(service.plan(source.id, "tenant")).rejects.toThrow("no future occurrence");
    await engine.shutdown();
  });
});
