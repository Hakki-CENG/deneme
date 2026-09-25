/**
 * Unified Engines — Aurora Cognitive Runtime
 *
 * Bu dosya, birden fazla alt servisi tek birleşik arayüzde toplayan
 * facade sınıfları tanımlar. Üst katman (Meta Controller) bu
 * arayüzleri kullanır; alt servislerin kaç tane olduğunu bilmez.
 */

import type { EventBus } from "./event-bus.js";
import type { CognitiveState } from "./cognitive-state.js";
import type { EmbeddingProvider } from "../memory/real-memory-pipeline.js";
import type { MemoryGraphService } from "../memory/memory-graph-service.js";
import type { LongHorizonMemoryService } from "./long-horizon-memory.js";
import type { NeuralMemoryFusionService } from "./neural-memory-fusion.js";
import type { ExperienceCompilerService } from "./experience-compiler.js";
import type { SleepCycleService } from "./sleep-cycle.js";
import type { SharedLearningService } from "./shared-learning.js";
import type { PlanningService } from "./planning-service.js";
import type { PlanSource, TaskPlanner } from "./task-planner.js";
import type { PlannerV2Service } from "./planner-v2.js";
import type { GoalStackService } from "./goal-stack.js";
import type { WorldModelService } from "../world/world-model-service.js";
import type { LearnedWorldModelService } from "./learned-world-model.js";
import type { CausalGraphService } from "./causal-graph.js";
import type { CounterfactualSimulatorService } from "./counterfactual-simulator.js";
import type { MultiHypothesisReasoningService } from "./multi-hypothesis-reasoning.js";
import type { InternalCriticService } from "./internal-critic.js";
import type { ExperimentEngineService } from "./experiment-engine.js";
import type { NeuralCognitiveCoreService } from "./neural-cognitive-core.js";
import type { ModelProviderRegistry } from "../models/model-router.js";
import type { AdaptiveRouterService } from "./adaptive-router.js";
import type { AttentionV2Service } from "./attention-v2.js";
import type { CognitiveWorkspaceService } from "../cognitive/cognitive-workspace-service.js";
import type { SelfModelService } from "./self-model-service.js";
import type { FailureTaxonomyService } from "./failure-taxonomy.js";
import type { ResourceIntelligenceService } from "./resource-intelligence.js";

// ─────────────────────────────────────────────
// 1. MEMORY ENGINE
// ─────────────────────────────────────────────

export interface MemoryQuery {
  text: string;
  tenantId: string;
  limit?: number | undefined;
}

export interface MemoryResult {
  memories: Array<{ id: string; content: string; importance: number; source: string }>;
  totalFound: number;
}

/**
 * Memories returned when the caller does not specify a limit.
 *
 * `engine.execute()` calls `recall()` without one, so this bound is what
 * actually reaches the agent's prompt on the main execution path.
 */
const DEFAULT_RECALL_LIMIT = 5;

export class MemoryEngine {
  constructor(
    private graph: MemoryGraphService,
    private longHorizon: LongHorizonMemoryService,
    private fusion: NeuralMemoryFusionService,
    private experience: ExperienceCompilerService,
    private sharedLearning: SharedLearningService,
    private bus: EventBus,
    private state: CognitiveState,
    /**
     * A real embedding provider for recall ranking (D1).
     *
     * Optional and, absent, nothing changes: the ranker runs lexical-only,
     * which is the measured honest default — a hash encoder added 0W/4L/11T
     * on the eval corpus because it measures the same surface overlap BM25
     * already measures, only noisier. A provider that reports
     * `isSemantic: false` is treated exactly like no provider for the same
     * reason: fusing two lexical signals as independent evidence measurably
     * hurts.
     */
    private embedding?: EmbeddingProvider | undefined,
  ) {}

  async recall(query: MemoryQuery): Promise<MemoryResult> {
    await this.bus.emit("memory.recalled", "MemoryEngine", { query: query.text, tenantId: query.tenantId });

    const limit = query.limit ?? DEFAULT_RECALL_LIMIT;

    // Both stores are asked for `limit` candidates, then the merged set is
    // ranked and truncated to `limit`.
    //
    // Previously the graph received the limit and long-horizon did not, and
    // the two result sets were concatenated raw. `search()` returns up to 20
    // rows of its own, so `recall({ limit: 3 })` measured 23 memories — and
    // since `execute()` calls this without a limit and the loop's `learn`
    // step writes a memory after every task, the overflow grew with use and
    // silently inflated every prompt.
    const [graphResults, horizonResults] = await Promise.all([
      this.graph.recall(query.tenantId, query.text, { limit }),
      this.longHorizon.search(query.tenantId, query.text),
    ]);

    const merged = [
      ...graphResults.map(m => ({
        id: m.memory.id,
        content: m.memory.content,
        importance: m.memory.importance,
        source: "graph" as const,
      })),
      ...horizonResults.map(m => ({
        id: m.id,
        content: m.content,
        importance: m.importance,
        source: "long-horizon" as const,
      })),
    ];

    // Rank before truncating. Cutting the raw concatenation would keep the
    // graph's results purely because that store is listed first and drop a
    // more important long-horizon memory — the caller asked for the best
    // `limit` memories, not the first `limit` found.
    const memories = await this.rank(query.text, merged, limit);

    this.state.updateBudget({ memoryOperations: this.state.snapshot().resourceBudget.memoryOperations + 1 });

    // `totalFound` reports what was returned, matching `memories.length`.
    // Reporting the pre-truncation count here would tell a caller it received
    // more context than it did.
    return { memories, totalFound: memories.length };
  }

