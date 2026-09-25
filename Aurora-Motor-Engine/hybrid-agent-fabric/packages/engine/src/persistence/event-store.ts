import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EventEnvelope } from "../types.js";
import { AsyncMutex } from "../util/async-mutex.js";

export type EventListener = (event: EventEnvelope) => void;

export interface EventStore {
  append(event: EventEnvelope): Promise<void>;
  read(sessionId: string, afterSequence?: number, limit?: number): Promise<EventEnvelope[]>;
  lastSequence(sessionId: string): Promise<number>;
  subscribe(sessionId: string, listener: EventListener): () => void;
  subscribeAll(listener: EventListener): () => void;
}

export class FileEventStore implements EventStore {
  private readonly mutexes = new Map<string, AsyncMutex>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly globalListeners = new Set<EventListener>();
  private readonly cache = new Map<string, EventEnvelope[]>();

  constructor(private readonly rootPath: string) {}

  private pathFor(sessionId: string): string {
    return join(this.rootPath, "events", `${sessionId}.jsonl`);
  }

  private mutexFor(sessionId: string): AsyncMutex {
    let mutex = this.mutexes.get(sessionId);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.mutexes.set(sessionId, mutex);
    }
    return mutex;
  }

  private async load(sessionId: string): Promise<EventEnvelope[]> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    let events: EventEnvelope[] = [];
    try {
      const content = await readFile(this.pathFor(sessionId), "utf8");
      events = content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EventEnvelope)
        .sort((left, right) => left.sequence - right.sequence);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.cache.set(sessionId, events);
    return events;
  }

  async append(event: EventEnvelope): Promise<void> {
    await this.mutexFor(event.sessionId).runExclusive(async () => {
      const events = await this.load(event.sessionId);
      const previous = events.at(-1);
      if (previous && event.generation === previous.generation && event.sequence !== previous.sequence + 1) {
        throw new Error(`Non-contiguous event sequence for ${event.sessionId}: expected ${previous.sequence + 1}, got ${event.sequence}`);
      }
      if (previous && event.generation < previous.generation) {
        throw new Error(`Stale event generation ${event.generation}; current is ${previous.generation}`);
      }
      await mkdir(dirname(this.pathFor(event.sessionId)), { recursive: true });
      await appendFile(this.pathFor(event.sessionId), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      events.push(event);
    });
    for (const listener of [...(this.listeners.get(event.sessionId) ?? []), ...this.globalListeners]) {
      try {
        listener(event);
      } catch {
        // Event observers are intentionally fail-open.
      }
    }
  }

  async read(sessionId: string, afterSequence = 0, limit = 1000): Promise<EventEnvelope[]> {
    const events = await this.load(sessionId);
    return events.filter((event) => event.sequence > afterSequence).slice(0, Math.max(0, limit));
  }

  async lastSequence(sessionId: string): Promise<number> {
    return (await this.load(sessionId)).at(-1)?.sequence ?? 0;
  }

  subscribe(sessionId: string, listener: EventListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) this.listeners.delete(sessionId);
    };
  }

  subscribeAll(listener: EventListener): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }
}

export class MemoryEventStore implements EventStore {
  private readonly events = new Map<string, EventEnvelope[]>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly globalListeners = new Set<EventListener>();

  async append(event: EventEnvelope): Promise<void> {
    const events = this.events.get(event.sessionId) ?? [];
    const last = events.at(-1);
    if (last && last.generation === event.generation && event.sequence !== last.sequence + 1) {
      throw new Error("Non-contiguous sequence");
    }
    events.push(event);
    this.events.set(event.sessionId, events);
    for (const listener of [...(this.listeners.get(event.sessionId) ?? []), ...this.globalListeners]) listener(event);
  }

  async read(sessionId: string, afterSequence = 0, limit = 1000): Promise<EventEnvelope[]> {
    return (this.events.get(sessionId) ?? []).filter((event) => event.sequence > afterSequence).slice(0, limit);
  }

  async lastSequence(sessionId: string): Promise<number> {
    return this.events.get(sessionId)?.at(-1)?.sequence ?? 0;
  }

  subscribe(sessionId: string, listener: EventListener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => set.delete(listener);
  }

  subscribeAll(listener: EventListener): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }
}
