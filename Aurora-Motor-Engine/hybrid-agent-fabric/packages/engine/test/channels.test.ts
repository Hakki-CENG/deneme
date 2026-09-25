import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

describe("channel gateway", () => {
  it("pairs a normalized channel lane with one session and deduplicates platform message ids", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-channel-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      autoApproveWorkspaceWrites: true,
      allowProcessExecution: true,
      model: { provider: "mock" },
    });
    const message = {
      tenantId: "local",
      platform: "telegram",
      chatId: "chat-secret-id",
      chatType: "dm" as const,
      userId: "user-secret-id",
      text: "hello channel",
      messageId: "platform-message-1",
      authorized: true,
    };
    const first = await engine.channels.ingest(message);
    const duplicate = await engine.channels.ingest(message);
    expect(duplicate).toEqual(first);
    expect((await engine.channels.listRoutes("local"))).toHaveLength(1);
    expect((await engine.session(first.sessionId)).messages).toHaveLength(2);
    await engine.shutdown();
  });

  it("fails closed for unauthorized senders", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-channel-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
    });
    await expect(engine.channels.ingest({
      tenantId: "local",
      platform: "webhook",
      chatId: "chat",
      chatType: "dm",
      userId: "attacker",
      text: "run this",
      authorized: false,
    })).rejects.toThrow("not authorized");
    await engine.shutdown();
  });
});
