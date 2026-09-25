import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "../types.js";
import { atomicWrite } from "../util/atomic-file.js";
import { classifyModelFailure, type ModelProviderError } from "./model-provider-error.js";

export interface ProviderCredentialInput {
  id?: string;
  apiKey: string;
}

interface CredentialRecord {
  id: string;
  apiKey: string;
  disabled: boolean;
  cooldownUntil: number;
  failureCount: number;
  lastUsedAt?: string;
  lastFailureCode?: string;
}

export interface CredentialPoolEntryStatus {
  id: string;
  state: "available" | "cooldown" | "disabled";
  cooldownUntil?: string;
  failureCount: number;
  lastUsedAt?: string;
  lastFailureCode?: string;
}

export interface CredentialPoolStatus {
  kind: "credential-pool";
  providerId: string;
  entries: CredentialPoolEntryStatus[];
}

export interface PersistedCredentialPoolEntry {
  id: string;
  disabled: boolean;
  cooldownUntil: number;
  failureCount: number;
  lastUsedAt?: string;
  lastFailureCode?: string;
}

export interface CredentialPoolStateStore {
  load(providerId: string): PersistedCredentialPoolEntry[];
  save(providerId: string, entries: PersistedCredentialPoolEntry[]): Promise<void>;
}

export interface CredentialPoolProviderOptions {
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
  stateStore?: CredentialPoolStateStore;
}

function stableCredentialId(apiKey: string, index: number): string {
  // The digest is an opaque inventory handle; no secret prefix/suffix is exposed.
  return `credential-${index + 1}-${createHash("sha256").update(apiKey).digest("hex").slice(0, 8)}`;
}

function normalizeCredentials(inputs: ProviderCredentialInput[]): CredentialRecord[] {
  const ids = new Set<string>();
  return inputs.map((input, index) => {
    const apiKey = input.apiKey.trim();
    if (!apiKey) throw new Error("Provider credential keys must not be empty.");
    const id = input.id?.trim() || stableCredentialId(apiKey, index);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(id)) throw new Error(`Invalid provider credential id: ${id}`);
    if (ids.has(id)) throw new Error(`Duplicate provider credential id: ${id}`);
    ids.add(id);
    return { id, apiKey, disabled: false, cooldownUntil: 0, failureCount: 0 };
  });
}