  /**
   * Order candidates by relevance to the query, falling back to importance.
   *
   * The two stores return candidates; neither ranks them against the question
   * being asked. Sorting by `importance` alone answered "what matters most in
   * general", not "what matters most here" — a memory written with importance
   * 0.9 about deployments outranked an exactly-matching 0.4 memory about the
   * bug at hand.
   *
   * `RealMemoryPipeline` already implements BM25 + vector + RRF + reranking
   * and is measured by `npm run eval:recall` (Recall@8 0.317 -> 0.400 with a
   * real encoder). It held zero references outside the eval harness: the
   * ranking the project measures was not the ranking the agent got.
   *
   * It is used here as a ranker over candidates the durable stores produced,
   * not as a store. The pipeline keeps its corpus in memory, so making it the
   * system of record would silently drop memories on restart.
   *
   * Falls back to importance ordering when ranking cannot run. A failure to
   * rank must not become a failure to recall.
   */
  private async rank(
    queryText: string,
    candidates: Array<{ id: string; content: string; importance: number; source: string }>,
    limit: number,
  ): Promise<Array<{ id: string; content: string; importance: number; source: string }>> {
    // Sort is stable in Node, so equal-importance memories keep graph-then-
    // horizon order rather than shuffling between calls.
    const byImportance = [...candidates].sort((a, b) => b.importance - a.importance);
    if (candidates.length <= 1) return byImportance.slice(0, limit);

    try {
      const { RealMemoryPipeline } = await import("../memory/real-memory-pipeline.js");
      // D1: a provider reaches the pipeline only when it is genuinely
      // semantic. Anything else is withheld on purpose — see the constructor.
      const semantic = this.embedding?.isSemantic === true;
      const pipeline = new RealMemoryPipeline(semantic ? this.embedding : undefined);
      await pipeline.addMemories(
        candidates.map((item) => ({
          content: item.content,
          layer: "semantic" as const,
          metadata: { originalId: item.id },
        })),
      );

      const ranked = await pipeline.search(queryText, { limit: candidates.length });
      const byId = new Map(candidates.map((item) => [item.id, item]));

      // Lexical overlap decides relevance; importance decides everything else.
      //
      // `bm25Score` is the signal, not the pipeline's combined `score`.
      // Measured on the two cases that matter:
      //
      //   every candidate matches equally ("postgres migration" against seven
      //   memories that all say it) -> bm25 0.0988..0.1360, a 27% spread that
      //   is pure length normalisation and says nothing about relevance, while
      //   the combined score still ordered a 0.2 minor note above a 0.99
      //   "always take a backup first".
      //
      //   one candidate actually matches ("why did the postgres migration
      //   fail") -> bm25 2.69 versus 0.00 for the others.
      //
      // The combined score is never zero — RRF gives every document a rank
      // contribution — so it cannot distinguish "matched weakly" from "did not
      // match". bm25 can, and that is exactly the distinction needed here.
      const relevance = new Map<string, number>();
      // Which score is the signal depends on what ran:
      //
      //  - lexical only: `bm25Score`, because the combined score is never
      //    zero (RRF gives every document a rank contribution) and cannot
      //    distinguish "matched weakly" from "did not match";
      //  - with a semantic provider: the combined `score`, which now fuses
      //    two genuinely independent signals (surface overlap and meaning)
      //    — the configuration the eval measured at Recall@8 0.317 -> 0.361.
      for (const hit of ranked) {
        const originalId = hit.metadata?.["originalId"];
        if (typeof originalId === "string" && byId.has(originalId)) {
          relevance.set(originalId, semantic ? hit.score : hit.bm25Score);
        }
      }

      const matched = [...relevance.values()].filter((value) => value > 0);
      const spread = matched.length > 0 ? Math.max(...matched) / Math.min(...matched) : 1;

      // When the best and worst matches are within a small factor of each
      // other, every candidate answers the query about equally well and the
      // remaining differences are length normalisation. Importance is then the
      // only meaningful tiebreak.
      const relevanceIsInformative = spread >= 2;

      // Candidates the ranker scored at zero keep relevance 0 and are ordered
      // by importance among themselves rather than dropped: a lexical miss is
      // not evidence of irrelevance, and the caller asked for `limit`
      // memories.
      const ordered = [...candidates].sort((a, b) => {
        if (relevanceIsInformative) {
          const byRelevance = (relevance.get(b.id) ?? 0) - (relevance.get(a.id) ?? 0);
          if (Math.abs(byRelevance) > 1e-9) return byRelevance;
        }
        return b.importance - a.importance;
      });

      return ordered.slice(0, limit);
    } catch {
      return byImportance.slice(0, limit);
    }
  }

