#!/usr/bin/env node
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ENGINE_VERSION, HybridAgentEngine, type EngineConfig, type EventEnvelope } from "@haf/engine";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

const rootHome = fileURLToPath(new URL("../../../var", import.meta.url));
const kernelScript = fileURLToPath(new URL("../../../python/kernel_server.py", import.meta.url));
const providerId = process.env.HAF_MODEL_PROVIDER ?? "mock";
const model: NonNullable<EngineConfig["model"]> = providerId === "mock"
  ? { provider: "mock" }
  : providerId === "openai-compatible"
    ? {
        provider: "openai-compatible",
        baseUrl: process.env.HAF_MODEL_BASE_URL ?? "https://api.openai.com/v1",
        ...(process.env.HAF_MODEL_API_KEY ? { apiKey: process.env.HAF_MODEL_API_KEY } : {}),
        modelName: process.env.HAF_MODEL_NAME ?? "gpt-4.1-mini",
      }
    : {
        provider: "profile",
        profileId: providerId,
        ...(process.env.HAF_MODEL_BASE_URL ? { baseUrl: process.env.HAF_MODEL_BASE_URL } : {}),
        ...(process.env.HAF_MODEL_API_KEY ? { apiKey: process.env.HAF_MODEL_API_KEY } : {}),
        ...(process.env.HAF_MODEL_NAME ? { modelName: process.env.HAF_MODEL_NAME } : {}),
      };
const sandboxBackend: EngineConfig["sandboxBackend"] = process.env.HAF_SANDBOX_BACKEND === "docker"
  ? "docker"
  : process.env.HAF_SANDBOX_BACKEND === "ssh" ? "ssh" : "local";
