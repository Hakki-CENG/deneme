import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentityService, roleAllows } from "../src/auth/identity-service.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("HttpOnly-session identity core", () => {
  it("persists encrypted sessions without plaintext identity data", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-auth-"));
    const path = join(root, "sessions.enc");
    const service = new IdentityService({ sessionFile: path, sessionSecret: "stable-secret", apiToken: "admin-token", defaultTenant: "local" });
    const identity = service.apiTokenIdentity("admin-token")!;
    const session = await service.createSession({ ...identity, email: "admin@example.test" });
    expect((await service.getSession(session.id))?.csrfToken).toBe(session.csrfToken);
    const disk = await readFile(path, "utf8");
    expect(disk).not.toContain("admin@example.test");
    expect(disk).not.toContain(session.csrfToken);

    const restarted = new IdentityService({ sessionFile: path, sessionSecret: "stable-secret", apiToken: "admin-token" });
    expect((await restarted.getSession(session.id))?.identity.email).toBe("admin@example.test");
    await restarted.logout(session.id);
    expect(await restarted.getSession(session.id)).toBeUndefined();
  });

  it("maps OIDC tenant and role claims without granting undeclared tenants", () => {
    const service = new IdentityService({
      sessionFile: "/tmp/unused.enc", sessionSecret: "secret", defaultTenant: "local",
      oidc: { issuer: "https://id.example.test", clientId: "haf", redirectUri: "https://haf.example.test/auth/oidc/callback" },
    });
    const identity = service.identityFromClaims({
      sub: "user-1", email: "user@example.test",
      haf_tenants: { engineering: "operator", finance: "viewer", invalid: "owner" },
      roles: ["other-role"],
    });
    expect(identity.tenants).toEqual({ engineering: "operator", finance: "viewer" });
    expect(service.roleFor(identity, "invalid")).toBeUndefined();
    expect(roleAllows(service.roleFor(identity, "engineering"), "viewer")).toBe(true);
    expect(roleAllows(service.roleFor(identity, "finance"), "operator")).toBe(false);
  });

  it("builds OIDC authorization requests with state, nonce and PKCE", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      issuer: "https://id.example.test",
      authorization_endpoint: "https://id.example.test/authorize",
      token_endpoint: "https://id.example.test/token",
      jwks_uri: "https://id.example.test/jwks",
    }), { status: 200 })) as typeof fetch;
    const service = new IdentityService({
      sessionFile: "/tmp/unused.enc", sessionSecret: "secret",
      oidc: { issuer: "https://id.example.test", clientId: "haf", redirectUri: "https://haf.example.test/auth/oidc/callback" },
    });
    const start = await service.oidcStart("/settings");
    const url = new URL(start.url);
    expect(url.searchParams.get("state")).toBe(start.state);
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });
});
