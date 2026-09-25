import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLocalJWKSet, jwtVerify } from "jose";
import { assertSafeUrl } from "../capabilities/web.js";
import type { CredentialBrokerLike } from "../security/credential-broker.js";
import { atomicWrite } from "../util/atomic-file.js";

const MAX_STATE_BYTES = 8 * 1024 * 1024;
const PENDING_TTL_MS = 15 * 60_000;
const REFRESH_SKEW_MS = 2 * 60_000;
const INTERNAL_CAPABILITY = "model.oauth";
const INTERNAL_AUDIENCE = "haf-internal:model-oauth";

export type OAuthClientAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

interface ModelOAuthSourceRecord {
  id: string;
  tenantId: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecretId?: string;
  clientAuthMethod: OAuthClientAuthMethod;
  scopes: string[];
  authorizationServerOrigins: string[];
  resourceOrigins: string[];
  authorizeParameters: Record<string, string>;
  enabled: boolean;
  pendingStateHash?: string;
  pendingExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}
interface ModelOAuthRegistryState { schemaVersion: 1; sources: ModelOAuthSourceRecord[] }
interface OAuthDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri?: string;
}
interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType: "Bearer";
  scope?: string;
  subjectProjection?: string;
}
interface OAuthPendingSecret {
  stateHash: string;
  verifier: string;
  nonce: string;
  expiresAt: number;
  discovery: OAuthDiscovery;
}
interface OAuthSecretState {
  schemaVersion: 1;
  pending?: OAuthPendingSecret;
  tokens?: OAuthTokens;
  lastErrorCode?: string;
  updatedAt: string;
}

export interface ModelOAuthSourceView extends Omit<ModelOAuthSourceRecord, "clientSecretId" | "pendingStateHash"> {
  clientSecretConfigured: boolean;
  authenticated: boolean;
  pending: boolean;
  expiresAt?: string;
  subjectProjection?: string;
  lastErrorCode?: string;
  persistentAcrossRestart: boolean;
}
export interface ModelOAuthStart {
  sourceId: string;
  authorizationUrl: string;
  expiresAt: string;
  restartResumable: boolean;
}
export interface ModelOAuthAuthorization {
  accessToken: string;
  expiresAt: number;
  resourceOrigins: string[];
}
export interface ModelOAuthManagerOptions {
  rootPath: string;
  credentials: CredentialBrokerLike;
  redirectUri?: string;
  fetch?: typeof fetch;
  urlGuard?: (url: string) => Promise<URL>;
  now?: () => number;
}

export class ModelOAuthError extends Error {
  constructor(readonly code: string, message: string, readonly reloginRequired = false) {
    super(message); this.name = "ModelOAuthError";
  }
}
export class ModelOAuthPendingNotFoundError extends ModelOAuthError {
  constructor() { super("state_missing", "Model OAuth state is missing, consumed, or expired."); this.name = "ModelOAuthPendingNotFoundError"; }
}

