import { createHmac, randomUUID } from "node:crypto";

export interface OutboundMedia {
  fileName: string;
  mimeType: string;
  data: Uint8Array;
}

export interface OutboundChannelMessage {
  destination: string;
  text: string;
  threadId?: string;
  media?: OutboundMedia;
  metadata?: Record<string, string>;
}

export interface ChannelDeliveryResult {
  platform: string;
  destination: string;
  messageId?: string;
  timestamp: string;
  rawStatus: number;
}

export interface ChannelAdapter {
  readonly id: string;
  send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult>;
  start?(): void;
  close?(): Promise<void>;
  status?(): unknown;
}

/**
 * An outbound platform (Telegram, Slack, Discord, …) refused or could not
 * receive a delivery.
 *
 * Every adapter reaches the network through {@link jsonRequest}, so this is the
 * single place a delivery failure is classified. What it distinguishes, and
 * why the distinction is worth carrying as data rather than prose:
 *
 * - **`rate-limited`** — the platform said "too fast, come back later", usually
 *   with a `Retry-After`. A caller can honour that; a 500 tells it nothing.
 * - **`quota-exceeded`** — the account's allowance is gone. Retrying sooner
 *   will not help, so the caller should stop rather than back off.
 * - **`connection-failed`** — we could not reach the platform at all. This is a
 *   502-shaped condition: the failure is upstream of us and retryable.
 * - **`rejected`** — the platform answered and said no (bad destination,
 *   revoked token, malformed payload). Retrying unchanged will fail again.
 */
export class ChannelDeliveryError extends Error {
  constructor(
    readonly platform: string,
    readonly disposition: "rejected" | "rate-limited" | "quota-exceeded" | "connection-failed",
    message: string,
    readonly detail: {
      destination?: string;
      httpStatus?: number;
      retryAfterMs?: number;
      cause?: string;
    } = {},
  ) {
    super(message);
    this.name = "ChannelDeliveryError";
  }
}

/**
 * Retry-After, in milliseconds. HTTP allows seconds or an HTTP date; both are
 * normalised here because a caller that has to parse two formats per platform
 * is a caller that parses neither.
 */
function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/**
 * Quota exhaustion, as distinct from a rate limit.
 *
 * The two look alike in a message ("quota", "limit") and mean opposite things:
 * a rate limit clears on its own in seconds, a quota does not clear until the
 * billing period rolls over. Classifying a quota as a rate limit is what makes
 * a caller retry in a tight loop against an account that cannot spend.
 */
function isQuotaExhausted(status: number, text: string): boolean {
  if (/quota|billing|credit|insufficient[_ ]?(?:funds|balance)|subscription/i.test(text)) return true;
  // 402 is payment-required; 403 with allowance wording is a plan limit, not a
  // permission denial. Both mean "spend more", not "slow down".
  if (status === 402) return true;
  return status === 403 && /allowance|exceeded|exhausted|upgrade your plan/i.test(text);
}

