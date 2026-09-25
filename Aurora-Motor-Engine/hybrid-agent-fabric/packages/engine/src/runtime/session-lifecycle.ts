import { join } from "node:path";
import type { SessionSnapshot } from "../types.js";
import { auroraDigest, auroraInteger, auroraRound, auroraText, DurableJsonState } from "../util/aurora-state.js";

const MAX_RECORDS = 100_000;
const MAX_PRICES = 200;

export interface SessionLifecycleRecord {
  sessionId: string;
  tenantId: string;
  state: "active" | "archived";
  reason?: string;
  actor: string;
  archivedAt?: string;
  restoredAt?: string;
  updatedAt: string;
}

export interface ModelPrice {
  /** `provider:model`, or a bare model id. Longest match wins, so a provider prefix can override. */
  route: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
  updatedAt: string;
}

export interface SessionCost {
  sessionId: string;
  tenantId: string;
  name: string;
  status: string;
  modelName?: string;
  /** Where the model name came from: the session chose one, or the runtime default applied. */
  modelSource: "session" | "runtime-default" | "unknown";
  state: SessionLifecycleRecord["state"];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number };
  /** Cost from the provider when it reported one, otherwise derived from the price table. */
  costUsd: number;
  costSource: "provider" | "price-table" | "unpriced";
  priceRoute?: string;
  updatedAt: string;
}

export interface TenantUsageRollup {
  tenantId: string;
  sessions: number;
  archived: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unpricedSessions: number;
  byModel: Array<{ model: string; sessions: number; totalTokens: number; costUsd: number }>;
  topSessions: Array<{ sessionId: string; name: string; totalTokens: number; costUsd: number }>;
  generatedAt: string;
}

interface LifecycleStateShape {
  schemaVersion: 1;
  records: SessionLifecycleRecord[];
  prices: ModelPrice[];
}

/**
 * Session lifecycle and cost.
 *
 * Two things every peer CLI has and Aurora did not: a way to get a finished session out of the way
 * without destroying it, and a straight answer to "what did this cost?".
 *
 * - **Archive, not delete.** An archived session keeps every event, snapshot and artefact; it simply
 *   refuses new work until it is restored. Deletion stays a separate, explicit, audited operation,
 *   because "tidy up my session list" and "destroy the evidence" must never be the same gesture.
 * - **Cost is derived, never invented.** When a provider reports a cost, that number is used and
 *   labelled `provider`. Otherwise the operator's own price table is applied and labelled
 *   `price-table`. A model with no price is reported as `unpriced` rather than silently counted as
 *   free — an unpriced model is a gap in the operator's configuration, and hiding it produces a
 *   confidently wrong invoice.
 */
export class SessionLifecycleService {
  private readonly store: DurableJsonState<LifecycleStateShape>;

