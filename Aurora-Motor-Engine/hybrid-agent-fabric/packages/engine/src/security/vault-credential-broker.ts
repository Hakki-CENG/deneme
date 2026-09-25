import { createHash, randomBytes } from "node:crypto";
import type {
  CredentialBrokerLike,
  CredentialLeaseRedemption,
  CredentialLeaseRequest,
  SecretMetadata,
} from "./credential-broker.js";

export interface VaultCredentialBrokerOptions {
  address: string;
  token: string;
  namespace?: string;
  mount?: string;
  prefix?: string;
  maxLeaseTtlMs?: number;
}

interface VaultLease {
  secretId: string;
  tenantId: string;
  capabilityId: string;
  audience: string;
  expiresAt: number;
  remainingUses: number;
}

interface SecretLocation {
  tenantId: string;
  name: string;
}

function segment(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error("Vault path segment is invalid.");
  return encodeURIComponent(value);
}

function secretId(tenantId: string, name: string): string {
  return createHash("sha256").update(`${tenantId}\0${name}`).digest("base64url");
}

export class VaultCredentialBroker implements CredentialBrokerLike {
  readonly persistentAcrossRestart = true;
  private readonly address: string;
  private readonly mount: string;
  private readonly prefix: string;
  private readonly leases = new Map<string, VaultLease>();
  private readonly locations = new Map<string, SecretLocation>();

  constructor(private readonly options: VaultCredentialBrokerOptions) {
    const address = new URL(options.address);
    if (address.protocol !== "https:" && address.protocol !== "http:") throw new Error("Vault address must use HTTP(S).");
    this.address = address.toString().replace(/\/$/, "");
    this.mount = options.mount ?? "secret";
    this.prefix = options.prefix ?? "haf";
    segment(this.mount); segment(this.prefix);
  }

  async put(input: { tenantId: string; name: string; value: string; description?: string }): Promise<SecretMetadata> {
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(input.name)) throw new Error("Secret name must be an uppercase environment-style identifier.");
    if (!input.value) throw new Error("Secret value cannot be empty.");
    const now = new Date().toISOString();
    const id = secretId(input.tenantId, input.name);
    const existing = await this.readSecret(input.tenantId, input.name).catch(() => undefined);
    const metadata: SecretMetadata = {
      id,
      tenantId: input.tenantId,
      name: input.name,
      ...(input.description ? { description: input.description } : existing?.metadata.description ? { description: existing.metadata.description } : {}),
      createdAt: existing?.metadata.createdAt ?? now,
      updatedAt: now,
      version: (existing?.metadata.version ?? 0) + 1,
    };
    await this.request("POST", this.dataPath(input.tenantId, input.name), {
      data: { value: input.value, metadata },
    });
    this.locations.set(id, { tenantId: input.tenantId, name: input.name });
    return metadata;
  }

  async list(tenantId: string): Promise<SecretMetadata[]> {
    const result = await this.request("LIST", this.metadataTenantPath(tenantId));
    const keys = Array.isArray(result?.data?.keys) ? result.data.keys.filter((key: unknown): key is string => typeof key === "string" && !key.endsWith("/")) : [];
    const output: SecretMetadata[] = [];
    for (const name of keys) {
      try {
        const secret = await this.readSecret(tenantId, name);
        output.push(secret.metadata);
        this.locations.set(secret.metadata.id, { tenantId, name });
      } catch {
        // A concurrently deleted/malformed secret does not hide the rest.
      }
    }
    return output;
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const location = await this.resolveLocation(tenantId, id);
    if (!location) return false;
    await this.request("DELETE", this.metadataPath(location.tenantId, location.name));
    this.locations.delete(id);
    for (const [leaseId, lease] of this.leases) if (lease.secretId === id) this.leases.delete(leaseId);
    return true;
  }

  async issueLease(input: CredentialLeaseRequest): Promise<{ leaseId: string; expiresAt: string }> {
    const location = await this.resolveLocation(input.tenantId, input.secretId);
    if (!location) throw new Error("Secret does not exist in this tenant.");
    const ttl = Math.min(Math.max(input.ttlMs ?? 60_000, 1000), this.options.maxLeaseTtlMs ?? 15 * 60_000);
    const leaseId = randomBytes(32).toString("base64url");
    const lease: VaultLease = {
      secretId: input.secretId,
      tenantId: input.tenantId,
      capabilityId: input.capabilityId,
      audience: input.audience,
      expiresAt: Date.now() + ttl,
      remainingUses: Math.min(Math.max(input.maxUses ?? 1, 1), 100),
    };
    this.leases.set(leaseId, lease);
    return { leaseId, expiresAt: new Date(lease.expiresAt).toISOString() };
  }

  async redeemLease(input: CredentialLeaseRedemption): Promise<string> {
    const lease = this.leases.get(input.leaseId);
    if (!lease) throw new Error("Credential lease is missing or already exhausted.");
    if (lease.expiresAt <= Date.now()) {
      this.leases.delete(input.leaseId);
      throw new Error("Credential lease expired.");
    }
    if (lease.tenantId !== input.tenantId || lease.capabilityId !== input.capabilityId || lease.audience !== input.audience) {
      throw new Error("Credential lease scope mismatch.");
    }
    const location = await this.resolveLocation(input.tenantId, lease.secretId);
    if (!location) throw new Error("Leased secret no longer exists.");
    const secret = await this.readSecret(location.tenantId, location.name);
    lease.remainingUses--;
    if (lease.remainingUses <= 0) this.leases.delete(input.leaseId);
    return secret.value;
  }

  revokeLease(leaseId: string): boolean { return this.leases.delete(leaseId); }
  purgeExpired(): number {
    let removed = 0;
    for (const [id, lease] of this.leases) if (lease.expiresAt <= Date.now()) { this.leases.delete(id); removed++; }
    return removed;
  }

  async health(): Promise<boolean> {
    try { await this.request("GET", "/v1/sys/health"); return true; } catch { return false; }
  }

  private async resolveLocation(tenantId: string, id: string): Promise<SecretLocation | undefined> {
    const cached = this.locations.get(id);
    if (cached?.tenantId === tenantId) return cached;
    await this.list(tenantId);
    const resolved = this.locations.get(id);
    return resolved?.tenantId === tenantId ? resolved : undefined;
  }

  private async readSecret(tenantId: string, name: string): Promise<{ value: string; metadata: SecretMetadata }> {
    const result = await this.request("GET", this.dataPath(tenantId, name));
    const data = result?.data?.data;
    if (!data || typeof data.value !== "string" || !data.metadata) throw new Error("Vault secret payload is invalid.");
    return { value: data.value, metadata: data.metadata as SecretMetadata };
  }

  private dataPath(tenantId: string, name: string): string {
    return `/v1/${segment(this.mount)}/data/${segment(this.prefix)}/${segment(tenantId)}/${segment(name)}`;
  }
  private metadataPath(tenantId: string, name: string): string {
    return `/v1/${segment(this.mount)}/metadata/${segment(this.prefix)}/${segment(tenantId)}/${segment(name)}`;
  }
  private metadataTenantPath(tenantId: string): string {
    return `/v1/${segment(this.mount)}/metadata/${segment(this.prefix)}/${segment(tenantId)}`;
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.address}${path}`, {
      method,
      headers: {
        "x-vault-token": this.options.token,
        ...(this.options.namespace ? { "x-vault-namespace": this.options.namespace } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Vault request failed with HTTP ${response.status}.`);
    if (response.status === 204) return {};
    return await response.json();
  }
}
