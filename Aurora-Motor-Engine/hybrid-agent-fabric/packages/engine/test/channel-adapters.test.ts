import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChannelAdapterRegistry,
  DiscordBotAdapter,
  MatrixAdapter,
  SignalRestAdapter,
  MattermostAdapter,
  LineMessagingAdapter,
  GoogleChatAdapter,
  MicrosoftTeamsAdapter,
  FeishuAdapter,
  SignedWebhookAdapter,
  SlackAdapter,
  TelegramAdapter,
  WhatsAppCloudAdapter,
} from "../src/channels/delivery-adapters.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("native outbound channel adapters", () => {
  it("normalizes Telegram and Slack delivery receipts", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("telegram")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, ts: "123.456" }), { status: 200 });
    }) as typeof fetch;
    const registry = new ChannelAdapterRegistry();
    registry.register(new TelegramAdapter("secret-token"));
    registry.register(new SlackAdapter("xoxb-secret"));
    expect((await registry.send("telegram", { destination: "chat", text: "hello" })).messageId).toBe("42");
    expect((await registry.send("slack", { destination: "channel", text: "hello" })).messageId).toBe("123.456");
    expect(calls[1]!.init?.headers).toMatchObject({ authorization: "Bearer xoxb-secret" });
  });

  it("normalizes WhatsApp, Matrix and Signal bridge receipts", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("graph.facebook")) return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
      if (String(url).includes("_matrix")) return new Response(JSON.stringify({ event_id: "$event" }), { status: 200 });
      return new Response(JSON.stringify({ timestamp: 12345 }), { status: 201 });
    }) as typeof fetch;
    expect((await new WhatsAppCloudAdapter("token", "phone").send({ destination: "905", text: "hi" })).messageId).toBe("wamid.1");
    expect((await new MatrixAdapter("https://matrix.example", "token").send({ destination: "!room:example", text: "hi" })).messageId).toBe("$event");
    expect((await new SignalRestAdapter("https://signal.example", "+1000", "token").send({ destination: "+2000", text: "hi" })).messageId).toBe("12345");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer token" });
    expect(calls[2]!.url).toContain("/v2/send");
  });

  it("delivers bounded native media without placing provider credentials in payloads", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const value = String(url); calls.push({ url: value, init });
      if (value.includes("telegram")) return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      if (value.includes("discord")) return new Response(JSON.stringify({ id: "discord-media" }), { status: 200 });
      if (value.includes("slack")) return new Response(JSON.stringify({ ok: true, file: { id: "slack-file" } }), { status: 200 });
      if (value.endsWith("/media")) return new Response(JSON.stringify({ id: "wa-media" }), { status: 200 });
      if (value.includes("graph.facebook")) return new Response(JSON.stringify({ messages: [{ id: "wa-message" }] }), { status: 200 });
      if (value.includes("/_matrix/media")) return new Response(JSON.stringify({ content_uri: "mxc://example/media" }), { status: 200 });
      if (value.includes("_matrix/client")) return new Response(JSON.stringify({ event_id: "$media" }), { status: 200 });
      return new Response(JSON.stringify({ timestamp: 55 }), { status: 201 });
    }) as typeof fetch;
    const media = { fileName: "pixel.png", mimeType: "image/png", data: new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) };
    expect((await new TelegramAdapter("tg").send({ destination: "chat", text: "caption", media })).messageId).toBe("1");
    expect((await new DiscordBotAdapter("discord").send({ destination: "channel", text: "caption", media })).messageId).toBe("discord-media");
    expect((await new SlackAdapter("slack").send({ destination: "channel", text: "caption", media })).messageId).toBe("slack-file");
    expect((await new WhatsAppCloudAdapter("wa", "phone").send({ destination: "905", text: "caption", media })).messageId).toBe("wa-message");
    expect((await new MatrixAdapter("https://matrix.example", "mx").send({ destination: "!room:example", text: "caption", media })).messageId).toBe("$media");
    expect((await new SignalRestAdapter("https://signal.example", "+1", "sig").send({ destination: "+2", text: "caption", media })).messageId).toBe("55");
    expect(calls.find((call) => call.url.includes("telegram"))!.url).toContain("sendPhoto");
    expect(calls.find((call) => call.url.includes("discord"))!.init?.body).toBeInstanceOf(FormData);
    const signalBody = JSON.parse(String(calls.find((call) => call.url.includes("signal"))!.init?.body));
    expect(signalBody.base64_attachments[0]).toContain("data:image/png");
    expect(JSON.stringify(signalBody)).not.toContain("sig");
  });

  it("delivers text through Mattermost, LINE, Google Chat, Teams and Feishu contracts", async () => {
    const calls: Array<{ url: string; headers: Headers; body: any }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input), raw = String(init?.body ?? ""), parsed = raw.startsWith("{") ? JSON.parse(raw) : raw;
      calls.push({ url, headers: new Headers(init?.headers), body: parsed });
      if (url.includes("mattermost")) return Response.json({ id: "post-1" });
      if (url.includes("api.line")) return Response.json({ sentMessages: [{ id: "line-1" }] });
      if (url.includes("chat.googleapis")) return Response.json({ name: "spaces/s/messages/g-1" });
      if (url.includes("graph.microsoft")) return Response.json({ id: "teams-1" });
      return Response.json({ code: 0, data: { message_id: "feishu-1" } });
    }) as typeof fetch;
    expect((await new MattermostAdapter("https://mattermost.example", "mm-token").send({ destination: "channel", text: "hello" })).messageId).toBe("post-1");
    expect((await new LineMessagingAdapter("line-token").send({ destination: "user", text: "hello" })).messageId).toBe("line-1");
    expect((await new GoogleChatAdapter("google-token").send({ destination: "spaces/abc", text: "hello", threadId: "spaces/abc/threads/t" })).messageId).toBe("spaces/s/messages/g-1");
    expect((await new MicrosoftTeamsAdapter("teams-token").send({ destination: "channel:team:19:channel@thread.tacv2", text: "hello" })).messageId).toBe("teams-1");
    expect((await new FeishuAdapter("feishu-token").send({ destination: "chat", text: "hello" })).messageId).toBe("feishu-1");
    expect(calls.find((item) => item.url.includes("mattermost"))?.body).toMatchObject({ channel_id: "channel", message: "hello" });
    expect(calls.find((item) => item.url.includes("api.line"))?.headers.get("authorization")).toBe("Bearer line-token");
    expect(calls.find((item) => item.url.includes("chat.googleapis"))?.body.thread.name).toContain("threads/t");
    expect(calls.find((item) => item.url.includes("graph.microsoft"))?.url).toContain("teams/team/channels/19%3Achannel%40thread.tacv2/messages");
    const feishu = calls.find((item) => item.url.includes("open.feishu"))!;
    expect(JSON.parse(feishu.body.content)).toEqual({ text: "hello" });
    expect(JSON.stringify(calls.map((item) => item.body))).not.toContain("line-token");
  });

  it("uploads media for Mattermost and Feishu while unsupported binary routes fail explicitly", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/api/v4/files")) return Response.json({ file_infos: [{ id: "file-1" }] });
      if (url.endsWith("/api/v4/posts")) return Response.json({ id: "post-media" });
      if (url.endsWith("/open-apis/im/v1/images")) return Response.json({ code: 0, data: { image_key: "image-key" } });
      return Response.json({ code: 0, data: { message_id: "feishu-media" } });
    }) as typeof fetch;
    const media = { fileName: "pixel.png", mimeType: "image/png", data: new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) };
    expect((await new MattermostAdapter("https://mattermost.example", "token").send({ destination: "channel", text: "caption", media })).messageId).toBe("post-media");
    expect((await new FeishuAdapter("token").send({ destination: "chat", text: "caption", media })).messageId).toBe("feishu-media");
    expect(calls.filter((item) => item.init?.body instanceof FormData)).toHaveLength(2);
    await expect(new LineMessagingAdapter("token").send({ destination: "user", text: "caption", media })).rejects.toThrow("does not support");
    await expect(new GoogleChatAdapter("token").send({ destination: "space", text: "caption", media })).rejects.toThrow("does not support");
    await expect(new MicrosoftTeamsAdapter("token").send({ destination: "chat:id", text: "caption", media })).rejects.toThrow("does not support");
  });

  it("rejects provider redirects and redacts credential-shaped error text", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })) as typeof fetch;
    await expect(new LineMessagingAdapter("token").send({ destination: "user", text: "hello" })).rejects.toThrow("redirects are forbidden");
    globalThis.fetch = vi.fn(async () => Response.json({ message: "authorization=super-secret-value" }, { status: 401 })) as typeof fetch;
    let capturedError: unknown;
    try { await new GoogleChatAdapter("token").send({ destination: "space", text: "hello" }); }
    catch (error) { capturedError = error; }
    expect(capturedError).toBeInstanceOf(Error);
    expect(String(capturedError)).not.toContain("super-secret-value");
  });

  it("signs generic webhook deliveries over exact body bytes", async () => {
    let headers: any; let payload: any;
    globalThis.fetch = vi.fn(async (_url, init) => {
      headers = init?.headers; payload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messageId: "remote-1" }), { status: 202 });
    }) as typeof fetch;
    const adapter = new SignedWebhookAdapter("webhook", "https://example.test/hook", "shared-secret");
    const result = await adapter.send({ destination: "ops", text: "deploy done", media: { fileName: "a.pdf", mimeType: "application/pdf", data: new Uint8Array([1,2,3]) } });
    expect(result.messageId).toBe("remote-1");
    expect(headers["x-haf-signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(payload.media).toEqual({ fileName: "a.pdf", mimeType: "application/pdf", base64: "AQID" });
    expect(JSON.stringify(payload)).not.toContain("shared-secret");
  });
});
