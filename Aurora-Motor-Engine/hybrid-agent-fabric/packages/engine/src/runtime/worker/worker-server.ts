import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite } from "../../util/atomic-file.js";
import { encodeWorkerFrame, WorkerFrameDecoder, type WorkerFrame, type WorkerFrameHeader } from "./framing.js";

export interface WorkerCursor {
  generation: number;
  sequence: number;
}

export interface WorkerDescriptor {
  schemaVersion: 1;
  workerId: string;
  pid: number;
  generation: number;
  socketPath: string;
  token: string;
  startedAt: string;
}

export interface WorkerCommandContext {
  clientId: string;
  requestId: string;
}

export interface WorkerServerOptions {
  workerId: string;
  generation?: number;
  socketPath: string;
  descriptorPath: string;
  token?: string;
  replayCapacity?: number;
  snapshotChunkBytes?: number;
  commandHandler: (method: string, payload: Buffer, context: WorkerCommandContext) => Promise<Buffer | string | object | null>;
  snapshotProvider: () => Promise<Buffer | string | object>;
}

interface SequencedEvent {
  generation: number;
  sequence: number;
  eventType: string;
  payload: Buffer;
}

interface Attachment {
  id: string;
  socket: Socket;
  decoder: WorkerFrameDecoder;
  authenticated: boolean;
  blocked: boolean;
  requiresResync: boolean;
}

