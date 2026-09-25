import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ApprovalRequest, CapabilityRisk, JsonValue } from "../types.js";
import { DurableJsonState, auroraInteger, auroraText } from "../util/aurora-state.js";

const MAX_RULES_PER_TENANT = 50;
const MAX_DECISIONS = 500;
const MAX_PATTERN_CHARS = 300;

/** Risk classes an automatic answer may never cover, whatever a rule says. */
const NEVER_AUTO_APPROVED: CapabilityRisk[] = ["privileged"];

export interface AutoApprovalRule {
  id: string;
  tenantId: string;
  /** Capability id or a `prefix.*` glob. `*` alone is refused: a rule must name what it covers. */
  capabilityPattern: string;
  /** Risk classes this rule may answer for. Empty means "the risk of the matched capability", still bounded by the floor. */
  riskClasses: CapabilityRisk[];
  /** Every pattern must match the JSON preview of the arguments for the rule to fire. */
  argumentPatterns: string[];
  /** Any match here refuses the automatic answer, even if the rule otherwise fits. */
  refusePatterns: string[];
  sessionIds: string[];
  /** Why this class of action is safe to answer without a human. Required; it is the audit record. */
  rationale: string;
  enabled: boolean;
  maxUses?: number;
  uses: number;
  expiresAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Rules an agent proposed arrive disabled: proposing is not granting. */
  proposedByAgent: boolean;
}

export interface AutoApprovalDecision {
  id: string;
  tenantId: string;
  sessionId: string;
  capabilityId: string;
  risk: CapabilityRisk;
  outcome: "auto-approved" | "escalated";
  ruleId?: string;
  rationale: string;
  argumentsPreview: JsonValue;
  decidedAt: string;
  sequence: number;
}

interface AutoApprovalStateShape {
  schemaVersion: 1;
  rules: AutoApprovalRule[];
  decisions: AutoApprovalDecision[];
  sequence: number;
}

export interface AutoApprovalReview {
  autoApproved: boolean;
  rationale: string;
  ruleId?: string;
}

function isState(value: unknown): value is AutoApprovalStateShape {
  const candidate = value as AutoApprovalStateShape | undefined;
  return Boolean(candidate && candidate.schemaVersion === 1 && Array.isArray(candidate.rules) && Array.isArray(candidate.decisions));
}

function compilePattern(pattern: string): RegExp {
  return new RegExp(auroraText(pattern, MAX_PATTERN_CHARS, "Argument pattern"), "i");
}

function matchesCapability(pattern: string, capabilityId: string): boolean {
  if (pattern.endsWith(".*")) return capabilityId.startsWith(pattern.slice(0, -1));
  return pattern === capabilityId;
}

/**
 * Reviewed automatic approvals.
 *
 * Aurora already had a way to stop asking: `auto` and `dontAsk` modes answer by risk class. That is a
 * blunt instrument — it says "anything of this shape, forever, because the operator flipped a dial",
 * and nothing about the decision survives afterwards. Peers shipped a different thing (`--approve-for-me`):
 * a *reviewed* answer for a *named class* of request, with the reasoning recorded. The distinction is
 * auditability, and it is the whole point:
 *
 * - **a rule must name what it covers.** `*` is refused; `git.*` is fine. A rule that covers everything
 *   is just `bypass` with extra steps.
 * - **a rule must carry a rationale.** It is stored on the rule and copied onto every decision it makes,
 *   so "why was this allowed?" is answerable months later without reconstructing anyone's intent.
 * - **there is a floor nothing crosses.** Privileged capabilities are never automatically answered, and
 *   an installation can switch the whole mechanism off through managed settings — a lower layer cannot
 *   switch it back on.
 * - **rules wear out.** Optional expiry and a use budget, both enforced, because a standing exemption
 *   granted for one migration should not still be live next year.
 * - **an agent may propose, never grant.** Proposals arrive disabled and need an operator to enable them.
 * - **escalations are recorded too.** A request the policy declined to auto-answer is written to the same
 *   log as one it did, so the log shows what the mechanism *refused*, not only what it waved through.
 */
