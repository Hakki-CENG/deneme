import { createHash } from "node:crypto";
import { Honcho } from "@honcho-ai/sdk";
import type { Capability, JsonValue } from "../types.js";
import { assertSafeUrl } from "../capabilities/web.js";
import { sanitizeExternalContext, type ExternalMemoryPrefetchInput, type ExternalMemoryProvider, type ExternalMemorySyncInput } from "./external-memory-provider.js";

export type HonchoRecallMode = "hybrid" | "context" | "tools";
export type HonchoReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";

export interface HonchoMemoryProviderOptions {
  apiKey?: string;
  baseURL?: string;
  workspaceId?: string;
  userPeer?: string;
  assistantPeer?: string;
  recallMode?: HonchoRecallMode;
  contextTokens?: number;
  contextCadence?: number;
  messageMaxChars?: number;
  timeoutMs?: number;
  maxRetries?: number;
  allowSelfHosted?: boolean;
  allowPrivateBaseUrl?: boolean;
  clientFactory?: (options: { apiKey?: string; baseURL: string; workspaceId: string; timeout: number; maxRetries: number }) => HonchoClientLike;
}

interface HonchoMessageLike {
  id?: string;
  content: string;
  peerId?: string;
  createdAt?: string;
}
interface HonchoContextLike {
  summary?: { content: string } | null;
  peerRepresentation?: string | null;
  peerCard?: string[] | null;
  messages?: HonchoMessageLike[];
}
interface HonchoConclusionLike { id: string; content: string; level?: string; createdAt?: string }
interface HonchoConclusionPageLike { items: HonchoConclusionLike[] }
interface HonchoConclusionScopeLike {
  list(options?: { page?: number; size?: number; session?: string | HonchoSessionLike; reverse?: boolean }): Promise<HonchoConclusionPageLike>;
  query(query: string, topK?: number): Promise<HonchoConclusionLike[]>;
  create(input: { content: string; sessionId?: string | HonchoSessionLike }): Promise<HonchoConclusionLike[]>;
  delete(id: string): Promise<void>;
}
interface HonchoPeerContextLike { representation?: string | null; peerCard?: string[] | null }
interface HonchoPeerLike {
  id: string;
  message(content: string, options?: { metadata?: Record<string, unknown>; createdAt?: string | Date }): unknown;
  context(options?: { target?: string | HonchoPeerLike; searchQuery?: string; searchTopK?: number; maxConclusions?: number }): Promise<HonchoPeerContextLike>;
  getCard(target?: string | HonchoPeerLike): Promise<string[] | null>;
  search(query: string, options?: { limit?: number }): Promise<HonchoMessageLike[]>;
  chat(query: string, options?: { target?: string | HonchoPeerLike; session?: string | HonchoSessionLike; reasoningLevel?: string }): Promise<string | null>;
  conclusionsOf(target: string | HonchoPeerLike): HonchoConclusionScopeLike;
}
interface HonchoSessionLike {
  id: string;
  addMessages(messages: unknown[]): Promise<unknown[]>;
  context(options?: {
    summary?: boolean;
    tokens?: number;
    peerTarget?: string | HonchoPeerLike;
    peerPerspective?: string | HonchoPeerLike;
    limitToSession?: boolean;
    representationOptions?: { searchQuery?: string; searchTopK?: number; maxConclusions?: number };
  }): Promise<HonchoContextLike>;
  search(query: string, options?: { limit?: number }): Promise<HonchoMessageLike[]>;
}
export interface HonchoClientLike {
  peer(id: string): Promise<HonchoPeerLike>;
  session(id: string, options?: { peers?: Array<string | HonchoPeerLike> }): Promise<HonchoSessionLike>;
  search(query: string, options?: { limit?: number }): Promise<HonchoMessageLike[]>;
}

interface Runtime {
  user: HonchoPeerLike;
  assistant: HonchoPeerLike;
  session: HonchoSessionLike;
  prefetchCount: number;
  cachedEntries: string[];
}

const OFFICIAL_ORIGIN = "https://api.honcho.dev";

/** Official Honcho SDK adapter with tenant-projected peers/sessions and bounded untrusted output. */
export class HonchoMemoryProvider implements ExternalMemoryProvider {
  readonly id = "honcho";
  readonly displayName = "Honcho user-model memory";
  readonly dataPolicy: ExternalMemoryProvider["dataPolicy"];
  private readonly baseURL: string;
  private readonly workspaceId: string;
  private readonly userPeer: string;
  private readonly assistantPeer: string;
  private readonly recallMode: HonchoRecallMode;
  private readonly contextTokens: number;
  private readonly contextCadence: number;
  private readonly messageMaxChars: number;
  private readonly client: HonchoClientLike;
  private readonly runtimes = new Map<string, Promise<Runtime>>();
  private baseUrlValidated: Promise<void> | undefined;

