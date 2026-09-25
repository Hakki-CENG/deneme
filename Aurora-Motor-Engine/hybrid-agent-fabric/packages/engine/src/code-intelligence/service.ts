import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { SandboxFactory } from "../sandbox/sandbox.js";
import { DurableJsonState, auroraInteger, auroraText } from "../util/aurora-state.js";
import { LspClient } from "./client.js";
import {
  normalizeDiagnostic,
  SEVERITY_NAMES,
  type NormalizedDiagnostic,
  type LspDiagnostic,
} from "./protocol.js";
import {
  findOccurrences,
  identifierAt,
  indexOfPosition,
  languageOf,
  MAX_OCCURRENCES,
  MAX_SCANNED_FILE_BYTES,
  MAX_SYMBOLS_PER_FILE,
  MAX_SYMBOLS_TOTAL,
  scanSymbols,
  stripNonCode,
  type ScannedSymbol,
  type SymbolKind,
} from "./scanner.js";
import {
  detectLanguages,
  findExecutable,
  findOnPath,
  LANGUAGE_PROFILES,
  profileFor,
  walkWorkspaceFiles,
  type LanguageDetection,
  type LanguageProfile,
} from "./servers.js";

export const MAX_DIAGNOSTIC_FILES = 60;
export const MAX_DIAGNOSTICS_PER_FILE = 100;
export const MAX_TOTAL_DIAGNOSTICS = 500;
export const MAX_DIAGNOSTIC_RUNS = 200;
export const MAX_SYMBOL_FILES = 400;
export const MAX_FILE_READ_BYTES = 1024 * 1024;
export const DEFAULT_TOOLCHAIN_TIMEOUT_MS = 180_000;
export const LSP_DIAGNOSTIC_WAIT_MS = 6000;
export const MAX_LSP_SERVERS = 2;

export type Severity = "error" | "warning" | "info" | "hint";
const SEVERITY_VALUES: Severity[] = ["error", "warning", "info", "hint"];

export interface CodeIntelligenceOptions {
  /** Enable the language server path. Toolchain diagnostics stay available regardless. */
  lsp?: boolean;
  /** serverId -> executable path override (tests, operator pinning). */
  serverBinaries?: Record<string, string>;
  /** serverId -> exact argument vector override. */
  serverArgs?: Record<string, string[]>;
  maxLspServers?: number;
  toolchainTimeoutMs?: number;
}

export interface FileDiagnostics {
  /** Relative to the workspace root, POSIX-style. */
  path: string;
  /** SHA-256 of the content the diagnostics describe; checked on read to detect staleness. */
  digest: string;
  diagnostics: NormalizedDiagnostic[];
}

export interface DiagnosticRun {
  id: string;
  tenantId: string;
  sessionId: string;
  workspacePath: string;
  languageId: string | null;
  languageLabel: string;
  backend: "lsp" | "toolchain" | "none";
  serverId?: string;
  toolchainId?: string;
  toolchainCommand?: string;
  files: FileDiagnostics[];
  counts: { errors: number; warnings: number; infos: number; hints: number; files: number; total: number };
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  sequence: number;
  reason: string;
}

interface DiagnosticsStateShape {
  schemaVersion: 1;
  runs: DiagnosticRun[];
  sequence: number;
}

function isState(value: unknown): value is DiagnosticsStateShape {
  const candidate = value as DiagnosticsStateShape | undefined;
  return Boolean(candidate && candidate.schemaVersion === 1 && Array.isArray(candidate.runs));
}

function relativePath(workspacePath: string, absolute: string): string {
  const rel = relative(workspacePath, absolute).replace(/\\/g, "/");
  return rel.startsWith("../") || rel === ".." ? absolute.replace(/\\/g, "/") : rel;
}

/** Toolchains print paths relative to the workspace root (tsc, ruff, go) or as `./pkg/x.go` (go vet). */
function normalizeToolchainPath(workspacePath: string, value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return relativePath(workspacePath, normalized);
  return normalized;
}

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function severityOf(value: string | undefined): Severity {
  return SEVERITY_VALUES.includes(value as Severity) ? (value as Severity) : "info";
}

function boundDiagnostics(items: NormalizedDiagnostic[], workspacePath: string): NormalizedDiagnostic[] {
  return items
    .map((item) => ({
      ...item,
      path: relativePath(workspacePath, item.path),
      ...(item.endLine === undefined ? {} : { endLine: item.endLine }),
      ...(item.endColumn === undefined ? {} : { endColumn: item.endColumn }),
    }))
    .slice(0, MAX_DIAGNOSTICS_PER_FILE);
}

const SEVERITY_KEY: Record<Severity, "errors" | "warnings" | "infos" | "hints"> = {
  error: "errors", warning: "warnings", info: "infos", hint: "hints",
};

function countBySeverity(files: FileDiagnostics[]): DiagnosticRun["counts"] {
  const counts: DiagnosticRun["counts"] = { errors: 0, warnings: 0, infos: 0, hints: 0, files: files.length, total: 0 };
  for (const file of files) {
    for (const item of file.diagnostics) counts[SEVERITY_KEY[item.severity]]++;
  }
  counts.total = counts.errors + counts.warnings + counts.infos + counts.hints;
  return counts;
}

interface ResolvedFile {
  absolute: string;
  relativePath: string;
  languageId: string;
  text: string;
}

interface ResolvedServer {
  executable: string;
  args: string[];
}

const LSP_SYMBOL_KINDS: Record<number, SymbolKind> = {
  2: "module", 3: "module", 4: "module", 5: "class", 6: "method", 7: "field", 8: "field",
  9: "method", 10: "enum", 11: "interface", 12: "function", 13: "variable", 14: "const",
  22: "const", 23: "struct", 26: "type",
};

export interface CodeSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
  column: number;
  endLine: number;
  container?: string;
  detail?: string;
}

export interface DefinitionCandidate {
  path: string;
  line: number;
  column: number;
  name: string;
  kind: string;
  container?: string;
}

export interface ReferenceOccurrence {
  path: string;
  line: number;
  column: number;
  length: number;
  requested?: boolean;
}

