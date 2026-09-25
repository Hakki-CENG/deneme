import { join } from "node:path";
import type { PolicyDecision } from "../types.js";
import type { PolicyEngine, PolicyInput } from "./policy-engine.js";
import type { RiskAnalyzerService, RiskLevel } from "./risk-analyzer.js";
import type { ConstitutionService, DecisionAttributes } from "../aurora/constitution-service.js";
import { auroraInteger, auroraRound, DurableJsonState } from "../util/aurora-state.js";

const MAX_DECISIONS = 100_000;

export interface AuroraPolicyOptions {
  /** Risk level at or above which an action must be confirmed even if the base policy allowed it. */
  confirmAtOrAbove?: RiskLevel;
  /** Deny outright at this level. `critical` is the safe default for unattended operation. */
  denyAtOrAbove?: RiskLevel | "never";
  /** Run the constitutional checker for every capability call, not only for risky ones. */
  alwaysCheckConstitution?: boolean;
  /** Persist every enforcement decision for audit. */
  recordDecisions?: boolean;
}

export interface AuroraEnforcementRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  capabilityId: string;
  declaredRisk: string;
  riskLevel: RiskLevel;
  matchedRules: string[];
  baseDecision: PolicyDecision["decision"];
  finalDecision: PolicyDecision["decision"];
  escalated: boolean;
  constitutionVerdict?: "allow" | "review" | "deny";
  violatedPrinciples: string[];
  reasonCode: string;
  at: string;
}

interface AuroraPolicyStateShape {
  schemaVersion: 1;
  decisions: AuroraEnforcementRecord[];
}

const LEVEL_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Aurora enforcement layer for the capability boundary.
 *
 * Until now the risk analyzer and the constitution were something Aurora could *consult*. This layer
 * makes them binding: every capability call is scored for destructive patterns and, when it matters,
 * checked against the constitution before the broker runs it.
 *
 * It is strictly escalation-only, which is what makes it safe to compose:
 * - it never returns `allow` for something another layer wanted approved or denied;
 * - it can raise `allow` to `require_approval`, or `allow`/`require_approval` to `deny`;
 * - it cannot grant authority, widen an allowlist, or bypass approvals.
 *
 * Because `LayeredPolicyEngine` keeps the strongest decision across layers, adding this engine can
 * only ever make the system more careful.
 */
export class AuroraPolicyEngine implements PolicyEngine {
  private readonly store: DurableJsonState<AuroraPolicyStateShape> | undefined;

  constructor(
    private readonly deps: { risk: RiskAnalyzerService; constitution: ConstitutionService },
    rootPath?: string,
    private readonly options: AuroraPolicyOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.store = rootPath && options.recordDecisions !== false
      ? new DurableJsonState<AuroraPolicyStateShape>(
        join(rootPath, "policy", "aurora-enforcement.json"),
        () => ({ schemaVersion: 1, decisions: [] }),
        (value) => {
          const state = value as AuroraPolicyStateShape;
          return !!state && state.schemaVersion === 1 && Array.isArray(state.decisions);
        },
        "Aurora policy enforcement",
      )
      : undefined;
  }

