import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { ModelOAuthManager } from "../src/models/model-oauth-manager.js";
import { OAuthBearerModelProvider } from "../src/models/oauth-bearer-model-provider.js";
import { ModelProviderError } from "../src/models/model-provider-error.js";
import { CredentialBroker } from "../src/security/credential-broker.js";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "../src/types.js";

const issuer = "https://auth.example.test";
const resource = "https://api.example.test";
const redirect = "https://haf.example.test/auth/model-oauth/callback";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "haf-model-oauth-"));
  const credentials = new CredentialBroker(root, "stable-key");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey); jwk.kid = "key-1"; jwk.alg = "RS256";
  let now = Date.parse("2026-08-19T12:00:00Z"), nonce = "", refreshes = 0, tokenCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({
      issuer, authorization_endpoint: `${issuer}/oauth2/authorize`, token_endpoint: `${issuer}/oauth2/token`, jwks_uri: `${issuer}/oauth2/jwks`,
    });
    if (url === `${issuer}/oauth2/jwks`) return Response.json({ keys: [jwk] });
    if (url === `${issuer}/oauth2/token`) {
      tokenCalls++;
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "refresh_token") {
        refreshes++;
        return Response.json({ access_token: `access-refreshed-${refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 3600, token_type: "Bearer" });
      }
      const idToken = await new SignJWT({ nonce, email: "user@example.test" })
        .setProtectedHeader({ alg: "RS256", kid: "key-1" }).setIssuer(issuer).setAudience("client-123").setSubject("subject-1")
        .setIssuedAt(Math.floor(now / 1000)).setExpirationTime(Math.floor(now / 1000) + 3600).sign(privateKey);
      return Response.json({ access_token: "access-initial", refresh_token: "refresh-initial", expires_in: 300, token_type: "Bearer", id_token: idToken });
    }
    return Response.json({ error: "missing" }, { status: 404 });
  };
  const options = { rootPath: root, credentials, redirectUri: redirect, fetch: fetchImpl, urlGuard: async (value: string) => new URL(value), now: () => now };
  return { root, credentials, options, setNonce(value: string) { nonce = value; }, advance(ms: number) { now += ms; }, stats: () => ({ refreshes, tokenCalls }) };
}

describe("generic model OIDC OAuth sources", () => {
  it("persists PKCE state/tokens only through Credential Broker and refreshes with rotation", async () => {
    const f = await fixture();
    const manager = new ModelOAuthManager(f.options);
    const source = await manager.register({
      tenantId: "tenant", name: "Provider OAuth", issuer, clientId: "client-123",
      scopes: ["openid", "profile", "offline_access"], resourceOrigins: [resource],
      authorizeParameters: { plan: "generic" },
    });
    expect(source).toMatchObject({ authenticated: false, clientSecretConfigured: true, resourceOrigins: [resource] });
    const started = await manager.start(source.id, "tenant");
    const authorize = new URL(started.authorizationUrl);
    expect(authorize.origin).toBe(issuer);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")).toContain("offline_access");
    expect(authorize.searchParams.get("plan")).toBe("generic");
    f.setNonce(authorize.searchParams.get("nonce")!);
    const state = authorize.searchParams.get("state")!;

    const restarted = new ModelOAuthManager(f.options);
    const connected = await restarted.finish({ state, code: "authorization-code" });
    expect(connected).toMatchObject({ authenticated: true, pending: false, subjectProjection: expect.stringMatching(/^[a-f0-9]{24}$/) });
    expect((await restarted.authorization(source.id, "tenant", resource)).accessToken).toBe("access-initial");
    await expect(restarted.authorization(source.id, "tenant", "https://evil.example")).rejects.toThrow("audience origin");
    f.advance(4 * 60_000);
    expect((await restarted.authorization(source.id, "tenant", resource)).accessToken).toBe("access-refreshed-1");
    expect(f.stats()).toMatchObject({ refreshes: 1, tokenCalls: 2 });

    const registry = await readFile(join(f.root, "models", "oauth-sources.json"), "utf8");
    for (const forbidden of [state, "authorization-code", "access-initial", "refresh-initial", "subject-1", "user@example.test"]) expect(registry).not.toContain(forbidden);
    const brokerDisk = await readFile(join(f.root, "credentials", "secrets.json"), "utf8");
    for (const forbidden of ["access-initial", "refresh-initial", state]) expect(brokerDisk).not.toContain(forbidden);
  });

  it("rejects poisoned discovery endpoints, redirects and invalid public-client configuration", async () => {
    const f = await fixture();
    const poisoned = new ModelOAuthManager({ ...f.options, fetch: async (input) => String(input).includes("openid-configuration")
      ? Response.json({ issuer, authorization_endpoint: "https://evil.example/authorize", token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` })
      : Response.json({}) });
    const source = await poisoned.register({ tenantId: "tenant", name: "poisoned", issuer, clientId: "client", scopes: ["openid"], resourceOrigins: [resource] });
    await expect(poisoned.start(source.id, "tenant")).rejects.toThrow("allowlist");
    await expect(poisoned.register({ tenantId: "tenant", name: "bad-secret", issuer, clientId: "client", clientAuthMethod: "client_secret_basic", scopes: ["openid"], resourceOrigins: [resource] })).rejects.toThrow("requires a Credential Broker secret");

    const redirecting = new ModelOAuthManager({ ...f.options, fetch: async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }) });
    const redirectSource = await redirecting.register({ tenantId: "tenant", name: "redirect", issuer, clientId: "client", scopes: ["openid"], resourceOrigins: [resource] });
    await expect(redirecting.start(redirectSource.id, "tenant")).rejects.toThrow("redirects are forbidden");
  });

  it("uses a confidential client secret only at the exact token origin", async () => {
    const f = await fixture();
    const secret = await f.credentials.put({ tenantId: "tenant", name: "OIDC_CLIENT_SECRET", value: "client-super-secret" });
    let authorization = "";
    const originalFetch = f.options.fetch;
    const manager = new ModelOAuthManager({ ...f.options, fetch: async (input, init) => {
      if (String(input).endsWith("/oauth2/token")) authorization = new Headers(init?.headers).get("authorization") ?? "";
      return await originalFetch(input, init);
    } });
    const source = await manager.register({
      tenantId: "tenant", name: "confidential", issuer, clientId: "client-123", clientSecretId: secret.id,
      clientAuthMethod: "client_secret_basic", scopes: ["openid", "offline_access"], resourceOrigins: [resource],
    });
    const started = await manager.start(source.id, "tenant");
    const url = new URL(started.authorizationUrl); f.setNonce(url.searchParams.get("nonce")!);
    await manager.finish({ state: url.searchParams.get("state")!, code: "code" });
    expect(authorization).toBe(`Basic ${Buffer.from("client-123:client-super-secret").toString("base64")}`);
    expect(JSON.stringify(await manager.list("tenant"))).not.toContain("client-super-secret");
  });

  it("refreshes once after a pre-output 401 but never after partial model output", async () => {
    const oauth = {
      authorization: vi.fn(async () => ({ accessToken: "old", expiresAt: Date.now() + 10000, resourceOrigins: [resource] })),
      forceRefresh: vi.fn(async () => ({ accessToken: "new", expiresAt: Date.now() + 10000, resourceOrigins: [resource] })),
    } as any;
    const request = { tenantId: "tenant", sessionId: "s", turnId: "t", systemPrompt: "x", messages: [], tools: [] } as unknown as ModelRequest;
    const provider = new OAuthBearerModelProvider({
      id: "oauth-route", tenantId: "tenant", sourceId: "source", resourceOrigin: resource, oauth,
      build: (token): ModelProvider => ({ id: "inner", async *stream() {
        if (token === "old") throw new ModelProviderError("rejected", { providerId: "inner", status: 401, code: "credential_rejected" });
        yield { type: "text_delta", delta: "ok" }; yield { type: "done", stopReason: "end_turn" };
      } }),
    });
    const events: ModelStreamEvent[] = []; for await (const event of provider.stream(request)) events.push(event);
    expect(events).toContainEqual({ type: "text_delta", delta: "ok" }); expect(oauth.forceRefresh).toHaveBeenCalledTimes(1);

    oauth.forceRefresh.mockClear();
    const partial = new OAuthBearerModelProvider({
      id: "partial", tenantId: "tenant", sourceId: "source", resourceOrigin: resource, oauth,
      build: (): ModelProvider => ({ id: "inner", async *stream() { yield { type: "text_delta", delta: "partial" }; throw new ModelProviderError("rejected", { providerId: "inner", status: 401 }); } }),
    });
    const iterator = partial.stream(request)[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { type: "text_delta", delta: "partial" } });
    await expect(iterator.next()).rejects.toThrow("rejected"); expect(oauth.forceRefresh).not.toHaveBeenCalled();
  });
});
