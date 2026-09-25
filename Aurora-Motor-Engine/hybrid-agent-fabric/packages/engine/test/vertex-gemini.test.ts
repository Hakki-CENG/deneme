import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "../src/models/gemini-provider.js";
import { ProviderProfileRegistry } from "../src/models/provider-profiles.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("native Vertex AI Gemini provider", () => {
  it("uses OAuth bearer auth and the configured Vertex publisher path", async () => {
    let url = ""; let headers: Headers;
    globalThis.fetch = vi.fn(async (input, init) => {
      url = String(input); headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "vertex-ok" }] } }], usageMetadata: {} }), { status: 200 });
    }) as typeof fetch;
    const provider = new GeminiProvider({
      id: "vertex",
      baseUrl: "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/publishers/google",
      accessToken: "vertex-access-secret",
      model: "gemini-test",
    });
    const events = [];
    for await (const event of provider.stream({
      sessionId: "s", turnId: "t", systemPrompt: "system",
      messages: [{ id: "u", role: "user", timestamp: new Date(0).toISOString(), content: [{ type: "text", text: "hello" }] }], tools: [],
    })) events.push(event);
    expect(url).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/publishers/google/models/gemini-test:generateContent");
    expect(headers!.get("authorization")).toBe("Bearer vertex-access-secret");
    expect(headers!.get("x-goog-api-key")).toBeNull();
    expect(url).not.toContain("vertex-access-secret");
    expect(events).toContainEqual({ type: "text_delta", delta: "vertex-ok" });
  });

  it("requires an explicit resource base URL in the Vertex profile", () => {
    const registry = new ProviderProfileRegistry();
    expect(() => registry.createProvider({ profileId: "vertex", apiKey: "token", model: "gemini" })).toThrow("explicit base URL");
    expect(registry.createProvider({
      profileId: "vertex", apiKey: "token", model: "gemini",
      baseUrl: "https://europe-west4-aiplatform.googleapis.com/v1/projects/p/locations/europe-west4/publishers/google",
    }).provider.id).toBe("vertex");
  });
});
