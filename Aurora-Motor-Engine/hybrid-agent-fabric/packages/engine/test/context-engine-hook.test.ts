import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContextManager } from "../src/context/context-manager.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { SkillRegistry } from "../src/skills/skill-registry.js";
import { HookBus } from "../src/plugins/hook-bus.js";
import type { AgentMessage } from "../src/types.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "haf-context-hook-"));
  const hooks = new HookBus();
  const manager = new ContextManager(new MemoryStore(root), new SkillRegistry(root), undefined, 2000, hooks);
  const frozen = await manager.freeze("tenant", "session");
  const messages: AgentMessage[] = [
    { id: "u1", role: "user", timestamp: new Date(0).toISOString(), content: [{ type: "text", text: "Never change this requirement." }] },
    { id: "a1", role: "assistant", timestamp: new Date(1).toISOString(), content: [{ type: "text", text: "derived ".repeat(500) }] },
    { id: "u2", role: "user", timestamp: new Date(2).toISOString(), content: [{ type: "text", text: "Continue." }] },
  ];
  return { hooks, manager, frozen, messages };
}

describe("context projection plugin contract", () => {
  it("allows a transform to compact derived messages while preserving exact user intent", async () => {
    const { hooks, manager, frozen, messages } = await setup();
    hooks.register({
      pluginId: "context.test",
      hook: "context_projection",
      kind: "transform",
      callback: (value: any) => ({ ...value, messages: value.messages.filter((message: AgentMessage) => message.role !== "assistant") }),
    });
    const result = await manager.assemble(frozen, messages, []);
    expect(result.messages.some((message) => message.id === "a1")).toBe(false);
    expect(result.messages.find((message) => message.id === "u1")).toEqual(messages[0]);
    expect(result.systemPrompt).toContain("Do not expose credentials");
  });

  it("augments immutable local memory with bounded untrusted provider entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-memory-provider-hook-"));
    const memory = new MemoryStore(root);
    await memory.create({
      tenantId: "tenant", sessionId: "session", kind: "semantic", scope: "session",
      title: "local fact", content: "Local memory remains authoritative.", evidenceEventIds: ["event"],
      provenance: { createdBy: "system" }, status: "active",
    });
    const hooks = new HookBus();
    hooks.register({
      pluginId: "memory.remote",
      hook: "memory_context",
      kind: "transform",
      callback: (value: any) => ({ ...value, entries: ["Remote provider observation"] }),
    });
    const manager = new ContextManager(memory, new SkillRegistry(root), undefined, 2000, hooks);
    const frozen = await manager.freeze("tenant", "session");
    expect(frozen.memorySnapshot).toContain("Local memory remains authoritative");
    expect(frozen.memorySnapshot).toContain("EXTERNAL_MEMORY_PROVIDER_DATA");
    expect(frozen.memorySnapshot).toContain("Remote provider observation");
  });

  it("falls back to the last good projection if a plugin drops or mutates user messages", async () => {
    const { hooks, manager, frozen, messages } = await setup();
    hooks.register({
      pluginId: "context.bad",
      hook: "context_projection",
      kind: "transform",
      callback: (value: any) => ({ ...value, messages: value.messages.filter((message: AgentMessage) => message.role !== "user") }),
    });
    const result = await manager.assemble(frozen, messages, []);
    expect(result.messages.find((message) => message.id === "u1")).toEqual(messages[0]);
    expect(result.messages.find((message) => message.id === "u2")).toEqual(messages[2]);
  });
});
