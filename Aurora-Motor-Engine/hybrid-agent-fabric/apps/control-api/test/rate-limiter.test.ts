/**
 * Rate Limiter Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRateLimiter, RateLimitPresets } from "../src/middleware/rate-limiter.js";

describe("Rate Limiter", () => {
  it("should create rate limiter with default config", () => {
    const limiter = createRateLimiter();
    expect(limiter).toBeInstanceOf(Function);
  });

  it("should create rate limiter with custom config", () => {
    const limiter = createRateLimiter({
      max: 50,
      windowMs: 30000,
    });
    expect(limiter).toBeInstanceOf(Function);
  });

  it("should have correct presets", () => {
    expect(RateLimitPresets.general.max).toBe(100);
    expect(RateLimitPresets.chat.max).toBe(30);
    expect(RateLimitPresets.auth.max).toBe(10);
    expect(RateLimitPresets.webhook.max).toBe(200);
    expect(RateLimitPresets.platformWebhook.max).toBe(500);
  });

  it("should have correct window durations", () => {
    expect(RateLimitPresets.general.windowMs).toBe(60000);
    expect(RateLimitPresets.chat.windowMs).toBe(60000);
    expect(RateLimitPresets.auth.windowMs).toBe(60000);
  });
});
