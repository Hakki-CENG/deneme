import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialBrokerLike } from "../security/credential-broker.js";
import { AsyncMutex } from "../util/async-mutex.js";
import { atomicWrite } from "../util/atomic-file.js";
import type { AutomationService } from "./automation-service.js";

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const MAX_NONCES = 20_000;
const MAX_BODY_BYTES = 1024 * 1024;
const REPLAY_WINDOW_MS = 5 * 60_000;
const CAPABILITY = "automation.responder.verify";

interface ResponderEventRecord {
  key: string;
  eventType: string;
  status: "processing" | "delivered" | "failed" | "uncertain";
  runId?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}
interface ResponderRecord {
  id: string;
  tenantId: string;
  name: string;
  automationId: string;
  eventType: string;
  credentialSecretId: string;
  heartbeatIntervalMs: number;
  enabled: boolean;
  reportedStatus?: "ready" | "degraded";
  version?: string;
  capabilities: string[];
  instanceProjection?: string;
  lastHeartbeatAt?: string;
  events: ResponderEventRecord[];
  nonces: Array<{ hash: string; expiresAt: number }>;
  createdAt: string;
  updatedAt: string;
}
interface ResponderState { schemaVersion: 1; responders: ResponderRecord[] }

export interface AutomationResponderView extends Omit<ResponderRecord, "credentialSecretId" | "events" | "nonces" | "reportedStatus"> {
  credentialConfigured: boolean;
  health: "pending" | "healthy" | "degraded" | "stale" | "disabled";
  eventCounts: { processing: number; delivered: number; failed: number; uncertain: number };
  reportedStatus?: "ready" | "degraded";
}
export interface ResponderAcceptance { accepted: true; duplicate: boolean; status: string; eventKey?: string }
export interface AutomationResponderOptions { rootPath: string; credentials: CredentialBrokerLike; automations: AutomationService; now?: () => number }

/** Signed external automation responder heartbeats/events with durable no-replay outcomes. */
export class AutomationResponderService {
  private state: ResponderState = { schemaVersion: 1, responders: [] };
  private loaded = false;
  private readonly now: () => number;
  private readonly mutex = new AsyncMutex();
  private readonly active = new Map<string, Promise<void>>();

  constructor(private readonly options: AutomationResponderOptions) { this.now = options.now ?? Date.now; }

  async add(input: { tenantId: string; name: string; automationId: string; credentialSecretId: string; heartbeatIntervalMs?: number }): Promise<AutomationResponderView> {
    await this.load();
    const automation = await this.options.automations.get(input.automationId);
    if (automation.tenantId !== input.tenantId || automation.trigger.kind !== "webhook") throw new Error("Automation responder requires a webhook automation in the same tenant.");
    const secret = (await this.options.credentials.list(input.tenantId)).find((item) => item.id === input.credentialSecretId);
    if (!secret) throw new Error("Automation responder credential secret does not exist in tenant.");
    const name = bounded(input.name, 200, "Automation responder name");
    if (this.state.responders.some((item) => item.tenantId === input.tenantId && item.name.toLowerCase() === name.toLowerCase())) throw new Error("Automation responder name already exists in tenant.");
    const now = new Date(this.now()).toISOString();
    const record: ResponderRecord = {
      id: randomUUID(), tenantId: input.tenantId, name, automationId: automation.id,
      eventType: automation.trigger.eventType, credentialSecretId: secret.id,
      heartbeatIntervalMs: integer(input.heartbeatIntervalMs ?? 60_000, 10_000, 60 * 60_000, "Heartbeat interval"),
      enabled: true, capabilities: [], events: [], nonces: [], createdAt: now, updatedAt: now,
    };
    this.state.responders.push(record); await this.save(); return await this.view(record);
  }

