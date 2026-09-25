import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { AutomationTrigger, AutomationService } from "./automation-service.js";
import type { HostedRepositoryProviderRegistry } from "../repositories/hosted-repository-provider.js";
import type { Supervisor } from "../runtime/supervisor.js";
import { atomicWrite } from "../util/atomic-file.js";

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const PLAN_TTL_MS = 15 * 60_000;

interface AutomationGitSourceRecord {
  id: string;
  tenantId: string;
  name: string;
  providerId: string;
  repositoryId: string;
  manifestPath: string;
  ref: string;
  sessionId: string;
  webhookSecretEnvironmentVariable?: string;
  allowedModels: string[];
  enabled: boolean;
  status: "idle" | "planned" | "applying" | "succeeded" | "failed" | "partial";
  lastPlanSha256?: string;
  lastPlanExpiresAt?: string;
  lastAppliedSha256?: string;
  lastRemoteVersion?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
}

interface AutomationGitState {
  schemaVersion: 1;
  sources: AutomationGitSourceRecord[];
}

export interface AutomationGitSourceView extends AutomationGitSourceRecord {}

export interface AutomationGitPlanEntry {
  key: string;
  name: string;
  trigger: AutomationTrigger["kind"];
  enabled: boolean;
  action: "create" | "update" | "unchanged";
  entrySha256: string;
}

export interface AutomationGitPlan {
  sourceId: string;
  manifestSha256: string;
  remoteVersion: string;
  expiresAt: string;
  entries: AutomationGitPlanEntry[];
  disableKeys: string[];
}

export interface AutomationGitApplyResult {
  sourceId: string;
  manifestSha256: string;
  status: "succeeded" | "partial" | "failed";
  created: number;
  updated: number;
  unchanged: number;
  disabled: number;
  errorCode?: string;
}

const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.string().datetime() }).strict(),
  z.object({ kind: z.literal("interval"), everyMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60_000) }).strict(),
  z.object({ kind: z.literal("cron"), expression: z.string().min(1).max(200), timezone: z.string().min(1).max(100).optional() }).strict(),
]);
const manifestTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("schedule"), schedule: scheduleSchema }).strict(),
  z.object({ kind: z.literal("webhook"), eventType: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i).max(200) }).strict(),
]);
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  automations: z.array(z.object({
    key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    prompt: z.string().min(1).max(50_000),
    trigger: manifestTriggerSchema,
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().min(1000).max(24 * 60 * 60_000).optional(),
    model: z.string().min(1).max(300).optional(),
  }).strict()).max(100),
}).strict();
type ParsedManifest = z.infer<typeof manifestSchema>;
type ManifestEntry = ParsedManifest["automations"][number];

