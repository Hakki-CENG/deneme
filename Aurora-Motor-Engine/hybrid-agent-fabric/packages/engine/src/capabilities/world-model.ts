import { z } from "zod";
import type { MultiWorldModelService } from "../world/multi-world-model-service.js";
import type { WorldModelService } from "../world/world-model-service.js";
import { defineCapability } from "./schema.js";

const unit = z.number().min(0).max(1);
const scope = z.enum(["personal", "environment", "digital", "project", "human", "goal", "general"]);
const entityType = z.enum(["person", "place", "project", "file", "task", "tool", "website", "model", "organization", "document", "device", "service", "concept", "goal"]);
const sourceType = z.enum(["user", "agent", "event", "memory", "system", "external"]);
const claimType = z.enum(["observation", "inference", "hypothesis", "prediction"]);
const problemType = z.enum(["technical", "economic", "security", "strategic", "creative", "user", "research", "operational", "general"]);

/** Aurora Phase D capabilities: world representation, causality, prediction calibration and simulation. */
export function worldModelCapabilities(service: WorldModelService) {
  return [
    defineCapability(
      { id: "world.entity.upsert", version: "1.0.0", description: "Create or update a world entity with type, scope, attributes and confidence.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ type: entityType, name: z.string().min(1).max(300), scope: scope.optional(), attributes: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), confidence: unit.optional(), importance: unit.optional(), tags: z.array(z.string()).max(100).optional() }),
      async (input, context) => await service.upsertEntity({
        tenantId: context.tenantId, type: input.type, name: input.name,
        ...(input.scope ? { scope: input.scope } : {}), ...(input.attributes ? { attributes: input.attributes } : {}),
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}), ...(input.importance !== undefined ? { importance: input.importance } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
      }),
    ),
    defineCapability(
      { id: "world.entities.list", version: "1.0.0", description: "List world entities, optionally filtered by scope or type.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ scope: scope.optional(), type: entityType.optional() }),
      async (input, context) => ({ entities: await service.entities(context.tenantId, { ...(input.scope ? { scope: input.scope } : {}), ...(input.type ? { type: input.type } : {}) }) }),
    ),
    defineCapability(
      { id: "world.state.record", version: "1.0.0", description: "Record a temporal state fact for an entity. A new value closes the previous validity window instead of overwriting history.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ entityId: z.string(), key: z.string().min(1).max(200), value: z.string().min(1).max(5000), claimType: claimType.optional(), sourceType, sourceId: z.string().max(300).optional(), confidence: unit, observedAt: z.string().datetime().optional(), validTo: z.string().datetime().optional(), evidenceRefs: z.array(z.string()).max(200).optional() }),
      async (input, context) => await service.recordState({
        tenantId: context.tenantId, entityId: input.entityId, key: input.key, value: input.value, sourceType: input.sourceType, confidence: input.confidence,
        ...(input.claimType ? { claimType: input.claimType } : {}), ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        ...(input.observedAt ? { observedAt: input.observedAt } : {}), ...(input.validTo ? { validTo: input.validTo } : {}),
        ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
      }),
    ),
    defineCapability(
      { id: "world.state.at", version: "1.0.0", description: "Read the believed state of an entity at a point in time.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ entityId: z.string(), at: z.string().datetime().optional() }),
      async (input, context) => ({ state: await service.stateAt(context.tenantId, input.entityId, input.at) }),
    ),
    defineCapability(
      { id: "world.temporal.view", version: "1.0.0", description: "Past, present and future view of one entity, including open predictions.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ entityId: z.string() }),
      async (input, context) => await service.temporalView(context.tenantId, input.entityId),
    ),
    defineCapability(
      { id: "world.relation.upsert", version: "1.0.0", description: "Create or strengthen a relation between two world entities.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ fromEntityId: z.string(), toEntityId: z.string(), type: z.string().min(1).max(100), strength: unit.optional(), confidence: unit.optional(), validTo: z.string().datetime().optional() }),
      async (input, context) => await service.relate({
        tenantId: context.tenantId, fromEntityId: input.fromEntityId, toEntityId: input.toEntityId, type: input.type,
        ...(input.strength !== undefined ? { strength: input.strength } : {}), ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(input.validTo ? { validTo: input.validTo } : {}),
      }),
    ),
    defineCapability(
      { id: "world.event.record", version: "1.0.0", description: "Record a world event with participants, confidence, importance and user relevance.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ entityIds: z.array(z.string()).max(50).optional(), summary: z.string().min(1).max(1000), detail: z.string().max(20_000).optional(), occurredAt: z.string().datetime().optional(), sourceType, sourceId: z.string().max(300).optional(), confidence: unit, importance: unit.optional(), userRelevance: unit.optional(), tags: z.array(z.string()).max(100).optional() }),
      async (input, context) => await service.recordEvent({
        tenantId: context.tenantId, summary: input.summary, sourceType: input.sourceType, confidence: input.confidence,
        ...(input.entityIds ? { entityIds: input.entityIds } : {}), ...(input.detail ? { detail: input.detail } : {}),
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}), ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        ...(input.importance !== undefined ? { importance: input.importance } : {}), ...(input.userRelevance !== undefined ? { userRelevance: input.userRelevance } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
      }),
    ),
    defineCapability(
      { id: "world.causality.assert", version: "1.0.0", description: "Assert a cause -> effect link between two recorded events or states.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ causeKind: z.enum(["event", "state"]), causeRef: z.string(), effectKind: z.enum(["event", "state"]), effectRef: z.string(), description: z.string().min(1).max(2000), strength: unit.optional(), confidence: unit.optional(), evidenceRefs: z.array(z.string()).max(200).optional() }),
      async (input, context) => await service.assertCausality({
        tenantId: context.tenantId, causeKind: input.causeKind, causeRef: input.causeRef, effectKind: input.effectKind, effectRef: input.effectRef, description: input.description,
        ...(input.strength !== undefined ? { strength: input.strength } : {}), ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
      }),
    ),
    defineCapability(
      { id: "world.causality.observe", version: "1.0.0", description: "Confirm or refute a causal link from reality; confidence is recomputed from the evidence ledger.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ linkId: z.string(), confirmed: z.boolean(), evidenceRefs: z.array(z.string()).max(200).optional() }),
      async (input, context) => await service.recordCausalObservation(context.tenantId, input.linkId, input.confirmed, input.evidenceRefs),
    ),
    defineCapability(
      { id: "world.prediction.create", version: "1.0.0", description: "Register a falsifiable prediction with an explicit probability and horizon.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ statement: z.string().min(1).max(2000), probability: unit, horizonAt: z.string().datetime(), entityId: z.string().optional(), basisLinkIds: z.array(z.string()).max(100).optional(), basisStateIds: z.array(z.string()).max(100).optional() }),
      async (input, context) => await service.predict({
        tenantId: context.tenantId, statement: input.statement, probability: input.probability, horizonAt: input.horizonAt,
        ...(input.entityId ? { entityId: input.entityId } : {}), ...(input.basisLinkIds ? { basisLinkIds: input.basisLinkIds } : {}), ...(input.basisStateIds ? { basisStateIds: input.basisStateIds } : {}),
      }),
    ),
    defineCapability(
      { id: "world.prediction.resolve", version: "1.0.0", description: "Resolve a prediction against reality, score it with Brier loss and update its causal basis.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ predictionId: z.string(), outcome: z.boolean(), note: z.string().max(2000).optional() }),
      async (input, context) => await service.resolvePrediction(context.tenantId, input.predictionId, input.outcome, input.note),
    ),
    defineCapability(
      { id: "world.calibration.report", version: "1.0.0", description: "Prediction calibration: accuracy, mean Brier score and probability buckets.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, context) => await service.calibration(context.tenantId),
    ),
    defineCapability(
      { id: "world.consistency.check", version: "1.0.0", description: "World consistency engine: conflicting current values for the same entity key.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, context) => ({ inconsistencies: await service.inconsistencies(context.tenantId) }),
    ),
    defineCapability(
      { id: "world.simulate", version: "1.0.0", description: "Bounded forward simulation or counterfactual branch over causal links; writes nothing to the world model.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ premise: z.string().min(1).max(2000), startKind: z.enum(["event", "state"]), startRef: z.string(), depth: z.number().int().min(1).max(8).optional(), mode: z.enum(["simulation", "counterfactual"]).optional() }),
      async (input, context) => await service.simulate({
        tenantId: context.tenantId, premise: input.premise, startKind: input.startKind, startRef: input.startRef,
        ...(input.depth !== undefined ? { depth: input.depth } : {}), ...(input.mode ? { mode: input.mode } : {}),
      }),
    ),
    defineCapability(
      { id: "world.scope.view", version: "1.0.0", description: "Read one sub-world model: personal, environment, digital, project, human or goal.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ scope }),
      async (input, context) => await service.scopeView(context.tenantId, input.scope),
    ),
    defineCapability(
      { id: "world.reassess", version: "1.0.0", description: "Re-evaluate old assumptions about an entity after new observations.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ entityId: z.string() }),
      async (input, context) => await service.reassess(context.tenantId, input.entityId),
    ),
  ];
}

/** Aurora Phase D capabilities: multi-perspective deliberation, scenarios and reality alignment. */
export function multiWorldCapabilities(service: MultiWorldModelService) {
  return [
    defineCapability(
      { id: "multiworld.perspectives.list", version: "1.0.0", description: "List the twelve built-in world-model perspectives with weights and prediction reputation.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, context) => ({ perspectives: await service.perspectives(context.tenantId) }),
    ),
    defineCapability(
      { id: "multiworld.analysis.create", version: "1.0.0", description: "Open a multi-perspective analysis; the meta world model weights perspectives by problem type and reputation.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ question: z.string().min(1).max(10_000), context: z.string().max(50_000).optional(), problemType: problemType.optional(), perspectiveIds: z.array(z.string()).max(50).optional() }),
      async (input, ctx) => await service.createAnalysis({
        tenantId: ctx.tenantId, question: input.question,
        ...(input.context ? { context: input.context } : {}), ...(input.problemType ? { problemType: input.problemType } : {}),
        ...(input.perspectiveIds ? { perspectiveIds: input.perspectiveIds } : {}),
      }),
    ),
    defineCapability(
      { id: "multiworld.view.submit", version: "1.0.0", description: "Submit one perspective's stance, confidence, rationale, risks and opportunities.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ analysisId: z.string(), perspectiveId: z.string(), stance: z.enum(["support", "oppose", "neutral"]), confidence: unit, rationale: z.string().min(1).max(20_000), keyRisks: z.array(z.string()).max(20).optional(), keyOpportunities: z.array(z.string()).max(20).optional(), evidenceRefs: z.array(z.string()).max(200).optional() }),
      async (input, ctx) => await service.submitView({
        tenantId: ctx.tenantId, analysisId: input.analysisId, perspectiveId: input.perspectiveId, stance: input.stance, confidence: input.confidence, rationale: input.rationale,
        ...(input.keyRisks ? { keyRisks: input.keyRisks } : {}), ...(input.keyOpportunities ? { keyOpportunities: input.keyOpportunities } : {}), ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
      }),
    ),
    defineCapability(
      { id: "multiworld.debate.challenge", version: "1.0.0", description: "One perspective formally challenges another; unresolved conflicts block a clean consensus.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ analysisId: z.string(), fromPerspectiveId: z.string(), targetPerspectiveId: z.string(), argument: z.string().min(1).max(10_000) }),
      async (input, ctx) => await service.challenge({ tenantId: ctx.tenantId, ...input }),
    ),
    defineCapability(
      { id: "multiworld.debate.resolve-conflict", version: "1.0.0", description: "Record how a perspective conflict was settled.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ analysisId: z.string(), conflictId: z.string(), resolution: z.string().min(1).max(10_000) }),
      async (input, ctx) => await service.resolveConflict(ctx.tenantId, input.analysisId, input.conflictId, input.resolution),
    ),
    defineCapability(
      { id: "multiworld.scenario.add", version: "1.1.0", description: "Add a scenario branch with a probability and optional cost/benefit estimates; sibling probabilities may not exceed 1.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ analysisId: z.string(), name: z.string().min(1).max(200), description: z.string().min(1).max(20_000), probability: unit, parentScenarioId: z.string().optional(), endorsingPerspectiveIds: z.array(z.string()).max(50).optional(), indicators: z.array(z.string()).max(20).optional(), cost: unit.optional(), benefit: unit.optional() }),
      async (input, ctx) => await service.addScenario({
        tenantId: ctx.tenantId, analysisId: input.analysisId, name: input.name, description: input.description, probability: input.probability,
        ...(input.parentScenarioId ? { parentScenarioId: input.parentScenarioId } : {}), ...(input.endorsingPerspectiveIds ? { endorsingPerspectiveIds: input.endorsingPerspectiveIds } : {}),
        ...(input.indicators ? { indicators: input.indicators } : {}),
        ...(input.cost !== undefined ? { cost: input.cost } : {}), ...(input.benefit !== undefined ? { benefit: input.benefit } : {}),
      }),
    ),
    defineCapability(
      { id: "multiworld.future.tree", version: "1.1.0", description: "Read the future tree with cumulative branch probabilities, per-branch expected value where measured, and the aggregate outlook (root EV, risk mass, unmeasured count).", risk: "pure", sideEffect: false, source: "core" },
      z.object({ analysisId: z.string() }),
      async (input, ctx) => ({ branches: await service.futureTree(ctx.tenantId, input.analysisId), outlook: await service.futureTreeOutlook(ctx.tenantId, input.analysisId) }),
    ),
    defineCapability(
      { id: "multiworld.scenario.outcome", version: "1.0.0", description: "Reality alignment: record whether a scenario happened and update endorsing perspectives' reputation.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ analysisId: z.string(), scenarioId: z.string(), occurred: z.boolean() }),
      async (input, ctx) => await service.recordScenarioOutcome({ tenantId: ctx.tenantId, ...input }),
    ),
    defineCapability(
      { id: "multiworld.analysis.resolve", version: "1.0.0", description: "Compute weighted consensus while preserving dissent, missing perspectives, open conflicts and uncertainty.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ analysisId: z.string(), minimumViews: z.number().int().min(2).max(50).optional() }),
      async (input, ctx) => await service.resolveAnalysis(ctx.tenantId, input.analysisId, input.minimumViews === undefined ? {} : { minimumViews: input.minimumViews }),
    ),
    defineCapability(
      { id: "multiworld.analyses.list", version: "1.0.0", description: "List multi-world analyses with their consensus results.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ status: z.enum(["open", "resolved"]).optional() }),
      async (input, ctx) => ({ analyses: await service.analyses(ctx.tenantId, input.status) }),
    ),
  ];
}