/**
 * Code intelligence for Aurora: language server diagnostics, symbols,
 * definition and references, with a toolchain fallback and a dependency-free
 * structural scanner when no server is installed.
 *
 * Hermes ships a real LSP client (`agent/lsp/*`) and so does every serious
 * peer: an agent that edits code without being able to read its own type
 * errors is working blind. Aurora's version keeps the peer invariants:
 *
 * - **diagnostics freshness is content-based, not clock-based.** Each file
 *   entry carries the SHA-256 of the exact text the server saw, so
 *   `latest()` can answer "is this still true?" without trusting timestamps.
 * - **server output is untrusted.** Message/code/source fields pass through
 *   `sanitizeDiagnosticField` (newline collapse, control-char neutralising,
 *   length caps) before they reach a tool result.
 * - **the toolchain path runs through the sandbox.** `tsc`, `ruff`,
 *   `go vet` and `cargo check` are executed with the same confinement and
 *   resource limits as every other command Aurora runs. LSP servers are
 *   read-only project processes spawned with a scrubbed environment, bounded
 *   strictly: `MAX_LSP_SERVERS` live instances, per-request timeouts,
 *   frame-size caps and a graceful SIGTERM→SIGKILL shutdown.
 * - **evidence is durable and bounded.** Every run is appended with
 *   sequence numbers to the durable diagnostic store; old runs are pruned.
 */
export class CodeIntelligenceService {
  private readonly state: DurableJsonState<DiagnosticsStateShape>;
  private readonly clients = new Map<string, { client: LspClient; touched: number; key: string }>();
  private readonly clientOrder: string[] = [];
  private readonly broken = new Set<string>();
  private closed = false;

  constructor(
    rootPath: string,
    private readonly factory: SandboxFactory,
    private readonly options: CodeIntelligenceOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.state = new DurableJsonState<DiagnosticsStateShape>(
      resolve(rootPath, "code-intelligence", "diagnostics.json"),
      () => ({ schemaVersion: 1, runs: [], sequence: 0 }),
      isState,
      "Code intelligence state",
    );
  }

  // ------------------------------------------------------------------ catalog

  async catalog(workspacePath: string): Promise<{
    detection: LanguageDetection;
    lspEnabled: boolean;
    servers: Array<{ serverId: string; label: string; available: boolean; executable?: string }>;
    toolchains: Array<{ id: string; label: string; available: boolean; reason: string }>;
  }> {
    const detection = await detectLanguages(workspacePath);
    const servers: Array<{ serverId: string; label: string; available: boolean; executable?: string }> = [];
    const toolchains: Array<{ id: string; label: string; available: boolean; reason: string }> = [];
    for (const profile of detection.languages) {
      if (profile.serverId) {
        const resolved = await this.resolveServer(profile, workspacePath);
        servers.push({
          serverId: profile.serverId,
          label: profile.label,
          available: Boolean(resolved),
          ...(resolved ? { executable: resolved.executable } : {}),
        });
      }
      toolchains.push(await this.describeToolchain(profile, workspacePath));
    }
    return { detection, lspEnabled: (this.options.lsp ?? true), servers, toolchains };
  }

  private async describeToolchain(profile: LanguageProfile, workspacePath: string): Promise<{ id: string; label: string; available: boolean; reason: string }> {
    if (profile.languageId === "typescript") {
      const hasConfig = await stat(resolve(workspacePath, "tsconfig.json")).then(() => true).catch(() => false);
      if (!hasConfig) return { id: "tsc", label: "TypeScript compiler (tsc --noEmit)", available: false, reason: "No tsconfig.json in the workspace root." };
      const local = await stat(resolve(workspacePath, "node_modules", ".bin", "tsc")).then(() => true).catch(() => false);
      const global = await findOnPath("tsc");
      const npx = await findOnPath("npx");
      return {
        id: "tsc", label: "TypeScript compiler (tsc --noEmit)", available: local || Boolean(global) || Boolean(npx),
        reason: local ? "tsc from workspace node_modules" : global ? `tsc from PATH (${global})` : npx ? "tsc via npx --no-install" : "No tsc or npx on PATH.",
      };
    }
    if (profile.languageId === "python") {
      const ruff = await findOnPath("ruff");
      const python = await findOnPath("python3") ?? await findOnPath("python");
      return {
        id: "python", label: "Python (ruff or AST syntax check)", available: Boolean(ruff) || Boolean(python),
        reason: ruff ? `ruff from PATH (${ruff})` : python ? "python3 AST parse" : "No ruff or python3 on PATH.",
      };
    }
    if (profile.languageId === "go") {
      const go = await findOnPath("go");
      return { id: "go", label: "Go (go vet ./...)", available: Boolean(go), reason: go ? `go from PATH (${go})` : "No go on PATH." };
    }
    if (profile.languageId === "rust") {
      const cargo = await findOnPath("cargo");
      return { id: "rust", label: "Rust (cargo check)", available: Boolean(cargo), reason: cargo ? `cargo from PATH (${cargo})` : "No cargo on PATH." };
    }
    return { id: "none", label: profile.label, available: false, reason: "No diagnostics toolchain for this language." };
  }

  private async resolveServer(profile: LanguageProfile, workspacePath: string): Promise<ResolvedServer | undefined> {
    if (!profile.serverId) return undefined;
    const overrideBinary = this.options.serverBinaries?.[profile.serverId];
    if (overrideBinary) {
      return { executable: overrideBinary, args: this.options.serverArgs?.[profile.serverId] ?? profile.serverArgs };
    }
    const executable = await findExecutable(profile.serverBinaries, workspacePath);
    if (!executable) return undefined;
    return { executable, args: profile.serverArgs };
  }

  // ------------------------------------------------------------------ lifecycle

  private async clientFor(serverId: string, rootPath: string, resolved: ResolvedServer): Promise<LspClient | undefined> {
    const key = `${serverId}|${rootPath}`;
    if (this.broken.has(key) || this.closed) return undefined;
    const existing = this.clients.get(key);
    if (existing) {
      const index = this.clientOrder.indexOf(key);
      if (index >= 0) this.clientOrder.splice(index, 1);
      this.clientOrder.push(key);
      existing.touched = this.now();
      return existing.client;
    }
    const maxServers = auroraInteger(this.options.maxLspServers ?? MAX_LSP_SERVERS, 1, 8, "Max LSP servers");
    while (this.clients.size >= maxServers) {
      const evictKey = this.clientOrder.shift();
      if (!evictKey) break;
      const entry = this.clients.get(evictKey);
      if (entry) {
        this.clients.delete(evictKey);
        await entry.client.dispose().catch(() => undefined);
      }
    }
    const client = new LspClient({
      rootPath,
      serverId,
      executable: resolved.executable,
      args: resolved.args,
      env: profileEnv(serverId),
    });
    try {
      await client.start();
    } catch (error) {
      this.broken.add(key);
      await client.dispose().catch(() => undefined);
      return undefined;
    }
    this.clients.set(key, { client, touched: this.now(), key });
    this.clientOrder.push(key);
    return client;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const entries = [...this.clients.values()];
    this.clients.clear();
    this.clientOrder.length = 0;
    await Promise.allSettled(entries.map(async (entry) => await entry.client.shutdown().catch(() => undefined)));
  }