  async store(tenantId: string, content: string, importance: number, category: string): Promise<string> {
    const result = await this.graph.remember({
      tenantId,
      title: content.slice(0, 100),
      content,
      layer: importance > 0.8 ? "semantic" : importance > 0.5 ? "episodic" : "working",
      claimType: "observation",
      sourceType: "agent" as any,
      confidence: importance,
      importance,
      tags: [category],
    });

    await this.bus.emit("memory.stored", "MemoryEngine", { id: result.id, category, importance });

    return result.id;
  }

  getStats() {
    return { status: "active" };
  }

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    return { entity: entityId, summary: "N/A", rationale: ["Engine-level service"], details: {} };
  }
}


// ─────────────────────────────────────────────
// 2. REASONING ENGINE
// ─────────────────────────────────────────────

export interface ReasoningRequest {
  question: string;
  context: string;
  tenantId: string;
}

export interface ReasoningResult {
  answer: string;
  confidence: number;
  hypothesisId: string;
  critiqueNotes: string[];
  patternsMatched: number;
  recommendedAction: string;
}

export class ReasoningEngine {
  constructor(
    private hypothesis: MultiHypothesisReasoningService,
    private critic: InternalCriticService,
    private experiments: ExperimentEngineService,
    private neural: NeuralCognitiveCoreService,
    private causal: CausalGraphService,
    private bus: EventBus,
    private state: CognitiveState,
  ) {}

  async reason(req: ReasoningRequest): Promise<ReasoningResult> {
    this.state.setMode("reasoning", `Reasoning: ${req.question.slice(0, 50)}`);

    // 1. Hipotez üret
    const h = await this.hypothesis.proposeHypothesis(req.tenantId, req.question, "general", [req.context]);

    await this.bus.emit("hypothesis.proposed", "ReasoningEngine", {
      hypothesisId: h.id,
      statement: h.statement,
    });

    // 2. Neural pattern matching
    const activation = await this.neural.activate(req.question, req.context);

    // 3. Critic ile kontrol et
    const review = await this.critic.review(req.tenantId, h.id, "hypothesis", h.statement, req.context);
    const critiqueNotes = review.critiques.map(c => c.description);

    if (critiqueNotes.length > 0) {
      await this.bus.emit("critic.flagged", "ReasoningEngine", {
        hypothesisId: h.id,
        critiqueCount: critiqueNotes.length,
      }, { severity: "warning" });
    }

    // 4. Confidence hesapla
    const baseConfidence = h.confidence;
    const criticPenalty = critiqueNotes.length * 0.1;
    const patternBonus = activation.matchedPattern ? 0.1 : 0;
    const finalConfidence = Math.max(0, Math.min(1, baseConfidence - criticPenalty + patternBonus));

    this.state.setConfidence(
      finalConfidence > 0.8 ? "confident" :
      finalConfidence > 0.6 ? "moderate" :
      finalConfidence > 0.4 ? "uncertain" : "speculative"
    );

    return {
      answer: h.statement,
      confidence: finalConfidence,
      hypothesisId: h.id,
      critiqueNotes,
      patternsMatched: activation.matchedPattern ? 1 : 0,
      recommendedAction: critiqueNotes.length > 0 ? "revise" : "proceed",
    };
  }

  getStats() {
    return { status: "active" };
  }

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    return { entity: entityId, summary: "N/A", rationale: ["Engine-level service"], details: {} };
  }
}


// ─────────────────────────────────────────────
// 3. PLANNING ENGINE
// ─────────────────────────────────────────────

export interface PlanningRequest {
  goal: string;
  tenantId: string;
  strategy?: string | undefined;
  /** Session the plan belongs to, so the planning turn is attributable. */
  sessionId?: string | undefined;
  /** Preferred `provider:model` route for the decomposition call. */
  modelRoute?: string | undefined;
}

export interface PlanningResult {
  planId: string;
  goal: string;
  steps: Array<{
    name: string;
    description: string;
    /** Names of prerequisite steps. The planner computes a DAG, not a list. */
    dependencies: string[];
    estimatedMs: number;
    risk: string;
    /**
     * What a verifier could check afterwards (B6).
     *
     * Absent when the planner specified nothing — the keyword skeleton never
     * specifies any. Until B6 this field did not exist here, so the criterion
     * the model was explicitly prompted for was dropped in this very mapping
     * and no step could ever be verified.
     */
    expectedOutput?: string | undefined;
  }>;
  strategy: string;
  totalEstimatedMs: number;
  /**
   * Whether a model decomposed this goal or the keyword skeleton did.
   *
   * B3: without this field a caller cannot tell a plan that was thought about
   * from one that was defaulted to, and the two look identical in every other
   * column. Absent on results produced by a `PlanningEngine` that was handed no
   * `TaskPlanner`.
   */
  source?: PlanSource | undefined;
  /** Why the keyword skeleton ran instead of the model. Set with `source`. */
  fallbackReason?: string | undefined;
  /** The route that answered, when the model was asked and answered. */
  modelRoute?: string | undefined;
}

