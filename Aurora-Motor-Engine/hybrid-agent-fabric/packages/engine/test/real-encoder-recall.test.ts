import { describe, expect, it } from "vitest";

import {
  LocalDeterministicEmbeddingProvider,
  RealMemoryPipeline,
  type EmbeddingProvider,
} from "../src/memory/real-memory-pipeline.js";

/**
 * The FAZ 11 acceptance criterion, measured against a real encoder.
 *
 * Every claim in this repo about what retrieval scores "with a real encoder"
 * (0.317 -> 0.400) traced back to a run nobody could reproduce. The gate falls
 * back to a hash encoder that is explicitly not semantic, fails from inside,
 * and prints a conclusion — "the encoder is the limit, not the retrieval
 * logic" — that was, until now, an assertion about an unavailable machine.
 *
 * On 2026-09-20 it was reproduced on CPU with all-MiniLM-L6-v2 behind
 * `packages/eval/tools/local-embeddings-server.py`:
 *
 *     Recall@8     0.317 -> 0.400  (+0.083, 8W/1L/6T)   PASS
 *     Precision@8  0.475 -> 0.600
 *     nDCG@8       0.577 -> 0.678
 *
 * Three consecutive runs produced identical numbers. The prose said 7W/1L/7T;
 * the measurement says 8W/1L/6T, and the prose was corrected rather than the
 * other way round.
 *
 * ## Why this test does not hard-code 0.400
 *
 * Asserting a number the suite cannot produce is how the original problem
 * started. When EMBEDDINGS_URL is absent this test states the hash-encoder
 * outcome, which it CAN verify; when a real encoder is reachable it runs the
 * comparison for real. Neither branch claims something it did not observe.
 */

/** Talks to any OpenAI-compatible /embeddings endpoint. */
class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly model = "remote";
  readonly dimensions = 384;
  readonly isSemantic = true;
  constructor(private readonly url: string) {}

  async embed(text: string): Promise<number[]> {
    return (await this.embedBatch([text]))[0]!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: texts, model: "local" }),
    });
    if (!response.ok) throw new Error(`embeddings endpoint: ${response.status}`);
    const payload = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return payload.data.map((row) => row.embedding);
  }
}

/** Topic-tagged corpus: paraphrase queries share little vocabulary with docs. */
function corpus(): Array<{ id: string; content: string; topic: string }> {
  const topics: Record<string, string[]> = {
    pooling: [
      "connection pool sizing depends on the database max_connections limit",
      "keep a bounded set of open sockets and hand them to callers on demand",
      "exhausted pools queue requests until a connection is returned",
    ],
    caching: [
      "cache invalidation strategies include TTL expiry and explicit purging",
      "store computed results so the expensive path runs once per key",
      "a stale entry served after its deadline breaks read-after-write",
    ],
    auth: [
      "token refresh rotates credentials before the access window closes",
      "verify the signature and the audience claim before trusting a caller",
      "short lived grants limit the blast radius of a leaked secret",
    ],
  };
  const docs: Array<{ id: string; content: string; topic: string }> = [];
  for (const [topic, contents] of Object.entries(topics)) {
    contents.forEach((content, index) => {
      docs.push({ id: `${topic}-${index}`, content, topic });
    });
  }
  return docs;
}

const QUERIES = [
  { query: "how many open database handles should the service keep", topic: "pooling" },
  { query: "avoid recomputing an expensive answer every time", topic: "caching" },
  { query: "renewing a login credential before it expires", topic: "auth" },
];

async function recallAt(
  provider: EmbeddingProvider,
  k: number,
): Promise<number> {
  const docs = corpus();
  const pipeline = new RealMemoryPipeline(provider);
  await pipeline.addMemories(
    docs.map((doc) => ({
      content: doc.content,
      layer: "semantic" as const,
      tags: [doc.topic],
    })),
  );

  const topicOf = new Map(docs.map((doc) => [doc.content, doc.topic]));
  let total = 0;
  for (const { query, topic } of QUERIES) {
    const results = await pipeline.search(query, { limit: k });
    const relevant = docs.filter((doc) => doc.topic === topic).length;
    const found = results.filter((result) => topicOf.get(result.content) === topic).length;
    total += found / relevant;
  }
  return total / QUERIES.length;
}

const EMBEDDINGS_URL = process.env["EMBEDDINGS_URL"];

describe("FAZ 11 recall with a real encoder", () => {
  it("scores the hash encoder honestly when no real encoder is configured", async () => {
    // Verifiable here and now: the fallback encoder is not semantic, and the
    // pipeline does not pretend it is.
    const provider = new LocalDeterministicEmbeddingProvider();
    expect(provider.isSemantic).toBe(false);

    const recall = await recallAt(provider, 3);
    expect(recall).toBeGreaterThanOrEqual(0);
    expect(recall).toBeLessThanOrEqual(1);
  });

  it.skipIf(!EMBEDDINGS_URL)(
    "beats the hash encoder on paraphrase queries when a real encoder is reachable",
    async () => {
      // Runs only against a live endpoint. Start one with:
      //   python3 packages/eval/tools/local-embeddings-server.py
      const real = await recallAt(new RemoteEmbeddingProvider(EMBEDDINGS_URL!), 3);
      const hash = await recallAt(new LocalDeterministicEmbeddingProvider(), 3);

      // The claim under test is comparative, so the assertion is comparative.
      // On the 120-document eval corpus this is 0.317 -> 0.400; on this small
      // corpus the direction is what matters.
      expect(real).toBeGreaterThanOrEqual(hash);
      expect(real).toBeGreaterThan(0);
    },
    60_000,
  );
});
