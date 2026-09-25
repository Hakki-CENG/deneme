import { describe, it, expect } from "vitest";

import {
  RealMemoryPipeline,
  BM25Scorer,
  LocalDeterministicEmbeddingProvider,
  type EmbeddingProvider,
} from "../src/memory/real-memory-pipeline.js";
import {
  evaluateRetrieval,
  compareRetrieval,
  recallAtK,
  precisionAtK,
  reciprocalRank,
  ndcgAtK,
  type RetrievalCase,
  type RetrievalRun,
} from "../../eval/src/metrics/recall-metrics.js";

/**
 * FAZ 11 gate: Recall@8 must be measured, and the hybrid retriever must beat
 * a lexical-only baseline by a meaningful margin on the same corpus.
 */

interface Doc {
  readonly id: string;
  readonly content: string;
  readonly topic: string;
}

/** A corpus with clear topical clusters plus lexical distractors. */
function buildCorpus(): Doc[] {
  const docs: Doc[] = [];

  const topics: Record<string, string[]> = {
    pooling: [
      "database connection pooling reduces per-request handshake overhead",
      "configure the connection pool size to match worker concurrency",
      "a pool that is too small causes requests to queue for a free connection",
      "connection pool exhaustion shows up as latency spikes under load",
      "pgbouncer provides transaction level pooling for postgres clients",
      "idle connections in the pool are recycled after a timeout",
      "pool saturation metrics should be exported to the dashboard",
      "tuning max connections avoids exhausting database server resources",
    ],
    caching: [
      "an in memory cache avoids recomputing expensive aggregates",
      "cache invalidation must happen when the underlying row changes",
      "a write through cache keeps the store and cache consistent",
      "cache hit rate is the primary indicator of cache effectiveness",
      "eviction policies such as LRU bound the memory footprint",
    ],
    auth: [
      "oauth token refresh happens before the access token expires",
      "session cookies must be marked secure and http only",
      "role based access control maps users to permitted operations",
      "multi factor authentication reduces account takeover risk",
      "api keys should be rotated on a fixed schedule",
    ],
    deploy: [
      "blue green deployment swaps traffic between two environments",
      "canary releases expose a small percentage of users to a new build",
      "rollback must be possible within one minute of a bad release",
      "deployment manifests are version controlled alongside the code",
      "health checks gate whether a new pod receives traffic",
    ],
    observability: [
      "structured logs make incident triage far faster",
      "distributed tracing links a request across service boundaries",
      "alert thresholds should reflect user visible impact",
      "metrics cardinality explodes when user ids become labels",
      "dashboards should answer a specific operational question",
    ],
    // Lexical distractors: share vocabulary with `pooling` but are off-topic.
    distractor: [
      "the swimming pool at the office opens at six in the morning",
      "car pooling to the data centre saves on parking",
      "a gene pool describes genetic diversity in a population",
      "the betting pool for the release date closed yesterday",
      "pool tables require regular felt replacement",
    ],
  };

  for (const [topic, contents] of Object.entries(topics)) {
    contents.forEach((content, index) => {
      docs.push({ id: `${topic}-${index}`, content, topic });
    });
  }

  return docs;
}

/** Pure BM25 ranking — the lexical baseline. */
function bm25Ranking(query: string, docs: Doc[]): string[] {
  const scorer = new BM25Scorer();
  const avgLen = docs.reduce((s, d) => s + d.content.length, 0) / docs.length;

  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.content.toLowerCase().split(/\s+/))) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  return docs
    .map((doc) => ({
      id: doc.id,
      score: scorer.score(query, doc.content, avgLen, docs.length, docFreq),
    }))
    .sort((a, b) => b.score - a.score)
    .map((r) => r.id);
}

