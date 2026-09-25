import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { BackupService } from "../src/persistence/backup-service.js";
import { DurableScheduler } from "../src/scheduler/scheduler.js";
import type { Supervisor } from "../src/runtime/supervisor.js";
import { PostgresDatabase } from "../src/persistence/postgres/database.js";
import { ModelProviderRegistry } from "../src/models/model-router.js";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "../src/types.js";

/** Simulate elapsed time: rewrite the durable job state so the once-job is due. */
async function makeDue(root: string, jobId: string): Promise<void> {
  const path = join(root, "scheduler", "jobs.json");
  const jobs = JSON.parse(await readFile(path, "utf8")) as Array<{ id: string; nextRunAt?: string }>;
  for (const job of jobs) {
    if (job.id === jobId) job.nextRunAt = new Date(Date.now() - 1000).toISOString();
  }
  await writeFile(path, JSON.stringify(jobs, null, 2));
}

function fakeProvider(id: string): ModelProvider {
  return {
    id,
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", delta: `response from ${id}` };
    },
  } as unknown as ModelProvider;
}

// ═══ O3: device-aware routing ═══

describe("O3 — device-aware task routing", () => {
  it("refuses local-only requests when only cloud providers exist, and serves them from a declared local provider", async () => {
    const registry = new ModelProviderRegistry();
    registry.register(fakeProvider("cloud-a"), true);
    registry.register(fakeProvider("cloud-b"));

    // Undeclared providers count as cloud: a local-only request has nowhere
    // to go and the error says so instead of silently using the cloud.
    await expect(async () => {
      for await (const _event of registry.stream({
        sessionId: "s", turnId: "t", systemPrompt: "x", messages: [], tools: [],
        model: "cloud-a", privacy: "local-only",
      })) { void _event; }
    }).rejects.toThrow(/No local model provider/);

    registry.setLocality("cloud-b", "local");
    const events: ModelStreamEvent[] = [];
    for await (const event of registry.stream({
      sessionId: "s", turnId: "t", systemPrompt: "x", messages: [], tools: [],
      model: "cloud-a:default", fallbackModels: ["cloud-b:default"], privacy: "local-only",
    })) events.push(event);
    const selected = events.find((event) => event.type === "route_selected") as { provider: string; fallback: boolean };
    // The cloud route was skipped; the local provider answered as the primary
    // candidate under the constraint (attempt 0, not a fallback).
    expect(selected.provider).toBe("cloud-b");
    expect(selected.fallback).toBe(false);
  });

  it("prefer-local reorders candidates so the local provider is tried first", async () => {
    const registry = new ModelProviderRegistry();
    registry.register(fakeProvider("cloud-a"), true);
    registry.register(fakeProvider("edge"), false);
    registry.setLocality("edge", "local");

    const events: ModelStreamEvent[] = [];
    for await (const event of registry.stream({
      sessionId: "s", turnId: "t", systemPrompt: "x", messages: [], tools: [],
      model: "cloud-a:default", fallbackModels: ["edge:default"], privacy: "prefer-local",
    })) events.push(event);
    const selected = events.find((event) => event.type === "route_selected") as { provider: string };
    expect(selected.provider).toBe("edge");
  });
});

// ═══ O5: backup / restore ═══

