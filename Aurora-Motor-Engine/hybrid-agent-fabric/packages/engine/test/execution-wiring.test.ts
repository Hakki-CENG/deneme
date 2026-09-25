/**
 * Wiring the cognitive pipelines to the real execution path.
 *
 * The 51-phase plan's core claim: the runtime is built, but the pieces are not
 * connected through an actual task. These tests cover the three connections
 * made here — automatic verification, learning, and honest session settlement.
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAgentViaSession } from "../src/execution/session-agent-adapter.js";
import { TaskContext } from "../src/execution/task-context.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "haf-wiring-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function context(): TaskContext {
  return new TaskContext({ tenantId: "t", goal: "do the thing", workspace });
}

/** A session engine whose status and events the test controls. */
function engineWith(status: string, events: Array<{ kind: string }>) {
  return {
    createSession: vi.fn(async () => ({ sessionId: "s1", status: "idle" })),
    command: vi.fn(async () => ({ ok: true })),
    session: vi.fn(async () => ({ status })),
    readEvents: vi.fn(async () => events),
  };
}

describe("a stopped agent is not a finished agent", () => {
  it("does not report a paused session as completed", async () => {
    const engine = engineWith("paused", [{ kind: "session.tool.called" }]);

    const result = await runAgentViaSession(engine as never, context(), { pollIntervalMs: 1 });

    expect(result.completed).toBe(false);
    expect(result.error).toContain("paused");
    expect(result.summary).toContain("stopped, not finished");
  });

  it("still reports a failed session as not completed", async () => {
    const engine = engineWith("failed", [{ kind: "session.tool.called" }]);

    const result = await runAgentViaSession(engine as never, context(), { pollIntervalMs: 1 });
    expect(result.completed).toBe(false);
  });

  it("reports waiting_approval as blocked, not done", async () => {
    const engine = engineWith("waiting_approval", [{ kind: "session.tool.called" }]);

    const result = await runAgentViaSession(engine as never, context(), { pollIntervalMs: 1 });
    expect(result.completed).toBe(false);
    expect(result.error).toContain("approval");
  });
});

describe("settling quietly is not evidence of work", () => {
  it("refuses to call an idle session with no agent activity completed", async () => {
    // A session created and immediately idle settles exactly like one that
    // worked for ten minutes. Only events tell them apart.
    const engine = engineWith("idle", [{ kind: "session.created" }]);

    const result = await runAgentViaSession(engine as never, context(), { pollIntervalMs: 1 });

    expect(result.completed).toBe(false);
    expect(result.error).toContain("no execution evidence");
  });

  it("accepts an idle session that shows a tool call", async () => {
    const engine = engineWith("idle", [
      { kind: "session.created" },
      { kind: "session.tool.called" },
    ]);

    const result = await runAgentViaSession(engine as never, context(), { pollIntervalMs: 1 });
    expect(result.completed).toBe(true);
  });

  it("accepts an idle session that produced an assistant message", async () => {
    const engine = engineWith("idle", [
      { kind: "session.created" },
      { kind: "session.message.assistant" },
    ]);

    const result = await runAgentViaSession(engine as never, context(), { pollIntervalMs: 1 });
    expect(result.completed).toBe(true);
  });
});

describe("verifiers are derived from the workspace", () => {
  it("detects a Node project's own test command", async () => {
    const { VerificationService } = await import("../src/harness/verification-service.js");
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ name: "x", scripts: { build: "tsc", test: "vitest run" } }),
    );

    const service = new VerificationService(workspace, (async () => ({
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      close: async () => undefined,
    })) as never);

    const recipe = await service.detect(workspace);

    expect(recipe.kind).toBe("node");
    expect(recipe.test.join(" ")).toContain("test");
    expect(recipe.build.join(" ")).toContain("build");
  });

  it("detects a Python project", async () => {
    const { VerificationService } = await import("../src/harness/verification-service.js");
    await writeFile(join(workspace, "pyproject.toml"), "[project]\nname='x'\n");

    const service = new VerificationService(workspace, (async () => ({
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      close: async () => undefined,
    })) as never);

    const recipe = await service.detect(workspace);
    expect(recipe.kind).toBe("python");
    expect(recipe.test.join(" ")).toContain("pytest");
  });

  it("produces no runnable commands for an empty workspace", async () => {
    const { VerificationService } = await import("../src/harness/verification-service.js");
    await mkdir(join(workspace, "empty"), { recursive: true });

    const service = new VerificationService(workspace, (async () => ({
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      close: async () => undefined,
    })) as never);

    const recipe = await service.detect(join(workspace, "empty"));

    // No toolchain means no verifier, which means the loop reports
    // `unverified` — absent evidence, not assumed success.
    expect(recipe.kind).toBe("unknown");
    expect(recipe.test).toHaveLength(0);
    expect(recipe.build).toHaveLength(0);
  });
});
