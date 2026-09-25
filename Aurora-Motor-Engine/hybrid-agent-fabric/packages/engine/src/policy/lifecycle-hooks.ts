import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PolicyDecision } from "../types.js";
import type { PolicyEngine, PolicyInput } from "./policy-engine.js";
import { auroraInteger, auroraText, DurableJsonState } from "../util/aurora-state.js";

const MAX_RULES = 500;
const MAX_FIRINGS = 20_000;

export type LifecycleEvent = "session.start" | "session.stop" | "prompt.submit" | "tool.pre" | "tool.post";
export type LifecycleAction = "allow" | "warn" | "require_approval" | "deny";

export interface LifecycleHookRule {
  id: string;
  tenantId: string;
  event: LifecycleEvent;
  enabled: boolean;
  description: string;
  /** Capability id globs (`fs.*`, `git.push`). Empty means "every capability" for tool events. */
  capabilityIds: string[];
  /** Bounded regular expression tested against the JSON-serialised arguments or prompt text. */
  argumentPattern?: string;
  /** When present, the rule only applies to calls running under one of these agent profiles. */
  agentProfileIds?: string[];
  action: LifecycleAction;
  reason: string;
  /**
   * Optional side effect. Deliberately **not** a shell command: a hook action invokes an allowlisted
   * governed capability, so it passes the same policy, approval and audit path as any other call.
   */
  runCapability?: { capabilityId: string; input: Record<string, unknown> };
  priority: number;
  createdAt: string;
  updatedAt: string;
  firedCount: number;
  lastFiredAt?: string;
}

export interface LifecycleFiring {
  id: string;
  tenantId: string;
  ruleId: string;
  event: LifecycleEvent;
  action: LifecycleAction;
  subject: string;
  reason: string;
  actionResult?: { capabilityId: string; status: "ok" | "failed" | "skipped"; detail: string };
  at: string;
}

export interface LifecycleHookConfig {
  tenantId: string;
  enabled: boolean;
  /** Hook actions are inert until a tenant explicitly allows them to run capabilities. */
  allowCapabilityActions: boolean;
  /** Capability ids a hook action may invoke. Empty means none, whatever a rule claims. */
  actionAllowlist: string[];
  updatedAt: string;
}

interface HookStateShape {
  schemaVersion: 1;
  rules: LifecycleHookRule[];
  firings: LifecycleFiring[];
  configs: LifecycleHookConfig[];
}

export interface LifecycleRunResult {
  event: LifecycleEvent;
  subject: string;
  matched: LifecycleFiring[];
  decision: LifecycleAction;
  blocked: boolean;
  generatedAt: string;
}

/**
 * Deterministic lifecycle hooks.
 *
 * Peers learned the same lesson from production: some rules must fire *every time*, not when a model
 * decides they are relevant — formatters, secret scrubbing, build gates, "never touch production".
 * Claude Code runs shell hooks on lifecycle events; Codex runs a smaller set. Aurora adds the same
 * primitive with two deliberate differences:
 *
 * - a hook **cannot shell out**. Its optional side effect invokes an allowlisted governed capability,
 *   so hook effects go through policy, approval, the effect journal and the audit trail like anything
 *   else. A hook cannot become a hole in the capability boundary;
 * - a `tool.pre` hook joins the layered policy stack as an **escalation-only** layer: it can warn,
 *   require approval or deny, but it can never grant authority another layer withheld.
 *
 * Everything is bounded: rule count, pattern length, regex evaluation with a literal fallback, action
 * allowlist, and a durable firing ledger so "why did my tool call get blocked?" is answerable.
 */
export class LifecycleHookService {
  private readonly store: DurableJsonState<HookStateShape>;
  /** Guards against a hook action re-entering the hook layer through the capability it invokes. */
  private readonly running = new Set<string>();

