import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import type { HonchoClientLike } from "../src/memory/honcho-memory-provider.js";
import type { CommandEnvelope, ModelRequest } from "../src/types.js";

const engines: HybridAgentEngine[] = [];
afterEach(async () => { await Promise.all(engines.splice(0).map((engine) => engine.shutdown())); });

describe("engine external-memory lifecycle", () => {
  it("injects Honcho context only into model projection and journals post-turn writeback", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-memory-engine-"));
    const synchronized: any[][] = [];
    const peers = new Map<string, any>();
    const makePeer = (id: string): any => ({
      id,
      message(content: string, options?: any) { return { peerId: id, content, ...options }; },
      async context() { return { representation: "prefers typed systems", peerCard: ["uses Rust"] }; },
      async getCard() { return ["uses Rust"]; },
      async search() { return []; },
      async chat() { return "reasoned"; },
      conclusionsOf() { return { async list() { return { items: [] }; }, async query() { return []; }, async create() { return []; }, async delete() {} }; },
    });
    const session: any = {
      id: "honcho-session",
      async context() { return { summary: { content: "cross-session summary" }, peerRepresentation: "prefers typed systems", peerCard: ["uses Rust"], messages: [] }; },
      async addMessages(value: any[]) { synchronized.push(value); return []; },
      async search() { return []; },
    };
    const client: HonchoClientLike = {
      async peer(id: string) { if (!peers.has(id)) peers.set(id, makePeer(id)); return peers.get(id); },
      async session() { return session; },
      async search() { return []; },
    };
    const engine = new HybridAgentEngine({
      homePath: root,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      autoApproveWorkspaceWrites: true,
      model: { provider: "mock" },
      externalMemory: {
        provider: "honcho",
        baseURL: "http://127.0.0.1:8000",
        allowSelfHosted: true,
        allowPrivateBaseUrl: true,
        clientFactory: () => client,
      },
    });
    engines.push(engine);
    let captured: ModelRequest | undefined;
    engine.models.register({
      id: "capture-memory",
      async *stream(request) {
        captured = request;
        yield { type: "text_delta", delta: "final response" };
        yield { type: "done", stopReason: "end_turn" };
      },
    }, true);
    const created = await engine.createSession({ tenantId: "tenant" });
    const command: CommandEnvelope = {
      protocolVersion: 1,
      commandId: randomUUID(),
      clientId: "test",
      tenantId: "tenant",
      sessionId: created.sessionId,
      kind: "session.prompt",
      source: "api",
      issuedAt: new Date().toISOString(),
      payload: { text: "Remember which systems I prefer" },
    };
    expect((await engine.command(command)).status).toBe("completed");
    expect(captured).toBeDefined();
    expect(JSON.stringify(captured!.messages)).toContain("EXTERNAL_MEMORY_CONTEXT");
    expect(JSON.stringify(captured!.messages)).toContain("prefers typed systems");
    const durable = await engine.session(created.sessionId);
    expect(JSON.stringify(durable.messages)).not.toContain("EXTERNAL_MEMORY_CONTEXT");
    expect(synchronized).toHaveLength(1);
    expect(JSON.stringify(synchronized[0])).toContain("Remember which systems I prefer");
    expect(JSON.stringify(synchronized[0])).toContain("final response");
    expect(engine.capabilities.list().map((item) => item.id)).toContain("memory.honcho.search");
    const events = await engine.readEvents(created.sessionId);
    expect(events).toContainEqual(expect.objectContaining({ type: "memory.external.sync", payload: expect.objectContaining({ status: "delivered" }) }));
    expect(await engine.externalMemory.status()).toMatchObject({ configured: true, id: "honcho", sync: { delivered: 1, uncertain: 0, pending: 0 } });
  });
});