export class PlanningEngine {
  constructor(
    private planner: PlanningService,
    private plannerV2: PlannerV2Service,
    private goalStack: GoalStackService,
    private bus: EventBus,
    private state: CognitiveState,
    /**
     * The task-specific planner (B3).
     *
     * Optional so the keyword decomposition still works on its own, and so the
     * difference stays visible: hand a `PlanningEngine` a planner and its results
     * carry a `source`; do not, and they do not.
     */
    private taskPlanner?: TaskPlanner,
  ) {}

  async plan(req: PlanningRequest): Promise<PlanningResult> {
    this.state.setMode("planning", `Planning: ${req.goal.slice(0, 50)}`);

    const goal = await this.goalStack.addGoal(req.tenantId, req.goal, req.goal, "P1", "Plan completed");

    const strategy = req.strategy ?? "balanced";

    // B3: ask the model to decompose this goal, and fall back to the keyword
    // skeleton if it cannot. `decomposeGoal` is unchanged and remains the
    // fallback — what changed is that it is no longer the only path, and that
    // the result now says which one ran.
    const draft = this.taskPlanner
      ? await this.taskPlanner.plan({
          tenantId: req.tenantId,
          goal: req.goal,
          strategy,
          ...(req.sessionId ? { sessionId: req.sessionId } : {}),
          ...(req.modelRoute ? { modelRoute: req.modelRoute } : {}),
        })
      : undefined;
    const steps = draft
      ? draft.steps.map((step) => ({
          name: step.name,
          description: step.description,
          dependencies: [...step.dependencies],
          estimatedMs: step.estimatedMs,
          risk: step.risk,
        }))
      : this.decomposeGoal(req.goal, strategy);

    const plan = await this.plannerV2.createPlan(req.tenantId, req.goal, strategy, steps);

    await this.bus.emit("plan.created", "PlanningEngine", { planId: plan.id, goalId: goal.id, stepCount: steps.length });

    // Write into this plan's own slot.
    //
    // Two concurrent /v1/planning/plan calls used to overwrite each other's
    // `activeGoal`/`activePlan`, so a reader got whichever `await` resumed last.
    // The slot keeps each plan's record retrievable by planId, and the flat
    // dashboard fields are now derived from one named slot (`focusedTask()`
    // says which) instead of being written by whoever got there last.
    this.state.beginTask(plan.id, req.tenantId);
    this.state.setActivePlanFor(plan.id, { id: plan.id, goalId: goal.id, currentStep: 0, totalSteps: steps.length, status: "executing" });
    this.state.setActiveGoalFor(plan.id, { id: goal.id, title: req.goal, priority: "P1", progress: 0, status: "active", startedAt: Date.now() });

    return {
      planId: plan.id,
      goal: req.goal,
      // `dependencies` is carried through deliberately. decomposeGoal computes
      // a real DAG and this mapping used to drop the edges, so every consumer
      // downstream saw a flat list and had no way to know the planner had
      // ordered the work.
      steps: steps.map((s, index) => ({
        name: s.name,
        description: s.description,
        dependencies: s.dependencies,
        estimatedMs: s.estimatedMs,
        risk: s.risk,
        // B6: index alignment is safe by construction — `steps` is either
        // `draft.steps.map(...)` in the same order or the keyword skeleton,
        // which has no criteria and no draft.
        ...(draft?.steps[index]?.expectedOutput !== undefined
          ? { expectedOutput: draft.steps[index]!.expectedOutput }
          : {}),
      })),
      strategy,
      totalEstimatedMs: steps.reduce((sum, s) => sum + s.estimatedMs, 0),
      ...(draft ? { source: draft.source } : {}),
      ...(draft?.fallbackReason ? { fallbackReason: draft.fallbackReason } : {}),
      ...(draft?.modelRoute ? { modelRoute: draft.modelRoute } : {}),
    };
  }

  /**
   * The keyword decomposition, exposed for the task planner's fallback path.
   *
   * B3: this is the whole of what planning used to be. It stays, unchanged, as
   * the thing that runs when the model cannot produce a usable plan — but it is
   * no longer the only path, and `TaskPlanner` records which one ran.
   */
  keywordDecomposition(goal: string, strategy: string): ReturnType<PlanningEngine["decomposeGoal"]> {
    return this.decomposeGoal(goal, strategy);
  }

