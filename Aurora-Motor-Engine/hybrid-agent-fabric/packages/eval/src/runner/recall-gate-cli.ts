/**
 * Measure the FAZ 11 acceptance criterion and print the number.
 *
 * `recall-gate.test.ts` already exercises this path, but it asserts
 * `recallAtK > 0`, calls `compareRetrieval` with `margin: 0`, and then only
 * checks that `passesGate` is *a boolean*. So the suite stays green whether
 * the hybrid retriever beats the lexical baseline, ties it, or the gate fails
 * outright. "Recall@8 is measurable" was being reported as "Recall@8 is good".
 *
 * This runner takes a position: it applies the real margin, prints the actual
 * figures, and exits non-zero when the criterion is not met. A gate that
 * cannot fail is not a gate.
 */
import {
  compareRetrieval,
  evaluateRetrieval,
  type RetrievalCase,
  type RetrievalRun,
} from "../metrics/recall-metrics.js";
// Imported through the package's exports map rather than by relative path: the
// eval package's rootDir does not include engine sources.
import {
  RealMemoryPipeline,
  LocalDeterministicEmbeddingProvider,
  BGEEmbeddingProvider,
} from "@haf/engine/memory/real-memory-pipeline.js";

interface Doc {
  id: string;
  topic: string;
  content: string;
}

/** Minimum absolute Recall@8 improvement over the lexical baseline. */
const MARGIN = 0.05;
const K = 8;

/**
 * Figures this corpus produces with the deterministic hash encoder.
 *
 * These are NOT the acceptance criterion — the hash encoder is not semantic and
 * cannot pass it (see the note printed on failure). They exist because the
 * acceptance gate needs a real embedding model, which CI does not have, and a
 * gate that CI cannot run protects nothing.
 *
 * `--regression-lock` compares against these instead. It cannot tell you the
 * retriever is *good*, only that the fusion, ranking and tie-breaking logic
 * still behaves exactly as it did when the numbers were measured. Verified by
 * sabotage: reverting the zero-score tail fix moves hybridRecall 0.339 -> 0.311
 * and the lock fails.
 */
const HASH_ENCODER_LOCK = {
  baselineRecall: 0.3166666666666667,
  hybridRecall: 0.3388888888888889,
  hybridPrecision: 0.5083333333333333,
  hybridNdcg: 0.6033296280252163,
  hybridMrr: 0.9555555555555556,
} as const;

/** Float comparison slack; the pipeline is deterministic, so this is tight. */
const LOCK_TOLERANCE = 1e-6;