  constructor(private readonly options: HonchoMemoryProviderOptions) {
    const endpoint = new URL(options.baseURL ?? OFFICIAL_ORIGIN);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
      throw new Error("Honcho base URL must be a credential-free origin without path, query or fragment.");
    }
    if (endpoint.protocol !== "https:" && !(options.allowSelfHosted && ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname))) {
      throw new Error("Honcho requires HTTPS; plaintext HTTP is limited to explicitly enabled loopback self-hosting.");
    }
    if (endpoint.origin !== OFFICIAL_ORIGIN && !options.allowSelfHosted) throw new Error("A non-cloud Honcho endpoint requires allowSelfHosted=true.");
    if (endpoint.origin === OFFICIAL_ORIGIN && !options.apiKey) throw new Error("Honcho Cloud requires an API key.");
    this.baseURL = endpoint.origin;
    this.dataPolicy = endpoint.origin === OFFICIAL_ORIGIN ? "external-provider" : "self-hosted";
    this.workspaceId = boundedId(options.workspaceId ?? "haf", 100);
    this.userPeer = boundedId(options.userPeer ?? "user", 100);
    this.assistantPeer = boundedId(options.assistantPeer ?? "haf", 100);
    this.recallMode = options.recallMode ?? "hybrid";
    this.contextTokens = boundedInteger(options.contextTokens ?? 2_000, 100, 20_000, "contextTokens");
    this.contextCadence = boundedInteger(options.contextCadence ?? 1, 1, 100, "contextCadence");
    this.messageMaxChars = boundedInteger(options.messageMaxChars ?? 25_000, 1_000, 25_000, "messageMaxChars");
    const timeout = boundedInteger(options.timeoutMs ?? 8_000, 500, 60_000, "timeoutMs");
    const factory = options.clientFactory ?? ((input) => new Honcho(input) as unknown as HonchoClientLike);
    this.client = factory({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      baseURL: this.baseURL,
      workspaceId: this.workspaceId,
      timeout,
      maxRetries: boundedInteger(options.maxRetries ?? 0, 0, 5, "maxRetries"),
    });
    if (!options.clientFactory) hardenOfficialSdkTransport(this.client, this.baseURL, timeout, options.allowPrivateBaseUrl ?? false);
  }

  async prefetch(input: ExternalMemoryPrefetchInput): Promise<string[]> {
    if (this.recallMode === "tools") return [];
    const runtime = await this.runtime(input.tenantId, input.sessionId);
    runtime.prefetchCount++;
    if (runtime.cachedEntries.length && (runtime.prefetchCount - 1) % this.contextCadence !== 0) return [...runtime.cachedEntries];
    try {
      const context = await runtime.session.context({
        summary: true,
        tokens: this.contextTokens,
        peerTarget: runtime.user,
        peerPerspective: runtime.assistant,
        limitToSession: false,
        representationOptions: { searchQuery: input.query.slice(0, 10_000), searchTopK: 20, maxConclusions: 100 },
      });
      runtime.cachedEntries = contextEntries(context);
      return [...runtime.cachedEntries];
    } catch {
      throw new Error("Honcho context retrieval failed.");
    }
  }

  async syncTurn(input: ExternalMemorySyncInput): Promise<void> {
    const runtime = await this.runtime(input.tenantId, input.sessionId);
    const messages = [
      ...chunkText(input.userMessage, this.messageMaxChars).map((content, index, all) => runtime.user.message(content, {
        metadata: { hafTurnId: input.turnId, role: "user", chunk: index + 1, chunks: all.length },
        createdAt: input.userTimestamp,
      })),
      ...chunkText(input.assistantResponse, this.messageMaxChars).map((content, index, all) => runtime.assistant.message(content, {
        metadata: { hafTurnId: input.turnId, role: "assistant", chunk: index + 1, chunks: all.length },
        createdAt: input.assistantTimestamp,
      })),
    ];
    if (!messages.length) return;
    try { await runtime.session.addMessages(messages); }
    catch { throw new Error("Honcho turn synchronization failed."); }
  }

  capabilities(): Capability[] {
    if (this.recallMode === "context") return [];
    return [this.profileCapability(), this.searchCapability(), this.contextCapability(), this.reasoningCapability(), this.conclusionCapability()];
  }

  async shutdown(): Promise<void> {
    this.runtimes.clear();
  }

  private profileCapability(): Capability {
    return capability("memory.honcho.profile", "Read the Honcho user-model peer card and representation.", "network", false,
      { type: "object", properties: { query: { type: "string", maxLength: 2000 } }, additionalProperties: false },
      (input) => ({ ...(typeof input.query === "string" ? { query: boundedText(input.query, 2_000) } : {}) }),
      async (input, context) => {
        const runtime = await this.runtime(context.tenantId, context.sessionId);
        try {
          const profile = await runtime.assistant.context({ target: runtime.user, ...(input.query ? { searchQuery: String(input.query) } : {}), searchTopK: 20, maxConclusions: 100 });
          return untrusted({ representation: boundedText(profile.representation ?? "", 8_000), card: (profile.peerCard ?? []).slice(0, 100).map((item) => boundedText(item, 1_000)) });
        } catch { throw new Error("Honcho profile request failed."); }
      });
  }

  private searchCapability(): Capability {
    return capability("memory.honcho.search", "Search cross-session Honcho memory excerpts.", "network", false,
      { type: "object", required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 4000 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false },
      (input) => ({ query: requiredText(input.query, 4_000, "query"), limit: boundedOptionalInteger(input.limit, 1, 20, 8) }),
      async (input, context) => {
        await this.runtime(context.tenantId, context.sessionId);
        try {
          const results = await this.client.search(String(input.query), { limit: Number(input.limit) });
          return untrusted({ results: results.slice(0, Number(input.limit)).map((item) => ({ id: item.id ?? null, content: boundedText(item.content, 2_000), createdAt: item.createdAt ?? null })) });
        } catch { throw new Error("Honcho search request failed."); }
      });
  }

  private contextCapability(): Capability {
    return capability("memory.honcho.context", "Read bounded session-scoped Honcho summary and user-model context.", "network", false,
      { type: "object", properties: { query: { type: "string", maxLength: 4000 }, tokens: { type: "integer", minimum: 100, maximum: 5000 } }, additionalProperties: false },
      (input) => ({ ...(typeof input.query === "string" ? { query: boundedText(input.query, 4_000) } : {}), tokens: boundedOptionalInteger(input.tokens, 100, 5_000, this.contextTokens) }),
      async (input, context) => {
        const runtime = await this.runtime(context.tenantId, context.sessionId);
        try {
          const result = await runtime.session.context({ summary: true, tokens: Number(input.tokens), peerTarget: runtime.user, peerPerspective: runtime.assistant,
            ...(input.query ? { representationOptions: { searchQuery: String(input.query), searchTopK: 20, maxConclusions: 100 } } : {}) });
          return untrusted({ entries: contextEntries(result) });
        } catch { throw new Error("Honcho context request failed."); }
      });
  }

  private reasoningCapability(): Capability {
    return capability("memory.honcho.reason", "Ask Honcho dialectic reasoning about the modeled user.", "external_side_effect", true,
      { type: "object", required: ["question"], properties: { question: { type: "string", minLength: 1, maxLength: 10000 }, reasoningLevel: { type: "string", enum: ["minimal", "low", "medium", "high", "max"] } }, additionalProperties: false },
      (input) => ({ question: requiredText(input.question, 10_000, "question"), reasoningLevel: reasoningLevel(input.reasoningLevel) }),
      async (input, context) => {
        const runtime = await this.runtime(context.tenantId, context.sessionId);
        try {
          const result = await runtime.assistant.chat(String(input.question), { target: runtime.user, session: runtime.session, reasoningLevel: String(input.reasoningLevel) });
          return untrusted({ answer: boundedText(result ?? "", 12_000) });
        } catch { throw new Error("Honcho reasoning request failed."); }
      });
  }

  private conclusionCapability(): Capability {
    return capability("memory.honcho.conclude", "Create, list, search or delete explicit Honcho conclusions about the user.", "external_side_effect", true,
      { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["create", "list", "search", "delete"] }, content: { type: "string", maxLength: 4000 }, query: { type: "string", maxLength: 4000 }, id: { type: "string", maxLength: 300 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
      validateConclusion,
      async (input, context) => {
        const runtime = await this.runtime(context.tenantId, context.sessionId);
        const scope = runtime.assistant.conclusionsOf(runtime.user);
        try {
          if (input.action === "create") {
            const created = await scope.create({ content: String(input.content), sessionId: runtime.session });
            return { status: "created", ids: created.map((item) => item.id).slice(0, 50) };
          }
          if (input.action === "delete") {
            await scope.delete(String(input.id));
            return { status: "deleted", id: String(input.id) };
          }
          const results = input.action === "search"
            ? await scope.query(String(input.query), Number(input.limit))
            : (await scope.list({ size: Number(input.limit), session: runtime.session, reverse: true })).items;
          return untrusted({ conclusions: results.slice(0, Number(input.limit)).map((item) => ({ id: item.id, content: boundedText(item.content, 2_000), level: item.level ?? null, createdAt: item.createdAt ?? null })) });
        } catch { throw new Error("Honcho conclusion request failed."); }
      });
  }

  private async runtime(tenantId: string, sessionId: string): Promise<Runtime> {
    await this.validateBaseUrl();
    const key = `${tenantId}\0${sessionId}`;
    let pending = this.runtimes.get(key);
    if (!pending) {
      pending = (async () => {
        const tenantProjection = digest(tenantId).slice(0, 16);
        const user = await this.client.peer(`${this.userPeer}-${tenantProjection}`);
        const assistant = await this.client.peer(`${this.assistantPeer}-${tenantProjection}`);
        const session = await this.client.session(`haf-${digest(`${tenantId}\0${sessionId}`).slice(0, 40)}`, { peers: [user, assistant] });
        return { user, assistant, session, prefetchCount: 0, cachedEntries: [] };
      })();
      this.runtimes.set(key, pending);
      pending.catch(() => this.runtimes.delete(key));
    }
    try { return await pending; }
    catch { throw new Error("Honcho session initialization failed."); }
  }

  private async validateBaseUrl(): Promise<void> {
    if (!this.baseUrlValidated) {
      this.baseUrlValidated = (async () => {
        if (this.options.allowPrivateBaseUrl) return;
        await assertSafeUrl(this.baseURL);
      })();
      this.baseUrlValidated.catch(() => { this.baseUrlValidated = undefined; });
    }
    await this.baseUrlValidated;
  }
}

