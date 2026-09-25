import { createHash, randomUUID } from "node:crypto";
import type { CredentialBrokerLike } from "../security/credential-broker.js";

const AUTH_ORIGIN = "https://auth.openai.com";
const DEVICE_CODE_URL = `${AUTH_ORIGIN}/api/accounts/deviceauth/usercode`;
const DEVICE_POLL_URL = `${AUTH_ORIGIN}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${AUTH_ORIGIN}/oauth/token`;
const VERIFICATION_URL = `${AUTH_ORIGIN}/codex/device`;
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const INTERNAL_CAPABILITY = "model.codex.oauth";
const INTERNAL_AUDIENCE = "haf-internal:codex-oauth";

interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: "Bearer";
}
interface PendingDeviceFlow {
  flowId: string;
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  nextPollAt: number;
  expiresAt: number;
  createdAt: number;
}
interface CodexOAuthState {
  schemaVersion: 1;
  tokens?: CodexTokens;
  pending?: PendingDeviceFlow;
  cooldownUntil?: number;
  lastErrorCode?: string;
  updatedAt: string;
}

export interface CodexDeviceFlowStart {
  flowId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  intervalMs: number;
  restartResumable: boolean;
}
export interface CodexDeviceFlowPoll {
  status: "pending" | "authenticated";
  retryAfterMs?: number;
  expiresAt?: string;
}
export interface CodexAuthorization {
  accessToken: string;
  accountId?: string;
  expiresAt: number;
}
export interface CodexOAuthStatus {
  authenticated: boolean;
  pending: boolean;
  expiresAt?: string;
  cooldownUntil?: string;
  accountProjection?: string;
  lastErrorCode?: string;
  persistentAcrossRestart: boolean;
}

export class CodexOAuthError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly reloginRequired = false) {
    super(message);
    this.name = "CodexOAuthError";
  }
}

export interface CodexOAuthManagerOptions {
  broker: CredentialBrokerLike;
  fetch?: typeof fetch;
  clientId?: string;
  userAgent?: string;
}