  constructor(
    rootPath: string,
    private readonly deps: {
      execute?: (input: { tenantId: string; capabilityId: string; input: Record<string, unknown>; reason: string }) => Promise<unknown>;
    } = {},
    private readonly now: () => number = Date.now,
  ) {
    this.store = new DurableJsonState<HookStateShape>(
      join(rootPath, "policy", "lifecycle-hooks.json"),
      () => ({ schemaVersion: 1, rules: [], firings: [], configs: [] }),
      (value) => {
        const state = value as HookStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.rules) && Array.isArray(state.firings) && Array.isArray(state.configs);
      },
      "Aurora lifecycle hooks",
    );
  }

  async config(tenantId: string): Promise<LifecycleHookConfig> {
    return await this.store.mutate((state) => structuredClone(this.mutableConfig(state, tenantId)));
  }

  async configure(input: { tenantId: string; enabled?: boolean; allowCapabilityActions?: boolean; actionAllowlist?: string[] }): Promise<LifecycleHookConfig> {
    return await this.store.mutate((state) => {
      const config = this.mutableConfig(state, input.tenantId);
      if (input.enabled !== undefined) config.enabled = input.enabled;
      if (input.allowCapabilityActions !== undefined) config.allowCapabilityActions = input.allowCapabilityActions;
      if (input.actionAllowlist !== undefined) {
        config.actionAllowlist = [...new Set(input.actionAllowlist.map((item) => auroraText(item, 200, "Action capability id")))].slice(0, 50);
      }
      config.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(config);
    });
  }

  async define(input: {
    tenantId: string; event: LifecycleEvent; description: string; action: LifecycleAction; reason: string;
    capabilityIds?: string[]; argumentPattern?: string; agentProfileIds?: string[];
    runCapability?: { capabilityId: string; input?: Record<string, unknown> };
    priority?: number; enabled?: boolean; id?: string;
  }): Promise<LifecycleHookRule> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const pattern = input.argumentPattern === undefined ? undefined : auroraText(input.argumentPattern, 500, "Argument pattern");
    if (pattern) compilePattern(pattern); // fail fast on an invalid or unbounded pattern
    return await this.store.mutate((state) => {
      if (state.rules.length >= MAX_RULES) throw new Error(`Lifecycle hooks are limited to ${MAX_RULES} rules.`);
      const id = input.id ? auroraText(input.id, 100, "Rule ID").toLowerCase() : `hook-${randomUUID()}`;
      const timestamp = new Date(this.now()).toISOString();
      const rule: LifecycleHookRule = {
        id,
        tenantId,
        event: input.event,
        enabled: input.enabled ?? true,
        description: auroraText(input.description, 500, "Hook description"),
        capabilityIds: [...new Set((input.capabilityIds ?? []).map((item) => auroraText(item, 200, "Capability pattern")))].slice(0, 50),
        ...(pattern ? { argumentPattern: pattern } : {}),
        ...(input.agentProfileIds?.length
          ? { agentProfileIds: [...new Set(input.agentProfileIds.map((item) => auroraText(item, 200, "Agent profile ID")))].slice(0, 50) }
          : {}),
        action: input.action,
        reason: auroraText(input.reason, 500, "Hook reason"),
        ...(input.runCapability
          ? { runCapability: { capabilityId: auroraText(input.runCapability.capabilityId, 200, "Action capability id"), input: input.runCapability.input ?? {} } }
          : {}),
        priority: auroraInteger(input.priority ?? 100, 1, 1000, "Hook priority"),
        createdAt: timestamp,
        updatedAt: timestamp,
        firedCount: 0,
      };
      const index = state.rules.findIndex((item) => item.tenantId === tenantId && item.id === id);
      if (index >= 0) {
        rule.createdAt = state.rules[index]!.createdAt;
        rule.firedCount = state.rules[index]!.firedCount;
        state.rules[index] = rule;
      } else {
        state.rules.push(rule);
      }
      return structuredClone(rule);
    });
  }

  async setEnabled(tenantId: string, ruleId: string, enabled: boolean): Promise<LifecycleHookRule> {
    return await this.store.mutate((state) => {
      const rule = state.rules.find((item) => item.tenantId === tenantId && item.id === ruleId);
      if (!rule) throw new Error("Lifecycle hook rule not found in tenant.");
      rule.enabled = enabled;
      rule.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(rule);
    });
  }

  async remove(tenantId: string, ruleId: string): Promise<{ ruleId: string; removed: boolean }> {
    return await this.store.mutate((state) => {
      const index = state.rules.findIndex((item) => item.tenantId === tenantId && item.id === ruleId);
      if (index < 0) return { ruleId, removed: false };
      state.rules.splice(index, 1);
      return { ruleId, removed: true };
    });
  }

  async rules(tenantId: string, event?: LifecycleEvent): Promise<LifecycleHookRule[]> {
    const state = await this.store.read();
    return state.rules
      .filter((item) => item.tenantId === tenantId && (event ? item.event === event : true))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map((item) => structuredClone(item));
  }

  async firings(tenantId: string, limit = 50): Promise<LifecycleFiring[]> {
    const state = await this.store.read();
    return state.firings
      .filter((item) => item.tenantId === tenantId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, auroraInteger(limit, 1, 1000, "Firing limit"))
      .map((item) => structuredClone(item));
  }

  /** Evaluate an event. Returns the strongest action across matching rules and records every firing. */
  async run(input: { tenantId: string; event: LifecycleEvent; subject: string; payload?: unknown; agentProfileId?: string }): Promise<LifecycleRunResult> {
    const config = await this.config(input.tenantId);
    const timestamp = new Date(this.now()).toISOString();
    if (!config.enabled) {
      return { event: input.event, subject: input.subject, matched: [], decision: "allow", blocked: false, generatedAt: timestamp };
    }
    if (this.running.has(input.tenantId)) {
      // A hook action is running: do not let its own capability call re-enter the hook layer.
      return { event: input.event, subject: input.subject, matched: [], decision: "allow", blocked: false, generatedAt: timestamp };
    }

    const rules = (await this.rules(input.tenantId, input.event)).filter((item) => item.enabled);
    const serialized = safeSerialize(input.payload);
    const matched: LifecycleFiring[] = [];
    let decision: LifecycleAction = "allow";

    for (const rule of rules) {
      if (!matchesCapability(rule.capabilityIds, input.subject)) continue;
      // A profile-scoped rule is inert for every other agent, and for calls with no profile at all.
      if (rule.agentProfileIds?.length && (!input.agentProfileId || !rule.agentProfileIds.includes(input.agentProfileId))) continue;
      if (rule.argumentPattern && !compilePattern(rule.argumentPattern).test(serialized)) continue;

      const firing: LifecycleFiring = {
        id: `firing-${randomUUID()}`,
        tenantId: input.tenantId,
        ruleId: rule.id,
        event: rule.event,
        action: rule.action,
        subject: input.subject,
        reason: rule.reason,
        at: timestamp,
      };

      if (rule.runCapability) {
        const actionResult = await this.invoke(input.tenantId, config, rule);
        if (actionResult) firing.actionResult = actionResult;
      }
      matched.push(firing);
      decision = strongest(decision, rule.action);
      if (rule.action === "deny") break;
    }

    if (matched.length) {
      await this.store.mutate((state) => {
        for (const firing of matched) {
          state.firings.push(firing);
          const rule = state.rules.find((item) => item.tenantId === input.tenantId && item.id === firing.ruleId);
          if (rule) { rule.firedCount++; rule.lastFiredAt = firing.at; }
        }
        if (state.firings.length > MAX_FIRINGS) state.firings.splice(0, state.firings.length - MAX_FIRINGS);
      });
    }

    return { event: input.event, subject: input.subject, matched, decision, blocked: decision === "deny", generatedAt: timestamp };
  }

  /** The `tool.pre` half of the service, shaped as a policy layer so it composes with the rest. */
  policyLayer(): PolicyEngine {
    return {
      decide: async (input: PolicyInput): Promise<PolicyDecision> => {
        try {
          const result = await this.run({
            tenantId: input.context.tenantId,
            event: "tool.pre",
            subject: input.descriptor.id,
            payload: input.arguments,
            ...(input.context.agentProfileId ? { agentProfileId: input.context.agentProfileId } : {}),
          });
          if (!result.matched.length) return { decision: "allow", reasonCode: "lifecycle_hook_no_match", message: "No lifecycle hook matched this call." };
          const strongestRule = result.matched.find((item) => item.action === result.decision) ?? result.matched[0]!;
          if (result.decision === "deny") {
            return { decision: "deny", reasonCode: "lifecycle_hook_denied", message: `Lifecycle hook "${strongestRule.ruleId}" denied this call: ${strongestRule.reason}` };
          }
          if (result.decision === "require_approval") {
            return { decision: "require_approval", reasonCode: "lifecycle_hook_confirm", message: `Lifecycle hook "${strongestRule.ruleId}" requires confirmation: ${strongestRule.reason}` };
          }
          return { decision: "allow", reasonCode: "lifecycle_hook_observed", message: `Lifecycle hook "${strongestRule.ruleId}" observed this call.` };
        } catch {
          // Fail in the safe direction: a broken hook store must not open a gate, and must not block
          // every call either — the other policy layers still decide.
          return { decision: "allow", reasonCode: "lifecycle_hook_unavailable", message: "Lifecycle hooks are unavailable; other policy layers still apply." };
        }
      },
    };
  }

  private async invoke(tenantId: string, config: LifecycleHookConfig, rule: LifecycleHookRule): Promise<LifecycleFiring["actionResult"]> {
    const action = rule.runCapability!;
    if (!config.allowCapabilityActions) {
      return { capabilityId: action.capabilityId, status: "skipped", detail: "Capability actions are disabled for this tenant." };
    }
    if (!config.actionAllowlist.includes(action.capabilityId)) {
      return { capabilityId: action.capabilityId, status: "skipped", detail: "Capability is not in the hook action allowlist." };
    }
    if (!this.deps.execute) {
      return { capabilityId: action.capabilityId, status: "skipped", detail: "No execution binding is configured." };
    }
    this.running.add(tenantId);
    try {
      await this.deps.execute({ tenantId, capabilityId: action.capabilityId, input: action.input, reason: `lifecycle hook ${rule.id}` });
      return { capabilityId: action.capabilityId, status: "ok", detail: "Hook action completed." };
    } catch (error) {
      return { capabilityId: action.capabilityId, status: "failed", detail: `${(error as Error).message}`.slice(0, 300) };
    } finally {
      this.running.delete(tenantId);
    }
  }

  private mutableConfig(state: HookStateShape, tenantId: string): LifecycleHookConfig {
    const id = auroraText(tenantId, 200, "Tenant ID");
    let config = state.configs.find((item) => item.tenantId === id);
    if (!config) {
      config = {
        tenantId: id,
        enabled: true,
        allowCapabilityActions: false,
        actionAllowlist: [],
        updatedAt: new Date(this.now()).toISOString(),
      };
      state.configs.push(config);
    }
    if (config.allowCapabilityActions === undefined) config.allowCapabilityActions = false;
    if (!Array.isArray(config.actionAllowlist)) config.actionAllowlist = [];
    return config;
  }
}

