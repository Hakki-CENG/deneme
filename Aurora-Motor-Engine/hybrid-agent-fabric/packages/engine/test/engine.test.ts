import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import type { CapabilityContext, CommandEnvelope } from "../src/types.js";

const engines: HybridAgentEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.shutdown()));
});

async function makeEngine(options: { approve?: boolean; process?: boolean } = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "haf-engine-"));
  const engine = new HybridAgentEngine({
    homePath,
    kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local",
    autoApproveWorkspaceWrites: options.approve ?? true,
    allowProcessExecution: options.process ?? true,
    model: { provider: "mock" },
  });
  engines.push(engine);
  return { engine, homePath };
}

function prompt(sessionId: string, text: string, commandId = randomUUID()): CommandEnvelope {
  return {
    protocolVersion: 1,
    commandId,
    clientId: "test-client",
    tenantId: "local",
    sessionId,
    kind: "session.prompt",
    source: "api",
    issuedAt: new Date().toISOString(),
    payload: { text },
  };
}

function context(session: { sessionId: string; familyId: string; workspacePath: string }): CapabilityContext {
  return {
    tenantId: "local",
    sessionId: session.sessionId,
    familyId: session.familyId,
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    source: "api",
    workspacePath: session.workspacePath,
    idempotencyKey: randomUUID(),
  };
}

describe("hybrid engine", () => {
  it("runs a prompt, persists events and deduplicates the command", async () => {
    const { engine } = await makeEngine();
    const session = await engine.createSession({ tenantId: "local", name: "test" });
    const command = prompt(session.sessionId, "hello", "same-command");
    const first = await engine.command(command);
    const second = await engine.command(command);
    expect(first.status).toBe("completed");
    expect(second).toEqual(first);
    expect((await engine.session(session.sessionId)).messages).toHaveLength(2);
    expect((await engine.readEvents(session.sessionId)).some((event) => event.type === "model.request.finished")).toBe(true);
  });

  it("executes a governed filesystem tool through the model loop", async () => {
    const { engine } = await makeEngine();
    const session = await engine.createSession({ tenantId: "local" });
    const result = await engine.command(prompt(session.sessionId, '[tool filesystem.write {"path":"hello.txt","content":"hello HAF"}]'));
    expect(result.status).toBe("completed");
    expect(await readFile(join(session.workspacePath, "hello.txt"), "utf8")).toBe("hello HAF");
    const events = await engine.readEvents(session.sessionId);
    expect(events.some((event) => event.type === "capability.policy")).toBe(true);
    expect(events.some((event) => event.type === "capability.finished")).toBe(true);
  });

  it("keeps Python variables across calls and routes host capabilities through the broker", async () => {
    const { engine } = await makeEngine();
    const session = await engine.createSession({ tenantId: "local" });
    const ctx = context(session);
    const first = await engine.capabilities.execute("python.execute", { code: "x = 40\nx + 2" }, ctx) as any;
    expect(first.result).toBe("42");
    const second = await engine.capabilities.execute(
      "python.execute",
      { code: 'haf.call("filesystem.write", {"path": "from-python.txt", "content": str(x)})' },
      { ...ctx, toolCallId: randomUUID(), idempotencyKey: randomUUID() },
    ) as any;
    expect(second.result).toContain("writtenChars");
    expect(await readFile(join(session.workspacePath, "from-python.txt"), "utf8")).toBe("40");
  });

  it("requires and resolves approval without blocking the control plane", async () => {
    const { engine } = await makeEngine({ approve: false, process: false });
    const session = await engine.createSession({ tenantId: "local" });
    const execution = engine.capabilities.execute("process.exec", { command: "printf approved" }, context(session));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    const pending = engine.approvals.list(session.sessionId);
    expect(pending).toHaveLength(1);
    engine.approvals.resolve(pending[0]!.id, "approve_once");
    const result = await execution as any;
    expect(result.stdout).toBe("approved");
  });

  it("stores image references in the transcript and projects workspace context to multimodal providers", async () => {
    const { engine } = await makeEngine();
    let captured: any;
    engine.models.register({
      id: "vision-test",
      async *stream(request) { captured = request; yield { type: "text_delta", delta: "seen" }; yield { type: "done", stopReason: "end_turn" }; },
    });
    const session = await engine.createSession({ tenantId: "local" });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    await writeFile(join(session.workspacePath, "pixel.png"), png);
    await engine.command({ ...prompt(session.sessionId, "select"), kind: "model.select", payload: { model: "vision-test:model" } });
    const result = await engine.command({ ...prompt(session.sessionId, "describe"), payload: { text: "describe", attachments: [{ path: "pixel.png", mimeType: "image/png" }] } });
    expect(result.status).toBe("completed");
    expect(captured.workspacePath).toBe(session.workspacePath);
    expect(captured.messages.at(-1).content).toContainEqual(expect.objectContaining({ type: "image", path: "pixel.png", mimeType: "image/png" }));
    expect((await engine.session(session.sessionId)).messages.some((message) => message.content.some((part) => part.type === "image"))).toBe(true);
  });

  it("spawns a child from inside the model tool loop without re-entering the parent mutex", async () => {
    const { engine } = await makeEngine();
    const parent = await engine.createSession({ tenantId: "local", name: "tool-parent" });
    const result = await engine.command(prompt(parent.sessionId, '[tool agent.spawn {"task":"review this","name":"tool-child"}]'));
    expect(result.status).toBe("completed");
    const refreshed = await engine.session(parent.sessionId);
    expect(refreshed.childSessionIds).toHaveLength(1);
    const child = await engine.session(refreshed.childSessionIds[0]!);
    expect(child.name).toBe("tool-child");
  });

  it("admits an isolated child and links it to the parent", async () => {
    const { engine } = await makeEngine();
    const parent = await engine.createSession({ tenantId: "local", name: "parent" });
    const child = await engine.supervisor.spawnChild({ parentSessionId: parent.sessionId, name: "reviewer", task: "review this" });
    const refreshed = await engine.session(parent.sessionId);
    expect(child.parentSessionId).toBe(parent.sessionId);
    expect(child.familyId).toBe(parent.familyId);
    expect(refreshed.childSessionIds).toContain(child.sessionId);
  });
});
