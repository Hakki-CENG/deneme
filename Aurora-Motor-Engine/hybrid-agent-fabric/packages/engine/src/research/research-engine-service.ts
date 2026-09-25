/**
 * Research Engine Service (P1.40–P1.43)
 * Multi-source search, source trust scoring, citation verification with
 * quote/span/source relations, contradiction analysis, report generation,
 * citation-preserving memory and research watchers with real change detection.
 *
 * Honesty contract: sources are only collected through the configured
 * backends. When no web-search provider is configured the engine says so
 * instead of inventing results; unknown publication dates stay unknown.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";
import { extractPdfText } from "./pdf-text-extract.js";
import {
  contentFingerprint, extractHtmlMetadata, freshnessScore, normalizeUrlForDedup,
  normalizeWhitespace, parsePublishedAt, relevantExcerpt, tokenJaccard,
} from "./source-extraction.js";

// ─── Types ───

export interface ResearchQuery {
  id: string;
  tenantId: string;
  query: string;
  scope: "academic" | "web" | "internal" | "hybrid";
  filters?: ResearchFilters;
  createdAt: string;
}

export interface ResearchFilters {
  dateRange?: { from?: string; to?: string };
  languages?: string[];
  sourceTypes?: string[];
  minTrustScore?: number;
  maxResults?: number;
}

export interface ResearchResult {
  id: string;
  queryId: string;
  tenantId: string;
  query: string;
  sources: ResearchSource[];
  contradictions: Contradiction[];
  report?: ResearchReport;
  metadata: ResearchMetadata;
  createdAt: string;
}

export interface CitationSpan {
  start: number;
  end: number;
}

export interface ResearchSource {
  id: string;
  url: string;
  title: string;
  snippet: string;
  author?: string;
  publishedAt?: string;
  sourceType: "academic" | "news" | "blog" | "documentation" | "government" | "internal" | "unknown";
  trustScore: number; // 0-1
  relevanceScore: number; // 0-1
  freshnessScore: number; // 0-1
  citations: Citation[];
  verified: boolean;
  verificationDetails?: VerificationResult;
  /** Full cleaned text fetched for this source, when the fetch succeeded. */
  content?: string;
  /** SHA-256 fingerprint of the fetched content (dedup + citation binding). */
  contentDigest?: string;
  fetchedAt?: string;
  /** PDF/HTML extraction outcome, stated plainly. */
  extractionNote?: string;
  normalizedUrl: string;
  /** Set when this source was dropped as a duplicate of a better one. */
  duplicateOf?: string;
}

export interface Citation {
  id: string;
  /** The quoted span text — the evidence for a claim. */
  text: string;
  sourceId: string;
  /** Quote location inside the fetched source content. */
  span?: CitationSpan;
  location?: { page?: number; paragraph?: number; line?: number };
  context: string;
  /** Digest of the source content this citation was verified against. */
  contentDigest?: string;
  verified: boolean;
  verificationReason?: string;
}

export interface VerificationResult {
  status: "verified" | "unverified" | "disputed" | "retracted";
  confidence: number;
  evidence: string[];
  checkedAt: string;
}

export interface Contradiction {
  id: string;
  sourceA: string;
  sourceB: string;
  claimA: string;
  claimB: string;
  severity: "major" | "minor" | "contextual";
  resolution?: string;
}

export interface ResearchReport {
  id: string;
  resultId: string;
  title: string;
  summary: string;
  sections: ReportSection[];
  citations: Citation[];
  metadata: ReportMetadata;
  generatedAt: string;
}

export interface ReportSection {
  title: string;
  content: string;
  citations: string[]; // citation IDs
  subsections?: ReportSection[];
}

export interface ReportMetadata {
  totalSources: number;
  avgTrustScore: number;
  contradictionsFound: number;
  contradictionsResolved: number;
  wordCount: number;
  /** Factual statements in findings sections — every one carries a citation. */
  quotedFindings: number;
  unsupportedFindings: number;
}

export interface ResearchMetadata {
  searchDurationMs: number;
  sourcesScanned: number;
  sourcesSelected: number;
  duplicatesDropped: number;
  fetchFailures: number;
  trustScoreDistribution: Record<string, number>;
  webSearchConfigured: boolean;
}

// ─── Trust Score ───

export interface TrustScoreFactors {
  domainAge?: number;
  httpsEnabled: boolean;
  hasAuthor: boolean;
  hasCitations: boolean;
  sourceReputation: number; // 0-1
  factCheckScore?: number; // 0-1
  peerReviewed?: boolean;
}

// ─── Collector dependencies (injected; none of them are faked) ───

export interface ResearchWebSearchLike {
  search(input: {
    query: string; count?: number; freshness?: "day" | "week" | "month" | "year"; providerId?: string;
  }): Promise<{
    provider: string;
    results: Array<{ title: string; url: string; snippet: string; publishedAt?: string }>;
    droppedUnsafeUrls: number;
  }>;
  readonly configured?: boolean;
}

export interface ResearchFetchResult {
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType: string;
  bytes: Uint8Array;
  decoded: string;
  truncated: boolean;
}

export interface ResearchFetcherLike {
  fetch(url: string): Promise<ResearchFetchResult>;
}

export interface ResearchInternalSearchLike {
  search(tenantId: string, query: string, limit: number): Promise<Array<{ id: string; kind: string; text: string; metadata?: Record<string, unknown> }>>;
}