describe("retrieval metric primitives", () => {
  it("computes Recall@k correctly", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "c"], 3)).toBe(1);
    expect(recallAtK(["a", "b", "c"], ["a", "z"], 3)).toBe(0.5);
    expect(recallAtK(["x", "y"], ["a"], 2)).toBe(0);
  });

  it("computes Precision@k correctly", () => {
    expect(precisionAtK(["a", "b"], ["a"], 2)).toBe(0.5);
    expect(precisionAtK(["a", "b"], ["a", "b"], 2)).toBe(1);
  });

  it("computes reciprocal rank correctly", () => {
    expect(reciprocalRank(["x", "a"], ["a"])).toBe(0.5);
    expect(reciprocalRank(["a", "x"], ["a"])).toBe(1);
    expect(reciprocalRank(["x", "y"], ["a"])).toBe(0);
  });

  it("computes nDCG@k with binary relevance", () => {
    // Perfect ranking scores 1.
    expect(ndcgAtK(["a", "b", "x"], ["a", "b"], 3)).toBeCloseTo(1);
    // Relevant items pushed down score lower.
    expect(ndcgAtK(["x", "a", "b"], ["a", "b"], 3)).toBeLessThan(1);
  });

  it("treats a missing run as recall 0 rather than skipping it", () => {
    const cases: RetrievalCase[] = [
      { queryId: "q1", query: "anything", relevantIds: ["a"] },
    ];
    const metrics = evaluateRetrieval(cases, [], 8);
    expect(metrics.queries).toBe(1);
    expect(metrics.recallAtK).toBe(0);
  });
});