async function jsonRequest(
  url: string,
  init: RequestInit,
  platform: string,
  destination: string,
): Promise<{ body: any; result: ChannelDeliveryResult }> {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error(`${platform} delivery endpoint is invalid.`);
  let response: Response;
  try {
    response = await fetch(target, { ...init, redirect: "manual" });
  } catch (error) {
    // Unwrap the `fetch failed` wrapper undici throws: the useful part is the
    // cause, whose code names whether this was DNS, a refused socket or a
    // timeout. AbortError is the caller's own cancellation and stays untyped.
    if ((error as { name?: string })?.name === "AbortError") throw error;
    const code = (error as { cause?: { code?: unknown } })?.cause?.code;
    throw new ChannelDeliveryError(
      platform,
      "connection-failed",
      `${platform} could not be reached${typeof code === "string" ? ` (${code})` : ""}.`,
      { destination, ...(typeof code === "string" ? { cause: code } : {}) },
    );
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${platform} delivery redirects are forbidden.`);
  }
  const text = await boundedResponseText(response, 2 * 1024 * 1024);
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  if (!response.ok || body?.ok === false || (platform === "feishu" && typeof body?.code === "number" && body.code !== 0)) {
    const raw = String(body?.error ?? body?.description ?? body?.msg ?? body?.message ?? text);
    const safe = raw.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/(token|secret|authorization)[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]").replace(/[\r\n\t]+/g, " ").slice(0, 500);
    // Telegram answers 429 with a JSON body instead of a Retry-After header;
    // everybody else uses the header. Check both before giving up on the hint.
    const parameters = body?.parameters;
    const headerRetry = retryAfterMs(response.headers.get("retry-after"));
    const bodyRetry = parameters && typeof parameters.retry_after === "number" && parameters.retry_after >= 0
      ? Math.round(parameters.retry_after * 1000)
      : undefined;
    const retry = headerRetry ?? bodyRetry;
    const disposition: ChannelDeliveryError["disposition"] =
      response.status === 429 ? "rate-limited" : isQuotaExhausted(response.status, `${safe} ${raw}`) ? "quota-exceeded" : "rejected";
    throw new ChannelDeliveryError(
      platform,
      disposition,
      `${platform} delivery failed (${response.status})${safe ? `: ${safe}` : "."}`,
      {
        destination,
        httpStatus: response.status,
        ...(retry !== undefined ? { retryAfterMs: retry } : {}),
      },
    );
  }
  return {
    body,
    result: { platform, destination, timestamp: new Date().toISOString(), rawStatus: response.status },
  };
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "", bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Channel provider response exceeds its safety bound.");
      }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally { reader.releaseLock(); }
}

function providerBase(value: string, platform: string, allowLoopbackHttp = false): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(allowLoopbackHttp && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${platform} API base must be a credential-free HTTPS origin${allowLoopbackHttp ? " (loopback HTTP allowed)" : ""}.`);
  }
  return url.toString().replace(/\/$/, "");
}

function unsupportedMedia(platform: string, message: OutboundChannelMessage): void {
  if (message.media) throw new Error(`${platform} adapter does not support direct binary media delivery.`);
}

function mediaBlob(media: OutboundMedia): Blob {
  const copy = new Uint8Array(media.data.byteLength); copy.set(media.data);
  return new Blob([copy.buffer], { type: media.mimeType });
}

function mediaKind(mimeType: string): "image" | "video" | "audio" | "document" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram";
  constructor(private readonly botToken: string, private readonly apiBase = "https://api.telegram.org") {}
  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    if (message.media) {
      const kind = mediaKind(message.media.mimeType);
      const method = kind === "image" ? "sendPhoto" : kind === "video" ? "sendVideo" : kind === "audio" ? "sendAudio" : "sendDocument";
      const field = kind === "image" ? "photo" : kind === "video" ? "video" : kind === "audio" ? "audio" : "document";
      const form = new FormData(); form.set("chat_id", message.destination); form.set("caption", message.text);
      if (message.threadId) form.set("message_thread_id", message.threadId);
      form.set(field, mediaBlob(message.media), message.media.fileName);
      const { body, result } = await jsonRequest(`${this.apiBase.replace(/\/$/, "")}/bot${this.botToken}/${method}`, {
        method: "POST", body: form, ...(signal ? { signal } : {}),
      }, this.id, message.destination);
      return { ...result, ...(body?.result?.message_id !== undefined ? { messageId: String(body.result.message_id) } : {}) };
    }
    const { body, result } = await jsonRequest(
      `${this.apiBase.replace(/\/$/, "")}/bot${this.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: message.destination,
          text: message.text,
          ...(message.threadId ? { message_thread_id: message.threadId } : {}),
        }),
        ...(signal ? { signal } : {}),
      },
      this.id,
      message.destination,
    );
    return { ...result, ...(body?.result?.message_id !== undefined ? { messageId: String(body.result.message_id) } : {}) };
  }
}

export class DiscordBotAdapter implements ChannelAdapter {
  readonly id = "discord";
  constructor(private readonly botToken: string, private readonly apiBase = "https://discord.com/api/v10") {}
  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    const url = `${this.apiBase.replace(/\/$/, "")}/channels/${encodeURIComponent(message.destination)}/messages`;
    if (message.media) {
      const form = new FormData();
      form.set("payload_json", JSON.stringify({ content: message.text, ...(message.threadId ? { message_reference: { message_id: message.threadId } } : {}) }));
      form.set("files[0]", mediaBlob(message.media), message.media.fileName);
      const { body, result } = await jsonRequest(url, { method: "POST", headers: { authorization: `Bot ${this.botToken}` }, body: form, ...(signal ? { signal } : {}) }, this.id, message.destination);
      return { ...result, ...(body?.id ? { messageId: String(body.id) } : {}) };
    }
    const { body, result } = await jsonRequest(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bot ${this.botToken}` },
        body: JSON.stringify({ content: message.text, ...(message.threadId ? { message_reference: { message_id: message.threadId } } : {}) }),
        ...(signal ? { signal } : {}),
      },
      this.id,
      message.destination,
    );
    return { ...result, ...(body?.id ? { messageId: String(body.id) } : {}) };
  }
}

