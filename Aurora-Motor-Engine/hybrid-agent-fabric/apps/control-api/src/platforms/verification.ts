import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";

function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifySlackSignature(input: {
  rawBody: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  signingSecret: string;
  nowMs?: number;
}): boolean {
  if (!input.timestamp || !input.signature || !/^v0=[a-f0-9]{64}$/i.test(input.signature)) return false;
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs((input.nowMs ?? Date.now()) / 1000 - timestamp) > 300) return false;
  const expected = `v0=${createHmac("sha256", input.signingSecret).update(`v0:${input.timestamp}:`).update(input.rawBody).digest("hex")}`;
  return constantEqual(expected, input.signature);
}

export function verifyWhatsAppSignature(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  return constantEqual(expected, signature);
}

export function verifyDiscordSignature(input: {
  rawBody: Buffer;
  signature: string | undefined;
  timestamp: string | undefined;
  publicKeyHex: string;
}): boolean {
  if (!input.signature || !input.timestamp || !/^[a-f0-9]{128}$/i.test(input.signature) || !/^[a-f0-9]{64}$/i.test(input.publicKeyHex)) return false;
  try {
    // RFC 8410 Ed25519 SubjectPublicKeyInfo prefix followed by the 32-byte raw key.
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(input.publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.concat([Buffer.from(input.timestamp), input.rawBody]), key, Buffer.from(input.signature, "hex"));
  } catch {
    return false;
  }
}

export function verifySharedSecret(provided: string | undefined, expected: string | undefined): boolean {
  return Boolean(provided && expected && constantEqual(provided, expected));
}

export function allowlisted(value: string, csv: string | undefined): boolean {
  const values = new Set((csv ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  return values.size > 0 && values.has(value);
}

export function verifyLineSignature(rawBody: Buffer, signature: string | undefined, channelSecret: string): boolean {
  if (!signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = createHmac("sha256", channelSecret).update(rawBody).digest("base64");
  return constantEqual(expected, signature);
}

export function verifyFeishuSignature(input: {
  rawBody: Buffer;
  timestamp: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
  encryptKey: string;
  nowMs?: number;
}): boolean {
  if (!input.timestamp || !input.nonce || !input.signature || !/^[a-f0-9]{64}$/i.test(input.signature)) return false;
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs((input.nowMs ?? Date.now()) / 1000 - timestamp) > 300) return false;
  const expected = createHash("sha256")
    .update(input.timestamp)
    .update(input.nonce)
    .update(input.encryptKey)
    .update(input.rawBody)
    .digest("hex");
  return constantEqual(expected, input.signature.toLowerCase());
}

export interface PlatformJwtVerifierOptions {
  audience: string;
  issuers: string[];
  jwksUrl: string;
  fetch?: typeof fetch;
  cacheTtlMs?: number;
}

/** Exact-origin, bounded JWKS JWT verifier for Google Chat / Teams webhooks. */
export class PlatformJwtVerifier {
  private readonly fetchImpl: typeof fetch;
  private keys: { value: ReturnType<typeof createLocalJWKSet>; expiresAt: number } | undefined;
  private readonly jwks: URL;
  constructor(private readonly options: PlatformJwtVerifierOptions) {
    if (!options.audience.trim() || !options.issuers.length || options.issuers.some((item) => !item.trim())) throw new Error("Platform JWT audience/issuer configuration is invalid.");
    this.jwks = new URL(options.jwksUrl);
    if (this.jwks.protocol !== "https:" || this.jwks.username || this.jwks.password || this.jwks.hash) throw new Error("Platform JWKS URL must use credential-free HTTPS.");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  async verify(authorization: string | undefined): Promise<JWTPayload> {
    if (!authorization?.startsWith("Bearer ")) throw new Error("Platform bearer token is missing.");
    const token = authorization.slice(7).trim();
    if (!token || token.length > 32 * 1024) throw new Error("Platform bearer token is invalid.");
    const jwks = await this.getKeys();
    try {
      const verified = await jwtVerify(token, jwks, { audience: this.options.audience, issuer: this.options.issuers });
      return verified.payload;
    } catch {
      throw new Error("Platform bearer token verification failed.");
    }
  }
  private async getKeys(): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (this.keys && this.keys.expiresAt > Date.now()) return this.keys.value;
    const response = await this.fetchImpl(this.jwks, { method: "GET", redirect: "manual", headers: { accept: "application/json" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error("Platform JWKS redirects are forbidden.");
    if (!response.ok) throw new Error(`Platform JWKS request failed with HTTP ${response.status}.`);
    const text = await boundedResponse(response, 1024 * 1024);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("Platform JWKS returned invalid JSON."); }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).keys) || !(parsed as any).keys.length || (parsed as any).keys.length > 100) {
      throw new Error("Platform JWKS document is malformed.");
    }
    const value = createLocalJWKSet(parsed as any);
    this.keys = { value, expiresAt: Date.now() + Math.min(24 * 60 * 60_000, Math.max(60_000, this.options.cacheTtlMs ?? 60 * 60_000)) };
    return value;
  }
}

async function boundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = "", bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error("Platform JWKS response exceeds its safety bound."); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
