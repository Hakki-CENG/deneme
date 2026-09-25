import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

const engines: HybridAgentEngine[] = [];
afterEach(async () => await Promise.all(engines.splice(0).map((engine) => engine.shutdown())));

describe("workspace attachment boundary", () => {
  it("atomically writes verified binary data and rejects malformed or escaping uploads", async () => {
    const engine = new HybridAgentEngine({
      homePath: await mkdtemp(join(tmpdir(), "haf-attachment-")),
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      autoApproveWorkspaceWrites: true,
      model: { provider: "mock" },
    });
    engines.push(engine);
    const session = await engine.createSession({ tenantId: "local" });
    const bytes = Buffer.from([0, 1, 2, 3, 254, 255]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const context = {
      tenantId: "local",
      sessionId: session.sessionId,
      familyId: session.familyId,
      turnId: randomUUID(),
      toolCallId: randomUUID(),
      source: "api" as const,
      workspacePath: session.workspacePath,
      idempotencyKey: randomUUID(),
    };
    const result = await engine.capabilities.execute("filesystem.write_binary", {
      path: ".haf/uploads/test.bin",
      base64: bytes.toString("base64"),
      expectedSha256: sha256,
    }, context) as any;
    expect(result).toEqual({ path: ".haf/uploads/test.bin", bytes: 6, sha256 });
    expect(await readFile(join(session.workspacePath, ".haf/uploads/test.bin"))).toEqual(bytes);
    await expect(engine.capabilities.execute("filesystem.write_binary", {
      path: "../escape.bin", base64: bytes.toString("base64"),
    }, { ...context, toolCallId: randomUUID(), idempotencyKey: randomUUID() })).rejects.toThrow("escapes");
    await expect(engine.capabilities.execute("filesystem.write_binary", {
      path: "bad.bin", base64: "not base64%%%",
    }, { ...context, toolCallId: randomUUID(), idempotencyKey: randomUUID() })).rejects.toThrow("malformed");
  });
});
