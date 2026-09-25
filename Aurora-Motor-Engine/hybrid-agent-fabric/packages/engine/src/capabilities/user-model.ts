import { z } from "zod";
import type { UserModelService } from "../user/user-model-service.js";
import { defineCapability } from "./schema.js";

const unit = z.number().min(0).max(1);
const category = z.enum(["identity-context", "goal", "motivation", "decision-style", "learning-style", "strength", "weakness", "habit", "productivity", "energy", "attention", "frustration", "communication", "trust", "interest", "project", "tooling"]);

/**
 * Aurora Phase E capabilities: governed user cognitive model.
 * Inferences are correctable, consent-scoped and deletable, and protected topics are rejected.
 */
export function userModelCapabilities(service: UserModelService) {
  return [
    defineCapability(
      { id: "user.model.observe", version: "1.0.0", description: "Record a behavioural claim about the user with evidence and confidence. Inferred claims stay proposed until confirmed; protected topics are rejected.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ userId: z.string().min(1).max(200), category, key: z.string().min(1).max(200), value: z.string().min(1).max(5000), confidence: unit, source: z.enum(["user-stated", "inferred", "system"]), evidenceRefs: z.array(z.string()).max(200).optional(), expiresAt: z.string().datetime().optional() }),
      async (input, ctx) => await service.observeClaim({
        tenantId: ctx.tenantId, userId: input.userId, category: input.category, key: input.key, value: input.value, confidence: input.confidence, source: input.source,
        ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}), ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      }),
    ),
    defineCapability(
      { id: "user.model.claims", version: "1.0.0", description: "Inspect every claim Aurora holds about a user, including proposed inferences.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200), category: category.optional(), status: z.enum(["proposed", "active", "corrected", "retracted", "expired"]).optional() }),
      async (input, ctx) => ({ claims: await service.claims(ctx.tenantId, input.userId, { ...(input.category ? { category: input.category } : {}), ...(input.status ? { status: input.status } : {}) }) }),
    ),
    defineCapability(
      { id: "user.model.correct", version: "1.0.0", description: "Apply a user correction to a claim; the previous value is retained as auditable history.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ claimId: z.string(), correctedValue: z.string().min(1).max(5000), reason: z.string().min(1).max(2000), confidence: unit.optional() }),
      async (input, ctx) => await service.correctClaim({ tenantId: ctx.tenantId, claimId: input.claimId, correctedValue: input.correctedValue, reason: input.reason, ...(input.confidence !== undefined ? { confidence: input.confidence } : {}) }),
    ),
    defineCapability(
      { id: "user.model.consent", version: "1.0.0", description: "Grant or deny consent for an inferred claim. Denial retracts it immediately.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ claimId: z.string(), consent: z.enum(["granted", "pending", "denied"]) }),
      async (input, ctx) => await service.setConsent(ctx.tenantId, input.claimId, input.consent),
    ),
    defineCapability(
      { id: "user.model.forget", version: "1.0.0", description: "Delete stored inferences about a user, optionally limited to one category.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ userId: z.string().min(1).max(200), category: category.optional() }),
      async (input, ctx) => await service.forgetUser(ctx.tenantId, input.userId, input.category),
    ),
    defineCapability(
      { id: "user.goal.upsert", version: "1.0.0", description: "Create or update a long/medium/short horizon user goal with progress.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ userId: z.string().min(1).max(200), horizon: z.enum(["long", "medium", "short"]), title: z.string().min(1).max(300), description: z.string().max(10_000).optional(), parentGoalId: z.string().optional(), importance: unit.optional(), goalId: z.string().optional(), progress: unit.optional(), status: z.enum(["active", "paused", "achieved", "abandoned"]).optional() }),
      async (input, ctx) => await service.upsertGoal({
        tenantId: ctx.tenantId, userId: input.userId, horizon: input.horizon, title: input.title,
        ...(input.description ? { description: input.description } : {}), ...(input.parentGoalId ? { parentGoalId: input.parentGoalId } : {}),
        ...(input.importance !== undefined ? { importance: input.importance } : {}), ...(input.goalId ? { goalId: input.goalId } : {}),
        ...(input.progress !== undefined ? { progress: input.progress } : {}), ...(input.status ? { status: input.status } : {}),
      }),
    ),
    defineCapability(
      { id: "user.goals.list", version: "1.0.0", description: "List the user's goal model ordered by horizon and importance.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200), status: z.enum(["active", "paused", "achieved", "abandoned"]).optional() }),
      async (input, ctx) => ({ goals: await service.goals(ctx.tenantId, input.userId, input.status) }),
    ),
    defineCapability(
      { id: "user.goals.stalled", version: "1.0.0", description: "List active user goals with no recorded progress in the given window.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200), days: z.number().int().min(1).max(365).optional() }),
      async (input, ctx) => ({ goals: await service.stalledGoals(ctx.tenantId, input.userId, input.days ?? 14) }),
    ),
    defineCapability(
      { id: "user.signal.record", version: "1.0.0", description: "Record a behavioural signal (activity, idle, message, commit, research, error, break) for state estimation.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ userId: z.string().min(1).max(200), kind: z.enum(["activity", "idle", "message", "commit", "research", "error", "break"]), intensity: unit, at: z.string().datetime().optional(), note: z.string().max(1000).optional() }),
      async (input, ctx) => await service.recordSignal({ tenantId: ctx.tenantId, userId: input.userId, kind: input.kind, intensity: input.intensity, ...(input.at ? { at: input.at } : {}), ...(input.note ? { note: input.note } : {}) }),
    ),
    defineCapability(
      { id: "user.state.estimate", version: "1.0.0", description: "Estimate the user's current state with explicit confidence and uncertainty. The result is an estimate, never ground truth.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200) }),
      async (input, ctx) => await service.estimateState(ctx.tenantId, input.userId),
    ),
    defineCapability(
      { id: "user.frustration.assess", version: "1.0.0", description: "Assess frustration risk from repeated errors and stalled goals, with an intervention recommendation.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200) }),
      async (input, ctx) => await service.frustrationRisk(ctx.tenantId, input.userId),
    ),
    defineCapability(
      { id: "user.milestone.add", version: "1.0.0", description: "Add a relationship-memory milestone to the personal growth timeline.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ userId: z.string().min(1).max(200), kind: z.enum(["decision", "success", "failure", "turning-point", "start"]), title: z.string().min(1).max(300), summary: z.string().min(1).max(10_000), importance: unit.optional(), occurredAt: z.string().datetime().optional() }),
      async (input, ctx) => await service.addMilestone({
        tenantId: ctx.tenantId, userId: input.userId, kind: input.kind, title: input.title, summary: input.summary,
        ...(input.importance !== undefined ? { importance: input.importance } : {}), ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      }),
    ),
    defineCapability(
      { id: "user.timeline", version: "1.0.0", description: "Read the user's growth timeline and relationship memory.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200) }),
      async (input, ctx) => ({ milestones: await service.timeline(ctx.tenantId, input.userId) }),
    ),
    defineCapability(
      { id: "user.advice.record", version: "1.0.0", description: "Record advice Aurora gave so its effectiveness can be measured later.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ userId: z.string().min(1).max(200), summary: z.string().min(1).max(10_000), initiativeId: z.string().optional(), taskRef: z.string().optional(), claimRefs: z.array(z.string()).max(100).optional() }),
      async (input, ctx) => await service.recordAdvice({ tenantId: ctx.tenantId, userId: input.userId, summary: input.summary, ...(input.initiativeId ? { initiativeId: input.initiativeId } : {}), ...(input.taskRef ? { taskRef: input.taskRef } : {}), ...(input.claimRefs ? { claimRefs: input.claimRefs } : {}) }),
    ),
    defineCapability(
      { id: "user.advice.outcome", version: "1.0.0", description: "Record whether advice was followed and whether it helped.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ adviceId: z.string(), followed: z.boolean(), helpful: z.boolean(), note: z.string().max(2000).optional() }),
      async (input, ctx) => await service.recordAdviceOutcome({ tenantId: ctx.tenantId, adviceId: input.adviceId, followed: input.followed, helpful: input.helpful, ...(input.note ? { note: input.note } : {}) }),
    ),
    defineCapability(
      { id: "user.alignment.check", version: "1.0.0", description: "Guardian alignment check: does a proposed action serve the user's own active goals?", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200), proposal: z.string().min(1).max(10_000) }),
      async (input, ctx) => await service.alignmentCheck(ctx.tenantId, input.userId, input.proposal),
    ),
    defineCapability(
      { id: "user.model.summary", version: "1.0.0", description: "Full inspectable projection of the user model: claims by category, goals, projects, trust, advice effectiveness and load.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200) }),
      async (input, ctx) => await service.summary(ctx.tenantId, input.userId),
    ),
    defineCapability(
      { id: "user.goals.conflicts", version: "1.0.0", description: "List goal conflicts: declared conflicts, dependency cycles and short-horizon overcommit.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200), overcommitThreshold: z.number().int().min(2).max(50).optional() }),
      async (input, ctx) => ({ conflicts: await service.goalConflicts(ctx.tenantId, input.userId, input.overcommitThreshold ?? 8) }),
    ),
    defineCapability(
      { id: "user.goals.blocked", version: "1.0.0", description: "List active goals blocked by dependencies that are not achieved yet.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200) }),
      async (input, ctx) => ({ blocked: await service.blockedGoals(ctx.tenantId, input.userId) }),
    ),
    defineCapability(
      { id: "user.project.upsert", version: "1.0.0", description: "Create or update the user's project model: repo/workspace links, active tasks, deadline, architecture notes, next actions, failures and expertise context.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({
        userId: z.string().min(1).max(200), projectId: z.string().optional(), name: z.string().min(1).max(200),
        repoUrl: z.string().max(500).optional(), workspacePath: z.string().max(2000).optional(),
        status: z.enum(["active", "paused", "archived"]).optional(), activeTasks: z.number().int().min(0).max(100_000).optional(),
        deadline: z.string().datetime().optional(), architectureNotes: z.string().max(50_000).optional(),
        expertise: z.array(z.string().min(1).max(100)).max(50).optional(),
        addNextAction: z.string().min(1).max(500).optional(), completeNextActionId: z.string().optional(), recordFailure: z.string().min(1).max(2000).optional(),
      }),
      async (input, ctx) => await service.upsertProject({
        tenantId: ctx.tenantId, userId: input.userId,
        ...(input.projectId ? { projectId: input.projectId } : {}), name: input.name,
        ...(input.repoUrl !== undefined ? { repoUrl: input.repoUrl } : {}),
        ...(input.workspacePath !== undefined ? { workspacePath: input.workspacePath } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.activeTasks !== undefined ? { activeTasks: input.activeTasks } : {}),
        ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
        ...(input.architectureNotes !== undefined ? { architectureNotes: input.architectureNotes } : {}),
        ...(input.expertise ? { expertise: input.expertise } : {}),
        ...(input.addNextAction ? { addNextAction: input.addNextAction } : {}),
        ...(input.completeNextActionId ? { completeNextActionId: input.completeNextActionId } : {}),
        ...(input.recordFailure ? { recordFailure: input.recordFailure } : {}),
      }),
    ),
    defineCapability(
      { id: "user.projects.list", version: "1.0.0", description: "List the user's project models with deadlines and status.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200), status: z.enum(["active", "paused", "archived"]).optional() }),
      async (input, ctx) => ({ projects: await service.projects(ctx.tenantId, input.userId, input.status) }),
    ),
    defineCapability(
      { id: "user.project.overview", version: "1.0.0", description: "One project in depth: deadline overdue check, pending next actions and failures in the last 7 days.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200), projectId: z.string().min(1) }),
      async (input, ctx) => await service.projectOverview(ctx.tenantId, input.userId, input.projectId),
    ),
    defineCapability(
      { id: "user.advice.policy", version: "1.0.0", description: "How often Aurora should advise this user right now, derived from measured advice effectiveness.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200) }),
      async (input, ctx) => await service.advicePolicy(ctx.tenantId, input.userId),
    ),
    defineCapability(
      { id: "user.privacy.set", version: "1.0.0", description: "Per-feature privacy switches (inference, signals, advice-tracking, research-memory, state-estimation) and the retention period in days.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({
        userId: z.string().min(1).max(200),
        feature: z.enum(["inference", "signals", "advice-tracking", "research-memory", "state-estimation"]).optional(),
        enabled: z.boolean().optional(),
        retentionDays: z.number().int().min(1).max(3650).optional(),
      }),
      async (input, ctx) => {
        if (input.feature && input.enabled !== undefined) {
          await service.setFeatureConsent(ctx.tenantId, input.userId, input.feature, input.enabled);
        }
        if (input.retentionDays !== undefined) {
          await service.setRetention(ctx.tenantId, input.userId, input.retentionDays);
        }
        return await service.featureConsents(ctx.tenantId, input.userId);
      },
    ),
    defineCapability(
      { id: "user.privacy.get", version: "1.0.0", description: "Read the current per-feature privacy switches and retention period.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200) }),
      async (input, ctx) => await service.featureConsents(ctx.tenantId, input.userId),
    ),
    defineCapability(
      { id: "user.privacy.apply-retention", version: "1.0.0", description: "Enforce the retention period now: delete aged inferred claims and telemetry; user-stated claims are kept and counted.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ userId: z.string().min(1).max(200) }),
      async (input, ctx) => await service.applyRetention(ctx.tenantId, input.userId),
    ),
    defineCapability(
      { id: "user.model.export", version: "1.0.0", description: "Export everything Aurora holds about one user as machine-readable JSON.", risk: "privileged", sideEffect: false, source: "core" },
      z.object({ userId: z.string().min(1).max(200) }),
      async (input, ctx) => await service.exportUser(ctx.tenantId, input.userId),
    ),
  ];
}
