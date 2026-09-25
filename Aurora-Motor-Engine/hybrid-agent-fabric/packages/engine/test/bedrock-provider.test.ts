import { describe, expect, it } from "vitest";
import { BedrockProvider } from "../src/models/bedrock-provider.js";
import { ProviderProfileRegistry } from "../src/models/provider-profiles.js";
import type { ModelRequest } from "../src/types.js";

class FakeBedrockClient {
  input: any;
  async send(command: any) {
    this.input = command.input;
    return {
      output: { message: { role: "assistant", content: [
        { text: "bedrock-ok" },
        { toolUse: { toolUseId: "tool-2", name: "filesystem__read", input: { path: "README.md" } } },
      ] } },
      stopReason: "tool_use",
      usage: { inputTokens: 20, outputTokens: 8, cacheReadInputTokens: 4, cacheWriteInputTokens: 2 },
    };
  }
}

describe("native AWS Bedrock Converse provider", () => {
  it("translates tools/history and normalizes Bedrock usage", async () => {
    const client = new FakeBedrockClient();
    const provider = new BedrockProvider({
      region: "us-east-1", model: "anthropic.claude-test-v1", client,
    });
    const request: ModelRequest = {
      sessionId: "s", turnId: "t", systemPrompt: "system",
      messages: [
        { id: "u", role: "user", timestamp: new Date(0).toISOString(), content: [{ type: "text", text: "hello" }] },
        { id: "a", role: "assistant", timestamp: new Date(1).toISOString(), content: [{ type: "tool_call", id: "tool-1", name: "filesystem.read", arguments: { path: "a.txt" } }] },
        { id: "r", role: "tool", timestamp: new Date(2).toISOString(), content: [{ type: "tool_result", toolCallId: "tool-1", name: "filesystem.read", result: { content: "a" }, isError: false }] },
      ],
      tools: [{ id: "filesystem.read", version: "1", description: "read", risk: "workspace_read", sideEffect: false, inputSchema: { type: "object" }, source: "core" }],
    };
    const events = [];
    for await (const event of provider.stream(request)) events.push(event);
    expect(client.input.modelId).toBe("anthropic.claude-test-v1");
    expect(client.input.toolConfig.tools[0].toolSpec.name).toBe("filesystem__read");
    expect(JSON.stringify(client.input.messages)).toContain("toolUse");
    expect(JSON.stringify(client.input.messages)).toContain("toolResult");
    expect(events).toContainEqual({ type: "text_delta", delta: "bedrock-ok" });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", call: expect.objectContaining({ id: "tool-2", name: "filesystem.read" }) }));
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 4, cacheWriteTokens: 2 } });
  });

  it("uses the AWS default credential chain and rejects API-key pools", () => {
    const registry = new ProviderProfileRegistry();
    const created = registry.createProvider({ profileId: "aws-bedrock", model: "model-id", region: "eu-west-1" });
    expect(created.provider.id).toBe("aws-bedrock");
    expect(() => registry.createProvider({ profileId: "aws-bedrock", model: "model-id", region: "eu-west-1", apiKey: "not-allowed" })).toThrow("default credential chain");
  });
});
