import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SshSandbox, createSandboxFactory } from "../src/sandbox/sandbox.js";
import { KernelManager } from "../src/kernel/kernel-manager.js";
import { CapabilityBroker } from "../src/capabilities/capability-broker.js";
import { DefaultPolicyEngine } from "../src/policy/policy-engine.js";
import { ApprovalService } from "../src/policy/approval-service.js";
import { EffectJournal } from "../src/persistence/effect-journal.js";

describe("SSH sandbox boundary", () => {
  it("validates host, user, port and remote root before invoking ssh", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-ssh-"));
    expect(() => new SshSandbox(workspace, { host: "host;rm -rf /" })).toThrow("host is invalid");
    expect(() => new SshSandbox(workspace, { host: "example.com", user: "bad user" })).toThrow("user is invalid");
    expect(() => new SshSandbox(workspace, { host: "example.com", port: 70000 })).toThrow("port is invalid");
    expect(() => new SshSandbox(workspace, { host: "example.com", remoteRoot: "/tmp/../root" })).toThrow("safe absolute path");
    const sandbox = await createSandboxFactory("ssh", { ssh: { host: "example.com", syncFiles: false } })(workspace);
    expect(sandbox.kind).toBe("ssh");
  });

  it("disables the local Python kernel for SSH sessions instead of bypassing the remote boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-ssh-kernel-"));
    const workspace = join(root, "workspace");
    const broker = new CapabilityBroker(new DefaultPolicyEngine(), new ApprovalService(), new EffectJournal(root));
    const manager = new KernelManager("/missing/kernel.py", root, broker, { kind: "disabled" });
    await expect(manager.execute("1+1", {
      tenantId: "tenant",
      sessionId: "session",
      familyId: "family",
      turnId: "turn",
      toolCallId: "tool",
      source: "api",
      workspacePath: workspace,
      idempotencyKey: "id",
    })).rejects.toThrow("disabled");
  });
});
