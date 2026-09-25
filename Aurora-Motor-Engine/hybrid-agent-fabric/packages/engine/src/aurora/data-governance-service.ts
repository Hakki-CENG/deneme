import { join } from "node:path";
import type { CognitiveWorkspaceService } from "../cognitive/cognitive-workspace-service.js";
import type { EnvironmentAwarenessService } from "../environment/environment-awareness-service.js";
import type { SkillEvolutionService } from "../evolution/skill-evolution-service.js";
import type { ProactiveInitiativeService } from "../initiative/proactive-initiative-service.js";
import type { MemoryGraphService } from "../memory/memory-graph-service.js";
import type { UserModelService } from "../user/user-model-service.js";
import type { WorldModelService } from "../world/world-model-service.js";
import type { AgentSocietyService } from "../society/agent-society-service.js";
import type { ContinualHarnessService } from "../harness/continual-harness-service.js";
import type { MicroagentRegistry } from "../knowledge/microagent-registry.js";
import type { ConstitutionService } from "./constitution-service.js";
import type { DecisionService } from "./decision-service.js";
import type { PlanningService } from "./planning-service.js";
import type { CognitiveOrchestrator } from "./cognitive-orchestrator.js";
import { auroraDigest, auroraInteger, auroraRound, auroraText } from "../util/aurora-state.js";

export interface AuroraExportSection {
  section: string;
  records: number;
  digest: string;
}

export interface AuroraExport {
  tenantId: string;
  userId?: string;
  scope: "tenant" | "user";
  sections: AuroraExportSection[];
  data: Record<string, unknown>;
  totalRecords: number;
  digest: string;
  generatedAt: string;
}

export interface AuroraPurgeReport {
  tenantId: string;
  userId?: string;
  scope: "tenant" | "user";
  dryRun: boolean;
  removed: Record<string, number>;
  retained: string[];
  totalRemoved: number;
  performedAt: string;
}

export interface IntegrityFinding {
  code: string;
  severity: "info" | "warning" | "critical";
  section: string;
  detail: string;
  subjectIds: string[];
}

export interface IntegrityReport {
  tenantId: string;
  checks: number;
  findings: IntegrityFinding[];
  healthy: boolean;
  score: number;
  generatedAt: string;
}

/**
 * Aurora data governance: export, purge and integrity self-check across every Aurora store.
 *
 * Constitution rule C10 requires user inferences to be inspectable and deletable, and an operator
 * running a long-lived cognitive system needs the same guarantee at tenant scope. This service is the
 * one place that knows every Aurora store, so "show me everything you know" and "forget this user"
 * are single, auditable operations rather than a checklist someone has to remember.
 *
 * Purge is deliberately conservative: it refuses to delete audit-grade records (constitutional
 * verdicts, evolution journal, ACOS cycles) and reports them as retained instead of silently keeping
 * them, so the caller always knows what survives and why.
 */
export class AuroraDataGovernanceService {
  constructor(
    private readonly deps: {
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
      microagents: MicroagentRegistry;
      decisions: DecisionService;
      planning: PlanningService;
      acos: CognitiveOrchestrator;
    },
    private readonly now: () => number = Date.now,
  ) {}

