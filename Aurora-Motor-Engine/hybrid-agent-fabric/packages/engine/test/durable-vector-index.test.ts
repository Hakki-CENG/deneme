/**
 * D2: the durable vector index behind semantic search.
 *
 * What was measured before this existed. `HybridSearchIndex` already persisted
 * documents (vectors included), was tenant-isolated, and was shared by the
 * memory graph and the knowledge indexer — the backend existed. Two things did
 * not:
 *
 *  - `search()` computed cosine between the query and EVERY document,
 *    regardless of which embedding provider had produced the document's
 *    vector. Configure a different model and the index silently blends
 *    cross-space similarities — numbers that look like evidence and are not.
 *  - There was no migration path: no way to re-embed the stored texts with
 *    the current provider, so a provider change left the whole index
 *    permanently vector-dead.
 *
 * Also found while measuring this: D1 had added a SECOND embedding
 * configuration knob (`embedding` next to the pre-existing `embeddings`) with
 * its own provider classes — the same endpoint configured twice under
 * different names. Removed; one knob drives both dialects now.
 */
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HashEmbeddingProvider,
  HybridSearchIndex,
  OpenAIEmbeddingProvider,
} from "../src/search/hybrid-index.js";

/** Same topic-orthogonal stub as the recall test: database/cache/neutral axes. */
function topicEmbeddingServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const input = (JSON.parse(String(Buffer.concat(chunks))) as { input?: unknown }).input;
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
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function root(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "haf-vidx-"));
}

describe("the index is durable and tenant-isolated (D2)", () => {
  it("documents written by one instance are found by the next, per tenant", async () => {
    const dir = await root();
    const first = new HybridSearchIndex(dir);
    await first.upsert({ id: "m1", tenantId: "t1", kind: "memory", text: "database replication notes", metadata: {} });
    await first.upsert({ id: "m2", tenantId: "t2", kind: "memory", text: "database replication notes", metadata: {} });

    const second = new HybridSearchIndex(dir);
    expect(await second.count("t1")).toBe(1);
    expect(await second.count("t2")).toBe(1);

    const hits = await second.search({ tenantId: "t1", query: "replication" });
    expect(hits.map((hit) => hit.id)).toEqual(["m1"]);
  });

  it("drops malformed rows on load instead of scoring them", async () => {
    const dir = await root();
    const path = join(dir, "search", "hybrid-index.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "search"), { recursive: true });
    await writeFile(path, JSON.stringify([
      "not a document",
      { id: "ok", tenantId: "t1", kind: "memory", text: "valid row", metadata: {}, vector: [0.1], embeddingProvider: "hash-embedding-v1", updatedAt: "2026-09-24T00:00:00.000Z" },
      { id: "no-vector", tenantId: "t1", kind: "memory", text: "broken row", metadata: {} },
    ]));

    const index = new HybridSearchIndex(dir);
    expect(await index.count()).toBe(1);
    const hits = await index.search({ tenantId: "t1", query: "valid" });
    expect(hits.map((hit) => hit.id)).toEqual(["ok"]);
  });
});

describe("a provider change does not blend vector spaces (D2)", () => {
  it("gives cross-provider documents vector score 0, keeping their lexical score", async () => {
    const dir = await root();
    // Written under the default hash provider.
    const hashed = new HybridSearchIndex(dir);
    await hashed.upsert({ id: "db", tenantId: "t1", kind: "memory", text: "postgres replication fell behind", metadata: {} });
    await hashed.upsert({ id: "notes", tenantId: "t1", kind: "memory", text: "standup notes", metadata: {} });

    // Reopened under a DIFFERENT provider (the topic stub).
    const endpoint = await topicEmbeddingServer();
    servers.push(endpoint.server);
    const migrated = new HybridSearchIndex(dir, new OpenAIEmbeddingProvider({ baseUrl: endpoint.url, apiKey: "test" }));

    const hits = await migrated.search({ tenantId: "t1", query: "database replication" });

    // Every stored document was embedded by another model: no cross-space
    // cosine, however inviting the numbers would look.
    expect(hits.length).toBe(2);
    for (const hit of hits) {
      expect(hit.vectorScore).toBe(0);
    }
    // Lexical scoring still works — the index is degraded, not blind.
    expect(hits[0]?.id).toBe("db");
  });

  it("rebuild() re-embeds the stored texts with the current provider", async () => {
    const dir = await root();
    const hashed = new HybridSearchIndex(dir);
    await hashed.upsert({ id: "db", tenantId: "t1", kind: "memory", text: "the postgres replica fell behind during the migration", metadata: {} });
    await hashed.upsert({ id: "notes", tenantId: "t1", kind: "memory", text: "standup notes and parking lot items", metadata: {} });

    const endpoint = await topicEmbeddingServer();
    servers.push(endpoint.server);
    const migrated = new HybridSearchIndex(dir, new OpenAIEmbeddingProvider({ baseUrl: endpoint.url, apiKey: "test" }));

    const result = await migrated.rebuild();
    expect(result.reembedded).toBe(2);

    // A semantically-close but lexically-disjoint query now ranks the
    // database memory first, through the vector signal.
    const hits = await migrated.search({ tenantId: "t1", query: "database outage" });
    expect(hits[0]?.id).toBe("db");
    expect(hits[0]!.vectorScore).toBeGreaterThan(0);

    // And the migration is durable: a fresh instance sees the new provider.
    const reopened = new HybridSearchIndex(dir, new OpenAIEmbeddingProvider({ baseUrl: endpoint.url, apiKey: "test" }));
    const reopenedHits = await reopened.search({ tenantId: "t1", query: "database outage" });
    expect(reopenedHits[0]?.id).toBe("db");
    expect(reopenedHits[0]!.vectorScore).toBeGreaterThan(0);
  });
});

describe("one configuration drives both embedding dialects (D2)", () => {
  it("the batch dialect adapts to the pipeline dialect without a second knob", async () => {
    const { batchEmbedderToPipelineProvider } = await import("../src/memory/real-memory-pipeline.js");
    let calls = 0;
    const batcher = {
      id: "stub-batch-v1",
      embed: async (texts: string[]): Promise<number[][]> => {
        calls += 1;
        return texts.map(() => [0.5, 0.5]);
      },
    };

    const adapted = batchEmbedderToPipelineProvider(batcher, { isSemantic: true });
    expect(adapted.model).toBe("stub-batch-v1");
    expect(adapted.isSemantic).toBe(true);

    const single = await adapted.embed("anything");
    expect(single).toEqual([0.5, 0.5]);
    const batch = await adapted.embedBatch(["a", "b"]);
    expect(batch).toEqual([[0.5, 0.5], [0.5, 0.5]]);
    expect(calls).toBe(2);

    // Dimensions are measured from the vectors, not declared by guesswork.
    expect(adapted.dimensions).toBe(2);
  });
});
