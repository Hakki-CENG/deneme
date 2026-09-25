import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { findOccurrences, identifierAt, indexOfPosition, scanSymbols, stripNonCode } from "../src/code-intelligence/scanner.js";
import { decodeFrames, encodeMessage, sanitizeDiagnosticField } from "../src/code-intelligence/protocol.js";

const FAKE_SERVER = resolve(process.cwd(), "test/fixtures/fake-lsp-server.mjs");

async function fixture(options: { lsp?: boolean } = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "haf-code-intelligence-"));
  const engine = new HybridAgentEngine({
    homePath,
    kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local",
    model: { provider: "mock" },
    autoApproveWorkspaceWrites: true,
    allowProcessExecution: true,
    ...(options.lsp
      ? {
          codeIntelligence: {
            lsp: true,
            serverBinaries: { "typescript-language-server": process.execPath },
            serverArgs: { "typescript-language-server": [FAKE_SERVER] },
          },
        }
      : { codeIntelligence: { lsp: false } }),
  });
  const session = await engine.createSession({ tenantId: "tenant", name: "coder" });
  const snapshot = await engine.session(session.sessionId);
  const context = (suffix: string) => ({
    tenantId: "tenant", sessionId: session.sessionId, familyId: session.sessionId, turnId: `turn-${suffix}`,
    toolCallId: `call-${suffix}`, source: "api" as const, workspacePath: snapshot.workspacePath, idempotencyKey: `ci-${suffix}`,
  });
  return { engine, session, workspacePath: snapshot.workspacePath, context };
}

describe("Code protocol and scanner primitives", () => {
  it("frames and decodes Content-Length messages and accepts a hostile body", () => {
    const encoded = encodeMessage({ jsonrpc: "2.0", id: 1, method: "test" });
    expect(encoded).toContain("Content-Length:");
    const { messages, rest } = decodeFrames(`${encoded}${encoded}`);
    expect(messages).toHaveLength(2);
    expect(rest).toBe("");
    const partial = decodeFrames(encoded.slice(0, 20));
    expect(partial.messages).toHaveLength(0);
    expect(partial.rest.length).toBeGreaterThan(0);
  });

  it("sanitizes server-produced diagnostic fields: newlines collapse, control chars neutralised, length capped", () => {
    const value = `first\nsecond\x1b[31m${"x".repeat(500)}`;
    const sanitized = sanitizeDiagnosticField(value, 300);
    expect(sanitized).not.toContain("\n");
    expect(sanitized.length).toBeLessThanOrEqual(300);
    expect(sanitized).toContain("first second");
    expect(sanitized).not.toContain("\u001b");
  });

  it("scans TypeScript symbols without matching comment/string text", () => {
    const source = [
      "// fake function hidden()",
      "export function greet(name: string) { return name; }",
      "export class Foo { }",
      "export interface Thing { id: string; }",
      "export type Alias = string;",
      "const secret = 'const hidden = 1';",
    ].join("\n");
    const symbols = scanSymbols(source, "typescript");
    const names = symbols.map((symbol) => symbol.name);
    expect(names).toEqual(["greet", "Foo", "Thing", "Alias", "secret"]);
    expect(symbols[0]).toMatchObject({ kind: "function", line: 2, column: 17, scopeDepth: 0 });
    expect(JSON.stringify(symbols)).not.toContain("hidden");
  });

  it("finds occurrences with word boundaries and identifiers at a position", () => {
    const source = "const target = 1;\nconst targetNot = 2;\ntarget + targetNot;\n";
    const cleaned = stripNonCode(source, "typescript");
    expect(findOccurrences(cleaned, "target")).toEqual([
      { line: 1, column: 7, length: 6 },
      { line: 3, column: 1, length: 6 },
    ]);
    const index = indexOfPosition(source, 3, 1);
    expect(identifierAt(cleaned, index)).toEqual({ name: "target", start: index, end: index + 6 });
    expect(identifierAt(cleaned, indexOfPosition(source, 3, 20))).toBeUndefined();
  });

  it("scans Python with indentation-based containers", () => {
    const source = "class Animal:\n    def speak(self):\n        return 'x'\n\ndef top():\n    pass\n";
    const symbols = scanSymbols(source, "python");
    expect(symbols.map((symbol) => [symbol.name, symbol.kind, symbol.container ?? null])).toEqual([
      ["Animal", "class", null],
      ["speak", "function", "Animal"],
      ["top", "function", null],
    ]);
  });
});

