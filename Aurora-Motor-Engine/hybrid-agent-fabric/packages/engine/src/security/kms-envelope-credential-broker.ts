import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../util/atomic-file.js";
import type {
  CredentialBrokerLike,
  CredentialLeaseRedemption,
  CredentialLeaseRequest,
  SecretMetadata,
} from "./credential-broker.js";

export interface KmsProvider {
  readonly id: string;
  generateDataKey(context: Record<string, string>): Promise<{ plaintextKey: Buffer; encryptedKey: Buffer }>;
  decryptDataKey(encryptedKey: Buffer, context: Record<string, string>): Promise<Buffer>;
}

interface EnvelopeSecret extends SecretMetadata {
  kmsProvider: string;
  encryptedDataKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface EnvelopeLease {
  secretId: string;
  tenantId: string;
  capabilityId: string;
  audience: string;
  expiresAt: number;
  remainingUses: number;
}

export class KmsEnvelopeCredentialBroker implements CredentialBrokerLike {
  readonly persistentAcrossRestart = true;
  private secrets: EnvelopeSecret[] = [];
  private loaded = false;
  private readonly leases = new Map<string, EnvelopeLease>();

  constructor(
    private readonly rootPath: string,
    private readonly kms: KmsProvider,
  ) {}

  private get path(): string { return join(this.rootPath, "credentials", "kms-envelopes.json"); }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.secrets = Array.isArray(parsed) ? parsed as EnvelopeSecret[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }
  private async save(): Promise<void> { await atomicWrite(this.path, `${JSON.stringify(this.secrets, null, 2)}\n`); }

  async put(input: { tenantId: string; name: string; value: string; description?: string }): Promise<SecretMetadata> {
    await this.load();
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(input.name) || !input.value) throw new Error("Secret name/value is invalid.");
    const existing = this.secrets.find((item) => item.tenantId === input.tenantId && item.name === input.name);
    const id = existing?.id ?? randomUUID();
    const context = { tenantId: input.tenantId, secretId: id, name: input.name };
    const dataKey = await this.kms.generateDataKey(context);
    if (dataKey.plaintextKey.length !== 32) throw new Error("KMS plaintext data key must contain 32 bytes.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dataKey.plaintextKey, iv);
    const ciphertext = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
    dataKey.plaintextKey.fill(0);
    const now = new Date().toISOString();
    const record: EnvelopeSecret = {
      id,
      tenantId: input.tenantId,
      name: input.name,
      ...(input.description ? { description: input.description } : existing?.description ? { description: existing.description } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
      kmsProvider: this.kms.id,
      encryptedDataKey: dataKey.encryptedKey.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    if (existing) this.secrets[this.secrets.indexOf(existing)] = record;
    else this.secrets.push(record);
    await this.save();
    return this.metadata(record);
  }

  async list(tenantId: string): Promise<SecretMetadata[]> {
    await this.load();
    return this.secrets.filter((item) => item.tenantId === tenantId).map((item) => this.metadata(item));
  }
  async remove(tenantId: string, id: string): Promise<boolean> {
    await this.load();
    const before = this.secrets.length;
    this.secrets = this.secrets.filter((item) => !(item.tenantId === tenantId && item.id === id));
    if (before !== this.secrets.length) await this.save();
    for (const [leaseId, lease] of this.leases) if (lease.secretId === id) this.leases.delete(leaseId);
    return before !== this.secrets.length;
  }

  async issueLease(input: CredentialLeaseRequest): Promise<{ leaseId: string; expiresAt: string }> {
    await this.load();
    if (!this.secrets.some((item) => item.id === input.secretId && item.tenantId === input.tenantId)) throw new Error("Secret does not exist in this tenant.");
    const ttl = Math.min(Math.max(input.ttlMs ?? 60_000, 1000), 15 * 60_000);
    const leaseId = randomBytes(32).toString("base64url");
    const lease: EnvelopeLease = {
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
    await this.load();
    const lease = this.leases.get(input.leaseId);
    if (!lease || lease.expiresAt <= Date.now()) {
      this.leases.delete(input.leaseId);
      throw new Error("Credential lease is missing or expired.");
    }
    if (lease.tenantId !== input.tenantId || lease.capabilityId !== input.capabilityId || lease.audience !== input.audience) throw new Error("Credential lease scope mismatch.");
    const secret = this.secrets.find((item) => item.id === lease.secretId && item.tenantId === lease.tenantId);
    if (!secret) throw new Error("Leased secret no longer exists.");
    const context = { tenantId: secret.tenantId, secretId: secret.id, name: secret.name };
    const key = await this.kms.decryptDataKey(Buffer.from(secret.encryptedDataKey, "base64"), context);
    if (key.length !== 32) throw new Error("KMS decrypted an invalid data key.");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.iv, "base64"));
      decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
      const value = Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]).toString("utf8");
      lease.remainingUses--;
      if (lease.remainingUses <= 0) this.leases.delete(input.leaseId);
      return value;
    } finally { key.fill(0); }
  }

  revokeLease(leaseId: string): boolean { return this.leases.delete(leaseId); }
  purgeExpired(): number {
    let count = 0;
    for (const [id, lease] of this.leases) if (lease.expiresAt <= Date.now()) { this.leases.delete(id); count++; }
    return count;
  }
  private metadata(item: EnvelopeSecret): SecretMetadata {
    return {
      id: item.id, tenantId: item.tenantId, name: item.name,
      ...(item.description ? { description: item.description } : {}),
      createdAt: item.createdAt, updatedAt: item.updatedAt, version: item.version,
    };
  }
}
