import { createHmac } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AutomationResponderService } from "../src/automation/automation-responder-service.js";
import type { AutomationService } from "../src/automation/automation-service.js";
import { HybridAgentEngine } from "../src/engine.js";
import { CredentialBroker } from "../src/security/credential-broker.js";

function signed(secret: string, raw: Buffer, timestamp: number, nonce: string) {
  return { timestamp: String(timestamp), nonce, signature: `sha256=${createHmac("sha256", secret).update(`${timestamp}.${nonce}.`).update(raw).digest("hex")}` };
}
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000) { const until = Date.now() + timeoutMs; while (Date.now() < until) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("condition timed out"); }

async function setup() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-responder-"));
  const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
  const session = await engine.createSession({ tenantId: "tenant" });
  const automation = await engine.automations.create({ tenantId: "tenant", name: "issues", sessionId: session.sessionId, prompt: "Process the issue event.", trigger: { kind: "webhook", eventType: "issue.created" } });
  const secret = await engine.credentials.put({ tenantId: "tenant", name: "RESPONDER_SECRET", value: "responder-super-secret" });
  return { homePath, engine, automation, secret };
}

describe("signed automation responder deployments", () => {
  it("records signed heartbeats and derives healthy/degraded/stale status without exposing identity or secret", async () => {
    const { homePath, engine, automation, secret } = await setup();
    let now = Date.parse("2026-08-19T12:00:00Z");
    const service = new AutomationResponderService({ rootPath: resolve(homePath, "data"), credentials: engine.credentials, automations: engine.automations, now: () => now });
    const responder = await service.add({ tenantId: "tenant", name: "github responder", automationId: automation.id, credentialSecretId: secret.id, heartbeatIntervalMs: 20_000 });
    const body = { instanceId: "private-instance-name", version: "1.2.3", status: "ready", capabilities: ["github.issues", "github.comments"] };
    const raw = Buffer.from(JSON.stringify(body));
    expect(await service.acceptHeartbeat(responder.id, raw, signed("responder-super-secret", raw, now / 1000, "nonce-heartbeat-1"), body)).toMatchObject({ duplicate: false, status: "heartbeat_recorded" });
    let view = (await service.list("tenant"))[0]!;
    expect(view).toMatchObject({ health: "healthy", version: "1.2.3", instanceProjection: expect.stringMatching(/^[a-f0-9]{24}$/), credentialConfigured: true });
    expect(JSON.stringify(view)).not.toContain("private-instance-name");
    expect(await service.acceptHeartbeat(responder.id, raw, signed("responder-super-secret", raw, now / 1000, "nonce-heartbeat-1"), body)).toMatchObject({ duplicate: true });
    now += 50_000; view = (await service.list("tenant"))[0]!; expect(view.health).toBe("degraded");
    now += 50_000; view = (await service.list("tenant"))[0]!; expect(view.health).toBe("stale");
    const disk = await readFile(join(homePath, "data", "automation", "responders.json"), "utf8");
    expect(disk).not.toContain("responder-super-secret"); expect(disk).not.toContain("private-instance-name");
    await service.close(); await engine.shutdown();
  });

  it("acknowledges signed events, dispatches once and suppresses duplicate replies", async () => {
    const { engine, automation, secret } = await setup();
    const responder = await engine.automationResponders.add({ tenantId: "tenant", name: "responder", automationId: automation.id, credentialSecretId: secret.id });
    const body = { eventId: "event-00000001", eventType: "issue.created", data: { title: "Fix race", body: "Untrusted issue text" } };
    const raw = Buffer.from(JSON.stringify(body)), timestamp = Date.now() / 1000;
    const headers = signed("responder-super-secret", raw, timestamp, "nonce-event-0001");
    expect(await engine.automationResponders.acceptEvent(responder.id, raw, headers, body)).toMatchObject({ accepted: true, duplicate: false, status: "processing" });
    await waitFor(async () => ((await engine.automationResponders.list("tenant"))[0]?.eventCounts.delivered ?? 0) === 1);
    const runs = await engine.automations.listRuns(automation.id);
    expect(runs).toHaveLength(1); expect(runs[0]!.status).toBe("completed");
    expect(await engine.automationResponders.acceptEvent(responder.id, raw, headers, body)).toMatchObject({ duplicate: true, status: "delivered" });
    await new Promise((resolve) => setTimeout(resolve, 30)); expect(await engine.automations.listRuns(automation.id)).toHaveLength(1);
    await engine.shutdown();
  });

  it("fails closed on tampering, stale timestamps, wrong event type and old secrets after rotation", async () => {
    const { engine, automation, secret } = await setup();
    const service = engine.automationResponders;
    const responder = await service.add({ tenantId: "tenant", name: "responder", automationId: automation.id, credentialSecretId: secret.id });
    const body = { eventId: "event-00000002", eventType: "issue.created", data: {} }, raw = Buffer.from(JSON.stringify(body));
    await expect(service.acceptEvent(responder.id, Buffer.from(JSON.stringify({ ...body, data: { changed: true } })), signed("responder-super-secret", raw, Date.now() / 1000, "nonce-tamper-1"), { ...body, data: { changed: true } })).rejects.toThrow("signature verification failed");
    await expect(service.acceptEvent(responder.id, raw, signed("responder-super-secret", raw, Date.now() / 1000 - 1000, "nonce-stale-1"), body)).rejects.toThrow("stale");
    const wrong = { ...body, eventType: "push.created", eventId: "event-00000003" }, wrongRaw = Buffer.from(JSON.stringify(wrong));
    await expect(service.acceptEvent(responder.id, wrongRaw, signed("responder-super-secret", wrongRaw, Date.now() / 1000, "nonce-wrong-1"), wrong)).rejects.toThrow("not allowed");
    const replacement = await engine.credentials.put({ tenantId: "tenant", name: "RESPONDER_SECRET_NEW", value: "replacement-secret" });
    await service.rotateCredential(responder.id, "tenant", replacement.id);
    await expect(service.acceptEvent(responder.id, raw, signed("responder-super-secret", raw, Date.now() / 1000, "nonce-old-secret"), body)).rejects.toThrow("signature verification failed");
    await service.acceptEvent(responder.id, raw, signed("replacement-secret", raw, Date.now() / 1000, "nonce-new-secret"), body);
    await engine.shutdown();
  });

  it("marks unknown dispatch outcomes uncertain and never replays duplicate event IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-responder-uncertain-"));
    const credentials = new CredentialBroker(root, "key");
    const secret = await credentials.put({ tenantId: "tenant", name: "RESPONDER_KEY", value: "shared-secret" });
    const dispatch = vi.fn(async () => { throw new Error("transport vanished"); });
    const automations = { get: async () => ({ id: "automation", tenantId: "tenant", trigger: { kind: "webhook", eventType: "issue.created" } }), dispatch } as unknown as AutomationService;
    const service = new AutomationResponderService({ rootPath: root, credentials, automations });
    const responder = await service.add({ tenantId: "tenant", name: "responder", automationId: "automation", credentialSecretId: secret.id });
    const body = { eventId: "event-uncertain-1", eventType: "issue.created", data: { secretPayload: "never persist me" } }, raw = Buffer.from(JSON.stringify(body));
    await service.acceptEvent(responder.id, raw, signed("shared-secret", raw, Date.now() / 1000, "nonce-uncertain-1"), body);
    await waitFor(async () => ((await service.list("tenant"))[0]?.eventCounts.uncertain ?? 0) === 1);
    const duplicate = await service.acceptEvent(responder.id, raw, signed("shared-secret", raw, Date.now() / 1000, "nonce-uncertain-2"), body);
    expect(duplicate).toMatchObject({ duplicate: true, status: "uncertain" }); expect(dispatch).toHaveBeenCalledTimes(1);
    const disk = await readFile(join(root, "automation", "responders.json"), "utf8"); expect(disk).not.toContain("never persist me"); expect(disk).not.toContain("shared-secret");
    await service.close();
  });
});
