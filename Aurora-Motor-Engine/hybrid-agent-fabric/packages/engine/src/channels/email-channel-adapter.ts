import { createHash, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImapFlow, type FetchMessageObject, type MailboxObject } from "imapflow";
import nodemailer from "nodemailer";
import type { ChannelGateway } from "./channel-gateway.js";
import type { ChannelAdapter, ChannelDeliveryResult, OutboundChannelMessage } from "./delivery-adapters.js";
import { atomicWrite } from "../util/atomic-file.js";

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const MAX_MIME_PARTS = 100;
const MAX_MIME_DEPTH = 8;

export interface EmailSmtpOptions {
  host: string;
  port?: number;
  secure?: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName?: string;
  tlsCa?: string | Buffer;
}

export interface EmailImapOptions {
  host: string;
  port?: number;
  secure?: boolean;
  username: string;
  password: string;
  mailbox?: string;
  tlsCa?: string | Buffer;
  inboundToken: string;
  recipientAddresses?: string[];
  initialSync?: "latest" | "all";
}

export interface EmailSmtpFactoryConfig {
  host: string;
  servername?: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  username: string;
  password: string;
  tlsCa?: string | Buffer;
  connectTimeoutMs: number;
}

export interface EmailImapFactoryConfig {
  host: string;
  servername?: string;
  port: number;
  secure: boolean;
  forceStartTls: boolean;
  username: string;
  password: string;
  tlsCa?: string | Buffer;
  connectTimeoutMs: number;
  maxMessageBytes: number;
}

export interface EmailSmtpTransportLike {
  sendMail(input: Record<string, unknown>): Promise<{ accepted?: unknown[]; rejected?: unknown[]; messageId?: string; response?: string }>;
  close?(): void;
}

export interface EmailImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string, options?: { readOnly?: boolean }): Promise<Pick<MailboxObject, "uidValidity" | "uidNext" | "exists">>;
  search(query: { uid: string }, options: { uid: true }): Promise<number[] | false>;
  fetchOne(uid: string, query: { uid?: boolean; size?: boolean; source?: boolean | { start?: number; maxLength?: number } }, options: { uid: true }): Promise<Pick<FetchMessageObject, "uid" | "size" | "source"> | false>;
  on(event: "exists" | "close" | "error", listener: (...args: any[]) => void): unknown;
}

export interface EmailChannelAdapterOptions {
  stateRoot: string;
  gateway: ChannelGateway;
  tenantId: string;
  smtp: EmailSmtpOptions;
  imap?: EmailImapOptions;
  allowedRecipients: string[];
  allowedSenders?: string[];
  allowPrivateHost?: boolean;
  pollIntervalMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  connectTimeoutMs?: number;
  maxMessageBytes?: number;
  maxBodyChars?: number;
  maxMessagesPerPoll?: number;
  autoReply?: boolean;
  lookup?: typeof dnsLookup;
  random?: () => number;
  smtpFactory?: (config: EmailSmtpFactoryConfig) => EmailSmtpTransportLike;
  imapFactory?: (config: EmailImapFactoryConfig) => EmailImapClientLike;
}

export interface ParsedInboundEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  messageId?: string;
  references: string[];
  token?: string;
  autoSubmitted?: string;
  precedence?: string;
  attachmentCount: number;
}

interface EmailEventRecord {
  uid: number;
  key: string;
  senderHash?: string;
  status: "processing" | "responding" | "done" | "failed" | "uncertain" | "ignored";
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

interface EmailState {
  schemaVersion: 1;
  mailboxKey: string;
  uidValidity?: string;
  lastUid: number;
  events: EmailEventRecord[];
}

export interface EmailConnectionStatus {
  id: "email";
  state: "stopped" | "outbound_only" | "resolving" | "connecting" | "connected" | "reconnecting" | "blocked";
  generation: number;
  reconnectAttempt: number;
  lastUid: number;
  processing: number;
  delivered: number;
  ignored: number;
  uncertain: number;
  smtpAccepted: number;
  smtpFailed: number;
  imapConfigured: boolean;
  tls: true;
  lastErrorCode?: "dns" | "tls" | "authentication" | "connect" | "protocol" | "mailbox" | "parse" | "gateway" | "smtp";
}

/** TLS-first SMTP outbound plus restart-safe IMAP inbound email channel. */
export class EmailChannelAdapter implements ChannelAdapter {
  readonly id = "email";
  private readonly smtp: Required<Pick<EmailSmtpOptions, "port" | "secure">> & EmailSmtpOptions;
  private readonly imap: (Required<Pick<EmailImapOptions, "port" | "secure" | "mailbox" | "initialSync">> & EmailImapOptions) | undefined;
  private readonly allowedRecipients: Set<string>;
  private readonly allowedSenders: Set<string>;
  private readonly inboundRecipients: Set<string>;
  private readonly lookup: typeof dnsLookup;
  private readonly random: () => number;
  private readonly pollIntervalMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxMessageBytes: number;
  private readonly maxBodyChars: number;
  private readonly maxMessagesPerPoll: number;
  private readonly autoReply: boolean;
  private state: EmailState;
  private loaded = false;
  private stopped = true;
  private blocked = false;
  private connectionState: EmailConnectionStatus["state"] = "stopped";
  private generation = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private imapClient: EmailImapClientLike | undefined;
  private polling: Promise<void> | undefined;
  private lastErrorCode: EmailConnectionStatus["lastErrorCode"];
  private smtpAccepted = 0;
  private smtpFailed = 0;

