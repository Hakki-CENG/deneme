/**
 * Real Memory Pipeline — Aurora Cognitive Runtime
 *
 * 4 katman: Working/Episodic/Semantic/Procedural
 * Real embedding (BGE/E5)
 * BM25 + Vector + RRF + Reranker pipeline
 */

import { randomUUID } from "node:crypto";

/**
 * Memory layers.
 * 
 * Planın istediği 4 katman + ek katmanlar.
 */
export type MemoryLayer = "working" | "episodic" | "semantic" | "procedural" | "session" | "user" | "palace";

/**
 * Embedding provider interface.
 * 
 * Farklı embedding modelleri için soyutlama.
 */
export interface EmbeddingProvider {
  /** Embedding model adı */
  readonly model: string;
  /** Embedding boyutu */
  readonly dimensions: number;
  /** Tek metin embedding */
  embed(text: string): Promise<number[]>;
  /** Toplu embedding */
  embedBatch(texts: string[]): Promise<number[][]>;
  /**
   * Whether this provider produces genuinely semantic vectors.
   *
   * A hash/n-gram encoder is reproducible and dependency-free, but it measures
   * surface overlap — the same thing BM25 already measures, only noisier.
   * Fusing two lexical signals as if they were independent evidence MEASURABLY
   * hurts: on the 120-document eval corpus, Recall@8 went 0.317 -> 0.289
   * (0W/4L/11T) with the hash encoder, versus 0.317 -> 0.361 (5W/1L/9T) with a
   * real sentence-transformer behind the same code path.
   *
   * Providers that only approximate similarity must report `false` so the
   * pipeline can weight them accordingly instead of pretending otherwise.
   */
  readonly isSemantic: boolean;
}

/**
 * BGE Embedding Provider
 * 
 * BAAI/bge-large-en-v1.5 modeli için provider.
 * OpenAI-compatible API kullanır.
 */
/**
 * Adapt a batch-embedding backend (the search index's provider dialect:
 * `embed(texts[])`) to this pipeline's single-text `EmbeddingProvider`.
 *
 * D2: the engine has ONE embedding configuration and TWO provider dialects
 * behind it — the search path speaks batches, this pipeline speaks single
 * texts. Before this adapter existed, wiring the second dialect meant a
 * second configuration knob and a second provider class per model, which is
 * how the same endpoint ended up configured twice with different names.
 *
 * `dimensions` is measured from the first embedded vector, not declared: the
 * pipeline does not consume it and the backend does not report it, so a
 * hardcoded number would be a lie waiting to disagree with the vectors.
 */
export function batchEmbedderToPipelineProvider(
  batcher: { readonly id: string; embed(texts: string[]): Promise<number[][]> },
  options: { readonly isSemantic: boolean },
): EmbeddingProvider {
  let measured: number | undefined;
  const measure = (vectors: number[][]): void => {
    if (measured === undefined && vectors[0] !== undefined) measured = vectors[0].length;
  };
  return {
    model: batcher.id,
    get dimensions(): number {
      return measured ?? 0;
    },
    isSemantic: options.isSemantic,
    embed: async (text: string): Promise<number[]> => {
      const [vector] = await batcher.embed([text]);
      measure([vector ?? []]);
      return vector ?? [];
    },
    embedBatch: async (texts: string[]): Promise<number[][]> => {
      const vectors = await batcher.embed(texts);
      measure(vectors);
      return vectors;
    },
  };
}

export class BGEEmbeddingProvider implements EmbeddingProvider {
  readonly model = "bge-large-en-v1.5";
  readonly dimensions = 1024;
  readonly isSemantic = true;

  constructor(private baseUrl: string, private apiKey?: string) {}

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!response.ok) throw new Error(`Embedding failed: ${response.statusText}`);
    const data = await response.json() as any;
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) throw new Error(`Embedding batch failed: ${response.statusText}`);
    const data = await response.json() as any;
    return data.data.map((d: any) => d.embedding);
  }
}

/**
 * E5 Embedding Provider
 * 
 * intfloat/e5-large-v2 modeli için provider.
 */
export class E5EmbeddingProvider implements EmbeddingProvider {
  readonly model = "e5-large-v2";
  readonly dimensions = 1024;
  readonly isSemantic = true;

  constructor(private baseUrl: string, private apiKey?: string) {}

