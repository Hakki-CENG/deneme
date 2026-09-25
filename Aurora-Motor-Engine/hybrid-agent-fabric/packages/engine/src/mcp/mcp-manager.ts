import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ENGINE_VERSION } from "../version.js";
import { Agent as UndiciAgent } from "undici";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Capability, CapabilityRisk, JsonValue } from "../types.js";
import type { CapabilityBroker } from "../capabilities/capability-broker.js";
import { assertSafeUrl } from "../capabilities/web.js";
import { asJsonValue } from "../util/json.js";
import { atomicWrite } from "../util/atomic-file.js";
import { BrokerBackedMcpOAuthProvider } from "./mcp-oauth-provider.js";
import {
  McpOAuthPendingStore,
  type PersistedMcpHttpOAuthConfig,
  type PersistedMcpOAuthPendingDescriptor,
} from "./mcp-oauth-pending-store.js";
import type { CredentialBrokerLike } from "../security/credential-broker.js";
import type { McpElicitationService } from "./mcp-elicitation-service.js";

export interface McpStdioConfig {
  name: string;
  tenantId?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  defaultRisk?: CapabilityRisk;
  toolTimeoutMs?: number;
}

export interface McpTlsOptions {
  certificate: string | Buffer;
  privateKey: string | Buffer;
  certificateAuthority?: string | Buffer;
  serverName?: string;
}

export interface McpHttpConfig {
  name: string;
  tenantId?: string;
  url: string;
  headers?: Record<string, string>;
  tls?: McpTlsOptions;
  oauthProvider?: BrokerBackedMcpOAuthProvider;
  defaultRisk?: CapabilityRisk;
  toolTimeoutMs?: number;
  allowPlainHttp?: boolean;
  circuitFailureThreshold?: number;
  circuitResetMs?: number;
}

export interface McpManagerOptions {
  urlGuard?: (url: string) => Promise<URL>;
  fetch?: typeof fetch;
  schemaCacheRoot?: string;
  elicitationService?: McpElicitationService;
  credentialBroker?: CredentialBrokerLike;
  oauthPendingTtlMs?: number;
}

export interface McpSchemaCacheRecord {
  schemaVersion: 1;
  name: string;
  kind: "stdio" | "streamable-http";
  endpoint: string;
  tools: Capability["descriptor"][];
  updatedAt: string;
}

type McpConfig = (McpStdioConfig & { kind: "stdio" }) | (McpHttpConfig & { kind: "streamable-http" });

interface ConnectedServer {
  config: McpConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  dispatcher?: UndiciAgent;
  capabilities: Capability[];
  capabilityIds: string[];
  failureCount: number;
  circuitOpenUntil: number;
}

interface PendingOAuthConnection {
  id: string;
  config: McpConfig;
  client: Client;
  transport: StreamableHTTPClientTransport;
  provider: BrokerBackedMcpOAuthProvider;
  dispatcher?: UndiciAgent;
  createdAt: number;
}

interface PreparedHttpConnection {
  normalized: McpConfig;
  client: Client;
  transport: StreamableHTTPClientTransport;
  dispatcher?: UndiciAgent;
}

export class McpOAuthPendingNotFoundError extends Error {
  constructor() {
    super("MCP OAuth connection is missing or expired.");
    this.name = "McpOAuthPendingNotFoundError";
  }
}

function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!result) throw new Error("MCP server/tool name cannot be normalized to a capability id.");
  return result;
}

