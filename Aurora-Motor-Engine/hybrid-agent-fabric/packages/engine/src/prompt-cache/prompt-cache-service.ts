import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentMessage, PromptCacheHint } from "../types.js";
import { DurableJsonState, auroraInteger, auroraText } from "../util/aurora-state.js";

/**
 * Prompt-cache breakpoints for Aurora — the round-four audit gap S5.
 *
 * Hermes ships `prompt_caching.py` (an Anthropic-style 4-breakpoint plan: end
 * of the static system prefix, end of the system prompt, last two non-system
 * messages), `prompt_cache_boundary.py` (builder-declared stable prefixes so a
 * breakpoint lands exactly at the volatile tail) and `prompt_cache_scope.py`
 * (rotation-stable logical cache scope, with forks/delegates kept isolated).
 * Aurora priced cache reads and wrote cache markers nowhere: a long session
 * paid full price for a prefix it had already sent, and nobody could say why.
 *
 * This service closes the same gap with Aurora's invariants:
 *
 * - **the plan is derived, not guessed.** From the assembled system prompt and
 *   the message list it labels each region stable or volatile: the system
 *   block, the conversation prefix (everything before the tail markers) and
 *   the message tail. Stability is a *digest comparison* against the previous
 *   plan for the session — the same freshness discipline diagnostics use.
 * - **`prefixHit` is honest.** A plan says the prefix would hit cache only
 *   when both stable regions are byte-identical to the previous request.
 *   Nothing is "likely" from vibes.
 * - **scope is explicit and documented.** Aurora compacts in place, so the
 *   physical session id is the correct cache scope; `/branch`/delegate
 *   children get their own id and therefore their own scope, exactly the
 *   isolation Hermes' `prompt_cache_scope` enforces for fork children.
 * - **evidence is durable and bounded.** Every plan is recorded with a
 *   sequence number (500 max), so "why did this request miss cache?" is
 *   answerable after the fact.
 *
 * The plan is consumed by providers that support explicit markers
 * (`AnthropicProvider`); providers with automatic caching (OpenAI-compatible,
 * Gemini) ignore the hint without any behavioral change.
 */

export const PROMPT_CACHE_TTLS_MS: readonly number[] = [300_000, 3_600_000];
export const DEFAULT_PROMPT_CACHE_TTL_MS = 300_000;
export const DEFAULT_MESSAGE_TAIL_MARKERS = 2;
export const MAX_MESSAGE_TAIL_MARKERS = 4;
export const MAX_CACHE_PLAN_RECORDS = 500;

export interface PromptCacheSegment {
  label: "system" | "conversation-prefix" | "message-tail";
  chars: number;
  stable: boolean;
  breakpointAtEnd: boolean;
  digest?: string;
}

export interface PromptCachePlanRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  scopeId: string;
  sequence: number;
  enabled: boolean;
  ttlMs: number;
  systemBreakpoint: boolean;
  toolBreakpoint: boolean;
  messageTailMarkers: number;
  messageCount: number;
  markerCount: number;
  stableChars: number;
  volatileChars: number;
  prefixHit: boolean;
  segments: PromptCacheSegment[];
  generatedAt: string;
}

export interface SessionCacheConfig {
  enabled: boolean;
  ttlMs: number;
}

interface CacheStateShape {
  schemaVersion: 1;
  sequence: number;
  plans: PromptCachePlanRecord[];
  config: Record<string, SessionCacheConfig>;
}

function isState(value: unknown): value is CacheStateShape {
  const candidate = value as CacheStateShape | undefined;
  return Boolean(candidate && candidate.schemaVersion === 1 && Array.isArray(candidate.plans) && typeof candidate.config === "object");
}

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function messageText(message: AgentMessage): string {
  return JSON.stringify(message.content);
}

export class PromptCacheService {
  private readonly state: DurableJsonState<CacheStateShape>;

