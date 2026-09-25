import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  ResearchEngineService,
  type ResearchFetcherLike,
  type ResearchInitiativeLike,
  type ResearchMemoryLike,
  type ResearchWebSearchLike,
} from "../src/research/research-engine-service.js";
import { extractPdfText } from "../src/research/pdf-text-extract.js";
import { HybridAgentEngine } from "../src/engine.js";
import { randomUUID } from "node:crypto";

// ─── Fixtures ───

interface FakePage {
  contentType: string;
  body: string | Uint8Array;
}

function fakeFetcher(pages: Record<string, FakePage>): ResearchFetcherLike & { served: string[] } {
  const served: string[] = [];
  return {
    served,
    fetch: async (url: string) => {
      served.push(url);
      const page = pages[url];
      if (!page) throw new Error(`404 not found: ${url}`);
      const bytes = typeof page.body === "string" ? new TextEncoder().encode(page.body) : page.body;
      const decoded = typeof page.body === "string" ? page.body : Buffer.from(page.body).toString("latin1");
      return { finalUrl: url, status: 200, ok: true, contentType: page.contentType, bytes, decoded, truncated: false };
    },
  };
}

function fakeWebSearch(results: Array<{ title: string; url: string; snippet: string; publishedAt?: string }>): ResearchWebSearchLike {
  return {
    configured: true,
    search: async (input) => ({
      provider: "fake",
      results: results.filter((result) => !input.freshness || result.publishedAt !== undefined).slice(0, input.count ?? 8),
      droppedUnsafeUrls: 0,
    }),
  };
}

function fakeMemory(): ResearchMemoryLike & { remembered: unknown[][] } {
  const remembered: unknown[][] = [];
  return {
    remembered,
    remember: async (input) => {
      remembered.push(input);
      return { id: `mem-${remembered.length}` };
    },
  };
}

function fakeInitiative(options: { duplicate?: boolean } = {}): ResearchInitiativeLike & { proposals: unknown[] } {
  const proposals: unknown[] = [];
  return {
    proposals,
    propose: async (input) => {
      if (options.duplicate) throw new Error("Initiative was suppressed as a duplicate of a recent notification.");
      proposals.push(input);
      return { id: `init-${proposals.length}` };
    },
  };
}

function htmlPage(body: string): FakePage {
  return { contentType: "text/html; charset=utf-8", body };
}

/** Build a minimal single-page PDF whose content stream shows `text`. */
function buildPdf(text: string, options: { flate?: boolean } = {}): Uint8Array {
  const content = `BT /F1 12 Tf (${text}) Tj ET`;
  const streamData = options.flate ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const dict = options.flate
    ? `<< /Filter /FlateDecode /Length ${streamData.length} >>`
    : `<< /Length ${streamData.length} >>`;
  const parts: Array<string | Buffer> = [
    "%PDF-1.4\n",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n",
    `4 0 obj ${dict} stream\n`,
    streamData,
    "\nendstream endobj\n",
    "trailer << /Root 1 0 R >>\n%%EOF\n",
  ];
  const total = parts.reduce((sum, part) => sum + (typeof part === "string" ? Buffer.byteLength(part) : part.length), 0);
  const out = Buffer.alloc(total);
  let offset = 0;
  for (const part of parts) {
    if (typeof part === "string") {
      out.write(part, offset, "latin1");
      offset += Buffer.byteLength(part);
    } else {
      part.copy(out, offset);
      offset += part.length;
    }
  }
  return new Uint8Array(out);
}

async function engine(deps: Partial<ConstructorParameters<typeof ResearchEngineService>[1]> = {}, now: () => number = () => Date.parse("2026-09-25T12:00:00Z")) {
  const root = await mkdtemp(join(tmpdir(), "haf-research-"));
  return new ResearchEngineService(root, { now, ...deps });
}

// ─── I1: real search backend ───