describe("O5 — backup, verify, restore", () => {
  it("takes a full backup, an incremental that only stores changes, and restores the chain", async () => {
    const source = await mkdtemp(join(tmpdir(), "o5-src-"));
    const backupRoot = await mkdtemp(join(tmpdir(), "o5-bak-"));
    await writeFile(join(source, "memory.json"), JSON.stringify({ v: 1 }), "utf8");
    await writeFile(join(source, "ledger.json"), JSON.stringify({ n: 7 }), "utf8");

    const service = new BackupService(source, backupRoot);
    const full = await service.createFull();
    expect(full.kind).toBe("full");
    expect(full.fileCount).toBe(2);
    expect((await service.verify(full.id)).verified).toBe(true);

    // Change one file, add one, leave one untouched.
    await writeFile(join(source, "ledger.json"), JSON.stringify({ n: 8 }), "utf8");
    await writeFile(join(source, "new.txt"), "fresh", "utf8");
    const incremental = await service.createIncremental();
    expect(incremental.kind).toBe("incremental");
    expect(incremental.baseBackupId).toBe(full.id);
    // 3 files recorded; only the 2 changed/new ones stored.
    expect(incremental.fileCount).toBe(3);
    expect(incremental.files.filter((file) => file.stored)).toHaveLength(2);
    expect(incremental.files.find((file) => file.relativePath === "memory.json")?.stored).toBe(false);

    // Destructive loss, then restore from the incremental chain.
    await writeFile(join(source, "ledger.json"), "garbage");
    await writeFile(join(source, "memory.json"), "garbage");
    const report = await service.restore(incremental.id);
    expect(report.verified).toBe(true);
    // Restore returns the WHOLE tree at the incremental's point in time:
    // the unchanged memory.json from the full backup, plus the two changed
    // files from the incremental.
    expect(report.restoredFiles).toBe(3);
    expect(await readFile(join(source, "ledger.json"), "utf8")).toContain("8");
    expect(await readFile(join(source, "memory.json"), "utf8")).toContain("1");
    expect(await readFile(join(source, "new.txt"), "utf8")).toBe("fresh");
  });

  it("refuses to restore from a corrupted backup (fail-closed, no partial restore)", async () => {
    const source = await mkdtemp(join(tmpdir(), "o5-src-"));
    const backupRoot = await mkdtemp(join(tmpdir(), "o5-bak-"));
    await writeFile(join(source, "state.json"), "important", "utf8");
    const service = new BackupService(source, backupRoot);
    const full = await service.createFull();

    // Corrupt the stored copy behind the manifest's back.
    await writeFile(join(backupRoot, full.id, "state.json"), "tampered", "utf8");
    const verdict = await service.verify(full.id);
    expect(verdict.verified).toBe(false);
    expect(verdict.mismatches[0]?.reason).toMatch(/checksum mismatch/);

    // Live state is destroyed AFTER the backup was made — the corrupt backup
    // must not be allowed to make it worse.
    await writeFile(join(source, "state.json"), "current-good", "utf8");
    const report = await service.restore(full.id);
    expect(report.verified).toBe(false);
    expect(report.restoredFiles).toBe(0);
    // The live tree was not touched by the refused restore.
    expect(await readFile(join(source, "state.json"), "utf8")).toBe("current-good");
  });
});

// ═══ O6/O7: worker reliability and crash recovery ═══

describe("O6/O7 — crash recovery, duplicate prevention, partition fail-closed", () => {
  it("advances a due job durably BEFORE dispatch: a dispatch crash never double-fires it", async () => {
    const root = await mkdtemp(join(tmpdir(), "o6-"));
    const dispatches: string[] = [];
    let dispatchesToCrash = 1;
    const supervisor = {
      dispatch: async (command: { commandId: string }) => {
        dispatches.push(command.commandId);
        if (dispatchesToCrash > 0) {
          dispatchesToCrash--;
          throw new Error("simulated worker crash mid-dispatch");
        }
        return { status: "completed" };
      },
    } as unknown as Supervisor;
    // A once-job cannot be created in the past, so create it in the future
    // and let (simulated) time pass by rewriting the durable state — exactly
    // what a restart after the due moment sees on disk.
    const scheduler = new DurableScheduler(root, supervisor);
    const job = await scheduler.create({
      tenantId: "t", sessionId: "s", prompt: "run the report",
      schedule: { kind: "once", at: new Date(Date.now() + 3_600_000).toISOString() },
    });
    await makeDue(root, job.id);

    // First tick: the job advances durably, then the dispatch crashes.
    const crashing = new DurableScheduler(root, supervisor);
    await expect(crashing.tick()).rejects.toThrow(/crash/);
    // A restart-equivalent fresh scheduler reads the same state.
    const restarted = new DurableScheduler(root, supervisor);
    await restarted.tick();
    // The once-job fired exactly once across both ticks.
    expect(dispatches).toHaveLength(1);
    const stored = JSON.parse(await readFile(join(root, "scheduler", "jobs.json"), "utf8")) as Array<{ id: string; status: string }>;
    expect(stored.find((item) => item.id === job.id)?.status).toBe("completed");
  });

  it("fails closed and honestly when the database is unreachable", async () => {
    const pool = {
      query: async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); },
    };
    const database = new PostgresDatabase({ pool: pool as never });
    // The schema check propagates the real connectivity error; it neither
    // fakes success nor silently falls back to another store.
    await expect(database.ensureSchema()).rejects.toThrow(/ECONNREFUSED/);
  });
});

