import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { BackgroundShellService } from "../src/sandbox/background-shell.js";
import { LocalSandbox } from "../src/sandbox/sandbox.js";

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-shell-"));
  const engine = new HybridAgentEngine({
    homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local", model: { provider: "mock" }, autoApproveWorkspaceWrites: true, allowProcessExecution: true,
  });
  const session = await engine.createSession({ tenantId: "tenant", name: "shell-owner" });
  const snapshot = await engine.session(session.sessionId);
  const context = (suffix: string) => ({
    tenantId: "tenant", sessionId: session.sessionId, familyId: session.sessionId,
    turnId: `turn-${suffix}`, toolCallId: `call-${suffix}`, source: "api" as const,
    workspacePath: snapshot.workspacePath, idempotencyKey: `shell-${suffix}`,
  });
  return { engine, session, snapshot, context };
}

async function directService() {
  const workspacePath = await mkdtemp(join(tmpdir(), "haf-shell-ws-"));
  const service = new BackgroundShellService(async (path) => new LocalSandbox(path));
  return { service, workspacePath };
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return;
    await new Promise((tick) => setTimeout(tick, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

describe("Background shells", () => {
  it("returns immediately and streams output that can be read incrementally by cursor", async () => {
    const { service, workspacePath } = await directService();
    const started = await service.start({
      tenantId: "tenant", sessionId: "session", workspacePath,
      command: "for i in 1 2 3; do echo line-$i; sleep 0.15; done",
      label: "counter",
    });
    expect(started.status).toBe("running");
    expect(started.producedChars).toBe(0);

    const first = await service.output({ shellId: started.id, cursor: 0, waitMs: 5_000 });
    expect(first.chunk).toContain("line-1");
    expect(first.nextCursor).toBeGreaterThan(0);
    expect(first.done).toBe(false);

    let cursor = first.nextCursor;
    let transcript = first.chunk;
    await waitFor(async () => {
      const next = await service.output({ shellId: started.id, cursor, waitMs: 1_000 });
      transcript += next.chunk;
      cursor = next.nextCursor;
      return next.done;
    }, "the shell to finish");

    expect(transcript).toContain("line-3");
    const final = service.get(started.id)!;
    expect(final.status).toBe("exited");
    expect(final.exitCode).toBe(0);
    expect(final.durationMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("kills a running shell on request and records the reason", async () => {
    const { service, workspacePath } = await directService();
    const started = await service.start({
      tenantId: "tenant", sessionId: "session", workspacePath, command: "sleep 30", timeoutMs: 60_000,
    });
    const stopped = await service.stop({ shellId: started.id, sessionId: "session", reason: "no longer needed" });
    expect(stopped.status).toBe("killed");
    expect(stopped.stopReason).toBe("no longer needed");
    expect(stopped.endedAt).toBeDefined();

    // Stopping twice is not an error, and does not rewrite how it ended.
    const again = await service.stop({ shellId: started.id, reason: "again" });
    expect(again.status).toBe("killed");
    expect(again.stopReason).toBe("no longer needed");
  }, 30_000);

  it("refuses to hand a shell to another session and bounds how many run at once", async () => {
    const { service, workspacePath } = await directService();
    const mine = await service.start({ tenantId: "tenant", sessionId: "mine", workspacePath, command: "sleep 5" });
    await expect(service.output({ shellId: mine.id, sessionId: "someone-else" })).rejects.toThrow(/another session/i);
    await expect(service.stop({ shellId: mine.id, sessionId: "someone-else", reason: "steal" })).rejects.toThrow(/another session/i);

    for (let index = 0; index < 3; index++) {
      await service.start({ tenantId: "tenant", sessionId: "mine", workspacePath, command: "sleep 5" });
    }
    await expect(service.start({ tenantId: "tenant", sessionId: "mine", workspacePath, command: "sleep 5" }))
      .rejects.toThrow(/already has 4 background shell/i);
    await service.stopForSession("mine", "test over");
  }, 30_000);

  it("reports lost output rather than stitching a misleading transcript", async () => {
    const { service, workspacePath } = await directService();
    const started = await service.start({
      tenantId: "tenant", sessionId: "session", workspacePath,
      // Well past the 200k-character live buffer, so the front is evicted while it runs.
      command: "head -c 400000 /dev/zero | tr '\\\\0' 'x'",
    });
    await waitFor(() => service.get(started.id)!.status !== "running", "the noisy shell to finish");

    const record = service.get(started.id)!;
    expect(record.producedChars).toBeGreaterThan(200_000);
    expect(record.droppedChars).toBeGreaterThan(0);

    const fromStart = await service.output({ shellId: started.id, cursor: 0 });
    expect(fromStart.skippedChars).toBe(record.droppedChars);
    expect(fromStart.cursor).toBe(0);
    expect(fromStart.nextCursor).toBeGreaterThan(record.droppedChars);
  }, 30_000);

  it("exposes start, output, stop and list as governed capabilities and kills shells when the session closes", async () => {
    const { engine, session, context } = await fixture();
    const started = await engine.capabilities.execute(
      "shell.start", { command: "echo hello-shell; sleep 20", label: "greeting" }, context("start"),
    ) as { id: string; status: string };
    expect(started.status).toBe("running");

    const output = await engine.capabilities.execute(
      "shell.output", { shellId: started.id, waitMs: 5_000 }, context("output"),
    ) as { chunk: string; nextCursor: number };
    expect(output.chunk).toContain("hello-shell");

    const listed = await engine.capabilities.execute("shell.list", { runningOnly: true }, context("list")) as { shells: Array<{ id: string }> };
    expect(listed.shells.map((item) => item.id)).toContain(started.id);

    await engine.command({
      protocolVersion: 1, commandId: randomUUID(), clientId: "test", tenantId: "tenant", sessionId: session.sessionId,
      kind: "session.close", source: "api", issuedAt: new Date().toISOString(), payload: {},
    });
    await waitFor(() => engine.backgroundShells.get(started.id)?.status !== "running", "the shell to die with its session");
    expect(engine.backgroundShells.get(started.id)!.stopReason).toBe("session closed");
    await engine.shutdown();
  }, 60_000);
});
