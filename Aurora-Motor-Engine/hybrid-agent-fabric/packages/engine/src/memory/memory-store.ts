import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite } from "../util/atomic-file.js";

export type MemoryKind = "episodic" | "semantic" | "preference" | "decision";
export type MemoryScope = "session" | "project" | "user" | "org";

export interface MemoryRecord {
  id: string;
  tenantId: string;
  sessionId?: string;
  kind: MemoryKind;
  scope: MemoryScope;
  title: string;
  content: string;
  evidenceEventIds: string[];
  provenance: { createdBy: "user" | "agent" | "system"; model?: string };
  status: "candidate" | "active" | "rejected";
  version: number;
  createdAt: string;
  updatedAt: string;
  /**
   * P2.23 multimodal memory: media files this record refers to, with their
   * provenance. The sha256 is verified by the capability layer at write time
   * against the real file, so a record cannot silently point at content that
   * changed or never existed.
   */
  attachments?: Array<{
    path: string;
    mimeType: string;
    sha256: string;
    bytes: number;
    kind: "image" | "audio" | "video" | "document";
    /** Modality-specific confidence — how much the record's claim should be trusted given this evidence. */
    confidence: number;
  }>;
}

const suspiciousPatterns = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /system\s+prompt/i,
  /exfiltrat/i,
  /send\s+.*(?:secret|token|credential)/i,
  /<script\b/i,
  /\bBEGIN\s+(?:SYSTEM|PROMPT)\b/i,
];

function assertSafeMemory(content: string): void {
  const hit = suspiciousPatterns.find((pattern) => pattern.test(content));
  if (hit) throw new Error(`Memory candidate rejected by injection scan (${hit.source}).`);
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length > 1));
}

export class MemoryStore {
  private records: MemoryRecord[] = [];
  private loaded = false;

  constructor(private readonly rootPath: string) {}

  private get path(): string {
    return join(this.rootPath, "memory", "records.json");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.records = Array.isArray(value) ? (value as MemoryRecord[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify(this.records, null, 2)}\n`);
  }

  async create(input: Omit<MemoryRecord, "id" | "version" | "createdAt" | "updatedAt">): Promise<MemoryRecord> {
    await this.load();
    assertSafeMemory(input.content);
    for (const attachment of input.attachments ?? []) {
      if (!/^[a-f0-9]{64}$/.test(attachment.sha256)) throw new Error(`Attachment ${attachment.path}: sha256 must be a 64-character hex digest.`);
      if (!Number.isFinite(attachment.confidence) || attachment.confidence < 0 || attachment.confidence > 1) {
        throw new Error(`Attachment ${attachment.path}: modality confidence must be between 0 and 1.`);
      }
      if (!Number.isInteger(attachment.bytes) || attachment.bytes < 0) throw new Error(`Attachment ${attachment.path}: bytes must be a non-negative integer.`);
    }
    const now = new Date().toISOString();
    const record: MemoryRecord = { ...input, id: randomUUID(), version: 1, createdAt: now, updatedAt: now };
    this.records.push(record);
    await this.save();
    return structuredClone(record);
  }

  async promote(id: string): Promise<MemoryRecord> {
    await this.load();
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error(`Memory ${id} does not exist.`);
    assertSafeMemory(record.content);
    record.status = "active";
    record.version++;
    record.updatedAt = new Date().toISOString();
    await this.save();
    return structuredClone(record);
  }

  async deactivate(id: string): Promise<MemoryRecord> {
    await this.load();
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error(`Memory ${id} does not exist.`);
    record.status = "rejected";
    record.version++;
    record.updatedAt = new Date().toISOString();
    await this.save();
    return structuredClone(record);
  }

  async search(tenantId: string, query: string, options: { sessionId?: string; limit?: number } = {}): Promise<MemoryRecord[]> {
    await this.load();
    const terms = tokenize(query);
    return this.records
      .filter((record) => record.tenantId === tenantId && record.status === "active")
      .filter((record) => record.scope !== "session" || record.sessionId === options.sessionId)
      .map((record) => {
        const haystack = tokenize(`${record.title} ${record.content}`);
        const score = [...terms].filter((term) => haystack.has(term)).length;
        return { record, score };
      })
      .filter(({ score }) => score > 0 || terms.size === 0)
      .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt))
      .slice(0, options.limit ?? 8)
      .map(({ record }) => structuredClone(record));
  }

  async frozenSnapshot(tenantId: string, sessionId: string, maxChars = 5000): Promise<string> {
    const records = await this.search(tenantId, "", { sessionId, limit: 50 });
    let output = records.map((record) => `- [${record.kind}/${record.scope}] ${record.title}: ${record.content}`).join("\n");
    if (output.length > maxChars) output = `${output.slice(0, maxChars)}\n[Memory snapshot truncated]`;
    return output;
  }
}
