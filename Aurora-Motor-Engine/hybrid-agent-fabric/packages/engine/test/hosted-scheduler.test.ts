import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedSchedulerRelay } from "../src/scheduler/hosted-relay.js";
import type { ScheduledJob, DurableScheduler } from "../src/scheduler/scheduler.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("hosted scale-to-zero scheduler relay", () => {
  it("arms without prompt content, verifies fire JWT and claims at most once", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-hosted-cron-"));
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: "k1", alg: "RS256", use: "sig" });
    const requests: Array<{ url: string; body?: any }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith("/jwks")) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } });
      requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const relay = new HostedSchedulerRelay(root, {
      portalUrl: "https://portal.example.test",
      accessToken: "portal-token",
      callbackUrl: "https://agent.example.test/v1/cron/fire",
      expectedAudience: "agent:test",
      issuer: "https://portal.example.test",
      jwksUrl: "https://portal.example.test/jwks",
    });
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const job: ScheduledJob = {
      id: "job-1", tenantId: "tenant", sessionId: "session", prompt: "secret prompt must not leave agent",
      schedule: { kind: "once", at: fireAt }, status: "active", nextRunAt: fireAt, runCount: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await relay.arm(job);
    expect(requests[0]!.body).toEqual({
      job_id: "job-1", fire_at: fireAt,
      agent_callback_url: "https://agent.example.test/v1/cron/fire",
      dedup_key: `job-1:${fireAt}`,
    });
    expect(JSON.stringify(requests[0]!.body)).not.toContain("secret prompt");

    const token = await new SignJWT({ purpose: "cron_fire", job_id: "job-1", fire_at: fireAt })
      .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://portal.example.test")
      .setAudience("agent:test").setIssuedAt().setExpirationTime("2m").sign(privateKey);
    expect(await relay.verifyFire(token)).toEqual({ jobId: "job-1", fireAt });
    let fires = 0;
    const scheduler = { fireExternal: async () => { fires++; return { status: "completed" as const }; } } as unknown as DurableScheduler;
    expect(await relay.handleFire(token, { job_id: "job-1", fire_at: fireAt }, scheduler)).toEqual({ accepted: true, status: "completed" });
    expect(await relay.handleFire(token, { job_id: "job-1", fire_at: fireAt }, scheduler)).toEqual({ accepted: true, status: "duplicate" });
    expect(fires).toBe(1);
  });

  it("rejects wrong purpose, audience and body/JWT mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-hosted-cron-"));
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: "k", alg: "RS256" });
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const relay = new HostedSchedulerRelay(root, {
      portalUrl: "https://portal.example.test", accessToken: "x", callbackUrl: "https://agent.test/fire",
      expectedAudience: "agent:good", issuer: "https://portal.example.test", jwksUrl: "https://portal.example.test/jwks",
    });
    const token = await new SignJWT({ purpose: "other", job_id: "job", fire_at: new Date().toISOString() })
      .setProtectedHeader({ alg: "RS256", kid: "k" }).setIssuer("https://portal.example.test")
      .setAudience("agent:good").setExpirationTime("2m").sign(privateKey);
    await expect(relay.verifyFire(token)).rejects.toThrow("purpose");
  });
});
