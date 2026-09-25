import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { JsonValue } from "../types.js";
import { asJsonValue } from "../util/json.js";

export interface KernelExecutionResult {
  stdout: string;
  stderr: string;
  result: string | null;
  resultType: string | null;
}

interface PendingFrame {
  type: string;
  executionId?: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abort?: () => void;
  signal?: AbortSignal;
}

export interface KernelHostRequestMetadata {
  requestId: string;
  executionId: string;
  kernelGeneration: string;
}

export type KernelHostRequestHandler = (
  capability: string,
  argumentsValue: Record<string, JsonValue>,
  metadata: KernelHostRequestMetadata,
) => Promise<JsonValue>;

export interface KernelLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface KernelClientOptions {
  pythonExecutable?: string;
  serverScript: string;
  cwd: string;
  launch?: KernelLaunchSpec;
  hostRequest: KernelHostRequestHandler;
  kernelGeneration?: string;
  startupTimeoutMs?: number;
  maxProtocolFrameChars?: number;
  maxHostRequestsPerExecution?: number;
  onTerminate?: (error: Error) => void;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Generation-fenced JSONL client for the persistent Python process.
 * Protocol timeout/cancellation kills the process because CPython execution is
 * synchronous and cannot otherwise guarantee that stale code stopped running.
 */
export class KernelClient {
  private process?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingFrame>();
  private readonly hostResponses = new Map<string, Promise<object>>();
  private ready?: Promise<void>;
  private closed = false;
  private activeExecution: { executionId: string; hostToken: string; hostRequests: number } | undefined;
  private terminationNotified = false;
  readonly generation: string;

