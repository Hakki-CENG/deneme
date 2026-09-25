import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../util/atomic-file.js";

export interface SecretMetadata {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

interface EncryptedSecret extends SecretMetadata {
  iv: string;
  tag: string;
  ciphertext: string;
}

interface CredentialLease {
  id: string;
  secretId: string;
  tenantId: string;
  capabilityId: string;
  audience: string;
  expiresAt: number;
  remainingUses: number;
}

export interface CredentialLeaseRequest {
  tenantId: string;
  secretId: string;
  capabilityId: string;
  audience: string;
  ttlMs?: number;
  maxUses?: number;
}

export interface CredentialLeaseRedemption {
  leaseId: string;
  tenantId: string;
  capabilityId: string;
  audience: string;
}

export interface CredentialBrokerLike {
  readonly persistentAcrossRestart: boolean;
  put(input: { tenantId: string; name: string; value: string; description?: string }): Promise<SecretMetadata>;
  list(tenantId: string): Promise<SecretMetadata[]>;
  remove(tenantId: string, id: string): Promise<boolean>;
  issueLease(input: CredentialLeaseRequest): Promise<{ leaseId: string; expiresAt: string }>;
  redeemLease(input: CredentialLeaseRedemption): Promise<string>;
  revokeLease(leaseId: string): boolean;
  purgeExpired(): number;
}

function deriveKey(input?: string): Buffer {
  if (!input) return randomBytes(32);
  if (/^[a-f0-9]{64}$/i.test(input)) return Buffer.from(input, "hex");
  try {
    const decoded = Buffer.from(input, "base64");
    if (decoded.length === 32) return decoded;
  } catch {}
  return scryptSync(input, "haf-local-credential-broker-v1", 32);
}

export class CredentialBroker implements CredentialBrokerLike {
  private readonly key: Buffer;
  private secrets: EncryptedSecret[] = [];
  private readonly leases = new Map<string, CredentialLease>();
  private loaded = false;
  private readonly hasPersistentKey: boolean;

  constructor(
    private readonly rootPath: string,
    masterKey?: string,
  ) {
    this.key = deriveKey(masterKey);
    this.hasPersistentKey = Boolean(masterKey);
  }

  get persistentAcrossRestart(): boolean {
    return this.hasPersistentKey;
  }

