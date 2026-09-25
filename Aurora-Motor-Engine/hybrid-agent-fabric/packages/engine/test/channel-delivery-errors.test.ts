/**
 * Outbound platform delivery failures, classified.
 *
 * These assertions exist because the codes `PLATFORM_RATE_LIMITED`,
 * `PLATFORM_QUOTA_EXCEEDED` and `PLATFORM_CONNECTION_FAILED` were registered in
 * the control API's error registry and nothing ever produced them: every
 * adapter threw the same plain `Error`, so an HTTP caller could not tell "slow
 * down" from "your account cannot spend" from "we could not reach Telegram".
 *
 * The responses here come from a real HTTP server on loopback rather than a
 * stubbed `fetch`, and the connection-failure case uses a port that was bound
 * and then closed — a genuine ECONNREFUSED, not a fabricated error object. The
 * classification is only worth anything if it survives the real transport.
 */
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelAdapterRegistry, ChannelDeliveryError, TelegramAdapter } from "../src/channels/delivery-adapters.js";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = undefined;
  });
});

async function serving(handler: (statusCode: number, body: string, headers?: Record<string, string>) => void, statusCode: number, body: string, headers: Record<string, string> = {}): Promise<string> {
  server = createServer((request, response) => {
    request.resume();
    response.writeHead(statusCode, { "content-type": "application/json", ...headers });
    response.end(body);
    handler(statusCode, body, headers);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function registryAt(apiBase: string): ChannelAdapterRegistry {
  const registry = new ChannelAdapterRegistry();
  registry.register(new TelegramAdapter("test-bot-token", apiBase));
  return registry;
}

const message = { destination: "chat-1", text: "hello" };

describe("ChannelDeliveryError classification", () => {
  it("reports a 429 as rate-limited and carries the platform's Retry-After", async () => {
    const base = await serving(() => undefined, 429, JSON.stringify({ description: "Too Many Requests" }), { "retry-after": "7" });
    const error = await registryAt(base).send("telegram", message).then(
      () => undefined,
      (caught: unknown) => caught as ChannelDeliveryError,
    );
    expect(error).toBeInstanceOf(ChannelDeliveryError);
    expect(error!.disposition).toBe("rate-limited");
    expect(error!.platform).toBe("telegram");
    expect(error!.detail.httpStatus).toBe(429);
    expect(error!.detail.retryAfterMs).toBe(7000);
    expect(error!.detail.destination).toBe("chat-1");
  });

  it("reads Telegram's body-encoded retry_after, since Telegram does not send the header", async () => {
    const base = await serving(() => undefined, 429, JSON.stringify({ ok: false, description: "Too Many Requests", parameters: { retry_after: 3 } }));
    const error = await registryAt(base).send("telegram", message).then(
      () => undefined,
      (caught: unknown) => caught as ChannelDeliveryError,
    );
    expect(error!.disposition).toBe("rate-limited");
    expect(error!.detail.retryAfterMs).toBe(3000);
  });

  it("separates an exhausted quota from a rate limit, because only one clears on its own", async () => {
    const base = await serving(() => undefined, 402, JSON.stringify({ ok: false, description: "Payment required: insufficient credit" }));
    const error = await registryAt(base).send("telegram", message).then(
      () => undefined,
      (caught: unknown) => caught as ChannelDeliveryError,
    );
    expect(error!.disposition).toBe("quota-exceeded");
    expect(error!.detail.httpStatus).toBe(402);
  });

  it("does not call a 400 a quota problem", async () => {
    const base = await serving(() => undefined, 400, JSON.stringify({ ok: false, description: "Bad Request: chat not found" }));
    const error = await registryAt(base).send("telegram", message).then(
      () => undefined,
      (caught: unknown) => caught as ChannelDeliveryError,
    );
    expect(error!.disposition).toBe("rejected");
    expect(error!.detail.httpStatus).toBe(400);
    expect(error!.detail.retryAfterMs).toBeUndefined();
  });

  it("reports an unreachable platform as connection-failed, naming the socket error", async () => {
    // Bind a port, note it, close it: the refusal below is a real ECONNREFUSED.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const error = await registryAt(`http://127.0.0.1:${port}`).send("telegram", message).then(
      () => undefined,
      (caught: unknown) => caught as ChannelDeliveryError,
    );
    expect(error).toBeInstanceOf(ChannelDeliveryError);
    expect(error!.disposition).toBe("connection-failed");
    expect(error!.detail.cause).toBe("ECONNREFUSED");
    expect(error!.detail.httpStatus).toBeUndefined();
  });

  it("keeps the redaction that hides credentials in provider text", async () => {
    const base = await serving(() => undefined, 401, JSON.stringify({ ok: false, description: "unauthorized Bearer 12345:ABCdef token=sekrit" }));
    const error = await registryAt(base).send("telegram", message).then(
      () => undefined,
      (caught: unknown) => caught as ChannelDeliveryError,
    );
    expect(error!.message).toContain("Bearer [REDACTED]");
    expect(error!.message).not.toContain("12345:ABCdef");
    expect(error!.message).not.toContain("sekrit");
  });

  it("still succeeds when the platform accepts the delivery", async () => {
    const base = await serving(() => undefined, 200, JSON.stringify({ ok: true, result: { message_id: 42 } }));
    const result = await registryAt(base).send("telegram", message);
    expect(result.rawStatus).toBe(200);
    expect(result.messageId).toBe("42");
    expect(result.platform).toBe("telegram");
  });
});
