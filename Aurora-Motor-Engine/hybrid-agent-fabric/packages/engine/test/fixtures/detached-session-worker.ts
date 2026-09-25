#!/usr/bin/env node
/**
 * Detached session-family worker — test fixture.
 *
 * A lightweight stand-in for `apps/session-worker` that owns a *persistent*
 * session family. State lives under `HAF_WORKER_HOME`, so when the process is
 * SIGKILLed and `WorkerProcessManager.recover()` respawns it, the root
 * transcript and the retained child registry are rehydrated from disk and the
 * generation counter advances.
 *
 * This is deliberately engine-free: these tests exercise the worker supervision
 * protocol (spawn / adopt / recover / generation fencing), not agent behaviour.
 *
 * Commands:
 *   spawn_child { task, name? } -> child session record
 *   list_sessions               -> { sessions: SessionRecord[] }
 *   state { sessionId? }        -> SessionRecord
 *   shutdown                    -> { shuttingDown: true }, then exits
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkerProtocolServer } from "../../src/runtime/worker/worker-server.js";

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
const statePath = join(workerHome, "family-state.json");

interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

interface SessionRecord {
  sessionId: string;
  parentSessionId: string | null;
  name: string;
  generation: number;
  childSessionIds: string[];
  messages: SessionMessage[];
  createdAt: string;
}

interface FamilyState {
  schemaVersion: 1;
  workerId: string;
  sessions: SessionRecord[];
}

const message = (role: SessionMessage["role"], content: string): SessionMessage => ({
  id: randomUUID(),
  role,
  content,
  createdAt: new Date().toISOString(),
});

function loadState(): FamilyState {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as FamilyState;
    if (parsed.schemaVersion === 1 && parsed.workerId === workerId && Array.isArray(parsed.sessions)) {
      return parsed;
    }
  } catch {
    // No prior state (first boot) or unreadable state: start a fresh family.
  }
  return {
    schemaVersion: 1,
    workerId,
    sessions: [
      {
        sessionId: workerId,
        parentSessionId: null,
        name: process.env.HAF_WORKER_SESSION_NAME ?? "root",
        generation: 0, // Bumped to 1 by the boot increment below.
        childSessionIds: [],
        messages: [message("system", "Root session created.")],
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

const state = loadState();

const rootSession = (): SessionRecord => {
  const found = state.sessions.find((session) => session.sessionId === workerId);
  if (!found) throw new Error("Root session missing from family state.");
  return found;
};

function persist(): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, statePath);
}

// Every boot is a new generation: the supervisor asserts this advances past 1
// once a killed worker has been recovered.
const root = rootSession();
root.generation += 1;
root.messages.push(message("system", `Worker generation ${root.generation} started.`));
persist();

let shuttingDown = false;

const server = new WorkerProtocolServer({
  workerId,
  socketPath,
  descriptorPath,
  token,
  generation: root.generation,
  commandHandler: async (method, payload) => {
    const input = payload.length ? JSON.parse(payload.toString("utf8")) : {};

    if (method === "spawn_child") {
      const parentId = typeof input.parentSessionId === "string" ? input.parentSessionId : workerId;
      const parent = state.sessions.find((session) => session.sessionId === parentId);
      if (!parent) throw new Error(`Unknown parent session: ${parentId}`);

      const task = String(input.task ?? "");
      const child: SessionRecord = {
        sessionId: randomUUID(),
        parentSessionId: parentId,
        name: typeof input.name === "string" ? input.name : "child",
        generation: 1,
        childSessionIds: [],
        messages: [
          message("user", task),
          message("assistant", `Accepted task: ${task}`),
        ],
        createdAt: new Date().toISOString(),
      };

      state.sessions.push(child);
      parent.childSessionIds.push(child.sessionId);
      parent.messages.push(message("system", `Spawned child ${child.sessionId} for: ${task}`));
      persist();
      return child;
    }

    if (method === "list_sessions") return { sessions: state.sessions };

    if (method === "state") {
      const sessionId = typeof input.sessionId === "string" ? input.sessionId : workerId;
      const session = state.sessions.find((item) => item.sessionId === sessionId);
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      return session;
    }

    if (method === "ping") return { ok: true };

    if (method === "shutdown") {
      if (!shuttingDown) {
        shuttingDown = true;
        setTimeout(() => void shutdown(), 25);
      }
      return { shuttingDown: true };
    }

    throw new Error(`Unknown session worker method: ${method}`);
  },
  snapshotProvider: async () => ({
    workerId,
    rootSessionId: workerId,
    sessions: state.sessions,
    capturedAt: new Date().toISOString(),
  }),
});

async function shutdown(): Promise<void> {
  shuttingDown = true;
  persist();
  await server.stop().catch(() => undefined);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

await server.start();
