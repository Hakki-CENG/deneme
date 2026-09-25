import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandEnvelope, CommandResult } from "../types.js";
import { AsyncMutex } from "../util/async-mutex.js";

export interface CommandJournalLike {
  execute(command: CommandEnvelope, operation: () => Promise<CommandResult>): Promise<CommandResult>;
}

interface JournalRecord {
  key: string;
  commandId: string;
  state: "started" | "completed";
  timestamp: string;
  result?: CommandResult;
}

export class CommandJournal implements CommandJournalLike {
  private readonly mutex = new AsyncMutex();
  private readonly records = new Map<string, JournalRecord>();
  private readonly inFlight = new Map<string, Promise<CommandResult>>();
  private loaded = false;

  constructor(private readonly rootPath: string) {}

  private get path(): string {
    return join(this.rootPath, "journal", "commands.jsonl");
  }

  private keyFor(command: CommandEnvelope): string {
    return `${command.tenantId}:${command.clientId}:${command.commandId}`;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const content = await readFile(this.path, "utf8");
      for (const line of content.split("\n").filter(Boolean)) {
        const record = JSON.parse(line) as JournalRecord;
        this.records.set(record.key, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async persist(record: JournalRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    this.records.set(record.key, record);
  }

  async execute(command: CommandEnvelope, operation: () => Promise<CommandResult>): Promise<CommandResult> {
    const key = this.keyFor(command);
    await this.mutex.runExclusive(() => this.ensureLoaded());

    const current = this.records.get(key);
    if (current?.state === "completed" && current.result) return current.result;
    const active = this.inFlight.get(key);
    if (active) return active;
    if (current?.state === "started") {
      return {
        commandId: command.commandId,
        status: "uncertain",
        error: {
          code: "COMMAND_OUTCOME_UNCERTAIN",
          message: "The command was durably accepted before a restart, but no durable outcome exists. It was not replayed automatically.",
          retryable: false,
        },
      };
    }

    const promise = (async () => {
      await this.mutex.runExclusive(() =>
        this.persist({ key, commandId: command.commandId, state: "started", timestamp: new Date().toISOString() }),
      );
      let result: CommandResult;
      try {
        result = await operation();
      } catch (error) {
        result = {
          commandId: command.commandId,
          status: "rejected",
          error: {
            code: "COMMAND_FAILED",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        };
      }
      await this.mutex.runExclusive(() =>
        this.persist({ key, commandId: command.commandId, state: "completed", timestamp: new Date().toISOString(), result }),
      );
      return result;
    })();

    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }
}