const TOPICS: Record<string, string[]> = {
  pooling: [
    "database connection pooling reduces per-request handshake overhead",
    "configure the connection pool size to match worker concurrency",
    "a pool that is too small causes requests to queue for a free connection",
    "connection pool exhaustion shows up as latency spikes under load",
    "pgbouncer provides transaction level pooling for postgres clients",
    "idle connections in the pool are recycled after a timeout",
    "pool saturation metrics should be exported to the dashboard",
    "tuning max connections avoids exhausting database server resources",
    "reusing an established socket avoids repeating the tls handshake",
    "a leaked handle is never returned to the reusable set",
    "borrowing and returning resources must be balanced under failure",
    "queue wait time grows sharply once every worker slot is busy",
  ],
  caching: [
    "an in memory cache avoids recomputing expensive aggregates",
    "cache invalidation must happen when the underlying row changes",
    "a write through cache keeps the store and cache consistent",
    "cache hit rate is the primary indicator of cache effectiveness",
    "stale entries are evicted by a time to live policy",
    "a cold cache causes a thundering herd against the origin",
    "cache keys should include the schema version to avoid poisoning",
    "read heavy endpoints benefit most from response caching",
    "eviction policies such as least recently used bound memory growth",
    "serving a saved copy avoids recomputing the same answer twice",
    "expiry timestamps decide when a stored answer stops being trusted",
    "memoised results must be dropped when their inputs change",
  ],
  auth: [
    "authentication verifies who the caller is before authorisation",
    "access tokens should be short lived and refreshed explicitly",
    "store password hashes with a slow adaptive hashing function",
    "role based access control maps roles to permitted operations",
    "a revoked token must stop working immediately at the edge",
    "multi factor authentication reduces credential stuffing risk",
    "session fixation is prevented by rotating the session id on login",
    "bearer tokens must never be logged or placed in query strings",
    "proving identity precedes deciding what the caller may do",
    "a signed credential expires so a stolen one stops working",
    "permission checks belong on the server, never only in the client",
    "api keys should be rotated on a fixed schedule",
  ],
  deploy: [
    "a blue green deployment keeps the previous version ready for rollback",
    "canary releases expose a small percentage of traffic to the new build",
    "database migrations must be backward compatible during rollout",
    "a rollback plan is part of the deployment, not an afterthought",
    "feature flags decouple deploying code from releasing behaviour",
    "health checks gate whether a new instance receives traffic",
    "deployment windows reduce blast radius for risky changes",
    "immutable artifacts make a deployment reproducible",
    "shipping to a small slice first limits who sees a bad build",
    "being able to go back to the previous version is mandatory",
    "gradual traffic shifting surfaces problems before full exposure",
    "an unhealthy instance must not receive user requests",
  ],
  observability: [
    "distributed tracing links a request across service boundaries",
    "metrics answer how often and how slow, logs answer what happened",
    "alerting should page on symptoms users feel, not on causes",
    "a service level objective defines acceptable error budget burn",
    "structured logs are queryable in a way free text logs are not",
    "high cardinality labels make a metrics backend expensive",
    "an incident timeline is reconstructed from traces and logs",
    "dashboards should answer a specific operational question",
    "following one request through every hop explains where time went",
    "waking someone at night is only justified by user visible harm",
    "recording what happened in a machine readable shape aids triage",
    "counters and histograms quantify how the system behaves over time",
  ],
  queueing: [
    "a message broker decouples producers from consumers",
    "at least once delivery requires idempotent consumers",
    "a dead letter queue captures messages that repeatedly fail",
    "consumer lag indicates the workers cannot keep up with arrivals",
    "backpressure prevents an overloaded consumer from collapsing",
    "ordering guarantees usually apply only within a partition",
    "visibility timeouts stop two workers processing the same item",
    "retry with exponential backoff avoids hammering a failing service",
    "work handed off asynchronously smooths bursty arrival rates",
    "processing the same event twice must not corrupt the result",
    "a growing backlog means arrivals exceed completions",
    "poison messages must be quarantined instead of retried forever",
  ],
  indexing: [
    "a btree index speeds up range queries on ordered columns",
    "a composite index only helps when the leading column is used",
    "every index adds write amplification on insert and update",
    "a covering index answers a query without touching the heap",
    "the planner may ignore an index when selectivity is poor",
    "full table scans dominate cost on large unindexed tables",
    "partial indexes reduce size by covering only matching rows",
    "index bloat is reclaimed by periodic maintenance",
    "looking up rows by a sorted structure beats scanning everything",
    "adding lookup structures makes writes more expensive",
    "statistics let the optimiser estimate how many rows match",
    "unused indexes cost storage and slow writes for no benefit",
  ],
  concurrency: [
    "a race condition appears when ordering between threads is unconstrained",
    "a mutex serialises access to shared mutable state",
    "deadlock occurs when two holders each wait on the other",
    "optimistic locking detects conflicts at commit time",
    "immutable data structures remove whole classes of races",
    "atomic compare and swap avoids taking a lock",
    "lock contention shows up as threads parked rather than working",
    "thread pools bound how much work runs simultaneously",
    "two tasks touching the same value can interleave badly",
    "guarding shared state costs throughput under contention",
    "circular waiting between holders halts progress entirely",
    "isolation levels define what concurrent transactions may observe",
  ],
  serialization: [
    "json is human readable but verbose on the wire",
    "protocol buffers require a schema and produce compact payloads",
    "schema evolution must tolerate unknown fields from newer senders",
    "versioning the payload avoids breaking older consumers",
    "binary encodings reduce bandwidth at the cost of inspectability",
    "floating point values lose precision across encodings",
    "a shared contract lets two services agree on message shape",
    "adding a field must not break a reader compiled earlier",
    "converting objects to bytes and back must round trip exactly",
    "content type negotiation selects the encoding for a response",
    "timestamps should carry an explicit timezone in transit",
    "large payloads should be streamed rather than buffered whole",
  ],
  ratelimiting: [
    "a token bucket allows short bursts within an average rate",
    "a leaky bucket smooths traffic to a constant outflow",
    "rate limits should return a retry after hint to the client",
    "per tenant quotas stop one caller starving the others",
    "sliding window counters approximate limits with less memory",
    "throttling protects a dependency from being overwhelmed",
    "a client should back off rather than retry immediately",
    "limits enforced at the edge shed load before it reaches the core",
    "capping how often a caller may act preserves capacity for everyone",
    "rejecting excess work early is cheaper than failing late",
    "fair sharing prevents a noisy neighbour dominating the service",
    "burst allowance absorbs brief spikes without rejecting requests",
  ],
};

