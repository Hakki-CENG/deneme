import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/models/openai-compatible-provider.js";
import { OpenAIResponsesProvider } from "../src/models/openai-responses-provider.js";
import { AnthropicProvider } from "../src/models/anthropic-provider.js";
import { GeminiProvider } from "../src/models/gemini-provider.js";
import { AzureOpenAIProvider } from "../src/models/azure-openai-provider.js";
import { BedrockProvider } from "../src/models/bedrock-provider.js";
import { resolveWorkspaceImage } from "../src/models/multimodal.js";
import type { ModelProvider, ModelRequest } from "../src/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function consume(provider: ModelProvider, request: ModelRequest) {
  for await (const _event of provider.stream(request)) {}
}

describe("workspace-confined multimodal projection", () => {
  it("projects one verified image into OpenAI, Responses, Anthropic, Gemini and Azure native payloads", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-multimodal-"));
    const bytes = Buffer.from(pngBase64, "base64");
    await writeFile(join(workspace, "image.png"), bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const request: ModelRequest = {
      sessionId: "s", turnId: "t", workspacePath: workspace, systemPrompt: "system", tools: [],
      messages: [{ id: "u", role: "user", timestamp: new Date(0).toISOString(), content: [
        { type: "text", text: "describe" },
        { type: "image", path: "image.png", mimeType: "image/png", sha256, alt: "pixel" },
      ] }],
    };
    const requests: Array<{ url: string; body: any; headers: Headers }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input); const body = JSON.parse(String(init?.body)); requests.push({ url, body, headers: new Headers(init?.headers) });
      if (url.includes("anthropic")) return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }), { status: 200 });
      if (url.includes("generativelanguage")) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: {} }), { status: 200 });
      if (url.endsWith("/responses")) return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: {} }), { status: 200 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200 });
    }) as typeof fetch;
    await consume(new OpenAICompatibleProvider({ baseUrl: "https://openai.example/v1", apiKey: "x", model: "m" }), request);
    await consume(new OpenAIResponsesProvider({ baseUrl: "https://responses.example/v1", apiKey: "x", model: "m" }), request);
    await consume(new AnthropicProvider({ baseUrl: "https://anthropic.example", apiKey: "x", model: "m" }), request);
    await consume(new GeminiProvider({ baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "x", model: "m" }), request);
    await consume(new AzureOpenAIProvider({ endpoint: "https://sample.openai.azure.com", apiKey: "x", deployment: "m" }), request);
    let bedrockInput: any;
    await consume(new BedrockProvider({ region: "us-east-1", model: "m", client: { async send(command: any) { bedrockInput = command.input; return { output: { message: { content: [{ text: "ok" }] } }, usage: {} }; } } }), request);

    const openAI = requests.find((item) => item.url.includes("openai.example"))!.body;
    expect(openAI.messages[1].content).toContainEqual(expect.objectContaining({ type: "image_url", image_url: expect.objectContaining({ url: expect.stringContaining("data:image/png;base64,") }) }));
    const responses = requests.find((item) => item.url.endsWith("/responses"))!.body;
    expect(responses.input[0].content).toContainEqual(expect.objectContaining({ type: "input_image", image_url: expect.stringContaining("data:image/png;base64,") }));
    const anthropic = requests.find((item) => item.url.includes("anthropic"))!.body;
    expect(anthropic.messages[0].content).toContainEqual(expect.objectContaining({ type: "image", source: expect.objectContaining({ media_type: "image/png", data: pngBase64 }) }));
    const gemini = requests.find((item) => item.url.includes("generativelanguage"))!.body;
    expect(gemini.contents[0].parts).toContainEqual({ inlineData: { mimeType: "image/png", data: pngBase64 } });
    const azure = requests.find((item) => item.url.includes("openai.azure"))!.body;
    expect(azure.messages[1].content).toContainEqual(expect.objectContaining({ type: "image_url" }));
    expect(bedrockInput.messages[0].content).toContainEqual(expect.objectContaining({ image: expect.objectContaining({ format: "png", source: expect.objectContaining({ bytes: expect.any(Uint8Array) }) }) }));
  });

  it("rejects MIME/hash mismatch and workspace escape before any provider request", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-multimodal-boundary-"));
    const workspace = join(root, "workspace");
    await writeFile(join(root, "outside.png"), Buffer.from(pngBase64, "base64"));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, "image.png"), Buffer.from(pngBase64, "base64"));
    await expect(resolveWorkspaceImage({ type: "image", path: "../outside.png", mimeType: "image/png" }, workspace)).rejects.toThrow("escapes");
    await expect(resolveWorkspaceImage({ type: "image", path: "image.png", mimeType: "image/jpeg" }, workspace)).rejects.toThrow("MIME type");
    await expect(resolveWorkspaceImage({ type: "image", path: "image.png", mimeType: "image/png", sha256: "0".repeat(64) }, workspace)).rejects.toThrow("SHA-256");
  });
});