  // ------------------------------------------------------------------ diagnostics

  private async resolveFiles(profile: LanguageProfile, workspacePath: string, requested?: string[]): Promise<ResolvedFile[]> {
    const candidates: string[] = [];
    if (requested && requested.length > 0) {
      for (const item of requested) {
        if (candidates.length >= MAX_DIAGNOSTIC_FILES) break;
        const absolute = resolve(workspacePath, item);
        if (absolute !== workspacePath && !absolute.startsWith(`${workspacePath}/`) && !absolute.startsWith(`${workspacePath}\\`)) continue;
        candidates.push(absolute);
      }
    } else {
      const walked = await walkWorkspaceFiles(workspacePath, { maxFiles: 4000 });
      for (const file of walked) {
        if (candidates.length >= MAX_DIAGNOSTIC_FILES) break;
        if (profile.extensions.some((extension) => file.path.toLowerCase().endsWith(extension))) candidates.push(file.path);
      }
    }
    const files: ResolvedFile[] = [];
    for (const absolute of candidates) {
      if (files.length >= MAX_DIAGNOSTIC_FILES) break;
      const info = await stat(absolute).catch(() => undefined);
      if (!info || !info.isFile() || info.size > MAX_FILE_READ_BYTES) continue;
      const text = await readFile(absolute, "utf8").catch(() => "");
      if (!text && info.size > 0) continue;
      files.push({ absolute, relativePath: relativePath(workspacePath, absolute), languageId: profile.languageId, text });
    }
    return files;
  }

  private async runLspDiagnostics(
    profile: LanguageProfile,
    workspacePath: string,
    files: ResolvedFile[],
    severities: Set<Severity>,
  ): Promise<Omit<DiagnosticRun, "id" | "tenantId" | "sessionId" | "workspacePath" | "sequence"> | undefined> {
    const serverId = profile.serverId;
    if (!serverId) return undefined;
    const server = await this.resolveServer(profile, workspacePath);
    if (!server) return undefined;
    const client = await this.clientFor(serverId, workspacePath, server);
    if (!client) return undefined;
    const started = this.now();
    const open: Array<{ uri: string; version: number; relativePath: string; text: string }> = [];
    try {
      for (const file of files) {
        const uri = `file://${encodeURI(file.absolute.replace(/\\/g, "/"))}`;
        const version = client.openDocument(uri, file.languageId, file.text);
        open.push({ uri, version, relativePath: file.relativePath, text: file.text });
      }
      await Promise.all(open.map(async (item) => {
        await client.waitForDiagnostics(item.uri, item.version, LSP_DIAGNOSTIC_WAIT_MS).catch(() => []);
      }));
    } finally {
      // Nothing to close here: diagnostics are snapshotted from the client
      // store below while documents are still open, then closed after the read.
    }
    const fileResults: FileDiagnostics[] = [];
    let total = 0;
    for (const item of open) {
      if (total >= MAX_TOTAL_DIAGNOSTICS) break;
      const diagnostics = client.currentDiagnostics(item.uri)
        .filter((diagnostic) => severities.has(diagnostic.severity))
        .slice(0, MAX_DIAGNOSTICS_PER_FILE);
      total += diagnostics.length;
      fileResults.push({ path: item.relativePath, digest: digestOf(item.text), diagnostics: boundDiagnostics(diagnostics, workspacePath) });
    }
    for (const item of open) client.closeDocument(item.uri);
    return {
      languageId: profile.languageId,
      languageLabel: profile.label,
      backend: "lsp",
      serverId,
      files: fileResults,
      counts: countBySeverity(fileResults),
      durationMs: this.now() - started,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(this.now()).toISOString(),
      reason: `${profile.serverId} reported ${countBySeverity(fileResults).total} diagnostic(s) across ${fileResults.length} file(s).`,
    };
  }

  private async runToolchainDiagnostics(
    profile: LanguageProfile,
    workspacePath: string,
    files: ResolvedFile[],
    signal?: AbortSignal,
  ): Promise<Omit<DiagnosticRun, "id" | "tenantId" | "sessionId" | "workspacePath" | "sequence">> {
    const target = await this.describeToolchain(profile, workspacePath);
    const started = this.now();
    const command = this.toolchainCommand(profile, workspacePath, files);
    if (!command) {
      return {
        languageId: profile.languageId,
        languageLabel: profile.label,
        backend: "none",
        toolchainId: target.id,
        files: [],
        counts: countBySeverity([]),
        durationMs: 0,
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date(started).toISOString(),
        reason: target.reason,
      };
    }
    const sandbox = await this.factory(workspacePath);
    let output = "";
    let exitCode: number | null = null;
    let timedOut = false;
    try {
      const result = await sandbox.exec({
        command,
        timeoutMs: this.options.toolchainTimeoutMs ?? DEFAULT_TOOLCHAIN_TIMEOUT_MS,
        maxOutputChars: 200_000,
        ...(signal ? { signal } : {}),
      });
      output = result.stdout;
      exitCode = result.exitCode;
      timedOut = result.timedOut;
    } finally {
      await sandbox.destroy().catch(() => undefined);
    }
    const parsed = this.parseToolchainOutput(profile, output);
    const byPath = new Map<string, NormalizedDiagnostic[]>();
    for (const item of parsed) {
      const key = normalizeToolchainPath(workspacePath, item.path);
      const list = byPath.get(key) ?? [];
      list.push({ ...item, path: key });
      byPath.set(key, list);
    }
    const fileResults: FileDiagnostics[] = [];
    const severities = new Set<Severity>(SEVERITY_VALUES);
    let total = 0;
    for (const file of files) {
      if (total >= MAX_TOTAL_DIAGNOSTICS) break;
      const diagnostics = (byPath.get(file.relativePath) ?? [])
        .filter((item) => severities.has(item.severity))
        .slice(0, MAX_DIAGNOSTICS_PER_FILE);
      if (diagnostics.length === 0) continue;
      total += diagnostics.length;
      fileResults.push({
        path: file.relativePath,
        digest: digestOf(file.text),
        diagnostics,
      });
    }
    const counts = countBySeverity(fileResults);
    return {
      languageId: profile.languageId,
      languageLabel: profile.label,
      backend: "toolchain",
      toolchainId: target.id,
      toolchainCommand: command,
      files: fileResults,
      counts,
      durationMs: this.now() - started,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(this.now()).toISOString(),
      reason: timedOut
        ? `${target.label} timed out after ${this.options.toolchainTimeoutMs ?? DEFAULT_TOOLCHAIN_TIMEOUT_MS}ms.`
        : exitCode !== 0
          ? `${target.label} exited with ${exitCode}; ${counts.total} diagnostic(s) parsed.`
          : `${target.label} reported ${counts.total} diagnostic(s).`,
    };
  }

