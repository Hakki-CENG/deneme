import {
  createHash,
  createHmac,
  createPrivateKey,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeUrl } from "../capabilities/web.js";
import type { CredentialBrokerLike, SecretMetadata } from "../security/credential-broker.js";
import { atomicWrite } from "../util/atomic-file.js";

const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PENDING = 10_000;
const MAX_DELIVERIES = 100_000;
const PENDING_TTL_MS = 15 * 60_000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
const GITHUB_API_VERSION = "2026-03-10";

interface GitHubAppKeyRecord {
  id: string;
  secretId: string;
  enabled: boolean;
  primary: boolean;
  createdAt: string;
  disabledAt?: string;
}

interface GitHubAppRecord {
  id: string;
  tenantId: string;
  name: string;
  appId: string;
  clientId?: string;
  appSlug: string;
  apiBase: string;
  webBase: string;
  projectionSalt: string;
  privateKeys: GitHubAppKeyRecord[];
  webhookSecrets: GitHubAppKeyRecord[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface GitHubAppPendingInstallation {
  id: string;
  tenantId: string;
  appConfigId: string;
  stateHash: string;
  returnTo: string;
  status: "pending" | "requested";
  createdAt: string;
  expiresAt: string;
}

interface GitHubAppInstallationRecord {
  id: string;
  tenantId: string;
  appConfigId: string;
  installationIdSecretId: string;
  installationProjection: string;
  accountIdProjection?: string;
  accountLogin?: string;
  accountType?: string;
  repositorySelection?: "all" | "selected";
  accessTokenSecretId?: string;
  accessTokenExpiresAt?: string;
  status: "active" | "suspended" | "deleted" | "disabled";
  createdAt: string;
  updatedAt: string;
  lastWebhookAt?: string;
}

export interface GitHubAppWebhookEvent {
  deliveryHash: string;
  appConfigId: string;
  installationId?: string;
  event: string;
  action?: string;
  repositoryId?: string;
  reviewNumber?: number;
  headSha?: string;
  payloadSha256: string;
  receivedAt: string;
}

interface GitHubAppState {
  schemaVersion: 1;
  apps: GitHubAppRecord[];
  pending: GitHubAppPendingInstallation[];
  installations: GitHubAppInstallationRecord[];
  deliveries: GitHubAppWebhookEvent[];
}

export interface GitHubAppManagerOptions {
  rootPath: string;
  credentials: CredentialBrokerLike;
  fetch?: typeof fetch;
  urlGuard?: (url: string) => Promise<URL>;
  now?: () => number;
}

export interface GitHubAppView {
  id: string;
  tenantId: string;
  name: string;
  appId: string;
  clientId?: string;
  appSlug: string;
  apiBase: string;
  webBase: string;
  enabled: boolean;
  privateKeys: Array<{ id: string; enabled: boolean; primary: boolean; configured: boolean; createdAt: string; disabledAt?: string }>;
  webhookSecrets: Array<{ id: string; enabled: boolean; primary: boolean; configured: boolean; createdAt: string; disabledAt?: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubAppInstallationView {
  id: string;
  tenantId: string;
  appConfigId: string;
  installationProjection: string;
  accountIdProjection?: string;
  accountLogin?: string;
  accountType?: string;
  repositorySelection?: "all" | "selected";
  status: "active" | "suspended" | "deleted" | "disabled";
  credentialConfigured: boolean;
  tokenExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  lastWebhookAt?: string;
}

export interface GitHubAppInstallationCredentialSource {
  installation(id: string, tenantId: string): Promise<GitHubAppInstallationView>;
  accessToken(id: string, tenantId: string): Promise<string>;
  accessCredential(id: string, tenantId: string): Promise<{ secretId: string; expiresAt: string }>;
}

export class GitHubAppPendingNotFoundError extends Error {
  constructor() {
    super("GitHub App installation state is missing, consumed, or expired.");
    this.name = "GitHubAppPendingNotFoundError";
  }
}

export class GitHubAppWebhookVerificationError extends Error {
  constructor() {
    super("GitHub App webhook signature verification failed.");
    this.name = "GitHubAppWebhookVerificationError";
  }
}

class GitHubAppHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GitHubAppHttpError";
  }
}

/**
 * Tenant-scoped GitHub App installation lifecycle and credential source.
 *
 * Raw installation IDs, private keys, webhook secrets and installation tokens
 * live only in Credential Broker. Registry/list surfaces expose opaque record
 * IDs and keyed projections.
 */
export class GitHubAppManager implements GitHubAppInstallationCredentialSource {
  private state: GitHubAppState = { schemaVersion: 1, apps: [], pending: [], installations: [], deliveries: [] };
  private loaded = false;
  private readonly fetchImpl: typeof fetch;
  private readonly urlGuard: (url: string) => Promise<URL>;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly options: GitHubAppManagerOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.urlGuard = options.urlGuard ?? assertSafeUrl;
    this.now = options.now ?? Date.now;
  }

  async register(input: {
    tenantId: string;
    name: string;
    appId: string;
    clientId?: string;
    appSlug: string;
    privateKeySecretIds: string[];
    webhookSecretIds?: string[];
    apiBase?: string;
    webBase?: string;
  }): Promise<GitHubAppView> {
    await this.load();
    const name = boundedText(input.name, 200, "GitHub App name");
    const appId = numericIdentifier(input.appId, "GitHub App ID");
    const clientId = input.clientId ? clientIdentifier(input.clientId) : undefined;
    const appSlug = slug(input.appSlug);
    if (this.state.apps.some((item) => item.tenantId === input.tenantId && item.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("GitHub App name already exists in tenant.");
    }
    if (this.state.apps.some((item) => item.tenantId === input.tenantId && item.appId === appId && item.appSlug === appSlug)) {
      throw new Error("GitHub App registration already exists in tenant.");
    }
    const privateKeySecretIds = uniqueSecretIds(input.privateKeySecretIds, 25, "private key");
    if (!privateKeySecretIds.length) throw new Error("At least one GitHub App private-key secret is required.");
    const webhookSecretIds = uniqueSecretIds(input.webhookSecretIds ?? [], 25, "webhook secret");
    const [apiBase, webBase] = await Promise.all([
      normalizedBase(input.apiBase ?? "https://api.github.com", this.urlGuard, true),
      normalizedBase(input.webBase ?? "https://github.com", this.urlGuard, false),
    ]);
    for (const secretId of privateKeySecretIds) await this.validatePrivateKey(input.tenantId, secretId, new URL(apiBase).origin);
    for (const secretId of webhookSecretIds) await this.assertSecret(input.tenantId, secretId);
    const now = new Date(this.now()).toISOString();
    const keyRecords = (ids: string[]): GitHubAppKeyRecord[] => ids.map((secretId, index) => ({
      id: randomUUID(), secretId, enabled: true, primary: index === 0, createdAt: now,
    }));
    const record: GitHubAppRecord = {
      id: randomUUID(), tenantId: input.tenantId, name, appId,
      ...(clientId ? { clientId } : {}), appSlug, apiBase, webBase,
      projectionSalt: randomBytes(32).toString("base64url"),
      privateKeys: keyRecords(privateKeySecretIds), webhookSecrets: keyRecords(webhookSecretIds),
      enabled: true, createdAt: now, updatedAt: now,
    };
    this.state.apps.push(record);
    await this.save();
    return await this.appView(record);
  }

  async list(tenantId: string): Promise<GitHubAppView[]> {
    await this.load();
    return await Promise.all(this.state.apps.filter((item) => item.tenantId === tenantId).map((item) => this.appView(item)));
  }

  async setEnabled(id: string, tenantId: string, enabled: boolean): Promise<GitHubAppView> {
    const app = await this.appRecord(id, tenantId);
    if (enabled && !app.privateKeys.some((item) => item.enabled)) throw new Error("GitHub App cannot be enabled without an active private key.");
    app.enabled = enabled;
    app.updatedAt = new Date(this.now()).toISOString();
    if (!enabled) await this.clearAppTokens(app.id, tenantId);
    await this.save();
    return await this.appView(app);
  }

  async rotatePrivateKey(input: { appConfigId: string; tenantId: string; secretId: string; makePrimary?: boolean }): Promise<GitHubAppView> {
    const app = await this.appRecord(input.appConfigId, input.tenantId);
    if (app.privateKeys.length >= 25) throw new Error("GitHub App private-key limit of 25 is reached.");
    if (app.privateKeys.some((item) => item.secretId === input.secretId)) throw new Error("GitHub App private-key secret is already registered.");
    await this.validatePrivateKey(input.tenantId, input.secretId, new URL(app.apiBase).origin);
    const makePrimary = input.makePrimary !== false;
    if (makePrimary) for (const key of app.privateKeys) key.primary = false;
    app.privateKeys.push({
      id: randomUUID(), secretId: input.secretId, enabled: true, primary: makePrimary,
      createdAt: new Date(this.now()).toISOString(),
    });
    app.updatedAt = new Date(this.now()).toISOString();
    await this.save();
    return await this.appView(app);
  }

  async setPrivateKeyEnabled(input: { appConfigId: string; tenantId: string; keyId: string; enabled: boolean }): Promise<GitHubAppView> {
    const app = await this.appRecord(input.appConfigId, input.tenantId);
    const key = app.privateKeys.find((item) => item.id === input.keyId);
    if (!key) throw new Error("GitHub App private key not found.");
    if (!input.enabled && app.enabled && app.privateKeys.filter((item) => item.enabled && item.id !== key.id).length === 0) {
      throw new Error("The last active GitHub App private key cannot be disabled while the app is enabled.");
    }
    key.enabled = input.enabled;
    if (input.enabled) delete key.disabledAt;
    else {
      key.primary = false;
      key.disabledAt = new Date(this.now()).toISOString();
    }
    if (!app.privateKeys.some((item) => item.enabled && item.primary)) {
      const next = app.privateKeys.find((item) => item.enabled);
      if (next) next.primary = true;
    }
    app.updatedAt = new Date(this.now()).toISOString();
    await this.save();
    return await this.appView(app);
  }

  async rotateWebhookSecret(input: { appConfigId: string; tenantId: string; secretId: string; makePrimary?: boolean }): Promise<GitHubAppView> {
    const app = await this.appRecord(input.appConfigId, input.tenantId);
    if (app.webhookSecrets.length >= 25) throw new Error("GitHub App webhook-secret limit of 25 is reached.");
    if (app.webhookSecrets.some((item) => item.secretId === input.secretId)) throw new Error("GitHub App webhook secret is already registered.");
    await this.assertSecret(input.tenantId, input.secretId);
    const makePrimary = input.makePrimary !== false;
    if (makePrimary) for (const key of app.webhookSecrets) key.primary = false;
    app.webhookSecrets.push({ id: randomUUID(), secretId: input.secretId, enabled: true, primary: makePrimary, createdAt: new Date(this.now()).toISOString() });
    app.updatedAt = new Date(this.now()).toISOString();
    await this.save();
    return await this.appView(app);
  }

  async setWebhookSecretEnabled(input: { appConfigId: string; tenantId: string; keyId: string; enabled: boolean }): Promise<GitHubAppView> {
    const app = await this.appRecord(input.appConfigId, input.tenantId);
    const key = app.webhookSecrets.find((item) => item.id === input.keyId);
    if (!key) throw new Error("GitHub App webhook secret not found.");
    if (!input.enabled && app.enabled && app.webhookSecrets.filter((item) => item.enabled && item.id !== key.id).length === 0) {
      throw new Error("The last active GitHub App webhook secret cannot be disabled while the app is enabled.");
    }
    key.enabled = input.enabled;
    if (input.enabled) delete key.disabledAt;
    else {
      key.primary = false;
      key.disabledAt = new Date(this.now()).toISOString();
    }
    if (!app.webhookSecrets.some((item) => item.enabled && item.primary)) {
      const next = app.webhookSecrets.find((item) => item.enabled);
      if (next) next.primary = true;
    }
    app.updatedAt = new Date(this.now()).toISOString();
    await this.save();
    return await this.appView(app);
  }

  async startInstallation(input: { appConfigId: string; tenantId: string; returnTo?: string }): Promise<{ pendingId: string; installationUrl: string; expiresAt: string }> {
    const app = await this.enabledApp(input.appConfigId, input.tenantId);
    await this.load();
    this.expirePending();
    if (this.state.pending.filter((item) => item.tenantId === input.tenantId).length >= MAX_PENDING) throw new Error("GitHub App pending installation limit is reached.");
    const state = randomBytes(32).toString("base64url");
    const createdAt = new Date(this.now()).toISOString();
    const pending: GitHubAppPendingInstallation = {
      id: randomUUID(), tenantId: input.tenantId, appConfigId: app.id, stateHash: sha256(state),
      returnTo: safeReturnTo(input.returnTo ?? "/canvas/"), status: "pending", createdAt,
      expiresAt: new Date(this.now() + PENDING_TTL_MS).toISOString(),
    };
    this.state.pending.push(pending);
    await this.save();
    const installationUrl = new URL(`/apps/${encodeURIComponent(app.appSlug)}/installations/new`, `${app.webBase}/`);
    installationUrl.searchParams.set("state", state);
    return { pendingId: pending.id, installationUrl: installationUrl.toString(), expiresAt: pending.expiresAt };
  }

  async markInstallationRequested(state: string): Promise<{ status: "requested"; returnTo: string }> {
    const stateHash = checkedStateHash(state);
    return await this.withLock(`pending:${stateHash}`, async () => {
      await this.load();
      const pending = this.pendingByHash(stateHash);
      pending.status = "requested";
      pending.expiresAt = new Date(this.now() + PENDING_TTL_MS).toISOString();
      await this.save();
      return { status: "requested", returnTo: pending.returnTo };
    });
  }

  async finishInstallation(input: { state: string; installationId: string; setupAction: "install" | "update" }): Promise<{ installation: GitHubAppInstallationView; returnTo: string }> {
    const stateHash = checkedStateHash(input.state);
    const installationId = numericIdentifier(input.installationId, "GitHub App installation ID");
    return await this.withLock(`pending:${stateHash}`, async () => {
      await this.load();
      const pending = this.pendingByHash(stateHash);
      const app = await this.enabledApp(pending.appConfigId, pending.tenantId);
      const metadata = await this.appApi(app, `app/installations/${installationId}`, { method: "GET" });
      if (String(metadata?.id ?? "") !== installationId || (metadata?.app_id !== undefined && String(metadata.app_id) !== app.appId)) {
        throw new Error("GitHub App installation metadata did not match the configured app.");
      }
      const record = await this.upsertInstallation(app, installationId, metadata, "active");
      this.state.pending = this.state.pending.filter((item) => item.id !== pending.id);
      await this.save();
      return { installation: await this.installationView(record), returnTo: pending.returnTo };
    });
  }

  async installations(tenantId: string, appConfigId?: string): Promise<GitHubAppInstallationView[]> {
    await this.load();
    return await Promise.all(this.state.installations
      .filter((item) => item.tenantId === tenantId && (!appConfigId || item.appConfigId === appConfigId))
      .map((item) => this.installationView(item)));
  }

  async installation(id: string, tenantId: string): Promise<GitHubAppInstallationView> {
    return await this.installationView(await this.installationRecord(id, tenantId));
  }

  async setInstallationEnabled(id: string, tenantId: string, enabled: boolean): Promise<GitHubAppInstallationView> {
    const record = await this.installationRecord(id, tenantId);
    if (record.status === "deleted" && enabled) throw new Error("A deleted GitHub App installation cannot be re-enabled without a new verified event.");
    record.status = enabled ? "active" : "disabled";
    record.updatedAt = new Date(this.now()).toISOString();
    if (!enabled) await this.clearToken(record);
    await this.save();
    return await this.installationView(record);
  }

  async removeInstallation(id: string, tenantId: string): Promise<boolean> {
    await this.load();
    const record = this.state.installations.find((item) => item.id === id && item.tenantId === tenantId);
    if (!record) return false;
    await this.options.credentials.remove(tenantId, record.installationIdSecretId);
    if (record.accessTokenSecretId) await this.options.credentials.remove(tenantId, record.accessTokenSecretId);
    this.state.installations = this.state.installations.filter((item) => item.id !== record.id);
    await this.save();
    return true;
  }

  async accessToken(id: string, tenantId: string): Promise<string> {
    return (await this.ensureAccess(id, tenantId)).token;
  }

  async accessCredential(id: string, tenantId: string): Promise<{ secretId: string; expiresAt: string }> {
    const access = await this.ensureAccess(id, tenantId);
    return { secretId: access.secretId, expiresAt: access.expiresAt };
  }

  async ingestWebhook(input: {
    rawBody: Buffer;
    signature: string | undefined;
    deliveryId: string | undefined;
    event: string | undefined;
    payload: unknown;
  }): Promise<{ accepted: true; duplicate: boolean; event: string; action?: string; installationId?: string }> {
    if (!input.rawBody.length || input.rawBody.length > MAX_RESPONSE_BYTES) throw new GitHubAppWebhookVerificationError();
    if (!input.deliveryId || !/^[A-Za-z0-9_.:-]{8,200}$/.test(input.deliveryId)) throw new GitHubAppWebhookVerificationError();
    if (!input.event || !/^[a-z_]{1,100}$/.test(input.event)) throw new GitHubAppWebhookVerificationError();
    const event = input.event;
    if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) throw new GitHubAppWebhookVerificationError();
    const payload = input.payload as Record<string, any>;
    const payloadAppId = String(payload?.installation?.app_id ?? payload?.app?.id ?? "");
    const app = await this.verifyWebhookSignature(input.rawBody, input.signature, payloadAppId);
    const deliveryHash = hmacProjection(app, `delivery\0${input.deliveryId}`);
    return await this.withLock(`delivery:${deliveryHash}`, async () => {
      await this.load();
      const prior = this.state.deliveries.find((item) => item.deliveryHash === deliveryHash && item.appConfigId === app.id);
      if (prior) return {
        accepted: true as const, duplicate: true, event: prior.event,
        ...(prior.action ? { action: prior.action } : {}), ...(prior.installationId ? { installationId: prior.installationId } : {}),
      };
      const action = typeof payload.action === "string" ? payload.action.slice(0, 100) : undefined;
      const rawInstallationId = String(payload?.installation?.id ?? "");
      let installation: GitHubAppInstallationRecord | undefined;
      if (/^\d{1,30}$/.test(rawInstallationId)) {
        const status = event === "installation" && action === "deleted" ? "deleted"
          : event === "installation" && action === "suspend" ? "suspended"
          : "active";
        installation = await this.upsertInstallation(app, rawInstallationId, payload.installation, status);
        installation.lastWebhookAt = new Date(this.now()).toISOString();
        installation.updatedAt = installation.lastWebhookAt;
        if (status !== "active" || event === "installation_repositories") await this.clearToken(installation);
      }
      const repositoryId = payload?.repository?.id === undefined ? undefined : String(payload.repository.id);
      const reviewNumber = Number(payload?.pull_request?.number ?? payload?.number);
      const headSha = typeof payload?.pull_request?.head?.sha === "string" && /^[a-f0-9]{40,64}$/i.test(payload.pull_request.head.sha)
        ? payload.pull_request.head.sha : undefined;
      const record: GitHubAppWebhookEvent = {
        deliveryHash, appConfigId: app.id,
        ...(installation ? { installationId: installation.id } : {}),
        event, ...(action ? { action } : {}),
        ...(repositoryId && /^\d{1,30}$/.test(repositoryId) ? { repositoryId } : {}),
        ...(Number.isInteger(reviewNumber) && reviewNumber > 0 ? { reviewNumber } : {}),
        ...(headSha ? { headSha } : {}), payloadSha256: sha256(input.rawBody),
        receivedAt: new Date(this.now()).toISOString(),
      };
      this.state.deliveries.push(record);
      if (this.state.deliveries.length > MAX_DELIVERIES) this.state.deliveries.splice(0, this.state.deliveries.length - MAX_DELIVERIES);
      await this.save();
      return {
        accepted: true as const, duplicate: false, event: record.event,
        ...(record.action ? { action: record.action } : {}), ...(record.installationId ? { installationId: record.installationId } : {}),
      };
    });
  }

  async webhookEvents(tenantId: string, appConfigId?: string): Promise<GitHubAppWebhookEvent[]> {
    await this.load();
    const appIds = new Set(this.state.apps.filter((item) => item.tenantId === tenantId && (!appConfigId || item.id === appConfigId)).map((item) => item.id));
    return this.state.deliveries.filter((item) => appIds.has(item.appConfigId)).slice(-1000).reverse().map((item) => structuredClone(item));
  }

  private async ensureAccess(id: string, tenantId: string): Promise<{ token: string; secretId: string; expiresAt: string }> {
    return await this.withLock(`access:${tenantId}:${id}`, async () => {
      const installation = await this.installationRecord(id, tenantId);
      if (installation.status !== "active") throw new Error("GitHub App installation is not active.");
      const app = await this.enabledApp(installation.appConfigId, tenantId);
      const cachedExpiry = Date.parse(installation.accessTokenExpiresAt ?? "");
      if (installation.accessTokenSecretId && Number.isFinite(cachedExpiry) && cachedExpiry > this.now() + TOKEN_REFRESH_SKEW_MS) {
        const metadata = (await this.options.credentials.list(tenantId)).find((item) => item.id === installation.accessTokenSecretId);
        if (metadata) {
          try {
            const token = await this.redeem(tenantId, metadata.id, "github.app.installation", new URL(app.apiBase).origin);
            return { token, secretId: metadata.id, expiresAt: installation.accessTokenExpiresAt! };
          } catch {
            // Missing/decryption-invalid cached credentials fall through to a new mint.
          }
        }
      }
      const installationId = await this.redeem(tenantId, installation.installationIdSecretId, "github.app.installation-id", new URL(app.apiBase).origin);
      if (!/^\d{1,30}$/.test(installationId)) throw new Error("Encrypted GitHub App installation ID is invalid.");
      const body = await this.appApi(app, `app/installations/${installationId}/access_tokens`, { method: "POST", body: {} });
      const token = typeof body?.token === "string" ? body.token : "";
      const expiresAt = typeof body?.expires_at === "string" ? body.expires_at : "";
      const expiresMs = Date.parse(expiresAt);
      if (!token || token.length > 20_000 || /\s/.test(token) || !Number.isFinite(expiresMs) || expiresMs <= this.now() + 60_000 || expiresMs > this.now() + 2 * 60 * 60_000) {
        throw new Error("GitHub App installation token response is invalid.");
      }
      const secret = await this.options.credentials.put({
        tenantId, name: accessTokenSecretName(installation.id), value: token,
        description: "HAF-managed GitHub App installation access token",
      });
      installation.accessTokenSecretId = secret.id;
      installation.accessTokenExpiresAt = new Date(expiresMs).toISOString();
      installation.updatedAt = new Date(this.now()).toISOString();
      await this.save();
      return { token, secretId: secret.id, expiresAt: installation.accessTokenExpiresAt };
    });
  }

  private async appApi(app: GitHubAppRecord, path: string, options: { method: "GET" | "POST"; body?: unknown }): Promise<any> {
    const keys = app.privateKeys.filter((item) => item.enabled).sort((a, b) => Number(b.primary) - Number(a.primary));
    if (!keys.length) throw new Error("GitHub App has no active private key.");
    let lastError: unknown;
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      let privateKey = await this.redeem(app.tenantId, key.secretId, "github.app.jwt", new URL(app.apiBase).origin);
      let jwt = "";
      try { jwt = createAppJwt(app.clientId ?? app.appId, privateKey, this.now()); }
      finally { privateKey = ""; }
      try {
        return await this.requestJson(app.apiBase, path, {
          method: options.method,
          headers: { authorization: `Bearer ${jwt}` },
          ...(options.body !== undefined ? { body: options.body } : {}),
        });
      } catch (error) {
        lastError = error;
        const rotate = error instanceof GitHubAppHttpError && [401, 403].includes(error.status) && index < keys.length - 1;
        if (!rotate) throw error;
      } finally { jwt = ""; }
    }
    throw lastError instanceof Error ? lastError : new Error("GitHub App request failed.");
  }

