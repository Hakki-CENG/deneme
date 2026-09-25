/**
 * A7: security screening is fail-closed, and says so in a way that survives.
 *
 * Two things were true and one was not:
 *
 * - `HookBus.invokeGuard` already fails closed — a guard that throws or times
 *   out produces a `deny`. That was correct but untested, so nothing held it.
 * - The broker stopped the capability. Also correct.
 * - But every refusal was a **plain `Error`**, so the only thing distinguishing
 *   "you are not allowed" from "it broke" was prose. The failure taxonomy
 *   classifies by pattern, and its `security_block` rules did not match the
 *   guard's own wording — so a security refusal was classified as unknown and
 *   the loop was free to choose a recovery for it.
 *
 * These tests pin the behaviour and the classification together: a refusal must
 * both stop the work and be recognised as a security block.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CapabilityBroker, CapabilityDeniedError } from "../src/capabilities/capability-broker.js";
import { classifyFailure } from "../src/execution/failure-taxonomy.js";
import { HookBus } from "../src/plugins/hook-bus.js";
import { ApprovalService } from "../src/policy/approval-service.js";
import type { PolicyEngine } from "../src/policy/policy-engine.js";
import type { Capability, CapabilityContext, JsonValue, PolicyDecision } from "../src/types.js";

const allowAll: PolicyEngine = {
  async decide(): Promise<PolicyDecision> {
    return { decision: "allow", reasonCode: "allowed", message: "Permitted." };
  },
};

const denyAll: PolicyEngine = {
  async decide(): Promise<PolicyDecision> {
    return { decision: "deny", reasonCode: "capability_denied", message: "This capability is on the deny list." };
  },
};

function capability(runs: () => void): Capability {
  return {
    descriptor: {
      id: "demo.write",
      version: "1.0.0",
      description: "test capability",
      risk: "workspace_write",
      sideEffect: true,
      inputSchema: { type: "object" },
      source: "core",
    },
    validate: (input) => (input ?? {}) as Record<string, JsonValue>,
    execute: async () => {
      runs();
      return { ok: true };
    },
  };
}

const context: CapabilityContext = {
  tenantId: "tenant",
  sessionId: randomUUID(),
  familyId: randomUUID(),
  turnId: randomUUID(),
  toolCallId: randomUUID(),
  source: "api",
  workspacePath: "/tmp/workspace",
  idempotencyKey: "test-key",
};

const effects = {
  async execute(_key: string, operation: () => Promise<JsonValue>): Promise<JsonValue> {
    return await operation();
  },
};

async function thrown(promise: Promise<unknown>): Promise<Error | undefined> {
  return await promise.then(
    () => undefined,
    (caught: unknown) => caught as Error,
  );
}

describe("a guard that cannot answer does not let the capability through", () => {
  it("denies when the guard throws, and the capability never runs", async () => {
    const hooks = new HookBus();
    hooks.register({
      pluginId: "broken.guard",
      hook: "pre_capability",
      kind: "guard",
      callback: async () => {
        throw new Error("the guard itself is broken");
      },
    });

    let executed = false;
    const broker = new CapabilityBroker(allowAll, new ApprovalService(), effects, hooks);
    broker.register(capability(() => {
      executed = true;
    }));

    const error = await thrown(broker.execute("demo.write", {}, context));

    expect(executed).toBe(false);
    expect(error).toBeInstanceOf(CapabilityDeniedError);
    expect((error as CapabilityDeniedError).source).toBe("security-guard");
    // Fail-closed has to be visible as a security block, not as a mystery.
    expect(classifyFailure(error!.message).kind).toBe("security_block");
  });

  it("denies when the guard hangs past its timeout", async () => {
    const hooks = new HookBus();
    hooks.register({
      pluginId: "slow.guard",
      hook: "pre_capability",
      kind: "guard",
      timeoutMs: 20,
      callback: () => new Promise(() => undefined),
    });

    let executed = false;
    const broker = new CapabilityBroker(allowAll, new ApprovalService(), effects, hooks);
    broker.register(capability(() => {
      executed = true;
    }));

    const error = await thrown(broker.execute("demo.write", {}, context));

    expect(executed).toBe(false);
    expect(error).toBeInstanceOf(CapabilityDeniedError);
    expect(error!.message).toMatch(/timed out/i);
    expect(classifyFailure(error!.message).kind).toBe("security_block");
  }, 30_000);

  it("lets the capability run when the guard is healthy and allows it", async () => {
    const hooks = new HookBus();
    hooks.register({
      pluginId: "fine.guard",
      hook: "pre_capability",
      kind: "guard",
      callback: async () => ({ decision: "allow" as const }),
    });

    let executed = false;
    const broker = new CapabilityBroker(allowAll, new ApprovalService(), effects, hooks);
    broker.register(capability(() => {
      executed = true;
    }));

    const result = await broker.execute("demo.write", {}, context);
    expect(executed).toBe(true);
    expect(result).toEqual({ ok: true });
  });
});

describe("every refusal is typed and classifies as a security block", () => {
  it("an explicit guard denial", async () => {
    const hooks = new HookBus();
    hooks.register({
      pluginId: "aurora.security",
      hook: "pre_capability",
      kind: "guard",
      callback: async () => ({ decision: "deny" as const, reason: "Prompt injection detected in arguments." }),
    });

    const broker = new CapabilityBroker(allowAll, new ApprovalService(), effects, hooks);
    broker.register(capability(() => undefined));

    const error = await thrown(broker.execute("demo.write", {}, context));
    expect(error).toBeInstanceOf(CapabilityDeniedError);
    expect((error as CapabilityDeniedError).source).toBe("security-guard");
    expect((error as CapabilityDeniedError).capabilityId).toBe("demo.write");
    expect(error!.message).toContain("Prompt injection detected in arguments.");
    expect(classifyFailure(error!.message).kind).toBe("security_block");
  });

  it("a policy denial", async () => {
    const broker = new CapabilityBroker(denyAll, new ApprovalService(), effects, new HookBus());
    broker.register(capability(() => undefined));

    const error = await thrown(broker.execute("demo.write", {}, context));
    expect(error).toBeInstanceOf(CapabilityDeniedError);
    expect((error as CapabilityDeniedError).source).toBe("policy");
    expect((error as CapabilityDeniedError).details?.reasonCode).toBe("capability_denied");
    expect(classifyFailure(error!.message).kind).toBe("security_block");
  });

  it("an approval that was refused or expired", async () => {
    const approvals = new ApprovalService(50);
    approvals.bindReviewer({
      async review() {
        return { approved: false, reason: "no" };
      },
    });
    const requireApproval: PolicyEngine = {
      async decide(): Promise<PolicyDecision> {
        return { decision: "require_approval", reasonCode: "needs_approval", message: "Ask a human." };
      },
    };

    const broker = new CapabilityBroker(requireApproval, approvals, effects, new HookBus());
    broker.register(capability(() => undefined));

    const error = await thrown(broker.execute("demo.write", {}, context));
    expect(error).toBeInstanceOf(CapabilityDeniedError);
    expect((error as CapabilityDeniedError).source).toBe("approval");
    // Not a security_block: this is a missing permission, and the taxonomy has
    // a category for exactly that.
    expect(classifyFailure(error!.message).kind).toBe("permission_gap");
  }, 30_000);
});
