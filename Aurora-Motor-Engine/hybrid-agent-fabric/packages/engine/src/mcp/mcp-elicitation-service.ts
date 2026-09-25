import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "../types.js";
import { assertSafeUrl } from "../capabilities/web.js";
import { atomicWrite } from "../util/atomic-file.js";
import { AsyncMutex } from "../util/async-mutex.js";

export type McpElicitationAction = "accept" | "decline" | "cancel";

export interface McpElicitationRequest {
  id: string;
  tenantId: string;
  serverName: string;
  mode: "form" | "url";
  message: string;
  requestedSchema?: {
    type: "object";
    properties: Record<string, Record<string, JsonValue>>;
    required: string[];
  };
  url?: string;
  elicitationId?: string;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolutionReason?: string;
}

interface PendingResolver {
  resolve: (value: { action: McpElicitationAction; content?: Record<string, JsonValue> }) => void;
  timer: NodeJS.Timeout;
}

function sanitizeMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("MCP elicitation message is required.");
  return value.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "").trim().slice(0, 10_000);
}

function sanitizeFormSchema(value: unknown): NonNullable<McpElicitationRequest["requestedSchema"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP elicitation schema must be an object.");
  const input = value as Record<string, unknown>;
  if (input.type !== "object" || !input.properties || typeof input.properties !== "object" || Array.isArray(input.properties)) {
    throw new Error("MCP elicitation supports only object form schemas.");
  }
  const entries = Object.entries(input.properties as Record<string, unknown>);
  if (entries.length > 50) throw new Error("MCP elicitation form exceeds 50 fields.");
  const properties: Record<string, Record<string, JsonValue>> = {};
  for (const [name, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("MCP elicitation field schema is invalid.");
    }
    const field = raw as Record<string, unknown>;
    if (!["string", "number", "integer", "boolean"].includes(String(field.type))) throw new Error(`MCP elicitation field ${name} uses an unsupported type.`);
    const clean: Record<string, JsonValue> = { type: String(field.type) };
    if (typeof field.title === "string") clean.title = field.title.slice(0, 300);
    if (typeof field.description === "string") clean.description = field.description.slice(0, 2000);
    if (typeof field.format === "string") clean.format = field.format.slice(0, 100);
    if (typeof field.minimum === "number" && Number.isFinite(field.minimum)) clean.minimum = field.minimum;
    if (typeof field.maximum === "number" && Number.isFinite(field.maximum)) clean.maximum = field.maximum;
    if (typeof field.minLength === "number") clean.minLength = Math.max(0, Math.min(100_000, Math.floor(field.minLength)));
    if (typeof field.maxLength === "number") clean.maxLength = Math.max(0, Math.min(100_000, Math.floor(field.maxLength)));
    if (Array.isArray(field.enum)) {
      const values = field.enum.filter((item): item is string | number | boolean => ["string", "number", "boolean"].includes(typeof item)).slice(0, 100);
      clean.enum = values;
    }
    if (["string", "number", "boolean"].includes(typeof field.default)) clean.default = field.default as JsonValue;
    properties[name] = clean;
  }
  const required = Array.isArray(input.required)
    ? input.required.filter((name): name is string => typeof name === "string" && name in properties).slice(0, 50)
    : [];
  return { type: "object", properties, required };
}

function validateContent(schema: NonNullable<McpElicitationRequest["requestedSchema"]>, content: unknown): Record<string, JsonValue> {
  if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("MCP elicitation response content must be an object.");
  const source = content as Record<string, unknown>;
  for (const required of schema.required) if (!(required in source)) throw new Error(`MCP elicitation field ${required} is required.`);
  const output: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(source)) {
    const field = schema.properties[name];
    if (!field) throw new Error(`Unexpected MCP elicitation field: ${name}`);
    const type = field.type;
    if (type === "integer" && (!Number.isInteger(value) || typeof value !== "number")) throw new Error(`MCP elicitation field ${name} must be an integer.`);
    if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`MCP elicitation field ${name} must be a number.`);
    if (type === "boolean" && typeof value !== "boolean") throw new Error(`MCP elicitation field ${name} must be boolean.`);
    if (type === "string" && typeof value !== "string") throw new Error(`MCP elicitation field ${name} must be a string.`);
    if (typeof value === "string") {
      if (typeof field.minLength === "number" && value.length < field.minLength) throw new Error(`MCP elicitation field ${name} is too short.`);
      if (typeof field.maxLength === "number" && value.length > field.maxLength) throw new Error(`MCP elicitation field ${name} is too long.`);
    }
    if (typeof value === "number") {
      if (typeof field.minimum === "number" && value < field.minimum) throw new Error(`MCP elicitation field ${name} is below minimum.`);
      if (typeof field.maximum === "number" && value > field.maximum) throw new Error(`MCP elicitation field ${name} is above maximum.`);
    }
    if (Array.isArray(field.enum) && !field.enum.includes(value as never)) throw new Error(`MCP elicitation field ${name} is outside its enum.`);
    output[name] = value as JsonValue;
  }
  return output;
}

