import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentInboxMessage, AgentInboxState } from "../types.js";
import { AsyncMutex } from "../util/async-mutex.js";
import { atomicWrite } from "../util/atomic-file.js";
import type { PgClientLike, PostgresDatabase } from "../persistence/postgres/database.js";

export type AgentInboxWakeListener = (targetSessionId: string) => void;

export interface AgentInboxStore {
  enqueue(message: AgentInboxMessage): Promise<void>;
  pendingCount(targetSessionId: string): Promise<number>;
  claimNext(targetSessionId: string, effectiveModes: AgentInboxMessage["effectiveMode"][], ownerId: string): Promise<AgentInboxMessage | undefined>;
  markDelivered(id: string, targetSessionId: string, ownerId: string, deliveredAt?: string): Promise<AgentInboxMessage>;
  markUncertain(id: string, targetSessionId: string, ownerId: string, reason: string): Promise<AgentInboxMessage>;
  get(id: string, targetSessionId: string): Promise<AgentInboxMessage | undefined>;
  list(targetSessionId: string, states?: AgentInboxState[]): Promise<AgentInboxMessage[]>;
  subscribe(listener: AgentInboxWakeListener): () => void;
  close?(): Promise<void>;
}

export interface AgentInboxOptions {
  claimTimeoutMs?: number;
  now?: () => number;
}

function sessionFileKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function clone(message: AgentInboxMessage): AgentInboxMessage {
  return structuredClone(message);
}

