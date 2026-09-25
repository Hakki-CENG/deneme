import { spawn, type ChildProcess } from "node:child_process";
import {
  decodeFrames,
  encodeMessage,
  fileUri,
  LSP_CONTENT_MODIFIED,
  LSP_INITIALIZE_TIMEOUT_MS,
  LSP_REQUEST_TIMEOUT_MS,
  LspProtocolError,
  type LspDiagnostic,
  type NormalizedDiagnostic,
  normalizeDiagnostic,
} from "./protocol.js";

const MAX_OUTPUT_FRAME_CHARS = 16 * 1024 * 1024;
const CONTENT_MODIFIED_RETRY_DELAYS_MS = [250, 500, 1000];

function scrubEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL"];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(extra)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) environment[name] = value;
  }
  return environment;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

interface DiagnosticsCacheEntry {
  version: number | undefined;
  items: LspDiagnostic[];
}

interface DiagnosticsWaiter {
  minVersion: number;
  resolve: (value: NormalizedDiagnostic[]) => void;
  timer: NodeJS.Timeout;
}

export interface LspClientOptions {
  rootPath: string;
  serverId: string;
  executable: string;
  args?: string[];
  env?: Record<string, string>;
  initializeTimeoutMs?: number;
  requestTimeoutMs?: number;
  contentModifiedRetries?: number;
}

/**
 * One LSP client = one `(server, workspace root)` pair, mirroring the shape
 * Hermes/OpenCode use. The client owns the child process and the JSON-RPC
 * exchange, exposes whole-document text sync and push diagnostics with
 * version-based freshness (never clock-based: a slow server's leftover from
 * the previous edit cannot masquerade as a verdict on current content).
 *
 * All spawns go through a scrubbed environment (same allow-list as the
 * command sandbox) and bounded IO: the frame decoder refuses absurd
 * `Content-Length` values, stderr is retained as a bounded tail for
 * debugging, and every request carries a timeout so a hung server cannot
 * pin a session turn forever.
 */
export class LspClient {
  private child: ChildProcess | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly versions = new Map<string, number>();
  private readonly latest = new Map<string, DiagnosticsCacheEntry>();
  private readonly waiters = new Map<string, DiagnosticsWaiter[]>();
  private stderrTail = "";
  private outputTail = "";
  private started = false;
  private shuttingDown = false;
  private readonly options: LspClientOptions;

  constructor(options: LspClientOptions) {
    this.options = options;
  }

  get rootPath(): string {
    return this.options.rootPath;
  }

  get serverId(): string {
    return this.options.serverId;
  }

  get logTail(): string {
    return `${this.outputTail}\n--- stderr ---\n${this.stderrTail}`.trim();
  }

  async start(): Promise<void> {
    if (this.started) return;
    const args = this.options.args ?? [];
    const child = spawn(this.options.executable, args, {
      cwd: this.options.rootPath,
      env: scrubEnvironment(this.options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code, signal) => {
      if (this.shuttingDown) return;
      const detail = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      this.failAll(new Error(`LSP server ${this.options.serverId} exited unexpectedly (${detail}).`));
    });
    this.started = true;
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    const result = await this.request<{ capabilities?: Record<string, unknown> }>(
      "initialize",
      {
        processId: process.pid,
        rootUri: fileUri(this.options.rootPath),
        capabilities: {
          workspace: { workspaceFolders: true },
          textDocument: {
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            definition: { linkSupport: true },
            references: true,
            publishDiagnostics: { versionSupport: true, relatedInformation: false },
          },
          window: { workDoneProgress: false },
        },
      },
      this.options.initializeTimeoutMs ?? LSP_INITIALIZE_TIMEOUT_MS,
    );
    this.notify("initialized", {});
    this.capabilities = result?.capabilities ?? {};
  }

  private capabilities: Record<string, unknown> = {};

  get supportsPullDiagnostics(): boolean {
    const textDocument = this.capabilities.textDocument as Record<string, unknown> | undefined;
    return Boolean(textDocument && typeof textDocument.diagnostic === "object");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_OUTPUT_FRAME_CHARS * 2) this.buffer = this.buffer.slice(-MAX_OUTPUT_FRAME_CHARS);
    const { messages, rest } = decodeFrames(this.buffer);
    this.buffer = rest;
    for (const message of messages) this.onMessage(message as Record<string, unknown>);
  }

