import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createConnection, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { ChannelGateway } from "./channel-gateway.js";
import type { ChannelAdapter, ChannelDeliveryResult, OutboundChannelMessage } from "./delivery-adapters.js";

const IRC_MAX_WIRE_BYTES = 512;
const IRC_MAX_INBOUND_LINE_BYTES = 8192;
const IRC_MAX_BUFFER_BYTES = 64 * 1024;
const IRC_MAX_IN_FLIGHT = 20;

export interface IrcChannelAdapterOptions {
  gateway: ChannelGateway;
  tenantId: string;
  host: string;
  port?: number;
  tls?: boolean;
  allowPlaintext?: boolean;
  allowPrivateHost?: boolean;
  tlsCa?: string | Buffer;
  nickname: string;
  username?: string;
  realName?: string;
  channels: string[];
  allowedNicknames?: string[];
  allowedAccounts?: string[];
  serverPassword?: string;
  sasl?: { account: string; password: string; authorizationIdentity?: string };
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  connectTimeoutMs?: number;
  outboundIntervalMs?: number;
  lookup?: typeof dnsLookup;
  random?: () => number;
}

export interface IrcConnectionStatus {
  id: "irc";
  state: "stopped" | "resolving" | "connecting" | "registering" | "connected" | "blocked" | "reconnecting";
  tls: boolean;
  generation: number;
  reconnectAttempt: number;
  joinedChannels: number;
  configuredChannels: number;
  inFlight: number;
  capabilities: string[];
  saslConfigured: boolean;
  lastErrorCode?: "dns" | "connect" | "tls" | "authentication" | "nickname" | "protocol" | "transport" | "gateway";
}

interface ParsedIrcMessage {
  tags: Record<string, string>;
  prefix?: string;
  command: string;
  params: string[];
  trailing?: string;
}

/**
 * Real IRC/IRCv3 long-lived channel transport.
 *
 * TLS verification is mandatory by default. Plaintext requires an explicit
 * switch and cannot carry PASS/SASL credentials. DNS is resolved before every
 * connection and all answers must be public unless private infrastructure was
 * explicitly enabled by the operator.
 */
export class IrcChannelAdapter implements ChannelAdapter {
  readonly id = "irc";
  private readonly host: string;
  private readonly port: number;
  private readonly useTls: boolean;
  private readonly nickname: string;
  private readonly username: string;
  private readonly realName: string;
  private readonly channels: string[];
  private readonly channelSet: Set<string>;
  private readonly allowedNicknames: Set<string>;
  private readonly allowedAccounts: Set<string>;
  private readonly lookup: typeof dnsLookup;
  private readonly random: () => number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly connectTimeoutMs: number;
  private readonly outboundIntervalMs: number;
  private socket: Socket | TLSSocket | undefined;
  private state: IrcConnectionStatus["state"] = "stopped";
  private stopped = true;
  private blocked = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connectTimer: NodeJS.Timeout | undefined;
  private generation = 0;
  private reconnectAttempt = 0;
  private joinedChannels = 0;
  private inFlight = 0;
  private inboundSequence = 0;
  private inputBuffer = Buffer.alloc(0);
  private advertisedCapabilities = new Set<string>();
  private negotiatedCapabilities = new Set<string>();
  private capLsComplete = false;
  private capEndSent = false;
  private saslPlainAvailable = false;
  private saslInProgress = false;
  private authorizedDestinations = new Set<string>();
  private writeTail: Promise<void> = Promise.resolve();
  private lastWriteAt = 0;
  private lastErrorCode: IrcConnectionStatus["lastErrorCode"];

