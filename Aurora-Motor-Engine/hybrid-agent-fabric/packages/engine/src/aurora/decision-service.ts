import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  auroraDigest, auroraIds, auroraInteger, auroraRound, auroraText, auroraTimestamp, auroraUnit, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_DECISIONS = 50_000;
const MAX_OPTIONS = 20;
const MAX_CRITERIA = 20;

export type DecisionStatus = "draft" | "open" | "decided" | "executed" | "reviewed" | "abandoned";
export type DecisionReversibility = "reversible" | "costly" | "irreversible";

export interface DecisionCriterion {
  id: string;
  name: string;
  weight: number;
  direction: "maximize" | "minimize";
  description: string;
}

export interface DecisionOption {
  id: string;
  name: string;
  description: string;
  scores: Record<string, number>;
  risks: string[];
  cost: { tokens?: number; hours?: number; money?: number };
  evidenceRefs: string[];
  weightedScore: number;
  scoredCriteria: number;
  createdAt: string;
}

export interface DecisionOutcome {
  observedAt: string;
  succeeded: boolean;
  observedValue: number;
  note: string;
  evidenceRefs: string[];
  surprise: number;
  brierScore: number;
}

/**
 * A durable Aurora decision record: the options considered, the criteria and weights used, the
 * chosen option with its expected value and confidence, the dissent that was preserved, and — later —
 * what actually happened. Decisions Aurora cannot review are decisions Aurora cannot learn from.
 */
export interface DecisionRecord {
  id: string;
  tenantId: string;
  sessionId?: string;
  title: string;
  question: string;
  context: string;
  status: DecisionStatus;
  reversibility: DecisionReversibility;
  criteria: DecisionCriterion[];
  options: DecisionOption[];
  chosenOptionId?: string;
  runnerUpOptionId?: string;
  margin: number;
  confidence: number;
  expectedValue: number;
  expectedOutcome: string;
  rationale: string;
  dissent: Array<{ source: string; concern: string; recordedAt: string }>;
  analysisId?: string;
  constitutionVerdictId?: string;
  constitutionVerdict?: "allow" | "review" | "deny";
  reviewDueAt?: string;
  outcome?: DecisionOutcome;
  goalIds: string[];
  evidenceRefs: string[];
  inputDigest: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}

export interface DecisionCalibration {
  tenantId: string;
  reviewed: number;
  succeeded: number;
  successRate: number;
  meanSurprise: number;
  brierMean: number;
  overconfidence: number;
  byReversibility: Record<string, { reviewed: number; successRate: number }>;
  worstDecisions: Array<{ id: string; title: string; surprise: number }>;
  generatedAt: string;
}

interface DecisionStateShape {
  schemaVersion: 1;
  decisions: DecisionRecord[];
}

/**
 * Aurora reasoning layer (ACOS L6): structured decision making with explicit criteria, weighted
 * option scoring, preserved dissent, an expected outcome that is falsifiable, and post-hoc
 * calibration that measures how well Aurora's confidence predicted reality.
 *
 * Scoring is deterministic: the model may supply the numbers, but the ranking, margin, confidence and
 * surprise are computed here so a decision can always be recomputed and audited.
 */
export class DecisionService {
  private readonly store: DurableJsonState<DecisionStateShape>;

