/**
 * Dependency-free structural scanner used when no language server is
 * installed. It is deliberately honest about what it is: a tokenizer plus
 * declaration patterns, not a full parser. It exists so Aurora's code
 * intelligence degrades to "useful" instead of "absent", and it never blocks
 * on process startup - the LSP path is tried first whenever the server
 * binary is available.
 *
 * The scanner strips string literals and comments before matching (keeping
 * line structure intact), so a symbol name inside a doc comment or a string
 * does not produce a phantom occurrence; every index maps 1:1 back to the
 * original line/column through precomputed line starts.
 */

export type SymbolKind =
  | "function" | "method" | "class" | "interface" | "type" | "enum" | "const"
  | "variable" | "module" | "trait" | "struct" | "impl" | "field";

export interface ScannedSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  column: number;
  endLine: number;
  /** Number of enclosing brace pairs (0 = top level). */
  scopeDepth: number;
  /** Python only: the enclosing class or function name. */
  container?: string;
  signature?: string;
}

export interface SymbolOccurrence {
  line: number;
  column: number;
  length: number;
}

export const MAX_SCANNED_FILE_BYTES = 1024 * 1024;
export const MAX_SYMBOLS_PER_FILE = 400;
export const MAX_SYMBOLS_TOTAL = 5000;
export const MAX_OCCURRENCES = 200;

type ScannerLanguage = "typescript" | "python" | "go" | "rust";

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function precomputeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function positionAt(lineStarts: number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid]! <= index) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: index - lineStarts[low]! + 1 };
}

function replaceRange(text: string, start: number, end: number): string {
  let out = "";
  for (let index = start; index < end; index++) {
    out += text[index] === "\n" || text[index] === "\r" ? text[index]! : " ";
  }
  return out;
}

/**
 * Return a copy of `text` in which string literals and comments are replaced
 * by spaces (newlines preserved). The result has the same length, so index
 * positions still map to the original source.
 */