  /** Everything Aurora holds for a tenant (or one user inside it), with per-section digests. */
  async export(input: { tenantId: string; userId?: string; includeContent?: boolean }): Promise<AuroraExport> {
    const includeContent = input.includeContent !== false;
    const data: Record<string, unknown> = {};
    const sections: AuroraExportSection[] = [];
    const add = (section: string, records: unknown[]): void => {
      sections.push({ section, records: records.length, digest: auroraDigest(records) });
      if (includeContent) data[section] = records;
    };

    if (input.userId) {
      const userId = auroraText(input.userId, 200, "User ID");
      add("user-claims", await this.deps.userModel.claims(input.tenantId, userId));
      add("user-goals", await this.deps.userModel.goals(input.tenantId, userId));
      add("user-timeline", await this.deps.userModel.timeline(input.tenantId, userId));
      add("user-summary", [await this.deps.userModel.summary(input.tenantId, userId)]);
      add("user-memories", (await this.deps.memoryGraph.list(input.tenantId, { limit: 1000 })).filter((item) => item.userId === userId));
    } else {
      add("cognitive-objects", await this.deps.cognitive.objects(input.tenantId));
      add("cognitive-goals", await this.deps.cognitive.goals(input.tenantId));
      add("cognitive-intake", await this.deps.cognitive.intakeLog(input.tenantId, 1000));
      add("memories", await this.deps.memoryGraph.list(input.tenantId, { limit: 1000 }));
      add("memory-relations", await this.deps.memoryGraph.relations(input.tenantId));
      add("thought-anchors", await this.deps.memoryGraph.anchors(input.tenantId));
      add("world-entities", await this.deps.worldModel.entities(input.tenantId));
      add("world-events", await this.deps.worldModel.events(input.tenantId, 1000));
      add("world-causality", await this.deps.worldModel.causalLinks(input.tenantId));
      add("world-predictions", await this.deps.worldModel.predictions(input.tenantId));
      add("initiatives", await this.deps.initiative.initiatives(input.tenantId, { limit: 1000 }));
      add("initiative-watchers", await this.deps.initiative.watchers(input.tenantId));
      add("initiative-digests", await this.deps.initiative.digests(input.tenantId));
      add("society-roles", await this.deps.society.roles(input.tenantId));
      add("society-tasks", await this.deps.society.tasks(input.tenantId));
      add("society-deliberations", await this.deps.society.deliberations(input.tenantId));
      add("evolution-gaps", await this.deps.evolution.gaps(input.tenantId));
      add("evolution-candidates", await this.deps.evolution.candidates(input.tenantId));
      add("evolution-journal", await this.deps.evolution.journalEntries(input.tenantId, 1000));
      add("environment-resources", await this.deps.environment.resources(input.tenantId));
      add("environment-actions", await this.deps.environment.actions(input.tenantId, { limit: 1000 }));
      add("environment-projects", await this.deps.environment.projects(input.tenantId));
      add("harness-entries", await this.deps.harness.entries(input.tenantId));
      add("harness-refinements", await this.deps.harness.refinements(input.tenantId, { limit: 1000 }));
      add("microagents", await this.deps.microagents.list(input.tenantId));
      add("decisions", await this.deps.decisions.list(input.tenantId, { limit: 1000 }));
      add("plans", await this.deps.planning.list(input.tenantId, { limit: 1000 }));
      add("constitution-principles", await this.deps.constitution.principles(input.tenantId));
      add("constitution-amendments", await this.deps.constitution.amendments(input.tenantId, 1000));
      add("constitution-decisions", await this.deps.constitution.decisions(input.tenantId, { limit: 1000 }));
      add("acos-cycles", await this.deps.acos.cycles(input.tenantId, 1000));
      add("acos-journal", await this.deps.acos.journal(input.tenantId, { limit: 1000 }));
    }

    return {
      tenantId: input.tenantId,
      ...(input.userId ? { userId: input.userId } : {}),
      scope: input.userId ? "user" : "tenant",
      sections,
      data,
      totalRecords: sections.reduce((sum, item) => sum + item.records, 0),
      digest: auroraDigest(sections.map((item) => `${item.section}:${item.digest}`).join("|")),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Purge user-scoped inferences. Tenant-wide purge is intentionally not offered here: destroying a
   * whole tenant's cognitive history is an operational action, not an agent capability.
   */
  async purgeUser(input: { tenantId: string; userId: string; dryRun?: boolean }): Promise<AuroraPurgeReport> {
    const userId = auroraText(input.userId, 200, "User ID");
    const dryRun = input.dryRun !== false;
    const removed: Record<string, number> = {};
    const userMemories = (await this.deps.memoryGraph.list(input.tenantId, { limit: 1000 })).filter((item) => item.userId === userId);
    const claims = await this.deps.userModel.claims(input.tenantId, userId);
    const goals = await this.deps.userModel.goals(input.tenantId, userId);
    const milestones = await this.deps.userModel.timeline(input.tenantId, userId);

    if (dryRun) {
      removed["user-claims"] = claims.length;
      removed["user-goals"] = goals.length;
      removed["user-milestones"] = milestones.length;
      removed["user-memories"] = userMemories.length;
    } else {
      const outcome = await this.deps.userModel.forgetUser(input.tenantId, userId);
      removed["user-claims"] = outcome.removedClaims;
      removed["user-goals"] = outcome.removedGoals;
      removed["user-milestones"] = outcome.removedMilestones;
      removed["user-signals"] = outcome.removedSignals;
      removed["user-advice"] = outcome.removedAdvice;
      let memories = 0;
      for (const memory of userMemories) {
        await this.deps.memoryGraph.forget(input.tenantId, memory.id);
        memories++;
      }
      removed["user-memories"] = memories;
    }

    return {
      tenantId: input.tenantId,
      userId,
      scope: "user",
      dryRun,
      removed,
      retained: [
        "constitution-decisions (audit record of what was decided and why)",
        "evolution-journal (capability change history)",
        "acos-cycles (unattended operation record)",
        "environment-actions (verification and rollback audit)",
      ],
      totalRemoved: Object.values(removed).reduce((sum, value) => sum + value, 0),
      performedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Cross-store integrity audit: dangling references, orphaned state, budget drift and lifecycle
   * inconsistencies that no single service can see on its own.
   */
  async selfCheck(tenantId: string): Promise<IntegrityReport> {
    const findings: IntegrityFinding[] = [];
    let checks = 0;
    const flag = (code: string, severity: IntegrityFinding["severity"], section: string, detail: string, subjectIds: string[]): void => {
      findings.push({ code, severity, section, detail, subjectIds: subjectIds.slice(0, 20) });
    };

    // 1. Memory relations must point at memories that still exist.
    checks++;
    const memories = await this.deps.memoryGraph.list(tenantId, { limit: 1000 });
    const memoryIds = new Set(memories.map((item) => item.id));
    const relations = await this.deps.memoryGraph.relations(tenantId);
    const danglingRelations = relations.filter((item) => !memoryIds.has(item.fromId) || !memoryIds.has(item.toId));
    if (danglingRelations.length) flag("dangling-memory-relation", "warning", "memory", "Relations reference memories that no longer exist.", danglingRelations.map((item) => item.id));

    // 2. Thought anchors must not reference deleted memories.
    checks++;
    const anchors = await this.deps.memoryGraph.anchors(tenantId);
    const brokenAnchors = anchors.filter((item) => item.memoryIds.some((id) => !memoryIds.has(id)));
    if (brokenAnchors.length) flag("anchor-missing-memory", "info", "memory", "Thought anchors reference memories that were removed.", brokenAnchors.map((item) => item.id));

    // 3. Focused cognitive objects must hold a reservation, and reservations must match the budget.
    checks++;
    const objects = await this.deps.cognitive.objects(tenantId);
    const budget = await this.deps.cognitive.budget(tenantId);
    const focused = objects.filter((item) => item.attentionState === "focused");
    const unreserved = focused.filter((item) => item.reservedTokens <= 0);
    if (unreserved.length) flag("focus-without-reservation", "warning", "cognitive", "Focused objects hold no token reservation.", unreserved.map((item) => item.id));
    checks++;
    const reservedSum = focused.reduce((sum, item) => sum + item.reservedTokens, 0);
    if (Math.abs(reservedSum - budget.reservedTokens) > 0) {
      flag("attention-reservation-drift", "warning", "cognitive", `Budget reserves ${budget.reservedTokens} tokens but focused objects hold ${reservedSum}.`, []);
    }

    // 4. Environment actions that completed must be verified or explicitly rolled back.
    checks++;
    const unverified = await this.deps.environment.unverifiedActions(tenantId);
    if (unverified.length) flag("verification-debt", "warning", "environment", "Completed actions have no verification record.", unverified.map((item) => item.id));

    // 5. Zone 3+ actions must never be executing without an approval record.
    checks++;
    const actions = await this.deps.environment.actions(tenantId, { limit: 1000 });
    const unapproved = actions.filter((item) => item.zone >= 3 && !item.approval && ["executing", "completed", "verified"].includes(item.status));
    if (unapproved.length) flag("high-zone-without-approval", "critical", "environment", "High-zone actions progressed without a recorded approval.", unapproved.map((item) => item.id));

    // 6. Decisions must reference options that exist and carry an expectation.
    checks++;
    const decisions = await this.deps.decisions.list(tenantId, { limit: 1000 });
    const brokenDecisions = decisions.filter((item) => item.chosenOptionId && !item.options.some((option) => option.id === item.chosenOptionId));
    if (brokenDecisions.length) flag("decision-missing-option", "critical", "decisions", "Decided decisions reference an option that no longer exists.", brokenDecisions.map((item) => item.id));
    checks++;
    const unexpected = decisions.filter((item) => ["decided", "executed"].includes(item.status) && !item.expectedOutcome);
    if (unexpected.length) flag("decision-without-expectation", "warning", "decisions", "Decided decisions carry no falsifiable expectation.", unexpected.map((item) => item.id));

    // 7. Plans must have an executable graph: no completed plan with unfinished steps.
    checks++;
    const plans = await this.deps.planning.list(tenantId, { limit: 1000 });
    const inconsistentPlans = plans.filter((item) => item.status === "completed" && item.steps.some((step) => !["done", "skipped"].includes(step.status)));
    if (inconsistentPlans.length) flag("plan-completed-with-open-steps", "warning", "plans", "Plans are marked completed while steps remain open.", inconsistentPlans.map((item) => item.id));

    // 8. Society tasks in flight must reference an existing role.
    checks++;
    const roles = new Set((await this.deps.society.roles(tenantId)).map((item) => item.id));
    const tasks = await this.deps.society.tasks(tenantId);
    const orphanTasks = tasks.filter((item) => item.assignedRoleId && !roles.has(item.assignedRoleId));
    if (orphanTasks.length) flag("task-missing-role", "warning", "society", "Tasks are assigned to roles that no longer exist.", orphanTasks.map((item) => item.id));

    // 9. Quarantined knowledge must never be enabled.
    checks++;
    const microagents = await this.deps.microagents.list(tenantId);
    const leaked = microagents.filter((item) => item.screeningFindings.length > 0 && item.enabled && !item.screened);
    if (leaked.length) flag("quarantine-bypass", "critical", "knowledge", "Quarantined knowledge documents are enabled without review.", leaked.map((item) => item.id));

    // 10. Production skills must have an approval and a regression baseline.
    checks++;
    const candidates = await this.deps.evolution.candidates(tenantId, "production");
    const ungated = candidates.filter((item) => !item.approvals.length || !item.regressionBaseline.length);
    if (ungated.length) flag("production-skill-ungated", "critical", "evolution", "Production skills are missing an approval or regression baseline.", ungated.map((item) => item.id));

    // 11. The constitutional hard floor must still be intact.
    checks++;
    const principles = await this.deps.constitution.principles(tenantId, "active");
    const requiredHard = ["C1", "C2", "C3", "C4", "C6", "C7", "C10", "C12", "P4"];
    const missing = requiredHard.filter((code) => !principles.some((item) => item.code === code && item.severity === "hard"));
    if (missing.length) flag("constitution-floor-missing", "critical", "constitution", `Hard principles are missing or softened: ${missing.join(", ")}.`, missing);

    const weights = { info: 0.05, warning: 0.15, critical: 0.4 } as const;
    const penalty = findings.reduce((sum, item) => sum + weights[item.severity], 0);
    return {
      tenantId,
      checks,
      findings,
      healthy: !findings.some((item) => item.severity === "critical"),
      score: auroraRound(Math.max(0, Math.min(1, 1 - penalty))),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Retention view: how much Aurora is holding, so an operator can plan pruning. */
  async footprint(tenantId: string): Promise<{ tenantId: string; sections: AuroraExportSection[]; totalRecords: number; largest: string[]; generatedAt: string }> {
    const exported = await this.export({ tenantId, includeContent: false });
    const largest = [...exported.sections].sort((a, b) => b.records - a.records).slice(0, 5).map((item) => `${item.section}: ${item.records}`);
    return {
      tenantId,
      sections: exported.sections,
      totalRecords: exported.totalRecords,
      largest,
      generatedAt: exported.generatedAt,
    };
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



export const AURORA_DATA_ROOT = (rootPath: string): string => join(rootPath);

export function exportRecordLimit(value: number): number {
  return auroraInteger(value, 1, 10_000, "Export record limit");
}