  private onMessage(message: Record<string, unknown> | undefined): void {
    if (!message || typeof message !== "object") return;
    const id = message.id;
    if (typeof id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if ("error" in message && message.error !== null && message.error !== undefined) {
        const error = message.error as { code?: number; message?: string };
        pending.reject(new LspProtocolError(error.code ?? -32000, String(error.message ?? "LSP request failed")));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    const method = message.method;
    if (method === "textDocument/publishDiagnostics") {
      this.onDiagnostics((message.params ?? {}) as { uri?: string; version?: number; diagnostics?: LspDiagnostic[] });
    } else if (method === "window/logMessage" || method === "window/showMessage") {
      const params = (message.params ?? {}) as { message?: string };
      if (params.message) {
        this.outputTail = `${this.outputTail}${params.message}\n`.slice(-4000);
      }
    }
  }

  private onDiagnostics(params: { uri?: string; version?: number; diagnostics?: LspDiagnostic[] }): void {
    if (!params.uri) return;
    const version = typeof params.version === "number" ? params.version : undefined;
    this.latest.set(params.uri, { version, items: params.diagnostics ?? [] });
    const entries = this.waiters.get(params.uri);
    if (!entries) return;
    const remaining: DiagnosticsWaiter[] = [];
    for (const waiter of entries) {
      if (version === undefined || version >= waiter.minVersion) {
        clearTimeout(waiter.timer);
        waiter.resolve(this.currentDiagnostics(params.uri));
      } else {
        remaining.push(waiter);
      }
    }
    if (remaining.length > 0) this.waiters.set(params.uri, remaining);
    else this.waiters.delete(params.uri);
  }

  /** Diagnostics currently held for a URI (already normalized and sanitized). */
  currentDiagnostics(uri: string): NormalizedDiagnostic[] {
    const entry = this.latest.get(uri);
    if (!entry) return [];
    return entry.items
      .map((diagnostic) => normalizeDiagnostic(uri, diagnostic))
      .filter((item) => item.message.length > 0);
  }

  async request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const retries = this.options.contentModifiedRetries ?? CONTENT_MODIFIED_RETRY_DELAYS_MS.length;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (this.shuttingDown || !this.child || this.child.killed) {
        throw new Error(`LSP server ${this.options.serverId} is not running.`);
      }
      try {
        return (await this.sendRequest(method, params, timeoutMs ?? this.options.requestTimeoutMs ?? LSP_REQUEST_TIMEOUT_MS)) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!(lastError instanceof LspProtocolError) || lastError.code !== LSP_CONTENT_MODIFIED) throw lastError;
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, CONTENT_MODIFIED_RETRY_DELAYS_MS[Math.min(attempt, CONTENT_MODIFIED_RETRY_DELAYS_MS.length - 1)]!));
        }
      }
    }
    throw lastError ?? new Error("LSP request failed.");
  }

  private sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.child || !this.child.stdin?.writable) {
      return Promise.reject(new Error(`LSP server ${this.options.serverId} is not running.`));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.child || !this.child.stdin?.writable) return;
    this.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  private write(payload: string): void {
    if (!this.child?.stdin?.writable) return;
    this.outputTail = `${this.outputTail}${payload}\n`.slice(-4000);
    try {
      this.child.stdin.write(payload);
    } catch {
      // The process died between the liveness check and the write; the next
      // request will surface a clean error instead of an unhandled throw.
    }
  }

  private versionFor(uri: string): number {
    const next = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, next);
    return next;
  }

  /** Open a document with whole-document sync. Returns the version the server will see. */
  openDocument(uri: string, languageId: string, text: string): number {
    const version = this.versionFor(uri);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
    return version;
  }

  changeDocument(uri: string, text: string): void {
    const version = this.versionFor(uri);
    // Whole-document sync: sending a single full replacement is well-tolerated
    // by every major server and avoids range bookkeeping (OpenCode, Hermes).
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  closeDocument(uri: string): void {
    this.notify("textDocument/didClose", { textDocument: { uri } });
    this.latest.delete(uri);
    this.versions.delete(uri);
    const entries = this.waiters.get(uri);
    for (const waiter of entries ?? []) clearTimeout(waiter.timer);
    this.waiters.delete(uri);
  }

  /** Resolve when the server has published diagnostics at least as fresh as `version` for `uri`. */
  async waitForDiagnostics(uri: string, version: number, timeoutMs: number): Promise<NormalizedDiagnostic[]> {
    const cached = this.latest.get(uri);
    if (cached && (cached.version === undefined || cached.version >= version)) return this.currentDiagnostics(uri);
    return await new Promise<NormalizedDiagnostic[]>((resolve) => {
      const timer = setTimeout(() => {
        const entries = this.waiters.get(uri) ?? [];
        this.waiters.set(uri, entries.filter((item) => item.timer !== timer));
        resolve(this.currentDiagnostics(uri));
      }, timeoutMs);
      const entries = this.waiters.get(uri) ?? [];
      entries.push({ minVersion: version, resolve, timer });
      this.waiters.set(uri, entries);
    });
  }

  documentSymbols(uri: string): Promise<unknown> {
    return this.request("textDocument/documentSymbol", { textDocument: { uri } });
  }

  definition(uri: string, line: number, character: number): Promise<unknown> {
    return this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  references(uri: string, line: number, character: number, includeDeclaration: boolean): Promise<unknown> {
    return this.request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration },
    });
  }

  workspaceSymbols(query: string): Promise<unknown> {
    return this.request("workspace/symbol", { query });
  }

  async shutdown(): Promise<void> {
    if (!this.child || this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      await this.request("shutdown", null, 2000);
    } catch {
      // Best effort: a server that will not answer `shutdown` gets the exit
      // notification anyway, then a signal.
    }
    this.notify("exit", null);
    await this.awaitExit(2000);
    if (!this.child.killed) this.kill("SIGTERM");
    await this.awaitExit(1000);
    if (!this.child.killed) this.kill("SIGKILL");
    this.failAll(new Error("LSP server shut down."));
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true;
    if (this.child && !this.child.killed) this.kill("SIGKILL");
    this.failAll(new Error("LSP server disposed."));
  }

  private kill(signal: NodeJS.Signals): void {
    try {
      this.child?.kill(signal);
    } catch {
      // Already gone.
    }
  }

  private async awaitExit(timeoutMs: number): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const entries of this.waiters.values()) {
      for (const waiter of entries) clearTimeout(waiter.timer);
    }
    this.waiters.clear();
  }
}
