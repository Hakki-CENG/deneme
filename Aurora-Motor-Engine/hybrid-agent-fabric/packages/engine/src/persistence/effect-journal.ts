import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "../types.js";
import { AsyncMutex } from "../util/async-mutex.js";

export interface EffectJournalLike {
  execute(key: string, operation: () => Promise<JsonValue>, tenantId?: string): Promise<JsonValue>;
}

interface EffectRecord {
  key: string;
  state: "started" | "completed";
  timestamp: string;
  result?: JsonValue;
}

export class EffectOutcomeUncertainError extends Error {
  constructor(key: string) {
    super(`Effect ${key} was started before a restart but has no durable outcome; automatic replay is blocked.`);
  }
}

export class EffectJournal implements EffectJournalLike {
  private readonly records = new Map<string, EffectRecord>();
  private readonly active = new Map<string, Promise<JsonValue>>();
  private readonly mutex = new AsyncMutex();
  private loaded = false;

  constructor(private readonly rootPath: string) {}

  private get path(): string {
    return join(this.rootPath, "journal", "effects.jsonl");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      for (const line of (await readFile(this.path, "utf8")).split("\n").filter(Boolean)) {
        const record = JSON.parse(line) as EffectRecord;
        this.records.set(record.key, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async write(record: EffectRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    this.records.set(record.key, record);
  }

  async execute(key: string, operation: () => Promise<JsonValue>, _tenantId?: string): Promise<JsonValue> {
    await this.mutex.runExclusive(() => this.load());
    const active = this.active.get(key);
    if (active) return active;
    const record = this.records.get(key);
    if (record?.state === "completed" && record.result !== undefined) return record.result;
    if (record?.state === "started") throw new EffectOutcomeUncertainError(key);

    const promise = (async () => {
      await this.mutex.runExclusive(() => this.write({ key, state: "started", timestamp: new Date().toISOString() }));
      const result = await operation();
      await this.mutex.runExclusive(() =>
        this.write({ key, state: "completed", timestamp: new Date().toISOString(), result }),
      );
      return result;
    })();
    this.active.set(key, promise);
    try {
      return await promise;
    } finally {
      this.active.delete(key);
    }
  }
}