/** Broker-encrypted OpenAI Codex device OAuth with refresh-token rotation. */
export class CodexOAuthManager {
  private readonly fetchImpl: typeof fetch;
  private readonly clientId: string;
  private readonly userAgent: string;
  private readonly cache = new Map<string, CodexOAuthState>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly options: CodexOAuthManagerOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.clientId = options.clientId ?? CODEX_OAUTH_CLIENT_ID;
    this.userAgent = options.userAgent ?? "hybrid-agent-fabric/1.38";
  }

  async startDeviceFlow(tenantId: string): Promise<CodexDeviceFlowStart> {
    return await this.withLock(tenantId, async () => {
      const response = await this.request(DEVICE_CODE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: this.clientId }),
      }, 15_000);
      if (response.status === 429) throw new CodexOAuthError("rate_limited", "OpenAI is temporarily rate-limiting Codex login requests.", true);
      if (!response.ok) throw new CodexOAuthError("device_code_request_failed", "Codex device authorization could not be started.", response.status >= 500);
      const value = await boundedJson(response, 64 * 1024);
      const userCode = requiredString(value.user_code, 200, "user_code");
      const deviceAuthId = requiredString(value.device_auth_id, 2_000, "device_auth_id");
      const intervalMs = Math.min(30_000, Math.max(3_000, Number(value.interval ?? 5) * 1_000));
      const expiresIn = Math.min(15 * 60, Math.max(60, Number(value.expires_in ?? 15 * 60)));
      const now = Date.now();
      const pending: PendingDeviceFlow = {
        flowId: randomUUID(),
        deviceAuthId,
        userCode,
        intervalMs,
        nextPollAt: now,
        expiresAt: now + expiresIn * 1_000,
        createdAt: now,
      };
      const state = await this.load(tenantId);
      state.pending = pending;
      delete state.lastErrorCode;
      await this.save(tenantId, state);
      return {
        flowId: pending.flowId,
        userCode,
        verificationUrl: VERIFICATION_URL,
        expiresAt: new Date(pending.expiresAt).toISOString(),
        intervalMs,
        restartResumable: this.options.broker.persistentAcrossRestart,
      };
    });
  }

  async pollDeviceFlow(tenantId: string, flowId: string): Promise<CodexDeviceFlowPoll> {
    return await this.withLock(tenantId, async () => {
      const state = await this.load(tenantId, true);
      const pending = state.pending;
      if (!pending || pending.flowId !== flowId) throw new CodexOAuthError("flow_missing", "Codex device authorization is missing or expired.");
      const now = Date.now();
      if (pending.expiresAt <= now) {
        delete state.pending;
        state.lastErrorCode = "device_code_expired";
        await this.save(tenantId, state);
        throw new CodexOAuthError("device_code_expired", "Codex device authorization expired.");
      }
      if (pending.nextPollAt > now) return {
        status: "pending",
        retryAfterMs: pending.nextPollAt - now,
        expiresAt: new Date(pending.expiresAt).toISOString(),
      };
      pending.nextPollAt = now + pending.intervalMs;
      await this.save(tenantId, state);
      const poll = await this.request(DEVICE_POLL_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode }),
      }, 15_000);
      if (poll.status === 403 || poll.status === 404) return {
        status: "pending",
        retryAfterMs: pending.intervalMs,
        expiresAt: new Date(pending.expiresAt).toISOString(),
      };
      if (poll.status === 429) throw new CodexOAuthError("rate_limited", "OpenAI is temporarily rate-limiting Codex device polling.", true);
      if (!poll.ok) {
        delete state.pending;
        state.lastErrorCode = "device_poll_failed";
        await this.save(tenantId, state);
        throw new CodexOAuthError("device_poll_failed", "Codex device authorization polling failed.", poll.status >= 500);
      }
      const codeValue = await boundedJson(poll, 64 * 1024);
      const authorizationCode = requiredString(codeValue.authorization_code, 8_192, "authorization_code");
      const codeVerifier = requiredString(codeValue.code_verifier, 8_192, "code_verifier");
      const tokens = await this.exchangeAuthorizationCode(authorizationCode, codeVerifier);
      state.tokens = tokens;
      delete state.pending;
      delete state.cooldownUntil;
      delete state.lastErrorCode;
      await this.save(tenantId, state);
      return { status: "authenticated" };
    });
  }

  async getAuthorization(tenantId: string): Promise<CodexAuthorization> {
    return await this.withLock(tenantId, async () => {
      const state = await this.load(tenantId, true);
      if (state.cooldownUntil && state.cooldownUntil > Date.now()) {
        throw new CodexOAuthError("rate_limited", "Codex credentials are cooling down after an upstream rate limit.", true);
      }
      let tokens = state.tokens;
      if (!tokens) throw new CodexOAuthError("not_authenticated", "Codex subscription authentication is required.", false, true);
      if (tokens.expiresAt <= Date.now() + 120_000) {
        tokens = await this.refresh(tenantId, state, tokens);
      }
      const claims = decodeJwt(tokens.accessToken);
      const accountId = accountIdFromClaims(claims);
      return { accessToken: tokens.accessToken, ...(accountId ? { accountId } : {}), expiresAt: tokens.expiresAt };
    });
  }

  async forceRefreshAuthorization(tenantId: string): Promise<CodexAuthorization> {
    return await this.withLock(tenantId, async () => {
      const state = await this.load(tenantId, true);
      if (!state.tokens) throw new CodexOAuthError("not_authenticated", "Codex subscription authentication is required.", false, true);
      const tokens = await this.refresh(tenantId, state, state.tokens);
      const accountId = accountIdFromClaims(decodeJwt(tokens.accessToken));
      return { accessToken: tokens.accessToken, ...(accountId ? { accountId } : {}), expiresAt: tokens.expiresAt };
    });
  }

  async listModels(tenantId: string): Promise<string[]> {
    let authorization = await this.getAuthorization(tenantId);
    let response = await this.codexRequest(authorization, 10_000);
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      authorization = await this.forceRefreshAuthorization(tenantId);
      response = await this.codexRequest(authorization, 10_000);
    }
    if (response.status === 429) {
      await this.noteRateLimit(tenantId, retryAfterMs(response.headers.get("retry-after")));
      throw new CodexOAuthError("rate_limited", "Codex model catalog is rate limited.", true);
    }
    if (!response.ok) throw new CodexOAuthError("catalog_failed", "Codex model catalog request failed.", response.status >= 500, response.status === 401 || response.status === 403);
    const value = await boundedJson(response, 2 * 1024 * 1024);
    const entries = Array.isArray(value.models) ? value.models : [];
    const models = entries
      .filter((item): item is Record<string, any> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .filter((item) => !(typeof item.visibility === "string" && ["hide", "hidden"].includes(item.visibility.trim().toLowerCase())))
      .filter((item) => typeof item.slug === "string" && item.slug.trim().length > 0 && item.slug.length <= 300)
      .map((item) => ({ slug: String(item.slug).trim(), priority: typeof item.priority === "number" ? item.priority : 10_000 }))
      .sort((left, right) => left.priority - right.priority || left.slug.localeCompare(right.slug))
      .slice(0, 500)
      .map((item) => item.slug);
    return [...new Set(models)];
  }

  async status(tenantId: string): Promise<CodexOAuthStatus> {
    const state = await this.load(tenantId, true);
    const accountId = state.tokens ? accountIdFromClaims(decodeJwt(state.tokens.accessToken)) : undefined;
    return {
      authenticated: Boolean(state.tokens),
      pending: Boolean(state.pending && state.pending.expiresAt > Date.now()),
      ...(state.tokens ? { expiresAt: new Date(state.tokens.expiresAt).toISOString() } : {}),
      ...(state.cooldownUntil && state.cooldownUntil > Date.now() ? { cooldownUntil: new Date(state.cooldownUntil).toISOString() } : {}),
      ...(accountId ? { accountProjection: createHash("sha256").update(accountId).digest("hex").slice(0, 16) } : {}),
      ...(state.lastErrorCode ? { lastErrorCode: state.lastErrorCode } : {}),
      persistentAcrossRestart: this.options.broker.persistentAcrossRestart,
    };
  }

  async logout(tenantId: string): Promise<void> {
    await this.withLock(tenantId, async () => {
      const state = await this.load(tenantId, true);
      delete state.tokens;
      delete state.pending;
      delete state.cooldownUntil;
      delete state.lastErrorCode;
      await this.save(tenantId, state);
    });
  }

  async noteRateLimit(tenantId: string, retryAfterMs?: number): Promise<void> {
    await this.withLock(tenantId, async () => {
      const state = await this.load(tenantId, true);
      state.cooldownUntil = Date.now() + Math.min(24 * 60 * 60_000, Math.max(30_000, retryAfterMs ?? 60_000));
      state.lastErrorCode = "rate_limited";
      await this.save(tenantId, state);
    });
  }

  private async exchangeAuthorizationCode(code: string, verifier: string): Promise<CodexTokens> {
    return await this.tokenRequest(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${AUTH_ORIGIN}/deviceauth/callback`,
      client_id: this.clientId,
      code_verifier: verifier,
    }));
  }

  private async refresh(tenantId: string, state: CodexOAuthState, current: CodexTokens): Promise<CodexTokens> {
    try {
      const tokens = await this.tokenRequest(new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: this.clientId,
      }), current.refreshToken);
      state.tokens = tokens;
      delete state.lastErrorCode;
      delete state.cooldownUntil;
      await this.save(tenantId, state);
      return tokens;
    } catch (error) {
      const oauth = error instanceof CodexOAuthError ? error : new CodexOAuthError("refresh_failed", "Codex token refresh failed.");
      state.lastErrorCode = oauth.code;
      if (oauth.code === "rate_limited") state.cooldownUntil = Date.now() + 60_000;
      if (oauth.reloginRequired) delete state.tokens;
      await this.save(tenantId, state);
      throw oauth;
    }
  }

  private async tokenRequest(form: URLSearchParams, previousRefreshToken?: string): Promise<CodexTokens> {
    const response = await this.request(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
    }, 20_000);
    if (response.status === 429) throw new CodexOAuthError("rate_limited", "Codex OAuth is rate limited; credentials remain valid.", true);
    if (!response.ok) {
      const relogin = response.status === 400 || response.status === 401 || response.status === 403;
      throw new CodexOAuthError(relogin ? "invalid_grant" : "token_request_failed", "Codex OAuth token request failed.", response.status >= 500, relogin);
    }
    const value = await boundedJson(response, 128 * 1024);
    const accessToken = requiredString(value.access_token, 128 * 1024, "access_token");
    const refreshToken = typeof value.refresh_token === "string" && value.refresh_token.trim()
      ? value.refresh_token.trim()
      : previousRefreshToken;
    if (!refreshToken) throw new CodexOAuthError("refresh_token_missing", "Codex OAuth response did not include a refresh token.", false, true);
    const jwtExpiry = jwtExpiryMs(accessToken);
    const expiresIn = Math.min(24 * 60 * 60, Math.max(60, Number(value.expires_in ?? 3_600)));
    return {
      accessToken,
      refreshToken,
      expiresAt: jwtExpiry ?? Date.now() + expiresIn * 1_000,
      tokenType: "Bearer",
    };
  }

  private async load(tenantId: string, force = false): Promise<CodexOAuthState> {
    if (!force) {
      const cached = this.cache.get(tenantId);
      if (cached) return cached;
    }
    const metadata = (await this.options.broker.list(tenantId)).find((item) => item.name === secretName(tenantId));
    if (!metadata) {
      const empty: CodexOAuthState = { schemaVersion: 1, updatedAt: new Date().toISOString() };
      this.cache.set(tenantId, empty);
      return empty;
    }
    const lease = await this.options.broker.issueLease({ tenantId, secretId: metadata.id, capabilityId: INTERNAL_CAPABILITY, audience: INTERNAL_AUDIENCE, ttlMs: 30_000, maxUses: 1 });
    const raw = await this.options.broker.redeemLease({ leaseId: lease.leaseId, tenantId, capabilityId: INTERNAL_CAPABILITY, audience: INTERNAL_AUDIENCE });
    if (Buffer.byteLength(raw) > 512 * 1024) throw new CodexOAuthError("state_invalid", "Encrypted Codex OAuth state exceeds its safety bound.");
    const state = validateState(JSON.parse(raw) as unknown);
    if (state.pending && state.pending.expiresAt <= Date.now()) delete state.pending;
    this.cache.set(tenantId, state);
    return state;
  }

  private async save(tenantId: string, state: CodexOAuthState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    const encoded = JSON.stringify(state);
    if (Buffer.byteLength(encoded) > 512 * 1024) throw new CodexOAuthError("state_invalid", "Codex OAuth state exceeds its safety bound.");
    await this.options.broker.put({ tenantId, name: secretName(tenantId), value: encoded, description: "Encrypted OpenAI Codex subscription OAuth state" });
    this.cache.set(tenantId, state);
  }

  private async codexRequest(auth: CodexAuthorization, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    try {
      const response = await this.fetchImpl("https://chatgpt.com/backend-api/codex/models?client_version=1.0.0", {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${auth.accessToken}`,
          "user-agent": "codex_cli_rs/0.0.0 (Hybrid Agent Fabric)",
          originator: "codex_cli_rs",
          ...(auth.accountId ? { "ChatGPT-Account-ID": auth.accountId } : {}),
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        throw new CodexOAuthError("redirect_forbidden", "Codex catalog redirects are forbidden.");
      }
      return response;
    } catch (error) {
      if (error instanceof CodexOAuthError) throw error;
      throw new CodexOAuthError("network_error", "Codex catalog network request failed.", true);
    } finally { clearTimeout(timeout); }
  }

  private async request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const target = new URL(url);
    if (target.origin !== AUTH_ORIGIN) throw new CodexOAuthError("origin_violation", "Codex OAuth request origin is invalid.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    try {
      const response = await this.fetchImpl(target, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/json", "user-agent": this.userAgent, ...(init.headers as Record<string, string> ?? {}) },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        throw new CodexOAuthError("redirect_forbidden", "Codex OAuth redirects are forbidden.");
      }
      return response;
    } catch (error) {
      if (error instanceof CodexOAuthError) throw error;
      throw new CodexOAuthError("network_error", "Codex OAuth network request failed.", true);
    } finally { clearTimeout(timeout); }
  }

  private async withLock<T>(tenantId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(tenantId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(tenantId, current);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.locks.get(tenantId) === current) this.locks.delete(tenantId);
    }
  }
}

