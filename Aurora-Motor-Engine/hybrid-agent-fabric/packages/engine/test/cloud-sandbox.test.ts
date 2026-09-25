import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudSandboxGateway } from "../src/sandbox/cloud-sandbox.js";
import { createSandboxFactory } from "../src/sandbox/sandbox.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("serverless sandbox gateway adapters", () => {
  it.each(["modal", "daytona", "vercel", "kubernetes"] as const)("provisions, executes and destroys a %s sandbox", async (provider) => {
    const workspace = await mkdtemp(join(tmpdir(), `haf-${provider}-`));
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (String(url).endsWith("/v1/sandboxes")) return new Response(JSON.stringify({ sandboxId: `${provider}-1`, status: "ready" }), { status: 200 });
      return new Response(JSON.stringify({ exitCode: 0, stdout: "ok", timedOut: false, truncated: false, durationMs: 4 }), { status: 200 });
    }) as typeof fetch;
    const sandbox = await createSandboxFactory(provider, { cloud: {
      provider, endpoint: "https://sandbox.example.test", bearerToken: "gateway-token",
      networkPolicy: "allowlist", allowedHosts: ["api.github.com"],
    } })(workspace);
    expect(await sandbox.exec({ command: "echo ok" })).toMatchObject({ exitCode: 0, stdout: "ok" });
    await sandbox.destroy();
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer gateway-token" });
    const provisionBody = JSON.parse(String(calls[0]!.init?.body));
    expect(provisionBody.provider).toBe(provider);
    expect(provisionBody.network).toEqual({ policy: "allowlist", allowedHosts: ["api.github.com"] });
    expect(calls.at(-1)?.init?.method).toBe("DELETE");
  });

  it("rejects invalid network and cwd configuration before remote execution", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-cloud-"));
    expect(() => new CloudSandboxGateway(workspace, {
      provider: "modal", endpoint: "https://sandbox.example.test", networkPolicy: "allowlist",
    })).toThrow("requires allowed hosts");
    const gateway = new CloudSandboxGateway(workspace, { provider: "modal", endpoint: "https://sandbox.example.test" });
    globalThis.fetch = vi.fn() as typeof fetch;
    await expect(gateway.exec({ command: "pwd", cwd: "../escape" })).rejects.toThrow("escapes");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
