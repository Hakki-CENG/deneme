import type { Supervisor } from "../runtime/supervisor.js";

export interface SessionSearchHit {
  sessionId: string;
  name: string;
  score: number;
  updatedAt: string;
  snippets: Array<{ messageId: string; role: string; text: string }>;
}

function tokens(value: string): string[] {
  return value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((item) => item.length > 1);
}

export class SessionSearchService {
  constructor(private readonly supervisor: Supervisor) {}

  async search(tenantId: string, query: string, limit = 20): Promise<SessionSearchHit[]> {
    const terms = [...new Set(tokens(query))];
    if (!terms.length) return [];
    const sessions = await this.supervisor.listSessions(tenantId);
    const hits: SessionSearchHit[] = [];
    for (const session of sessions) {
      let score = 0;
      const snippets: SessionSearchHit["snippets"] = [];
      for (const message of session.messages) {
        if (message.hidden) continue;
        const text = message.content
          .filter((part) => part.type === "text")
          .map((part) => part.type === "text" ? part.text : "")
          .join(" ");
        if (!text) continue;
        const words = tokens(text);
        const frequencies = new Map<string, number>();
        for (const word of words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
        let messageScore = 0;
        for (const term of terms) {
          const frequency = frequencies.get(term) ?? 0;
          if (frequency) messageScore += 1 + Math.log(frequency);
          else if (text.toLocaleLowerCase().includes(term)) messageScore += 0.35;
        }
        if (messageScore > 0) {
          score += messageScore;
          snippets.push({
            messageId: message.id,
            role: message.role,
            text: text.replace(/\s+/g, " ").slice(0, 500),
          });
        }
      }
      if (session.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) score += 3;
      if (score > 0) {
        hits.push({
          sessionId: session.sessionId,
          name: session.name,
          score: Number(score.toFixed(3)),
          updatedAt: session.updatedAt,
          snippets: snippets.sort((a, b) => b.text.length - a.text.length).slice(0, 5),
        });
      }
    }
    return hits.sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit);
  }
}