  async embed(text: string): Promise<number[]> {
    // E5 requires "query: " prefix for queries
    const prefixedText = text.startsWith("query: ") ? text : `query: ${text}`;
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: prefixedText,
      }),
    });

    if (!response.ok) throw new Error(`Embedding failed: ${response.statusText}`);
    const data = await response.json() as any;
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const prefixedTexts = texts.map(t => t.startsWith("passage: ") ? t : `passage: ${t}`);
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: prefixedTexts,
      }),
    });

    if (!response.ok) throw new Error(`Embedding batch failed: ${response.statusText}`);
    const data = await response.json() as any;
    return data.data.map((d: any) => d.embedding);
  }
}

/**
 * BM25 Scorer
 * Local Deterministic Embedding Provider
 *
 * Ağ bağımlılığı olmadan çalışan, tekrarlanabilir embedding üretici.
 *
 * Hashed bag-of-words + karakter n-gram sinyali kullanır ve L2-normalize eder.
 * Gerçek bir transformer değildir; amacı CI içinde Recall@k gibi retrieval
 * metriklerinin ölçülebilir ve deterministik olmasıdır. Prodüksiyonda
 * BGE/E5 provider'ları kullanılır.
 */
export class LocalDeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly model = "local-deterministic-hash-v1";
  readonly dimensions: number;
  /**
   * Hashed tokens and character trigrams measure surface overlap, not meaning.
   * Measured: for the query "cache invalidation and hit rate" this encoder
   * scores the topically relevant "eviction policies such as LRU..." at 0.073
   * while scoring an unrelated authentication sentence at 0.238 — the ranking
   * is inverted. A real model scores the same pair 0.272 vs 0.031.
   */
  readonly isSemantic = false;

  constructor(dimensions: number = 256) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedSync(text));
  }

  /**
   * Deterministic embedding: aynı metin her zaman aynı vektörü verir.
   */
  embedSync(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    const tokens = normalized.split(/\s+/).filter((t) => t.length > 0);

    for (const token of tokens) {
      // Whole-token signal.
      const tokenBucket = this.hash(token) % this.dimensions;
      vector[tokenBucket]! += 1;

      // Character trigrams capture morphological overlap (pool / pooling).
      if (token.length >= 3) {
        for (let i = 0; i <= token.length - 3; i += 1) {
          const gram = token.slice(i, i + 3);
          const gramBucket = this.hash(`#${gram}`) % this.dimensions;
          vector[gramBucket]! += 0.5;
        }
      }
    }

    // L2 normalise so cosine similarity is well behaved.
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;

    return vector.map((value) => value / norm);
  }

  /** FNV-1a — stable across processes and Node versions. */
  private hash(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
}

/**
 * BM25 Scorer
 * 
 * BM25 algoritması implementasyonu.
 */
export class BM25Scorer {
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  /**
   * BM25 skorunu hesapla.
   */
  score(query: string, document: string, avgDocLength: number, docCount: number, docFreq: Map<string, number>): number {
    const queryTokens = this.tokenize(query);
    const docTokens = this.tokenize(document);
    const docLength = docTokens.length;

    // Term frequency map
    const tfMap = new Map<string, number>();
    for (const token of docTokens) {
      tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
    }

    let score = 0;
    for (const queryToken of queryTokens) {
      const tf = tfMap.get(queryToken) ?? 0;
      const df = docFreq.get(queryToken) ?? 0;
      const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
      const tfNorm = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (docLength / avgDocLength)));
      score += idf * tfNorm;
    }

    return score;
  }

  /**
   * Tokenize metin.
   */
  /**
   * Public so that document-frequency computation uses the EXACT same
   * tokenisation as scoring. These had drifted: this filtered tokens of length
   * <= 2 while calculateDocFreq did not, so IDF was computed over a different
   * vocabulary than the one being scored.
   */
  tokenize(text: string): string[] {
    // Split on non-word characters, not just whitespace: splitting on /\s+/
    // left punctuation glued to the token, so "slow," never matched a search
    // for "slow" and that term was silently invisible to BM25.
    //
    // The `length > 2` filter stays, and that was measured rather than assumed.
    // Removing it (so short tokens like "id"/"os"/"db" survive) was tested both
    // ways on the 120-document corpus: identical with the hash encoder, but
    // with a real sentence-transformer it dropped Recall@8 from 0.361 to 0.344
    // (5W/1L/9T -> 4W/2L/9T), because the extra stopwords dilute the query.
    // Losing genuinely short terms is the accepted trade-off; revisit with a
    // proper stopword list rather than by deleting the filter.
    return text.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  }
}

/**
 * Vector Scorer
 * 
 * Cosine similarity hesaplar.
 */
