import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { HybridAgentEngine } from "../src/engine.js";
import { SessionNotFoundError } from "../src/runtime/supervisor.js";

/**
 * A missing session has to be recognisable as a missing session.
 *
 * The supervisor used to throw a plain `Error` whose only distinguishing feature
 * was the wording of its message, so an HTTP layer had nothing to match on and
 * answered 500. `SESSION_NOT_FOUND` (HAF-3001, 404) sat in the control API's
 * error registry unused, which means the documented response was never the one a
 * client actually got.
 *
 * These tests pin the type, because a message can be reworded without anybody
 * thinking about the API contract attached to it.
 */
async function makeEngine(): Promise<HybridAgentEngine> {
  const engine = new HybridAgentEngine({
    homePath: mkdtempSync(join(tmpdir(), "session-error-")),
    kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local",
    model: { provider: "mock" },
  });
  await engine.initialize();
  return engine;
}

describe("session lookup failures are typed", () => {
  it("throws SessionNotFoundError for an id that was never created", async () => {
    const engine = await makeEngine();
    try {
      await expect(engine.session("no-such-session")).rejects.toBeInstanceOf(SessionNotFoundError);
    } finally {
      await engine.shutdown();
    }
  });

  it("carries the session id so a caller can report which one was missing", async () => {
    const engine = await makeEngine();
    try {
      const error = await engine.session("missing-42").then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SessionNotFoundError);
      expect((error as SessionNotFoundError).sessionId).toBe("missing-42");
      expect((error as SessionNotFoundError).message).toContain("missing-42");
    } finally {
      await engine.shutdown();
    }
  });

  it("still returns the snapshot for a session that does exist", async () => {
    // Guarding against the fix being too broad: a lookup that always threw would
    // also make every missing-session test pass.
    const engine = await makeEngine();
    try {
      const created = await engine.createSession({ tenantId: "local", name: "exists" });
      const snapshot = await engine.session(created.sessionId);
      expect(snapshot.sessionId).toBe(created.sessionId);
    } finally {
      await engine.shutdown();
    }
  });
});
