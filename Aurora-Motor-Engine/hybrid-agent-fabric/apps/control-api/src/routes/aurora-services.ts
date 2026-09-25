/**
 * New Aurora Services Routes (Phase3-5)
 * Multi-Hypothesis, Internal Critic, Experiment Engine, Planner V2,
 * Agent Economy, Reputation, Resource Intelligence, Shared Learning,
 * Dynamic Composition, Capability Marketplace, Swarm Orchestration,
 * Benchmark Lab, Adaptive Router, Goal Stack, Attention V2,
 * Self-Debugging, Causal Graph, Long-Horizon Memory, Neural Core,
 * Learned World Model
 */
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import type { HybridAgentEngine } from "@haf/engine";


/** Tenant validation — ensures operator can only access their own tenant */
function validateTenant(requestedTenantId: string, requestTenantId?: string): string {
  // If no request tenant context, use requested (development mode)
  if (!requestTenantId) return requestedTenantId;
  // If mismatch, throw 403
  if (requestedTenantId !== requestTenantId) {
    throw new Error("FORBIDDEN: Cannot access another tenant's resources");
  }
  return requestedTenantId;
}

// Pagination helper
function paginate<T>(items: T[], page: number = 1, pageSize: number = 20): { data: T[]; pagination: { page: number; pageSize: number; total: number; totalPages: number; hasNext: boolean; hasPrev: boolean } } {
  const total = items.length;
  const totalPages = Math.ceil(total / pageSize);
  const p = Math.max(1, Math.min(page, totalPages || 1));
  const start = (p - 1) * pageSize;
  const data = items.slice(start, start + pageSize);
  return { data, pagination: { page: p, pageSize, total, totalPages, hasNext: p < totalPages, hasPrev: p > 1 } };
}

