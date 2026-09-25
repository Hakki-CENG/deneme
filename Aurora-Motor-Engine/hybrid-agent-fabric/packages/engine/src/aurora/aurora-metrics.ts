import type { CognitiveWorkspaceService } from "../cognitive/cognitive-workspace-service.js";
import type { EnvironmentAwarenessService } from "../environment/environment-awareness-service.js";
import type { SkillEvolutionService } from "../evolution/skill-evolution-service.js";
import type { ProactiveInitiativeService } from "../initiative/proactive-initiative-service.js";
import type { MemoryGraphService } from "../memory/memory-graph-service.js";
import type { AgentSocietyService } from "../society/agent-society-service.js";
import type { WorldModelService } from "../world/world-model-service.js";
import type { ConstitutionService } from "./constitution-service.js";
import type { DecisionService } from "./decision-service.js";
import type { PlanningService } from "./planning-service.js";
import type { AuroraAutopilot } from "./autopilot.js";
import type { AuroraFleetSupervisor } from "./fleet-supervisor.js";
import type { AuroraExecutionBridge } from "./execution-bridge.js";
import type { RoleAuthorityService } from "./role-authority-service.js";
import type { AuroraOutcomeHarvester } from "./outcome-harvester.js";
import type { AuroraPlanFeedback } from "./plan-feedback-service.js";
import type { AuroraEstimationCalibrator } from "./estimation-calibrator.js";
import type { CognitiveOrchestrator } from "./cognitive-orchestrator.js";
import { auroraRound } from "../util/aurora-state.js";

export interface AuroraMetricsSnapshot {
  tenantId: string;
  cognitive: { health: number; objects: number; focused: number; queued: number; deferred: number; blocked: number; violations: number; budgetSaturation: number };
  memory: { health: number; total: number; contradicted: number; stale: number; duplicates: number };
  world: { entities: number; openPredictions: number; accuracy: number; brierMean: number; inconsistencies: number };
  initiative: { trust: number; queued: number; delivered: number; suppressed: number; usedImmediate: number; usedMessage: number };
  society: { advisories: number; running: number; open: number; averageQuality: number; budgetSaturation: number };
  evolution: { index: number; production: number; beta: number; openGaps: number; successRate: number };
  environment: { resources: number; degraded: number; verificationDebt: number; unexpectedOutcomes: number };
  decisions: { reviewed: number; successRate: number; overconfidence: number; reviewBacklog: number };
  plans: { active: number; blocked: number; averageProgress: number; stalled: number };
  constitution: { complianceRate: number; denied: number; review: number; identityVersion: number };
  autopilot: { enabled: boolean; runsToday: number; failureRate: number };
  fleet: { enrolled: boolean; enabled: boolean; paused: boolean; priority: number; sweeps: number; runs: number; failures: number };
  delegation: { open: number; completed: number; failed: number; autoDelegate: boolean; failureRate: number };
  authority: { roles: number; boundRoles: number; leastAuthorityRatio: number; findings: number };
  harvest: { recorded: number; review: number; autoRecord: boolean };
  planFeedback: { recorded: number; successRate: number; meanSurprise: number; pending: number };
  estimation: { samples: number; factor: number; accuracy: number; confidence: number };
  acos: { cycles: number; lastDegradedPhases: number };
  generatedAt: string;
}

/**
 * Content-free Aurora telemetry.
 *
 * Every value here is a count, a rate or a bounded score. No titles, no content, no user text and no
 * identifiers leave this surface, so the Prometheus endpoint stays safe to scrape from an operations
 * network while still answering the questions that matter: is cognition healthy, is memory decaying,
 * is Aurora overconfident, is it accumulating verification debt, is unattended operation failing?
 */
