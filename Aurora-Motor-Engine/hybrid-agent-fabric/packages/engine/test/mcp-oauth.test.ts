import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrokerBackedMcpOAuthProvider } from "../src/mcp/mcp-oauth-provider.js";
import { CredentialBroker } from "../src/security/credential-broker.js";

describe("broker-backed MCP OAuth/PKCE state", () => {
  it("encrypts tokens, verifier, client registration and discovery state without list disclosure", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-mcp-oauth-"));
    const broker = new CredentialBroker(root, "persistent-test-key");
    const options = {
      tenantId: "tenant",
      serverUrl: "https://mcp.example.test/mcp",
      redirectUrl: "https://haf.example.test/auth/mcp/callback",
      clientId: "client-id",
      clientSecret: "client-secret",
      scopes: ["mcp:tools"],
      authorizationServerOrigins: ["https://auth.example.test"],
      broker,
    };
    const provider = new BrokerBackedMcpOAuthProvider(options);
    const state = await provider.state();
    await provider.saveCodeVerifier("verifier-value");
    await provider.saveTokens({ access_token: "access-secret", token_type: "Bearer", refresh_token: "refresh-secret" });
    await provider.saveClientInformation({ client_id: "registered-client", client_secret: "registered-secret" });
    await expect(provider.redirectToAuthorization(new URL(`https://untrusted.example.test/authorize?state=${state}`))).rejects.toThrow("not explicitly trusted");
    await provider.redirectToAuthorization(new URL(`https://auth.example.test/authorize?state=${state}`));
    expect(provider.authorizationUrl?.origin).toBe("https://auth.example.test");
    expect(await provider.codeVerifier()).toBe("verifier-value");
    expect((await provider.tokens())?.access_token).toBe("access-secret");
    expect(JSON.stringify(await broker.list("tenant"))).not.toContain("access-secret");
    expect(JSON.stringify(await broker.list("tenant"))).not.toContain("client-secret");

    const reloaded = new BrokerBackedMcpOAuthProvider(options);
    expect((await reloaded.tokens())?.refresh_token).toBe("refresh-secret");
    expect((await reloaded.clientInformation())?.client_id).toBe("registered-client");
    await expect(reloaded.validateState("wrong-state-value-that-is-long-enough")).rejects.toThrow("state validation");
    await reloaded.validateState(state);
    await reloaded.invalidateCredentials("tokens");
    expect(await reloaded.tokens()).toBeUndefined();
  });

  it("requires secure callbacks except explicit loopback development", async () => {
    const broker = new CredentialBroker(await mkdtemp(join(tmpdir(), "haf-mcp-oauth-url-")), "key");
    expect(() => new BrokerBackedMcpOAuthProvider({
      tenantId: "tenant", serverUrl: "https://mcp.example.test/mcp", redirectUrl: "http://public.example.test/callback", broker,
    })).toThrow("must use HTTPS");
    expect(() => new BrokerBackedMcpOAuthProvider({
      tenantId: "tenant", serverUrl: "https://mcp.example.test/mcp", redirectUrl: "http://127.0.0.1:8787/auth/mcp/callback", broker,
    })).not.toThrow();
  });
});
