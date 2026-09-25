import { describe, expect, it } from "vitest";
import { HeadlessRpcServer } from "../src/rpc.js";

function fakeClient() {
  return {
    async health() { return { status: "ok" }; },
    async listSessions() { return [{ sessionId: "s1" }]; },
    async createSession(input: any) { return { sessionId: "s2", ...input }; },
    async getSession(sessionId: string) { return { sessionId }; },
    async prompt(sessionId: string, text: string) { return { status: "completed", sessionId, text }; },
    async command(sessionId: string, kind: string, payload: unknown) { return { status: "completed", sessionId, kind, payload }; },
    async events() { return [{ sequence: 1, type: "event" }]; },
    async approvals() { return [{ id: "approval" }]; },
    async resolveApproval(_id: string, resolution: string) { return { resolution }; },
    async subscribe(_sessionId: string, options: any) {
      await options.onEvent({ sequence: 2, type: "model.text.delta", payload: { delta: "hi" } });
      await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
}

describe("headless JSON-RPC bridge", () => {
  it("maps session/approval operations and emits reconnectable event notifications", async () => {
    const output: any[] = [];
    const server = new HeadlessRpcServer(fakeClient() as any, (value) => output.push(value));
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "sessions.create", params: { name: "rpc" } }));
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "sessions.prompt", params: { sessionId: "s2", text: "hello" } }));
    const subscription = await server.handle({ jsonrpc: "2.0", id: 4, method: "sessions.subscribe", params: { sessionId: "s2", afterSequence: 1 } });
    const subscriptionId = (subscription?.result as any).subscriptionId;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(output).toContainEqual(expect.objectContaining({ jsonrpc: "2.0", id: 1, result: expect.objectContaining({ protocolVersion: 1 }) }));
    expect(output).toContainEqual(expect.objectContaining({ id: 2, result: expect.objectContaining({ sessionId: "s2", name: "rpc" }) }));
    expect(output).toContainEqual(expect.objectContaining({ id: 3, result: expect.objectContaining({ status: "completed", text: "hello" }) }));
    expect(output).toContainEqual(expect.objectContaining({ method: "sessions.event", params: expect.objectContaining({ subscriptionId, sessionId: "s2" }) }));
    expect(await server.handle({ jsonrpc: "2.0", id: 5, method: "sessions.unsubscribe", params: { subscriptionId } })).toMatchObject({ result: { removed: true } });
    await server.shutdown();
  });

  it("returns standard errors for malformed input, unknown methods and invalid params", async () => {
    const output: any[] = [];
    const server = new HeadlessRpcServer(fakeClient() as any, (value) => output.push(value));
    await server.handleLine("not json");
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "missing" }));
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "sessions.get", params: [] }));
    expect(output[0]).toMatchObject({ error: { code: -32700 } });
    expect(output[1]).toMatchObject({ id: 1, error: { code: -32601 } });
    expect(output[2]).toMatchObject({ id: 2, error: { code: -32602 } });
  });
});