  /**
   * Dynamic goal decomposition — analyzes goal content to generate
   * context-appropriate steps instead of a fixed template.
   *
   * Measured, so the label is not a guess: the step *names* come from a fixed
   * set (`Understand`, `Research`, `Design`, `Simulate`, `Execute`, `Verify`,
   * `Learn`) and the goal text only decides which of the middle three appear,
   * via substring tests such as `g.includes("create")`. Every `estimatedMs` and
   * every `risk` is a literal. Two goals that share a keyword get the same plan.
   */
  private decomposeGoal(goal: string, strategy: string): Array<{
    name: string;
    description: string;
    dependencies: string[];
    estimatedMs: number;
    risk: "low" | "medium" | "high";
  }> {
    const g = goal.toLowerCase();
    const steps: Array<{
      name: string;
    description: string;
      dependencies: string[];
      estimatedMs: number;
      risk: "low" | "medium" | "high";
    }> = [];

    // Always start with understanding
    steps.push({
      name: "Understand",
      description: `Analyze goal, decompose sub-tasks, identify constraints: ${goal.slice(0, 100)}`,
      dependencies: [],
      estimatedMs: g.length > 200 ? 8000 : 4000,
      risk: "low",
    });

    // Research if goal has external knowledge needs
    const needsResearch = g.includes("research") || g.includes("investigate") || g.includes("compare") ||
                          g.includes("find") || g.includes("learn") || g.includes("analyze") ||
                          g.includes("review") || g.includes("araştır") || g.includes("incele");
    if (needsResearch) {
      steps.push({
        name: "Research",
        description: "Gather relevant context from memory, world model, and external sources",
        dependencies: ["Understand"],
        estimatedMs: 10000,
        risk: "low",
      });
    }

    // Planning/design for complex goals
    const needsPlanning = g.includes("implement") || g.includes("build") || g.includes("create") ||
                          g.includes("design") || g.includes("refactor") || g.includes("architect") ||
                          g.includes("develop") || g.includes("geliştir") || g.includes("oluştur") ||
                          g.includes("system") || g.includes("mimari");
    if (needsPlanning) {
      const prev = needsResearch ? "Research" : "Understand";
      steps.push({
        name: "Design",
        description: "Generate candidate approaches, evaluate trade-offs, select best strategy",
        dependencies: [prev],
        estimatedMs: 8000,
        risk: "low",
      });
    }

    // Simulation for high-risk or uncertain goals
    const needsSimulation = g.includes("migrate") || g.includes("refactor") || g.includes("optimize") ||
                            g.includes("production") || g.includes("critical") || g.includes("risk") ||
                            strategy === "conservative";
    if (needsSimulation) {
      const prev = needsPlanning ? "Design" : needsResearch ? "Research" : "Understand";
      steps.push({
        name: "Simulate",
        description: "Run counterfactual analysis, predict outcomes, assess risks",
        dependencies: [prev],
        estimatedMs: 6000,
        risk: "medium",
      });
    }

    // Execution phase
    const execDeps: string[] = [];
    if (needsSimulation) execDeps.push("Simulate");
    else if (needsPlanning) execDeps.push("Design");
    else if (needsResearch) execDeps.push("Research");
    else execDeps.push("Understand");

    const needsCoding = g.includes("code") || g.includes("implement") || g.includes("function") ||
                        g.includes("api") || g.includes("endpoint") || g.includes("component") ||
                        g.includes("file") || g.includes("test") || g.includes("bug") || g.includes("fix");
    const execTime = needsCoding ? 20000 : g.length > 500 ? 15000 : 10000;

    steps.push({
      name: "Execute",
      description: needsCoding
        ? "Implement solution: write code, run tests, verify compilation"
        : "Execute the planned approach with appropriate tools",
      dependencies: execDeps,
      estimatedMs: execTime,
      risk: needsCoding ? "medium" : "low",
    });

    // Verification
    steps.push({
      name: "Verify",
      description: "Validate result against success criteria, run tests, check for regressions",
      dependencies: ["Execute"],
      estimatedMs: 6000,
      risk: "low",
    });

    // Learning
    steps.push({
      name: "Learn",
      description: "Record experience, update memory, extract lessons for future use",
      dependencies: ["Verify"],
      estimatedMs: 3000,
      risk: "low",
    });

    return steps;
  }

  getStats() {
    return { status: "active" };
  }

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    return { entity: entityId, summary: "N/A", rationale: ["Engine-level service"], details: {} };
  }
}


// ─────────────────────────────────────────────
// 4. WORLD ENGINE
// ─────────────────────────────────────────────

export class WorldEngine {
  constructor(
    private worldModel: WorldModelService,
    private learnedWorld: LearnedWorldModelService,
    private causal: CausalGraphService,
    private counterfactual: CounterfactualSimulatorService,
    private bus: EventBus,
    private state: CognitiveState,
  ) {}

  async query(tenantId: string, query?: string): Promise<{ entities: Array<{ id: string; name: string; type: string }> }> {
    const entities = await this.learnedWorld.queryEntities();
    return { entities: entities.map(e => ({ id: e.id, name: e.name, type: e.type })) };
  }