export class FileCredentialPoolStateStore implements CredentialPoolStateStore {
  constructor(private readonly rootPath: string) {}
  private path(providerId: string): string {
    return join(this.rootPath, "models", "credential-pools", `${createHash("sha256").update(providerId).digest("hex")}.json`);
  }
  load(providerId: string): PersistedCredentialPoolEntry[] {
    try {
      const raw = readFileSync(this.path(providerId), "utf8");
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error("Credential pool state exceeds its safety bound.");
      const value = JSON.parse(raw) as any;
      if (!value || value.schemaVersion !== 1 || value.providerId !== providerId || !Array.isArray(value.entries) || value.entries.length > 1000) throw new Error("Credential pool state is malformed.");
      return value.entries.filter((entry: any) => entry && typeof entry.id === "string" && typeof entry.disabled === "boolean" && Number.isFinite(entry.cooldownUntil) && Number.isInteger(entry.failureCount) && entry.failureCount >= 0).map((entry: any) => ({
        id: entry.id, disabled: entry.disabled, cooldownUntil: Math.max(0, entry.cooldownUntil), failureCount: Math.min(entry.failureCount, 1_000_000),
        ...(typeof entry.lastUsedAt === "string" ? { lastUsedAt: entry.lastUsedAt } : {}),
        ...(typeof entry.lastFailureCode === "string" ? { lastFailureCode: entry.lastFailureCode.slice(0, 200) } : {}),
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  async save(providerId: string, entries: PersistedCredentialPoolEntry[]): Promise<void> {
    const value = { schemaVersion: 1, providerId, entries };
    const encoded = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new Error("Credential pool state exceeds its safety bound.");
    await atomicWrite(this.path(providerId), encoded);
  }
}

/**
 * Same-provider credential rotation. A request is retried only if the failed
 * credential produced no model output, avoiding duplicate partial generations.
 */
export class CredentialPoolModelProvider implements ModelProvider {
  readonly id: string;
  private readonly credentials: CredentialRecord[];
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;
  private readonly stateStore: CredentialPoolStateStore | undefined;
  private cursor = 0;

  constructor(
    providerId: string,
    credentials: ProviderCredentialInput[],
    private readonly factory: (apiKey: string) => ModelProvider,
    options: CredentialPoolProviderOptions = {},
  ) {
    if (credentials.length === 0) throw new Error("A credential pool requires at least one credential.");
    this.id = providerId;
    this.credentials = normalizeCredentials(credentials);
    this.baseCooldownMs = options.baseCooldownMs ?? 10_000;
    this.maxCooldownMs = options.maxCooldownMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
    this.stateStore = options.stateStore;
    const persisted = new Map((this.stateStore?.load(this.id) ?? []).map((entry) => [entry.id, entry]));
    for (const credential of this.credentials) {
      const state = persisted.get(credential.id);
      if (!state) continue;
      credential.disabled = state.disabled;
      credential.cooldownUntil = state.cooldownUntil;
      credential.failureCount = state.failureCount;
      if (state.lastUsedAt) credential.lastUsedAt = state.lastUsedAt;
      if (state.lastFailureCode) credential.lastFailureCode = state.lastFailureCode;
    }
  }

  status(): CredentialPoolStatus {
    const now = this.now();
    return {
      kind: "credential-pool",
      providerId: this.id,
      entries: this.credentials.map((credential) => ({
        id: credential.id,
        state: credential.disabled ? "disabled" : credential.cooldownUntil > now ? "cooldown" : "available",
        ...(credential.cooldownUntil > now ? { cooldownUntil: new Date(credential.cooldownUntil).toISOString() } : {}),
        failureCount: credential.failureCount,
        ...(credential.lastUsedAt ? { lastUsedAt: credential.lastUsedAt } : {}),
        ...(credential.lastFailureCode ? { lastFailureCode: credential.lastFailureCode } : {}),
      })),
    };
  }

  private orderedCandidates(): CredentialRecord[] {
    const now = this.now();
    const available = this.credentials.filter((credential) => !credential.disabled && credential.cooldownUntil <= now);
    if (available.length === 0) {
      const cooling = this.credentials
        .filter((credential) => !credential.disabled)
        .sort((left, right) => left.cooldownUntil - right.cooldownUntil);
      // If every usable key is cooling down, surface the failure rather than
      // bypassing the provider's retry window.
      return cooling.length > 0 && cooling[0]!.cooldownUntil <= now ? [cooling[0]!] : [];
    }
    const offset = this.cursor % available.length;
    return [...available.slice(offset), ...available.slice(0, offset)];
  }

  private persistedEntries(): PersistedCredentialPoolEntry[] {
    return this.credentials.map((credential) => ({
      id: credential.id, disabled: credential.disabled, cooldownUntil: credential.cooldownUntil,
      failureCount: credential.failureCount,
      ...(credential.lastUsedAt ? { lastUsedAt: credential.lastUsedAt } : {}),
      ...(credential.lastFailureCode ? { lastFailureCode: credential.lastFailureCode } : {}),
    }));
  }
  private async persist(): Promise<void> { await this.stateStore?.save(this.id, this.persistedEntries()); }

  async reset(credentialId?: string): Promise<CredentialPoolStatus> {
    const targets = credentialId ? this.credentials.filter((entry) => entry.id === credentialId) : this.credentials;
    if (!targets.length) throw new Error(`Credential ${credentialId} is not part of provider ${this.id}.`);
    for (const credential of targets) {
      credential.disabled = false; credential.cooldownUntil = 0; credential.failureCount = 0;
      delete credential.lastFailureCode;
    }
    await this.persist();
    return this.status();
  }

  private async markSuccess(credential: CredentialRecord): Promise<void> {
    credential.failureCount = 0;
    credential.cooldownUntil = 0;
    delete credential.lastFailureCode;
    credential.lastUsedAt = new Date(this.now()).toISOString();
    const index = this.credentials.indexOf(credential);
    this.cursor = index < 0 ? this.cursor + 1 : index + 1;
    try { await this.persist(); } catch { /* Successful model output is not invalidated by observer-state persistence failure. */ }
  }

  private async markFailure(credential: CredentialRecord, failure: ModelProviderError): Promise<void> {
    credential.failureCount++;
    credential.lastFailureCode = failure.code;
    credential.lastUsedAt = new Date(this.now()).toISOString();
    if (failure.credentialDisposition === "disable") {
      credential.disabled = true;
      credential.cooldownUntil = 0;
      await this.persist();
      return;
    }
    if (failure.credentialDisposition === "cooldown") {
      const exponential = Math.min(this.baseCooldownMs * 2 ** Math.max(0, credential.failureCount - 1), this.maxCooldownMs);
      credential.cooldownUntil = this.now() + Math.min(Math.max(failure.retryAfterMs ?? exponential, this.baseCooldownMs), this.maxCooldownMs);
    }
    await this.persist();
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const candidates = this.orderedCandidates();
    if (candidates.length === 0) {
      throw new Error(`No ${this.id} credentials are currently available; inspect provider pool status before retrying.`);
    }

    let lastFailure: ModelProviderError | undefined;
    for (const credential of candidates) {
      let producedOutput = false;
      try {
        for await (const event of this.factory(credential.apiKey).stream(request)) {
          producedOutput = true;
          yield event;
        }
        await this.markSuccess(credential);
        return;
      } catch (error) {
        const failure = classifyModelFailure(this.id, error);
        lastFailure = failure;
        if (producedOutput) throw failure;
        await this.markFailure(credential, failure);
        const mayTryAnother = failure.credentialDisposition === "disable" || failure.credentialDisposition === "cooldown";
        if (!mayTryAnother) throw failure;
      }
    }
    throw lastFailure ?? new Error(`No ${this.id} credential completed the model request.`);
  }
}
