import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CognitiveWorkspaceService } from "../cognitive/cognitive-workspace-service.js";
import type { EnvironmentAwarenessService } from "../environment/environment-awareness-service.js";
import type { SkillEvolutionService } from "../evolution/skill-evolution-service.js";
import type { ProactiveInitiativeService } from "../initiative/proactive-initiative-service.js";
import type { MemoryGraphService } from "../memory/memory-graph-service.js";
import type { AgentSocietyService } from "../society/agent-society-service.js";
import type { UserModelService } from "../user/user-model-service.js";
import type { WorldModelService } from "../world/world-model-service.js";
import type { ConstitutionService } from "./constitution-service.js";
import type { DecisionService } from "./decision-service.js";
import type { PlanningService } from "./planning-service.js";
import type { ContinualHarnessService } from "../harness/continual-harness-service.js";
import { auroraDigest, auroraInteger, auroraRound, auroraText, DurableJsonState } from "../util/aurora-state.js";

const MAX_CYCLES = 20_000;
const MAX_JOURNAL = 50_000;

/** The ACOS control loop stages, in the order the PDF specifies. */
export type CyclePhase =
  | "observe" | "update-world" | "prioritize" | "allocate" | "execute"
  | "evaluate" | "learn" | "remember" | "reflect" | "evolve";

export type CycleMode = "full" | "maintenance" | "reflection" | "dream" | "emergency";

export interface CyclePhaseResult {
  phase: CyclePhase;
  status: "ok" | "skipped" | "degraded" | "failed";
  summary: string;
  detail: Record<string, number | string | boolean>;
  durationMs: number;
}

export interface CognitiveCycleReport {
  id: string;
  tenantId: string;
  mode: CycleMode;
  sequence: number;
  phases: CyclePhaseResult[];
  attention: { focused: number; deferred: number; preempted: number; budgetSaturation: number };
  health: { cognitive: number; memory: number; constitutionCompliance: number };
  signals: { intake: number; initiativesQueued: number; advisories: number; gaps: number; stuckSessions: number; decisionsDue: number; stalledPlans: number };
  recommendations: string[];
  constitutionVerdict: "allow" | "review" | "deny";
  degraded: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface CognitiveJournalEntry {
  id: string;
  tenantId: string;
  cycleId?: string;
  kind: "cycle" | "insight" | "decision" | "reflection" | "anomaly" | "note";
  title: string;
  body: string;
  refs: string[];
  at: string;
}

interface OrchestratorStateShape {
  schemaVersion: 1;
  cycles: CognitiveCycleReport[];
  journal: CognitiveJournalEntry[];
  sequences: Array<{ tenantId: string; sequence: number }>;
}

export interface CognitiveOrchestratorDependencies {
  cognitive: CognitiveWorkspaceService;
  memoryGraph: MemoryGraphService;
  worldModel: WorldModelService;
  initiative: ProactiveInitiativeService;
  userModel: UserModelService;
  evolution: SkillEvolutionService;
  environment: EnvironmentAwarenessService;
  society: AgentSocietyService;
  constitution: ConstitutionService;
  harness: ContinualHarnessService;
  decisions?: DecisionService;
  planning?: PlanningService;
}

export interface CycleOptions {
  mode?: CycleMode;
  userId?: string;
  /** Skip specific phases (for example on a maintenance tick). */
  skipPhases?: CyclePhase[];
  /** Allow attention preemption during the allocate phase. */
  preempt?: boolean;
  /** Upper bound on how many insight candidates the dream phase may propose. */
  maxInsights?: number;
}

const MODE_PHASES: Record<CycleMode, CyclePhase[]> = {
  full: ["observe", "update-world", "prioritize", "allocate", "execute", "evaluate", "learn", "remember", "reflect", "evolve"],
  maintenance: ["observe", "update-world", "remember", "evaluate"],
  reflection: ["observe", "prioritize", "evaluate", "reflect", "learn"],
  dream: ["remember", "reflect", "learn"],
  emergency: ["observe", "prioritize", "allocate", "execute"],
};

/**
 * ACOS — the Aurora Cognitive Operating System control loop.
 *
 * Every Aurora subsystem is durable and independently governed; this orchestrator is what makes them
 * one organism. A tick walks Observe -> Update World -> Prioritize -> Allocate -> Execute -> Evaluate
 * -> Learn -> Remember -> Reflect -> Evolve, bounded by the constitution and the attention budget,
 * and writes a durable cycle report plus thought-journal entries.
 *
 * It coordinates; it never executes side effects itself. Every phase calls an already-governed
 * service, and a failing phase degrades the cycle instead of aborting the organism.
 */
export class CognitiveOrchestrator {
  private readonly store: DurableJsonState<OrchestratorStateShape>;

