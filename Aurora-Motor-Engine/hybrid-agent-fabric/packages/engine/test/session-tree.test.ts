import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import type { CommandEnvelope } from "../src/types.js";

function command(sessionId: string, kind: CommandEnvelope["kind"], payload: any): CommandEnvelope {
  return { protocolVersion: 1, commandId: randomUUID(), clientId: "tree-test", tenantId: "local", sessionId, kind, source: "api", issuedAt: new Date().toISOString(), payload };
}

function config(homePath: string) {
  return {
    homePath,
    kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local" as const,
    model: { provider: "mock" as const },
  };
}

describe("branch-preserving session tree", () => {
  it("branches from an earlier entry without deleting the abandoned path", async () => {
    const home = await mkdtemp(join(tmpdir(), "haf-tree-"));
    const engine = new HybridAgentEngine(config(home));
    const session = await engine.createSession({ tenantId: "local" });
    await engine.command(command(session.sessionId, "session.prompt", { text: "first" }));
    await engine.command(command(session.sessionId, "session.prompt", { text: "second path" }));
    const before = await engine.session(session.sessionId);
    const branchPoint = before.messages[1]!.id;
    await engine.command(command(session.sessionId, "session.tree.label", { entryId: branchPoint, label: "stable-point" }));
    await engine.command(command(session.sessionId, "session.tree.branch", { entryId: branchPoint }));
    await engine.command(command(session.sessionId, "session.prompt", { text: "alternative path" }));
    const after = await engine.session(session.sessionId);
    expect(after.messages.map((message) => message.content[0]?.type === "text" ? (message.content[0] as any).text : "")).toEqual([
      "first", "HAF mock response: first", "alternative path", "HAF mock response: alternative path",
    ]);
    expect(after.tree?.entries).toHaveLength(6);
    expect(after.tree?.entries.some((entry) => entry.message.content.some((part) => part.type === "text" && part.text === "second path"))).toBe(true);
    expect(after.tree?.entries.find((entry) => entry.id === branchPoint)?.labels).toContain("stable-point");
    await engine.shutdown();

    const restored = new HybridAgentEngine(config(home));
    const restoredState = await restored.session(session.sessionId);
    expect(restoredState.messages.at(-1)?.content[0]).toMatchObject({ type: "text", text: "HAF mock response: alternative path" });
    expect(restoredState.tree?.entries).toHaveLength(6);
    await restored.shutdown();
  });

  it("uses a context-reset tree entry during compaction while retaining old branches", async () => {
    const home = await mkdtemp(join(tmpdir(), "haf-tree-"));
    const engine = new HybridAgentEngine(config(home));
    const session = await engine.createSession({ tenantId: "local" });
    for (let index = 0; index < 7; index++) await engine.command(command(session.sessionId, "session.prompt", { text: `turn ${index}` }));
    const before = await engine.session(session.sessionId);
    expect(before.messages.length).toBe(14);
    await engine.command(command(session.sessionId, "session.compact", {}));
    const after = await engine.session(session.sessionId);
    expect(after.messages.length).toBe(13);
    expect(after.messages[0]?.content[0]).toMatchObject({ type: "text" });
    expect((after.messages[0]?.content[0] as any).text).toContain("COMPACTION_SUMMARY");
    expect(after.tree?.entries.some((entry) => entry.contextReset)).toBe(true);
    expect((after.tree?.entries.length ?? 0)).toBeGreaterThan(before.tree?.entries.length ?? 0);
    await engine.shutdown();
  });
});
