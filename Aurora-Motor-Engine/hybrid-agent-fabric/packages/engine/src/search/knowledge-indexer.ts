import type { AgentMessage, EventEnvelope, JsonValue, SessionSnapshot } from "../types.js";
import type { EventStore } from "../persistence/event-store.js";
import type { HybridSearchIndex } from "./hybrid-index.js";

function messageText(message: AgentMessage): string {
  return message.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "tool_result") return JSON.stringify(part.result);
    return "";
  }).filter(Boolean).join("\n");
}

export class KnowledgeIndexer {
  private readonly unsubscribe: () => void;
  constructor(
    events: EventStore,
    private readonly index: HybridSearchIndex,
  ) {
    this.unsubscribe = events.subscribeAll((event) => void this.observe(event));
  }

  async indexSession(snapshot: SessionSnapshot): Promise<number> {
    let count = 0;
    for (const message of snapshot.tree?.entries.map((entry) => entry.message) ?? snapshot.messages) {
      if (message.hidden) continue;
      const text = messageText(message);
      if (!text) continue;
      await this.index.upsert({
        id: `message:${snapshot.sessionId}:${message.id}`,
        tenantId: snapshot.tenantId,
        kind: "session_message",
        text,
        metadata: { sessionId: snapshot.sessionId, messageId: message.id, role: message.role },
      });
      count++;
    }
    return count;
  }

  close(): void { this.unsubscribe(); }

  private async observe(event: EventEnvelope): Promise<void> {
    if (event.type !== "message.created") return;
    const payload = event.payload as Record<string, JsonValue>;
    const message = payload.message as unknown as AgentMessage | undefined;
    if (!message?.id || message.hidden || event.visibility === "internal") return;
    const text = messageText(message);
    if (!text) return;
    await this.index.upsert({
      id: `message:${event.sessionId}:${message.id}`,
      tenantId: event.tenantId,
      kind: "session_message",
      text,
      metadata: { sessionId: event.sessionId, messageId: message.id, role: message.role },
    });
  }
}
