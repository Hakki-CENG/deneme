import { resolve } from "node:path";
import { DurableJsonState, auroraText } from "../util/aurora-state.js";

const MAX_OVERRIDES = 2000;
const MAX_DEFAULTS = 500;

export interface SessionBudgetLimits {
  /** Hard cap on session spend in USD. Absent means no money cap. */
  maxUsd?: number;
  /** Hard cap on total tokens. Absent means no token cap. */
  maxTokens?: number;
  /** Fraction of a cap at which the session is warned but still allowed. */
  warnAtFraction: number;
  /** What happens at the cap: refuse new turns, or record a warning and continue. */
  onExceeded: "block" | "warn";
}

export interface TenantBudgetDefaults extends SessionBudgetLimits {
  tenantId: string;
  updatedAt: string;
}

export interface SessionBudgetOverride extends SessionBudgetLimits {
  tenantId: string;
  sessionId: string;
  reason: string;
  setBy: string;
  updatedAt: string;
}

export interface SessionBudgetVerdict {
  tenantId: string;
  sessionId: string;
  state: "unlimited" | "ok" | "warning" | "exhausted";
  source: "session" | "tenant" | "none";
  limits: SessionBudgetLimits;
  spentUsd: number;
  totalTokens: number;
  /** Highest fraction of any cap that has been consumed, 0 when there is no cap. */
  consumedFraction: number;
  remainingUsd?: number;
  remainingTokens?: number;
  /** Only true when the cap is reached *and* the policy is to block. */
  blocked: boolean;
  message: string;
  /** Present when spend could not be priced, so a cap cannot be honestly enforced. */
  unpriced?: boolean;
}

interface BudgetStateShape {
  schemaVersion: 1;
  defaults: TenantBudgetDefaults[];
  overrides: SessionBudgetOverride[];
}

function isState(value: unknown): value is BudgetStateShape {
  const candidate = value as BudgetStateShape | undefined;
  return Boolean(candidate && candidate.schemaVersion === 1 && Array.isArray(candidate.defaults) && Array.isArray(candidate.overrides));
}

function normalizeLimits(input: Partial<SessionBudgetLimits>): SessionBudgetLimits {
  const limits: SessionBudgetLimits = {
    warnAtFraction: Math.min(0.99, Math.max(0.1, input.warnAtFraction ?? 0.8)),
    onExceeded: input.onExceeded === "warn" ? "warn" : "block",
  };
  if (input.maxUsd !== undefined) {
    if (!Number.isFinite(input.maxUsd) || input.maxUsd <= 0) throw new Error("A spend cap must be a positive number of dollars.");
    limits.maxUsd = Math.min(1_000_000, input.maxUsd);
  }
  if (input.maxTokens !== undefined) {
    if (!Number.isInteger(input.maxTokens) || input.maxTokens <= 0) throw new Error("A token cap must be a positive whole number.");
    limits.maxTokens = Math.min(10_000_000_000, input.maxTokens);
  }
  return limits;
}

/**
 * A session's spend cap was reached and the policy is to block.
 *
 * Typed so the HTTP layer answers 429 with the numbers behind the refusal
 * instead of an undifferentiated 500. Carrying the whole verdict matters: the
 * caller needs to know which cap fired and by how much to decide whether to
 * raise it, and `unpriced` tells them the money cap was not actually
 * enforceable rather than quietly holding.
 */
export class SessionBudgetExceededError extends Error {
  constructor(readonly verdict: SessionBudgetVerdict) {
    super(verdict.message);
    this.name = "SessionBudgetExceededError";
  }
}

/**
 * Session spend budgets.
 *
 * Aurora could already answer "what did this cost?" — a price table, a per-session cost and a tenant
 * rollup. What it could not do is answer "and stop when it reaches this much", which is the control an
 * operator actually wants before letting an agent run unattended overnight. Peers added exactly this:
 * a hard cap on a session's spend.
 *
 * The properties that make a cap real rather than decorative:
 *
 * - **it blocks new work, never truncates work in flight.** A turn already running finishes; the next
 *   one is refused. Killing a half-finished edit to save four cents is a worse outcome than the spend.
 * - **an unpriced model cannot be silently treated as free.** If cost cannot be derived, a *money* cap
 *   reports `unpriced` and does not pretend to hold; the token cap, which is always measurable, still
 *   does. Hiding an unenforceable cap behind a green light is how budgets get discovered in an invoice.
 * - **a warning comes before the wall,** at a configurable fraction, so an agent can wrap up rather
 *   than being cut off mid-plan.
 * - **overrides are attributed.** Raising a session's cap records who did it and why.
 */
export class SessionBudgetService {
  private readonly state: DurableJsonState<BudgetStateShape>;

  constructor(rootPath: string, private readonly now: () => number = Date.now) {
    this.state = new DurableJsonState<BudgetStateShape>(
      resolve(rootPath, "policy", "session-budgets.json"),
      () => ({ schemaVersion: 1, defaults: [], overrides: [] }),
      isState,
      "Session budget state",
    );
  }

