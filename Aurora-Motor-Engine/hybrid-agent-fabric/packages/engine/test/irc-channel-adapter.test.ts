import { createServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelGateway } from "../src/channels/channel-gateway.js";
import { IrcChannelAdapter } from "../src/channels/irc-channel-adapter.js";
import { IRC_TEST_CERT, IRC_TEST_KEY } from "./fixtures/irc-tls-fixture.js";

const servers: Server[] = [];
const adapters: IrcChannelAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map(async (adapter) => await adapter.close()));
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return address.port;
}

function receiveLines(socket: Socket, onLine: (line: string) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true before timeout");
}

describe("long-lived IRC/IRCv3 channel adapter", () => {
  it("negotiates IRCv3, enforces sender/channel allowlists, ingests messages and returns bounded replies", async () => {
    const received: string[] = [];
    let peer: Socket | undefined;
    const server = createServer((socket) => {
      peer = socket;
      receiveLines(socket, (line) => {
        received.push(line);
        if (line === "CAP LS 302") socket.write(":irc.test CAP * LS :message-tags server-time account-tag\r\n");
        else if (line.startsWith("CAP REQ :")) socket.write(":irc.test CAP HafBot ACK :message-tags server-time account-tag\r\n");
        else if (line === "CAP END") socket.write(":irc.test 001 HafBot :welcome\r\n");
        else if (line === "JOIN #haf") {
          socket.write(":HafBot!haf@localhost JOIN :#haf\r\n");
          socket.write("PING :probe-1\r\n");
          socket.write("@msgid=bad-1;account=mallory;time=2026-08-19T12:00:00.000Z :Mallory!u@h PRIVMSG #haf :ignore me\r\n");
          socket.write("@msgid=msg-1;account=alice;time=2026-08-19T12:00:01.000Z :Alice!u@h PRIVMSG #haf :hello IRC\r\n");
        }
      });
    });
    const port = await listen(server);
    const ingest = vi.fn(async () => ({
      sessionId: "session", commandId: "command", text: "agent response", status: "completed" as const,
    }));
    const gateway = { ingest } as unknown as ChannelGateway;
    const adapter = new IrcChannelAdapter({
      gateway, tenantId: "tenant", host: "127.0.0.1", port, tls: false,
      allowPlaintext: true, allowPrivateHost: true, nickname: "HafBot",
      channels: ["#haf"], allowedAccounts: ["alice"], outboundIntervalMs: 0,
      reconnectMinMs: 100, reconnectMaxMs: 200,
    });
    adapters.push(adapter);
    adapter.start();
    await adapter.waitUntilConnected().catch(() => { throw new Error(JSON.stringify({ received, status: adapter.status() })); });
    await waitFor(() => ingest.mock.calls.length === 1 && received.some((line) => line === "PRIVMSG #haf :agent response"));
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![0]).toMatchObject({
      tenantId: "tenant", platform: "irc", chatId: "#haf", chatType: "channel",
      userId: "alice", text: "hello IRC", messageId: "msg-1", authorized: true,
      metadata: { serverTime: "2026-08-19T12:00:01.000Z" },
    });
    expect(received).toContain("CAP REQ :message-tags server-time account-tag");
    expect(received).toContain("JOIN #haf");
    expect(received).toContain("PONG :probe-1");
    expect(adapter.status()).toMatchObject({ state: "connected", tls: false, generation: 1, configuredChannels: 1 });

    const long = "🙂".repeat(400);
    const result = await adapter.send({ destination: "#haf", text: long });
    expect(result).toMatchObject({ platform: "irc", destination: "#haf", rawStatus: 202 });
    await waitFor(() => received.filter((line) => line.startsWith("PRIVMSG #haf :")).length >= 5);
    for (const line of received.filter((item) => item.startsWith("PRIVMSG #haf :"))) {
      expect(Buffer.byteLength(`${line}\r\n`)).toBeLessThanOrEqual(512);
    }
    expect(peer?.destroyed).toBe(false);
  });

  it("performs SASL PLAIN over verified TLS and never projects credentials in status", async () => {
    const received: string[] = [];
    let decoded = "";
    const server = createTlsServer({ key: IRC_TEST_KEY, cert: IRC_TEST_CERT }, (socket) => {
      receiveLines(socket, (line) => {
        received.push(line);
        if (line === "CAP LS 302") socket.write(":irc.test CAP * LS :message-tags sasl=PLAIN\r\n");
        else if (line.startsWith("CAP REQ :")) socket.write(":irc.test CAP HafBot ACK :message-tags sasl\r\n");
        else if (line === "AUTHENTICATE PLAIN") socket.write("AUTHENTICATE +\r\n");
        else if (line.startsWith("AUTHENTICATE ") && line !== "AUTHENTICATE +") {
          decoded = Buffer.from(line.slice("AUTHENTICATE ".length), "base64").toString("utf8");
          socket.write(":irc.test 903 HafBot :SASL authentication successful\r\n");
        } else if (line === "CAP END") socket.write(":irc.test 001 HafBot :welcome\r\n");
      });
    });
    const port = await listen(server);
    const gateway = { ingest: vi.fn() } as unknown as ChannelGateway;
    // Plaintext credential transport fails before any socket is created.
    expect(() => new IrcChannelAdapter({
      gateway, tenantId: "tenant", host: "127.0.0.1", port, tls: false, allowPlaintext: true,
      allowPrivateHost: true, nickname: "HafBot", channels: ["#haf"], allowedNicknames: ["Alice"],
      sasl: { account: "haf-account", password: "sasl-super-secret" },
    })).toThrow("cannot be sent over plaintext");

    const adapter = new IrcChannelAdapter({
      gateway, tenantId: "tenant", host: "127.0.0.1", port, tls: true, tlsCa: IRC_TEST_CERT,
      allowPrivateHost: true, nickname: "HafBot", channels: ["#haf"], allowedNicknames: ["Alice"],
      sasl: { account: "haf-account", password: "sasl-super-secret" }, outboundIntervalMs: 0,
      reconnectMinMs: 100, reconnectMaxMs: 200,
    });
    adapters.push(adapter);
    adapter.start();
    await adapter.waitUntilConnected().catch(() => { throw new Error(JSON.stringify({ received, status: adapter.status() })); });
    expect(decoded).toBe("haf-account\0haf-account\0sasl-super-secret");
    expect(received).toContain("AUTHENTICATE PLAIN");
    expect(received).toContain("CAP END");
    expect(adapter.status()).toMatchObject({ state: "connected", tls: true, saslConfigured: true });
    expect(JSON.stringify(adapter.status())).not.toContain("haf-account");
    expect(JSON.stringify(adapter.status())).not.toContain("sasl-super-secret");
  });

  it("reconnects with a new generation after transport loss", async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      const current = connections;
      receiveLines(socket, (line) => {
        if (line === "CAP LS 302") socket.write(":irc.test CAP * LS :message-tags\r\n");
        else if (line.startsWith("CAP REQ :")) socket.write(":irc.test CAP HafBot ACK :message-tags\r\n");
        else if (line === "CAP END") socket.write(":irc.test 001 HafBot :welcome\r\n");
        else if (line === "JOIN #haf" && current === 1) setTimeout(() => socket.destroy(), 20);
      });
    });
    const port = await listen(server);
    const gateway = { ingest: vi.fn() } as unknown as ChannelGateway;
    const adapter = new IrcChannelAdapter({
      gateway, tenantId: "tenant", host: "127.0.0.1", port, tls: false,
      allowPlaintext: true, allowPrivateHost: true, nickname: "HafBot",
      channels: ["#haf"], allowedNicknames: ["Alice"], reconnectMinMs: 100,
      reconnectMaxMs: 100, outboundIntervalMs: 0, random: () => 0.5,
    });
    adapters.push(adapter);
    adapter.start();
    await waitFor(() => adapter.status().generation >= 2 && adapter.status().state === "connected", 3000);
    expect(connections).toBeGreaterThanOrEqual(2);
    expect(adapter.status()).toMatchObject({ state: "connected", generation: 2, reconnectAttempt: 0 });
  });

  it("fails closed on unsafe destinations, missing allowlists and protocol injection", async () => {
    const gateway = { ingest: vi.fn() } as unknown as ChannelGateway;
    expect(() => new IrcChannelAdapter({
      gateway, tenantId: "tenant", host: "127.0.0.1", nickname: "HafBot",
      channels: ["#haf"], allowedNicknames: ["Alice"],
    })).toThrow("Private or special-use");
    expect(() => new IrcChannelAdapter({
      gateway, tenantId: "tenant", host: "irc.example.com", nickname: "HafBot", channels: ["#haf"],
    })).toThrow("non-empty nickname or account allowlist");
    expect(() => new IrcChannelAdapter({
      gateway, tenantId: "tenant", host: "irc.example.com", nickname: "HafBot\r\nOPER root", channels: ["#haf"], allowedNicknames: ["Alice"],
    })).toThrow("nickname is invalid");
    expect(() => new IrcChannelAdapter({
      gateway, tenantId: "tenant", host: "irc.example.com", nickname: "HafBot", channels: ["#haf\r\nJOIN #evil"], allowedNicknames: ["Alice"],
    })).toThrow("channel is invalid");
  });
});