  constructor(private readonly options: EmailChannelAdapterOptions) {
    const smtpHost = validHost(options.smtp.host, "SMTP");
    const smtpSecure = options.smtp.secure === true;
    this.smtp = {
      ...options.smtp, host: smtpHost, secure: smtpSecure,
      port: boundedInteger(options.smtp.port ?? (smtpSecure ? 465 : 587), 1, 65535, "SMTP port"),
      username: validCredential(options.smtp.username, 500, "SMTP username"),
      password: validCredential(options.smtp.password, 2000, "SMTP password"),
      fromAddress: validEmail(options.smtp.fromAddress),
      ...(options.smtp.fromName ? { fromName: cleanHeader(options.smtp.fromName, 200, "SMTP from name") } : {}),
    };
    validateCa(options.smtp.tlsCa, "SMTP");
    this.imap = options.imap ? {
      ...options.imap,
      host: validHost(options.imap.host, "IMAP"),
      secure: options.imap.secure !== false,
      port: boundedInteger(options.imap.port ?? (options.imap.secure === false ? 143 : 993), 1, 65535, "IMAP port"),
      mailbox: validMailbox(options.imap.mailbox ?? "INBOX"),
      initialSync: options.imap.initialSync ?? "latest",
      username: validCredential(options.imap.username, 500, "IMAP username"),
      password: validCredential(options.imap.password, 2000, "IMAP password"),
      inboundToken: validCredential(options.imap.inboundToken, 1000, "Email inbound token"),
    } : undefined;
    validateCa(options.imap?.tlsCa, "IMAP");
    this.allowedRecipients = new Set(options.allowedRecipients.map(validEmail));
    this.allowedSenders = new Set((options.allowedSenders ?? []).map(validEmail));
    if (!this.allowedRecipients.size) throw new Error("Email requires at least one allowed recipient.");
    if (this.imap && !this.allowedSenders.size) throw new Error("Inbound email requires at least one allowed sender.");
    this.inboundRecipients = new Set((this.imap?.recipientAddresses ?? [this.smtp.fromAddress]).map(validEmail));
    if (this.imap && !this.inboundRecipients.size) throw new Error("Inbound email requires at least one recipient address.");
    if (!options.allowPrivateHost && (isPrivateOrSpecialIp(this.smtp.host) || (this.imap && isPrivateOrSpecialIp(this.imap.host)))) {
      throw new Error("Private or special-use email destination is forbidden.");
    }
    this.lookup = options.lookup ?? dnsLookup;
    this.random = options.random ?? Math.random;
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 30_000, 1000, 10 * 60_000, "Email poll interval");
    this.reconnectMinMs = boundedInteger(options.reconnectMinMs ?? 1000, 100, 60_000, "Email reconnect minimum");
    this.reconnectMaxMs = boundedInteger(options.reconnectMaxMs ?? 60_000, this.reconnectMinMs, 10 * 60_000, "Email reconnect maximum");
    this.connectTimeoutMs = boundedInteger(options.connectTimeoutMs ?? 15_000, 1000, 120_000, "Email connect timeout");
    this.maxMessageBytes = boundedInteger(options.maxMessageBytes ?? 2 * 1024 * 1024, 1024, 20 * 1024 * 1024, "Email message byte limit");
    this.maxBodyChars = boundedInteger(options.maxBodyChars ?? 20_000, 1000, 100_000, "Email body character limit");
    this.maxMessagesPerPoll = boundedInteger(options.maxMessagesPerPoll ?? 50, 1, 500, "Email messages-per-poll limit");
    this.autoReply = options.autoReply !== false;
    this.state = { schemaVersion: 1, mailboxKey: this.mailboxKey(), lastUid: 0, events: [] };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.blocked = false;
    if (!this.imap) {
      this.connectionState = "outbound_only";
      return;
    }
    void this.connectImap();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.blocked = false;
    this.connectionState = "stopped";
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.reconnectTimer = undefined;
    this.pollTimer = undefined;
    const client = this.imapClient;
    this.imapClient = undefined;
    if (client) await client.logout().catch(() => undefined);
    await this.polling?.catch(() => undefined);
  }