function asBuffer(value: Buffer | string | object | null): Buffer {
  if (value === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.from(JSON.stringify(value), "utf8");
}

export class WorkerProtocolServer {
  private server: Server | undefined;
  private readonly attachments = new Map<string, Attachment>();
  private readonly replay: SequencedEvent[] = [];
  private sequence = 0;
  readonly descriptor: WorkerDescriptor;

  constructor(private readonly options: WorkerServerOptions) {
    this.descriptor = {
      schemaVersion: 1,
      workerId: options.workerId,
      pid: process.pid,
      generation: options.generation ?? 1,
      socketPath: options.socketPath,
      token: options.token ?? randomUUID(),
      startedAt: new Date().toISOString(),
    };
  }

  get cursor(): WorkerCursor {
    return { generation: this.descriptor.generation, sequence: this.sequence };
  }

  async start(): Promise<WorkerDescriptor> {
    if (this.server) return this.descriptor;
    await mkdir(dirname(this.options.socketPath), { recursive: true });
    await mkdir(dirname(this.options.descriptorPath), { recursive: true });
    await rm(this.options.socketPath, { force: true });
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      server.once("error", reject);
      server.listen(this.options.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(this.options.socketPath, 0o600);
    await atomicWrite(this.options.descriptorPath, `${JSON.stringify(this.descriptor, null, 2)}\n`);
    return this.descriptor;
  }

  publish(eventType: string, payload: Buffer | string | object): WorkerCursor {
    const event: SequencedEvent = {
      generation: this.descriptor.generation,
      sequence: ++this.sequence,
      eventType,
      payload: asBuffer(payload),
    };
    this.replay.push(event);
    const capacity = this.options.replayCapacity ?? 4096;
    if (this.replay.length > capacity) this.replay.splice(0, this.replay.length - capacity);
    for (const attachment of this.attachments.values()) this.sendEvent(attachment, event);
    return this.cursor;
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    const attachment: Attachment = {
      id: randomUUID(),
      socket,
      decoder: new WorkerFrameDecoder(),
      authenticated: false,
      blocked: false,
      requiresResync: false,
    };
    this.attachments.set(attachment.id, attachment);
    const authTimer = setTimeout(() => socket.destroy(new Error("Worker authentication timeout.")), 5000);
    authTimer.unref();
    socket.on("data", (chunk) => {
      try {
        for (const frame of attachment.decoder.push(chunk)) void this.handle(attachment, frame, authTimer);
      } catch (error) {
        socket.destroy(error as Error);
      }
    });
    socket.on("drain", () => {
      attachment.blocked = false;
      if (attachment.requiresResync && attachment.authenticated) {
        this.write(attachment, { type: "resync_required", ...this.cursor });
      }
    });
    const cleanup = () => {
      clearTimeout(authTimer);
      this.attachments.delete(attachment.id);
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);
  }

  private async handle(attachment: Attachment, frame: WorkerFrame, authTimer: NodeJS.Timeout): Promise<void> {
    const { header, payload } = frame;
    if (!attachment.authenticated) {
      if (header.type !== "auth" || header.token !== this.descriptor.token) {
        attachment.socket.destroy(new Error("Worker authentication failed."));
        return;
      }
      attachment.authenticated = true;
      clearTimeout(authTimer);
      this.write(attachment, { type: "auth_ok", workerId: this.descriptor.workerId, ...this.cursor });
      return;
    }

    if (header.type === "ping") {
      this.write(attachment, {
        type: "pong",
        ...(typeof header.requestId === "string" ? { requestId: header.requestId } : {}),
        ...this.cursor,
      });
      return;
    }
    if (header.type === "attach") {
      await this.attachReplay(attachment, header);
      return;
    }
    if (header.type === "snapshot_request") {
      await this.sendSnapshot(attachment, String(header.requestId ?? randomUUID()));
      return;
    }
    if (header.type === "command") {
      const requestId = String(header.requestId ?? "");
      const method = String(header.method ?? "");
      if (!requestId || !method) {
        this.write(attachment, { type: "command_error", requestId, code: "INVALID_COMMAND" });
        return;
      }
      try {
        const result = await this.options.commandHandler(method, payload, { clientId: attachment.id, requestId });
        this.write(attachment, { type: "command_result", requestId, ok: true }, asBuffer(result));
      } catch (error) {
        this.write(attachment, {
          type: "command_result",
          requestId,
          ok: false,
          errorClass: error instanceof Error ? error.name : "unknown",
        }, Buffer.from(error instanceof Error ? error.message : String(error), "utf8"));
      }
      return;
    }
    this.write(attachment, { type: "protocol_error", code: "UNKNOWN_FRAME_TYPE" });
  }

  private async attachReplay(attachment: Attachment, header: WorkerFrameHeader): Promise<void> {
    const requestId = String(header.requestId ?? randomUUID());
    const generation = Number(header.generation ?? 0);
    const sequence = Number(header.sequence ?? 0);
    attachment.requiresResync = false;
    if (generation !== this.descriptor.generation) {
      this.write(attachment, { type: "attach_result", requestId, replay: "unavailable", ...this.cursor });
      await this.sendSnapshot(attachment, requestId);
      return;
    }
    const oldest = this.replay[0]?.sequence ?? this.sequence + 1;
    if (sequence < oldest - 1) {
      this.write(attachment, { type: "attach_result", requestId, replay: "partial", oldestSequence: oldest, ...this.cursor });
      await this.sendSnapshot(attachment, requestId);
      return;
    }
    this.write(attachment, { type: "attach_result", requestId, replay: "complete", ...this.cursor });
    for (const event of this.replay) {
      if (event.sequence > sequence) this.sendEvent(attachment, event);
    }
  }

  private sendEvent(attachment: Attachment, event: SequencedEvent): void {
    if (!attachment.authenticated || attachment.blocked || attachment.requiresResync) {
      if (attachment.authenticated) attachment.requiresResync = true;
      return;
    }
    const accepted = this.write(attachment, {
      type: "event",
      eventType: event.eventType,
      generation: event.generation,
      sequence: event.sequence,
    }, event.payload);
    if (!accepted) {
      attachment.blocked = true;
      attachment.requiresResync = true;
    }
  }

  private async sendSnapshot(attachment: Attachment, requestId: string): Promise<void> {
    const snapshot = asBuffer(await this.options.snapshotProvider());
    const chunkBytes = Math.max(16 * 1024, this.options.snapshotChunkBytes ?? 512 * 1024);
    const chunks = Math.max(1, Math.ceil(snapshot.length / chunkBytes));
    this.write(attachment, { type: "snapshot_begin", requestId, chunks, bytes: snapshot.length, ...this.cursor });
    for (let index = 0; index < chunks; index++) {
      const chunk = snapshot.subarray(index * chunkBytes, Math.min(snapshot.length, (index + 1) * chunkBytes));
      if (!this.write(attachment, { type: "snapshot_chunk", requestId, index, chunks }, chunk)) {
        attachment.requiresResync = true;
        return;
      }
    }
    this.write(attachment, { type: "snapshot_end", requestId, ...this.cursor });
    attachment.requiresResync = false;
  }

  private write(attachment: Attachment, header: WorkerFrameHeader, payload?: Buffer): boolean {
    if (attachment.socket.destroyed) return false;
    return attachment.socket.write(encodeWorkerFrame(header, payload));
  }

  async stop(): Promise<void> {
    for (const attachment of this.attachments.values()) attachment.socket.destroy();
    this.attachments.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    await Promise.all([
      rm(this.options.socketPath, { force: true }),
      rm(this.options.descriptorPath, { force: true }),
    ]);
  }
}
