/**
 * ACP (Agent Client Protocol) stdio server — end-to-end against the real entrypoint.
 *
 * `apps/acp-server` had 332 lines and zero tests. It is a top-level script that
 * constructs a HybridAgentEngine at module scope and speaks newline-delimited
 * JSON-RPC over stdio, so it cannot be unit tested by importing it; the only
 * honest coverage is to spawn the built artifact and drive the real protocol.
 *
 * The engine runs with the mock model provider and a throwaway HAF_HOME, so no
 * network, no python kernel and no repo state is touched.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const ACP_MAIN = join(REPO_ROOT, "apps", "acp-server", "dist", "main.js");

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class AcpConnection {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (message: JsonRpcMessage) => void; reject: (error: Error) => void }
  >();
  readonly notifications: JsonRpcMessage[] = [];
  readonly child: ChildProcessWithoutNullStreams;

  constructor(homePath: string) {
    this.child = spawn(process.execPath, [ACP_MAIN], {
      cwd: REPO_ROOT,
      env: { ...process.env, HAF_HOME: homePath, HAF_MODEL_PROVIDER: "mock" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue; // tolerate non-JSON chatter on stdout
      }
      if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (waiter) {
          this.pending.delete(message.id);
          waiter.resolve(message);
          continue;
        }
      }
      this.notifications.push(message);
    }
  }

  request(method: string, params?: unknown, timeoutMs = 60_000): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolvePromise(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(payload);
    });
  }

  sendRaw(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  async terminate(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        done();
      }, 10_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}

describe("acp-server stdio protocol", () => {
  let home: string;
  let connection: AcpConnection;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "acp-server-"));
    connection = new AcpConnection(home);
    const initialized = await connection.request("initialize");
    // Fail fast with real diagnostics if the server never came up.
    expect(initialized.error, JSON.stringify(initialized.error)).toBeUndefined();
  }, 120_000);

  afterAll(async () => {
    await connection?.terminate();
    await rm(home, { recursive: true, force: true });
  });

  it("announces its capabilities and a version that matches the package", async () => {
    const response = await connection.request("initialize");
    const result = response.result as {
      protocolVersion: number;
      agentInfo: { name: string; version: string };
      agentCapabilities: { loadSession: boolean };
      _meta: Record<string, { capabilities: string[] }>;
    };

    expect(result.protocolVersion).toBe(1);
    expect(result.agentInfo.name).toBe("Hybrid Agent Fabric");
    // Regression: this was hardcoded to "1.38.0" while the repo shipped 1.65.0,
    // so every client was told it was talking to a release 27 versions old.
    expect(result.agentInfo.version).toBe("1.65.0");
    expect(result.agentCapabilities.loadSession).toBe(true);
    expect(result._meta["ai.hybrid-agent-fabric"]?.capabilities.length).toBeGreaterThan(0);
  });

  it("answers an unknown method with JSON-RPC -32601 instead of hanging", async () => {
    const response = await connection.request("session/does-not-exist");
    expect(response.error?.code).toBe(-32601);
    expect(response.error?.message).toMatch(/Method not found/);
  });

  it("refuses a prompt before a session exists", async () => {
    const response = await connection.request("session/prompt", {
      prompt: [{ type: "text", text: "too early" }],
    });
    expect(response.error?.code).toBe(-32000);
    expect(response.error?.message).toMatch(/Create a session first/);
  });

  it("creates a session, runs a prompt and reports the engine command", async () => {
    const created = await connection.request("session/new", {
      cwd: home,
      _meta: { tenantId: "local", name: "acp smoke" },
    });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    expect(sessionId).toBeTruthy();
    expect((created.result as { modes: { currentModeId: string } }).modes.currentModeId).toBe("default");

    const prompted = await connection.request("session/prompt", {
      prompt: [{ type: "text", text: "hello from the protocol test" }],
    });
    expect(prompted.error, JSON.stringify(prompted.error)).toBeUndefined();
    // `_meta` carries the raw engine CommandResult: { commandId, status, result?, error? }.
    const result = prompted.result as {
      stopReason: string;
      _meta: {
        "ai.hybrid-agent-fabric": { commandId: string; status: string; error?: { message: string } };
      };
    };
    const command = result._meta["ai.hybrid-agent-fabric"];
    expect(command.error, JSON.stringify(command.error)).toBeUndefined();
    expect(command.status).toBe("completed");
    expect(command.commandId).toMatch(/^[0-9a-f-]{36}$/);
    // The server maps completed -> end_turn, uncertain -> max_turn_requests,
    // anything else -> cancelled.
    expect(result.stopReason).toBe("end_turn");
    expect(sessionId).toBeTruthy();
  }, 180_000);

  it("rejects a second session while one is already open", async () => {
    const response = await connection.request("session/new", { _meta: { tenantId: "local" } });
    expect(response.error?.message).toMatch(/already owns a session/);
  });

  it("closes the session and then allows a new one", async () => {
    expect((await connection.request("session/close")).result).toEqual({});
    const reopened = await connection.request("session/new", { _meta: { tenantId: "local" } });
    expect(reopened.error, JSON.stringify(reopened.error)).toBeUndefined();
    expect((reopened.result as { sessionId: string }).sessionId).toBeTruthy();
    await connection.request("session/close");
  });

  it("reports malformed input as a parse error without dying", async () => {
    connection.sendRaw("{ this is not json");
    // The next well-formed request still has to be answered, which proves the
    // readline loop survived the bad line.
    const after = await connection.request("initialize");
    expect(after.error).toBeUndefined();
    expect((after.result as { protocolVersion: number }).protocolVersion).toBe(1);
  });
});