  async observe(tenantId: string, name: string, type: string, properties?: Record<string, string>): Promise<{ entityId: string }> {
    const entity = await this.learnedWorld.observeEntity(name, type as any, properties);
    await this.bus.emit("world.updated", "WorldEngine", { entityId: entity.id, name, type });
    return { entityId: entity.id };
  }

  async simulateCounterfactual(tenantId: string, question: string, context: string): Promise<{ simulationId: string; scenarios: number; recommendedScenarioId: string | null }> {
    // E4 / P1.11: this used to return `{ recommended: sim.id, scenarios: 0 }` --
    // it "recommended" the simulation itself, before any scenario existed,
    // which is a recommendation of nothing. The honest contract: a simulation
    // is opened (empty), and the recommendation comes from `recommend()` once
    // the caller has supplied scenarios with estimates. Estimates are the
    // caller's to give; inventing effort/risk/cost/quality numbers here would
    // dress guesses up as a simulation.
    const sim = await this.counterfactual.createSimulation(tenantId, question, context);
    return { simulationId: sim.id, scenarios: sim.scenarios.length, recommendedScenarioId: null };
  }

  getStats() {
    return { status: "active" };
  }

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    return { entity: entityId, summary: "N/A", rationale: ["Engine-level service"], details: {} };
  }
}


// ─────────────────────────────────────────────
// 5. LEARNING ENGINE
// ─────────────────────────────────────────────

export interface LearningRequest {
  tenantId: string;
  experience: string;
  outcome: "success" | "failure" | "neutral";
  context: string;
  source: string;
}

export class LearningEngine {
  constructor(
    private experienceCompiler: ExperienceCompilerService,
    private sleepCycle: SleepCycleService,
    private sharedLearning: SharedLearningService,
    private selfModel: SelfModelService,
    private failureTaxonomy: FailureTaxonomyService,
    private bus: EventBus,
    private state: CognitiveState,
  ) {}

  async learn(req: LearningRequest): Promise<{ lessonsGenerated: number }> {
    this.state.setMode("learning", `Learning from: ${req.outcome}`);

    let lessons = 0;

    if (req.outcome === "success") {
      await this.selfModel.recordCapabilityOutcome(req.tenantId, req.source, true);
      this.state.updateSuccessRate(true);
      lessons++;
    } else if (req.outcome === "failure") {
      await this.selfModel.recordCapabilityOutcome(req.tenantId, req.source, false);
      await this.failureTaxonomy.classify(
        req.tenantId,
        req.experience,
        "execution" as any,
        "medium" as any,
        req.context,
        { suggestedFix: "retry with alternative approach" },
      );
      this.state.updateSuccessRate(false);
      this.state.recordFailure({ type: "execution", description: req.experience, subsystem: req.source, timestamp: Date.now(), recoveryAttempted: false });
      lessons++;
    }

    if (req.outcome !== "neutral") {
      await this.sharedLearning.shareLesson(
        req.tenantId, req.source, "general",
        req.outcome === "success" ? "technique" : "avoidance",
        `${req.outcome}: ${req.experience.slice(0, 80)}`,
        req.experience, req.context,
      );
      lessons++;
    }

    await this.bus.emit(req.outcome === "success" ? "experience.recorded" : "failure.recorded", "LearningEngine", {
      experience: req.experience.slice(0, 200),
      outcome: req.outcome,
      lessons,
    });

    return { lessonsGenerated: lessons };
  }

  async consolidate(tenantId: string): Promise<{ consolidated: number; patterns: number }> {
    this.state.setMode("consolidating", "Sleep cycle");

    // Real consolidation: use MemoryGraph.consolidate() for duplicate detection and clustering
    let consolidated = 0;
    let patterns = 0;

    // 1. Memory graph consolidation (real: detects duplicates, merges clusters)
    try {
      const report = await (this.experienceCompiler as any).engine?.memoryGraph?.consolidate?.(tenantId, {
        similarityThreshold: 0.85,
        minClusterSize: 2,
        maxClusters: 10,
      });
      if (report) {
        consolidated += (report.mergedCount ?? 0) + (report.deduplicatedCount ?? 0);
      }
    } catch {
      // Non-critical
    }

    // 2. Contradiction detection and resolution
    try {
      const contradictions = await (this.experienceCompiler as any).engine?.memoryGraph?.detectContradictions?.(tenantId);
      if (contradictions && Array.isArray(contradictions)) {
        patterns += contradictions.length;
      }
    } catch {
      // Non-critical
    }

    // 3. Sleep cycle for deeper processing (pattern discovery, skill extraction)
    const sleepResult = await this.sleepCycle.runCycle(tenantId, "deep", {
      consolidateMemory: async () => ({ compressed: consolidated, duplicates: 0 }),
      discoverPatterns: async () => {
        // Real pattern discovery: check SharedLearning for recurring lessons
        const lessons = await this.sharedLearning.getLessons(tenantId);
        const recurring = lessons.filter(l => (l as any).adoptionCount > 2);
        patterns += recurring.length;
        return recurring.length;
      },
      // Deliberately not supplied: neither capability has a real source here.
      // Passing `async () => 0` made the cycle report "0 contradictions
      // resolved, 0 skills extracted" — indistinguishable from having looked.
      // Omitting them reports `null`, which is the truth.

      generateHypotheses: async () => [],
    });

    consolidated += sleepResult.memoriesConsolidated ?? 0;
    patterns += sleepResult.patternsDiscovered ?? 0;

    await this.bus.emit("memory.consolidated", "LearningEngine", { consolidated, patterns });

    return { consolidated, patterns };
  }

