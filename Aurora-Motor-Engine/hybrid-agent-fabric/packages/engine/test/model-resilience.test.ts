import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "../src/types.js";
import { GeminiProvider } from "../src/models/gemini-provider.js";
import { CredentialPoolModelProvider } from "../src/models/provider-credential-pool.js";
import { ModelProviderError, modelHttpError } from "../src/models/model-provider-error.js";
import { ModelProviderRegistry } from "../src/models/model-router.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const request: ModelRequest = {
  sessionId: "session",
  turnId: "turn",
  model: "google:gemini-3-flash-preview",
  systemPrompt: "system",
  messages: [{ id: "user-1", role: "user", timestamp: new Date(0).toISOString(), content: [{ type: "text", text: "hello" }] }],
  tools: [{
    id: "filesystem.read",
    version: "1",
    description: "Read a workspace file",
    risk: "workspace_read",
    sideEffect: false,
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    source: "core",
  }],
};

async function collect(provider: ModelProvider, input: ModelRequest = request): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream(input)) events.push(event);
  return events;
}

describe("native Gemini and resilient model routing", () => {
  it("uses native GenerateContent, preserves Gemini 3 tool ids and normalizes output", async () => {
    let url = "";
    let headers: Headers;
    let body: any;
    globalThis.fetch = vi.fn(async (input, init) => {
      url = String(input);
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        candidates: [{
          finishReason: "STOP",
          content: { parts: [
            { text: "thinking", thought: true },
            { text: "done" },
            { functionCall: { id: "call-2", name: "filesystem__read", args: { path: "README.md" } } },
          ] },
        }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, cachedContentTokenCount: 3 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const provider = new GeminiProvider({ apiKey: "secret-google-key", model: "gemini-3-flash-preview" });
    const replayRequest: ModelRequest = {
      ...request,
      messages: [
        ...request.messages,
        { id: "assistant-1", role: "assistant", timestamp: new Date(1).toISOString(), content: [{ type: "tool_call", id: "call-1", name: "filesystem.read", arguments: { path: "a.txt" } }] },
        { id: "tool-1", role: "tool", timestamp: new Date(2).toISOString(), content: [{ type: "tool_result", toolCallId: "call-1", name: "filesystem.read", result: { content: "a" }, isError: false }] },
      ],
    };
    const events = await collect(provider, replayRequest);
    expect(url).toContain("/models/gemini-3-flash-preview:generateContent");
    expect(url).not.toContain("secret-google-key");
    expect(headers!.get("x-goog-api-key")).toBe("secret-google-key");
    expect(body.tools[0].functionDeclarations[0].name).toBe("filesystem__read");
    const replayCall = body.contents.flatMap((item: any) => item.parts).find((part: any) => part.functionCall?.name === "filesystem__read");
    const replayResult = body.contents.flatMap((item: any) => item.parts).find((part: any) => part.functionResponse?.name === "filesystem__read");
    expect(replayCall.functionCall.id).toBe("call-1");
    expect(replayResult.functionResponse.id).toBe("call-1");
    expect(events).toContainEqual({ type: "reasoning_delta", delta: "thinking" });
    expect(events).toContainEqual({ type: "text_delta", delta: "done" });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", call: expect.objectContaining({ id: "call-2", name: "filesystem.read" }) }));
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 } });
  });

  it("rotates same-provider credentials on pre-output throttling without exposing secrets", async () => {
    const attempted: string[] = [];
    const pool = new CredentialPoolModelProvider("pooled", [
      { id: "first", apiKey: "first-secret" },
      { id: "second", apiKey: "second-secret" },
    ], (apiKey): ModelProvider => ({
      id: "pooled",
      async *stream() {
        attempted.push(apiKey);
        if (apiKey === "first-secret") {
          throw new ModelProviderError("rate limited", {
            providerId: "pooled",
            status: 429,
            code: "rate_limited",
            retryable: true,
            credentialDisposition: "cooldown",
            retryAfterMs: 60_000,
          });
        }
        yield { type: "text_delta", delta: "ok" };
        yield { type: "done", stopReason: "end_turn" };
      },
    }), { now: () => Date.parse("2026-08-18T00:00:00.000Z") });
    expect(await collect(pool)).toEqual([
      { type: "text_delta", delta: "ok" },
      { type: "done", stopReason: "end_turn" },
    ]);
    expect(attempted).toEqual(["first-secret", "second-secret"]);
    const encoded = JSON.stringify(pool.status());
    expect(encoded).toContain("first");
    expect(encoded).not.toContain("first-secret");
    expect(pool.status().entries.find((entry) => entry.id === "first")?.state).toBe("cooldown");
  });

  it("redacts reflected credentials from bounded provider diagnostics", async () => {
    const error = await modelHttpError("provider", new Response(JSON.stringify({
      error: "Authorization: Bearer super-secret-token-value",
      api_key: "sk-proj-reflected-secret-value",
    }), { status: 401 }));
    expect(error.message).not.toContain("super-secret-token-value");
    expect(error.message).not.toContain("sk-proj-reflected-secret-value");
    expect(error.credentialDisposition).toBe("disable");
  });

  it("uses only explicit fallback routes and does not replay after partial output", async () => {
    const router = new ModelProviderRegistry();
    router.register({ id: "primary", async *stream() { throw new ModelProviderError("down", { providerId: "primary", code: "transport_error", retryable: true }); } }, true);
    router.register({ id: "backup", async *stream() { yield { type: "text_delta", delta: "backup" }; yield { type: "done", stopReason: "end_turn" }; } });
    const events = await collect(router, { ...request, model: "primary:p1", fallbackModels: ["backup:b1"] });
    expect(events).toContainEqual(expect.objectContaining({ type: "route_failed", provider: "primary" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "route_selected", provider: "backup", fallback: true }));
    expect(events).toContainEqual({ type: "text_delta", delta: "backup" });

    const partial = new ModelProviderRegistry();
    partial.register({ id: "partial", async *stream() { yield { type: "text_delta", delta: "half" }; throw new Error("stream broke"); } }, true);
    partial.register({ id: "unused", async *stream() { yield { type: "text_delta", delta: "duplicate" }; } });
    const received: ModelStreamEvent[] = [];
    await expect((async () => {
      for await (const event of partial.stream({ ...request, model: "partial:p", fallbackModels: ["unused:u"] })) received.push(event);
    })()).rejects.toThrow("stream broke");
    expect(received).not.toContainEqual({ type: "text_delta", delta: "duplicate" });
  });
});