export class SlackAdapter implements ChannelAdapter {
  readonly id = "slack";
  constructor(private readonly botToken: string, private readonly apiBase = "https://slack.com/api") {}
  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    if (message.media) {
      const form = new FormData(); form.set("channels", message.destination); form.set("initial_comment", message.text);
      if (message.threadId) form.set("thread_ts", message.threadId);
      form.set("file", mediaBlob(message.media), message.media.fileName);
      const { body, result } = await jsonRequest(`${this.apiBase.replace(/\/$/, "")}/files.upload`, {
        method: "POST", headers: { authorization: `Bearer ${this.botToken}` }, body: form, ...(signal ? { signal } : {}),
      }, this.id, message.destination);
      return { ...result, ...(body?.file?.id ? { messageId: String(body.file.id) } : {}) };
    }
    const { body, result } = await jsonRequest(
      `${this.apiBase.replace(/\/$/, "")}/chat.postMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${this.botToken}` },
        body: JSON.stringify({ channel: message.destination, text: message.text, ...(message.threadId ? { thread_ts: message.threadId } : {}) }),
        ...(signal ? { signal } : {}),
      },
      this.id,
      message.destination,
    );
    return { ...result, ...(body?.ts ? { messageId: String(body.ts) } : {}) };
  }
}

export class WhatsAppCloudAdapter implements ChannelAdapter {
  readonly id = "whatsapp";
  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
    private readonly graphBase = "https://graph.facebook.com/v22.0",
  ) {}
  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    if (message.media) {
      const root = `${this.graphBase.replace(/\/$/, "")}/${encodeURIComponent(this.phoneNumberId)}`;
      const form = new FormData(); form.set("messaging_product", "whatsapp"); form.set("file", mediaBlob(message.media), message.media.fileName);
      const uploaded = await jsonRequest(`${root}/media`, { method: "POST", headers: { authorization: `Bearer ${this.accessToken}` }, body: form, ...(signal ? { signal } : {}) }, this.id, message.destination);
      const mediaId = uploaded.body?.id; if (!mediaId) throw new Error("whatsapp media upload returned no id");
      const kind = mediaKind(message.media.mimeType); const type = kind === "image" ? "image" : kind === "video" ? "video" : kind === "audio" ? "audio" : "document";
      const mediaPayload = { id: mediaId, ...(type !== "audio" && message.text ? { caption: message.text } : {}), ...(type === "document" ? { filename: message.media.fileName } : {}) };
      const delivered = await jsonRequest(`${root}/messages`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.accessToken}` },
        body: JSON.stringify({ messaging_product: "whatsapp", to: message.destination, type, [type]: mediaPayload }), ...(signal ? { signal } : {}),
      }, this.id, message.destination);
      const messageId = delivered.body?.messages?.[0]?.id;
      return { ...delivered.result, ...(messageId ? { messageId: String(messageId) } : {}) };
    }
    const { body, result } = await jsonRequest(
      `${this.graphBase.replace(/\/$/, "")}/${encodeURIComponent(this.phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.accessToken}` },
        body: JSON.stringify({ messaging_product: "whatsapp", to: message.destination, type: "text", text: { body: message.text } }),
        ...(signal ? { signal } : {}),
      },
      this.id,
      message.destination,
    );
    const messageId = body?.messages?.[0]?.id;
    return { ...result, ...(messageId ? { messageId: String(messageId) } : {}) };
  }
}

export class MatrixAdapter implements ChannelAdapter {
  readonly id = "matrix";
  constructor(
    private readonly homeserver: string,
    private readonly accessToken: string,
  ) {}
  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    const transactionId = randomUUID();
    const roomId = encodeURIComponent(message.destination);
    if (message.media) {
      const upload = await jsonRequest(`${this.homeserver.replace(/\/$/, "")}/_matrix/media/v3/upload?filename=${encodeURIComponent(message.media.fileName)}`, {
        method: "POST", headers: { "content-type": message.media.mimeType, authorization: `Bearer ${this.accessToken}` }, body: message.media.data as any, ...(signal ? { signal } : {}),
      }, this.id, message.destination);
      const contentUri = upload.body?.content_uri; if (!contentUri) throw new Error("matrix media upload returned no content_uri");
      const kind = mediaKind(message.media.mimeType); const msgtype = kind === "image" ? "m.image" : kind === "video" ? "m.video" : kind === "audio" ? "m.audio" : "m.file";
      const delivered = await jsonRequest(`${this.homeserver.replace(/\/$/, "")}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${transactionId}`, {
        method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${this.accessToken}` },
        body: JSON.stringify({ msgtype, body: message.text || message.media.fileName, filename: message.media.fileName, url: contentUri, info: { mimetype: message.media.mimeType, size: message.media.data.byteLength } }), ...(signal ? { signal } : {}),
      }, this.id, message.destination);
      return { ...delivered.result, ...(delivered.body?.event_id ? { messageId: String(delivered.body.event_id) } : {}) };
    }
    const { body, result } = await jsonRequest(
      `${this.homeserver.replace(/\/$/, "")}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${transactionId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.accessToken}` },
        body: JSON.stringify({ msgtype: "m.text", body: message.text }),
        ...(signal ? { signal } : {}),
      },
      this.id,
      message.destination,
    );
    return { ...result, ...(body?.event_id ? { messageId: String(body.event_id) } : {}) };
  }
}