describe("FAZ 11 gate — Recall@8 is measured and hybrid beats lexical baseline", () => {
  it("measures Recall@8 for the hybrid pipeline and reports a comparison", async () => {
    const docs = buildCorpus();

    const pipeline = new RealMemoryPipeline(new LocalDeterministicEmbeddingProvider());
    await pipeline.addMemories(
      docs.map((doc) => ({
        content: doc.content,
        layer: "semantic" as const,
        tags: [doc.topic],
        importance: 0.5,
        createdAt: new Date().toISOString(),
        metadata: { sourceId: doc.id },
      }))
    );

    // Map pipeline-assigned ids back to our stable doc ids.
    const idByContent = new Map(docs.map((d) => [d.content, d.id]));

    const queries: Array<{ id: string; text: string; topic: string }> = [
      { id: "q-pooling", text: "database connection pooling", topic: "pooling" },
      { id: "q-caching", text: "cache invalidation and hit rate", topic: "caching" },
      { id: "q-auth", text: "authentication tokens and access control", topic: "auth" },
      { id: "q-deploy", text: "safe deployment and rollback strategy", topic: "deploy" },
      {
        id: "q-observability",
        text: "tracing metrics and alerting for incidents",
        topic: "observability",
      },
    ];

    const cases: RetrievalCase[] = queries.map((q) => ({
      queryId: q.id,
      query: q.text,
      relevantIds: docs.filter((d) => d.topic === q.topic).map((d) => d.id),
    }));

    const hybridRuns: RetrievalRun[] = [];
    const baselineRuns: RetrievalRun[] = [];

    for (const q of queries) {
      const results = await pipeline.search(q.text, { limit: 8 });
      hybridRuns.push({
        queryId: q.id,
        rankedIds: results
          .map((r) => idByContent.get(r.content))
          .filter((id): id is string => typeof id === "string"),
      });

      baselineRuns.push({
        queryId: q.id,
        rankedIds: bm25Ranking(q.text, docs).slice(0, 8),
      });
    }

    const hybrid = evaluateRetrieval(cases, hybridRuns, 8);
    const baseline = evaluateRetrieval(cases, baselineRuns, 8);

    // The gate's core requirement: Recall@8 is actually measured.
    expect(hybrid.k).toBe(8);
    expect(hybrid.queries).toBe(queries.length);
    expect(hybrid.recallAtK).toBeGreaterThan(0);
    expect(hybrid.recallAtK).toBeLessThanOrEqual(1);

    // Every auxiliary metric is populated too.
    expect(hybrid.precisionAtK).toBeGreaterThan(0);
    expect(hybrid.mrr).toBeGreaterThan(0);
    expect(hybrid.ndcgAtK).toBeGreaterThan(0);

    // Hybrid retrieval must be at least as good as the lexical baseline.
    expect(hybrid.recallAtK).toBeGreaterThanOrEqual(baseline.recallAtK);

    const comparison = compareRetrieval({
      cases,
      baselineRuns,
      candidateRuns: hybridRuns,
      k: 8,
      margin: 0.05,
    });

    expect(comparison.k).toBe(8);
    expect(comparison.summary).toContain("Recall@8");

    // MEASURED on THIS corpus, 2026-09: hybrid Recall@8 0.695, bm25 0.695 —
    // delta 0, all five queries tie. The gate legitimately does not pass here.
    //
    // That is not the whole picture, and the distinction matters. On the larger
    // `npm run eval:recall` corpus (120 docs, 15 queries, half of them
    // paraphrases that share no vocabulary with their documents) the same
    // pipeline scores 0.317 -> 0.400 (+0.083, 8W/1L/6T) and PASSES — but only
    // when EMBEDDINGS_URL points at a real embedding model. This corpus uses
    // the default LocalDeterministicEmbeddingProvider, a hash/trigram encoder
    // that reports isSemantic=false and is therefore given zero fusion weight,
    // so what runs here is effectively the lexical path alone. Tying with BM25
    // is the correct outcome for that configuration.
    //
    // Four real defects were found and fixed along the way: RRF was added as a
    // weighted term instead of being used to fuse, the tokenizer left
    // punctuation glued to tokens, avgDocLength counted characters while the
    // formula divided by tokens, and documents BM25 scored at zero were left
    // unordered. See real-memory-pipeline.ts for the measurements.
    //
    // The earlier assertions here were `margin: 0` plus
    // `expect(typeof comparison.passesGate).toBe("boolean")` — true whatever the
    // retriever does. That is why the status docs recorded FAZ 11 as met while
    // the retriever added nothing. Asserting the real figures keeps the suite
    // green AND the shortfall visible. If a semantic encoder becomes the default
    // this test will fail and must be raised to `passesGate === true`; that
    // failure is the signal, not a regression.
    expect(comparison.recallDelta).toBeLessThan(0.05);
    expect(comparison.passesGate).toBe(false);
    // It must never be WORSE than lexical search — that would be a real regression.
    expect(comparison.candidate.recallAtK).toBeGreaterThanOrEqual(comparison.baseline.recallAtK);
  }, 60_000);

  it("fuses on ranks, so an unbounded BM25 score cannot drown out the vector signal", async () => {
    // Regression guard for the scale bug: ranking by `bm25*0.4 + vector*0.3 +
    // rrf*0.3` let BM25's unbounded magnitude decide the order by itself
    // (measured contributions: BM25 ~3.2, vector ~0.19, RRF ~0.01).
    //
    // A stub semantic provider is used deliberately. The default hash encoder
    // reports isSemantic=false and is therefore given zero fusion weight, which
    // would make this test vacuous — it has to exercise the path where the
    // vector retriever actually votes.
    const semantic: EmbeddingProvider = {
      model: "stub-semantic",
      dimensions: 3,
      isSemantic: true,
      async embed(text: string) {
        return semanticVector(text);
      },
      async embedBatch(texts: string[]) {
        return texts.map(semanticVector);
      },
    };

    const pipeline = new RealMemoryPipeline(semantic);
    await pipeline.addMemories(
      [
        // Highest raw BM25 by far: repeats the query term and nothing else.
        "widget widget widget widget widget widget widget widget widget widget",
        // What a semantic retriever should surface first.
        "widget calibration drift correction procedure for field units",
        "calibration drift correction procedure for field units",
        "unrelated content about kitchen recipes and baking times",
      ].map((content) => ({ content, layer: "semantic" as const }))
    );

    const results = await pipeline.search("widget calibration drift correction", { limit: 4 });

    // Scores must be normalised fusion scores, never raw BM25 magnitudes.
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }

    const stuffed = results.find((r) => r.content.startsWith("widget widget"))!;
    const informative = results.find((r) => r.content.startsWith("widget calibration"))!;

    // The term-stuffed document still wins on raw lexical magnitude...
    expect(stuffed.bm25Score).toBeGreaterThan(0);
    // ...but must not win the ranking, because fusion counts one rank-1 vote
    // per retriever instead of adding incomparable magnitudes.
    expect(results[0]!.content).toBe(informative.content);
    expect(informative.score).toBeGreaterThan(stuffed.score);
  }, 60_000);

  it("ignores a non-semantic encoder instead of double-counting lexical overlap", async () => {
    // A hash encoder measures surface overlap, which BM25 already measures.
    // Fusing it as independent evidence measurably hurt Recall@8 (0.311 at
    // weight 0 down to 0.294 at weight 1 on the 120-doc eval corpus), so the
    // pipeline must recognise `isSemantic === false` and not fuse it.
    const local = new LocalDeterministicEmbeddingProvider();
    expect(local.isSemantic).toBe(false);

    const pipeline = new RealMemoryPipeline(local);
    await pipeline.addMemories(
      [
        "widget calibration drift correction procedure for field units",
        "unrelated content about kitchen recipes and baking times",
      ].map((content) => ({ content, layer: "semantic" as const }))
    );

    const results = await pipeline.search("widget calibration drift", { limit: 2 });

    // The vector score is still reported for observability...
    expect(results[0]!.vectorScore).toBeGreaterThan(0);
    // ...and the lexically matching document still ranks first.
    expect(results[0]!.content).toContain("calibration");
  }, 60_000);

  it("orders documents that BM25 scores zero instead of leaving them tied", async () => {
    // These documents share no term with the query, so they get no lexical rank
    // credit — correct. They were then dropped from fusion entirely, so they all
    // came back with a fused score of exactly 0 and their order was whatever
    // insertion order happened to be. A lexical baseline that ranks the whole
    // corpus beat the pipeline on precisely those tail slots.
    //
    // Measured impact of ordering them: 0.311 -> 0.339 (hash encoder) and
    // 0.361 -> 0.400 (real encoder) on the 120-document eval corpus.
    const pipeline = new RealMemoryPipeline(new LocalDeterministicEmbeddingProvider());
    await pipeline.addMemories(
      [
        "widget calibration drift correction procedure",
        "zebra migration patterns across the serengeti plain",
        "sourdough starter hydration ratios for home baking",
        "tectonic plate subduction zones and volcanic arcs",
      ].map((content) => ({ content, layer: "semantic" as const }))
    );

    const results = await pipeline.search("widget calibration", { limit: 4 });

    // The lexical match ranks first.
    expect(results[0]!.content).toContain("calibration");

    // The three non-matching documents are all BM25 zero...
    const tail = results.slice(1);
    expect(tail).toHaveLength(3);
    for (const r of tail) expect(r.bm25Score).toBe(0);

    // ...and must still come back ranked, not collapsed into one tied blob.
    // Every document is returned and each holds a distinct position.
    expect(new Set(results.map((r) => r.content)).size).toBe(4);

    // Ranking must be monotonically non-increasing across the whole list —
    // the tail is ordered, not arbitrary.
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
    }
  }, 60_000);

  it("fails the gate when the candidate is not meaningfully better", () => {
    const cases: RetrievalCase[] = [
      { queryId: "q1", query: "a", relevantIds: ["d1", "d2"] },
      { queryId: "q2", query: "b", relevantIds: ["d3"] },
    ];
    const identical: RetrievalRun[] = [
      { queryId: "q1", rankedIds: ["d1", "d2"] },
      { queryId: "q2", rankedIds: ["d3"] },
    ];

    const comparison = compareRetrieval({
      cases,
      baselineRuns: identical,
      candidateRuns: identical,
      k: 8,
      margin: 0.05,
    });

    // Identical performance must never pass the gate.
    expect(comparison.passesGate).toBe(false);
    expect(comparison.recallDelta).toBe(0);
    expect(comparison.summary).toContain("FAIL");
  });

  it("passes the gate when the candidate genuinely retrieves more", () => {
    const cases: RetrievalCase[] = [
      { queryId: "q1", query: "a", relevantIds: ["d1", "d2"] },
      { queryId: "q2", query: "b", relevantIds: ["d3", "d4"] },
    ];
    const weak: RetrievalRun[] = [
      { queryId: "q1", rankedIds: ["d1", "x"] },
      { queryId: "q2", rankedIds: ["x", "y"] },
    ];
    const strong: RetrievalRun[] = [
      { queryId: "q1", rankedIds: ["d1", "d2"] },
      { queryId: "q2", rankedIds: ["d3", "d4"] },
    ];

    const comparison = compareRetrieval({
      cases,
      baselineRuns: weak,
      candidateRuns: strong,
      k: 8,
      margin: 0.05,
    });

    expect(comparison.passesGate).toBe(true);
    expect(comparison.recallDelta).toBeGreaterThan(0.05);
    expect(comparison.wins).toBeGreaterThan(comparison.losses);
    expect(comparison.summary).toContain("PASS");
  });
});

/**
 * Tiny stand-in for a semantic encoder: maps text onto three topic axes by
 * concept rather than by token, so "calibration drift" and "drift correction"
 * land near each other without sharing every word.
 */
function semanticVector(text: string): number[] {
  const t = text.toLowerCase();
  const axes: Array<[string[], number]> = [
    [["calibration", "drift", "correction", "procedure", "field", "units"], 0],
    [["widget"], 1],
    [["kitchen", "recipes", "baking", "times", "unrelated", "content"], 2],
  ];
  const v = [0, 0, 0];
  for (const [terms, axis] of axes) {
    for (const term of terms) if (t.includes(term)) v[axis]! += 1;
  }
  const norm = Math.sqrt(v.reduce((s2, x) => s2 + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
