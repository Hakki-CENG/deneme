import { afterEach, describe, expect, it, vi } from "vitest";
import { OpaPolicyEngine, LayeredPolicyEngine } from "../src/policy/opa-policy-engine.js";
import { DefaultPolicyEngine } from "../src/policy/policy-engine.js";
import type { PolicyInput } from "../src/policy/policy-engine.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const input: PolicyInput = {
  descriptor: {
    id: "channel.send", version: "1", description: "send", risk: "external_side_effect",
    sideEffect: true, inputSchema: { type: "object" }, source: "core",
  },
  arguments: { destination: "ops", token: "must-not-leak", message: "x" },
  context: {
    tenantId: "tenant", sessionId: "session", familyId: "family", turnId: "turn", toolCallId: "tool",
    source: "api", workspacePath: "/tmp", idempotencyKey: "id",
  },
};

describe("OPA policy layer", () => {
  it("accepts typed OPA decisions and redacts secret-like arguments", async () => {
    let body = "";
    globalThis.fetch = vi.fn(async (_url, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ result: {
        decision: "require_approval", reasonCode: "org_external_send", message: "review", approvalScope: "once",
      } }), { status: 200 });
    }) as typeof fetch;
    const opa = new OpaPolicyEngine({ endpoint: "https://opa.example.test/v1/data/haf/decision" });
    expect(await opa.decide(input)).toMatchObject({ decision: "require_approval", reasonCode: "org_external_send" });
    expect(body).toContain("<redacted>");
    expect(body).not.toContain("must-not-leak");
  });

  it("fails closed on unavailable or invalid OPA responses", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("offline details"); }) as typeof fetch;
    const opa = new OpaPolicyEngine({ endpoint: "https://opa.example.test/v1/data/haf/decision" });
    expect(await opa.decide(input)).toMatchObject({ decision: "deny", reasonCode: "opa_unavailable" });
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ result: { hello: "world" } }), { status: 200 })) as typeof fetch;
    expect(await opa.decide(input)).toMatchObject({ decision: "deny", reasonCode: "opa_invalid_result" });
  });

  it("preserves the strongest decision across local and organization layers", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ result: { decision: "allow" } }), { status: 200 })) as typeof fetch;
    const layered = new LayeredPolicyEngine([
      new DefaultPolicyEngine(),
      new OpaPolicyEngine({ endpoint: "https://opa.example.test/v1/data/haf/decision" }),
    ]);
    const decision = await layered.decide(input);
    expect(decision.decision).toBe("require_approval");
  });
});