export class AuroraMetricsCollector {
  constructor(
    private readonly deps: {
      cognitive: CognitiveWorkspaceService;
      memoryGraph: MemoryGraphService;
      worldModel: WorldModelService;
      initiative: ProactiveInitiativeService;
      society: AgentSocietyService;
      evolution: SkillEvolutionService;
      environment: EnvironmentAwarenessService;
      decisions: DecisionService;
      planning: PlanningService;
      constitution: ConstitutionService;
      autopilot: AuroraAutopilot;
      fleet?: AuroraFleetSupervisor;
      delegation?: AuroraExecutionBridge;
      roleAuthority?: RoleAuthorityService;
      harvester?: AuroraOutcomeHarvester;
      planFeedback?: AuroraPlanFeedback;
      estimation?: AuroraEstimationCalibrator;
      acos: CognitiveOrchestrator;
    },
    private readonly now: () => number = Date.now,
  ) {}

  async snapshot(tenantId: string): Promise<AuroraMetricsSnapshot> {
    const [
      cognitiveHealth, cognitiveBudget, memoryHealth, entities, predictions, calibration, inconsistencies,
      initiativeBudget, initiatives, meta, evolutionIndex, gaps, inventory, decisionCalibration, decisionBacklog,
      plans, stalledPlans, compliance, identity, autopilotHealth, cycles, fleetMember,
      delegationLinks, delegationPolicy, authorityAudit, harvestAssessments, harvestPolicy,
      feedbackSummary, feedbackCandidates, estimationProfile,
    ] = await Promise.all([
      this.deps.cognitive.health(tenantId),
      this.deps.cognitive.budget(tenantId),
      this.deps.memoryGraph.health(tenantId),
      this.deps.worldModel.entities(tenantId, { status: "active" }),
      this.deps.worldModel.predictions(tenantId, "open"),
      this.deps.worldModel.calibration(tenantId),
      this.deps.worldModel.inconsistencies(tenantId),
      this.deps.initiative.budget(tenantId),
      this.deps.initiative.initiatives(tenantId, { limit: 1000 }),
      this.deps.society.metaMonitor(tenantId),
      this.deps.evolution.evolutionIndex(tenantId),
      this.deps.evolution.gaps(tenantId, "open"),
      this.deps.environment.inventory(tenantId),
      this.deps.decisions.calibration(tenantId),
      this.deps.decisions.dueForReview(tenantId),
      this.deps.planning.list(tenantId, { limit: 1000 }),
      this.deps.planning.stalled(tenantId, 7),
      this.deps.constitution.compliance(tenantId, 30),
      this.deps.constitution.identity(tenantId),
      this.deps.autopilot.health(tenantId),
      this.deps.acos.cycles(tenantId, 1),
      this.deps.fleet ? this.deps.fleet.member(tenantId) : Promise.resolve(undefined),
      this.deps.delegation ? this.deps.delegation.links(tenantId, { limit: 1000 }) : Promise.resolve([]),
      this.deps.delegation ? this.deps.delegation.policy(tenantId) : Promise.resolve(undefined),
      this.deps.roleAuthority ? this.deps.roleAuthority.audit(tenantId) : Promise.resolve(undefined),
      this.deps.harvester ? this.deps.harvester.assessments(tenantId, { limit: 1000 }) : Promise.resolve([]),
      this.deps.harvester ? this.deps.harvester.policy(tenantId) : Promise.resolve(undefined),
      this.deps.planFeedback ? this.deps.planFeedback.summary(tenantId) : Promise.resolve(undefined),
      this.deps.planFeedback ? this.deps.planFeedback.candidates(tenantId, 200) : Promise.resolve([]),
      this.deps.estimation ? this.deps.estimation.profile(tenantId) : Promise.resolve(undefined),
    ]);
    const delegationCompleted = delegationLinks.filter((item) => item.status === "completed").length;
    const delegationFailed = delegationLinks.filter((item) => item.status === "failed").length;
    const delegationResolved = delegationCompleted + delegationFailed;
    const activePlans = plans.filter((item) => item.status === "active");
    return {
      tenantId,
      cognitive: {
        health: cognitiveHealth.healthScore,
        objects: cognitiveHealth.totals.objects,
        focused: cognitiveHealth.totals.focused,
        queued: cognitiveHealth.totals.queued,
        deferred: cognitiveHealth.totals.deferred,
        blocked: cognitiveHealth.totals.blocked,
        violations: cognitiveHealth.constitutionalViolations.length,
        budgetSaturation: cognitiveBudget.dailyTokenBudget
          ? auroraRound((cognitiveBudget.usedTokens + cognitiveBudget.reservedTokens) / cognitiveBudget.dailyTokenBudget)
          : 0,
      },
      memory: {
        health: memoryHealth.healthScore,
        total: memoryHealth.total,
        contradicted: memoryHealth.contradicted.length,
        stale: memoryHealth.stale.length,
        duplicates: memoryHealth.duplicateClusters.length,
      },
      world: {
        entities: entities.length,
        openPredictions: predictions.length,
        accuracy: calibration.accuracy,
        brierMean: calibration.brierMean,
        inconsistencies: inconsistencies.length,
      },
      initiative: {
        trust: initiativeBudget.trustScore,
        queued: initiatives.filter((item) => item.state === "queued").length,
        delivered: initiatives.filter((item) => item.state === "delivered").length,
        suppressed: initiatives.filter((item) => item.state === "suppressed" || item.state === "digested").length,
        usedImmediate: initiativeBudget.usedImmediate,
        usedMessage: initiativeBudget.usedMessage,
      },
      society: {
        advisories: meta.advisories.length,
        running: meta.utilization.runningTasks,
        open: meta.utilization.openTasks,
        averageQuality: meta.utilization.averageQuality,
        budgetSaturation: meta.budgetSaturation,
      },
      evolution: {
        index: evolutionIndex.index,
        production: evolutionIndex.productionSkills,
        beta: evolutionIndex.betaSkills,
        openGaps: gaps.length,
        successRate: evolutionIndex.successRate,
      },
      environment: {
        resources: inventory.totals.resources,
        degraded: inventory.totals.degraded,
        verificationDebt: inventory.unverifiedActions,
        unexpectedOutcomes: inventory.unexpectedOutcomes,
      },
      decisions: {
        reviewed: decisionCalibration.reviewed,
        successRate: decisionCalibration.successRate,
        overconfidence: decisionCalibration.overconfidence,
        reviewBacklog: decisionBacklog.length,
      },
      plans: {
        active: activePlans.length,
        blocked: plans.filter((item) => item.status === "blocked").length,
        averageProgress: activePlans.length ? auroraRound(activePlans.reduce((sum, item) => sum + item.progress, 0) / activePlans.length) : 0,
        stalled: stalledPlans.length,
      },
      constitution: {
        complianceRate: compliance.complianceRate,
        denied: compliance.denied,
        review: compliance.review,
        identityVersion: identity.version,
      },
      autopilot: {
        enabled: autopilotHealth.enabled,
        runsToday: autopilotHealth.runsToday,
        failureRate: autopilotHealth.failureRate,
      },
      fleet: {
        enrolled: fleetMember !== undefined,
        enabled: fleetMember?.enabled ?? false,
        paused: fleetMember?.pausedUntil !== undefined && Date.parse(fleetMember.pausedUntil) > this.now(),
        priority: fleetMember?.priority ?? 0,
        sweeps: fleetMember?.totalSweeps ?? 0,
        runs: fleetMember?.totalRuns ?? 0,
        failures: fleetMember?.totalFailures ?? 0,
      },
      delegation: {
        open: delegationLinks.filter((item) => !["completed", "failed", "cancelled", "detached"].includes(item.status)).length,
        completed: delegationCompleted,
        failed: delegationFailed,
        autoDelegate: delegationPolicy?.autoDelegate ?? false,
        failureRate: delegationResolved ? auroraRound(delegationFailed / delegationResolved) : 0,
      },
      authority: {
        roles: authorityAudit?.roles ?? 0,
        boundRoles: authorityAudit?.boundRoles ?? 0,
        leastAuthorityRatio: authorityAudit?.leastAuthorityRatio ?? 0,
        findings: authorityAudit?.findings.length ?? 0,
      },
      harvest: {
        recorded: harvestAssessments.filter((item) => item.disposition === "recorded").length,
        review: harvestAssessments.filter((item) => item.disposition === "review").length,
        autoRecord: harvestPolicy?.autoRecord ?? false,
      },
      planFeedback: {
        recorded: feedbackSummary?.recorded ?? 0,
        successRate: feedbackSummary?.successRate ?? 0,
        meanSurprise: feedbackSummary?.meanSurprise ?? 0,
        pending: feedbackCandidates.filter((item) => item.eligible).length,
      },
      estimation: {
        samples: estimationProfile?.overall.samples ?? 0,
        factor: estimationProfile?.overall.factor ?? 1,
        accuracy: estimationProfile?.overall.accuracy ?? 0,
        confidence: estimationProfile?.overall.confidence ?? 0,
      },
      acos: {
        cycles: cycles[0]?.sequence ?? 0,
        lastDegradedPhases: cycles[0]?.degraded.length ?? 0,
      },
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Prometheus exposition for one tenant, matching the existing content-free metric style. */
  async prometheus(tenantId: string): Promise<string> {
    const snapshot = await this.snapshot(tenantId);
    const label = safeLabel(tenantId);
    const lines: string[] = [
      "# HELP haf_aurora_health Aurora subsystem health scores (0-1).",
      "# TYPE haf_aurora_health gauge",
      `haf_aurora_health{tenant="${label}",subsystem="cognitive"} ${snapshot.cognitive.health}`,
      `haf_aurora_health{tenant="${label}",subsystem="memory"} ${snapshot.memory.health}`,
      `haf_aurora_health{tenant="${label}",subsystem="constitution"} ${snapshot.constitution.complianceRate}`,
      "# TYPE haf_aurora_cognitive_objects gauge",
      `haf_aurora_cognitive_objects{tenant="${label}",state="focused"} ${snapshot.cognitive.focused}`,
      `haf_aurora_cognitive_objects{tenant="${label}",state="queued"} ${snapshot.cognitive.queued}`,
      `haf_aurora_cognitive_objects{tenant="${label}",state="deferred"} ${snapshot.cognitive.deferred}`,
      `haf_aurora_cognitive_objects{tenant="${label}",state="blocked"} ${snapshot.cognitive.blocked}`,
      "# TYPE haf_aurora_budget_saturation gauge",
      `haf_aurora_budget_saturation{tenant="${label}",scope="cognitive"} ${snapshot.cognitive.budgetSaturation}`,
      `haf_aurora_budget_saturation{tenant="${label}",scope="society"} ${snapshot.society.budgetSaturation}`,
      "# TYPE haf_aurora_memory gauge",
      `haf_aurora_memory{tenant="${label}",kind="total"} ${snapshot.memory.total}`,
      `haf_aurora_memory{tenant="${label}",kind="contradicted"} ${snapshot.memory.contradicted}`,
      `haf_aurora_memory{tenant="${label}",kind="stale"} ${snapshot.memory.stale}`,
      "# TYPE haf_aurora_world gauge",
      `haf_aurora_world{tenant="${label}",kind="entities"} ${snapshot.world.entities}`,
      `haf_aurora_world{tenant="${label}",kind="open_predictions"} ${snapshot.world.openPredictions}`,
      `haf_aurora_world{tenant="${label}",kind="inconsistencies"} ${snapshot.world.inconsistencies}`,
      "# TYPE haf_aurora_prediction_brier gauge",
      `haf_aurora_prediction_brier{tenant="${label}"} ${snapshot.world.brierMean}`,
      "# TYPE haf_aurora_initiative gauge",
      `haf_aurora_initiative{tenant="${label}",kind="trust"} ${snapshot.initiative.trust}`,
      `haf_aurora_initiative{tenant="${label}",kind="queued"} ${snapshot.initiative.queued}`,
      `haf_aurora_initiative{tenant="${label}",kind="delivered"} ${snapshot.initiative.delivered}`,
      `haf_aurora_initiative{tenant="${label}",kind="suppressed"} ${snapshot.initiative.suppressed}`,
      "# TYPE haf_aurora_evolution_index gauge",
      `haf_aurora_evolution_index{tenant="${label}"} ${snapshot.evolution.index}`,
      "# TYPE haf_aurora_skills gauge",
      `haf_aurora_skills{tenant="${label}",stage="production"} ${snapshot.evolution.production}`,
      `haf_aurora_skills{tenant="${label}",stage="beta"} ${snapshot.evolution.beta}`,
      `haf_aurora_skills{tenant="${label}",stage="open_gaps"} ${snapshot.evolution.openGaps}`,
      "# TYPE haf_aurora_environment gauge",
      `haf_aurora_environment{tenant="${label}",kind="resources"} ${snapshot.environment.resources}`,
      `haf_aurora_environment{tenant="${label}",kind="degraded"} ${snapshot.environment.degraded}`,
      `haf_aurora_environment{tenant="${label}",kind="verification_debt"} ${snapshot.environment.verificationDebt}`,
      `haf_aurora_environment{tenant="${label}",kind="unexpected_outcomes"} ${snapshot.environment.unexpectedOutcomes}`,
      "# TYPE haf_aurora_decisions gauge",
      `haf_aurora_decisions{tenant="${label}",kind="reviewed"} ${snapshot.decisions.reviewed}`,
      `haf_aurora_decisions{tenant="${label}",kind="success_rate"} ${snapshot.decisions.successRate}`,
      `haf_aurora_decisions{tenant="${label}",kind="overconfidence"} ${snapshot.decisions.overconfidence}`,
      `haf_aurora_decisions{tenant="${label}",kind="review_backlog"} ${snapshot.decisions.reviewBacklog}`,
      "# TYPE haf_aurora_plans gauge",
      `haf_aurora_plans{tenant="${label}",kind="active"} ${snapshot.plans.active}`,
      `haf_aurora_plans{tenant="${label}",kind="blocked"} ${snapshot.plans.blocked}`,
      `haf_aurora_plans{tenant="${label}",kind="stalled"} ${snapshot.plans.stalled}`,
      `haf_aurora_plans{tenant="${label}",kind="average_progress"} ${snapshot.plans.averageProgress}`,
      "# TYPE haf_aurora_constitution gauge",
      `haf_aurora_constitution{tenant="${label}",kind="denied"} ${snapshot.constitution.denied}`,
      `haf_aurora_constitution{tenant="${label}",kind="review"} ${snapshot.constitution.review}`,
      `haf_aurora_constitution{tenant="${label}",kind="identity_version"} ${snapshot.constitution.identityVersion}`,
      "# TYPE haf_aurora_autopilot gauge",
      `haf_aurora_autopilot{tenant="${label}",kind="enabled"} ${snapshot.autopilot.enabled ? 1 : 0}`,
      `haf_aurora_autopilot{tenant="${label}",kind="runs_today"} ${snapshot.autopilot.runsToday}`,
      `haf_aurora_autopilot{tenant="${label}",kind="failure_rate"} ${snapshot.autopilot.failureRate}`,
      "# TYPE haf_aurora_fleet gauge",
      `haf_aurora_fleet{tenant="${label}",kind="enrolled"} ${snapshot.fleet.enrolled ? 1 : 0}`,
      `haf_aurora_fleet{tenant="${label}",kind="paused"} ${snapshot.fleet.paused ? 1 : 0}`,
      `haf_aurora_fleet{tenant="${label}",kind="sweeps"} ${snapshot.fleet.sweeps}`,
      `haf_aurora_fleet{tenant="${label}",kind="runs"} ${snapshot.fleet.runs}`,
      `haf_aurora_fleet{tenant="${label}",kind="failures"} ${snapshot.fleet.failures}`,
      "# TYPE haf_aurora_delegation gauge",
      `haf_aurora_delegation{tenant="${label}",kind="open"} ${snapshot.delegation.open}`,
      `haf_aurora_delegation{tenant="${label}",kind="completed"} ${snapshot.delegation.completed}`,
      `haf_aurora_delegation{tenant="${label}",kind="failed"} ${snapshot.delegation.failed}`,
      `haf_aurora_delegation{tenant="${label}",kind="failure_rate"} ${snapshot.delegation.failureRate}`,
      "# TYPE haf_aurora_authority gauge",
      `haf_aurora_authority{tenant="${label}",kind="roles"} ${snapshot.authority.roles}`,
      `haf_aurora_authority{tenant="${label}",kind="bound_roles"} ${snapshot.authority.boundRoles}`,
      `haf_aurora_authority{tenant="${label}",kind="least_authority_ratio"} ${snapshot.authority.leastAuthorityRatio}`,
      "# TYPE haf_aurora_harvest gauge",
      `haf_aurora_harvest{tenant="${label}",kind="recorded"} ${snapshot.harvest.recorded}`,
      `haf_aurora_harvest{tenant="${label}",kind="review"} ${snapshot.harvest.review}`,
      "# TYPE haf_aurora_plan_feedback gauge",
      `haf_aurora_plan_feedback{tenant="${label}",kind="recorded"} ${snapshot.planFeedback.recorded}`,
      `haf_aurora_plan_feedback{tenant="${label}",kind="pending"} ${snapshot.planFeedback.pending}`,
      `haf_aurora_plan_feedback{tenant="${label}",kind="mean_surprise"} ${snapshot.planFeedback.meanSurprise}`,
      "# TYPE haf_aurora_estimation gauge",
      `haf_aurora_estimation{tenant="${label}",kind="samples"} ${snapshot.estimation.samples}`,
      `haf_aurora_estimation{tenant="${label}",kind="factor"} ${snapshot.estimation.factor}`,
      `haf_aurora_estimation{tenant="${label}",kind="accuracy"} ${snapshot.estimation.accuracy}`,
      "# TYPE haf_aurora_acos gauge",
      `haf_aurora_acos{tenant="${label}",kind="cycles"} ${snapshot.acos.cycles}`,
      `haf_aurora_acos{tenant="${label}",kind="degraded_phases"} ${snapshot.acos.lastDegradedPhases}`,
    ];
    return `${lines.join("\n")}\n`;
  }

  /**
   * Operational alerts derived from the same snapshot. These are thresholds an operator would
   * otherwise have to invent, expressed once, in the system that knows what the numbers mean.
   */
  async alerts(tenantId: string): Promise<Array<{ code: string; severity: "info" | "warning" | "critical"; detail: string; value: number }>> {
    const snapshot = await this.snapshot(tenantId);
    const alerts: Array<{ code: string; severity: "info" | "warning" | "critical"; detail: string; value: number }> = [];
    const add = (code: string, severity: "info" | "warning" | "critical", detail: string, value: number): void => { alerts.push({ code, severity, detail, value }); };
    if (snapshot.cognitive.health < 0.5) add("cognitive-health-low", "critical", "Cognitive health is below 0.5; loops or focus overruns are accumulating.", snapshot.cognitive.health);
    if (snapshot.cognitive.budgetSaturation >= 0.95) add("attention-budget-exhausted", "warning", "The daily attention budget is effectively consumed.", snapshot.cognitive.budgetSaturation);
    if (snapshot.memory.health < 0.6) add("memory-health-low", "warning", "Memory health is degraded by contradictions, staleness or duplicates.", snapshot.memory.health);
    if (snapshot.world.inconsistencies > 0) add("world-inconsistent", "warning", "The world model holds conflicting current claims.", snapshot.world.inconsistencies);
    if (snapshot.world.brierMean > 0.3) add("prediction-miscalibrated", "warning", "Prediction Brier score is above 0.3.", snapshot.world.brierMean);
    if (snapshot.initiative.trust < 0.4) add("initiative-trust-low", "warning", "Proactive trust is low; notifications are being rated unhelpful.", snapshot.initiative.trust);
    if (snapshot.environment.verificationDebt > 0) add("verification-debt", "warning", "Completed actions are missing verification records.", snapshot.environment.verificationDebt);
    if (snapshot.environment.degraded > 0) add("environment-degraded", "info", "One or more environment resources are degraded.", snapshot.environment.degraded);
    if (snapshot.decisions.overconfidence > 0.2 && snapshot.decisions.reviewed >= 5) add("decision-overconfidence", "warning", "Stated decision confidence exceeds observed success by more than 0.2.", snapshot.decisions.overconfidence);
    if (snapshot.decisions.reviewBacklog > 0) add("decision-review-backlog", "info", "Decisions are past their review date without an outcome.", snapshot.decisions.reviewBacklog);
    if (snapshot.plans.stalled > 0) add("plans-stalled", "info", "Active plans have not moved in over a week.", snapshot.plans.stalled);
    if (snapshot.constitution.complianceRate < 0.8) add("constitution-compliance-low", "critical", "More than a fifth of reviewed decisions were denied or sent to review.", snapshot.constitution.complianceRate);
    if (snapshot.autopilot.enabled && snapshot.autopilot.failureRate > 0.25) add("autopilot-failing", "warning", "Unattended cadences are failing more than a quarter of the time.", snapshot.autopilot.failureRate);
    if (snapshot.delegation.failed >= 3 && snapshot.delegation.failureRate > 0.4) add("delegation-failing", "warning", "Delegated plan work is failing more often than it succeeds.", snapshot.delegation.failureRate);
    if (snapshot.authority.roles > 0 && snapshot.authority.leastAuthorityRatio < 0.5) add("roles-inherit-authority", "warning", "More than half of the active society roles run with full inherited capability authority.", snapshot.authority.leastAuthorityRatio);
    if (snapshot.estimation.samples >= 5 && (snapshot.estimation.factor >= 1.5 || snapshot.estimation.factor <= 0.66)) add("estimates-biased", "info", "Measured durations say this tenant's plan estimates are systematically off; apply the calibration.", snapshot.estimation.factor);
    if (snapshot.planFeedback.recorded >= 5 && snapshot.planFeedback.meanSurprise > 0.4) add("plan-expectations-off", "warning", "Finished plans keep landing far from what their decisions expected.", snapshot.planFeedback.meanSurprise);
    if (snapshot.harvest.review >= 5) add("harvest-review-backlog", "info", "Delegated tasks are waiting for a human verdict on their outcome.", snapshot.harvest.review);
    if (snapshot.fleet.paused) add("fleet-tenant-paused", "warning", "The fleet circuit breaker paused unattended operation for this tenant.", 1);
    if (snapshot.acos.lastDegradedPhases > 0) add("acos-degraded", "warning", "The last cognitive cycle had degraded phases.", snapshot.acos.lastDegradedPhases);
    return alerts;
  }

  // ═══ P3: Stats ═══

  getStats() {
    return { status: "active" };
  }

  // ═══ P3: Explainability ═══

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    return { entity: entityId, summary: "N/A", rationale: ["Service does not support entity lookup"], details: {} };
  }
}



function safeLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 100);
}
