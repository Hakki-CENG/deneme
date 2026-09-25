import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeUrl } from "../capabilities/web.js";
import { AsyncMutex } from "../util/async-mutex.js";
import { atomicWrite } from "../util/atomic-file.js";
import type { ChannelGateway } from "./channel-gateway.js";
import type { ChannelAdapter, ChannelDeliveryResult, OutboundChannelMessage } from "./delivery-adapters.js";

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 100_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface TwilioSmsAdapterOptions {
  stateRoot: string;
  gateway: ChannelGateway;
  tenantId: string;
  accountSid: string;
  authToken: string;
  fromNumber: string;
  allowedNumbers: string[];
  webhookUrl?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  urlGuard?: (url: string) => Promise<URL>;
}

interface TwilioSmsEvent {
  key: string;
  senderHash: string;
  recipientHash: string;
  status: "processing" | "responding" | "done" | "failed" | "uncertain";
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

interface TwilioSmsState {
  schemaVersion: 1;
  events: TwilioSmsEvent[];
}

export interface TwilioSmsStatus {
  id: "twilio-sms";
  state: "stopped" | "ready" | "outbound_only";
  processing: number;
  delivered: number;
  failed: number;
  uncertain: number;
  inboundConfigured: boolean;
  outboundAccepted: number;
  outboundFailed: number;
}

export interface TwilioInboundAcceptance {
  accepted: true;
  duplicate: boolean;
  eventKey: string;
  status: TwilioSmsEvent["status"];
}

interface NormalizedInboundSms {
  messageSid: string;
  from: string;
  to: string;
  body: string;
  mediaCount: number;
}

/** Native Twilio SMS transport with signed asynchronous ingress and no uncertain reply replay. */
export class TwilioSmsAdapter implements ChannelAdapter {
  readonly id = "twilio-sms";
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fromNumber: string;
  private readonly allowedNumbers: Set<string>;
  private readonly apiBase: URL;
  private readonly webhookUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly urlGuard: (url: string) => Promise<URL>;
  private state: TwilioSmsState = { schemaVersion: 1, events: [] };
  private loaded = false;
  private stopped = true;
  private readonly mutex = new AsyncMutex();
  private readonly active = new Map<string, Promise<void>>();
  private outboundAccepted = 0;
  private outboundFailed = 0;

  constructor(private readonly options: TwilioSmsAdapterOptions) {
    this.accountSid = validAccountSid(options.accountSid);
    this.authToken = validSecret(options.authToken);
    this.fromNumber = validPhone(options.fromNumber);
    this.allowedNumbers = new Set(options.allowedNumbers.map(validPhone));
    if (!this.allowedNumbers.size) throw new Error("Twilio SMS requires at least one allowed phone number.");
    this.apiBase = new URL(options.apiBase ?? "https://api.twilio.com");
    if (this.apiBase.protocol !== "https:" || this.apiBase.username || this.apiBase.password || this.apiBase.search || this.apiBase.hash) {
      throw new Error("Twilio API base must be a credential-free HTTPS URL.");
    }
    this.webhookUrl = options.webhookUrl ? normalizedWebhookUrl(options.webhookUrl) : undefined;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.urlGuard = options.urlGuard ?? assertSafeUrl;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.mutex.runExclusive(async () => {
      await this.load();
      let changed = false;
      for (const event of this.state.events) if (event.status === "processing" || event.status === "responding") {
        const previous = event.status;
        event.status = "uncertain";
        event.errorCode = previous === "responding" ? "restart_during_send" : "restart_during_processing";
        event.updatedAt = new Date().toISOString();
        changed = true;
      }
      if (changed) await this.save();
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.race([
      Promise.allSettled([...this.active.values()]).then(() => undefined),
      new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5000); timer.unref(); }),
    ]);
  }

