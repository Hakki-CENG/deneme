import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  auroraDigest, auroraIds, auroraInteger, auroraRound, auroraText, auroraUnit, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_PRINCIPLES = 500;
const MAX_DECISIONS = 100_000;
const MAX_AMENDMENTS = 10_000;

export type PrincipleCategory = "safety" | "autonomy" | "privacy" | "evidence" | "resource" | "evolution" | "user" | "identity";
/** `hard` principles can never be waived by an agent; `soft` principles produce review, not denial. */
export type PrincipleSeverity = "hard" | "soft";

export interface ConstitutionPrinciple {
  id: string;
  tenantId: string;
  code: string;
  title: string;
  statement: string;
  category: PrincipleCategory;
  severity: PrincipleSeverity;
  builtin: boolean;
  status: "active" | "retired";
  version: number;
  rationale: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConstitutionAmendment {
  id: string;
  tenantId: string;
  principleId: string;
  kind: "created" | "amended" | "retired" | "restored";
  before?: { title: string; statement: string; severity: PrincipleSeverity; status: ConstitutionPrinciple["status"] };
  after: { title: string; statement: string; severity: PrincipleSeverity; status: ConstitutionPrinciple["status"] };
  approvedBy: string;
  reason: string;
  at: string;
}

/** Attributes an actor declares about a decision. Missing evidence is itself a constitutional signal. */
export interface DecisionAttributes {
  destructive?: boolean;
  irreversible?: boolean;
  externalSideEffect?: boolean;
  affectsUserData?: boolean;
  affectsProtectedTopic?: boolean;
  autonomous?: boolean;
  humanApproved?: boolean;
  hasEvidence?: boolean;
  hasRollbackPlan?: boolean;
  verificationPlanned?: boolean;
  claimType?: "observation" | "inference" | "hypothesis" | "prediction";
  confidence?: number;
  userRelevance?: number;
  notifiesUser?: boolean;
  selfModifying?: boolean;
  stagedEvolution?: boolean;
  dissentPreserved?: boolean;
  contradictsPrinciple?: string[];
  estimatedTokens?: number;
  budgetRemainingTokens?: number;
}

export interface ConstitutionVerdict {
  id: string;
  tenantId: string;
  summary: string;
  actor: string;
  verdict: "allow" | "review" | "deny";
  violations: Array<{ code: string; severity: PrincipleSeverity; detail: string; remedy: string }>;
  satisfied: string[];
  attributeDigest: string;
  identityVersion: number;
  decidedAt: string;
}

export interface IdentityCore {
  tenantId: string;
  mission: string;
  version: number;
  principleDigest: string;
  continuity: Array<{ version: number; change: string; approvedBy: string; at: string }>;
  createdAt: string;
  updatedAt: string;
}

interface ConstitutionStateShape {
  schemaVersion: 1;
  principles: ConstitutionPrinciple[];
  amendments: ConstitutionAmendment[];
  decisions: ConstitutionVerdict[];
  identities: IdentityCore[];
}

const DEFAULT_MISSION =
  "Be the user's durable cognitive companion: understand their goals, reduce their information load, surface opportunities and risks early, act only inside granted authority, and become more useful over time without ever becoming an unconstrained agent.";

/**
 * The twelve cross-cutting rules extracted from the Aurora PDF plus the ACOS operating principles.
 * Codes are stable so policies, tests and audits can reference them.
 */
const BUILTIN_PRINCIPLES: Array<Omit<ConstitutionPrinciple, "id" | "tenantId" | "builtin" | "status" | "version" | "createdAt" | "updatedAt">> = [
  { code: "C1", title: "No unconstrained super-agent", statement: "No single agent may hold unbounded authority; Prime synthesizes and coordinates but does not bypass policy.", category: "safety", severity: "hard", rationale: "Aurora is a society of bounded specialists, not one omnipotent agent." },
  { code: "C2", title: "Policy above agents", statement: "Policy, approvals and the capability broker remain authoritative over every agent decision.", category: "safety", severity: "hard", rationale: "Authority must be enforced by the runtime, not by prompt discipline." },
  { code: "C3", title: "Sourced claims", statement: "Every claim carries source, confidence, importance and time.", category: "evidence", severity: "hard", rationale: "Unsourced assertions cannot be audited, corrected or superseded." },
  { code: "C4", title: "Typed epistemics", statement: "Observation, inference, hypothesis and prediction are distinct and never silently promoted.", category: "evidence", severity: "hard", rationale: "Confusing a guess with an observation corrupts every downstream decision." },
  { code: "C5", title: "Bounded proactivity", statement: "Proactive contact is bounded by user relevance, attention budget and silence rules.", category: "user", severity: "soft", rationale: "Attention is the scarcest user resource; noise destroys trust." },
  { code: "C6", title: "Staged evolution", statement: "Capability change is candidate -> sandbox -> test -> review -> deploy; never direct self-modification.", category: "evolution", severity: "hard", rationale: "Self-promotion without evidence is the fastest route to an unsafe system." },
  { code: "C7", title: "Critical action discipline", statement: "Destructive or critical actions require approval, verification, audit and a recovery path.", category: "safety", severity: "hard", rationale: "Irreversible actions must never depend on a single model judgement." },
  { code: "C8", title: "Explicit budgets", statement: "Resource, token and API budgets are explicit and enforced across reactive, tactical and strategic horizons.", category: "resource", severity: "soft", rationale: "Unbounded background cognition becomes a cost and safety failure." },
  { code: "C9", title: "Preserved dissent", statement: "Disagreement is preserved; consensus is reported with confidence and dissent.", category: "evidence", severity: "soft", rationale: "Manufactured agreement hides the information that mattered." },
  { code: "C10", title: "Governed user model", statement: "User inferences are scoped, inspectable, correctable, consent-bound and deletable; protected topics are refused.", category: "privacy", severity: "hard", rationale: "Modelling behaviour is allowed; profiling a person is not." },
  { code: "C11", title: "Interruptible cognition", statement: "Background loops are durable but interruptible, budgeted and protected against repetition.", category: "autonomy", severity: "soft", rationale: "A thought loop that cannot be stopped is a failure mode, not autonomy." },
  { code: "C12", title: "No exactly-once claims", statement: "No component claims exactly-once external effects; uncertain outcomes stay uncertain.", category: "safety", severity: "hard", rationale: "Silent replay of external effects is worse than an explicit unknown." },
  { code: "P1", title: "Continuous presence", statement: "Aurora observes, thinks, learns and plans between conversations, within declared budgets.", category: "autonomy", severity: "soft", rationale: "A companion that only exists during a prompt cannot anticipate anything." },
  { code: "P2", title: "User advocacy", statement: "Every decision is evaluated against the user's own goals, habits and priorities.", category: "user", severity: "soft", rationale: "Aurora serves one user's interest, not a generic average." },
  { code: "P3", title: "Memory continuity", statement: "Knowledge is related, scored, compressed and retained rather than discarded at session end.", category: "identity", severity: "soft", rationale: "Continuity is the difference between a tool and a companion." },
  { code: "P4", title: "Identity continuity", statement: "Purpose survives version changes; amendments are approved, versioned and auditable.", category: "identity", severity: "hard", rationale: "A system that can silently rewrite its purpose has no purpose." },
];

/**
 * Aurora Internal Constitution Checker and Long-Term Identity Core.
 *
 * Principles are durable, versioned and amendable only with an explicit human approver and reason.
 * `check()` is a deterministic rule engine over declared decision attributes: it can escalate an
 * action to review or deny it, but it can never grant authority the policy engine has not granted.
 */
export class ConstitutionService {
  private readonly store: DurableJsonState<ConstitutionStateShape>;

