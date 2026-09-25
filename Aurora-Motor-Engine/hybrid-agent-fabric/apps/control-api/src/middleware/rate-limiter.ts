/**
 * Rate Limiting Middleware
 * Token bucket + sliding window rate limiter for API endpoints.
 * Supports per-IP, per-user, and per-endpoint rate limits.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export interface RateLimitConfig {
  /** Maximum requests per window */
  max: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Key generator (defaults to IP-based) */
  keyGenerator?: (request: FastifyRequest) => string;
  /** Custom error message */
  message?: string;
  /** Skip rate limiting for certain conditions */
  skip?: (request: FastifyRequest) => boolean;
  /** Headers to include in response */
  headers?: boolean;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillRate: number; // tokens per ms
}

interface SlidingWindowEntry {
  timestamps: number[];
}

const DEFAULT_CONFIG: RateLimitConfig = {
  max: 100,
  windowMs: 60_000, // 1 minute
  message: "Too many requests, please try again later.",
  headers: true,
};

// In-memory stores (production'da Redis kullanılmalı)
const tokenBuckets = new Map<string, TokenBucket>();
const slidingWindows = new Map<string, SlidingWindowEntry>();

// Cleanup interval - eski entry'leri temizle
const CLEANUP_INTERVAL = 5 * 60_000; // 5 minutes
let lastCleanup = Date.now();

function cleanupStores() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;

  for (const [key, bucket] of tokenBuckets) {
    if (now - bucket.lastRefill > CLEANUP_INTERVAL) {
      tokenBuckets.delete(key);
    }
  }
  for (const [key, entry] of slidingWindows) {
    const recent = entry.timestamps.filter((t) => now - t < CLEANUP_INTERVAL);
    if (recent.length === 0) {
      slidingWindows.delete(key);
    } else {
      entry.timestamps = recent;
    }
  }
}

/** Whether to trust X-Forwarded-For header — set to true ONLY behind a trusted reverse proxy */
const TRUST_PROXY = process.env.TRUST_PROXY === "true";

function getClientIp(request: FastifyRequest): string {
  // Only trust forwarded headers when explicitly configured (behind a trusted proxy)
  if (TRUST_PROXY) {
    const forwarded = request.headers["x-forwarded-for"];
    if (forwarded) {
      const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0]?.trim();
      if (ip) return ip;
    }
  }
  return request.ip || "unknown";
}

function consumeToken(key: string, config: RateLimitConfig): { allowed: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  let bucket = tokenBuckets.get(key);

  if (!bucket) {
    bucket = {
      tokens: config.max,
      lastRefill: now,
      maxTokens: config.max,
      refillRate: config.max / config.windowMs,
    };
    tokenBuckets.set(key, bucket);
  }

  // Refill tokens
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRate);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    const resetMs = Math.ceil((1 - bucket.tokens) / bucket.refillRate);
    return { allowed: false, remaining: 0, resetMs };
  }

  bucket.tokens -= 1;
  const resetMs = Math.ceil((bucket.maxTokens - bucket.tokens) / bucket.refillRate);
  return { allowed: true, remaining: Math.floor(bucket.tokens), resetMs };
}

function checkSlidingWindow(key: string, config: RateLimitConfig): { allowed: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  let entry = slidingWindows.get(key);

  if (!entry) {
    entry = { timestamps: [] };
    slidingWindows.set(key, entry);
  }

  // Remove timestamps outside the window
  entry.timestamps = entry.timestamps.filter((t) => now - t < config.windowMs);

  if (entry.timestamps.length >= config.max) {
    const oldestInWindow = entry.timestamps[0]!;
    const resetMs = oldestInWindow + config.windowMs - now;
    return { allowed: false, remaining: 0, resetMs };
  }

  entry.timestamps.push(now);
  const remaining = config.max - entry.timestamps.length;
  const resetMs = config.windowMs;
  return { allowed: true, remaining, resetMs };
}

export function createRateLimiter(config: Partial<RateLimitConfig> = {}) {
  const merged = { ...DEFAULT_CONFIG, ...config };
  const keyGen = merged.keyGenerator ?? getClientIp;

  return async function rateLimitHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (merged.skip?.(request)) return;

    cleanupStores();

    const key = keyGen(request);
    const result = consumeToken(key, merged);

    if (merged.headers) {
      reply.header("X-RateLimit-Limit", merged.max);
      reply.header("X-RateLimit-Remaining", result.remaining);
      reply.header("X-RateLimit-Reset", Math.ceil(Date.now() + result.resetMs));
    }

    if (!result.allowed) {
      reply.header("Retry-After", Math.ceil(result.resetMs / 1000));
      await reply.code(429).send({
        error: "rate_limit_exceeded",
        message: merged.message,
        retryAfter: Math.ceil(result.resetMs / 1000),
      });
    }
  };
}

/**
 * Endpoint-specific rate limit presets
 */
export const RateLimitPresets = {
  /** General API - 100 req/min */
  general: { max: 100, windowMs: 60_000 },
  /** Chat/AI endpoints - 30 req/min (more expensive) */
  chat: { max: 30, windowMs: 60_000 },
  /** Auth endpoints - 10 req/min (brute force protection) */
  auth: { max: 10, windowMs: 60_000 },
  /** File upload - 20 req/min */
  upload: { max: 20, windowMs: 60_000 },
  /** Webhook endpoints - 200 req/min (high throughput) */
  webhook: { max: 200, windowMs: 60_000 },
  /** Platform webhooks - 500 req/min */
  platformWebhook: { max: 500, windowMs: 60_000 },
} as const;

/**
 * Register rate limiting on a Fastify instance
 */
export async function registerRateLimiting(app: FastifyInstance): Promise<void> {
  // Global rate limit
  app.addHook("onRequest", createRateLimiter(RateLimitPresets.general));
}