// Two query styles per topic. The lexical queries share vocabulary with their
// documents; the paraphrase queries deliberately do not, which is exactly the
// case a semantic encoder is supposed to win and a lexical baseline cannot.
const QUERIES: Array<{ id: string; text: string; topic: string }> = [
  { id: "q-pooling", text: "database connection pooling", topic: "pooling" },
  { id: "q-pooling-para", text: "reusing established sockets instead of reconnecting", topic: "pooling" },
  { id: "q-caching", text: "cache invalidation and hit rate", topic: "caching" },
  { id: "q-caching-para", text: "storing computed answers so they are not recomputed", topic: "caching" },
  { id: "q-auth", text: "authentication tokens and access control", topic: "auth" },
  { id: "q-auth-para", text: "proving identity and deciding what someone may do", topic: "auth" },
  { id: "q-deploy", text: "safe deployment and rollback strategy", topic: "deploy" },
  { id: "q-deploy-para", text: "shipping a new build gradually and undoing it", topic: "deploy" },
  { id: "q-observability", text: "tracing metrics and alerting for incidents", topic: "observability" },
  { id: "q-observability-para", text: "understanding what a running system is doing", topic: "observability" },
  { id: "q-queueing", text: "message queue consumer lag and retries", topic: "queueing" },
  { id: "q-indexing", text: "database index selectivity and query planning", topic: "indexing" },
  { id: "q-concurrency", text: "race conditions locks and deadlock", topic: "concurrency" },
  { id: "q-serialization", text: "payload encoding and schema evolution", topic: "serialization" },
  { id: "q-ratelimiting", text: "throttling requests with token bucket quotas", topic: "ratelimiting" },
];

function buildCorpus(): Doc[] {
  const docs: Doc[] = [];
  for (const [topic, contents] of Object.entries(TOPICS)) {
    contents.forEach((content, i) => {
      docs.push({ id: `${topic}-${i}`, topic, content });
    });
  }
  return docs;
}

/** Plain BM25-ish lexical baseline: the thing the hybrid retriever must beat. */
function bm25Ranking(query: string, docs: readonly Doc[]): string[] {
  const k1 = 1.5;
  const b = 0.75;
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  const n = docs.length;
  const tokenised = docs.map((d) => ({
    id: d.id,
    tokens: d.content.toLowerCase().split(/\W+/).filter(Boolean),
  }));
  const avgLen = tokenised.reduce((sum, d) => sum + d.tokens.length, 0) / n;

  const df = new Map<string, number>();
  for (const term of terms) {
    df.set(term, tokenised.filter((d) => d.tokens.includes(term)).length);
  }

  return tokenised
    .map((doc) => {
      let score = 0;
      for (const term of terms) {
        const freq = doc.tokens.filter((t) => t === term).length;
        if (freq === 0) continue;
        const docFreq = df.get(term) ?? 0;
        const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
        score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * doc.tokens.length) / avgLen)));
      }
      return { id: doc.id, score };
    })
    .sort((a, b2) => b2.score - a.score)
    // Zero-scoring docs are kept. Dropping them looks tidier but weakens the
    // baseline: a retriever that returns 8 results is being compared against
    // one allowed to return fewer, and the gate passes on that gap rather than
    // on retrieval quality. Measured both ways — filtered made the margin look
    // like +0.050, unfiltered shows the real +0.025.
    .map((d) => d.id);
}

