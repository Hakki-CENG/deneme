import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { AnthropicProvider } from "../src/models/anthropic-provider.js";
import { PromptCacheService } from "../src/prompt-cache/prompt-cache-service.js";
import type { AgentMessage, CapabilityDescriptor, ModelRequest } from "../src/types.js";

function messages(extra: AgentMessage[] = []): AgentMessage[] {
  return [
    { id: "u1", role: "user", content: [{ type: "text", text: "First request" }], timestamp: "2026-01-01T00:00:00.000Z" },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "First answer" }], timestamp: "2026-01-01T00:00:01.000Z" },
    ...extra,
  ];
}

async function serviceFixture() {
  const root = await mkdtemp(join(tmpdir(), "haf-prompt-cache-"));
  const service = new PromptCacheService(root);
  return { service, root };
}

describe("Prompt-cache planner", () => {
  it("derives a plan, and a byte-identical repeat reports a cache hit", async () => {
    const { service } = await serviceFixture();
    const input = { tenantId: "tenant", sessionId: "session", systemPrompt: "You are an agent.\n\n<ACTIVE_CAPABILITIES>…</ACTIVE_CAPABILITIES>", messages: messages() };

    const first = await service.plan(input);
    expect(first.hint).toBeDefined();
    expect(first.plan.markerCount).toBe(4); // system + tool + last 2 messages
    expect(first.plan.prefixHit).toBe(false);
    expect(first.plan.stableChars).toBeGreaterThan(0);
    expect(first.plan.scopeId).toBe("session");
    expect(first.plan.segments.find((segment) => segment.label === "system")?.breakpointAtEnd).toBe(true);

    const second = await service.plan(input);
    expect(second.plan.prefixHit).toBe(true);
    expect(second.plan.sequence).toBe(first.plan.sequence + 1);
    const systemSegment = second.plan.segments.find((segment) => segment.label === "system");
    expect(systemSegment?.stable).toBe(true);

    const latest = await service.latest("tenant", "session");
    expect(latest.plan?.id).toBe(second.plan.id);
    expect(latest.message).toContain("cache hit expected");
  });

  it("reports a miss when the system prompt changes, and keeps bounded history", async () => {
    const { service } = await serviceFixture();
    const input = { tenantId: "tenant", sessionId: "session", systemPrompt: "System A", messages: messages() };
    await service.plan(input);
    const changed = await service.plan({ ...input, systemPrompt: "System B" });
    expect(changed.plan.prefixHit).toBe(false);
    expect(changed.plan.segments.find((segment) => segment.label === "system")?.stable).toBe(false);
    const history = await service.list({ tenantId: "tenant", sessionId: "session", limit: 10 });
    expect(history).toHaveLength(2);
  });

  it("disabling cache removes markers and coerces unsupported TTLs", async () => {
    const { service } = await serviceFixture();
    const input = { tenantId: "tenant", sessionId: "session", systemPrompt: "System", messages: messages() };
    const configured = await service.config("tenant", "session", { ttlMs: 3_600_000 });
    expect(configured).toEqual({ enabled: true, ttlMs: 3_600_000 });
    const invalid = await service.config("tenant", "session", { ttlMs: 600_000 });
    expect(invalid.ttlMs).toBe(300_000);

    const disabled = await service.config("tenant", "session", { enabled: false });
    expect(disabled.enabled).toBe(false);
    const plan = await service.plan(input);
    expect(plan.hint).toBeUndefined();
    expect(plan.plan.markerCount).toBe(0);
    const latest = await service.latest("tenant", "session");
    expect(latest.message).toContain("disabled");
  });
});

