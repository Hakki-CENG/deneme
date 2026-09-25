import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../util/atomic-file.js";
import type { ModelProvider } from "../types.js";
import type { ProviderProfile } from "./provider-profiles.js";
import { ProviderProfileRegistry } from "./provider-profiles.js";
import type { ModelOAuthManager } from "./model-oauth-manager.js";
import { OAuthBearerModelProvider } from "./oauth-bearer-model-provider.js";

export interface ModelConfigurationRecord {
  id: string;
  tenantId: string;
  name: string;
  baseProfileId: string;
  model: string;
  dataPolicy: "provider" | "aggregator" | "local";
  baseUrl?: string;
  credentialEnvironmentVariable?: string;
  credentialOAuthSourceId?: string;
  credentialAudienceOrigin?: string;
  headerEnvironmentVariables: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConfigurationView extends Omit<ModelConfigurationRecord, "credentialAudienceOrigin"> {
  configured: boolean;
  credentialAudienceOrigin?: string;
}

function environmentName(value: string): string {
  if (!/^[A-Z_][A-Z0-9_]{0,199}$/.test(value)) throw new Error(`Invalid credential environment variable: ${value}`);
  return value;
}

function headerName(value: string): string {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(value) || /^(?:host|content-length|connection|transfer-encoding|authorization|api-key|x-api-key)$/i.test(value)) {
    throw new Error(`Custom model header ${value} is forbidden or reserved.`);
  }
  return value;
}

export class ModelConfigurationRegistry {
  private records: ModelConfigurationRecord[] = [];
  private loaded = false;

  constructor(
    private readonly rootPath: string,
    private readonly profiles: ProviderProfileRegistry,
    private readonly oauth?: ModelOAuthManager,
  ) {}