export function validateMcpTlsOptions(tls: McpTlsOptions): McpTlsOptions {
  const certificate = Buffer.isBuffer(tls.certificate) ? tls.certificate : Buffer.from(tls.certificate);
  const privateKey = Buffer.isBuffer(tls.privateKey) ? tls.privateKey : Buffer.from(tls.privateKey);
  const certificateAuthority = tls.certificateAuthority === undefined
    ? undefined
    : Buffer.isBuffer(tls.certificateAuthority) ? tls.certificateAuthority : Buffer.from(tls.certificateAuthority);
  for (const [name, value] of [["certificate", certificate], ["private key", privateKey], ["certificate authority", certificateAuthority]] as const) {
    if (!value) continue;
    if (value.length < 32 || value.length > 1024 * 1024) throw new Error(`MCP TLS ${name} size is invalid.`);
  }
  if (!certificate.toString("utf8").includes("-----BEGIN CERTIFICATE-----")) throw new Error("MCP TLS certificate is not PEM encoded.");
  if (!/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(privateKey.toString("utf8"))) throw new Error("MCP TLS private key is not an unencrypted PEM key.");
  if (certificateAuthority && !certificateAuthority.toString("utf8").includes("-----BEGIN CERTIFICATE-----")) throw new Error("MCP TLS certificate authority is not PEM encoded.");
  if (tls.serverName && (!/^[A-Za-z0-9.-]{1,253}$/.test(tls.serverName) || tls.serverName.startsWith(".") || tls.serverName.endsWith("."))) {
    throw new Error("MCP TLS server name is invalid.");
  }
  return {
    certificate,
    privateKey,
    ...(certificateAuthority ? { certificateAuthority } : {}),
    ...(tls.serverName ? { serverName: tls.serverName } : {}),
  };
}

function safeHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(name) || /^(?:host|content-length|connection|transfer-encoding)$/i.test(name)) {
      throw new Error(`MCP header ${name} is forbidden.`);
    }
    if (/\r|\n/.test(value) || value.length > 8192) throw new Error(`MCP header ${name} is invalid.`);
    output[name] = value;
  }
  return output;
}

export class McpManager {
  private readonly servers = new Map<string, ConnectedServer>();
  private readonly pendingOAuth = new Map<string, PendingOAuthConnection>();
  private readonly urlGuard: (url: string) => Promise<URL>;
  private readonly fetchImpl: typeof fetch;
  private readonly schemaCacheRoot: string | undefined;
  private readonly elicitationService: McpElicitationService | undefined;
  private readonly oauthPendingStore: McpOAuthPendingStore | undefined;
  private readonly credentialBroker: CredentialBrokerLike | undefined;
  private readonly oauthPendingTtlMs: number;
  private readonly oauthLocks = new Map<string, Promise<void>>();

  constructor(private readonly broker: CapabilityBroker, options: McpManagerOptions = {}) {
    this.urlGuard = options.urlGuard ?? assertSafeUrl;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.schemaCacheRoot = options.schemaCacheRoot;
    this.elicitationService = options.elicitationService;
    this.credentialBroker = options.credentialBroker;
    this.oauthPendingStore = options.credentialBroker ? new McpOAuthPendingStore(options.credentialBroker) : undefined;
    this.oauthPendingTtlMs = Math.min(60 * 60_000, Math.max(60_000, options.oauthPendingTtlMs ?? 10 * 60_000));
  }

  list(): Array<{
    name: string;
    kind: McpConfig["kind"];
    command?: string;
    url?: string;
    capabilityIds: string[];
    circuit: "closed" | "open";
  }> {
    const now = Date.now();
    return [...this.servers.values()].map((server) => ({
      name: server.config.name,
      kind: server.config.kind,
      ...(server.config.kind === "stdio" ? { command: server.config.command } : { url: server.config.url }),
      capabilityIds: [...server.capabilityIds],
      circuit: server.circuitOpenUntil > now ? "open" : "closed",
    }));
  }

  private cachePath(server: ConnectedServer): string | undefined {
    if (!this.schemaCacheRoot) return undefined;
    const endpoint = server.config.kind === "stdio" ? server.config.command : server.config.url;
    const key = createHash("sha256").update(`${server.config.name}\0${server.config.kind}\0${endpoint}`).digest("hex");
    return join(this.schemaCacheRoot, `${key}.json`);
  }

