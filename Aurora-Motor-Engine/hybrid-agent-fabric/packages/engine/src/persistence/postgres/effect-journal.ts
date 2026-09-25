import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../types.js";
import { EffectOutcomeUncertainError, type EffectJournalLike } from "../effect-journal.js";
import { PostgresDatabase } from "./database.js";

export class PostgresEffectJournal implements EffectJournalLike {
  private readonly active = new Map<string, Promise<JsonValue>>();
  private readonly completed = new Map<string, JsonValue>();
  constructor(private readonly database: PostgresDatabase) {}

  async execute(key: string, operation: () => Promise<JsonValue>, tenantId = "system"): Promise<JsonValue> {
    await this.database.ensureSchema();
    if (this.completed.has(key)) return this.completed.get(key)!;
    const running = this.active.get(key);
    if (running) return await running;
    const ownerId = randomUUID();
    await this.database.pool.query(
      `INSERT INTO ${this.database.table("effect_journal")} (effect_key,tenant_id,owner_id,state)
       VALUES ($1,$2,$3,'started') ON CONFLICT (effect_key) DO NOTHING`, [key, tenantId, ownerId],
    );
    const ownership = await this.database.pool.query<{ owner_id: string; state: string; result: JsonValue | null }>(
      `SELECT owner_id,state,result FROM ${this.database.table("effect_journal")} WHERE effect_key=$1`, [key],
    );
    const existing = ownership.rows[0];
    if (existing?.owner_id !== ownerId) {
      if (existing?.state === "completed" && existing.result !== null) {
        this.completed.set(key, existing.result);
        return existing.result;
      }
      throw new EffectOutcomeUncertainError(key);
    }
    const promise = (async () => {
      const result = await operation();
      await this.database.pool.query(
        `UPDATE ${this.database.table("effect_journal")} SET state='completed',result=$2::jsonb,updated_at=now() WHERE effect_key=$1`,
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
