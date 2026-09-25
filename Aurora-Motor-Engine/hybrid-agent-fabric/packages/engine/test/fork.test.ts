import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

function prompt(sessionId: string, text: string) {
  return {
    protocolVersion: 1 as const,
    commandId: randomUUID(),
    clientId: "fork-test",
    tenantId: "local",
    sessionId,
    kind: "session.prompt" as const,
    source: "api" as const,
    issuedAt: new Date().toISOString(),
    payload: { text },
  };
}

describe("session forks", () => {
  it("forks at an exact message and can preserve an explicit abandoned-branch summary", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-fork-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
    });
    const source = await engine.createSession({ tenantId: "local", name: "source" });
    await engine.command(prompt(source.sessionId, "first"));
    await engine.command(prompt(source.sessionId, "second"));
    const sourceState = await engine.session(source.sessionId);
    const cut = sourceState.messages[1]!; // first assistant response
    const fork = await engine.supervisor.forkSession({
      sourceSessionId: source.sessionId,
      messageId: cut.id,
      name: "alternative",
      includeAbandonedBranchSummary: true,
    });
    expect(fork.forkedFrom).toEqual({ sessionId: source.sessionId, messageId: cut.id });
    expect(fork.familyId).toBe(fork.sessionId);
    expect(fork.messages.slice(0, 2)).toEqual(sourceState.messages.slice(0, 2));
    expect(fork.messages.at(-1)?.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(fork.messages.at(-1))).toContain("ABANDONED_BRANCH_SUMMARY");
    expect((await engine.readEvents(source.sessionId)).some((event) => event.type === "session.fork.created")).toBe(true);
    await engine.shutdown();
  });
});
