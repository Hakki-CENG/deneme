import type { JsonValue } from "../types.js";

/**
 * Approval previews.
 *
 * An approval prompt is a question put to a human: "may this run?" The preview *is* the question. Two
 * failure modes make the answer meaningless, and peers have shipped fixes for both:
 *
 * - **truncation that hides the decision.** A generic "first 2000 characters" cut can drop the tail of
 *   a shell command - which is exactly where `&& rm -rf /` would sit. Decision-relevant fields are
 *   therefore kept whole to a much larger bound, and if anything is dropped the preview *says so*.
 * - **masking that hides the target.** Secret redaction must never blank out the command, path, host or
 *   destination the approver is being asked about. Only values that look like credentials are masked,
 *   and every mask is counted, so a preview cannot quietly become "approve this ████".
 *
 * The rule of thumb: an approver may be shown less *content*, never less *intent*.
 */

/** Keys whose values the approver must be able to read in full to make a decision. */
const DECISION_KEYS = new Set([
  "command", "cmd", "script", "path", "paths", "file", "filePath", "target", "targetPath",
  "destination", "dest", "url", "endpoint", "host", "hostname", "repository", "repo", "branch",
  "remote", "query", "sql", "method", "operation", "recipient", "to", "capabilityId", "sessionId",
]);

/** Keys whose values are credentials by name; the value is masked, the key is still shown. */
const SECRET_KEYS = /^(?:.*_)?(?:password|passwd|secret|token|apikey|api_key|accesskey|access_key|privatekey|private_key|authorization|auth|credential|credentials|cookie|session_token|refresh_token|client_secret)$/i;

/** Value shapes that are credentials wherever they appear. */
const SECRET_VALUES: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const DECISION_VALUE_CHARS = 20_000;
const OTHER_VALUE_CHARS = 2_000;

export interface PreviewIntegrity {
  /** Number of values a credential pattern masked. Zero means nothing was hidden. */
  maskedValues: number;
  /** Keys whose values were shortened, with the original length, so nothing vanishes silently. */
  shortened: Array<{ key: string; originalChars: number; keptChars: number }>;
  /** Keys dropped entirely because the payload was too large even after shortening. */
  droppedKeys: string[];
}

export interface SafePreviewResult {
  preview: JsonValue;
  integrity: PreviewIntegrity;
}

function maskSecrets(text: string, integrity: PreviewIntegrity): string {
  let output = text;
  for (const pattern of SECRET_VALUES) {
    output = output.replace(pattern, () => {
      integrity.maskedValues++;
      return "[redacted-credential]";
    });
  }
  return output;
}

function shorten(key: string, text: string, limit: number, integrity: PreviewIntegrity): string {
  if (text.length <= limit) return text;
  integrity.shortened.push({ key, originalChars: text.length, keptChars: limit });
  // Both ends are kept: a dangerous tail is exactly what a head-only cut would hide.
  const head = Math.ceil(limit * 0.7);
  const tail = limit - head;
  return `${text.slice(0, head)}…[${text.length - limit} characters omitted]…${tail > 0 ? text.slice(-tail) : ""}`;
}

function sanitize(key: string, value: JsonValue, integrity: PreviewIntegrity, depth = 0): JsonValue {
  if (depth > 6) return "[nested]";
  if (typeof value === "string") {
    if (SECRET_KEYS.test(key)) {
      integrity.maskedValues++;
      return "[redacted-credential]";
    }
    const limit = DECISION_KEYS.has(key) ? DECISION_VALUE_CHARS : OTHER_VALUE_CHARS;
    return shorten(key, maskSecrets(value, integrity), limit, integrity);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(key, item, integrity, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, sanitize(childKey, childValue as JsonValue, integrity, depth + 1)]),
    );
  }
  return value;
}

/**
 * Build an approval preview that keeps the decision readable. Returns the preview together with an
 * integrity report, so a UI can show "3 values masked" rather than leaving the approver to wonder.
 */
export function buildApprovalPreview(value: JsonValue, maxChars = 40_000): SafePreviewResult {
  const integrity: PreviewIntegrity = { maskedValues: 0, shortened: [], droppedKeys: [] };
  let preview = sanitize("", value, integrity);

  if (JSON.stringify(preview).length > maxChars && preview && typeof preview === "object" && !Array.isArray(preview)) {
    // Over budget: drop non-decision keys first, largest first, and name every one that goes.
    const entries = Object.entries(preview)
      .filter(([key]) => !DECISION_KEYS.has(key))
      .sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length);
    const kept: Record<string, JsonValue> = { ...preview };
    for (const [key] of entries) {
      if (JSON.stringify(kept).length <= maxChars) break;
      delete kept[key];
      integrity.droppedKeys.push(key);
    }
    preview = kept;
  }
  return { preview, integrity };
}

export function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, asJsonValue(item)]));
  }
  return String(value);
}

export function safePreview(value: JsonValue, maxChars = 2000): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxChars) return value;
  return { truncated: true, preview: serialized.slice(0, maxChars), originalChars: serialized.length };
}