  getStats() {
    return { status: "active" };
  }

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    return { entity: entityId, summary: "N/A", rationale: ["Engine-level service"], details: {} };
  }
}


// ─────────────────────────────────────────────
// 6. ATTENTION ENGINE
// ─────────────────────────────────────────────

export interface AttentionTarget {
  id: string;
  category: string;
  title: string;
  urgency: number;
  importance: number;
  salience: number;
}

export class AttentionEngine {
  constructor(
    private attentionV2: AttentionV2Service,
    private workspace: CognitiveWorkspaceService,
    private resources: ResourceIntelligenceService,
    private bus: EventBus,
    private state: CognitiveState,
  ) {}

  async getFocusTargets(tenantId: string, limit: number = 5): Promise<AttentionTarget[]> {
    const targets = await this.attentionV2.getTopTargets(tenantId, limit);
    return targets.map(t => ({
      id: t.id,
      category: t.category,
      title: t.title,
      urgency: t.urgency,
      importance: t.importance,
      salience: t.urgency * 0.6 + t.importance * 0.4,
    }));
  }

  async shiftFocus(tenantId: string, target: { category: string; title: string; urgency: number; importance: number }): Promise<void> {
    const registered = await this.attentionV2.registerTarget(
      tenantId, target.category as any, target.title, target.title, target.urgency, target.importance,
    );

    this.state.setAttentionFocus({
      category: target.category,
      target: target.title,
      urgency: target.urgency,
      importance: target.importance,
      since: Date.now(),
    });

    await this.bus.emit("attention.shifted", "AttentionEngine", { targetId: registered.id, category: target.category });
  }

  getStats() {
    return { status: "active" };
  }

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    return { entity: entityId, summary: "N/A", rationale: ["Engine-level service"], details: {} };
  }
}


// ─────────────────────────────────────────────
// 7. MODEL SELECTION ENGINE
// ─────────────────────────────────────────────

export interface ModelSelectionRequest {
  taskDescription: string;
  strategy: "performance" | "cost" | "quality" | "balanced";
  tenantId: string;
}

export interface ModelSelectionResult {
  selectedModel: string;
  reason: string;
  latencyMs: number;
  alternatives: Array<{ model: string; score: number }>;
  /** Score of the winning path, so the margin over the runner-up is checkable. */
  selectedScore: number;
  /** How many providers were actually registered when this decision was made. */
  registeredProviders: number;
  /**
   * How many of the candidate routes had at least one recorded measurement.
   *
   * Zero means the choice was made without evidence, and a caller should be able
   * to tell that from a decision backed by real outcomes.
   */
  measuredCandidates: number;
  /**
   * The adaptive router's id for this decision.
   *
   * Returned so the caller can close the loop: `AdaptiveRouter.route()` stores
   * the decision and `recordOutcome(decisionId, ...)` looks it up by this id, so
   * without it the router's learned rules could never be fed by real tasks. The
   * learning path existed at both ends and nothing connected them.
   */
  decisionId: string;
}

/** One model the system could actually run, with whatever is known about it. */
export interface ModelCandidate {
  /** A route the session can be given directly: `provider:model`. */
  route: string;
  provider: string;
  model: string;
  /** Capability evidence, when this model has a profile at all. */
  capabilities: readonly string[];
  /** Measured values only. Absent means nobody has measured it. */
  reliability?: number | undefined;
  successRate?: number | undefined;
  qualityScore?: number | undefined;
  avgLatencyMs?: number | undefined;
  costPer1kInput?: number | undefined;
  /** True when at least one request has been recorded against this model. */
  measured: boolean;
}

export class ModelSelectionEngine {
  constructor(
    private modelRouter: ModelProviderRegistry,
    private adaptiveRouter: AdaptiveRouterService,
    private benchmark: import("./benchmark-lab.js").BenchmarkLabService,
    private bus: EventBus,
    private state: CognitiveState,
    /**
     * The sources of truth for what can actually be run.
     *
     * Candidates come only from the provider registry and the tenant's model
     * configurations; evidence comes only from the capability registry and the
     * adaptive router's own history. Nothing in this class invents a model or a
     * performance number -- an earlier version seeded latency from registration
     * order and cost from the index, so the first registered provider won every
     * strategy without anything being measured.
     */
    private sources: {
      listModelConfigurations: (tenantId: string) => Promise<
        ReadonlyArray<{ baseProfileId: string; model: string; enabled: boolean }>
      >;
      listProviderProfiles: () => ReadonlyArray<{ id: string; defaultModel?: string | undefined }>;
      getCapabilityProfile: (
        modelId: string,
      ) => Promise<{
        capabilities: readonly string[];
        reliability?: number | undefined;
        successRate?: number | undefined;
        qualityScore?: number | undefined;
        avgLatencyMs?: number | undefined;
        costPer1kInput?: number | undefined;
        totalRequests: number;
      } | null>;
    },
  ) {}