function secretName(tenantId: string): string {
  return `HAF_CODEX_OAUTH_${createHash("sha256").update(tenantId).digest("hex").slice(0, 48).toUpperCase()}`;
}
function validateState(value: unknown): CodexOAuthState {
  if (!value || typeof value !== "object" || (value as any).schemaVersion !== 1) throw new CodexOAuthError("state_invalid", "Encrypted Codex OAuth state is malformed.");
  const state = value as CodexOAuthState;
  if (state.tokens && (!state.tokens.accessToken || !state.tokens.refreshToken || !Number.isFinite(state.tokens.expiresAt))) throw new CodexOAuthError("state_invalid", "Encrypted Codex token state is malformed.");
  if (state.pending && (!state.pending.flowId || !state.pending.deviceAuthId || !state.pending.userCode || !Number.isFinite(state.pending.expiresAt))) throw new CodexOAuthError("state_invalid", "Encrypted Codex device state is malformed.");
  return state;
}
async function boundedJson(response: Response, maxBytes: number): Promise<Record<string, any>> {
  let text = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new CodexOAuthError("response_oversized", "Codex OAuth response exceeds its safety bound.");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new CodexOAuthError("response_invalid", "Codex OAuth returned invalid JSON."); }
}
function requiredString(value: unknown, max: number, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new CodexOAuthError("response_invalid", `Codex OAuth response field ${name} is invalid.`);
  return value.trim();
}
function decodeJwt(token: string): Record<string, any> | undefined {
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
}
function jwtExpiryMs(token: string): number | undefined {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1_000 : undefined;
}
function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 24 * 60 * 60_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 24 * 60 * 60_000)) : undefined;
}
function accountIdFromClaims(claims: Record<string, any> | undefined): string | undefined {
  const auth = claims?.["https://api.openai.com/auth"];
  const value = auth && typeof auth === "object" ? auth.chatgpt_account_id : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
