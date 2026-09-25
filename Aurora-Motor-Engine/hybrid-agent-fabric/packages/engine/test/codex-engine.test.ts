import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import type { CommandEnvelope } from "../src/types.js";

const engines: HybridAgentEngine[] = [];
afterEach(async () => { await Promise.all(engines.splice(0).map((engine) => engine.shutdown())); vi.unstubAllGlobals(); });
function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("Codex subscription engine route", () => {
  it("authenticates, selects tenant credentials and runs through the native SSE route", async () => {
    const requests: Array<{ url: string; authorization: string; body: string }> = [];
    const access = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "account-id" } });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? "", body: String(init?.body ?? "") });
      if (url.endsWith("/api/accounts/deviceauth/usercode")) return Response.json({ user_code: "CODE", device_auth_id: "device", interval: 3 });
      if (url.endsWith("/api/accounts/deviceauth/token")) return Response.json({ authorization_code: "code", code_verifier: "verifier" });
      if (url.endsWith("/oauth/token")) return Response.json({ access_token: access, refresh_token: "refresh" });
      if (url.endsWith("/backend-api/codex/responses")) {
        const payload = [
          { type: "response.output_text.delta", delta: "codex response" },
          { type: "response.completed", response: { status: "completed", usage: { input_tokens: 4, output_tokens: 2 } } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
        return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(null, { status: 404 });
    });
    const root = await mkdtemp(join(tmpdir(), "haf-codex-engine-"));
    const engine = new HybridAgentEngine({
      homePath: root,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      masterKey: "stable-key",
      model: { provider: "codex-subscription", modelName: "account-model" },
    });
    engines.push(engine);
    const flow = await engine.codexAuth.startDeviceFlow("tenant");
    await engine.codexAuth.pollDeviceFlow("tenant", flow.flowId);
    const session = await engine.createSession({ tenantId: "tenant" });
    const command: CommandEnvelope = {
      protocolVersion: 1,
      commandId: randomUUID(), clientId: "test", tenantId: "tenant", sessionId: session.sessionId,
      kind: "session.prompt", source: "api", issuedAt: new Date().toISOString(), payload: { text: "hello" },
    };
    const result = await engine.command(command);
    expect(result.status).toBe("completed");
    expect(JSON.stringify((await engine.session(session.sessionId)).messages)).toContain("codex response");
    const modelRequest = requests.find((item) => item.url.endsWith("/backend-api/codex/responses"))!;
    expect(modelRequest.authorization).toBe(`Bearer ${access}`);
    expect(modelRequest.body).not.toContain(access);
    expect(JSON.parse(modelRequest.body).model).toBe("account-model");
    expect((await engine.codexAuth.status("tenant")).authenticated).toBe(true);
  });
});