  constructor(private readonly options: KernelClientOptions) {
    this.generation = options.kernelGeneration ?? randomUUID();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const launch = this.options.launch ?? {
        command: this.options.pythonExecutable ?? "python3",
        args: [this.options.serverScript],
        cwd: this.options.cwd,
        env: { PATH: process.env.PATH ?? "", HOME: this.options.cwd, PYTHONUNBUFFERED: "1" },
      };
      const child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env ?? { PATH: process.env.PATH ?? "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.process = child;
      const timeout = setTimeout(() => {
        const error = new Error("Python kernel startup timed out.");
        reject(error);
        this.terminate(error);
      }, this.options.startupTimeoutMs ?? 10_000);
      timeout.unref();
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (line.length > (this.options.maxProtocolFrameChars ?? 1_000_000)) {
          this.terminate(new Error("Python kernel protocol frame exceeded the configured limit."));
          return;
        }
        void this.handleLine(line, () => {
          clearTimeout(timeout);
          resolve();
        }).catch((error) => {
          const failure = error instanceof Error ? error : new Error(String(error));
          clearTimeout(timeout);
          reject(failure);
          this.terminate(failure);
        });
      });
      child.stderr.on("data", (chunk) => {
        if (!this.closed) process.stderr.write(`[kernel] ${chunk.toString("utf8")}`);
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
        this.terminate(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        this.terminate(new Error(`Python kernel exited code=${code} signal=${signal}`));
      });
    });
    return this.ready;
  }

  private hostResponseKey(metadata: KernelHostRequestMetadata): string {
    return `${metadata.kernelGeneration}:${metadata.executionId}:${metadata.requestId}`;
  }

  private async handleLine(line: string, onReady: () => void): Promise<void> {
    let frame: any;
    try {
      frame = JSON.parse(line);
    } catch {
      throw new Error("Python kernel emitted malformed protocol JSON.");
    }
    if (frame.type === "ready") {
      if (frame.protocolVersion !== 2) throw new Error(`Unsupported Python kernel protocol version: ${frame.protocolVersion}`);
      onReady();
      return;
    }
    if (frame.type === "host_request") {
      await this.handleHostRequest(frame);
      return;
    }
    if (frame.type === "result") {
      const id = String(frame.id);
      const pending = this.pending.get(id);
      if (!pending) return; // A late frame after cancellation can never revive the request.
      if (pending.executionId && frame.executionId !== pending.executionId) {
        throw new Error("Python kernel result execution identity mismatch.");
      }
      this.clearPending(id, pending);
      if (pending.executionId && this.activeExecution?.executionId === pending.executionId) this.activeExecution = undefined;
      if (frame.ok) pending.resolve(frame);
      else pending.reject(new Error(`${frame.error ?? "Kernel execution failed"}\n${frame.traceback ?? ""}`));
    }
  }

  private async handleHostRequest(frame: any): Promise<void> {
    const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
    const executionId = typeof frame.executionId === "string" ? frame.executionId : "";
    const kernelGeneration = typeof frame.kernelGeneration === "string" ? frame.kernelGeneration : "";
    const hostToken = typeof frame.hostToken === "string" ? frame.hostToken : "";
    const active = this.activeExecution;
    const metadata = { requestId, executionId, kernelGeneration };
    if (!requestId || !executionId || !kernelGeneration || !hostToken ||
        kernelGeneration !== this.generation || !active || executionId !== active.executionId ||
        !constantTimeEqual(hostToken, active.hostToken)) {
      this.safeWrite({ type: "host_response", requestId, executionId, kernelGeneration, ok: false, error: "stale_or_unauthenticated_host_request" });
      return;
    }
    const pendingExecution = [...this.pending.values()].some((pending) => pending.type === "execute" && pending.executionId === executionId);
    if (!pendingExecution) {
      this.safeWrite({ type: "host_response", requestId, executionId, kernelGeneration, ok: false, error: "execution_is_no_longer_current" });
      return;
    }
    const key = this.hostResponseKey(metadata);
    // The cache holds the in-flight promise, not just the settled response, so
    // duplicate frames that arrive *while the capability handler is still
    // running* are folded into the same invocation. Caching only after the
    // await would let a kernel replay a frame fast enough to execute the
    // side-effecting capability twice.
    const cached = this.hostResponses.get(key);
    if (cached) {
      this.safeWrite(await cached);
      return;
    }
    active.hostRequests++;
    if (active.hostRequests > (this.options.maxHostRequestsPerExecution ?? 1000)) {
      this.safeWrite({ type: "host_response", requestId, executionId, kernelGeneration, ok: false, error: "host_request_limit_exceeded" });
      return;
    }
    // Never rejects: failures are converted into an `ok: false` response frame,
    // so a cached entry can always be awaited safely.
    const work = (async (): Promise<object> => {
      try {
        const result = await this.options.hostRequest(String(frame.capability), frame.arguments ?? {}, metadata);
        return { type: "host_response", requestId, executionId, kernelGeneration, ok: true, result };
      } catch (error) {
        return {
          type: "host_response",
          requestId,
          executionId,
          kernelGeneration,
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
        };
      }
    })();
    this.hostResponses.set(key, work);
    while (this.hostResponses.size > 2000) this.hostResponses.delete(this.hostResponses.keys().next().value!);
    this.safeWrite(await work);
  }

  private safeWrite(frame: unknown): void {
    if (!this.process || this.closed || this.process.stdin.destroyed) return;
    this.process.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private write(frame: unknown): void {
    if (!this.process || this.closed || this.process.stdin.destroyed) throw new Error("Python kernel is not running.");
    this.process.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private clearPending(id: string, pending: PendingFrame): void {
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abort!);
    this.pending.delete(id);
  }

  private failPending(error: Error): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    this.activeExecution = undefined;
    for (const [id, pending] of this.pending) {
      this.clearPending(id, pending);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private terminate(error: Error): void {
    if (!this.terminationNotified) {
      this.terminationNotified = true;
      this.options.onTerminate?.(error);
    }
    if (!this.closed) {
      this.closed = true;
      try {
        if (this.process?.pid && process.platform !== "win32") process.kill(-this.process.pid, "SIGKILL");
        else this.process?.kill("SIGKILL");
      } catch {
        this.process?.kill("SIGKILL");
      }
    }
    this.failPending(error);
  }

  private async request(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    options: { signal?: AbortSignal; executionId?: string } = {},
  ): Promise<any> {
    await this.start();
    if (this.closed) throw new Error("Python kernel is closed.");
    if (options.signal?.aborted) {
      const error = new DOMException(`Kernel ${type} was cancelled.`, "AbortError");
      this.terminate(error);
      throw error;
    }
    const id = randomUUID();
    return await new Promise((resolve, reject) => {
      const failCurrent = (error: Error) => {
        const pending = this.pending.get(id);
        if (pending) this.clearPending(id, pending);
        reject(error);
        this.terminate(error);
      };
      const timer = setTimeout(() => failCurrent(new Error(`Kernel ${type} timed out after ${timeoutMs} ms.`)), timeoutMs);
      timer.unref();
      const abort = () => failCurrent(new DOMException(`Kernel ${type} was cancelled.`, "AbortError"));
      const pending: PendingFrame = {
        type,
        ...(options.executionId ? { executionId: options.executionId } : {}),
        resolve,
        reject,
        timer,
        ...(options.signal ? { signal: options.signal, abort } : {}),
      };
      this.pending.set(id, pending);
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.write({ type, id, ...payload });
      } catch (error) {
        failCurrent(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async execute(code: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<KernelExecutionResult> {
    const executionId = randomUUID();
    const hostToken = randomBytes(32).toString("base64url");
    this.activeExecution = { executionId, hostToken, hostRequests: 0 };
    const frame = await this.request("execute", {
      code,
      executionId,
      kernelGeneration: this.generation,
      hostToken,
    }, timeoutMs, { executionId, ...(signal ? { signal } : {}) });
    return {
      stdout: String(frame.stdout ?? ""),
      stderr: String(frame.stderr ?? ""),
      result: frame.result === null || frame.result === undefined ? null : String(frame.result),
      resultType: frame.resultType === null || frame.resultType === undefined ? null : String(frame.resultType),
    };
  }

  async snapshot(path: string): Promise<JsonValue> {
    return asJsonValue((await this.request("snapshot", { path }, 10_000)).result);
  }

  async restore(path: string): Promise<JsonValue> {
    return asJsonValue((await this.request("restore", { path }, 10_000)).result);
  }

  abort(reason = "Kernel execution aborted by host."): void {
    this.terminate(new DOMException(reason, "AbortError"));
  }

  async close(): Promise<void> {
    if (!this.process || this.closed) return;
    try {
      await this.request("shutdown", {}, 2000);
    } catch {
      this.terminate(new Error("Python kernel shutdown failed."));
    }
    this.closed = true;
  }
}
