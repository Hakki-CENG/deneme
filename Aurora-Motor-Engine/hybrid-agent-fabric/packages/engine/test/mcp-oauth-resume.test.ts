import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { CapabilityBroker } from "../src/capabilities/capability-broker.js";
import { BrokerBackedMcpOAuthProvider } from "../src/mcp/mcp-oauth-provider.js";
import { McpOAuthPendingStore } from "../src/mcp/mcp-oauth-pending-store.js";
import { McpManager, McpOAuthPendingNotFoundError } from "../src/mcp/mcp-manager.js";
import { EffectJournal } from "../src/persistence/effect-journal.js";
import { ApprovalService } from "../src/policy/approval-service.js";
import { DefaultPolicyEngine } from "../src/policy/policy-engine.js";
import { CredentialBroker } from "../src/security/credential-broker.js";

async function capabilityBroker(root: string): Promise<CapabilityBroker> {
  return new CapabilityBroker(new DefaultPolicyEngine(), new ApprovalService(), new EffectJournal(root));
}

describe("restart-resumable MCP OAuth coordination", () => {
  it("rebuilds the encrypted pending transport after process replacement and completes PKCE", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-mcp-oauth-resume-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const app = createMcpExpressApp();
    let origin = "";
    const tokenBodies: string[] = [];
    const staticClientSecret = "oauth-client-secret-that-must-stay-encrypted";

    app.get("/.well-known/oauth-protected-resource/mcp", (_request, response) => {
      response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["mcp:tools"] });
    });
    app.get("/.well-known/oauth-authorization-server", (_request, response) => {
      response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    });
    app.post("/token", async (request, response) => {
      let encoded = typeof request.body === "string" ? request.body : request.body ? JSON.stringify(request.body) : "";
      if (!encoded) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        encoded = Buffer.concat(chunks).toString("utf8");
      }
      tokenBodies.push(encoded);
      response.json({ access_token: "restart-access-token", refresh_token: "restart-refresh-token", token_type: "Bearer", expires_in: 3600 });
    });
    app.get("/mcp", (_request, response) => response.sendStatus(405));
    app.post("/mcp", async (request, response) => {
      if (request.headers.authorization !== "Bearer restart-access-token") {
        response
          .status(401)
          .set("WWW-Authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`)
          .json({ error: "unauthorized" });
        return;
      }
      const server = new McpServer({ name: "oauth-resume-test", version: "1.0.0" });
      server.tool("echo", "OAuth protected echo", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
      response.on("close", () => { void transport.close(); void server.close(); });
    });

    const listener = await new Promise<ReturnType<typeof app.listen>>((resolvePromise) => {
      const value = app.listen(0, "127.0.0.1", () => resolvePromise(value));
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("OAuth MCP test server did not bind.");
    origin = `http://127.0.0.1:${address.port}`;
    const serverUrl = `${origin}/mcp`;
    const broker1 = new CredentialBroker(root, "restart-stable-master-key");
    const manager1 = new McpManager(await capabilityBroker(join(root, "effects-1")), {
      credentialBroker: broker1,
      urlGuard: async (value) => new URL(value),
    });
    let manager2: McpManager | undefined;
    try {
      const provider = new BrokerBackedMcpOAuthProvider({
        tenantId: "tenant-a",
        serverUrl,
        redirectUrl: "http://127.0.0.1:8787/auth/mcp/callback",
        clientId: "restart-client-id",
        clientSecret: staticClientSecret,
        scopes: ["mcp:tools"],
        broker: broker1,
      });
      const start = await manager1.connectHttp({
        name: "oauth-echo",
        tenantId: "tenant-a",
        url: serverUrl,
        allowPlainHttp: true,
        oauthProvider: provider,
        defaultRisk: "pure",
        headers: { "x-server-side-header": "encrypted-header-value" },
      });
      expect(start.authorizationRequired).toBe(true);
      expect(start.restartResumable).toBe(true);
      expect(start.authorizationUrl).toContain("code_challenge=");
      expect(start.authorizationUrl).toContain(`state=${encodeURIComponent(provider.oauthState)}`);

      const encryptedAtRest = await readFile(join(root, "credentials", "secrets.json"), "utf8");
      expect(encryptedAtRest).not.toContain(provider.oauthState);
      expect(encryptedAtRest).not.toContain(staticClientSecret);
      expect(encryptedAtRest).not.toContain("encrypted-header-value");
      expect(JSON.stringify(await broker1.list("tenant-a"))).not.toContain(staticClientSecret);

      // Simulate replacement of the control process: all live SDK objects are gone,
      // but closeAll intentionally leaves the encrypted browser authorization pending.
      await manager1.closeAll();
      const broker2 = new CredentialBroker(root, "restart-stable-master-key");
      const capability2 = await capabilityBroker(join(root, "effects-2"));
      manager2 = new McpManager(capability2, {
        credentialBroker: broker2,
        urlGuard: async (value) => new URL(value),
      });
      const completions = await Promise.allSettled([
        manager2.finishHttpOAuthByState({ state: provider.oauthState, code: "authorization-code-after-restart" }),
        manager2.finishHttpOAuthByState({ state: provider.oauthState, code: "authorization-code-after-restart" }),
      ]);
      const fulfilled = completions.filter((item): item is PromiseFulfilledResult<{ name: string; capabilityIds: string[] }> => item.status === "fulfilled");
      const rejected = completions.filter((item) => item.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0]!.value).toEqual({ name: "oauth-echo", capabilityIds: ["mcp.oauth-echo.echo"] });
      expect(tokenBodies).toHaveLength(1);
      expect(tokenBodies.join(" ")).toContain("authorization-code-after-restart");
      expect(tokenBodies.join(" ")).toContain("restart-client-id");
      expect(tokenBodies.join(" ")).toContain(encodeURIComponent(staticClientSecret));

      const result = await capability2.execute("mcp.oauth-echo.echo", { text: "resumed" }, {
        tenantId: "tenant-a",
        sessionId: randomUUID(), familyId: randomUUID(), turnId: randomUUID(), toolCallId: randomUUID(),
        source: "api", workspacePath: workspace, idempotencyKey: randomUUID(),
      });
      expect(JSON.stringify(result)).toContain("resumed");
      await expect(manager2.finishHttpOAuthByState({ state: provider.oauthState, code: "replay" }))
        .rejects.toBeInstanceOf(McpOAuthPendingNotFoundError);
    } finally {
      await manager1.closeAll();
      await manager2?.closeAll();
      await new Promise<void>((resolvePromise, reject) => listener.close((error) => error ? reject(error) : resolvePromise()));
    }
  }, 20_000);

  it("removes encrypted pending state on a denied callback after replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-mcp-oauth-cancel-"));
    const credentials = new CredentialBroker(root, "restart-stable-key");
    const resumeOptions = {
      tenantId: "tenant",
      serverUrl: "http://127.0.0.1:9999/mcp",
      redirectUrl: "http://127.0.0.1:8787/auth/mcp/callback",
    };
    const provider = new BrokerBackedMcpOAuthProvider({ ...resumeOptions, broker: credentials });
    const state = await provider.state();
    await provider.saveCodeVerifier("cancelled-verifier");
    const now = Date.now();
    await new McpOAuthPendingStore(credentials).save(state, {
      schemaVersion: 1,
      connectionId: randomUUID(),
      createdAt: now,
      expiresAt: now + 600_000,
      config: { name: "cancelled", tenantId: "tenant", url: resumeOptions.serverUrl, oauth: resumeOptions, allowPlainHttp: true },
    });

    const replacementCredentials = new CredentialBroker(root, "restart-stable-key");
    const manager = new McpManager(await capabilityBroker(join(root, "effects")), { credentialBroker: replacementCredentials });
    expect(await manager.cancelHttpOAuthByState(state)).toBe(true);
    expect(await manager.cancelHttpOAuthByState(state)).toBe(false);
    const reloaded = new BrokerBackedMcpOAuthProvider({ ...resumeOptions, broker: replacementCredentials });
    expect(await reloaded.matchesState(state)).toBe(false);
    await expect(reloaded.codeVerifier()).rejects.toThrow("verifier is missing");
  });
});