export class SignalRestAdapter implements ChannelAdapter {
  readonly id = "signal";
  constructor(
    private readonly baseUrl: string,
    private readonly senderNumber: string,
    private readonly bearerToken?: string,
  ) {}
  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    const { body, result } = await jsonRequest(
      `${this.baseUrl.replace(/\/$/, "")}/v2/send`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
        },
        body: JSON.stringify({
          number: this.senderNumber,
          recipients: [message.destination],
          message: message.text,
          ...(message.media ? { base64_attachments: [`data:${message.media.mimeType};filename=${encodeURIComponent(message.media.fileName)};base64,${Buffer.from(message.media.data).toString("base64")}`] } : {}),
        }),
        ...(signal ? { signal } : {}),
      },
      this.id,
      message.destination,
    );
    const timestamp = body?.timestamp;
    return { ...result, ...(timestamp !== undefined ? { messageId: String(timestamp) } : {}) };
  }
}

export class MattermostAdapter implements ChannelAdapter {
  readonly id = "mattermost";
  private readonly apiBase: string;
  constructor(baseUrl: string, private readonly botToken: string, allowLoopbackHttp = false) {
    const base = providerBase(baseUrl, this.id, allowLoopbackHttp);
    this.apiBase = base.endsWith("/api/v4") ? base : `${base}/api/v4`;
  }
  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    let fileIds: string[] | undefined;
    if (message.media) {
      const form = new FormData();
      form.set("channel_id", message.destination);
      form.set("files", mediaBlob(message.media), message.media.fileName);
      const uploaded = await jsonRequest(`${this.apiBase}/files`, {
        method: "POST", headers: { authorization: `Bearer ${this.botToken}` }, body: form, ...(signal ? { signal } : {}),
      }, this.id, message.destination);
      const uploadedIds: string[] = Array.isArray(uploaded.body?.file_infos)
        ? uploaded.body.file_infos.map((item: any) => String(item?.id ?? "")).filter(Boolean).slice(0, 10)
        : [];
      if (!uploadedIds.length) throw new Error("mattermost media upload returned no file id.");
      fileIds = uploadedIds;
    }
    const { body, result } = await jsonRequest(`${this.apiBase}/posts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.botToken}` },
      body: JSON.stringify({ channel_id: message.destination, message: message.text, ...(message.threadId ? { root_id: message.threadId } : {}), ...(fileIds ? { file_ids: fileIds } : {}) }),
      ...(signal ? { signal } : {}),
    }, this.id, message.destination);
    return { ...result, ...(body?.id ? { messageId: String(body.id) } : {}) };
  }
}