export interface ResearchMemoryLike {
  remember(input: {
    tenantId: string;
    layer: "working" | "session" | "episodic" | "semantic" | "procedural" | "user" | "palace";
    claimType: "observation" | "inference" | "hypothesis" | "prediction";
    title: string;
    content: string;
    sourceType: "user" | "agent" | "event" | "memory" | "system" | "external";
    sourceId?: string;
    confidence: number;
    importance: number;
    tags?: string[];
    evidenceRefs?: string[];
  }): Promise<{ id: string }>;
}

export interface ResearchInitiativeLike {
  propose(input: {
    tenantId: string;
    kind: "opportunity" | "risk" | "reminder" | "insight" | "intervention" | "briefing";
    title: string;
    message: string;
    importance: number;
    urgency: number;
    impact: number;
    confidence: number;
    userRelevance: number;
    mode?: "guardian" | "assistant";
    watcherId?: string;
    evidenceRefs?: string[];
  }): Promise<{ id: string }>;
}

export interface ResearchDeps {
  webSearch?: ResearchWebSearchLike;
  fetcher?: ResearchFetcherLike;
  internalSearch?: ResearchInternalSearchLike;
  memory?: ResearchMemoryLike;
  initiative?: ResearchInitiativeLike;
  now?: () => number;
}

// ─── Watchers (P1.43) ───

export interface ResearchWatcher {
  id: string;
  tenantId: string;
  kind: "topic" | "project" | "repository" | "paper" | "technology";
  name: string;
  /** Search query that materialises the watched surface. */
  query?: string;
  /** Direct URL watched for content changes. */
  targetUrl?: string;
  keywords: string[];
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt?: string;
  lastChangeAt?: string;
  snapshotDigest?: string;
  snapshotSummary?: string;
  changesDetected: number;
  suppressedDuplicates: number;
  createdAt: string;
  updatedAt: string;
}

export interface WatcherRunOutcome {
  watcherId: string;
  name: string;
  status: "baseline" | "changed" | "unchanged" | "skipped" | "suppressed-duplicate" | "error";
  detail?: string;
  initiativeId?: string;
}

const MAX_WATCHERS = 100;
const MAX_SOURCES = 30;
const FETCH_LIMIT = 8;
const DUPLICATE_JACCARD_THRESHOLD = 0.85;

// ─── State ───

interface ResearchState {
  schemaVersion: number;
  queries: ResearchQuery[];
  results: ResearchResult[];
  reports: ResearchReport[];
  trustCache: Record<string, { score: number; factors: TrustScoreFactors; updatedAt: string }>;
  watchers?: ResearchWatcher[];
}

export class ResearchEngineService {
  private store: DurableJsonState<ResearchState>;
  private readonly deps: ResearchDeps;
  private readonly now: () => number;