  private get path(): string { return join(this.rootPath, "models", "configurations.json"); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.records = Array.isArray(parsed) ? (parsed as ModelConfigurationRecord[]).map((item) => ({ ...item, tenantId: item.tenantId ?? "local", dataPolicy: item.dataPolicy ?? this.profiles.get(item.baseProfileId)?.dataPolicy ?? "provider", headerEnvironmentVariables: item.headerEnvironmentVariables ?? {} })) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify(this.records, null, 2)}\n`);
  }

  private async view(record: ModelConfigurationRecord): Promise<ModelConfigurationView> {
    const environmentReady = !record.credentialEnvironmentVariable || Boolean(process.env[record.credentialEnvironmentVariable]);
    const oauthReady = !record.credentialOAuthSourceId || Boolean(this.oauth && (await this.oauth.get(record.credentialOAuthSourceId, record.tenantId).catch(() => undefined))?.authenticated);
    const headersReady = Object.values(record.headerEnvironmentVariables).every((name) => Boolean(process.env[name]));
    return { ...structuredClone(record), configured: environmentReady && oauthReady && headersReady };
  }

  async list(tenantId?: string): Promise<ModelConfigurationView[]> {
    await this.load();
    return await Promise.all(this.records.filter((record) => !tenantId || record.tenantId === tenantId).map((record) => this.view(record)));
  }

  async get(id: string): Promise<ModelConfigurationRecord> {
    await this.load();
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error(`Model configuration ${id} not found.`);
    return structuredClone(record);
  }

  async add(input: {
    tenantId?: string;
    name: string;
    baseProfileId: string;
    model: string;
    dataPolicy?: "provider" | "aggregator" | "local";
    baseUrl?: string;
    credentialEnvironmentVariable?: string;
    credentialOAuthSourceId?: string;
    credentialAudienceOrigin?: string;
    headerEnvironmentVariables?: Record<string, string>;
  }): Promise<ModelConfigurationView> {
    await this.load();
    const baseProfile = this.profiles.get(input.baseProfileId);
    if (!baseProfile) throw new Error(`Unknown base provider profile: ${input.baseProfileId}`);
    const name = input.name.trim();
    const model = input.model.trim();
    if (!name || name.length > 200 || !model || model.length > 300) throw new Error("Model configuration name/model is invalid.");
    if (this.records.some((record) => record.name.toLowerCase() === name.toLowerCase())) throw new Error(`Model configuration name ${name} already exists.`);
    const tenantId = input.tenantId?.trim() || "local";
    if (input.credentialEnvironmentVariable && input.credentialOAuthSourceId) throw new Error("Model configuration cannot combine environment and OAuth bearer credentials.");
    const oauthSource = input.credentialOAuthSourceId
      ? await this.oauth?.get(input.credentialOAuthSourceId, tenantId)
      : undefined;
    if (input.credentialOAuthSourceId && !oauthSource) throw new Error("Model OAuth source does not exist in tenant.");
    const credentialEnvironmentVariable = input.credentialOAuthSourceId ? undefined : input.credentialEnvironmentVariable
      ? environmentName(input.credentialEnvironmentVariable)
      : baseProfile.dataPolicy === "local" || baseProfile.credentialMode === "aws-default" ? undefined : baseProfile.apiKeyEnvironmentVariable;
    let baseUrl: string | undefined;
    let audience: string | undefined;
    if (input.baseUrl) {
      const url = new URL(input.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Custom model base URL must be credential-free HTTP(S) without query or fragment.");
      baseUrl = url.toString().replace(/\/$/, "");
      audience = input.credentialAudienceOrigin ? new URL(input.credentialAudienceOrigin).origin : undefined;
      if (credentialEnvironmentVariable && audience !== url.origin) {
        throw new Error("Custom model credentials require an exact credentialAudienceOrigin matching the base URL origin.");
      }
    } else if (input.credentialAudienceOrigin) {
      audience = new URL(input.credentialAudienceOrigin).origin;
      if (!baseProfile.defaultBaseUrl || audience !== new URL(baseProfile.defaultBaseUrl).origin) throw new Error("Credential audience does not match the base profile origin.");
    }
    if (oauthSource) {
      const resourceOrigin = new URL(baseUrl ?? baseProfile.defaultBaseUrl ?? "").origin;
      if (!oauthSource.resourceOrigins.includes(resourceOrigin)) throw new Error("Model OAuth source is not authorized for the configured model origin.");
      audience = resourceOrigin;
    }
    const customOrigin = Boolean(baseUrl && (!baseProfile.defaultBaseUrl || new URL(baseUrl).origin !== new URL(baseProfile.defaultBaseUrl).origin));
    if (customOrigin && !input.dataPolicy) throw new Error("Custom model origins require an explicit dataPolicy label.");
    const dataPolicy = input.dataPolicy ?? baseProfile.dataPolicy ?? "provider";
    const headerEnvironmentVariables: Record<string, string> = {};
    for (const [header, variable] of Object.entries(input.headerEnvironmentVariables ?? {})) {
      headerEnvironmentVariables[headerName(header)] = environmentName(variable);
    }
    const now = new Date().toISOString();
    const record: ModelConfigurationRecord = {
      id: `model-${randomUUID()}`,
      tenantId,
      name,
      baseProfileId: baseProfile.id,
      model,
      dataPolicy,
      ...(baseUrl ? { baseUrl } : {}),
      ...(credentialEnvironmentVariable ? { credentialEnvironmentVariable } : {}),
      ...(input.credentialOAuthSourceId ? { credentialOAuthSourceId: input.credentialOAuthSourceId } : {}),
      ...(audience ? { credentialAudienceOrigin: audience } : {}),
      headerEnvironmentVariables,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    await this.save();
    return this.view(record);
  }

  async setEnabled(id: string, enabled: boolean): Promise<ModelConfigurationView> {
    await this.load();
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error(`Model configuration ${id} not found.`);
    record.enabled = enabled;
    record.updatedAt = new Date().toISOString();
    await this.save();
    return this.view(record);
  }

  async remove(id: string): Promise<boolean> {
    await this.load();
    const before = this.records.length;
    this.records = this.records.filter((record) => record.id !== id);
    if (before !== this.records.length) await this.save();
    return before !== this.records.length;
  }

  async materialize(id: string): Promise<{ provider: ModelProvider; modelName: string; profile: ProviderProfile }> {
    const record = await this.get(id);
    if (!record.enabled) throw new Error(`Model configuration ${id} is disabled.`);
    const apiKey = record.credentialEnvironmentVariable ? process.env[record.credentialEnvironmentVariable] : undefined;
    const baseProfile = this.profiles.get(record.baseProfileId)!;
    if (!record.credentialOAuthSourceId && !apiKey && baseProfile.dataPolicy !== "local" && baseProfile.credentialMode !== "aws-default") throw new Error(`Model credential environment variable ${record.credentialEnvironmentVariable} is not set.`);
    const headers: Record<string, string> = {};
    for (const [header, variable] of Object.entries(record.headerEnvironmentVariables)) {
      const value = process.env[variable];
      if (!value) throw new Error(`Model header environment variable ${variable} is not set.`);
      headers[header] = value;
    }
    const build = (credential?: string) => this.profiles.createProvider({
      profileId: record.baseProfileId,
      runtimeId: record.id,
      ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
      ...(credential ? { apiKey: credential } : {}),
      model: record.model,
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    if (record.credentialOAuthSourceId) {
      if (!this.oauth || !record.credentialAudienceOrigin) throw new Error("Model OAuth runtime is unavailable or missing its resource audience.");
      const source = await this.oauth.get(record.credentialOAuthSourceId, record.tenantId);
      if (!source.enabled || !source.authenticated) throw new Error("Model OAuth source is disabled or not authenticated.");
      const profile = this.profiles.get(record.baseProfileId)!;
      return {
        provider: new OAuthBearerModelProvider({
          id: record.id, tenantId: record.tenantId, sourceId: record.credentialOAuthSourceId,
          resourceOrigin: record.credentialAudienceOrigin, oauth: this.oauth,
          build: (token) => build(token).provider,
        }),
        modelName: `${record.id}:${record.model}`,
        profile,
      };
    }
    return build(apiKey);
  }
}