export class AutoApprovalService {
  private readonly state: DurableJsonState<AutoApprovalStateShape>;
  private enabledCheck?: (tenantId: string) => Promise<boolean>;

  constructor(rootPath: string, private readonly now: () => number = Date.now) {
    this.state = new DurableJsonState<AutoApprovalStateShape>(
      resolve(rootPath, "policy", "auto-approvals.json"),
      () => ({ schemaVersion: 1, rules: [], decisions: [], sequence: 0 }),
      isState,
      "Auto-approval state",
    );
  }

  /** Managed settings can switch the mechanism off entirely; nothing below that layer can switch it on. */
  bindEnabled(check: (tenantId: string) => Promise<boolean>): void {
    this.enabledCheck = check;
  }

  async upsertRule(input: {
    tenantId: string;
    capabilityPattern: string;
    rationale: string;
    id?: string | undefined;
    riskClasses?: CapabilityRisk[] | undefined;
    argumentPatterns?: string[] | undefined;
    refusePatterns?: string[] | undefined;
    sessionIds?: string[] | undefined;
    enabled?: boolean | undefined;
    maxUses?: number | undefined;
    expiresAt?: string | undefined;
    createdBy?: string | undefined;
    proposedByAgent?: boolean | undefined;
  }): Promise<AutoApprovalRule> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const capabilityPattern = auroraText(input.capabilityPattern, 200, "Capability pattern");
    if (capabilityPattern === "*" || capabilityPattern === ".*" || !/^[A-Za-z0-9_.:-]+(\.\*)?$/.test(capabilityPattern)) {
      throw new Error("An auto-approval rule must name a capability or a `prefix.*` family, never everything.");
    }
    const riskClasses = (input.riskClasses ?? []).map((risk) => {
      if (NEVER_AUTO_APPROVED.includes(risk)) throw new Error(`Risk class "${risk}" can never be answered automatically.`);
      return risk;
    });
    const patterns = (input.argumentPatterns ?? []).slice(0, 10);
    const refusals = (input.refusePatterns ?? []).slice(0, 10);
    for (const pattern of [...patterns, ...refusals]) compilePattern(pattern);