  constructor(
    rootPath: string,
    private readonly deps: {
      sessions: (tenantId?: string) => Promise<SessionSnapshot[]>;
      session: (sessionId: string) => Promise<SessionSnapshot>;
      /** The model a session actually runs on when it never selected one explicitly. */
      defaultModel?: () => string | undefined;
    },
    private readonly now: () => number = Date.now,
  ) {
    this.store = new DurableJsonState<LifecycleStateShape>(
      join(rootPath, "sessions", "lifecycle.json"),
      () => ({ schemaVersion: 1, records: [], prices: [] }),
      (value) => {
        const state = value as LifecycleStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.records) && Array.isArray(state.prices);
      },
      "Aurora session lifecycle",
    );
  }

  async state(tenantId: string, sessionId: string): Promise<SessionLifecycleRecord> {
    const state = await this.store.read();
    const found = state.records.find((item) => item.tenantId === tenantId && item.sessionId === sessionId);
    return found
      ? structuredClone(found)
      : { sessionId, tenantId, state: "active", actor: "default", updatedAt: new Date(this.now()).toISOString() };
  }

  /** True when the session must refuse new work. Cheap enough to call on the command path. */
  async isArchived(tenantId: string, sessionId: string): Promise<boolean> {
    return (await this.state(tenantId, sessionId)).state === "archived";
  }

  async archive(input: { tenantId: string; sessionId: string; reason: string; actor?: string }): Promise<SessionLifecycleRecord> {
    return await this.transition({ ...input, next: "archived" });
  }

  async restore(input: { tenantId: string; sessionId: string; reason: string; actor?: string }): Promise<SessionLifecycleRecord> {
    return await this.transition({ ...input, next: "active" });
  }

  async list(tenantId: string, filter: { state?: SessionLifecycleRecord["state"]; limit?: number } = {}): Promise<SessionLifecycleRecord[]> {
    const state = await this.store.read();
    return state.records
      .filter((item) => item.tenantId === tenantId && (filter.state ? item.state === filter.state : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, auroraInteger(filter.limit ?? 100, 1, 1000, "Lifecycle limit"))
      .map((item) => structuredClone(item));
  }

  async prices(tenantId: string): Promise<ModelPrice[]> {
    const state = await this.store.read();
    return state.prices.filter((item) => item.route.startsWith(`${tenantId}:`) || !item.route.includes("|"))
      .map((item) => structuredClone(item))
      .sort((a, b) => a.route.localeCompare(b.route));
  }

  async setPrice(input: { route: string; inputPerMillionUsd: number; outputPerMillionUsd: number; cacheReadPerMillionUsd?: number }): Promise<ModelPrice> {
    const route = auroraText(input.route, 200, "Model route").toLowerCase();
    const positive = (value: number, label: string): number => {
      if (!Number.isFinite(value) || value < 0 || value > 100_000) throw new Error(`${label} is invalid.`);
      return Number(value.toFixed(6));
    };
    return await this.store.mutate((state) => {
      const price: ModelPrice = {
        route,
        inputPerMillionUsd: positive(input.inputPerMillionUsd, "Input price"),
        outputPerMillionUsd: positive(input.outputPerMillionUsd, "Output price"),
        ...(input.cacheReadPerMillionUsd === undefined ? {} : { cacheReadPerMillionUsd: positive(input.cacheReadPerMillionUsd, "Cache read price") }),
        updatedAt: new Date(this.now()).toISOString(),
      };
      const index = state.prices.findIndex((item) => item.route === route);
      if (index >= 0) state.prices[index] = price;
      else {
        if (state.prices.length >= MAX_PRICES) throw new Error(`The price table is limited to ${MAX_PRICES} entries.`);
        state.prices.push(price);
      }
      return structuredClone(price);
    });
  }

  async removePrice(route: string): Promise<{ route: string; removed: boolean }> {
    const id = route.trim().toLowerCase();
    return await this.store.mutate((state) => {
      const index = state.prices.findIndex((item) => item.route === id);
      if (index < 0) return { route: id, removed: false };
      state.prices.splice(index, 1);
      return { route: id, removed: true };
    });
  }

  /** Cost for one session, with the source of the number stated. */
  async cost(sessionId: string): Promise<SessionCost> {
    const snapshot = await this.deps.session(sessionId);
    const state = await this.store.read();
    return this.costOf(snapshot, state, await this.state(snapshot.tenantId, sessionId));
  }

  /** Tenant-wide rollup: what was spent, on which models, and what could not be priced. */
  async usage(tenantId: string, options: { limit?: number } = {}): Promise<TenantUsageRollup> {
    const [snapshots, state] = await Promise.all([this.deps.sessions(tenantId), this.store.read()]);
    const records = new Map(state.records.filter((item) => item.tenantId === tenantId).map((item) => [item.sessionId, item]));
    const costs = snapshots.map((snapshot) => this.costOf(
      snapshot,
      state,
      records.get(snapshot.sessionId) ?? { sessionId: snapshot.sessionId, tenantId, state: "active", actor: "default", updatedAt: snapshot.updatedAt },
    ));
    const byModel = new Map<string, { model: string; sessions: number; totalTokens: number; costUsd: number }>();
    for (const item of costs) {
      const model = item.modelName ?? "unknown";
      const entry = byModel.get(model) ?? { model, sessions: 0, totalTokens: 0, costUsd: 0 };
      entry.sessions++;
      entry.totalTokens += item.usage.totalTokens;
      entry.costUsd = auroraRound(entry.costUsd + item.costUsd);
      byModel.set(model, entry);
    }
    return {
      tenantId,
      sessions: costs.length,
      archived: costs.filter((item) => item.state === "archived").length,
      totalTokens: costs.reduce((sum, item) => sum + item.usage.totalTokens, 0),
      inputTokens: costs.reduce((sum, item) => sum + item.usage.inputTokens, 0),
      outputTokens: costs.reduce((sum, item) => sum + item.usage.outputTokens, 0),
      costUsd: auroraRound(costs.reduce((sum, item) => sum + item.costUsd, 0)),
      unpricedSessions: costs.filter((item) => item.costSource === "unpriced" && item.usage.totalTokens > 0).length,
      byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)),
      topSessions: costs
        .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens || a.sessionId.localeCompare(b.sessionId))
        .slice(0, auroraInteger(options.limit ?? 10, 1, 100, "Top session limit"))
        .map((item) => ({ sessionId: item.sessionId, name: item.name, totalTokens: item.usage.totalTokens, costUsd: item.costUsd })),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  private costOf(snapshot: SessionSnapshot, state: LifecycleStateShape, record: SessionLifecycleRecord): SessionCost {
    const usage = snapshot.totalUsage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const totalTokens = usage.inputTokens + usage.outputTokens;
    const reported = typeof usage.costUsd === "number" && usage.costUsd > 0 ? usage.costUsd : undefined;
    const runtimeDefault = this.deps.defaultModel?.();
    const modelName = snapshot.modelName ?? runtimeDefault;
    const modelSource: SessionCost["modelSource"] = snapshot.modelName ? "session" : runtimeDefault ? "runtime-default" : "unknown";
    const price = this.priceFor(state, modelName);
    const derived = price
      ? auroraRound(
        (usage.inputTokens / 1_000_000) * price.inputPerMillionUsd
        + (usage.outputTokens / 1_000_000) * price.outputPerMillionUsd
        + (usage.cacheReadTokens / 1_000_000) * (price.cacheReadPerMillionUsd ?? 0),
      )
      : undefined;
    return {
      sessionId: snapshot.sessionId,
      tenantId: snapshot.tenantId,
      name: snapshot.name,
      status: snapshot.status,
      ...(modelName ? { modelName } : {}),
      modelSource,
      state: record.state,
      usage: { ...usage, totalTokens },
      costUsd: reported ?? derived ?? 0,
      costSource: reported !== undefined ? "provider" : derived !== undefined ? "price-table" : "unpriced",
      ...(price ? { priceRoute: price.route } : {}),
      updatedAt: snapshot.updatedAt,
    };
  }

  /** Longest matching route wins, so `openai:gpt-5` beats a bare `gpt-5` entry. */
  private priceFor(state: LifecycleStateShape, modelName?: string): ModelPrice | undefined {
    if (!modelName) return undefined;
    const target = modelName.toLowerCase();
    return state.prices
      .filter((item) => target === item.route || target.startsWith(item.route) || target.endsWith(item.route))
      .sort((a, b) => b.route.length - a.route.length)[0];
  }

  private async transition(input: { tenantId: string; sessionId: string; reason: string; actor?: string; next: SessionLifecycleRecord["state"] }): Promise<SessionLifecycleRecord> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const sessionId = auroraText(input.sessionId, 200, "Session ID");
    const reason = auroraText(input.reason, 1000, "Reason");
    const actor = auroraText(input.actor ?? "operator", 200, "Actor");
    // The session must exist and belong to the tenant: archiving is not a way to probe for ids.
    const snapshot = await this.deps.session(sessionId);
    if (snapshot.tenantId !== tenantId) throw new Error("Session does not belong to this tenant.");

    return await this.store.mutate((state) => {
      const timestamp = new Date(this.now()).toISOString();
      const existing = state.records.find((item) => item.tenantId === tenantId && item.sessionId === sessionId);
      const record: SessionLifecycleRecord = existing ?? {
        sessionId, tenantId, state: "active", actor, updatedAt: timestamp,
      };
      if (record.state === input.next) throw new Error(`Session is already ${input.next}.`);
      record.state = input.next;
      record.reason = reason;
      record.actor = actor;
      record.updatedAt = timestamp;
      if (input.next === "archived") record.archivedAt = timestamp;
      else record.restoredAt = timestamp;
      if (!existing) {
        if (state.records.length >= MAX_RECORDS) state.records.splice(0, state.records.length - MAX_RECORDS + 1);
        state.records.push(record);
      }
      return structuredClone(record);
    });
  }
}

/** Stable identity for a rendered command template, used for de-duplication and audit. */
export function commandDigest(name: string, body: string): string {
  return auroraDigest(`${name}:${body}`);
}
