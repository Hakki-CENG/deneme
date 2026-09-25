import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesystemCapabilities } from "../src/capabilities/filesystem.js";
import { CapabilityBroker } from "../src/capabilities/capability-broker.js";
import { DefaultPolicyEngine } from "../src/policy/policy-engine.js";
import { ApprovalService } from "../src/policy/approval-service.js";
import { EffectJournal } from "../src/persistence/effect-journal.js";
import { defineCapability } from "../src/capabilities/schema.js";
import { z } from "zod";

const context = (workspacePath: string, source: "api" | "webhook" = "api") => ({
  tenantId: "tenant", sessionId: "session", familyId: "family", turnId: "turn",
  toolCallId: "tool", source, workspacePath, idempotencyKey: "effect",
});

describe("adversarial capability boundaries", () => {
  it("blocks symlink reads escaping the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-adversarial-"));
    const outside = await mkdtemp(join(tmpdir(), "haf-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "escape"));
    const read = filesystemCapabilities().find((item) => item.descriptor.id === "filesystem.read")!;
    await expect(read.execute({ path: "escape/secret.txt" }, context(root))).rejects.toThrow("Symlink escapes");
  });

  it("denies mutating capabilities from untrusted webhook sources before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-adversarial-"));
    let executed = false;
    const broker = new CapabilityBroker(new DefaultPolicyEngine({ autoApproveWorkspaceWrites: true }), new ApprovalService(), new EffectJournal(root));
    broker.register(defineCapability(
      { id: "danger.write", version: "1", description: "danger", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({}),
      async () => { executed = true; return { ok: true }; },
    ));
    await expect(broker.execute("danger.write", {}, context(root, "webhook"))).rejects.toThrow("blocked by policy");
    expect(executed).toBe(false);
  });
});