if (sandboxBackend === "ssh" && !process.env.HAF_SSH_HOST) throw new Error("HAF_SSH_HOST is required for the SSH sandbox.");
const engine = new HybridAgentEngine({
  homePath: resolve(process.env.HAF_HOME ?? rootHome),
  kernelServerScript: resolve(process.env.HAF_KERNEL_SERVER ?? kernelScript),
  sandboxBackend,
  ...(sandboxBackend === "ssh"
    ? {
        sshSandbox: {
          host: process.env.HAF_SSH_HOST!,
          ...(process.env.HAF_SSH_USER ? { user: process.env.HAF_SSH_USER } : {}),
          ...(process.env.HAF_SSH_PORT ? { port: Number(process.env.HAF_SSH_PORT) } : {}),
          ...(process.env.HAF_SSH_IDENTITY_FILE ? { identityFile: process.env.HAF_SSH_IDENTITY_FILE } : {}),
          ...(process.env.HAF_SSH_REMOTE_ROOT ? { remoteRoot: process.env.HAF_SSH_REMOTE_ROOT } : {}),
          syncFiles: process.env.HAF_SSH_SYNC_FILES !== "false",
        },
      }
    : {}),
  autoApproveWorkspaceWrites: process.env.HAF_AUTO_APPROVE_WORKSPACE === "true",
  allowProcessExecution: process.env.HAF_ALLOW_PROCESS === "true",
  ...(process.env.HAF_MASTER_KEY ? { masterKey: process.env.HAF_MASTER_KEY } : {}),
  ...(process.env.HAF_VAULT_ADDRESS && process.env.HAF_VAULT_TOKEN
    ? { vault: {
        address: process.env.HAF_VAULT_ADDRESS,
        token: process.env.HAF_VAULT_TOKEN,
        ...(process.env.HAF_VAULT_NAMESPACE ? { namespace: process.env.HAF_VAULT_NAMESPACE } : {}),
        ...(process.env.HAF_VAULT_MOUNT ? { mount: process.env.HAF_VAULT_MOUNT } : {}),
        ...(process.env.HAF_VAULT_PREFIX ? { prefix: process.env.HAF_VAULT_PREFIX } : {}),
      } }
    : {}),
  ...(process.env.HAF_EMBEDDING_API_KEY
    ? {
        embeddings: {
          apiKey: process.env.HAF_EMBEDDING_API_KEY,
          ...(process.env.HAF_EMBEDDING_BASE_URL ? { baseUrl: process.env.HAF_EMBEDDING_BASE_URL } : {}),
          ...(process.env.HAF_EMBEDDING_MODEL ? { model: process.env.HAF_EMBEDDING_MODEL } : {}),
          ...(process.env.HAF_EMBEDDING_DIMENSIONS ? { dimensions: Number(process.env.HAF_EMBEDDING_DIMENSIONS) } : {}),
        },
      }
    : {}),
  ...(process.env.HAF_POSTGRES_URL
    ? {
        postgres: {
          connectionString: process.env.HAF_POSTGRES_URL,
          schema: process.env.HAF_POSTGRES_SCHEMA ?? "haf",
          enableNotify: process.env.HAF_POSTGRES_NOTIFY !== "false",
          enableRls: process.env.HAF_POSTGRES_RLS === "true",
        },
      }
    : {}),
  ...(process.env.HAF_NATS_SERVERS
    ? {
        nats: {
          servers: process.env.HAF_NATS_SERVERS.split(",").map((value) => value.trim()).filter(Boolean),
          ...(process.env.HAF_NATS_TOKEN ? { token: process.env.HAF_NATS_TOKEN } : {}),
          ...(process.env.HAF_NATS_USER ? { user: process.env.HAF_NATS_USER } : {}),
          ...(process.env.HAF_NATS_PASS ? { pass: process.env.HAF_NATS_PASS } : {}),
          prefix: process.env.HAF_NATS_PREFIX ?? "haf",
        },
      }
    : {}),
  ...(process.env.HAF_OPA_ENDPOINT
    ? {
        opa: {
          endpoint: process.env.HAF_OPA_ENDPOINT,
          ...(process.env.HAF_OPA_BEARER_TOKEN ? { bearerToken: process.env.HAF_OPA_BEARER_TOKEN } : {}),
          timeoutMs: Number(process.env.HAF_OPA_TIMEOUT_MS ?? 3000),
        },
      }
    : {}),
  ...(process.env.HAF_AUDIO_API_KEY
    ? {
        audio: {
          apiKey: process.env.HAF_AUDIO_API_KEY,
          ...(process.env.HAF_AUDIO_BASE_URL ? { baseUrl: process.env.HAF_AUDIO_BASE_URL } : {}),
          ...(process.env.HAF_STT_MODEL ? { transcriptionModel: process.env.HAF_STT_MODEL } : {}),
          ...(process.env.HAF_TTS_MODEL ? { speechModel: process.env.HAF_TTS_MODEL } : {}),
          ...(process.env.HAF_TTS_VOICE ? { defaultVoice: process.env.HAF_TTS_VOICE } : {}),
        },
      }
    : {}),
  ...((process.env.HAF_BROWSER_CDP_ENDPOINT || process.env.HAF_BROWSER_EXECUTABLE_PATH)
    ? {
        browser: {
          ...(process.env.HAF_BROWSER_CDP_ENDPOINT ? { cdpEndpoint: process.env.HAF_BROWSER_CDP_ENDPOINT } : {}),
          ...(process.env.HAF_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.HAF_BROWSER_EXECUTABLE_PATH } : {}),
          headless: process.env.HAF_BROWSER_HEADLESS !== "false",
          allowPrivateCdpEndpoint: process.env.HAF_BROWSER_ALLOW_PRIVATE_CDP === "true",
        },
      }
    : {}),
  model,
});
await engine.initialize();
engine.start();

let activeSessionId: string | undefined;
let unsubscribe: (() => void) | undefined;
let activeTenant = "local";

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id: JsonRpcRequest["id"], value: unknown): void {
  if (id === undefined) return;
  write({ jsonrpc: "2.0", id, result: value });
}

