import { randomUUID } from "node:crypto";
import type { AgentMessage, ModelProvider, ModelRequest, ModelStreamEvent, ToolCallContent } from "../types.js";

function textOf(message: AgentMessage): string {
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

// End-anchored: a prompt that IS just a tool directive.
const toolPattern = /\[tool\s+([a-zA-Z0-9_.-]+)\s+([\s\S]+)\]\s*$/;

// Same directive embedded in a longer prompt.
//
// This exists because the end-anchored form alone made the capability path
// unreachable from a real task. The execution loop does not send the goal
// verbatim: `buildAgentBriefing` puts the goal first and appends constraints,
// the plan and recalled memories, so the prompt never ends with `]` and the
// pattern above could not match. Measured, that meant no task ever produced a
// tool call, no capability was ever invoked, and `embodiment` -- which backs the
// `filesystem.*` capabilities -- stayed idle no matter how it was wired.
//
// Non-greedy on the arguments so an embedded directive stops at its own closing
// bracket rather than running to the last one in the prompt.
const embeddedToolPattern = /\[tool\s+([a-zA-Z0-9_.-]+)\s+([\s\S]+?)\]/;

export class MockModelProvider implements ModelProvider {
  readonly id = "mock";

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const last = request.messages.at(-1);
    if (!last) {
      yield { type: "text_delta", delta: "No input." };
      yield { type: "done", stopReason: "end_turn" };
      return;
    }
    if (last.role === "tool") {
      const toolResult = last.content.find((part) => part.type === "tool_result");
      const text = `Tool ${toolResult?.type === "tool_result" ? toolResult.name : "unknown"} completed: ${JSON.stringify(toolResult?.type === "tool_result" ? toolResult.result : null)}`;
      yield { type: "text_delta", delta: text };
      yield { type: "usage", usage: { inputTokens: 20, outputTokens: Math.ceil(text.length / 4), cacheReadTokens: 0, cacheWriteTokens: 0 } };
      yield { type: "done", stopReason: "end_turn" };
      return;
    }
    const input = textOf(last);
    const match = toolPattern.exec(input) ?? embeddedToolPattern.exec(input);
    if (match) {
      const name = match[1]!;
      let argumentsValue: Record<string, any> = {};
      try {
        argumentsValue = JSON.parse(match[2]!);
      } catch {
        argumentsValue = { raw: match[2]! };
      }
      const call: ToolCallContent = { type: "tool_call", id: randomUUID(), name, arguments: argumentsValue };
      yield { type: "tool_call", call };
      yield { type: "usage", usage: { inputTokens: Math.ceil(input.length / 4), outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      yield { type: "done", stopReason: "tool_use" };
      return;
    }
    const answer = `HAF mock response: ${input}`;
    for (const chunk of answer.match(/.{1,24}/g) ?? []) yield { type: "text_delta", delta: chunk };
    yield { type: "usage", usage: { inputTokens: Math.ceil(input.length / 4), outputTokens: Math.ceil(answer.length / 4), cacheReadTokens: 0, cacheWriteTokens: 0 } };
    yield { type: "done", stopReason: "end_turn" };
  }
}
