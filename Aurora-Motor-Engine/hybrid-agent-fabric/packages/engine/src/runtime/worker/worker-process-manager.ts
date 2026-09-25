import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { WorkerDescriptor } from "./worker-server.js";
import { WorkerProtocolClient } from "./worker-client.js";
import { atomicWrite } from "../../util/atomic-file.js";

export interface SpawnWorkerOptions {
  workerId?: string;
  entrypoint: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

interface WorkerLaunchManifest {
  schemaVersion: 1;
  workerId: string;
  entrypoint: string;
  args: string[];
  env: Record<string, string>;
  createdAt: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class WorkerProcessManager {
  private readonly clients = new Map<string, WorkerProtocolClient>();

  constructor(private readonly rootPath: string) {}

  private descriptorPath(workerId: string): string {
    return join(this.rootPath, "workers", `${workerId}.json`);
  }

  private launchManifestPath(workerId: string): string {
    return join(this.rootPath, "worker-launches", `${workerId}.json`);
  }

  private persistedEnvironment(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
    const allowed = new Set([
      "HAF_WORKER_HOME", "HAF_WORKER_TENANT_ID", "HAF_WORKER_SESSION_NAME",
      "HAF_MODEL_PROVIDER", "HAF_MODEL_BASE_URL", "HAF_MODEL_NAME",
      "HAF_SANDBOX_BACKEND", "HAF_AUTO_APPROVE_WORKSPACE", "HAF_ALLOW_PROCESS",
      "HAF_KERNEL_SERVER", "HAF_WORKER_REPLAY_CAPACITY",
    ]);
    return Object.fromEntries(
      Object.entries(env ?? {}).filter((entry): entry is [string, string] => allowed.has(entry[0]) && typeof entry[1] === "string"),
    );
  }

  private socketPath(workerId: string): string {
    // Unix-domain sockets are commonly limited to ~108 bytes. Hash the full
    // manager scope + worker id into a short, collision-resistant /tmp path.
    const digest = createHash("sha256").update(`${this.rootPath}:${workerId}`).digest("hex").slice(0, 24);
    return join(tmpdir(), `haf-worker-${digest}.sock`);
  }

  async spawn(options: SpawnWorkerOptions): Promise<WorkerProtocolClient> {
    const workerId = options.workerId ?? randomUUID();
    const descriptorPath = this.descriptorPath(workerId);
    const manifestPath = this.launchManifestPath(workerId);
    const socketPath = this.socketPath(workerId);
    const token = randomBytes(32).toString("base64url");
    const logPath = join(this.rootPath, "worker-logs", `${workerId}.log`);
    await Promise.all([
      mkdir(dirname(descriptorPath), { recursive: true }),
      mkdir(dirname(manifestPath), { recursive: true }),
      mkdir(dirname(socketPath), { recursive: true }),
      mkdir(dirname(logPath), { recursive: true }),
    ]);
    await Promise.all([rm(descriptorPath, { force: true }), rm(socketPath, { force: true })]);
    const manifest: WorkerLaunchManifest = {
      schemaVersion: 1,
      workerId,
      entrypoint: options.entrypoint,
      args: [...(options.args ?? [])],
      env: this.persistedEnvironment(options.env),
      createdAt: new Date().toISOString(),
    };
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const logFd = openSync(logPath, "a", 0o600);
    const child = spawn(process.execPath, [options.entrypoint, ...(options.args ?? [])], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        ...options.env,
        HAF_WORKER_ID: workerId,
        HAF_WORKER_TOKEN: token,
        HAF_WORKER_SOCKET: socketPath,
        HAF_WORKER_DESCRIPTOR: descriptorPath,
      },
    });
    closeSync(logFd);
    child.unref();
    const deadline = Date.now() + (options.startupTimeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      try {
        const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as WorkerDescriptor;
        if (descriptor.workerId !== workerId || descriptor.token !== token || !processAlive(descriptor.pid)) {
          throw new Error("Worker descriptor identity mismatch.");
        }
        const client = new WorkerProtocolClient(descriptor);
        await client.connect();
        this.clients.set(workerId, client);
        return client;
      } catch (error) {
        let daemonAlive = false;
        try {
          const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as WorkerDescriptor;
          daemonAlive = descriptor.workerId === workerId && descriptor.token === token && processAlive(descriptor.pid);
        } catch {}
        if (!processAlive(child.pid!) && !daemonAlive) throw new Error(`Detached worker ${workerId} exited during startup.`);
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(`Detached worker ${workerId} startup timed out.`);
  }

  async adopt(workerId: string): Promise<WorkerProtocolClient> {
    const current = this.clients.get(workerId);
    if (current) {
      try {
        await current.ping();
        return current;
      } catch {
        current.close();
        this.clients.delete(workerId);
      }
    }
    const descriptor = JSON.parse(await readFile(this.descriptorPath(workerId), "utf8")) as WorkerDescriptor;
    if (!processAlive(descriptor.pid)) {
      await this.cleanupDescriptor(descriptor);
      throw new Error(`Worker ${workerId} is not alive.`);
    }
    const client = new WorkerProtocolClient(descriptor);
    await client.connect();
    await client.ping();
    this.clients.set(workerId, client);
    return client;
  }

  async recover(workerId: string): Promise<WorkerProtocolClient> {
    try {
      return await this.adopt(workerId);
    } catch {
      const manifest = JSON.parse(await readFile(this.launchManifestPath(workerId), "utf8")) as WorkerLaunchManifest;
      if (manifest.schemaVersion !== 1 || manifest.workerId !== workerId) throw new Error("Invalid worker launch manifest.");
      return await this.spawn({
        workerId,
        entrypoint: manifest.entrypoint,
        args: manifest.args,
        env: manifest.env,
        startupTimeoutMs: 30_000,
      });
    }
  }

  async adoptAll(recoverStale = false): Promise<Array<{ workerId: string; status: "adopted" | "recovered" | "stale"; client?: WorkerProtocolClient }>> {
    const readJsonNames = async (directory: string): Promise<string[]> => {
      try {
        return (await readdir(directory)).filter((item) => item.endsWith(".json")).map((item) => item.slice(0, -5));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    };
    const workerIds = new Set([
      ...(await readJsonNames(join(this.rootPath, "workers"))),
      ...(await readJsonNames(join(this.rootPath, "worker-launches"))),
    ]);
    const output: Array<{ workerId: string; status: "adopted" | "recovered" | "stale"; client?: WorkerProtocolClient }> = [];
    for (const workerId of workerIds) {
      try {
        output.push({ workerId, status: "adopted", client: await this.adopt(workerId) });
      } catch {
        if (recoverStale) {
          try {
            output.push({ workerId, status: "recovered", client: await this.recover(workerId) });
            continue;
          } catch {}
        }
        output.push({ workerId, status: "stale" });
      }
    }
    return output;
  }

  async stop(workerId: string, force = false): Promise<void> {
    let client: WorkerProtocolClient | undefined;
    try {
      client = await this.adopt(workerId);
      if (!force) await client.command("shutdown", {}, 5000);
    } catch {
      // Force path below handles a dead/unresponsive worker.
    }
    client?.close();
    this.clients.delete(workerId);
    try {
      const descriptor = JSON.parse(await readFile(this.descriptorPath(workerId), "utf8")) as WorkerDescriptor;
      if (processAlive(descriptor.pid)) process.kill(descriptor.pid, force ? "SIGKILL" : "SIGTERM");
      await this.cleanupDescriptor(descriptor);
    } catch {}
    await rm(this.launchManifestPath(workerId), { force: true });
  }

  closeAttachments(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }

  private async cleanupDescriptor(descriptor: WorkerDescriptor): Promise<void> {
    await Promise.all([
      rm(this.descriptorPath(descriptor.workerId), { force: true }),
      rm(descriptor.socketPath, { force: true }),
    ]);
  }
}
