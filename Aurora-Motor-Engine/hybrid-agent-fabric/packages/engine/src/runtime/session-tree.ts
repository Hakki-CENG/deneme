import type { AgentMessage, SessionTreeEntry, SessionTreeState } from "../types.js";

export interface SessionTreeViewEntry extends SessionTreeEntry {
  active: boolean;
  childIds: string[];
  depth: number;
}

export class SessionTree {
  private readonly entries = new Map<string, SessionTreeEntry>();
  private activeLeafId: string | undefined;

  constructor(state?: SessionTreeState, legacyMessages: AgentMessage[] = []) {
    if (state?.entries.length) {
      for (const entry of state.entries) this.entries.set(entry.id, structuredClone(entry));
      this.activeLeafId = state.activeLeafId;
    } else {
      for (const message of legacyMessages) this.append(message);
    }
  }

  get state(): SessionTreeState {
    return {
      entries: [...this.entries.values()].map((entry) => structuredClone(entry)),
      ...(this.activeLeafId ? { activeLeafId: this.activeLeafId } : {}),
    };
  }

  get leafId(): string | undefined {
    return this.activeLeafId;
  }

  append(message: AgentMessage, options: { parentId?: string; contextReset?: boolean } = {}): SessionTreeEntry {
    if (this.entries.has(message.id)) throw new Error(`Session tree already contains message ${message.id}.`);
    const parentId = options.parentId ?? this.activeLeafId;
    if (parentId && !this.entries.has(parentId)) throw new Error(`Session tree parent ${parentId} does not exist.`);
    const entry: SessionTreeEntry = {
      id: message.id,
      ...(parentId ? { parentId } : {}),
      message: structuredClone(message),
      labels: [],
      ...(options.contextReset ? { contextReset: true } : {}),
      createdAt: new Date().toISOString(),
    };
    this.entries.set(entry.id, entry);
    this.activeLeafId = entry.id;
    return structuredClone(entry);
  }

  branch(entryId: string): AgentMessage[] {
    if (!this.entries.has(entryId)) throw new Error(`Session tree entry ${entryId} does not exist.`);
    this.activeLeafId = entryId;
    return this.activeMessages();
  }

  label(entryId: string, label: string | null): SessionTreeEntry {
    const entry = this.entries.get(entryId);
    if (!entry) throw new Error(`Session tree entry ${entryId} does not exist.`);
    if (label === null || !label.trim()) entry.labels = [];
    else {
      const normalized = label.trim().slice(0, 100);
      if (!entry.labels.includes(normalized)) entry.labels.push(normalized);
      entry.labels = entry.labels.slice(-10);
    }
    return structuredClone(entry);
  }

  activeMessages(): AgentMessage[] {
    if (!this.activeLeafId) return [];
    const reverse: AgentMessage[] = [];
    const seen = new Set<string>();
    let current = this.entries.get(this.activeLeafId);
    while (current) {
      if (seen.has(current.id)) throw new Error("Session tree contains a cycle.");
      seen.add(current.id);
      reverse.push(structuredClone(current.message));
      if (current.contextReset) break;
      current = current.parentId ? this.entries.get(current.parentId) : undefined;
    }
    return reverse.reverse();
  }

  view(): SessionTreeViewEntry[] {
    const children = new Map<string, string[]>();
    for (const entry of this.entries.values()) {
      if (!entry.parentId) continue;
      const list = children.get(entry.parentId) ?? [];
      list.push(entry.id);
      children.set(entry.parentId, list);
    }
    const activePath = new Set<string>();
    let active = this.activeLeafId ? this.entries.get(this.activeLeafId) : undefined;
    while (active) {
      if (activePath.has(active.id)) break;
      activePath.add(active.id);
      active = active.parentId ? this.entries.get(active.parentId) : undefined;
    }
    const depthOf = (entry: SessionTreeEntry): number => {
      let depth = 0;
      let parent = entry.parentId ? this.entries.get(entry.parentId) : undefined;
      const seen = new Set<string>();
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        depth++;
        parent = parent.parentId ? this.entries.get(parent.parentId) : undefined;
      }
      return depth;
    };
    return [...this.entries.values()].map((entry) => ({
      ...structuredClone(entry),
      active: activePath.has(entry.id),
      childIds: [...(children.get(entry.id) ?? [])],
      depth: depthOf(entry),
    }));
  }
}
