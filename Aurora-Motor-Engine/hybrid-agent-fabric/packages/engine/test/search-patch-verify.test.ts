import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { VerificationService } from "../src/harness/verification-service.js";
import { LocalSandbox } from "../src/sandbox/sandbox.js";

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-round4-"));
  const engine = new HybridAgentEngine({
    homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local", model: { provider: "mock" }, autoApproveWorkspaceWrites: true, allowProcessExecution: true,
  });
  const session = await engine.createSession({ tenantId: "tenant", name: "coder" });
  const snapshot = await engine.session(session.sessionId);
  const context = (suffix: string) => ({
    tenantId: "tenant", sessionId: session.sessionId, familyId: session.sessionId, turnId: `turn-${suffix}`,
    toolCallId: `call-${suffix}`, source: "api" as const, workspacePath: snapshot.workspacePath, idempotencyKey: `r4-${suffix}`,
  });
  return { engine, session, workspacePath: snapshot.workspacePath, context };
}

describe("Workspace search primitives", () => {
  it("matches files by glob, newest first, and never follows a symlink out", async () => {
    const { engine, workspacePath, context } = await fixture();
    await mkdir(join(workspacePath, "src", "deep"), { recursive: true });
    await writeFile(join(workspacePath, "src", "one.ts"), "export const one = 1;\n", "utf8");
    await writeFile(join(workspacePath, "src", "deep", "two.ts"), "export const two = 2;\n", "utf8");
    await writeFile(join(workspacePath, "src", "notes.md"), "# notes\n", "utf8");
    await mkdir(join(workspacePath, "node_modules", "junk"), { recursive: true });
    await writeFile(join(workspacePath, "node_modules", "junk", "three.ts"), "export const three = 3;\n", "utf8");

    const result = await engine.capabilities.execute("filesystem.glob", { pattern: "src/**/*.ts" }, context("glob")) as any;
    expect(result.matches.map((item: any) => item.path).sort()).toEqual(["src/deep/two.ts", "src/one.ts"]);
    // Dependency directories are never searched: they are noise an agent pays tokens for.
    expect(JSON.stringify(result.matches)).not.toContain("node_modules");

    const single = await engine.capabilities.execute("filesystem.glob", { pattern: "*.md", path: "src" }, context("glob-2")) as any;
    expect(single.matches.map((item: any) => item.path)).toEqual(["src/notes.md"]);
    await engine.shutdown();
  }, 60_000);

  it("greps contents with line numbers, include filters and context lines", async () => {
    const { engine, workspacePath, context } = await fixture();
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await writeFile(join(workspacePath, "src", "a.ts"), "line one\nconst target = 42;\nline three\n", "utf8");
    await writeFile(join(workspacePath, "src", "b.py"), "target = 'python'\n", "utf8");
    await writeFile(join(workspacePath, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x54, 0x41, 0x52]), null as any);

    const all = await engine.capabilities.execute("filesystem.grep", { pattern: "target" }, context("grep")) as any;
    expect(all.matches.map((item: any) => `${item.path}:${item.line}`).sort()).toEqual(["src/a.ts:2", "src/b.py:1"]);
    // A binary file is reported as skipped rather than dumped into the transcript.
    expect(all.skippedBinaryFiles).toBeGreaterThan(0);

    const filtered = await engine.capabilities.execute("filesystem.grep", { pattern: "target", include: "*.ts", contextLines: 1 }, context("grep-2")) as any;
    expect(filtered.matches).toHaveLength(1);
    expect(filtered.matches[0].before).toEqual(["line one"]);
    expect(filtered.matches[0].after).toEqual(["line three"]);

    await expect(engine.capabilities.execute("filesystem.grep", { pattern: "([" }, context("grep-3")))
      .rejects.toThrow(/invalid search pattern/i);
    await engine.shutdown();
  }, 60_000);
});

describe("Patch application", () => {
  const diff = (path: string) => [
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    " first",
    "-second",
    "+SECOND",
    " third",
    "",
  ].join("\n");

  it("applies a unified diff and reports what changed", async () => {
    const { engine, workspacePath, context } = await fixture();
    await writeFile(join(workspacePath, "file.txt"), "first\nsecond\nthird\n", "utf8");

    const preview = await engine.capabilities.execute("filesystem.patch", { diff: diff("file.txt"), dryRun: true }, context("patch-dry")) as any;
    expect(preview.applied).toBe(false);
    expect(preview.files[0].path).toBe("file.txt");
    const untouched = await engine.capabilities.execute("filesystem.read", { path: "file.txt" }, context("read-1")) as any;
    expect(untouched.content).toContain("second");

    const applied = await engine.capabilities.execute("filesystem.patch", { diff: diff("file.txt") }, context("patch")) as any;
    expect(applied.applied).toBe(true);
    const after = await engine.capabilities.execute("filesystem.read", { path: "file.txt" }, context("read-2")) as any;
    expect(after.content).toContain("SECOND");
    expect(after.content).not.toContain("\nsecond");
    await engine.shutdown();
  }, 60_000);

  it("refuses a stale patch and leaves every file untouched", async () => {
    const { engine, workspacePath, context } = await fixture();
    await writeFile(join(workspacePath, "one.txt"), "first\nsecond\nthird\n", "utf8");
    await writeFile(join(workspacePath, "two.txt"), "unchanged\n", "utf8");
    const combined = [
      diff("one.txt").trimEnd(),
      "--- a/two.txt",
      "+++ b/two.txt",
      "@@ -1,1 +1,1 @@",
      "-something that is not there",
      "+replacement",
      "",
    ].join("\n");

    await expect(engine.capabilities.execute("filesystem.patch", { diff: combined }, context("patch-stale")))
      .rejects.toThrow(/context does not match/i);
    // All or nothing: the hunk that *would* have applied did not.
    const first = await engine.capabilities.execute("filesystem.read", { path: "one.txt" }, context("read-3")) as any;
    expect(first.content).toContain("second");
    await engine.shutdown();
  }, 60_000);

  it("refuses to escape the workspace and rejects an unparseable diff", async () => {
    const { engine, context } = await fixture();
    const escaping = ["--- a/../outside.txt", "+++ b/../outside.txt", "@@ -0,0 +1,1 @@", "+pwned", ""].join("\n");
    await expect(engine.capabilities.execute("filesystem.patch", { diff: escaping }, context("patch-escape")))
      .rejects.toThrow(/escapes the assigned workspace/i);
    await expect(engine.capabilities.execute("filesystem.patch", { diff: "not a diff at all" }, context("patch-junk")))
      .rejects.toThrow(/no file hunks/i);
    await engine.shutdown();
  }, 60_000);
});