  constructor(
    rootPath: string,
    private readonly deps: CognitiveOrchestratorDependencies,
    private readonly now: () => number = Date.now,
    private readonly hooks: {
      stuckSessions?: (tenantId: string) => Promise<Array<{ sessionId: string; signature?: string; detail: string }>>;
      integrity?: (tenantId: string) => Promise<{ findings: number; critical: number; score: number; details: string[] }>;
      /** Plan-to-society reconciliation, and — only if the tenant enabled it — new delegation. */
      delegation?: (tenantId: string) => Promise<{ synced: number; updatedSteps: number; delegated: number; skipped: number; autoDelegate: boolean; harvested?: number; review?: number }>;
      /** Record decision outcomes derived from finished plans, so calibration reflects reality. */
      planFeedback?: (tenantId: string) => Promise<{ recorded: number; executedMarked: number }>;
      /** Fold measured step durations into the estimation profile. */
      estimation?: (tenantId: string) => Promise<{ ingested: number; skipped: number; samples: number }>;
    } = {},
  ) {
    this.store = new DurableJsonState<OrchestratorStateShape>(
      join(rootPath, "acos", "state.json"),
      () => ({ schemaVersion: 1, cycles: [], journal: [], sequences: [] }),
      (value) => {
        const state = value as OrchestratorStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.cycles) && Array.isArray(state.journal) && Array.isArray(state.sequences);
      },
      "Aurora ACOS state",
    );
  }

