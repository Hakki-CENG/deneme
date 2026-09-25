import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AsyncMutex } from "./async-mutex.js";
import { atomicWrite } from "./atomic-file.js";

export const AURORA_MAX_STATE_BYTES = 16 * 1024 * 1024;

/**
 * Durable, bounded, mutex-serialized JSON state used by the Aurora substrate services.
 * Every Aurora store keeps the same guarantees as the existing HAF stores: atomic writes,
 * schema validation on load, and an explicit size bound so a runaway loop cannot grow state forever.
 */
export class DurableJsonState<T extends { schemaVersion: number }> {
  private value: T | undefined;
  private readonly mutex = new AsyncMutex();
  /**
   * Shared first-load promise. Without it, two concurrent `read()` calls both
   * see `value === undefined`, both load from disk, and the second assignment
   * silently discards every mutation the first caller already made through
   * `mutate` — a lost-write race found while wiring parallel user-model event
   * handlers (J1). One load is shared by every concurrent reader.
   */
  private loadPromise: Promise<T> | undefined;

  constructor(
    private readonly path: string,
    private readonly create: () => T,
    private readonly validate: (value: unknown) => boolean,
    private readonly label: string,
    private readonly maxBytes: number = AURORA_MAX_STATE_BYTES,
  ) {}

  async read(): Promise<T> {
    if (!this.value) {
      this.loadPromise ??= this.loadFromDisk().then(
        (loaded) => {
          this.value = loaded;
          return loaded;
        },
        (error) => {
          this.loadPromise = undefined; // a failed load must not be cached
          throw error;
        },
      );
      return await this.loadPromise;
    }
    return this.value;
  }

  /** Serialized read-modify-write. The callback receives the live state and may mutate it in place. */
  async mutate<R>(operation: (state: T) => Promise<R> | R): Promise<R> {
    return await this.mutex.runExclusive(async () => {
      if (!this.value) await this.read();
      const result = await operation(this.value!);
      await this.flush(this.value!);
      return result;
    });
  }

  private async loadFromDisk(): Promise<T> {
    try {
      const raw = await readFile(this.path, "utf8");
      if (Buffer.byteLength(raw) > this.maxBytes) throw new Error(`${this.label} exceeds its safety bound.`);
      const parsed: unknown = JSON.parse(raw);
      if (!this.validate(parsed)) throw new Error(`${this.label} is malformed.`);
      return parsed as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.create();
    }
  }

  private async flush(state: T): Promise<void> {
    const encoded = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > this.maxBytes) throw new Error(`${this.label} exceeds its safety bound.`);
    await atomicWrite(this.path, encoded);
  }
}

export function auroraUnit(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1.`);
  return Number(value.toFixed(6));
}

export function auroraInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} is invalid.`);
  return value;
}

export function auroraText(value: string, max: number, label: string): string {
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

export function auroraOptionalText(value: string | undefined, max: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  return auroraText(value, max, label);
}

export function auroraTags(values: readonly string[] | undefined, label = "Aurora tags"): string[] {
  const tags = [...new Set((values ?? []).map((item) => item.trim().toLowerCase()))].filter((item) => item.length > 0);
  if (tags.length > 100 || tags.some((item) => !/^[a-z0-9][a-z0-9._:-]{0,99}$/.test(item))) throw new Error(`${label} are invalid.`);
  return tags;
}

export function auroraIds(values: readonly string[] | undefined, max: number, label: string): string[] {
  const ids = [...new Set((values ?? []).map((item) => item.trim()))].filter((item) => item.length > 0);
  if (ids.length > max || ids.some((item) => item.length > 300)) throw new Error(`${label} are invalid.`);
  return ids;
}

export function auroraTimestamp(value: string | undefined, fallback: number, label: string): string {
  if (value === undefined) return new Date(fallback).toISOString();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid.`);
  return new Date(parsed).toISOString();
}

export function auroraDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function auroraWeek(now: number): string {
  const date = new Date(now);
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() + 6) % 7)));
  return monday.toISOString().slice(0, 10);
}

export function auroraMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

export function auroraDigest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

/** Cheap deterministic lexical similarity used for de-duplication, contradiction and recall scoring. */
export function auroraTokens(value: string): string[] {
  return [...new Set(value.toLowerCase()
    .replace(/[^\p{L}\p{N}\s._-]/gu, " ")
    .split(/\s+/)
    .map((item) => item.replace(/^[._-]+/, "").replace(/[._-]+$/, ""))
    .filter((item) => item.length > 2))];
}

export function auroraSimilarity(left: string, right: string): number {
  const a = new Set(auroraTokens(left));
  const b = new Set(auroraTokens(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return Number((shared / (a.size + b.size - shared)).toFixed(6));
}

export function auroraRound(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

export function auroraArray(value: unknown): boolean {
  return Array.isArray(value);
}

/** Strips `undefined` values so optional zod fields satisfy exactOptionalPropertyTypes contracts. */
export type AuroraDefined<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };
export function auroraDefined<T extends Record<string, unknown>>(value: T): AuroraDefined<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as AuroraDefined<T>;
}