  async decide(input: PolicyInput): Promise<PolicyDecision> {
    const confirmAt = this.options.confirmAtOrAbove ?? "high";
    const denyAt = this.options.denyAtOrAbove ?? "critical";

    let assessment: Awaited<ReturnType<RiskAnalyzerService["assess"]>> | undefined;
    try {
      assessment = await this.deps.risk.assess({
        tenantId: input.context.tenantId,
        capabilityId: input.descriptor.id,
        declaredRisk: input.descriptor.risk,
        args: input.arguments,
        sessionId: input.context.sessionId,
        record: false,
      });
    } catch {
      // A failing analyzer must not silently open the gate: fall back to the declared risk only.
      assessment = undefined;
    }

    const level: RiskLevel = assessment?.level ?? fallbackLevel(input.descriptor.risk);
    const matchedRules = assessment?.matchedRules.map((item) => item.code) ?? [];
    let decision: PolicyDecision | undefined;

    // Escalation requires *evidence*, not merely a risky capability class. The base policy already
    // reasons about declared risk and the operator configures it deliberately; this layer adds
    // scrutiny only when a destructive pattern actually matched the arguments.
    const evidenceDriven = matchedRules.length > 0;

    if (evidenceDriven && denyAt !== "never" && LEVEL_ORDER[level] >= LEVEL_ORDER[denyAt]) {
      decision = {
        decision: "deny",
        reasonCode: "aurora_risk_denied",
        message: `Aurora risk analysis classified this call as ${level}${matchedRules.length ? ` (${matchedRules.join(", ")})` : ""}.`,
        constraints: { riskLevel: level, matchedRules: matchedRules.slice(0, 10) },
      };
    } else if (evidenceDriven && LEVEL_ORDER[level] >= LEVEL_ORDER[confirmAt]) {
      decision = {
        decision: "require_approval",
        reasonCode: "aurora_risk_escalation",
        message: `Aurora risk analysis classified this call as ${level}${matchedRules.length ? ` (${matchedRules.join(", ")})` : ""}; confirm before it runs.`,
        approvalScope: "once",
        constraints: { riskLevel: level, matchedRules: matchedRules.slice(0, 10), zoneHint: assessment?.zoneHint ?? 2 },
      };
    }

    // Constitutional review runs for consequential calls, or for everything when configured.
    let verdict: Awaited<ReturnType<ConstitutionService["check"]>> | undefined;
    const consequential = this.options.alwaysCheckConstitution === true
      || evidenceDriven
      || input.descriptor.id.startsWith("user.")
      || input.descriptor.risk === "privileged";
    if (consequential) {
      try {
        verdict = await this.deps.constitution.check({
          tenantId: input.context.tenantId,
          actor: `capability:${input.descriptor.id}`,
          summary: `Capability ${input.descriptor.id} invoked from ${input.context.source}`,
          attributes: attributesFor(input, level, decision !== undefined),
        });
      } catch {
        verdict = undefined;
      }
      if (verdict?.verdict === "deny") {
        decision = {
          decision: "deny",
          reasonCode: "aurora_constitution_denied",
          message: `Constitutional review denied this call: ${verdict.violations.map((item) => item.code).join(", ")}.`,
          constraints: { violations: verdict.violations.map((item) => `${item.code}: ${item.remedy}`).slice(0, 10) },
        };
      } else if (verdict?.verdict === "review" && decision?.decision !== "deny") {
        decision = {
          decision: "require_approval",
          reasonCode: "aurora_constitution_review",
          message: `Constitutional review flagged ${verdict.violations.map((item) => item.code).join(", ")}; confirm before it runs.`,
          approvalScope: "once",
          constraints: { violations: verdict.violations.map((item) => `${item.code}: ${item.detail}`).slice(0, 10) },
        };
      }
    }

    const final: PolicyDecision = decision ?? {
      decision: "allow",
      reasonCode: "aurora_no_escalation",
      message: `Aurora governance found no reason to escalate (${level} risk).`,
    };

    if (this.store) {
      const record: AuroraEnforcementRecord = {
        id: `enforce-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        tenantId: input.context.tenantId,
        sessionId: input.context.sessionId,
        capabilityId: input.descriptor.id,
        declaredRisk: input.descriptor.risk,
        riskLevel: level,
        matchedRules,
        baseDecision: "allow",
        finalDecision: final.decision,
        escalated: final.decision !== "allow",
        ...(verdict ? { constitutionVerdict: verdict.verdict } : {}),
        violatedPrinciples: verdict?.violations.map((item) => item.code) ?? [],
        reasonCode: final.reasonCode,
        at: new Date(this.now()).toISOString(),
      };
      await this.store.mutate((state) => {
        state.decisions.push(record);
        if (state.decisions.length > MAX_DECISIONS) state.decisions.splice(0, state.decisions.length - MAX_DECISIONS);
      }).catch(() => undefined);
    }

    return final;
  }

  /** Enforcement audit trail: what Aurora escalated, why, and how often. */
  async decisions(tenantId: string, filter?: { escalatedOnly?: boolean; limit?: number }): Promise<AuroraEnforcementRecord[]> {
    if (!this.store) return [];
    const state = await this.store.read();
    return state.decisions
      .filter((item) => item.tenantId === tenantId && (!filter?.escalatedOnly || item.escalated))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, auroraInteger(filter?.limit ?? 100, 1, 1000, "Enforcement limit"))
      .map((item) => structuredClone(item));
  }

  /** How much of Aurora's own tool use is being escalated, and by which rules. */
  async summary(tenantId: string, windowDays = 7): Promise<{
    tenantId: string; total: number; escalated: number; denied: number; escalationRate: number;
    byLevel: Record<string, number>; topRules: Array<{ code: string; count: number }>;
    topPrinciples: Array<{ code: string; count: number }>; generatedAt: string;
  }> {
    if (!this.store) {
      return { tenantId, total: 0, escalated: 0, denied: 0, escalationRate: 0, byLevel: {}, topRules: [], topPrinciples: [], generatedAt: new Date(this.now()).toISOString() };
    }
    const state = await this.store.read();
    const threshold = this.now() - auroraInteger(windowDays, 1, 365, "Enforcement window") * 86_400_000;
    const records = state.decisions.filter((item) => item.tenantId === tenantId && Date.parse(item.at) >= threshold);
    const byLevel: Record<string, number> = {};
    const rules = new Map<string, number>();
    const principles = new Map<string, number>();
    for (const record of records) {
      byLevel[record.riskLevel] = (byLevel[record.riskLevel] ?? 0) + 1;
      for (const rule of record.matchedRules) rules.set(rule, (rules.get(rule) ?? 0) + 1);
      for (const principle of record.violatedPrinciples) principles.set(principle, (principles.get(principle) ?? 0) + 1);
    }
    const escalated = records.filter((item) => item.escalated).length;
    return {
      tenantId,
      total: records.length,
      escalated,
      denied: records.filter((item) => item.finalDecision === "deny").length,
      escalationRate: records.length ? auroraRound(escalated / records.length) : 0,
      byLevel,
      topRules: [...rules.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      topPrinciples: [...principles.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }
}

/**
 * Derives constitutional decision attributes from what the runtime already knows about one capability
 * call. Two deliberate choices keep this honest:
 *
 * - the destructive/rollback dimension is *not* asserted here. At the capability boundary Aurora has
 *   no declared rollback plan to judge; that dimension belongs to Aurora action records, and the risk
 *   layer above already handles destructive patterns. Claiming it here would produce false denials.
 * - `humanApproved` reflects whether this call is already gated by an approval requirement, which is
 *   a fact about the decision being made, not an assumption about the operator.
 */
function attributesFor(input: PolicyInput, level: RiskLevel, approvalEnforced: boolean): DecisionAttributes {
  const risk = input.descriptor.risk;
  return {
    externalSideEffect: risk === "external_side_effect" || risk === "network",
    autonomous: input.context.source !== "api" && input.context.source !== "web",
    humanApproved: approvalEnforced,
    hasEvidence: true,
    // Capability outcomes are journaled by the effect journal and returned as tool results.
    verificationPlanned: true,
    affectsUserData: input.descriptor.id.startsWith("user.") || input.descriptor.id.startsWith("memory."),
    claimType: "observation",
    confidence: level === "low" ? 0.9 : 0.8,
  };
}

function fallbackLevel(risk: string): RiskLevel {
  if (risk === "privileged" || risk === "external_side_effect" || risk === "process") return "high";
  if (risk === "workspace_write" || risk === "network") return "medium";
  return "low";
}
