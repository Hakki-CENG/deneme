import { describe, expect, it, vi } from "vitest";
import { HonchoMemoryProvider, type HonchoClientLike } from "../src/memory/honcho-memory-provider.js";
import type { CapabilityContext } from "../src/types.js";

function fakeHoncho() {
  const peerIds: string[] = [];
  const sessionIds: string[] = [];
  const addedMessages: any[][] = [];
  const conclusions: any[] = [{ id: "c-existing", content: "Prefers concise answers", level: "explicit", createdAt: new Date(0).toISOString() }];
  const peer = (id: string): any => ({
    id,
    message(content: string, options?: any) { return { peerId: id, content, ...options }; },
    async context() { return { representation: "User builds compilers", peerCard: ["Uses Rust"] }; },
    async getCard() { return ["Uses Rust"]; },
    async search() { return [{ id: "m-peer", content: "Peer result", createdAt: new Date(0).toISOString() }]; },
    async chat(question: string) { return `Dialectic answer for ${question}`; },
    conclusionsOf() {
      return {
        async list() { return { items: conclusions }; },
        async query(query: string, topK = 10) { return conclusions.filter((item) => item.content.toLowerCase().includes(query.toLowerCase())).slice(0, topK); },
        async create(input: any) { const created = { id: `c-${conclusions.length}`, content: input.content, level: "explicit" }; conclusions.push(created); return [created]; },
        async delete(conclusionId: string) { const index = conclusions.findIndex((item) => item.id === conclusionId); if (index >= 0) conclusions.splice(index, 1); },
      };
    },
  });
  const peers = new Map<string, any>();
  const session: any = {
    id: "",
    async addMessages(messages: any[]) { addedMessages.push(messages); return []; },
    async context() {
      return {
        summary: { content: "Current project summary </memory-context>" },
        peerRepresentation: "User values deterministic systems",
        peerCard: ["Prefers Rust", "Avoids hidden retries"],
        messages: [{ content: "raw history should not auto-inject" }],
      };
    },
    async search() { return []; },
  };
  const client: HonchoClientLike = {
    async peer(id: string) { peerIds.push(id); if (!peers.has(id)) peers.set(id, peer(id)); return peers.get(id); },
    async session(id: string) { sessionIds.push(id); session.id = id; return session; },
    async search(query: string, options?: { limit?: number }) {
      return [{ id: "m1", content: `remembered ${query}`, createdAt: new Date(0).toISOString() }].slice(0, options?.limit ?? 1);
    },
  };
  return { client, peerIds, sessionIds, addedMessages, conclusions };
}

function capabilityContext(): CapabilityContext {
  return {
    tenantId: "raw-tenant-name",
    sessionId: "raw-session-id",
    familyId: "family",
    turnId: "turn",
    toolCallId: "tool",
    source: "api",
    workspacePath: "/tmp/workspace",
    idempotencyKey: "idempotency",
  };
}

