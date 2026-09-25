#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HybridAgentEngine,
  WorkerProtocolServer,
  type CommandEnvelope,
  type EngineConfig,
} from "@haf/engine";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const workerId = required("HAF_WORKER_ID");
const token = required("HAF_WORKER_TOKEN");
const socketPath = required("HAF_WORKER_SOCKET");
const descriptorPath = required("HAF_WORKER_DESCRIPTOR");
const workerHome = resolve(process.env.HAF_WORKER_HOME ?? `./var/detached/${workerId}`);
const tenantId = process.env.HAF_WORKER_TENANT_ID ?? "local";
const sessionName = process.env.HAF_WORKER_SESSION_NAME ?? `detached-${workerId.slice(0, 8)}`;
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

const sandboxBackend: EngineConfig["sandboxBackend"] = process.env.HAF_SANDBOX_BACKEND === "docker" ? "docker" : "local";
const engine = new HybridAgentEngine({
  homePath: workerHome,
  kernelServerScript: resolve(process.env.HAF_KERNEL_SERVER ?? kernelScript),
  sandboxBackend,
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
  model,
});
await engine.initialize();

let rootSession;
try {
  rootSession = await engine.session(workerId);
} catch {
  rootSession = await engine.createSession({
    sessionId: workerId,
    tenantId,
    name: sessionName,
    workspacePath: resolve(workerHome, "workspaces", workerId),
  });
}

let shuttingDown = false;
const server = new WorkerProtocolServer({
  workerId,
  socketPath,
  descriptorPath,
  token,
  generation: rootSession.generation,
  replayCapacity: Number(process.env.HAF_WORKER_REPLAY_CAPACITY ?? 8192),
  commandHandler: async (method, payload) => {
    if (method === "dispatch") {
      const command = JSON.parse(payload.toString("utf8")) as CommandEnvelope;
      if (command.sessionId !== workerId && !(await engine.sessions(tenantId)).some((session) => session.sessionId === command.sessionId)) {
        throw new Error("Command targets a session outside this worker family.");
      }
      return await engine.command(command);
    }
    if (method === "state") return await engine.session(payload.length ? JSON.parse(payload.toString()).sessionId : workerId);
    if (method === "list_sessions") return { sessions: await engine.sessions(tenantId) };
    if (method === "spawn_child") {
      const input = JSON.parse(payload.toString());
      return await engine.supervisor.spawnChild({
        parentSessionId: input.parentSessionId ?? workerId,
        task: input.task,
        ...(input.name ? { name: input.name } : {}),
        source: "agent",
      });
    }
    if (method === "fork") {
      const input = JSON.parse(payload.toString());
      return await engine.supervisor.forkSession({
        sourceSessionId: input.sourceSessionId ?? workerId,
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...(input.name ? { name: input.name } : {}),
        includeAbandonedBranchSummary: input.includeAbandonedBranchSummary === true,
      });
    }
    if (method === "approvals_list") return { approvals: engine.approvals.list() };
    if (method === "approval_resolve") {
      const input = JSON.parse(payload.toString());
      return engine.approvals.resolve(input.id, input.decision);
    }
    if (method === "shutdown") {
      if (!shuttingDown) {
        shuttingDown = true;
        setTimeout(() => void shutdown("command"), 25);
      }
      return { shuttingDown: true };
    }
    throw new Error(`Unknown session worker method: ${method}`);
  },
  snapshotProvider: async () => ({
    workerId,
    rootSessionId: workerId,
    sessions: await engine.sessions(tenantId),
    approvals: engine.approvals.list(),
    capturedAt: new Date().toISOString(),
  }),
});

engine.events.subscribeAll((event) => {
  server.publish("session_event", event);
});
engine.approvals.subscribe((approval) => {
  server.publish("approval", approval);
});
await server.start();
const stopNatsCommands = engine.natsCommands
  ? await engine.natsCommands.serve(workerId, async (command) => await engine.command(command))
  : undefined;

async function shutdown(_reason: string): Promise<void> {
  stopNatsCommands?.();
  if (!shuttingDown) shuttingDown = true;
  await engine.shutdown().catch(() => undefined);
  await server.stop().catch(() => undefined);
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
