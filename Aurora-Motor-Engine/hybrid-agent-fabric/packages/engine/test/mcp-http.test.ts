import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { CapabilityBroker } from "../src/capabilities/capability-broker.js";
import { ApprovalService } from "../src/policy/approval-service.js";
import { DefaultPolicyEngine } from "../src/policy/policy-engine.js";
import { EffectJournal } from "../src/persistence/effect-journal.js";
import { McpManager, validateMcpTlsOptions } from "../src/mcp/mcp-manager.js";

async function brokerRoot() {
  const root = await mkdtemp(join(tmpdir(), "haf-mcp-http-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const broker = new CapabilityBroker(new DefaultPolicyEngine(), new ApprovalService(), new EffectJournal(root));
  return { root, workspace, broker };
}

describe("Streamable HTTP MCP boundary", () => {
  it("validates bounded PEM mTLS material and server names", () => {
    const certificate = `-----BEGIN CERTIFICATE-----\n${"A".repeat(64)}\n-----END CERTIFICATE-----`;
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${"B".repeat(64)}\n-----END PRIVATE KEY-----`;
    const tls = validateMcpTlsOptions({ certificate, privateKey, certificateAuthority: certificate, serverName: "mcp.example.com" });
    expect(Buffer.isBuffer(tls.certificate)).toBe(true);
    expect(tls.serverName).toBe("mcp.example.com");
    expect(() => validateMcpTlsOptions({ certificate: "bad", privateKey })).toThrow("size is invalid");
    expect(() => validateMcpTlsOptions({ certificate, privateKey, serverName: "bad name" })).toThrow("server name");
  });

  it("connects through same-origin guarded fetch without exposing server-side headers", async () => {
    const { root, workspace, broker } = await brokerRoot();
    const app = createMcpExpressApp();
    const seenAuthorization: string[] = [];
    app.post("/mcp", async (request, response) => {
      seenAuthorization.push(String(request.headers.authorization ?? ""));
      const server = new McpServer({ name: "haf-http-test", version: "1.0.0" });
      server.tool("echo", "Echo over HTTP", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
      response.on("close", () => { void transport.close(); void server.close(); });
    });
    const listener = await new Promise<ReturnType<typeof app.listen>>((resolvePromise) => {
      const value = app.listen(0, "127.0.0.1", () => resolvePromise(value));
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind a TCP port.");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const manager = new McpManager(broker, { urlGuard: async (value) => new URL(value), schemaCacheRoot: join(root, "schema-cache") });
    try {
      const connected = await manager.connectHttp({
        name: "remote-echo",
        url,
        allowPlainHttp: true,
        headers: { authorization: "Bearer server-side-secret" },
        defaultRisk: "pure",
      });
      expect(connected.capabilityIds).toEqual(["mcp.remote-echo.echo"]);
      const result = await broker.execute("mcp.remote-echo.echo", { text: "hello remote MCP" }, {
        tenantId: "local",
        sessionId: randomUUID(),
        familyId: randomUUID(),
        turnId: randomUUID(),
        toolCallId: randomUUID(),
        source: "api",
        workspacePath: workspace,
        idempotencyKey: randomUUID(),
      });
      expect(JSON.stringify(result)).toContain("hello remote MCP");
      expect(seenAuthorization).toContain("Bearer server-side-secret");
      expect(JSON.stringify(manager.list())).not.toContain("server-side-secret");
      const cached = await manager.listCachedSchemas();
      expect(cached[0]?.tools.map((tool) => tool.id)).toContain("mcp.remote-echo.echo");
      expect(JSON.stringify(cached)).not.toContain("server-side-secret");
    } finally {
      await manager.closeAll();
      await new Promise<void>((resolvePromise, reject) => listener.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it("rejects loopback HTTP endpoints under the production URL guard", async () => {
    const { broker } = await brokerRoot();
    const manager = new McpManager(broker);
    await expect(manager.connectHttp({
      name: "unsafe",
      url: "http://127.0.0.1:3000/mcp",
      allowPlainHttp: true,
    })).rejects.toThrow("Private or special-use");
    const testGuardManager = new McpManager(broker, { urlGuard: async (value) => new URL(value) });
    await expect(testGuardManager.connectHttp({
      name: "query-secret",
      url: "https://example.com/mcp?token=secret",
    })).rejects.toThrow("query strings");
  });
});