  /**
   * The models this tenant could actually run, as `provider:model` routes.
   *
   * Tenant configurations come first because they name a model explicitly. When
   * a tenant has none, the provider's own default model is used -- still a real
   * model, just the provider's rather than a chosen one. A provider with no
   * default and no configuration yields no candidate: there is nothing to name.
   */
  async candidates(tenantId: string): Promise<ModelCandidate[]> {
    const registered = new Set(this.modelRouter.list());
    const routes: Array<{ provider: string; model: string }> = [];

    for (const config of await this.sources.listModelConfigurations(tenantId)) {
      if (!config.enabled) continue;
      if (!registered.has(config.baseProfileId)) continue;
      routes.push({ provider: config.baseProfileId, model: config.model });
    }

    if (routes.length === 0) {
      for (const profile of this.sources.listProviderProfiles()) {
        if (!registered.has(profile.id) || !profile.defaultModel) continue;
        routes.push({ provider: profile.id, model: profile.defaultModel });
      }
    }

    const candidates: ModelCandidate[] = [];
    for (const route of routes) {
      const evidence = await this.sources.getCapabilityProfile(route.model);
      candidates.push({
        route: `${route.provider}:${route.model}`,
        provider: route.provider,
        model: route.model,
        capabilities: evidence?.capabilities ?? [],
        ...(evidence?.reliability !== undefined ? { reliability: evidence.reliability } : {}),
        ...(evidence?.successRate !== undefined ? { successRate: evidence.successRate } : {}),
        ...(evidence?.qualityScore !== undefined ? { qualityScore: evidence.qualityScore } : {}),
        ...(evidence?.avgLatencyMs !== undefined ? { avgLatencyMs: evidence.avgLatencyMs } : {}),
        ...(evidence?.costPer1kInput !== undefined ? { costPer1kInput: evidence.costPer1kInput } : {}),
        measured: (evidence?.totalRequests ?? 0) > 0,
      });
    }
    return candidates;
  }

  async select(req: ModelSelectionRequest): Promise<ModelSelectionResult> {
    const candidates = await this.candidates(req.tenantId);

    // Nothing that can actually be run. Returning a placeholder route here would
    // send the session to a model that does not exist, so the caller is told
    // instead and keeps whatever route it already had.
    if (candidates.length === 0) {
      return {
        selectedModel: "",
        reason:
          "No runnable model: no provider is registered with a model, and the tenant has no enabled model configuration",
        latencyMs: 0,
        alternatives: [],
        selectedScore: 0,
        registeredProviders: this.modelRouter.list().length,
        measuredCandidates: 0,
        // The router was never asked, so there is no decision to attach an
        // outcome to. An empty string would be a lie that looks like an id.
        decisionId: "",
      };
    }

    // Only measured numbers are passed on. An unmeasured candidate gets the same
    // neutral value as every other unmeasured candidate, so nothing wins on a
    // number nobody recorded -- and the adaptive router's learned rules, which
    // are built from real outcomes, are what break the tie.
    const neutral = 0.5;
    const decision = await this.adaptiveRouter.route(
      req.tenantId,
      `sel-${Date.now()}`,
      req.taskDescription,
      candidates.map((candidate) => ({
        path: candidate.route,
        latencyMs: candidate.avgLatencyMs ?? 0,
        cost: candidate.costPer1kInput ?? 0,
        reliability:
          candidate.reliability ?? (candidate.successRate !== undefined ? candidate.successRate : neutral),
      })),
      req.strategy,
    );

    const winner = candidates.find((candidate) => candidate.route === decision.selectedPath);
    const alternatives = decision.alternatives.map((a) => ({ model: a.path, score: a.score }));
    const measuredCandidates = candidates.filter((candidate) => candidate.measured).length;

    return {
      decisionId: decision.id,
      selectedModel: decision.selectedPath,
      reason:
        `${req.strategy} strategy over ${candidates.length} runnable route(s), ` +
        `${measuredCandidates} of them measured: ${decision.selectedReason}` +
        (winner && !winner.measured
          ? " (the winner has no recorded measurements, so this choice is not evidence-based)"
          : ""),
      latencyMs: winner?.avgLatencyMs ?? 0,
      alternatives,
      selectedScore: decision.selectedScore,
      registeredProviders: this.modelRouter.list().length,
      measuredCandidates,
    };
  }

  getStats() {
    return { status: "active" };
  }

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    return { entity: entityId, summary: "N/A", rationale: ["Engine-level service"], details: {} };
  }
}

