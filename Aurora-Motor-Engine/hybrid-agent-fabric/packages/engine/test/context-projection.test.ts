import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/types.js";
import { projectIntentPreservingContext } from "../src/context/intent-preserving-projection.js";

function message(id: string, role: AgentMessage["role"], text: string): AgentMessage {
  return { id, role, timestamp: new Date(0).toISOString(), content: [{ type: "text", text }] };
}

describe("intent-preserving context projection", () => {
  it("keeps user instructions verbatim while compacting older derived output", () => {
    const mustKeep = "MUST KEEP: use the existing retry helper and never add a new one.";
    const oldAssistant = "assistant detail ".repeat(700);
    const toolResult = "tool output ".repeat(900);
    const messages: AgentMessage[] = [
      message("u1", "user", mustKeep),
      message("a1", "assistant", oldAssistant),
      {
        id: "t1",
        role: "tool",
        timestamp: new Date(1).toISOString(),
        content: [{ type: "tool_result", toolCallId: "call-1", name: "process.exec", result: { stdout: toolResult }, isError: false }],
      },
      message("u2", "user", "Now verify the final result."),
      message("a2", "assistant", "recent answer"),
    ];
    const original = structuredClone(messages);
    const projected = projectIntentPreservingContext(messages, { maxChars: 2_000, protectedTailChars: 300, derivedPreviewChars: 120 });
    const firstUser = projected.messages.find((item) => item.id === "u1")!;
    expect(firstUser).toEqual(messages[0]);
    expect(JSON.stringify(projected.messages)).toContain(mustKeep);
    expect(JSON.stringify(projected.messages)).toContain("_haf_compacted");
    expect(JSON.stringify(projected.messages)).toContain("sha256");
    expect(projected.messages.find((item) => item.id === "a2")).toEqual(messages[4]);
    expect(projected.stats.compactedMessages).toBe(2);
    expect(projected.stats.projectedChars).toBeLessThan(projected.stats.originalChars);
    expect(messages).toEqual(original);
  });

  it("reports soft-budget overflow instead of silently deleting oversized user intent", () => {
    const instruction = "user-source-of-truth ".repeat(500);
    const projected = projectIntentPreservingContext([
      message("u1", "user", instruction),
      message("a1", "assistant", "derived ".repeat(500)),
      message("u2", "user", "latest"),
    ], { maxChars: 1_000, protectedTailChars: 100, derivedPreviewChars: 80 });
    expect(projected.stats.budgetOverflow).toBe(true);
    expect(projected.messages.find((item) => item.id === "u1")?.content[0]).toEqual({ type: "text", text: instruction });
  });
});