  async list(tenantId: string): Promise<AutomationResponderView[]> { await this.load(); return await Promise.all(this.state.responders.filter((item) => item.tenantId === tenantId).map((item) => this.view(item))); }
  async setEnabled(id: string, tenantId: string, enabled: boolean): Promise<AutomationResponderView> { const record = await this.record(id, tenantId); record.enabled = enabled; record.updatedAt = new Date(this.now()).toISOString(); await this.save(); return await this.view(record); }
  async rotateCredential(id: string, tenantId: string, credentialSecretId: string): Promise<AutomationResponderView> {
    const record = await this.record(id, tenantId);
    if (!(await this.options.credentials.list(tenantId)).some((item) => item.id === credentialSecretId)) throw new Error("Automation responder credential secret does not exist in tenant.");
    record.credentialSecretId = credentialSecretId; record.nonces = []; record.updatedAt = new Date(this.now()).toISOString(); await this.save(); return await this.view(record);
  }
  async remove(id: string, tenantId: string): Promise<boolean> { await this.load(); const before = this.state.responders.length; this.state.responders = this.state.responders.filter((item) => !(item.id === id && item.tenantId === tenantId)); if (before !== this.state.responders.length) await this.save(); return before !== this.state.responders.length; }

  async acceptHeartbeat(id: string, rawBody: Buffer, headers: SignedResponderHeaders, body: unknown): Promise<ResponderAcceptance> {
    return await this.mutex.runExclusive(async () => {
      const record = await this.enabledRecord(id);
      const parsed = heartbeatPayload(body);
      const duplicate = await this.verify(record, rawBody, headers);
      if (duplicate) return { accepted: true, duplicate: true, status: "heartbeat_duplicate" };
      record.reportedStatus = parsed.status; record.version = parsed.version; record.capabilities = parsed.capabilities;
      record.instanceProjection = projection(parsed.instanceId); record.lastHeartbeatAt = new Date(this.now()).toISOString(); record.updatedAt = record.lastHeartbeatAt;
      await this.save(); return { accepted: true, duplicate: false, status: "heartbeat_recorded" };
    });
  }

  async acceptEvent(id: string, rawBody: Buffer, headers: SignedResponderHeaders, body: unknown): Promise<ResponderAcceptance> {
    let task: Promise<void> | undefined;
    const acceptance = await this.mutex.runExclusive(async () => {
      const record = await this.enabledRecord(id);
      const parsed = eventPayload(body);
      if (parsed.eventType !== record.eventType) throw new Error("Automation responder event type is not allowed.");
      const nonceDuplicate = await this.verify(record, rawBody, headers);
      const key = sha256(`${record.id}\0${parsed.eventId}`);
      const existing = record.events.find((item) => item.key === key);
      if (nonceDuplicate || existing) return { accepted: true as const, duplicate: true, status: existing?.status ?? "nonce_duplicate", eventKey: key };
      const now = new Date(this.now()).toISOString();
      const event: ResponderEventRecord = { key, eventType: parsed.eventType, status: "processing", createdAt: now, updatedAt: now };
      record.events.push(event); if (record.events.length > MAX_EVENTS) record.events.splice(0, record.events.length - MAX_EVENTS);
      await this.save();
      task = this.process(record, event, parsed.data).finally(() => this.active.delete(key)); this.active.set(key, task);
      return { accepted: true as const, duplicate: false, status: "processing", eventKey: key };
    });
    void task;
    return acceptance;
  }

