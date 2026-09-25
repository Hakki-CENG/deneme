import { describe, expect, it } from "vitest";
import { CodexSubscriptionProvider } from "../src/models/codex-subscription-provider.js";
import { ModelProviderError } from "../src/models/model-provider-error.js";
import type { ModelRequest } from "../src/types.js";

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}
function request(): ModelRequest {
  return {
    tenantId: "tenant",
    sessionId: "session-id",
    turnId: "turn-id",
    model: "openai-codex:account-model",
    systemPrompt: "Never emit <|channel|> wire tokens.",
    messages: [{ id: "u", role: "user", timestamp: new Date(0).toISOString(), content: [{ type: "text", text: "hello <|start|>" }] }],
    tools: [{ id: "filesystem.read", version: "1", description: "read", risk: "workspace_read", sideEffect: false, inputSchema: { type: "object" }, source: "core" }],
  };
}

describe("native Codex subscription Responses transport", () => {
  it("sends first-party headers, neutralizes Harmony tokens and streams reasoning/text/tools/usage", async () => {
    let captured: { url: string; headers: Headers; body: any } | undefined;
    const oauth: any = {
      async getAuthorization() { return { accessToken: "access-secret", accountId: "account-secret", expiresAt: Date.now() + 3600_000 }; },
      async forceRefreshAuthorization() { throw new Error("unexpected refresh"); },
      async noteRateLimit() {},
    };
    const provider = new CodexSubscriptionProvider({
      model: "fallback",
      oauth,
      fetch: async (input, init) => {
        captured = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
        return sse([
          { type: "response.output_item.added", item: { type: "message", phase: "commentary" } },
          { type: "response.output_text.delta", delta: "checking" },
          { type: "response.output_item.added", item: { type: "message", phase: "final" } },
          { type: "response.output_text.delta", delta: "answer" },
          { type: "response.output_item.done", item: { type: "function_call", call_id: "call-1", name: "filesystem__read", arguments: "{\"path\":\"README.md\"}" } },
          { type: "response.completed", response: { status: "completed", usage: { input_tokens: 20, output_tokens: 8, input_tokens_details: { cached_tokens: 5 } } } },
        ]);
      },
    });
    const events = [];
    for await (const event of provider.stream(request())) events.push(event);
    expect(captured?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(captured?.headers.get("authorization")).toBe("Bearer access-secret");
    expect(captured?.headers.get("chatgpt-account-id")).toBe("account-secret");
    expect(captured?.headers.get("originator")).toBe("codex_cli_rs");
    expect(captured?.headers.get("session_id")).toBe("session-id");
    expect(captured?.headers.get("x-client-request-id")).toMatch(/^pck_[a-f0-9]{24}$/);
    expect(captured?.body.model).toBe("account-model");
    expect(captured?.body.store).toBe(false);
    expect(captured?.body.stream).toBe(true);
    expect(captured?.body.max_output_tokens).toBeUndefined();
    expect(JSON.stringify(captured?.body)).not.toContain("<|channel|>");
    expect(JSON.stringify(captured?.body)).not.toContain("<|start|>");
    expect(events).toContainEqual({ type: "reasoning_delta", delta: "checking" });
    expect(events).toContainEqual({ type: "text_delta", delta: "answer" });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", call: expect.objectContaining({ id: "call-1", name: "filesystem.read", arguments: { path: "README.md" } }) }));
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 5, cacheWriteTokens: 0 } });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });

  it("refreshes once after a pre-output 401 and never puts credentials in the body", async () => {
    let requests = 0;
    let refreshes = 0;
    const oauth: any = {
      async getAuthorization() { return { accessToken: "old-token", expiresAt: Date.now() + 3600_000 }; },
      async forceRefreshAuthorization() { refreshes++; return { accessToken: "new-token", expiresAt: Date.now() + 3600_000 }; },
      async noteRateLimit() {},
    };
    const bodies: string[] = [];
    const authHeaders: string[] = [];
    const provider = new CodexSubscriptionProvider({
      model: "model", oauth,
      fetch: async (_input, init) => {
        requests++;
        bodies.push(String(init?.body));
        authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
        if (requests === 1) return new Response("unauthorized", { status: 401 });
        return sse([{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: { status: "completed" } }]);
      },
    });
    const events = [];
    for await (const event of provider.stream(request())) events.push(event);
    expect(requests).toBe(2);
    expect(refreshes).toBe(1);
    expect(authHeaders).toEqual(["Bearer old-token", "Bearer new-token"]);
    expect(bodies.every((body) => !body.includes("old-token") && !body.includes("new-token"))).toBe(true);
    expect(events).toContainEqual({ type: "text_delta", delta: "ok" });
  });

  it("does not classify a truncated stream as retryable after partial model output", async () => {
    const oauth: any = { async getAuthorization() { return { accessToken: "token", expiresAt: Date.now() + 3600_000 }; }, async noteRateLimit() {} };
    const provider = new CodexSubscriptionProvider({ model: "model", oauth, fetch: async () => sse([{ type: "response.output_text.delta", delta: "partial" }]) });
    const iterator = provider.stream(request());
    expect(await iterator.next()).toEqual({ done: false, value: { type: "text_delta", delta: "partial" } });
    await expect(iterator.next()).rejects.toMatchObject({ code: "truncated_stream", retryable: false });
  });

  it("rejects redirects before sending model output", async () => {
    const oauth: any = { async getAuthorization() { return { accessToken: "token", expiresAt: Date.now() + 3600_000 }; }, async noteRateLimit() {} };
    const provider = new CodexSubscriptionProvider({ model: "model", oauth, fetch: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }) });
    const consume = async () => { for await (const _event of provider.stream(request())) {} };
    await expect(consume()).rejects.toBeInstanceOf(ModelProviderError);
    await expect(consume()).rejects.toMatchObject({ code: "redirect_forbidden" });
  });
});
