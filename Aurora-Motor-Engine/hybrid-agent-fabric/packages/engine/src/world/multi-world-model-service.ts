import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  auroraIds, auroraInteger, auroraRound, auroraTags, auroraText, auroraUnit, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_ANALYSES = 20_000;
const MAX_SCENARIOS_PER_ANALYSIS = 64;

export type PerspectiveStance = "support" | "oppose" | "neutral";
export type ProblemType = "technical" | "economic" | "security" | "strategic" | "creative" | "user" | "research" | "operational" | "general";

export interface WorldPerspective {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  focus: string;
  questions: string[];
  baseWeight: number;
  reputation: number;
  resolvedPredictions: number;
  brierMean: number;
  status: "active" | "retired";
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PerspectiveView {
  perspectiveId: string;
  stance: PerspectiveStance;
  confidence: number;
  rationale: string;
  keyRisks: string[];
  keyOpportunities: string[];
  evidenceRefs: string[];
  submittedAt: string;
}

export interface PerspectiveConflict {
  id: string;
  fromPerspectiveId: string;
  targetPerspectiveId: string;
  argument: string;
  status: "open" | "acknowledged" | "resolved";
  resolution?: string;
  createdAt: string;
}

export interface WorldScenario {
  id: string;
  name: string;
  description: string;
  probability: number;
  parentScenarioId?: string;
  endorsingPerspectiveIds: string[];
  indicators: string[];
  /**
   * P1.26 (cost/risk/benefit): this branch's relative cost, 0-1. Absent means
   * unmeasured -- a missing estimate is reported as missing, never as zero,
   * because a zero and an unknown imply opposite decisions.
   */
  cost?: number;
  /**
   * P1.26: this branch's relative benefit, 0-1. Absent means unmeasured; the
   * expected value is only computed when both halves exist.
   */
  benefit?: number;
  outcome?: "occurred" | "not-occurred";
  brierScore?: number;
  resolvedAt?: string;
  createdAt: string;
}

export interface MultiWorldAnalysis {
  id: string;
  tenantId: string;
  question: string;
  context: string;
  problemType: ProblemType;
  perspectiveIds: string[];
  weights: Record<string, number>;
  status: "open" | "resolved";
  views: PerspectiveView[];
  conflicts: PerspectiveConflict[];
  scenarios: WorldScenario[];
  consensus?: {
    score: number;
    decision: "proceed" | "hold" | "reject" | "uncertain";
    supportWeight: number;
    opposeWeight: number;
    neutralWeight: number;
    agreement: number;
    uncertainty: number;
    dissentPerspectiveIds: string[];
    missingPerspectiveIds: string[];
    unresolvedConflictIds: string[];
    rationale: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface MultiWorldStateShape {
  schemaVersion: 1;
  perspectives: WorldPerspective[];
  analyses: MultiWorldAnalysis[];
}

const BUILTIN_PERSPECTIVES: Array<{ code: string; name: string; focus: string; questions: string[]; weight: number }> = [
  { code: "WM-01", name: "Technical Model", focus: "Feasibility, scalability, performance and maintenance cost.", questions: ["Does it work?", "Does it scale?", "What is the maintenance cost?"], weight: 1 },
  { code: "WM-02", name: "Economic Model", focus: "Cost, benefit and resource consumption.", questions: ["What does it cost?", "What is the return?", "Which resources are consumed?"], weight: 0.9 },
  { code: "WM-03", name: "Risk Model", focus: "Failure modes and worst-case outcomes.", questions: ["What can go wrong?", "What is the worst case?"], weight: 1.1 },
  { code: "WM-04", name: "Opportunity Model", focus: "Hidden advantages and missed openings.", questions: ["Is there hidden upside?", "Are we missing an opportunity?"], weight: 0.9 },
  { code: "WM-05", name: "Human Model", focus: "Human behaviour, fatigue and motivation.", questions: ["How will people react?", "Will this exhaust them?"], weight: 0.9 },
  { code: "WM-06", name: "Strategic Model", focus: "Long-horizon consequences.", questions: ["What happens in six months?", "What happens in two years?"], weight: 1 },
  { code: "WM-07", name: "Security Model", focus: "Attack surface, data loss and authority.", questions: ["Does this open a hole?", "Is data at risk?"], weight: 1.2 },
  { code: "WM-08", name: "Scientific Model", focus: "Evidence quality and source reliability.", questions: ["Is there evidence?", "Is the source reliable?"], weight: 1 },
  { code: "WM-09", name: "Creativity Model", focus: "Untried and alternative approaches.", questions: ["Is there another solution?", "What has not been tried?"], weight: 0.8 },
  { code: "WM-10", name: "User-Centric Model", focus: "The user's own interest and priorities.", questions: ["Is this good for the user?", "Does it match their priorities?"], weight: 1.2 },
  { code: "WM-11", name: "Time Model", focus: "Timing and horizon relevance.", questions: ["Does it matter now?", "Will it matter in a year?"], weight: 0.8 },
  { code: "WM-12", name: "Complexity Model", focus: "Unnecessary complexity and simpler paths.", questions: ["Is this over-engineered?", "Is there a simpler route?"], weight: 0.9 },
];

/** Meta world model: which perspectives dominate for a given problem type. */
const PROBLEM_EMPHASIS: Record<ProblemType, Partial<Record<string, number>>> = {
  technical: { "WM-01": 1.6, "WM-12": 1.3, "WM-02": 1.1 },
  economic: { "WM-02": 1.7, "WM-06": 1.2, "WM-11": 1.1 },
  security: { "WM-07": 1.9, "WM-03": 1.5, "WM-01": 1.1 },
  strategic: { "WM-06": 1.7, "WM-04": 1.3, "WM-11": 1.2 },
  creative: { "WM-09": 1.7, "WM-04": 1.3, "WM-12": 1.1 },
  user: { "WM-10": 1.8, "WM-05": 1.4, "WM-11": 1.1 },
  research: { "WM-08": 1.7, "WM-09": 1.2, "WM-04": 1.2 },
  operational: { "WM-01": 1.3, "WM-03": 1.3, "WM-02": 1.2 },
  general: {},
};

/**
 * Aurora Phase D — Multi-World Model: perspective registry, debate/conflict engine, weighted consensus
 * that preserves dissent, scenario/future-tree probabilities and per-perspective prediction reputation.
 */
export class MultiWorldModelService {
  private readonly store: DurableJsonState<MultiWorldStateShape>;

  constructor(rootPath: string, private readonly now: () => number = Date.now) {
    this.store = new DurableJsonState<MultiWorldStateShape>(
      join(rootPath, "world-model", "multi-world.json"),
      () => ({ schemaVersion: 1, perspectives: [], analyses: [] }),
      (value) => {
        const state = value as MultiWorldStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.perspectives) && Array.isArray(state.analyses);
      },
      "Aurora multi-world model",
    );
  }

  async perspectives(tenantId: string): Promise<WorldPerspective[]> {
    return await this.store.mutate((state) => {
      this.seed(state, tenantId);
      return state.perspectives.filter((item) => item.tenantId === tenantId).sort((a, b) => a.code.localeCompare(b.code)).map((item) => structuredClone(item));
    });
  }

  async addPerspective(input: { tenantId: string; code: string; name: string; focus: string; questions?: string[]; baseWeight?: number }): Promise<WorldPerspective> {
    return await this.store.mutate((state) => {
      this.seed(state, input.tenantId);
      const code = auroraText(input.code, 40, "Perspective code").toUpperCase();
      if (state.perspectives.some((item) => item.tenantId === input.tenantId && item.code === code)) throw new Error("Perspective code already exists in tenant.");
      if (state.perspectives.filter((item) => item.tenantId === input.tenantId).length >= 100) throw new Error("Perspective limit reached.");
      const nowIso = new Date(this.now()).toISOString();
      const perspective: WorldPerspective = {
        id: `wm-${randomUUID()}`,
        tenantId: input.tenantId,
        code,
        name: auroraText(input.name, 200, "Perspective name"),
        focus: auroraText(input.focus, 2000, "Perspective focus"),
        questions: (input.questions ?? []).slice(0, 20).map((item) => auroraText(item, 300, "Perspective question")),
        baseWeight: input.baseWeight === undefined ? 1 : boundedWeight(input.baseWeight),
        reputation: 0.5,
        resolvedPredictions: 0,
        brierMean: 0.25,
        status: "active",
        builtin: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.perspectives.push(perspective);
      return structuredClone(perspective);
    });
  }

  async retirePerspective(tenantIdValue: string, perspectiveId: string): Promise<WorldPerspective> {
    return await this.store.mutate((state) => {
      const perspective = this.mutablePerspective(state, tenantIdValue, perspectiveId);
      perspective.status = "retired";
      perspective.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(perspective);
    });
  }

  /** Open a multi-perspective analysis. Weights combine base weight, meta emphasis and prediction reputation. */
  async createAnalysis(input: { tenantId: string; question: string; context?: string; problemType?: ProblemType; perspectiveIds?: string[] }): Promise<MultiWorldAnalysis> {
    return await this.store.mutate((state) => {
      this.seed(state, input.tenantId);
      if (state.analyses.length >= MAX_ANALYSES) throw new Error("Multi-world analysis limit reached.");
      const problemType = input.problemType ?? "general";
      const pool = state.perspectives.filter((item) => item.tenantId === input.tenantId && item.status === "active");
      const requested = auroraIds(input.perspectiveIds, 50, "Analysis perspective IDs");
      const selected = requested.length ? pool.filter((item) => requested.includes(item.id)) : pool;
      if (selected.length < 2) throw new Error("A multi-world analysis needs at least two active perspectives.");
      const emphasis = PROBLEM_EMPHASIS[problemType] ?? {};
      const weights: Record<string, number> = {};
      for (const perspective of selected) {
        weights[perspective.id] = auroraRound(perspective.baseWeight * (emphasis[perspective.code] ?? 1) * (0.5 + perspective.reputation));
      }
      const nowIso = new Date(this.now()).toISOString();
      const analysis: MultiWorldAnalysis = {
        id: `mwa-${randomUUID()}`,
        tenantId: input.tenantId,
        question: auroraText(input.question, 10_000, "Analysis question"),
        context: input.context ? auroraText(input.context, 50_000, "Analysis context") : "",
        problemType,
        perspectiveIds: selected.map((item) => item.id),
        weights,
        status: "open",
        views: [],
        conflicts: [],
        scenarios: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.analyses.push(analysis);
      return structuredClone(analysis);
    });
  }

  async submitView(input: {
    tenantId: string; analysisId: string; perspectiveId: string; stance: PerspectiveStance; confidence: number;
    rationale: string; keyRisks?: string[]; keyOpportunities?: string[]; evidenceRefs?: string[];
  }): Promise<MultiWorldAnalysis> {
    return await this.store.mutate((state) => {
      const analysis = this.mutableAnalysis(state, input.tenantId, input.analysisId);
      if (analysis.status !== "open") throw new Error("Multi-world analysis is already resolved.");
      if (!analysis.perspectiveIds.includes(input.perspectiveId)) throw new Error("Perspective is not part of this analysis.");
      if (analysis.views.some((item) => item.perspectiveId === input.perspectiveId)) throw new Error("Perspective already submitted a view.");
      analysis.views.push({
        perspectiveId: input.perspectiveId,
        stance: input.stance,
        confidence: auroraUnit(input.confidence, "View confidence"),
        rationale: auroraText(input.rationale, 20_000, "View rationale"),
        keyRisks: (input.keyRisks ?? []).slice(0, 20).map((item) => auroraText(item, 500, "View risk")),
        keyOpportunities: (input.keyOpportunities ?? []).slice(0, 20).map((item) => auroraText(item, 500, "View opportunity")),
        evidenceRefs: auroraIds(input.evidenceRefs, 200, "View evidence refs"),
        submittedAt: new Date(this.now()).toISOString(),
      });
      analysis.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(analysis);
    });
  }

  /** Debate engine: one perspective formally challenges another; unresolved conflicts block clean consensus. */
  async challenge(input: { tenantId: string; analysisId: string; fromPerspectiveId: string; targetPerspectiveId: string; argument: string }): Promise<PerspectiveConflict> {
    return await this.store.mutate((state) => {
      const analysis = this.mutableAnalysis(state, input.tenantId, input.analysisId);
      if (input.fromPerspectiveId === input.targetPerspectiveId) throw new Error("A perspective cannot challenge itself.");
      for (const id of [input.fromPerspectiveId, input.targetPerspectiveId]) {
        if (!analysis.perspectiveIds.includes(id)) throw new Error("Perspective is not part of this analysis.");
      }
      if (analysis.conflicts.length >= 200) throw new Error("Analysis conflict limit reached.");
      const conflict: PerspectiveConflict = {
        id: `conflict-${randomUUID()}`,
        fromPerspectiveId: input.fromPerspectiveId,
        targetPerspectiveId: input.targetPerspectiveId,
        argument: auroraText(input.argument, 10_000, "Conflict argument"),
        status: "open",
        createdAt: new Date(this.now()).toISOString(),
      };
      analysis.conflicts.push(conflict);
      analysis.updatedAt = conflict.createdAt;
      return structuredClone(conflict);
    });
  }

  async resolveConflict(tenantIdValue: string, analysisId: string, conflictId: string, resolution: string): Promise<PerspectiveConflict> {
    return await this.store.mutate((state) => {
      const analysis = this.mutableAnalysis(state, tenantIdValue, analysisId);
      const conflict = analysis.conflicts.find((item) => item.id === conflictId);
      if (!conflict) throw new Error("Analysis conflict not found.");
      conflict.status = "resolved";
      conflict.resolution = auroraText(resolution, 10_000, "Conflict resolution");
      analysis.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(conflict);
    });
  }

  /** Add a possible future. Branches form the future tree; sibling probabilities may not exceed 1. */
  async addScenario(input: { tenantId: string; analysisId: string; name: string; description: string; probability: number; parentScenarioId?: string; endorsingPerspectiveIds?: string[]; indicators?: string[]; cost?: number; benefit?: number }): Promise<WorldScenario> {
    return await this.store.mutate((state) => {
      const analysis = this.mutableAnalysis(state, input.tenantId, input.analysisId);
      if (analysis.scenarios.length >= MAX_SCENARIOS_PER_ANALYSIS) throw new Error("Analysis scenario limit reached.");
      if (input.parentScenarioId && !analysis.scenarios.some((item) => item.id === input.parentScenarioId)) throw new Error("Parent scenario not found.");
      const probability = auroraUnit(input.probability, "Scenario probability");
      const siblings = analysis.scenarios.filter((item) => item.parentScenarioId === input.parentScenarioId);
      const total = siblings.reduce((sum, item) => sum + item.probability, 0) + probability;
      if (total > 1.000001) throw new Error("Sibling scenario probabilities cannot exceed 1.");
      const endorsing = auroraIds(input.endorsingPerspectiveIds, 50, "Scenario endorsements");
      for (const id of endorsing) if (!analysis.perspectiveIds.includes(id)) throw new Error("Endorsing perspective is not part of this analysis.");
      const scenario: WorldScenario = {
        id: `scn-${randomUUID()}`,
        name: auroraText(input.name, 200, "Scenario name"),
        description: auroraText(input.description, 20_000, "Scenario description"),
        probability,
        ...(input.parentScenarioId ? { parentScenarioId: input.parentScenarioId } : {}),
        endorsingPerspectiveIds: endorsing,
        indicators: (input.indicators ?? []).slice(0, 20).map((item) => auroraText(item, 500, "Scenario indicator")),
        // P1.26: only a supplied estimate is stored. One-sided estimates are
        // kept (they are still evidence about cost or benefit) but they do not
        // add up to an expected value; see futureTree.
        ...(input.cost !== undefined ? { cost: auroraUnit(input.cost, "Scenario cost") } : {}),
        ...(input.benefit !== undefined ? { benefit: auroraUnit(input.benefit, "Scenario benefit") } : {}),
        createdAt: new Date(this.now()).toISOString(),
      };
      analysis.scenarios.push(scenario);
      analysis.updatedAt = scenario.createdAt;
      return structuredClone(scenario);
    });
  }

  /**
   * Nested future tree view with cumulative branch probabilities and, where the
   * branch is measured, its expected value (P1.26: cost/risk/benefit).
   *
   * `expectedValue` is `cumulativeProbability * (benefit - cost)` and appears
   * ONLY when both estimates exist. A missing estimate is not a zero: "we do
   * not know what this costs" and "this costs nothing" are different branches
   * of different decisions, and collapsing them would let the tree look
   * decided when it is merely counted.
   */
  async futureTree(tenantIdValue: string, analysisId: string): Promise<Array<{ scenario: WorldScenario; cumulativeProbability: number; expectedValue?: number; children: string[] }>> {
    const state = await this.store.read();
    const analysis = state.analyses.find((item) => item.tenantId === tenantIdValue && item.id === analysisId);
    if (!analysis) throw new Error("Multi-world analysis not found in tenant.");
    const byId = new Map(analysis.scenarios.map((item) => [item.id, item]));
    return analysis.scenarios.map((scenario) => {
      let cumulative = scenario.probability;
      let parent = scenario.parentScenarioId ? byId.get(scenario.parentScenarioId) : undefined;
      let guard = 0;
      while (parent && guard++ < 32) {
        cumulative *= parent.probability;
        parent = parent.parentScenarioId ? byId.get(parent.parentScenarioId) : undefined;
      }
      return {
        scenario: structuredClone(scenario),
        cumulativeProbability: auroraRound(cumulative),
        ...(scenario.cost !== undefined && scenario.benefit !== undefined
          ? { expectedValue: auroraRound(cumulative * (scenario.benefit - scenario.cost)) }
          : {}),
        children: analysis.scenarios.filter((item) => item.parentScenarioId === scenario.id).map((item) => item.id),
      };
    });
  }

  /**
   * P1.26 aggregate over the future tree: what the measured branches are worth,
   * how much probability mass sits on branches that are measured to be net
   * negative (risk), and how many branches carry no measurement at all. The
   * root expected value sums only root scenarios so parent and child are never
   * double-counted; unmeasured roots contribute nothing rather than zero.
   */
  async futureTreeOutlook(tenantIdValue: string, analysisId: string): Promise<{
    rootExpectedValue: number | undefined;
    riskMass: number;
    measuredBranches: number;
    unmeasuredBranches: number;
  }> {
    const branches = await this.futureTree(tenantIdValue, analysisId);
    const roots = branches.filter((branch) => branch.scenario.parentScenarioId === undefined);
    let ev: number | undefined;
    for (const root of roots) {
      if (root.expectedValue === undefined) continue;
      ev = auroraRound((ev ?? 0) + root.expectedValue);
    }
    const riskMass = roots
      .filter((root) => root.expectedValue !== undefined && root.expectedValue < 0)
      .reduce((sum, root) => sum + root.scenario.probability, 0);
    const measured = branches.filter((branch) => branch.expectedValue !== undefined).length;
    return {
      rootExpectedValue: ev,
      riskMass: auroraRound(riskMass),
      measuredBranches: measured,
      unmeasuredBranches: branches.length - measured,
    };
  }

  /**
   * Reality Alignment Engine: record whether a scenario happened, score the endorsing perspectives
   * with Brier loss and update their prediction reputation.
   */
  async recordScenarioOutcome(input: { tenantId: string; analysisId: string; scenarioId: string; occurred: boolean }): Promise<{ scenario: WorldScenario; updatedPerspectives: WorldPerspective[] }> {
    return await this.store.mutate((state) => {
      const analysis = this.mutableAnalysis(state, input.tenantId, input.analysisId);
      const scenario = analysis.scenarios.find((item) => item.id === input.scenarioId);
      if (!scenario) throw new Error("Analysis scenario not found.");
      if (scenario.outcome) throw new Error("Scenario outcome is already recorded.");
      const nowIso = new Date(this.now()).toISOString();
      scenario.outcome = input.occurred ? "occurred" : "not-occurred";
      scenario.brierScore = auroraRound((scenario.probability - (input.occurred ? 1 : 0)) ** 2);
      scenario.resolvedAt = nowIso;
      const updated: WorldPerspective[] = [];
      for (const perspectiveId of scenario.endorsingPerspectiveIds) {
        const perspective = state.perspectives.find((item) => item.tenantId === input.tenantId && item.id === perspectiveId);
        if (!perspective) continue;
        const previous = perspective.resolvedPredictions;
        perspective.resolvedPredictions = previous + 1;
        perspective.brierMean = auroraRound((perspective.brierMean * previous + (scenario.brierScore ?? 0)) / (previous + 1));
        perspective.reputation = auroraRound(Math.max(0, Math.min(1, 1 - perspective.brierMean * 2)));
        perspective.updatedAt = nowIso;
        updated.push(structuredClone(perspective));
      }
      analysis.updatedAt = nowIso;
      return { scenario: structuredClone(scenario), updatedPerspectives: updated };
    });
  }

  /**
   * Weighted consensus that never hides disagreement: dissent, missing perspectives, open conflicts
   * and the uncertainty spread are all part of the result.
   */
  async resolveAnalysis(tenantIdValue: string, analysisId: string, options?: { minimumViews?: number }): Promise<MultiWorldAnalysis> {
    return await this.store.mutate((state) => {
      const analysis = this.mutableAnalysis(state, tenantIdValue, analysisId);
      if (analysis.status === "resolved") throw new Error("Multi-world analysis is already resolved.");
      const minimum = auroraInteger(options?.minimumViews ?? Math.max(2, Math.ceil(analysis.perspectiveIds.length * 0.5)), 2, analysis.perspectiveIds.length, "Minimum analysis views");
      if (analysis.views.length < minimum) throw new Error("Multi-world analysis has not reached its minimum perspective count.");
      let support = 0;
      let oppose = 0;
      let neutral = 0;
      for (const view of analysis.views) {
        const weight = (analysis.weights[view.perspectiveId] ?? 1) * view.confidence;
        if (view.stance === "support") support += weight;
        else if (view.stance === "oppose") oppose += weight;
        else neutral += weight;
      }
      const total = support + oppose + neutral;
      const score = total ? auroraRound((support - oppose) / total) : 0;
      const agreement = total ? auroraRound(Math.max(support, oppose) / total) : 0;
      const unresolvedConflictIds = analysis.conflicts.filter((item) => item.status === "open").map((item) => item.id);
      const dominant: PerspectiveStance | undefined = support > oppose ? "support" : oppose > support ? "oppose" : undefined;
      const decision = !dominant || agreement < 0.55 || unresolvedConflictIds.length > 0
        ? (score > 0.15 ? "hold" : score < -0.15 ? "reject" : "uncertain")
        : dominant === "support" ? "proceed" : "reject";
      const dissent = dominant ? analysis.views.filter((item) => item.stance !== dominant && item.stance !== "neutral").map((item) => item.perspectiveId) : analysis.views.map((item) => item.perspectiveId);
      const missing = analysis.perspectiveIds.filter((id) => !analysis.views.some((view) => view.perspectiveId === id));
      analysis.consensus = {
        score,
        decision,
        supportWeight: auroraRound(support),
        opposeWeight: auroraRound(oppose),
        neutralWeight: auroraRound(neutral),
        agreement,
        uncertainty: auroraRound(1 - agreement),
        dissentPerspectiveIds: dissent,
        missingPerspectiveIds: missing,
        unresolvedConflictIds,
        rationale: `Weighted by perspective emphasis for ${analysis.problemType} problems and prediction reputation; ${dissent.length} dissenting, ${missing.length} missing, ${unresolvedConflictIds.length} unresolved conflict(s).`,
      };
      analysis.status = "resolved";
      analysis.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(analysis);
    });
  }

  async analyses(tenantIdValue: string, status?: MultiWorldAnalysis["status"]): Promise<MultiWorldAnalysis[]> {
    const state = await this.store.read();
    return state.analyses
      .filter((item) => item.tenantId === tenantIdValue && (!status || item.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => structuredClone(item));
  }

  async getAnalysis(tenantIdValue: string, analysisId: string): Promise<MultiWorldAnalysis> {
    const state = await this.store.read();
    const analysis = state.analyses.find((item) => item.tenantId === tenantIdValue && item.id === analysisId);
    if (!analysis) throw new Error("Multi-world analysis not found in tenant.");
    return structuredClone(analysis);
  }

  private seed(state: MultiWorldStateShape, tenantIdValue: string): void {
    if (state.perspectives.some((item) => item.tenantId === tenantIdValue && item.builtin)) return;
    const nowIso = new Date(this.now()).toISOString();
    for (const perspective of BUILTIN_PERSPECTIVES) {
      state.perspectives.push({
        id: `wm-${tenantIdValue}-${perspective.code.toLowerCase()}`,
        tenantId: tenantIdValue,
        code: perspective.code,
        name: perspective.name,
        focus: perspective.focus,
        questions: perspective.questions,
        baseWeight: perspective.weight,
        reputation: 0.5,
        resolvedPredictions: 0,
        brierMean: 0.25,
        status: "active",
        builtin: true,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }

  private mutableAnalysis(state: MultiWorldStateShape, tenantIdValue: string, id: string): MultiWorldAnalysis {
    const analysis = state.analyses.find((item) => item.tenantId === tenantIdValue && item.id === id);
    if (!analysis) throw new Error("Multi-world analysis not found in tenant.");
    return analysis;
  }

  private mutablePerspective(state: MultiWorldStateShape, tenantIdValue: string, id: string): WorldPerspective {
    this.seed(state, tenantIdValue);
    const perspective = state.perspectives.find((item) => item.tenantId === tenantIdValue && item.id === id);
    if (!perspective) throw new Error("World perspective not found in tenant.");
    return perspective;
  }
}

function boundedWeight(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 5) throw new Error("Perspective weight must be between 0 and 5.");
  return Number(value.toFixed(4));
}

export function perspectiveTagSummary(perspective: WorldPerspective): string[] {
  return auroraTags([perspective.code.toLowerCase(), ...perspective.name.toLowerCase().split(/\s+/).slice(0, 3)]);
}