  async setTenantDefaults(input: { tenantId: string } & Partial<SessionBudgetLimits>): Promise<TenantBudgetDefaults> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const limits = normalizeLimits(input);
    return await this.state.mutate((state) => {
      const record: TenantBudgetDefaults = { tenantId, ...limits, updatedAt: new Date(this.now()).toISOString() };
      const index = state.defaults.findIndex((item) => item.tenantId === tenantId);
      if (index >= 0) state.defaults[index] = record;
      else {
        if (state.defaults.length >= MAX_DEFAULTS) throw new Error("Too many tenant budget defaults are stored.");
        state.defaults.push(record);
      }
      return structuredClone(record);
    });
  }

  async setSessionBudget(input: { tenantId: string; sessionId: string; reason: string; setBy?: string } & Partial<SessionBudgetLimits>): Promise<SessionBudgetOverride> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const sessionId = auroraText(input.sessionId, 200, "Session ID");
    const limits = normalizeLimits(input);
    if (limits.maxUsd === undefined && limits.maxTokens === undefined) {
      throw new Error("A session budget needs a spend cap, a token cap, or both.");
    }
    return await this.state.mutate((state) => {
      const record: SessionBudgetOverride = {
        tenantId, sessionId, ...limits,
        reason: auroraText(input.reason, 1000, "Budget reason"),
        setBy: auroraText(input.setBy ?? "operator", 200, "Budget author"),
        updatedAt: new Date(this.now()).toISOString(),
      };
      const index = state.overrides.findIndex((item) => item.sessionId === sessionId && item.tenantId === tenantId);
      if (index >= 0) state.overrides[index] = record;
      else {
        if (state.overrides.length >= MAX_OVERRIDES) throw new Error("Too many session budgets are stored.");
        state.overrides.push(record);
      }
      return structuredClone(record);
    });
  }

  async clearSessionBudget(tenantId: string, sessionId: string): Promise<boolean> {
    return await this.state.mutate((state) => {
      const index = state.overrides.findIndex((item) => item.sessionId === sessionId && item.tenantId === tenantId);
      if (index < 0) return false;
      state.overrides.splice(index, 1);
      return true;
    });
  }

  async defaults(tenantId: string): Promise<TenantBudgetDefaults | undefined> {
    const state = await this.state.read();
    const found = state.defaults.find((item) => item.tenantId === tenantId);
    return found ? structuredClone(found) : undefined;
  }

  async overrides(tenantId: string): Promise<SessionBudgetOverride[]> {
    const state = await this.state.read();
    return state.overrides.filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item));
  }

  /** Evaluate a session's spend against whatever cap applies to it. */
  async evaluate(input: {
    tenantId: string; sessionId: string; spentUsd: number; totalTokens: number; costSource?: string;
  }): Promise<SessionBudgetVerdict> {
    const state = await this.state.read();
    const override = state.overrides.find((item) => item.sessionId === input.sessionId && item.tenantId === input.tenantId);
    const tenantDefault = state.defaults.find((item) => item.tenantId === input.tenantId);
    const limits = override ?? tenantDefault;
    const base: Omit<SessionBudgetVerdict, "state" | "message" | "blocked" | "consumedFraction"> = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      source: override ? "session" : tenantDefault ? "tenant" : "none",
      limits: limits ? { ...normalizeLimits(limits) } : { warnAtFraction: 0.8, onExceeded: "block" },
      spentUsd: input.spentUsd,
      totalTokens: input.totalTokens,
    };
    if (!limits || (limits.maxUsd === undefined && limits.maxTokens === undefined)) {
      return { ...base, state: "unlimited", consumedFraction: 0, blocked: false, message: "No budget applies to this session." };
    }

    const unpriced = input.costSource === "unpriced" && limits.maxUsd !== undefined;
    const usdFraction = limits.maxUsd !== undefined && !unpriced ? input.spentUsd / limits.maxUsd : 0;
    const tokenFraction = limits.maxTokens !== undefined ? input.totalTokens / limits.maxTokens : 0;
    const consumedFraction = Math.max(usdFraction, tokenFraction);
    const verdict: SessionBudgetVerdict = {
      ...base,
      consumedFraction,
      state: "ok",
      blocked: false,
      message: "Within budget.",
      ...(limits.maxUsd !== undefined ? { remainingUsd: Math.max(0, limits.maxUsd - input.spentUsd) } : {}),
      ...(limits.maxTokens !== undefined ? { remainingTokens: Math.max(0, limits.maxTokens - input.totalTokens) } : {}),
      ...(unpriced ? { unpriced: true } : {}),
    };

    if (consumedFraction >= 1) {
      verdict.state = "exhausted";
      verdict.blocked = limits.onExceeded === "block";
      const which = tokenFraction >= 1 ? `${input.totalTokens} tokens against a cap of ${limits.maxTokens}` : `$${input.spentUsd.toFixed(4)} against a cap of $${limits.maxUsd}`;
      verdict.message = `Session budget exhausted: ${which}. ${verdict.blocked ? "New turns are refused until the budget is raised." : "Continuing under a warn-only budget."}`;
    } else if (consumedFraction >= (limits.warnAtFraction ?? 0.8)) {
      verdict.state = "warning";
      verdict.message = `Session has used ${(consumedFraction * 100).toFixed(0)}% of its budget.`;
    }
    if (unpriced && verdict.state !== "exhausted") {
      verdict.message = `${verdict.message} The model used has no price entry, so the spend cap cannot be enforced; only the token cap applies.`;
    }
    return verdict;
  }
}
