import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderProfileRegistry } from "../src/models/provider-profiles.js";
import { AnthropicProvider } from "../src/models/anthropic-provider.js";
import { HybridAgentEngine } from "../src/engine.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("provider profiles", () => {
  it("ships a provider-neutral catalog and resolves aliases", () => {
    const registry = new ProviderProfileRegistry();
    expect(registry.get("gemini")?.id).toBe("google");
    expect(registry.list().map((item) => item.id)).toEqual(expect.arrayContaining([
      "openai", "anthropic", "openrouter", "google", "groq", "xai", "deepseek", "mistral", "ollama",
    ]));
    expect(() => registry.createProvider({ profileId: "anthropic", model: "test" })).toThrow("ANTHROPIC_API_KEY");
    const local = registry.createProvider({ profileId: "ollama", model: "local-model" });
    expect(local.modelName).toBe("ollama:local-model");
  });

  it("normalizes native Anthropic text, tool calls and usage", async () => {
    let requestBody: any;
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "tool-1", name: "filesystem__read", input: { path: "a.txt" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "test", model: "claude-test" });
    const events = [];
    for await (const event of provider.stream({
      sessionId: "session",
      turnId: "turn",
      systemPrompt: "system",
      messages: [{ id: "m1", role: "user", timestamp: new Date().toISOString(), content: [{ type: "text", text: "hello" }] }],
      tools: [{
        id: "filesystem.read",
        version: "1",
        description: "read",
        risk: "workspace_read",
        sideEffect: false,
        inputSchema: { type: "object" },
        source: "core",
      }],
    })) events.push(event);
    expect(requestBody.tools[0].name).toBe("filesystem__read");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", call: expect.objectContaining({ name: "filesystem.read" }) }));
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 } });
  });

  it("persists a provider:model selection per session", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-model-select-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
    });
    const session = await engine.createSession({ tenantId: "local" });
    const result = await engine.command({
      protocolVersion: 1,
      commandId: randomUUID(),
      clientId: "model-test",
      tenantId: "local",
      sessionId: session.sessionId,
      kind: "model.select",
      source: "api",
      issuedAt: new Date().toISOString(),
      payload: { model: "mock:test-model" },
    });
    expect(result.status).toBe("completed");
    expect((await engine.session(session.sessionId)).modelName).toBe("mock:test-model");
    await engine.shutdown();
  });
});