export class McpElicitationService {
  private requests: McpElicitationRequest[] = [];
  private loaded = false;
  private readonly pending = new Map<string, PendingResolver>();
  private readonly mutex = new AsyncMutex();

  constructor(private readonly rootPath: string, private readonly timeoutMs = 5 * 60_000) {}
  private get path(): string { return join(this.rootPath, "mcp", "elicitations.json"); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.requests = Array.isArray(parsed) ? parsed as McpElicitationRequest[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const now = new Date().toISOString();
    for (const request of this.requests) {
      if (request.status === "pending") {
        request.status = "expired";
        request.resolvedAt = now;
        request.resolutionReason = "control_process_restarted";
      }
    }
    this.loaded = true;
    await this.save();
  }

  private async save(): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify(this.requests.slice(-5000), null, 2)}\n`);
  }

  async request(serverName: string, tenantId: string, params: any): Promise<{ action: McpElicitationAction; content?: Record<string, JsonValue> }> {
    await this.load();
    const mode = params?.mode;
    if (mode !== "form" && mode !== "url") throw new Error("Unsupported MCP elicitation mode.");
    const now = Date.now();
    const request: McpElicitationRequest = {
      id: randomUUID(),
      tenantId,
      serverName,
      mode,
      message: sanitizeMessage(params.message),
      ...(mode === "form" ? { requestedSchema: sanitizeFormSchema(params.requestedSchema) } : {}),
      ...(mode === "url" ? { url: (await assertSafeUrl(String(params.url))).toString() } : {}),
      ...(typeof params.elicitationId === "string" ? { elicitationId: params.elicitationId.slice(0, 500) } : {}),
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.timeoutMs).toISOString(),
    };
    const response = new Promise<{ action: McpElicitationAction; content?: Record<string, JsonValue> }>((resolve) => {
      const timer = setTimeout(() => {
        void this.expire(request.id);
        resolve({ action: "decline" });
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(request.id, { resolve, timer });
    });
    try {
      await this.mutex.runExclusive(async () => {
        this.requests.push(request);
        await this.save();
      });
    } catch (error) {
      const pending = this.pending.get(request.id);
      if (pending) clearTimeout(pending.timer);
      this.pending.delete(request.id);
      throw error;
    }
    return await response;
  }

  private async expire(id: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const request = this.requests.find((item) => item.id === id);
      if (!request || request.status !== "pending") return;
      request.status = "expired";
      request.resolvedAt = new Date().toISOString();
      request.resolutionReason = "timeout";
      this.pending.delete(id);
      await this.save();
    });
  }

  async list(tenantId: string, status: McpElicitationRequest["status"] = "pending"): Promise<McpElicitationRequest[]> {
    await this.load();
    return this.requests.filter((request) => request.tenantId === tenantId && request.status === status).map((request) => structuredClone(request));
  }

  async resolve(tenantId: string, id: string, input: { action: McpElicitationAction; content?: Record<string, JsonValue> }): Promise<McpElicitationRequest> {
    await this.load();
    return await this.mutex.runExclusive(async () => {
      const request = this.requests.find((item) => item.id === id);
      if (!request || request.tenantId !== tenantId || request.status !== "pending") throw new Error("MCP elicitation is missing, expired, already resolved, or outside this tenant.");
      const pending = this.pending.get(id);
      if (!pending) throw new Error("MCP elicitation has no live transport after restart.");
      let content: Record<string, JsonValue> | undefined;
      if (input.action === "accept" && request.mode === "form") content = validateContent(request.requestedSchema!, input.content);
      if (input.action === "accept" && request.mode === "url" && input.content) throw new Error("URL elicitation does not accept form content.");
      request.status = input.action === "accept" ? "accepted" : input.action === "decline" ? "declined" : "cancelled";
      request.resolvedAt = new Date().toISOString();
      request.resolutionReason = `human_${input.action}`;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      await this.save();
      pending.resolve({ action: input.action, ...(content ? { content } : {}) });
      return structuredClone(request);
    });
  }

  async close(): Promise<void> {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ action: "cancel" });
      this.pending.delete(id);
    }
  }
}