  private get path(): string {
    return join(this.rootPath, "credentials", "secrets.json");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.secrets = Array.isArray(parsed) ? parsed as EncryptedSecret[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify(this.secrets, null, 2)}\n`);
  }

  private encrypt(value: string): Pick<EncryptedSecret, "iv" | "tag" | "ciphertext"> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: encrypted.toString("base64"),
    };
  }

  private decrypt(secret: EncryptedSecret): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(secret.iv, "base64"));
    decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  async put(input: {
    tenantId: string;
    name: string;
    value: string;
    description?: string;
  }): Promise<SecretMetadata> {
    await this.load();
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(input.name)) throw new Error("Secret name must be an uppercase environment-style identifier.");
    if (!input.value) throw new Error("Secret value cannot be empty.");
    const now = new Date().toISOString();
    let secret = this.secrets.find((item) => item.tenantId === input.tenantId && item.name === input.name);
    if (secret) {
      Object.assign(secret, this.encrypt(input.value));
      secret.updatedAt = now;
      secret.version++;
      if (input.description !== undefined) secret.description = input.description;
    } else {
      secret = {
        id: randomUUID(),
        tenantId: input.tenantId,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        createdAt: now,
        updatedAt: now,
        version: 1,
        ...this.encrypt(input.value),
      };
      this.secrets.push(secret);
    }
    await this.save();
    return this.metadata(secret);
  }

  /**
   * P2.41 secret rotation: replace a secret's value and, critically, kill
   * every outstanding lease for it. A rotated secret whose old leases kept
   * redeeming would make rotation cosmetic — the old value would still be
   * reachable until each lease expired on its own. Redemption attempts after
   * rotation fail with the lease-missing error, which is the fail-closed
   * outcome. Rotation bumps the version and stamps updatedAt, so an operator
   * can verify the rotation actually happened from metadata alone.
   */
  async rotate(input: { tenantId: string; name: string; value: string }): Promise<SecretMetadata> {
    await this.load();
    if (!input.value) throw new Error("Secret value cannot be empty.");
    const secret = this.secrets.find((item) => item.tenantId === input.tenantId && item.name === input.name);
    if (!secret) throw new Error(`Secret ${input.name} not found for tenant ${input.tenantId}.`);
    Object.assign(secret, this.encrypt(input.value));
    secret.updatedAt = new Date().toISOString();
    secret.version++;
    for (const [leaseId, lease] of this.leases) {
      if (lease.secretId === secret.id) this.leases.delete(leaseId);
    }
    await this.save();
    return this.metadata(secret);
  }

  async list(tenantId: string): Promise<SecretMetadata[]> {
    await this.load();
    return this.secrets.filter((secret) => secret.tenantId === tenantId).map((secret) => this.metadata(secret));
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    await this.load();
    const before = this.secrets.length;
    this.secrets = this.secrets.filter((secret) => !(secret.tenantId === tenantId && secret.id === id));
    if (this.secrets.length !== before) await this.save();
    for (const [leaseId, lease] of this.leases) if (lease.secretId === id) this.leases.delete(leaseId);
    return this.secrets.length !== before;
  }

  async issueLease(input: CredentialLeaseRequest): Promise<{ leaseId: string; expiresAt: string }> {
    await this.load();
    const secret = this.secrets.find((item) => item.id === input.secretId && item.tenantId === input.tenantId);
    if (!secret) throw new Error("Secret does not exist in this tenant.");
    const ttlMs = Math.min(Math.max(input.ttlMs ?? 60_000, 1000), 15 * 60_000);
    const id = randomUUID();
    const lease: CredentialLease = {
      id,
      secretId: secret.id,
      tenantId: input.tenantId,
      capabilityId: input.capabilityId,
      audience: input.audience,
      expiresAt: Date.now() + ttlMs,
      remainingUses: Math.min(Math.max(input.maxUses ?? 1, 1), 100),
    };
    this.leases.set(id, lease);
    return { leaseId: id, expiresAt: new Date(lease.expiresAt).toISOString() };
  }

  /** Internal execution-plane API. Never expose this value through REST/model results. */
  async redeemLease(input: CredentialLeaseRedemption): Promise<string> {
    await this.load();
    const lease = this.leases.get(input.leaseId);
    if (!lease) throw new Error("Credential lease is missing or already exhausted.");
    if (lease.expiresAt <= Date.now()) {
      this.leases.delete(lease.id);
      throw new Error("Credential lease expired.");
    }
    if (lease.tenantId !== input.tenantId || lease.capabilityId !== input.capabilityId || lease.audience !== input.audience) {
      throw new Error("Credential lease scope mismatch.");
    }
    const secret = this.secrets.find((item) => item.id === lease.secretId && item.tenantId === lease.tenantId);
    if (!secret) throw new Error("Leased secret no longer exists.");
    lease.remainingUses--;
    if (lease.remainingUses <= 0) this.leases.delete(lease.id);
    return this.decrypt(secret);
  }

  revokeLease(leaseId: string): boolean {
    return this.leases.delete(leaseId);
  }

  purgeExpired(): number {
    let removed = 0;
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt <= Date.now()) {
        this.leases.delete(id);
        removed++;
      }
    }
    return removed;
  }

  private metadata(secret: EncryptedSecret): SecretMetadata {
    return {
      id: secret.id,
      tenantId: secret.tenantId,
      name: secret.name,
      ...(secret.description ? { description: secret.description } : {}),
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
      version: secret.version,
    };
  }
}
