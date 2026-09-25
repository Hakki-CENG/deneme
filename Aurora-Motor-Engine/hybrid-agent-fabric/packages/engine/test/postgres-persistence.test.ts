import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { PostgresDatabase, type PgPoolLike } from "../src/persistence/postgres/database.js";
import { PostgresEventStore } from "../src/persistence/postgres/event-store.js";
import { PostgresSnapshotStore } from "../src/persistence/postgres/snapshot-store.js";
import { PostgresCommandJournal } from "../src/persistence/postgres/command-journal.js";
import { PostgresEffectJournal } from "../src/persistence/postgres/effect-journal.js";
import { PostgresSessionLeaseManager } from "../src/persistence/postgres/session-lease.js";
import { HybridAgentEngine } from "../src/engine.js";
import type { CommandEnvelope, EventEnvelope, SessionSnapshot } from "../src/types.js";

function database() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool() as unknown as PgPoolLike;
  return new PostgresDatabase({ pool, schema: "haf_test", enableNotify: false });
}

function event(sequence: number): EventEnvelope {
  return {
    schemaVersion: 1, eventId: `event-${sequence}`, tenantId: "tenant", sessionId: "session",
    familyId: "session", generation: 1, sequence, traceId: "trace", type: "test",
    timestamp: new Date().toISOString(), visibility: "internal", redactionClass: "none", payload: { sequence },
  };
}

const command: CommandEnvelope = {
  protocolVersion: 1, commandId: "command", clientId: "client", tenantId: "tenant", sessionId: "session",
  kind: "session.pause", source: "api", issuedAt: new Date().toISOString(), payload: {},
};

describe("PostgreSQL distributed persistence", () => {
  it("persists events, snapshots and deduplicated journals", async () => {
    const db = database();
    const events = new PostgresEventStore(db);
    const seen: string[] = [];
    events.subscribeAll((item) => seen.push(item.eventId));
    await events.append(event(1));
    await events.append(event(1));
    await events.append(event(2));
    expect((await events.read("session", 0)).map((item) => item.sequence)).toEqual([1, 2]);
    expect(await events.lastSequence("session")).toBe(2);
    expect(seen).toEqual(["event-1", "event-2"]);

    const snapshots = new PostgresSnapshotStore(db);
    const snapshot = {
      sessionId: "session", familyId: "session", tenantId: "tenant", generation: 1, lastSequence: 2,
      status: "idle", name: "test", workspacePath: "/tmp", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), messages: [], childSessionIds: [],
      totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    } satisfies SessionSnapshot;
    await snapshots.save(snapshot);
    expect((await snapshots.load("session"))?.lastSequence).toBe(2);

    const commands = new PostgresCommandJournal(db);
    let commandRuns = 0;
    const first = await commands.execute(command, async () => ({ commandId: command.commandId, status: "completed", result: { n: ++commandRuns } }));
    expect(await commands.execute(command, async () => ({ commandId: command.commandId, status: "completed", result: { n: ++commandRuns } }))).toEqual(first);
    const reloadedCommands = new PostgresCommandJournal(db);
    expect(await reloadedCommands.execute(command, async () => ({ commandId: command.commandId, status: "completed", result: { n: ++commandRuns } }))).toEqual(first);
    expect(commandRuns).toBe(1);

    const effects = new PostgresEffectJournal(db);
    let effectRuns = 0;
    expect(await effects.execute("effect", async () => ({ n: ++effectRuns }))).toEqual({ n: 1 });
    expect(await effects.execute("effect", async () => ({ n: ++effectRuns }))).toEqual({ n: 1 });
    const reloadedEffects = new PostgresEffectJournal(db);
    expect(await reloadedEffects.execute("effect", async () => ({ n: ++effectRuns }))).toEqual({ n: 1 });
    expect(effectRuns).toBe(1);
  });

  it("coordinates session ownership across runtime instances", async () => {
    const db = database();
    const first = new PostgresSessionLeaseManager(db, { ownerId: "one" });
    const second = new PostgresSessionLeaseManager(db, { ownerId: "two" });
    await first.acquire("session");
    await expect(second.acquire("session")).rejects.toThrow("already active");
    await first.release("session");
    await second.acquire("session");
    await second.releaseAll();
  });

  it("runs the complete engine vertical slice on PostgreSQL adapters", async () => {
    const db = database();
    const homePath = await mkdtemp(join(tmpdir(), "haf-pg-engine-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      postgres: { pool: db.pool, schema: db.schema, enableNotify: false },
      model: { provider: "mock" },
    });
    const session = await engine.createSession({ tenantId: "tenant" });
    const result = await engine.command({
      protocolVersion: 1, commandId: randomUUID(), clientId: "test", tenantId: "tenant",
      sessionId: session.sessionId, kind: "session.prompt", source: "api", issuedAt: new Date().toISOString(),
      payload: { text: "postgres runtime" },
    });
    expect(result.status).toBe("completed");
    expect((await engine.readEvents(session.sessionId)).some((item) => item.type === "model.request.finished")).toBe(true);
    expect((await engine.session(session.sessionId)).messages).toHaveLength(2);
    await engine.shutdown();
  });
});
