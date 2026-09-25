import { createHash } from "node:crypto";

/**
 * Source-extraction utilities for the research backend (P1.40):
 * HTML metadata extraction, URL/content deduplication keys, published-date
 * parsing and a freshness score. All functions are pure and measured — no
 * fabricated values: unknown stays unknown.
 */

export interface ExtractedSourceMetadata {
  title?: string;
  author?: string;
  publishedAt?: string;
  description?: string;
  siteName?: string;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/\s+/g, " ")
    .trim();
}

function attrValue(tag: string, attr: string): string | undefined {
  const pattern = new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = pattern.exec(tag);
  if (!match) return undefined;
  const value = match[2] ?? match[3] ?? match[4] ?? "";
  return value ? decodeEntities(value) : undefined;
}

/** Extract title/author/publishedAt/description/siteName from an HTML document head. */
export function extractHtmlMetadata(html: string): ExtractedSourceMetadata {
  const result: ExtractedSourceMetadata = {};
  const head = html.slice(0, 100_000);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  if (titleMatch?.[1]) {
    const title = decodeEntities(titleMatch[1]);
    if (title) result.title = title.slice(0, 500);
  }
  for (const metaTag of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = metaTag[0];
    const name = (attrValue(tag, "name") ?? attrValue(tag, "property") ?? "").toLowerCase();
    const content = attrValue(tag, "content");
    if (!content) continue;
    if (name === "author" && !result.author) result.author = content.slice(0, 300);
    else if ((name === "description" || name === "og:description") && !result.description) result.description = content.slice(0, 2000);
    else if ((name === "article:published_time" || name === "date" || name === "pubdate" || name === "og:updated_time") && !result.publishedAt) {
      const iso = parsePublishedAt(content);
      if (iso) result.publishedAt = iso;
    } else if (name === "og:site_name" && !result.siteName) result.siteName = content.slice(0, 200);
  }
  if (!result.publishedAt) {
    const timeMatch = /<time\b[^>]*datetime\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/i.exec(html.slice(0, 200_000));
    const datetime = timeMatch?.[2] ?? timeMatch?.[3];
    if (datetime) {
      const iso = parsePublishedAt(datetime);
      if (iso) result.publishedAt = iso;
    }
  }
  return result;
}

/**
 * Normalize a date-ish string to ISO-8601 when it is genuinely parseable.
 * Provider-relative strings such as "3 days ago" are intentionally rejected
 * (unknown stays unknown rather than being guessed).
 */
export function parsePublishedAt(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/i.test(value)) return undefined;
  const parsed = Date.parse(value.includes("T") ? value : value.replace(" ", "T"));
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref_src|igshid)$/i;

/** Canonical dedup key for a URL: scheme/host normalisation, tracking params and fragments dropped. */
export function normalizeUrlForDedup(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname === "") pathname = "/";
  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.test(key))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  return `${host}${pathname}${query}`;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** SHA-256 fingerprint of normalized text (first 40k chars) for content dedup. */
export function contentFingerprint(text: string): string {
  const normalized = normalizeWhitespace(text).slice(0, 40_000).toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

function tokenSet(text: string): Set<string> {
  return new Set(normalizeWhitespace(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((token) => token.length > 2));
}

/** Jaccard similarity of the token sets of two texts (0-1). */
export function tokenJaccard(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Freshness score (0-1). <=7 days old → 1.0; decays linearly to 0.2 at 180
 * days; older → 0.1; unknown publication date → 0.3 with the unknown made
 * explicit by the caller via `publishedAt === undefined`.
 */
export function freshnessScore(publishedAt: string | undefined, now: number): number {
  if (!publishedAt) return 0.3;
  const parsed = Date.parse(publishedAt);
  if (Number.isNaN(parsed)) return 0.3;
  const ageDays = Math.max(0, (now - parsed) / 86_400_000);
  if (ageDays <= 7) return 1;
  if (ageDays <= 180) return Math.round((1 - ((ageDays - 7) / 173) * 0.8) * 10_000) / 10_000;
  return 0.1;
}

/** Most relevant bounded excerpt of `content` for `query` (sentence windows ranked by token overlap). */
export function relevantExcerpt(content: string, query: string, maxChars = 1200): string {
  const normalized = normalizeWhitespace(content);
  if (normalized.length <= maxChars) return normalized;
  const queryTokens = tokenSet(query);
  const sentences = normalized.split(/(?<=[.!?])\s+(?=[A-ZÇĞİÖŞÜ0-9"“(\[])/);
  let best = "";
  let bestScore = -1;
  const window: string[] = [];
  let windowChars = 0;
  for (const sentence of sentences) {
    window.push(sentence);
    windowChars += sentence.length + 1;
    while (windowChars > maxChars && window.length > 1) {
      windowChars -= window[0]!.length + 1;
      window.shift();
    }
    const text = window.join(" ");
    const tokens = tokenSet(text);
    let overlap = 0;
    for (const token of queryTokens) if (tokens.has(token)) overlap++;
    const score = overlap / Math.sqrt(Math.max(1, tokens.size));
    if (score > bestScore) {
      bestScore = score;
      best = text;
    }
  }
  return best || normalized.slice(0, maxChars);
}
