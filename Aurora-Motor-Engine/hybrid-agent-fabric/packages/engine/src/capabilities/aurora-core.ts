import { z } from "zod";
import type { CognitiveOrchestrator } from "../aurora/cognitive-orchestrator.js";
import type { ConstitutionService } from "../aurora/constitution-service.js";
import type { ContinualHarnessService } from "../harness/continual-harness-service.js";
import type { MicroagentRegistry } from "../knowledge/microagent-registry.js";
import type { RiskAnalyzerService } from "../policy/risk-analyzer.js";
import type { StuckDetectorService } from "../runtime/stuck-detector.js";
import { auroraDefined } from "../util/aurora-state.js";
import { defineCapability } from "./schema.js";

const unit = z.number().min(0).max(1);
const component = z.enum(["prompt-note", "memory", "skill-spec", "subagent-spec"]);
const riskLevel = z.enum(["low", "medium", "high", "critical"]);

/** Constitutional identity core: principles, amendments, decision checks and compliance. */
export function constitutionCapabilities(service: ConstitutionService) {
  return [
    defineCapability(
      { id: "constitution.principles", version: "1.0.0", description: "List Aurora's constitutional principles with severity and version.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ status: z.enum(["active", "retired"]).optional() }),
      async (input, ctx) => ({ principles: await service.principles(ctx.tenantId, input.status) }),
    ),
    defineCapability(
      { id: "constitution.identity", version: "1.0.0", description: "Read the Long-Term Identity Core: mission, identity version and continuity log.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.identity(ctx.tenantId),
    ),
    defineCapability(
      { id: "constitution.check", version: "1.0.0", description: "Run the Internal Constitution Checker over a proposed decision. Hard violations deny, soft violations require review; it can never grant authority.", risk: "pure", sideEffect: false, source: "core" },
      z.object({
        summary: z.string().min(1).max(5000), actor: z.string().min(1).max(200),
        attributes: z.object({
          destructive: z.boolean().optional(), irreversible: z.boolean().optional(), externalSideEffect: z.boolean().optional(),
          affectsUserData: z.boolean().optional(), affectsProtectedTopic: z.boolean().optional(), autonomous: z.boolean().optional(),
          humanApproved: z.boolean().optional(), hasEvidence: z.boolean().optional(), hasRollbackPlan: z.boolean().optional(),
          verificationPlanned: z.boolean().optional(), claimType: z.enum(["observation", "inference", "hypothesis", "prediction"]).optional(),
          confidence: unit.optional(), userRelevance: unit.optional(), notifiesUser: z.boolean().optional(),
          selfModifying: z.boolean().optional(), stagedEvolution: z.boolean().optional(), dissentPreserved: z.boolean().optional(),
          contradictsPrinciple: z.array(z.string()).max(20).optional(),
          estimatedTokens: z.number().int().min(0).optional(), budgetRemainingTokens: z.number().int().min(0).optional(),
        }),
      }),
      async (input, ctx) => await service.check({ tenantId: ctx.tenantId, actor: input.actor, summary: input.summary, attributes: auroraDefined(input.attributes) }),
    ),
    defineCapability(
      { id: "constitution.compliance", version: "1.0.0", description: "Constitutional compliance report: allow/review/deny rates and the most-violated principles.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ windowDays: z.number().int().min(1).max(3650).optional() }),
      async (input, ctx) => await service.compliance(ctx.tenantId, input.windowDays ?? 30),
    ),
    defineCapability(
      { id: "constitution.projection", version: "1.0.0", description: "Bounded constitution projection (mission plus principle summaries) for prompt assembly.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ maxCharacters: z.number().int().min(200).max(20_000).optional() }),
      async (input, ctx) => await service.projection(ctx.tenantId, input.maxCharacters ?? 4000),
    ),
    defineCapability(
      { id: "constitution.amend", version: "1.0.0", description: "Amend a constitutional principle. Requires an approver and reason; built-in hard principles cannot be softened or retired.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ principleId: z.string(), title: z.string().max(200).optional(), statement: z.string().max(5000).optional(), severity: z.enum(["hard", "soft"]).optional(), approvedBy: z.string().min(1).max(200), reason: z.string().min(1).max(5000) }),
      async (input, ctx) => await service.amendPrinciple({
        tenantId: ctx.tenantId, principleId: input.principleId, approvedBy: input.approvedBy, reason: input.reason,
        ...(input.title ? { title: input.title } : {}), ...(input.statement ? { statement: input.statement } : {}), ...(input.severity ? { severity: input.severity } : {}),
      }),
    ),
  ];
}

/** Continual Harness: the agent's own reviewable, reversible scaffolding. */
export function harnessCapabilities(service: ContinualHarnessService) {
  return [
    defineCapability(
      { id: "harness.entries", version: "1.0.0", description: "List continual-harness entries: prompt notes, memories, skill specs and sub-agent specs.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ component: component.optional(), enabledOnly: z.boolean().optional(), scope: z.enum(["session", "tenant"]).optional() }),
      async (input, ctx) => ({ entries: await service.entries(ctx.tenantId, { sessionId: ctx.sessionId, ...(input.component ? { component: input.component } : {}), ...(input.enabledOnly !== undefined ? { enabledOnly: input.enabledOnly } : {}), ...(input.scope ? { scope: input.scope } : {}) }) }),
    ),
    defineCapability(
      { id: "harness.refine", version: "1.0.0", description: "Apply one small, evidence-backed refinement batch to harness state. Snapshotted and rollback-capable; the base system prompt and policy are out of scope.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({
        trigger: z.string().min(1).max(2000), rationale: z.string().min(1).max(10_000), scope: z.enum(["session", "tenant"]).optional(),
        evidenceRefs: z.array(z.string()).max(200).optional(),
        operations: z.array(z.object({
          operation: z.enum(["create", "update", "delete", "enable", "disable"]), component, key: z.string().min(1).max(200),
          title: z.string().max(300).optional(), body: z.string().max(20_000).optional(), tags: z.array(z.string()).max(100).optional(),
          priority: z.number().int().min(0).max(100).optional(), evidenceRefs: z.array(z.string()).max(200).optional(),
        })).min(1).max(8),
      }),
      async (input, ctx) => await service.refine({
        tenantId: ctx.tenantId, sessionId: ctx.sessionId, trigger: input.trigger, rationale: input.rationale, operations: input.operations.map((item) => auroraDefined(item)),
        ...(input.scope ? { scope: input.scope } : {}), ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
      }),
    ),
    defineCapability(
      { id: "harness.rollback", version: "1.0.0", description: "Roll one refinement back to its snapshot. Newer refinements in the same scope must be rolled back first.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ refinementId: z.string() }),
      async (input, ctx) => await service.rollback(ctx.tenantId, input.refinementId),
    ),
    defineCapability(
      { id: "harness.refinements", version: "1.0.0", description: "List harness refinements with their triggers, operations and outcomes.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ status: z.enum(["applied", "rolled-back"]).optional(), limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ refinements: await service.refinements(ctx.tenantId, { ...(input.status ? { status: input.status } : {}), ...(input.limit ? { limit: input.limit } : {}) }) }),
    ),
    defineCapability(
      { id: "harness.refinement.outcome", version: "1.0.0", description: "Record whether a refinement actually helped; effectiveness feeds pruning.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ refinementId: z.string(), helpful: z.boolean(), note: z.string().min(1).max(2000) }),
      async (input, ctx) => await service.recordRefinementOutcome(ctx.tenantId, input.refinementId, input.helpful, input.note),
    ),
    defineCapability(
      { id: "harness.project", version: "1.0.0", description: "Budgeted projection of harness state for prompt assembly, with usage accounting.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ characterBudget: z.number().int().min(200).max(100_000).optional(), components: z.array(component).max(4).optional() }),
      async (input, ctx) => await service.project({ tenantId: ctx.tenantId, sessionId: ctx.sessionId, ...(input.characterBudget ? { characterBudget: input.characterBudget } : {}), ...(input.components ? { components: input.components } : {}) }),
    ),
  ];
}

/** Trigger-activated knowledge documents with injection screening. */
export function microagentCapabilities(service: MicroagentRegistry) {
  return [
    defineCapability(
      { id: "microagents.list", version: "1.0.0", description: "List microagents with activation mode, effectiveness and quarantine state.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ activation: z.enum(["always", "keyword", "glob", "manual"]).optional(), enabledOnly: z.boolean().optional(), quarantinedOnly: z.boolean().optional() }),
      async (input, ctx) => ({ microagents: await service.list(ctx.tenantId, { ...(input.activation ? { activation: input.activation } : {}), ...(input.enabledOnly !== undefined ? { enabledOnly: input.enabledOnly } : {}), ...(input.quarantinedOnly !== undefined ? { quarantinedOnly: input.quarantinedOnly } : {}) }) }),
    ),
    defineCapability(
      { id: "microagents.register", version: "1.0.0", description: "Register a trigger-activated knowledge document. Injection screening quarantines anything that tries to rewrite instructions or exfiltrate secrets.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({
        name: z.string().min(2).max(120), body: z.string().min(1).max(50_000), activation: z.enum(["always", "keyword", "glob", "manual"]).optional(),
        triggers: z.array(z.string()).max(100).optional(), globs: z.array(z.string()).max(50).optional(), summary: z.string().max(1000).optional(),
        priority: z.number().int().min(0).max(100).optional(), source: z.enum(["user", "repository", "skill", "learned"]).optional(),
        sourceRef: z.string().max(500).optional(), tags: z.array(z.string()).max(100).optional(),
      }),
      async (input, ctx) => await service.register(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "microagents.recall", version: "1.0.0", description: "Recall the knowledge that applies to the current query and touched files, inside a character budget.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ query: z.string().max(20_000).optional(), touchedPaths: z.array(z.string()).max(200).optional(), requestedNames: z.array(z.string()).max(50).optional(), characterBudget: z.number().int().min(50).max(100_000).optional() }),
      async (input, ctx) => await service.recall(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "microagents.feedback", version: "1.0.0", description: "Record whether recalled knowledge helped; unhelpful documents lose priority.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ microagentId: z.string(), helpful: z.boolean() }),
      async (input, ctx) => await service.recordFeedback(ctx.tenantId, input.microagentId, input.helpful),
    ),
  ];
}

/** Escalation-only risk analysis over proposed capability calls. */
export function riskCapabilities(service: RiskAnalyzerService) {
  return [
    defineCapability(
      { id: "risk.assess", version: "1.0.0", description: "Assess a proposed capability call for destructive patterns and return a risk level, confirmation requirement and safe-zone hint. Escalation only.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ capabilityId: z.string().min(1).max(200), declaredRisk: z.enum(["pure", "workspace_read", "workspace_write", "process", "network", "external_side_effect", "privileged"]), args: z.record(z.unknown()).optional() }),
      async (input, ctx) => await service.assess({ tenantId: ctx.tenantId, capabilityId: input.capabilityId, declaredRisk: input.declaredRisk, sessionId: ctx.sessionId, ...(input.args ? { args: input.args } : {}) }),
    ),
    defineCapability(
      { id: "risk.rules", version: "1.0.0", description: "List destructive-pattern risk rules.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => ({ rules: await service.rules(ctx.tenantId) }),
    ),
    defineCapability(
      { id: "risk.posture", version: "1.0.0", description: "Rolling risk posture: assessment counts by level, confirmation rate and the most-triggered rules.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ windowDays: z.number().int().min(1).max(365).optional() }),
      async (input, ctx) => await service.posture(ctx.tenantId, input.windowDays ?? 7),
    ),
    defineCapability(
      { id: "risk.policy.set", version: "1.0.0", description: "Set the tenant confirmation policy for risk-assessed actions.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ mode: z.enum(["never", "critical", "high", "medium", "all"]), autoDenyCritical: z.boolean().optional() }),
      async (input, ctx) => await service.setPolicy(ctx.tenantId, input.mode, input.autoDenyCritical),
    ),
    defineCapability(
      { id: "risk.rule.add", version: "1.0.0", description: "Add a tenant-specific destructive-pattern rule.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ code: z.string().min(2).max(60), description: z.string().min(1).max(1000), level: riskLevel, pattern: z.string().min(1).max(2000), appliesToCapabilityIds: z.array(z.string()).max(100).optional() }),
      async (input, ctx) => await service.addRule(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
  ];
}

/** Session stuck detection over the durable event log. */
export function stuckCapabilities(service: StuckDetectorService) {
  return [
    defineCapability(
      { id: "session.stuck.analyze", version: "1.0.0", description: "Analyze a session's recent events for repeated actions, repeated errors, oscillation, monologue and approval starvation.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ sessionId: z.string().optional(), windowSize: z.number().int().min(4).max(500).optional(), repeatThreshold: z.number().int().min(2).max(50).optional(), monologueThreshold: z.number().int().min(2).max(50).optional() }),
      async (input, ctx) => await service.analyze(input.sessionId ?? ctx.sessionId, {
        ...(input.windowSize ? { windowSize: input.windowSize } : {}),
        ...(input.repeatThreshold ? { repeatThreshold: input.repeatThreshold } : {}),
        ...(input.monologueThreshold ? { monologueThreshold: input.monologueThreshold } : {}),
      }),
    ),
  ];
}

/** ACOS control loop: one bounded cognitive cycle plus the thought journal. */
export function orchestratorCapabilities(service: CognitiveOrchestrator) {
  return [
    defineCapability(
      { id: "acos.cycle.run", version: "1.0.0", description: "Run one bounded ACOS cognitive cycle: observe, update world, prioritize, allocate, execute, evaluate, learn, remember, reflect, evolve.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ mode: z.enum(["full", "maintenance", "reflection", "dream", "emergency"]).optional(), userId: z.string().max(200).optional(), preempt: z.boolean().optional(), maxInsights: z.number().int().min(1).max(20).optional() }),
      async (input, ctx) => await service.tick(ctx.tenantId, {
        ...(input.mode ? { mode: input.mode } : {}), ...(input.userId ? { userId: input.userId } : {}),
        ...(input.preempt !== undefined ? { preempt: input.preempt } : {}), ...(input.maxInsights ? { maxInsights: input.maxInsights } : {}),
      }),
    ),
    defineCapability(
      { id: "acos.cycles", version: "1.0.0", description: "List recent ACOS cycle reports with phase results and recommendations.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ cycles: await service.cycles(ctx.tenantId, input.limit ?? 20) }),
    ),
    defineCapability(
      { id: "acos.status", version: "1.0.0", description: "One-screen status of the whole Aurora organism across every subsystem.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().max(200).optional() }),
      async (input, ctx) => await service.status(ctx.tenantId, input.userId),
    ),
    defineCapability(
      { id: "acos.journal", version: "1.0.0", description: "Read Aurora's thought journal: cycles, insights, decisions, reflections and anomalies.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ kind: z.enum(["cycle", "insight", "decision", "reflection", "anomaly", "note"]).optional(), limit: z.number().int().min(1).max(2000).optional() }),
      async (input, ctx) => ({ entries: await service.journal(ctx.tenantId, { ...(input.kind ? { kind: input.kind } : {}), ...(input.limit ? { limit: input.limit } : {}) }) }),
    ),
    defineCapability(
      { id: "acos.journal.note", version: "1.0.0", description: "Append a note to the thought journal.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ kind: z.enum(["cycle", "insight", "decision", "reflection", "anomaly", "note"]).optional(), title: z.string().min(1).max(300), body: z.string().min(1).max(20_000), refs: z.array(z.string()).max(100).optional() }),
      async (input, ctx) => await service.note({ tenantId: ctx.tenantId, title: input.title, body: input.body, ...(input.kind ? { kind: input.kind } : {}), ...(input.refs ? { refs: input.refs } : {}) }),
    ),
  ];
}

/** Memory insight/concept-formation capabilities (Dream Mode association). */
export function insightCapabilities(memoryGraph: { proposeInsights: (tenantId: string, options?: { minSharedTags?: number; minImportance?: number; limit?: number }) => Promise<unknown>; materializeInsight: (input: { tenantId: string; leftId: string; rightId: string; title: string; content: string; confidence?: number; importance?: number; tags?: string[] }) => Promise<unknown> }) {
  return [
    defineCapability(
      { id: "memory.insights.propose", version: "1.0.0", description: "Dream-Mode concept formation: propose connections between related but unlinked memories. Nothing is written until a candidate is materialized.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ minSharedTags: z.number().int().min(1).max(20).optional(), minImportance: unit.optional(), limit: z.number().int().min(1).max(100).optional() }),
      async (input, ctx) => ({ candidates: await memoryGraph.proposeInsights(ctx.tenantId, auroraDefined(input)) }),
    ),
    defineCapability(
      { id: "memory.insights.materialize", version: "1.0.0", description: "Store an insight candidate as a palace-layer hypothesis linked to both source memories.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ leftId: z.string(), rightId: z.string(), title: z.string().min(1).max(300), content: z.string().min(1).max(100_000), confidence: unit.optional(), importance: unit.optional(), tags: z.array(z.string()).max(100).optional() }),
      async (input, ctx) => await memoryGraph.materializeInsight(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
  ];
}
