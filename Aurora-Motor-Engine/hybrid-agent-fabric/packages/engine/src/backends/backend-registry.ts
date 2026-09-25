import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../util/atomic-file.js";

export type BackendKind = "local" | "remote" | "cloud";
export type BackendAuth =
  | { mode: "none" }
  | { mode: "bearer-env"; environmentVariable: string }
  | { mode: "session-key-env"; environmentVariable: string };

export interface BackendRecord {
  id: string;
  name: string;
  kind: BackendKind;
  baseUrl: string;
  auth: BackendAuth;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BackendHealth {
  backendId: string;
  status: "healthy" | "unhealthy" | "disabled";
  checkedAt: string;
  latencyMs?: number;
  version?: string;
  errorClass?: string;
}

function validateEnvironmentVariable(value: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) throw new Error("Backend credential reference must be an environment variable name.");
  return value;
}

export class BackendRegistry {
  private records: BackendRecord[] = [];
  private loaded = false;

  constructor(private readonly rootPath: string) {}

  private get path(): string {
    return join(this.rootPath, "backends", "registry.json");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.records = Array.isArray(parsed) ? parsed as BackendRecord[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!this.records.some((record) => record.id === "local")) {
      const now = new Date().toISOString();
      this.records.unshift({
        id: "local",
        name: "Local HAF Engine",
        kind: "local",
        baseUrl: "local://engine",
        auth: { mode: "none" },
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await this.save();
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify(this.records, null, 2)}\n`);
  }

  async list(): Promise<BackendRecord[]> {
    await this.load();
    return this.records.map((record) => structuredClone(record));
  }

  async get(id: string): Promise<BackendRecord> {
    await this.load();
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error(`Backend ${id} not found.`);
    return structuredClone(record);
  }

  async add(input: {
    name: string;
    kind: Exclude<BackendKind, "local">;
    baseUrl: string;
    auth: BackendAuth;
  }): Promise<BackendRecord> {
    await this.load();
    const url = new URL(input.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Remote backend URL must use HTTP(S).");
    if (url.username || url.password) throw new Error("Backend URL must not contain credentials.");
    if (input.auth.mode !== "none") validateEnvironmentVariable(input.auth.environmentVariable);
    const now = new Date().toISOString();
    const record: BackendRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      kind: input.kind,
      baseUrl: url.toString().replace(/\/$/, ""),
      auth: input.auth,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    if (!record.name) throw new Error("Backend name is required.");
    this.records.push(record);
    await this.save();
    return structuredClone(record);
  }

  async setEnabled(id: string, enabled: boolean): Promise<BackendRecord> {
    await this.load();
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error(`Backend ${id} not found.`);
    if (record.id === "local" && !enabled) throw new Error("The built-in local backend cannot be disabled.");
    record.enabled = enabled;
    record.updatedAt = new Date().toISOString();
    await this.save();
    return structuredClone(record);
  }

  async remove(id: string): Promise<boolean> {
    await this.load();
    if (id === "local") throw new Error("The built-in local backend cannot be removed.");
    const before = this.records.length;
    this.records = this.records.filter((record) => record.id !== id);
    if (this.records.length !== before) await this.save();
    return this.records.length !== before;
  }

  private authHeaders(record: BackendRecord): Record<string, string> {
    if (record.auth.mode === "none") return {};
    const value = process.env[record.auth.environmentVariable];
    if (!value) throw new Error(`Backend credential environment variable ${record.auth.environmentVariable} is not set.`);
    return record.auth.mode === "bearer-env"
      ? { authorization: `Bearer ${value}` }
      : { "x-session-api-key": value };
  }

  async health(id: string, timeoutMs = 5000): Promise<BackendHealth> {
    const record = await this.get(id);
    if (!record.enabled) return { backendId: id, status: "disabled", checkedAt: new Date().toISOString() };
    if (record.kind === "local") return { backendId: id, status: "healthy", checkedAt: new Date().toISOString(), latencyMs: 0 };
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await fetch(`${record.baseUrl}/health`, { headers: this.authHeaders(record), signal: controller.signal });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      return {
        backendId: id,
        status: response.ok ? "healthy" : "unhealthy",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        ...(typeof body.version === "string" ? { version: body.version } : {}),
        ...(!response.ok ? { errorClass: `http_${response.status}` } : {}),
      };
    } catch (error) {
      return {
        backendId: id,
        status: "unhealthy",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        errorClass: error instanceof Error ? error.name : "unknown",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async proxy(id: string, path: string, init: RequestInit = {}): Promise<Response> {
    const record = await this.get(id);
    if (!record.enabled) throw new Error(`Backend ${id} is disabled.`);
    if (record.kind === "local") throw new Error("Local backend requests do not use the remote proxy.");
    if (!path.startsWith("/v1/") && path !== "/health") throw new Error("Backend proxy path is outside the allowed API prefix.");
    return await fetch(`${record.baseUrl}${path}`, {
      ...init,
      headers: { ...this.authHeaders(record), ...(init.headers ?? {}) },
    });
  }
}
