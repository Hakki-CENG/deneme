import { randomUUID } from "node:crypto";
import type { CommandEnvelope, CommandResult } from "../../types.js";
import type { CommandJournalLike } from "../command-journal.js";
import { PostgresDatabase } from "./database.js";

export class PostgresCommandJournal implements CommandJournalLike {
  private readonly active = new Map<string, Promise<CommandResult>>();
  private readonly completed = new Map<string, CommandResult>();
  constructor(private readonly database: PostgresDatabase) {}

  private key(command: CommandEnvelope): string {
    return `${command.tenantId}:${command.clientId}:${command.commandId}`;
  }

  async execute(command: CommandEnvelope, operation: () => Promise<CommandResult>): Promise<CommandResult> {
    await this.database.ensureSchema();
    const key = this.key(command);
    const cached = this.completed.get(key);
    if (cached) return cached;
    const running = this.active.get(key);
    if (running) return await running;
    const ownerId = randomUUID();
    await this.database.pool.query(
      `INSERT INTO ${this.database.table("command_journal")} (journal_key, tenant_id, command_id, owner_id, state)
       VALUES ($1,$2,$3,$4,'started') ON CONFLICT (journal_key) DO NOTHING`,
      [key, command.tenantId, command.commandId, ownerId],
    );
    const ownership = await this.database.pool.query<{ owner_id: string; state: string; result: CommandResult | null }>(
      `SELECT owner_id,state,result FROM ${this.database.table("command_journal")} WHERE journal_key=$1`, [key],
    );
    const existing = ownership.rows[0];
    if (existing?.owner_id !== ownerId) {
      if (existing?.state === "completed" && existing.result) {
        this.completed.set(key, existing.result);
        return existing.result;
      }
      return {
        commandId: command.commandId,
        status: "uncertain",
        error: {
          code: "COMMAND_OUTCOME_UNCERTAIN",
          message: "The command is durably started by another process or lost its outcome; it was not replayed.",
          retryable: false,
        },
      };
    }
    const promise = (async () => {
      let result: CommandResult;
      try { result = await operation(); }
      catch (error) {
        result = {
          commandId: command.commandId,
          status: "rejected",
          error: { code: "COMMAND_FAILED", message: error instanceof Error ? error.message : String(error), retryable: false },
        };
      }
      await this.database.pool.query(
        `UPDATE ${this.database.table("command_journal")} SET state='completed',result=$2::jsonb,updated_at=now() WHERE journal_key=$1`,
        [key, JSON.stringify(result)],
      );
      this.completed.set(key, result);
      return result;
    })();
    this.active.set(key, promise);
    try { return await promise; }
    finally { this.active.delete(key); }
  }
}