  /** Run one bounded cognitive cycle. */
  async tick(tenantId: string, options: CycleOptions = {}): Promise<CognitiveCycleReport> {
    const mode = options.mode ?? "full";
    const skip = new Set(options.skipPhases ?? []);
    const startedAt = this.now();

    // ═══ PREFLIGHT: Should this cycle run? ═══
    const preflight = await this.preflight(tenantId, mode);
    if (!preflight.shouldRun) {
      return {
        id: `cycle-preflight-blocked-${randomUUID()}`,
        tenantId,
        mode,
        sequence: 0,
        phases: [],
        attention: { focused: 0, deferred: 0, preempted: 0, budgetSaturation: 0 },
        health: { cognitive: 1, memory: 1, constitutionCompliance: 1 },
        signals: { intake: 0, initiativesQueued: 0, advisories: 0, gaps: 0, stuckSessions: 0, decisionsDue: 0, stalledPlans: 0 },
        recommendations: [preflight.reason],
        constitutionVerdict: "deny",
        degraded: [],
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(this.now()).toISOString(),
        durationMs: 0,
      };
    }

    // Apply preflight constraints
    const phases = MODE_PHASES[mode]
      .filter((phase) => !skip.has(phase))
      .filter((phase) => !preflight.blockedPhases.has(phase));
    const results: CyclePhaseResult[] = [];
    const degraded: string[] = [];
    const recommendations: string[] = [];
    const signals = { intake: 0, initiativesQueued: 0, advisories: 0, gaps: 0, stuckSessions: 0, decisionsDue: 0, stalledPlans: 0 };
    const attention = { focused: 0, deferred: 0, preempted: 0, budgetSaturation: 0 };
    const health = { cognitive: 1, memory: 1, constitutionCompliance: 1 };

    for (const phase of phases) {
      const phaseStart = this.now();
      try {
        const result = await this.runPhase(phase, tenantId, options, { signals, attention, health, recommendations });
        results.push({ ...result, phase, durationMs: Math.max(0, this.now() - phaseStart) });
      } catch (error) {
        degraded.push(phase);
        results.push({
          phase,
          status: "failed",
          summary: `Phase failed: ${(error as Error).message}`.slice(0, 500),
          detail: {},
          durationMs: Math.max(0, this.now() - phaseStart),
        });
      }
    }

    // The cycle itself is a decision and is checked against the constitution like any other.
    const verdict = await this.deps.constitution.check({
      tenantId,
      actor: "acos-orchestrator",
      summary: `ACOS ${mode} cycle with ${results.length} phases`,
      attributes: {
        autonomous: true,
        hasEvidence: results.some((item) => item.status === "ok"),
        estimatedTokens: 0,
        budgetRemainingTokens: 0,
        claimType: "observation",
        confidence: 0.9,
        dissentPreserved: true,
      },
    });

    const finishedAt = this.now();
    const report: CognitiveCycleReport = {
      id: `cycle-${randomUUID()}`,
      tenantId,
      mode,
      sequence: 0,
      phases: results,
      attention,
      health,
      signals,
      recommendations: [...new Set(recommendations)].slice(0, 50),
      constitutionVerdict: verdict.verdict as "allow" | "review" | "deny",
      degraded,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: Math.max(0, finishedAt - startedAt),
    };

    return await this.store.mutate((state) => {
      let sequence = state.sequences.find((item) => item.tenantId === tenantId);
      if (!sequence) {
        sequence = { tenantId, sequence: 0 };
        state.sequences.push(sequence);
      }
      sequence.sequence++;
      report.sequence = sequence.sequence;
      state.cycles.push(report);
      if (state.cycles.length > MAX_CYCLES) state.cycles.splice(0, state.cycles.length - MAX_CYCLES);
      this.appendJournal(state, {
        tenantId,
        cycleId: report.id,
        kind: "cycle",
        title: `ACOS ${mode} cycle #${report.sequence}`,
        body: results.map((item) => `${item.phase}: ${item.status} — ${item.summary}`).join("\n").slice(0, 20_000),
        refs: [],
      });
      if (degraded.length) {
        this.appendJournal(state, {
          tenantId,
          cycleId: report.id,
          kind: "anomaly",
          title: `Degraded phases: ${degraded.join(", ")}`,
          body: results.filter((item) => item.status === "failed").map((item) => item.summary).join("\n").slice(0, 10_000),
          refs: [],
        });
      }
      return structuredClone(report);
    });
  }

