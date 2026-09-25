/**
 * Typed session failures.
 *
 * Each of these used to be a plain `Error` distinguished only by its wording,
 * which meant the HTTP layer either matched on prose or answered 500 for
 * conditions that are not server faults:
 *
 * - posting to a closed session — a 409 the caller can act on, not a crash;
 * - a fan-out cap — the system doing exactly what it was configured to do;
 * - a spend cap being reached — a 429 with the numbers behind the refusal.
 *
 * The assertions below check the fields, not the message text, because the
 * fields are what a caller can rely on across a rewording.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { SessionBudgetExceededError } from "../src/policy/session-budget.js";
import { SessionLimitError, SessionNotRunnableError } from "../src/runtime/session-errors.js";

async function engineWith(config: Record<string, unknown> = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "haf-typed-errors-"));
  return new HybridAgentEngine({
    homePath,
    kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local",
    model: { provider: "mock" },
    autoApproveWorkspaceWrites: true,
    allowProcessExecution: true,
    ...config,
  });
}

function prompt(tenantId: string, sessionId: string, text: string) {
  return {
    protocolVersion: 1 as const,
    commandId: randomUUID(),
    clientId: "test",
    tenantId,
    sessionId,
    kind: "session.prompt" as const,
    source: "api" as const,
    issuedAt: new Date().toISOString(),
    payload: { text },
  };
}

/** Resolve to the thrown error, or `undefined` if the call succeeded. */
async function thrown(promise: Promise<unknown>): Promise<Error | undefined> {
  return await promise.then(
    () => undefined,
    (caught: unknown) => caught as Error,
  );
}