describe("research backend (P1.40)", () => {
  it("collects, fetches, extracts metadata and deduplicates web sources", async () => {
    const pages: Record<string, FakePage> = {
      "https://example.com/vectors": htmlPage(
        "<html><head><title>Vector databases explained</title>" +
        '<meta name="author" content="Ada Lovelace">' +
        '<meta property="article:published_time" content="2026-09-20T08:00:00Z">' +
        "</head><body><p>Vector databases store embeddings and support similarity search at scale. " +
        "Similarity search performance increase with approximate indexes.</p></body></html>",
      ),
      // A near-duplicate: same substance plus a two-token tail — different
      // SHA-256 digest, token overlap just over the similarity threshold.
      // Only the Jaccard check can catch this one.
      "https://mirror.example.net/vectors-copy": htmlPage(
        "<html><head><title>Vector databases explained</title></head><body>" +
        "<p>Vector databases store embeddings and support similarity search at scale. " +
        "Similarity search performance increase with approximate indexes. Mirror copy.</p></body></html>",
      ),
    };
    const fetcher = fakeFetcher(pages);
    const search = fakeWebSearch([
      { title: "Vector databases explained", url: "https://example.com/vectors", snippet: "Embeddings and similarity search." },
      { title: "Vector databases explained (tracking)", url: "https://example.com/vectors?utm_source=x", snippet: "Embeddings and similarity search." },
      { title: "Mirror copy", url: "https://mirror.example.net/vectors-copy", snippet: "Embeddings and similarity search." },
    ]);
    const service = await engine({ webSearch: search, fetcher });

    const result = await service.research("tenant", "vector databases similarity search", "web", { maxResults: 5 });

    // URL-twin and content-twin duplicates must both be dropped.
    expect(result.metadata.duplicatesDropped).toBe(2);
    expect(result.sources).toHaveLength(1);
    const source = result.sources[0]!;
    expect(source.url).toBe("https://example.com/vectors");
    expect(source.author).toBe("Ada Lovelace");
    expect(source.publishedAt).toBe("2026-09-20T08:00:00.000Z");
    expect(source.content).toContain("similarity search");
    expect(source.extractionNote).toContain("HTML fetched");
    expect(source.contentDigest).toBeTruthy();
    expect(source.relevanceScore).toBeGreaterThan(0);
    expect(source.freshnessScore).toBe(1); // 5 days old
    // The quoted citation was extracted from the fetched content.
    expect(source.citations.length).toBeGreaterThan(0);
  });

  it("refuses to invent sources when no search provider is configured", async () => {
    const service = await engine({});
    await expect(service.research("tenant", "anything", "web")).rejects.toThrow("Web search is not configured");
    await expect(service.research("tenant", "anything", "hybrid")).rejects.toThrow("Web search is not configured");
  });

  it("keeps fetch-failed sources with an honest note instead of dropping them silently", async () => {
    const fetcher = fakeFetcher({}); // every URL 404s
    const search = fakeWebSearch([
      { title: "Only snippet", url: "https://example.com/only", snippet: "The search snippet is all we have." },
    ]);
    const service = await engine({ webSearch: search, fetcher });
    const result = await service.research("tenant", "snippet only", "web");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.extractionNote).toContain("fetch failed");
    expect(result.sources[0]!.content).toBeUndefined();
    expect(result.metadata.fetchFailures).toBe(1);
  });

  it("applies the date-range filter to known dates and keeps unknown dates visible", async () => {
    const pages: Record<string, FakePage> = {
      "https://example.com/new": htmlPage('<meta property="article:published_time" content="2026-09-24T00:00:00Z"><p>Fresh content about topic alpha.</p>'),
      "https://example.com/old": htmlPage('<meta property="article:published_time" content="2020-01-01T00:00:00Z"><p>Stale content about topic alpha.</p>'),
      "https://example.com/nodate": htmlPage("<p>Undated content about topic alpha.</p>"),
    };
    const search = fakeWebSearch([
      { title: "New", url: "https://example.com/new", snippet: "alpha" },
      { title: "Old", url: "https://example.com/old", snippet: "alpha" },
      { title: "No date", url: "https://example.com/nodate", snippet: "alpha" },
    ]);
    const service = await engine({ webSearch: search, fetcher: fakeFetcher(pages) });
    const result = await service.research("tenant", "topic alpha", "web", {
      maxResults: 10,
      dateRange: { from: "2026-01-01T00:00:00.000Z" },
    });
    const urls = result.sources.map((source) => source.url).sort();
    expect(urls).toEqual(["https://example.com/new", "https://example.com/nodate"]);
  });
});

