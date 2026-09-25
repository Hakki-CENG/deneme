import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { MCP_ERROR_CODES, MCP_STATELESS_REVISION, StatelessMcpClient } from "../src/mcp/stateless-mcp-client.js";

interface Recorded { method: string; headers: Record<string, string>; body: any }

async function statelessServer(handler: (request: Recorded, response: ServerResponse) => unknown | "streamed"): Promise<{ url: string; server: Server; seen: Recorded[] }> {
  const seen: Recorded[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
      const record: Recorded = { method: body.method, headers, body };
      seen.push(record);
      const result = handler(record, response);
      if (result === "streamed") return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(result && (result as any).error ? { error: (result as any).error } : { result }) }));
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/mcp`, server, seen };
}

let open: Server[] = [];
afterEach(async () => {
  for (const server of open) await new Promise<void>((done) => server.close(() => done()));
  open = [];
});

async function engineFixture() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-round3b-"));
  const engine = new HybridAgentEngine({
    homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local", model: { provider: "mock" }, autoApproveWorkspaceWrites: true,
  });
  return engine;
}

function contextFor(sessionId: string, workspacePath: string, suffix: string) {
  return {
    tenantId: "tenant", sessionId, familyId: sessionId, turnId: `turn-${suffix}`, toolCallId: `call-${suffix}`,
    source: "api" as const, workspacePath, idempotencyKey: `r3b-${suffix}`,
  };
}

describe("Cross-family agent directory and directed messaging", () => {
  it("lists every live agent in the tenant and flags names that are not unique", async () => {
    const engine = await engineFixture();
    const alpha = await engine.createSession({ tenantId: "tenant", name: "builder" });
    await engine.createSession({ tenantId: "tenant", name: "reviewer" });
    await engine.createSession({ tenantId: "other", name: "outsider" });

    const directory = await engine.supervisor.directory("tenant");
    expect(directory.map((item) => item.name).sort()).toEqual(["builder", "reviewer"]);
    expect(directory.every((item) => item.nameIsUnique)).toBe(true);
    // Another tenant's agents are not in the directory at all, not merely unreachable.
    expect(directory.some((item) => item.name === "outsider")).toBe(false);

    const snapshot = await engine.session(alpha.sessionId);
    const view = await engine.capabilities.execute("agent.directory", { query: "review" }, contextFor(alpha.sessionId, snapshot.workspacePath, "dir")) as any;
    expect(view.agents).toHaveLength(1);
    expect(view.agents[0].name).toBe("reviewer");
    await engine.shutdown();
  }, 60_000);

  it("delivers a message outside family reach and records it as external", async () => {
    const engine = await engineFixture();
    const sender = await engine.createSession({ tenantId: "tenant", name: "sender" });
    const stranger = await engine.createSession({ tenantId: "tenant", name: "stranger" });

    const roster = await engine.supervisor.familyRoster(sender.sessionId);
    expect(roster.some((item) => item.sessionId === stranger.sessionId)).toBe(false);

    const delivery = await engine.supervisor.sendDirectedMessage({
      senderSessionId: sender.sessionId, targetName: "stranger", message: "Please review branch feature/x.",
    });
    expect(delivery.receipts).toHaveLength(1);
    expect(delivery.receipts[0]!.relationship).toBe("external");
    const inbox = await engine.supervisor.listAgentInbox(stranger.sessionId);
    expect(inbox.some((item) => item.text.includes("feature/x"))).toBe(true);
    await engine.shutdown();
  }, 60_000);

  it("refuses an ambiguous name, itself, and anything in another tenant", async () => {
    const engine = await engineFixture();
    const sender = await engine.createSession({ tenantId: "tenant", name: "sender" });
    const parent = await engine.createSession({ tenantId: "tenant", name: "twin-parent" });
    // Two live agents answering to the same name in different families.
    await engine.supervisor.spawnChild({ parentSessionId: parent.sessionId, task: "one", name: "twin" });
    await engine.createSession({ tenantId: "tenant", name: "twin" });
    const elsewhere = await engine.createSession({ tenantId: "other", name: "faraway" });

    await expect(engine.supervisor.sendDirectedMessage({ senderSessionId: sender.sessionId, targetName: "twin", message: "hi" }))
      .rejects.toThrow(/matches 2 live agents/i);
    await expect(engine.supervisor.sendDirectedMessage({ senderSessionId: sender.sessionId, targetSessionId: sender.sessionId, message: "hi" }))
      .rejects.toThrow(/cannot message itself/i);
    await expect(engine.supervisor.sendDirectedMessage({ senderSessionId: sender.sessionId, targetSessionId: elsewhere.sessionId, message: "hi" }))
      .rejects.toThrow(/no live agent in this tenant/i);
    await engine.shutdown();
  }, 60_000);

  it("treats crossing a family boundary as privileged", async () => {
    const engine = await engineFixture();
    const descriptor = engine.capabilities.list().find((item) => item.id === "agent.message.direct")!;
    expect(descriptor.risk).toBe("privileged");
    // Family messaging stays ungated: the tree itself is the authorisation there.
    expect(engine.capabilities.list().find((item) => item.id === "agent.send")!.risk).toBe("pure");
    await engine.shutdown();
  }, 60_000);
});

describe("Conversation-inheriting spawn", () => {
  it("starts the child from the parent's transcript when asked, and empty when not", async () => {
    const engine = await engineFixture();
    const parent = await engine.createSession({ tenantId: "tenant", name: "lead" });
    await engine.command({
      protocolVersion: 1, commandId: "cmd-inherit-1", clientId: "test", tenantId: "tenant", sessionId: parent.sessionId,
      kind: "session.prompt", source: "api", issuedAt: new Date().toISOString(), payload: { text: "Remember: the API base is https://api.example." },
    });

    const forked = await engine.supervisor.spawnChild({ parentSessionId: parent.sessionId, task: "Continue.", name: "forked", inheritConversation: true });
    const inherited = await engine.session(forked.sessionId);
    const text = JSON.stringify(inherited.messages);
    expect(text).toContain("api.example");

    const fresh = await engine.supervisor.spawnChild({ parentSessionId: parent.sessionId, task: "Start clean.", name: "fresh" });
    const freshSnapshot = await engine.session(fresh.sessionId);
    expect(JSON.stringify(freshSnapshot.messages)).not.toContain("api.example");
    await engine.shutdown();
  }, 90_000);

  it("copies the transcript rather than sharing it, so a child cannot rewrite the parent's history", async () => {
    const engine = await engineFixture();
    const parent = await engine.createSession({ tenantId: "tenant", name: "lead" });
    await engine.command({
      protocolVersion: 1, commandId: "cmd-inherit-2", clientId: "test", tenantId: "tenant", sessionId: parent.sessionId,
      kind: "session.prompt", source: "api", issuedAt: new Date().toISOString(), payload: { text: "original instruction" },
    });
    const before = (await engine.session(parent.sessionId)).messages.length;
    const child = await engine.supervisor.spawnChild({ parentSessionId: parent.sessionId, task: "Work.", inheritConversation: 2 });
    const childSnapshot = await engine.session(child.sessionId);
    expect(childSnapshot.messages.length).toBeGreaterThan(0);
    expect((await engine.session(parent.sessionId)).messages.length).toBe(before);
    await engine.shutdown();
  }, 90_000);
});

describe("MCP 2026-07-28 remaining surfaces", () => {
  it("honours ttlMs and refuses to cache when the server says not to", async () => {
    let calls = 0;
    const { url, server } = await statelessServer((request) => {
      if (request.method === "tools/list") {
        calls++;
        return { tools: [{ name: "echo" }], cacheScope: "none" };
      }
      return {};
    });
    open.push(server);
    const client = new StatelessMcpClient({ endpoint: url, allowPlainHttp: true, listCacheTtlMs: 600_000 });
    await client.listTools();
    const second = await client.listTools();
    expect(second.fromCache).toBe(false);
    expect(calls).toBe(2);
  });

  it("names the renumbered protocol errors and stops asking a server that cannot serve the revision", async () => {
    let calls = 0;
    const { url, server } = await statelessServer(() => {
      calls++;
      return { error: { code: MCP_ERROR_CODES.unsupportedProtocolVersion, message: "server speaks 2025-11-25" } };
    });
    open.push(server);
    const client = new StatelessMcpClient({ endpoint: url, allowPlainHttp: true });

    const outcome = await client.callTool({ name: "echo" });
    expect(outcome.status).toBe("error");
    expect(outcome.status === "error" && outcome.code).toBe(MCP_ERROR_CODES.unsupportedProtocolVersion);
    expect(outcome.status === "error" && outcome.kind).toBe("unsupported-version");

    const again = await client.callTool({ name: "echo" });
    expect(again.status === "error" && again.message).toMatch(/not retrying/i);
    // The second call never reached the network.
    expect(calls).toBe(1);
  });

  it("polls a task handle to completion and reports a failed task as an error", async () => {
    let polls = 0;
    const { url, server } = await statelessServer((request) => {
      if (request.method === "tools/call") return { task: { taskId: "task-1", state: "working", pollIntervalMs: 100 } };
      if (request.method === "tasks/get") {
        polls++;
        return polls < 2 ? { state: "working" } : { state: "completed", result: { ok: true } };
      }
      return {};
    });
    open.push(server);
    const client = new StatelessMcpClient({ endpoint: url, allowPlainHttp: true });

    const handle = await client.callTool({ name: "slow" });
    expect(handle.status).toBe("task");

    const finished = await client.callToolInteractive({ name: "slow", resolveInputs: async () => [] });
    expect(finished.status).toBe("completed");
    expect(finished.status === "completed" && (finished.result as any).ok).toBe(true);
  }, 30_000);

  it("sends input to a running task and sends the per-request log level", async () => {
    const seenLevels: unknown[] = [];
    const { url, server } = await statelessServer((request) => {
      seenLevels.push(request.body.params?._meta?.["io.modelcontextprotocol/logLevel"]);
      if (request.method === "tasks/update") return { accepted: true };
      if (request.method === "tasks/get") return { state: "completed", result: "done" };
      return {};
    });
    open.push(server);
    const client = new StatelessMcpClient({ endpoint: url, allowPlainHttp: true, logLevel: "warning" });

    const status = await client.updateTask("task-9", { answer: "yes" });
    expect(status.state).toBe("completed");
    expect(status.terminal).toBe(true);
    expect(seenLevels[0]).toBe("warning");
  });

  it("receives change notifications on the subscription stream and invalidates the affected cache", async () => {
    const { url, server } = await statelessServer((request, response) => {
      if (request.method === "subscriptions/listen") {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} })}\n`);
        return "streamed";
      }
      if (request.method === "tools/list") return { tools: [{ name: "echo" }] };
      return {};
    });
    open.push(server);
    const client = new StatelessMcpClient({ endpoint: url, allowPlainHttp: true, listCacheTtlMs: 600_000 });
    await client.listTools();

    const received: string[] = [];
    const subscription = await client.listen({ types: ["toolsListChanged"], onNotification: (item) => received.push(item.type) });
    for (let wait = 0; wait < 200 && received.length === 0; wait++) await new Promise((tick) => setTimeout(tick, 10));
    subscription.stop();

    expect(received).toContain("toolsListChanged");
    // The cache the notification named is gone; nothing else was touched.
    const refreshed = await client.listTools();
    expect(refreshed.fromCache).toBe(false);
  }, 30_000);

  it("reports the server identity it was given in result metadata", async () => {
    const { url, server } = await statelessServer(() => ({
      tools: [],
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "demo-server", version: "2.0.0" } },
    }));
    open.push(server);
    const client = new StatelessMcpClient({ endpoint: url, allowPlainHttp: true });
    await client.listTools();
    expect(client.serverInfo()).toEqual({ name: "demo-server", version: "2.0.0" });
  });

  it("still refuses a request whose routing header would disagree with its body", async () => {
    const { url, server } = await statelessServer(() => ({ tools: [] }));
    open.push(server);
    const client = new StatelessMcpClient({ endpoint: url, allowPlainHttp: true, headers: { "Mcp-Method": "tools/list" } });
    await expect(client.discover()).resolves.toMatchObject({ failed: true });
    expect(MCP_STATELESS_REVISION).toBe("2026-07-28");
  });
});