  private toolchainCommand(profile: LanguageProfile, workspacePath: string, files: ResolvedFile[]): string | undefined {
    const paths = files.map((file) => shellQuote(file.relativePath)).join(" ");
    if (profile.languageId === "typescript") {
      const localTsc = resolve(workspacePath, "node_modules", ".bin", "tsc");
      if (existsSync(localTsc)) return `${shellQuote(localTsc)} --noEmit --pretty false`;
      return "npx --no-install tsc --noEmit --pretty false || tsc --noEmit --pretty false";
    }
    if (profile.languageId === "python") {
      // Ruff is tried first when installed; otherwise a pure-AST syntax check
      // (read-only: no .pyc files, so the check cannot dirty the workspace).
      const astScript = "import ast,json,sys\nfor p in sys.argv[1:]:\n try:\n  ast.parse(open(p,encoding='utf-8').read(),filename=p)\n except SyntaxError as e:\n  print(json.dumps({'path':p,'line':e.lineno or 1,'column':e.offset or 1,'message':e.msg,'code':'SyntaxError'}))\n";
      return `if command -v ruff >/dev/null 2>&1; then ruff check --output-format=json ${paths || "."}; else python3 -c ${shellQuote(astScript)} ${paths}; fi`;
    }
    if (profile.languageId === "go") return `go vet ./...`;
    if (profile.languageId === "rust") return `cargo check --message-format=json 2>/dev/null | grep -E '^\\{' || cargo check`;
    return undefined;
  }

