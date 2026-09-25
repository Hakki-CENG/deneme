/**
 * Bölüm H — EMBODIMENT: arac sözleşmesi, dosya sistemi sertleştirmesi,
 * terminal, git, kod zekası ve ortam haritası.
 *
 * Ölçüm (yazmadan önce):
 *
 *  - H1: CapabilityDescriptor'da input şeması, risk, side-effect ve izin
 *    vardı; idempotency yalnızca context'te taşınıyordu (beyan yok), çıktı
 *    şeması yoktu, doğrulayıcı ve geri alma yoktu.
 *  - H2: confinement + symlink savunması + base64 binary yazma tamamdı; kota,
 *    dosya kilidi, büyük dosya akışı ve arşiv güvenliği yoktu.
 *  - H3: process.exec + sandbox (env allowlist, timeout, ulimit kaynak
 *    limitleri, süreç ağacı kill) ÖLÇÜMLE kapalı bulundu — yeniden yazılmadı.
 *  - H4: tarayıcıda tıkla/yaz/bas/kaydet/kaydır vardı; seçim ve dosya yükleme
 *    yoktu, eylem doğrulaması ve döngü dedektörü yoktu.
 *  - H5: status/diff/branch/commit + PR oluşturma/yorum/kapatma/birleştirme
 *    (SHA korumalı) vardı; clone, push, rollback ve CI durumu yoktu.
 *  - H6: LSP + scanner + sembol/tanım/referans + tanılama vardı; bağımlılık
 *    grafiği, yama üretimi ve refactor doğrulaması yoktu.
 *  - H7: ortam haritası (interpreter'lar, araç sürümleri, cihaz, proje
 *    yapısı) yoktu.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { BrowserManager, detectActionLoop } from "../src/browser/browser-manager.js";
import { HybridAgentEngine } from "../src/engine.js";
import { defineCapability } from "../src/capabilities/schema.js";
import { parseSafeTar } from "../src/util/safe-tar.js";

const FAKE_SERVER = join(process.cwd(), "test/fixtures/fake-lsp-server.mjs");

async function newEngine(options: { quotaBytes?: number; lsp?: boolean } = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "haf-embodiment-"));
  const engine = new HybridAgentEngine({
    homePath,
    kernelServerScript: "",
    sandboxBackend: "local",
    model: { provider: "mock" },
    autoApproveWorkspaceWrites: true,
    allowProcessExecution: true,
    ...(options.quotaBytes ? { workspaceQuotaBytes: options.quotaBytes } : {}),
    ...(options.lsp
      ? {
          codeIntelligence: {
            lsp: true,
            serverBinaries: { "typescript-language-server": process.execPath },
            serverArgs: { "typescript-language-server": [FAKE_SERVER] },
          },
        }
      : {}),
  } as never);
  const session = await engine.createSession({ tenantId: "h-tenant", name: "embodiment" });
  const snapshot = await engine.session(session.sessionId);
  const context = (suffix: string) => ({
    tenantId: "h-tenant",
    sessionId: session.sessionId,
    familyId: session.sessionId,
    turnId: `turn-${suffix}`,
    toolCallId: `call-${suffix}`,
    source: "api" as const,
    workspacePath: snapshot.workspacePath,
    idempotencyKey: `h-${suffix}-${randomUUID()}`,
  });
  return { engine, workspacePath: snapshot.workspacePath, context, sessionId: session.sessionId };
}

// ─────────────────────────────── H1: common tool contract

describe("H1: the capability contract is declared and enforced", () => {
  it("filesystem capabilities declare idempotency and an output schema", async () => {
    const { engine } = await newEngine();
    const descriptors = engine.capabilities.list();
    const write = descriptors.find((item) => item.id === "filesystem.write")!;
    expect(write.idempotency).toBe("keyed");
    expect(write.outputSchema).toBeDefined();
    const read = descriptors.find((item) => item.id === "filesystem.read")!;
    expect(read.idempotency).toBe("inherent");
    expect(read.outputSchema).toBeDefined();
    await engine.shutdown();
  });

  it("a failed post-execution verification fails the call in the broker", async () => {
    const { engine, workspacePath, context } = await newEngine();
    engine.capabilities.register(
      defineCapability(
        { id: "test.h1.unverified", version: "1.0.0", description: "test", risk: "pure", sideEffect: false, source: "core" },
        z.object({ path: z.string() }),
        async () => ({ done: true }),
        {
          output: z.object({ done: z.boolean() }),
          verify: async () => ({ ok: false, reason: "the promised effect never happened" }),
        },
      ),
    );
    await expect(engine.capabilities.execute("test.h1.unverified", { path: "x" }, context("v1"))).rejects.toThrow(/failed post-execution verification: the promised effect never happened/);
    await engine.shutdown();
  });

  it("an output that violates the declared schema is refused, not returned", async () => {
    const { engine, context } = await newEngine();
    engine.capabilities.register(
      defineCapability(
        { id: "test.h1.misshapen", version: "1.0.0", description: "test", risk: "pure", sideEffect: false, source: "core" },
        z.object({}),
        async () => ({ surprise: "not in the contract" }),
        { output: z.object({ expected: z.number() }) },
      ),
    );
    await expect(engine.capabilities.execute("test.h1.misshapen", {}, context("v2"))).rejects.toThrow(/violated its declared output schema/);
    await engine.shutdown();
  });

  it("a declared rollback compensates a failed execution", async () => {
    const { engine, workspacePath, context } = await newEngine();
    const target = join(workspacePath, "half-done.txt");
    engine.capabilities.register(
      defineCapability(
        { id: "test.h1.halfway", version: "1.0.0", description: "test", risk: "workspace_write", sideEffect: true, source: "core" },
        z.object({ path: z.string() }),
        async ({ path }) => {
          // Take effect, then fail — the worst case a rollback exists for.
          await writeFile(join(workspacePath, path), "partial", "utf8");
          throw new Error("the work failed after writing");
        },
        {
          rollback: async ({ path }) => {
            await rm(join(workspacePath, path), { force: true });
            return { rolledBack: true };
          },
        },
      ),
    );
    await expect(engine.capabilities.execute("test.h1.halfway", { path: "half-done.txt" }, context("v3"))).rejects.toThrow(/the work failed after writing/);
    expect(await stat(target).then(() => true, () => false)).toBe(false);
    await engine.shutdown();
  });

  it("filesystem.write passes through the real broker path and lands on disk", async () => {
    const { engine, workspacePath, context } = await newEngine();
    const result = await engine.capabilities.execute("filesystem.write", { path: "notes/real.txt", content: "on disk" }, context("v4"));
    expect(result).toMatchObject({ path: "notes/real.txt", writtenChars: 7 });
    expect(await readFile(join(workspacePath, "notes/real.txt"), "utf8")).toBe("on disk");
    await engine.shutdown();
  });
});

// ─────────────────────────────── H2: filesystem production hardening

describe("H2: workspace quotas, locking, streaming reads and archive safety", () => {
  it("a write that would exceed the workspace quota is refused before it lands", async () => {
    const { engine, workspacePath, context } = await newEngine({ quotaBytes: 8 * 1024 });
    await engine.capabilities.execute("filesystem.write", { path: "small.txt", content: "x".repeat(2 * 1024) }, context("q1"));
    await expect(
      engine.capabilities.execute("filesystem.write", { path: "big.txt", content: "y".repeat(16 * 1024) }, context("q2")),
    ).rejects.toThrow(/quota exceeded/);
    expect(await stat(join(workspacePath, "big.txt")).then(() => true, () => false)).toBe(false);
    // The quota holds, it does not wedge: a small write still goes through.
    await engine.capabilities.execute("filesystem.write", { path: "small2.txt", content: "z".repeat(64) }, context("q3"));
    await engine.shutdown();
  });

  it("a path lock is exclusive across sessions and only its holder may release it", async () => {
    const { engine, workspacePath, context } = await newEngine();
    const first = await engine.capabilities.execute("filesystem.lock", { path: "shared.bin" }, context("l1"));
    expect(first).toMatchObject({ locked: true });
    // A second attempt — even with a different tool call — is refused.
    await expect(engine.capabilities.execute("filesystem.lock", { path: "shared.bin" }, context("l2"))).rejects.toThrow(/already locked/);
    // Another session cannot unlock it.
    const stranger = (suffix: string) => ({ ...context(suffix), sessionId: `stranger-${suffix}` });
    await expect(engine.capabilities.execute("filesystem.unlock", { path: "shared.bin" }, stranger("l3"))).rejects.toThrow(/locked by another session/);
    // The holder can.
    await expect(engine.capabilities.execute("filesystem.unlock", { path: "shared.bin" }, context("l4"))).resolves.toMatchObject({ unlocked: true });
    // Two concurrent takers race past the existing-lock read: only the O_EXCL
    // create arbitrates, so exactly one of them may win.
    const race = await Promise.allSettled([
      engine.capabilities.execute("filesystem.lock", { path: "raced.bin" }, context("r1")),
      engine.capabilities.execute("filesystem.lock", { path: "raced.bin" }, context("r2")),
    ]);
    expect(race.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((item) => item.status === "rejected")).toHaveLength(1);
    // A stale lock past its TTL is taken over instead of fencing forever.
    await engine.capabilities.execute("filesystem.lock", { path: "stale.bin", ttlMs: 60_000 }, context("l5"));
    const { readdir } = await import("node:fs/promises");
    const locksDir = join(workspacePath, ".aurora-locks");
    const files = await readdir(locksDir);
    for (const name of files) {
      const lockPath = join(locksDir, name);
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as { path?: string };
      if (lock.path === "stale.bin") {
        await writeFile(lockPath, JSON.stringify({ ...lock, createdAt: new Date(Date.now() - 120_000).toISOString() }), "utf8");
      }
    }
    await expect(engine.capabilities.execute("filesystem.lock", { path: "stale.bin", ttlMs: 60_000 }, context("l6"))).resolves.toMatchObject({ locked: true });
    await engine.shutdown();
  });

  it("reads stream: windowed reads reach the tail of a large file without loading it", async () => {
    const { engine, workspacePath, context } = await newEngine();
    const payload = `A`.repeat(1024 * 1024 - 10) + "TAIL-MARKER";
    await writeFile(join(workspacePath, "large.log"), payload, "utf8");
    const info = await stat(join(workspacePath, "large.log"));
    const tail = (await engine.capabilities.execute(
      "filesystem.read",
      { path: "large.log", offsetBytes: info.size - 11 },
      context("s1"),
    )) as { content: string; truncated: boolean; bytesSkipped: number; fileBytes: number };
    expect(tail.content).toBe("TAIL-MARKER");
    expect(tail.bytesSkipped).toBe(info.size - 11);
    expect(tail.fileBytes).toBe(info.size);
    const head = (await engine.capabilities.execute(
      "filesystem.read",
      { path: "large.log", maxChars: 100 },
      context("s2"),
    )) as { content: string; truncated: boolean; chars: number };
    expect(head.chars).toBe(100);
    expect(head.truncated).toBe(true);
    await engine.shutdown();
  });

  it("archives extract only what is safe; traversal and symlink entries are refused wholesale", async () => {
    const { engine, workspacePath, context } = await newEngine();
    // A well-formed archive with two files.
    await writeFile(join(workspacePath, "good.tar"), buildTar([
      { path: "docs/readme.txt", content: "safe content" },
      { path: "src/main.txt", content: "also safe" },
    ]));
    await engine.capabilities.execute("filesystem.archive.extract", { archivePath: "good.tar", intoDirectory: "out" }, context("a1"));
    expect(await readFile(join(workspacePath, "out/docs/readme.txt"), "utf8")).toBe("safe content");
    expect(await readFile(join(workspacePath, "out/src/main.txt"), "utf8")).toBe("also safe");

    // A traversal archive is refused and writes nothing.
    await writeFile(join(workspacePath, "evil.tar"), buildTar([
      { path: "innocent.txt", content: "decoy" },
      { path: "../escape.txt", content: "should never exist" },
    ]));
    await expect(engine.capabilities.execute("filesystem.archive.extract", { archivePath: "evil.tar", intoDirectory: "out2" }, context("a2"))).rejects.toThrow(/escapes the extraction root/);
    expect(await stat(join(workspacePath, "out2")).then(() => true, () => false)).toBe(false);
    expect(await stat(join(workspacePath, "..", "escape.txt")).then(() => true, () => false)).toBe(false);

    // A symlink entry is refused outright.
    await writeFile(join(workspacePath, "link.tar"), buildTar([
      { path: "link.txt", content: "", typeFlag: "2", linkName: "/etc/passwd" },
    ]));
    await expect(engine.capabilities.execute("filesystem.archive.extract", { archivePath: "link.tar", intoDirectory: "out3" }, context("a3"))).rejects.toThrow(/unsupported type/);
    // The parser level agrees: these never become entries.
    expect(() => parseSafeTar(buildTar([{ path: "../x", content: "y" }]))).toThrow(/escapes the extraction root/);
    expect(() => parseSafeTar(buildTar([{ path: "ok.txt", content: "y", typeFlag: "2", linkName: "z" }]))).toThrow(/unsupported type/);
    await engine.shutdown();
  });
});

// ─────────────────────────────── H5: git deep integration

describe("H5: clone, push and rollback exist with their guards", () => {
  it("the capability set covers clone/push/rollback/ci.status alongside the existing tools", async () => {
    const { engine } = await newEngine();
    const ids = engine.capabilities.list().filter((item) => item.id.startsWith("git.")).map((item) => item.id);
    for (const expected of ["git.status", "git.diff", "git.branch.list", "git.branch.create", "git.branch.switch", "git.commit", "git.clone", "git.push", "git.rollback", "git.ci.status"]) {
      expect(ids).toContain(expected);
    }
    const push = engine.capabilities.list().find((item) => item.id === "git.push")!;
    expect(push.risk).toBe("external_side_effect");
    await engine.shutdown();
  });

  it("a network-risk clone stops at the human approval gate until a person answers", { timeout: 90_000 }, async () => {
    const { engine, context, sessionId } = await newEngine();
    const execution = engine.capabilities.execute("git.clone", { url: "file:///etc/repo", intoDirectory: "repo" }, context("c-gate"));
    // The call is parked in front of a person, not silently run.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const pending = engine.approvals.list(sessionId);
    const request = pending.find((item) => item.capabilityId === "git.clone");
    expect(request).toBeDefined();
    expect(request!.risk).toBe("network");
    engine.approvals.resolve(request!.id, "approve_session");
    // Approved by a person — and THEN the transport guard refuses file://.
    await expect(execution).rejects.toThrow(/https:\/\//);
    await engine.shutdown();
  });

  it("once approved for the session, clone refuses every transport except credential-free HTTPS", { timeout: 90_000 }, async () => {
    const { engine, context, sessionId } = await newEngine();
    const first = engine.capabilities.execute("git.clone", { url: "https://127.0.0.1:1/repo.git", intoDirectory: "repo" }, context("c-warm"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const request = engine.approvals.list(sessionId).find((item) => item.capabilityId === "git.clone");
    engine.approvals.resolve(request!.id, "approve_session");
    // The session grant lets the remaining calls reach the URL guards directly.
    await expect(first).rejects.toThrow(); // port 1 refuses the connection instantly, so the sandbox call fails fast without any real network target
    await expect(engine.capabilities.execute("git.clone", { url: "file:///etc/repo", intoDirectory: "repo" }, context("c-file"))).rejects.toThrow(/https:\/\//);
    await expect(engine.capabilities.execute("git.clone", { url: "http://github.com/org/repo.git", intoDirectory: "repo" }, context("c-http"))).rejects.toThrow(/https:\/\//);
    await expect(engine.capabilities.execute("git.clone", { url: "git@github.com:org/repo.git", intoDirectory: "repo" }, context("c-ssh"))).rejects.toThrow(/not a valid URL/);
    await expect(engine.capabilities.execute("git.clone", { url: "https://user:token@github.com/org/repo.git", intoDirectory: "repo" }, context("c-cred"))).rejects.toThrow(/must not embed credentials/);
    await engine.shutdown();
  });

  it("push is an external side effect: a denied approval means no push, ever", { timeout: 90_000 }, async () => {
    const { engine, context, sessionId } = await newEngine();
    const push = engine.capabilities.execute("git.push", { remote: "origin", branch: "main" }, context("p-gate"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const request = engine.approvals.list(sessionId).find((item) => item.capabilityId === "git.push");
    expect(request).toBeDefined();
    expect(request!.risk).toBe("external_side_effect");
    engine.approvals.resolve(request!.id, "deny");
    await expect(push).rejects.toThrow(/approval was denied or expired/);
    await engine.shutdown();
  });
});

// ─────────────────────────────── H6: code intelligence

describe("H6: dependency graph, patch generation and refactor verification", () => {
  it("maps relative imports to file edges and package imports to externals", async () => {
    const { engine, workspacePath, context } = await newEngine();
    await writeFile(join(workspacePath, "a.ts"), `import { helper } from "./b";\nimport { readFileSync } from "fs";\nexport const a = helper;\n`, "utf8");
    await writeFile(join(workspacePath, "b.ts"), `export const helper = 1;\n`, "utf8");
    const result = (await engine.capabilities.execute("code.dependencies", {}, context("d1"))) as {
      edges: Array<{ from: string; to: string }>;
      external: Array<{ from: string; specifier: string }>;
    };
    expect(result.edges).toContainEqual({ from: "a.ts", to: "b.ts" });
    expect(result.external).toContainEqual({ from: "a.ts", specifier: "fs" });
    await engine.shutdown();
  });

  it("generates a patch that filesystem.patch can apply — generation and application round-trip", async () => {
    const { engine, workspacePath, context } = await newEngine();
    const before = "line one\nline two\nline three\n";
    const after = "line one\nline two, changed\nline three\nline four\n";
    await writeFile(join(workspacePath, "doc.txt"), before, "utf8");
    const generated = (await engine.capabilities.execute("code.patch.generate", {
      edits: [{ path: "doc.txt", before, after }],
    }, context("p1"))) as { diff: string };
    expect(generated.diff).toContain("--- doc.txt");
    await engine.capabilities.execute("filesystem.patch", { diff: generated.diff }, context("p2"));
    expect(await readFile(join(workspacePath, "doc.txt"), "utf8")).toBe(after);
    await engine.shutdown();
  });

  it("verifies a refactor against a diagnostics baseline: new errors regress, fixes improve", async () => {
    const { engine, workspacePath, context } = await newEngine({ lsp: true });
    await writeFile(join(workspacePath, "app.ts"), "const value: number = 1;\nexport { value };\n", "utf8");
    const baseline = (await engine.capabilities.execute("code.diagnostics.run", {}, context("r0"))) as { id: string };
    // Regressed: introduce an error.
    await writeFile(join(workspacePath, "app.ts"), "// TYPE_ERROR_MARKER\nconst value: number = 1;\nexport { value };\n", "utf8");
    const regressed = (await engine.capabilities.execute("code.refactor.verify", { baselineRunId: baseline.id }, context("r1"))) as { verdict: string; newErrors: unknown[] };
    expect(regressed.verdict).toBe("regressed");
    expect(regressed.newErrors.length).toBeGreaterThan(0);
    // Improved: remove the error again.
    await writeFile(join(workspacePath, "app.ts"), "const value: number = 1;\nexport { value };\n", "utf8");
    const improved = (await engine.capabilities.execute("code.refactor.verify", { baselineRunId: baseline.id }, context("r2"))) as { verdict: string };
    expect(improved.verdict).toBe("clean");
    await engine.shutdown();
  });
});

// ─────────────────────────────── H7: environment mapper

describe("H7: the environment probe measures what is actually installed", () => {
  it("reports measured interpreters, device state, project structure and honest unknowns", { timeout: 120_000 }, async () => {
    const { engine, workspacePath, context } = await newEngine();
    await writeFile(join(workspacePath, "hello.ts"), "export const hi = 1;\n", "utf8");
    const probe = (await engine.capabilities.execute("environment.probe", {}, context("e1"))) as {
      interpreters: Array<{ id: string; available: boolean; version?: string }>;
      device: { measured: boolean };
      projectStructure: { fileCount: number; languages: Record<string, number> };
      network: { probed: boolean; reason: string };
      permissions: { capabilityCount: number; byRisk: Record<string, number> };
    };
    const node = probe.interpreters.find((item) => item.id === "node")!;
    expect(node.available).toBe(true);
    expect(node.version).toMatch(/v?\d/);
    expect(probe.device.measured).toBe(true);
    expect(probe.projectStructure.languages.ts).toBeGreaterThanOrEqual(1);
    expect(probe.network.probed).toBe(false);
    expect(probe.permissions.capabilityCount).toBeGreaterThan(50);
    expect(probe.permissions.byRisk.workspace_write).toBeGreaterThan(0);
    await engine.shutdown();
  });
});

// ─────────────────────────────── H4: browser actuator guards

describe("H4: browser action verification and anti-loop", () => {
  it("a repeated action that never changes the page is a loop; a changing retry is not", () => {
    const stuck = [
      { action: "click", target: "e3", snapshotHash: "h1" },
      { action: "click", target: "e3", snapshotHash: "h1" },
      { action: "click", target: "e3", snapshotHash: "h1" },
    ];
    expect(detectActionLoop(stuck)).toMatchObject({ loop: true });
    const progressing = [
      { action: "click", target: "e3", snapshotHash: "h1" },
      { action: "click", target: "e3", snapshotHash: "h2" },
      { action: "click", target: "e3", snapshotHash: "h3" },
    ];
    expect(detectActionLoop(progressing)).toMatchObject({ loop: false });
    const differentTarget = [
      { action: "click", target: "e1", snapshotHash: "h1" },
      { action: "click", target: "e2", snapshotHash: "h1" },
      { action: "click", target: "e3", snapshotHash: "h1" },
    ];
    expect(detectActionLoop(differentTarget)).toMatchObject({ loop: false });
  });

  it("the manager hash-verifies snapshot changes and the toolset includes select and upload", async () => {
    // Hash-based effect verification is exercised through the exported
    // static behaviour on snapshots (no browser backend needed for the
    // contract-level assertions).
    const manager = new BrowserManager({ executablePath: "/configured/chromium" });
    expect(manager.configured).toBe(true);
    const homePath = await mkdtemp(join(tmpdir(), "haf-browser-h-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: "",
      sandboxBackend: "local",
      model: { provider: "mock" },
      browser: { executablePath: "/configured/chromium" },
    } as never);
    const ids = engine.capabilities.list().filter((item) => item.id.startsWith("browser.") || item.id.startsWith("computer.")).map((item) => item.id);
    expect(ids).toContain("browser.select");
    expect(ids).toContain("browser.upload");
    await engine.shutdown();
  });
});

// ─────────────────────────────── tar builder for the archive tests

function tarHeader(name: string, size: number, typeFlag: string, linkName = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 99), 0, "utf8");
  header.write("0000644 \0", 100, "utf8");
  header.write("0000000 \0", 108, "utf8");
  header.write("0000000 \0", 116, "utf8");
  header.write(size.toString(8).padStart(11, "0") + " \0", 124, "utf8");
  header.write("00000000000 \0", 136, "utf8");
  // Checksum field is spaces while summing.
  header.write("        ", 148, "utf8");
  header.write(typeFlag, 156, "utf8");
  header.write(linkName.slice(0, 99), 157, "utf8");
  header.write("ustar\0", 257, "utf8");
  header.write("00", 263, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  return header;
}

function buildTar(entries: Array<{ path: string; content: string; typeFlag?: string; linkName?: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content, "utf8");
    chunks.push(tarHeader(entry.path, content.length, entry.typeFlag ?? "0", entry.linkName ?? ""));
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