  constructor(rootPath: string, private readonly now: () => number = Date.now) {
    this.store = new DurableJsonState<DecisionStateShape>(
      join(rootPath, "decisions", "state.json"),
      () => ({ schemaVersion: 1, decisions: [] }),
      (value) => {
        const state = value as DecisionStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.decisions);
      },
      "Aurora decision ledger",
    );
  }

  /** Open a decision with its criteria. Weights are normalized so scores stay comparable. */
  async open(input: {
    tenantId: string; title: string; question: string; context?: string; sessionId?: string;
    reversibility?: DecisionReversibility; criteria: Array<{ name: string; weight: number; direction?: "maximize" | "minimize"; description?: string }>;
    goalIds?: string[]; analysisId?: string; evidenceRefs?: string[];
  }): Promise<DecisionRecord> {
    return await this.store.mutate((state) => {
      if (state.decisions.length >= MAX_DECISIONS) throw new Error("Aurora decision limit reached.");
      if (!input.criteria.length || input.criteria.length > MAX_CRITERIA) throw new Error(`A decision needs 1-${MAX_CRITERIA} criteria.`);
      const totalWeight = input.criteria.reduce((sum, item) => sum + auroraUnit(item.weight, "Criterion weight"), 0);
      if (totalWeight <= 0) throw new Error("Criterion weights must sum to more than zero.");
      const names = new Set<string>();
      const criteria: DecisionCriterion[] = input.criteria.map((item) => {
        const name = auroraText(item.name, 120, "Criterion name").toLowerCase();
        if (names.has(name)) throw new Error("Criterion names must be unique.");
        names.add(name);
        return {
          id: `criterion-${randomUUID()}`,
          name,
          weight: auroraRound(auroraUnit(item.weight, "Criterion weight") / totalWeight),
          direction: item.direction ?? "maximize",
          description: item.description ? auroraText(item.description, 1000, "Criterion description") : "",
        };
      });
      const nowIso = new Date(this.now()).toISOString();
      const record: DecisionRecord = {
        id: `decision-${randomUUID()}`,
        tenantId: input.tenantId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        title: auroraText(input.title, 300, "Decision title"),
        question: auroraText(input.question, 10_000, "Decision question"),
        context: input.context ? auroraText(input.context, 50_000, "Decision context") : "",
        status: "open",
        reversibility: input.reversibility ?? "reversible",
        criteria,
        options: [],
        margin: 0,
        confidence: 0,
        expectedValue: 0,
        expectedOutcome: "",
        rationale: "",
        dissent: [],
        ...(input.analysisId ? { analysisId: input.analysisId } : {}),
        goalIds: auroraIds(input.goalIds, 50, "Decision goal IDs"),
        evidenceRefs: auroraIds(input.evidenceRefs, 200, "Decision evidence refs"),
        inputDigest: auroraDigest({ question: input.question, criteria: criteria.map((item) => `${item.name}:${item.weight}:${item.direction}`) }),
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.decisions.push(record);
      return structuredClone(record);
    });
  }

  /** Add an option with a 0-1 score per criterion. Missing criteria are treated as unknown, not zero. */
  async addOption(input: {
    tenantId: string; decisionId: string; name: string; description?: string;
    scores: Record<string, number>; risks?: string[]; cost?: { tokens?: number | undefined; hours?: number | undefined; money?: number | undefined }; evidenceRefs?: string[];
  }): Promise<DecisionRecord> {
    return await this.store.mutate((state) => {
      const decision = this.mutable(state, input.tenantId, input.decisionId);
      if (decision.status !== "open" && decision.status !== "draft") throw new Error("Options can only be added while the decision is open.");
      if (decision.options.length >= MAX_OPTIONS) throw new Error("Decision option limit reached.");
      const name = auroraText(input.name, 200, "Option name");
      if (decision.options.some((item) => item.name.toLowerCase() === name.toLowerCase())) throw new Error("Option names must be unique inside a decision.");
      const scores: Record<string, number> = {};
      for (const [key, value] of Object.entries(input.scores)) {
        const criterion = decision.criteria.find((item) => item.name === key.trim().toLowerCase() || item.id === key);
        if (!criterion) throw new Error(`Unknown decision criterion "${key}".`);
        scores[criterion.name] = auroraUnit(value, `Score for ${criterion.name}`);
      }
      const nowIso = new Date(this.now()).toISOString();
      const option: DecisionOption = {
        id: `option-${randomUUID()}`,
        name,
        description: input.description ? auroraText(input.description, 20_000, "Option description") : "",
        scores,
        risks: (input.risks ?? []).slice(0, 20).map((item) => auroraText(item, 1000, "Option risk")),
        cost: {
          ...(input.cost?.tokens !== undefined ? { tokens: auroraInteger(input.cost.tokens, 0, 1_000_000_000, "Option token cost") } : {}),
          ...(input.cost?.hours !== undefined ? { hours: auroraRound(Math.max(0, input.cost.hours), 2) } : {}),
          ...(input.cost?.money !== undefined ? { money: auroraRound(Math.max(0, input.cost.money), 2) } : {}),
        },
        evidenceRefs: auroraIds(input.evidenceRefs, 200, "Option evidence refs"),
        weightedScore: 0,
        scoredCriteria: Object.keys(scores).length,
        createdAt: nowIso,
      };
      decision.options.push(option);
      this.rescore(decision);
      decision.updatedAt = nowIso;
      return structuredClone(decision);
    });
  }

  /** Record a dissenting concern. Dissent is preserved on the record forever (constitution C9). */
  async recordDissent(input: { tenantId: string; decisionId: string; source: string; concern: string }): Promise<DecisionRecord> {
    return await this.store.mutate((state) => {
      const decision = this.mutable(state, input.tenantId, input.decisionId);
      if (decision.dissent.length >= 50) throw new Error("Decision dissent limit reached.");
      decision.dissent.push({
        source: auroraText(input.source, 200, "Dissent source"),
        concern: auroraText(input.concern, 5000, "Dissent concern"),
        recordedAt: new Date(this.now()).toISOString(),
      });
      decision.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(decision);
    });
  }

  /**
   * Decide. The winner is computed from the weighted scores, never taken on trust; an explicit
   * override is allowed but must state why it beat the computed ranking.
   */
  async decide(input: {
    tenantId: string; decisionId: string; rationale: string; expectedOutcome: string;
    chosenOptionId?: string; overrideReason?: string; reviewInDays?: number;
    constitutionVerdictId?: string; constitutionVerdict?: "allow" | "review" | "deny";
  }): Promise<DecisionRecord> {
    return await this.store.mutate((state) => {
      const decision = this.mutable(state, input.tenantId, input.decisionId);
      if (decision.status !== "open") throw new Error("Only an open decision can be decided.");
      if (decision.options.length < 2) throw new Error("A decision needs at least two options; a single option is not a decision.");
      if (input.constitutionVerdict === "deny") throw new Error("A decision denied by the constitution cannot be recorded as decided.");
      this.rescore(decision);
      const ranked = [...decision.options].sort((a, b) => b.weightedScore - a.weightedScore || a.name.localeCompare(b.name));
      const computed = ranked[0]!;
      const chosen = input.chosenOptionId ? decision.options.find((item) => item.id === input.chosenOptionId) : computed;
      if (!chosen) throw new Error("Chosen option not found in this decision.");
      if (chosen.id !== computed.id && !input.overrideReason) throw new Error("Choosing a lower-ranked option requires an explicit override reason.");
      const runnerUp = ranked.find((item) => item.id !== chosen.id);
      const timestamp = this.now();
      const nowIso = new Date(timestamp).toISOString();
      const margin = runnerUp ? auroraRound(chosen.weightedScore - runnerUp.weightedScore) : chosen.weightedScore;
      const coverage = decision.criteria.length ? chosen.scoredCriteria / decision.criteria.length : 0;
      const dissentPenalty = Math.min(0.4, decision.dissent.length * 0.1);
      decision.chosenOptionId = chosen.id;
      if (runnerUp) decision.runnerUpOptionId = runnerUp.id;
      decision.margin = margin;
      decision.expectedValue = chosen.weightedScore;
      decision.confidence = auroraRound(Math.max(0.05, Math.min(0.95, (0.4 + margin) * coverage * (1 - dissentPenalty))));
      decision.expectedOutcome = auroraText(input.expectedOutcome, 5000, "Expected outcome");
      decision.rationale = [auroraText(input.rationale, 20_000, "Decision rationale"), input.overrideReason ? `Override: ${auroraText(input.overrideReason, 5000, "Override reason")}` : ""].filter(Boolean).join("\n");
      decision.status = "decided";
      decision.decidedAt = nowIso;
      decision.updatedAt = nowIso;
      if (input.constitutionVerdictId) decision.constitutionVerdictId = input.constitutionVerdictId;
      if (input.constitutionVerdict) decision.constitutionVerdict = input.constitutionVerdict;
      const reviewDays = auroraInteger(input.reviewInDays ?? (decision.reversibility === "irreversible" ? 7 : 30), 1, 3650, "Review window");
      decision.reviewDueAt = new Date(timestamp + reviewDays * 86_400_000).toISOString();
      return structuredClone(decision);
    });
  }

  async markExecuted(tenantId: string, decisionId: string, note: string): Promise<DecisionRecord> {
    return await this.store.mutate((state) => {
      const decision = this.mutable(state, tenantId, decisionId);
      if (decision.status !== "decided") throw new Error("Only a decided decision can be marked executed.");
      decision.status = "executed";
      decision.rationale = `${decision.rationale}\nExecution: ${auroraText(note, 5000, "Execution note")}`;
      decision.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(decision);
    });
  }

  /**
   * Reality feedback. Surprise is the gap between the expected value and what happened, and the
   * Brier score measures whether the stated confidence was honest.
   */
  async recordOutcome(input: { tenantId: string; decisionId: string; succeeded: boolean; observedValue?: number; note: string; evidenceRefs?: string[] }): Promise<DecisionRecord> {
    return await this.store.mutate((state) => {
      const decision = this.mutable(state, input.tenantId, input.decisionId);
      if (!["decided", "executed"].includes(decision.status)) throw new Error("Only a decided or executed decision can record an outcome.");
      if (decision.outcome) throw new Error("Decision outcome is already recorded.");
      const observed = input.observedValue === undefined ? (input.succeeded ? 1 : 0) : auroraUnit(input.observedValue, "Observed value");
      const nowIso = new Date(this.now()).toISOString();
      decision.outcome = {
        observedAt: nowIso,
        succeeded: input.succeeded,
        observedValue: observed,
        note: auroraText(input.note, 10_000, "Outcome note"),
        evidenceRefs: auroraIds(input.evidenceRefs, 200, "Outcome evidence refs"),
        surprise: auroraRound(Math.abs(decision.expectedValue - observed)),
        brierScore: auroraRound((decision.confidence - (input.succeeded ? 1 : 0)) ** 2),
      };
      decision.status = "reviewed";
      decision.updatedAt = nowIso;
      return structuredClone(decision);
    });
  }

  async abandon(tenantId: string, decisionId: string, reason: string): Promise<DecisionRecord> {
    return await this.store.mutate((state) => {
      const decision = this.mutable(state, tenantId, decisionId);
      if (decision.status === "reviewed") throw new Error("A reviewed decision cannot be abandoned.");
      decision.status = "abandoned";
      decision.rationale = `${decision.rationale}\nAbandoned: ${auroraText(reason, 5000, "Abandon reason")}`;
      decision.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(decision);
    });
  }

  async list(tenantId: string, filter?: { status?: DecisionStatus; limit?: number }): Promise<DecisionRecord[]> {
    const state = await this.store.read();
    return state.decisions
      .filter((item) => item.tenantId === tenantId && (!filter?.status || item.status === filter.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, auroraInteger(filter?.limit ?? 100, 1, 1000, "Decision limit"))
      .map((item) => structuredClone(item));
  }

  async get(tenantId: string, decisionId: string): Promise<DecisionRecord> {
    const state = await this.store.read();
    const decision = state.decisions.find((item) => item.tenantId === tenantId && item.id === decisionId);
    if (!decision) throw new Error("Aurora decision not found in tenant.");
    return structuredClone(decision);
  }

  /** Decisions whose review window has elapsed without an outcome: the follow-through backlog. */
  async dueForReview(tenantId: string, at?: string): Promise<DecisionRecord[]> {
    const state = await this.store.read();
    const timestamp = at ? Date.parse(auroraTimestamp(at, this.now(), "Review time")) : this.now();
    return state.decisions
      .filter((item) => item.tenantId === tenantId && ["decided", "executed"].includes(item.status) && item.reviewDueAt && Date.parse(item.reviewDueAt) <= timestamp)
      .sort((a, b) => (a.reviewDueAt ?? "").localeCompare(b.reviewDueAt ?? ""))
      .map((item) => structuredClone(item));
  }

  /** How well did stated confidence predict reality? Overconfidence above zero means Aurora oversells. */
  async calibration(tenantId: string): Promise<DecisionCalibration> {
    const state = await this.store.read();
    const reviewed = state.decisions.filter((item) => item.tenantId === tenantId && item.outcome);
    const byReversibility: DecisionCalibration["byReversibility"] = {};
    for (const kind of ["reversible", "costly", "irreversible"] as DecisionReversibility[]) {
      const group = reviewed.filter((item) => item.reversibility === kind);
      byReversibility[kind] = {
        reviewed: group.length,
        successRate: group.length ? auroraRound(group.filter((item) => item.outcome?.succeeded).length / group.length) : 0,
      };
    }
    const succeeded = reviewed.filter((item) => item.outcome?.succeeded).length;
    const meanConfidence = reviewed.length ? reviewed.reduce((sum, item) => sum + item.confidence, 0) / reviewed.length : 0;
    const successRate = reviewed.length ? succeeded / reviewed.length : 0;
    return {
      tenantId,
      reviewed: reviewed.length,
      succeeded,
      successRate: auroraRound(successRate),
      meanSurprise: reviewed.length ? auroraRound(reviewed.reduce((sum, item) => sum + (item.outcome?.surprise ?? 0), 0) / reviewed.length) : 0,
      brierMean: reviewed.length ? auroraRound(reviewed.reduce((sum, item) => sum + (item.outcome?.brierScore ?? 0), 0) / reviewed.length) : 0,
      overconfidence: reviewed.length ? auroraRound(meanConfidence - successRate) : 0,
      byReversibility,
      worstDecisions: reviewed
        .filter((item) => item.outcome)
        .sort((a, b) => (b.outcome?.surprise ?? 0) - (a.outcome?.surprise ?? 0))
        .slice(0, 5)
        .map((item) => ({ id: item.id, title: item.title, surprise: item.outcome?.surprise ?? 0 })),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  private rescore(decision: DecisionRecord): void {
    for (const option of decision.options) {
      let total = 0;
      let weightUsed = 0;
      for (const criterion of decision.criteria) {
        const raw = option.scores[criterion.name];
        if (raw === undefined) continue;
        const value = criterion.direction === "minimize" ? 1 - raw : raw;
        total += value * criterion.weight;
        weightUsed += criterion.weight;
      }
      option.scoredCriteria = Object.keys(option.scores).length;
      // Unscored criteria are unknown, not zero: normalize by the weight actually used.
      option.weightedScore = weightUsed > 0 ? auroraRound(total / weightUsed) : 0;
    }
  }

  // ═══ P2: Explainability ═══


  // ═══ P3: Stats ═══

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const items = (s as any).decisions?.filter((x: any) => x.tenantId === tenantId) ?? [];
    return { total: items.length };
  }

async why(tenantId: string, decisionId: string): Promise<{
    decision: string; winner: string | null; confidence: number;
    rationale: string[]; criteriaBreakdown: Array<{ criterion: string; weight: number; winnerScore: number; bestAlternative: number }>;
    rejectedOptions: string[]; uncertainties: string[];
  }> {
    const s = await this.store.read();
    const d = s.decisions.find((x) => x.tenantId === tenantId && x.id === decisionId);
    if (!d) throw new Error("Aurora decision not found");
    this.rescore(d);
    const ranked = [...d.options].sort((a, b) => (b.weightedScore ?? 0) - (a.weightedScore ?? 0));
    const winner = ranked[0] ?? null;
    const second = ranked[1] ?? null;
    const gap = winner && second ? (winner.weightedScore ?? 0) - (second.weightedScore ?? 0) : 1;
    const confidence = Math.min(1, Math.max(0, 0.5 + gap));
    const rationale: string[] = [];
    if (winner) rationale.push(`Selected "${winner.name}" with score ${(winner.weightedScore ?? 0).toFixed(3)}`);
    if (gap < 0.05) rationale.push("WARNING: Near-tie between top options — decision may be fragile");
    if (d.evidenceRefs.length > 0) rationale.push(`${d.evidenceRefs.length} evidence reference(s) applied`);
    const criteriaBreakdown = d.criteria.map(c => {
      const wScore = winner ? (winner.scores[c.name] ?? 0) : 0;
      const bAlt = second ? (second.scores[c.name] ?? 0) : 0;
      return { criterion: c.name, weight: c.weight, winnerScore: wScore, bestAlternative: bAlt };
    });
    const rejectedOptions = ranked.slice(1).map(o => o.name);
    const uncertainties = d.criteria.filter(c => !winner?.scores[c.name]).map(c => c.name);
    return { decision: d.title, winner: winner?.name ?? null, confidence, rationale, criteriaBreakdown, rejectedOptions, uncertainties };
  }

  private mutable(state: DecisionStateShape, tenantId: string, id: string): DecisionRecord {
    const decision = state.decisions.find((item) => item.tenantId === tenantId && item.id === id);
    if (!decision) throw new Error("Aurora decision not found in tenant.");
    return decision;
  }
}
