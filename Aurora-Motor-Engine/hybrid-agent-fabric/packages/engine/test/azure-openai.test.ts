import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureOpenAIProvider } from "../src/models/azure-openai-provider.js";
import { ProviderProfileRegistry } from "../src/models/provider-profiles.js";
import type { ModelRequest } from "../src/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("native Azure OpenAI deployment provider", () => {
  it("uses deployment routing and api-key auth without leaking the key into URL/body", async () => {
    let url = "";
    let headers: Headers;
    let body = "";
    globalThis.fetch = vi.fn(async (input, init) => {
      url = String(input); headers = new Headers(init?.headers); body = String(init?.body);
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "tool_calls", message: { content: "checking", tool_calls: [{ id: "call-1", function: { name: "filesystem__read", arguments: "{\"path\":\"README.md\"}" } }] } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const request: ModelRequest = {
      sessionId: "session", turnId: "turn", systemPrompt: "system",
      messages: [{ id: "u", role: "user", timestamp: new Date(0).toISOString(), content: [{ type: "text", text: "hello" }] }],
      tools: [{ id: "filesystem.read", version: "1", description: "read", risk: "workspace_read", sideEffect: false, inputSchema: { type: "object" }, source: "core" }],
    };
    const events = [];
    for await (const event of new AzureOpenAIProvider({
      endpoint: "https://sample.openai.azure.com", apiKey: "azure-secret", deployment: "gpt-deploy", apiVersion: "2025-01-01-preview",
    }).stream(request)) events.push(event);
    expect(url).toBe("https://sample.openai.azure.com/openai/deployments/gpt-deploy/chat/completions?api-version=2025-01-01-preview");
    expect(headers!.get("api-key")).toBe("azure-secret");
    expect(headers!.get("authorization")).toBeNull();
    expect(url + body).not.toContain("azure-secret");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", call: expect.objectContaining({ name: "filesystem.read" }) }));
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 0 } });
  });

  it("requires an explicit endpoint in the provider profile", () => {
    const registry = new ProviderProfileRegistry();
    expect(registry.get("azure-openai")?.apiMode).toBe("azure-openai-chat");
    expect(() => registry.createProvider({ profileId: "azure-openai", apiKey: "x", model: "deployment" })).toThrow("explicit base URL");
    expect(registry.createProvider({ profileId: "azure-openai", apiKey: "x", model: "deployment", baseUrl: "https://sample.openai.azure.com" }).provider.id).toBe("azure-openai");
  });
});