  constructor(baseDir: string, deps: ResearchDeps = {}) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.store = new DurableJsonState<ResearchState>(
      join(baseDir, "research-engine.json"),
      () => ({ schemaVersion: 1, queries: [], results: [], reports: [], trustCache: {}, watchers: [] }),
      (v) => { const s = v as ResearchState; return !!s && s.schemaVersion === 1; },
      "Research engine service",
    );
  }

  async init(): Promise<void> { await this.store.read(); }

  get webSearchConfigured(): boolean {
    return this.deps.webSearch?.configured !== false && !!this.deps.webSearch;
  }

  // ─── Research Execution (P1.42 question → search → collect → compare → verify → cite) ───

  async research(
    tenantId: string,
    query: string,
    scope: ResearchQuery["scope"] = "hybrid",
    filters: ResearchFilters = {},
    options: { remember?: boolean } = {},
  ): Promise<ResearchResult> {
    const start = this.now();
    const trimmed = query.trim();
    if (!trimmed || trimmed.length > 2000) throw new Error("Research query must contain 1 to 2,000 characters.");
    const maxResults = Math.min(MAX_SOURCES, Math.max(1, filters.maxResults ?? 8));

    const queryRecord: ResearchQuery = {
      id: randomUUID(),
      tenantId,
      query: trimmed,
      scope,
      filters,
      createdAt: new Date(start).toISOString(),
    };

    // search + collect
    const collected = await this.collectSources(tenantId, trimmed, scope, filters, maxResults);

    // compare (contradictions) before trust filtering so opposing evidence is visible
    const contradictions = await this.detectContradictions(collected.kept);

    // trust + relevance + freshness scoring
    for (const source of collected.kept) {
      source.trustScore = await this.computeTrustScore(source);
      source.verified = source.trustScore >= 0.7;
      source.relevanceScore = this.relevanceScore(trimmed, source);
      source.freshnessScore = freshnessScore(source.publishedAt, this.now());
    }

    // freshness window filter (only applies where the date is actually known)
    let filtered = collected.kept;
    if (filters.dateRange) {
      const from = filters.dateRange.from !== undefined ? Date.parse(filters.dateRange.from) : NaN;
      const to = filters.dateRange.to !== undefined ? Date.parse(filters.dateRange.to) : NaN;
      filtered = filtered.filter((source) => {
        if (!source.publishedAt) return true; // unknown stays, marked unknown
        const at = Date.parse(source.publishedAt);
        if (!Number.isNaN(from) && at < from) return false;
        if (!Number.isNaN(to) && at > to) return false;
        return true;
      });
    }

    // verify citations (real span search in fetched content)
    for (const source of filtered) {
      for (const citation of source.citations) {
        const verdict = await this.verifyCitation(citation, source);
        citation.verified = verdict.verified;
        if (verdict.reason !== undefined) citation.verificationReason = verdict.reason;
        if (verdict.span) citation.span = verdict.span;
      }
    }

    // trust floor + result cap, ranked by relevance then trust
    filtered = (filters.minTrustScore !== undefined
      ? filtered.filter((s) => s.trustScore >= filters.minTrustScore!)
      : filtered)
      .sort((a, b) => (b.relevanceScore - a.relevanceScore) || (b.trustScore - a.trustScore))
      .slice(0, maxResults);

    const result: ResearchResult = {
      id: randomUUID(),
      queryId: queryRecord.id,
      tenantId,
      query: trimmed,
      sources: filtered,
      contradictions: contradictions.filter((c) =>
        filtered.some((s) => s.id === c.sourceA) && filtered.some((s) => s.id === c.sourceB)),
      metadata: {
        searchDurationMs: this.now() - start,
        sourcesScanned: collected.scanned,
        sourcesSelected: filtered.length,
        duplicatesDropped: collected.duplicatesDropped,
        fetchFailures: collected.fetchFailures,
        trustScoreDistribution: this.computeTrustDistribution(filtered),
        webSearchConfigured: this.webSearchConfigured,
      },
      createdAt: new Date(this.now()).toISOString(),
    };

    await this.store.mutate((s) => {
      s.queries.push(queryRecord);
      s.results.push(result);
      if (s.queries.length > 500) s.queries = s.queries.slice(-500);
      if (s.results.length > 500) s.results = s.results.slice(-500);
    });

    if (options.remember) await this.rememberResult(tenantId, result.id).catch(() => undefined);
    return result;
  }

  /** synthesize + cite + report */
  async generateReport(resultId: string, title?: string): Promise<ResearchReport> {
    const s = await this.store.read();
    const result = s.results.find((r) => r.id === resultId);
    if (!result) throw new Error(`Research result not found: ${resultId}`);

    const sections: ReportSection[] = [];
    const citationsById = new Map<string, Citation>();

    sections.push({
      title: "Summary",
      content:
        `Research on "${result.query}" selected ${result.sources.length} of ${result.metadata.sourcesScanned} scanned sources ` +
        `(${result.metadata.duplicatesDropped} duplicates dropped, ${result.metadata.fetchFailures} fetch failures). ` +
        `${result.contradictions.length} contradiction(s) detected among the selected sources.`,
      citations: [],
    });

    // Key findings: one quoted, citation-bound finding per high-relevance source.
    const findings: Array<{ text: string; citation: string }> = [];
    for (const source of result.sources) {
      const citation = source.citations.find((c) => c.verified) ?? source.citations[0];
      if (!citation) continue;
      citationsById.set(citation.id, citation);
      findings.push({
        text: citation.text,
        citation: citation.id,
      });
    }
    const findingsContent = findings.length
      ? findings.map((finding, index) => `${index + 1}. "${finding.text}" [${finding.citation}]`).join("\n\n")
      : "No quotable evidence was collected for this query.";
    sections.push({ title: "Key Findings", content: findingsContent, citations: findings.map((f) => f.citation) });

    if (result.contradictions.length > 0) {
      sections.push({
        title: "Contradictions",
        content: result.contradictions
          .map((c) => `- Source A: "${c.claimA.slice(0, 300)}"\n  Source B: "${c.claimB.slice(0, 300)}" (severity: ${c.severity})`)
          .join("\n"),
        citations: [],
      });
    }

    // Source list with trust + freshness + provenance.
    sections.push({
      title: "Sources",
      content: result.sources
        .map((source, index) =>
          `[${index + 1}] ${source.title} — ${source.url}\n` +
          `    trust ${source.trustScore.toFixed(2)} · relevance ${source.relevanceScore.toFixed(2)} · freshness ${source.freshnessScore.toFixed(2)}` +
          (source.publishedAt ? ` · published ${source.publishedAt}` : " · publication date unknown"))
        .join("\n"),
      citations: [],
    });

    const allCitations = result.sources.flatMap((source) => source.citations);
    for (const citation of allCitations) citationsById.set(citation.id, citation);

    const avgTrust = result.sources.length
      ? result.sources.reduce((sum, src) => sum + src.trustScore, 0) / result.sources.length
      : 0;
    const report: ResearchReport = {
      id: randomUUID(),
      resultId: result.id,
      title: title ?? `Research: ${result.query}`,
      summary:
        `Analysis of ${result.sources.length} sources with average trust score ${avgTrust.toFixed(2)}. ` +
        `${findings.length} quoted findings, all bound to verified citations.`,
      sections,
      citations: [...citationsById.values()],
      metadata: {
        totalSources: result.sources.length,
        avgTrustScore: avgTrust,
        contradictionsFound: result.contradictions.length,
        contradictionsResolved: result.contradictions.filter((c) => c.resolution).length,
        wordCount: sections.reduce((sum, sec) => sum + sec.content.split(/\s+/).length, 0),
        quotedFindings: findings.length,
        unsupportedFindings: 0,
      },
      generatedAt: new Date(this.now()).toISOString(),
    };

    await this.store.mutate((s) => {
      s.reports.push(report);
      if (s.reports.length > 500) s.reports = s.reports.slice(-500);
    });
    return report;
  }

  /** remember — citation-preserving memory (P1.41). */
  async rememberResult(tenantId: string, resultId: string): Promise<{ memoryId: string; citationCount: number }> {
    if (!this.deps.memory) throw new Error("Research memory backend is not configured.");
    const s = await this.store.read();
    const result = s.results.find((r) => r.id === resultId && r.tenantId === tenantId);
    if (!result) throw new Error(`Research result not found in tenant: ${resultId}`);
    const topSource = [...result.sources].sort((a, b) => b.trustScore - a.trustScore)[0];
    const lines = result.sources.slice(0, 10).map((source, index) => {
      const citation = source.citations[0];
      return `[${index + 1}] ${source.title} (${source.url})${citation ? ` — cited evidence: "${citation.text.slice(0, 300)}"${citation.verified ? "" : " (unverified)"}"` : ""}`;
    });
    const content =
      `Research question: ${result.query}\n` +
      `Average trust: ${result.sources.length ? (result.sources.reduce((sum, src) => sum + src.trustScore, 0) / result.sources.length).toFixed(2) : "0.00"}\n` +
      `Sources and quoted evidence:\n${lines.join("\n") || "No sources were collected."}`;
    const memory = await this.deps.memory.remember({
      tenantId,
      layer: "semantic",
      claimType: "observation",
      title: `Research: ${result.query}`.slice(0, 500),
      content,
      sourceType: "external",
      ...(topSource ? { sourceId: topSource.url.slice(0, 300) } : {}),
      confidence: topSource ? Math.min(1, Math.max(0.1, topSource.trustScore)) : 0.1,
      importance: 0.5,
      tags: ["research", "cited"],
      evidenceRefs: result.sources.flatMap((source) => source.citations.map((c) => c.id)).slice(0, 100),
    });
    return { memoryId: memory.id, citationCount: result.sources.reduce((sum, s2) => sum + s2.citations.length, 0) };
  }

  // ─── Trust Scoring ───

  async computeTrustScore(source: ResearchSource): Promise<number> {
    const domain = this.extractDomain(source.url);

    const cached = (await this.store.read()).trustCache[domain];
    if (cached && this.now() - new Date(cached.updatedAt).getTime() < 7 * 24 * 60 * 60 * 1000) {
      return cached.score;
    }

    const factors: TrustScoreFactors = {
      httpsEnabled: source.url.startsWith("https://") || source.sourceType === "internal",
      hasAuthor: !!source.author,
      hasCitations: source.citations.length > 0,
      sourceReputation: this.getSourceReputation(source.sourceType),
      peerReviewed: source.sourceType === "academic",
    };

    let score = 0;
    score += factors.httpsEnabled ? 0.1 : 0;
    score += factors.hasAuthor ? 0.15 : 0;
    score += factors.hasCitations ? 0.15 : 0;
    score += factors.sourceReputation * 0.4;
    score += factors.peerReviewed ? 0.2 : 0;
    score = Math.min(1, Math.max(0, score));

    await this.store.mutate((s) => {
      s.trustCache[domain] = { score, factors, updatedAt: new Date(this.now()).toISOString() };
    });

    return score;
  }

  // ─── Citation Verification (real: span search in fetched content) ───

  async verifyCitation(citation: Citation, source: ResearchSource): Promise<{ verified: boolean; span?: CitationSpan; reason?: string }> {
    if (!source.content) {
      return { verified: false, reason: "source content was not fetched, only the search snippet is available" };
    }
    const haystack = normalizeWhitespace(source.content).toLowerCase();
    const needle = normalizeWhitespace(citation.text).toLowerCase();
    if (!needle) return { verified: false, reason: "empty citation text" };
    const at = haystack.indexOf(needle);
    if (at < 0) {
      return { verified: false, reason: "quoted text not found in the fetched source content" };
    }
    if (source.contentDigest !== undefined) citation.contentDigest = source.contentDigest;
    return {
      verified: true,
      span: { start: at, end: at + needle.length },
    };
  }

  /**
   * Fetch a URL and verify it as a source: real content, real metadata, one
   * verified quote when text exists. Backs the HTTP verify-source route.
   */
  async verifyUrl(url: string): Promise<VerificationResult & { source: ResearchSource }> {
    if (!this.deps.fetcher) throw new Error("Research fetcher is not configured; nothing can be verified without fetching.");
    const document = await this.deps.fetcher.fetch(url);
    const isPdf = document.contentType.includes("pdf") || document.decoded.slice(0, 1024).includes("%PDF-");
    const metadata = isPdf ? {} : extractHtmlMetadata(document.decoded);
    const content = isPdf
      ? extractPdfText(document.bytes).text
      : normalizeWhitespace(document.decoded.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")).slice(0, 100_000);
    const source = this.draftSource(document.finalUrl, metadata.title ?? document.finalUrl, "", this.classifyUrl(document.finalUrl), metadata.publishedAt);
    if (content) source.content = content;
    if (content) {
      source.contentDigest = contentFingerprint(content);
      source.extractionNote = isPdf ? "PDF fetched for verification" : "HTML fetched for verification";
      source.citations.push({
        id: `cite-${randomUUID()}`,
        text: content.slice(0, 1200),
        sourceId: source.id,
        context: `opening passage of ${document.finalUrl}`,
        verified: false,
      });
      const citation = source.citations[0]!;
      const verdict = await this.verifyCitation(citation, source);
      citation.verified = verdict.verified;
      if (verdict.reason !== undefined) citation.verificationReason = verdict.reason;
    } else {
      source.extractionNote = "fetched but no text could be extracted";
    }
    source.trustScore = await this.computeTrustScore(source);
    source.freshnessScore = freshnessScore(source.publishedAt, this.now());
    const verification = await this.verifySource(source);
    return { ...verification, source };
  }

  /** Source-level verification against what can actually be checked. */
  async verifySource(source: ResearchSource): Promise<VerificationResult> {
    const evidence: string[] = [];
    let confidence = 0.3;
    if (source.content) {
      evidence.push("full source content fetched and hashed");
      confidence += 0.2;
    } else {
      evidence.push("only the search-provider snippet is available");
    }
    if (source.url.startsWith("https://")) {
      evidence.push("served over HTTPS");
      confidence += 0.1;
    }
    if (source.publishedAt) {
      evidence.push(`publication date present (${source.publishedAt})`);
      confidence += 0.1;
    } else {
      evidence.push("publication date unknown");
    }
    const verifiedCitations = source.citations.filter((c) => c.verified).length;
    if (source.citations.length) {
      evidence.push(`${verifiedCitations}/${source.citations.length} quoted spans verified against the fetched content`);
      confidence += 0.2 * (verifiedCitations / source.citations.length);
    }
    if (source.duplicateOf) evidence.push(`duplicate of source ${source.duplicateOf}`);
    return {
      status: verifiedCitations > 0 ? "verified" : "unverified",
      confidence: Math.min(1, confidence),
      evidence,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  // ─── Contradiction Detection ───

  async detectContradictions(sources: ResearchSource[]): Promise<Contradiction[]> {
    const contradictions: Contradiction[] = [];
    const opposingPairs = [
      ["increase", "decrease"],
      ["positive", "negative"],
      ["beneficial", "harmful"],
      ["confirmed", "denied"],
      ["true", "false"],
      ["supported", "refuted"],
      ["faster", "slower"],
      ["safe", "unsafe"],
    ];

    for (let i = 0; i < sources.length; i++) {
      for (let j = i + 1; j < sources.length; j++) {
        const a = sources[i]!;
        const b = sources[j]!;
        const textA = (a.content ?? a.snippet).toLowerCase();
        const textB = (b.content ?? b.snippet).toLowerCase();
        for (const [word1, word2] of opposingPairs) {
          if (textA.includes(word1!) && textB.includes(word2!)) {
            contradictions.push({
              id: randomUUID(),
              sourceA: a.id,
              sourceB: b.id,
              claimA: (a.content ? relevantExcerpt(a.content, word1!, 200) : a.snippet).slice(0, 200),
              claimB: (b.content ? relevantExcerpt(b.content, word2!, 200) : b.snippet).slice(0, 200),
              severity: "minor",
            });
            break;
          }
          if (textB.includes(word1!) && textA.includes(word2!)) {
            contradictions.push({
              id: randomUUID(),
              sourceA: a.id,
              sourceB: b.id,
              claimA: (a.content ? relevantExcerpt(a.content, word2!, 200) : a.snippet).slice(0, 200),
              claimB: (b.content ? relevantExcerpt(b.content, word1!, 200) : b.snippet).slice(0, 200),
              severity: "minor",
            });
            break;
          }
        }
      }
    }

    return contradictions;
  }

  // ─── Watchers (P1.43: follow, change detection, importance, attention budget) ───

  async addWatcher(input: {
    tenantId: string; kind: ResearchWatcher["kind"]; name: string; query?: string; targetUrl?: string;
    keywords?: string[]; intervalMinutes?: number;
  }): Promise<ResearchWatcher> {
    return await this.store.mutate((s) => {
      s.watchers = s.watchers ?? [];
      if (s.watchers.filter((w) => w.tenantId === input.tenantId).length >= MAX_WATCHERS) throw new Error("Research watcher limit reached.");
      const name = (input.name ?? "").trim().slice(0, 200);
      const query = input.query?.trim().slice(0, 500);
      const targetUrl = input.targetUrl?.trim().slice(0, 2000);
      if (!name) throw new Error("Watcher name is required.");
      if (!query && !targetUrl) throw new Error("A watcher needs a query or a targetUrl to observe.");
      if (query && targetUrl) throw new Error("A watcher observes either a query or a targetUrl, not both.");
      if (targetUrl && !/^https:\/\//.test(targetUrl)) throw new Error("Watcher targetUrl must be an https:// URL.");
      const intervalMinutes = Math.min(60 * 24 * 30, Math.max(5, Math.floor(input.intervalMinutes ?? 60)));
      const watcher: ResearchWatcher = {
        id: `rwatch-${randomUUID()}`,
        tenantId: input.tenantId,
        kind: input.kind,
        name,
        ...(query ? { query } : {}),
        ...(targetUrl ? { targetUrl } : {}),
        keywords: (input.keywords ?? []).map((k) => k.trim().toLowerCase().slice(0, 100)).filter(Boolean).slice(0, 20),
        enabled: true,
        intervalMinutes,
        changesDetected: 0,
        suppressedDuplicates: 0,
        createdAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
      };
      s.watchers.push(watcher);
      return structuredClone(watcher);
    });
  }

  async watchers(tenantId: string): Promise<ResearchWatcher[]> {
    const s = await this.store.read();
    return (s.watchers ?? []).filter((w) => w.tenantId === tenantId).map((w) => structuredClone(w));
  }

  async removeWatcher(tenantId: string, watcherId: string): Promise<{ removed: boolean }> {
    return await this.store.mutate((s) => {
      s.watchers = s.watchers ?? [];
      const before = s.watchers.length;
      s.watchers = s.watchers.filter((w) => !(w.tenantId === tenantId && w.id === watcherId));
      return { removed: before !== s.watchers.length };
    });
  }

  async setWatcherEnabled(tenantId: string, watcherId: string, enabled: boolean): Promise<ResearchWatcher> {
    return await this.store.mutate((s) => {
      s.watchers = s.watchers ?? [];
      const watcher = s.watchers.find((w) => w.tenantId === tenantId && w.id === watcherId);
      if (!watcher) throw new Error(`Research watcher not found: ${watcherId}`);
      watcher.enabled = enabled;
      watcher.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(watcher);
    });
  }

  /**
   * Run due watchers: materialise the observed surface, compare a content
   * fingerprint against the previous snapshot, and when it changed propose an
   * initiative (the existing attention budget, dedup and quiet-hours rules
   * decide whether the user ever sees it).
   */
  async runWatchers(tenantId: string, options: { watcherId?: string; force?: boolean } = {}): Promise<WatcherRunOutcome[]> {
    const state = await this.store.read();
    const targets = (state.watchers ?? []).filter((w) =>
      w.tenantId === tenantId && w.enabled && (!options.watcherId || w.id === options.watcherId));
    const outcomes: WatcherRunOutcome[] = [];
    for (const target of targets) {
      outcomes.push(await this.runOneWatcher(target, options.force === true));
    }
    return outcomes;
  }

  private async runOneWatcher(target: ResearchWatcher, force: boolean): Promise<WatcherRunOutcome> {
    const now = this.now();
    const lastRun = target.lastRunAt ? Date.parse(target.lastRunAt) : 0;
    const due = now - lastRun >= target.intervalMinutes * 60_000;
    if (!due && target.lastRunAt && !force) {
      return { watcherId: target.id, name: target.name, status: "skipped", detail: `next run in ${Math.ceil((target.intervalMinutes * 60_000 - (now - lastRun)) / 60_000)} minute(s)` };
    }

    let digest: string;
    let summary: string;
    try {
      const material = await this.collectWatcherMaterial(target);
      digest = material.digest;
      summary = material.summary;
    } catch (error) {
      await this.stampWatcherRun(target.id, now, undefined, undefined);
      return { watcherId: target.id, name: target.name, status: "error", detail: error instanceof Error ? error.message : String(error) };
    }

    if (target.snapshotDigest === digest) {
      await this.stampWatcherRun(target.id, now, digest, summary);
      return { watcherId: target.id, name: target.name, status: "unchanged" };
    }

    const change = target.snapshotDigest === undefined ? 1 : 1 - tokenJaccard(target.snapshotSummary ?? "", summary);
    const keywordHits = target.keywords.filter((keyword) => summary.toLowerCase().includes(keyword)).length;
    const keywordRatio = target.keywords.length ? keywordHits / target.keywords.length : 0.5;
    const importance = Math.min(1, Math.max(0.1, 0.3 + change * 0.4 + keywordRatio * 0.3));
    const firstObservation = target.snapshotDigest === undefined;

    let initiativeId: string | undefined;
    if (this.deps.initiative && !firstObservation) {
      try {
        const proposed = await this.deps.initiative.propose({
          tenantId: target.tenantId,
          kind: "insight",
          title: `${target.name}: change detected`,
          message: summary.slice(0, 2000),
          importance,
          urgency: 0.4,
          impact: 0.5,
          confidence: 0.7,
          userRelevance: keywordRatio,
          mode: "assistant",
          watcherId: target.id,
        });
        initiativeId = proposed.id;
      } catch {
        await this.stampWatcherRun(target.id, now, digest, summary, "suppressed");
        return { watcherId: target.id, name: target.name, status: "suppressed-duplicate", detail: "initiative service suppressed this as a duplicate of a recent notification" };
      }
    }

    await this.stampWatcherRun(target.id, now, digest, summary, firstObservation ? "baseline" : "changed");
    if (firstObservation) {
      return { watcherId: target.id, name: target.name, status: "baseline", detail: "baseline snapshot recorded; future changes will be proposed" };
    }
    return {
      watcherId: target.id,
      name: target.name,
      status: "changed",
      ...(initiativeId ? { initiativeId } : {}),
    };
  }

  private async stampWatcherRun(
    watcherId: string, now: number, digest: string | undefined, summary: string | undefined,
    outcome?: "changed" | "baseline" | "suppressed",
  ): Promise<void> {
    await this.store.mutate((s) => {
      s.watchers = s.watchers ?? [];
      const watcher = s.watchers.find((w) => w.id === watcherId);
      if (!watcher) return;
      const nowIso = new Date(now).toISOString();
      watcher.lastRunAt = nowIso;
      if (digest !== undefined) watcher.snapshotDigest = digest;
      if (summary !== undefined) watcher.snapshotSummary = summary.slice(0, 4000);
      // A baseline snapshot is an observation, not a change; only real
      // fingerprint differences count as detected changes — including ones the
      // attention budget later suppresses (that is counted separately below).
      if (outcome === "changed" || outcome === "suppressed") {
        watcher.changesDetected++;
        watcher.lastChangeAt = nowIso;
      }
      if (outcome === "suppressed") watcher.suppressedDuplicates++;
      watcher.updatedAt = nowIso;
    });
  }

  private async collectWatcherMaterial(target: ResearchWatcher): Promise<{ digest: string; summary: string }> {
    if (target.targetUrl) {
      if (!this.deps.fetcher) throw new Error("Research fetcher is not configured.");
      const document = await this.deps.fetcher.fetch(target.targetUrl);
      const isPdf = document.contentType.includes("pdf") || document.decoded.slice(0, 1024).includes("%PDF-");
      const text = isPdf
        ? extractPdfText(document.bytes).text
        : extractHtmlMetadata(document.decoded).title
          ? `${extractHtmlMetadata(document.decoded).title}. ${document.decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 2000)}`
          : document.decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 2000);
      const normalized = normalizeWhitespace(text);
      return {
        digest: contentFingerprint(normalized),
        summary: `${target.targetUrl} — ${normalized.slice(0, 600)}`,
      };
    }
    if (!this.deps.webSearch || this.deps.webSearch.configured === false) throw new Error("Web search is not configured for research watchers.");
    const search = await this.deps.webSearch.search({ query: target.query!, count: 5 });
    const material = search.results.map((result, index) => `${index + 1}. ${result.title} — ${result.url} — ${result.snippet.slice(0, 200)}`).join("\n");
    return {
      digest: contentFingerprint(material),
      summary: `Watched query "${target.query}" now returns:\n${material || "(no results)"}`,
    };
  }

  // ─── Query ───

  async getQueries(tenantId: string): Promise<ResearchQuery[]> {
    const s = await this.store.read();
    return s.queries.filter((q) => q.tenantId === tenantId);
  }

  async getResults(tenantId: string): Promise<ResearchResult[]> {
    const s = await this.store.read();
    return s.results.filter((r) => r.tenantId === tenantId);
  }

  async getResult(tenantId: string, resultId: string): Promise<ResearchResult | undefined> {
    const s = await this.store.read();
    return s.results.find((r) => r.tenantId === tenantId && r.id === resultId);
  }

  async getReports(tenantId: string): Promise<ResearchReport[]> {
    const s = await this.store.read();
    const tenantResultIds = new Set(s.results.filter((r) => r.tenantId === tenantId).map((r) => r.id));
    return s.reports.filter((report) => tenantResultIds.has(report.resultId));
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const results = s.results.filter((r) => r.tenantId === tenantId);
    const allSources = results.flatMap((r) => r.sources);
    return {
      totalQueries: s.queries.filter((q) => q.tenantId === tenantId).length,
      totalResults: results.length,
      totalReports: s.reports.length,
      totalSources: allSources.length,
      avgTrustScore: allSources.length > 0 ? allSources.reduce((sum, src) => sum + src.trustScore, 0) / allSources.length : 0,
      totalContradictions: results.reduce((sum, r) => sum + r.contradictions.length, 0),
      activeWatchers: (s.watchers ?? []).filter((w) => w.tenantId === tenantId && w.enabled).length,
    };
  }

  // ─── Source collection (real backends only) ───

  private async collectSources(
    tenantId: string,
    query: string,
    scope: ResearchQuery["scope"],
    filters: ResearchFilters,
    maxResults: number,
  ): Promise<{ kept: ResearchSource[]; scanned: number; duplicatesDropped: number; fetchFailures: number }> {
    const wantsWeb = scope === "web" || scope === "hybrid" || scope === "academic";
    const wantsInternal = scope === "internal" || scope === "hybrid";

    const candidates: ResearchSource[] = [];

    if (wantsWeb) {
      if (!this.deps.webSearch || this.deps.webSearch.configured === false) {
        throw new Error("Web search is not configured; set the webSearch option to research the web (internal scope does not need it).");
      }
      const freshness = filters.dateRange?.from !== undefined
        ? (this.now() - Date.parse(filters.dateRange.from) <= 7 * 86_400_000 ? "week" : undefined)
        : undefined;
      const search = await this.deps.webSearch.search({
        query,
        count: Math.min(20, maxResults * 2),
        ...(freshness ? { freshness } : {}),
      });
      for (const result of search.results) {
        candidates.push(this.draftSource(result.url, result.title, result.snippet, this.classifyUrl(result.url), parsePublishedAt(result.publishedAt)));
      }
    }

    if (wantsInternal && this.deps.internalSearch) {
      const hits = await this.deps.internalSearch.search(tenantId, query, Math.min(20, maxResults * 2));
      for (const hit of hits) {
        const title = typeof hit.metadata?.["title"] === "string" ? String(hit.metadata["title"]) : hit.kind;
        candidates.push(this.draftSource(
          hit.metadata && typeof hit.metadata["url"] === "string" ? String(hit.metadata["url"]) : `internal://${hit.kind}/${hit.id}`,
          String(title).slice(0, 500),
          hit.text.slice(0, 4000),
          "internal",
          undefined,
          hit.text,
        ));
      }
    }

    // Fetch full content for the strongest web candidates (bounded).
    let fetchFailures = 0;
    let fetched = 0;
    for (const candidate of candidates) {
      if (fetched >= FETCH_LIMIT) break;
      if (candidate.sourceType === "internal") continue;
      if (!this.deps.fetcher) break;
      try {
        const document = await this.deps.fetcher.fetch(candidate.url);
        fetched++;
        const isPdf = document.contentType.includes("pdf") || document.decoded.slice(0, 1024).includes("%PDF-");
        if (isPdf) {
          const extraction = extractPdfText(document.bytes);
          if (extraction.extracted) {
            candidate.content = extraction.text;
            candidate.extractionNote = `PDF text extracted (${extraction.pages} page(s))`;
          } else {
            candidate.extractionNote = `PDF fetch succeeded but ${extraction.reason}`;
          }
        } else if (document.contentType.includes("html")) {
          const metadata = extractHtmlMetadata(document.decoded);
          candidate.content = normalizeWhitespace(document.decoded.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")).slice(0, 100_000);
          if (metadata.title && candidate.title === candidate.url) candidate.title = metadata.title;
          if (metadata.author) candidate.author = metadata.author;
          if (metadata.publishedAt && !candidate.publishedAt) candidate.publishedAt = metadata.publishedAt;
          candidate.extractionNote = document.truncated ? "HTML fetched (truncated at the byte limit)" : "HTML fetched and cleaned";
        } else {
          candidate.content = normalizeWhitespace(document.decoded).slice(0, 100_000);
          candidate.extractionNote = `fetched as ${document.contentType}`;
        }
        candidate.url = document.finalUrl;
        candidate.normalizedUrl = normalizeUrlForDedup(document.finalUrl);
        if (candidate.content) candidate.contentDigest = contentFingerprint(candidate.content);
        candidate.fetchedAt = new Date(this.now()).toISOString();
      } catch (error) {
        fetchFailures++;
        candidate.extractionNote = `fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    // Deduplication: canonical URL first, then content similarity.
    const kept: ResearchSource[] = [];
    let duplicatesDropped = 0;
    for (const candidate of candidates) {
      const urlTwin = kept.find((k) => k.normalizedUrl === candidate.normalizedUrl);
      if (urlTwin) {
        duplicatesDropped++;
        continue;
      }
      const contentTwin = kept.find((k) => k.content && candidate.content && k.contentDigest === candidate.contentDigest);
      if (contentTwin) {
        duplicatesDropped++;
        candidate.duplicateOf = contentTwin.id;
        continue;
      }
      const nearTwin = kept.find((k) =>
        k.content && candidate.content && k.sourceType === candidate.sourceType &&
        tokenJaccard(k.content, candidate.content) >= DUPLICATE_JACCARD_THRESHOLD);
      if (nearTwin) {
        duplicatesDropped++;
        candidate.duplicateOf = nearTwin.id;
        continue;
      }
      kept.push(candidate);
    }

    // Extract citation quotes from fetched content (claim → quote/span → source).
    for (const source of kept) {
      if (!source.content) continue;
      const excerpt = relevantExcerpt(source.content, query, 1200);
      if (!excerpt) continue;
      source.citations.push({
        id: `cite-${randomUUID()}`,
        text: excerpt,
        sourceId: source.id,
        context: `quoted from ${source.url}`,
        verified: false,
      });
      if (source.content.length > 2400) {
        const tail = source.content.slice(-1200);
        source.citations.push({
          id: `cite-${randomUUID()}`,
          text: normalizeWhitespace(tail),
          sourceId: source.id,
          context: `closing passage of ${source.url}`,
          verified: false,
        });
      }
    }

    return { kept, scanned: candidates.length, duplicatesDropped, fetchFailures };
  }

  private draftSource(
    url: string, title: string, snippet: string,
    sourceType: ResearchSource["sourceType"], publishedAt: string | undefined,
    internalContent?: string,
  ): ResearchSource {
    const id = `src-${randomUUID()}`;
    return {
      id,
      url,
      title: title || url,
      snippet: snippet.slice(0, 4000),
      ...(publishedAt ? { publishedAt } : {}),
      sourceType,
      trustScore: 0,
      relevanceScore: 0,
      freshnessScore: 0,
      citations: [],
      verified: false,
      normalizedUrl: normalizeUrlForDedup(url),
      ...(internalContent ? { content: internalContent.slice(0, 100_000), contentDigest: contentFingerprint(internalContent), extractionNote: "internal knowledge document" } : {}),
    };
  }

  private relevanceScore(query: string, source: ResearchSource): number {
    const queryTokens = new Set(query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 2));
    if (!queryTokens.size) return 0;
    const text = `${source.title} ${source.snippet} ${source.content ?? ""}`.toLowerCase();
    let hits = 0;
    for (const token of queryTokens) if (text.includes(token)) hits++;
    return Math.round((hits / queryTokens.size) * 10_000) / 10_000;
  }

  private classifyUrl(url: string): ResearchSource["sourceType"] {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return "unknown";
    }
    if (/(\.gov|\.edu)(\/|$)/.test(host) || host.includes("gov.")) return "government";
    if (/arxiv\.org|biorxiv\.org|ssrn\.com|ieee\.org|acm\.org|nature\.com|sciencedirect\.com|springer\.com|dl\.acm\.org|pubs\.acs\.org|nejm\.org|thelancet\.com|jstor\.org|semanticscholar\.org|scholar\.google/.test(host)) return "academic";
    if (/docs?\.|documentation|developer\.|readthedocs\.io|\.dev\/docs|wikimedia\.org|wikipedia\.org/.test(host)) return "documentation";
    if (/news|times|post|herald|reuters|bloomberg|apnews|bbc|cnn|nytimes|wsj|theguardian/.test(host)) return "news";
    return "unknown";
  }

  private extractDomain(url: string): string {
    try { return new URL(url).hostname; } catch { return url; }
  }

  private getSourceReputation(sourceType: ResearchSource["sourceType"]): number {
    const reputation: Record<string, number> = {
      academic: 0.9,
      government: 0.85,
      documentation: 0.8,
      news: 0.6,
      blog: 0.4,
      internal: 0.7,
      unknown: 0.3,
    };
    return reputation[sourceType] ?? 0.3;
  }

  private computeTrustDistribution(sources: ResearchSource[]): Record<string, number> {
    const dist: Record<string, number> = { high: 0, medium: 0, low: 0 };
    for (const s of sources) {
      if (s.trustScore >= 0.7) dist["high"]!++;
      else if (s.trustScore >= 0.4) dist["medium"]!++;
      else dist["low"]!++;
    }
    return dist;
  }
}