  constructor(private readonly options: IrcChannelAdapterOptions) {
    this.host = validHost(options.host);
    this.port = boundedInteger(options.port ?? (options.tls === false ? 6667 : 6697), 1, 65535, "IRC port");
    this.useTls = options.tls !== false;
    if (!this.useTls && options.allowPlaintext !== true) throw new Error("IRC plaintext transport requires IRC_ALLOW_PLAINTEXT=true.");
    if (!this.useTls && (options.serverPassword || options.sasl)) throw new Error("IRC credentials cannot be sent over plaintext transport.");
    if (!this.useTls && options.tlsCa) throw new Error("IRC TLS CA material requires TLS transport.");
    if (options.tlsCa && Buffer.byteLength(options.tlsCa) > 1024 * 1024) throw new Error("IRC TLS CA material exceeds 1 MiB.");
    if (!options.allowPrivateHost && isPrivateOrSpecialIp(this.host)) throw new Error("Private or special-use IRC destination is forbidden.");
    this.nickname = validNick(options.nickname, "IRC nickname");
    this.username = validUser(options.username ?? options.nickname);
    this.realName = cleanAtom(options.realName ?? "Hybrid Agent Fabric", 100, "IRC real name");
    this.channels = [...new Set(options.channels.map(validChannel))].slice(0, 100);
    if (!this.channels.length) throw new Error("IRC requires at least one configured channel.");
    this.channelSet = new Set(this.channels.map(ircCasefold));
    this.allowedNicknames = new Set((options.allowedNicknames ?? []).map((item) => ircCasefold(validNick(item, "IRC allowed nickname"))));
    this.allowedAccounts = new Set((options.allowedAccounts ?? []).map((item) => ircCasefold(validAccount(item, "IRC allowed account"))));
    if (!this.allowedNicknames.size && !this.allowedAccounts.size) throw new Error("IRC requires a non-empty nickname or account allowlist.");
    if (options.serverPassword && (options.serverPassword.length > 500 || /[\r\n\0]/.test(options.serverPassword))) throw new Error("IRC server password is invalid.");
    if (options.sasl) {
      validAccount(options.sasl.account, "IRC SASL account");
      if (!options.sasl.password || options.sasl.password.length > 1000 || /[\r\n\0]/.test(options.sasl.password)) throw new Error("IRC SASL password is invalid.");
      if (options.sasl.authorizationIdentity !== undefined && options.sasl.authorizationIdentity !== "") validAccount(options.sasl.authorizationIdentity, "IRC SASL authorization identity");
    }
    this.lookup = options.lookup ?? dnsLookup;
    this.random = options.random ?? Math.random;
    this.reconnectMinMs = boundedInteger(options.reconnectMinMs ?? 1000, 100, 60_000, "IRC reconnect minimum");
    this.reconnectMaxMs = boundedInteger(options.reconnectMaxMs ?? 60_000, this.reconnectMinMs, 10 * 60_000, "IRC reconnect maximum");
    this.connectTimeoutMs = boundedInteger(options.connectTimeoutMs ?? 15_000, 1000, 120_000, "IRC connect timeout");
    this.outboundIntervalMs = boundedInteger(options.outboundIntervalMs ?? 800, 0, 10_000, "IRC outbound interval");
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.blocked = false;
    this.reconnectAttempt = 0;
    void this.connectNow();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.blocked = false;
    this.state = "stopped";
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.reconnectTimer = undefined;
    this.connectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { socket.destroy(); resolve(); }, 1000);
        timer.unref();
        socket.once("close", () => { clearTimeout(timer); resolve(); });
        socket.end("QUIT :HAF shutdown\r\n");
      });
    }
    await this.writeTail.catch(() => undefined);
  }

  status(): IrcConnectionStatus {
    return {
      id: "irc", state: this.state, tls: this.useTls, generation: this.generation,
      reconnectAttempt: this.reconnectAttempt, joinedChannels: this.joinedChannels,
      configuredChannels: this.channels.length, inFlight: this.inFlight,
      capabilities: [...this.negotiatedCapabilities].sort(), saslConfigured: Boolean(this.options.sasl),
      ...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
    };
  }

  async waitUntilConnected(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.state === "connected") return;
      if (this.state === "blocked") throw new Error(`IRC connection blocked (${this.lastErrorCode ?? "unknown"}).`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("IRC connection did not become ready before timeout.");
  }

  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    if (message.media) throw new Error("IRC does not support direct binary media delivery.");
    if (this.state !== "connected" || !this.socket || this.socket.destroyed) throw new Error("IRC adapter is not connected.");
    if (signal?.aborted) throw signal.reason ?? new Error("IRC send aborted.");
    const destination = validDestination(message.destination);
    const foldedDestination = ircCasefold(destination);
    if (!this.channelSet.has(foldedDestination) && !this.allowedNicknames.has(foldedDestination) && !this.authorizedDestinations.has(foldedDestination)) {
      throw new Error("IRC destination is outside configured channels and authorized senders.");
    }
    const text = sanitizeText(message.text, 100_000);
    const frames = splitIrcText(destination, text);
    for (const frame of frames) {
      if (signal?.aborted) throw signal.reason ?? new Error("IRC send aborted.");
      await this.queueLine(frame, signal);
    }
    return {
      platform: this.id, destination, messageId: randomUUID(), timestamp: new Date().toISOString(), rawStatus: 202,
    };
  }

  private async connectNow(): Promise<void> {
    if (this.stopped || this.blocked || this.socket) return;
    this.state = "resolving";
    let addresses: Array<{ address: string; family: number }>;
    try {
      const literal = isIP(this.host);
      addresses = literal ? [{ address: this.host, family: literal }] : await this.lookup(this.host, { all: true, verbatim: true });
      if (!addresses.length) throw new Error("no addresses");
      if (!this.options.allowPrivateHost && addresses.some((item) => isPrivateOrSpecialIp(item.address))) throw new Error("private address");
    } catch {
      this.lastErrorCode = "dns";
      this.scheduleReconnect();
      return;
    }
    this.state = "connecting";
    const target = addresses[0]!;
    const socket: Socket | TLSSocket = this.useTls
      ? tlsConnect({
          host: target.address, port: this.port, rejectUnauthorized: true,
          ...(this.options.tlsCa ? { ca: this.options.tlsCa } : {}),
          ...(!isIP(this.host) ? { servername: this.host } : {}),
        })
      : createConnection({ host: target.address, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    this.connectTimer = setTimeout(() => {
      this.lastErrorCode = "connect";
      socket.destroy(new Error("connect timeout"));
    }, this.connectTimeoutMs);
    this.connectTimer.unref();
    const readyEvent = this.useTls ? "secureConnect" : "connect";
    socket.once(readyEvent, () => this.onTransportReady(socket));
    socket.on("data", (chunk: Buffer) => this.onData(socket, chunk));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (!this.lastErrorCode) this.lastErrorCode = this.useTls && /certificate|tls|ssl/i.test(error.message) ? "tls" : "transport";
    });
    socket.once("close", () => this.onClose(socket));
  }

  private onTransportReady(socket: Socket | TLSSocket): void {
    if (socket !== this.socket || this.stopped) return;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.generation++;
    this.reconnectAttempt = 0;
    this.joinedChannels = 0;
    this.inputBuffer = Buffer.alloc(0);
    this.advertisedCapabilities.clear();
    this.negotiatedCapabilities.clear();
    this.capLsComplete = false;
    this.capEndSent = false;
    this.saslPlainAvailable = false;
    this.saslInProgress = false;
    this.authorizedDestinations = new Set();
    this.state = "registering";
    this.lastErrorCode = undefined;
    this.connectTimer = setTimeout(() => {
      this.lastErrorCode = "transport";
      socket.destroy(new Error("registration timeout"));
    }, this.connectTimeoutMs);
    this.connectTimer.unref();
    this.writeImmediate("CAP LS 302");
    if (this.options.serverPassword) this.writeImmediate(`PASS ${this.options.serverPassword}`);
    this.writeImmediate(`NICK ${this.nickname}`);
    this.writeImmediate(`USER ${this.username} 0 * :${this.realName}`);
  }

  private onData(socket: Socket | TLSSocket, chunk: Buffer): void {
    if (socket !== this.socket || this.stopped) return;
    if (this.inputBuffer.length + chunk.length > IRC_MAX_BUFFER_BYTES) {
      this.protocolViolation(socket);
      return;
    }
    this.inputBuffer = Buffer.concat([this.inputBuffer, chunk]);
    while (true) {
      const index = this.inputBuffer.indexOf(0x0a);
      if (index < 0) break;
      let line = this.inputBuffer.subarray(0, index);
      this.inputBuffer = this.inputBuffer.subarray(index + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      if (!line.length) continue;
      if (line.length > IRC_MAX_INBOUND_LINE_BYTES || line.includes(0)) {
        this.protocolViolation(socket);
        return;
      }
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(line);
      const parsed = parseIrcMessage(decoded);
      if (!parsed) {
        this.protocolViolation(socket);
        return;
      }
      this.handleMessage(parsed, decoded);
    }
  }

  private handleMessage(message: ParsedIrcMessage, raw: string): void {
    const command = message.command.toUpperCase();
    if (command === "PING") {
      const token = message.trailing ?? message.params[0] ?? "";
      this.writeImmediate(`PONG :${sanitizeProtocolToken(token, 400)}`);
      return;
    }
    if (command === "CAP") {
      this.handleCap(message);
      return;
    }
    if (command === "AUTHENTICATE" && message.params[0] === "+" && this.saslInProgress) {
      this.sendSaslPlain();
      return;
    }
    if (["900", "903"].includes(command) && this.saslInProgress) {
      this.saslInProgress = false;
      this.finishCapabilities();
      return;
    }
    if (["904", "905", "906", "907"].includes(command)) {
      this.blockConnection("authentication");
      return;
    }
    if (command === "433") {
      this.blockConnection("nickname");
      return;
    }
    if (command === "001") {
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      if (!this.capEndSent) this.finishCapabilities();
      this.state = "connected";
      this.lastErrorCode = undefined;
      for (const channel of this.channels) this.writeImmediate(`JOIN ${channel}`);
      return;
    }
    if (command === "JOIN") {
      const nick = prefixNick(message.prefix);
      if (nick && ircCasefold(nick) === ircCasefold(this.nickname)) this.joinedChannels = Math.min(this.channels.length, this.joinedChannels + 1);
      return;
    }
    if (command !== "PRIVMSG" || this.state !== "connected" || this.inFlight >= IRC_MAX_IN_FLIGHT) return;
    const target = message.params[0];
    const sourceNick = prefixNick(message.prefix);
    if (!target || !sourceNick || ircCasefold(sourceNick) === ircCasefold(this.nickname)) return;
    const text = sanitizeInboundText(message.trailing ?? "");
    if (!text) return;
    const account = message.tags.account && message.tags.account !== "*" ? message.tags.account : undefined;
    const authorized = this.allowedNicknames.has(ircCasefold(sourceNick)) || Boolean(account && this.allowedAccounts.has(ircCasefold(account)));
    if (!authorized) return;
    const isChannel = /^[#&+!]/.test(target);
    if (isChannel && !this.channelSet.has(ircCasefold(target))) return;
    if (!isChannel && ircCasefold(target) !== ircCasefold(this.nickname)) return;
    const responseDestination = isChannel ? target : sourceNick;
    this.authorizedDestinations.add(ircCasefold(sourceNick));
    const userId = account ?? sourceNick;
    const messageId = validMessageId(message.tags.msgid)
      ?? createHash("sha256").update(`${this.generation}\0${++this.inboundSequence}\0${raw}`).digest("hex");
    const serverTime = validServerTime(message.tags.time);
    this.inFlight++;
    void this.options.gateway.ingest({
      tenantId: this.options.tenantId, platform: "irc", chatId: isChannel ? target : `dm:${userId}`,
      chatType: isChannel ? "channel" : "dm", userId, text, messageId, authorized: true,
      metadata: {
        ircAccountHash: createHash("sha256").update(account ?? "").digest("hex").slice(0, 24),
        ...(serverTime ? { serverTime } : {}),
      },
    }).then(async (delivery) => {
      if (delivery.text && this.state === "connected") await this.send({ destination: responseDestination, text: delivery.text });
    }).catch(() => { this.lastErrorCode = "gateway"; }).finally(() => { this.inFlight--; });
  }

  private handleCap(message: ParsedIrcMessage): void {
    const subcommand = String(message.params[1] ?? message.params[0] ?? "").toUpperCase();
    const values = (message.trailing ?? message.params.at(-1) ?? "").split(" ").filter(Boolean);
    if (subcommand === "LS") {
      for (const value of values) {
        const [name, configured] = value.split("=", 2);
        this.advertisedCapabilities.add(name!);
        if (name === "sasl" && (!configured || configured.split(",").some((mechanism) => mechanism.toUpperCase() === "PLAIN"))) this.saslPlainAvailable = true;
      }
      // params[0] is commonly the target "*". Only a later star marks a multiline LS reply.
      const continuation = message.params.slice(2).includes("*");
      if (continuation) return;
      this.capLsComplete = true;
      const requested = ["message-tags", "server-time", "account-tag"].filter((item) => this.advertisedCapabilities.has(item));
      if (this.options.sasl && this.advertisedCapabilities.has("sasl") && this.saslPlainAvailable) requested.push("sasl");
      if (this.options.sasl && !requested.includes("sasl")) {
        this.blockConnection("authentication");
        return;
      }
      if (!requested.length) this.finishCapabilities();
      else this.writeImmediate(`CAP REQ :${requested.join(" ")}`);
      return;
    }
    if (subcommand === "ACK") {
      for (const value of values) this.negotiatedCapabilities.add(value.replace(/^-/, "").split("=")[0]!);
      if (this.options.sasl && values.some((item) => item.replace(/^-/, "").split("=")[0] === "sasl")) {
        this.saslInProgress = true;
        this.writeImmediate("AUTHENTICATE PLAIN");
      } else this.finishCapabilities();
      return;
    }
    if (subcommand === "NAK") {
      if (this.options.sasl) this.blockConnection("authentication");
      else this.finishCapabilities();
    }
  }

  private sendSaslPlain(): void {
    const sasl = this.options.sasl;
    if (!sasl) return this.finishCapabilities();
    const authorizationIdentity = sasl.authorizationIdentity ?? sasl.account;
    const encoded = Buffer.from(`${authorizationIdentity}\0${sasl.account}\0${sasl.password}`, "utf8").toString("base64");
    for (let offset = 0; offset < encoded.length; offset += 400) this.writeImmediate(`AUTHENTICATE ${encoded.slice(offset, offset + 400)}`);
    if (encoded.length % 400 === 0) this.writeImmediate("AUTHENTICATE +");
  }

  private finishCapabilities(): void {
    if (this.capEndSent) return;
    this.capEndSent = true;
    this.writeImmediate("CAP END");
  }

  private writeImmediate(line: string): void {
    const socket = this.socket;
    if (!socket || socket.destroyed || /[\r\n\0]/.test(line) || Buffer.byteLength(`${line}\r\n`) > IRC_MAX_WIRE_BYTES) return;
    socket.write(`${line}\r\n`);
  }

  private async queueLine(line: string, signal?: AbortSignal): Promise<void> {
    const operation = async () => {
      const socket = this.socket;
      if (!socket || socket.destroyed || this.state !== "connected") throw new Error("IRC transport became unavailable before send.");
      if (signal?.aborted) throw signal.reason ?? new Error("IRC send aborted.");
      const waitMs = Math.max(0, this.lastWriteAt + this.outboundIntervalMs - Date.now());
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      if (signal?.aborted) throw signal.reason ?? new Error("IRC send aborted.");
      await new Promise<void>((resolve, reject) => socket.write(`${line}\r\n`, (error) => error ? reject(error) : resolve()));
      this.lastWriteAt = Date.now();
    };
    const result = this.writeTail.then(operation);
    this.writeTail = result.catch(() => undefined);
    return await result;
  }

  private protocolViolation(socket: Socket | TLSSocket): void {
    this.lastErrorCode = "protocol";
    socket.destroy();
  }

  private blockConnection(code: "authentication" | "nickname"): void {
    this.lastErrorCode = code;
    this.blocked = true;
    this.state = "blocked";
    this.socket?.destroy();
  }

  private onClose(socket: Socket | TLSSocket): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.inputBuffer = Buffer.alloc(0);
    this.joinedChannels = 0;
    if (this.stopped) this.state = "stopped";
    else if (this.blocked) this.state = "blocked";
    else this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.blocked || this.reconnectTimer) return;
    this.state = "reconnecting";
    const exponential = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** Math.min(this.reconnectAttempt++, 10));
    const delay = Math.max(100, Math.floor(exponential * (0.8 + this.random() * 0.4)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectNow();
    }, delay);
    this.reconnectTimer.unref();
  }
}

