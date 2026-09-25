import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

describe("cross-session search", () => {
  it("returns tenant-scoped ranked bounded snippets", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-search-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
    });
    const alpha = await engine.createSession({ tenantId: "tenant-a", name: "auth migration" });
    await engine.command({
      protocolVersion: 1,
      commandId: randomUUID(),
      clientId: "search-test",
      tenantId: "tenant-a",
      sessionId: alpha.sessionId,
      kind: "session.prompt",
      source: "api",
      issuedAt: new Date().toISOString(),
      payload: { text: "rotate authentication tokens safely" },
    });
    const hidden = await engine.createSession({ tenantId: "tenant-b", name: "secret auth" });
    await engine.command({
      protocolVersion: 1,
      commandId: randomUUID(),
      clientId: "search-test",
      tenantId: "tenant-b",
      sessionId: hidden.sessionId,
      kind: "session.prompt",
      source: "api",
      issuedAt: new Date().toISOString(),
      payload: { text: "authentication should never cross tenants" },
    });
    const hits = await engine.sessionSearch.search("tenant-a", "authentication tokens");
    expect(hits[0]?.sessionId).toBe(alpha.sessionId);
    expect(hits.some((hit) => hit.sessionId === hidden.sessionId)).toBe(false);
    expect(hits[0]?.snippets[0]?.text).toContain("authentication tokens");
    await engine.shutdown();
  });
});