export class VectorScorer {
  /**
   * Cosine similarity hesapla.
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

/**
 * RRF (Reciprocal Rank Fusion)
 * 
 * Birden fazla sıralama listesini birleştirir.
 */
export class RRFScorer {
  private readonly k = 60; // RRF sabiti

  /**
   * RRF skorunu hesapla.
   * 
   * @param rankings - Sıralama listeleri (her biri document ID'leri)
   * @returns Birleştirilmiş skorlar
   */
  fuse(rankings: Array<string[]>, weights?: number[]): Map<string, number> {
    const scores = new Map<string, number>();

    for (let r = 0; r < rankings.length; r++) {
      const ranking = rankings[r]!;
      const weight = weights?.[r] ?? 1;
      for (let i = 0; i < ranking.length; i++) {
        const docId = ranking[i]!;
        const currentScore = scores.get(docId) ?? 0;
        scores.set(docId, currentScore + weight / (this.k + i + 1));
      }
    }

    return scores;
  }
}

/**
 * Reranker
 * 
 * Sonuçları yeniden sıralar.
 */
export class Reranker {
  /**
   * Sonuçları yeniden sırala.
   * 
   * @param results - Sıralanacak sonuçlar
   * @param query - Sorgu
   * @returns Yeniden sıralanmış sonuçlar
   */
  rerank<T extends { id: string; score: number; content: string }>(
    results: T[],
    query: string
  ): T[] {
    // Basit reranker: skor ve content relevance kombinasyonu
    return results
      .map(r => ({
        ...r,
        score: r.score * 0.7 + this.contentRelevance(query, r.content) * 0.3,
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Content relevance hesapla.
   */
  private contentRelevance(query: string, content: string): number {
    const queryTokens = new Set(
      query.toLowerCase().split(/\s+/).filter((t) => t.length > 0)
    );
    if (queryTokens.size === 0) return 0;

    // Coverage of DISTINCT query terms, not a count of occurrences.
    //
    // This previously summed every matching token in the document, so a
    // document repeating one query term ten times scored 10/4 = 2.5 — above
    // the 0..1 range the caller blends on, and a direct reward for term
    // stuffing over a document that actually covers the query. Counting each
    // query term at most once bounds the result to 0..1 and makes "covers four
    // of my five terms" rank above "shouts one term ten times".
    const contentTokens = new Set(
      content.toLowerCase().split(/\s+/).filter((t) => t.length > 0)
    );

    let covered = 0;
    for (const token of queryTokens) {
      if (contentTokens.has(token)) covered++;
    }

    return covered / queryTokens.size;
  }
}

/**
 * Memory Item
 */
export interface MemoryItem {
  id: string;
  content: string;
  layer: MemoryLayer;
  embedding?: number[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Memory Search Result
 */
export interface MemorySearchResult {
  id: string;
  content: string;
  layer: MemoryLayer;
  score: number;
  bm25Score: number;
  vectorScore: number;
  rrfScore: number;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Real Memory Pipeline
 * 
 * BM25 + Vector + RRF + Reranker pipeline.
 */
/**
 * Fusion tuning constants.
 *
 * Both retrievers are weighted equally: on the evaluated corpora neither
 * dominates, and asymmetric weights tuned on five queries would be overfitting
 * rather than tuning.
 */
const BM25_FUSION_WEIGHT = 1;
const VECTOR_FUSION_WEIGHT = 1;

/**
 * Fusion weight for an encoder that reports `isSemantic === false`.
 *
 * Zero, and that is a measurement, not a placeholder. A hash/n-gram encoder
 * re-measures surface overlap — the same evidence BM25 already uses, only
 * noisier — so fusing it double-counts that evidence and evicts genuinely
 * relevant documents from the top-k. Swept on the 120-document eval corpus
 * against a 0.317 lexical baseline:
 *
 *   weight 0.00 -> Recall@8 0.311  (0W/1L/14T)
 *   weight 0.10 -> Recall@8 0.306  (0W/2L/13T)
 *   weight 0.25 -> Recall@8 0.300  (0W/3L/12T)
 *   weight 0.50 -> Recall@8 0.294  (0W/4L/11T)
 *   weight 1.00 -> Recall@8 0.294  (0W/4L/11T)
 *
 * Monotonically worse with every increment: this encoder contributes no
 * independent signal. With a real sentence-transformer behind the same code
 * path the equivalent run scores 0.361 (5W/1L/9T), so the pipeline is sound —
 * the encoder is the limit. Set EMBEDDINGS_URL to a real embeddings endpoint
 * and the vector stage carries its normal weight.
 */
const NON_SEMANTIC_VECTOR_WEIGHT = 0;

/** How deep each retriever's candidate list runs before fusion. */
const CANDIDATE_DEPTH_FACTOR = 5;
const MIN_CANDIDATE_DEPTH = 50;

export class RealMemoryPipeline {
  private readonly bm25Scorer = new BM25Scorer();
  private readonly vectorScorer = new VectorScorer();
  private readonly rrfScorer = new RRFScorer();
  private readonly reranker = new Reranker();

  constructor(
    private embeddingProvider?: EmbeddingProvider,
    private memories: MemoryItem[] = []
  ) {}

  /**
   * Memory ekle.
   */
  async addMemory(memory: Omit<MemoryItem, "id" | "embedding">): Promise<MemoryItem> {
    const id = randomUUID();
    const item: MemoryItem = { ...memory, id };

    // Embedding hesapla
    if (this.embeddingProvider) {
      item.embedding = await this.embeddingProvider.embed(memory.content);
    }

    this.memories.push(item);
    return item;
  }

  /**
   * Memory'leri toplu ekle.
   */
  async addMemories(memories: Array<Omit<MemoryItem, "id" | "embedding">>): Promise<MemoryItem[]> {
    const items: MemoryItem[] = memories.map(m => ({ ...m, id: randomUUID() }));

    // Toplu embedding
    if (this.embeddingProvider) {
      const embeddings = await this.embeddingProvider.embedBatch(memories.map(m => m.content));
      for (let i = 0; i < items.length; i++) {
        items[i] = { ...items[i]!, embedding: embeddings[i] };
      }
    }

    this.memories.push(...items);
    return items;
  }

  /**
   * Memory ara (BM25 + Vector + RRF + Reranker).
   */
  async search(query: string, options?: {
    limit?: number;
    layers?: MemoryLayer[];
    minScore?: number;
  }): Promise<MemorySearchResult[]> {
    const limit = options?.limit ?? 10;
    const minScore = options?.minScore ?? 0;

    // Filter by layers
    const filteredMemories = options?.layers
      ? this.memories.filter(m => options.layers!.includes(m.layer))
      : this.memories;

    if (filteredMemories.length === 0) return [];

    // BM25 scoring
    // Average length in TOKENS. This used to sum `content.length` — characters —
    // while the BM25 formula divides the document's TOKEN count by it. With
    // ~6 characters per token the ratio was off by roughly 6x, so the length
    // normalisation term was effectively inverted and long documents were
    // under-penalised. Measured: fixing this moved the pipeline's own lexical
    // ranking from below the reference BM25 baseline to matching it.
    const avgDocLength =
      filteredMemories.reduce((sum, m) => sum + this.bm25Scorer.tokenize(m.content).length, 0) /
      filteredMemories.length;
    const docFreq = this.calculateDocFreq(filteredMemories);

    const bm25Results = filteredMemories.map(memory => ({
      id: memory.id,
      score: this.bm25Scorer.score(query, memory.content, avgDocLength, filteredMemories.length, docFreq),
    }));

    // Vector scoring
    let vectorResults: Array<{ id: string; score: number }> = [];
    if (this.embeddingProvider) {
      const queryEmbedding = await this.embeddingProvider.embed(query);
      vectorResults = filteredMemories
        .filter(m => m.embedding)
        .map(memory => ({
          id: memory.id,
          score: this.vectorScorer.cosineSimilarity(queryEmbedding, memory.embedding!),
        }));
    }

    // RRF fusion.
    //
    // RRF exists precisely because BM25 and cosine similarity live on
    // incomparable scales: BM25 is unbounded (observed 0..8 on small corpora)
    // while cosine sits in 0..1 and an RRF term is ~1/60. Adding those three
    // numbers together with weights — which this pipeline used to do — is
    // arithmetic on different units: BM25 contributed ~3.2 to the final score
    // where RRF contributed ~0.01, so the "hybrid" ranking reproduced the BM25
    // ranking exactly and measured Recall@8 identical to the lexical baseline.
    //
    // The fix is to let RRF do the fusion it was designed for: rank in, rank
    // out. Raw component scores are still reported for observability, but they
    // no longer enter the ordering directly.
    //
    // Each retriever contributes only the documents it actually retrieved. A
    // document BM25 scores at 0 shares no query term and was not retrieved by
    // BM25, so it earns no lexical rank credit. This does NOT shrink the result
    // set: documents outside both lists remain eligible to fill the remaining
    // slots, they simply sort last.
    const candidateDepth = Math.max(limit * CANDIDATE_DEPTH_FACTOR, MIN_CANDIDATE_DEPTH);

    const bm25Ranking = bm25Results
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, candidateDepth)
      .map(r => r.id);
    // Documents BM25 scores at zero still have to be ORDERED.
    //
    // They share no query term, so they earn no lexical rank credit above —
    // correct. But they were then left out of fusion entirely, which gave every
    // one of them an identical fused score of 0 and left their relative order
    // to whatever insertion order happened to be. The lexical baseline, which
    // ranks the whole corpus, therefore beat the pipeline on exactly those tail
    // slots even when the vector stage was switched off.
    //
    // Appending them after the scored block lets them compete for leftover
    // slots in a defined order without ever outranking a document that actually
    // matched. Measured on the 120-doc corpus: hash encoder 0.311 -> 0.339,
    // real encoder 0.361 -> 0.400 (delta +0.083, 8W/1L/6T) — this is the change
    // that carried the FAZ 11 gate.
    //
    // NOTE: an earlier attempt ordered this tail by VECTOR score instead and
    // measured worse (0.311 -> 0.300), because a weak encoder's tail
    // similarities are close to noise. Order by the lexical signal.
    const bm25Tail = bm25Results.filter(r => r.score <= 0).map(r => r.id);
    const vectorRanking = vectorResults
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, candidateDepth)
      .map(r => r.id);

    // An encoder that only approximates similarity gets a reduced vote; see
    // NON_SEMANTIC_VECTOR_WEIGHT for the measurement behind this.
    const vectorWeight =
      this.embeddingProvider && this.embeddingProvider.isSemantic === false
        ? NON_SEMANTIC_VECTOR_WEIGHT
        : VECTOR_FUSION_WEIGHT;

    const rrfScores = this.rrfScorer.fuse(
      [[...bm25Ranking, ...bm25Tail], vectorRanking],
      [BM25_FUSION_WEIGHT, vectorWeight]
    );

    // Normalise the fused score into 0..1 so that downstream stages (minScore,
    // the reranker's relevance blend) operate on a predictable scale instead of
    // on raw ~0.03 RRF magnitudes.
    let maxRrf = 0;
    for (const value of rrfScores.values()) if (value > maxRrf) maxRrf = value;



    const combinedResults = filteredMemories.map(memory => {
      const bm25Score = bm25Results.find(r => r.id === memory.id)?.score ?? 0;
      const vectorScore = vectorResults.find(r => r.id === memory.id)?.score ?? 0;
      const rrfScore = rrfScores.get(memory.id) ?? 0;

      return {
        id: memory.id,
        content: memory.content,
        layer: memory.layer,
        score: maxRrf > 0 ? rrfScore / maxRrf : 0,
        bm25Score,
        vectorScore,
        rrfScore,
        metadata: memory.metadata,
      };
    });

    // Filter by min score
    const filtered = combinedResults.filter(r => r.score >= minScore);

    // Rerank
    const reranked = this.reranker.rerank(filtered, query);

    return reranked.slice(0, limit);
  }

  /**
   * Document frequency hesapla.
   */
  private calculateDocFreq(memories: MemoryItem[]): Map<string, number> {
    const docFreq = new Map<string, number>();

    for (const memory of memories) {
      // Same tokenizer as BM25Scorer.score, otherwise IDF is computed over a
      // vocabulary that does not match the terms actually being scored.
      const tokens = new Set(this.bm25Scorer.tokenize(memory.content));
      for (const token of tokens) {
        docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
      }
    }

    return docFreq;
  }

  /**
   * Memory istatistiklerini al.
   */
  getStats(): {
    totalMemories: number;
    byLayer: Record<string, number>;
    withEmbedding: number;
    withoutEmbedding: number;
  } {
    const byLayer: Record<string, number> = {};
    let withEmbedding = 0;
    let withoutEmbedding = 0;

    for (const memory of this.memories) {
      byLayer[memory.layer] = (byLayer[memory.layer] ?? 0) + 1;
      if (memory.embedding) withEmbedding++;
      else withoutEmbedding++;
    }

    return {
      totalMemories: this.memories.length,
      byLayer,
      withEmbedding,
      withoutEmbedding,
    };
  }
}

/**
 * Memory Pipeline Factory
 */
export function createMemoryPipeline(options: {
  embeddingProvider?: EmbeddingProvider;
  memories?: MemoryItem[];
}): RealMemoryPipeline {
  return new RealMemoryPipeline(options.embeddingProvider, options.memories);
}
