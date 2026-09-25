/**
 * D1: a real embedding provider on the runtime recall path.
 *
 * What was measured before this existed. `RealMemoryPipeline` (BM25 + vector +
 * RRF + rerank) ran in production as the recall ranker — but with NO embedding
 * provider, deliberately, because the only in-repo encoder is a hash encoder
 * that measures surface overlap (measured on the eval corpus: Recall@8
 * 0.317 -> 0.289, 0W/4L/11T — it hurts). The real providers (BGE/E5, behind an
 * OpenAI-compatible endpoint) existed in the same file and were reachable only
 * from the eval harness. So the ranking the project measured was never the
 * ranking the agent got: production recall was lexical-only.
 *
 * This file tests the wiring end to end against a REAL local HTTP endpoint
 * speaking the OpenAI embeddings dialect — the same path a production BGE
 * service would take — plus the honest fallbacks: no configuration changes
 * nothing, and a dead endpoint fails soft to importance ordering.
 */
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HybridAgentEngine } from "../src/engine.js";

/**
 * An OpenAI-compatible /embeddings endpoint whose "model" encodes one of four
 * topics into an orthogonal axis, so semantic similarity is exact and known:
 *
 *   database/postgres -> [1,0,0,0]   cache/redis -> [0,1,0,0]
 *   anything else     -> [0,0,1,0]
 */
function topicEmbeddingServer(): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = String(Buffer.concat(chunks));
      calls.push(text);
      if (request.method !== "POST" || !request.url?.includes("/embeddings")) {
        response.writeHead(404).end();
        return;
      }
      // OpenAI dialect: `input` is one string or an array of strings, and the
      // reply carries one embedding per item, in order. (An earlier version of
      // this stub stringified the array, so every candidate got the same
      // vector and the test measured the stub, not the wiring.)
      const input = (JSON.parse(text) as { input?: unknown }).input;
      const items = Array.isArray(input) ? input : [input];
      const embed = (value: unknown): number[] => {
        const lower = String(value ?? "").toLowerCase();
        return lower.includes("database") || lower.includes("postgres")
          ? [1, 0, 0, 0]
          : lower.includes("cache") || lower.includes("redis")
            ? [0, 1, 0, 0]
            : [0, 0, 1, 0];
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: items.map((item, index) => ({ index, embedding: embed(item) })) }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, calls });
    });
  });
}

async function newEngine(embeddings?: { baseUrl: string }): Promise<HybridAgentEngine> {
  const root = await mkdtemp(join(tmpdir(), "haf-mem-"));
  return new HybridAgentEngine({
    homePath: root,
    kernelServerScript: "",
    sandboxBackend: "local",
    model: { provider: "mock" },
    // D2 unified this onto the pre-existing `embeddings` knob: one endpoint
    // drives both the durable search index and the recall ranker.
    ...(embeddings ? { embeddings: { ...embeddings, apiKey: "test-key" } } : {}),
  } as never);
}

const memories = [
  {
    // Semantically a database memory; lexically disjoint from the query.
    tenantId: "t",
    layer: "episodic" as const,
    claimType: "observation" as const,
    title: "replica lag",
    content: "the postgres replica fell behind during the migration",
    sourceType: "agent" as const,
    confidence: 0.9,
    importance: 0.2,
  },
  {
    // Lexically overlapping with the query; semantically a cache memory.
    tenantId: "t",
    layer: "semantic" as const,
    claimType: "inference" as const,
    title: "postmortem format",
    content: "the outage postmortem for the cache redesign",
    sourceType: "agent" as const,
    confidence: 0.9,
    importance: 0.95,
  },
  {
    // Neither lexically nor semantically related; middle importance.
    tenantId: "t",
    layer: "working" as const,
    claimType: "observation" as const,
    title: "meeting notes",
    content: "standup notes and parking lot items",
    sourceType: "user" as const,
    confidence: 0.9,
    importance: 0.5,
  },
];

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("recall ranking with a real embedding endpoint (D1)", () => {
  it("ranks a semantically related memory above lexically overlapping, higher-importance ones", async () => {
    const endpoint = await topicEmbeddingServer();
    servers.push(endpoint.server);
    const engine = await newEngine({ baseUrl: endpoint.url });

    for (const memory of memories) {
      await engine.memoryGraph.remember(memory);
    }

    const result = await engine.memoryEngine.recall({ tenantId: "t", text: "database outage postmortem" });
    const contents = (result.memories ?? []).map((m: { content: string }) => m.content);

    // The provider actually answered along the way (candidates at add time,
    // the query at search time).
    expect(endpoint.calls.length).toBeGreaterThan(0);

    // Semantic order: the postgres memory is semantically the closest thing to
    // a "database" question even though it shares no query term and has the
    // LOWEST importance of the three.
    expect(contents[0]).toBe("the postgres replica fell behind during the migration");
    expect(contents).toContain("the outage postmortem for the cache redesign");
  });

  it("without an endpoint configured, the lexical default is unchanged", async () => {
    const engine = await newEngine();

    for (const memory of memories) {
      await engine.memoryGraph.remember(memory);
    }

    const result = await engine.memoryEngine.recall({ tenantId: "t", text: "database outage postmortem" });
    const contents = (result.memories ?? []).map((m: { content: string }) => m.content);

    // Lexical-only: the only term-overlapping memory is the postmortem one;
    // with the lexical signal uninformative across the rest, importance
    // orders them — so the high-importance cache memory leads. This is the
    // exact behaviour that existed before D1, pinned.
    expect(contents[0]).toBe("the outage postmortem for the cache redesign");
    expect(contents[contents.length - 1]).toBe("the postgres replica fell behind during the migration");
  });

  it("fails soft to importance ordering when the endpoint is dead", async () => {
    // Nothing listens on this port; the provider's fetch must throw, and the
    // ranker's catch must degrade to importance ordering rather than to an
    // empty recall.
    const engine = await newEngine({ baseUrl: "http://127.0.0.1:9" });

    for (const memory of memories) {
      await engine.memoryGraph.remember(memory);
    }

    const result = await engine.memoryEngine.recall({ tenantId: "t", text: "database outage postmortem" });
    const contents = (result.memories ?? []).map((m: { content: string }) => m.content);

    expect(contents.length).toBe(3);
    // Importance order: 0.95, 0.5, 0.2.
    expect(contents).toEqual([
      "the outage postmortem for the cache redesign",
      "standup notes and parking lot items",
      "the postgres replica fell behind during the migration",
    ]);
  }, 30_000);
});