export function stripNonCode(text: string, language: ScannerLanguage): string {
  let out = "";
  let index = 0;
  const length = text.length;
  const isPython = language === "python";
  const isRust = language === "rust";
  while (index < length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (!isPython && char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      out += replaceRange(text, index, end < 0 ? length : end);
      index = end < 0 ? length : end;
      continue;
    }
    if (!isPython && char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end < 0 ? length : end + 2;
      out += replaceRange(text, index, stop);
      index = stop;
      continue;
    }
    if (isPython && char === "#") {
      const end = text.indexOf("\n", index);
      out += replaceRange(text, index, end < 0 ? length : end);
      index = end < 0 ? length : end;
      continue;
    }
    if ((char === '"' || char === "'") && !(isRust && char === "'" && isWordChar(next ?? ""))) {
      // Rust lifetimes (`'a`) look like single quotes but never close with a
      // matching quote on the same token; a char literal is `'x'`.
      const quote = char;
      const triple = text.slice(index, index + 3) === quote.repeat(3);
      const delimiter = triple ? quote.repeat(3) : quote;
      let cursor = index + delimiter.length;
      let end = -1;
      while (cursor < length) {
        if (text[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (text.slice(cursor, cursor + delimiter.length) === delimiter) {
          end = cursor + delimiter.length;
          break;
        }
        cursor++;
      }
      const stop = end < 0 ? length : end;
      const inner = text.slice(index, stop);
      // Template literals with ${...} would hide code from the scanner; for a
      // symbol index the whole literal is acceptable noise to lose.
      out += replaceRange(text, index, stop);
      void inner;
      index = stop;
      continue;
    }
    if (char === "`" && !isPython) {
      const end = text.indexOf("`", index + 1);
      const stop = end < 0 ? length : end + 1;
      out += replaceRange(text, index, stop);
      index = stop;
      continue;
    }
    out += char;
    index++;
  }
  return out;
}

interface DeclarationPattern {
  kind: SymbolKind;
  pattern: RegExp;
}

function tsPatterns(): DeclarationPattern[] {
  const lineStart = "^[ \\t]*";
  return [
    { kind: "function", pattern: new RegExp(`${lineStart}(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+([A-Za-z_$][\\w$]*)`, "gm") },
    { kind: "class", pattern: new RegExp(`${lineStart}(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+([A-Za-z_$][\\w$]*)`, "gm") },
    { kind: "interface", pattern: new RegExp(`${lineStart}(?:export\\s+)?interface\\s+([A-Za-z_$][\\w$]*)`, "gm") },
    { kind: "type", pattern: new RegExp(`${lineStart}(?:export\\s+)?type\\s+([A-Za-z_$][\\w$]*)\\s*=`, "gm") },
    { kind: "enum", pattern: new RegExp(`${lineStart}(?:export\\s+)?(?:const\\s+)?enum\\s+([A-Za-z_$][\\w$]*)`, "gm") },
    { kind: "const", pattern: new RegExp(`${lineStart}(?:export\\s+)?(?:const|let|var)\\s+(?!enum\\b)([A-Za-z_$][\\w$]*)`, "gm") },
  ];
}

function goPatterns(): DeclarationPattern[] {
  const lineStart = "^[ \\t]*";
  return [
    { kind: "function", pattern: new RegExp(`${lineStart}func\\s+(?:\\([^)]*\\)\\s*)?([A-Za-z_]\\w*)`, "gm") },
    { kind: "type", pattern: new RegExp(`${lineStart}type\\s+([A-Za-z_]\\w*)`, "gm") },
    { kind: "const", pattern: new RegExp(`${lineStart}(?:const|var)\\s+([A-Za-z_]\\w*)`, "gm") },
  ];
}

function rustPatterns(): DeclarationPattern[] {
  const lineStart = "^[ \\t]*";
  const visibility = "(?:pub(?:\\s*\\([^)]*\\))?\\s+)?";
  return [
    { kind: "function", pattern: new RegExp(`${lineStart}${visibility}(?:async\\s+)?fn\\s+([A-Za-z_]\\w*)`, "gm") },
    { kind: "struct", pattern: new RegExp(`${lineStart}${visibility}(?:struct|enum|trait|mod|type)\\s+([A-Za-z_]\\w*)`, "gm") },
    { kind: "const", pattern: new RegExp(`${lineStart}${visibility}(?:const|static)\\s+([A-Za-z_]\\w*)`, "gm") },
  ];
}

interface BraceEvent {
  index: number;
  depth: number;
}

function braceEvents(cleaned: string): BraceEvent[] {
  const events: BraceEvent[] = [];
  let depth = 0;
  for (let index = 0; index < cleaned.length; index++) {
    if (cleaned[index] === "{") {
      depth++;
      events.push({ index, depth });
    } else if (cleaned[index] === "}") {
      depth = Math.max(0, depth - 1);
      events.push({ index, depth });
    }
  }
  return events;
}

function depthAt(events: BraceEvent[], index: number): number {
  let low = 0;
  let high = events.length - 1;
  let result = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (events[mid]!.index <= index) {
      result = events[mid]!.depth;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

function scanBraceLanguage(cleaned: string, patterns: DeclarationPattern[], language: ScannerLanguage): ScannedSymbol[] {
  const lineStarts = precomputeLineStarts(cleaned);
  const events = braceEvents(cleaned);
  const symbols: ScannedSymbol[] = [];
  for (const entry of patterns) {
    entry.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = entry.pattern.exec(cleaned)) !== null) {
      const name = match[1];
      if (!name || symbols.length >= MAX_SYMBOLS_PER_FILE) break;
      const nameOffset = match[0].indexOf(name);
      const start = match.index + Math.max(0, nameOffset);
      const end = start + name.length;
      const startPos = positionAt(lineStarts, start);
      const endPos = positionAt(lineStarts, end);
      const scopeDepth = depthAt(events, start);
      const signature = cleaned.slice(match.index, match.index + Math.min(120, cleaned.length - match.index)).trim();
      symbols.push({
        name,
        kind: entry.kind,
        line: startPos.line,
        column: startPos.column,
        endLine: endPos.line,
        scopeDepth,
        ...(signature ? { signature } : {}),
      });
      if (entry.pattern.lastIndex === match.index) entry.pattern.lastIndex++;
    }
  }
  symbols.sort((a, b) => a.line - b.line || a.column - b.column);
  return symbols.slice(0, MAX_SYMBOLS_PER_FILE);
}

function scanPython(cleaned: string): ScannedSymbol[] {
  const symbols: ScannedSymbol[] = [];
  const stack: Array<{ indent: number; name: string; kind: SymbolKind; line: number; column: number }> = [];
  const lines = cleaned.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    const functionMatch = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(trimmed);
    const classMatch = /^class\s+([A-Za-z_]\w*)\s*[(:]/.exec(trimmed);
    const match = functionMatch ?? classMatch;
    if (!match) continue;
    while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    const name = match[1]!;
    const kind: SymbolKind = classMatch ? "class" : "function";
    const column = line.indexOf(name) + 1;
    const container = stack.length > 0 ? stack[stack.length - 1]!.name : undefined;
    symbols.push({
      name,
      kind,
      line: lineIndex + 1,
      column,
      endLine: lineIndex + 1,
      scopeDepth: stack.length,
      ...(container ? { container } : {}),
      ...(kind === "function" ? { signature: trimmed.slice(0, 120) } : {}),
    });
    stack.push({ indent, name, kind, line: lineIndex + 1, column });
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  return symbols;
}

export function scanSymbols(content: string, language: ScannerLanguage): ScannedSymbol[] {
  const cleaned = stripNonCode(content, language);
  if (language === "python") return scanPython(cleaned);
  if (language === "go") return scanBraceLanguage(cleaned, goPatterns(), language);
  if (language === "rust") return scanBraceLanguage(cleaned, rustPatterns(), language);
  return scanBraceLanguage(cleaned, tsPatterns(), language);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All exact, word-boundary occurrences of `name` in the scanned (string/comment-stripped) text. */
export function findOccurrences(cleaned: string, name: string, limit = MAX_OCCURRENCES): SymbolOccurrence[] {
  const lineStarts = precomputeLineStarts(cleaned);
  const occurrences: SymbolOccurrence[] = [];
  let index = 0;
  while (occurrences.length < limit) {
    const found = cleaned.indexOf(name, index);
    if (found < 0) break;
    const before = found > 0 ? cleaned[found - 1]! : "";
    const after = found + name.length < cleaned.length ? cleaned[found + name.length]! : "";
    if ((before === "" || !isWordChar(before)) && (after === "" || !isWordChar(after))) {
      const position = positionAt(lineStarts, found);
      occurrences.push({ line: position.line, column: position.column, length: name.length });
    }
    index = found + 1;
  }
  return occurrences;
}

/** Convert a 1-based line/column into a 0-based index for `length`-preserving scanning. */
export function indexOfPosition(text: string, line: number, column: number): number {
  const starts = precomputeLineStarts(text);
  const targetLine = Math.max(1, line);
  const start = starts[Math.min(targetLine - 1, starts.length - 1)] ?? 0;
  return start + Math.max(0, column - 1);
}

/** Extract the identifier touching `index` (0-based), if any. */
export function identifierAt(cleaned: string, index: number): { name: string; start: number; end: number } | undefined {
  if (index < 0 || index >= cleaned.length) return undefined;
  if (!isWordChar(cleaned[index]!)) return undefined;
  let start = index;
  while (start > 0 && isWordChar(cleaned[start - 1]!)) start--;
  let end = index + 1;
  while (end < cleaned.length && isWordChar(cleaned[end]!)) end++;
  return { name: cleaned.slice(start, end), start, end };
}

export function languageOf(path: string): ScannerLanguage | undefined {
  const lower = path.toLowerCase();
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) return "typescript";
  if (/\.(py|pyi)$/.test(lower)) return "python";
  if (/\.go$/.test(lower)) return "go";
  if (/\.rs$/.test(lower)) return "rust";
  return undefined;
}
