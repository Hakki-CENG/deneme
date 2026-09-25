#!/usr/bin/env node
/**
 * Minimal detached worker — test fixture.
 *
 * Holds a single counter in memory and serves it over the worker protocol so
 * `WorkerProcessManager` adoption/recovery can be tested without booting a full
 * `HybridAgentEngine`.
 *
 * Commands:
 *   increment { by?: number } -> { value, pid }
 *   get                       -> { value, pid }
 *   shutdown                  -> { shuttingDown: true }, then exits
 */

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

let value = 0;
let shuttingDown = false;

const server = new WorkerProtocolServer({
  workerId,
  socketPath,
  descriptorPath,
  token,
  commandHandler: async (method, payload) => {
    if (method === "increment") {
      const input = payload.length ? JSON.parse(payload.toString("utf8")) : {};
      value += typeof input.by === "number" ? input.by : 1;
      return { value, pid: process.pid };
    }
    if (method === "get") return { value, pid: process.pid };
    if (method === "ping") return { ok: true };
    if (method === "shutdown") {
      if (!shuttingDown) {
        shuttingDown = true;
        setTimeout(() => void shutdown(), 25);
      }
      return { shuttingDown: true };
    }
    throw new Error(`Unknown fixture worker method: ${method}`);
  },
  snapshotProvider: async () => ({ workerId, value, pid: process.pid }),
});

async function shutdown(): Promise<void> {
  shuttingDown = true;
  await server.stop().catch(() => undefined);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

await server.start();