  status(): EmailConnectionStatus {
    return {
      id: "email", state: this.connectionState, generation: this.generation,
      reconnectAttempt: this.reconnectAttempt, lastUid: this.state.lastUid,
      processing: this.state.events.filter((item) => item.status === "processing" || item.status === "responding").length,
      delivered: this.state.events.filter((item) => item.status === "done").length,
      ignored: this.state.events.filter((item) => item.status === "ignored").length,
      uncertain: this.state.events.filter((item) => item.status === "uncertain").length,
      smtpAccepted: this.smtpAccepted, smtpFailed: this.smtpFailed,
      imapConfigured: Boolean(this.imap), tls: true,
      ...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
    };
  }

  async waitUntilConnected(timeoutMs = 10_000): Promise<void> {
    if (!this.imap) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.connectionState === "connected") return;
      if (this.connectionState === "blocked") throw new Error(`Email connection blocked (${this.lastErrorCode ?? "unknown"}).`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Email IMAP connection did not become ready before timeout.");
  }

  async pollNow(): Promise<void> {
    if (!this.imap || !this.imapClient || this.connectionState !== "connected") throw new Error("Email IMAP adapter is not connected.");
    if (!this.polling) this.polling = this.pollMailbox().finally(() => { this.polling = undefined; });
    return await this.polling;
  }

  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    const destination = validEmail(message.destination);
    if (!this.allowedRecipients.has(destination) && !this.allowedSenders.has(destination)) throw new Error("Email destination is outside configured recipients and authorized senders.");
    const subject = cleanHeader(message.metadata?.subject ?? "Message from Hybrid Agent Fabric", 500, "Email subject");
    const threadId = message.threadId ? validMessageId(message.threadId) : undefined;
    return await this.sendEmail({ destination, subject, text: message.text, ...(threadId ? { inReplyTo: threadId, references: [threadId] } : {}), ...(message.media ? { media: message.media } : {}) }, signal);
  }

  private async connectImap(): Promise<void> {
    if (this.stopped || this.blocked || !this.imap || this.imapClient) return;
    await this.load();
    this.connectionState = "resolving";
    let target: { address: string; servername?: string };
    try { target = await this.resolveEndpoint(this.imap.host); }
    catch { this.lastErrorCode = "dns"; return this.scheduleReconnect(); }
    this.connectionState = "connecting";
    const config: EmailImapFactoryConfig = {
      host: target.address, ...(target.servername ? { servername: target.servername } : {}),
      port: this.imap.port, secure: this.imap.secure, forceStartTls: !this.imap.secure,
      username: this.imap.username, password: this.imap.password,
      ...(this.imap.tlsCa ? { tlsCa: this.imap.tlsCa } : {}),
      connectTimeoutMs: this.connectTimeoutMs, maxMessageBytes: this.maxMessageBytes,
    };
    const client = this.options.imapFactory ? this.options.imapFactory(config) : defaultImapFactory(config);
    this.imapClient = client;
    client.on("error", (error: any) => {
      const code = String(error?.authenticationFailed ? "authentication" : error?.code ?? "").toLowerCase();
      this.lastErrorCode = code.includes("auth") ? "authentication" : code.includes("cert") || code.includes("tls") ? "tls" : "connect";
    });
    client.on("close", () => this.onImapClose(client));
    client.on("exists", () => this.schedulePoll(0));
    try {
      await client.connect();
      const mailbox = await client.mailboxOpen(this.imap.mailbox, { readOnly: true });
      await this.acceptMailbox(mailbox);
      this.generation++;
      this.reconnectAttempt = 0;
      this.connectionState = "connected";
      this.lastErrorCode = undefined;
      this.schedulePoll(0);
    } catch (error: any) {
      this.imapClient = undefined;
      await client.logout().catch(() => undefined);
      const code = String(error?.authenticationFailed ? "authentication" : error?.code ?? error?.message ?? "").toLowerCase();
      if (code.includes("auth")) {
        this.lastErrorCode = "authentication";
        this.blocked = true;
        this.connectionState = "blocked";
      } else {
        this.lastErrorCode = code.includes("cert") || code.includes("tls") ? "tls" : "connect";
        this.scheduleReconnect();
      }
    }
  }

  private async acceptMailbox(mailbox: Pick<MailboxObject, "uidValidity" | "uidNext" | "exists">): Promise<void> {
    const uidValidity = mailbox.uidValidity.toString();
    const changed = this.state.uidValidity !== undefined && this.state.uidValidity !== uidValidity;
    if (this.state.uidValidity === undefined || changed) {
      this.state.uidValidity = uidValidity;
      this.state.lastUid = this.state.uidValidity === undefined || this.imap?.initialSync === "all" && !changed ? 0 : Math.max(0, mailbox.uidNext - 1);
      if (changed) this.state.lastUid = Math.max(0, mailbox.uidNext - 1);
      this.state.events = [];
    }
    // A crash after SMTP dispatch but before completion must not replay the reply.
    for (const event of this.state.events) if (event.status === "responding") {
      event.status = "uncertain";
      event.errorCode = "restart_during_smtp";
      event.updatedAt = new Date().toISOString();
      this.state.lastUid = Math.max(this.state.lastUid, event.uid);
    }
    await this.save();
  }

  private async pollMailbox(): Promise<void> {
    const client = this.imapClient, imap = this.imap;
    if (!client || !imap || this.stopped) return;
    try {
      const found = await client.search({ uid: `${this.state.lastUid + 1}:*` }, { uid: true });
      const uids = (found || []).filter((uid) => Number.isInteger(uid) && uid > this.state.lastUid).sort((a, b) => a - b).slice(0, this.maxMessagesPerPoll);
      for (const uid of uids) {
        if (this.stopped || client !== this.imapClient) break;
        await this.processUid(client, uid);
      }
      this.schedulePoll(this.pollIntervalMs);
    } catch {
      this.lastErrorCode = "protocol";
      await client.logout().catch(() => undefined);
      if (client === this.imapClient) {
        this.imapClient = undefined;
        this.scheduleReconnect();
      }
    }
  }

  private async processUid(client: EmailImapClientLike, uid: number): Promise<void> {
    const key = this.eventKey(uid);
    const existing = this.state.events.find((item) => item.key === key);
    if (existing && ["done", "failed", "uncertain", "ignored"].includes(existing.status)) {
      this.state.lastUid = Math.max(this.state.lastUid, uid);
      await this.save();
      return;
    }
    const now = new Date().toISOString();
    const event = existing ?? { uid, key, status: "processing" as const, createdAt: now, updatedAt: now };
    if (!existing) this.state.events.push(event);
    event.status = "processing";
    event.updatedAt = now;
    delete event.errorCode;
    await this.save();
    const metadata = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
    if (!metadata || !metadata.size || metadata.size > this.maxMessageBytes) return await this.finishEvent(event, "ignored", "size_rejected");
    const fetched = await client.fetchOne(String(uid), { uid: true, source: { start: 0, maxLength: this.maxMessageBytes + 1 } }, { uid: true });
    if (!fetched || !fetched.source || fetched.source.length > this.maxMessageBytes) return await this.finishEvent(event, "ignored", "source_rejected");
    let parsed: ParsedInboundEmail;
    try { parsed = parseInboundEmail(fetched.source, this.maxBodyChars); }
    catch { return await this.finishEvent(event, "ignored", "parse_rejected"); }
    event.senderHash = hashProjection(parsed.from);
    if (!this.allowedSenders.has(parsed.from)) return await this.finishEvent(event, "ignored", "sender_not_allowed");
    if (!parsed.to.some((address) => this.inboundRecipients.has(address))) return await this.finishEvent(event, "ignored", "recipient_not_allowed");
    if (!safeSecretEqual(parsed.token, this.imap!.inboundToken)) return await this.finishEvent(event, "ignored", "token_invalid");
    if (parsed.from === this.smtp.fromAddress || parsed.autoSubmitted && parsed.autoSubmitted.toLowerCase() !== "no" || parsed.precedence && /^(bulk|list|junk)$/i.test(parsed.precedence)) {
      return await this.finishEvent(event, "ignored", "automatic_message");
    }
    const delivery = await this.options.gateway.ingest({
      tenantId: this.options.tenantId, platform: "email", chatId: `email:${parsed.from}`,
      chatType: "dm", userId: parsed.from,
      text: `UNTRUSTED INBOUND EMAIL\nSubject: ${parsed.subject}\n\n${parsed.text}\nEND UNTRUSTED EMAIL`,
      messageId: key, authorized: true,
      metadata: { emailSenderHash: hashProjection(parsed.from), subjectHash: hashProjection(parsed.subject), attachmentCount: String(parsed.attachmentCount) },
    }).catch(async () => {
      this.lastErrorCode = "gateway";
      await this.finishEvent(event, "failed", "gateway_failed");
      return undefined;
    });
    if (!delivery) return;
    if (!this.autoReply || !delivery.text) return await this.finishEvent(event, "done");
    event.status = "responding";
    event.updatedAt = new Date().toISOString();
    await this.save();
    try {
      await this.sendEmail({
        destination: parsed.from,
        subject: replySubject(parsed.subject), text: delivery.text,
        ...(parsed.messageId ? { inReplyTo: parsed.messageId, references: [...parsed.references, parsed.messageId].slice(-20) } : {}),
      });
      await this.finishEvent(event, "done");
    } catch {
      await this.finishEvent(event, "uncertain", "smtp_outcome_uncertain");
    }
  }

  private async finishEvent(event: EmailEventRecord, status: EmailEventRecord["status"], errorCode?: string): Promise<void> {
    event.status = status;
    event.updatedAt = new Date().toISOString();
    if (errorCode) event.errorCode = errorCode; else delete event.errorCode;
    this.state.lastUid = Math.max(this.state.lastUid, event.uid);
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    await this.save();
  }

  private async sendEmail(input: {
    destination: string; subject: string; text: string; inReplyTo?: string; references?: string[];
    media?: NonNullable<OutboundChannelMessage["media"]>;
  }, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    if (signal?.aborted) throw signal.reason ?? new Error("Email send aborted.");
    const destination = validEmail(input.destination);
    const target = await this.resolveEndpoint(this.smtp.host);
    const config: EmailSmtpFactoryConfig = {
      host: target.address, ...(target.servername ? { servername: target.servername } : {}),
      port: this.smtp.port, secure: this.smtp.secure, requireTLS: !this.smtp.secure,
      username: this.smtp.username, password: this.smtp.password,
      ...(this.smtp.tlsCa ? { tlsCa: this.smtp.tlsCa } : {}), connectTimeoutMs: this.connectTimeoutMs,
    };
    const transport = this.options.smtpFactory ? this.options.smtpFactory(config) : defaultSmtpFactory(config);
    try {
      const result = await transport.sendMail({
        from: this.smtp.fromName ? { name: this.smtp.fromName, address: this.smtp.fromAddress } : this.smtp.fromAddress,
        to: destination, subject: cleanHeader(input.subject, 500, "Email subject"),
        text: sanitizeBody(input.text, 100_000),
        ...(input.inReplyTo ? { inReplyTo: validMessageId(input.inReplyTo) } : {}),
        ...(input.references?.length ? { references: input.references.map(validMessageId).slice(-20) } : {}),
        ...(input.media ? { attachments: [{ filename: safeFileName(input.media.fileName), content: Buffer.from(input.media.data), contentType: input.media.mimeType, contentDisposition: "attachment" }] } : {}),
        headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" },
        disableFileAccess: true, disableUrlAccess: true,
      });
      const accepted = Array.isArray(result.accepted) ? result.accepted.length : 0;
      const rejected = Array.isArray(result.rejected) ? result.rejected.length : 0;
      if (!accepted || rejected) throw new Error("SMTP provider did not accept every recipient.");
      this.smtpAccepted++;
      return { platform: "email", destination, ...(result.messageId ? { messageId: String(result.messageId).slice(0, 500) } : {}), timestamp: new Date().toISOString(), rawStatus: 202 };
    } catch {
      this.smtpFailed++;
      this.lastErrorCode = "smtp";
      throw new Error("Email SMTP send failed or has an uncertain outcome.");
    } finally { transport.close?.(); }
  }

  private async resolveEndpoint(host: string): Promise<{ address: string; servername?: string }> {
    const literal = isIP(host);
    const addresses = literal ? [{ address: host, family: literal }] : await this.lookup(host, { all: true, verbatim: true });
    if (!addresses.length || !this.options.allowPrivateHost && addresses.some((item) => isPrivateOrSpecialIp(item.address))) throw new Error("Email endpoint resolution was rejected.");
    return { address: addresses[0]!.address, ...(!literal ? { servername: host } : {}) };
  }

  private onImapClose(client: EmailImapClientLike): void {
    if (client !== this.imapClient) return;
    this.imapClient = undefined;
    if (this.stopped) this.connectionState = "stopped";
    else if (this.blocked) this.connectionState = "blocked";
    else this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.blocked || this.reconnectTimer) return;
    this.connectionState = "reconnecting";
    const base = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** Math.min(this.reconnectAttempt++, 10));
    const delay = Math.max(100, Math.floor(base * (0.8 + this.random() * 0.4)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectImap();
    }, delay);
    this.reconnectTimer.unref();
  }

  private schedulePoll(delay: number): void {
    if (this.stopped || !this.imapClient || this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.pollNow().catch(() => undefined);
    }, delay);
    this.pollTimer.unref();
  }

  private mailboxKey(): string {
    return createHash("sha256").update(`${this.options.tenantId}\0${this.imap?.host ?? "outbound"}\0${this.imap?.mailbox ?? ""}`).digest("hex");
  }
  private eventKey(uid: number): string {
    return createHash("sha256").update(`${this.state.mailboxKey}\0${this.state.uidValidity ?? "unknown"}\0${uid}`).digest("hex");
  }
  private get path(): string { return join(this.options.stateRoot, "channels", "email-state.json"); }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8");
      if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error("Email channel state exceeds its safety bound.");
      const parsed = JSON.parse(raw) as EmailState;
      if (parsed.schemaVersion !== 1 || parsed.mailboxKey !== this.state.mailboxKey || !Number.isInteger(parsed.lastUid) || !Array.isArray(parsed.events)) throw new Error("Email channel state is malformed.");
      this.state = parsed;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.loaded = true;
  }
  private async save(): Promise<void> {
    const encoded = `${JSON.stringify(this.state, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new Error("Email channel state exceeds its safety bound.");
    await atomicWrite(this.path, encoded);
  }
}

function defaultSmtpFactory(config: EmailSmtpFactoryConfig): EmailSmtpTransportLike {
  return nodemailer.createTransport({
    host: config.host, port: config.port, secure: config.secure, requireTLS: config.requireTLS,
    auth: { user: config.username, pass: config.password },
    tls: { rejectUnauthorized: true, ...(config.servername ? { servername: config.servername } : {}), ...(config.tlsCa ? { ca: config.tlsCa } : {}) },
    connectionTimeout: config.connectTimeoutMs, greetingTimeout: config.connectTimeoutMs, socketTimeout: 60_000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
  }) as unknown as EmailSmtpTransportLike;
}

function defaultImapFactory(config: EmailImapFactoryConfig): EmailImapClientLike {
  return new ImapFlow({
    host: config.host, ...(config.servername ? { servername: config.servername } : {}),
    port: config.port, secure: config.secure, doSTARTTLS: config.forceStartTls,
    auth: { user: config.username, pass: config.password },
    tls: { rejectUnauthorized: true, ...(config.servername ? { servername: config.servername } : {}), ...(config.tlsCa ? { ca: config.tlsCa } : {}) },
    logger: false, logRaw: false, emitLogs: false, disableCompression: true, disableAutoIdle: false,
    connectionTimeout: config.connectTimeoutMs, greetingTimeout: config.connectTimeoutMs, socketTimeout: 5 * 60_000,
    maxLineLength: 64 * 1024, maxLiteralSize: config.maxMessageBytes + 1024, maxResponseSize: config.maxMessageBytes + 128 * 1024,
  }) as unknown as EmailImapClientLike;
}

export function parseInboundEmail(source: Buffer, maxBodyChars = 20_000): ParsedInboundEmail {
  if (!source.length || source.length > 20 * 1024 * 1024) throw new Error("Email source size is invalid.");
  const top = splitEntity(source);
  const headers = parseHeaders(top.headers);
  const from = parseAddressList(firstHeader(headers, "from"))[0];
  const to = parseAddressList([...(headers.get("to") ?? []), ...(headers.get("cc") ?? [])].join(","));
  if (!from || !to.length) throw new Error("Email sender or recipient headers are invalid.");
  const subject = cleanTextHeader(decodeEncodedWords(firstHeader(headers, "subject") || "(no subject)"), 500);
  const counter = { parts: 0, attachments: 0 };
  const content = parseMimeEntity(source, 0, counter);
  const text = sanitizeBody((content.plain || htmlToText(content.html || "")).slice(0, maxBodyChars), maxBodyChars);
  if (!text) throw new Error("Email has no bounded text body.");
  const messageIdRaw = firstHeader(headers, "message-id");
  const messageId = messageIdRaw ? validMessageId(messageIdRaw.trim()) : undefined;
  const references = (firstHeader(headers, "references") || "").match(/<[^<>\r\n]{1,498}>/g)?.map(validMessageId).slice(-20) ?? [];
  return {
    from, to, subject, text,
    ...(messageId ? { messageId } : {}), references,
    ...(firstHeader(headers, "x-haf-email-token") ? { token: firstHeader(headers, "x-haf-email-token").trim() } : {}),
    ...(firstHeader(headers, "auto-submitted") ? { autoSubmitted: cleanTextHeader(firstHeader(headers, "auto-submitted"), 100) } : {}),
    ...(firstHeader(headers, "precedence") ? { precedence: cleanTextHeader(firstHeader(headers, "precedence"), 100) } : {}),
    attachmentCount: counter.attachments,
  };
}

function parseMimeEntity(source: Buffer, depth: number, counter: { parts: number; attachments: number }): { plain?: string; html?: string } {
  if (depth > MAX_MIME_DEPTH || ++counter.parts > MAX_MIME_PARTS) throw new Error("Email MIME structure exceeds limits.");
  const entity = splitEntity(source), headers = parseHeaders(entity.headers);
  const contentType = firstHeader(headers, "content-type") || "text/plain; charset=utf-8";
  const disposition = firstHeader(headers, "content-disposition").toLowerCase();
  if (disposition.startsWith("attachment")) { counter.attachments++; return {}; }
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType.startsWith("multipart/")) {
    const boundary = parameterValue(contentType, "boundary");
    if (!boundary || boundary.length > 200) throw new Error("Email multipart boundary is invalid.");
    let plain: string | undefined, html: string | undefined;
    for (const part of splitMultipart(entity.body, boundary)) {
      const parsed = parseMimeEntity(part, depth + 1, counter);
      plain ??= parsed.plain; html ??= parsed.html;
    }
    return { ...(plain ? { plain } : {}), ...(html ? { html } : {}) };
  }
  if (mediaType !== "text/plain" && mediaType !== "text/html") { counter.attachments++; return {}; }
  const decoded = decodeBody(entity.body, firstHeader(headers, "content-transfer-encoding"), parameterValue(contentType, "charset"));
  return mediaType === "text/plain" ? { plain: decoded } : { html: decoded };
}

function splitEntity(source: Buffer): { headers: Buffer; body: Buffer } {
  let index = source.indexOf(Buffer.from("\r\n\r\n")), separator = 4;
  if (index < 0) { index = source.indexOf(Buffer.from("\n\n")); separator = 2; }
  if (index < 0 || index > 128 * 1024) throw new Error("Email headers are invalid or too large.");
  return { headers: source.subarray(0, index), body: source.subarray(index + separator) };
}
function parseHeaders(value: Buffer): Map<string, string[]> {
  const text = value.toString("latin1");
  const unfolded = text.replace(/\r?\n[ \t]+/g, " ");
  const headers = new Map<string, string[]>();
  for (const line of unfolded.split(/\r?\n/)) {
    if (!line || line.length > 16_384) throw new Error("Email header line is invalid.");
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error("Email header syntax is invalid.");
    const key = line.slice(0, separator).trim().toLowerCase();
    if (!/^[a-z0-9-]{1,100}$/.test(key)) throw new Error("Email header name is invalid.");
    const entry = line.slice(separator + 1).trim();
    const list = headers.get(key) ?? [];
    if (list.length < 20) list.push(entry.slice(0, 16_384));
    headers.set(key, list);
  }
  return headers;
}
function firstHeader(headers: Map<string, string[]>, key: string): string { return headers.get(key)?.[0] ?? ""; }
function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const marker = `--${boundary}`, closing = `--${boundary}--`;
  const lines = body.toString("latin1").split(/\r?\n/);
  const parts: Buffer[] = []; let current: string[] | undefined;
  for (const line of lines) {
    if (line === marker) { if (current) parts.push(Buffer.from(current.join("\r\n"), "latin1")); current = []; continue; }
    if (line === closing) { if (current) parts.push(Buffer.from(current.join("\r\n"), "latin1")); current = undefined; break; }
    if (current) current.push(line);
  }
  if (!parts.length || parts.length > MAX_MIME_PARTS) throw new Error("Email multipart body is invalid.");
  return parts;
}
function decodeBody(body: Buffer, encodingValue: string, charsetValue?: string): string {
  const encoding = encodingValue.trim().toLowerCase();
  let bytes: Buffer;
  if (encoding === "base64") {
    const encoded = body.toString("ascii").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Email base64 body is invalid.");
    bytes = Buffer.from(encoded, "base64");
  } else if (encoding === "quoted-printable") bytes = decodeQuotedPrintable(body);
  else if (!encoding || ["7bit", "8bit", "binary"].includes(encoding)) bytes = body;
  else throw new Error("Email transfer encoding is unsupported.");
  const charset = normalizeCharset(charsetValue);
  try { return new TextDecoder(charset, { fatal: false }).decode(bytes); }
  catch { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); }
}
function decodeQuotedPrintable(input: Buffer): Buffer {
  const text = input.toString("latin1").replace(/=\r?\n/g, "");
  const output: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "=" && /^[A-Fa-f0-9]{2}$/.test(text.slice(index + 1, index + 3))) {
      output.push(Number.parseInt(text.slice(index + 1, index + 3), 16)); index += 2;
    } else output.push(text.charCodeAt(index) & 0xff);
  }
  return Buffer.from(output);
}
function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?\s]{1,40})\?([bBqQ])\?([^?]{0,8192})\?=/g, (_all, charset: string, mode: string, encoded: string) => {
    try {
      const bytes = mode.toLowerCase() === "b" ? Buffer.from(encoded, "base64") : decodeQuotedPrintable(Buffer.from(encoded.replace(/_/g, " "), "latin1"));
      return new TextDecoder(normalizeCharset(charset), { fatal: false }).decode(bytes);
    } catch { return "[invalid encoded header]"; }
  });
}
function normalizeCharset(value?: string): "utf-8" | "windows-1252" {
  const charset = (value ?? "utf-8").trim().replace(/^"|"$/g, "").toLowerCase();
  return ["iso-8859-1", "latin1", "windows-1252"].includes(charset) ? "windows-1252" : "utf-8";
}
function parameterValue(header: string, name: string): string | undefined {
  const match = header.match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i"));
  return (match?.[1] ?? match?.[2])?.trim();
}
function parseAddressList(value: string): string[] {
  const matches = value.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}/g) ?? [];
  return [...new Set(matches.map(validEmail))].slice(0, 100);
}
function htmlToText(value: string): string {
  return value.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, " ").trim();
}
function replySubject(subject: string): string { return /^re:/i.test(subject) ? subject : `Re: ${subject}`.slice(0, 500); }
function safeSecretEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function validEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(email) || email.includes("..")) throw new Error("Email address is invalid.");
  return email;
}
function validMessageId(value: string): string {
  const messageId = value.trim();
  if (!/^<[^<>\r\n]{1,498}>$/.test(messageId)) throw new Error("Email Message-ID is invalid.");
  return messageId;
}
function validHost(value: string, label: string): string {
  const host = value.trim().replace(/^\[|\]$/g, "");
  if (!host || host.length > 253 || /[\s/@\\\0]/.test(host) || (!isIP(host) && !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(host))) throw new Error(`${label} host is invalid.`);
  return host;
}
function validMailbox(value: string): string {
  const mailbox = value.trim();
  if (!mailbox || mailbox.length > 500 || /[\r\n\0]/.test(mailbox)) throw new Error("IMAP mailbox is invalid.");
  return mailbox;
}
function validCredential(value: string, max: number, label: string): string {
  if (!value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}
function cleanHeader(value: string, max: number, label: string): string {
  const text = value.trim();
  if (!text || text.length > max || /[\r\n\0]/.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}
function cleanTextHeader(value: string, max: number): string { return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || "(empty)"; }
function sanitizeBody(value: string, max: number): string {
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!text || text.length > max) throw new Error("Email text body is invalid.");
  return text;
}
function safeFileName(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 200) || "attachment.bin"; }
function hashProjection(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function validateCa(value: string | Buffer | undefined, label: string): void {
  if (value && (Buffer.byteLength(value) > 1024 * 1024 || !value.toString().includes("-----BEGIN CERTIFICATE-----"))) throw new Error(`${label} TLS CA material is invalid.`);
}
function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} is invalid.`);
  return value;
}
function isPrivateOrSpecialIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) || (a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    const value = address.toLowerCase();
    const mapped = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) { const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16); return isPrivateOrSpecialIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`); }
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value) || value.startsWith("ff") || value.startsWith("2001:db8:");
  }
  return false;
}