function failure(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): void {
  if (id === undefined) return;
  write({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

function notification(method: string, params: unknown): void {
  write({ jsonrpc: "2.0", method, params });
}

function projectEvent(event: EventEnvelope): void {
  if (!activeSessionId || event.visibility === "internal") return;
  let update: unknown;
  switch (event.type) {
    case "model.text.delta":
      update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: (event.payload as any).delta ?? "" } };
      break;
    case "capability.started":
      update = {
        sessionUpdate: "tool_call",
        toolCallId: (event.payload as any).toolCallId,
        title: (event.payload as any).capabilityId,
        kind: "execute",
        status: "in_progress",
      };
      break;
    case "capability.finished":
      update = {
        sessionUpdate: "tool_call_update",
        toolCallId: (event.payload as any).toolCallId,
        status: (event.payload as any).status === "ok" ? "completed" : "failed",
      };
      break;
    case "session.status.changed":
      update = {
        sessionUpdate: "session_info_update",
        _meta: {
          "ai.hybrid-agent-fabric": {
            status: (event.payload as any).status,
            generation: event.generation,
            sequence: event.sequence,
          },
        },
      };
      break;
    case "goal.set":
    case "goal.pause":
    case "goal.resume":
    case "goal.complete":
    case "goal.clear":
      update = {
        sessionUpdate: "session_info_update",
        _meta: { "ai.hybrid-agent-fabric": { goal: (event.payload as any).goal ?? null } },
      };
      break;
    case "autonomous.configured":
      update = {
        sessionUpdate: "session_info_update",
        _meta: { "ai.hybrid-agent-fabric": { autonomous: (event.payload as any).autonomous ?? null } },
      };
      break;
    case "subagent.linked":
      update = {
        sessionUpdate: "session_info_update",
        _meta: { "ai.hybrid-agent-fabric": { childSessionId: (event.payload as any).childSessionId } },
      };
      break;
    default:
      return;
  }
  notification("session/update", { sessionId: activeSessionId, update });
}

async function handle(request: JsonRpcRequest): Promise<void> {
  try {
    switch (request.method) {
      case "initialize":
        result(request.id, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false, embeddedContext: true } },
          agentInfo: { name: "Hybrid Agent Fabric", version: ENGINE_VERSION },
          _meta: { "ai.hybrid-agent-fabric": { capabilities: engine.capabilities.list().map((item) => item.id) } },
        });
        return;
      case "session/new": {
        if (activeSessionId) throw new Error("This ACP connection already owns a session; close it before creating another.");
        activeTenant = String(request.params?._meta?.tenantId ?? "local");
        const session = await engine.createSession({
          tenantId: activeTenant,
          name: request.params?._meta?.name ? String(request.params._meta.name) : "ACP session",
          ...(request.params?.cwd ? { workspacePath: String(request.params.cwd) } : {}),
        });
        activeSessionId = session.sessionId;
        unsubscribe = engine.subscribe(session.sessionId, projectEvent);
        result(request.id, { sessionId: session.sessionId, modes: { currentModeId: "default", availableModes: [] } });
        return;
      }
      case "session/load": {
        if (activeSessionId) throw new Error("Close the current ACP session first.");
        const sessionId = String(request.params?.sessionId ?? "");
        const session = await engine.session(sessionId);
        activeSessionId = session.sessionId;
        activeTenant = session.tenantId;
        unsubscribe = engine.subscribe(session.sessionId, projectEvent);
        result(request.id, { sessionId: session.sessionId });
        return;
      }
      case "session/prompt": {
        if (!activeSessionId) throw new Error("Create a session first.");
        const blocks = Array.isArray(request.params?.prompt) ? request.params.prompt : [];
        const text = blocks.filter((block: any) => block?.type === "text").map((block: any) => String(block.text ?? "")).join("\n");
        const command = await engine.command({
          protocolVersion: 1,
          commandId: randomUUID(),
          clientId: "acp-stdio",
          tenantId: activeTenant,
          sessionId: activeSessionId,
          kind: "session.prompt",
          source: "api",
          issuedAt: new Date().toISOString(),
          payload: { text },
        });
        result(request.id, {
          stopReason: command.status === "completed" ? "end_turn" : command.status === "uncertain" ? "max_turn_requests" : "cancelled",
          _meta: { "ai.hybrid-agent-fabric": command },
        });
        return;
      }
      case "session/cancel":
        if (activeSessionId) {
          await engine.command({
            protocolVersion: 1,
            commandId: randomUUID(),
            clientId: "acp-stdio",
            tenantId: activeTenant,
            sessionId: activeSessionId,
            kind: "session.cancel",
            source: "api",
            issuedAt: new Date().toISOString(),
            payload: {},
          });
        }
        result(request.id, {});
        return;
      case "session/close":
        if (activeSessionId) {
          await engine.command({
            protocolVersion: 1,
            commandId: randomUUID(),
            clientId: "acp-stdio",
            tenantId: activeTenant,
            sessionId: activeSessionId,
            kind: "session.close",
            source: "api",
            issuedAt: new Date().toISOString(),
            payload: {},
          });
        }
        unsubscribe?.();
        unsubscribe = undefined;
        activeSessionId = undefined;
        result(request.id, {});
        return;
      default:
        failure(request.id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    failure(request.id, -32000, error instanceof Error ? error.message : String(error));
  }
}

const input = createInterface({ input: process.stdin, terminal: false });
let requestChain = Promise.resolve();
input.on("line", (line) => {
  requestChain = requestChain.then(async () => {
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      await handle(request);
    } catch (error) {
      failure(null, -32700, error instanceof Error ? error.message : String(error));
    }
  });
});
input.on("close", () => {
  void requestChain.finally(async () => {
    unsubscribe?.();
    await engine.shutdown();
  });
});