// ─── PDF parsing (P1.40) ───

describe("PDF text extraction (P1.40)", () => {
  it("extracts text from an uncompressed content stream", () => {
    const extraction = extractPdfText(buildPdf("Hello PDF text extraction world."));
    expect(extraction.extracted).toBe(true);
    expect(extraction.pages).toBe(1);
    expect(extraction.text).toContain("Hello PDF text extraction world.");
  });

  it("extracts text from FlateDecode-compressed content streams", () => {
    const extraction = extractPdfText(buildPdf("Compressed streams decompress into readable text.", { flate: true }));
    expect(extraction.extracted).toBe(true);
    expect(extraction.text).toContain("Compressed streams decompress into readable text.");
  });

  it("says so when the document is not a PDF or has no text layer", () => {
    expect(extractPdfText(new TextEncoder().encode("<html>not a pdf</html>")).reason).toBe("not a PDF document");
    const imageOnly = new TextEncoder().encode("%PDF-1.4\n4 0 obj << /Filter /DCTDecode /Length 3 >> stream\nabc\nendstream endobj\n%%EOF");
    const extraction = extractPdfText(imageOnly);
    expect(extraction.extracted).toBe(false);
    expect(extraction.reason).toContain("no extractable text layer");
  });

  it("extracts and cites PDF sources during research", async () => {
    const pdf = buildPdf("The benchmark throughput increase was measured on the new hardware.");
    const fetcher = fakeFetcher({ "https://example.com/paper.pdf": { contentType: "application/pdf", body: pdf } });
    const search = fakeWebSearch([{ title: "Benchmark paper", url: "https://example.com/paper.pdf", snippet: "Throughput benchmarks." }]);
    const service = await engine({ webSearch: search, fetcher });
    const result = await service.research("tenant", "benchmark throughput", "web");
    const source = result.sources[0]!;
    expect(source.extractionNote).toContain("PDF text extracted");
    expect(source.citations[0]!.text).toContain("throughput increase");
  });
});

// ─── I2: citation / provenance ───

