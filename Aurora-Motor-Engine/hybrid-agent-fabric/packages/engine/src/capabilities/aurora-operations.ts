import { z } from "zod";
import type { AuroraDataGovernanceService } from "../aurora/data-governance-service.js";
import type { AuroraExecutionBridge } from "../aurora/execution-bridge.js";
import type { AuroraEstimationCalibrator } from "../aurora/estimation-calibrator.js";
import type { AuroraFleetSupervisor } from "../aurora/fleet-supervisor.js";
import type { AuroraOutcomeHarvester } from "../aurora/outcome-harvester.js";
import type { AuroraPlanFeedback } from "../aurora/plan-feedback-service.js";
import type { RoleAuthorityService } from "../aurora/role-authority-service.js";
import type { AuroraMetricsCollector } from "../aurora/aurora-metrics.js";
import type { WorkspaceCheckpointService } from "../aurora/workspace-checkpoint-service.js";
import { auroraDefined } from "../util/aurora-state.js";
import { defineCapability } from "./schema.js";

/**
 * Operational Aurora surfaces: real workspace rollback, content-free telemetry and the data
 * governance operations (export, purge, integrity self-check) that keep a long-lived cognitive
 * system inspectable.
 */
export function checkpointCapabilities(service: WorkspaceCheckpointService) {
  return [
    defineCapability(
      { id: "checkpoint.capture", version: "1.0.0", description: "Take a bounded content-addressed snapshot of the session workspace so risky work has a real recovery path.", risk: "workspace_read", sideEffect: true, source: "core" },
      z.object({ label: z.string().min(1).max(200), reason: z.string().min(1).max(2000), actionId: z.string().max(300).optional(), maxFiles: z.number().int().min(1).max(50_000).optional(), maxTotalBytes: z.number().int().min(1024).max(1_073_741_824).optional() }),
      async (input, ctx) => await service.capture(auroraDefined({
        tenantId: ctx.tenantId, workspacePath: ctx.workspacePath, sessionId: ctx.sessionId,
        label: input.label, reason: input.reason, actionId: input.actionId,
        limits: auroraDefined({ maxFiles: input.maxFiles, maxTotalBytes: input.maxTotalBytes }),
      })),
    ),
    defineCapability(
      { id: "checkpoint.diff", version: "1.0.0", description: "Compare the current workspace against a checkpoint without changing anything.", risk: "workspace_read", sideEffect: false, source: "core" },
      z.object({ checkpointId: z.string() }),
      async (input, ctx) => await service.diff(ctx.tenantId, input.checkpointId, ctx.workspacePath),
    ),
    defineCapability(
      { id: "checkpoint.restore", version: "1.0.0", description: "Restore the workspace to a checkpoint. A safety checkpoint is taken first, so the rollback is itself reversible.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ checkpointId: z.string(), removeAddedFiles: z.boolean().optional(), safetyCheckpoint: z.boolean().optional() }),
      async (input, ctx) => await service.restore(auroraDefined({
        tenantId: ctx.tenantId, workspacePath: ctx.workspacePath, checkpointId: input.checkpointId,
        removeAddedFiles: input.removeAddedFiles, safetyCheckpoint: input.safetyCheckpoint,
      })),
    ),
    defineCapability(
      { id: "checkpoint.list", version: "1.0.0", description: "List workspace checkpoints with their manifests and restore history.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ sessionId: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ checkpoints: await service.list(ctx.tenantId, auroraDefined(input)) }),
    ),
    defineCapability(
      { id: "checkpoint.usage", version: "1.0.0", description: "Checkpoint storage footprint and deduplication ratio.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.usage(ctx.tenantId),
    ),
  ];
}

export function auroraMetricsCapabilities(service: AuroraMetricsCollector) {
  return [
    defineCapability(
      { id: "aurora.metrics", version: "1.0.0", description: "Content-free Aurora telemetry across cognition, memory, world, initiative, society, evolution, environment, decisions, plans, constitution and autopilot.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.snapshot(ctx.tenantId),
    ),
    defineCapability(
      { id: "aurora.alerts", version: "1.0.0", description: "Threshold alerts derived from Aurora telemetry: degraded health, budget exhaustion, miscalibration, verification debt, overconfidence and failing autopilot.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => ({ alerts: await service.alerts(ctx.tenantId) }),
    ),
  ];
}

export function governanceCapabilities(service: AuroraDataGovernanceService) {
  return [
    defineCapability(
      { id: "aurora.export", version: "1.0.0", description: "Export everything Aurora holds for the tenant, or for one user, with per-section digests.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().max(200).optional(), includeContent: z.boolean().optional() }),
      async (input, ctx) => await service.export(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "aurora.purge.user", version: "1.0.0", description: "Purge a user's stored inferences. Defaults to a dry run; audit-grade records are reported as retained rather than silently kept.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ userId: z.string().min(1).max(200), dryRun: z.boolean().optional() }),
      async (input, ctx) => await service.purgeUser(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "aurora.selfcheck", version: "1.0.0", description: "Cross-store integrity audit: dangling references, reservation drift, verification debt, ungated production skills, quarantine bypass and constitutional floor damage.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.selfCheck(ctx.tenantId),
    ),
    defineCapability(
      { id: "aurora.footprint", version: "1.0.0", description: "Retention view of how many records each Aurora store holds.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.footprint(ctx.tenantId),
    ),
  ];
}

/**
 * Fleet capabilities are deliberately tenant-scoped: an agent may enroll, tune or withdraw its own
 * tenant and read its own membership, but the cross-tenant fleet view and cross-tenant sweeps stay
 * with operators over the admin-gated Control API. Multi-tenancy must never leak through a tool.
 */
export function fleetCapabilities(service: AuroraFleetSupervisor) {
  return [
    defineCapability(
      { id: "aurora.fleet.status", version: "1.0.0", description: "This tenant's unattended fleet membership joined with its autopilot health.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.tenantStatus(ctx.tenantId),
    ),
    defineCapability(
      { id: "aurora.fleet.enroll", version: "1.0.0", description: "Opt this tenant into the unattended fleet driver with a priority band and a per-sweep run cap.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ priority: z.number().int().min(1).max(5).optional(), maxRunsPerSweep: z.number().int().min(1).max(50).optional(), note: z.string().max(500).optional(), enabled: z.boolean().optional() }),
      async (input, ctx) => await service.enroll(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "aurora.fleet.update", version: "1.0.0", description: "Change this tenant's fleet enrollment: enablement, priority, per-sweep run cap or note.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ enabled: z.boolean().optional(), priority: z.number().int().min(1).max(5).optional(), maxRunsPerSweep: z.number().int().min(1).max(50).optional(), note: z.string().max(500).optional() }),
      async (input, ctx) => await service.update(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "aurora.fleet.withdraw", version: "1.0.0", description: "Remove this tenant from the unattended fleet driver. Its autopilot config and ledger are kept.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.withdraw(ctx.tenantId),
    ),
    defineCapability(
      { id: "aurora.fleet.sweep", version: "1.0.0", description: "Run this tenant's due cadences through the fleet supervisor, honouring the per-sweep cap and circuit breaker.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.sweep({ tenantId: ctx.tenantId, limit: 1 }),
    ),
  ];
}

/**
 * Delegation capabilities close the loop between a plan and the society that executes it. Posting,
 * nominating and awarding are governed writes; spawning the child session (`plan.activate`) is a
 * separate, explicitly privileged step so real work never starts as a side effect of planning.
 */
export function delegationCapabilities(service: AuroraExecutionBridge) {
  return [
    defineCapability(
      { id: "plan.delegate", version: "1.0.0", description: "Turn ready plan steps into society tasks, nominating the best-matching role with recorded match evidence.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({
        planId: z.string().min(1).max(300), rootSessionId: z.string().max(200).optional(),
        stepKeys: z.array(z.string().min(1).max(120)).max(25).optional(), max: z.number().int().min(1).max(25).optional(),
        priority: z.enum(["critical", "high", "normal", "low"]).optional(), capabilityTags: z.array(z.string()).max(20).optional(),
        nominate: z.boolean().optional(), award: z.boolean().optional(), activate: z.boolean().optional(),
      }),
      async (input, ctx) => await service.delegate(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "plan.activate", version: "1.0.0", description: "Spawn the child session for an awarded delegation. The one irreversible delegation step, kept explicit.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ linkId: z.string().min(1).max(300) }),
      async (input, ctx) => await service.activate(ctx.tenantId, input.linkId),
    ),
    defineCapability(
      { id: "plan.sync", version: "1.0.0", description: "Reconcile society task outcomes back into plan steps, carrying the child session's evidence event IDs.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ planId: z.string().max(300).optional(), limit: z.number().int().min(1).max(2000).optional() }),
      async (input, ctx) => await service.sync(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "plan.delegations", version: "1.0.0", description: "List delegation links with their match evidence, society status and outcomes.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ planId: z.string().max(300).optional(), openOnly: z.boolean().optional(), limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ links: await service.links(ctx.tenantId, auroraDefined(input)) }),
    ),
    defineCapability(
      { id: "plan.delegation-report", version: "1.0.0", description: "How much of a plan is actually being executed, by which roles, with what results.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ planId: z.string().min(1).max(300) }),
      async (input, ctx) => await service.report(ctx.tenantId, input.planId),
    ),
    defineCapability(
      { id: "plan.delegation-candidates", version: "1.0.0", description: "Rank the active society roles that could take a piece of work, with coverage, reputation and current load.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ capabilityTags: z.array(z.string()).max(20) }),
      async (input, ctx) => ({ candidates: await service.candidates(ctx.tenantId, input.capabilityTags) }),
    ),
    defineCapability(
      { id: "plan.delegation-detach", version: "1.0.0", description: "Unhook a delegation from its plan step without touching the society task, for replanning.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ linkId: z.string().min(1).max(300), reason: z.string().min(1).max(1000) }),
      async (input, ctx) => await service.detach(ctx.tenantId, input.linkId, input.reason),
    ),
    defineCapability(
      { id: "plan.delegation-policy", version: "1.0.0", description: "Read or change unattended delegation: auto-delegate, auto-activate, root session and concurrency bounds.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({
        autoDelegate: z.boolean().optional(), autoActivate: z.boolean().optional(), rootSessionId: z.string().max(200).nullable().optional(),
        maxActiveTasksPerPlan: z.number().int().min(1).max(100).optional(), maxTasksPerRun: z.number().int().min(1).max(25).optional(),
        requireRoleMatch: z.boolean().optional(),
        probation: z.object({ minAttempts: z.number().int().min(1).max(1000).optional(), maxFailureRate: z.number().min(0).max(1).optional(), riskFloor: z.number().min(0).max(1).optional() }).optional(),
      }),
      async (input, ctx) => {
        if (!Object.keys(input).length) return await service.policy(ctx.tenantId);
        const { probation, ...rest } = input;
        return await service.configure(auroraDefined({
          tenantId: ctx.tenantId, ...rest,
          ...(probation ? { probation: auroraDefined(probation) } : {}),
        }));
      },
    ),
  ];
}

/**
 * Role authority: least-privilege capability allowlists for the society. Reading templates and the
 * audit is pure; applying one changes who can do what, so it is privileged.
 */
export function roleAuthorityCapabilities(service: RoleAuthorityService) {
  return [
    defineCapability(
      { id: "society.authority.templates", version: "1.1.0", description: "List the least-authority role templates — built-in and tenant-defined — with rationale and risk ceiling.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => ({ templates: await service.allTemplates(ctx.tenantId) }),
    ),
    defineCapability(
      { id: "society.authority.resolve", version: "1.1.0", description: "Resolve a role template against the live capability catalog without changing anything.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ templateId: z.string().min(1).max(100) }),
      async (input, ctx) => await service.resolveFor(ctx.tenantId, input.templateId),
    ),
    defineCapability(
      { id: "society.authority.apply", version: "1.0.0", description: "Create or update the agent profile for a role template and bind it to its roles.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ templateId: z.string().min(1).max(100), roleIds: z.array(z.string().min(1).max(200)).max(50).optional(), bind: z.boolean().optional(), modelRoute: z.string().max(300).optional() }),
      async (input, ctx) => await service.apply(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "society.authority.apply-all", version: "1.0.0", description: "Bring the whole society to least authority by applying every built-in template.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({}),
      async (_input, ctx) => ({ applied: await service.applyAll(ctx.tenantId) }),
    ),
    defineCapability(
      { id: "society.authority.define", version: "1.0.0", description: "Define or replace a tenant's own least-authority template. Built-in ids are reserved and empty templates are rejected.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({
        id: z.string().min(2).max(60), title: z.string().min(1).max(200), rationale: z.string().min(1).max(2000),
        roleIds: z.array(z.string().min(1).max(200)).max(50).optional(),
        allow: z.array(z.string().min(1).max(200)).min(1).max(100),
        deny: z.array(z.string().min(1).max(200)).max(100).optional(),
        maxRisk: z.enum(["pure", "workspace_read", "workspace_write", "process", "network", "external_side_effect", "privileged"]),
      }),
      async (input, ctx) => await service.defineTemplate(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "society.authority.remove", version: "1.0.0", description: "Remove a tenant-defined template. Built-in templates cannot be removed.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ templateId: z.string().min(1).max(100) }),
      async (input, ctx) => await service.removeTemplate(ctx.tenantId, input.templateId),
    ),
    defineCapability(
      { id: "society.authority.audit", version: "1.0.0", description: "Which roles still inherit full authority, which profiles are missing and which drifted above their template.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.audit(ctx.tenantId),
    ),
  ];
}

/**
 * Outcome harvesting: score settled delegated work from recorded events and close the society loop.
 * Reading assessments is pure; recording an outcome changes reputation and plan state, so it is
 * privileged — and the ambiguous middle band is never auto-recorded at all.
 */
export function harvestCapabilities(service: AuroraOutcomeHarvester) {
  return [
    defineCapability(
      { id: "plan.harvest", version: "1.0.0", description: "Score settled delegated tasks from their child sessions and record unambiguous outcomes.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ planId: z.string().max(300).optional(), linkId: z.string().max(300).optional(), force: z.boolean().optional() }),
      async (input, ctx) => await service.harvest(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "plan.harvest-assess", version: "1.0.0", description: "Score one delegated task's child session without recording anything.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ linkId: z.string().min(1).max(300) }),
      async (input, ctx) => await service.assess(ctx.tenantId, input.linkId),
    ),
    defineCapability(
      { id: "plan.harvest-assessments", version: "1.0.0", description: "Read outcome assessments with the full criteria scorecard behind each score.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ planId: z.string().max(300).optional(), disposition: z.enum(["recorded", "review", "skipped"]).optional(), limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ assessments: await service.assessments(ctx.tenantId, auroraDefined(input)) }),
    ),
    defineCapability(
      { id: "plan.harvest-review", version: "1.0.0", description: "The delegated tasks the harvester refused to judge, waiting for a human verdict.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ review: await service.reviewQueue(ctx.tenantId, input.limit ?? 50) }),
    ),
    defineCapability(
      { id: "plan.harvest-resolve", version: "1.0.0", description: "Resolve a review item with a human verdict, keeping the machine scorecard attached.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ assessmentId: z.string().min(1).max(300), success: z.boolean(), quality: z.number().min(0).max(1).optional(), note: z.string().max(1000).optional() }),
      async (input, ctx) => await service.resolveReview(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "plan.harvest-policy", version: "1.0.0", description: "Read or change harvesting: automatic recording, success/failure thresholds and the settle window.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ autoRecord: z.boolean().optional(), successAtOrAbove: z.number().min(0).max(1).optional(), failBelow: z.number().min(0).max(1).optional(), settleAfterMs: z.number().int().min(0).max(86_400_000).optional(), maxPerRun: z.number().int().min(1).max(200).optional(), learnFromFailures: z.boolean().optional() }),
      async (input, ctx) => Object.keys(input).length
        ? await service.configure(auroraDefined({ tenantId: ctx.tenantId, ...input }))
        : await service.policy(ctx.tenantId),
    ),
  ];
}

/**
 * Plan feedback: turn a finished plan into the decision outcome that calibration depends on.
 * Reading candidates and records is pure; reconciling writes an outcome, so it is privileged and
 * supports a dry run that shows exactly what would be written.
 */
export function planFeedbackCapabilities(service: AuroraPlanFeedback) {
  return [
    defineCapability(
      { id: "decision.feedback-candidates", version: "1.0.0", description: "Decisions whose plans have finished and are waiting for a recorded outcome, with the reason each one is or is not eligible.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ candidates: await service.candidates(ctx.tenantId, input.limit ?? 50) }),
    ),
    defineCapability(
      { id: "decision.feedback-reconcile", version: "1.0.0", description: "Record decision outcomes derived from terminal plans and their evidence. Supports a dry run.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ planId: z.string().max(300).optional(), dryRun: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() }),
      async (input, ctx) => await service.reconcile(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "decision.feedback-records", version: "1.0.0", description: "Plan-derived decision outcomes with their surprise, Brier score and evidence.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ records: await service.records(ctx.tenantId, input.limit ?? 50) }),
    ),
    defineCapability(
      { id: "decision.feedback-summary", version: "1.0.0", description: "How well plan-derived expectations matched plan-derived reality.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.summary(ctx.tenantId),
    ),
  ];
}

/**
 * Estimation calibration: planning that learns how wrong it usually is, from measured durations only.
 * Profiling and suggesting are pure; applying rewrites plan estimates as an auditable revision.
 */
export function estimationCapabilities(service: AuroraEstimationCalibrator) {
  return [
    defineCapability(
      { id: "plan.estimation-ingest", version: "1.0.0", description: "Harvest finished steps with recorded durations into the estimation sample set.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ planId: z.string().max(300).optional(), limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => await service.ingest(ctx.tenantId, auroraDefined(input)),
    ),
    defineCapability(
      { id: "plan.estimation-profile", version: "1.0.0", description: "Measured estimating skill: median correction factor, error and confidence, overall and per bucket.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.profile(ctx.tenantId),
    ),
    defineCapability(
      { id: "plan.estimation-suggest", version: "1.0.0", description: "Corrected estimates for a plan's unfinished steps, including the ones deliberately left alone.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ planId: z.string().min(1).max(300) }),
      async (input, ctx) => await service.suggest(ctx.tenantId, input.planId),
    ),
    defineCapability(
      { id: "plan.estimation-apply", version: "1.0.0", description: "Apply measured corrections to a plan as a recorded revision naming the factor and sample count.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ planId: z.string().min(1).max(300), minSamples: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => await service.apply(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "plan.estimation-samples", version: "1.0.0", description: "The measured estimate/actual pairs behind the correction factors.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ samples: await service.samples(ctx.tenantId, input.limit ?? 100) }),
    ),
  ];
}

/** Which roles their own record has benched, and what that currently blocks. */
export function probationCapabilities(service: AuroraExecutionBridge) {
  return [
    defineCapability(
      { id: "society.probation", version: "1.0.0", description: "Roles on probation with their record, plus the ready high-risk steps this currently blocks.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.probationReport(ctx.tenantId),
    ),
  ];
}
