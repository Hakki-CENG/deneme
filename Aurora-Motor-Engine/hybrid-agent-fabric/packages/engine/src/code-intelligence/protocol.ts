/**
 * Language Server Protocol message layer for Aurora code intelligence.
 *
 * The transport is the LSP stdio framing every server speaks: `Content-Length`
 * headers followed by a JSON body. This module owns only that layer plus the
 * shared value types - the client, the server registry and the service sit on
 * top of it.
 *
 * Security note (mirrors Hermes' `agent/lsp/reporter.py`, which calls this out
 * explicitly): diagnostic `message`, `code` and `source` fields originate from
 * a language server that has just parsed *user-controlled source code*. A
 * hostile repository can shape an identifier, type alias or import path so the
 * server echoes instruction-shaped text back into the model's tool result.
 * Every field that crosses into a tool result goes through
 * `sanitizeDiagnosticField`: newlines are collapsed, control characters are
 * neutralised and the field is length-capped, so a repo cannot smuggle a new
 * line or a prompt-injection block through the compiler.
 */

export const LSP_CONTENT_MODIFIED = -32801;
export const LSP_REQUEST_TIMEOUT_MS = 15_000;
export const LSP_INITIALIZE_TIMEOUT_MS = 30_000;

export class LspProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "LspProtocolError";
  }
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
  /** LSP 3.15+: the document version this diagnostic describes. */
  version?: number;
}

export function encodeMessage(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

/** Parse as many complete frames as the buffer holds; the remainder is returned for the next chunk. */
export function decodeFrames(buffer: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = [];
  let rest = buffer;
  for (;;) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const headers = rest.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(headers);
    if (!match) {
      // A malformed frame cannot be resynced reliably; drop it so a hostile or
      // buggy server cannot stall the reader forever.
      rest = rest.slice(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    if (!Number.isFinite(length) || length < 0 || length > 16 * 1024 * 1024) {
      rest = rest.slice(headerEnd + 4);
      continue;
    }
    const start = headerEnd + 4;
    if (rest.length < start + length) break;
    const body = rest.slice(start, start + length);
    rest = rest.slice(start + length);
    try {
      messages.push(JSON.parse(body) as unknown);
    } catch {
      // A single corrupt JSON body must not kill the connection; the next
      // frame still carries sequence state we care about.
    }
  }
  return { messages, rest };
}

/** Build a `file://` URI for a workspace path. Paths are encodeURI-escaped so spaces and non-ASCII survive. */
export function fileUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(absolute)}`;
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  const rest = uri.slice("file://".length);
  return decodeURIComponent(rest.replace(/^\/([A-Za-z]:)/, "$1"));
}

export const SEVERITY_NAMES: Record<number, "error" | "warning" | "info" | "hint"> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

export const SEVERITY_RANK: Record<string, number> = { error: 1, warning: 2, info: 3, hint: 4 };

export interface NormalizedDiagnostic {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source: string;
  code: string;
}

/**
 * Collapse CR/LF, neutralise control characters and cap the length of a
 * server-produced field before it enters a tool result. The language server
 * output is untrusted from the agent's point of view: the repository being
 * analyzed belongs to the user, and compiler messages quote its identifiers.
 */
export function sanitizeDiagnosticField(value: unknown, limit: number): string {
  if (value === null || value === undefined) return "";
  const raw = String(value).replace(/\r/g, " ").replace(/\n/g, " ");
  let out = "";
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    out += code === 0x09 || (code >= 0x20 && code !== 0x7f) ? char : " ";
    if (out.length >= limit) break;
  }
  return out;
}

export const MAX_DIAGNOSTIC_MESSAGE_CHARS = 300;
export const MAX_DIAGNOSTIC_CODE_CHARS = 80;
export const MAX_DIAGNOSTIC_SOURCE_CHARS = 80;

/** Normalize and sanitize a raw LSP diagnostic. Line/column are 1-based for the stable API surface. */
export function normalizeDiagnostic(uri: string, diagnostic: LspDiagnostic): NormalizedDiagnostic {
  const severity = diagnostic.severity !== undefined && SEVERITY_NAMES[diagnostic.severity] !== undefined
    ? SEVERITY_NAMES[diagnostic.severity]!
    : "info";
  const rawPath = uriToPath(uri);
  return {
    path: rawPath,
    line: Math.max(1, diagnostic.range.start.line + 1),
    column: Math.max(1, diagnostic.range.start.character + 1),
    ...(diagnostic.range.end.line !== diagnostic.range.start.line || diagnostic.range.end.character !== diagnostic.range.start.character
      ? {
          endLine: Math.max(1, diagnostic.range.end.line + 1),
          endColumn: Math.max(1, diagnostic.range.end.character + 1),
        }
      : {}),
    severity,
    message: sanitizeDiagnosticField(diagnostic.message, MAX_DIAGNOSTIC_MESSAGE_CHARS),
    source: sanitizeDiagnosticField(diagnostic.source, MAX_DIAGNOSTIC_SOURCE_CHARS) || "lsp",
    code: sanitizeDiagnosticField(diagnostic.code, MAX_DIAGNOSTIC_CODE_CHARS),
  };
}
