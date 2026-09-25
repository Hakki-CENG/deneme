import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { transcriptAsJson, transcriptAsMarkdown, transcriptAsTrajectory } from "../src/runtime/transcript-export.js";
import type { CommandEnvelope, JsonValue } from "../src/types.js";

const engines: HybridAgentEngine[] = [];
afterEach(async () => await Promise.all(engines.splice(0).map((engine) => engine.shutdown())));

async function engineAndSession() {
  const engine = new HybridAgentEngine({
    homePath: await mkdtemp(join(tmpdir(), "haf-tasks-")),
    kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local",
    model: { provider: "mock" },
  });
  engines.push(engine);
  const session = await engine.createSession({ tenantId: "local", name: "Task / Export" });
  return { engine, session };
}

function command(sessionId: string, kind: CommandEnvelope["kind"], payload: JsonValue): CommandEnvelope {
  return {
    protocolVersion: 1,
    commandId: randomUUID(),
    clientId: "task-test",
    tenantId: "local",
    sessionId,
    kind,
    source: "api",
    issuedAt: new Date().toISOString(),
    payload,
  };
}

describe("durable task board and transcript export", () => {
  it("enforces dependencies, auto-unblocks work and rejects dependency cycles", async () => {
    const { engine, session } = await engineAndSession();
    const first = await engine.command(command(session.sessionId, "task.create", { title: "Build", priority: "high", status: "ready" }));
    const firstId = (first.result as any).task.id as string;
    const second = await engine.command(command(session.sessionId, "task.create", {
      title: "Review",
      status: "in_progress",
      dependsOn: [firstId],
    }));
    const secondId = (second.result as any).task.id as string;
    expect((second.result as any).task.status).toBe("blocked");

    const third = await engine.command(command(session.sessionId, "task.create", {
      title: "Release",
      dependsOn: [secondId],
    }));
    const thirdId = (third.result as any).task.id as string;
    const cycle = await engine.command(command(session.sessionId, "task.update", { id: firstId, dependsOn: [thirdId] }));
    expect(cycle.status).toBe("rejected");
    expect(cycle.error?.message).toContain("cycle");

    const finished = await engine.command(command(session.sessionId, "task.update", { id: firstId, status: "done" }));
    expect((finished.result as any).unblockedTaskIds).toContain(secondId);
    const state = await engine.session(session.sessionId);
    expect(state.tasks?.find((task) => task.id === secondId)?.status).toBe("ready");
    expect(state.tasks?.find((task) => task.id === firstId)?.dependsOn).toEqual([]);

    const events = await engine.readEvents(session.sessionId);
    expect(events.some((event) => event.type === "task.create")).toBe(true);
    expect(events.some((event) => event.type === "task.update")).toBe(true);
  });

  it("exports a versioned JSON record and readable Markdown without workspace paths", async () => {
    const { engine, session } = await engineAndSession();
    await engine.command(command(session.sessionId, "session.prompt", { text: "hello export" }));
    await engine.command(command(session.sessionId, "task.create", { title: "Ship it", status: "ready" }));
    const state = await engine.session(session.sessionId);
    const json = transcriptAsJson(state, "2026-08-18T12:00:00.000Z");
    const markdown = transcriptAsMarkdown(state, "2026-08-18T12:00:00.000Z");
    const trajectory = transcriptAsTrajectory(state);
    expect(json.schemaVersion).toBe(1);
    expect(json.messages.length).toBeGreaterThanOrEqual(2);
    expect(json.tasks[0]?.title).toBe("Ship it");
    expect(JSON.stringify(json)).not.toContain(state.workspacePath);
    expect(markdown).toContain("# Task / Export");
    expect(markdown).toContain("hello export");
    expect(markdown).toContain("## Task board");
    expect(trajectory.schemaVersion).toBe("haf.trajectory.v1");
    expect(trajectory.conversations.some((message) => message.from === "human" && message.value === "hello export")).toBe(true);
    expect(JSON.stringify(trajectory)).not.toContain(state.workspacePath);
    expect(JSON.stringify(trajectory.conversations)).not.toContain('"from":"system"');
  });
});
