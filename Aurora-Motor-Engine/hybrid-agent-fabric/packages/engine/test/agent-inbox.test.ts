import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { FileAgentInboxStore, PostgresAgentInboxStore, newAgentInboxMessage } from "../src/runtime/agent-inbox.js";
import { PostgresDatabase, type PgPoolLike } from "../src/persistence/postgres/database.js";
import type { CommandEnvelope, ModelProvider } from "../src/types.js";

const engines: HybridAgentEngine[] = [];
afterEach(async () => await Promise.all(engines.splice(0).map((engine) => engine.shutdown())));

function record() {
  return newAgentInboxMessage({
    tenantId: "tenant",
    familyId: "family",
    senderSessionId: "sender",
    senderName: "sender-name",
    targetSessionId: "target",
    targetName: "target-name",
    relationship: "parent",
    requestedMode: "auto",
    effectiveMode: "steer",
    text: "hello",
  });
}

function pgDatabase() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  return new PostgresDatabase({ pool: new adapter.Pool() as unknown as PgPoolLike, schema: "haf_inbox", enableNotify: false });
}

async function makeEngine() {
  const engine = new HybridAgentEngine({
    homePath: await mkdtemp(join(tmpdir(), "haf-agent-inbox-engine-")),
    kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local",
    model: { provider: "mock" },
  });
  engines.push(engine);
  return engine;
}

function prompt(sessionId: string, text: string): CommandEnvelope {
  return {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    clientId: "inbox-test",
    tenantId: "tenant",
    sessionId,
    kind: "session.prompt",
    source: "api",
    issuedAt: new Date().toISOString(),
    payload: { text },
  };
}

describe("durable family-scoped agent inbox", () => {
  it("persists file claims, delivery and stale-claim uncertainty", async () => {
    let now = Date.parse("2026-08-18T00:00:00.000Z");
    const root = await mkdtemp(join(tmpdir(), "haf-agent-inbox-file-"));
    const store = new FileAgentInboxStore(root, { now: () => now, claimTimeoutMs: 1000 });
    const wakes: string[] = [];
    const unsubscribe = store.subscribe((targetSessionId) => wakes.push(targetSessionId));
    const first = record();
    await store.enqueue(first);
    expect(wakes).toEqual(["target"]);
    unsubscribe();
    expect(await store.pendingCount("target")).toBe(1);
    const claimed = await store.claimNext("target", ["steer"], "owner-1");
    expect(claimed?.state).toBe("claimed");
    const delivered = await store.markDelivered(first.id, "target", "owner-1");
    expect(delivered.state).toBe("delivered");
    expect((await new FileAgentInboxStore(root).get(first.id, "target"))?.state).toBe("delivered");

    const second = record();
    await store.enqueue(second);
    await store.claimNext("target", ["steer"], "lost-owner");
    now += 2000;
    expect(await store.pendingCount("target")).toBe(0);
    const uncertain = await store.get(second.id, "target");
    expect(uncertain?.state).toBe("uncertain");
    expect(uncertain?.uncertainReason).toContain("claim_owner_lost");
  });

  it("claims and completes messages on the PostgreSQL store", async () => {
    const store = new PostgresAgentInboxStore(pgDatabase());
    const message = record();
    await store.enqueue(message);
    await store.enqueue(message);
    expect(await store.pendingCount("target")).toBe(1);
    const claimed = await store.claimNext("target", ["steer"], "pg-owner");
    expect(claimed?.id).toBe(message.id);
    await store.markDelivered(message.id, "target", "pg-owner", "2026-08-18T00:00:01.000Z");
    expect((await store.get(message.id, "target"))?.state).toBe("delivered");
  });

  it("delivers idle messages immediately and enforces direct family reach", async () => {
    const engine = await makeEngine();
    const parent = await engine.createSession({ tenantId: "tenant", name: "parent" });
    const child = await engine.supervisor.createSession({ tenantId: "tenant", name: "child", familyId: parent.familyId, parentSessionId: parent.sessionId });
    const sibling = await engine.supervisor.createSession({ tenantId: "tenant", name: "sibling", familyId: parent.familyId, parentSessionId: parent.sessionId });
    await expect(engine.supervisor.createSession({ tenantId: "tenant", name: "sibling", familyId: parent.familyId, parentSessionId: parent.sessionId })).rejects.toThrow("already used by a sibling");
    const outsider = await engine.createSession({ tenantId: "tenant", name: "outsider" });

    const roster = await engine.supervisor.familyRoster(child.sessionId);
    expect(roster.map((item) => [item.relationship, item.name])).toEqual(expect.arrayContaining([["parent", "parent"], ["sibling", "sibling"]]));
    const sent = await engine.supervisor.sendAgentMessage({
      senderSessionId: parent.sessionId,
      targetSessionId: child.sessionId,
      message: "Check the migration",
      mode: "auto",
    });
    expect(sent.receipts[0]).toEqual(expect.objectContaining({ deliveryStatus: "delivered", effectiveMode: "follow_up", relationship: "parent" }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    const childState = await engine.session(child.sessionId);
    expect(JSON.stringify(childState.messages)).toContain("Check the migration");
    expect((await engine.supervisor.listAgentInbox(child.sessionId))[0]?.state).toBe("delivered");

    await expect(engine.supervisor.sendAgentMessage({
      senderSessionId: child.sessionId,
      targetSessionId: outsider.sessionId,
      message: "not allowed",
    })).rejects.toThrow("outside direct");
  });

  it("injects auto messages at a busy turn boundary instead of replaying the turn", async () => {
    const engine = await makeEngine();
    let releaseFirst!: () => void;
    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((resolvePromise) => { startedFirst = resolvePromise; });
    const firstRelease = new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise; });
    let calls = 0;
    const slow: ModelProvider = {
      id: "slow",
      async *stream(request) {
        calls++;
        if (calls === 1) {
          startedFirst();
          await firstRelease;
        }
        const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
        const text = lastUser?.content.find((part) => part.type === "text");
        yield { type: "text_delta", delta: `slow-${calls}:${text?.type === "text" ? text.text.slice(-40) : "none"}` };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    engine.models.register(slow);
    const parent = await engine.createSession({ tenantId: "tenant", name: "parent" });
    const child = await engine.supervisor.createSession({ tenantId: "tenant", name: "busy-child", familyId: parent.familyId, parentSessionId: parent.sessionId });
    await engine.command({ ...prompt(child.sessionId, "select"), kind: "model.select", payload: { model: "slow:test" } });
    const running = engine.command(prompt(child.sessionId, "long work"));
    await firstStarted;
    const sent = await engine.supervisor.sendAgentMessage({
      senderSessionId: parent.sessionId,
      targetSessionId: child.sessionId,
      message: "steer with updated requirement",
      mode: "auto",
    });
    expect(sent.receipts[0]).toEqual(expect.objectContaining({ deliveryStatus: "queued", effectiveMode: "steer" }));
    releaseFirst();
    expect((await running).status).toBe("completed");
    expect(calls).toBe(2);
    const state = await engine.session(child.sessionId);
    expect(JSON.stringify(state.messages)).toContain("steer with updated requirement");
    expect((await engine.supervisor.listAgentInbox(child.sessionId))[0]?.state).toBe("delivered");
  });
});