describe("Project verification", () => {
  it("detects the project's own commands and says which files revealed them", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "haf-verify-"));
    await writeFile(join(workspacePath, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "vitest run", lint: "eslint ." } }), "utf8");
    await writeFile(join(workspacePath, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
    const verification = new VerificationService(await mkdtemp(join(tmpdir(), "haf-verify-state-")), async (path) => new LocalSandbox(path));

    const recipe = await verification.detect(workspacePath);
    expect(recipe.kind).toBe("node");
    // The lockfile picks the package manager: running npm in a pnpm repo fails for the wrong reason.
    expect(recipe.name).toBe("Node (pnpm)");
    expect(recipe.build).toEqual(["pnpm run build"]);
    expect(recipe.evidence).toContain("pnpm-lock.yaml");

    const goWorkspace = await mkdtemp(join(tmpdir(), "haf-verify-go-"));
    await writeFile(join(goWorkspace, "go.mod"), "module example\n", "utf8");
    expect((await verification.detect(goWorkspace)).test).toEqual(["go test ./..."]);
  }, 30_000);

  it("records passing evidence and refuses to call an empty project verified", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "haf-verify-state-"));
    const verification = new VerificationService(stateRoot, async (path) => new LocalSandbox(path));

    const workspacePath = await mkdtemp(join(tmpdir(), "haf-verify-run-"));
    await writeFile(join(workspacePath, "Makefile"), "build:\n\techo building\ntest:\n\techo testing\n", "utf8");
    const run = await verification.run({ tenantId: "tenant", sessionId: "session", workspacePath });
    expect(run.verdict).toBe("verified");
    expect(run.phases.map((item) => item.phase)).toEqual(["build", "test"]);
    expect(run.phases.every((item) => item.passed)).toBe(true);
    expect(run.phases[0]!.outputTail).toContain("building");

    const evidence = await verification.latest("tenant", "session");
    expect(evidence.verified).toBe(true);

    const bare = await mkdtemp(join(tmpdir(), "haf-verify-bare-"));
    const inconclusive = await verification.run({ tenantId: "tenant", sessionId: "empty", workspacePath: bare });
    // Nothing ran, so nothing was proven: silence is not evidence.
    expect(inconclusive.verdict).toBe("inconclusive");
    expect((await verification.latest("tenant", "empty")).verified).toBe(false);
  }, 60_000);

  it("stops at the first failing phase and keeps the failure's output", async () => {
    const verification = new VerificationService(await mkdtemp(join(tmpdir(), "haf-verify-state-")), async (path) => new LocalSandbox(path));
    const workspacePath = await mkdtemp(join(tmpdir(), "haf-verify-fail-"));
    await writeFile(join(workspacePath, "Makefile"), "build:\n\techo compiling; exit 3\ntest:\n\techo should-not-run\n", "utf8");

    const run = await verification.run({ tenantId: "tenant", sessionId: "session", workspacePath });
    expect(run.verdict).toBe("failed");
    expect(run.phases).toHaveLength(1);
    expect(run.phases[0]!.exitCode).not.toBe(0);
    expect(run.phases[0]!.outputTail).toContain("compiling");
    expect(JSON.stringify(run)).not.toContain("should-not-run");
  }, 60_000);

  it("exposes recipe, run and evidence as capabilities on a real session", async () => {
    const { engine, workspacePath, context } = await fixture();
    await writeFile(join(workspacePath, "Makefile"), "test:\n\techo capability-verified\n", "utf8");

    const recipe = await engine.capabilities.execute("verify.recipe", {}, context("recipe")) as any;
    expect(recipe.kind).toBe("make");

    const run = await engine.capabilities.execute("verify.run", { phases: ["test"] }, context("run")) as any;
    expect(run.verdict).toBe("verified");

    const evidence = await engine.capabilities.execute("verify.evidence", {}, context("evidence")) as any;
    expect(evidence.latest.verified).toBe(true);
    expect(evidence.history).toHaveLength(1);
    await engine.shutdown();
  }, 90_000);
});