  async close(): Promise<void> {
    await Promise.race([
      Promise.allSettled([...this.active.values()]).then(() => undefined),
      new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5000); timer.unref(); }),
    ]);
  }

  private async process(record: ResponderRecord, event: ResponderEventRecord, data: unknown): Promise<void> {
    try {
      const run = await this.options.automations.dispatch(record.automationId, "webhook", data as any);
      await this.mutex.runExclusive(async () => {
        event.status = run.status === "completed" ? "delivered" : run.status === "uncertain" ? "uncertain" : "failed";
        event.runId = run.id; if (run.errorCode) event.errorCode = run.errorCode;
        event.updatedAt = new Date(this.now()).toISOString(); await this.save();
      });
    } catch {
      await this.mutex.runExclusive(async () => { event.status = "uncertain"; event.errorCode = "dispatch_outcome_unknown"; event.updatedAt = new Date(this.now()).toISOString(); await this.save(); });
    }
  }

  private async verify(record: ResponderRecord, rawBody: Buffer, headers: SignedResponderHeaders): Promise<boolean> {
    if (!rawBody.length || rawBody.length > MAX_BODY_BYTES) throw new Error("Automation responder body size is invalid.");
    const timestamp = Number(headers.timestamp);
    if (!headers.timestamp || !Number.isFinite(timestamp) || Math.abs(this.now() / 1000 - timestamp) > REPLAY_WINDOW_MS / 1000) throw new Error("Automation responder timestamp is missing or stale.");
    if (!headers.nonce || !/^[A-Za-z0-9_.:-]{8,200}$/.test(headers.nonce)) throw new Error("Automation responder nonce is invalid.");
    if (!headers.signature || !/^sha256=[a-f0-9]{64}$/i.test(headers.signature)) throw new Error("Automation responder signature is invalid.");
    const audience = `haf-internal:automation-responder:${record.id}`;
    const lease = await this.options.credentials.issueLease({ tenantId: record.tenantId, secretId: record.credentialSecretId, capabilityId: CAPABILITY, audience, ttlMs: 30_000, maxUses: 1 });
    let secret = await this.options.credentials.redeemLease({ leaseId: lease.leaseId, tenantId: record.tenantId, capabilityId: CAPABILITY, audience });
    try {
      const expected = `sha256=${createHmac("sha256", secret).update(`${headers.timestamp}.${headers.nonce}.`).update(rawBody).digest("hex")}`;
      const left = Buffer.from(expected), right = Buffer.from(headers.signature.toLowerCase());
      if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("Automation responder signature verification failed.");
    } finally { secret = ""; }
    const now = this.now(); record.nonces = record.nonces.filter((item) => item.expiresAt > now);
    const nonceHash = sha256(`${record.id}\0${headers.nonce}`);
    if (record.nonces.some((item) => item.hash === nonceHash)) return true;
    record.nonces.push({ hash: nonceHash, expiresAt: now + REPLAY_WINDOW_MS });
    if (record.nonces.length > MAX_NONCES) record.nonces.splice(0, record.nonces.length - MAX_NONCES);
    return false;
  }

  private health(record: ResponderRecord): AutomationResponderView["health"] {
    if (!record.enabled) return "disabled";
    if (!record.lastHeartbeatAt) return "pending";
    const age = this.now() - Date.parse(record.lastHeartbeatAt);
    if (record.reportedStatus === "degraded" || age > record.heartbeatIntervalMs * 2) return age > record.heartbeatIntervalMs * 4 ? "stale" : "degraded";
    return "healthy";
  }
  private async view(record: ResponderRecord): Promise<AutomationResponderView> {
    const configured = (await this.options.credentials.list(record.tenantId)).some((item) => item.id === record.credentialSecretId);
    const count = (status: ResponderEventRecord["status"]) => record.events.filter((item) => item.status === status).length;
    return {
      id: record.id, tenantId: record.tenantId, name: record.name, automationId: record.automationId, eventType: record.eventType,
      heartbeatIntervalMs: record.heartbeatIntervalMs, enabled: record.enabled,
      capabilities: [...record.capabilities], ...(record.instanceProjection ? { instanceProjection: record.instanceProjection } : {}),
      ...(record.lastHeartbeatAt ? { lastHeartbeatAt: record.lastHeartbeatAt } : {}), createdAt: record.createdAt, updatedAt: record.updatedAt,
      credentialConfigured: configured, health: this.health(record),
      eventCounts: { processing: count("processing"), delivered: count("delivered"), failed: count("failed"), uncertain: count("uncertain") },
      ...(record.reportedStatus ? { reportedStatus: record.reportedStatus } : {}), ...(record.version ? { version: record.version } : {}),
    };
  }
  private async enabledRecord(id: string): Promise<ResponderRecord> { await this.load(); const record = this.state.responders.find((item) => item.id === id); if (!record || !record.enabled) throw new Error("Automation responder is missing or disabled."); return record; }
  private async record(id: string, tenantId: string): Promise<ResponderRecord> { await this.load(); const record = this.state.responders.find((item) => item.id === id && item.tenantId === tenantId); if (!record) throw new Error("Automation responder not found in tenant."); return record; }
  private get path(): string { return join(this.options.rootPath, "automation", "responders.json"); }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try { const raw = await readFile(this.path, "utf8"); if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error("Automation responder state exceeds its safety bound."); const parsed = JSON.parse(raw) as ResponderState; if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.responders)) throw new Error("Automation responder state is malformed."); this.state = parsed; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let changed = false;
    for (const responder of this.state.responders) for (const event of responder.events) if (event.status === "processing") { event.status = "uncertain"; event.errorCode = "restart_during_dispatch"; event.updatedAt = new Date(this.now()).toISOString(); changed = true; }
    this.loaded = true; if (changed) await this.save();
  }
  private async save(): Promise<void> { const encoded = `${JSON.stringify(this.state, null, 2)}\n`; if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new Error("Automation responder state exceeds its safety bound."); await atomicWrite(this.path, encoded); }
}

