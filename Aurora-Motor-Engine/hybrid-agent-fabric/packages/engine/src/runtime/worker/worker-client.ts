import { createConnection, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { encodeWorkerFrame, WorkerFrameDecoder, type WorkerFrame } from "./framing.js";
import type { WorkerCursor, WorkerDescriptor } from "./worker-server.js";

interface PendingRequest {
  resolve: (frame: WorkerFrame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface SnapshotAssembly {
  chunks: Buffer[];
  expectedChunks: number;
  expectedBytes: number;
}

export interface WorkerEvent {
  eventType: string;
  cursor: WorkerCursor;
  payload: Buffer;
}

export interface AttachResult {
  replay: "complete" | "partial" | "unavailable";
  cursor: WorkerCursor;
  snapshot?: Buffer;
}

export class WorkerProtocolClient {
  private socket: Socket | undefined;
  private readonly decoder = new WorkerFrameDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly snapshots = new Map<string, SnapshotAssembly>();
  private readonly snapshotWaiters = new Map<string, { resolve: (value: Buffer) => void; reject: (error: Error) => void }>();
  private readonly eventListeners = new Set<(event: WorkerEvent) => void>();
  private readonly resyncListeners = new Set<(cursor: WorkerCursor) => void>();
  private authPromise: Promise<void> | undefined;
  private authResolve: (() => void) | undefined;
  private authReject: ((error: Error) => void) | undefined;
  private currentCursor: WorkerCursor = { generation: 0, sequence: 0 };

  constructor(readonly descriptor: WorkerDescriptor) {}

  static async fromDescriptorFile(path: string): Promise<WorkerProtocolClient> {
    const descriptor = JSON.parse(await readFile(path, "utf8")) as WorkerDescriptor;
    if (descriptor.schemaVersion !== 1) throw new Error("Unsupported worker descriptor version.");
    return new WorkerProtocolClient(descriptor);
  }

  get cursor(): WorkerCursor {
    return { ...this.currentCursor };
  }

  onEvent(listener: (event: WorkerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onResyncRequired(listener: (cursor: WorkerCursor) => void): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  async connect(timeoutMs = 5000): Promise<void> {
    if (this.socket && !this.socket.destroyed) return await this.authPromise;
    this.authPromise = new Promise<void>((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
    });
    const socket = createConnection(this.descriptor.socketPath);
    this.socket = socket;
    socket.setNoDelay(true);
    const timer = setTimeout(() => socket.destroy(new Error("Worker connection timeout.")), timeoutMs);
    timer.unref();
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.write(encodeWorkerFrame({ type: "auth", token: this.descriptor.token }));
    });
    socket.on("data", (chunk) => {
      try {
        for (const frame of this.decoder.push(chunk)) this.handle(frame);
      } catch (error) {
        socket.destroy(error as Error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      this.authReject?.(error);
      this.failPending(error);
    });
    socket.once("close", () => {
      this.failPending(new Error("Worker connection closed."));
      this.socket = undefined;
      this.authPromise = undefined;
      this.decoder.reset();
    });
    return await this.authPromise;
  }

  async ping(timeoutMs = 3000): Promise<WorkerCursor> {
    const frame = await this.request({ type: "ping" }, undefined, timeoutMs);
    return this.cursorFrom(frame);
  }

  async command(method: string, payload: Buffer | string | object = Buffer.alloc(0), timeoutMs = 120_000): Promise<Buffer> {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
    const frame = await this.request({ type: "command", method }, body, timeoutMs);
    if (frame.header.ok !== true) {
      const error = new Error(frame.payload.toString("utf8") || "Worker command failed.");
      error.name = typeof frame.header.errorClass === "string" ? frame.header.errorClass : "WorkerCommandError";
      throw error;
    }
    return frame.payload;
  }

  async attach(cursor: WorkerCursor, timeoutMs = 30_000): Promise<AttachResult> {
    const requestId = randomUUID();
    await this.connect();
    const attachPromise = this.waitFor(requestId, timeoutMs);
    const snapshotPromise = this.waitForSnapshot(requestId, timeoutMs);
    this.write({ type: "attach", requestId, generation: cursor.generation, sequence: cursor.sequence });
    const frame = await attachPromise;
    const replay = String(frame.header.replay) as AttachResult["replay"];
    const result: AttachResult = { replay, cursor: this.cursorFrom(frame) };
    if (replay !== "complete") result.snapshot = await snapshotPromise;
    else this.cancelSnapshotWaiter(requestId);
    return result;
  }

  async snapshot(timeoutMs = 30_000): Promise<{ cursor: WorkerCursor; snapshot: Buffer }> {
    const requestId = randomUUID();
    await this.connect();
    const snapshotPromise = this.waitForSnapshot(requestId, timeoutMs);
    this.write({ type: "snapshot_request", requestId });
    return { cursor: this.cursor, snapshot: await snapshotPromise };
  }

  private async request(header: Record<string, unknown>, payload?: Buffer, timeoutMs = 30_000): Promise<WorkerFrame> {
    const requestId = randomUUID();
    await this.connect();
    const promise = this.waitFor(requestId, timeoutMs);
    this.write({ ...header, requestId }, payload);
    return await promise;
  }

  private waitFor(requestId: string, timeoutMs: number): Promise<WorkerFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Worker request ${requestId} timed out.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  private waitForSnapshot(requestId: string, timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.snapshotWaiters.delete(requestId);
        this.snapshots.delete(requestId);
        reject(new Error(`Worker snapshot ${requestId} timed out.`));
      }, timeoutMs);
      timer.unref();
      this.snapshotWaiters.set(requestId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  private cancelSnapshotWaiter(requestId: string): void {
    const waiter = this.snapshotWaiters.get(requestId);
    if (waiter) waiter.resolve(Buffer.alloc(0));
    this.snapshotWaiters.delete(requestId);
    this.snapshots.delete(requestId);
  }

  private handle(frame: WorkerFrame): void {
    const type = frame.header.type;
    if (type === "auth_ok") {
      this.currentCursor = this.cursorFrom(frame);
      this.authResolve?.();
      return;
    }
    if (type === "event") {
      const cursor = this.cursorFrom(frame);
      if (cursor.generation !== this.currentCursor.generation || cursor.sequence > this.currentCursor.sequence) {
        this.currentCursor = cursor;
        const event = { eventType: String(frame.header.eventType ?? "event"), cursor, payload: frame.payload };
        for (const listener of this.eventListeners) listener(event);
      }
      return;
    }
    if (type === "resync_required") {
      const cursor = this.cursorFrom(frame);
      for (const listener of this.resyncListeners) listener(cursor);
      return;
    }
    if (type === "snapshot_begin") {
      const requestId = String(frame.header.requestId ?? "");
      this.snapshots.set(requestId, {
        chunks: [],
        expectedChunks: Number(frame.header.chunks ?? 0),
        expectedBytes: Number(frame.header.bytes ?? 0),
      });
      return;
    }
    if (type === "snapshot_chunk") {
      const requestId = String(frame.header.requestId ?? "");
      const assembly = this.snapshots.get(requestId);
      if (assembly) assembly.chunks[Number(frame.header.index ?? assembly.chunks.length)] = frame.payload;
      return;
    }
    if (type === "snapshot_end") {
      const requestId = String(frame.header.requestId ?? "");
      const assembly = this.snapshots.get(requestId);
      const waiter = this.snapshotWaiters.get(requestId);
      if (!assembly || !waiter) return;
      const snapshot = Buffer.concat(assembly.chunks);
      this.snapshots.delete(requestId);
      this.snapshotWaiters.delete(requestId);
      this.currentCursor = this.cursorFrom(frame);
      if (assembly.chunks.filter(Boolean).length !== assembly.expectedChunks || snapshot.length !== assembly.expectedBytes) {
        waiter.reject(new Error("Worker snapshot was incomplete."));
      } else waiter.resolve(snapshot);
      return;
    }
    const requestId = typeof frame.header.requestId === "string" ? frame.header.requestId : undefined;
    if (requestId) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        this.currentCursor = this.cursorFrom(frame, this.currentCursor);
        pending.resolve(frame);
      }
    }
  }

  private cursorFrom(frame: WorkerFrame, fallback: WorkerCursor = this.currentCursor): WorkerCursor {
    const generation = Number(frame.header.generation ?? fallback.generation);
    const sequence = Number(frame.header.sequence ?? fallback.sequence);
    return { generation, sequence };
  }

  private write(header: Record<string, unknown>, payload?: Buffer): void {
    if (!this.socket || this.socket.destroyed) throw new Error("Worker is not connected.");
    this.socket.write(encodeWorkerFrame(header as any, payload));
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.snapshotWaiters.values()) waiter.reject(error);
    this.snapshotWaiters.clear();
    this.snapshots.clear();
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }
}
