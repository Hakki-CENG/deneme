/**
 * Detached session worker — end-to-end against the real entrypoint.
 *
 * `apps/session-worker` had 185 lines and zero tests. The supervision protocol
 * itself is well covered by `packages/engine/test/worker-protocol.test.ts`, but
 * those tests drive an in-process `WorkerProtocolServer` plus an explicitly
 * engine-free fixture (`test/fixtures/detached-session-worker.ts`). Nothing
 * exercised the shipped entrypoint: its required-env validation, its engine
 * wiring, the root-session bootstrap, or the cross-family command guard.
 *
 * This spawns `dist/main.js` for real, connects over the real Unix socket with
 * the real `WorkerProtocolClient`, and drives the real method dispatch. The
 * engine runs on the mock provider with a throwaway home, so no network and no
 * repo state is involved.
 *
 * `spawn_child` / `fork` are deliberately not driven here: they spawn further
 * detached OS processes, which is supervision territory already covered by
 * `worker-process-manager.test.ts`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkerProtocolClient } from "@haf/engine";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const WORKER_MAIN = join(REPO_ROOT, "apps", "session-worker", "dist", "main.js");

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

interface Harness {
  worker: ChildProcess;
  client: WorkerProtocolClient;
  workerId: string;
  socketPath: string;
  descriptorPath: string;
  home: string;
  stderr: string;
}

async function startWorker(overrides: Record<string, string | undefined> = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "session-worker-"));
  const workerId = `test-worker-${randomUUID().slice(0, 8)}`;
  const socketPath = join(home, "worker.sock");
  const descriptorPath = join(home, "worker.json");

  let stderr = "";
  const worker = spawn(process.execPath, [WORKER_MAIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HAF_WORKER_ID: workerId,
      HAF_WORKER_TOKEN: `test-token-${randomUUID()}`,
      HAF_WORKER_SOCKET: socketPath,
      HAF_WORKER_DESCRIPTOR: descriptorPath,
      HAF_WORKER_HOME: home,
      HAF_WORKER_TENANT_ID: "local",
      HAF_MODEL_PROVIDER: "mock",
      ...overrides,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  worker.stderr?.setEncoding("utf8");
  worker.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  await waitFor(() => existsSync(descriptorPath), 90_000, `descriptor at ${descriptorPath}`);

  const client = await WorkerProtocolClient.fromDescriptorFile(descriptorPath);
  await client.connect(30_000);

  return { worker, client, workerId, socketPath, descriptorPath, home, get stderr() { return stderr; } } as Harness;
}

async function stopWorker(harness: Harness | undefined): Promise<void> {
  if (!harness) return;
  harness.client.close();
  if (harness.worker.exitCode === null && harness.worker.signalCode === null) {
    harness.worker.kill("SIGTERM");
    await Promise.race([
      new Promise((done) => harness.worker.once("exit", done)),
      sleep(15_000).then(() => harness.worker.kill("SIGKILL")),
    ]);
  }
  await rm(harness.home, { recursive: true, force: true });
}

describe("session-worker entrypoint", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startWorker();
  }, 180_000);

  afterAll(async () => {
    await stopWorker(harness);
  });

  it("writes a usable descriptor and answers a protocol ping", async () => {
    const descriptor = JSON.parse(await readFile(harness.descriptorPath, "utf8")) as {
      workerId: string;
      socketPath: string;
      token: string;
    };
    expect(descriptor.workerId).toBe(harness.workerId);
    expect(descriptor.socketPath).toBe(harness.socketPath);
    expect(descriptor.token).toBeTruthy();

    const cursor = await harness.client.ping(15_000);
    expect(cursor.generation).toBeGreaterThanOrEqual(1);
  });

  it("bootstraps the root session under the worker id", async () => {
    const state = JSON.parse((await harness.client.command("state")).toString()) as {
      sessionId: string;
      tenantId: string;
      generation: number;
    };
    expect(state.sessionId).toBe(harness.workerId);
    expect(state.tenantId).toBe("local");
    expect(state.generation).toBeGreaterThanOrEqual(1);
  });

  it("lists its own session family", async () => {
    const listed = JSON.parse((await harness.client.command("list_sessions")).toString()) as {
      sessions: Array<{ sessionId: string }>;
    };
    expect(listed.sessions.map((session) => session.sessionId)).toContain(harness.workerId);
  });

  it("returns approvals without any pending", async () => {
    const approvals = JSON.parse((await harness.client.command("approvals_list")).toString()) as {
      approvals: unknown[];
    };
    expect(Array.isArray(approvals.approvals)).toBe(true);
  });

  it("rejects a command aimed at a session outside this worker family", async () => {
    // This is the guard that keeps one detached worker from driving another
    // tenant's session; it has never been exercised before.
    const envelope = {
      protocolVersion: 1,
      commandId: randomUUID(),
      clientId: "worker-test",
      tenantId: "local",
      sessionId: randomUUID(),
      kind: "session.prompt",
      source: "api",
      issuedAt: new Date().toISOString(),
      payload: { text: "should not be dispatched" },
    };
    await expect(harness.client.command("dispatch", envelope)).rejects.toThrow(
      /outside this worker family/,
    );
  });

  it("rejects an unknown method by name", async () => {
    await expect(harness.client.command("not_a_real_method", {})).rejects.toThrow(
      /Unknown session worker method/,
    );
  });

  it("shuts down cleanly when asked, and exits", async () => {
    const reply = JSON.parse((await harness.client.command("shutdown")).toString()) as {
      shuttingDown: boolean;
    };
    expect(reply.shuttingDown).toBe(true);

    const code = await Promise.race([
      new Promise<number | null>((done) => {
        harness.worker.once("exit", (exitCode) => done(exitCode));
        if (harness.worker.exitCode !== null) done(harness.worker.exitCode);
      }),
      sleep(30_000).then(() => "timeout" as const),
    ]);
    expect(code, "worker did not exit after the shutdown command").not.toBe("timeout");
    expect(code).toBe(0);
  }, 60_000);
});

describe("session-worker startup validation", () => {
  it("refuses to start without a worker token and says which variable is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "session-worker-noenv-"));
    let stderr = "";
    const worker = spawn(process.execPath, [WORKER_MAIN], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HAF_WORKER_ID: "no-token-worker",
        HAF_WORKER_SOCKET: join(home, "worker.sock"),
        HAF_WORKER_DESCRIPTOR: join(home, "worker.json"),
        HAF_WORKER_HOME: home,
        HAF_MODEL_PROVIDER: "mock",
        HAF_WORKER_TOKEN: undefined,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    worker.stderr?.setEncoding("utf8");
    worker.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const code = await Promise.race([
      new Promise<number | null>((done) => worker.once("exit", (exitCode) => done(exitCode))),
      sleep(30_000).then(() => "timeout" as const),
    ]);
    expect(code, "worker started despite a missing required variable").not.toBe("timeout");
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/HAF_WORKER_TOKEN is required/);

    await rm(home, { recursive: true, force: true });
  }, 60_000);
});