describe("Anthropic cache markers", () => {
  it("places system, tool and message-tail breakpoints and skips textless messages", async () => {
    const originalFetch = globalThis.fetch;
    const captured: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      captured.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: "end_turn",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      const provider = new AnthropicProvider({ apiKey: "test", model: "claude-x" });
      const request: ModelRequest = {
        sessionId: "session",
        turnId: "turn",
        systemPrompt: "System prefix",
        messages: [
          { id: "u1", role: "user", content: [{ type: "text", text: "hello" }], timestamp: "t" },
          { id: "a1", role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: "t" },
          { id: "u2", role: "user", content: [{ type: "text", text: "next" }], timestamp: "t" },
          { id: "a2", role: "assistant", content: [{ type: "tool_call", id: "c1", name: "x", arguments: {} }], timestamp: "t" },
        ],
        tools: [{ id: "read.file", version: "1", description: "read", risk: "pure", sideEffect: false, inputSchema: { type: "object" as const }, source: "core" as const }],
        promptCache: {
          planId: "plan-1",
          scopeId: "session",
          ttlMs: 300_000,
          systemBreakpoint: true,
          toolBreakpoint: true,
          messageTailMarkers: 2,
        },
      };
      for await (const _event of provider.stream(request)) {
        // Drain.
      }
      expect(captured).toHaveLength(1);
      const body = captured[0]!;
      const system = body.system as Array<{ type: string; text: string; cache_control?: { type: string; ttl: string } }>;
      expect(Array.isArray(system)).toBe(true);
      expect(system[0]).toMatchObject({ type: "text", text: "System prefix", cache_control: { type: "ephemeral", ttl: "5m" } });
      const tools = body.tools as Array<{ cache_control?: { type: string } }>;
      expect(tools[tools.length - 1]?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
      const msgs = body.messages as Array<{ role: string; content: Array<{ type: string; cache_control?: { type: string } }> }>;
      // Last 2 non-system messages: u2 (text) and a2 (tool-only, skipped).
      const marked = msgs.flatMap((message) => message.content.filter((block) => block.cache_control));
      expect(marked).toHaveLength(1);
      expect(marked[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Prompt-cache capability and actor wiring", () => {
  it("records a plan for every model request and exposes read/control capabilities", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-prompt-cache-e2e-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
      autoApproveWorkspaceWrites: true,
      allowProcessExecution: true,
    });
    const session = await engine.createSession({ tenantId: "tenant", name: "cache-demo" });
    const snapshot = await engine.session(session.sessionId);
    await engine.command({
      protocolVersion: 1,
      commandId: `cmd-cache-${Date.now()}`,
      clientId: "test-client",
      tenantId: "tenant",
      sessionId: session.sessionId,
      kind: "session.prompt",
      source: "api",
      issuedAt: new Date().toISOString(),
      payload: { text: "Say hello in one sentence." },
    });

    let latest: Awaited<ReturnType<typeof engine.promptCache.latest>> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      latest = await engine.promptCache.latest("tenant", session.sessionId);
      if (latest.plan) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    expect(latest?.plan).toBeDefined();
    expect(latest?.plan?.markerCount).toBeGreaterThan(0);
    expect(latest?.plan?.enabled).toBe(true);

    const context = {
      tenantId: "tenant", sessionId: session.sessionId, familyId: session.sessionId, turnId: "turn-cache",
      toolCallId: "call-cache", source: "api" as const, workspacePath: snapshot.workspacePath, idempotencyKey: "cache-1",
    };
    const evidence = await engine.capabilities.execute("session.cache.plan", { limit: 3 }, context) as any;
    expect(evidence.latest.plan.id).toBe(latest?.plan?.id);

    // `session.cache.config` is privileged: it needs an operator decision like
    // any other session-level configuration and must resolve through the
    // approval channel rather than silently applying.
    const configCall = engine.capabilities.execute("session.cache.config", { enabled: false }, context);
    let approvals = engine.approvals.list(session.sessionId);
    for (let wait = 0; wait < 100 && !approvals.length; wait++) {
      await new Promise((tick) => setTimeout(tick, 10));
      approvals = engine.approvals.list(session.sessionId);
    }
    expect(approvals.length).toBe(1);
    engine.approvals.resolve(approvals[0]!.id, "approve_once");
    const configured = await configCall as any;
    expect(configured.enabled).toBe(false);
    const after = await engine.capabilities.execute("session.cache.plan", {}, context) as any;
    expect(after.latest.message).toContain("disabled");

    // The actor emitted the plan as evidence on the request event.
    const events = await engine.readEvents(session.sessionId);
    const started = events.find((item) => item.type === "model.request.started");
    expect((started?.payload as { promptCache?: { id: string } }).promptCache?.id).toMatch(/^cache-plan-/);
    await engine.shutdown();
  }, 60_000);
});
