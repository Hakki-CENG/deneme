import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { defineCapability } from "./schema.js";

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
    a >= 224;
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
}

export async function assertSafeUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) URLs are allowed.");
  if (url.username || url.password) throw new Error("URLs containing credentials are forbidden.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (["localhost", "localhost.localdomain"].includes(hostname.toLowerCase()) || hostname.endsWith(".localhost")) {
    throw new Error("Loopback destinations are forbidden.");
  }
  const literal = isIP(hostname);
  const addresses = literal ? [{ address: hostname, family: literal }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("URL hostname did not resolve.");
  for (const item of addresses) {
    if ((item.family === 4 && privateIpv4(item.address)) || (item.family === 6 && privateIpv6(item.address))) {
      throw new Error(`Private or special-use destination is forbidden (${item.address}).`);
    }
  }
  return url;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export interface PublicDocument {
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType: string;
  bytes: Uint8Array;
  decoded: string;
  truncated: boolean;
}

/**
 * Fetch one bounded public HTTP(S) document with the same redirect and
 * private-network checks `web.fetch` applies. Shared with the research
 * collector so both paths enforce one security contract (P1.40).
 */
export async function fetchPublicDocument(
  rawUrl: string,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<PublicDocument> {
  const maxBytes = Math.min(5_000_000, Math.max(1, options.maxBytes ?? 1_000_000));
  let url = await assertSafeUrl(rawUrl);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 5; redirect++) {
    response = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": "HybridAgentFabric/0.2 (+https://localhost)" },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw new Error("Redirect response omitted Location.");
    if (redirect === 5) throw new Error("Too many redirects.");
    url = await assertSafeUrl(new URL(location, url).toString());
  }
  if (!response) throw new Error("No response received.");
  const { bytes, truncated } = await readBoundedBody(response, maxBytes);
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return { finalUrl: url.toString(), status: response.status, ok: response.ok, contentType, bytes, decoded, truncated };
}

export async function readBoundedBody(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - size;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    const chunk = value.length > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    size += chunk.length;
    if (value.length > remaining) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: output, truncated };
}

export function webCapabilities() {
  return [
    defineCapability(
      {
        id: "web.fetch",
        version: "1.0.0",
        description: "Fetch bounded public HTTP(S) content with private-network and redirect SSRF checks.",
        risk: "network",
        sideEffect: false,
        source: "core",
      },
      z.object({
        url: z.string().url(),
        maxBytes: z.number().int().positive().max(5_000_000).optional(),
        format: z.enum(["text", "raw"]).default("text"),
      }),
      async ({ url: rawUrl, maxBytes = 1_000_000, format }, context) => {
        const document = await fetchPublicDocument(rawUrl, {
          maxBytes,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        const contentType = document.contentType;
        const content = format === "text" && contentType.includes("html") ? htmlToText(document.decoded) : document.decoded;
        return {
          finalUrl: document.finalUrl,
          status: document.status,
          ok: document.ok,
          contentType,
          content,
          bytes: document.bytes.length,
          truncated: document.truncated,
        };
      },
    ),
  ];
}
