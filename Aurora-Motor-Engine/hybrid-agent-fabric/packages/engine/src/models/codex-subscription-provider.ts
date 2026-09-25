import { createHash, randomUUID } from "node:crypto";
import type { JsonValue, ModelProvider, ModelRequest, ModelStreamEvent, ToolCallContent } from "../types.js";
import { CodexOAuthManager } from "./codex-oauth-manager.js";
import { modelHttpError, ModelProviderError, retryAfterMilliseconds } from "./model-provider-error.js";
import { openAIResponsesInputItems } from "./openai-responses-provider.js";

const CODEX_ORIGIN = "https://chatgpt.com";
const CODEX_BASE_URL = `${CODEX_ORIGIN}/backend-api/codex`;
const HARMONY_TOKEN = /<\|(start|end|channel|message|constrain|return|call)\|>/g;

export interface CodexSubscriptionProviderOptions {
  id?: string;
  model: string;
  oauth: CodexOAuthManager;
  reasoningEffort?: "low" | "medium" | "high" | "max";
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

/** Native ChatGPT Codex subscription transport. No API-key fallback is attempted. */
export class CodexSubscriptionProvider implements ModelProvider {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: CodexSubscriptionProviderOptions) {
    this.id = options.id ?? "openai-codex";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = Math.min(10 * 60_000, Math.max(5_000, options.requestTimeoutMs ?? 180_000));
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const tenantId = request.tenantId;
    if (!tenantId) throw new ModelProviderError("Codex subscription requests require tenant context.", { providerId: this.id, code: "tenant_required" });
    let authorization = await this.options.oauth.getAuthorization(tenantId);
    const model = selectedModel(request, this.options.model);
    const tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.id.replaceAll(".", "__"),
      description: `${tool.description} [capability-id: ${tool.id}]`,
      parameters: tool.inputSchema,
      strict: false,
    }));
    const cacheKey = `pck_${createHash("sha256").update(`${request.sessionId}\0${request.systemPrompt}\0${stableJson(tools)}`).digest("hex").slice(0, 24)}`;
    const body: Record<string, unknown> = neutralizeHarmony({
      model,
      instructions: request.systemPrompt,
      input: await openAIResponsesInputItems(request.messages, request.workspacePath),
      ...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
      reasoning: { effort: request.reasoningEffort ?? this.options.reasoningEffort ?? "medium", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: cacheKey,
      store: false,
      stream: true,
    }) as Record<string, unknown>;

    let response = await this.send(request, authorization, cacheKey, body);
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      authorization = await this.options.oauth.forceRefreshAuthorization(tenantId);
      response = await this.send(request, authorization, cacheKey, body);
    }
    if (response.status === 429) {
      const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
      await this.options.oauth.noteRateLimit(tenantId, retryAfterMs);
      throw await modelHttpError(this.id, response);
    }
    if (!response.ok) throw await modelHttpError(this.id, response);
    if (!response.body) throw new ModelProviderError("Codex subscription returned no event stream.", { providerId: this.id, code: "empty_stream", retryable: true });

    let activePhase: string | undefined;
    let emittedText = false;
    let toolUse = false;
    let terminal = false;
    for await (const event of sseJson(response.body, request.signal)) {
      const type = typeof event.type === "string" ? event.type : "";
      if (type === "error") {
        const failure = streamError(this.id, event);
        if (failure.code === "rate_limited") await this.options.oauth.noteRateLimit(tenantId, failure.retryAfterMs);
        throw failure;
      }
      if (type === "response.output_item.added") {
        const item = record(event.item);
        activePhase = item?.type === "message" && typeof item.phase === "string" ? item.phase.toLowerCase() : undefined;
        if (typeof item?.type === "string" && item.type.includes("function_call")) toolUse = true;
        continue;
      }
      if (type.includes("output_text.delta")) {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (!delta) continue;
        if (activePhase === "analysis" || activePhase === "commentary") yield { type: "reasoning_delta", delta };
        else {
          emittedText = true;
          yield { type: "text_delta", delta };
        }
        continue;
      }
      if (type.includes("reasoning") && type.includes("delta")) {
        if (typeof event.delta === "string" && event.delta) yield { type: "reasoning_delta", delta: event.delta };
        continue;
      }
      if (type === "response.output_item.done") {
        const item = record(event.item);
        if (item?.type === "function_call" && typeof item.name === "string") {
          toolUse = true;
          yield { type: "tool_call", call: toolCall(item) };
        } else if (!emittedText && item?.type === "message" && item.phase !== "analysis" && item.phase !== "commentary") {
          for (const part of Array.isArray(item.content) ? item.content : []) {
            if (record(part)?.type === "output_text" && typeof record(part)?.text === "string" && record(part)!.text) {
              emittedText = true;
              yield { type: "text_delta", delta: String(record(part)!.text) };
            }
          }
        }
        continue;
      }
      if (["response.completed", "response.incomplete", "response.failed"].includes(type)) {
        terminal = true;
        const responseValue = record(event.response) ?? {};
        if (type === "response.failed") {
          const error = record(responseValue.error);
          const failure = streamError(this.id, { ...error, type: "error" });
          if (failure.code === "rate_limited") await this.options.oauth.noteRateLimit(tenantId, failure.retryAfterMs);
          throw failure;
        }
        const usage = record(responseValue.usage);
        yield { type: "usage", usage: usage ? normalizeUsage(usage) : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
        const incomplete = record(responseValue.incomplete_details)?.reason;
        yield { type: "done", stopReason: toolUse ? "tool_use" : incomplete === "max_output_tokens" ? "max_tokens" : "end_turn" };
        break;
      }
    }
    if (!terminal) throw new ModelProviderError("Codex subscription stream ended without a terminal event.", { providerId: this.id, code: "truncated_stream", retryable: !emittedText });
  }

  private async send(request: ModelRequest, auth: { accessToken: string; accountId?: string }, cacheKey: string, body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    try {
      const target = new URL(`${CODEX_BASE_URL}/responses`);
      if (target.origin !== CODEX_ORIGIN) throw new Error("Codex endpoint origin mismatch.");
      const response = await this.fetchImpl(target, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${auth.accessToken}`,
          "user-agent": "codex_cli_rs/0.0.0 (Hybrid Agent Fabric)",
          originator: "codex_cli_rs",
          ...(auth.accountId ? { "ChatGPT-Account-ID": auth.accountId } : {}),
          session_id: request.sessionId,
          "x-client-request-id": cacheKey,
        },
        body: JSON.stringify(body),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        throw new ModelProviderError("Codex subscription redirects are forbidden.", { providerId: this.id, code: "redirect_forbidden" });
      }
      return response;
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ModelProviderError("Codex subscription network request failed.", { providerId: this.id, code: "transport_error", retryable: true, cause: error });
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
    }
  }
}

async function* sseJson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Record<string, any>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw new Error("Codex SSE event exceeds 2 MiB.");
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) yield parsed;
      }
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) throw new Error("Codex SSE buffer exceeds 2 MiB.");
    }
  } finally { reader.releaseLock(); }
}

function toolCall(item: Record<string, any>): ToolCallContent {
  let args: Record<string, JsonValue> = {};
  try {
    const parsed = JSON.parse(typeof item.arguments === "string" ? item.arguments : "{}");
    args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed as JsonValue };
  } catch { args = { raw: String(item.arguments ?? "").slice(0, 20_000) }; }
  return {
    type: "tool_call",
    id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : randomUUID(),
    name: String(item.name).replaceAll("__", "."),
    arguments: args,
  };
}
function normalizeUsage(value: Record<string, any>) {
  return {
    inputTokens: number(value.input_tokens),
    outputTokens: number(value.output_tokens),
    cacheReadTokens: number(record(value.input_tokens_details)?.cached_tokens),
    cacheWriteTokens: 0,
  };
}
function streamError(providerId: string, event: Record<string, any>): ModelProviderError {
  const code = typeof event.code === "string" ? event.code.slice(0, 100) : "stream_error";
  const rateLimited = /rate|quota|usage/i.test(code) || event.status === 429;
  const credential = /auth|token|account|unauthorized/i.test(code) || event.status === 401 || event.status === 403;
  return new ModelProviderError(`Codex subscription stream failed (${code}).`, {
    providerId,
    ...(typeof event.status === "number" ? { status: event.status } : {}),
    code: rateLimited ? "rate_limited" : credential ? "credential_rejected" : code,
    retryable: rateLimited,
    credentialDisposition: credential ? "disable" : rateLimited ? "cooldown" : "none",
  });
}
function neutralizeHarmony(value: unknown): unknown {
  if (typeof value === "string") return value.replace(HARMONY_TOKEN, "<｜$1｜>");
  if (Array.isArray(value)) return value.map(neutralizeHarmony);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (HARMONY_TOKEN.test(key)) throw new ModelProviderError("Reserved Codex wire token in object key.", { providerId: "openai-codex", code: "invalid_prompt" });
      HARMONY_TOKEN.lastIndex = 0;
      output[key] = neutralizeHarmony(item);
    }
    return output;
  }
  return value;
}
function selectedModel(request: ModelRequest, fallback: string): string {
  return request.model?.includes(":") ? request.model.slice(request.model.indexOf(":") + 1) : fallback;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function record(value: unknown): Record<string, any> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined; }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