/** Generic tenant-scoped OIDC Authorization Code + PKCE credential source for model routes. */
export class ModelOAuthManager {
  private registry: ModelOAuthRegistryState = { schemaVersion: 1, sources: [] };
  private loaded = false;
  private readonly fetchImpl: typeof fetch;
  private readonly urlGuard: (url: string) => Promise<URL>;
  private readonly now: () => number;
  private readonly redirectUri: string | undefined;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly options: ModelOAuthManagerOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.urlGuard = options.urlGuard ?? assertSafeUrl;
    this.now = options.now ?? Date.now;
    this.redirectUri = options.redirectUri ? normalizedRedirect(options.redirectUri) : undefined;
  }

  async register(input: {
    tenantId: string; name: string; issuer: string; clientId: string;
    clientSecretId?: string; clientAuthMethod?: OAuthClientAuthMethod;
    scopes: string[]; authorizationServerOrigins?: string[]; resourceOrigins: string[];
    authorizeParameters?: Record<string, string>;
  }): Promise<ModelOAuthSourceView> {
    await this.load();
    if (!this.redirectUri) throw new Error("HAF_MODEL_OAUTH_REDIRECT_URI is required before registering a model OAuth source.");
    const name = bounded(input.name, 200, "Model OAuth source name");
    if (this.registry.sources.some((item) => item.tenantId === input.tenantId && item.name.toLowerCase() === name.toLowerCase())) throw new Error("Model OAuth source name already exists in tenant.");
    const issuerUrl = await this.urlGuard(input.issuer);
    if (issuerUrl.protocol !== "https:" || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash || issuerUrl.pathname !== "/") throw new Error("Model OAuth issuer must be a credential-free HTTPS origin.");
    const issuer = issuerUrl.origin;
    const clientId = bounded(input.clientId, 500, "Model OAuth client ID");
    const method = input.clientAuthMethod ?? (input.clientSecretId ? "client_secret_basic" : "none");
    if (method !== "none" && !input.clientSecretId) throw new Error("Model OAuth confidential client authentication requires a Credential Broker secret.");
    if (method === "none" && input.clientSecretId) throw new Error("Model OAuth client secret requires an explicit secret authentication method.");
    if (input.clientSecretId && !(await this.options.credentials.list(input.tenantId)).some((item) => item.id === input.clientSecretId)) throw new Error("Model OAuth client-secret reference does not exist in tenant.");
    const scopes = uniqueTokens(input.scopes, 50, "scope");
    if (!scopes.includes("openid")) throw new Error("Model OAuth sources require the openid scope for verified account binding.");
    const authorizationServerOrigins = await normalizeOrigins(input.authorizationServerOrigins?.length ? input.authorizationServerOrigins : [issuer], this.urlGuard, 20);
    if (!authorizationServerOrigins.includes(issuer)) throw new Error("Model OAuth authorization origins must include the issuer origin.");
    const resourceOrigins = await normalizeOrigins(input.resourceOrigins, this.urlGuard, 20);
    if (!resourceOrigins.length) throw new Error("Model OAuth requires at least one exact resource origin.");
    const authorizeParameters: Record<string, string> = {};
    const reserved = new Set(["response_type", "client_id", "redirect_uri", "scope", "state", "nonce", "code_challenge", "code_challenge_method"]);
    for (const [key, value] of Object.entries(input.authorizeParameters ?? {})) {
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key) || reserved.has(key) || typeof value !== "string" || !value || value.length > 500 || /[\r\n\0]/.test(value)) throw new Error("Model OAuth extra authorization parameter is invalid or reserved.");
      authorizeParameters[key] = value;
    }
    const now = new Date(this.now()).toISOString();
    const record: ModelOAuthSourceRecord = {
      id: randomUUID(), tenantId: input.tenantId, name, issuer, clientId,
      ...(input.clientSecretId ? { clientSecretId: input.clientSecretId } : {}), clientAuthMethod: method,
      scopes, authorizationServerOrigins, resourceOrigins, authorizeParameters,
      enabled: true, createdAt: now, updatedAt: now,
    };
    this.registry.sources.push(record); await this.saveRegistry();
    return await this.view(record);
  }

  async list(tenantId: string): Promise<ModelOAuthSourceView[]> {
    await this.load();
    return await Promise.all(this.registry.sources.filter((item) => item.tenantId === tenantId).map((item) => this.view(item)));
  }
  async get(id: string, tenantId: string): Promise<ModelOAuthSourceView> { return await this.view(await this.record(id, tenantId)); }
  async setEnabled(id: string, tenantId: string, enabled: boolean): Promise<ModelOAuthSourceView> {
    const source = await this.record(id, tenantId); source.enabled = enabled; source.updatedAt = new Date(this.now()).toISOString();
    if (!enabled) { delete source.pendingStateHash; delete source.pendingExpiresAt; const state = await this.loadSecret(source); delete state.pending; await this.saveSecret(source, state); }
    await this.saveRegistry(); return await this.view(source);
  }
  async remove(id: string, tenantId: string): Promise<boolean> {
    await this.load(); const source = this.registry.sources.find((item) => item.id === id && item.tenantId === tenantId); if (!source) return false;
    const metadata = (await this.options.credentials.list(tenantId)).find((item) => item.name === secretName(source.id));
    if (metadata) await this.options.credentials.remove(tenantId, metadata.id);
    this.registry.sources = this.registry.sources.filter((item) => item !== source); await this.saveRegistry(); return true;
  }
  async logout(id: string, tenantId: string): Promise<ModelOAuthSourceView> {
    const source = await this.record(id, tenantId), state = await this.loadSecret(source);
    delete state.tokens; delete state.pending; delete state.lastErrorCode;
    delete source.pendingStateHash; delete source.pendingExpiresAt; source.updatedAt = new Date(this.now()).toISOString();
    await this.saveSecret(source, state); await this.saveRegistry(); return await this.view(source);
  }

  async start(id: string, tenantId: string, returnTo = "/canvas/"): Promise<ModelOAuthStart> {
    return await this.withLock(`source:${id}`, async () => {
      const source = await this.enabledRecord(id, tenantId);
      if (!this.redirectUri) throw new Error("Model OAuth redirect URI is not configured.");
      const discovery = await this.discover(source);
      const verifier = randomBytes(64).toString("base64url").slice(0, 128);
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const stateRaw = randomBytes(32).toString("base64url"), stateHash = sha256(stateRaw), nonce = randomBytes(32).toString("base64url");
      const expiresAt = this.now() + PENDING_TTL_MS;
      const secret = await this.loadSecret(source);
      secret.pending = { stateHash, verifier, nonce, expiresAt, discovery };
      delete secret.lastErrorCode; await this.saveSecret(source, secret);
      source.pendingStateHash = stateHash; source.pendingExpiresAt = new Date(expiresAt).toISOString(); source.updatedAt = new Date(this.now()).toISOString();
      await this.saveRegistry();
      const url = new URL(discovery.authorizationEndpoint);
      const params: Record<string, string> = {
        response_type: "code", client_id: source.clientId, redirect_uri: this.redirectUri,
        scope: source.scopes.join(" "), state: stateRaw, nonce, code_challenge: challenge, code_challenge_method: "S256",
        ...source.authorizeParameters,
      };
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      safeReturnTo(returnTo); // Validated for future UI parity; callback currently returns Canvas root.
      return { sourceId: source.id, authorizationUrl: url.toString(), expiresAt: new Date(expiresAt).toISOString(), restartResumable: this.options.credentials.persistentAcrossRestart };
    });
  }

  async finish(input: { state: string; code?: string; error?: string }): Promise<ModelOAuthSourceView> {
    const stateHash = checkedStateHash(input.state);
    return await this.withLock(`state:${stateHash}`, async () => {
      await this.load();
      const source = this.registry.sources.find((item) => item.pendingStateHash === stateHash && item.pendingExpiresAt && Date.parse(item.pendingExpiresAt) > this.now());
      if (!source) throw new ModelOAuthPendingNotFoundError();
      const secret = await this.loadSecret(source), pending = secret.pending;
      if (!pending || pending.stateHash !== stateHash || pending.expiresAt <= this.now()) throw new ModelOAuthPendingNotFoundError();
      if (input.error || !input.code) {
        delete secret.pending; secret.lastErrorCode = "authorization_denied"; delete source.pendingStateHash; delete source.pendingExpiresAt;
        await this.saveSecret(source, secret); await this.saveRegistry();
        throw new ModelOAuthError("authorization_denied", "Model OAuth authorization was denied.", true);
      }
      const tokens = await this.exchange(source, pending, input.code);
      secret.tokens = tokens; delete secret.pending; delete secret.lastErrorCode;
      delete source.pendingStateHash; delete source.pendingExpiresAt; source.updatedAt = new Date(this.now()).toISOString();
      await this.saveSecret(source, secret); await this.saveRegistry(); return await this.view(source);
    });
  }

  async authorization(id: string, tenantId: string, resourceOrigin: string): Promise<ModelOAuthAuthorization> {
    return await this.withLock(`source:${id}`, async () => {
      const source = await this.enabledRecord(id, tenantId);
      const origin = new URL(resourceOrigin).origin;
      if (!source.resourceOrigins.includes(origin)) throw new ModelOAuthError("audience_mismatch", "Model OAuth token audience origin is not allowed.");
      const secret = await this.loadSecret(source); let tokens = secret.tokens;
      if (!tokens) throw new ModelOAuthError("not_authenticated", "Model OAuth authentication is required.", true);
      if (tokens.expiresAt <= this.now() + REFRESH_SKEW_MS) tokens = await this.refresh(source, secret, tokens, false);
      return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, resourceOrigins: [...source.resourceOrigins] };
    });
  }
  async forceRefresh(id: string, tenantId: string, resourceOrigin: string): Promise<ModelOAuthAuthorization> {
    return await this.withLock(`source:${id}`, async () => {
      const source = await this.enabledRecord(id, tenantId), origin = new URL(resourceOrigin).origin;
      if (!source.resourceOrigins.includes(origin)) throw new ModelOAuthError("audience_mismatch", "Model OAuth token audience origin is not allowed.");
      const secret = await this.loadSecret(source); if (!secret.tokens) throw new ModelOAuthError("not_authenticated", "Model OAuth authentication is required.", true);
      const tokens = await this.refresh(source, secret, secret.tokens, true);
      return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, resourceOrigins: [...source.resourceOrigins] };
    });
  }

  private async exchange(source: ModelOAuthSourceRecord, pending: OAuthPendingSecret, code: string): Promise<OAuthTokens> {
    const form = new URLSearchParams({ grant_type: "authorization_code", code: bounded(code, 8192, "OAuth code"), redirect_uri: this.redirectUri!, client_id: source.clientId, code_verifier: pending.verifier });
    const value = await this.tokenRequest(source, pending.discovery.tokenEndpoint, form);
    const id = required(value.id_token, 256 * 1024, "id_token");
    const subjectProjection = await this.verifyIdToken(source, pending.discovery, id, pending.nonce);
    return tokenValue(value, this.now(), undefined, subjectProjection);
  }
  private async refresh(source: ModelOAuthSourceRecord, secret: OAuthSecretState, current: OAuthTokens, forced: boolean): Promise<OAuthTokens> {
    if (!current.refreshToken) { secret.lastErrorCode = "refresh_token_missing"; await this.saveSecret(source, secret); throw new ModelOAuthError("refresh_token_missing", "Model OAuth refresh token is missing; re-authentication is required.", true); }
    try {
      const discovery = await this.discover(source);
      const value = await this.tokenRequest(source, discovery.tokenEndpoint, new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: source.clientId }));
      const tokens = tokenValue(value, this.now(), current.refreshToken, current.subjectProjection);
      secret.tokens = tokens; delete secret.lastErrorCode; await this.saveSecret(source, secret); return tokens;
    } catch (error) {
      secret.lastErrorCode = forced ? "forced_refresh_failed" : "refresh_failed"; await this.saveSecret(source, secret); throw error;
    }
  }
  private async tokenRequest(source: ModelOAuthSourceRecord, endpoint: string, form: URLSearchParams): Promise<Record<string, any>> {
    const target = await this.guardedEndpoint(source, endpoint);
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
    if (source.clientAuthMethod !== "none") {
      const clientSecret = await this.clientSecret(source, target.origin);
      if (source.clientAuthMethod === "client_secret_basic") headers.authorization = `Basic ${Buffer.from(`${source.clientId}:${clientSecret}`).toString("base64")}`;
      else form.set("client_secret", clientSecret);
    }
    const response = await this.request(target, { method: "POST", headers, body: form.toString() }, 256 * 1024);
    if (!response.ok) throw new ModelOAuthError([400, 401, 403].includes(response.status) ? "invalid_grant" : "token_request_failed", `Model OAuth token endpoint returned HTTP ${response.status}.`, [400, 401, 403].includes(response.status));
    return await boundedJson(response, 256 * 1024);
  }
  private async verifyIdToken(source: ModelOAuthSourceRecord, discovery: OAuthDiscovery, token: string, nonce: string): Promise<string> {
    if (!discovery.jwksUri) throw new ModelOAuthError("jwks_missing", "OIDC discovery omitted jwks_uri.");
    const jwksTarget = await this.guardedEndpoint(source, discovery.jwksUri);
    const response = await this.request(jwksTarget, { method: "GET", headers: { accept: "application/json" } }, 1024 * 1024);
    if (!response.ok) throw new ModelOAuthError("jwks_failed", "Model OAuth JWKS retrieval failed.");
    const jwks = await boundedJson(response, 1024 * 1024);
    if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 100) throw new ModelOAuthError("jwks_invalid", "Model OAuth JWKS is malformed.");
    try {
      const verified = await jwtVerify(token, createLocalJWKSet(jwks as any), { issuer: source.issuer, audience: source.clientId, currentDate: new Date(this.now()) });
      if (verified.payload.nonce !== nonce || typeof verified.payload.sub !== "string" || !verified.payload.sub) throw new Error("claims");
      return sha256(`${source.issuer}\0${verified.payload.sub}`).slice(0, 24);
    } catch { throw new ModelOAuthError("id_token_invalid", "Model OAuth ID token verification failed.", true); }
  }
  private async discover(source: ModelOAuthSourceRecord): Promise<OAuthDiscovery> {
    const url = `${source.issuer}/.well-known/openid-configuration`;
    const response = await this.request(await this.guardedEndpoint(source, url), { method: "GET", headers: { accept: "application/json" } }, 256 * 1024);
    if (!response.ok) throw new ModelOAuthError("discovery_failed", `Model OAuth discovery returned HTTP ${response.status}.`);
    const value = await boundedJson(response, 256 * 1024);
    if (value.issuer !== source.issuer) throw new ModelOAuthError("issuer_mismatch", "Model OAuth discovery issuer mismatch.");
    const authorizationEndpoint = required(value.authorization_endpoint, 8192, "authorization_endpoint");
    const tokenEndpoint = required(value.token_endpoint, 8192, "token_endpoint");
    const jwksUri = required(value.jwks_uri, 8192, "jwks_uri");
    await Promise.all([authorizationEndpoint, tokenEndpoint, jwksUri].map((item) => this.guardedEndpoint(source, item)));
    return { issuer: source.issuer, authorizationEndpoint, tokenEndpoint, jwksUri };
  }
  private async guardedEndpoint(source: ModelOAuthSourceRecord, value: string): Promise<URL> {
    const url = await this.urlGuard(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !source.authorizationServerOrigins.includes(url.origin)) throw new ModelOAuthError("origin_violation", "Model OAuth endpoint escaped the authorization-server allowlist.");
    return url;
  }
  private async request(url: URL, init: RequestInit, maxBytes: number): Promise<Response> {
    const response = await this.fetchImpl(url, { ...init, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel().catch(() => undefined); throw new ModelOAuthError("redirect_forbidden", "Model OAuth redirects are forbidden."); }
    const bytes = response.headers.get("content-length");
    if (bytes && Number(bytes) > maxBytes) { await response.body?.cancel().catch(() => undefined); throw new ModelOAuthError("response_oversized", "Model OAuth response exceeds its safety bound."); }
    return response;
  }
  private async clientSecret(source: ModelOAuthSourceRecord, audience: string): Promise<string> {
    if (!source.clientSecretId) throw new ModelOAuthError("client_secret_missing", "Model OAuth client secret is missing.");
    const lease = await this.options.credentials.issueLease({ tenantId: source.tenantId, secretId: source.clientSecretId, capabilityId: INTERNAL_CAPABILITY, audience, ttlMs: 30_000, maxUses: 1 });
    return await this.options.credentials.redeemLease({ leaseId: lease.leaseId, tenantId: source.tenantId, capabilityId: INTERNAL_CAPABILITY, audience });
  }
  private async enabledRecord(id: string, tenantId: string): Promise<ModelOAuthSourceRecord> { const source = await this.record(id, tenantId); if (!source.enabled) throw new Error("Model OAuth source is disabled."); return source; }
  private async record(id: string, tenantId: string): Promise<ModelOAuthSourceRecord> { await this.load(); const source = this.registry.sources.find((item) => item.id === id && item.tenantId === tenantId); if (!source) throw new Error("Model OAuth source not found in tenant."); return source; }
  private async view(source: ModelOAuthSourceRecord): Promise<ModelOAuthSourceView> {
    const state = await this.loadSecret(source);
    const clientSecretConfigured = !source.clientSecretId || (await this.options.credentials.list(source.tenantId)).some((item) => item.id === source.clientSecretId);
    return {
      id: source.id, tenantId: source.tenantId, name: source.name, issuer: source.issuer, clientId: source.clientId,
      clientAuthMethod: source.clientAuthMethod, scopes: [...source.scopes], authorizationServerOrigins: [...source.authorizationServerOrigins],
      resourceOrigins: [...source.resourceOrigins], authorizeParameters: { ...source.authorizeParameters }, enabled: source.enabled,
      ...(source.pendingExpiresAt ? { pendingExpiresAt: source.pendingExpiresAt } : {}), createdAt: source.createdAt, updatedAt: source.updatedAt,
      clientSecretConfigured, authenticated: Boolean(state.tokens), pending: Boolean(state.pending && state.pending.expiresAt > this.now()),
      ...(state.tokens ? { expiresAt: new Date(state.tokens.expiresAt).toISOString() } : {}),
      ...(state.tokens?.subjectProjection ? { subjectProjection: state.tokens.subjectProjection } : {}),
      ...(state.lastErrorCode ? { lastErrorCode: state.lastErrorCode } : {}), persistentAcrossRestart: this.options.credentials.persistentAcrossRestart,
    };
  }
  private get registryPath(): string { return join(this.options.rootPath, "models", "oauth-sources.json"); }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try { const raw = await readFile(this.registryPath, "utf8"); if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error("Model OAuth registry exceeds its safety bound."); const parsed = JSON.parse(raw) as ModelOAuthRegistryState; if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sources)) throw new Error("Model OAuth registry is malformed."); this.registry = parsed; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const now = this.now(); let changed = false;
    for (const source of this.registry.sources) if (source.pendingExpiresAt && Date.parse(source.pendingExpiresAt) <= now) { delete source.pendingStateHash; delete source.pendingExpiresAt; changed = true; }
    this.loaded = true; if (changed) await this.saveRegistry();
  }
  private async saveRegistry(): Promise<void> { const encoded = `${JSON.stringify(this.registry, null, 2)}\n`; if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new Error("Model OAuth registry exceeds its safety bound."); await atomicWrite(this.registryPath, encoded); }
  private async loadSecret(source: ModelOAuthSourceRecord): Promise<OAuthSecretState> {
    const metadata = (await this.options.credentials.list(source.tenantId)).find((item) => item.name === secretName(source.id));
    if (!metadata) return { schemaVersion: 1, updatedAt: new Date(this.now()).toISOString() };
    const lease = await this.options.credentials.issueLease({ tenantId: source.tenantId, secretId: metadata.id, capabilityId: INTERNAL_CAPABILITY, audience: INTERNAL_AUDIENCE, ttlMs: 30_000, maxUses: 1 });
    const raw = await this.options.credentials.redeemLease({ leaseId: lease.leaseId, tenantId: source.tenantId, capabilityId: INTERNAL_CAPABILITY, audience: INTERNAL_AUDIENCE });
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new ModelOAuthError("state_invalid", "Encrypted model OAuth state is oversized.");
    const value = JSON.parse(raw) as OAuthSecretState; if (value.schemaVersion !== 1) throw new ModelOAuthError("state_invalid", "Encrypted model OAuth state is malformed."); return value;
  }
  private async saveSecret(source: ModelOAuthSourceRecord, state: OAuthSecretState): Promise<void> {
    state.updatedAt = new Date(this.now()).toISOString(); const encoded = JSON.stringify(state); if (Buffer.byteLength(encoded) > 1024 * 1024) throw new ModelOAuthError("state_invalid", "Model OAuth secret state is oversized.");
    await this.options.credentials.put({ tenantId: source.tenantId, name: secretName(source.id), value: encoded, description: "Encrypted model-provider OAuth state" });
  }
  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve(); let release!: () => void; const current = new Promise<void>((resolve) => { release = resolve; }); const queued = previous.then(() => current); this.locks.set(key, queued); await previous;
    try { return await operation(); } finally { release(); if (this.locks.get(key) === queued) this.locks.delete(key); }
  }
}