  private async requestJson(baseValue: string, path: string, input: { method: "GET" | "POST"; headers?: Record<string, string>; body?: unknown }): Promise<any> {
    const base = new URL(baseValue.endsWith("/") ? baseValue : `${baseValue}/`);
    const target = await this.urlGuard(new URL(path.replace(/^\/+/, ""), base).toString());
    const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    if (target.origin !== base.origin || !target.pathname.startsWith(prefix) || target.username || target.password || target.hash) {
      throw new Error("GitHub App API request escaped its configured boundary.");
    }
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json", "user-agent": "Hybrid-Agent-Fabric/1.38",
      "x-github-api-version": GITHUB_API_VERSION, ...(input.headers ?? {}),
    };
    if (input.body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(target, {
      method: input.method, headers, redirect: "manual",
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubAppHttpError(response.status, "GitHub App API redirects are forbidden.");
    }
    const text = await boundedResponseText(response, MAX_RESPONSE_BYTES);
    if (!response.ok) throw new GitHubAppHttpError(response.status, `GitHub App API request failed with HTTP ${response.status}.`);
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { throw new Error("GitHub App API returned invalid JSON."); }
  }

  private async verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, payloadAppId: string): Promise<GitHubAppRecord> {
    if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) throw new GitHubAppWebhookVerificationError();
    await this.load();
    const candidates = this.state.apps.filter((item) => item.enabled && (!payloadAppId || item.appId === payloadAppId));
    for (const app of candidates) {
      for (const secretRef of app.webhookSecrets.filter((item) => item.enabled)) {
        let secret = "";
        try {
          secret = await this.redeem(app.tenantId, secretRef.secretId, "github.app.webhook", new URL(app.apiBase).origin);
          const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
          if (safeEqual(expected, signature)) return app;
        } catch {
          // A missing/invalid candidate secret cannot weaken verification.
        } finally { secret = ""; }
      }
    }
    throw new GitHubAppWebhookVerificationError();
  }

  private async upsertInstallation(app: GitHubAppRecord, rawInstallationId: string, metadata: any, status: GitHubAppInstallationRecord["status"]): Promise<GitHubAppInstallationRecord> {
    const projection = hmacProjection(app, `installation\0${rawInstallationId}`);
    let record = this.state.installations.find((item) => item.appConfigId === app.id && item.installationProjection === projection);
    const now = new Date(this.now()).toISOString();
    if (!record) {
      const id = randomUUID();
      const secret = await this.options.credentials.put({
        tenantId: app.tenantId, name: installationIdSecretName(id), value: rawInstallationId,
        description: "HAF-managed encrypted GitHub App installation identifier",
      });
      record = {
        id, tenantId: app.tenantId, appConfigId: app.id, installationIdSecretId: secret.id,
        installationProjection: projection, status, createdAt: now, updatedAt: now,
      };
      this.state.installations.push(record);
    } else {
      record.status = status;
      record.updatedAt = now;
    }
    const accountId = String(metadata?.account?.id ?? "");
    if (/^\d{1,30}$/.test(accountId)) record.accountIdProjection = hmacProjection(app, `account\0${accountId}`);
    const login = typeof metadata?.account?.login === "string" ? metadata.account.login.trim() : "";
    if (login && login.length <= 200 && !/[\u0000-\u001f\u007f]/.test(login)) record.accountLogin = login;
    const accountType = typeof metadata?.account?.type === "string" ? metadata.account.type : "";
    if (["User", "Organization", "Enterprise", "Bot"].includes(accountType)) record.accountType = accountType;
    if (metadata?.repository_selection === "all" || metadata?.repository_selection === "selected") record.repositorySelection = metadata.repository_selection;
    return record;
  }

  private async clearAppTokens(appConfigId: string, tenantId: string): Promise<void> {
    for (const installation of this.state.installations.filter((item) => item.appConfigId === appConfigId && item.tenantId === tenantId)) await this.clearToken(installation);
  }

  private async clearToken(record: GitHubAppInstallationRecord): Promise<void> {
    if (record.accessTokenSecretId) await this.options.credentials.remove(record.tenantId, record.accessTokenSecretId);
    delete record.accessTokenSecretId;
    delete record.accessTokenExpiresAt;
  }

  private async appRecord(id: string, tenantId: string): Promise<GitHubAppRecord> {
    await this.load();
    const record = this.state.apps.find((item) => item.id === id && item.tenantId === tenantId);
    if (!record) throw new Error("GitHub App registration not found in tenant.");
    return record;
  }

  private async enabledApp(id: string, tenantId: string): Promise<GitHubAppRecord> {
    const app = await this.appRecord(id, tenantId);
    if (!app.enabled) throw new Error("GitHub App registration is disabled.");
    return app;
  }

  private async installationRecord(id: string, tenantId: string): Promise<GitHubAppInstallationRecord> {
    await this.load();
    const record = this.state.installations.find((item) => item.id === id && item.tenantId === tenantId);
    if (!record) throw new Error("GitHub App installation not found in tenant.");
    return record;
  }

  private pendingByHash(stateHash: string): GitHubAppPendingInstallation {
    this.expirePending();
    const pending = this.state.pending.find((item) => item.stateHash === stateHash);
    if (!pending || Date.parse(pending.expiresAt) <= this.now()) throw new GitHubAppPendingNotFoundError();
    return pending;
  }

  private expirePending(): void {
    const now = this.now();
    this.state.pending = this.state.pending.filter((item) => Date.parse(item.expiresAt) > now);
  }

  private async assertSecret(tenantId: string, secretId: string): Promise<SecretMetadata> {
    const secret = (await this.options.credentials.list(tenantId)).find((item) => item.id === secretId);
    if (!secret) throw new Error("GitHub App credential secret does not exist in tenant.");
    return secret;
  }

  private async validatePrivateKey(tenantId: string, secretId: string, audience: string): Promise<void> {
    await this.assertSecret(tenantId, secretId);
    let pem = await this.redeem(tenantId, secretId, "github.app.key-validation", audience);
    try {
      if (Buffer.byteLength(pem) > 64 * 1024) throw new Error("GitHub App private key exceeds 64 KiB.");
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType !== "rsa") throw new Error("GitHub App private key must be RSA.");
      const bits = key.asymmetricKeyDetails?.modulusLength;
      if (typeof bits === "number" && bits < 2048) throw new Error("GitHub App RSA private key must be at least 2048 bits.");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("GitHub App")) throw error;
      throw new Error("GitHub App private-key secret is not a valid RSA private key.");
    } finally { pem = ""; }
  }

  private async redeem(tenantId: string, secretId: string, capabilityId: string, audience: string): Promise<string> {
    const lease = await this.options.credentials.issueLease({ tenantId, secretId, capabilityId, audience, ttlMs: 30_000, maxUses: 1 });
    return await this.options.credentials.redeemLease({ leaseId: lease.leaseId, tenantId, capabilityId, audience });
  }

  private async appView(record: GitHubAppRecord): Promise<GitHubAppView> {
    const configured = new Set((await this.options.credentials.list(record.tenantId)).map((item) => item.id));
    const project = (item: GitHubAppKeyRecord) => ({
      id: item.id, enabled: item.enabled, primary: item.primary, configured: configured.has(item.secretId),
      createdAt: item.createdAt, ...(item.disabledAt ? { disabledAt: item.disabledAt } : {}),
    });
    return {
      id: record.id, tenantId: record.tenantId, name: record.name, appId: record.appId,
      ...(record.clientId ? { clientId: record.clientId } : {}), appSlug: record.appSlug,
      apiBase: record.apiBase, webBase: record.webBase, enabled: record.enabled,
      privateKeys: record.privateKeys.map(project), webhookSecrets: record.webhookSecrets.map(project),
      createdAt: record.createdAt, updatedAt: record.updatedAt,
    };
  }

  private async installationView(record: GitHubAppInstallationRecord): Promise<GitHubAppInstallationView> {
    const configured = new Set((await this.options.credentials.list(record.tenantId)).map((item) => item.id));
    return {
      id: record.id, tenantId: record.tenantId, appConfigId: record.appConfigId,
      installationProjection: record.installationProjection,
      ...(record.accountIdProjection ? { accountIdProjection: record.accountIdProjection } : {}),
      ...(record.accountLogin ? { accountLogin: record.accountLogin } : {}),
      ...(record.accountType ? { accountType: record.accountType } : {}),
      ...(record.repositorySelection ? { repositorySelection: record.repositorySelection } : {}),
      status: record.status,
      credentialConfigured: configured.has(record.installationIdSecretId),
      ...(record.accessTokenExpiresAt ? { tokenExpiresAt: record.accessTokenExpiresAt } : {}),
      createdAt: record.createdAt, updatedAt: record.updatedAt,
      ...(record.lastWebhookAt ? { lastWebhookAt: record.lastWebhookAt } : {}),
    };
  }

  private get path(): string { return join(this.options.rootPath, "github-apps", "state.json"); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8");
      if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error("GitHub App registry exceeds its safety bound.");
      this.state = validateState(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
    this.expirePending();
  }

  private async save(): Promise<void> {
    this.expirePending();
    const encoded = `${JSON.stringify(this.state, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new Error("GitHub App registry exceeds its safety bound.");
    await atomicWrite(this.path, encoded);
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

export function createAppJwt(issuer: string, privateKeyPem: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({ iat: now - 60, exp: now + 9 * 60, iss: issuer });
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), createPrivateKey(privateKeyPem)).toString("base64url");
  return `${signingInput}.${signature}`;
}

function base64UrlJson(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function hmacProjection(app: GitHubAppRecord, value: string): string {
  return createHmac("sha256", Buffer.from(app.projectionSalt, "base64url")).update(value).digest("hex");
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function checkedStateHash(state: string): string {
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(state)) throw new GitHubAppPendingNotFoundError();
  return sha256(state);
}
function numericIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^\d{1,30}$/.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}
function clientIdentifier(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_.-]{5,200}$/.test(normalized)) throw new Error("GitHub App client ID is invalid.");
  return normalized;
}
function slug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(normalized)) throw new Error("GitHub App slug is invalid.");
  return normalized;
}
function boundedText(value: string, max: number, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}
function uniqueSecretIds(values: string[], max: number, label: string): string[] {
  if (!Array.isArray(values) || values.length > max) throw new Error(`GitHub App ${label} secret list is invalid.`);
  const result = [...new Set(values.map((item) => item.trim()))];
  if (result.some((item) => !/^[A-Za-z0-9-]{8,200}$/.test(item))) throw new Error(`GitHub App ${label} secret reference is invalid.`);
  return result;
}
function safeReturnTo(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.length > 2000 || /[\u0000-\u001f\u007f\\]/.test(value)) {
    throw new Error("GitHub App return path is invalid.");
  }
  const url = new URL(value, "https://haf.invalid");
  if (url.origin !== "https://haf.invalid" || !url.pathname.startsWith("/canvas")) throw new Error("GitHub App return path must target Canvas.");
  return `${url.pathname}${url.search}${url.hash}`;
}
function installationIdSecretName(id: string): string { return `HAF_GITHUB_INSTALLATION_${id.replaceAll("-", "").toUpperCase()}`; }
function accessTokenSecretName(id: string): string { return `HAF_GITHUB_ACCESS_${id.replaceAll("-", "").toUpperCase()}`; }
async function normalizedBase(value: string, guard: (url: string) => Promise<URL>, allowPath: boolean): Promise<string> {
  const url = await guard(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (!allowPath && url.pathname !== "/")) {
    throw new Error("GitHub App endpoint must be credential-free public HTTPS.");
  }
  return allowPath ? url.toString().replace(/\/$/, "") : url.origin;
}
async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("GitHub App API response exceeds its safety bound.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
function validateState(value: unknown): GitHubAppState {
  if (!value || typeof value !== "object" || (value as any).schemaVersion !== 1
    || !Array.isArray((value as any).apps) || !Array.isArray((value as any).pending)
    || !Array.isArray((value as any).installations) || !Array.isArray((value as any).deliveries)) {
    throw new Error("GitHub App registry is malformed.");
  }
  const state = value as GitHubAppState;
  if (state.apps.length > 10_000 || state.pending.length > MAX_PENDING || state.installations.length > 100_000 || state.deliveries.length > MAX_DELIVERIES) {
    throw new Error("GitHub App registry exceeds record limits.");
  }
  return state;
}