  status(): TwilioSmsStatus {
    return {
      id: "twilio-sms", state: this.stopped ? "stopped" : this.webhookUrl ? "ready" : "outbound_only",
      processing: this.state.events.filter((item) => item.status === "processing" || item.status === "responding").length,
      delivered: this.state.events.filter((item) => item.status === "done").length,
      failed: this.state.events.filter((item) => item.status === "failed").length,
      uncertain: this.state.events.filter((item) => item.status === "uncertain").length,
      inboundConfigured: Boolean(this.webhookUrl), outboundAccepted: this.outboundAccepted, outboundFailed: this.outboundFailed,
    };
  }

  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    if (message.media) throw new Error("Twilio SMS adapter does not accept workspace binary media without an explicit public media URL.");
    const destination = validPhone(message.destination);
    if (!this.allowedNumbers.has(destination)) throw new Error("Twilio SMS destination is not allowlisted.");
    const text = validBody(message.text);
    if (signal?.aborted) throw signal.reason ?? new Error("Twilio SMS send aborted.");
    const base = new URL(this.apiBase.toString().endsWith("/") ? this.apiBase : `${this.apiBase}/`);
    const relative = `2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`;
    const target = await this.urlGuard(new URL(relative, base).toString());
    const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    if (target.origin !== base.origin || !target.pathname.startsWith(prefix) || target.username || target.password || target.search || target.hash) {
      throw new Error("Twilio SMS API request escaped its configured boundary.");
    }
    const form = new URLSearchParams({ To: destination, From: this.fromNumber, Body: text });
    let dispatched = false;
    try {
      dispatched = true;
      const response = await this.fetchImpl(target, {
        method: "POST", redirect: "manual",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          "user-agent": "Hybrid-Agent-Fabric/1.32",
        },
        body: form.toString(), ...(signal ? { signal } : {}),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Twilio SMS redirects are forbidden and the send outcome is uncertain.");
      }
      const body = await boundedResponse(response, MAX_RESPONSE_BYTES);
      if (!response.ok) throw new Error(`Twilio SMS request failed with HTTP ${response.status}.`);
      let parsed: any;
      try { parsed = JSON.parse(body); } catch { throw new Error("Twilio SMS returned invalid JSON."); }
      const sid = typeof parsed?.sid === "string" && /^(?:SM|MM)[a-f0-9]{32}$/i.test(parsed.sid) ? parsed.sid : undefined;
      if (!sid) throw new Error("Twilio SMS response omitted a valid message SID.");
      this.outboundAccepted++;
      return { platform: this.id, destination, messageId: sid, timestamp: new Date().toISOString(), rawStatus: response.status };
    } catch {
      this.outboundFailed++;
      throw new Error(dispatched ? "Twilio SMS send failed or has an uncertain outcome." : "Twilio SMS send failed before dispatch.");
    }
  }

  async acceptInbound(params: Record<string, unknown>, signature: string | undefined): Promise<TwilioInboundAcceptance> {
    if (!this.webhookUrl) throw new Error("Twilio SMS inbound webhook is not configured.");
    if (!verifyTwilioSignature({ url: this.webhookUrl, params, signature, authToken: this.authToken })) throw new Error("Twilio SMS webhook signature verification failed.");
    const normalized = normalizeInbound(params, this.accountSid, this.fromNumber, this.allowedNumbers);
    const eventKey = createHash("sha256").update(`${this.accountSid}\0${normalized.messageSid}`).digest("hex");
    let acceptance!: TwilioInboundAcceptance;
    await this.mutex.runExclusive(async () => {
      await this.load();
      const existing = this.state.events.find((item) => item.key === eventKey);
      if (existing) {
        acceptance = { accepted: true, duplicate: true, eventKey, status: existing.status };
        return;
      }
      const now = new Date().toISOString();
      const event: TwilioSmsEvent = {
        key: eventKey, senderHash: hashProjection(normalized.from), recipientHash: hashProjection(normalized.to),
        status: "processing", createdAt: now, updatedAt: now,
      };
      this.state.events.push(event);
      if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
      await this.save();
      acceptance = { accepted: true, duplicate: false, eventKey, status: "processing" };
      const task = this.processInbound(event, normalized).finally(() => this.active.delete(eventKey));
      this.active.set(eventKey, task);
    });
    return acceptance;
  }

  private async processInbound(event: TwilioSmsEvent, message: NormalizedInboundSms): Promise<void> {
    try {
      const delivery = await this.options.gateway.ingest({
        tenantId: this.options.tenantId, platform: "twilio-sms", chatId: message.from,
        chatType: "dm", userId: message.from, text: message.body,
        messageId: message.messageSid, authorized: true,
        metadata: { senderHash: event.senderHash, recipientHash: event.recipientHash, mediaCount: String(message.mediaCount) },
      });
      if (!delivery.text) return await this.finishEvent(event, "done");
      await this.finishEvent(event, "responding");
      try {
        await this.send({ destination: message.from, text: delivery.text });
        await this.finishEvent(event, "done");
      } catch {
        await this.finishEvent(event, "uncertain", "sms_reply_outcome_uncertain");
      }
    } catch {
      await this.finishEvent(event, "failed", "gateway_failed");
    }
  }

  private async finishEvent(event: TwilioSmsEvent, status: TwilioSmsEvent["status"], errorCode?: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      event.status = status;
      event.updatedAt = new Date().toISOString();
      if (errorCode) event.errorCode = errorCode; else delete event.errorCode;
      await this.save();
    });
  }

  private get path(): string { return join(this.options.stateRoot, "channels", "twilio-sms-state.json"); }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8");
      if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error("Twilio SMS state exceeds its safety bound.");
      const parsed = JSON.parse(raw) as TwilioSmsState;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.events) || parsed.events.length > MAX_EVENTS) throw new Error("Twilio SMS state is malformed.");
      this.state = parsed;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.loaded = true;
  }
  private async save(): Promise<void> {
    const encoded = `${JSON.stringify(this.state, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new Error("Twilio SMS state exceeds its safety bound.");
    await atomicWrite(this.path, encoded);
  }
}

export function verifyTwilioSignature(input: {
  url: string;
  params: Record<string, unknown>;
  signature: string | undefined;
  authToken: string;
}): boolean {
  if (!input.signature || input.signature.length > 200 || !input.authToken) return false;
  let payload = input.url;
  for (const key of Object.keys(input.params).sort()) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key)) return false;
    const raw = input.params[key];
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length > 100) return false;
    for (const value of values) {
      if (typeof value !== "string" || value.length > 20_000 || /[\u0000]/.test(value)) return false;
      payload += key + value;
    }
  }
  const expected = createHmac("sha1", input.authToken).update(payload, "utf8").digest("base64");
  const left = Buffer.from(expected), right = Buffer.from(input.signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeInbound(params: Record<string, unknown>, accountSid: string, fromNumber: string, allowed: Set<string>): NormalizedInboundSms {
  const scalar = (name: string, max: number): string => {
    const value = params[name];
    if (typeof value !== "string" || !value || value.length > max || /[\u0000]/.test(value)) throw new Error(`Twilio inbound ${name} is invalid.`);
    return value;
  };
  if (scalar("AccountSid", 100) !== accountSid) throw new Error("Twilio inbound account does not match configuration.");
  const messageSid = validMessageSid(scalar("MessageSid", 100));
  const from = validPhone(scalar("From", 30));
  const to = validPhone(scalar("To", 30));
  if (to !== fromNumber) throw new Error("Twilio inbound recipient does not match configured number.");
  if (!allowed.has(from)) throw new Error("Twilio inbound sender is not allowlisted.");
  const body = validBody(scalar("Body", 1600));
  const mediaRaw = params.NumMedia;
  const mediaCount = mediaRaw === undefined ? 0 : Number(mediaRaw);
  if (!Number.isInteger(mediaCount) || mediaCount < 0 || mediaCount > 10) throw new Error("Twilio inbound media count is invalid.");
  return { messageSid, from, to, body, mediaCount };
}

async function boundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = "", bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error("Twilio SMS response exceeds its safety bound."); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
function validAccountSid(value: string): string {
  const sid = value.trim(); if (!/^AC[a-f0-9]{32}$/i.test(sid)) throw new Error("Twilio Account SID is invalid."); return sid;
}
function validMessageSid(value: string): string {
  const sid = value.trim(); if (!/^(?:SM|MM)[a-f0-9]{32}$/i.test(sid)) throw new Error("Twilio Message SID is invalid."); return sid;
}
function validSecret(value: string): string {
  if (!value || value.length > 1000 || /[\r\n\u0000]/.test(value)) throw new Error("Twilio auth token is invalid."); return value;
}
function validPhone(value: string): string {
  const phone = value.trim(); if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("Twilio phone number must use E.164 format."); return phone;
}
function validBody(value: string): string {
  const body = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!body || body.length > 1600) throw new Error("Twilio SMS body is invalid."); return body;
}
function normalizedWebhookUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Twilio webhook URL must use credential-free HTTPS.");
  return url.toString();
}
function hashProjection(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
