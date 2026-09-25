import { assertSafeUrl } from "../capabilities/web.js";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface WebSearchProvider {
  readonly id: string;
  search(input: { query: string; count: number; freshness?: "day" | "week" | "month" | "year"; signal?: AbortSignal }): Promise<WebSearchResult[]>;
}

export interface BraveSearchProviderOptions {
  apiKey: string;
  baseUrl?: string;
  country?: string;
  language?: string;
}

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export class BraveSearchProvider implements WebSearchProvider {
  readonly id = "brave";
  constructor(private readonly options: BraveSearchProviderOptions) {}

  async search(input: { query: string; count: number; freshness?: "day" | "week" | "month" | "year"; signal?: AbortSignal }): Promise<WebSearchResult[]> {
    const endpoint = new URL((this.options.baseUrl ?? "https://api.search.brave.com/res/v1/web/search").replace(/\/$/, ""));
    endpoint.searchParams.set("q", input.query);
    endpoint.searchParams.set("count", String(input.count));
    endpoint.searchParams.set("safesearch", "moderate");
    if (this.options.country) endpoint.searchParams.set("country", this.options.country);
    if (this.options.language) endpoint.searchParams.set("search_lang", this.options.language);
    if (input.freshness) endpoint.searchParams.set("freshness", `p${input.freshness === "day" ? "d" : input.freshness === "week" ? "w" : input.freshness === "month" ? "m" : "y"}`);
    const response = await fetch(endpoint, {
      headers: {
        accept: "application/json",
        "x-subscription-token": this.options.apiKey,
        "user-agent": "HybridAgentFabric/1.2",
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok) throw new Error(`Brave Search returned HTTP ${response.status}.`);
    const body = await response.json() as any;
    const rows = Array.isArray(body?.web?.results) ? body.web.results : [];
    return rows.slice(0, input.count).map((row: any) => ({
      title: bounded(row.title, 500),
      url: bounded(row.url, 4000),
      snippet: bounded(row.description, 4000),
      ...(bounded(row.age ?? row.page_age, 100) ? { publishedAt: bounded(row.age ?? row.page_age, 100) } : {}),
    })).filter((row: WebSearchResult) => row.title && row.url);
  }
}

export interface TavilySearchProviderOptions {
  apiKey: string;
  baseUrl?: string;
  searchDepth?: "basic" | "advanced";
}

export class TavilySearchProvider implements WebSearchProvider {
  readonly id = "tavily";
  constructor(private readonly options: TavilySearchProviderOptions) {}

  async search(input: { query: string; count: number; freshness?: "day" | "week" | "month" | "year"; signal?: AbortSignal }): Promise<WebSearchResult[]> {
    const response = await fetch((this.options.baseUrl ?? "https://api.tavily.com/search").replace(/\/$/, ""), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: this.options.apiKey,
        query: input.query,
        max_results: input.count,
        search_depth: this.options.searchDepth ?? "basic",
        topic: "general",
        include_answer: false,
        include_raw_content: false,
        ...(input.freshness ? { days: input.freshness === "day" ? 1 : input.freshness === "week" ? 7 : input.freshness === "month" ? 31 : 365 } : {}),
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok) throw new Error(`Tavily Search returned HTTP ${response.status}.`);
    const body = await response.json() as any;
    const rows = Array.isArray(body?.results) ? body.results : [];
    return rows.slice(0, input.count).map((row: any) => ({
      title: bounded(row.title, 500),
      url: bounded(row.url, 4000),
      snippet: bounded(row.content, 4000),
      ...(bounded(row.published_date, 100) ? { publishedAt: bounded(row.published_date, 100) } : {}),
    })).filter((row: WebSearchResult) => row.title && row.url);
  }
}

export class WebSearchService {
  private readonly providers = new Map<string, WebSearchProvider>();
  private activeProviderId?: string;

  constructor(private readonly urlGuard: (url: string) => Promise<URL> = assertSafeUrl) {}

  register(provider: WebSearchProvider, makeActive = false): void {
    if (this.providers.has(provider.id)) throw new Error(`Web search provider ${provider.id} is already registered.`);
    this.providers.set(provider.id, provider);
    if (makeActive || !this.activeProviderId) this.activeProviderId = provider.id;
  }

  get configured(): boolean {
    return Boolean(this.activeProviderId);
  }

  list(): Array<{ id: string; active: boolean }> {
    return [...this.providers.keys()].map((id) => ({ id, active: id === this.activeProviderId }));
  }

  async search(input: {
    query: string;
    count?: number;
    providerId?: string;
    freshness?: "day" | "week" | "month" | "year";
    signal?: AbortSignal;
  }): Promise<{ provider: string; query: string; results: WebSearchResult[]; droppedUnsafeUrls: number }> {
    const query = input.query.trim();
    if (!query || query.length > 2000) throw new Error("Web search query must contain 1 to 2,000 characters.");
    const count = Math.min(20, Math.max(1, Math.floor(input.count ?? 8)));
    const providerId = input.providerId ?? this.activeProviderId;
    const provider = providerId ? this.providers.get(providerId) : undefined;
    if (!provider) throw new Error(`Web search provider ${providerId ?? "(default)"} is not configured.`);
    const raw = await provider.search({
      query,
      count,
      ...(input.freshness ? { freshness: input.freshness } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const results: WebSearchResult[] = [];
    let droppedUnsafeUrls = 0;
    for (const result of raw.slice(0, count)) {
      try {
        const url = await this.urlGuard(result.url);
        results.push({
          title: bounded(result.title, 500),
          url: url.toString(),
          snippet: bounded(result.snippet, 4000),
          ...(result.publishedAt ? { publishedAt: bounded(result.publishedAt, 100) } : {}),
        });
      } catch {
        droppedUnsafeUrls++;
      }
    }
    return { provider: provider.id, query, results, droppedUnsafeUrls };
  }
}
