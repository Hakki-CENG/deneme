import type { AgentMessage, JsonValue, SessionSnapshot } from "../types.js";

export interface TranscriptExport {
  schemaVersion: 1;
  exportedAt: string;
  session: {
    sessionId: string;
    familyId: string;
    parentSessionId?: string;
    name: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    modelName?: string;
    modelFallbacks: string[];
    totalUsage: SessionSnapshot["totalUsage"];
  };
  messages: AgentMessage[];
  tasks: NonNullable<SessionSnapshot["tasks"]>;
  goal: SessionSnapshot["goal"] | null;
}

export function transcriptAsJson(session: SessionSnapshot, exportedAt = new Date().toISOString()): TranscriptExport {
  return {
    schemaVersion: 1,
    exportedAt,
    session: {
      sessionId: session.sessionId,
      familyId: session.familyId,
      ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
      name: session.name,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.modelName ? { modelName: session.modelName } : {}),
      modelFallbacks: session.modelFallbacks ?? [],
      totalUsage: structuredClone(session.totalUsage),
    },
    messages: structuredClone(session.messages.filter((message) => !message.hidden)),
    tasks: structuredClone(session.tasks ?? []),
    goal: structuredClone(session.goal ?? null),
  };
}

export interface TrainingTrajectory {
  schemaVersion: "haf.trajectory.v1";
  sessionId: string;
  familyId: string;
  model: string | null;
  startedAt: string;
  endedAt: string;
  outcome: "completed" | "failed" | "incomplete";
  usage: SessionSnapshot["totalUsage"];
  conversations: Array<{
    from: "human" | "gpt" | "tool";
    value: string;
    messageId: string;
    timestamp: string;
    images?: Array<{ mimeType: string; sha256?: string; alt?: string }>;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, JsonValue> }>;
    toolResult?: { toolCallId: string; name: string; result: JsonValue; isError: boolean };
  }>;
}

export function transcriptAsTrajectory(session: SessionSnapshot): TrainingTrajectory {
  const conversations: TrainingTrajectory["conversations"] = [];
  for (const message of session.messages) {
    if (message.hidden || message.role === "system") continue; // Hidden/runtime instructions are never exported as training data.
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.type === "text" ? part.text : "")
      .join("\n");
    const images: Array<{ mimeType: string; sha256?: string; alt?: string }> = message.content.flatMap((part) =>
      part.type === "image" ? [{
        mimeType: part.mimeType,
        ...(part.sha256 ? { sha256: part.sha256 } : {}),
        ...(part.alt ? { alt: part.alt } : {}),
      }] : [],
    );
    const calls = message.content
      .filter((part) => part.type === "tool_call")
      .map((part) => part.type === "tool_call" ? { id: part.id, name: part.name, arguments: structuredClone(part.arguments) } : undefined)
      .filter((part): part is { id: string; name: string; arguments: Record<string, JsonValue> } => Boolean(part));
    const result = message.content.find((part) => part.type === "tool_result");
    if (message.role === "tool" && result?.type === "tool_result") {
      conversations.push({
        from: "tool",
        value: JSON.stringify(result.result),
        messageId: message.id,
        timestamp: message.timestamp,
        toolResult: {
          toolCallId: result.toolCallId,
          name: result.name,
          result: structuredClone(result.result),
          isError: result.isError,
        },
      });
    } else if (message.role === "user" || message.role === "assistant") {
      conversations.push({
        from: message.role === "user" ? "human" : "gpt",
        value: [text, ...images.map((image) => `[image ${image.mimeType}${image.sha256 ? ` sha256=${image.sha256}` : ""}]`)].filter(Boolean).join("\n"),
        messageId: message.id,
        timestamp: message.timestamp,
        ...(images.length ? { images } : {}),
        ...(calls.length ? { toolCalls: calls } : {}),
      });
    }
  }
  return {
    schemaVersion: "haf.trajectory.v1",
    sessionId: session.sessionId,
    familyId: session.familyId,
    model: session.modelName ?? null,
    startedAt: session.createdAt,
    endedAt: session.updatedAt,
    outcome: session.status === "closed" ? "completed" : session.status === "failed" ? "failed" : "incomplete",
    usage: structuredClone(session.totalUsage),
    conversations,
  };
}

function fenced(value: JsonValue | Record<string, JsonValue>): string {
  const body = JSON.stringify(value, null, 2).replaceAll("```", "` ` `");
  return `\n\n\`\`\`json\n${body}\n\`\`\``;
}

function messageMarkdown(message: AgentMessage): string {
  const output: string[] = [`## ${message.role[0]!.toUpperCase()}${message.role.slice(1)}`, `_${message.timestamp}_`];
  for (const part of message.content) {
    if (part.type === "text") output.push(part.text);
    else if (part.type === "image") output.push(`**Image attachment:** \`${part.mimeType}\`${part.sha256 ? ` · SHA-256 \`${part.sha256}\`` : ""}${part.alt ? ` · ${part.alt}` : ""}`);
    else if (part.type === "tool_call") output.push(`**Tool call: \`${part.name}\`**${fenced(part.arguments)}`);
    else output.push(`**Tool result: \`${part.name}\`${part.isError ? " (error)" : ""}**${fenced(part.result)}`);
  }
  return output.join("\n\n");
}

export function transcriptAsMarkdown(session: SessionSnapshot, exportedAt = new Date().toISOString()): string {
  const lines = [
    `# ${session.name.replace(/^#+\s*/, "")}`,
    "",
    `- Session: \`${session.sessionId}\``,
    `- Family: \`${session.familyId}\``,
    `- Status: ${session.status}`,
    `- Model: ${session.modelName ?? "default"}`,
    `- Exported: ${exportedAt}`,
    `- Usage: ${session.totalUsage.inputTokens} input / ${session.totalUsage.outputTokens} output tokens`,
  ];
  if (session.goal) lines.push("", "## Persistent goal", "", `**${session.goal.status}:** ${session.goal.objective}`);
  if (session.tasks?.length) {
    lines.push("", "## Task board", "");
    for (const task of session.tasks) {
      lines.push(`- [${task.status === "done" ? "x" : " "}] **${task.title}** — ${task.status}/${task.priority} (\`${task.id}\`)`);
    }
  }
  lines.push("", "# Conversation", "");
  for (const message of session.messages.filter((message) => !message.hidden)) lines.push(messageMarkdown(message), "", "---", "");
  return `${lines.join("\n").trim()}\n`;
}
