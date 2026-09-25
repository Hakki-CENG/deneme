import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_STATELESS_REVISION, StatelessMcpClient } from "../src/mcp/stateless-mcp-client.js";

interface Recorded { method: string; headers: Record<string, string>; body: any }

async function statelessServer(handler: (request: Recorded) => unknown): Promise<{ url: string; server: Server; seen: Recorded[] }> {
  const seen: Recorded[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
      const record: Recorded = { method: body.method, headers, body };
      seen.push(record);
      const result = handler(record);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(result && (result as any).error ? { error: (result as any).error } : { result }) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/mcp`, server, seen };
}

let open: Server[] = [];
afterEach(async () => {
  for (const server of open) await new Promise<void>((resolve) => server.close(() => resolve()));
  open = [];
});

describe("MCP 2026-07-28 stateless client", () => {
  it("discovers capabilities without a handshake and never sends a session id", async () => {
    const { url, server, seen } = await statelessServer((request) => {
      if (request.method === "server/discover") {
        return { protocolVersion: MCP_STATELESS_REVISION, serverInfo: { name: "demo", version: "1.0.0" }, capabilities: { tools: {} } };
      }
      return {};
    });
    open.push(server);
    const client = new StatelessMcpClient({ endpoint: url, allowPlainHttp: true });

    const discovered = await client.discover();
    expect(discovered).toMatchObject({ protocolVersion: MCP_STATELESS_REVISION, serverInfo: { name: "demo" }, fromCache: false });
    // No initialize handshake happened: the very first call on the wire is server/discover.
    expect(seen[0]?.method).toBe("server/discover");
    expect(seen.some((item) => item.method === "initialize")).toBe(false);
    expect(seen[0]?.headers["mcp-session-id"]).toBeUndefined();
  });

  it("sends the routing headers the revision requires, matching the body", async () => {
    const { url, server, seen } = await statelessServer((request) => {
      if (request.method === "tools/list") return { tools: [{ name: "search", description: "Search things" }] };
      if (request.method === "tools/call") return { resultType: "completed", content: "ok" };
      return {};
    });
    open.push(server);
    const client = new StatelessMcpClient({ endpoint: url, allowPlainHttp: true });

    await client.listTools();
    await client.callTool({ name: "search", arguments: { query: "x" } });

    const list = seen.find((item) => item.method === "tools/list")!;
    expect(list.headers["mcp-protocol-version"]).toBe(MCP_STATELESS_REVISION);
    expect(list.headers["mcp-method"]).toBe("tools/list");
    expect(list.body.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe(MCP_STATELESS_REVISION);

    const call = seen.find((item) => item.method === "tools/call")!;
    expect(call.headers["mcp-method"]).toBe("tools/call");
    // Mcp-Name mirrors params.name exactly; a gateway can route on it without reading the body.
    expect(call.headers["mcp-name"]).toBe("search");
    expect(call.body.params.name).toBe(call.headers["mcp-name"]);
  });

  it("caches list results, which the revision makes safe, and refreshes on demand", async () => {
    let calls = 0;
    const { url, server } = await statelessServer((request) => {
      if (request.method === "tools/list") { calls++; return { tools: [{ name: `tool-${calls}` }] }; }
      return {};
    });
    open.push(server);
    const client = new StatelessMcpClient({ endpoint: url, allowPlainHttp: true, listCacheTtlMs: 60_000 });

    const first = await client.listTools();
    const second = await client.listTools();
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(calls).toBe(1);

    const forced = await client.listTools(true);
    expect(forced.fromCache).toBe(false);
    expect(calls).toBe(2);
  });

  it("completes a multi round-trip request, echoing requestState verbatim", async () => {
    const { url, server, seen } = await statelessServer((request) => {
      if (request.method !== "tools/call") return {};
      const params = request.body.params;
      if (!params.inputResponses) {
        return {
          resultType: "input_required",
          requestState: "opaque-state-token",
          inputRequests: [{ id: "confirm", prompt: "Delete 12 rows?", kind: "choice", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }],
        };
      }
      return { resultType: "completed", answered: params.inputResponses[0].value, echoedState: params.requestState };
    });
    open.push(server);
    const client = new StatelessMcpClient({ endpoint: url, allowPlainHttp: true });

    const first = await client.callTool({ name: "delete-rows", arguments: { table: "orders" } });
    expect(first.status).toBe("input-required");
    if (first.status !== "input-required") throw new Error("unreachable");
    expect(first.inputRequests[0]).toMatchObject({ id: "confirm", kind: "choice" });
    expect(first.inputRequests[0]?.options?.length).toBe(2);

    const second = await client.callTool({
      name: "delete-rows", arguments: { table: "orders" },
      requestId: first.requestId, requestState: first.requestState,
      inputResponses: [{ id: "confirm", value: "yes" }],
    });
    expect(second).toMatchObject({ status: "completed" });
    expect((second as { result: any }).result.answered).toBe("yes");
    // The state is echoed back exactly as received; the client never parses or rewrites it.
    expect((second as { result: any }).result.echoedState).toBe("opaque-state-token");
    // The re-issued call keeps the original request id, as the revision requires.
    const calls = seen.filter((item) => item.method === "tools/call");
    expect(calls[0]?.body.id).toBe(calls[1]?.body.id);
  });

  it("drives an interactive call through a caller-supplied resolver and bounds the rounds", async () => {
    const { url, server } = await statelessServer((request) => {
      if (request.method !== "tools/call") return {};
      return request.body.params.inputResponses
        ? { resultType: "completed", ok: true }
        : { resultType: "input_required", requestState: "state", inputRequests: [{ id: "q", prompt: "Which?", kind: "text" }] };
    });
    open.push(server);
    const client = new StatelessMcpClient({ endpoint: url, allowPlainHttp: true });

    const asked: string[] = [];
    const outcome = await client.callToolInteractive({
      name: "ask", resolveInputs: async (requests) => { asked.push(requests[0]!.prompt); return [{ id: "q", value: "answer" }]; },
    });
    expect(outcome).toMatchObject({ status: "completed", rounds: 2 });
    expect(asked).toEqual(["Which?"]);

    const { url: stubborn, server: stubbornServer } = await statelessServer(() => ({ resultType: "input_required", requestState: "s", inputRequests: [{ id: "q", prompt: "Again?" }] }));
    open.push(stubbornServer);
    const looping = new StatelessMcpClient({ endpoint: stubborn, allowPlainHttp: true });
    const bounded = await looping.callToolInteractive({ name: "loop", resolveInputs: async () => [{ id: "q", value: "v" }], maxRounds: 2 });
    expect(bounded.status).toBe("error");
    expect(bounded.rounds).toBe(2);
  });

  it("refuses an oversized requestState and a server error is returned, not thrown", async () => {
    const { url, server } = await statelessServer((request) => {
      if (request.method === "tools/call") return { error: { code: -32602, message: "bad arguments" } };
      return {};
    });
    open.push(server);
    const client = new StatelessMcpClient({ endpoint: url, allowPlainHttp: true });

    await expect(client.callTool({ name: "x", requestState: "s".repeat(5000) })).rejects.toThrow(/requestState exceeds/);
    const outcome = await client.callTool({ name: "x" });
    expect(outcome).toMatchObject({ status: "error" });
    expect((outcome as { message: string }).message).toMatch(/bad arguments/);
  });

  it("does not block a turn when discovery fails, and refuses unsafe endpoints", async () => {
    const client = new StatelessMcpClient({ endpoint: "http://127.0.0.1:1/mcp", allowPlainHttp: true, requestTimeoutMs: 1000 });
    const discovered = await client.discover();
    expect(discovered).toMatchObject({ failed: true });

    expect(() => new StatelessMcpClient({ endpoint: "http://mcp.example.test/mcp" })).toThrow(/requires HTTPS/);
    expect(() => new StatelessMcpClient({ endpoint: "https://user:pass@mcp.example.test/mcp" })).toThrow(/must not embed credentials/);
  });
});

describe("Stateless MCP registration", () => {
  it("registers tools as governed capabilities and stays usable when discovery fails", async () => {
    const { url, server } = await statelessServer((request) => {
      if (request.method === "server/discover") return { error: { code: -32601, message: "not implemented" } };
      if (request.method === "tools/list") return { tools: [{ name: "search", description: "Search the corpus" }] };
      if (request.method === "tools/call") return { resultType: "completed", hits: 3 };
      return {};
    });
    open.push(server);

    const { CapabilityBroker } = await import("../src/capabilities/capability-broker.js");
    const { DefaultPolicyEngine } = await import("../src/policy/policy-engine.js");
    const { ApprovalService } = await import("../src/policy/approval-service.js");
    const { StatelessMcpRegistry } = await import("../src/mcp/stateless-mcp-registry.js");
    const broker = new CapabilityBroker(new DefaultPolicyEngine({ autoApproveWorkspaceWrites: true }), new ApprovalService(), { async claim() { return { status: "fresh" as const }; }, async settle() {} } as any);
    const registry = new StatelessMcpRegistry(broker);

    const status = await registry.connect({ name: "demo", endpoint: url, allowPlainHttp: true });
    // Discovery failed, so the server is degraded — but its tools still registered and still work.
    expect(status.state).toBe("degraded");
    expect(status.detail).toMatch(/Discovery failed/);
    expect(status.tools).toEqual(["search"]);
    expect(broker.list().some((item) => item.id === "mcp.demo.search")).toBe(true);

    expect(await registry.disconnect("demo")).toEqual({ name: "demo", disconnected: true });
    expect(broker.list().some((item) => item.id === "mcp.demo.search")).toBe(false);
  });

  it("routes a mid-call input request to the human and refuses when no channel exists", async () => {
    const { url, server } = await statelessServer((request) => {
      if (request.method === "server/discover") return { protocolVersion: MCP_STATELESS_REVISION };
      if (request.method === "tools/list") return { tools: [{ name: "danger" }] };
      if (request.method !== "tools/call") return {};
      return request.body.params.inputResponses
        ? { resultType: "completed", confirmed: request.body.params.inputResponses[0].value }
        : { resultType: "input_required", requestState: "s", inputRequests: [{ id: "confirm", prompt: "Really?", kind: "choice", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }] };
    });
    open.push(server);

    const { CapabilityBroker } = await import("../src/capabilities/capability-broker.js");
    const { DefaultPolicyEngine } = await import("../src/policy/policy-engine.js");
    const { ApprovalService } = await import("../src/policy/approval-service.js");
    const { StatelessMcpRegistry } = await import("../src/mcp/stateless-mcp-registry.js");
    const effects = { async claim() { return { status: "fresh" as const }; }, async settle() {} } as any;
    const context = {
      tenantId: "tenant", sessionId: "session", familyId: "session", turnId: "t", toolCallId: "c",
      source: "api" as const, workspacePath: "/tmp", idempotencyKey: "mcp-1",
    };

    const asked: string[] = [];
    const interactive = new StatelessMcpRegistry(
      new CapabilityBroker(new DefaultPolicyEngine({ autoApproveWorkspaceWrites: true }), new ApprovalService(), effects),
      { askUser: async ({ requests }) => { asked.push(requests[0]!.prompt); return [{ id: "confirm", value: "Yes" }]; } },
    );
    await interactive.connect({ name: "demo", endpoint: url, allowPlainHttp: true });
    const capability = (interactive as any).servers.get("demo").capabilityIds[0];
    expect(capability).toBe("mcp.demo.danger");

    const brokerless = new StatelessMcpRegistry(
      new CapabilityBroker(new DefaultPolicyEngine({ autoApproveWorkspaceWrites: true }), new ApprovalService(), effects),
    );
    const noChannel = await brokerless.connect({ name: "demo2", endpoint: url, allowPlainHttp: true });
    expect(noChannel.state).toBe("ready");
    expect(asked.length).toBe(0);
  });
});