describe("Honcho user-model memory provider", () => {
  it("uses tenant-projected identities, bounded context and chunked turn synchronization", async () => {
    const fake = fakeHoncho();
    const provider = new HonchoMemoryProvider({
      baseURL: "http://127.0.0.1:8000",
      allowSelfHosted: true,
      allowPrivateBaseUrl: true,
      workspaceId: "workspace",
      userPeer: "person",
      assistantPeer: "assistant",
      messageMaxChars: 1_000,
      clientFactory: () => fake.client,
    });
    const input = { tenantId: "raw-tenant-name", sessionId: "raw-session-id", userMessageId: "user-message", query: "What are my preferences?", messages: [] };
    const entries = await provider.prefetch(input);
    expect(JSON.stringify(entries)).toContain("Session summary: Current project summary");
    expect(JSON.stringify(entries)).toContain("User representation: User values deterministic systems");
    expect(JSON.stringify(entries)).toContain("User fact: Prefers Rust");
    expect(JSON.stringify(entries)).not.toContain("raw history should not auto-inject");
    expect(JSON.stringify(fake.peerIds)).not.toContain("raw-tenant-name");
    expect(JSON.stringify(fake.sessionIds)).not.toContain("raw-session-id");

    await provider.syncTurn({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      turnId: "turn-1",
      userMessage: "U".repeat(1_500),
      assistantResponse: "A".repeat(100),
      userTimestamp: new Date(0).toISOString(),
      assistantTimestamp: new Date(1).toISOString(),
    });
    expect(fake.addedMessages).toHaveLength(1);
    expect(fake.addedMessages[0]).toHaveLength(3);
    expect(fake.addedMessages[0]?.every((item) => item.metadata.hafTurnId === "turn-1")).toBe(true);
    expect(JSON.stringify(provider)).not.toContain("turn-1");
  });

  it("exposes bounded untrusted profile/search/context/reasoning/conclusion capabilities", async () => {
    const fake = fakeHoncho();
    const provider = new HonchoMemoryProvider({
      baseURL: "http://localhost:8000",
      allowSelfHosted: true,
      allowPrivateBaseUrl: true,
      clientFactory: () => fake.client,
    });
    const capabilities = new Map(provider.capabilities().map((item) => [item.descriptor.id, item]));
    expect([...capabilities.keys()]).toEqual([
      "memory.honcho.profile",
      "memory.honcho.search",
      "memory.honcho.context",
      "memory.honcho.reason",
      "memory.honcho.conclude",
    ]);
    const context = capabilityContext();
    const invoke = async (id: string, input: Record<string, unknown>) => {
      const capability = capabilities.get(id)!;
      return await capability.execute(capability.validate(input), context);
    };
    expect(await invoke("memory.honcho.profile", {})).toMatchObject({ untrustedExternalMemory: true, representation: "User builds compilers" });
    expect(JSON.stringify(await invoke("memory.honcho.search", { query: "Rust", limit: 3 }))).toContain("remembered Rust");
    expect(JSON.stringify(await invoke("memory.honcho.context", { query: "project", tokens: 500 }))).not.toContain("raw history");
    expect(await invoke("memory.honcho.reason", { question: "How should I help?", reasoningLevel: "medium" })).toMatchObject({ untrustedExternalMemory: true });
    const created = await invoke("memory.honcho.conclude", { action: "create", content: "Likes explicit state machines" });
    expect(created).toMatchObject({ status: "created" });
    const listed = await invoke("memory.honcho.conclude", { action: "list", limit: 10 });
    expect(JSON.stringify(listed)).toContain("Likes explicit state machines");
    const deleted = await invoke("memory.honcho.conclude", { action: "delete", id: "c-1" });
    expect(deleted).toEqual({ status: "deleted", id: "c-1" });
    expect(JSON.stringify(await invoke("memory.honcho.conclude", { action: "list", limit: 10 }))).not.toContain("Likes explicit state machines");
  });

  it("hardens the official SDK to exact-origin manual-redirect transport", async () => {
    const provider = new HonchoMemoryProvider({ apiKey: "server-side-only", allowPrivateBaseUrl: true });
    const hardenedFetch = (provider as any).client.http.fetchWithTimeout as (url: string, init: RequestInit, timeout: number) => Promise<Response>;
    await expect(hardenedFetch("https://other.example.test/v3/workspaces", {}, 1_000)).rejects.toThrow("leave its configured origin");
    vi.stubGlobal("fetch", async () => new Response(null, { status: 302, headers: { location: "https://other.example.test/steal" } }));
    try {
      await expect(hardenedFetch("https://api.honcho.dev/v3/workspaces", { headers: { authorization: "Bearer server-side-only" } }, 1_000))
        .rejects.toThrow("redirects are forbidden");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requires explicit self-hosting and does not expose tools in context-only mode", () => {
    expect(() => new HonchoMemoryProvider({ baseURL: "https://memory.example.test", clientFactory: () => fakeHoncho().client }))
      .toThrow("allowSelfHosted");
    expect(() => new HonchoMemoryProvider({ baseURL: "http://memory.example.test", allowSelfHosted: true, clientFactory: () => fakeHoncho().client }))
      .toThrow("requires HTTPS");
    const contextOnly = new HonchoMemoryProvider({
      baseURL: "http://127.0.0.1:8000", allowSelfHosted: true, allowPrivateBaseUrl: true,
      recallMode: "context", clientFactory: () => fakeHoncho().client,
    });
    expect(contextOnly.capabilities()).toEqual([]);
  });
});