function parseIrcMessage(line: string): ParsedIrcMessage | undefined {
  if (!line || /[\r\n\0]/.test(line)) return undefined;
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const end = rest.indexOf(" ");
    if (end < 2) return undefined;
    for (const pair of rest.slice(1, end).split(";").slice(0, 100)) {
      const separator = pair.indexOf("=");
      const key = separator < 0 ? pair : pair.slice(0, separator);
      if (!/^[A-Za-z0-9+./-]{1,100}$/.test(key)) continue;
      tags[key] = ircTagUnescape(separator < 0 ? "" : pair.slice(separator + 1)).slice(0, 500);
    }
    rest = rest.slice(end + 1);
  }
  let prefix: string | undefined;
  if (rest.startsWith(":")) {
    const end = rest.indexOf(" ");
    if (end < 2) return undefined;
    prefix = rest.slice(1, end).slice(0, 500);
    rest = rest.slice(end + 1);
  }
  let trailing: string | undefined;
  const trailingIndex = rest.indexOf(" :");
  if (trailingIndex >= 0) {
    trailing = rest.slice(trailingIndex + 2);
    rest = rest.slice(0, trailingIndex);
  }
  const parts = rest.split(/ +/).filter(Boolean);
  const command = parts.shift();
  if (!command || !/^(?:[A-Za-z]+|\d{3})$/.test(command) || parts.length > 15) return undefined;
  return { tags, ...(prefix ? { prefix } : {}), command, params: parts, ...(trailing !== undefined ? { trailing } : {}) };
}

