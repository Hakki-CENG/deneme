import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { VideoAspectRatio, VideoGenerationService } from "./video-generation.js";
import { atomicWrite } from "../util/atomic-file.js";

export type MediaJobStatus = "submitting" | "queued" | "running" | "succeeded" | "failed" | "cancelling" | "cancelled" | "uncertain";
interface MediaJobRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  kind: "video";
  providerId: string;
  externalJobId?: string;
  model?: string;
  modality?: "text" | "image" | "multi-reference";
  references: number;
  requestKeyHash?: string;
  status: MediaJobStatus;
  errorCode?: string;
  artifact?: { path: string; bytes: number; mimeType: string };
  createdAt: string;
  updatedAt: string;
}
export interface MediaJobView extends Omit<MediaJobRecord, "externalJobId" | "requestKeyHash"> {}

export class MediaJobManager {
  private records: MediaJobRecord[] = [];
  private loaded = false;
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly rootPath: string, private readonly video: VideoGenerationService) {}

  async submitVideo(input: {
    tenantId: string; sessionId: string; workspacePath: string; providerId: string; prompt: string;
    aspectRatio?: VideoAspectRatio; durationSeconds?: number; sourcePath?: string; sourcePaths?: string[];
    idempotencyKey?: string; signal?: AbortSignal;
  }): Promise<MediaJobView> {
    await this.load();
    const requestKeyHash = input.idempotencyKey ? createHash("sha256").update(`${input.tenantId}\0${input.sessionId}\0${input.idempotencyKey}`).digest("hex") : undefined;
    if (requestKeyHash) {
      const existing = this.records.find((item) => item.tenantId === input.tenantId && item.sessionId === input.sessionId && item.requestKeyHash === requestKeyHash);
      if (existing) return view(existing);
    }
    if (this.records.filter((item) => item.tenantId === input.tenantId && ["submitting", "queued", "running", "cancelling"].includes(item.status)).length >= 100) {
      throw new Error("Tenant has reached the 100 active media-job limit.");
    }
    const now = new Date().toISOString();
    const record: MediaJobRecord = {
      id: randomUUID(), tenantId: input.tenantId, sessionId: input.sessionId, kind: "video",
      providerId: input.providerId, references: (input.sourcePath ? 1 : 0) + (input.sourcePaths?.length ?? 0),
      ...(requestKeyHash ? { requestKeyHash } : {}),
      status: "submitting", createdAt: now, updatedAt: now,
    };
    this.records.push(record); await this.save();
    try {
      const submitted = await this.video.submitQueued({
        workspacePath: input.workspacePath, providerId: input.providerId, prompt: input.prompt,
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
        ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
        ...(input.sourcePaths?.length ? { sourcePaths: input.sourcePaths } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      record.externalJobId = submitted.externalJobId;
      record.model = submitted.model;
      record.modality = submitted.modality;
      record.references = submitted.references;
      record.status = "queued";
      record.updatedAt = new Date().toISOString(); await this.save();
      return view(record);
    } catch (error) {
      record.status = "uncertain";
      record.errorCode = "submission_uncertain";
      record.updatedAt = new Date().toISOString(); await this.save();
      throw error;
    }
  }

  async poll(input: { id: string; tenantId: string; workspacePath: string; signal?: AbortSignal }): Promise<MediaJobView> {
    return await this.withLock(input.id, async () => {
      const record = await this.record(input.id, input.tenantId);
      if (!["queued", "running"].includes(record.status) || !record.externalJobId) return view(record);
      const result = await this.video.pollQueued({
        workspacePath: input.workspacePath, providerId: record.providerId, externalJobId: record.externalJobId,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      record.status = result.status;
      if (result.status === "failed") record.errorCode = result.code.slice(0, 100);
      if (result.status === "succeeded") {
        record.model = result.model;
        record.artifact = result.video;
        delete record.errorCode;
      }
      record.updatedAt = new Date().toISOString(); await this.save();
      return view(record);
    });
  }

  async cancel(input: { id: string; tenantId: string; signal?: AbortSignal }): Promise<MediaJobView> {
    return await this.withLock(input.id, async () => {
      const record = await this.record(input.id, input.tenantId);
      if (["succeeded", "failed", "cancelled"].includes(record.status)) return view(record);
      if (!record.externalJobId) throw new Error("Media job has no confirmed external job id; its outcome is uncertain.");
      record.status = "cancelling"; record.updatedAt = new Date().toISOString(); await this.save();
      try {
        await this.video.cancelQueued({ providerId: record.providerId, externalJobId: record.externalJobId, ...(input.signal ? { signal: input.signal } : {}) });
        record.status = "cancelled"; delete record.errorCode;
      } catch (error) {
        record.status = "uncertain"; record.errorCode = "cancellation_uncertain";
        record.updatedAt = new Date().toISOString(); await this.save();
        throw error;
      }
      record.updatedAt = new Date().toISOString(); await this.save(); return view(record);
    });
  }

  async get(id: string, tenantId: string): Promise<MediaJobView> { return view(await this.record(id, tenantId)); }
  async list(tenantId: string, sessionId?: string): Promise<MediaJobView[]> {
    await this.load();
    return this.records.filter((item) => item.tenantId === tenantId && (!sessionId || item.sessionId === sessionId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 1000).map(view);
  }

  private get path(): string { return join(this.rootPath, "media", "jobs.json"); }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8");
      if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error("Media job registry exceeds 16 MiB.");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) throw new Error("Media job registry is malformed.");
      this.records = parsed as MediaJobRecord[];
      let changed = false;
      for (const item of this.records) if (item.status === "submitting" || item.status === "cancelling") {
        const previous = item.status;
        item.status = "uncertain"; item.errorCode = previous === "submitting" ? "submission_uncertain" : "cancellation_uncertain";
        item.updatedAt = new Date().toISOString(); changed = true;
      }
      if (changed) await this.save();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.loaded = true;
  }
  private async save(): Promise<void> {
    if (this.records.length > 100_000) this.records.splice(0, this.records.length - 100_000);
    const encoded = `${JSON.stringify(this.records, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) throw new Error("Media job registry exceeds 16 MiB.");
    await atomicWrite(this.path, encoded);
  }
  private async record(id: string, tenantId: string): Promise<MediaJobRecord> {
    await this.load(); const record = this.records.find((item) => item.id === id && item.tenantId === tenantId);
    if (!record) throw new Error("Media job not found in tenant."); return record;
  }
  private async withLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve(); let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; }); this.locks.set(id, current); await previous;
    try { return await action(); } finally { release(); if (this.locks.get(id) === current) this.locks.delete(id); }
  }
}

function view(record: MediaJobRecord): MediaJobView {
  const { externalJobId: _externalJobId, requestKeyHash: _requestKeyHash, ...safe } = record;
  return structuredClone(safe);
}