function tokenValue(value: Record<string, any>, now: number, priorRefresh?: string, subjectProjection?: string): OAuthTokens {
  const accessToken = required(value.access_token, 256 * 1024, "access_token");
  const refreshToken = typeof value.refresh_token === "string" && value.refresh_token.trim() ? value.refresh_token.trim() : priorRefresh;
  const expiresIn = Math.min(24 * 60 * 60, Math.max(60, Number(value.expires_in ?? 3600)));
  return { accessToken, ...(refreshToken ? { refreshToken } : {}), expiresAt: now + expiresIn * 1000, tokenType: "Bearer", ...(typeof value.scope === "string" ? { scope: value.scope.slice(0, 2000) } : {}), ...(subjectProjection ? { subjectProjection } : {}) };
}
function secretName(id: string): string { return `HAF_MODEL_OAUTH_${sha256(id).slice(0, 48).toUpperCase()}`; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function checkedStateHash(value: string): string { if (!/^[A-Za-z0-9_-]{32,200}$/.test(value)) throw new ModelOAuthPendingNotFoundError(); return sha256(value); }
function required(value: unknown, max: number, field: string): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new ModelOAuthError("response_invalid", `Model OAuth response field ${field} is invalid.`); return value.trim(); }
function bounded(value: string, max: number, label: string): string { const text = value.trim(); if (!text || text.length > max || /[\r\n\0]/.test(text)) throw new Error(`${label} is invalid.`); return text; }
function uniqueTokens(values: string[], max: number, label: string): string[] { const tokens = [...new Set(values.map((item) => item.trim()))]; if (!tokens.length || tokens.length > max || tokens.some((item) => !/^[A-Za-z0-9:._/-]{1,200}$/.test(item))) throw new Error(`Model OAuth ${label} list is invalid.`); return tokens; }
async function normalizeOrigins(values: string[], guard: (url: string) => Promise<URL>, max: number): Promise<string[]> { if (!values.length || values.length > max) throw new Error("Model OAuth origin list is invalid."); const origins: string[] = []; for (const value of values) { const url = await guard(value); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Model OAuth origins must be credential-free HTTPS origins."); origins.push(url.origin); } return [...new Set(origins)]; }
function normalizedRedirect(value: string): string { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Model OAuth redirect URI must be credential-free HTTPS."); return url.toString(); }
function safeReturnTo(value: string): string { if (!value.startsWith("/canvas") || value.startsWith("//") || value.length > 2000 || /[\r\n\0\\]/.test(value)) throw new Error("Model OAuth return path is invalid."); return value; }
async function boundedJson(response: Response, maxBytes: number): Promise<Record<string, any>> { let text = "", bytes = 0; if (response.body) { const reader = response.body.getReader(), decoder = new TextDecoder(); try { while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maxBytes) { await reader.cancel().catch(() => undefined); throw new ModelOAuthError("response_oversized", "Model OAuth response exceeds its safety bound."); } text += decoder.decode(value, { stream: true }); } text += decoder.decode(); } finally { reader.releaseLock(); } } try { const parsed = JSON.parse(text); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); return parsed; } catch { throw new ModelOAuthError("response_invalid", "Model OAuth returned invalid JSON."); } }