export class FileAgentInboxStore implements AgentInboxStore {
  private readonly locks = new Map<string, AsyncMutex>();
  private readonly listeners = new Set<AgentInboxWakeListener>();
  private readonly claimTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly rootPath: string, options: AgentInboxOptions = {}) {
    this.claimTimeoutMs = options.claimTimeoutMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  private path(targetSessionId: string): string {
    return join(this.rootPath, "agent-inbox", `${sessionFileKey(targetSessionId)}.json`);
  }

  private lock(targetSessionId: string): AsyncMutex {
    let lock = this.locks.get(targetSessionId);
    if (!lock) {
      lock = new AsyncMutex();
      this.locks.set(targetSessionId, lock);
    }
    return lock;
  }

  private async load(targetSessionId: string): Promise<AgentInboxMessage[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path(targetSessionId), "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("Agent inbox file must contain an array.");
      return parsed as AgentInboxMessage[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private recoverStaleClaims(messages: AgentInboxMessage[]): void {
    const deadline = this.now() - this.claimTimeoutMs;
    for (const message of messages) {
      if (message.state === "claimed" && Date.parse(message.updatedAt) <= deadline) {
        message.state = "uncertain";
        message.uncertainReason = "claim_owner_lost_before_delivery_confirmation";
        message.updatedAt = new Date(this.now()).toISOString();
        delete message.ownerId;
      }
    }
  }

  private async save(targetSessionId: string, messages: AgentInboxMessage[]): Promise<void> {
    await mkdir(join(this.rootPath, "agent-inbox"), { recursive: true, mode: 0o700 });
    await atomicWrite(this.path(targetSessionId), `${JSON.stringify(messages, null, 2)}\n`);
  }

  async enqueue(message: AgentInboxMessage): Promise<void> {
    let inserted = false;
    await this.lock(message.targetSessionId).runExclusive(async () => {
      const messages = await this.load(message.targetSessionId);
      this.recoverStaleClaims(messages);
      if (messages.some((item) => item.id === message.id || item.commandId === message.commandId)) return;
      messages.push(clone(message));
      await this.save(message.targetSessionId, messages);
      inserted = true;
    });
    if (inserted) for (const listener of this.listeners) {
      try { listener(message.targetSessionId); } catch {}
    }
  }

  async pendingCount(targetSessionId: string): Promise<number> {
    return await this.lock(targetSessionId).runExclusive(async () => {
      const messages = await this.load(targetSessionId);
      const before = JSON.stringify(messages);
      this.recoverStaleClaims(messages);
      if (JSON.stringify(messages) !== before) await this.save(targetSessionId, messages);
      return messages.filter((message) => message.state === "pending" || message.state === "claimed").length;
    });
  }

  async claimNext(targetSessionId: string, effectiveModes: AgentInboxMessage["effectiveMode"][], ownerId: string): Promise<AgentInboxMessage | undefined> {
    return await this.lock(targetSessionId).runExclusive(async () => {
      const messages = await this.load(targetSessionId);
      this.recoverStaleClaims(messages);
      const next = messages
        .filter((message) => message.state === "pending" && effectiveModes.includes(message.effectiveMode))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!next) {
        await this.save(targetSessionId, messages);
        return undefined;
      }
      next.state = "claimed";
      next.ownerId = ownerId;
      next.updatedAt = new Date(this.now()).toISOString();
      await this.save(targetSessionId, messages);
      return clone(next);
    });
  }

  private async transition(id: string, targetSessionId: string, ownerId: string, state: "delivered" | "uncertain", details: { deliveredAt?: string; reason?: string }): Promise<AgentInboxMessage> {
    return await this.lock(targetSessionId).runExclusive(async () => {
      const messages = await this.load(targetSessionId);
      const message = messages.find((item) => item.id === id);
      if (!message) throw new Error(`Agent inbox message ${id} does not exist.`);
      if (message.state === state) return clone(message);
      if (message.state !== "claimed" || message.ownerId !== ownerId) throw new Error(`Agent inbox message ${id} is not owned by this delivery attempt.`);
      message.state = state;
      message.updatedAt = new Date(this.now()).toISOString();
      if (state === "delivered") {
        message.deliveredAt = details.deliveredAt ?? message.updatedAt;
        delete message.uncertainReason;
      } else {
        message.uncertainReason = details.reason ?? "delivery_outcome_uncertain";
      }
      delete message.ownerId;
      await this.save(targetSessionId, messages);
      return clone(message);
    });
  }

  async markDelivered(id: string, targetSessionId: string, ownerId: string, deliveredAt?: string): Promise<AgentInboxMessage> {
    return await this.transition(id, targetSessionId, ownerId, "delivered", { ...(deliveredAt ? { deliveredAt } : {}) });
  }

  async markUncertain(id: string, targetSessionId: string, ownerId: string, reason: string): Promise<AgentInboxMessage> {
    return await this.transition(id, targetSessionId, ownerId, "uncertain", { reason });
  }

  async get(id: string, targetSessionId: string): Promise<AgentInboxMessage | undefined> {
    return (await this.list(targetSessionId)).find((item) => item.id === id);
  }

  async list(targetSessionId: string, states?: AgentInboxState[]): Promise<AgentInboxMessage[]> {
    return await this.lock(targetSessionId).runExclusive(async () => {
      const messages = await this.load(targetSessionId);
      const before = JSON.stringify(messages);
      this.recoverStaleClaims(messages);
      if (JSON.stringify(messages) !== before) await this.save(targetSessionId, messages);
      return messages
        .filter((message) => !states || states.includes(message.state))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map(clone);
    });
  }

  subscribe(listener: AgentInboxWakeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export class PostgresAgentInboxStore implements AgentInboxStore {
  private readonly claimTimeoutMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<AgentInboxWakeListener>();
  private readonly channel: string;
  private listenerClient: PgClientLike | undefined;
  private listenerPromise: Promise<void> | undefined;

  constructor(private readonly database: PostgresDatabase, options: AgentInboxOptions = {}) {
    this.claimTimeoutMs = options.claimTimeoutMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.channel = `haf_agent_inbox_${database.schema}`;
  }

  private row(row: any): AgentInboxMessage {
    return {
      id: row.id,
      commandId: row.command_id,
      tenantId: row.tenant_id,
      familyId: row.family_id,
      senderSessionId: row.sender_session_id,
      senderName: row.sender_name,
      targetSessionId: row.target_session_id,
      targetName: row.target_name,
      relationship: row.relationship,
      requestedMode: row.requested_mode,
      effectiveMode: row.effective_mode,
      text: row.text,
      state: row.state,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      ...(row.owner_id ? { ownerId: row.owner_id } : {}),
      ...(row.delivered_at ? { deliveredAt: new Date(row.delivered_at).toISOString() } : {}),
      ...(row.uncertain_reason ? { uncertainReason: row.uncertain_reason } : {}),
    };
  }

  private async recover(targetSessionId?: string): Promise<void> {
    await this.database.ensureSchema();
    await this.database.pool.query(`
      UPDATE ${this.database.table("agent_inbox")}
      SET state='uncertain', owner_id=NULL,
          uncertain_reason='claim_owner_lost_before_delivery_confirmation', updated_at=now()
      WHERE state='claimed' AND updated_at < $1
      ${targetSessionId ? "AND target_session_id=$2" : ""}
    `, targetSessionId
      ? [new Date(this.now() - this.claimTimeoutMs).toISOString(), targetSessionId]
      : [new Date(this.now() - this.claimTimeoutMs).toISOString()]);
  }

  async enqueue(message: AgentInboxMessage): Promise<void> {
    await this.database.ensureSchema();
    await this.database.pool.query(`
      INSERT INTO ${this.database.table("agent_inbox")} (
        id, command_id, tenant_id, family_id, sender_session_id, sender_name,
        target_session_id, target_name, relationship, requested_mode,
        effective_mode, text, state, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT DO NOTHING
    `, [
      message.id, message.commandId, message.tenantId, message.familyId,
      message.senderSessionId, message.senderName, message.targetSessionId,
      message.targetName, message.relationship, message.requestedMode,
      message.effectiveMode, message.text, message.state, message.createdAt, message.updatedAt,
    ]);
    if (this.database.enableNotify) {
      await this.database.pool.query("SELECT pg_notify($1, $2)", [this.channel, JSON.stringify({ targetSessionId: message.targetSessionId })]);
    }
    for (const listener of this.listeners) {
      try { listener(message.targetSessionId); } catch {}
    }
  }

  async pendingCount(targetSessionId: string): Promise<number> {
    await this.recover(targetSessionId);
    const result = await this.database.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM ${this.database.table("agent_inbox")}
      WHERE target_session_id=$1 AND state IN ('pending','claimed')
    `, [targetSessionId]);
    return Number(result.rows[0]?.count ?? 0);
  }

  async claimNext(targetSessionId: string, effectiveModes: AgentInboxMessage["effectiveMode"][], ownerId: string): Promise<AgentInboxMessage | undefined> {
    await this.recover(targetSessionId);
    if (effectiveModes.length === 0) return undefined;
    const result = await this.database.pool.query(`
      UPDATE ${this.database.table("agent_inbox")}
      SET state='claimed', owner_id=$3, updated_at=now()
      WHERE id = (
        SELECT id FROM ${this.database.table("agent_inbox")}
        WHERE target_session_id=$1 AND state='pending' AND effective_mode = ANY($2::text[])
        ORDER BY created_at ASC LIMIT 1
      ) AND state='pending'
      RETURNING *
    `, [targetSessionId, effectiveModes, ownerId]);
    return result.rows[0] ? this.row(result.rows[0]) : undefined;
  }

  private async transition(id: string, ownerId: string, state: "delivered" | "uncertain", value: string): Promise<AgentInboxMessage> {
    await this.database.ensureSchema();
    const result = state === "delivered"
      ? await this.database.pool.query(`
          UPDATE ${this.database.table("agent_inbox")}
          SET state='delivered', delivered_at=$3, owner_id=NULL, uncertain_reason=NULL, updated_at=now()
          WHERE id=$1 AND state='claimed' AND owner_id=$2 RETURNING *
        `, [id, ownerId, value])
      : await this.database.pool.query(`
          UPDATE ${this.database.table("agent_inbox")}
          SET state='uncertain', uncertain_reason=$3, owner_id=NULL, updated_at=now()
          WHERE id=$1 AND state='claimed' AND owner_id=$2 RETURNING *
        `, [id, ownerId, value]);
    if (!result.rows[0]) throw new Error(`Agent inbox message ${id} is not owned by this delivery attempt.`);
    return this.row(result.rows[0]);
  }

  async markDelivered(id: string, _targetSessionId: string, ownerId: string, deliveredAt = new Date(this.now()).toISOString()): Promise<AgentInboxMessage> {
    return await this.transition(id, ownerId, "delivered", deliveredAt);
  }

  async markUncertain(id: string, _targetSessionId: string, ownerId: string, reason: string): Promise<AgentInboxMessage> {
    return await this.transition(id, ownerId, "uncertain", reason);
  }

  async get(id: string, _targetSessionId: string): Promise<AgentInboxMessage | undefined> {
    await this.database.ensureSchema();
    const result = await this.database.pool.query(`SELECT * FROM ${this.database.table("agent_inbox")} WHERE id=$1`, [id]);
    return result.rows[0] ? this.row(result.rows[0]) : undefined;
  }

  async list(targetSessionId: string, states?: AgentInboxState[]): Promise<AgentInboxMessage[]> {
    await this.recover(targetSessionId);
    const result = states?.length
      ? await this.database.pool.query(`
          SELECT * FROM ${this.database.table("agent_inbox")}
          WHERE target_session_id=$1 AND state = ANY($2::text[]) ORDER BY created_at ASC
        `, [targetSessionId, states])
      : await this.database.pool.query(`
          SELECT * FROM ${this.database.table("agent_inbox")}
          WHERE target_session_id=$1 ORDER BY created_at ASC
        `, [targetSessionId]);
    return result.rows.map((row) => this.row(row));
  }

  subscribe(listener: AgentInboxWakeListener): () => void {
    this.listeners.add(listener);
    void this.ensureListener();
    return () => this.listeners.delete(listener);
  }

  private async ensureListener(): Promise<void> {
    if (!this.database.enableNotify || this.listenerClient || this.listenerPromise) return;
    this.listenerPromise = (async () => {
      await this.database.ensureSchema();
      const client = await this.database.pool.connect();
      this.listenerClient = client;
      client.on?.("notification", (message: { channel?: string; payload?: string }) => {
        if (message.channel !== this.channel || !message.payload) return;
        try {
          const targetSessionId = JSON.parse(message.payload).targetSessionId;
          if (typeof targetSessionId !== "string") return;
          for (const listener of this.listeners) {
            try { listener(targetSessionId); } catch {}
          }
        } catch {}
      });
      client.on?.("error", () => {
        this.listenerClient?.release();
        this.listenerClient = undefined;
        this.listenerPromise = undefined;
      });
      await client.query(`LISTEN "${this.channel}"`);
    })();
    try {
      await this.listenerPromise;
    } catch {
      (this.listenerClient as PgClientLike | undefined)?.release();
      this.listenerClient = undefined;
      this.listenerPromise = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.listenerClient) {
      await this.listenerClient.query(`UNLISTEN "${this.channel}"`).catch(() => undefined);
      this.listenerClient.release();
      this.listenerClient = undefined;
    }
    this.listenerPromise = undefined;
    this.listeners.clear();
  }
}

export function newAgentInboxMessage(input: Omit<AgentInboxMessage, "id" | "commandId" | "state" | "createdAt" | "updatedAt">): AgentInboxMessage {
  const now = new Date().toISOString();
  return {
    ...input,
    id: randomUUID(),
    commandId: randomUUID(),
    state: "pending",
    createdAt: now,
    updatedAt: now,
  };
}