  private async persistSchemaCache(server: ConnectedServer): Promise<void> {
    const path = this.cachePath(server);
    if (!path) return;
    const record: McpSchemaCacheRecord = {
      schemaVersion: 1,
      name: server.config.name,
      kind: server.config.kind,
      endpoint: server.config.kind === "stdio" ? server.config.command : server.config.url,
      tools: server.capabilities.map((capability) => structuredClone(capability.descriptor)),
      updatedAt: new Date().toISOString(),
    };
    const encoded = JSON.stringify(record, null, 2);
    if (encoded.length > 2_000_000) throw new Error(`MCP server ${server.config.name} schema cache exceeds 2 MB.`);
    await atomicWrite(path, `${encoded}\n`);
  }

  async listCachedSchemas(): Promise<McpSchemaCacheRecord[]> {
    if (!this.schemaCacheRoot) return [];
    let files: string[];
    try { files = await readdir(this.schemaCacheRoot); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: McpSchemaCacheRecord[] = [];
    for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 1000)) {
      try {
        const value = JSON.parse(await readFile(join(this.schemaCacheRoot, file), "utf8")) as McpSchemaCacheRecord;
        if (value.schemaVersion === 1 && typeof value.name === "string" && Array.isArray(value.tools)) records.push(value);
      } catch {
        // A malformed observer cache cannot break live MCP operation.
      }
    }
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map((record) => structuredClone(record));
  }

  private clientFor(serverName: string, tenantId: string, serverRef: () => ConnectedServer | undefined): Client {
    const client = new Client({ name: "hybrid-agent-fabric", version: ENGINE_VERSION }, {
      ...(this.elicitationService ? { capabilities: { elicitation: { form: {}, url: {} } } } : {}),
      listChanged: {
        tools: {
          onChanged: async (error, tools) => {
            const server = serverRef();
            if (!server || error || !tools) return;
            await this.syncTools(server, tools).catch(() => undefined);
          },
        },
      },
    });
    if (this.elicitationService) {
      client.setRequestHandler(ElicitRequestSchema, async (request) =>
        await this.elicitationService!.request(serverName, tenantId, request.params) as any,
      );
    }
    return client;
  }

  async connectStdio(config: McpStdioConfig): Promise<{ name: string; capabilityIds: string[] }> {
    if (this.servers.has(config.name)) throw new Error(`MCP server ${config.name} is already connected.`);
    const normalized: McpConfig = { ...config, kind: "stdio" };
    const transport = new StdioClientTransport({
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.env ? { env: config.env } : {}),
      stderr: "pipe",
      maxBufferSize: 10 * 1024 * 1024,
    });
    let server: ConnectedServer | undefined;
    const client = this.clientFor(config.name, config.tenantId ?? "system", () => server);
    await client.connect(transport);
    server = {
      config: normalized,
      client,
      transport,
      capabilities: [],
      capabilityIds: [],
      failureCount: 0,
      circuitOpenUntil: 0,
    };
    try {
      await this.syncTools(server, (await client.listTools()).tools);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.servers.set(config.name, server);
    return { name: config.name, capabilityIds: [...server.capabilityIds] };
  }

  async connectHttp(config: McpHttpConfig): Promise<{
    name: string;
    capabilityIds: string[];
    authorizationRequired?: boolean;
    oauthConnectionId?: string;
    authorizationUrl?: string;
    restartResumable?: boolean;
  }> {
    await this.purgePendingOAuth();
    const pendingName = [...this.pendingOAuth.values()].some((pending) => pending.config.name === config.name)
      || Boolean(await this.oauthPendingStore?.hasServerName(config.name));
    if (this.servers.has(config.name) || pendingName) {
      throw new Error(`MCP server ${config.name} is already connected or awaiting OAuth.`);
    }
    const prepared = await this.prepareHttpConnection(config);
    try {
      await prepared.client.connect(prepared.transport as unknown as Transport);
    } catch (error) {
      const unauthorized = error instanceof UnauthorizedError || (error instanceof Error && error.name === "UnauthorizedError");
      const authorizationUrl = config.oauthProvider?.authorizationUrl;
      if (unauthorized && config.oauthProvider && authorizationUrl) {
        const oauthConnectionId = randomUUID();
        const pending: PendingOAuthConnection = {
          id: oauthConnectionId,
          config: prepared.normalized,
          client: prepared.client,
          transport: prepared.transport,
          provider: config.oauthProvider,
          ...(prepared.dispatcher ? { dispatcher: prepared.dispatcher } : {}),
          createdAt: Date.now(),
        };
        try {
          if (this.oauthPendingStore) {
            await this.oauthPendingStore.save(config.oauthProvider.oauthState, {
              schemaVersion: 1,
              connectionId: oauthConnectionId,
              createdAt: pending.createdAt,
              expiresAt: pending.createdAt + this.oauthPendingTtlMs,
              config: this.serializePendingConfig(config),
            });
          }
        } catch (persistError) {
          await prepared.client.close().catch(() => undefined);
          await prepared.dispatcher?.close().catch(() => undefined);
          throw persistError;
        }
        this.pendingOAuth.set(oauthConnectionId, pending);
        return {
          name: config.name,
          capabilityIds: [],
          authorizationRequired: true,
          oauthConnectionId,
          authorizationUrl: authorizationUrl.toString(),
          restartResumable: this.oauthPendingStore?.persistentAcrossRestart ?? false,
        };
      }
      await prepared.client.close().catch(() => undefined);
      await prepared.dispatcher?.close().catch(() => undefined);
      throw error;
    }
    const connected: ConnectedServer = {
      config: prepared.normalized,
      client: prepared.client,
      transport: prepared.transport,
      ...(prepared.dispatcher ? { dispatcher: prepared.dispatcher } : {}),
      capabilities: [],
      capabilityIds: [],
      failureCount: 0,
      circuitOpenUntil: 0,
    };
    try {
      await this.syncTools(connected, (await prepared.client.listTools()).tools);
    } catch (error) {
      await prepared.client.close().catch(() => undefined);
      await prepared.dispatcher?.close().catch(() => undefined);
      throw error;
    }
    this.servers.set(config.name, connected);
    return { name: config.name, capabilityIds: [...connected.capabilityIds] };
  }

  private async prepareHttpConnection(config: McpHttpConfig): Promise<PreparedHttpConnection> {
    const endpoint = await this.urlGuard(config.url);
    if (endpoint.protocol !== "https:" && !config.allowPlainHttp) throw new Error("Remote MCP requires HTTPS unless allowPlainHttp is explicitly enabled.");
    if (endpoint.username || endpoint.password) throw new Error("Remote MCP URL credentials are forbidden.");
    if (endpoint.search || endpoint.hash) throw new Error("Remote MCP endpoint query strings and fragments are forbidden; use server-side headers for credentials.");
    const headers = safeHeaders(config.headers);
    if (config.tls && endpoint.protocol !== "https:") throw new Error("MCP mutual TLS requires an HTTPS endpoint.");
    const tls = config.tls ? validateMcpTlsOptions(config.tls) : undefined;
    const dispatcher = tls ? new UndiciAgent({
      connect: {
        cert: tls.certificate,
        key: tls.privateKey,
        ...(tls.certificateAuthority ? { ca: tls.certificateAuthority } : {}),
        ...(tls.serverName ? { servername: tls.serverName } : {}),
        rejectUnauthorized: true,
      },
    }) : undefined;
    const origin = endpoint.origin;
    const secureFetch: typeof fetch = async (input, init) => {
      const target = await this.urlGuard(typeof input === "string" || input instanceof URL ? String(input) : input.url);
      const sameMcpOrigin = target.origin === origin;
      const trustedOAuthOrigin = config.oauthProvider?.allowsAuthorizationServerUrl(target) ?? false;
      if (!sameMcpOrigin && !trustedOAuthOrigin) {
        throw new Error("Remote MCP request attempted to leave its configured or explicitly trusted OAuth origins.");
      }
      const response = await (this.fetchImpl as any)(target, { ...init, redirect: "manual", ...(dispatcher ? { dispatcher } : {}) });
      if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error("Remote MCP and OAuth redirects are forbidden; configure canonical endpoint URLs.");
      return response;
    };
    const { headers: _secretHeaders, tls: _secretTls, oauthProvider: _oauthProvider, ...publicConfig } = config;
    const normalized: McpConfig = { ...publicConfig, kind: "streamable-http" };
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers },
      ...(config.oauthProvider ? { authProvider: config.oauthProvider as OAuthClientProvider } : {}),
      fetch: secureFetch,
      reconnectionOptions: {
        initialReconnectionDelay: 500,
        maxReconnectionDelay: 10_000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 3,
      },
    });
    let server: ConnectedServer | undefined;
    const client = this.clientFor(config.name, config.tenantId ?? "system", () => server);
    return { normalized, client, transport, ...(dispatcher ? { dispatcher } : {}) };
  }

  private serializePendingConfig(config: McpHttpConfig): PersistedMcpHttpOAuthConfig {
    if (!config.oauthProvider) throw new Error("MCP OAuth provider is required for restart coordination.");
    return {
      name: config.name,
      ...(config.tenantId ? { tenantId: config.tenantId } : {}),
      url: config.url,
      ...(config.headers ? { headers: { ...config.headers } } : {}),
      ...(config.tls ? {
        tls: {
          certificateBase64: Buffer.from(config.tls.certificate).toString("base64"),
          privateKeyBase64: Buffer.from(config.tls.privateKey).toString("base64"),
          ...(config.tls.certificateAuthority ? { certificateAuthorityBase64: Buffer.from(config.tls.certificateAuthority).toString("base64") } : {}),
          ...(config.tls.serverName ? { serverName: config.tls.serverName } : {}),
        },
      } : {}),
      oauth: config.oauthProvider.resumeOptions(),
      ...(config.defaultRisk ? { defaultRisk: config.defaultRisk } : {}),
      ...(config.toolTimeoutMs ? { toolTimeoutMs: config.toolTimeoutMs } : {}),
      ...(config.allowPlainHttp !== undefined ? { allowPlainHttp: config.allowPlainHttp } : {}),
      ...(config.circuitFailureThreshold ? { circuitFailureThreshold: config.circuitFailureThreshold } : {}),
      ...(config.circuitResetMs ? { circuitResetMs: config.circuitResetMs } : {}),
    };
  }

  private deserializePendingConfig(value: PersistedMcpHttpOAuthConfig): McpHttpConfig {
    if (!this.credentialBroker) throw new Error("MCP OAuth restart coordination requires a credential broker.");
    const providerServer = new URL(value.oauth.serverUrl);
    const configuredServer = new URL(value.url);
    if (providerServer.toString() !== configuredServer.toString()) throw new Error("MCP OAuth pending provider/server binding mismatch.");
    if (value.tenantId && value.oauth.tenantId !== value.tenantId) throw new Error("MCP OAuth pending tenant binding mismatch.");
    const oauthProvider = new BrokerBackedMcpOAuthProvider({ ...value.oauth, broker: this.credentialBroker });
    return {
      name: value.name,
      ...(value.tenantId ? { tenantId: value.tenantId } : {}),
      url: value.url,
      ...(value.headers ? { headers: { ...value.headers } } : {}),
      ...(value.tls ? {
        tls: {
          certificate: Buffer.from(value.tls.certificateBase64, "base64"),
          privateKey: Buffer.from(value.tls.privateKeyBase64, "base64"),
          ...(value.tls.certificateAuthorityBase64 ? { certificateAuthority: Buffer.from(value.tls.certificateAuthorityBase64, "base64") } : {}),
          ...(value.tls.serverName ? { serverName: value.tls.serverName } : {}),
        },
      } : {}),
      oauthProvider,
      ...(value.defaultRisk ? { defaultRisk: value.defaultRisk } : {}),
      ...(value.toolTimeoutMs ? { toolTimeoutMs: value.toolTimeoutMs } : {}),
      ...(value.allowPlainHttp !== undefined ? { allowPlainHttp: value.allowPlainHttp } : {}),
      ...(value.circuitFailureThreshold ? { circuitFailureThreshold: value.circuitFailureThreshold } : {}),
      ...(value.circuitResetMs ? { circuitResetMs: value.circuitResetMs } : {}),
    };
  }

  private async purgePendingOAuth(): Promise<void> {
    const now = Date.now();
    const expired = await this.oauthPendingStore?.purgeExpired(now) ?? [];
    for (const descriptor of expired) {
      const live = this.pendingOAuth.get(descriptor.connectionId);
      if (live) {
        this.pendingOAuth.delete(descriptor.connectionId);
        await live.provider.clearAuthorizationAttempt().catch(() => undefined);
        await live.client.close().catch(() => undefined);
        await live.dispatcher?.close().catch(() => undefined);
      } else if (this.credentialBroker) {
        const provider = new BrokerBackedMcpOAuthProvider({ ...descriptor.config.oauth, broker: this.credentialBroker });
        await provider.clearAuthorizationAttempt().catch(() => undefined);
      }
    }
    const cutoff = now - this.oauthPendingTtlMs;
    for (const [id, pending] of this.pendingOAuth) {
      if (pending.createdAt > cutoff) continue;
      this.pendingOAuth.delete(id);
      await this.oauthPendingStore?.removeByConnectionId(id).catch(() => false);
      await pending.provider.clearAuthorizationAttempt().catch(() => undefined);
      await pending.client.close().catch(() => undefined);
      await pending.dispatcher?.close().catch(() => undefined);
    }
  }

  private async restorePending(descriptor: PersistedMcpOAuthPendingDescriptor): Promise<PendingOAuthConnection> {
    const live = this.pendingOAuth.get(descriptor.connectionId);
    if (live) return live;
    if (this.servers.has(descriptor.config.name)) throw new Error(`MCP server ${descriptor.config.name} is already connected.`);
    const config = this.deserializePendingConfig(descriptor.config);
    const prepared = await this.prepareHttpConnection(config);
    const pending: PendingOAuthConnection = {
      id: descriptor.connectionId,
      config: prepared.normalized,
      client: prepared.client,
      transport: prepared.transport,
      provider: config.oauthProvider!,
      ...(prepared.dispatcher ? { dispatcher: prepared.dispatcher } : {}),
      createdAt: descriptor.createdAt,
    };
    this.pendingOAuth.set(pending.id, pending);
    return pending;
  }

  private async withOAuthLock<T>(connectionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.oauthLocks.get(connectionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    this.oauthLocks.set(connectionId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.oauthLocks.get(connectionId) === current) this.oauthLocks.delete(connectionId);
    }
  }

  async finishHttpOAuth(input: { connectionId: string; code: string; state: string }): Promise<{ name: string; capabilityIds: string[] }> {
    await this.purgePendingOAuth();
    const exists = this.pendingOAuth.has(input.connectionId)
      || Boolean(await this.oauthPendingStore?.loadByConnectionId(input.connectionId));
    if (!exists) throw new McpOAuthPendingNotFoundError();
    return await this.withOAuthLock(input.connectionId, async () => {
      let pending = this.pendingOAuth.get(input.connectionId);
      if (!pending) {
        const descriptor = await this.oauthPendingStore?.loadByConnectionId(input.connectionId);
        if (descriptor) pending = await this.restorePending(descriptor);
      }
      if (!pending) throw new McpOAuthPendingNotFoundError();
      return await this.completeHttpOAuth(pending, input.code, input.state);
    });
  }

  async finishHttpOAuthByState(input: { code: string; state: string }): Promise<{ name: string; capabilityIds: string[] }> {
    await this.purgePendingOAuth();
    const descriptor = await this.oauthPendingStore?.loadByState(input.state);
    let connectionId = descriptor?.connectionId;
    if (!connectionId) {
      for (const candidate of this.pendingOAuth.values()) {
        if (await candidate.provider.matchesState(input.state)) {
          connectionId = candidate.id;
          break;
        }
      }
    }
    if (!connectionId) throw new McpOAuthPendingNotFoundError();
    return await this.withOAuthLock(connectionId, async () => {
      const currentDescriptor = await this.oauthPendingStore?.loadByState(input.state);
      let pending = currentDescriptor ? await this.restorePending(currentDescriptor) : this.pendingOAuth.get(connectionId!);
      if (!pending || !await pending.provider.matchesState(input.state)) throw new McpOAuthPendingNotFoundError();
      return await this.completeHttpOAuth(pending, input.code, input.state);
    });
  }

  private async completeHttpOAuth(pending: PendingOAuthConnection, code: string, state: string): Promise<{ name: string; capabilityIds: string[] }> {
    await pending.provider.validateState(state);
    try {
      await pending.transport.finishAuth(code);
      await pending.client.connect(pending.transport as unknown as Transport);
      const connected: ConnectedServer = {
        config: pending.config,
        client: pending.client,
        transport: pending.transport,
        ...(pending.dispatcher ? { dispatcher: pending.dispatcher } : {}),
        capabilities: [],
        capabilityIds: [],
        failureCount: 0,
        circuitOpenUntil: 0,
      };
      await this.syncTools(connected, (await pending.client.listTools()).tools);
      this.servers.set(pending.config.name, connected);
      this.pendingOAuth.delete(pending.id);
      await this.oauthPendingStore?.removeByConnectionId(pending.id);
      await pending.provider.clearAuthorizationAttempt();
      return { name: connected.config.name, capabilityIds: [...connected.capabilityIds] };
    } catch (error) {
      this.pendingOAuth.delete(pending.id);
      await this.oauthPendingStore?.removeByConnectionId(pending.id).catch(() => false);
      await pending.provider.clearAuthorizationAttempt().catch(() => undefined);
      await pending.client.close().catch(() => undefined);
      await pending.dispatcher?.close().catch(() => undefined);
      throw error;
    }
  }

  async cancelHttpOAuth(connectionId: string): Promise<boolean> {
    const exists = this.pendingOAuth.has(connectionId)
      || Boolean(await this.oauthPendingStore?.loadByConnectionId(connectionId));
    if (!exists) return false;
    return await this.withOAuthLock(connectionId, async () => {
      const pending = this.pendingOAuth.get(connectionId);
      const descriptor = pending ? undefined : await this.oauthPendingStore?.loadByConnectionId(connectionId);
      if (!pending && !descriptor) return false;
      this.pendingOAuth.delete(connectionId);
      await this.oauthPendingStore?.removeByConnectionId(connectionId).catch(() => false);
      const provider = pending?.provider ?? (descriptor && this.credentialBroker
        ? new BrokerBackedMcpOAuthProvider({ ...descriptor.config.oauth, broker: this.credentialBroker })
        : undefined);
      await provider?.clearAuthorizationAttempt().catch(() => undefined);
      await pending?.client.close().catch(() => undefined);
      await pending?.dispatcher?.close().catch(() => undefined);
      return true;
    });
  }

  async cancelHttpOAuthByState(state: string): Promise<boolean> {
    await this.purgePendingOAuth();
    const descriptor = await this.oauthPendingStore?.loadByState(state);
    let connectionId = descriptor?.connectionId;
    if (!connectionId) {
      for (const candidate of this.pendingOAuth.values()) {
        if (await candidate.provider.matchesState(state)) {
          connectionId = candidate.id;
          break;
        }
      }
    }
    if (!connectionId) return false;
    return await this.withOAuthLock(connectionId, async () => {
      const currentDescriptor = await this.oauthPendingStore?.loadByState(state);
      const pending = this.pendingOAuth.get(connectionId!);
      const provider = pending?.provider ?? (currentDescriptor && this.credentialBroker
        ? new BrokerBackedMcpOAuthProvider({ ...currentDescriptor.config.oauth, broker: this.credentialBroker })
        : undefined);
      if (!provider || !await provider.matchesState(state)) return false;
      this.pendingOAuth.delete(connectionId!);
      await this.oauthPendingStore?.removeByState(state).catch(() => false);
      await provider.clearAuthorizationAttempt().catch(() => undefined);
      await pending?.client.close().catch(() => undefined);
      await pending?.dispatcher?.close().catch(() => undefined);
      return true;
    });
  }

  private buildCapabilities(server: ConnectedServer, tools: any[]): Capability[] {
    return tools.map((tool): Capability => {
      const id = `mcp.${slug(server.config.name)}.${slug(tool.name)}`;
      const risk: CapabilityRisk = tool.annotations?.readOnlyHint === true
        ? "network"
        : server.config.defaultRisk ?? (tool.annotations?.destructiveHint === true ? "external_side_effect" : "network");
      return {
        descriptor: {
          id,
          version: "1.0.0",
          description: `${tool.description ?? tool.name} (MCP server: ${server.config.name})`,
          risk,
          sideEffect: tool.annotations?.readOnlyHint !== true,
          inputSchema: asJsonValue(tool.inputSchema ?? { type: "object" }),
          source: "mcp",
        },
        validate(input: unknown) {
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`MCP tool ${tool.name} expects an object input.`);
          return input as Record<string, JsonValue>;
        },
        execute: async (input, context) => {
          const now = Date.now();
          if (server.circuitOpenUntil > now) throw new Error(`MCP server ${server.config.name} circuit is open.`);
          if (server.circuitOpenUntil && server.circuitOpenUntil <= now) {
            server.circuitOpenUntil = 0;
            server.failureCount = 0;
          }
          try {
            const result = await server.client.callTool(
              { name: tool.name, arguments: input },
              undefined,
              {
                timeout: Math.min(10 * 60_000, Math.max(1000, server.config.toolTimeoutMs ?? 120_000)),
                ...(context.signal ? { signal: context.signal } : {}),
              },
            );
            server.failureCount = 0;
            return asJsonValue(result);
          } catch (error) {
            server.failureCount++;
            const threshold = server.config.kind === "streamable-http" ? server.config.circuitFailureThreshold ?? 3 : 3;
            if (server.failureCount >= threshold) {
              const resetMs = server.config.kind === "streamable-http" ? server.config.circuitResetMs ?? 30_000 : 30_000;
              server.circuitOpenUntil = Date.now() + resetMs;
            }
            throw error;
          }
        },
      };
    });
  }

  private async syncTools(server: ConnectedServer, tools: any[]): Promise<void> {
    const next = this.buildCapabilities(server, tools);
    const ids = next.map((capability) => capability.descriptor.id);
    if (new Set(ids).size !== ids.length) throw new Error(`MCP server ${server.config.name} exposed colliding normalized tool names.`);
    const previous = server.capabilities;
    for (const capability of previous) this.broker.unregister(capability.descriptor.id);
    const registered: Capability[] = [];
    try {
      for (const capability of next) {
        this.broker.register(capability);
        registered.push(capability);
      }
      server.capabilities = next;
      server.capabilityIds = ids;
      await this.persistSchemaCache(server).catch(() => undefined);
    } catch (error) {
      for (const capability of registered) this.broker.unregister(capability.descriptor.id);
      for (const capability of previous) this.broker.register(capability);
      throw error;
    }
  }

  async disconnect(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) return;
    for (const id of server.capabilityIds) this.broker.unregister(id);
    await server.client.close();
    await server.dispatcher?.close().catch(() => undefined);
    this.servers.delete(name);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((name) => this.disconnect(name)));
    // Pending browser authorizations are suspended, not cancelled: their encrypted
    // descriptors let a replacement control process resume the callback safely.
    const pending = [...this.pendingOAuth.values()];
    this.pendingOAuth.clear();
    await Promise.all(pending.map(async (item) => {
      await item.client.close().catch(() => undefined);
      await item.dispatcher?.close().catch(() => undefined);
    }));
  }
}
