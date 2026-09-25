import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type { CapabilityBroker } from "../capabilities/capability-broker.js";
import type { CapabilityContext } from "../types.js";
import { AsyncMutex } from "../util/async-mutex.js";
import { KernelClient, type KernelExecutionResult, type KernelLaunchSpec } from "./kernel-client.js";

interface ManagedKernel {
  client: KernelClient;
  mutex: AsyncMutex;
  activeContext: CapabilityContext | undefined;
  activeAbort: AbortController | undefined;
  snapshotPath: string;
}

export interface KernelIsolationOptions {
  kind: "local" | "docker" | "disabled";
  dockerImage?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
}

export class KernelManager {
  private readonly kernels = new Map<string, ManagedKernel>();

  constructor(
    private readonly serverScript: string,
    private readonly stateRoot: string,
    private readonly broker: CapabilityBroker,
    private readonly isolation: KernelIsolationOptions = { kind: "local" },
  ) {}

  private async launchSpec(sessionId: string, workspacePath: string): Promise<{
    launch?: KernelLaunchSpec;
    snapshotPath: string;
  }> {
    const stateDirectory = resolve(this.stateRoot, "kernels");
    await mkdir(stateDirectory, { recursive: true });
    if (this.isolation.kind === "local") {
      return { snapshotPath: join(stateDirectory, `${sessionId}.json`) };
    }
    if (this.isolation.kind === "disabled") {
      throw new Error("The persistent Python kernel is disabled for this sandbox backend to prevent execution-boundary bypass.");
    }

    const hostWorkspace = resolve(workspacePath);
    const hostScript = resolve(this.serverScript);
    const uid = typeof process.getuid === "function" ? process.getuid() : 65534;
    const gid = typeof process.getgid === "function" ? process.getgid() : 65534;
    const containerSnapshotPath = `/state/${sessionId}.json`;
    const args = [
      "run", "--rm", "--init", "-i",
      "--network", "none",
      "--memory", this.isolation.memory ?? "1g",
      "--cpus", this.isolation.cpus ?? "1",
      "--pids-limit", String(this.isolation.pidsLimit ?? 128),
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--user", `${uid}:${gid}`,
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
      "-v", `${hostWorkspace}:/workspace:rw`,
      "-v", `${stateDirectory}:/state:rw`,
      "-v", `${hostScript}:/opt/haf/kernel_server.py:ro`,
      "-w", "/workspace",
      "-e", "HOME=/tmp",
      "-e", "PYTHONUNBUFFERED=1",
      this.isolation.dockerImage ?? "python:3.13-slim",
      "python3", "/opt/haf/kernel_server.py",
    ];
    return {
      launch: {
        command: "docker",
        args,
        cwd: hostWorkspace,
        env: { PATH: process.env.PATH ?? "" },
      },
      snapshotPath: containerSnapshotPath,
    };
  }

  private async get(sessionId: string, workspacePath: string): Promise<ManagedKernel> {
    const existing = this.kernels.get(sessionId);
    if (existing) return existing;
    await mkdir(workspacePath, { recursive: true });
    const launch = await this.launchSpec(sessionId, workspacePath);
    const managed = {} as ManagedKernel;
    const client = new KernelClient({
      serverScript: this.serverScript,
      cwd: workspacePath,
      ...(launch.launch ? { launch: launch.launch } : {}),
      hostRequest: async (capability, argumentsValue, metadata) => {
        const context = managed.activeContext;
        if (!context || metadata.kernelGeneration !== managed.client.generation) {
          throw new Error("Kernel host request arrived outside the current generation.");
        }
        managed.activeAbort?.signal.throwIfAborted();
        return await this.broker.execute(capability, argumentsValue, {
          ...context,
          ...(managed.activeAbort ? { signal: managed.activeAbort.signal } : {}),
          toolCallId: metadata.requestId,
          idempotencyKey: `${context.idempotencyKey}:kernel:${metadata.kernelGeneration}:${metadata.executionId}:${metadata.requestId}`,
        });
      },
      onTerminate: () => managed.activeAbort?.abort(),
    });
    managed.client = client;
    managed.mutex = new AsyncMutex();
    managed.snapshotPath = launch.snapshotPath;
    this.kernels.set(sessionId, managed);
    try {
      await client.start();
      await client.restore(managed.snapshotPath);
      return managed;
    } catch (error) {
      this.kernels.delete(sessionId);
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async execute(code: string, context: CapabilityContext): Promise<KernelExecutionResult> {
    const kernel = await this.get(context.sessionId, context.workspacePath);
    return await kernel.mutex.runExclusive(async () => {
      const abort = new AbortController();
      const forwardAbort = () => abort.abort(context.signal?.reason);
      context.signal?.addEventListener("abort", forwardAbort, { once: true });
      kernel.activeAbort = abort;
      kernel.activeContext = { ...context, signal: abort.signal };
      try {
        const result = await kernel.client.execute(code, 120_000, abort.signal);
        await kernel.client.snapshot(kernel.snapshotPath);
        return result;
      } catch (error) {
        if (kernel.client.isClosed) this.kernels.delete(context.sessionId);
        throw error;
      } finally {
        context.signal?.removeEventListener("abort", forwardAbort);
        kernel.activeContext = undefined;
        kernel.activeAbort = undefined;
      }
    });
  }

  async close(sessionId: string): Promise<void> {
    const kernel = this.kernels.get(sessionId);
    if (!kernel) return;
    await kernel.client.close();
    this.kernels.delete(sessionId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.kernels.keys()].map((sessionId) => this.close(sessionId)));
  }
}