describe("Toolchain diagnostics", () => {
  it("parses a Python syntax error through the sandbox and records durable evidence", async () => {
    const { engine, workspacePath, context } = await fixture();
    await writeFile(join(workspacePath, "broken.py"), "def ok():\n    return 1\n\ndef bad(:\n", "utf8");
    await writeFile(join(workspacePath, "good.py"), "def fine():\n    return 2\n", "utf8");

    const run = await engine.capabilities.execute(
      "code.diagnostics.run",
      { files: ["broken.py", "good.py"], forceToolchain: true },
      context("py-diag"),
    ) as any;
    expect(["toolchain", "none"]).toContain(run.backend);
    expect(run.languageId).toBe("python");
    const broken = run.files.find((file: any) => file.path === "broken.py");
    expect(broken).toBeDefined();
    expect(broken.diagnostics.length).toBeGreaterThan(0);
    expect(broken.diagnostics[0].severity).toBe("error");
    expect(broken.diagnostics[0].code).toBe("SyntaxError");

    const evidence = await engine.capabilities.execute("code.diagnostics.evidence", { limit: 3 }, context("py-evidence")) as any;
    expect(evidence.latest.run.id).toBe(run.id);
    expect(evidence.latest.fresh).toBe(true);

    // Content changed -> the evidence is honest about being stale.
    await writeFile(join(workspacePath, "broken.py"), "def ok():\n    return 1\n", "utf8");
    const after = await engine.capabilities.execute("code.diagnostics.evidence", { limit: 1 }, context("py-evidence-2")) as any;
    expect(after.latest.fresh).toBe(false);
    await engine.shutdown();
  }, 60_000);

  it("parses tsc-style output from a project-local compiler and hides project errors in toolchain provenance", async () => {
    const { engine, workspacePath, context } = await fixture();
    await mkdir(join(workspacePath, "node_modules", ".bin"), { recursive: true });
    const tscPath = join(workspacePath, "node_modules", ".bin", "tsc");
    await writeFile(tscPath, [
      "#!/bin/sh",
      "cat <<'EOF'",
      "src/broken.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/broken.ts(7,1): error TS2304: Cannot find name 'nope'.",
      "EOF",
    ].join("\n"), "utf8");
    await chmod(tscPath, 0o755);
    await writeFile(join(workspacePath, "package.json"), JSON.stringify({ name: "f", scripts: {} }), "utf8");
    await writeFile(join(workspacePath, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }), "utf8");
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await writeFile(join(workspacePath, "src", "broken.ts"), "const x: number = 'nope';\n", "utf8");

    const run = await engine.capabilities.execute(
      "code.diagnostics.run",
      { files: ["src/broken.ts"], forceToolchain: true },
      context("ts-diag"),
    ) as any;
    expect(run.backend).toBe("toolchain");
    expect(run.toolchainId).toBe("tsc");
    expect(run.toolchainCommand).toContain("tsc");
    const file = run.files.find((item: any) => item.path === "src/broken.ts");
    expect(file.diagnostics.map((item: any) => item.code)).toEqual(["TS2322", "TS2304"]);
    expect(file.diagnostics[0]).toMatchObject({ line: 3, column: 5, severity: "error", source: "typescript" });
    await engine.shutdown();
  }, 60_000);
});

