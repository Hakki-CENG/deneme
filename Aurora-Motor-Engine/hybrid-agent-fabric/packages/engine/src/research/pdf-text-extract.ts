import { inflateSync } from "node:zlib";

/**
 * Minimal, dependency-free PDF text extraction (P1.40 "PDF/paper parsing").
 *
 * Scope, stated honestly: this extracts text from PDF content streams whose
 * strings use simple encodings (the common case for papers generated from
 * LaTeX/Word). It decompresses FlateDecode streams, decodes `(...) Tj`,
 * `[ ... ] TJ` and `<...> Tj` operators with their escape sequences, and
 * reports page count. It does NOT render pages, understand CID/CMap fonts or
 * OCR scanned documents — when no text layer exists it says so instead of
 * inventing content.
 */

export interface PdfTextExtraction {
  extracted: boolean;
  text: string;
  pages: number;
  reason?: string;
}

const MAX_STREAMS = 500;
const MAX_CHARS = 200_000;

function decodePdfString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b" || next === "f") out += " ";
    else if (next === "(" || next === ")" || next === "\\") out += next;
    else if (next === "\n") {
      // line continuation: contributes nothing
    } else if (next === "\r") {
      if (raw[i + 1] === "\n") i++;
    } else if (next >= "0" && next <= "7") {
      let octal = next;
      while (octal.length < 3 && (raw[i + 1] ?? "") >= "0" && (raw[i + 1] ?? "") <= "7") {
        octal += raw[++i] ?? "";
      }
      out += String.fromCharCode(parseInt(octal, 8) & 0xff);
    } else {
      out += next;
    }
  }
  return out;
}

function decodePdfHexString(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/g, "");
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

/** Extract `(...)`-style strings with balanced parens, starting at `start` (which must be "("). */
function readParenthesized(source: string, start: number): { value: string; end: number } | undefined {
  if (source[start] !== "(") return undefined;
  let depth = 1;
  let body = "";
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "\\") {
      body += ch + (source[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return { value: body, end: i };
    }
    body += ch;
  }
  return undefined;
}

function textFromContentStream(content: string): string {
  let out = "";
  const parts: string[] = [];
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (ch === "(") {
      const literal = readParenthesized(content, i);
      if (literal) {
        parts.push(decodePdfString(literal.value));
        i = literal.end;
        continue;
      }
    }
    if (ch === "<" && content[i + 1] !== "<") {
      const close = content.indexOf(">", i);
      if (close > i) {
        const hex = content.slice(i + 1, close);
        // Only treat as a text-showing hex string when followed by Tj/TJ-class operators.
        const after = content.slice(close + 1, close + 8);
        if (/\s*(Tj|TJ|'|")/.test(after)) {
          parts.push(decodePdfHexString(hex));
          i = close;
          continue;
        }
      }
    }
    if (ch === "[") {
      const close = content.indexOf("]", i);
      if (close > i) {
        const after = content.slice(close + 1, close + 8);
        if (/\s*TJ/.test(after)) {
          const arrayBody = content.slice(i + 1, close);
          const strings = [...arrayBody.matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((match) => decodePdfString(match[1]!));
          if (strings.length) parts.push(strings.join(""));
          i = close;
          continue;
        }
      }
    }
    // Positioning operators that start a new line.
    if (ch === "T" && (content[i + 1] === "d" || content[i + 1] === "D" || content[i + 1] === "*")) {
      const before = content[i - 1];
      if (before === undefined || /\s/.test(before)) parts.push("\n");
    }
  }
  out = parts.join(" ");
  return out.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function looksLikePdf(latin: string): boolean {
  return latin.slice(0, 1024).includes("%PDF-");
}

export function extractPdfText(bytes: Uint8Array): PdfTextExtraction {
  const latin = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  if (!looksLikePdf(latin)) {
    return { extracted: false, text: "", pages: 0, reason: "not a PDF document" };
  }
  const pageCount = [...latin.matchAll(/\/Type\s*\/Page(?![a-zA-Z])/g)].length;
  const chunks: string[] = [];
  const streamPattern = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  let processed = 0;
  while ((match = streamPattern.exec(latin)) !== null && processed < MAX_STREAMS) {
    const start = match.index + match[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) break;
    // The dictionary precedes the stream keyword.
    const dictStart = Math.max(0, match.index - 600);
    const dict = latin.slice(dictStart, match.index);
    let raw = latin.slice(start, end);
    // Trailing EOL before endstream is not part of the data.
    raw = raw.replace(/\r?\n$/, "");
    if (/\/FlateDecode/.test(dict)) {
      try {
        raw = inflateSync(Buffer.from(raw, "latin1")).toString("latin1");
      } catch {
        // An undecodable stream is skipped, not faked.
        continue;
      }
    }
    if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(dict)) continue; // image data, no text
    const text = textFromContentStream(raw);
    if (text) chunks.push(text);
    processed++;
  }
  const text = chunks.join("\n").slice(0, MAX_CHARS).trim();
  if (!text) {
    return {
      extracted: false,
      text: "",
      pages: pageCount,
      reason: "no extractable text layer (scanned or image-only PDF)",
    };
  }
  return { extracted: true, text, pages: pageCount };
}
