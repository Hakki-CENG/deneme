import { createHash } from "node:crypto";
import type { CapabilityRisk } from "../types.js";
import type { CredentialBrokerLike, SecretMetadata } from "../security/credential-broker.js";
import type { BrokerBackedMcpOAuthResumeOptions } from "./mcp-oauth-provider.js";

const INTERNAL_TENANT = "__haf_internal_mcp_oauth_pending__";
const SECRET_PREFIX = "HAF_MCP_OAUTH_PENDING_";
const CAPABILITY_ID = "mcp.oauth.pending";
const AUDIENCE = "haf-internal:mcp-oauth-pending";
const MAX_PENDING_RECORDS = 1_000;
const MAX_ENCODED_BYTES = 6 * 1024 * 1024;

export interface PersistedMcpTlsOptions {
  certificateBase64: string;
  privateKeyBase64: string;
  certificateAuthorityBase64?: string;
  serverName?: string;
}

export interface PersistedMcpHttpOAuthConfig {
  name: string;
  tenantId?: string;
  url: string;
  headers?: Record<string, string>;
  tls?: PersistedMcpTlsOptions;
  oauth: BrokerBackedMcpOAuthResumeOptions;
  defaultRisk?: CapabilityRisk;
  toolTimeoutMs?: number;
  allowPlainHttp?: boolean;
  circuitFailureThreshold?: number;
  circuitResetMs?: number;
}

export interface PersistedMcpOAuthPendingDescriptor {
  schemaVersion: 1;
  connectionId: string;
  createdAt: number;
  expiresAt: number;
  config: PersistedMcpHttpOAuthConfig;
}

interface StoredPending {
  metadata: SecretMetadata;
  descriptor: PersistedMcpOAuthPendingDescriptor;
}

/**
 * Stores restart coordination inside the Credential Broker. Raw OAuth state and
 * transport credentials never enter a plaintext journal, API response or schema cache.
 */
export class McpOAuthPendingStore {
  constructor(private readonly broker: CredentialBrokerLike) {}

  get persistentAcrossRestart(): boolean {
    return this.broker.persistentAcrossRestart;
  }

  private secretName(state: string): string {
    const digest = createHash("sha256").update(state).digest("hex").toUpperCase();
    return `${SECRET_PREFIX}${digest}`;
  }

  async save(state: string, descriptor: PersistedMcpOAuthPendingDescriptor): Promise<void> {
    const value = JSON.stringify(descriptor);
    if (Buffer.byteLength(value) > MAX_ENCODED_BYTES) throw new Error("MCP OAuth pending descriptor exceeds the encrypted storage bound.");
    await this.broker.put({
      tenantId: INTERNAL_TENANT,
      name: this.secretName(state),
      value,
      description: "Encrypted restart-resumable MCP OAuth transport descriptor",
    });
  }

  async loadByState(state: string, now = Date.now()): Promise<PersistedMcpOAuthPendingDescriptor | undefined> {
    const metadata = (await this.metadata()).find((item) => item.name === this.secretName(state));
    if (!metadata) return undefined;
    const descriptor = await this.read(metadata);
    if (descriptor.expiresAt <= now) {
      await this.broker.remove(INTERNAL_TENANT, metadata.id);
      return undefined;
    }
    return descriptor;
  }

  async loadByConnectionId(connectionId: string, now = Date.now()): Promise<PersistedMcpOAuthPendingDescriptor | undefined> {
    for (const metadata of await this.metadata()) {
      const descriptor = await this.read(metadata);
      if (descriptor.expiresAt <= now) {
        await this.broker.remove(INTERNAL_TENANT, metadata.id);
        continue;
      }
      if (descriptor.connectionId === connectionId) return descriptor;
    }
    return undefined;
  }

  async hasServerName(name: string, now = Date.now()): Promise<boolean> {
    for (const metadata of await this.metadata()) {
      const descriptor = await this.read(metadata);
      if (descriptor.expiresAt <= now) {
        await this.broker.remove(INTERNAL_TENANT, metadata.id);
        continue;
      }
      if (descriptor.config.name === name) return true;
    }
    return false;
  }

  async removeByState(state: string): Promise<boolean> {
    const metadata = (await this.metadata()).find((item) => item.name === this.secretName(state));
    return metadata ? await this.broker.remove(INTERNAL_TENANT, metadata.id) : false;
  }

  async removeByConnectionId(connectionId: string): Promise<boolean> {
    for (const metadata of await this.metadata()) {
      const descriptor = await this.read(metadata);
      if (descriptor.connectionId === connectionId) return await this.broker.remove(INTERNAL_TENANT, metadata.id);
    }
    return false;
  }

  async purgeExpired(now = Date.now()): Promise<PersistedMcpOAuthPendingDescriptor[]> {
    const removed: PersistedMcpOAuthPendingDescriptor[] = [];
    for (const metadata of await this.metadata()) {
      let descriptor: PersistedMcpOAuthPendingDescriptor;
      try {
        descriptor = await this.read(metadata);
      } catch {
        // Corrupt encrypted coordination is unusable and must fail closed rather than
        // becoming an immortal callback capability.
        await this.broker.remove(INTERNAL_TENANT, metadata.id).catch(() => false);
        continue;
      }
      if (descriptor.expiresAt > now) continue;
      await this.broker.remove(INTERNAL_TENANT, metadata.id);
      removed.push(descriptor);
    }
    return removed;
  }