  private parseToolchainOutput(profile: LanguageProfile, output: string): NormalizedDiagnostic[] {
    const results: NormalizedDiagnostic[] = [];
    if (profile.languageId === "typescript") {
      const re = /^(.+?)\((\d+),(\d+)\):\s*(error|warning|info)\s+(TS\d+):\s*(.*)$/gm;
      let match: RegExpExecArray | null;
      while ((match = re.exec(output)) !== null) {
        if (results.length >= MAX_TOTAL_DIAGNOSTICS) break;
        results.push({
          path: match[1]!,
          line: Number(match[2]),
          column: Number(match[3]),
          severity: severityOf(match[4]),
          message: match[6]!.slice(0, 300),
          source: "typescript",
          code: match[5]!,
        });
      }
    } else if (profile.languageId === "python") {
      for (const line of output.split("\n")) {
        if (results.length >= MAX_TOTAL_DIAGNOSTICS) break;
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as { path?: string; line?: number; column?: number; message?: string; code?: string };
          if (!parsed.path) continue;
          results.push({
            path: parsed.path,
            line: parsed.line ?? 1,
            column: parsed.column ?? 1,
            severity: "error",
            message: String(parsed.message ?? "Syntax error").slice(0, 300),
            source: "python",
            code: String(parsed.code ?? "SyntaxError"),
          });
        } catch {
          // Not a JSON line; skip.
        }
      }
    } else if (profile.languageId === "go") {
      const re = /^([^:]+?):(\d+):(\d+):\s*(.*)$/gm;
      let match: RegExpExecArray | null;
      while ((match = re.exec(output)) !== null) {
        if (results.length >= MAX_TOTAL_DIAGNOSTICS) break;
        results.push({
          path: match[1]!,
          line: Number(match[2]),
          column: Number(match[3]),
          severity: "error",
          message: match[4]!.slice(0, 300),
          source: "go",
          code: "go-vet",
        });
      }
    } else if (profile.languageId === "rust") {
      for (const line of output.split("\n")) {
        if (results.length >= MAX_TOTAL_DIAGNOSTICS) break;
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as {
            reason?: string;
            message?: { message?: string; code?: { code?: string } | string | null; level?: string; spans?: Array<{ file_name?: string; line_start?: number; column_start?: number }> };
          };
          if (parsed.reason !== "compiler-message" || !parsed.message) continue;
          const span = parsed.message.spans?.[0];
          if (!span?.file_name) continue;
          results.push({
            path: span.file_name,
            line: span.line_start ?? 1,
            column: span.column_start ?? 1,
            severity: severityOf(parsed.message.level),
            message: String(parsed.message.message ?? "").slice(0, 300),
            source: "rust",
            code: typeof parsed.message.code === "object" ? parsed.message.code?.code ?? "" : String(parsed.message.code ?? ""),
          });
        } catch {
          // Skip non-JSON cargo lines.
        }
      }
    }
    return results;
  }

  async runDiagnostics(input: {
    tenantId: string;
    sessionId: string;
    workspacePath: string;
    files?: string[];
    severities?: Severity[];
    forceToolchain?: boolean;
    signal?: AbortSignal;
  }): Promise<DiagnosticRun> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const sessionId = auroraText(input.sessionId, 200, "Session ID");
    const severities = new Set<Severity>(input.severities?.length ? input.severities : ["error"]);
    const detection = await detectLanguages(input.workspacePath);
    const profile = input.files?.length
      ? profileFor(input.files[0]!) ?? LANGUAGE_PROFILES.find((item) => item.languageId === detection.primaryLanguageId)
      : LANGUAGE_PROFILES.find((item) => item.languageId === detection.primaryLanguageId);
    if (!profile) {
      const run: DiagnosticRun = {
        id: `code-diagnostics-${randomUUID()}`,
        tenantId,
        sessionId,
        workspacePath: input.workspacePath,
        languageId: null,
        languageLabel: "Unknown",
        backend: "none",
        files: [],
        counts: countBySeverity([]),
        durationMs: 0,
        startedAt: new Date(this.now()).toISOString(),
        finishedAt: new Date(this.now()).toISOString(),
        sequence: 0,
        reason: detection.markers.length > 0
          ? `No diagnostics toolchain covers ${detection.markers.join(", ")}.`
          : "No supported source language detected in this workspace.",
      };
      return await this.record(run);
    }
    const files = await this.resolveFiles(profile, input.workspacePath, input.files);
    let produced: Omit<DiagnosticRun, "id" | "tenantId" | "sessionId" | "workspacePath" | "sequence">;
    if ((this.options.lsp ?? true) && !input.forceToolchain) {
      produced = await this.runLspDiagnostics(profile, input.workspacePath, files, severities)
        ?? await this.runToolchainDiagnostics(profile, input.workspacePath, files, input.signal);
    } else {
      produced = await this.runToolchainDiagnostics(profile, input.workspacePath, files, input.signal);
    }
    const run: DiagnosticRun = {
      id: `code-diagnostics-${randomUUID()}`,
      tenantId,
      sessionId,
      workspacePath: input.workspacePath,
      ...produced,
      sequence: 0,
    };
    return await this.record(run);
  }

  private async record(run: DiagnosticRun): Promise<DiagnosticRun> {
    return await this.state.mutate((state) => {
      state.sequence += 1;
      run.sequence = state.sequence;
      state.runs.push(run);
      if (state.runs.length > MAX_DIAGNOSTIC_RUNS) state.runs.splice(0, state.runs.length - MAX_DIAGNOSTIC_RUNS);
      return structuredClone(run);
    });
  }

  async list(filter: { tenantId: string; sessionId?: string | undefined; limit?: number | undefined }): Promise<DiagnosticRun[]> {
    const state = await this.state.read();
    return state.runs
      .filter((run) => run.tenantId === filter.tenantId)
      .filter((run) => (filter.sessionId ? run.sessionId === filter.sessionId : true))
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, auroraInteger(filter.limit ?? 10, 1, MAX_DIAGNOSTIC_RUNS, "Diagnostics limit"))
      .map((run) => structuredClone(run));
  }

  /**
   * The diagnostics a session can point at. `fresh` is computed from content
   * digests, not timestamps: a run stays fresh only while every file it
   * described still has the exact text the server saw.
   */
  async latest(tenantId: string, sessionId: string): Promise<{ run?: DiagnosticRun; fresh: boolean; message: string }> {
    const [run] = await this.list({ tenantId, sessionId, limit: 1 });
    if (!run) return { fresh: false, message: "This session has not run diagnostics yet." };
    let fresh = true;
    let staleFiles = 0;
    for (const file of run.files) {
      const absolute = resolve(run.workspacePath, file.path);
      try {
        const content = await readFile(absolute, "utf8");
        if (digestOf(content) !== file.digest) {
          fresh = false;
          staleFiles++;
        }
      } catch {
        fresh = false;
        staleFiles++;
      }
    }
    return {
      run,
      fresh,
      message: fresh
        ? `Diagnostics from ${run.finishedAt} are current (${run.counts.total} across ${run.counts.files} file(s)).`
        : `Diagnostics from ${run.finishedAt} are stale (${staleFiles} file(s) changed since).`,
    };
  }

  // ------------------------------------------------------------------ symbols

  private async readResolvedFile(workspacePath: string, filePath: string): Promise<ResolvedFile | undefined> {
    const absolute = resolve(workspacePath, filePath);
    if (absolute !== workspacePath && !absolute.startsWith(`${workspacePath}/`) && !absolute.startsWith(`${workspacePath}\\`)) return undefined;
    const info = await stat(absolute).catch(() => undefined);
    if (!info || !info.isFile() || info.size > MAX_SCANNED_FILE_BYTES) return undefined;
    const text = await readFile(absolute, "utf8").catch(() => "");
    const language = languageOf(absolute);
    if (!language) return undefined;
    return { absolute, relativePath: relativePath(workspacePath, absolute), languageId: language, text };
  }

  async symbols(input: { tenantId: string; sessionId: string; workspacePath: string; path?: string | undefined }): Promise<{
    backend: "lsp" | "builtin" | "none";
    languageId: string | null;
    files: number;
    symbols: CodeSymbol[];
    truncated: boolean;
    generatedAt: string;
  }> {
    auroraText(input.tenantId, 200, "Tenant ID");
    auroraText(input.sessionId, 200, "Session ID");
    if (input.path) {
      const file = await this.readResolvedFile(input.workspacePath, input.path);
      if (file) {
        const profile = profileFor(file.absolute);
        if (profile?.serverId && (this.options.lsp ?? true)) {
          const resolved = await this.resolveServer(profile, input.workspacePath);
          const client = resolved ? await this.clientFor(profile.serverId, input.workspacePath, resolved) : undefined;
          if (client) {
            const uri = `file://${encodeURI(file.absolute.replace(/\\/g, "/"))}`;
            try {
              client.openDocument(uri, file.languageId, file.text);
              const raw = (await client.documentSymbols(uri)) as unknown;
              return this.fromLspSymbols(raw, file, input.workspacePath);
            } catch (error) {
              // LSP failed; fall through to the built-in scanner rather than failing the call.
              void error;
            } finally {
              client.closeDocument(uri);
            }
          }
        }
        const scanned = scanSymbols(file.text, languageOf(file.absolute) ?? "typescript");
        return {
          backend: "builtin",
          languageId: languageOf(file.absolute) ?? null,
          files: 1,
          symbols: scanned.map((symbol) => this.toCodeSymbol(symbol, file.relativePath)),
          truncated: scanned.length >= MAX_SYMBOLS_PER_FILE,
          generatedAt: new Date(this.now()).toISOString(),
        };
      }
    }
    const detection = await detectLanguages(input.workspacePath);
    const language = detection.primaryLanguageId ?? "typescript";
    const walked = await walkWorkspaceFiles(input.workspacePath, { maxFiles: MAX_SYMBOL_FILES * 4 });
    const symbols: CodeSymbol[] = [];
    let files = 0;
    let truncated = false;
    for (const file of walked) {
      if (files >= MAX_SYMBOL_FILES || symbols.length >= MAX_SYMBOLS_TOTAL) {
        truncated = true;
        break;
      }
      const fileLanguage = languageOf(file.path);
      if (!fileLanguage || fileLanguage !== language) continue;
      if (file.size > MAX_SCANNED_FILE_BYTES) continue;
      const text = await readFile(file.path, "utf8").catch(() => "");
      if (!text && file.size > 0) continue;
      const scanned = scanSymbols(text, fileLanguage);
      files++;
      for (const symbol of scanned) {
        symbols.push(this.toCodeSymbol(symbol, relativePath(input.workspacePath, file.path)));
        if (symbols.length >= MAX_SYMBOLS_TOTAL) {
          truncated = true;
          break;
        }
      }
    }
    return {
      backend: "builtin",
      languageId: language,
      files,
      symbols,
      truncated,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  private toCodeSymbol(symbol: ScannedSymbol, path: string): CodeSymbol {
    return {
      name: symbol.name,
      kind: symbol.kind,
      path,
      line: symbol.line,
      column: symbol.column,
      endLine: symbol.endLine,
      ...(symbol.container ? { container: symbol.container } : {}),
      ...(symbol.signature ? { detail: symbol.signature } : {}),
    };
  }

  private fromLspSymbols(
    raw: unknown,
    file: ResolvedFile,
    workspacePath: string,
  ): { backend: "lsp"; languageId: string | null; files: number; symbols: CodeSymbol[]; truncated: boolean; generatedAt: string } {
    const symbols: CodeSymbol[] = [];
    const visit = (items: unknown[]): void => {
      if (symbols.length >= MAX_SYMBOLS_PER_FILE) return;
      for (const item of items) {
        const symbol = item as { name?: string; kind?: number; range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } }; selectionRange?: { start?: { line?: number; character?: number } }; detail?: string; children?: unknown[] } | undefined;
        if (!symbol?.name) continue;
        symbols.push({
          name: symbol.name,
          kind: LSP_SYMBOL_KINDS[symbol.kind ?? 0] ?? "variable",
          path: file.relativePath,
          line: (symbol.range?.start?.line ?? 0) + 1,
          column: (symbol.range?.start?.character ?? 0) + 1,
          endLine: (symbol.range?.end?.line ?? symbol.range?.start?.line ?? 0) + 1,
          ...(symbol.detail ? { detail: symbol.detail.slice(0, 200) } : {}),
        });
        if (Array.isArray(symbol.children)) visit(symbol.children);
      }
    };
    if (Array.isArray(raw)) visit(raw);
    else if (raw && typeof raw === "object") visit([raw]);
    return {
      backend: "lsp",
      languageId: file.languageId,
      files: 1,
      symbols,
      truncated: symbols.length >= MAX_SYMBOLS_PER_FILE,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  // ------------------------------------------------------------------ definition & references

  private tokenAt(file: ResolvedFile, line: number, column: number): { name: string; line: number; column: number } | undefined {
    const cleaned = stripNonCode(file.text, languageOf(file.absolute) ?? "typescript");
    const index = indexOfPosition(cleaned, line, column);
    const token = identifierAt(cleaned, index);
    if (!token) return undefined;
    return { name: token.name, line, column };
  }

  private async definitionCandidates(workspacePath: string, name: string): Promise<DefinitionCandidate[]> {
    const walked = await walkWorkspaceFiles(workspacePath, { maxFiles: MAX_SYMBOL_FILES * 4 });
    const candidates: DefinitionCandidate[] = [];
    for (const file of walked) {
      if (file.size > MAX_SCANNED_FILE_BYTES) continue;
      const language = languageOf(file.path);
      if (!language) continue;
      const text = await readFile(file.path, "utf8").catch(() => "");
      if (!text && file.size > 0) continue;
      const symbols = scanSymbols(text, language);
      for (const symbol of symbols) {
        if (symbol.name !== name) continue;
        candidates.push({
          path: relativePath(workspacePath, file.path),
          line: symbol.line,
          column: symbol.column,
          name: symbol.name,
          kind: symbol.kind,
          ...(symbol.container ? { container: symbol.container } : {}),
        });
        if (candidates.length >= 10) return candidates;
      }
    }
    return candidates;
  }

  async definition(input: { tenantId: string; sessionId: string; workspacePath: string; path: string; line: number; column: number }): Promise<{
    backend: "lsp" | "builtin" | "none";
    name: string | null;
    candidates: DefinitionCandidate[];
  }> {
    auroraText(input.tenantId, 200, "Tenant ID");
    auroraText(input.sessionId, 200, "Session ID");
    const file = await this.readResolvedFile(input.workspacePath, input.path);
    if (!file) return { backend: "none", name: null, candidates: [] };
    const token = this.tokenAt(file, input.line, input.column);
    if (!token) return { backend: "none", name: null, candidates: [] };
    const profile = profileFor(file.absolute);
    if (profile?.serverId && (this.options.lsp ?? true)) {
      const resolved = await this.resolveServer(profile, input.workspacePath);
      const client = resolved ? await this.clientFor(profile.serverId, input.workspacePath, resolved) : undefined;
      if (client) {
        const uri = `file://${encodeURI(file.absolute.replace(/\\/g, "/"))}`;
        try {
          client.openDocument(uri, file.languageId, file.text);
          const raw = (await client.definition(uri, input.line - 1, input.column - 1)) as unknown;
          const locations = this.fromLspLocations(raw, input.workspacePath);
          if (locations.length > 0) {
            const candidates = locations.map((item) => ({ ...item, name: token.name, kind: "symbol" }));
            return { backend: "lsp", name: token.name, candidates };
          }
        } catch {
          // Fall through.
        } finally {
          client.closeDocument(uri);
        }
      }
    }
    const candidates = await this.definitionCandidates(input.workspacePath, token.name);
    return { backend: candidates.length > 0 ? "builtin" : "none", name: token.name, candidates };
  }

  async references(input: {
    tenantId: string;
    sessionId: string;
    workspacePath: string;
    path: string;
    line: number;
    column: number;
    includeDeclaration?: boolean | undefined;
  }): Promise<{
    backend: "lsp" | "builtin" | "none";
    name: string | null;
    occurrences: ReferenceOccurrence[];
    total: number;
    truncated: boolean;
  }> {
    auroraText(input.tenantId, 200, "Tenant ID");
    auroraText(input.sessionId, 200, "Session ID");
    const file = await this.readResolvedFile(input.workspacePath, input.path);
    if (!file) return { backend: "none", name: null, occurrences: [], total: 0, truncated: false };
    const token = this.tokenAt(file, input.line, input.column);
    if (!token) return { backend: "none", name: null, occurrences: [], total: 0, truncated: false };
    const profile = profileFor(file.absolute);
    if (profile?.serverId && (this.options.lsp ?? true)) {
      const resolved = await this.resolveServer(profile, input.workspacePath);
      const client = resolved ? await this.clientFor(profile.serverId, input.workspacePath, resolved) : undefined;
      if (client) {
        const uri = `file://${encodeURI(file.absolute.replace(/\\/g, "/"))}`;
        try {
          client.openDocument(uri, file.languageId, file.text);
          const raw = (await client.references(uri, input.line - 1, input.column - 1, input.includeDeclaration ?? false)) as unknown;
          const occurrences = this.fromLspLocations(raw, input.workspacePath).map((item) => ({
            path: item.path,
            line: item.line,
            column: item.column,
            length: Math.max(1, token.name.length),
            ...(item.path === file.relativePath && item.line === input.line && item.column === input.column ? { requested: true } : {}),
          }));
          return {
            backend: "lsp",
            name: token.name,
            occurrences: occurrences.slice(0, MAX_OCCURRENCES),
            total: occurrences.length,
            truncated: occurrences.length > MAX_OCCURRENCES,
          };
        } catch {
          // Fall through to the scanner.
        } finally {
          client.closeDocument(uri);
        }
      }
    }
    const walked = await walkWorkspaceFiles(input.workspacePath, { maxFiles: MAX_SYMBOL_FILES * 4 });
    const occurrences: ReferenceOccurrence[] = [];
    for (const walkedFile of walked) {
      if (occurrences.length >= MAX_OCCURRENCES) break;
      if (walkedFile.size > MAX_SCANNED_FILE_BYTES) continue;
      const language = languageOf(walkedFile.path);
      if (!language) continue;
      const text = await readFile(walkedFile.path, "utf8").catch(() => "");
      if (!text && walkedFile.size > 0) continue;
      const cleaned = stripNonCode(text, language);
      for (const found of findOccurrences(cleaned, token.name, MAX_OCCURRENCES - occurrences.length)) {
        occurrences.push({
          path: relativePath(input.workspacePath, walkedFile.path),
          line: found.line,
          column: found.column,
          length: found.length,
          ...(relativePath(input.workspacePath, walkedFile.path) === file.relativePath && found.line === input.line && found.column === input.column ? { requested: true } : {}),
        });
        if (occurrences.length >= MAX_OCCURRENCES) break;
      }
    }
    return {
      backend: occurrences.length > 0 ? "builtin" : "none",
      name: token.name,
      occurrences,
      total: occurrences.length,
      truncated: occurrences.length >= MAX_OCCURRENCES,
    };
  }

  private fromLspLocations(raw: unknown, workspacePath: string): Array<{ path: string; line: number; column: number }> {
    const results: Array<{ path: string; line: number; column: number }> = [];
    const add = (value: unknown): void => {
      if (results.length >= MAX_OCCURRENCES) return;
      const location = value as { uri?: string; range?: { start?: { line?: number; character?: number } }; targetUri?: string; targetRange?: { start?: { line?: number; character?: number } } } | undefined;
      const uri = location?.targetUri ?? location?.uri;
      const range = location?.targetRange ?? location?.range;
      if (!uri || !range?.start) return;
      const normalized = normalizeDiagnostic(uri, {
        range: {
          start: { line: range.start.line ?? 0, character: range.start.character ?? 0 },
          end: { line: range.start.line ?? 0, character: range.start.character ?? 0 },
        },
        message: "",
      });
      results.push({ path: relativePath(workspacePath, normalized.path), line: normalized.line, column: normalized.column });
    };
    if (Array.isArray(raw)) for (const item of raw) add(item);
    else if (raw && typeof raw === "object") add(raw);
    return results;
  }

  // ------------------------------------------------------- P1.38 additions

  /**
   * P1.38 dependency graph: a bounded, honest import scanner over the
   * workspace. Relative imports are resolved to workspace files and reported
   * as edges; package specifiers are reported as external dependencies
   * without pretending to know their versions. This is a scanner, not a
   * parser — the same honesty rule as the fallback symbol scanner.
   */
  async dependencies(workspacePath: string): Promise<{
    files: number;
    edges: Array<{ from: string; to: string }>;
    external: Array<{ from: string; specifier: string }>;
    capped: boolean;
  }> {
    const MAX_DEP_FILES = 2_000;
    const MAX_EDGES = 5_000;
    const SKIP = new Set([".git", "node_modules", ".venv", "dist", "build", "target", "__pycache__", "coverage"]);
    const collected: string[] = [];
    let capped = false;
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (collected.length >= MAX_DEP_FILES) {
          capped = true;
          return;
        }
        if (SKIP.has(entry.name)) continue;
        const full = resolve(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && /\.(?:ts|tsx|js|jsx|mjs|cjs|py)$/.test(entry.name)) collected.push(full);
      }
    };
    await walk(workspacePath);
    const edges: Array<{ from: string; to: string }> = [];
    const external: Array<{ from: string; specifier: string }> = [];
    for (const file of collected) {
      const from = relative(workspacePath, file).split("\\").join("/");
      const content = (await readFile(file, "utf8").catch(() => "")).slice(0, MAX_SCANNED_FILE_BYTES);
      const specifiers = new Set<string>();
      for (const match of content.matchAll(/^\s*import\s+(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/gm)) specifiers.add(match[1]!);
      for (const match of content.matchAll(/^\s*export\s+[^\n'";]*?\sfrom\s+["']([^"']+)["']/gm)) specifiers.add(match[1]!);
      for (const match of content.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(match[1]!);
      for (const match of content.matchAll(/^\s*import\s+([A-Za-z_][\w.]*)/gm)) specifiers.add(`py:${match[1]!}`);
      for (const match of content.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+/gm)) specifiers.add(`py:${match[1]!}`);
      for (const rawSpecifier of specifiers) {
        if (rawSpecifier.startsWith("py:")) {
          const specifier = rawSpecifier.slice(3)!;
          if (/^[a-z]/.test(specifier)) external.push({ from, specifier });
          else edges.push({ from, to: specifier });
          continue;
        }
        if (!rawSpecifier.startsWith(".") && !rawSpecifier.startsWith("/")) {
          external.push({ from, specifier: rawSpecifier });
          continue;
        }
        const resolved = await this.resolveImport(workspacePath, file, rawSpecifier);
        if (resolved) edges.push({ from, to: resolved });
      }
      if (edges.length + external.length > MAX_EDGES) {
        capped = true;
        break;
      }
    }
    return { files: collected.length, edges, external, capped };
  }

  private async resolveImport(workspacePath: string, importer: string, specifier: string): Promise<string | undefined> {
    const base = resolve(importer, "..", specifier);
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.py`, resolve(base, "index.ts"), resolve(base, "index.js")];
    for (const candidate of candidates) {
      if (await stat(candidate).then(() => true, () => false)) {
        const rel = relative(workspacePath, candidate).split("\\").join("/");
        if (rel.startsWith("..")) return undefined;
        return rel;
      }
    }
    return undefined;
  }

  /**
   * P1.38 patch generation: a line-level unified diff between two contents of
   * the same file, in exactly the format `filesystem.patch` applies — so a
   * generated patch can be verified by applying it. Files are capped because
   * the diff is computed in memory; a file too large to diff here is refused
   * rather than diffed approximately.
   */
  generatePatch(edits: ReadonlyArray<{ path: string; before: string; after: string }>): string {
    const MAX_DIFF_FILES = 50;
    const MAX_DIFF_LINES = 2_000;
    if (!edits.length || edits.length > MAX_DIFF_FILES) throw new Error(`Patch generation takes 1-${MAX_DIFF_FILES} files.`);
    const chunks: string[] = [];
    for (const edit of edits) {
      const before = edit.before.split("\n");
      const after = edit.after.split("\n");
      if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) {
        throw new Error(`File "${edit.path}" is too large for in-memory patch generation (>${MAX_DIFF_LINES} lines).`);
      }
      const operations = diffLines(before, after);
      if (!operations.some((operation) => operation.kind !== "same")) continue;
      // Number every operation with its original/new line so hunk headers stay
      // correct even when consecutive hunks share context lines. `filesystem.patch`
      // applies hunks bottom-up from `oldStart`, so a header that drifts even one
      // line refuses to apply — which is exactly the safety property wanted.
      let oldCounter = 1;
      let newCounter = 1;
      const numbered = operations.map((operation) => {
        const entry = {
          ...operation,
          ...(operation.kind !== "add" ? { oldNo: oldCounter++ } : {}),
          ...(operation.kind !== "remove" ? { newNo: newCounter++ } : {}),
        };
        return entry;
      });
      const hunks: Array<typeof numbered> = [];
      let current: typeof numbered = [];
      for (const entry of numbered) {
        if (entry.kind === "same") {
          current.push(entry);
          if (current.length >= 8) {
            hunks.push(current);
            current = [];
          }
        } else {
          current.push(entry);
        }
      }
      if (current.length) hunks.push(current);
      chunks.push(`--- ${edit.path}\n+++ ${edit.path}`);
      for (const hunk of hunks) {
        const removed = hunk.filter((entry) => entry.kind !== "add").length;
        const added = hunk.filter((entry) => entry.kind !== "remove").length;
        const startOld = hunk.find((entry) => entry.kind !== "add")?.oldNo ?? oldCounter;
        const startNew = hunk.find((entry) => entry.kind !== "remove")?.newNo ?? newCounter;
        chunks.push(`@@ -${startOld},${removed} +${startNew},${added} @@`);
        for (const entry of hunk) {
          if (entry.kind === "same") chunks.push(` ${entry.text}`);
          else if (entry.kind === "add") chunks.push(`+${entry.text}`);
          else chunks.push(`-${entry.text}`);
        }
      }
    }
    if (!chunks.length) return "";
    // No trailing newline: `filesystem.patch` splits on "\n" and would read a
    // final empty element as one more context line than the hunk header
    // promised, making the generated patch refuse to apply to itself.
    return chunks.join("\n");
  }

  /**
   * P1.38 refactor verification: compare the workspace's current diagnostics
   * against a recorded baseline run. A refactor is a change that is supposed
   * to preserve behaviour; new errors mean it did not. The verdict vocabulary
   * is deliberately small: `regressed` (new errors), `improved` (errors
   * resolved and none added), `clean` (no change in errors).
   */
  async refactorVerify(input: {
    tenantId: string;
    sessionId: string;
    workspacePath: string;
    baselineRunId: string;
    signal?: AbortSignal;
  }): Promise<{
    baseline: { runId: string; errors: number; warnings: number };
    current: { runId: string; errors: number; warnings: number };
    newErrors: Array<{ path: string; line: number; message: string }>;
    resolvedErrors: Array<{ path: string; line: number; message: string }>;
    verdict: "clean" | "improved" | "regressed";
  }> {
    const state = await this.state.read();
    const baseline = state.runs.find((run) => run.id === input.baselineRunId && run.tenantId === input.tenantId && run.sessionId === input.sessionId);
    if (!baseline) throw new Error("Baseline diagnostics run not found for this tenant and session.");
    const current = await this.runDiagnostics({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const key = (item: { path: string; line: number; message: string }): string => `${item.path}:${item.line}:${item.message}`;
    const baselineErrors = new Set<string>();
    for (const file of baseline.files) {
      for (const diagnostic of file.diagnostics) {
        if (diagnostic.severity === "error") baselineErrors.add(key({ path: file.path, line: diagnostic.line, message: diagnostic.message }));
      }
    }
    const currentErrors = new Set<string>();
    for (const file of current.files) {
      for (const diagnostic of file.diagnostics) {
        if (diagnostic.severity === "error") currentErrors.add(key({ path: file.path, line: diagnostic.line, message: diagnostic.message }));
      }
    }
    const newErrors = [...currentErrors].filter((value) => !baselineErrors.has(value)).map(parseDiagnosticKey);
    const resolvedErrors = [...baselineErrors].filter((value) => !currentErrors.has(value)).map(parseDiagnosticKey);
    const verdict = newErrors.length > 0 ? "regressed" : resolvedErrors.length > 0 ? "improved" : "clean";
    return {
      baseline: { runId: baseline.id, errors: baseline.counts.errors, warnings: baseline.counts.warnings },
      current: { runId: current.id, errors: current.counts.errors, warnings: current.counts.warnings },
      newErrors,
      resolvedErrors,
      verdict,
    };
  }
}

function parseDiagnosticKey(key: string): { path: string; line: number; message: string } {
  const first = key.indexOf(":");
  const second = key.indexOf(":", first + 1);
  return { path: key.slice(0, first), line: Number(key.slice(first + 1, second)), message: key.slice(second + 1) };
}

/** Classic LCS line diff; capped upstream by the line limit. */
function diffLines(before: readonly string[], after: readonly string[]): Array<{ kind: "same" | "add" | "remove"; text: string }> {
  const n = before.length;
  const m = after.length;
  const table = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const match = table[(i + 1) * (m + 1) + (j + 1)] ?? 0;
      const skipBefore = table[(i + 1) * (m + 1) + j] ?? 0;
      const skipAfter = table[i * (m + 1) + (j + 1)] ?? 0;
      table[i * (m + 1) + j] = before[i] === after[j]
        ? match + 1
        : Math.max(skipBefore, skipAfter);
    }
  }
  const operations: Array<{ kind: "same" | "add" | "remove"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      operations.push({ kind: "same", text: before[i]! });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * (m + 1) + j] ?? 0) >= (table[i * (m + 1) + (j + 1)] ?? 0)) {
      operations.push({ kind: "remove", text: before[i]! });
      i += 1;
    } else {
      operations.push({ kind: "add", text: after[j]! });
      j += 1;
    }
  }
  while (i < n) {
    operations.push({ kind: "remove", text: before[i]! });
    i += 1;
  }
  while (j < m) {
    operations.push({ kind: "add", text: after[j]! });
    j += 1;
  }
  return operations;
}

function profileEnv(serverId: string): Record<string, string> {
  if (serverId === "pyright") return { ...(process.env.PYTHON ? { PYTHON: process.env.PYTHON } : {}) };
  return {};
}