  async cycles(tenantId: string, limit = 50): Promise<CognitiveCycleReport[]> {
    const state = await this.store.read();
    return state.cycles
      .filter((item) => item.tenantId === tenantId)
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, auroraInteger(limit, 1, 1000, "Cycle limit"))
      .map((item) => structuredClone(item));
  }

  /** Aurora's thought journal: what it worked on, what it noticed and what it decided. */
  async journal(tenantId: string, filter?: { kind?: CognitiveJournalEntry["kind"]; limit?: number }): Promise<CognitiveJournalEntry[]> {
    const state = await this.store.read();
    return state.journal
      .filter((item) => item.tenantId === tenantId && (!filter?.kind || item.kind === filter.kind))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, auroraInteger(filter?.limit ?? 100, 1, 2000, "Journal limit"))
      .map((item) => structuredClone(item));
  }

  async note(input: { tenantId: string; kind?: CognitiveJournalEntry["kind"]; title: string; body: string; refs?: string[] }): Promise<CognitiveJournalEntry> {
    return await this.store.mutate((state) => structuredClone(this.appendJournal(state, {
      tenantId: input.tenantId,
      kind: input.kind ?? "note",
      title: input.title,
      body: input.body,
      refs: input.refs ?? [],
    })));
  }

  /** One-screen status of the whole organism, assembled from every Aurora subsystem. */
  async status(tenantId: string, userId?: string): Promise<Record<string, unknown>> {
    const [cognitiveHealth, memoryHealth, mode, budget, initiativeBudget, evolutionIndex, inventory, compliance, identity, meta] = await Promise.all([
      this.deps.cognitive.health(tenantId),
      this.deps.memoryGraph.health(tenantId),
      this.deps.cognitive.mode(tenantId),
      this.deps.cognitive.budget(tenantId),
      this.deps.initiative.budget(tenantId),
      this.deps.evolution.evolutionIndex(tenantId),
      this.deps.environment.inventory(tenantId),
      this.deps.constitution.compliance(tenantId),
      this.deps.constitution.identity(tenantId),
      this.deps.society.metaMonitor(tenantId),
    ]);
    const lastCycle = (await this.cycles(tenantId, 1))[0];
    return {
      tenantId,
      identity: { mission: identity.mission, version: identity.version },
      mode: mode.mode,
      cognitive: { health: cognitiveHealth.healthScore, focused: cognitiveHealth.totals.focused, queued: cognitiveHealth.totals.queued, violations: cognitiveHealth.constitutionalViolations.length },
      attentionBudget: { used: budget.usedTokens, reserved: budget.reservedTokens, daily: budget.dailyTokenBudget },
      memory: { health: memoryHealth.healthScore, total: memoryHealth.total, contradicted: memoryHealth.contradicted.length },
      initiative: { trust: initiativeBudget.trustScore, immediateUsed: initiativeBudget.usedImmediate, messageUsed: initiativeBudget.usedMessage },
      evolution: { index: evolutionIndex.index, production: evolutionIndex.productionSkills, delta: evolutionIndex.delta },
      environment: { resources: inventory.totals.resources, degraded: inventory.totals.degraded, verificationDebt: inventory.unverifiedActions },
      society: { advisories: meta.advisories.length, running: meta.utilization.runningTasks, quality: meta.utilization.averageQuality },
      ...(this.deps.decisions ? { decisions: await this.deps.decisions.calibration(tenantId).then((item) => ({ reviewed: item.reviewed, successRate: item.successRate, overconfidence: item.overconfidence })) } : {}),
      ...(this.deps.planning ? { plans: await this.deps.planning.list(tenantId, { status: "active", limit: 100 }).then((items) => ({ active: items.length, averageProgress: items.length ? Number((items.reduce((sum, plan) => sum + plan.progress, 0) / items.length).toFixed(4)) : 0 })) } : {}),
      constitution: { complianceRate: compliance.complianceRate, denied: compliance.denied, review: compliance.review },
      ...(userId ? { user: await this.deps.userModel.estimateState(tenantId, userId) } : {}),
      lastCycle: lastCycle ? { sequence: lastCycle.sequence, mode: lastCycle.mode, degraded: lastCycle.degraded, finishedAt: lastCycle.finishedAt } : null,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  // ═══ PREFLIGHT: Check if cycle should run and what's allowed ═══
  private async preflight(
    tenantId: string,
    mode: CycleMode,
  ): Promise<{ shouldRun: boolean; reason: string; blockedPhases: Set<CyclePhase>; maxDurationMs: number }> {
    const blockedPhases = new Set<CyclePhase>();

    // 1. Constitutional preflight
    const verdict = await this.deps.constitution.check({
      tenantId,
      actor: "acos-preflight",
      summary: `ACOS ${mode} cycle preflight`,
      attributes: {
        autonomous: true,
        hasEvidence: false,
        estimatedTokens: 0,
        budgetRemainingTokens: 0,
        claimType: "observation",
        confidence: 0.9,
        dissentPreserved: true,
      },
    });

    if (verdict.verdict === "deny") {
      return { shouldRun: false, reason: `Constitutional denied: ${verdict.violations.map(v => v.detail).join(", ") || "blocked"}`, blockedPhases, maxDurationMs: 0 };
    }

    // 2. Resource budget
    const maxDurationMs = mode === "emergency" ? 30000 : mode === "dream" ? 60000 : 120000;

    // 3. Per-phase governance: high-risk phases need extra clearance
    if (mode === "dream") {
      blockedPhases.add("execute");
      blockedPhases.add("allocate");
      blockedPhases.add("evolve");
    }
    if (mode !== "full") {
      blockedPhases.add("evolve");
    }

    return { shouldRun: true, reason: "preflight passed", blockedPhases, maxDurationMs };
  }

  private async runPhase(
    phase: CyclePhase,
    tenantId: string,
    options: CycleOptions,
    accumulator: { signals: CognitiveCycleReport["signals"]; attention: CognitiveCycleReport["attention"]; health: CognitiveCycleReport["health"]; recommendations: string[] },
  ): Promise<Omit<CyclePhaseResult, "phase" | "durationMs">> {
    switch (phase) {
      case "observe": {
        // Environment and society observations enter the workspace as sourced cognitive objects.
        const stuck = this.hooks.stuckSessions ? await this.hooks.stuckSessions(tenantId) : [];
        accumulator.signals.stuckSessions = stuck.length;
        let intake = 0;
        for (const session of stuck.slice(0, 5)) {
          const result = await this.deps.cognitive.intake({
            tenantId,
            source: "system",
            title: `Stuck session ${session.sessionId.slice(0, 8)}`,
            content: session.detail,
            sourceId: session.sessionId,
            kind: "problem",
            confidence: 0.8,
            importance: 0.7,
            urgency: 0.7,
            impact: 0.6,
            userRelevance: 0.6,
            horizon: "reactive",
            tags: ["stuck", "anomaly"],
          });
          if (result.accepted) intake++;
        }
        const staleProjects = await this.deps.environment.staleProjects(tenantId, 7);
        for (const project of staleProjects.slice(0, 5)) {
          const result = await this.deps.cognitive.intake({
            tenantId,
            source: "environment",
            title: `Stalled project: ${project.project.name}`,
            content: `No recorded activity for ${project.idleDays} days. Open tasks: ${project.project.openTasks}. Risks: ${project.project.risks.join("; ") || "none recorded"}.`,
            sourceId: project.project.id,
            kind: "risk",
            confidence: 0.7,
            importance: 0.6,
            urgency: 0.5,
            impact: 0.6,
            userRelevance: 0.7,
            horizon: "tactical",
            tags: ["project", "stalled"],
          });
          if (result.accepted) intake++;
        }
        accumulator.signals.intake += intake;
        return { status: "ok", summary: `Observed ${stuck.length} stuck session(s) and ${staleProjects.length} stalled project(s); ${intake} new workspace object(s).`, detail: { stuck: stuck.length, staleProjects: staleProjects.length, intake } };
      }
      case "update-world": {
        const expired = await this.deps.worldModel.expirePredictions(tenantId);
        const inconsistencies = await this.deps.worldModel.inconsistencies(tenantId);
        const calibration = await this.deps.worldModel.calibration(tenantId);
        if (inconsistencies.length) accumulator.recommendations.push(`Resolve ${inconsistencies.length} world-model inconsistency(ies) before relying on affected predictions.`);
        if (calibration.resolved >= 5 && calibration.brierMean > 0.3) accumulator.recommendations.push(`Prediction calibration is weak (Brier ${calibration.brierMean}); lower stated probabilities or gather more evidence.`);
        return { status: "ok", summary: `${expired.length} prediction(s) expired, ${inconsistencies.length} inconsistency(ies), Brier ${calibration.brierMean}.`, detail: { expired: expired.length, inconsistencies: inconsistencies.length, brier: calibration.brierMean, accuracy: calibration.accuracy } };
      }
      case "prioritize": {
        const arbitration = await this.deps.cognitive.arbitrateGoals(tenantId);
        const meta = await this.deps.society.metaMonitor(tenantId);
        accumulator.signals.advisories = meta.advisories.length;
        for (const advisory of meta.advisories.filter((item) => item.severity === "critical").slice(0, 5)) accumulator.recommendations.push(advisory.recommendation);
        let stalledPlans = 0;
        if (this.deps.planning) {
          const stalled = await this.deps.planning.stalled(tenantId, 7);
          stalledPlans = stalled.length;
          accumulator.signals.stalledPlans = stalledPlans;
          for (const item of stalled.slice(0, 3)) {
            accumulator.recommendations.push(item.readySteps.length
              ? `Plan "${item.plan.title}" idle ${item.idleDays} day(s) with ready step(s): ${item.readySteps.slice(0, 3).join(", ")}.`
              : `Plan "${item.plan.title}" idle ${item.idleDays} day(s) with no ready step; replan or abandon it.`);
          }
        }
        return { status: "ok", summary: `Ranked ${arbitration.rankedGoalIds.length} goal(s); ${meta.advisories.length} society advisory(ies); ${stalledPlans} stalled plan(s).`, detail: { goals: arbitration.rankedGoalIds.length, conflicts: arbitration.conflictGoalIds.length, advisories: meta.advisories.length, stalledPlans } };
      }
      case "allocate": {
        const allocation = await this.deps.cognitive.allocateAttention(tenantId, { preempt: options.preempt ?? options.mode === "emergency" });
        accumulator.attention.focused = allocation.focused.length;
        accumulator.attention.deferred = allocation.deferred.length;
        accumulator.attention.preempted = allocation.preempted.length;
        accumulator.attention.budgetSaturation = allocation.budget.dailyTokenBudget
          ? auroraRound((allocation.budget.usedTokens + allocation.budget.reservedTokens) / allocation.budget.dailyTokenBudget)
          : 0;
        return { status: "ok", summary: `Focused ${allocation.focused.length}, deferred ${allocation.deferred.length}, preempted ${allocation.preempted.length}.`, detail: { focused: allocation.focused.length, deferred: allocation.deferred.length, preempted: allocation.preempted.length, saturation: accumulator.attention.budgetSaturation } };
      }
      case "execute": {
        // Execution stays with the governed capability path; the cycle only routes proactive output
        // and reconciles delegated plan work with what the society actually did.
        const evaluation = await this.deps.initiative.evaluate(tenantId);
        accumulator.signals.initiativesQueued = evaluation.queued.length;
        let delegation: { synced: number; updatedSteps: number; delegated: number; skipped: number; autoDelegate: boolean; harvested?: number; review?: number } | undefined;
        if (this.hooks.delegation) {
          delegation = await this.hooks.delegation(tenantId);
          if (delegation.updatedSteps > 0) accumulator.recommendations.push(`${delegation.updatedSteps} plan step(s) moved because delegated society work changed state.`);
          if (delegation.autoDelegate && delegation.delegated > 0) accumulator.recommendations.push(`Delegated ${delegation.delegated} ready plan step(s) to the society.`);
          if (delegation.review) accumulator.recommendations.push(`${delegation.review} delegated task(s) finished ambiguously and need a human verdict.`);
        }
        return {
          status: "ok",
          summary: `Evaluated ${evaluation.evaluated} initiative(s): ${evaluation.queued.length} queued, ${evaluation.digested.length} digested${delegation ? `; harvested ${delegation.harvested ?? 0} outcome(s), reconciled ${delegation.synced} delegation(s), delegated ${delegation.delegated}` : ""}.`,
          detail: {
            evaluated: evaluation.evaluated, queued: evaluation.queued.length, digested: evaluation.digested.length, trust: evaluation.budget.trustScore,
            delegationsSynced: delegation?.synced ?? 0, delegatedSteps: delegation?.delegated ?? 0, delegationStepUpdates: delegation?.updatedSteps ?? 0,
            outcomesHarvested: delegation?.harvested ?? 0, outcomesInReview: delegation?.review ?? 0,
          },
        };
      }
      case "evaluate": {
        // Reality is folded in before calibration is read: a decision whose plan finished should not
        // still be counted as an open bet on the next line.
        let feedbackRecorded = 0;
        if (this.hooks.planFeedback) {
          const feedback = await this.hooks.planFeedback(tenantId);
          feedbackRecorded = feedback.recorded;
          if (feedback.recorded > 0) accumulator.recommendations.push(`${feedback.recorded} decision outcome(s) recorded from finished plans.`);
        }
        const cognitiveHealth = await this.deps.cognitive.health(tenantId);
        const compliance = await this.deps.constitution.compliance(tenantId, 7);
        accumulator.health.cognitive = cognitiveHealth.healthScore;
        accumulator.health.constitutionCompliance = compliance.complianceRate;
        for (const violation of cognitiveHealth.constitutionalViolations.slice(0, 5)) accumulator.recommendations.push(`${violation.code}: ${violation.detail}`);
        let decisionsDue = 0;
        let overconfidence = 0;
        if (this.deps.decisions) {
          const due = await this.deps.decisions.dueForReview(tenantId);
          decisionsDue = due.length;
          accumulator.signals.decisionsDue = decisionsDue;
          for (const decision of due.slice(0, 3)) accumulator.recommendations.push(`Decision "${decision.title}" is past its review date; record the actual outcome.`);
          const calibration = await this.deps.decisions.calibration(tenantId);
          overconfidence = calibration.overconfidence;
          if (calibration.reviewed >= 5 && calibration.overconfidence > 0.2) {
            accumulator.recommendations.push(`Decision confidence runs ${calibration.overconfidence} above the observed success rate; state lower confidence or gather more evidence.`);
          }
        }
        let integrityScore = 1;
        let integrityCritical = 0;
        if (this.hooks.integrity) {
          const integrity = await this.hooks.integrity(tenantId);
          integrityScore = integrity.score;
          integrityCritical = integrity.critical;
          for (const detail of integrity.details.slice(0, 3)) accumulator.recommendations.push(`Integrity: ${detail}`);
        }
        const status = cognitiveHealth.healthScore < 0.5 || integrityCritical > 0 ? "degraded" : "ok";
        return { status, summary: `Cognitive health ${cognitiveHealth.healthScore}, compliance ${compliance.complianceRate}, ${decisionsDue} decision review(s) due, integrity ${integrityScore}.`, detail: { health: cognitiveHealth.healthScore, blocked: cognitiveHealth.totals.blocked, violations: cognitiveHealth.constitutionalViolations.length, compliance: compliance.complianceRate, decisionsDue, overconfidence, integrityScore, integrityCritical, feedbackRecorded } };
      }
      case "learn": {
        // Friction observed by the cognitive layer becomes an evidence-backed capability-gap signal.
        const blocked = (await this.deps.cognitive.objects(tenantId)).filter((item) => item.state === "blocked" && item.repeatedIterationCount >= 3);
        let gaps = 0;
        for (const object of blocked.slice(0, 5)) {
          const observation = await this.deps.evolution.observeGap({
            tenantId,
            kind: "friction",
            description: `Repeated failure while working on: ${object.title}`,
            context: object.content.slice(0, 5000),
            severity: Math.min(1, object.importance + 0.1),
            evidenceRefs: [object.id],
          });
          gaps++;
          if (observation.candidateRecommended) accumulator.recommendations.push(`Design a skill candidate for recurring friction: ${object.title}`);
        }
        accumulator.signals.gaps = gaps;
        const pruned = await this.deps.harness.prune(tenantId);
        // Estimating is a skill like any other: measured durations feed the profile every cycle.
        let estimationSamples = 0;
        let estimationIngested = 0;
        if (this.hooks.estimation) {
          const estimation = await this.hooks.estimation(tenantId);
          estimationSamples = estimation.samples;
          estimationIngested = estimation.ingested;
        }
        return { status: "ok", summary: `Recorded ${gaps} friction signal(s); pruned ${pruned.length} stale harness entry(ies); ingested ${estimationIngested} estimate sample(s).`, detail: { gaps, pruned: pruned.length, estimationIngested, estimationSamples } };
      }
      case "remember": {
        const sweep = await this.deps.memoryGraph.sweep(tenantId);
        const contradictions = await this.deps.memoryGraph.detectContradictions(tenantId);
        const memoryHealth = await this.deps.memoryGraph.health(tenantId);
        accumulator.health.memory = memoryHealth.healthScore;
        if (memoryHealth.duplicateClusters.length >= 3) accumulator.recommendations.push("Run memory consolidation: duplicate clusters are accumulating.");
        return { status: "ok", summary: `Archived ${sweep.archived.length}, expired ${sweep.expired.length}, found ${contradictions.length} contradiction(s); health ${memoryHealth.healthScore}.`, detail: { archived: sweep.archived.length, expired: sweep.expired.length, contradictions: contradictions.length, health: memoryHealth.healthScore } };
      }
      case "reflect": {
        const dueAnchors = await this.deps.memoryGraph.dueAnchors(tenantId);
        const curiosity = await this.deps.cognitive.curiosityQueue(tenantId, 5);
        for (const anchor of dueAnchors.slice(0, 3)) accumulator.recommendations.push(`Thought anchor due: ${anchor.title} — next step: ${anchor.nextStep}`);
        const insights = options.mode === "dream" || options.mode === "full"
          ? await this.deps.memoryGraph.proposeInsights(tenantId, { limit: auroraInteger(options.maxInsights ?? 3, 1, 20, "Insight limit") })
          : [];
        return { status: "ok", summary: `${dueAnchors.length} anchor(s) due, ${curiosity.length} curiosity item(s), ${insights.length} insight candidate(s).`, detail: { anchors: dueAnchors.length, curiosity: curiosity.length, insights: insights.length } };
      }
      case "evolve": {
        const index = await this.deps.evolution.evolutionIndex(tenantId);
        const bottlenecks = await this.deps.evolution.workflowBottlenecks(tenantId);
        for (const bottleneck of bottlenecks.filter((item) => item.bottleneckStep).slice(0, 3)) accumulator.recommendations.push(`${bottleneck.name}: ${bottleneck.recommendation}`);
        return { status: "ok", summary: `Evolution index ${index.index} (delta ${index.delta}); ${bottlenecks.length} workflow(s) reviewed.`, detail: { index: index.index, delta: index.delta, production: index.productionSkills, workflows: bottlenecks.length } };
      }
      default:
        return { status: "skipped", summary: "Unknown phase.", detail: {} };
    }
  }

  private appendJournal(state: OrchestratorStateShape, input: { tenantId: string; cycleId?: string; kind: CognitiveJournalEntry["kind"]; title: string; body: string; refs: string[] }): CognitiveJournalEntry {
    const entry: CognitiveJournalEntry = {
      id: `journal-${randomUUID()}`,
      tenantId: input.tenantId,
      ...(input.cycleId ? { cycleId: input.cycleId } : {}),
      kind: input.kind,
      title: auroraText(input.title, 300, "Journal title"),
      body: auroraText(input.body || "(empty)", 20_000, "Journal body"),
      refs: input.refs.slice(0, 100),
      at: new Date(this.now()).toISOString(),
    };
    state.journal.push(entry);
    if (state.journal.length > MAX_JOURNAL) state.journal.splice(0, state.journal.length - MAX_JOURNAL);
    return entry;
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const items = (s as any)[Object.keys(s).find(k => Array.isArray((s as any)[k])) ?? ""]?.filter((x: any) => x.tenantId === tenantId) ?? [];
    return { total: items.length };
  }

  // ═══ P3: Explainability ═══

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    const s = await this.store.read();
    const keys = Object.keys(s);
    const arrayKey = keys.find(k => Array.isArray((s as any)[k]));
    const items: any[] = arrayKey ? ((s as any)[arrayKey] as any[]).filter((x: any) => x.tenantId === tenantId) : [];
    const entity = items.find((x: any) => x.id === entityId);
    if (!entity) throw new Error("Entity not found");
    const rationale: string[] = [`Found entity: ${entity.name ?? entity.title ?? entity.id ?? entityId}`];
    return { entity: entity.name ?? entity.title ?? entityId, summary: entity.description ?? entity.statement ?? "", rationale, details: entity };
  }
}



export function cycleDigest(report: CognitiveCycleReport): string {
  return auroraDigest(report.phases.map((item) => `${item.phase}:${item.status}`).join("|"));
}