  constructor(rootPath: string, private readonly now: () => number = Date.now) {
    this.store = new DurableJsonState<ConstitutionStateShape>(
      join(rootPath, "constitution", "state.json"),
      () => ({ schemaVersion: 1, principles: [], amendments: [], decisions: [], identities: [] }),
      (value) => {
        const state = value as ConstitutionStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.principles) && Array.isArray(state.amendments)
          && Array.isArray(state.decisions) && Array.isArray(state.identities);
      },
      "Aurora constitution",
    );
  }

  async principles(tenantId: string, status?: ConstitutionPrinciple["status"]): Promise<ConstitutionPrinciple[]> {
    return await this.store.mutate((state) => {
      this.seed(state, tenantId);
      return state.principles
        .filter((item) => item.tenantId === tenantId && (!status || item.status === status))
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((item) => structuredClone(item));
    });
  }

  async identity(tenantId: string): Promise<IdentityCore> {
    return await this.store.mutate((state) => {
      this.seed(state, tenantId);
      return structuredClone(this.mutableIdentity(state, tenantId));
    });
  }

  /** Restate the mission. This is an identity change: it needs an approver and is versioned forever. */
  async setMission(input: { tenantId: string; mission: string; approvedBy: string; reason: string }): Promise<IdentityCore> {
    return await this.store.mutate((state) => {
      this.seed(state, input.tenantId);
      const identity = this.mutableIdentity(state, input.tenantId);
      const mission = auroraText(input.mission, 5000, "Aurora mission");
      if (mission === identity.mission) return structuredClone(identity);
      identity.mission = mission;
      identity.version++;
      identity.continuity.push({
        version: identity.version,
        change: `Mission restated: ${mission.slice(0, 200)}`,
        approvedBy: auroraText(input.approvedBy, 200, "Approver"),
        at: new Date(this.now()).toISOString(),
      });
      identity.updatedAt = new Date(this.now()).toISOString();
      identity.principleDigest = this.principleDigest(state, input.tenantId);
      return structuredClone(identity);
    });
  }