function capability(
  id: string, description: string, risk: Capability["descriptor"]["risk"], sideEffect: boolean,
  inputSchema: JsonValue,
  validate: (input: Record<string, unknown>) => Record<string, JsonValue>,
  execute: Capability["execute"],
): Capability {
  return {
    descriptor: { id, version: "1.0.0", description, risk, sideEffect, inputSchema, source: "core" },
    validate(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${id} expects an object input.`);
      return validate(input as Record<string, unknown>);
    },
    execute,
  };
}

function contextEntries(context: HonchoContextLike): string[] {
  const entries: string[] = [];
  if (context.summary?.content) entries.push(`Session summary: ${boundedText(sanitizeExternalContext(context.summary.content), 4_000)}`);
  if (context.peerRepresentation) entries.push(`User representation: ${boundedText(sanitizeExternalContext(context.peerRepresentation), 6_000)}`);
  for (const item of context.peerCard ?? []) entries.push(`User fact: ${boundedText(sanitizeExternalContext(item), 1_000)}`);
  return entries.slice(0, 100);
}
function chunkText(value: string, max: number): string[] {
  const text = value.trim();
  if (!text) return [];
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += max - 32) {
    const part = text.slice(offset, offset + max - 32);
    chunks.push(`${offset ? "[continued] " : ""}${part}${offset + max - 32 < text.length ? " [continues]" : ""}`);
  }
  return chunks;
}
function validateConclusion(input: Record<string, unknown>): Record<string, JsonValue> {
  const action = String(input.action ?? "");
  if (!new Set(["create", "list", "search", "delete"]).has(action)) throw new Error("Honcho conclusion action is invalid.");
  if (action === "create") return { action, content: requiredText(input.content, 4_000, "content") };
  if (action === "delete") return { action, id: requiredText(input.id, 300, "id") };
  if (action === "search") return { action, query: requiredText(input.query, 4_000, "query"), limit: boundedOptionalInteger(input.limit, 1, 50, 10) };
  return { action, limit: boundedOptionalInteger(input.limit, 1, 50, 20) };
}
function untrusted(value: Record<string, JsonValue>): JsonValue { return { untrustedExternalMemory: true, ...value }; }
function boundedId(value: string, max: number): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized.length > max) throw new Error("Honcho workspace/peer identifier is invalid.");
  return normalized;
}
function requiredText(value: unknown, max: number, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Honcho ${name} is required.`);
  return boundedText(value.trim(), max);
}
function boundedText(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`; }
function boundedOptionalInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`Expected integer ${min}-${max}.`);
  return value;
}
function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Honcho ${name} must be an integer between ${min} and ${max}.`);
  return value;
}
function reasoningLevel(value: unknown): HonchoReasoningLevel {
  return (["minimal", "low", "medium", "high", "max"] as const).includes(value as HonchoReasoningLevel) ? value as HonchoReasoningLevel : "low";
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function hardenOfficialSdkTransport(client: HonchoClientLike, origin: string, defaultTimeoutMs: number, allowPrivate: boolean): void {
  const http = (client as any).http;
  if (!http || typeof http.fetchWithTimeout !== "function") {
    throw new Error("Honcho SDK transport does not expose the required hardening boundary.");
  }
  http.fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
    const target = allowPrivate ? new URL(url) : await assertSafeUrl(url);
    if (target.origin !== origin) throw new Error("Honcho SDK request attempted to leave its configured origin.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(60_000, Math.max(500, timeoutMs ?? defaultTimeoutMs)));
    timeout.unref();
    const abort = () => controller.abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(target, { ...init, redirect: "manual", signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Honcho SDK redirects are forbidden.");
      }
      return response;
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", abort);
    }
  };
}
