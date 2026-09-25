import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { channelCapabilities } from "../src/capabilities/channels.js";
import { ChannelAdapterRegistry, type OutboundChannelMessage } from "../src/channels/delivery-adapters.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("channel media confinement", () => {
  it("loads verified bounded workspace media only at delivery time", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-channel-media-"));
    await writeFile(join(workspace, "pixel.png"), png);
    let captured: OutboundChannelMessage | undefined;
    const registry = new ChannelAdapterRegistry();
    registry.register({ id: "capture", async send(message) { captured = message; return { platform: "capture", destination: message.destination, timestamp: new Date().toISOString(), rawStatus: 200 }; } });
    const capability = channelCapabilities(registry)[0]!;
    const context = {
      tenantId: "tenant", sessionId: "session", familyId: "family", turnId: "turn", toolCallId: "tool",
      source: "api" as const, workspacePath: workspace, idempotencyKey: "key",
    };
    await capability.execute(capability.validate({ platform: "capture", destination: "dest", text: "caption", mediaPath: "pixel.png" }), context);
    expect(captured?.media).toEqual(expect.objectContaining({ fileName: "pixel.png", mimeType: "image/png" }));
    expect(captured?.media?.data.length).toBe(png.length);
    await expect(capability.execute(capability.validate({ platform: "capture", destination: "dest", text: "x", mediaPath: "../outside.png" }), context)).rejects.toThrow();
  });
});