describe("citation verification with quote/span/source relations (P1.41)", () => {
  it("verifies a quote as a span offset into the fetched content", async () => {
    const fetcher = fakeFetcher({
      "https://example.com/report": htmlPage("<p>The repository migration finished on schedule and reduced build times.</p>"),
    });
    const search = fakeWebSearch([{ title: "Report", url: "https://example.com/report", snippet: "Migration report." }]);
    const service = await engine({ webSearch: search, fetcher });
    const result = await service.research("tenant", "repository migration build times", "web");
    const source = result.sources[0]!;
    const citation = source.citations[0]!;
    expect(citation.verified).toBe(true);
    expect(citation.span).toBeTruthy();
    if (citation.span) {
      const normalized = source.content!.toLowerCase();
      expect(normalized.slice(citation.span.start, citation.span.end)).toBe(citation.text.toLowerCase());
    }
    expect(citation.contentDigest).toBe(source.contentDigest);
    const verdict = await service.verifyCitation(
      { id: "c", text: "a quote that appears nowhere in the document", sourceId: source.id, context: "", verified: false },
      source,
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain("not found");
  });

  it("source verification reports only what was actually checked", async () => {
    const fetcher = fakeFetcher({
      "https://example.com/checked": htmlPage('<meta name="author" content="Grace"><meta property="article:published_time" content="2026-09-01T00:00:00Z"><p>Checked content about topic beta.</p>'),
    });
    const search = fakeWebSearch([{ title: "Checked", url: "https://example.com/checked", snippet: "beta" }]);
    const service = await engine({ webSearch: search, fetcher });
    const result = await service.research("tenant", "topic beta", "web");
    const verification = await service.verifySource(result.sources[0]!);
    expect(verification.status).toBe("verified");
    expect(verification.evidence.join(" ")).toContain("fetched and hashed");
    expect(verification.evidence.join(" ")).toContain("publication date present");
  });

  it("detects contradictions between real source contents", async () => {
    const fetcher = fakeFetcher({
      "https://example.com/a": htmlPage("<p>Latency decrease was observed after the cache layer was added.</p>"),
      "https://example.com/b": htmlPage("<p>Latency increase was reported under heavy load instead.</p>"),
    });
    const search = fakeWebSearch([
      { title: "A", url: "https://example.com/a", snippet: "cache latency" },
      { title: "B", url: "https://example.com/b", snippet: "load latency" },
    ]);
    const service = await engine({ webSearch: search, fetcher });
    const result = await service.research("tenant", "latency cache load", "web");
    expect(result.contradictions.length).toBeGreaterThan(0);
    expect(result.contradictions[0]!.claimA.length).toBeGreaterThan(0);
  });
});

// ─── I3: report + remember ───

describe("research report and memory (P1.42)", () => {
  it("generates a citation-bound report with zero unsupported findings", async () => {
    const fetcher = fakeFetcher({
      "https://example.com/one": htmlPage("<p>The release train ships weekly and the rollback window is fifteen minutes.</p>"),
      "https://example.com/two": htmlPage("<p>Deployments are automated and the rollback window is fifteen minutes in total.</p>"),
    });
    const search = fakeWebSearch([
      { title: "One", url: "https://example.com/one", snippet: "release train" },
      { title: "Two", url: "https://example.com/two", snippet: "deployments" },
    ]);
    const service = await engine({ webSearch: search, fetcher });
    const result = await service.research("tenant", "release train rollback window", "web");
    const report = await service.generateReport(result.id, "Rollback window research");
    expect(report.title).toBe("Rollback window research");
    expect(report.metadata.quotedFindings).toBeGreaterThan(0);
    expect(report.metadata.unsupportedFindings).toBe(0);
    const findings = report.sections.find((section) => section.title === "Key Findings")!;
    // Every finding line cites a citation id that exists on the report.
    const cited = [...findings.content.matchAll(/\[(cite-[0-9a-f-]+)\]/g)].map((match) => match[1]!);
    expect(cited.length).toBe(report.metadata.quotedFindings);
    for (const id of cited) expect(report.citations.some((citation) => citation.id === id)).toBe(true);
    expect(report.resultId).toBe(result.id);
  });

  it("remembers results with citations as evidence refs and the top source as provenance", async () => {
    const fetcher = fakeFetcher({
      "https://example.com/trusted": htmlPage("<p>The protocol upgrade improved throughput by a measured margin.</p>"),
    });
    const search = fakeWebSearch([{ title: "Trusted", url: "https://example.com/trusted", snippet: "protocol" }]);
    const memory = fakeMemory();
    const service = await engine({ webSearch: search, fetcher, memory });
    const result = await service.research("tenant", "protocol upgrade throughput", "web");
    const remembered = await service.rememberResult("tenant", result.id);
    expect(remembered.citationCount).toBeGreaterThan(0);
    expect(memory.remembered).toHaveLength(1);
    const record = memory.remembered[0] as { sourceType: string; sourceId?: string; evidenceRefs: string[]; layer: string };
    expect(record.sourceType).toBe("external");
    expect(record.sourceId).toBe("https://example.com/trusted");
    expect(record.evidenceRefs!.length).toBeGreaterThan(0);
    expect(record.layer).toBe("semantic");
  });

  it("research with remember=true persists through the memory backend", async () => {
    const fetcher = fakeFetcher({ "https://example.com/x": htmlPage("<p>Content about remembered research topic.</p>") });
    const search = fakeWebSearch([{ title: "X", url: "https://example.com/x", snippet: "remembered" }]);
    const memory = fakeMemory();
    const service = await engine({ webSearch: search, fetcher, memory });
    await service.research("tenant", "remembered research topic", "web", {}, { remember: true });
    expect(memory.remembered).toHaveLength(1);
  });
});

// ─── I4: watchers ───

describe("research watchers (P1.43)", () => {
  async function watcherSetup(options: { duplicate?: boolean } = {}) {
    const pages: Record<string, FakePage> = {
      "https://example.com/project": htmlPage("<p>Version 1.0 of the watched project is available.</p>"),
    };
    const fetcher = fakeFetcher(pages);
    const initiative = fakeInitiative(options);
    let now = Date.parse("2026-09-25T12:00:00Z");
    const root = await mkdtemp(join(tmpdir(), "haf-research-watch-"));
    const service = new ResearchEngineService(root, {
      fetcher,
      initiative,
      now: () => now,
    });
    return {
      service,
      initiative,
      setPage: (next: string) => { pages["https://example.com/project"] = htmlPage(`<p>${next}</p>`); },
      advance: (minutes: number) => { now += minutes * 60_000; },
    };
  }

  it("records a baseline, then detects change, proposes an initiative, and skips until due", async () => {
    const setup = await watcherSetup();
    const watcher = await setup.service.addWatcher({
      tenantId: "tenant", kind: "project", name: "Watched project", targetUrl: "https://example.com/project", keywords: ["version"], intervalMinutes: 60,
    });

    const baseline = await setup.service.runWatchers("tenant");
    expect(baseline[0]!.status).toBe("baseline");
    expect(setup.initiative.proposals).toHaveLength(0);
    expect((await setup.service.watchers("tenant"))[0]!.changesDetected).toBe(0);

    // Not due yet → skipped without fetching.
    setup.advance(10);
    const skipped = await setup.service.runWatchers("tenant");
    expect(skipped[0]!.status).toBe("skipped");

    // Due again, content unchanged → honest "unchanged".
    setup.advance(60);
    const unchanged = await setup.service.runWatchers("tenant");
    expect(unchanged[0]!.status).toBe("unchanged");
    expect(setup.initiative.proposals).toHaveLength(0);

    // Content changed → change detected and an initiative proposed.
    setup.setPage("Version 2.0 of the watched project is available with new features.");
    setup.advance(60);
    const changed = await setup.service.runWatchers("tenant");
    expect(changed[0]!.status).toBe("changed");
    expect(changed[0]!.initiativeId).toBeTruthy();
    expect(setup.initiative.proposals).toHaveLength(1);
    const proposal = setup.initiative.proposals[0] as { kind: string; importance: number; watcherId?: string };
    expect(proposal.kind).toBe("insight");
    expect(proposal.importance).toBeGreaterThan(0.1);
    expect(proposal.watcherId).toBe(watcher.id);
    const stored = (await setup.service.watchers("tenant"))[0]!;
    expect(stored.changesDetected).toBe(1);
    expect(stored.lastChangeAt).toBeTruthy();
  });

  it("records duplicate suppression honestly when the initiative service dedups", async () => {
    const setup = await watcherSetup({ duplicate: true });
    await setup.service.addWatcher({ tenantId: "tenant", kind: "topic", name: "Repeated topic", targetUrl: "https://example.com/project" });
    await setup.service.runWatchers("tenant"); // baseline
    setup.setPage("Version 2.0 of the watched project is available with new features.");
    setup.advance(60);
    const outcome = await setup.service.runWatchers("tenant");
    expect(outcome[0]!.status).toBe("suppressed-duplicate");
    const stored = (await setup.service.watchers("tenant"))[0]!;
    expect(stored.suppressedDuplicates).toBe(1);
    expect(stored.changesDetected).toBe(1); // the change was real; only its delivery was suppressed
  });

  it("validates watcher input: one of query/targetUrl, https only, interval bounds", async () => {
    const service = await engine({ webSearch: fakeWebSearch([]) });
    await expect(service.addWatcher({ tenantId: "t", kind: "topic", name: "empty" })).rejects.toThrow("query or a targetUrl");
    await expect(service.addWatcher({ tenantId: "t", kind: "topic", name: "both", query: "a", targetUrl: "https://x.example" })).rejects.toThrow("not both");
    await expect(service.addWatcher({ tenantId: "t", kind: "topic", name: "http", targetUrl: "http://x.example" })).rejects.toThrow("https://");
    const watcher = await service.addWatcher({ tenantId: "t", kind: "topic", name: "clamped", query: "q", intervalMinutes: 1 });
    expect(watcher.intervalMinutes).toBe(5);
  });

  it("reports watcher errors (e.g. unconfigured search) instead of pretending", async () => {
    const service = await engine({});
    await service.addWatcher({ tenantId: "t", kind: "technology", name: "Tech", query: "rust" });
    const outcomes = await service.runWatchers("t");
    expect(outcomes[0]!.status).toBe("error");
    expect(outcomes[0]!.detail).toContain("Web search is not configured");
  });
});

// ─── Engine wiring: the capability surface is real, not just the service ───

describe("research and user-model wiring in the engine (P1.40–P1.48)", () => {
  async function newEngine() {
    const homePath = await mkdtemp(join(tmpdir(), "haf-research-engine-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: "",
      sandboxBackend: "local",
      model: { provider: "mock" },
      autoApproveWorkspaceWrites: true,
      allowProcessExecution: true,
    } as never);
    const session = await engine.createSession({ tenantId: "r-tenant", name: "research" });
    const snapshot = await engine.session(session.sessionId);
    const context = (suffix: string) => ({
      tenantId: "r-tenant",
      sessionId: session.sessionId,
      familyId: session.sessionId,
      turnId: `turn-${suffix}`,
      toolCallId: `call-${suffix}`,
      source: "api" as const,
      workspacePath: snapshot.workspacePath,
      idempotencyKey: `r-${suffix}-${randomUUID()}`,
    });
    return { engine, context, sessionId: session.sessionId };
  }

  async function approveResearchCall(engine: HybridAgentEngine, sessionId: string, match: string): Promise<void> {
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const pending = await engine.approvals.list(sessionId);
      const request = pending.find((item) => JSON.stringify(item).includes(match));
      if (request) {
        await engine.approvals.resolve(request.id, "approve_session");
        return;
      }
    }
    throw new Error(`No pending approval matched ${match}`);
  }

  it("registers the research and new user-model capabilities on the broker", async () => {
    const { engine } = await newEngine();
    const listed = engine.capabilities.list().map((capability) => capability.id);
    for (const id of [
      "research.query", "research.report", "research.remember",
      "research.watcher.add", "research.watcher.list", "research.watcher.remove", "research.watcher.run",
      "user.goals.conflicts", "user.goals.blocked",
      "user.project.upsert", "user.projects.list", "user.project.overview",
      "user.advice.policy", "user.privacy.set", "user.privacy.get", "user.privacy.apply-retention", "user.model.export",
    ]) {
      expect(listed, `missing capability ${id}`).toContain(id);
    }
  });

  it("runs research.query through the broker (internal scope, approval-gated network risk)", async () => {
    const { engine, context, sessionId } = await newEngine();
    const execution = engine.capabilities.execute("research.query", { question: "internal knowledge about the project", scope: "internal" }, context("internal"));
    await approveResearchCall(engine, sessionId, "research.query");
    const result = await execution;
    // No documents are indexed in a fresh engine — the honest answer is zero sources.
    expect(result.metadata.sourcesSelected).toBe(0);
    expect(result.metadata.webSearchConfigured).toBe(false);
  });

  it("refuses web research through the broker when no provider is configured", async () => {
    const { engine, context, sessionId } = await newEngine();
    const execution = engine.capabilities.execute("research.query", { question: "anything at all", scope: "web" }, context("web"));
    await approveResearchCall(engine, sessionId, "research.query");
    await expect(execution).rejects.toThrow("Web search is not configured");
  });

  it("wires the user-model integration without creating claims by default (inference off)", async () => {
    const { engine } = await newEngine();
    expect(engine.userModelIntegration).toBeTruthy();
    await engine.eventBus.emit("task.received", "test", { tenantId: "r-tenant", goal: "Some goal", userId: "u-default", taskId: "task-r1" });
    expect(await engine.userModel.claims("r-tenant", "u-default")).toHaveLength(0);
  });
});
