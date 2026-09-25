import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIResponsesProvider } from "../src/models/openai-responses-provider.js";
import type { ModelRequest } from "../src/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("OpenAI Responses provider", () => {
  it("translates conversation/tool history and normalizes output without server storage", async () => {
    let requestBody: any;
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        output: [
          { type: "message", content: [{ type: "output_text", text: "checking" }] },
          { type: "function_call", call_id: "call-2", name: "filesystem__read", arguments: "{\"path\":\"README.md\"}" },
        ],
        usage: { input_tokens: 20, output_tokens: 9, input_tokens_details: { cached_tokens: 4 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const request: ModelRequest = {
      sessionId: "session",
      turnId: "turn",
      model: "openai-responses:test-model",
      systemPrompt: "system",
      messages: [
        { id: "u1", role: "user", timestamp: new Date(0).toISOString(), content: [{ type: "text", text: "hello" }] },
        { id: "a1", role: "assistant", timestamp: new Date(1).toISOString(), content: [
          { type: "text", text: "calling" },
          { type: "tool_call", id: "call-1", name: "filesystem.read", arguments: { path: "a.txt" } },
        ] },
        { id: "t1", role: "tool", timestamp: new Date(2).toISOString(), content: [
          { type: "tool_result", toolCallId: "call-1", name: "filesystem.read", result: { content: "a" }, isError: false },
        ] },
      ],
      tools: [{
        id: "filesystem.read",
        version: "1",
        description: "read",
        risk: "workspace_read",
        sideEffect: false,
        inputSchema: { type: "object" },
        source: "core",
      }],
    };
    const events = [];
    for await (const event of new OpenAIResponsesProvider({ apiKey: "secret", model: "fallback" }).stream(request)) events.push(event);
    expect(requestBody.model).toBe("test-model");
    expect(requestBody.store).toBe(false);
    expect(requestBody.instructions).toBe("system");
    expect(requestBody.input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call-1", name: "filesystem__read" }));
    expect(requestBody.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call-1" }));
    expect(events).toContainEqual({ type: "text_delta", delta: "checking" });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", call: expect.objectContaining({ id: "call-2", name: "filesystem.read" }) }));
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 20, outputTokens: 9, cacheReadTokens: 4, cacheWriteTokens: 0 } });
  });
});
