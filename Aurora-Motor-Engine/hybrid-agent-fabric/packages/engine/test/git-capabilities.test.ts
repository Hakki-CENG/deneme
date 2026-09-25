import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

const execFileAsync = promisify(execFile);
const engines: HybridAgentEngine[] = [];
afterEach(async () => await Promise.all(engines.splice(0).map((engine) => engine.shutdown())));

describe("typed Git capabilities", () => {
  it("reads status, validates local branches and creates a no-hook local commit", async () => {
    const engine = new HybridAgentEngine({
      homePath: await mkdtemp(join(tmpdir(), "haf-git-")),
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      autoApproveWorkspaceWrites: true,
      model: { provider: "mock" },
    });
    engines.push(engine);
    const session = await engine.createSession({ tenantId: "local" });
    await execFileAsync("git", ["init", "-b", "main", session.workspacePath]);
    await writeFile(join(session.workspacePath, "README.md"), "initial\n");
    await execFileAsync("git", ["-C", session.workspacePath, "add", "README.md"]);
    await execFileAsync("git", ["-C", session.workspacePath, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
    const context = {
      tenantId: "local", sessionId: session.sessionId, familyId: session.familyId,
      turnId: randomUUID(), toolCallId: randomUUID(), source: "api" as const,
      workspacePath: session.workspacePath, idempotencyKey: randomUUID(),
    };
    const branches = await engine.capabilities.execute("git.branch.list", {}, context) as any;
    expect(branches.branches).toContainEqual({ current: true, name: "main" });
    await engine.capabilities.execute("git.branch.create", { name: "feature/safe" }, { ...context, toolCallId: randomUUID(), idempotencyKey: randomUUID() });
    await writeFile(join(session.workspacePath, "feature.txt"), "feature\n");
    const status = await engine.capabilities.execute("git.status", {}, { ...context, toolCallId: randomUUID(), idempotencyKey: randomUUID() }) as any;
    expect(status.output).toContain("feature.txt");
    const committed = await engine.capabilities.execute("git.commit", {
      message: "add feature", paths: ["feature.txt"], authorName: "HAF Test", authorEmail: "haf@example.com",
    }, { ...context, toolCallId: randomUUID(), idempotencyKey: randomUUID() }) as any;
    expect(committed.commit).toMatch(/^[a-f0-9]{40,64}$/);
    await engine.capabilities.execute("git.branch.switch", { name: "main" }, { ...context, toolCallId: randomUUID(), idempotencyKey: randomUUID() });
    await expect(engine.capabilities.execute("git.branch.create", { name: "../unsafe" }, { ...context, toolCallId: randomUUID(), idempotencyKey: randomUUID() })).rejects.toThrow("invalid");
  });
});