export function registerAuroraServiceRoutes(app: FastifyInstance, engine: HybridAgentEngine, z: typeof import("zod").z, auroraTenant: z.ZodObject<any>) {

  // ═══ Phase3: Multi-Hypothesis Reasoning ═══
  app.get("/v1/multi-hypothesis", async (request) => { const q = z.object({ tenantId: z.string().default("local"), page: z.coerce.number().default(1), pageSize: z.coerce.number().default(20) }).parse(request.query); const items = await engine.multiHypothesis.getHypotheses(q.tenantId); return paginate(items, q.page, q.pageSize); });
  app.post("/v1/multi-hypothesis", async (request) => { const b = z.object({ tenantId: z.string().default("local"), statement: z.string(), domain: z.string(), assumptions: z.array(z.string()).optional(), implications: z.array(z.string()).optional() }).parse(request.body); return await engine.multiHypothesis.proposeHypothesis(b.tenantId, b.statement, b.domain, b.assumptions, b.implications); });
  app.post("/v1/multi-hypothesis/:id/evidence", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const b = z.object({ source: z.string(), description: z.string(), supports: z.boolean(), strength: z.enum(["weak","moderate","strong","conclusive"]) }).parse(request.body); return await engine.multiHypothesis.addEvidence(id, b.source, b.description, b.supports, b.strength); });
  app.post("/v1/multi-hypothesis/reason", async (request) => { const b = z.object({ tenantId: z.string().default("local"), question: z.string(), candidateIds: z.array(z.string()) }).parse(request.body); return await engine.multiHypothesis.reason(b.tenantId, b.question, b.candidateIds); });
  app.get("/v1/multi-hypothesis/chains", async (request) => { const q = auroraTenant.parse(request.query); return { chains: await engine.multiHypothesis.getReasoningChains(q.tenantId) }; });
  app.get("/v1/multi-hypothesis/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.multiHypothesis.getStats(q.tenantId); });

  // ═══ Phase3: Internal Critic ═══
  app.get("/v1/critic/reviews", async (request) => { const q = auroraTenant.parse(request.query); return { reviews: await engine.internalCritic.getReviews(q.tenantId) }; });
  app.post("/v1/critic/review", async (request) => { const b = z.object({ tenantId: z.string().default("local"), targetId: z.string(), targetType: z.string(), content: z.string(), context: z.string().optional() }).parse(request.body); return await engine.internalCritic.review(b.tenantId, b.targetId, b.targetType, b.content, b.context); });
  app.post("/v1/critic/resolve", async (request) => { const b = z.object({ reviewId: z.string(), critiqueId: z.string(), resolvedBy: z.string() }).parse(request.body); await engine.internalCritic.resolveCritique(b.reviewId, b.critiqueId, b.resolvedBy); return { ok: true }; });
  app.get("/v1/critic/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.internalCritic.getStats(q.tenantId); });

  // ═══ Phase3: Experiment Engine ═══
  app.get("/v1/experiments", async (request) => { const q = auroraTenant.parse(request.query); return { experiments: await engine.experimentEngine.getExperiments(q.tenantId) }; });
  app.post("/v1/experiments", async (request) => { const b = z.object({ tenantId: z.string().default("local"), name: z.string(), hypothesis: z.string(), methodology: z.string(), variables: z.array(z.object({ name: z.string(), type: z.enum(["independent","dependent","controlled"]), value: z.string() })) }).parse(request.body); return await engine.experimentEngine.createExperiment(b.tenantId, b.name, b.hypothesis, b.methodology, b.variables); });
  app.post("/v1/experiments/:id/start", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); await engine.experimentEngine.startExperiment(id); return { ok: true }; });
  app.post("/v1/experiments/:id/result", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const b = z.object({ metric: z.string(), value: z.number(), baseline: z.number() }).parse(request.body); await engine.experimentEngine.recordResult(id, b.metric, b.value, b.baseline); return { ok: true }; });
  app.post("/v1/experiments/:id/complete", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const b = z.object({ conclusion: z.string(), confidence: z.number() }).parse(request.body); await engine.experimentEngine.completeExperiment(id, b.conclusion, b.confidence); return { ok: true }; });
  app.get("/v1/experiments/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.experimentEngine.getStats(q.tenantId); });

  // ═══ Phase3: Planner V2 ═══
  app.get("/v1/planner-v2", async (request) => { const q = auroraTenant.parse(request.query); return { plans: await engine.plannerV2.getPlans(q.tenantId) }; });
  app.post("/v1/planner-v2", async (request) => { const b = z.object({ tenantId: z.string().default("local"), goal: z.string(), strategy: z.string(), steps: z.array(z.object({ name: z.string(), description: z.string(), dependencies: z.array(z.string()), estimatedMs: z.number(), risk: z.enum(["low","medium","high"]) })) }).parse(request.body); return await engine.plannerV2.createPlan(b.tenantId, b.goal, b.strategy, b.steps); });
  app.post("/v1/planner-v2/:id/activate", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); await engine.plannerV2.activatePlan(id); return { ok: true }; });
  app.post("/v1/planner-v2/:id/step", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const b = z.object({ stepId: z.string(), status: z.enum(["pending","in_progress","completed","failed","skipped"]), outputs: z.array(z.string()).optional() }).parse(request.body); await engine.plannerV2.updateStep(id, b.stepId, b.status, b.outputs); return { ok: true }; });
  app.get("/v1/planner-v2/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.plannerV2.getStats(q.tenantId); });

  // ═══ Phase4: Agent Economy ═══
  app.get("/v1/economy/wallets", async (request) => { const q = auroraTenant.parse(request.query); return await engine.agentEconomy.getStats(q.tenantId); });
  app.post("/v1/economy/trade", async (request) => { const b = z.object({ tenantId: z.string().default("local"), fromAgentId: z.string(), toAgentId: z.string(), offer: z.object({ resource: z.string(), amount: z.number() }), request: z.object({ resource: z.string(), amount: z.number() }) }).parse(request.body); return await engine.agentEconomy.offerTrade(b.tenantId, b.fromAgentId, b.toAgentId, b.offer as any, b.request as any); });
  app.post("/v1/economy/trade/:id/accept", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); return { accepted: await engine.agentEconomy.acceptTrade(id) }; });
  app.get("/v1/economy/trades", async (request) => { const q = auroraTenant.parse(request.query); return { trades: await engine.agentEconomy.getTrades(q.tenantId) }; });

  // ═══ Phase4: Reputation ═══
  app.get("/v1/reputation", async (request) => { const q = auroraTenant.parse(request.query); return { entries: await engine.reputation.getEntries(q.tenantId) }; });
  app.post("/v1/reputation/interaction", async (request) => { const b = z.object({ tenantId: z.string().default("local"), agentId: z.string(), success: z.boolean(), domain: z.string(), helpful: z.boolean() }).parse(request.body); await engine.reputation.recordInteraction(b.tenantId, b.agentId, b.success, b.domain, b.helpful); return { ok: true }; });
  app.post("/v1/reputation/endorse", async (request) => { const b = z.object({ fromAgentId: z.string(), tenantId: z.string().default("local"), targetAgentId: z.string(), domain: z.string(), weight: z.number() }).parse(request.body); await engine.reputation.endorse(b.fromAgentId, b.tenantId, b.targetAgentId, b.domain, b.weight); return { ok: true }; });
  app.get("/v1/reputation/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.reputation.getStats(q.tenantId); });

  // ═══ Phase4: Resource Intelligence ═══
  app.get("/v1/resources/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.resourceIntelligence.getStats(q.tenantId); });
  app.post("/v1/resources/allocate", async (request) => { const b = z.object({ tenantId: z.string().default("local"), subsystem: z.string(), resourceType: z.string(), amount: z.number(), priority: z.enum(["critical","high","normal","low","background"]) }).parse(request.body); return await engine.resourceIntelligence.allocate(b.tenantId, b.subsystem, b.resourceType as any, b.amount, b.priority); });
  app.post("/v1/resources/analyze", async (request) => { const b = auroraTenant.parse(request.body ?? {}); return { suggestions: await engine.resourceIntelligence.analyze(b.tenantId) }; });

  // ═══ Phase4: Shared Learning ═══
  app.get("/v1/shared-learning", async (request) => { const q = auroraTenant.parse(request.query); return { lessons: await engine.sharedLearning.getLessons(q.tenantId) }; });
  app.post("/v1/shared-learning", async (request) => { const b = z.object({ tenantId: z.string().default("local"), fromAgentId: z.string(), domain: z.string(), type: z.enum(["pattern","technique","optimization","avoidance","integration"]), title: z.string(), description: z.string(), context: z.string(), tags: z.array(z.string()).optional() }).parse(request.body); return await engine.sharedLearning.shareLesson(b.tenantId, b.fromAgentId, b.domain, b.type, b.title, b.description, b.context, b.tags); });
  app.post("/v1/shared-learning/:id/adopt", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const b = z.object({ agentId: z.string(), result: z.enum(["success","failure","neutral"]), context: z.string() }).parse(request.body); await engine.sharedLearning.adoptLesson(id, b.agentId, b.result, b.context); return { ok: true }; });
  app.get("/v1/shared-learning/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.sharedLearning.getStats(q.tenantId); });

  // ═══ Phase4: Dynamic Composition ═══
  app.get("/v1/composition/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.dynamicComposition.getStats(q.tenantId); });
  app.post("/v1/composition/component", async (request) => { const b = z.object({ name: z.string(), type: z.string(), capabilities: z.array(z.string()), latencyMs: z.number(), reliability: z.number(), cost: z.number() }).parse(request.body); return await engine.dynamicComposition.registerComponent(b.name, b.type, b.capabilities, b.latencyMs, b.reliability, b.cost); });
  app.post("/v1/composition/compose", async (request) => { const b = z.object({ tenantId: z.string().default("local"), goal: z.string(), requiredCapabilities: z.array(z.string()) }).parse(request.body); return await engine.dynamicComposition.compose(b.tenantId, b.goal, b.requiredCapabilities); });

  // ═══ Phase4: Capability Marketplace ═══
  app.get("/v1/marketplace/search", async (request) => { const q = z.object({ tenantId: z.string().default("local"), query: z.string(), category: z.string().optional() }).parse(request.query); return { results: await engine.capabilityMarketplace.searchCapabilities(q.tenantId, q.query, q.category) }; });
  app.post("/v1/marketplace/list", async (request) => { const b = z.object({ tenantId: z.string().default("local"), providerAgentId: z.string(), name: z.string(), description: z.string(), category: z.string(), tags: z.array(z.string()), costPerUse: z.number(), avgLatencyMs: z.number(), reliability: z.number() }).parse(request.body); return await engine.capabilityMarketplace.listCapability(b.tenantId, b.providerAgentId, b.name, b.description, b.category, b.tags, b.costPerUse, b.avgLatencyMs, b.reliability); });
  app.post("/v1/marketplace/request", async (request) => { const b = z.object({ tenantId: z.string().default("local"), requesterAgentId: z.string(), neededCapability: z.string(), context: z.string(), urgency: z.enum(["low","normal","high","critical"]) }).parse(request.body); return await engine.capabilityMarketplace.requestCapability(b.tenantId, b.requesterAgentId, b.neededCapability, b.context, b.urgency); });
  app.get("/v1/marketplace/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.capabilityMarketplace.getStats(q.tenantId); });

  // ═══ Phase4: Swarm Orchestration ═══
  app.get("/v1/swarm", async (request) => { const q = auroraTenant.parse(request.query); return { swarms: await engine.swarmOrchestration.getSwarms(q.tenantId) }; });
  app.post("/v1/swarm", async (request) => { const b = z.object({ tenantId: z.string().default("local"), name: z.string(), strategy: z.enum(["round-robin","capability-match","load-balance","auction"]) }).parse(request.body); return await engine.swarmOrchestration.createSwarm(b.tenantId, b.name, b.strategy); });
  app.post("/v1/swarm/:id/member", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const b = z.object({ agentId: z.string(), role: z.enum(["leader","worker","scout","optimizer","validator"]), capabilities: z.array(z.string()), reliability: z.number() }).parse(request.body); await engine.swarmOrchestration.addMember(id, b.agentId, b.role, b.capabilities, b.reliability); return { ok: true }; });
  app.post("/v1/swarm/:id/task", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const b = z.object({ description: z.string(), priority: z.number(), parallelizable: z.boolean() }).parse(request.body); return await engine.swarmOrchestration.submitTask(id, b.description, b.priority, b.parallelizable); });
  app.get("/v1/swarm/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.swarmOrchestration.getStats(q.tenantId); });

  // ═══ Phase5: Benchmark Lab ═══
  app.get("/v1/benchmarks/runs", async (request) => { const q = z.object({ tenantId: z.string().default("local"), subsystem: z.string().optional() }).parse(request.query); return { runs: await engine.benchmarkLab.getRuns(q.tenantId, q.subsystem) }; });
  app.post("/v1/benchmarks/run", async (request) => { const b = z.object({ tenantId: z.string().default("local"), name: z.string(), subsystem: z.string(), metrics: z.array(z.object({ name: z.string(), value: z.number(), unit: z.string(), baseline: z.number() })), duration: z.number(), iterations: z.number(), environment: z.string() }).parse(request.body); return await engine.benchmarkLab.recordRun(b.tenantId, b.name, b.subsystem, b.metrics, b.duration, b.iterations, b.environment); });
  app.get("/v1/benchmarks/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.benchmarkLab.getStats(q.tenantId); });

  // ═══ Phase5: Adaptive Router ═══
  app.get("/v1/adaptive-router/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.adaptiveRouter.getStats(q.tenantId); });
  app.post("/v1/adaptive-router/route", async (request) => { const b = z.object({ tenantId: z.string().default("local"), requestId: z.string(), pattern: z.string(), availablePaths: z.array(z.object({ path: z.string(), latencyMs: z.number(), cost: z.number(), reliability: z.number() })), strategy: z.enum(["performance","cost","quality","balanced"]) }).parse(request.body); return await engine.adaptiveRouter.route(b.tenantId, b.requestId, b.pattern, b.availablePaths, b.strategy); });

  // ═══ Phase5: Goal Stack ═══
  app.get("/v1/goal-stack/active", async (request) => { const q = z.object({ tenantId: z.string().default("local"), page: z.coerce.number().default(1), pageSize: z.coerce.number().default(20) }).parse(request.query); const items = await engine.goalStack.getActiveGoals(q.tenantId); return paginate(items, q.page, q.pageSize); });
  app.post("/v1/goal-stack", async (request) => { const b = z.object({ tenantId: z.string().default("local"), title: z.string(), description: z.string(), priority: z.enum(["P0","P1","P2","P3","P4"]), successCriteria: z.string(), parentId: z.string().optional(), estimatedEffort: z.number().optional() }).parse(request.body); return await engine.goalStack.addGoal(b.tenantId, b.title, b.description, b.priority, b.successCriteria, b.parentId, b.estimatedEffort); });
  app.post("/v1/goal-stack/:id/progress", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const b = z.object({ progress: z.number(), blockers: z.array(z.string()).optional() }).parse(request.body); await engine.goalStack.updateProgress(id, b.progress, b.blockers); return { ok: true }; });
  app.get("/v1/goal-stack/tree", async (request) => { const q = auroraTenant.parse(request.query); return { tree: await engine.goalStack.getGoalTree(q.tenantId) }; });
  app.get("/v1/goal-stack/metrics", async (request) => { const q = auroraTenant.parse(request.query); return await engine.goalStack.getMetrics(q.tenantId); });

  // ═══ Phase5: Attention V2 ═══
  app.get("/v1/attention-v2/targets", async (request) => { const q = z.object({ tenantId: z.string().default("local"), limit: z.coerce.number().default(10) }).parse(request.query); return { targets: await engine.attentionV2.getTopTargets(q.tenantId, q.limit) }; });
  app.post("/v1/attention-v2/target", async (request) => { const b = z.object({ tenantId: z.string().default("local"), category: z.enum(["task","threat","opportunity","maintenance","social","learning"]), title: z.string(), description: z.string(), urgency: z.number(), importance: z.number(), decayRate: z.number().optional() }).parse(request.body); return await engine.attentionV2.registerTarget(b.tenantId, b.category, b.title, b.description, b.urgency, b.importance, b.decayRate); });
  app.post("/v1/attention-v2/allocate", async (request) => { const b = z.object({ tenantId: z.string().default("local"), budgetMs: z.number() }).parse(request.body); return await engine.attentionV2.allocate(b.tenantId, b.budgetMs); });
  app.get("/v1/attention-v2/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.attentionV2.getStats(q.tenantId); });

  // ═══ Phase5: Self-Debugging ═══
  app.get("/v1/self-debugging/bugs", async (request) => { const q = z.object({ tenantId: z.string().default("local"), page: z.coerce.number().default(1), pageSize: z.coerce.number().default(50) }).parse(request.query); const items = await engine.selfDebugging.getBugs(q.tenantId, 1000); return paginate(items, q.page, q.pageSize); });
  app.post("/v1/self-debugging/bug", async (request) => { const b = z.object({ tenantId: z.string().default("local"), type: z.enum(["logic","state","timing","resource","data","integration","config","unknown"]), description: z.string(), symptoms: z.array(z.string()), affectedSubsystem: z.string(), reproductionSteps: z.array(z.string()), severity: z.enum(["low","medium","high","critical"]) }).parse(request.body); return await engine.selfDebugging.reportBug(b.tenantId, b.type, b.description, b.symptoms, b.affectedSubsystem, b.reproductionSteps, b.severity); });
  app.post("/v1/self-debugging/fix", async (request) => { const b = z.object({ bugId: z.string(), description: z.string(), rootCause: z.string(), fix: z.string() }).parse(request.body); return await engine.selfDebugging.proposeFix(b.bugId, b.description, b.rootCause, b.fix); });
  app.get("/v1/self-debugging/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.selfDebugging.getStats(q.tenantId); });

  // ═══ Phase5: Causal Graph ═══
  app.get("/v1/causal-graph/stats", async () => { return await engine.causalGraph.getStats(); });
  app.post("/v1/causal-graph/node", async (request) => { const b = z.object({ name: z.string(), type: z.enum(["event","state","action","outcome"]), description: z.string() }).parse(request.body); return await engine.causalGraph.addNode(b.name, b.type, b.description); });
  app.post("/v1/causal-graph/edge", async (request) => { const b = z.object({ fromId: z.string(), toId: z.string(), type: z.enum(["causes","enables","prevents","correlates","inhibits"]), strength: z.number(), confidence: z.number() }).parse(request.body); return await engine.causalGraph.addEdge(b.fromId, b.toId, b.type, b.strength, b.confidence); });
  app.post("/v1/causal-graph/paths", async (request) => { const b = z.object({ fromId: z.string(), toId: z.string(), maxDepth: z.number().optional() }).parse(request.body); return { paths: await engine.causalGraph.findPaths(b.fromId, b.toId, b.maxDepth) }; });

  // ═══ Phase5: Long-Horizon Memory ═══
  app.get("/v1/long-horizon-memory", async (request) => { const q = auroraTenant.parse(request.query); return { memories: await engine.longHorizonMemory.getMemories(q.tenantId) }; });
  app.post("/v1/long-horizon-memory", async (request) => { const b = z.object({ tenantId: z.string().default("local"), category: z.enum(["episodic","semantic","procedural","emotional","strategic"]), horizon: z.enum(["short","medium","long","permanent"]), title: z.string(), content: z.string(), importance: z.number(), emotionalWeight: z.number().optional(), associations: z.array(z.string()).optional() }).parse(request.body); return await engine.longHorizonMemory.storeMemory(b.tenantId, b.category, b.horizon, b.title, b.content, b.importance, b.emotionalWeight, b.associations); });
  app.post("/v1/long-horizon-memory/consolidate", async (request) => { const b = z.object({ memoryIds: z.array(z.string()), title: z.string(), content: z.string() }).parse(request.body); return await engine.longHorizonMemory.consolidate(b.memoryIds, b.title, b.content); });
  app.get("/v1/long-horizon-memory/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.longHorizonMemory.getStats(q.tenantId); });

  // ═══ Phase5: Neural Cognitive Core ═══
  app.get("/v1/neural-core/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.neuralCognitiveCore.getStats(q.tenantId); });
  app.post("/v1/neural-core/pattern", async (request) => { const b = z.object({ name: z.string(), description: z.string(), triggerConditions: z.array(z.string()), responseTemplate: z.string() }).parse(request.body); return await engine.neuralCognitiveCore.registerPattern(b.name, b.description, b.triggerConditions, b.responseTemplate); });
  app.post("/v1/neural-core/activate", async (request) => { const b = z.object({ input: z.string(), context: z.string() }).parse(request.body); return await engine.neuralCognitiveCore.activate(b.input, b.context); });

  // ═══ Phase5: Learned World Model ═══
  app.get("/v1/learned-world/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.learnedWorldModel.getStats(q.tenantId); });
  app.post("/v1/learned-world/entity", async (request) => { const b = z.object({ name: z.string(), type: z.enum(["user","system","environment","tool","concept"]), properties: z.record(z.string()).optional() }).parse(request.body); return await engine.learnedWorldModel.observeEntity(b.name, b.type, b.properties); });
  app.post("/v1/learned-world/relation", async (request) => { const b = z.object({ fromId: z.string(), toId: z.string(), type: z.enum(["uses","depends_on","conflicts_with","enhances","replaces","part_of","related_to"]), strength: z.number() }).parse(request.body); return await engine.learnedWorldModel.addRelation(b.fromId, b.toId, b.type, b.strength); });
  app.post("/v1/learned-world/rule", async (request) => { const b = z.object({ condition: z.string(), consequence: z.string(), example: z.string() }).parse(request.body); return await engine.learnedWorldModel.addRule(b.condition, b.consequence, b.example); });
  app.post("/v1/learned-world/query", async (request) => { const b = z.object({ type: z.enum(["user","system","environment","tool","concept"]).optional(), nameContains: z.string().optional() }).parse(request.body); return { entities: await engine.learnedWorldModel.queryEntities(b.type, b.nameContains) }; });

  // ═══ E4 / P1.11: Counterfactual simulator — "what if B instead of A?" ═══
  //
  // The durable machine (create → scenarios with estimates → weighted
  // recommendation → actual outcome → calibration) existed in full and had
  // zero callers: not even an HTTP route reached it, and the only wrapper
  // that touched it returned a recommendation of the simulation itself.
  // Estimates are the caller's to supply; the routes never invent them.
  app.post("/v1/counterfactual/simulations", async (request, reply) => { const b = z.object({ tenantId: z.string().default("local"), question: z.string().min(1).max(10_000), context: z.string().max(50_000).optional() }).parse(request.body); return await reply.code(201).send(await engine.counterfactualSimulator.createSimulation(b.tenantId, b.question, b.context ?? "")); });
  app.get("/v1/counterfactual/simulations", async (request) => { const q = z.object({ tenantId: z.string().default("local"), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query); return { simulations: await engine.counterfactualSimulator.getSimulations(q.tenantId, q.limit ?? 20) }; });
  app.post("/v1/counterfactual/simulations/:simId/scenarios", async (request, reply) => { const { simId } = z.object({ simId: z.string() }).parse(request.params); const b = z.object({ tenantId: z.string().default("local"), name: z.string().min(1).max(200), description: z.string().min(1).max(20_000), assumptions: z.array(z.string()).max(20).optional(), parameters: z.record(z.union([z.number(), z.string()])).optional(), estimatedEffort: z.number().min(0).max(100), estimatedRisk: z.number().min(0).max(1), estimatedCost: z.number().min(0).max(100), estimatedQuality: z.number().min(0).max(1), pros: z.array(z.string()).max(20).optional(), cons: z.array(z.string()).max(20).optional(), confidence: z.number().min(0).max(1) }).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.counterfactualSimulator.addScenario(simId, { ...rest, assumptions: rest.assumptions ?? [], parameters: rest.parameters ?? {}, pros: rest.pros ?? [], cons: rest.cons ?? [] })); });
  app.post("/v1/counterfactual/simulations/:simId/recommend", async (request) => { const { simId } = z.object({ simId: z.string() }).parse(request.params); const b = z.object({ tenantId: z.string().default("local"), weights: z.object({ effort: z.number().min(0).max(1), risk: z.number().min(0).max(1), cost: z.number().min(0).max(1), quality: z.number().min(0).max(1) }).optional() }).parse(request.body ?? {}); return await engine.counterfactualSimulator.recommend(simId, b.weights); });
  app.post("/v1/counterfactual/simulations/:simId/outcome", async (request) => { const { simId } = z.object({ simId: z.string() }).parse(request.params); const b = z.object({ tenantId: z.string().default("local"), chosenScenarioId: z.string(), actualOutcome: z.string().min(1).max(10_000), actualMetrics: z.object({ effort: z.number(), risk: z.number(), cost: z.number(), quality: z.number() }).optional() }).parse(request.body); return await engine.counterfactualSimulator.recordOutcome(simId, b.chosenScenarioId, b.actualOutcome, b.actualMetrics); });
  app.get("/v1/counterfactual/calibration", async (request) => { const q = auroraTenant.parse(request.query); return await engine.counterfactualSimulator.getCalibrationAccuracy(q.tenantId); });


  // ═══ P1-30: Hypothesis Lifecycle ═══
  app.post("/v1/multi-hypothesis/:id/start-testing", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); await engine.multiHypothesis.startTesting(id); return { ok: true }; });
  app.post("/v1/multi-hypothesis/supersede", async (request) => { const b = z.object({ oldId: z.string(), newId: z.string() }).parse(request.body); await engine.multiHypothesis.supersedeHypothesis(b.oldId, b.newId); return { ok: true }; });
  app.get("/v1/multi-hypothesis/evidence-graph", async (request) => { const q = auroraTenant.parse(request.query); return await engine.multiHypothesis.getEvidenceGraph(q.tenantId); });
  app.post("/v1/multi-hypothesis/:id/calibrate", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); return { confidence: await engine.multiHypothesis.calibrateConfidence(id) }; });

  // ═══ P1-35/38: Self-Model Awareness + Gap Detector ═══
  app.get("/v1/self-model/awareness", async (request) => { const q = auroraTenant.parse(request.query); return await engine.selfModel.getCapabilityAwareness(q.tenantId); });
  app.get("/v1/self-model/gaps", async (request) => { const q = auroraTenant.parse(request.query); return { gaps: await engine.selfModel.detectCapabilityGaps(q.tenantId) }; });

  // ═══ P1-56: Model Capability Registry ═══
  app.get("/v1/model-capabilities", async () => { return { profiles: await engine.modelCapabilityRegistry.getProfiles() }; });
  app.get("/v1/model-capabilities/:modelId", async (request) => { const { modelId } = z.object({ modelId: z.string() }).parse(request.params); return await engine.modelCapabilityRegistry.getProfile(modelId); });
  app.post("/v1/model-capabilities", async (request) => { const b = z.object({ modelId: z.string(), displayName: z.string(), provider: z.string(), capabilities: z.array(z.string()), contextWindow: z.number(), maxOutputTokens: z.number().optional(), avgLatencyMs: z.number().optional(), costPer1kInput: z.number().optional(), costPer1kOutput: z.number().optional(), specializations: z.array(z.string()).optional() }).parse(request.body); return await engine.modelCapabilityRegistry.register(b as any); });
  app.post("/v1/model-capabilities/:modelId/outcome", async (request) => { const { modelId } = z.object({ modelId: z.string() }).parse(request.params); const b = z.object({ success: z.boolean(), latencyMs: z.number() }).parse(request.body); await engine.modelCapabilityRegistry.recordOutcome(modelId, b.success, b.latencyMs); return { ok: true }; });
  app.post("/v1/model-capabilities/:modelId/benchmark", async (request) => { const { modelId } = z.object({ modelId: z.string() }).parse(request.params); const b = z.object({ benchmark: z.string(), score: z.number(), latencyMs: z.number(), costUsd: z.number() }).parse(request.body); await engine.modelCapabilityRegistry.recordBenchmark(modelId, b.benchmark, b.score, b.latencyMs, b.costUsd); return { ok: true }; });
  app.post("/v1/model-capabilities/select", async (request) => { const b = z.object({ requiredCapabilities: z.array(z.string()), strategy: z.enum(["performance","cost","quality","balanced"]), preferSpecialization: z.string().optional() }).parse(request.body); return await engine.modelCapabilityRegistry.selectBest(b as any); });
  app.get("/v1/model-capabilities/stats", async () => { return await engine.modelCapabilityRegistry.getStats(); });

  // ═══ P2: Cost Intelligence ═══
  app.get("/v1/cognitive-telemetry/cost", async (request) => { const q = auroraTenant.parse(request.query); return await engine.cognitiveTelemetry.getCostStats(q.tenantId); });

  // ═══ P2: Self-Healing ═══
  app.post("/v1/self-debugging/heal", async (request) => { const b = z.object({ tenantId: z.string().default("local"), subsystem: z.string(), symptoms: z.array(z.string()) }).parse(request.body); return await engine.selfDebugging.selfHeal(b.tenantId, b.subsystem, b.symptoms); });

  // ═══ P2: Learned Routing Endpoints ═══
  app.post("/v1/routing/learn", async (request) => { const b = z.object({ tenantId: z.string().default("local") }).parse(request.body); return await engine.adaptiveRouter.learnRoute(b.tenantId); });
  app.post("/v1/routing/smart", async (request) => { const b = z.object({ tenantId: z.string().default("local"), pattern: z.string() }).parse(request.body); return await engine.adaptiveRouter.smartRoute(b.tenantId, b.pattern); });

  // ═══ P2: Explainability Endpoints ═══
  app.post("/v1/decisions/why", async (request) => { const b = z.object({ tenantId: z.string().default("local"), decisionId: z.string() }).parse(request.body); return await engine.decisions.why(b.tenantId, b.decisionId); });
  app.post("/v1/routing/why", async (request) => { const b = z.object({ tenantId: z.string().default("local"), routeId: z.string() }).parse(request.body); return await engine.adaptiveRouter.why(b.tenantId, b.routeId); });
  app.post("/v1/planning/why", async (request) => { const b = z.object({ tenantId: z.string().default("local"), planId: z.string() }).parse(request.body); return await engine.plannerV2.why(b.tenantId, b.planId); });
  app.post("/v1/meta-controller/why", async (request) => { const b = z.object({ tenantId: z.string().default("local"), traceId: z.string() }).parse(request.body); return await engine.metaController.why(b.tenantId, b.traceId); });
  app.post("/v1/hypotheses/why", async (request) => { const b = z.object({ tenantId: z.string().default("local"), hypothesisId: z.string() }).parse(request.body); return await engine.multiHypothesis.why(b.tenantId, b.hypothesisId); });
  app.post("/v1/goals/why", async (request) => { const b = z.object({ tenantId: z.string().default("local"), goalId: z.string() }).parse(request.body); return await engine.goalStack.why(b.tenantId, b.goalId); });
  app.post("/v1/constitution/why", async (request) => { const b = z.object({ tenantId: z.string().default("local"), violationId: z.string() }).parse(request.body); return await engine.constitution.why(b.tenantId, b.violationId); });

  // ═══ P2: Advanced Intelligence Endpoints ═══
  
  // Cognitive reflection: analyze recent decisions and extract lessons
  app.get("/v1/cognitive/reflection", async (request) => { const q = z.object({ tenantId: z.string().default("local"), limit: z.number().default(10) }).parse(request.query);
    const [decisions, hypotheses, failures] = await Promise.all([
      engine.decisions.list(q.tenantId, { limit: q.limit }).catch(() => []),
      engine.multiHypothesis.getHypotheses(q.tenantId).catch(() => []),
      engine.selfModel.getFailurePatterns(q.tenantId).catch(() => []),
    ]);
    const completedDecisions = decisions.filter(d => d.outcome);
    const lessons: string[] = [];
    for (const d of completedDecisions.slice(0, 5)) {
      if (!d.outcome?.succeeded) lessons.push(`Decision "${d.title}" failed — review criteria and alternatives`);
    }
    for (const f of failures.slice(0, 3)) {
      lessons.push(`Failure pattern: ${f.type} — root cause: ${f.commonCause}`);
    }
    return { recentDecisions: completedDecisions.length, activeHypotheses: hypotheses.length, lessons, reflectionScore: Math.min(1, lessons.length * 0.1 + completedDecisions.length * 0.05) };
  });
  
  // Strategic recommendations: combine goals, capabilities, and market data
  app.get("/v1/strategy/recommendations", async (request) => { const q = z.object({ tenantId: z.string().default("local") }).parse(request.query);
    const [goals, capabilities, skills, market] = await Promise.all([
      engine.goalStack.getActiveGoals(q.tenantId).catch(() => []),
      engine.selfModel.getCapabilities(q.tenantId).catch(() => []),
      engine.experienceCompiler.getSkills(q.tenantId).catch(() => []),
      engine.capabilityMarketplace.getStats(q.tenantId).catch(() => []),
    ]);
    const recommendations: Array<{ type: string; priority: number; description: string; rationale: string }> = [];
    for (const g of goals.filter((g: any) => g.progress < 0.3)) {
      recommendations.push({ type: "goal_acceleration", priority: Number(g.priority) || 5, description: `Accelerate goal: ${g.title}`, rationale: `Progress: ${(g.progress * 100).toFixed(0)}%` });
    }
    for (const c of capabilities.filter((c: any) => c.level === "novice")) {
      recommendations.push({ type: "capability_building", priority: 7, description: `Build capability in ${c.domain}`, rationale: `Current level: ${c.level}` });
    }
    recommendations.sort((a, b) => b.priority - a.priority);
    return { recommendations: recommendations.slice(0, 10), goalCount: goals.length, capabilityCount: capabilities.length, skillCount: skills.length };
  });
  
  // Risk assessment: combine multiple risk signals
  app.get("/v1/risk/assessment", async (request) => { const q = z.object({ tenantId: z.string().default("local") }).parse(request.query);
    const [bugs, costStats, failures, goals] = await Promise.all([
      engine.selfDebugging.getBugs(q.tenantId, 50).catch(() => []),
      engine.cognitiveTelemetry.getCostStats(q.tenantId).catch(() => null),
      engine.selfModel.getFailurePatterns(q.tenantId).catch(() => []),
      engine.goalStack.getActiveGoals(q.tenantId).catch(() => []),
    ]);
    const risks: Array<{ type: string; severity: string; description: string; mitigation: string }> = [];
    if (bugs.length > 10) risks.push({ type: "technical_debt", severity: "high", description: `${bugs.length} open bugs`, mitigation: "Prioritize and fix critical bugs" });
    if (costStats?.totalCostUsd && costStats.totalCostUsd > 10) risks.push({ type: "cost_overrun", severity: "medium", description: `Total cost: $${costStats.totalCostUsd.toFixed(2)}`, mitigation: "Review cost-heavy operations" });
    for (const f of failures.slice(0, 3)) {
      risks.push({ type: "recurring_failure", severity: "high", description: `Recurring ${f.type} failures`, mitigation: `Address root cause: ${f.commonCause}` });
    }
    const stalledGoals = goals.filter(g => g.progress < 0.1);
    if (stalledGoals.length > 2) risks.push({ type: "goal_stalling", severity: "medium", description: `${stalledGoals.length} stalled goals`, mitigation: "Review and reprioritize goals" });
    const overallRisk = risks.length === 0 ? "low" : risks.length <= 2 ? "medium" : "high";
    return { risks, overallRisk, totalRisks: risks.length };
  });

  // ═══ P2: Deep Cross-Service Integration ═══
  
  // Full decision lifecycle: open → analyze → decide → execute → learn
  app.post("/v1/decisions/lifecycle", async (request) => { const b = z.object({ tenantId: z.string().default("local"), title: z.string(), question: z.string(), options: z.array(z.string()) }).parse(request.body);
    const decision = await engine.decisions.open({ tenantId: b.tenantId, title: b.title, question: b.question, context: b.question, reversibility: "reversible", criteria: [{ name: "quality", weight: 1 }] });
    for (const opt of b.options) { await engine.decisions.addOption({ tenantId: b.tenantId, decisionId: decision.id, name: opt, description: opt, scores: {} }); }
    const hypotheses = await engine.multiHypothesis.getHypotheses(b.tenantId).catch(() => []);
    const relatedHypotheses = hypotheses.filter(h => h.statement.toLowerCase().includes(String(b.question ?? "").toLowerCase().split(" ")[0] ?? "")).slice(0, 3);
    return { decision, relatedHypotheses: relatedHypotheses.map(h => ({ id: h.id, statement: h.statement, confidence: h.confidence })) };
  });
  
  // Goal-driven planning: create goal → find skills → create plan
  app.post("/v1/planning/goal-driven", async (request) => { const b = z.object({ tenantId: z.string().default("local"), goalTitle: z.string(), goalDescription: z.string(), priority: z.number().default(5) }).parse(request.body);
    const goal = await engine.goalStack.addGoal(b.tenantId, b.goalTitle, b.goalDescription, (b.priority ?? 5) as any, "Achieve " + b.goalTitle);
    const skills = await engine.experienceCompiler.getSkills(b.tenantId).catch(() => []);
    const relevantSkills = skills.filter(sk => sk.name.toLowerCase().includes(String(b.goalTitle ?? "").toLowerCase().split(" ")[0] ?? "") || sk.description.toLowerCase().includes(String(b.goalDescription ?? "").toLowerCase().split(" ")[0] ?? "")).slice(0, 5);
    return { goal, relevantSkills: relevantSkills.map(sk => ({ id: sk.id, name: sk.name, confidence: sk.confidence, stage: sk.stage })) };
  });
  
  // Agent capability assessment: check all capabilities and suggest improvements
  app.get("/v1/capabilities/assessment", async (request) => { const q = z.object({ tenantId: z.string().default("local") }).parse(request.query);
    const [capabilities, failures, skills] = await Promise.all([
      engine.selfModel.getCapabilities(q.tenantId as string).catch(() => []),
      engine.selfModel.getFailurePatterns(q.tenantId).catch(() => []),
      engine.experienceCompiler.getSkills(q.tenantId).catch(() => []),
    ]);
    const weakCapabilities = capabilities.filter(c => c.level === "novice" || c.level === "incapable");
    const strongCapabilities = capabilities.filter(c => c.level === "proficient");
    const gaps = weakCapabilities.map(c => ({ domain: c.domain, level: c.level, suggestedSkills: skills.filter(sk => sk.requiredCapabilities.some(rc => rc.toLowerCase().includes(c.domain.toLowerCase()))).slice(0, 3) }));
    return { totalCapabilities: capabilities.length, weak: weakCapabilities.length, strong: strongCapabilities.length, gaps, recentFailures: failures.slice(0, 5) };
  });
  
  // System self-diagnosis: check all subsystems and report issues
  app.get("/v1/system/diagnosis", async (request) => { const q = z.object({ tenantId: z.string().default("local") }).parse(request.query);
    const [bugs, costStats, capabilities, goals] = await Promise.all([
      engine.selfDebugging.getBugs(q.tenantId, 50).catch(() => []),
      engine.cognitiveTelemetry.getCostStats(q.tenantId).catch(() => null),
      engine.selfModel.getCapabilities(q.tenantId as string).catch(() => []),
      engine.goalStack.getActiveGoals(q.tenantId).catch(() => []),
    ]);
    const openBugs = bugs;
    const highCostModels = costStats?.byModel ? Object.entries(costStats.byModel).filter(([_, v]: any) => typeof v === "number" ? v > 1 : (v?.costUsd ?? 0) > 1).map(([model]) => model) : [];
    const stalledGoals = goals.filter(g => g.progress < 0.1);
    const issues: string[] = [];
    if (openBugs.length > 5) issues.push(`${openBugs.length} open bugs — consider fixing high-priority ones`);
    if (highCostModels.length > 0) issues.push(`High-cost models: ${highCostModels.join(", ")}`);
    if (stalledGoals.length > 3) issues.push(`${stalledGoals.length} stalled goals — review and reprioritize`);
    return { openBugs: openBugs.length, highCostModels, stalledGoals: stalledGoals.length, issues, overallHealth: issues.length === 0 ? "healthy" : issues.length <= 2 ? "warning" : "critical" };
  });
  
  // Learning effectiveness: what has the system learned and how effective is it?
  app.get("/v1/learning/effectiveness", async (request) => { const q = z.object({ tenantId: z.string().default("local") }).parse(request.query);
    const [skills, hypotheses, decisions, bugs] = await Promise.all([
      engine.experienceCompiler.getSkills(q.tenantId).catch(() => []),
      engine.multiHypothesis.getHypotheses(q.tenantId).catch(() => []),
      engine.decisions.list(q.tenantId, { limit: 100 }).catch(() => []),
      engine.selfDebugging.getBugs(q.tenantId, 100).catch(() => []),
    ]);
    const productionSkills = skills.filter(sk => sk.stage === "production");
    const avgSkillConfidence = skills.length ? skills.reduce((s, sk) => s + sk.confidence, 0) / skills.length : 0;
    const confirmedHypotheses = hypotheses.filter(h => h.status === "confirmed");
    const decisionSuccessRate = decisions.length ? decisions.filter(d => d.outcome?.succeeded).length / Math.max(1, decisions.filter(d => d.outcome).length) : 0;
    return { totalSkills: skills.length, productionSkills: productionSkills.length, avgSkillConfidence, totalHypotheses: hypotheses.length, confirmedHypotheses: confirmedHypotheses.length, decisionSuccessRate, totalBugs: bugs.length, resolvedBugs: 0 };
  });

  // ═══ P2: Advanced Feature Endpoints ═══
  
  // Memory Consolidation
  app.post("/v1/memory/consolidate", async (request) => { const b = z.object({ tenantId: z.string().default("local") }).parse(request.body); return await engine.longHorizonMemory.autoConsolidate(b.tenantId); });
  
  // Skill Transfer
  app.post("/v1/skills/transfer", async (request) => { const b = z.object({ skillId: z.string(), targetTenantId: z.string(), adaptation: z.string().optional() }).parse(request.body); return await engine.experienceCompiler.transferSkill(b.skillId, b.targetTenantId, b.adaptation); });
  app.post("/v1/skills/similar", async (request) => { const b = z.object({ tenantId: z.string().default("local"), tags: z.array(z.string()) }).parse(request.body); return await engine.experienceCompiler.findSimilarSkills(b.tenantId, b.tags); });
  
  // Proactive Intelligence
  app.get("/v1/proactive/anticipate", async (request) => { const q = z.object({ tenantId: z.string().default("local") }).parse(request.query); return await engine.selfModel.anticipateNeeds(q.tenantId); });
  
  // Causal Impact Analysis
  app.post("/v1/causal/impact", async (request) => { const b = z.object({ nodeId: z.string() }).parse(request.body); return await engine.causalGraph.analyzeImpact(b.nodeId); });
  
  // Context Optimization
  app.post("/v1/context/optimize", async (request) => { const b = z.object({ tenantId: z.string().default("local"), budget: z.object({}).passthrough().optional() }).parse(request.body); return await engine.auroraContextComposer?.optimizeContext({ tenantId: b.tenantId } as any) ?? { optimized: false, tokenSavings: 0, recommendations: ["Context composer not available"] }; });
  
  // Multi-Model Orchestration
  app.post("/v1/models/orchestrate", async (request) => { const b = z.object({ task: z.string(), requiredCapabilities: z.array(z.string()), maxModels: z.number().optional(), preferCost: z.boolean().optional() }).parse(request.body); return await engine.modelCapabilityRegistry.orchestrate({ task: b.task, requiredCapabilities: b.requiredCapabilities, ...(b.maxModels != null ? { maxModels: b.maxModels } : {}), ...(b.preferCost != null ? { preferCost: b.preferCost } : {}) }); });

  // ═══ P2: Cross-Service Integration Endpoints ═══

  // System Health Dashboard — aggregates health across all subsystems
  app.get("/v1/system/health", async (request) => { const q = z.object({ tenantId: z.string().default("local") }).parse(request.query); const tenantId = q.tenantId;
    const [debuggingStats, capabilityStats, routerStats, costStats] = await Promise.all([
      engine.selfDebugging.getStats(tenantId).catch(() => null),
      engine.modelCapabilityRegistry.getStats().catch(() => null),
      engine.adaptiveRouter.getStats(tenantId).catch(() => null),
      engine.cognitiveTelemetry.getCostStats(tenantId).catch(() => null),
    ]);
    return { debugging: debuggingStats, capabilities: capabilityStats, routing: routerStats, costs: costStats };
  });

  // Explain a decision end-to-end
  app.post("/v1/explain/full", async (request) => { const b = z.object({ tenantId: z.string().default("local"), decisionId: z.string() }).parse(request.body);
    const decisionWhy = await engine.decisions.why(b.tenantId, b.decisionId).catch(() => null);
    const decisions = await engine.decisions.list(b.tenantId, { limit: 100 });
    const successRate = decisions.length ? decisions.filter(d => d.outcome?.succeeded).length / decisions.length : 0;
    const avgConfidence = decisions.length ? decisions.reduce((s, d) => s + d.confidence, 0) / decisions.length : 0;
    return { decision: decisionWhy, context: { totalDecisions: decisions.length, successRate, avgConfidence } };
  });

  // Learning pipeline — what has the system learned?
  app.get("/v1/learning/summary", async (request) => { const q = z.object({ tenantId: z.string().default("local") }).parse(request.query); const tenantId = q.tenantId;
    const [debuggingStats, skills, sharedStats] = await Promise.all([
      engine.selfDebugging.getStats(tenantId).catch(() => null),
      engine.experienceCompiler.getSkills(tenantId).catch(() => []),
      engine.sharedLearning.getStats(tenantId).catch(() => null),
    ]);
    return { debugging: debuggingStats, skills: skills?.length ?? 0, topSkills: (skills ?? []).slice(0, 5).map(sk => ({ name: sk.name, confidence: sk.confidence, stage: sk.stage })), sharedLearning: sharedStats };
  });

  // Cognitive budget — track token/cost spending across all services
  app.get("/v1/budget/status", async (request) => { const q = z.object({ tenantId: z.string().default("local") }).parse(request.query); const tenantId = q.tenantId;
    const [costStats, resourceStats] = await Promise.all([
      engine.cognitiveTelemetry.getCostStats(tenantId).catch(() => null),
      engine.resourceIntelligence.getStats(tenantId).catch(() => null),
    ]);
    return { costs: costStats, resources: resourceStats };
  });

  // Agent society overview
  app.get("/v1/society/overview", async (request) => { const q = z.object({ tenantId: z.string().default("local") }).parse(request.query); const tenantId = q.tenantId;
    const [agentStats, reputationStats, swarmStats] = await Promise.all([
      engine.agentEconomy.getStats(tenantId).catch(() => null),
      engine.reputation.getStats(tenantId).catch(() => null),
      engine.swarmOrchestration.getStats(tenantId).catch(() => null),
    ]);
    return { agents: agentStats, reputation: reputationStats, swarm: swarmStats };
  });

  // ═══ P2: Cognitive Pipeline — chain services for complex tasks ═══

  // Full cognitive cycle: perceive → reason → decide → act → learn
  app.post("/v1/cognitive/cycle", async (request) => { const b = z.object({ tenantId: z.string().default("local"), task: z.string() }).parse(request.body);
    const traceId = `cycle-${Date.now()}`;
    const [hypotheses, goals, plans] = await Promise.all([
      engine.multiHypothesis.getHypotheses(b.tenantId).catch(() => []),
      engine.goalStack.getActiveGoals(b.tenantId).catch(() => []),
      engine.plannerV2.getPlans(b.tenantId).catch(() => []),
    ]);
    return { traceId, phase: "perceived", activeHypotheses: hypotheses.length, activeGoals: goals.filter((g: any) => g.status === "active").length, activePlans: plans.length };
  });

  // Feedback loop: record outcome and propagate to all relevant services
  app.post("/v1/feedback/outcome", async (request) => { const b = z.object({ tenantId: z.string().default("local"), decisionId: z.string(), succeeded: z.boolean(), note: z.string().default("") }).parse(request.body);
    // Record outcome in decision service
    const decision = await engine.decisions.recordOutcome({ tenantId: b.tenantId, decisionId: b.decisionId, succeeded: b.succeeded, note: b.note }).catch(() => null);
    // Propagate learning
    if (decision) {
      // Update routing confidence
      await engine.adaptiveRouter.learnRoute(b.tenantId).catch(() => undefined);
    }
    return { recorded: !!decision, decision, propagated: true };
  });

  // Cross-service search: find relevant context across all services
  app.post("/v1/search/unified", async (request) => { const b = z.object({ tenantId: z.string().default("local"), query: z.string(), limit: z.number().default(10) }).parse(request.body);
    const [decisions, hypotheses, goals, skills, memories] = await Promise.all([
      engine.decisions.list(b.tenantId, { limit: b.limit }).catch(() => []),
      engine.multiHypothesis.getHypotheses(b.tenantId).catch(() => []),
      engine.goalStack.getActiveGoals(b.tenantId).catch(() => []),
      engine.experienceCompiler.getSkills(b.tenantId).catch(() => []),
      engine.longHorizonMemory.search(b.tenantId, b.query).catch(() => []),
    ]);
    const query = b.query.toLowerCase();
    const matchedDecisions = decisions.filter((d: any) => d.title?.toLowerCase().includes(query) || d.question?.toLowerCase().includes(query)).slice(0, 5);
    const matchedHypotheses = hypotheses.filter((h: any) => h.statement?.toLowerCase().includes(query)).slice(0, 5);
    const matchedGoals = goals.filter((g: any) => g.description?.toLowerCase().includes(query) || g.title?.toLowerCase().includes(query)).slice(0, 5);
    return { decisions: matchedDecisions, hypotheses: matchedHypotheses, goals: matchedGoals, skills: skills.slice(0, 5), memories: memories.slice(0, 5) };
  });

  // System-wide metrics dashboard
  app.get("/v1/dashboard/metrics", async (request) => { const q = z.object({ tenantId: z.string().default("local") }).parse(request.query); const tenantId = q.tenantId;
    const [decisions, goals, hypotheses, bugs, costStats] = await Promise.all([
      engine.decisions.list(tenantId, { limit: 100 }).catch(() => []),
      engine.goalStack.getActiveGoals(tenantId).catch(() => []),
      engine.multiHypothesis.getHypotheses(tenantId).catch(() => []),
      engine.selfDebugging.getBugs(tenantId, 50).catch(() => []),
      engine.cognitiveTelemetry.getCostStats(tenantId).catch(() => null),
    ]);
    const decisionSuccessRate = decisions.length ? decisions.filter((d: any) => d.outcome?.succeeded).length / Math.max(1, decisions.filter((d: any) => d.outcome).length) : 0;
    const goalCompletionRate = goals.length ? goals.filter((g: any) => g.status === "completed").length / goals.length : 0;
    const hypothesisConfidence = hypotheses.length ? hypotheses.reduce((s: number, h: any) => s + h.confidence, 0) / hypotheses.length : 0;
    return { decisions: { total: decisions.length, successRate: decisionSuccessRate }, goals: { total: goals.length, completionRate: goalCompletionRate }, hypotheses: { total: hypotheses.length, avgConfidence: hypothesisConfidence }, bugs: { total: bugs.length, open: bugs.filter((b: any) => !b.resolved).length }, costs: costStats };
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase6: Real-World Capabilities (15 Features)
  // ═══════════════════════════════════════════════════════════════════

  // 1. Multimodal Service — OCR, document, image, video, audio, CAD, map, time series
  app.get("/v1/multimodal/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.multimodal.getStats(q.tenantId); });
  app.get("/v1/multimodal/analyses", async (request) => { const q = z.object({ tenantId: z.string().default("local"), modality: z.string().optional() }).parse(request.query); return { analyses: await engine.multimodal.getAnalyses(q.tenantId, q.modality as any) }; });
  app.post("/v1/multimodal/ocr", async (request) => { const b = z.object({ tenantId: z.string().default("local"), source: z.string(), language: z.string().optional() }).parse(request.body); return await engine.multimodal.performOCR(b.tenantId, b.source, b.language); });
  app.post("/v1/multimodal/document", async (request) => { const b = z.object({ tenantId: z.string().default("local"), source: z.string(), format: z.string().optional() }).parse(request.body); return await engine.multimodal.analyzeDocument(b.tenantId, b.source, b.format); });
  app.post("/v1/multimodal/image", async (request) => { const b = z.object({ tenantId: z.string().default("local"), source: z.string() }).parse(request.body); return await engine.multimodal.analyzeImage(b.tenantId, b.source); });
  app.post("/v1/multimodal/video", async (request) => { const b = z.object({ tenantId: z.string().default("local"), source: z.string(), frameInterval: z.number().optional() }).parse(request.body); return await engine.multimodal.analyzeVideo(b.tenantId, b.source, b.frameInterval); });
  app.post("/v1/multimodal/audio", async (request) => { const b = z.object({ tenantId: z.string().default("local"), source: z.string(), language: z.string().optional() }).parse(request.body); return await engine.multimodal.analyzeAudio(b.tenantId, b.source, b.language); });
  app.post("/v1/multimodal/cad", async (request) => { const b = z.object({ tenantId: z.string().default("local"), source: z.string(), format: z.string() }).parse(request.body); return await engine.multimodal.analyzeCAD(b.tenantId, b.source, b.format as any); });
  app.post("/v1/multimodal/map", async (request) => { const b = z.object({ tenantId: z.string().default("local"), source: z.string(), format: z.string().optional() }).parse(request.body); return await engine.multimodal.analyzeMap(b.tenantId, b.source, b.format); });
  app.post("/v1/multimodal/timeseries", async (request) => { const b = z.object({ tenantId: z.string().default("local"), source: z.string(), interval: z.string().optional() }).parse(request.body); return await engine.multimodal.analyzeTimeSeries(b.tenantId, b.source, b.interval); });

  // 2. Connector Service — Email, Calendar, CRM, ERP, IoT, etc.
  app.get("/v1/connectors/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.connectors.getStats(q.tenantId); });
  app.get("/v1/connectors", async (request) => { const q = z.object({ tenantId: z.string().default("local"), type: z.string().optional() }).parse(request.query); return { connectors: await engine.connectors.getConnectors(q.tenantId, q.type as any) }; });
  app.post("/v1/connectors", async (request) => { const b = z.object({ tenantId: z.string().default("local"), type: z.string(), name: z.string(), provider: z.string(), credentialRef: z.string(), settings: z.record(z.unknown()).optional() }).parse(request.body); return await engine.connectors.registerConnector(b.tenantId, b.type as any, b.name, b.provider, b.credentialRef, b.settings); });
  app.post("/v1/connectors/:id/sync", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); return await engine.connectors.sync(id); });
  app.post("/v1/connectors/:id/email/send", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const b = z.object({ to: z.array(z.string()), subject: z.string(), body: z.string(), html: z.string().optional() }).parse(request.body); return await engine.connectors.sendEmail(id, b.to, b.subject, b.body, b.html); });
  app.get("/v1/connectors/:id/calendar", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const q = z.object({ start: z.string(), end: z.string() }).parse(request.query); return { events: await engine.connectors.listCalendarEvents(id, q.start, q.end) }; });
  app.post("/v1/connectors/:id/calendar", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const b = z.object({ title: z.string(), start: z.string(), end: z.string(), description: z.string().optional(), location: z.string().optional() }).parse(request.body); return await engine.connectors.createCalendarEvent(id, b as any); });
  app.get("/v1/connectors/:id/iot/devices", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); return { devices: await engine.connectors.listDevices(id) }; });

  // 3. Computer Use Service — Browser automation, visual grounding, form filling, rollback
  app.get("/v1/computer-use/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.computerUse.getStats(q.tenantId); });
  app.get("/v1/computer-use/tasks", async (request) => { const q = z.object({ tenantId: z.string().default("local"), status: z.string().optional() }).parse(request.query); return { tasks: await engine.computerUse.getTasks(q.tenantId, q.status as any) }; });
  app.post("/v1/computer-use/tasks", async (request) => { const b = z.object({ tenantId: z.string().default("local"), name: z.string(), target: z.string(), steps: z.array(z.object({ type: z.string(), selector: z.string().optional(), value: z.string().optional() })) }).parse(request.body); return await engine.computerUse.createTask(b.tenantId, b.name, b.target as any, b.steps as any); });
  app.post("/v1/computer-use/tasks/:id/execute", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); return await engine.computerUse.executeTask(id); });
  app.post("/v1/computer-use/tasks/:id/rollback", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); return await engine.computerUse.rollbackTask(id); });
  app.post("/v1/computer-use/visual-grounding", async (request) => { const b = z.object({ target: z.string(), screenshot: z.string().optional() }).parse(request.body); return await engine.computerUse.performVisualGrounding(b.target as any, b.screenshot); });
  app.post("/v1/computer-use/find-element", async (request) => { const b = z.object({ tenantId: z.string().default("local"), description: z.string() }).parse(request.body); return { element: await engine.computerUse.findByVisualDescription(b.tenantId, b.description) }; });
  app.post("/v1/computer-use/fill-form", async (request) => { const b = z.object({ fields: z.array(z.object({ name: z.string(), label: z.string(), type: z.string(), required: z.boolean(), selector: z.string() })), values: z.record(z.string()) }).parse(request.body); return await engine.computerUse.fillForm(b.fields as any, b.values); });
  app.get("/v1/computer-use/screenshot", async () => { return { screenshot: await engine.computerUse.captureScreen() }; });

  // 4. Code Pipeline Service — Issue → Plan → Branch → Implement → Test → Security → PR → CI → Deploy
  app.get("/v1/pipeline/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.codePipeline.getStats(q.tenantId); });
  app.get("/v1/pipeline/runs", async (request) => { const q = z.object({ tenantId: z.string().default("local"), status: z.string().optional() }).parse(request.query); return { runs: await engine.codePipeline.getPipelineRuns(q.tenantId, q.status as any) }; });
  app.post("/v1/pipeline/issues", async (request) => { const b = z.object({ tenantId: z.string().default("local"), title: z.string(), description: z.string(), labels: z.array(z.string()).optional(), priority: z.string().optional() }).parse(request.body); return await engine.codePipeline.createIssue(b.tenantId, b.title, b.description, b.labels, b.priority as any); });
  app.get("/v1/pipeline/issues", async (request) => { const q = z.object({ tenantId: z.string().default("local"), status: z.string().optional() }).parse(request.query); return { issues: await engine.codePipeline.getIssues(q.tenantId, q.status as any) }; });
  app.post("/v1/pipeline/start", async (request) => { const b = z.object({ tenantId: z.string().default("local"), issueId: z.string() }).parse(request.body); return await engine.codePipeline.startPipeline(b.tenantId, b.issueId); });
  app.post("/v1/pipeline/:id/execute", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); return await engine.codePipeline.executePipeline(id); });
  app.post("/v1/pipeline/:id/rollback", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); return await engine.codePipeline.rollback(id); });

  // 5. Research Engine — Multi-source search, trust scoring, citation verification, contradiction analysis
  app.get("/v1/research/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.researchEngine.getStats(q.tenantId); });
  app.get("/v1/research/queries", async (request) => { const q = auroraTenant.parse(request.query); return { queries: await engine.researchEngine.getQueries(q.tenantId) }; });
  app.get("/v1/research/results", async (request) => { const q = auroraTenant.parse(request.query); return { results: await engine.researchEngine.getResults(q.tenantId) }; });
  app.get("/v1/research/reports", async (request) => { const q = auroraTenant.parse(request.query); return { reports: await engine.researchEngine.getReports(q.tenantId) }; });
  app.post("/v1/research", async (request) => { const b = z.object({ tenantId: z.string().default("local"), query: z.string(), scope: z.string().optional(), filters: z.object({}).passthrough().optional() }).parse(request.body); return await engine.researchEngine.research(b.tenantId, b.query, b.scope as any, b.filters as any); });
  app.post("/v1/research/:id/report", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const b = z.object({ title: z.string().optional() }).parse(request.body ?? {}); return await engine.researchEngine.generateReport(id, b.title); });
  app.post("/v1/research/verify-source", async (request) => { const b = z.object({ url: z.string() }).parse(request.body); return await engine.researchEngine.verifyUrl(b.url); });

  // 6. Digital Twin — User's projects, tools, goals, constraints, workflows
  app.get("/v1/digital-twin/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.digitalTwin.getStats(q.tenantId); });
  app.get("/v1/digital-twin", async (request) => { const q = auroraTenant.parse(request.query); return { twin: await engine.digitalTwin.getTwin(q.tenantId) }; });
  app.post("/v1/digital-twin", async (request) => { const b = z.object({ tenantId: z.string().default("local"), userId: z.string(), profile: z.object({}).passthrough().optional() }).parse(request.body); return await engine.digitalTwin.createTwin(b.tenantId, b.userId, b.profile); });
  app.post("/v1/digital-twin/projects", async (request) => { const b = z.object({ tenantId: z.string().default("local"), name: z.string(), description: z.string(), status: z.string().optional(), technologies: z.array(z.string()).optional() }).parse(request.body); return await engine.digitalTwin.addProject(b.tenantId, b as any); });
  app.post("/v1/digital-twin/tools", async (request) => { const b = z.object({ tenantId: z.string().default("local"), name: z.string(), type: z.string(), proficiency: z.string() }).parse(request.body); return await engine.digitalTwin.addTool(b.tenantId, b as any); });
  app.post("/v1/digital-twin/workflows", async (request) => { const b = z.object({ tenantId: z.string().default("local"), name: z.string(), description: z.string(), steps: z.array(z.object({ name: z.string(), action: z.string(), estimatedMinutes: z.number() })) }).parse(request.body); return await engine.digitalTwin.addWorkflow(b.tenantId, b as any); });
  app.post("/v1/digital-twin/constraints", async (request) => { const b = z.object({ tenantId: z.string().default("local"), type: z.string(), description: z.string(), severity: z.string() }).parse(request.body); return await engine.digitalTwin.addConstraint(b.tenantId, b as any); });
  app.post("/v1/digital-twin/preferences", async (request) => { const b = z.object({ tenantId: z.string().default("local") }).passthrough().parse(request.body); await engine.digitalTwin.updatePreferences(b.tenantId, b as any); return { ok: true }; });
  app.post("/v1/digital-twin/learn", async (request) => { const b = z.object({ tenantId: z.string().default("local"), type: z.string(), content: z.string(), confidence: z.number(), source: z.string() }).parse(request.body); await engine.digitalTwin.recordLearning(b.tenantId, b as any); return { ok: true }; });
  app.post("/v1/digital-twin/sync", async (request) => { const b = auroraTenant.parse(request.body ?? {}); return await engine.digitalTwin.sync(b.tenantId); });

  // 7. Domain Experts — Law, Finance, Health with source-showing, controlled modes
  app.get("/v1/domain-experts", async (request) => { const q = z.object({ domain: z.string().optional() }).parse(request.query); return { experts: await engine.domainExperts.getExperts(q.domain as any) }; });
  app.get("/v1/domain-experts/:id", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); return await engine.domainExperts.getExpert(id); });
  app.post("/v1/domain-experts/consult", async (request) => { const b = z.object({ tenantId: z.string().default("local"), domain: z.string(), query: z.string() }).parse(request.body); return await engine.domainExperts.consult(b.tenantId, b.domain as any, b.query); });
  app.get("/v1/domain-experts/consultations", async (request) => { const q = z.object({ tenantId: z.string().default("local"), domain: z.string().optional() }).parse(request.query); return { consultations: await engine.domainExperts.getConsultations(q.tenantId, q.domain as any) }; });
  app.post("/v1/domain-experts/compliance", async (request) => { const b = z.object({ tenantId: z.string().default("local"), domain: z.string(), jurisdiction: z.string() }).parse(request.body); return await engine.domainExperts.checkCompliance(b.tenantId, b.domain as any, b.jurisdiction); });

  // 8. Federated/Edge Service — Local models, edge nodes, data policies, air-gap
  app.get("/v1/federated/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.federated.getStats(q.tenantId); });
  app.get("/v1/federated/models", async (request) => { const q = z.object({ tenantId: z.string().default("local"), format: z.string().optional() }).parse(request.query); return { models: await engine.federated.getModels(q.tenantId, q.format as any) }; });
  app.post("/v1/federated/models", async (request) => { const b = z.object({ tenantId: z.string().default("local"), name: z.string(), format: z.string(), path: z.string(), capabilities: z.array(z.string()).optional() }).parse(request.body); return await engine.federated.registerModel(b.tenantId, b.name, b.format as any, b.path, b.capabilities); });
  app.get("/v1/federated/nodes", async (request) => { const q = z.object({ tenantId: z.string().default("local"), target: z.string().optional() }).parse(request.query); return { nodes: await engine.federated.getNodes(q.tenantId, q.target as any) }; });
  app.post("/v1/federated/nodes", async (request) => { const b = z.object({ tenantId: z.string().default("local"), name: z.string(), target: z.string(), capabilities: z.object({}).passthrough() }).parse(request.body); return await engine.federated.registerNode(b.tenantId, b.name, b.target as any, b.capabilities as any); });
  app.post("/v1/federated/infer", async (request) => { const b = z.object({ tenantId: z.string().default("local"), modelId: z.string(), input: z.string(), parameters: z.record(z.unknown()).optional() }).parse(request.body); return await engine.federated.infer(b.tenantId, b.modelId, b.input, b.parameters); });
  app.get("/v1/federated/data-policies", async (request) => { const q = auroraTenant.parse(request.query); return { policies: await engine.federated.getDataPolicies(q.tenantId) }; });
  app.post("/v1/federated/data-policies", async (request) => { const b = z.object({ tenantId: z.string().default("local"), name: z.string(), description: z.string(), rules: z.array(z.object({ type: z.string(), description: z.string(), enforced: z.boolean() })) }).parse(request.body); return await engine.federated.createDataPolicy(b.tenantId, b.name, b.description, b.rules as any); });
  app.get("/v1/federated/air-gap", async () => { return await engine.federated.getAirGapConfig(); });
  app.put("/v1/federated/air-gap", async (request) => { const b = z.object({ enabled: z.boolean().optional(), offlineMode: z.boolean().optional() }).parse(request.body); await engine.federated.configureAirGap(b as any); return { ok: true }; });

  // 9. Agent SDK — Third-party extensions, tools, workflows, expert agents
  app.get("/v1/sdk/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.agentSDK.getStats(q.tenantId); });
  app.get("/v1/sdk/extensions", async (request) => { const q = z.object({ tenantId: z.string().default("local"), type: z.string().optional(), status: z.string().optional() }).parse(request.query); return { extensions: await engine.agentSDK.getExtensions(q.tenantId, q.type as any, q.status as any) }; });
  app.post("/v1/sdk/extensions", async (request) => { const b = z.object({ tenantId: z.string().default("local"), name: z.string(), description: z.string(), type: z.string(), version: z.string(), author: z.string(), manifest: z.object({ entrypoint: z.string(), runtime: z.string(), dependencies: z.array(z.string()).optional(), capabilities: z.array(z.string()).optional(), minEngineVersion: z.string() }).passthrough(), permissions: z.object({}).passthrough() }).parse(request.body); return await engine.agentSDK.registerExtension(b.tenantId, b as any); });
  app.get("/v1/sdk/extensions/:id", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); return await engine.agentSDK.getExtension(id); });
  app.get("/v1/sdk/extensions/:id/reviews", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); return { reviews: await engine.agentSDK.getReviews(id) }; });
  app.post("/v1/sdk/instances", async (request) => { const b = z.object({ extensionId: z.string(), tenantId: z.string().default("local"), config: z.record(z.unknown()).optional() }).parse(request.body); return await engine.agentSDK.createInstance(b.extensionId, b.tenantId, b.config); });
  app.get("/v1/sdk/instances", async (request) => { const q = z.object({ tenantId: z.string().default("local"), extensionId: z.string().optional() }).parse(request.query); return { instances: await engine.agentSDK.getInstances(q.tenantId, q.extensionId) }; });
  app.post("/v1/sdk/instances/:id/execute", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const b = z.object({ tenantId: z.string().default("local"), input: z.unknown() }).parse(request.body); return await engine.agentSDK.execute(id, b.tenantId, b.input); });
  app.get("/v1/sdk/config", async () => { return await engine.agentSDK.getConfig(); });
  app.put("/v1/sdk/config", async (request) => { const b = z.object({}).passthrough().parse(request.body); await engine.agentSDK.updateConfig(b); return { ok: true }; });
}