// ═══ O8: load scaling ═══

describe("O8 — load scaling", () => {
  it("runs many concurrent sessions without cross-contamination", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "o8-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      autoApproveWorkspaceWrites: true,
      allowProcessExecution: true,
      model: { provider: "mock" },
    });
    const SESSIONS = 8;
    const sessions = await Promise.all(
      Array.from({ length: SESSIONS }, (_, index) => engine.createSession({ tenantId: `load-tenant-${index}` })),
    );
    const reports = await Promise.all(sessions.map((session, index) =>
      engine.execute({ tenantId: `load-tenant-${index}`, goal: `Remember the codeword marker-${index} for tenant ${index}.`, workspace: session.workspacePath }),
    ));
    expect(reports).toHaveLength(SESSIONS);
    for (let index = 0; index < SESSIONS; index++) {
      // Each report belongs to its own tenant and references its own goal.
      expect(reports[index]!.tenantId).toBe(`load-tenant-${index}`);
      expect(reports[index]!.goal).toContain(`marker-${index}`);
      expect(["completed", "executed", "failed", "blocked", "ask", "unverified"]).toContain(reports[index]!.status);
    }
    // The scheduler and memory stay per-tenant under the same load.
    for (let index = 0; index < SESSIONS; index++) {
      const jobs = await engine.scheduler.list(`load-tenant-${index}`);
      expect(jobs.every((job) => job.tenantId === `load-tenant-${index}`)).toBe(true);
    }
    await engine.shutdown();
  }, 120_000);

  it("dispatches a burst of due jobs in one scheduler tick", async () => {
    const root = await mkdtemp(join(tmpdir(), "o8b-"));
    const dispatches: string[] = [];
    const supervisor = {
      dispatch: async (command: { commandId: string }) => {
        dispatches.push(command.commandId);
        return { status: "completed" };
      },
    } as unknown as Supervisor;
    const seeder = new DurableScheduler(root, supervisor);
    const JOBS = 30;
    const ids: string[] = [];
    for (let index = 0; index < JOBS; index++) {
      const created = await seeder.create({
        tenantId: `t-${index}`, sessionId: "s", prompt: `job ${index}`,
        schedule: { kind: "once", at: new Date(Date.now() + 3_600_000).toISOString() },
      });
      ids.push(created.id);
    }
    for (const id of ids) await makeDue(root, id);
    const scheduler = new DurableScheduler(root, supervisor);
    await scheduler.tick();
    expect(dispatches).toHaveLength(JOBS);
    const stored = JSON.parse(await readFile(join(root, "scheduler", "jobs.json"), "utf8")) as Array<{ status: string }>;
    expect(stored.filter((job) => job.status === "completed")).toHaveLength(JOBS);
    // A second tick is a no-op: every job advanced durably already.
    const second = new DurableScheduler(root, supervisor);
    await second.tick();
    expect(dispatches).toHaveLength(JOBS);
  });

  it("serves concurrent memory searches with tenant isolation intact", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "o8c-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      autoApproveWorkspaceWrites: true,
      model: { provider: "mock" },
    });
    const session = await engine.createSession({ tenantId: "mem-load" });
    for (let index = 0; index < 60; index++) {
      await engine.memory.create({
        tenantId: index % 2 === 0 ? "mem-load" : "other-tenant",
        sessionId: session.sessionId,
        kind: "semantic",
        scope: "global",
        title: `record ${index}`,
        content: `payload for record ${index} about scalability`,
        evidenceEventIds: [],
        provenance: { createdBy: "user" },
        status: "active",
      });
    }
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      engine.memory.search("mem-load", "scalability", { limit: 50 })));
    for (const records of results) {
      expect(records.length).toBe(30);
      expect(records.every((record) => record.tenantId === "mem-load")).toBe(true);
    }
    await engine.shutdown();
  }, 60_000);
});
