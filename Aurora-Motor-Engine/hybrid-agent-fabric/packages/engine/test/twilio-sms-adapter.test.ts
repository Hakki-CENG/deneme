import { createHmac } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChannelGateway } from "../src/channels/channel-gateway.js";
import { TwilioSmsAdapter, verifyTwilioSignature } from "../src/channels/twilio-sms-adapter.js";

const ACCOUNT = `AC${"a".repeat(32)}`;
const MESSAGE = `SM${"b".repeat(32)}`;
const TOKEN = "twilio-auth-super-secret";
const WEBHOOK = "https://haf.example.com/v1/platforms/twilio/webhook";
const FROM = "+14155550100";
const TO = "+14155550199";

function signature(params: Record<string, unknown>, token = TOKEN): string {
  let value = WEBHOOK;
  for (const key of Object.keys(params).sort()) {
    const raw = params[key];
    for (const item of Array.isArray(raw) ? raw : [raw]) value += key + String(item);
  }
  return createHmac("sha1", token).update(value).digest("base64");
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true");
}

describe("native Twilio SMS channel", () => {
  it("sends form-encoded SMS with exact origin, Basic auth and recipient confinement", async () => {
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    const root = await mkdtemp(join(tmpdir(), "haf-twilio-send-"));
    const adapter = new TwilioSmsAdapter({
      stateRoot: root, gateway: { ingest: vi.fn() } as unknown as ChannelGateway, tenantId: "tenant",
      accountSid: ACCOUNT, authToken: TOKEN, fromNumber: TO, allowedNumbers: [FROM],
      fetch: async (input, init) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
        return Response.json({ sid: MESSAGE, status: "queued" }, { status: 201 });
      },
      urlGuard: async (url) => new URL(url),
    });
    adapter.start();
    const result = await adapter.send({ destination: FROM, text: "Hello from HAF" });
    expect(result).toMatchObject({ platform: "twilio-sms", destination: FROM, messageId: MESSAGE, rawStatus: 201 });
    expect(calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Messages.json`);
    expect(calls[0]!.headers.get("authorization")).toBe(`Basic ${Buffer.from(`${ACCOUNT}:${TOKEN}`).toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({ To: FROM, From: TO, Body: "Hello from HAF" });
    expect(calls[0]!.body).not.toContain(TOKEN);
    await expect(adapter.send({ destination: "+14155550999", text: "blocked" })).rejects.toThrow("not allowlisted");
    await expect(adapter.send({ destination: FROM, text: "x", media: { fileName: "a.png", mimeType: "image/png", data: new Uint8Array([1]) } })).rejects.toThrow("does not accept");
    expect(JSON.stringify(adapter.status())).not.toContain(TOKEN);
    await adapter.close();
  });

  it("validates signed ingress before asynchronous routing and deduplicates replies durably", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-twilio-inbound-"));
    const params = { AccountSid: ACCOUNT, MessageSid: MESSAGE, From: FROM, To: TO, Body: "Review the deployment", NumMedia: "0" };
    const ingest = vi.fn(async () => ({ sessionId: "session", commandId: "command", text: "Deployment reviewed", status: "completed" as const }));
    let sends = 0;
    const adapter = new TwilioSmsAdapter({
      stateRoot: root, gateway: { ingest } as unknown as ChannelGateway, tenantId: "tenant",
      accountSid: ACCOUNT, authToken: TOKEN, fromNumber: TO, allowedNumbers: [FROM], webhookUrl: WEBHOOK,
      fetch: async () => { sends++; return Response.json({ sid: `SM${"c".repeat(32)}` }, { status: 201 }); },
      urlGuard: async (url) => new URL(url),
    });
    adapter.start();
    expect(await adapter.acceptInbound(params, signature(params))).toMatchObject({ accepted: true, duplicate: false, status: "processing" });
    await waitFor(() => adapter.status().delivered === 1);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![0]).toMatchObject({
      tenantId: "tenant", platform: "twilio-sms", chatType: "dm", userId: FROM,
      text: "Review the deployment", messageId: MESSAGE, authorized: true,
    });
    expect(sends).toBe(1);
    expect(await adapter.acceptInbound(params, signature(params))).toMatchObject({ accepted: true, duplicate: true, status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ingest).toHaveBeenCalledTimes(1); expect(sends).toBe(1);
    const state = await readFile(join(root, "channels", "twilio-sms-state.json"), "utf8");
    for (const forbidden of [MESSAGE, FROM, TO, "Review the deployment", TOKEN, "Deployment reviewed"]) expect(state).not.toContain(forbidden);
    await expect(adapter.acceptInbound({ ...params, Body: "tampered" }, signature(params))).rejects.toThrow("signature verification failed");
    await adapter.close();
  });

  it("marks ambiguous replies uncertain and does not replay them after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-twilio-uncertain-"));
    const params = { AccountSid: ACCOUNT, MessageSid: MESSAGE, From: FROM, To: TO, Body: "hello", NumMedia: "0" };
    const ingest = vi.fn(async () => ({ sessionId: "session", commandId: "command", text: "reply", status: "completed" as const }));
    let attempts = 0;
    const create = () => new TwilioSmsAdapter({
      stateRoot: root, gateway: { ingest } as unknown as ChannelGateway, tenantId: "tenant",
      accountSid: ACCOUNT, authToken: TOKEN, fromNumber: TO, allowedNumbers: [FROM], webhookUrl: WEBHOOK,
      fetch: async () => { attempts++; throw new Error("socket closed after POST"); }, urlGuard: async (url) => new URL(url),
    });
    const first = create(); first.start(); await first.acceptInbound(params, signature(params));
    await waitFor(() => first.status().uncertain === 1);
    expect(attempts).toBe(1); await first.close();
    const restarted = create(); restarted.start();
    await waitFor(() => restarted.status().uncertain === 1);
    expect(await restarted.acceptInbound(params, signature(params))).toMatchObject({ duplicate: true, status: "uncertain" });
    expect(attempts).toBe(1); expect(ingest).toHaveBeenCalledTimes(1);
    await restarted.close();
  });

  it("uses constant-time form signature verification and rejects malformed signed values", () => {
    const params = { AccountSid: ACCOUNT, Body: "APPROVE 8142", From: FROM, MessageSid: MESSAGE, To: TO };
    const signed = signature(params);
    expect(verifyTwilioSignature({ url: WEBHOOK, params, signature: signed, authToken: TOKEN })).toBe(true);
    expect(verifyTwilioSignature({ url: WEBHOOK, params: { ...params, Body: "APPROVE 9999" }, signature: signed, authToken: TOKEN })).toBe(false);
    expect(verifyTwilioSignature({ url: WEBHOOK, params, signature: undefined, authToken: TOKEN })).toBe(false);
    expect(verifyTwilioSignature({ url: WEBHOOK, params: { Bad: { nested: true } }, signature: signed, authToken: TOKEN })).toBe(false);
  });
});