function splitIrcText(destination: string, text: string): string[] {
  const prefix = `PRIVMSG ${destination} :`;
  const maxPayloadBytes = IRC_MAX_WIRE_BYTES - 2 - Buffer.byteLength(prefix);
  if (maxPayloadBytes < 1) throw new Error("IRC destination leaves no message payload capacity.");
  const output: string[] = [];
  for (const logicalLine of text.split(/\r?\n/)) {
    let chunk = "";
    for (const character of logicalLine || " ") {
      if (Buffer.byteLength(chunk + character) > maxPayloadBytes) {
        if (chunk) output.push(`${prefix}${chunk}`);
        chunk = character;
      } else chunk += character;
    }
    if (chunk) output.push(`${prefix}${chunk}`);
  }
  if (!output.length || output.length > 1000) throw new Error("IRC message produces an invalid number of frames.");
  return output;
}

function sanitizeInboundText(value: string): string {
  if (!value || value.startsWith("\u0001")) return "";
  return value
    .replace(/\u0003(?:\d{1,2}(?:,\d{1,2})?)?/g, "")
    .replace(/[\u0002\u000f\u0011\u0016\u001d\u001e\u001f]/g, "")
    .replace(/[\u0000\r\n]/g, " ")
    .trim()
    .slice(0, 16_384);
}

