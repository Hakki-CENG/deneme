import type { EventEnvelope } from "../../types.js";
import type { EventListener, EventStore } from "../event-store.js";
import type { PgClientLike } from "./database.js";
import { PostgresDatabase } from "./database.js";

interface EventRow {
  event_id: string;
  tenant_id: string;
  session_id: string;
  family_id: string;
  generation: number;
  sequence: string | number;
  turn_id: string | null;
  trace_id: string;
  type: string;
  timestamp: string | Date;
  visibility: EventEnvelope["visibility"];
  redaction_class: EventEnvelope["redactionClass"];
  payload: EventEnvelope["payload"];
}

function fromRow(row: EventRow): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: row.event_id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    familyId: row.family_id,
    generation: Number(row.generation),
    sequence: Number(row.sequence),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    traceId: row.trace_id,
    type: row.type,
    timestamp: new Date(row.timestamp).toISOString(),
    visibility: row.visibility,
    redactionClass: row.redaction_class,
    payload: row.payload,
  };
}

export class PostgresEventStore implements EventStore {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly globalListeners = new Set<EventListener>();
  private listenerClient: PgClientLike | undefined;
  private listenerPromise: Promise<void> | undefined;
  private readonly seen = new Set<string>();
  private readonly channel: string;

  constructor(private readonly database: PostgresDatabase) {
    this.channel = `haf_events_${database.schema}`;
  }

  async append(event: EventEnvelope): Promise<void> {
    if (this.seen.has(event.eventId)) return;
    await this.database.ensureSchema();
    const result = await this.database.pool.query(
      `INSERT INTO ${this.database.table("events")} (
        event_id, tenant_id, session_id, family_id, generation, sequence, turn_id,
        trace_id, type, timestamp, visibility, redaction_class, payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
      ON CONFLICT (event_id) DO NOTHING`,
      [
        event.eventId, event.tenantId, event.sessionId, event.familyId, event.generation,
        event.sequence, event.turnId ?? null, event.traceId, event.type, event.timestamp,
        event.visibility, event.redactionClass, JSON.stringify(event.payload),
      ],
    );
    if ((result.rowCount ?? 0) === 0) return;
    this.markSeen(event.eventId);
    this.notify(event);
    if (this.database.enableNotify) {
      await this.database.pool.query("SELECT pg_notify($1, $2)", [this.channel, JSON.stringify({ eventId: event.eventId })]);
    }
  }

  async read(sessionId: string, afterSequence = 0, limit = 1000): Promise<EventEnvelope[]> {
    await this.database.ensureSchema();
    const result = await this.database.pool.query<EventRow>(
      `SELECT * FROM ${this.database.table("events")}
       WHERE session_id=$1 AND sequence>$2 ORDER BY sequence ASC LIMIT $3`,
      [sessionId, afterSequence, Math.max(0, limit)],
    );
    return result.rows.map(fromRow);
  }

  async lastSequence(sessionId: string): Promise<number> {
    await this.database.ensureSchema();
    const result = await this.database.pool.query<{ value: string | number }>(
      `SELECT COALESCE(MAX(sequence),0) AS value FROM ${this.database.table("events")} WHERE session_id=$1`,
      [sessionId],
    );
    return Number(result.rows[0]?.value ?? 0);
  }

  subscribe(sessionId: string, listener: EventListener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(sessionId, set);
    void this.ensureListener();
    return () => set.delete(listener);
  }

  subscribeAll(listener: EventListener): () => void {
    this.globalListeners.add(listener);
    void this.ensureListener();
    return () => this.globalListeners.delete(listener);
  }

  private notify(event: EventEnvelope): void {
    for (const listener of [...(this.listeners.get(event.sessionId) ?? []), ...this.globalListeners]) {
      try { listener(event); } catch {}
    }
  }

  private markSeen(eventId: string): void {
    this.seen.add(eventId);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!);
  }

  private async ensureListener(): Promise<void> {
    if (!this.database.enableNotify || this.listenerClient) return;
    if (this.listenerPromise) return await this.listenerPromise;
    this.listenerPromise = (async () => {
      await this.database.ensureSchema();
      const client = await this.database.pool.connect();
      this.listenerClient = client;
      client.on?.("notification", (message: { channel?: string; payload?: string }) => {
        if (message.channel !== this.channel || !message.payload) return;
        void this.handleNotification(message.payload);
      });
      client.on?.("error", () => {
        this.listenerClient?.release();
        this.listenerClient = undefined;
        this.listenerPromise = undefined;
      });
      await client.query(`LISTEN "${this.channel}"`);
    })();
    try { await this.listenerPromise; }
    catch {
      (this.listenerClient as PgClientLike | undefined)?.release();
      this.listenerClient = undefined;
      this.listenerPromise = undefined;
    }
  }

  private async handleNotification(payload: string): Promise<void> {
    let eventId: string | undefined;
    try { eventId = JSON.parse(payload).eventId; } catch {}
    if (!eventId || this.seen.has(eventId)) return;
    const result = await this.database.pool.query<EventRow>(
      `SELECT * FROM ${this.database.table("events")} WHERE event_id=$1`,
      [eventId],
    );
    const row = result.rows[0];
    if (!row) return;
    this.markSeen(eventId);
    this.notify(fromRow(row));
  }

  async close(): Promise<void> {
    if (this.listenerClient) {
      await this.listenerClient.query(`UNLISTEN "${this.channel}"`).catch(() => undefined);
      this.listenerClient.release();
      this.listenerClient = undefined;
    }
  }
}
