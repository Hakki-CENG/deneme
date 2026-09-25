import { createHash } from "node:crypto";
import type { AgentMessage, JsonValue, MessageContent } from "../types.js";

export interface ContextProjectionOptions {
  maxChars: number;
  protectedTailChars?: number;
  derivedPreviewChars?: number;
}

export interface ContextProjectionStats {
  originalChars: number;
  projectedChars: number;
  compactedMessages: number;
  preservedUserMessages: number;
  budgetOverflow: boolean;
  microCompactedMessages?: number;
  microCompactionWindows?: number;
  microCompactionCacheHits?: number;
  externalMemoryProvider?: string;
  externalMemoryEntries?: number;
  externalMemoryStatus?: "disabled" | "hit" | "empty" | "failed";
  auroraContextChars?: number;
  auroraContextDigest?: string;
  auroraContextSections?: number;
}

export interface ContextProjectionResult {
  messages: AgentMessage[];
  stats: ContextProjectionStats;
}

function contentChars(message: AgentMessage): number {
  return JSON.stringify(message.content).length;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function boundedText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.ceil(limit * 0.65);
  const tail = Math.floor(limit * 0.35);
  return `${text.slice(0, head)}\n…[${text.length - limit} chars compacted]…\n${text.slice(-tail)}`;
}

function compactJson(value: JsonValue, previewChars: number): JsonValue {
  const encoded = JSON.stringify(value);
  return {
    _haf_compacted: true,
    sha256: digest(value),
    originalChars: encoded.length,
    preview: boundedText(encoded, previewChars),
  };
}

function compactDerivedContent(content: MessageContent[], previewChars: number): MessageContent[] {
  return content.map((part): MessageContent => {
    if (part.type === "text") {
      return {
        type: "text",
        text: `[Earlier derived output compacted; sha256=${digest(part.text)}; originalChars=${part.text.length}]\n${boundedText(part.text, previewChars)}`,
      };
    }
    if (part.type === "image") return structuredClone(part);
    if (part.type === "tool_call") {
      const encoded = JSON.stringify(part.arguments);
      return encoded.length <= previewChars
        ? structuredClone(part)
        : { ...structuredClone(part), arguments: compactJson(part.arguments, previewChars) as Record<string, JsonValue> };
    }
    return {
      ...structuredClone(part),
      result: compactJson(part.result, previewChars),
    };
  });
}

/**
 * Builds a model-facing view without mutating the durable transcript.
 *
 * User and system messages are retained verbatim. Older assistant/tool output is
 * reduced to bounded previews plus hashes, while a recent tail remains verbatim.
 * If user-authored content alone exceeds the configured soft budget, intent wins:
 * the projection reports budgetOverflow rather than silently deleting instructions.
 */
export function projectIntentPreservingContext(
  messages: AgentMessage[],
  options: ContextProjectionOptions,
): ContextProjectionResult {
  const maxChars = Math.max(1_000, Math.floor(options.maxChars));
  const protectedTailChars = Math.min(
    maxChars,
    Math.max(1_000, Math.floor(options.protectedTailChars ?? maxChars * 0.45)),
  );
  const previewChars = Math.max(80, Math.floor(options.derivedPreviewChars ?? 600));
  const originalChars = messages.reduce((sum, message) => sum + contentChars(message), 0);
  if (originalChars <= maxChars) {
    return {
      messages: structuredClone(messages),
      stats: {
        originalChars,
        projectedChars: originalChars,
        compactedMessages: 0,
        preservedUserMessages: messages.filter((message) => message.role === "user").length,
        budgetOverflow: false,
      },
    };
  }

  let tailChars = 0;
  let tailStart = messages.length;
  while (tailStart > 0) {
    const nextSize = contentChars(messages[tailStart - 1]!);
    if (tailStart < messages.length && tailChars + nextSize > protectedTailChars) break;
    tailStart--;
    tailChars += nextSize;
  }

  let compactedMessages = 0;
  const projected = messages.map((message, index): AgentMessage => {
    if (index >= tailStart || message.role === "user" || message.role === "system") return structuredClone(message);
    compactedMessages++;
    return { ...structuredClone(message), content: compactDerivedContent(message.content, previewChars) };
  });
  const projectedChars = projected.reduce((sum, message) => sum + contentChars(message), 0);
  const stats: ContextProjectionStats = {
    originalChars,
    projectedChars,
    compactedMessages,
    preservedUserMessages: messages.filter((message) => message.role === "user").length,
    budgetOverflow: projectedChars > maxChars,
  };
  projected.unshift({
    id: "context-projection-notice",
    role: "system",
    timestamp: new Date(0).toISOString(),
    content: [{
      type: "text",
      text: `[Context projection compacted ${compactedMessages} older assistant/tool messages. User instructions remain verbatim. originalChars=${originalChars} projectedChars=${projectedChars} overflow=${stats.budgetOverflow}.]`,
    }],
  });
  return { messages: projected, stats };
}
