import { z } from "zod";
import type { AuroraAutopilot } from "../aurora/autopilot.js";
import type { DecisionService } from "../aurora/decision-service.js";
import type { ExperienceDistiller } from "../aurora/experience-distiller.js";
import type { PlanningService } from "../aurora/planning-service.js";
import type { ProvenanceService } from "../aurora/provenance-service.js";
import { auroraDefined } from "../util/aurora-state.js";
import { defineCapability } from "./schema.js";

const unit = z.number().min(0).max(1);
const stepInput = z.object({
  key: z.string().min(1).max(120),
  title: z.string().min(1).max(300),
  detail: z.string().max(20_000).optional(),
  dependsOn: z.array(z.string()).max(50).optional(),
  estimateMinutes: z.number().int().min(0).max(100_000).optional(),
  estimateTokens: z.number().int().min(0).max(100_000_000).optional(),
  riskLevel: unit.optional(),
  verification: z.string().max(2000).optional(),
  assignedRoleId: z.string().max(200).optional(),
});
const provenanceKind = z.enum(["cognitive-object", "initiative", "intake", "memory", "world-entity", "world-event", "environment-action", "environment-resource", "decision", "plan", "constitution-verdict"]);

/** Structured decision making with criteria, dissent, expected outcomes and calibration. */
export function decisionCapabilities(service: DecisionService) {
  return [
    defineCapability(
      { id: "decision.open", version: "1.0.0", description: "Open a structured decision with weighted criteria. Weights are normalized so options stay comparable.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({
        title: z.string().min(1).max(300), question: z.string().min(1).max(10_000), context: z.string().max(50_000).optional(),
        reversibility: z.enum(["reversible", "costly", "irreversible"]).optional(),
        criteria: z.array(z.object({ name: z.string().min(1).max(120), weight: unit, direction: z.enum(["maximize", "minimize"]).optional(), description: z.string().max(1000).optional() })).min(1).max(20),
        goalIds: z.array(z.string()).max(50).optional(), analysisId: z.string().optional(), evidenceRefs: z.array(z.string()).max(200).optional(),
      }),
      async (input, ctx) => await service.open(auroraDefined({ tenantId: ctx.tenantId, sessionId: ctx.sessionId, ...input, criteria: input.criteria.map((item) => auroraDefined(item)) })),
    ),
    defineCapability(
      { id: "decision.option.add", version: "1.0.0", description: "Add an option scored 0-1 against the decision criteria. Unscored criteria count as unknown, never as zero.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({
        decisionId: z.string(), name: z.string().min(1).max(200), description: z.string().max(20_000).optional(),
        scores: z.record(unit), risks: z.array(z.string()).max(20).optional(),
        cost: z.object({ tokens: z.number().int().min(0).optional(), hours: z.number().min(0).optional(), money: z.number().min(0).optional() }).optional(),
        evidenceRefs: z.array(z.string()).max(200).optional(),
      }),
      async (input, ctx) => await service.addOption(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "decision.dissent", version: "1.0.0", description: "Record a dissenting concern; dissent stays on the record permanently.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ decisionId: z.string(), source: z.string().min(1).max(200), concern: z.string().min(1).max(5000) }),
      async (input, ctx) => await service.recordDissent({ tenantId: ctx.tenantId, ...input }),
    ),
    defineCapability(
      { id: "decision.decide", version: "1.0.0", description: "Decide using the computed weighted ranking. Choosing a lower-ranked option requires an explicit override reason; a constitution denial blocks the decision.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({
        decisionId: z.string(), rationale: z.string().min(1).max(20_000), expectedOutcome: z.string().min(1).max(5000),
        chosenOptionId: z.string().optional(), overrideReason: z.string().max(5000).optional(), reviewInDays: z.number().int().min(1).max(3650).optional(),
        constitutionVerdictId: z.string().optional(), constitutionVerdict: z.enum(["allow", "review", "deny"]).optional(),
      }),
      async (input, ctx) => await service.decide(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "decision.outcome", version: "1.0.0", description: "Record what actually happened; surprise and Brier score are computed from the stated expectation and confidence.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ decisionId: z.string(), succeeded: z.boolean(), observedValue: unit.optional(), note: z.string().min(1).max(10_000), evidenceRefs: z.array(z.string()).max(200).optional() }),
      async (input, ctx) => await service.recordOutcome(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "decision.list", version: "1.0.0", description: "List decisions with options, dissent, expectations and outcomes.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ status: z.enum(["draft", "open", "decided", "executed", "reviewed", "abandoned"]).optional(), limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ decisions: await service.list(ctx.tenantId, auroraDefined(input)) }),
    ),
    defineCapability(
      { id: "decision.review.due", version: "1.0.0", description: "List decisions whose review window elapsed without an outcome.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => ({ decisions: await service.dueForReview(ctx.tenantId) }),
    ),
    defineCapability(
      { id: "decision.calibration", version: "1.0.0", description: "Decision calibration: success rate, mean surprise, Brier score and overconfidence.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.calibration(ctx.tenantId),
    ),
  ];
}

/** Dependency-ordered planning with critical path, verification and auditable replanning. */
export function planningCapabilities(service: PlanningService) {
  return [
    defineCapability(
      { id: "plan.create", version: "1.0.0", description: "Create a dependency-ordered plan with estimates, per-step verification and a computed critical path. Dependency cycles are rejected.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({
        title: z.string().min(1).max(300), objective: z.string().min(1).max(20_000),
        horizon: z.enum(["reactive", "tactical", "strategic"]).optional(), goalId: z.string().optional(),
        decisionId: z.string().optional(), tags: z.array(z.string()).max(100).optional(), steps: z.array(stepInput).min(1).max(200),
      }),
      async (input, ctx) => await service.create(auroraDefined({ tenantId: ctx.tenantId, sessionId: ctx.sessionId, ...input, steps: input.steps.map((item) => auroraDefined(item)) })),
    ),
    defineCapability(
      { id: "plan.revise", version: "1.0.0", description: "Replace the step graph with a new version. Completed work survives; the reason and trigger are mandatory.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ planId: z.string(), reason: z.string().min(1).max(5000), trigger: z.enum(["manual", "step-failed", "blocked", "scope-change", "budget", "review"]).optional(), steps: z.array(stepInput.extend({ status: z.enum(["pending", "ready", "in-progress", "blocked", "done", "skipped", "failed"]).optional() })).min(1).max(200) }),
      async (input, ctx) => await service.revise(auroraDefined({ tenantId: ctx.tenantId, ...input, steps: input.steps.map((item) => auroraDefined(item)) })),
    ),
    defineCapability(
      { id: "plan.step.update", version: "1.0.0", description: "Advance a plan step. Starting a step requires its dependencies to be satisfied.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ planId: z.string(), stepKey: z.string().min(1).max(120), status: z.enum(["pending", "ready", "in-progress", "blocked", "done", "skipped", "failed"]), note: z.string().max(5000).optional(), actualMinutes: z.number().int().min(0).max(100_000).optional(), evidenceRefs: z.array(z.string()).max(200).optional(), taskId: z.string().max(200).optional() }),
      async (input, ctx) => await service.updateStep(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
    defineCapability(
      { id: "plan.progress", version: "1.0.0", description: "What can start now, what is blocked on what, and how much work remains on the critical path.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ planId: z.string() }),
      async (input, ctx) => await service.progress(ctx.tenantId, input.planId),
    ),
    defineCapability(
      { id: "plan.list", version: "1.0.0", description: "List plans with progress, estimates and revision history.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ status: z.enum(["draft", "active", "blocked", "completed", "abandoned", "superseded"]).optional(), goalId: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ plans: await service.list(ctx.tenantId, auroraDefined(input)) }),
    ),
    defineCapability(
      { id: "plan.stalled", version: "1.0.0", description: "Plans with ready work that has not moved: the stalled-progress signal.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ days: z.number().int().min(1).max(365).optional() }),
      async (input, ctx) => ({ stalled: await service.stalled(ctx.tenantId, input.days ?? 7) }),
    ),
  ];
}

/** Closed learning loop: distill lessons from real trajectories as governed candidates. */
export function distillerCapabilities(service: ExperienceDistiller) {
  return [
    defineCapability(
      { id: "experience.distill", version: "1.0.0", description: "Analyze a finished session trajectory and propose reusable lessons: procedures, pitfalls and capability gaps. Proposals are never auto-applied.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ sessionId: z.string().optional(), objective: z.string().max(5000).optional(), maxEvents: z.number().int().min(10).max(5000).optional() }),
      async (input, ctx) => await service.distill(auroraDefined({ tenantId: ctx.tenantId, sessionId: input.sessionId ?? ctx.sessionId, objective: input.objective, maxEvents: input.maxEvents })),
    ),
    defineCapability(
      { id: "experience.proposals", version: "1.0.0", description: "List distilled lesson proposals with evidence and confidence.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ status: z.enum(["proposed", "applied", "rejected", "duplicate"]).optional(), kind: z.enum(["harness-memory", "microagent", "skill-blueprint", "workflow"]).optional(), limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ proposals: await service.proposals(ctx.tenantId, auroraDefined(input)) }),
    ),
    defineCapability(
      { id: "experience.apply", version: "1.0.0", description: "Apply a distilled proposal through the governed harness, microagent or skill-evolution service.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ proposalId: z.string(), actor: z.string().min(1).max(200) }),
      async (input, ctx) => await service.apply({ tenantId: ctx.tenantId, ...input }),
    ),
    defineCapability(
      { id: "experience.reject", version: "1.0.0", description: "Reject a distilled proposal with a reason so it is not proposed again.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ proposalId: z.string(), reason: z.string().min(1).max(2000) }),
      async (input, ctx) => await service.reject(ctx.tenantId, input.proposalId, input.reason),
    ),
  ];
}

/** Unattended cadence for the cognitive loop, with hard bounds and a durable run ledger. */
export function autopilotCapabilities(service: AuroraAutopilot) {
  return [
    defineCapability(
      { id: "autopilot.status", version: "1.0.0", description: "Autopilot cadence health: enablement, daily run usage, failure rate and next scheduled work.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.health(ctx.tenantId),
    ),
    defineCapability(
      { id: "autopilot.configure", version: "1.0.0", description: "Enable/disable unattended operation and tune cadences, daily run ceiling and quiet hours.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({
        enabled: z.boolean().optional(), maxRunsPerDay: z.number().int().min(0).max(5000).optional(),
        quietHoursUtc: z.object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) }).nullable().optional(),
        cadences: z.array(z.object({ kind: z.enum(["pulse", "maintenance", "reflection", "dream", "daily-briefing", "weekly-review", "monthly-strategy"]), enabled: z.boolean().optional(), everyMinutes: z.number().int().min(5).max(129_600).optional() })).max(7).optional(),
      }),
      async (input, ctx) => await service.configure(auroraDefined({ tenantId: ctx.tenantId, ...input, cadences: input.cadences?.map((item) => auroraDefined(item)) })),
    ),
    defineCapability(
      { id: "autopilot.run-due", version: "1.0.0", description: "Run every cadence that is currently due, respecting quiet hours and the daily ceiling.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({}),
      async (_input, ctx) => ({ runs: await service.runDue(ctx.tenantId) }),
    ),
    defineCapability(
      { id: "autopilot.runs", version: "1.0.0", description: "Read the unattended run ledger with outcomes and durations.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ runs: await service.runs(ctx.tenantId, input.limit ?? 50) }),
    ),
  ];
}

/** "Why did you do that?" — reconstructed from durable state, never narrated by a model. */
export function provenanceCapabilities(service: ProvenanceService) {
  return [
    defineCapability(
      { id: "aurora.explain", version: "1.0.0", description: "Trace an artifact's provenance across initiatives, cognition, memory, world state, decisions, plans, actions and constitutional review.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ kind: provenanceKind, id: z.string().min(1).max(300), depth: z.number().int().min(1).max(6).optional() }),
      async (input, ctx) => await service.explain(auroraDefined({ tenantId: ctx.tenantId, ...input })),
    ),
  ];
}