export class LineMessagingAdapter implements ChannelAdapter {
  readonly id = "line";
  private readonly apiBase: string;
  constructor(private readonly channelAccessToken: string, apiBase = "https://api.line.me") {
    this.apiBase = providerBase(apiBase, this.id);
  }
  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    unsupportedMedia(this.id, message);
    const { body, result } = await jsonRequest(`${this.apiBase}/v2/bot/message/push`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.channelAccessToken}` },
      body: JSON.stringify({ to: message.destination, messages: [{ type: "text", text: message.text }] }),
      ...(signal ? { signal } : {}),
    }, this.id, message.destination);
    const id = body?.sentMessages?.[0]?.id;
    return { ...result, ...(id ? { messageId: String(id) } : {}) };
  }
}

export class GoogleChatAdapter implements ChannelAdapter {
  readonly id = "google-chat";
  private readonly apiBase: string;
  constructor(private readonly accessToken: string, apiBase = "https://chat.googleapis.com") {
    this.apiBase = providerBase(apiBase, this.id);
  }
  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    unsupportedMedia(this.id, message);
    const space = message.destination.startsWith("spaces/") ? message.destination.slice("spaces/".length) : message.destination;
    const { body, result } = await jsonRequest(`${this.apiBase}/v1/spaces/${encodeURIComponent(space)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.accessToken}` },
      body: JSON.stringify({ text: message.text, ...(message.threadId ? { thread: { name: message.threadId } } : {}) }),
      ...(signal ? { signal } : {}),
    }, this.id, message.destination);
    return { ...result, ...(body?.name ? { messageId: String(body.name) } : {}) };
  }
}

export class MicrosoftTeamsAdapter implements ChannelAdapter {
  readonly id = "teams";
  private readonly graphBase: string;
  constructor(private readonly accessToken: string, graphBase = "https://graph.microsoft.com") {
    this.graphBase = providerBase(graphBase, this.id);
  }
  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    unsupportedMedia(this.id, message);
    const target = teamsTarget(message.destination);
    const { body, result } = await jsonRequest(`${this.graphBase}/v1.0/${target}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.accessToken}` },
      body: JSON.stringify({ body: { contentType: "text", content: message.text } }),
      ...(signal ? { signal } : {}),
    }, this.id, message.destination);
    return { ...result, ...(body?.id ? { messageId: String(body.id) } : {}) };
  }
}

export class FeishuAdapter implements ChannelAdapter {
  readonly id = "feishu";
  private readonly apiBase: string;
  constructor(private readonly tenantAccessToken: string, apiBase = "https://open.feishu.cn") {
    this.apiBase = providerBase(apiBase, this.id);
  }
  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    let msgType = "text";
    let content: Record<string, string> = { text: message.text };
    if (message.media) {
      const image = message.media.mimeType.startsWith("image/");
      const form = new FormData();
      if (image) form.set("image_type", "message");
      else {
        form.set("file_type", feishuFileType(message.media.mimeType));
        form.set("file_name", message.media.fileName);
      }
      form.set(image ? "image" : "file", mediaBlob(message.media), message.media.fileName);
      const uploaded = await jsonRequest(`${this.apiBase}/open-apis/im/v1/${image ? "images" : "files"}`, {
        method: "POST", headers: { authorization: `Bearer ${this.tenantAccessToken}` }, body: form, ...(signal ? { signal } : {}),
      }, this.id, message.destination);
      const key = image ? uploaded.body?.data?.image_key : uploaded.body?.data?.file_key;
      if (!key) throw new Error(`feishu ${image ? "image" : "file"} upload returned no key.`);
      msgType = image ? "image" : "file";
      content = image ? { image_key: String(key) } : { file_key: String(key) };
    }
    const url = message.threadId
      ? `${this.apiBase}/open-apis/im/v1/messages/${encodeURIComponent(message.threadId)}/reply`
      : `${this.apiBase}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    const payload = message.threadId
      ? { msg_type: msgType, content: JSON.stringify(content) }
      : { receive_id: message.destination, msg_type: msgType, content: JSON.stringify(content) };
    const { body, result } = await jsonRequest(url, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.tenantAccessToken}` },
      body: JSON.stringify(payload), ...(signal ? { signal } : {}),
    }, this.id, message.destination);
    const id = body?.data?.message_id;
    return { ...result, ...(id ? { messageId: String(id) } : {}) };
  }
}

function teamsTarget(destination: string): string {
  if (destination.startsWith("chat:")) {
    const chatId = destination.slice(5);
    if (!chatId) throw new Error("teams chat destination is empty.");
    return `chats/${encodeURIComponent(chatId)}/messages`;
  }
  if (destination.startsWith("channel:")) {
    const value = destination.slice(8), separator = value.indexOf(":");
    const teamId = separator >= 0 ? value.slice(0, separator) : "";
    const channelId = separator >= 0 ? value.slice(separator + 1) : "";
    if (!teamId || !channelId) throw new Error("teams channel destination must be channel:<team-id>:<channel-id>.");
    return `teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`;
  }
  throw new Error("teams destination must start with chat: or channel:.");
}

function feishuFileType(mimeType: string): string {
  if (mimeType.startsWith("audio/")) return "opus";
  if (mimeType.startsWith("video/")) return "mp4";
  if (mimeType === "application/pdf") return "pdf";
  return "stream";
}

export class SignedWebhookAdapter implements ChannelAdapter {
  readonly id: string;
  constructor(
    id: string,
    private readonly endpoint: string,
    private readonly secret: string,
  ) {
    this.id = id;
  }
  async send(message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    const timestamp = new Date().toISOString();
    const bodyText = JSON.stringify({
      destination: message.destination,
      text: message.text,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      ...(message.metadata ? { metadata: message.metadata } : {}),
      ...(message.media ? { media: { fileName: message.media.fileName, mimeType: message.media.mimeType, base64: Buffer.from(message.media.data).toString("base64") } } : {}),
      timestamp,
    });
    const signature = createHmac("sha256", this.secret).update(bodyText).digest("hex");
    const { body, result } = await jsonRequest(
      this.endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-haf-timestamp": timestamp,
          "x-haf-signature": `sha256=${signature}`,
        },
        body: bodyText,
        ...(signal ? { signal } : {}),
      },
      this.id,
      message.destination,
    );
    return { ...result, ...(body?.messageId ? { messageId: String(body.messageId) } : {}) };
  }
}

export class ChannelAdapterRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Channel adapter ${adapter.id} already exists.`);
    this.adapters.set(adapter.id, adapter);
  }

  list(): string[] {
    return [...this.adapters.keys()].sort();
  }

  statuses(): Array<{ id: string; longLived: boolean; status?: unknown }> {
    return [...this.adapters.values()].sort((a, b) => a.id.localeCompare(b.id)).map((adapter) => ({
      id: adapter.id,
      longLived: typeof adapter.start === "function" || typeof adapter.close === "function",
      ...(adapter.status ? { status: adapter.status() } : {}),
    }));
  }

  startAll(): void {
    for (const adapter of this.adapters.values()) adapter.start?.();
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map(async (adapter) => await adapter.close?.()));
  }

  async send(platform: string, message: OutboundChannelMessage, signal?: AbortSignal): Promise<ChannelDeliveryResult> {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`No outbound adapter configured for ${platform}.`);
    return await adapter.send(message, signal);
  }
}