    return await this.state.mutate((state) => {
      const existing = input.id ? state.rules.find((rule) => rule.id === input.id && rule.tenantId === tenantId) : undefined;
      if (!existing && state.rules.filter((rule) => rule.tenantId === tenantId).length >= MAX_RULES_PER_TENANT) {
        throw new Error(`A tenant may hold at most ${MAX_RULES_PER_TENANT} auto-approval rules.`);
      }
      const nowIso = new Date(this.now()).toISOString();
      const rule: AutoApprovalRule = {
        id: existing?.id ?? `auto-approval-${randomUUID()}`,
        tenantId,
        capabilityPattern,
        riskClasses,
        argumentPatterns: patterns,
        refusePatterns: refusals,
        sessionIds: (input.sessionIds ?? []).slice(0, 20).map((id) => auroraText(id, 200, "Session ID")),
        rationale: auroraText(input.rationale, 2000, "Rule rationale"),
        // A proposal is never live on arrival, whatever it asks for.
        enabled: input.proposedByAgent ? false : input.enabled ?? true,
        ...(input.maxUses === undefined ? {} : { maxUses: auroraInteger(input.maxUses, 1, 10_000, "Rule use budget") }),
        uses: existing?.uses ?? 0,
        ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt).toISOString() } : {}),
        createdBy: auroraText(input.createdBy ?? (input.proposedByAgent ? "agent" : "operator"), 200, "Rule author"),
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
        proposedByAgent: input.proposedByAgent ?? existing?.proposedByAgent ?? false,
      };
      if (existing) state.rules[state.rules.indexOf(existing)] = rule;
      else state.rules.push(rule);
      return structuredClone(rule);
    });
  }

  async setEnabled(tenantId: string, ruleId: string, enabled: boolean): Promise<AutoApprovalRule> {
    return await this.state.mutate((state) => {
      const rule = state.rules.find((item) => item.id === ruleId && item.tenantId === tenantId);
      if (!rule) throw new Error("Auto-approval rule not found.");
      rule.enabled = enabled;
      rule.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(rule);
    });
  }

  async removeRule(tenantId: string, ruleId: string): Promise<boolean> {
    return await this.state.mutate((state) => {
      const index = state.rules.findIndex((item) => item.id === ruleId && item.tenantId === tenantId);
      if (index < 0) return false;
      state.rules.splice(index, 1);
      return true;
    });
  }

  async listRules(tenantId: string): Promise<AutoApprovalRule[]> {
    const state = await this.state.read();
    return state.rules.filter((rule) => rule.tenantId === tenantId).map((rule) => structuredClone(rule));
  }

  async listDecisions(filter: { tenantId: string; sessionId?: string | undefined; limit?: number | undefined }): Promise<AutoApprovalDecision[]> {
    const state = await this.state.read();
    return state.decisions
      .filter((decision) => decision.tenantId === filter.tenantId)
      .filter((decision) => (filter.sessionId ? decision.sessionId === filter.sessionId : true))
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, auroraInteger(filter.limit ?? 50, 1, MAX_DECISIONS, "Decision limit"))
      .map((decision) => structuredClone(decision));
  }

  /**
   * Review one approval request. Returns whether it was answered automatically and why — and records
   * both answers, so the log shows what the mechanism refused as well as what it allowed.
   */
  async review(request: ApprovalRequest): Promise<AutoApprovalReview> {
    const record = async (review: AutoApprovalReview): Promise<AutoApprovalReview> => {
      await this.state.mutate((state) => {
        state.sequence += 1;
        state.decisions.push({
          id: `auto-decision-${randomUUID()}`,
          tenantId: request.tenantId,
          sessionId: request.sessionId,
          capabilityId: request.capabilityId,
          risk: request.risk,
          outcome: review.autoApproved ? "auto-approved" : "escalated",
          ...(review.ruleId ? { ruleId: review.ruleId } : {}),
          rationale: review.rationale,
          argumentsPreview: request.argumentsPreview,
          decidedAt: new Date(this.now()).toISOString(),
          sequence: state.sequence,
        });
        if (state.decisions.length > MAX_DECISIONS) state.decisions.splice(0, state.decisions.length - MAX_DECISIONS);
      });
      return review;
    };

    if (NEVER_AUTO_APPROVED.includes(request.risk)) {
      return await record({ autoApproved: false, rationale: `Risk class "${request.risk}" always needs a human.` });
    }
    if (this.enabledCheck) {
      const allowed = await this.enabledCheck(request.tenantId).catch(() => false);
      if (!allowed) return await record({ autoApproved: false, rationale: "Automatic approvals are disabled for this tenant." });
    }

    const state = await this.state.read();
    const nowMs = this.now();
    const candidates = state.rules.filter((rule) => rule.tenantId === request.tenantId && rule.enabled);
    const preview = JSON.stringify(request.argumentsPreview ?? null);

    for (const rule of candidates) {
      if (!matchesCapability(rule.capabilityPattern, request.capabilityId)) continue;
      if (rule.riskClasses.length > 0 && !rule.riskClasses.includes(request.risk)) continue;
      if (rule.sessionIds.length > 0 && !rule.sessionIds.includes(request.sessionId)) continue;
      if (rule.expiresAt && Date.parse(rule.expiresAt) <= nowMs) continue;
      if (rule.maxUses !== undefined && rule.uses >= rule.maxUses) continue;
      if (rule.refusePatterns.some((pattern) => compilePattern(pattern).test(preview))) {
        return await record({
          autoApproved: false,
          ruleId: rule.id,
          rationale: `Rule ${rule.id} matched but its refusal pattern fired; escalated to a human.`,
        });
      }
      if (!rule.argumentPatterns.every((pattern) => compilePattern(pattern).test(preview))) continue;

      await this.state.mutate((current) => {
        const live = current.rules.find((item) => item.id === rule.id);
        if (live) {
          live.uses += 1;
          live.updatedAt = new Date(this.now()).toISOString();
        }
      });
      return await record({ autoApproved: true, ruleId: rule.id, rationale: rule.rationale });
    }
    return await record({ autoApproved: false, rationale: "No reviewed rule covers this request." });
  }
}
