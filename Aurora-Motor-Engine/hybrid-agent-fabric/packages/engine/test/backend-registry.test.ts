import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendRegistry } from "../src/backends/backend-registry.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.TEST_REMOTE_TOKEN; });

describe("server-side backend registry", () => {
  it("seeds local, persists remote metadata and resolves credentials only server-side", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-backends-"));
    const registry = new BackendRegistry(root);
    expect((await registry.list()).map((item) => item.id)).toEqual(["local"]);
    const remote = await registry.add({
      name: "Remote team engine",
      kind: "remote",
      baseUrl: "https://agents.example.test/",
      auth: { mode: "bearer-env", environmentVariable: "TEST_REMOTE_TOKEN" },
    });
    expect(remote.baseUrl).toBe("https://agents.example.test");
    expect(JSON.stringify(await registry.list())).not.toContain("secret-value");

    process.env.TEST_REMOTE_TOKEN = "secret-value";
    let authorization = "";
    globalThis.fetch = vi.fn(async (_url, init) => {
      authorization = (init?.headers as Record<string, string>).authorization;
      return new Response(JSON.stringify({ status: "ok", version: "0.2.0" }), { status: 200 });
    }) as typeof fetch;
    const health = await registry.health(remote.id);
    expect(health.status).toBe("healthy");
    expect(authorization).toBe("Bearer secret-value");

    const reloaded = new BackendRegistry(root);
    expect((await reloaded.get(remote.id)).name).toBe("Remote team engine");
  });

  it("never allows removing or disabling the local backend", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-backends-"));
    const registry = new BackendRegistry(root);
    await expect(registry.remove("local")).rejects.toThrow("cannot be removed");
    await expect(registry.setEnabled("local", false)).rejects.toThrow("cannot be disabled");
  });
});