describe("typed session errors", () => {
  it("reports a prompt to a closed session as a structured refusal, not a crash", async () => {
    const engine = await engineWith();
    const child = await engine.createSession({ tenantId: "tenant", name: "worker" });
    await engine.closeSession(child.sessionId);
    expect((await engine.supervisor.getSession(child.sessionId)).status).toBe("closed");

    // A command refusal is a result, not a throw -- so what matters is that the
    // result says *why*. Before this it said COMMAND_FAILED, the same code a
    // crashed turn reports, and the HTTP layer answered 200 either way.
    const result = await engine.command(prompt("tenant", child.sessionId, "Are you still there?"));
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("SESSION_NOT_RUNNABLE");
    expect(result.error?.sessionState).toBe("closed");
    expect(result.error?.retryable).toBe(false);
    await engine.shutdown();
  }, 90_000);

  it("reports a prompt to a paused session the same way, naming the paused state", async () => {
    const engine = await engineWith();
    const session = await engine.createSession({ tenantId: "tenant", name: "worker" });
    await engine.command({ ...prompt("tenant", session.sessionId, "hello"), kind: "session.pause" });

    const result = await engine.command(prompt("tenant", session.sessionId, "Are you still there?"));
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("SESSION_NOT_RUNNABLE");
    expect(result.error?.sessionState).toBe("paused");
    await engine.shutdown();
  }, 90_000);

  it("says an archived session cannot take a prompt, as the same typed refusal", async () => {
    const engine = await engineWith();
    const session = await engine.createSession({ tenantId: "tenant", name: "worker" });
    await engine.sessionLifecycle.archive({ tenantId: "tenant", sessionId: session.sessionId, reason: "Done." });

    const error = await thrown(engine.command(prompt("tenant", session.sessionId, "hello")));

    expect(error).toBeInstanceOf(SessionNotRunnableError);
    expect((error as SessionNotRunnableError).sessionStatus).toBe("archived");
    await engine.shutdown();
  }, 90_000);

  it("names which fan-out limit stopped a spawn, so the right one can be raised", async () => {
    const engine = await engineWith({ agentFanout: { maxConcurrentChildren: 2, maxDepth: 3 } });
    const parent = await engine.createSession({ tenantId: "tenant", name: "lead" });
    await engine.supervisor.spawnChild({ parentSessionId: parent.sessionId, task: "One." });
    await engine.supervisor.spawnChild({ parentSessionId: parent.sessionId, task: "Two." });

    const status = await engine.supervisor.fanoutStatus(parent.sessionId);
    expect(status.canSpawn).toBe(false);
    expect(status.limit).toBe("concurrency");

    const error = await thrown(engine.supervisor.spawnChild({ parentSessionId: parent.sessionId, task: "Three." }));

    expect(error).toBeInstanceOf(SessionLimitError);
    expect((error as SessionLimitError).limit).toBe("concurrency");
    expect((error as SessionLimitError).limits.maxConcurrentChildren).toBe(2);
    expect((error as SessionLimitError).sessionId).toBe(parent.sessionId);
    // The wording the existing preview test relies on is unchanged.
    expect(error!.message).toMatch(/concurrency limit of 2/i);
    await engine.shutdown();
  }, 90_000);

  it("reports the depth limit as a depth limit, not a concurrency one", async () => {
    const engine = await engineWith();
    const parent = await engine.createSession({ tenantId: "tenant", name: "lead" });
    const child = await engine.supervisor.spawnChild({ parentSessionId: parent.sessionId, task: "One." });
    const status = await engine.supervisor.fanoutStatus(child.sessionId);
    expect(status.limit).toBe("depth");
    expect(status.canSpawn).toBe(false);

    const error = await thrown(engine.supervisor.spawnChild({ parentSessionId: child.sessionId, task: "Nested." }));
    expect((error as SessionLimitError).limit).toBe("depth");
    expect((error as SessionLimitError).limits.maxDepth).toBe(1);
    await engine.shutdown();
  }, 90_000);

  it("refuses a new turn on an exhausted budget and carries the verdict", async () => {
    const engine = await engineWith();
    const session = await engine.createSession({ tenantId: "tenant", name: "spender" });
    // Spend something first: a cap on a session that has done nothing is not
    // exhausted, and pretending otherwise would test the wrong thing.
    await engine.command(prompt("tenant", session.sessionId, "Do a little work."));

    await engine.sessionBudgets.setSessionBudget({
      tenantId: "tenant",
      sessionId: session.sessionId,
      reason: "test cap",
      setBy: "test",
      maxTokens: 1,
      onExceeded: "block",
    });

    const error = await thrown(engine.command(prompt("tenant", session.sessionId, "One more turn.")));

    expect(error).toBeInstanceOf(SessionBudgetExceededError);
    const verdict = (error as SessionBudgetExceededError).verdict;
    expect(verdict.state).toBe("exhausted");
    expect(verdict.blocked).toBe(true);
    expect(verdict.sessionId).toBe(session.sessionId);
    expect(verdict.limits.maxTokens).toBe(1);
    expect(verdict.totalTokens).toBeGreaterThan(1);
    // The mock model has no price entry, so a money cap would be unenforceable;
    // a token cap is always measurable and this one held.
    expect(verdict.source).toBe("session");
    await engine.shutdown();
  }, 90_000);

  it("does not refuse a turn when the budget policy is warn-only", async () => {
    const engine = await engineWith();
    const session = await engine.createSession({ tenantId: "tenant", name: "warned" });
    await engine.command(prompt("tenant", session.sessionId, "Do a little work."));
    await engine.sessionBudgets.setSessionBudget({
      tenantId: "tenant",
      sessionId: session.sessionId,
      reason: "test warn",
      setBy: "test",
      maxTokens: 1,
      onExceeded: "warn",
    });

    const verdict = await engine.budgetVerdict("tenant", session.sessionId);
    expect(verdict.state).toBe("exhausted");
    expect(verdict.blocked).toBe(false);

    // And the turn is genuinely allowed, not merely unblocked in the verdict.
    const result = await engine.command(prompt("tenant", session.sessionId, "Keep going."));
    expect(result.status).toBe("completed");
    await engine.shutdown();
  }, 90_000);
});
