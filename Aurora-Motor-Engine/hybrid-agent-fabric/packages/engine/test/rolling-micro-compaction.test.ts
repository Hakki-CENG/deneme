import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContextManager } from "../src/context/context-manager.js";
import { RollingMicroCompactor } from "../src/context/rolling-micro-compactor.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { SkillRegistry } from "../src/skills/skill-registry.js";
import type { AgentMessage } from "../src/types.js";

function textMessage(id: string, role: AgentMessage["role"], text: string, tick: number): AgentMessage {
  return { id, role, timestamp: new Date(tick).toISOString(), content: [{ type: "text", text }] };
}

function transcript(): AgentMessage[] {
  return [
    textMessage("user-requirement", "user", "Keep this exact user requirement byte-for-byte.", 0),
    textMessage("old-assistant", "assistant", "old derived explanation ".repeat(400), 1),
    {
      id: "old-tool",
      role: "tool",
      timestamp: new Date(2).toISOString(),
      content: [{
        type: "tool_result",
        toolCallId: "call-old",
        name: "process.exec",
        result: { stdout: "sensitive-derived-value ".repeat(300), exitCode: 0 },
        isError: false,
      }],
    },
    textMessage("latest-user", "user", "Now continue and verify.", 3),
    textMessage("latest-assistant", "assistant", "recent protected output ".repeat(120), 4),
  ];
}

describe("packaged rolling micro-compaction", () => {
  it("persists bounded deterministic windows while preserving user/system messages exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-micro-compact-"));
    const compactor = new RollingMicroCompactor(root, {
      protectedTailChars: 1_000,
      maxMessagesPerWindow: 12,
      maxSummaryChars: 1_000,
    });
    const messages = transcript();
    const original = structuredClone(messages);
    const first = await compactor.project("tenant", "session", messages, 2_000);
    expect(first.stats.compactedMessages).toBe(2);
    expect(first.stats.windows).toBe(1);
    expect(first.stats.cacheHits).toBe(0);
    expect(first.stats.projectedChars).toBeLessThan(first.stats.sourceChars);
    expect(first.messages.find((item) => item.id === "user-requirement")).toEqual(messages[0]);
    expect(first.messages.find((item) => item.id === "latest-user")).toEqual(messages[3]);
    expect(first.messages.some((item) => item.id === "old-assistant" || item.id === "old-tool")).toBe(false);
    const summary = JSON.stringify(first.messages);
    expect(summary).toContain("DERIVED_CONTEXT_MICRO_SUMMARY");
    expect(summary).toContain("result_sha256");
    expect(summary).not.toContain("sensitive-derived-value");
    expect(messages).toEqual(original);

    const second = await compactor.project("tenant", "session", messages, 2_000);
    expect(second.stats.cacheHits).toBe(1);
    expect(second.messages).toEqual(first.messages);
    const files = await readdir(join(root, "context", "micro-compaction"));
    expect(files).toHaveLength(1);
    const cache = await readFile(join(root, "context", "micro-compaction", files[0]!), "utf8");
    expect(cache).not.toContain("sensitive-derived-value");
    expect(Buffer.byteLength(cache)).toBeLessThan(2 * 1024 * 1024);
  });

  it("integrates before intent projection and treats a malformed observer cache as a miss", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-micro-context-"));
    const compactor = new RollingMicroCompactor(root, { protectedTailChars: 1_000, maxSummaryChars: 900 });
    const memory = new MemoryStore(root);
    const manager = new ContextManager(memory, new SkillRegistry(root), undefined, 2_000, undefined, compactor);
    const frozen = await manager.freeze("tenant", "session");
    const first = await manager.assemble(frozen, transcript(), []);
    expect(first.projection.microCompactedMessages).toBe(2);
    expect(first.projection.microCompactionWindows).toBe(1);
    expect(first.messages.find((item) => item.id === "user-requirement")?.content).toEqual(transcript()[0]!.content);
    expect(first.systemPrompt).toContain("Do not expose credentials");

    const files = await readdir(join(root, "context", "micro-compaction"));
    await writeFile(join(root, "context", "micro-compaction", files[0]!), "{malformed", "utf8");
    const second = await manager.assemble(frozen, transcript(), []);
    expect(second.projection.microCompactionCacheHits).toBe(0);
    expect(second.messages.find((item) => item.id === "latest-user")?.content).toEqual(transcript()[3]!.content);
  });
});
