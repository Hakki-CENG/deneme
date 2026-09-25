import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkerProcessManager } from "../src/runtime/worker/worker-process-manager.js";

describe("detached worker process adoption", () => {
  it("keeps worker state alive across supervisor attachment replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-worker-manager-"));
    const firstManager = new WorkerProcessManager(root);
    const tsxCli = resolve(process.cwd(), "../../node_modules/tsx/dist/cli.mjs");
    const fixture = resolve(process.cwd(), "test/fixtures/detached-worker.ts");
    const first = await firstManager.spawn({ workerId: "root-session", entrypoint: tsxCli, args: [fixture] });
    const initial = JSON.parse((await first.command("increment", { by: 7 })).toString());
    expect(initial.value).toBe(7);
    const pid = initial.pid;

    // Simulate control-plane death: only the attachment closes, not the worker.
    firstManager.closeAttachments();
    const replacementManager = new WorkerProcessManager(root);
    const adopted = await replacementManager.adopt("root-session");
    const after = JSON.parse((await adopted.command("increment", { by: 5 })).toString());
    expect(after).toEqual({ value: 12, pid });
    await replacementManager.stop("root-session");
  }, 20_000);

  it("respawns a dead worker from its launch manifest with the same worker identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-worker-recover-"));
    const manager = new WorkerProcessManager(root);
    const tsxCli = resolve(process.cwd(), "../../node_modules/tsx/dist/cli.mjs");
    const fixture = resolve(process.cwd(), "test/fixtures/detached-worker.ts");
    const first = await manager.spawn({ workerId: "recoverable", entrypoint: tsxCli, args: [fixture] });
    const firstState = JSON.parse((await first.command("increment", { by: 1 })).toString());
    process.kill(firstState.pid, "SIGKILL");
    manager.closeAttachments();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

    const replacementManager = new WorkerProcessManager(root);
    const recovered = await replacementManager.recover("recoverable");
    const secondState = JSON.parse((await recovered.command("get")).toString());
    expect(secondState.pid).not.toBe(firstState.pid);
    await replacementManager.stop("recoverable");
  }, 20_000);
});