/**
 * Regression-lock mode: assert the hash-encoder figures have not moved.
 *
 * Returns the list of drifted metrics, empty when everything matches.
 */
function checkRegressionLock(actual: {
  baselineRecall: number;
  hybridRecall: number;
  hybridPrecision: number;
  hybridNdcg: number;
  hybridMrr: number;
}): string[] {
  const drift: string[] = [];
  for (const [metric, expected] of Object.entries(HASH_ENCODER_LOCK)) {
    const got = actual[metric as keyof typeof actual];
    if (Math.abs(got - expected) > LOCK_TOLERANCE) {
      drift.push(`    ${metric.padEnd(18)} expected ${expected.toFixed(6)}  got ${got.toFixed(6)}`);
    }
  }
  return drift;
}

async function main(): Promise<void> {
  const regressionLock = process.argv.includes("--regression-lock");
  const docs = buildCorpus();

  // EMBEDDINGS_URL points at any OpenAI-compatible /embeddings endpoint and
  // swaps in a real semantic encoder. Without it the run uses the deterministic
  // hash encoder, which is reproducible in CI but is NOT semantic — it scores a
  // topically relevant document that shares no vocabulary below an unrelated
  // one that happens to share a token.
  const embeddingsUrl = process.env["EMBEDDINGS_URL"];

  // The lock values were measured with the hash encoder. Running the lock
  // against a different encoder would compare against the wrong reference and
  // report drift that is really just a model change, so refuse instead.
  if (regressionLock && embeddingsUrl) {
    console.error(
      "❌ --regression-lock is calibrated for the deterministic hash encoder,\n" +
        `   but EMBEDDINGS_URL is set (${embeddingsUrl}). Unset it to run the lock,\n` +
        "   or drop --regression-lock to run the real acceptance gate.\n",
    );
    process.exitCode = 1;
    return;
  }

  const embedder = embeddingsUrl
    ? new BGEEmbeddingProvider(embeddingsUrl)
    : new LocalDeterministicEmbeddingProvider();
  console.log(
    `  encoder: ${embeddingsUrl ? `remote (${embeddingsUrl})` : "local-deterministic-hash-v1 (not semantic)"}\n`
  );

  const pipeline = new RealMemoryPipeline(embedder);
  await pipeline.addMemories(
    docs.map((doc) => ({
      content: doc.content,
      layer: "semantic" as const,
      tags: [doc.topic],
      importance: 0.5,
      createdAt: new Date().toISOString(),
      metadata: { sourceId: doc.id },
    })),
  );

  const idByContent = new Map(docs.map((d) => [d.content, d.id]));

  const cases: RetrievalCase[] = QUERIES.map((q) => ({
    queryId: q.id,
    query: q.text,
    relevantIds: docs.filter((d) => d.topic === q.topic).map((d) => d.id),
  }));

  const hybridRuns: RetrievalRun[] = [];
  const baselineRuns: RetrievalRun[] = [];

  for (const q of QUERIES) {
    const results = await pipeline.search(q.text, { limit: K });
    hybridRuns.push({
      queryId: q.id,
      rankedIds: results
        .map((r) => idByContent.get(r.content))
        .filter((id): id is string => typeof id === "string"),
    });
    baselineRuns.push({ queryId: q.id, rankedIds: bm25Ranking(q.text, docs).slice(0, K) });
  }

  const hybrid = evaluateRetrieval(cases, hybridRuns, K);
  const baseline = evaluateRetrieval(cases, baselineRuns, K);
  const comparison = compareRetrieval({
    cases,
    baselineRuns,
    candidateRuns: hybridRuns,
    k: K,
    margin: MARGIN,
  });

  console.log(`\nFAZ 11 — Recall@${K} (${docs.length} docs, ${QUERIES.length} queries)\n`);
  console.log(`  metric          baseline(bm25)   hybrid`);
  console.log(
    `  Recall@${K}        ${baseline.recallAtK.toFixed(3)}            ${hybrid.recallAtK.toFixed(3)}`,
  );
  console.log(
    `  Precision@${K}     ${baseline.precisionAtK.toFixed(3)}            ${hybrid.precisionAtK.toFixed(3)}`,
  );
  console.log(
    `  MRR             ${baseline.mrr.toFixed(3)}            ${hybrid.mrr.toFixed(3)}`,
  );
  console.log(
    `  nDCG@${K}         ${baseline.ndcgAtK.toFixed(3)}            ${hybrid.ndcgAtK.toFixed(3)}`,
  );
  console.log(`\n  per-query Recall@${K}:`);
  const baseByQuery = new Map(baseline.perQuery.map((q) => [q.queryId, q.recallAtK]));
  for (const q of hybrid.perQuery) {
    const base = baseByQuery.get(q.queryId) ?? 0;
    const mark = q.recallAtK > base ? "W" : q.recallAtK < base ? "L" : "T";
    console.log(
      `    ${q.queryId.padEnd(18)} ${base.toFixed(3)} → ${q.recallAtK.toFixed(3)}  [${mark}]`,
    );
  }
  console.log(`\n  ${comparison.summary}`);

  if (regressionLock) {
    const drift = checkRegressionLock({
      baselineRecall: baseline.recallAtK,
      hybridRecall: hybrid.recallAtK,
      hybridPrecision: hybrid.precisionAtK,
      hybridNdcg: hybrid.ndcgAtK,
      hybridMrr: hybrid.mrr,
    });

    if (drift.length > 0) {
      console.error(
        `\n❌ Regression lock failed: ${drift.length} metric(s) moved from the ` +
          `recorded hash-encoder behaviour.\n`,
      );
      console.error(drift.join("\n"));
      console.error(
        "\n   Retrieval logic changed. If the change is intentional and an\n" +
          "   improvement, re-measure and update HASH_ENCODER_LOCK in this file.\n" +
          "   Do not update it just to make CI green.\n",
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      "\n✅ Regression lock held: hash-encoder retrieval behaviour is unchanged.\n" +
        "   This is NOT the FAZ 11 acceptance criterion — it only proves the\n" +
        "   fusion and ranking logic did not regress. The criterion needs a real\n" +
        "   encoder (EMBEDDINGS_URL), where this pipeline measured 0.317 -> 0.400.\n",
    );
    return;
  }

  if (!comparison.passesGate) {
    console.error(
      `\n❌ Gate failed: hybrid retrieval must beat the lexical baseline by at least ` +
        `${MARGIN} Recall@${K} and win more queries than it loses.\n`,
    );
    if (!embeddingsUrl) {
      console.log(
        "   Note: this run used the deterministic hash encoder, which is NOT\n" +
          "   semantic and is given zero fusion weight by design. With a real\n" +
          "   embedding model (set EMBEDDINGS_URL to an OpenAI-compatible\n" +
          "   /embeddings endpoint) the same pipeline measured 0.317 -> 0.400\n" +
          "   (+0.083, 8W/1L/6T) and passes. The encoder is the limit here,\n" +
          "   not the retrieval logic.\n\n" +
          "   That is reproducible without an API key — a real MiniLM encoder\n" +
          "   runs on CPU in this repo:\n\n" +
          "     pip install sentence-transformers\n" +
          "     python3 packages/eval/tools/local-embeddings-server.py &\n" +
          "     EMBEDDINGS_URL=http://127.0.0.1:8099/v1/embeddings \\\n" +
          "       npm run eval:recall -w @haf/eval\n",
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(`\n✅ Gate passed: Recall@${K} beats the lexical baseline by the required margin.\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