  constructor(
    rootPath: string,
    private readonly options: { enabled?: boolean; ttlMs?: number; messageTailMarkers?: number } = {},
    private readonly now: () => number = Date.now,
  ) {
    this.state = new DurableJsonState<CacheStateShape>(
      resolve(rootPath, "prompt-cache", "plans.json"),
      () => ({ schemaVersion: 1, sequence: 0, plans: [], config: {} }),
      isState,
      "Prompt-cache state",
    );
  }

  private validTtl(value: number): number {
    return PROMPT_CACHE_TTLS_MS.includes(value) ? value : DEFAULT_PROMPT_CACHE_TTL_MS;
  }

  async config(tenantId: string, sessionId: string, input: { enabled?: boolean; ttlMs?: number }): Promise<SessionCacheConfig> {
    auroraText(tenantId, 200, "Tenant ID");
    auroraText(sessionId, 200, "Session ID");
    return await this.state.mutate((state) => {
      const current = state.config[sessionId] ?? { enabled: this.options.enabled ?? true, ttlMs: this.validTtl(this.options.ttlMs ?? DEFAULT_PROMPT_CACHE_TTL_MS) };
      const next: Partial<SessionCacheConfig> = {
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.ttlMs === undefined ? {} : { ttlMs: this.validTtl(input.ttlMs) }),
      };
      const merged = {
        enabled: next.enabled ?? current.enabled,
        ttlMs: next.ttlMs ?? current.ttlMs,
      };
      // A disabled session must not silently keep paying for markers: keep the
      // config so re-enabling restores it, but the effective value is off.
      state.config[sessionId] = merged;
      return structuredClone(merged);
    });
  }

  /** The effective per-session cache configuration. */
  async effectiveConfig(sessionId: string): Promise<SessionCacheConfig> {
    const state = await this.state.read();
    return structuredClone(state.config[sessionId] ?? {
      enabled: this.options.enabled ?? true,
      ttlMs: this.validTtl(this.options.ttlMs ?? DEFAULT_PROMPT_CACHE_TTL_MS),
    });
  }

  /**
   * Compute the cache plan for a request and record it as durable evidence.
   * Returns the plan record plus the provider hint (when enabled).
   */
  async plan(input: {
    tenantId: string;
    sessionId: string;
    systemPrompt: string;
    messages: AgentMessage[];
  }): Promise<{ plan: PromptCachePlanRecord; hint?: PromptCacheHint }> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const sessionId = auroraText(input.sessionId, 200, "Session ID");
    const state = await this.state.read();
    const config = state.config[sessionId] ?? {
      enabled: this.options.enabled ?? true,
      ttlMs: this.validTtl(this.options.ttlMs ?? DEFAULT_PROMPT_CACHE_TTL_MS),
    };
    const previous = state.plans.filter((plan) => plan.tenantId === tenantId && plan.sessionId === sessionId).sort((a, b) => b.sequence - a.sequence)[0];

    const enabled = config.enabled;
    const tailMarkers = auroraInteger(
      this.options.messageTailMarkers ?? DEFAULT_MESSAGE_TAIL_MARKERS,
      0,
      MAX_MESSAGE_TAIL_MARKERS,
      "Message tail markers",
    );
    const systemDigest = digestOf(input.systemPrompt);
    const nonSystem = input.messages.filter((message) => message.role !== "system");
    const tail = nonSystem.slice(Math.max(0, nonSystem.length - (enabled ? tailMarkers : 0)));
    const prefix = nonSystem.slice(0, Math.max(0, nonSystem.length - tail.length));
    const prefixDigest = digestOf(prefix.map(messageText).join("\n---\n"));
    const systemStable = previous?.segments.find((segment) => segment.label === "system")?.digest === systemDigest;
    const prefixStable = previous?.segments.find((segment) => segment.label === "conversation-prefix")?.digest === prefixDigest;
    const systemChars = input.systemPrompt.length;
    const prefixChars = prefix.reduce((sum, message) => sum + messageText(message).length, 0);
    const tailChars = tail.reduce((sum, message) => sum + messageText(message).length, 0);

    const segments: PromptCacheSegment[] = [
      {
        label: "system",
        chars: systemChars,
        stable: systemStable,
        breakpointAtEnd: enabled,
        digest: systemDigest,
      },
      {
        label: "conversation-prefix",
        chars: prefixChars,
        stable: prefixStable,
        breakpointAtEnd: false,
        // Always present: an empty prefix is still a stable region, and a
        // missing digest must not masquerade as "changed".
        digest: prefixDigest,
      },
      {
        label: "message-tail",
        chars: tailChars,
        stable: false,
        breakpointAtEnd: enabled && tail.length > 0,
      },
    ];
    const markerCount = enabled ? 2 + (tailMarkers > 0 ? tail.length : 0) : 0;

    return await this.state.mutate((state) => {
      state.sequence += 1;
      const plan: PromptCachePlanRecord = {
        id: `cache-plan-${randomUUID()}`,
        tenantId,
        sessionId,
        // Aurora compacts in place; branch/delegate children own this id, so
        // scope isolation is per physical session by construction.
        scopeId: sessionId,
        sequence: state.sequence,
        enabled,
        ttlMs: config.ttlMs,
        systemBreakpoint: enabled,
        toolBreakpoint: enabled,
        messageTailMarkers: enabled ? tailMarkers : 0,
        messageCount: nonSystem.length,
        markerCount,
        stableChars: systemChars + prefixChars,
        volatileChars: tailChars,
        prefixHit: enabled && systemStable && prefixStable,
        segments,
        generatedAt: new Date(this.now()).toISOString(),
      };
      state.plans.push(plan);
      if (state.plans.length > MAX_CACHE_PLAN_RECORDS) state.plans.splice(0, state.plans.length - MAX_CACHE_PLAN_RECORDS);
      const hint: PromptCacheHint | undefined = enabled
        ? {
            planId: plan.id,
            scopeId: plan.scopeId,
            ttlMs: plan.ttlMs,
            systemBreakpoint: plan.systemBreakpoint,
            toolBreakpoint: plan.toolBreakpoint,
            messageTailMarkers: tailMarkers,
          }
        : undefined;
      return { plan: structuredClone(plan), ...(hint ? { hint } : {}) };
    });
  }

  async latest(tenantId: string, sessionId: string): Promise<{ plan?: PromptCachePlanRecord; config: SessionCacheConfig; message: string }> {
    const state = await this.state.read();
    const plan = state.plans
      .filter((item) => item.tenantId === tenantId && item.sessionId === sessionId)
      .sort((a, b) => b.sequence - a.sequence)[0];
    const config = structuredClone(state.config[sessionId] ?? {
      enabled: this.options.enabled ?? true,
      ttlMs: this.validTtl(this.options.ttlMs ?? DEFAULT_PROMPT_CACHE_TTL_MS),
    });
    if (!plan) {
      return { config, message: "No cache plan has been computed for this session yet." };
    }
    return {
      plan: structuredClone(plan),
      config,
      // The configuration is the effective state; the plan records what the
      // request actually shipped, so a config change made after a request is
      // reported honestly instead of being hidden behind the older plan.
      message: !config.enabled
        ? "Prompt caching is disabled for this session."
        : !plan.enabled
          ? "Prompt caching is enabled; the latest plan predates that change."
          : plan.prefixHit
            ? `Prefix ${plan.stableChars} chars stable · ${plan.markerCount} markers · cache hit expected.`
            : `Prefix changed (${plan.stableChars} chars stable) · ${plan.markerCount} markers · cache miss this request.`,
    };
  }

  async list(filter: { tenantId: string; sessionId?: string | undefined; limit?: number | undefined }): Promise<PromptCachePlanRecord[]> {
    const state = await this.state.read();
    return state.plans
      .filter((plan) => plan.tenantId === filter.tenantId)
      .filter((plan) => (filter.sessionId ? plan.sessionId === filter.sessionId : true))
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, auroraInteger(filter.limit ?? 10, 1, MAX_CACHE_PLAN_RECORDS, "Cache plan limit"))
      .map((plan) => structuredClone(plan));
  }
}