const ACTION_STRENGTH: Record<LifecycleAction, number> = { allow: 0, warn: 1, require_approval: 2, deny: 3 };

function strongest(left: LifecycleAction, right: LifecycleAction): LifecycleAction {
  return ACTION_STRENGTH[right] > ACTION_STRENGTH[left] ? right : left;
}

/** Minimal glob matching over capability ids: `*` matches within a segment run, exact otherwise. */
function matchesCapability(patterns: string[], subject: string): boolean {
  if (!patterns.length) return true;
  return patterns.some((pattern) => {
    if (pattern === "*" || pattern === "**") return true;
    if (!pattern.includes("*")) return pattern === subject;
    const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\s]*");
    return new RegExp(`^${escaped}$`).test(subject);
  });
}

/**
 * Patterns are operator-authored but still untrusted: length is bounded at definition time and the
 * expression is compiled with a literal fallback so a malformed rule disables itself instead of
 * throwing on every capability call.
 */
function compilePattern(pattern: string): RegExp {
  if (pattern.length > 500) throw new Error("Hook argument pattern is too long.");
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

function safeSerialize(payload: unknown): string {
  if (payload === undefined || payload === null) return "";
  if (typeof payload === "string") return payload.slice(0, 100_000);
  try {
    return JSON.stringify(payload).slice(0, 100_000);
  } catch {
    return "";
  }
}
