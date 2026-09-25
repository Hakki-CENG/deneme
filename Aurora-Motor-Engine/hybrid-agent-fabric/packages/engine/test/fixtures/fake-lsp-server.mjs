#!/usr/bin/env node
/**
 * Fake language server — test fixture.
 *
 * Speaks LSP over Content-Length framed JSON-RPC on stdio. It reacts to marker
 * comments in the opened document so the engine's diagnostics/symbol/definition
 * /references plumbing can be tested without installing a real
 * typescript-language-server.
 *
 * Markers understood in document text:
 *   TYPE_ERROR_MARKER — publishes a TS9999 error diagnostic on that line.
 *   WARNING_MARKER    — publishes a W1000 warning diagnostic on that line.
 *
 * The error message is deliberately long and multi-line so the host's
 * sanitizer (single line, <= 300 chars) is exercised.
 */

import { Buffer } from "node:buffer";

/** uri -> { version, text } */
const documents = new Map();

const send = (message) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  const payload = Buffer.from(body, "utf8");
  process.stdout.write(`Content-Length: ${payload.byteLength}\r\n\r\n`);
  process.stdout.write(payload);
};

const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });

const NOISY_ERROR_MESSAGE =
  "Type 'string' is not assignable to type 'number'.\n" +
  "  The expected type comes from property 'value'.\n" +
  `  ${"Additional diagnostic context that pads this message well beyond the three hundred character limit so the host sanitizer has to truncate it. ".repeat(4)}`;

function computeDiagnostics(text) {
  const diagnostics = [];
  const lines = text.split("\n");

  lines.forEach((line, index) => {
    if (line.includes("TYPE_ERROR_MARKER")) {
      diagnostics.push({
        range: {
          start: { line: index, character: 2 },
          end: { line: index, character: Math.max(3, line.length) },
        },
        severity: 1, // Error
        code: "TS9999",
        source: "ts",
        message: NOISY_ERROR_MESSAGE,
      });
    }
    if (line.includes("WARNING_MARKER")) {
      diagnostics.push({
        range: {
          start: { line: index, character: 0 },
          end: { line: index, character: Math.max(1, line.length) },
        },
        severity: 2, // Warning
        code: "W1000",
        source: "ts",
        message: "Unused marker comment.",
      });
    }
  });

  return diagnostics;
}

function publish(uri) {
  const doc = documents.get(uri);
  if (!doc) return;
  notify("textDocument/publishDiagnostics", {
    uri,
    version: doc.version,
    diagnostics: computeDiagnostics(doc.text),
  });
}

function handle(message) {
  const { id, method, params } = message;

  switch (method) {
    case "initialize":
      reply(id, {
        capabilities: {
          textDocumentSync: { openClose: true, change: 1 },
          documentSymbolProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
        },
        serverInfo: { name: "fake-lsp-server", version: "1.0.0" },
      });
      return;

    case "initialized":
      return;

    case "textDocument/didOpen": {
      const doc = params?.textDocument;
      if (!doc?.uri) return;
      documents.set(doc.uri, { version: doc.version ?? 1, text: doc.text ?? "" });
      publish(doc.uri);
      return;
    }

    case "textDocument/didChange": {
      const uri = params?.textDocument?.uri;
      if (!uri) return;
      const existing = documents.get(uri) ?? { version: 0, text: "" };
      const change = params?.contentChanges?.[0];
      documents.set(uri, {
        version: params?.textDocument?.version ?? existing.version + 1,
        text: change?.text ?? existing.text,
      });
      publish(uri);
      return;
    }

    case "textDocument/didClose": {
      const uri = params?.textDocument?.uri;
      if (uri) documents.delete(uri);
      return;
    }

    case "textDocument/documentSymbol": {
      // The test asserts: name "say", kind function, line 1 (1-based),
      // detail "Greets callers".
      reply(id, [
        {
          name: "say",
          detail: "Greets callers",
          kind: 12, // SymbolKind.Function
          range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
          selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } },
        },
      ]);
      return;
    }

    case "textDocument/definition": {
      // The test asks at line 3, column 3 (1-based) and expects a candidate at
      // line 3, column 6 (1-based) => zero-based line 2, character 5.
      const uri = params?.textDocument?.uri;
      reply(id, [
        {
          uri,
          range: { start: { line: 2, character: 5 }, end: { line: 2, character: 11 } },
        },
      ]);
      return;
    }

    case "textDocument/references": {
      // The test expects exactly two occurrences.
      const uri = params?.textDocument?.uri;
      reply(id, [
        { uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } } },
        { uri, range: { start: { line: 2, character: 5 }, end: { line: 2, character: 11 } } },
      ]);
      return;
    }

    case "shutdown":
      reply(id, null);
      return;

    case "exit":
      process.exit(0);
      return;

    default:
      // Unknown requests must still be answered so the client never hangs.
      if (id !== undefined && id !== null) {
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
  }
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  for (;;) {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator === -1) return;

    const header = buffer.subarray(0, separator).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(separator + 4);
      continue;
    }

    const length = Number(match[1]);
    const start = separator + 4;
    if (buffer.byteLength < start + length) return;

    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);

    try {
      handle(JSON.parse(body));
    } catch {
      // Ignore malformed frames; a real server would log and continue.
    }
  }
});

process.stdin.on("close", () => process.exit(0));
