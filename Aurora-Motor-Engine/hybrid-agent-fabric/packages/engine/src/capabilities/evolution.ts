import { z } from "zod";
import type { SkillEvolutionService } from "../evolution/skill-evolution-service.js";
import { defineCapability } from "./schema.js";

const unit = z.number().min(0).max(1);
const stage = z.enum(["blueprint", "sandbox", "test", "beta", "production", "archived"]);

/**
 * Aurora Phase F capabilities: capability-gap detection, staged skill evolution with evidence gates,
 * composition, retirement, workflow evolution and the cognitive evolution index.
 */
export function evolutionCapabilities(service: SkillEvolutionService) {
  return [
    defineCapability(
      { id: "evolution.gap.observe", version: "1.0.0", description: "Record a capability gap, repeated friction, bottleneck or error pattern. Identical signatures increment instead of duplicating.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ kind: z.enum(["capability-gap", "friction", "bottleneck", "error-pattern"]), description: z.string().min(1).max(5000), context: z.string().max(20_000).optional(), severity: unit.optional(), evidenceRefs: z.array(z.string()).max(200).optional() }),
      async (input, ctx) => await service.observeGap({
        tenantId: ctx.tenantId, kind: input.kind, description: input.description,
        ...(input.context ? { context: input.context } : {}), ...(input.severity !== undefined ? { severity: input.severity } : {}),
        ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
      }),
    ),
    defineCapability(
      { id: "evolution.gaps.list", version: "1.0.0", description: "List detected capability gaps ranked by severity and recurrence.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ status: z.enum(["open", "candidate-created", "resolved", "dismissed"]).optional() }),
      async (input, ctx) => ({ gaps: await service.gaps(ctx.tenantId, input.status) }),
    ),
    defineCapability(
      { id: "evolution.blueprint.create", version: "1.0.0", description: "Design a skill blueprint (purpose, inputs, outputs, tools, risks, tests). Blueprints are inert designs, never executable skills.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ name: z.string().min(1).max(200), purpose: z.string().min(1).max(10_000), gapId: z.string().optional(), inputs: z.array(z.string()).max(50).optional(), outputs: z.array(z.string()).max(50).optional(), tools: z.array(z.string()).max(50).optional(), risks: z.array(z.string()).max(50).optional(), tests: z.array(z.string()).max(50).optional(), compositeOfIds: z.array(z.string()).max(20).optional() }),
      async (input, ctx) => await service.createBlueprint({
        tenantId: ctx.tenantId, name: input.name, purpose: input.purpose,
        ...(input.gapId ? { gapId: input.gapId } : {}), ...(input.inputs ? { inputs: input.inputs } : {}), ...(input.outputs ? { outputs: input.outputs } : {}),
        ...(input.tools ? { tools: input.tools } : {}), ...(input.risks ? { risks: input.risks } : {}), ...(input.tests ? { tests: input.tests } : {}),
        ...(input.compositeOfIds ? { compositeOfIds: input.compositeOfIds } : {}),
      }),
    ),
    defineCapability(
      { id: "evolution.evaluation.record", version: "1.0.0", description: "Record a sandbox/test/beta evaluation; accuracy, speed and safety scores are recomputed from evidence.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ candidateId: z.string(), suite: z.string().min(1).max(200), passed: z.number().int().min(0), failed: z.number().int().min(0), safetyFindings: z.number().int().min(0).max(10_000).optional(), averageLatencyMs: z.number().int().min(0).optional(), utility: unit.optional(), notes: z.string().max(5000).optional() }),
      async (input, ctx) => await service.recordEvaluation({
        tenantId: ctx.tenantId, candidateId: input.candidateId, suite: input.suite, passed: input.passed, failed: input.failed,
        ...(input.safetyFindings !== undefined ? { safetyFindings: input.safetyFindings } : {}), ...(input.averageLatencyMs !== undefined ? { averageLatencyMs: input.averageLatencyMs } : {}),
        ...(input.utility !== undefined ? { utility: input.utility } : {}), ...(input.notes ? { notes: input.notes } : {}),
      }),
    ),
    defineCapability(
      { id: "evolution.usage.record", version: "1.0.0", description: "Record a beta/production invocation outcome so reliability and speed reflect reality.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ candidateId: z.string(), success: z.boolean(), durationMs: z.number().int().min(0) }),
      async (input, ctx) => await service.recordUsage({ tenantId: ctx.tenantId, ...input }),
    ),
    defineCapability(
      { id: "evolution.regression.baseline", version: "1.0.0", description: "Record a regression baseline pass rate for a suite.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ candidateId: z.string(), suite: z.string().min(1).max(200), passRate: unit }),
      async (input, ctx) => await service.recordRegressionBaseline(ctx.tenantId, input.candidateId, input.suite, input.passRate),
    ),
    defineCapability(
      { id: "evolution.regression.check", version: "1.0.0", description: "Regression protection: verify a new build does not lose ground against any recorded baseline.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ candidateId: z.string(), results: z.array(z.object({ suite: z.string().min(1).max(200), passRate: unit })).max(200) }),
      async (input, ctx) => await service.checkRegression(ctx.tenantId, input.candidateId, input.results),
    ),
    defineCapability(
      { id: "evolution.stage.advance", version: "1.0.0", description: "Advance one evolution stage (blueprint -> sandbox -> test -> beta -> production). Every gate is evidence-based and production requires an explicit approval.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ candidateId: z.string(), to: stage, actor: z.string().min(1).max(200), reason: z.string().min(1).max(2000), approval: z.object({ actor: z.string().min(1).max(200), reason: z.string().min(1).max(2000) }).optional() }),
      async (input, ctx) => await service.advanceStage({
        tenantId: ctx.tenantId, candidateId: input.candidateId, to: input.to, actor: input.actor, reason: input.reason,
        ...(input.approval ? { approval: input.approval } : {}),
      }),
    ),
    defineCapability(
      { id: "evolution.stage.readiness", version: "1.0.0", description: "Explain exactly what a candidate still needs before its next stage gate opens.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ candidateId: z.string() }),
      async (input, ctx) => await service.stageReadiness(ctx.tenantId, input.candidateId),
    ),
    defineCapability(
      { id: "evolution.candidates.list", version: "1.0.0", description: "List skill candidates with multidimensional scores and usage statistics.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ stage: stage.optional() }),
      async (input, ctx) => ({ candidates: await service.candidates(ctx.tenantId, input.stage) }),
    ),
    defineCapability(
      { id: "evolution.composition.graph", version: "1.0.0", description: "Read the skill composition graph: members and dependents per skill.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => ({ nodes: await service.compositionGraph(ctx.tenantId) }),
    ),
    defineCapability(
      { id: "evolution.retire", version: "1.0.0", description: "Retire a skill with a reason. Skills used by active composites cannot be retired.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ candidateId: z.string(), reason: z.string().min(1).max(2000) }),
      async (input, ctx) => await service.retire({ tenantId: ctx.tenantId, ...input }),
    ),
    defineCapability(
      { id: "evolution.retirement.sweep", version: "1.0.0", description: "Apply the retirement policy to unused or low-value skills.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ maxIdleDays: z.number().int().min(1).max(3650).optional(), minComposite: unit.optional() }),
      async (input, ctx) => ({ retired: await service.sweepRetirement(ctx.tenantId, { ...(input.maxIdleDays !== undefined ? { maxIdleDays: input.maxIdleDays } : {}), ...(input.minComposite !== undefined ? { minComposite: input.minComposite } : {}) }) }),
    ),
    defineCapability(
      { id: "evolution.workflow.record", version: "1.0.0", description: "Record a workflow version with its steps, duration, success rate and rationale.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ name: z.string().min(1).max(200), steps: z.array(z.string()).min(1).max(100), averageDurationMs: z.number().int().min(0), successRate: unit, rationale: z.string().min(1).max(5000), bottleneckStep: z.string().max(300).optional() }),
      async (input, ctx) => await service.recordWorkflowVersion({
        tenantId: ctx.tenantId, name: input.name, steps: input.steps, averageDurationMs: input.averageDurationMs, successRate: input.successRate, rationale: input.rationale,
        ...(input.bottleneckStep ? { bottleneckStep: input.bottleneckStep } : {}),
      }),
    ),
    defineCapability(
      { id: "evolution.workflow.bottlenecks", version: "1.0.0", description: "Cognitive bottleneck detection across workflow versions with recommendations.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => ({ workflows: await service.workflowBottlenecks(ctx.tenantId) }),
    ),
    defineCapability(
      { id: "evolution.journal", version: "1.0.0", description: "Read the evolution journal: gaps, stage changes, evaluations, regressions and retirements.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ limit: z.number().int().min(1).max(2000).optional() }),
      async (input, ctx) => ({ entries: await service.journalEntries(ctx.tenantId, input.limit ?? 200) }),
    ),
    defineCapability(
      { id: "evolution.index", version: "1.0.0", description: "Cognitive Evolution Index: capability growth, quality, success rate, gap closure and workflow improvement.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.evolutionIndex(ctx.tenantId),
    ),
  ];
}
