import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KernelClient, type KernelHostRequestHandler } from "../src/kernel/kernel-client.js";

async function client(handler: KernelHostRequestHandler) {
  const cwd = await mkdtemp(join(tmpdir(), "haf-kernel-protocol-"));
  return new KernelClient({
    serverScript: "/unused",
    cwd,
    launch: {
      command: process.execPath,
      args: [resolve(process.cwd(), "test/fixtures/fake-kernel.mjs")],
      cwd,
      env: { PATH: process.env.PATH ?? "" },
    },
    hostRequest: handler,
  });
}

describe("generation-fenced kernel host protocol", () => {
  it("deduplicates authenticated host requests by generation/execution/request id", async () => {
    let calls = 0;
    const kernel = await client(async (_capability: string, _arguments: any, metadata: any) => {
      calls++;
      expect(metadata.requestId).toBe("host-request-1");
      return { accepted: true };
    });
    const result = await kernel.execute("duplicate");
    expect(calls).toBe(1);
    expect(result.result).toContain("accepted");
    await kernel.close();
  });

  it("rejects stale or unauthenticated requests before the capability handler", async () => {
    let calls = 0;
    const kernel = await client(async () => { calls++; return null; });
    const result = await kernel.execute("stale");
    expect(calls).toBe(0);
    expect(result.result).toContain("stale_or_unauthenticated_host_request");
    await kernel.close();
  });

  it("kills the synchronous kernel on cancellation so late frames cannot regain currentness", async () => {
    const kernel = await client(async () => null);
    const abort = new AbortController();
    const execution = kernel.execute("hang", 30_000, abort.signal);
    setTimeout(() => abort.abort(), 30).unref();
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(kernel.isClosed).toBe(true);
    await expect(kernel.execute("duplicate")).rejects.toThrow("closed");
  });
});