export interface SignedResponderHeaders { timestamp?: string; nonce?: string; signature?: string }
function heartbeatPayload(value: unknown): { instanceId: string; version: string; status: "ready" | "degraded"; capabilities: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Automation responder heartbeat payload is invalid.");
  const body = value as any; const instanceId = bounded(body.instanceId, 200, "Responder instance ID"), version = bounded(body.version, 100, "Responder version");
  if (!['ready', 'degraded'].includes(body.status)) throw new Error("Automation responder reported status is invalid.");
  const capabilities = [...new Set<string>((Array.isArray(body.capabilities) ? body.capabilities : []).map((item: unknown) => bounded(String(item), 100, "Responder capability")))].slice(0, 100);
  return { instanceId, version, status: body.status as "ready" | "degraded", capabilities };
}
function eventPayload(value: unknown): { eventId: string; eventType: string; data: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Automation responder event payload is invalid.");
  const body = value as any; const eventId = bounded(body.eventId, 200, "Responder event ID"), eventType = bounded(body.eventType, 200, "Responder event type");
  if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(eventId) || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(eventType)) throw new Error("Automation responder event identity is invalid.");
  validateJson(body.data, 0); return { eventId, eventType, data: body.data ?? null };
}
function validateJson(value: unknown, depth: number): void { if (depth > 20) throw new Error("Responder event data exceeds depth limit."); if (value === null || ["string", "boolean"].includes(typeof value)) { if (typeof value === "string" && value.length > 100_000) throw new Error("Responder event string is too large."); return; } if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Responder event number is invalid."); return; } if (Array.isArray(value)) { if (value.length > 1000) throw new Error("Responder event array is too large."); for (const item of value) validateJson(item, depth + 1); return; } if (value && typeof value === "object") { const entries = Object.entries(value as Record<string, unknown>); if (entries.length > 1000) throw new Error("Responder event object is too large."); for (const [key, item] of entries) { if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Responder event object key is forbidden."); validateJson(item, depth + 1); } return; } throw new Error("Responder event data is not JSON-safe."); }
function bounded(value: unknown, max: number, label: string): string { if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid.`); return value.trim(); }
function integer(value: number, min: number, max: number, label: string): number { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} is invalid.`); return value; }
function projection(value: string): string { return sha256(value).slice(0, 24); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
