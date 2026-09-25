import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import type { CommandEnvelope } from "../src/types.js";

const engines: HybridAgentEngine[] = [];
afterEach(async () => Promise.all(engines.splice(0).map((engine) => engine.shutdown())));

async function setup() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-goal-"));
  const engine = new HybridAgentEngine({
    homePath,
    kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local",
    autoApproveWorkspaceWrites: true,
    allowProcessExecution: true,
    model: { provider: "mock" },
  });
  engines.push(engine);
  const session = await engine.createSession({ tenantId: "local" });
  return { engine, session };
}

function command(sessionId: string, kind: CommandEnvelope["kind"], payload: any): CommandEnvelope {
  return {
    protocolVersion: 1,
    commandId: randomUUID(),
    clientId: "goal-test",
    tenantId: "local",
    sessionId,
    kind,
    source: "api",
    issuedAt: new Date().toISOString(),
    payload,
  };
}

describe("persistent goals and autonomous continuation", () => {
  it("continues an active goal within a hard continuation budget", async () => {
    const { engine, session } = await setup();
    await engine.command(command(session.sessionId, "goal.set", {
      objective: "finish the bounded task",
      maxContinuations: 2,
      tokenBudget: 10000,
    }));
    const result = await engine.command(command(session.sessionId, "session.prompt", { text: "start" }));
    expect(result.status).toBe("completed");
    const state = await engine.session(session.sessionId);
    expect(state.goal?.continuationCount).toBe(2);
    expect(state.goal?.status).toBe("active");
    expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(3);
    expect((await engine.readEvents(session.sessionId)).some((event) => event.type === "continuation.limit_reached")).toBe(true);
  });

  it("allows the model to explicitly complete a goal through a governed capability", async () => {
    const { engine, session } = await setup();
    await engine.command(command(session.sessionId, "goal.set", { objective: "complete me", maxContinuations: 5 }));
    await engine.command(command(session.sessionId, "session.prompt", { text: "[tool goal.complete {}]" }));
    const state = await engine.session(session.sessionId);
    expect(state.goal?.status).toBe("completed");
    expect(state.goal?.continuationCount).toBe(0);
  });

  it("runs quality gates and stops immediately when they pass", async () => {
    const { engine, session } = await setup();
    await writeFile(join(session.workspacePath, "ok.txt"), "ok");
    await engine.command(command(session.sessionId, "autonomous.configure", {
      enabled: true,
      maxContinuations: 3,
      gates: ["test -f ok.txt"],
      gateMaxRetries: 2,
    }));
    await engine.command(command(session.sessionId, "session.prompt", { text: "verify" }));
    const state = await engine.session(session.sessionId);
    expect(state.autonomous?.continuationsUsed).toBe(0);
    const decisions = (await engine.readEvents(session.sessionId)).filter((event) => event.type === "continuation.evaluated");
    expect(decisions.at(-1)?.payload).toMatchObject({ reason: "gates_passed", continue: false });
  });
});
