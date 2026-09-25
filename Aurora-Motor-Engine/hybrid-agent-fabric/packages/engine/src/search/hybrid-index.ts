import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../util/atomic-file.js";
import type { JsonValue } from "../types.js";

export interface EmbeddingProvider {
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly id = "hash-embedding-v1";
  constructor(readonly dimensions = 256) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      for (const token of tokenize(text)) {
        const digest = createHash("sha256").update(token).digest();
        const index = digest.readUInt32BE(0) % this.dimensions;
        const sign = digest[4]! % 2 ? 1 : -1;
        vector[index] = (vector[index] ?? 0) + sign;
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      return vector.map((value) => value / norm);
    });
  }
}

export interface OpenAIEmbeddingOptions {
  baseUrl?: string;
  apiKey: string;
  model?: string;
  dimensions?: number;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai-embedding";
  constructor(private readonly options: OpenAIEmbeddingOptions) {}
  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${(this.options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.options.model ?? "text-embedding-3-small",
        input: texts,
        ...(this.options.dimensions ? { dimensions: this.options.dimensions } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Embedding API ${response.status}: ${(await response.text()).slice(0, 1000)}`);
    const body = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
    const sorted = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
    if (sorted.length !== texts.length || sorted.some((item) => !Array.isArray(item.embedding))) throw new Error("Embedding provider returned an invalid vector count.");
    return sorted.map((item) => item.embedding);
  }
}

export interface SearchDocument {
  id: string;
  tenantId: string;
  kind: "session_message" | "memory" | "skill" | "artifact";
  text: string;
  metadata: Record<string, JsonValue>;
  vector: number[];
  embeddingProvider: string;
  updatedAt: string;
}

export interface HybridSearchHit {
  id: string;
  kind: SearchDocument["kind"];
  text: string;
  metadata: Record<string, JsonValue>;
  score: number;
  lexicalScore: number;
  vectorScore: number;
}

function tokenize(value: string): string[] {
  return value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length > 1);
}

function isSearchDocument(value: unknown): value is SearchDocument {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.tenantId === "string" &&
    typeof record.kind === "string" &&
    typeof record.text === "string" &&
    typeof record.embeddingProvider === "string" &&
    Array.isArray(record.vector) &&
    record.vector.every((item) => typeof item === "number")
  );
}

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0, a = 0, b = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
    a += left[index]! ** 2;
    b += right[index]! ** 2;
  }
  return a && b ? dot / Math.sqrt(a * b) : 0;
}

export class HybridSearchIndex {
  private documents: SearchDocument[] = [];
  private loaded = false;
  private writeChain = Promise.resolve();

  constructor(
    private readonly rootPath: string,
    private readonly embeddings: EmbeddingProvider = new HashEmbeddingProvider(),
  ) {}

  private get path(): string { return join(this.rootPath, "search", "hybrid-index.json"); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      // Shape-validated on load: a row that is not a document (a hand edit, a
      // truncated write from an older format) must not reach `search`, where
      // it would either throw or — worse — silently score. Dropped rows are a
      // fact about the file, reported by `count()`, not hidden.
      this.documents = Array.isArray(parsed)
        ? parsed.filter(isSearchDocument)
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    this.writeChain = this.writeChain.then(() => atomicWrite(this.path, `${JSON.stringify(this.documents)}\n`));
    return await this.writeChain;
  }

  async upsert(input: Omit<SearchDocument, "vector" | "embeddingProvider" | "updatedAt">): Promise<SearchDocument> {
    await this.load();
    if (!input.text.trim()) throw new Error("Search document text cannot be empty.");
    const [vector] = await this.embeddings.embed([input.text]);
    if (!vector?.length || vector.some((value) => !Number.isFinite(value))) throw new Error("Embedding provider returned an invalid vector.");
    const document: SearchDocument = {
      ...input,
      vector,
      embeddingProvider: this.embeddings.id,
      updatedAt: new Date().toISOString(),
    };
    const index = this.documents.findIndex((item) => item.id === input.id && item.tenantId === input.tenantId);
    if (index >= 0) this.documents[index] = document;
    else this.documents.push(document);
    await this.save();
    return structuredClone(document);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    await this.load();
    const before = this.documents.length;
    this.documents = this.documents.filter((item) => !(item.tenantId === tenantId && item.id === id));
    if (this.documents.length !== before) await this.save();
    return this.documents.length !== before;
  }

  async search(input: {
    tenantId: string;
    query: string;
    kinds?: SearchDocument["kind"][];
    limit?: number;
    lexicalWeight?: number;
    vectorWeight?: number;
  }): Promise<HybridSearchHit[]> {
    await this.load();
    const candidates = this.documents.filter((item) => item.tenantId === input.tenantId && (!input.kinds?.length || input.kinds.includes(item.kind)));
    if (!candidates.length || !input.query.trim()) return [];
    const queryTerms = tokenize(input.query);
    const [queryVector] = await this.embeddings.embed([input.query]);
    const lengths = candidates.map((item) => tokenize(item.text).length);
    const averageLength = lengths.reduce((sum, value) => sum + value, 0) / lengths.length || 1;
    const documentFrequency = new Map<string, number>();
    for (const term of new Set(queryTerms)) {
      documentFrequency.set(term, candidates.filter((item) => new Set(tokenize(item.text)).has(term)).length);
    }
    const lexicalWeight = input.lexicalWeight ?? 0.55;
    const vectorWeight = input.vectorWeight ?? 0.45;
    const hits = candidates.map((document, documentIndex) => {
      const terms = tokenize(document.text);
      const frequencies = new Map<string, number>();
      for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      let bm25 = 0;
      for (const term of queryTerms) {
        const tf = frequencies.get(term) ?? 0;
        if (!tf) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5));
        const denominator = tf + 1.2 * (1 - 0.75 + 0.75 * lengths[documentIndex]! / averageLength);
        bm25 += idf * (tf * 2.2 / denominator);
      }
      const normalizedLexical = bm25 ? bm25 / (bm25 + 1) : 0;
      // Cross-provider cosine is meaningless: a document embedded by another
      // model lives in a different vector space, and its similarity to this
      // query is a number that looks like evidence and is not. Such documents
      // keep their lexical score and get vector 0 — the honest value — until
      // `rebuild()` re-embeds them with the current provider.
      const sameProvider = document.embeddingProvider === this.embeddings.id;
      const rawCosine = sameProvider ? cosine(queryVector!, document.vector) : 0;
      const normalizedVector = sameProvider ? (rawCosine + 1) / 2 : 0;
      return {
        id: document.id,
        kind: document.kind,
        text: document.text.slice(0, 2000),
        metadata: structuredClone(document.metadata),
        lexicalScore: Number(normalizedLexical.toFixed(6)),
        vectorScore: Number(normalizedVector.toFixed(6)),
        score: Number((lexicalWeight * normalizedLexical + vectorWeight * normalizedVector).toFixed(6)),
      };
    });
    return hits.sort((a, b) => b.score - a.score).slice(0, input.limit ?? 20);
  }

  async count(tenantId?: string): Promise<number> {
    await this.load();
    return this.documents.filter((item) => !tenantId || item.tenantId === tenantId).length;
  }

  /**
   * Re-embed every document with the CURRENT provider (D2).
   *
   * The index is durable and outlives configuration: documents written under
   * one embedding model are still there when another is configured, and
   * `search` honestly refuses to compare across spaces (vector 0). Rebuild is
   * the migration path — the texts are the source of truth, the vectors are
   * derived — and it is explicit rather than automatic because re-embedding a
   * large index costs real money against a real endpoint.
   *
   * Batched, so a large index does not turn into one unbounded request.
   */
  async rebuild(): Promise<{ reembedded: number }> {
    await this.load();
    const batchSize = 64;
    for (let start = 0; start < this.documents.length; start += batchSize) {
      const batch = this.documents.slice(start, start + batchSize)!;
      const vectors = await this.embeddings.embed(batch.map((document) => document.text));
      if (vectors.length !== batch.length) {
        throw new Error(`Embedding provider returned ${vectors.length} vector(s) for ${batch.length} document(s).`);
      }
      for (let index = 0; index < batch.length; index += 1) {
        const vector = vectors[index]!;
        if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
          throw new Error("Embedding provider returned an invalid vector.");
        }
        batch[index]!.vector = vector;
        batch[index]!.embeddingProvider = this.embeddings.id;
        batch[index]!.updatedAt = new Date().toISOString();
      }
    }
    await this.save();
    return { reembedded: this.documents.length };
  }
}