  private async metadata(): Promise<SecretMetadata[]> {
    const records = (await this.broker.list(INTERNAL_TENANT))
      .filter((item) => item.name.startsWith(SECRET_PREFIX));
    if (records.length > MAX_PENDING_RECORDS) throw new Error("MCP OAuth pending descriptor inventory exceeds its safety bound.");
    return records;
  }

  private async read(metadata: SecretMetadata): Promise<PersistedMcpOAuthPendingDescriptor> {
    const lease = await this.broker.issueLease({
      tenantId: INTERNAL_TENANT,
      secretId: metadata.id,
      capabilityId: CAPABILITY_ID,
      audience: AUDIENCE,
      ttlMs: 30_000,
      maxUses: 1,
    });
    const raw = await this.broker.redeemLease({
      leaseId: lease.leaseId,
      tenantId: INTERNAL_TENANT,
      capabilityId: CAPABILITY_ID,
      audience: AUDIENCE,
    });
    if (Buffer.byteLength(raw) > MAX_ENCODED_BYTES) throw new Error("MCP OAuth pending descriptor exceeds its safety bound.");
    return validatePendingDescriptor(JSON.parse(raw) as unknown);
  }
}

function validatePendingDescriptor(value: unknown): PersistedMcpOAuthPendingDescriptor {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isUuid(value.connectionId)) {
    throw new Error("MCP OAuth pending descriptor is malformed.");
  }
  if (!finiteTimestamp(value.createdAt) || !finiteTimestamp(value.expiresAt) || value.expiresAt <= value.createdAt) {
    throw new Error("MCP OAuth pending descriptor timestamps are malformed.");
  }
  const config = value.config;
  if (!isRecord(config) || !boundedText(config.name, 1, 200) || !boundedUrl(config.url)) {
    throw new Error("MCP OAuth pending transport config is malformed.");
  }
  if (config.tenantId !== undefined && !boundedText(config.tenantId, 1, 500)) throw new Error("MCP OAuth pending tenant is malformed.");
  if (config.defaultRisk !== undefined && !["pure", "workspace_read", "workspace_write", "process", "network", "external_side_effect", "privileged"].includes(String(config.defaultRisk))) {
    throw new Error("MCP OAuth pending risk is malformed.");
  }
  if (config.toolTimeoutMs !== undefined && !boundedInteger(config.toolTimeoutMs, 1_000, 600_000)) throw new Error("MCP OAuth pending timeout is malformed.");
  if (config.circuitFailureThreshold !== undefined && !boundedInteger(config.circuitFailureThreshold, 1, 100)) throw new Error("MCP OAuth pending circuit threshold is malformed.");
  if (config.circuitResetMs !== undefined && !boundedInteger(config.circuitResetMs, 1_000, 3_600_000)) throw new Error("MCP OAuth pending circuit reset is malformed.");
  if (config.allowPlainHttp !== undefined && typeof config.allowPlainHttp !== "boolean") throw new Error("MCP OAuth pending HTTP policy is malformed.");
  if (config.headers !== undefined) validateHeaders(config.headers);
  if (config.tls !== undefined) validateTls(config.tls);
  validateOAuth(config.oauth);
  return value as unknown as PersistedMcpOAuthPendingDescriptor;
}

function validateOAuth(value: unknown): void {
  if (!isRecord(value) || !boundedText(value.tenantId, 1, 500) || !boundedUrl(value.serverUrl) || !boundedUrl(value.redirectUrl)) {
    throw new Error("MCP OAuth pending provider config is malformed.");
  }
  for (const key of ["clientId", "clientSecret", "clientName"] as const) {
    if (value[key] !== undefined && !boundedText(value[key], 1, key === "clientSecret" ? 16_384 : 2_000)) throw new Error("MCP OAuth pending client config is malformed.");
  }
  if (value.scopes !== undefined && (!Array.isArray(value.scopes) || value.scopes.length > 50 || value.scopes.some((item) => !boundedText(item, 1, 200)))) {
    throw new Error("MCP OAuth pending scopes are malformed.");
  }
  if (value.authorizationServerOrigins !== undefined && (!Array.isArray(value.authorizationServerOrigins) || value.authorizationServerOrigins.length > 20 || value.authorizationServerOrigins.some((item) => !boundedUrl(item)))) {
    throw new Error("MCP OAuth pending authorization origins are malformed.");
  }
}

function validateHeaders(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).length > 100) throw new Error("MCP OAuth pending headers are malformed.");
  for (const [name, header] of Object.entries(value)) {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(name) || typeof header !== "string" || header.length > 8_192 || /\r|\n/.test(header)) {
      throw new Error("MCP OAuth pending headers are malformed.");
    }
  }
}

function validateTls(value: unknown): void {
  if (!isRecord(value) || !boundedBase64(value.certificateBase64) || !boundedBase64(value.privateKeyBase64)) throw new Error("MCP OAuth pending TLS config is malformed.");
  if (value.certificateAuthorityBase64 !== undefined && !boundedBase64(value.certificateAuthorityBase64)) throw new Error("MCP OAuth pending TLS CA is malformed.");
  if (value.serverName !== undefined && !boundedText(value.serverName, 1, 253)) throw new Error("MCP OAuth pending TLS server name is malformed.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function boundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}
function boundedUrl(value: unknown): value is string {
  if (!boundedText(value, 1, 8_192)) return false;
  try { new URL(value); return true; } catch { return false; }
}
function boundedInteger(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}
function boundedBase64(value: unknown): value is string {
  return typeof value === "string" && value.length >= 40 && value.length <= 1_500_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
