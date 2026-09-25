import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexOAuthManager, CodexOAuthError } from "../src/models/codex-oauth-manager.js";
import { CredentialBroker } from "../src/security/credential-broker.js";

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("broker-backed Codex subscription OAuth", () => {
  it("resumes a device flow after manager replacement and keeps tokens encrypted", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-codex-oauth-"));
    const broker1 = new CredentialBroker(root, "stable-codex-key");
    const accountId = "acct-sensitive-123";
    const access = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
    const requests: Array<{ url: string; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, body: String(init?.body ?? "") });
      if (url.endsWith("/api/accounts/deviceauth/usercode")) return Response.json({ user_code: "ABCD-EFGH", device_auth_id: "device-auth-secret", interval: 3, expires_in: 900 });
      if (url.endsWith("/api/accounts/deviceauth/token")) return Response.json({ authorization_code: "authorization-secret", code_verifier: "verifier-secret" });
      if (url.endsWith("/oauth/token")) return Response.json({ access_token: access, refresh_token: "refresh-secret", expires_in: 3600 });
      if (url.includes("/backend-api/codex/models?")) return Response.json({ models: [
        { slug: "model-hidden", visibility: "hidden", priority: 0 },
        { slug: "model-b", priority: 2, supported_in_api: false },
        { slug: "model-a", priority: 1 },
      ] });
      return new Response("not found", { status: 404 });
    };
    const first = new CodexOAuthManager({ broker: broker1, fetch: fetchImpl });
    const flow = await first.startDeviceFlow("tenant");
    expect(flow.userCode).toBe("ABCD-EFGH");
    expect(flow.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(flow.restartResumable).toBe(true);

    const broker2 = new CredentialBroker(root, "stable-codex-key");
    const replacement = new CodexOAuthManager({ broker: broker2, fetch: fetchImpl });
    expect((await replacement.pollDeviceFlow("tenant", flow.flowId)).status).toBe("authenticated");
    const authorization = await replacement.getAuthorization("tenant");
    expect(authorization.accessToken).toBe(access);
    expect(authorization.accountId).toBe(accountId);
    const status = await replacement.status("tenant");
    expect(status).toMatchObject({ authenticated: true, pending: false, persistentAcrossRestart: true });
    expect(JSON.stringify(status)).not.toContain(accountId);
    expect(await replacement.listModels("tenant")).toEqual(["model-a", "model-b"]);
    expect(JSON.stringify(await broker2.list("tenant"))).not.toContain("refresh-secret");
    const encrypted = await readFile(join(root, "credentials", "secrets.json"), "utf8");
    for (const raw of ["device-auth-secret", "authorization-secret", "verifier-secret", "refresh-secret", access]) expect(encrypted).not.toContain(raw);
    expect(requests.every((item) => item.url.startsWith("https://auth.openai.com/") || item.url.startsWith("https://chatgpt.com/backend-api/codex/"))).toBe(true);
    await replacement.logout("tenant");
    expect((await replacement.status("tenant")).authenticated).toBe(false);
  });

  it("rotates expiring refresh tokens once under concurrent access", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-codex-refresh-"));
    const broker = new CredentialBroker(root, "stable-key");
    const oldAccess = jwt({ exp: Math.floor(Date.now() / 1000) + 30 });
    const newAccess = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "account" } });
    let refreshes = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) return Response.json({ user_code: "CODE", device_auth_id: "device", interval: 3 });
      if (url.endsWith("/api/accounts/deviceauth/token")) return Response.json({ authorization_code: "code", code_verifier: "verifier" });
      if (url.endsWith("/oauth/token")) {
        const form = new URLSearchParams(String(init?.body));
        if (form.get("grant_type") === "authorization_code") return Response.json({ access_token: oldAccess, refresh_token: "refresh-old" });
        refreshes++;
        expect(form.get("refresh_token")).toBe("refresh-old");
        return Response.json({ access_token: newAccess, refresh_token: "refresh-rotated" });
      }
      return new Response(null, { status: 404 });
    };
    const manager = new CodexOAuthManager({ broker, fetch: fetchImpl });
    const flow = await manager.startDeviceFlow("tenant");
    await manager.pollDeviceFlow("tenant", flow.flowId);
    const values = await Promise.all([manager.getAuthorization("tenant"), manager.getAuthorization("tenant")]);
    expect(values.every((value) => value.accessToken === newAccess)).toBe(true);
    expect(refreshes).toBe(1);
  });

  it("fails closed on redirects and preserves credentials during rate-limit cooldown", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-codex-guard-"));
    const broker = new CredentialBroker(root, "key");
    const redirecting = new CodexOAuthManager({ broker, fetch: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }) });
    await expect(redirecting.startDeviceFlow("tenant")).rejects.toMatchObject({ code: "redirect_forbidden" });

    const manager = new CodexOAuthManager({ broker, fetch: async () => new Response(null, { status: 429 }) });
    await expect(manager.startDeviceFlow("other")).rejects.toMatchObject({ code: "rate_limited", retryable: true });
    await expect(manager.pollDeviceFlow("tenant", "missing")).rejects.toBeInstanceOf(CodexOAuthError);
  });
});