/** Explicit plan/apply synchronization of bounded automation manifests from hosted Git. */
export class AutomationGitSyncService {
  private state: AutomationGitState = { schemaVersion: 1, sources: [] };
  private loaded = false;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly rootPath: string,
    private readonly hosted: HostedRepositoryProviderRegistry,
    private readonly automations: AutomationService,
    private readonly supervisor: Supervisor,
  ) {}

  async add(input: {
    tenantId: string;
    name: string;
    providerId: string;
    repositoryId: string;
    manifestPath: string;
    ref: string;
    sessionId: string;
    webhookSecretEnvironmentVariable?: string;
    allowedModels?: string[];
  }): Promise<AutomationGitSourceView> {
    await this.load();
    const name = bounded(input.name, 200, "Git sync source name");
    if (this.state.sources.some((item) => item.tenantId === input.tenantId && item.name.toLowerCase() === name.toLowerCase())) throw new Error("Git sync source name already exists in tenant.");
    const session = await this.supervisor.getSession(input.sessionId);
    if (session.tenantId !== input.tenantId) throw new Error("Git sync source session belongs to a different tenant.");
    await this.hosted.repository(input.providerId, input.tenantId, input.repositoryId);
    const manifestPath = safePath(input.manifestPath);
    if (!manifestPath.toLowerCase().endsWith(".json")) throw new Error("Automation Git manifest must be a JSON file.");
    const ref = safeRef(input.ref);
    const webhookSecretEnvironmentVariable = input.webhookSecretEnvironmentVariable
      ? environmentName(input.webhookSecretEnvironmentVariable) : undefined;
    const allowedModels = [...new Set((input.allowedModels ?? []).map((item) => bounded(item, 300, "Allowed model route")))].slice(0, 20);
    const now = new Date().toISOString();
    const record: AutomationGitSourceRecord = {
      id: randomUUID(), tenantId: input.tenantId, name, providerId: input.providerId,
      repositoryId: input.repositoryId, manifestPath, ref, sessionId: input.sessionId,
      ...(webhookSecretEnvironmentVariable ? { webhookSecretEnvironmentVariable } : {}),
      allowedModels, enabled: true, status: "idle", createdAt: now, updatedAt: now,
    };
    this.state.sources.push(record);
    await this.save();
    return structuredClone(record);
  }

  async list(tenantId: string): Promise<AutomationGitSourceView[]> {
    await this.load();
    return this.state.sources.filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item));
  }

  async setEnabled(id: string, tenantId: string, enabled: boolean): Promise<AutomationGitSourceView> {
    const source = await this.source(id, tenantId);
    source.enabled = enabled;
    source.updatedAt = new Date().toISOString();
    if (!enabled) {
      delete source.lastPlanSha256;
      delete source.lastPlanExpiresAt;
      await this.automations.disableGitManagedMissing(source.id, tenantId, new Set());
    }
    await this.save();
    return structuredClone(source);
  }

  async remove(id: string, tenantId: string): Promise<boolean> {
    await this.load();
    const source = this.state.sources.find((item) => item.id === id && item.tenantId === tenantId);
    if (!source) return false;
    await this.automations.disableGitManagedMissing(source.id, tenantId, new Set());
    this.state.sources = this.state.sources.filter((item) => item !== source);
    await this.save();
    return true;
  }

  async plan(id: string, tenantId: string): Promise<AutomationGitPlan> {
    return await this.withLock(id, async () => {
      const source = await this.enabledSource(id, tenantId);
      const fetched = await this.fetchManifest(source);
      const plan = await this.buildPlan(source, fetched.manifest, fetched.contentSha256, fetched.remoteVersion);
      source.status = "planned";
      source.lastPlanSha256 = plan.manifestSha256;
      source.lastPlanExpiresAt = plan.expiresAt;
      source.lastRemoteVersion = plan.remoteVersion;
      delete source.lastErrorCode;
      source.updatedAt = new Date().toISOString();
      await this.save();
      return plan;
    });
  }

  async apply(id: string, tenantId: string, expectedManifestSha256: string): Promise<AutomationGitApplyResult> {
    return await this.withLock(id, async () => {
      const source = await this.enabledSource(id, tenantId);
      if (!/^[a-f0-9]{64}$/i.test(expectedManifestSha256) || source.lastPlanSha256 !== expectedManifestSha256 || !source.lastPlanExpiresAt || Date.parse(source.lastPlanExpiresAt) <= Date.now()) {
        throw new Error("Automation Git apply requires a current matching plan hash.");
      }
      const fetched = await this.fetchManifest(source);
      if (fetched.contentSha256 !== expectedManifestSha256) throw new Error("Automation Git manifest changed after planning; create a new plan.");
      const planned = await this.buildPlan(source, fetched.manifest, fetched.contentSha256, fetched.remoteVersion);
      source.status = "applying";
      source.updatedAt = new Date().toISOString();
      delete source.lastErrorCode;
      await this.save();
      let created = 0, updated = 0, unchanged = 0, disabled = 0;
      try {
        for (const entry of fetched.manifest.automations) {
          const planEntry = planned.entries.find((item) => item.key === entry.key)!;
          if (planEntry.action === "unchanged") { unchanged++; continue; }
          await this.automations.reconcileGitManaged({
            sourceId: source.id, key: entry.key, entrySha256: planEntry.entrySha256,
            manifestSha256: fetched.contentSha256, tenantId: source.tenantId,
            name: entry.name, ...(entry.description ? { description: entry.description } : {}),
            sessionId: source.sessionId, prompt: entry.prompt,
            trigger: materializeTrigger(entry.trigger, source.webhookSecretEnvironmentVariable),
            enabled: entry.enabled, ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
            ...(entry.model ? { model: entry.model } : {}),
          });
          if (planEntry.action === "create") created++; else updated++;
        }
        const retained = new Set(fetched.manifest.automations.map((item) => item.key));
        disabled = (await this.automations.disableGitManagedMissing(source.id, source.tenantId, retained)).length;
        source.status = "succeeded";
        source.lastAppliedSha256 = fetched.contentSha256;
        source.lastRemoteVersion = fetched.remoteVersion;
        delete source.lastPlanSha256;
        delete source.lastPlanExpiresAt;
        delete source.lastErrorCode;
        source.updatedAt = new Date().toISOString();
        await this.save();
        return { sourceId: source.id, manifestSha256: fetched.contentSha256, status: "succeeded", created, updated, unchanged, disabled };
      } catch {
        const partial = created + updated + disabled > 0;
        source.status = partial ? "partial" : "failed";
        source.lastErrorCode = partial ? "partial_apply" : "apply_failed";
        delete source.lastPlanSha256;
        delete source.lastPlanExpiresAt;
        source.updatedAt = new Date().toISOString();
        await this.save();
        return {
          sourceId: source.id, manifestSha256: fetched.contentSha256,
          status: partial ? "partial" : "failed", created, updated, unchanged, disabled,
          errorCode: source.lastErrorCode,
        };
      }
    });
  }

  private async fetchManifest(source: AutomationGitSourceRecord): Promise<{ manifest: ParsedManifest; contentSha256: string; remoteVersion: string }> {
    const file = await this.hosted.readFile(source.providerId, source.tenantId, source.repositoryId, source.manifestPath, source.ref);
    let raw: unknown;
    try { raw = JSON.parse(file.content); }
    catch { throw new Error("Automation Git manifest is not valid JSON."); }
    const manifest = manifestSchema.parse(raw);
    const keys = new Set<string>();
    for (const entry of manifest.automations) {
      if (keys.has(entry.key)) throw new Error(`Automation Git manifest contains duplicate key ${entry.key}.`);
      keys.add(entry.key);
      if (entry.model && !source.allowedModels.includes(entry.model)) throw new Error(`Automation Git manifest model ${entry.model} is not allowlisted by the source.`);
      if (entry.trigger.kind === "webhook" && !source.webhookSecretEnvironmentVariable) throw new Error("Webhook automation requires an administrator-configured secret environment variable on the Git source.");
      if (entry.trigger.kind === "schedule") {
        if (entry.trigger.schedule.kind === "once" && Date.parse(entry.trigger.schedule.at) <= Date.now()) throw new Error(`Automation Git schedule for ${entry.key} has no future occurrence.`);
        if (entry.trigger.schedule.kind === "cron") {
          try { CronExpressionParser.parse(entry.trigger.schedule.expression, { ...(entry.trigger.schedule.timezone ? { tz: entry.trigger.schedule.timezone } : {}) }).next(); }
          catch { throw new Error(`Automation Git cron schedule for ${entry.key} is invalid.`); }
        }
      }
    }
    return { manifest, contentSha256: file.contentSha256, remoteVersion: file.remoteVersion };
  }

  private async buildPlan(source: AutomationGitSourceRecord, manifest: ParsedManifest, manifestSha256: string, remoteVersion: string): Promise<AutomationGitPlan> {
    const current = (await this.automations.list(source.tenantId)).filter((item) => item.managedBy?.kind === "git_sync" && item.managedBy.sourceId === source.id);
    const byKey = new Map(current.map((item) => [item.managedBy!.key, item]));
    const entries: AutomationGitPlanEntry[] = manifest.automations.map((entry) => {
      const entrySha256 = hashCanonical(entry);
      const existing = byKey.get(entry.key);
      return {
        key: entry.key, name: entry.name, trigger: entry.trigger.kind, enabled: entry.enabled,
        action: !existing ? "create" : existing.managedBy?.entrySha256 === entrySha256 ? "unchanged" : "update",
        entrySha256,
      };
    });
    const retained = new Set(entries.map((item) => item.key));
    const disableKeys = current.filter((item) => item.enabled && !retained.has(item.managedBy!.key)).map((item) => item.managedBy!.key).sort();
    return { sourceId: source.id, manifestSha256, remoteVersion, expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(), entries, disableKeys };
  }

  private async enabledSource(id: string, tenantId: string): Promise<AutomationGitSourceRecord> {
    const source = await this.source(id, tenantId);
    if (!source.enabled) throw new Error("Automation Git source is disabled.");
    return source;
  }
  private async source(id: string, tenantId: string): Promise<AutomationGitSourceRecord> {
    await this.load();
    const source = this.state.sources.find((item) => item.id === id && item.tenantId === tenantId);
    if (!source) throw new Error("Automation Git source not found in tenant.");
    return source;
  }
  private get path(): string { return join(this.rootPath, "automation", "git-sources.json"); }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8");
      if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error("Automation Git state exceeds its safety bound.");
      const parsed = JSON.parse(raw) as AutomationGitState;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sources) || parsed.sources.length > 10_000) throw new Error("Automation Git state is malformed.");
      this.state = parsed;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let recovered = false;
    for (const source of this.state.sources) if (source.status === "applying") {
      source.status = "partial";
      source.lastErrorCode = "restart_during_apply";
      delete source.lastPlanSha256;
      delete source.lastPlanExpiresAt;
      source.updatedAt = new Date().toISOString();
      recovered = true;
    }
    this.loaded = true;
    if (recovered) await this.save();
  }
  private async save(): Promise<void> {
    const encoded = `${JSON.stringify(this.state, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new Error("Automation Git state exceeds its safety bound.");
    await atomicWrite(this.path, encoded);
  }
  private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(id, queued);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.locks.get(id) === queued) this.locks.delete(id); }
  }
}

function materializeTrigger(trigger: ManifestEntry["trigger"], secretEnvironmentVariable?: string): AutomationTrigger {
  if (trigger.kind === "manual") return { kind: "manual" };
  if (trigger.kind === "schedule") {
    const schedule = trigger.schedule.kind === "cron"
      ? { kind: "cron" as const, expression: trigger.schedule.expression, ...(trigger.schedule.timezone ? { timezone: trigger.schedule.timezone } : {}) }
      : trigger.schedule;
    return { kind: "schedule", schedule };
  }
  if (!secretEnvironmentVariable) throw new Error("Git-managed webhook secret is missing.");
  return { kind: "webhook", eventType: trigger.eventType, secretEnvironmentVariable };
}
function safePath(value: string): string {
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path.length > 500 || path.startsWith("/") || path.includes("//") || path.split("/").some((part) => !part || part === "." || part === "..") || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("Automation Git manifest path is invalid.");
  return path;
}
function safeRef(value: string): string {
  const ref = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) || ref.includes("..") || ref.includes("//") || ref.includes("@{") || ref.endsWith("/") || ref.endsWith(".")) throw new Error("Automation Git ref is invalid.");
  return ref;
}
function environmentName(value: string): string {
  if (!/^[A-Z_][A-Z0-9_]{0,199}$/.test(value)) throw new Error("Automation Git webhook secret environment variable is invalid.");
  return value;
}
function bounded(value: string, max: number, label: string): string {
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hashCanonical(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