  /** Add a tenant-specific principle. New principles start as `soft` unless an approver marks them hard. */
  async addPrinciple(input: { tenantId: string; code: string; title: string; statement: string; category: PrincipleCategory; severity?: PrincipleSeverity; rationale: string; approvedBy: string }): Promise<ConstitutionPrinciple> {
    return await this.store.mutate((state) => {
      this.seed(state, input.tenantId);
      if (state.principles.filter((item) => item.tenantId === input.tenantId).length >= MAX_PRINCIPLES) throw new Error("Constitution principle limit reached.");
      const code = auroraText(input.code, 20, "Principle code").toUpperCase();
      if (state.principles.some((item) => item.tenantId === input.tenantId && item.code === code)) throw new Error("Principle code already exists in tenant.");
      const nowIso = new Date(this.now()).toISOString();
      const principle: ConstitutionPrinciple = {
        id: `principle-${randomUUID()}`,
        tenantId: input.tenantId,
        code,
        title: auroraText(input.title, 200, "Principle title"),
        statement: auroraText(input.statement, 5000, "Principle statement"),
        category: input.category,
        severity: input.severity ?? "soft",
        builtin: false,
        status: "active",
        version: 1,
        rationale: auroraText(input.rationale, 5000, "Principle rationale"),
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.principles.push(principle);
      this.recordAmendment(state, principle, "created", undefined, input.approvedBy, input.rationale);
      return structuredClone(principle);
    });
  }

  /**
   * Amend a principle. Built-in hard principles may be clarified but never softened or retired,
   * so the safety floor cannot be edited away by the system that is bound by it.
   */
  async amendPrinciple(input: { tenantId: string; principleId: string; title?: string; statement?: string; severity?: PrincipleSeverity; approvedBy: string; reason: string }): Promise<ConstitutionPrinciple> {
    return await this.store.mutate((state) => {
      const principle = this.mutablePrinciple(state, input.tenantId, input.principleId);
      const before = { title: principle.title, statement: principle.statement, severity: principle.severity, status: principle.status };
      if (principle.builtin && principle.severity === "hard" && input.severity && input.severity !== "hard") {
        throw new Error("A built-in hard constitutional principle cannot be softened.");
      }
      if (input.title) principle.title = auroraText(input.title, 200, "Principle title");
      if (input.statement) principle.statement = auroraText(input.statement, 5000, "Principle statement");
      if (input.severity) principle.severity = input.severity;
      principle.version++;
      principle.updatedAt = new Date(this.now()).toISOString();
      this.recordAmendment(state, principle, "amended", before, input.approvedBy, input.reason);
      this.bumpIdentity(state, input.tenantId, `Principle ${principle.code} amended to v${principle.version}`, input.approvedBy);
      return structuredClone(principle);
    });
  }

  async retirePrinciple(input: { tenantId: string; principleId: string; approvedBy: string; reason: string }): Promise<ConstitutionPrinciple> {
    return await this.store.mutate((state) => {
      const principle = this.mutablePrinciple(state, input.tenantId, input.principleId);
      if (principle.builtin && principle.severity === "hard") throw new Error("A built-in hard constitutional principle cannot be retired.");
      const before = { title: principle.title, statement: principle.statement, severity: principle.severity, status: principle.status };
      principle.status = "retired";
      principle.version++;
      principle.updatedAt = new Date(this.now()).toISOString();
      this.recordAmendment(state, principle, "retired", before, input.approvedBy, input.reason);
      this.bumpIdentity(state, input.tenantId, `Principle ${principle.code} retired`, input.approvedBy);
      return structuredClone(principle);
    });
  }

  async amendments(tenantId: string, limit = 200): Promise<ConstitutionAmendment[]> {
    const state = await this.store.read();
    return state.amendments
      .filter((item) => item.tenantId === tenantId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, auroraInteger(limit, 1, 2000, "Amendment limit"))
      .map((item) => structuredClone(item));
  }

  /**
   * Deterministic constitutional review of a proposed decision.
   * Hard violations deny, soft violations require review, and everything is recorded for audit.
   */
  async check(input: { tenantId: string; actor: string; summary: string; attributes: DecisionAttributes }): Promise<ConstitutionVerdict> {
    return await this.store.mutate((state) => {
      this.seed(state, input.tenantId);
      const identity = this.mutableIdentity(state, input.tenantId);
      const active = new Map(state.principles.filter((item) => item.tenantId === input.tenantId && item.status === "active").map((item) => [item.code, item]));
      const attributes = input.attributes;
      const violations: ConstitutionVerdict["violations"] = [];
      const satisfied: string[] = [];
      const flag = (code: string, detail: string, remedy: string): void => {
        const principle = active.get(code);
        if (!principle) return;
        violations.push({ code, severity: principle.severity, detail, remedy });
      };
      const pass = (code: string): void => { if (active.has(code)) satisfied.push(code); };

      if ((attributes.destructive || attributes.irreversible) && !attributes.humanApproved) {
        flag("C7", "A destructive or irreversible action was proposed without human approval.", "Request approval before execution.");
      } else if (attributes.destructive || attributes.irreversible) pass("C7");

      if ((attributes.destructive || attributes.irreversible) && !attributes.hasRollbackPlan) {
        flag("C7", "No rollback plan was declared for a destructive or irreversible action.", "Declare a concrete recovery path first.");
      }
      if (attributes.externalSideEffect && !attributes.verificationPlanned) {
        flag("C7", "An external side effect was proposed without a verification step.", "Declare how the outcome will be verified.");
      }
      if (attributes.externalSideEffect) {
        pass("C12");
      }
      if (attributes.claimType && attributes.confidence === undefined) {
        flag("C3", "A typed claim was proposed without a confidence score.", "Attach confidence, source and timestamp to the claim.");
      } else if (attributes.claimType) pass("C3");
      if (attributes.claimType && attributes.claimType !== "observation" && attributes.hasEvidence === false) {
        flag("C4", `A ${attributes.claimType} was proposed without evidence and must not be presented as an observation.`, "Keep the claim typed and gather evidence before promoting it.");
      } else if (attributes.claimType) pass("C4");

      if (attributes.notifiesUser && (attributes.userRelevance ?? 0) < 0.3) {
        flag("C5", "A user notification was proposed with low user relevance.", "Digest it instead of interrupting, or raise the evidence for relevance.");
      } else if (attributes.notifiesUser) pass("C5");

      if (attributes.selfModifying && !attributes.stagedEvolution) {
        flag("C6", "A self-modifying change was proposed outside the staged evolution pipeline.", "Route the change through candidate -> sandbox -> test -> review -> deploy.");
      } else if (attributes.selfModifying) pass("C6");

      if (attributes.affectsProtectedTopic) {
        flag("C10", "The decision touches a protected user topic.", "Drop the protected inference; Aurora models behaviour, not identity.");
      }
      if (attributes.affectsUserData && !attributes.humanApproved && attributes.autonomous) {
        flag("C10", "Autonomous processing of user data was proposed without consent evidence.", "Obtain explicit consent or downgrade to a proposal.");
      } else if (attributes.affectsUserData) pass("C10");

      if (attributes.estimatedTokens !== undefined && attributes.budgetRemainingTokens !== undefined && attributes.estimatedTokens > attributes.budgetRemainingTokens) {
        flag("C8", "The declared cost exceeds the remaining budget.", "Defer the work or raise the budget deliberately.");
      } else if (attributes.estimatedTokens !== undefined) pass("C8");

      if (attributes.dissentPreserved === false) {
        flag("C9", "A consensus was reported without preserving dissent.", "Report dissenting perspectives and residual uncertainty.");
      } else if (attributes.dissentPreserved) pass("C9");

      if (attributes.autonomous && attributes.hasEvidence === false) {
        flag("C11", "Autonomous continuation was proposed without evidence of progress.", "Record progress evidence or stop the loop.");
      } else if (attributes.autonomous) pass("C11");

      for (const code of auroraIds(attributes.contradictsPrinciple, 20, "Contradicted principle codes")) {
        flag(code.toUpperCase(), "The actor declared that this decision contradicts the principle.", "Withdraw the decision or seek an approved amendment.");
      }

      const verdict: ConstitutionVerdict = {
        id: `verdict-${randomUUID()}`,
        tenantId: input.tenantId,
        summary: auroraText(input.summary, 5000, "Decision summary"),
        actor: auroraText(input.actor, 200, "Decision actor"),
        verdict: violations.some((item) => item.severity === "hard") ? "deny" : violations.length ? "review" : "allow",
        violations,
        satisfied: [...new Set(satisfied)].sort(),
        attributeDigest: auroraDigest(attributes),
        identityVersion: identity.version,
        decidedAt: new Date(this.now()).toISOString(),
      };
      state.decisions.push(verdict);
      if (state.decisions.length > MAX_DECISIONS) state.decisions.splice(0, state.decisions.length - MAX_DECISIONS);
      return structuredClone(verdict);
    });
  }

  async decisions(tenantId: string, filter?: { verdict?: ConstitutionVerdict["verdict"]; limit?: number }): Promise<ConstitutionVerdict[]> {
    const state = await this.store.read();
    return state.decisions
      .filter((item) => item.tenantId === tenantId && (!filter?.verdict || item.verdict === filter.verdict))
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
      .slice(0, auroraInteger(filter?.limit ?? 100, 1, 1000, "Decision limit"))
      .map((item) => structuredClone(item));
  }

  /** Compliance summary: how often Aurora is being denied or sent to review, and by which principle. */
  async compliance(tenantId: string, windowDays = 30): Promise<{ tenantId: string; total: number; allowed: number; review: number; denied: number; complianceRate: number; topViolations: Array<{ code: string; count: number; severity: PrincipleSeverity }>; identityVersion: number; generatedAt: string }> {
    const state = await this.store.read();
    const threshold = this.now() - auroraInteger(windowDays, 1, 3650, "Compliance window") * 86_400_000;
    const decisions = state.decisions.filter((item) => item.tenantId === tenantId && Date.parse(item.decidedAt) >= threshold);
    const counts = new Map<string, { count: number; severity: PrincipleSeverity }>();
    for (const decision of decisions) {
      for (const violation of decision.violations) {
        const current = counts.get(violation.code) ?? { count: 0, severity: violation.severity };
        current.count++;
        counts.set(violation.code, current);
      }
    }
    const allowed = decisions.filter((item) => item.verdict === "allow").length;
    return {
      tenantId,
      total: decisions.length,
      allowed,
      review: decisions.filter((item) => item.verdict === "review").length,
      denied: decisions.filter((item) => item.verdict === "deny").length,
      complianceRate: decisions.length ? auroraRound(allowed / decisions.length) : 1,
      topViolations: [...counts.entries()].map(([code, value]) => ({ code, count: value.count, severity: value.severity })).sort((a, b) => b.count - a.count).slice(0, 10),
      identityVersion: (await this.identity(tenantId)).version,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Bounded constitution projection for prompts: codes, titles and severities only. */
  async projection(tenantId: string, maxCharacters = 4000): Promise<{ mission: string; identityVersion: number; text: string; principleCount: number }> {
    const identity = await this.identity(tenantId);
    const principles = await this.principles(tenantId, "active");
    const limit = auroraInteger(maxCharacters, 200, 20_000, "Projection limit");
    const lines: string[] = [`MISSION (identity v${identity.version}): ${identity.mission}`];
    for (const principle of principles) {
      const line = `${principle.code} [${principle.severity}] ${principle.title}: ${principle.statement}`;
      if (lines.join("\n").length + line.length + 1 > limit) break;
      lines.push(line);
    }
    return { mission: identity.mission, identityVersion: identity.version, text: lines.join("\n"), principleCount: principles.length };
  }

  private seed(state: ConstitutionStateShape, tenantId: string): void {
    if (state.principles.some((item) => item.tenantId === tenantId && item.builtin)) return;
    const nowIso = new Date(this.now()).toISOString();
    for (const principle of BUILTIN_PRINCIPLES) {
      state.principles.push({
        id: `principle-${tenantId}-${principle.code.toLowerCase()}`,
        tenantId,
        ...principle,
        builtin: true,
        status: "active",
        version: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
    if (!state.identities.some((item) => item.tenantId === tenantId)) {
      state.identities.push({
        tenantId,
        mission: DEFAULT_MISSION,
        version: 1,
        principleDigest: this.principleDigest(state, tenantId),
        continuity: [{ version: 1, change: "Aurora identity core created with the built-in constitution.", approvedBy: "system", at: nowIso }],
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }

  private principleDigest(state: ConstitutionStateShape, tenantId: string): string {
    return auroraDigest(state.principles
      .filter((item) => item.tenantId === tenantId && item.status === "active")
      .map((item) => `${item.code}:${item.version}:${item.severity}`)
      .sort()
      .join("|"));
  }

  private bumpIdentity(state: ConstitutionStateShape, tenantId: string, change: string, approvedBy: string): void {
    const identity = this.mutableIdentity(state, tenantId);
    identity.version++;
    identity.principleDigest = this.principleDigest(state, tenantId);
    identity.continuity.push({ version: identity.version, change: change.slice(0, 500), approvedBy: auroraText(approvedBy, 200, "Approver"), at: new Date(this.now()).toISOString() });
    if (identity.continuity.length > 5000) identity.continuity.splice(0, identity.continuity.length - 5000);
    identity.updatedAt = new Date(this.now()).toISOString();
  }

  private recordAmendment(state: ConstitutionStateShape, principle: ConstitutionPrinciple, kind: ConstitutionAmendment["kind"], before: ConstitutionAmendment["before"], approvedBy: string, reason: string): void {
    state.amendments.push({
      id: `amendment-${randomUUID()}`,
      tenantId: principle.tenantId,
      principleId: principle.id,
      kind,
      ...(before ? { before } : {}),
      after: { title: principle.title, statement: principle.statement, severity: principle.severity, status: principle.status },
      approvedBy: auroraText(approvedBy, 200, "Approver"),
      reason: auroraText(reason, 5000, "Amendment reason"),
      at: new Date(this.now()).toISOString(),
    });
    if (state.amendments.length > MAX_AMENDMENTS) state.amendments.splice(0, state.amendments.length - MAX_AMENDMENTS);
  }

  private mutableIdentity(state: ConstitutionStateShape, tenantId: string): IdentityCore {
    const identity = state.identities.find((item) => item.tenantId === tenantId);
    if (!identity) throw new Error("Aurora identity core not found in tenant.");
    return identity;
  }

  private mutablePrinciple(state: ConstitutionStateShape, tenantId: string, id: string): ConstitutionPrinciple {
    this.seed(state, tenantId);
    const principle = state.principles.find((item) => item.tenantId === tenantId && (item.id === id || item.code === id.toUpperCase()));
    if (!principle) throw new Error("Constitutional principle not found in tenant.");
    return principle;
  }

  // ═══ P2: Explainability ═══


  // ═══ P3: Stats ═══

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const items = (s as any).decisions?.filter((x: any) => x.tenantId === tenantId) ?? [];
    return { total: items.length };
  }

async why(tenantId: string, violationId: string): Promise<{
    rule: string; violation: string; severity: string;
    rationale: string[]; remediation: string; precedent: string[];
  }> {
    const s = await this.store.read();
    const v = s.decisions.find((x: any) => x.tenantId === tenantId && x.id === violationId);
    if (!v) throw new Error("Aurora verdict not found");
    const maxSeverity = v.violations.reduce((m: string, vi: any) => vi.severity === "critical" ? "critical" : vi.severity === "high" && m !== "critical" ? "high" : m, "low");
    const rationale: string[] = [`Verdict: ${v.verdict}`, `Summary: ${v.summary}`, `Violations: ${v.violations.length}`];
    for (const vi of v.violations) rationale.push(`  ${vi.code}: ${vi.detail}`);
    const precedent: string[] = [];
    return { rule: v.verdict, violation: v.summary, severity: maxSeverity, rationale, remediation: v.violations.map((vi: any) => vi.remedy).join("; ") || "Review action", precedent };
  }
}

/** Convenience helper so callers can express a unit-scored attribute without importing the validator. */
export function constitutionalConfidence(value: number): number {
  return auroraUnit(value, "Decision confidence");
}