describe("Language server integration", () => {
  it("runs diagnostics through an LSP server with sanitized, version-checked results", async () => {
    const { engine, workspacePath, context } = await fixture({ lsp: true });
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await writeFile(join(workspacePath, "payload.ts"), "export function report() {\n  // TYPE_ERROR_MARKER\n  return 1;\n}\n// WARNING_MARKER\n", "utf8");

    const run = await engine.capabilities.execute("code.diagnostics.run", { files: ["payload.ts"] }, context("lsp-diag")) as any;
    expect(run.backend).toBe("lsp");
    expect(run.serverId).toBe("typescript-language-server");
    const file = run.files.find((item: any) => item.path === "payload.ts");
    expect(file).toBeDefined();
    // Default severity filter is error-only, so the fake W1000 warning is excluded.
    expect(file.diagnostics).toHaveLength(1);
    expect(file.diagnostics[0].code).toBe("TS9999");
    expect(file.diagnostics[0].message).not.toContain("\n");
    expect(file.diagnostics[0].message.length).toBeLessThanOrEqual(300);

    // Warnings are requested explicitly.
    const warnings = await engine.capabilities.execute(
      "code.diagnostics.run",
      { files: ["payload.ts"], severities: ["error", "warning"] },
      context("lsp-diag-2"),
    ) as any;
    const file2 = warnings.files.find((item: any) => item.path === "payload.ts");
    expect(file2.diagnostics.map((item: any) => item.code).sort()).toEqual(["TS9999", "W1000"]);
    await engine.shutdown();
  }, 60_000);

  it("answers symbols, definition and references through the LSP server", async () => {
    const { engine, workspacePath, context } = await fixture({ lsp: true });
    await writeFile(join(workspacePath, "a.ts"), "export function say() {\n  // TYPE_ERROR_MARKER\n  return 1;\n}\n", "utf8");

    const symbols = await engine.capabilities.execute("code.symbols", { path: "a.ts" }, context("lsp-symbols")) as any;
    expect(symbols.backend).toBe("lsp");
    expect(symbols.symbols[0]).toMatchObject({ name: "say", kind: "function", line: 1, detail: "Greets callers" });

    const definition = await engine.capabilities.execute("code.definition", { path: "a.ts", line: 3, column: 3 }, context("lsp-def")) as any;
    expect(definition.backend).toBe("lsp");
    expect(definition.name).toBe("return");
    expect(definition.candidates[0]).toMatchObject({ path: "a.ts", line: 3, column: 6 });

    const references = await engine.capabilities.execute("code.references", { path: "a.ts", line: 3, column: 3 }, context("lsp-refs")) as any;
    expect(references.backend).toBe("lsp");
    expect(references.occurrences.length).toBe(2);
    await engine.shutdown();
  }, 60_000);

  it("falls back to the toolchain when no LSP server binary is installed, and reports that in the catalog", async () => {
    const { engine, workspacePath, context } = await fixture();
    await writeFile(join(workspacePath, "a.ts"), "export const n: number = 'x';\n", "utf8");
    await writeFile(join(workspacePath, "tsconfig.json"), "{}", "utf8");

    const catalog = await engine.capabilities.execute("code.catalog", {}, context("catalog")) as any;
    expect(catalog.detection.primaryLanguageId).toBe("typescript");
    expect(catalog.servers.length).toBe(1);
    // No real typescript-language-server on PATH in the test environment.
    const serverEntry = catalog.servers[0];
    expect(serverEntry.serverId).toBe("typescript-language-server");
    expect(serverEntry.available).toBe(false);

    const run = await engine.capabilities.execute("code.diagnostics.run", { files: ["a.ts"] }, context("fallback")) as any;
    expect(["toolchain", "none"]).toContain(run.backend);
    expect(run.languageId).toBe("typescript");
    await engine.shutdown();
  }, 60_000);

  it("refuses definition/reference paths that escape the workspace", async () => {
    const { engine, context } = await fixture();
    const outside = resolve(tmpdir(), `escape-${Date.now()}.ts`);
    await writeFile(outside, "export const x = 1;\n", "utf8");
    const definition = await engine.capabilities.execute("code.definition", { path: outside, line: 1, column: 14 }, context("escape"))
      .then((value) => value as any)
      .catch(() => ({ backend: "none", candidates: [] }));
    expect(definition).toMatchObject({ backend: "none", candidates: [] });
    const references = await engine.capabilities.execute("code.references", { path: outside, line: 1, column: 14 }, context("escape-refs"))
      .then((value) => value as any)
      .catch(() => ({ backend: "none", occurrences: [] }));
    expect(references).toMatchObject({ backend: "none", occurrences: [] });
    await engine.shutdown();
  }, 60_000);
});
