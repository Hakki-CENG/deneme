import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkerProcessManager } from "../src/runtime/worker/worker-process-manager.js";

describe("detached root family recovery", () => {
  it("rehydrates root transcript and retained child registry after worker death", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-family-recovery-"));
    const home = join(root, "worker-home");
    const manager = new WorkerProcessManager(join(root, "control"));
    const tsxCli = resolve(process.cwd(), "../../node_modules/tsx/dist/cli.mjs");
    const fixture = resolve(process.cwd(), "test/fixtures/detached-session-worker.ts");
    const client = await manager.spawn({
      workerId: "root-family",
      entrypoint: tsxCli,
      args: [fixture],
      env: { HAF_WORKER_HOME: home },
    });
    const child = JSON.parse((await client.command("spawn_child", { task: "child work", name: "reviewer" })).toString());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const before = JSON.parse((await client.command("list_sessions")).toString()).sessions;
    expect(before.find((session: any) => session.sessionId === "root-family").childSessionIds).toContain(child.sessionId);
    expect(before.find((session: any) => session.sessionId === child.sessionId)).toBeTruthy();

    const descriptor = JSON.parse(await readFile(join(root, "control", "workers", "root-family.json"), "utf8"));
    process.kill(descriptor.pid, "SIGKILL");
    manager.closeAttachments();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

    const replacement = new WorkerProcessManager(join(root, "control"));
    const recovered = await replacement.recover("root-family");
    const after = JSON.parse((await recovered.command("list_sessions")).toString()).sessions;
    const rootState = after.find((session: any) => session.sessionId === "root-family");
    const childState = after.find((session: any) => session.sessionId === child.sessionId);
    expect(rootState.generation).toBeGreaterThan(1);
    expect(rootState.childSessionIds).toContain(child.sessionId);
    expect(childState).toBeTruthy();
    expect(childState.messages.length).toBeGreaterThanOrEqual(2);
    await replacement.stop("root-family");
  }, 30_000);
});