function sanitizeText(value: string, max: number): string {
  const text = value.replace(/[\u0000]/g, "").trim();
  if (!text || text.length > max) throw new Error("IRC message text is invalid.");
  return text;
}
function validHost(value: string): string {
  const host = value.trim().replace(/^\[|\]$/g, "");
  if (!host || host.length > 253 || /[\s/@\\\0]/.test(host) || (!isIP(host) && !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(host))) {
    throw new Error("IRC host is invalid.");
  }
  return host;
}
function validNick(value: string, label: string): string {
  const nick = value.trim();
  if (!/^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,30}$/.test(nick)) throw new Error(`${label} is invalid.`);
  return nick;
}
function validUser(value: string): string {
  const user = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$/.test(user)) throw new Error("IRC username is invalid.");
  return user;
}
function validAccount(value: string, label: string): string {
  const account = value.trim();
  if (!account || account.length > 200 || /[\s\r\n\0]/.test(account)) throw new Error(`${label} is invalid.`);
  return account;
}
function validChannel(value: string): string {
  const channel = value.trim();
  if (!/^[#&+!][^\s,\u0000\u0007\r\n:]{1,100}$/.test(channel)) throw new Error("IRC channel is invalid.");
  return channel;
}
function validDestination(value: string): string {
  const destination = value.trim();
  if (/^[#&+!]/.test(destination)) return validChannel(destination);
  return validNick(destination, "IRC destination");
}
function cleanAtom(value: string, max: number, label: string): string {
  const text = value.trim();
  if (!text || text.length > max || /[\r\n\0]/.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}
function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} is invalid.`);
  return value;
}
function prefixNick(prefix: string | undefined): string | undefined {
  const nick = prefix?.split(/[!@]/, 1)[0];
  return nick && /^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,30}$/.test(nick) ? nick : undefined;
}
function ircCasefold(value: string): string {
  return value.toLowerCase().replace(/\[/g, "{").replace(/\]/g, "}").replace(/\\/g, "|").replace(/\^/g, "~");
}
function ircTagUnescape(value: string): string {
  return value.replace(/\\([s:\\rn])/g, (_match, char: string) => char === "s" ? " " : char === ":" ? ";" : char === "r" ? "\r" : char === "n" ? "\n" : char);
}
function validMessageId(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9._~+:/=-]{1,200}$/.test(value) ? value : undefined;
}
function validServerTime(value: string | undefined): string | undefined {
  if (!value || value.length > 100) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
function sanitizeProtocolToken(value: string, max: number): string { return value.replace(/[\r\n\0]/g, "").slice(0, max); }
function isPrivateOrSpecialIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b, c] = parts as [number, number, number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && c === 2)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    const value = address.toLowerCase();
    const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1]!, 16), low = Number.parseInt(mappedHex[2]!, 16);
      return isPrivateOrSpecialIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd")
      || /^fe[89ab]/.test(value) || value.startsWith("ff") || value.startsWith("2001:db8:")
      || value.startsWith("::ffff:127.") || value.startsWith("::ffff:10.") || value.startsWith("::ffff:192.168.");
  }
  return false;
}
