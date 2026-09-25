import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HashEmbeddingProvider, HybridSearchIndex, OpenAIEmbeddingProvider } from "../src/search/hybrid-index.js";
import { HybridAgentEngine } from "../src/engine.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("persistent hybrid retrieval", () => {
  it("combines BM25-style lexical and cosine vector scores with tenant isolation", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-hybrid-"));
    const index = new HybridSearchIndex(root, new HashEmbeddingProvider(128));
    await index.upsert({ id: "one", tenantId: "a", kind: "memory", text: "rotate authentication tokens safely", metadata: { source: "memory" } });
    await index.upsert({ id: "two", tenantId: "a", kind: "skill", text: "generate colorful product illustrations", metadata: { source: "skill" } });
    await index.upsert({ id: "hidden", tenantId: "b", kind: "memory", text: "authentication tokens secret", metadata: {} });
    const hits = await index.search({ tenantId: "a", query: "authentication token rotation" });
    expect(hits[0]?.id).toBe("one");
    expect(hits[0]!.lexicalScore).toBeGreaterThan(0);
    expect(hits[0]!.vectorScore).toBeGreaterThan(0.5);
    expect(hits.some((hit) => hit.id === "hidden")).toBe(false);

    const reloaded = new HybridSearchIndex(root, new HashEmbeddingProvider(128));
    expect(await reloaded.count("a")).toBe(2);
  });

  it("indexes live session message events through the engine", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-hybrid-engine-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
    });
    const session = await engine.createSession({ tenantId: "tenant" });
    await engine.command({
      protocolVersion: 1, commandId: randomUUID(), clientId: "search", tenantId: "tenant", sessionId: session.sessionId,
      kind: "session.prompt", source: "api", issuedAt: new Date().toISOString(), payload: { text: "investigate database replication lag" },
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    const hits = await engine.knowledgeIndex.search({ tenantId: "tenant", query: "replication lag" });
    expect(hits.some((hit) => hit.metadata.sessionId === session.sessionId)).toBe(true);
    await engine.shutdown();
  });

  it("normalizes OpenAI-compatible embedding responses", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }],
    }), { status: 200 })) as typeof fetch;
    const provider = new OpenAIEmbeddingProvider({ apiKey: "secret", model: "embed-test" });
    expect(await provider.embed(["one", "two"])).toEqual([[1, 0], [0, 1]]);
  });
});
