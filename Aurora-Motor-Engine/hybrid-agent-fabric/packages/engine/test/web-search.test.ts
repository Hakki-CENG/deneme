import { afterEach, describe, expect, it, vi } from "vitest";
import { BraveSearchProvider, TavilySearchProvider, WebSearchService } from "../src/web/web-search.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("normalized web search providers", () => {
  it("keeps the Brave credential in a header and filters unsafe result URLs", async () => {
    let requestUrl = "";
    let headers: Headers;
    globalThis.fetch = vi.fn(async (input, init) => {
      requestUrl = String(input);
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify({
        web: { results: [
          { title: "Public result", url: "https://93.184.216.34/article", description: "Useful evidence" },
          { title: "Unsafe result", url: "http://127.0.0.1/admin", description: "internal" },
        ] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const search = new WebSearchService();
    search.register(new BraveSearchProvider({ apiKey: "brave-secret" }), true);
    const result = await search.search({ query: "hybrid agents", count: 5, freshness: "week" });
    expect(requestUrl).toContain("q=hybrid+agents");
    expect(requestUrl).toContain("freshness=pw");
    expect(requestUrl).not.toContain("brave-secret");
    expect(headers!.get("x-subscription-token")).toBe("brave-secret");
    expect(result.results).toEqual([{ title: "Public result", url: "https://93.184.216.34/article", snippet: "Useful evidence" }]);
    expect(result.droppedUnsafeUrls).toBe(1);
  });

  it("normalizes Tavily results without returning its server-side credential", async () => {
    let body: any;
    globalThis.fetch = vi.fn(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: [{
        title: "Tavily result",
        url: "https://93.184.216.34/tavily",
        content: "Grounded snippet",
        published_date: "2026-08-18",
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const service = new WebSearchService();
    service.register(new TavilySearchProvider({ apiKey: "tavily-secret" }), true);
    const result = await service.search({ query: "agent runtime", freshness: "month" });
    expect(body.api_key).toBe("tavily-secret");
    expect(body.days).toBe(31);
    expect(result.results[0]).toEqual(expect.objectContaining({ title: "Tavily result", publishedAt: "2026-08-18" }));
    expect(JSON.stringify(result)).not.toContain("tavily-secret");
  });

  it("bounds normalized fields and provider result count", async () => {
    const service = new WebSearchService(async (url) => new URL(url));
    service.register({
      id: "fake",
      async search() {
        return Array.from({ length: 30 }, (_, index) => ({
          title: `Result ${index} ${"x".repeat(1000)}`,
          url: `https://example.com/${index}`,
          snippet: "s".repeat(10_000),
        }));
      },
    }, true);
    const result = await service.search({ query: "bounded", count: 20 });
    expect(result.results).toHaveLength(20);
    expect(result.results[0]!.title.length).toBeLessThanOrEqual(500);
    expect(result.results[0]!.snippet.length).toBeLessThanOrEqual(4000);
  });
});
