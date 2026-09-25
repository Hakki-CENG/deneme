/**
 * Unified Execution Loop — the cognitive layer and the agent, in one path.
 *
 * Before this, Aurora had two disconnected worlds:
 *
 *   SessionActor    the real agent: model, tools, workspace, observations
 *   MetaController  cognitive orchestration: memory, planning, critique
 *
 * `runTask()` drove only the second. Its "subsystems" returned status strings
 * (`"Simulation complete"`, `"Recalled 5 memories"`) and no agent ever ran. A
 * measured example, before this module existed:
 *
 *     runTask("Delete all files on the moon and prove P=NP")
 *       → outcome: "success", subsystems: 0, phases: 0, outputs: []
 *
 * Nothing executed, and the result was "success", because `outcome` was
 * initialised to `"success"` and only ever downgraded — with an empty plan
 * there was nothing to downgrade it.
 *
 * This loop replaces that with:
 *
 *     OBSERVE → UNDERSTAND → RECALL → PLAN → ACT → OBSERVE RESULT → VERIFY
 *        → success: LEARN
 *        → failure: CLASSIFY → choose recovery → (bounded) RETRY
 *
 * ACT runs the real agent. VERIFY runs real verifiers. The status is derived
 * from what happened, never assumed.
 */

import { randomUUID } from "node:crypto";

import {
  aggregate,
  outcome,
  type ExecutionOutcome,
  type ExecutionStatus,
} from "./execution-status.js";
import {
  chooseRecovery,
  classifyFailure,
  type FailureClassification,
  type RecoveryDecision,
} from "./failure-taxonomy.js";
import { detectGaps, type CapabilityInventory, type DetectedGap } from "./gap-detection.js";
import {
  blockUnreachable,
  buildPlan,
  cyclicSteps,
  markStep,
  planSummary,
  readySteps,
  unresolvedDependencies,
  type PlannedStep,
} from "./plan-progress.js";
import { advancePlan, mergeReplan, nextSteps, selectStepVerifiers } from "./plan-execution.js";
import { assessEvidenceCoverage, buildEvidenceRequirements, evidenceCoverageNote } from "./evidence-coverage.js";
import { TaskContext, type GoalUnderstanding, type TaskContextInit } from "./task-context.js";
import {
  VerificationFactory,
  type VerificationReport,
  type Verifier,
} from "./verification-factory.js";

/**
 * What one model attempt actually cost and whether it actually worked.
 *
 * `completed` and `verified` are deliberately separate fields. An agent can
 * finish a turn happily and still have produced the wrong thing; recording that
 * as a model success teaches the router to prefer a model that lies well. The
 * verification verdict is the success signal, the agent's own claim is not.
 */
export interface ModelOutcomeSample {
  /** `provider:model`, or the default route when selection produced none. */
  readonly route: string;
  readonly latencyMs: number;
  /** Verification passed. This is what counts as model success. */
  readonly verified: boolean;
  /** The agent believed it finished. Kept for diagnosis, not for scoring. */
  readonly completed: boolean;
  /** Verification could not decide. Reported so "unknown" is not read as failure. */
  readonly uncertain: boolean;
  readonly tokens: number | undefined;
  readonly costUsd: number | undefined;
  readonly toolCalls: number | undefined;
  readonly attempt: number;
  readonly taskId: string;
  readonly tenantId: string;
  /** The routing decision this attempt ran under, when there was one. */
  readonly decisionId: string | undefined;
}

/**
 * What the loop needs from the outside world.
 *
 * Injected rather than imported so the loop can be tested without booting a
 * whole engine, and so a caller that has no agent must say so explicitly
 * instead of silently getting a no-op.
 */
export interface ExecutionDependencies {
  /**
   * Runs the real agent against the goal. REQUIRED.
   *
   * There is deliberately no default. A default would reintroduce the original
   * bug: a loop that reports success without an agent behind it.
   */
  readonly runAgent: (context: TaskContext) => Promise<AgentRunResult>;

  /** Retrieves relevant memories. Optional; absence is recorded, not faked. */
  readonly recall?: ((context: TaskContext) => Promise<readonly string[]>) | undefined;

  /**
   * Produces a plan. Optional.
   *
   * May return plain descriptions or `PlannedStep`s carrying dependency edges.
   * Both are accepted so existing planners keep working; a planner that only
   * returns strings yields a dependency-free plan rather than one with
   * invented edges.
   */
  readonly plan?:
    | ((context: TaskContext) => Promise<readonly (string | PlannedStep)[]>)
    | undefined;

  /**
   * Understands the goal before any work starts (B2 / P1.2).
   *
   * Extraction (constraints, preferences, risks, deadline, expected artifact,
   * success criteria, missing information, ambiguity) and the
   * ask/think/research/act decision. Optional: a loop with no understanding
   * behaves exactly as before, which is the honest baseline — the goal text,
   * un-understood, is still a goal.
   *
   * "ask" is the one recommendation that changes control flow: the task stops
   * before the attempt loop and the report carries the questions, because
   * running anyway spends the whole attempt budget discovering a question that
   * could have been asked at the start.
   */
  readonly understandGoal?:
    | ((context: TaskContext) => Promise<GoalUnderstanding>)
    | undefined;

  /** Builds verifiers for this specific goal. */
  readonly verifiersFor?: ((context: TaskContext) => Promise<readonly Verifier[]>) | undefined;

  /**
   * Records what the model actually did on one attempt.
   *
   * Without this the model registries only ever learned from outcomes a caller
   * bothered to post by hand, which in practice meant never: `recordOutcome`
   * existed on both `ModelCapabilityRegistry` and `AdaptiveRouter` and nothing
   * on the execution path called either. The result was a router that ranked
   * models on evidence it never collected.
   *
   * Called once per attempt, after verification, with the measured latency and
   * the verification verdict. Optional -- a loop with no registries behind it
   * says so in the report rather than pretending the measurement happened.
   */
  readonly recordModelOutcome?: ((sample: ModelOutcomeSample) => Promise<void> | void) | undefined;

  /**
   * Which capabilities were invoked while this task ran.
   *
   * The loop cannot answer this itself: capabilities are executed by the session
   * actor, several layers down, and nothing carried the names back up. The report
   * therefore used to be silent on what the task actually ran -- it could say a
   * task succeeded and not say what did the work. The capability broker is the
   * authority on execution, so it is asked, through whoever owns it.
   *
   * Called once, when the report is built. Returning an empty list is honest; a
   * task may legitimately invoke nothing.
   */
  readonly invokedCapabilities?: (() => readonly string[]) | undefined;

  /**
   * Audits the run for reward hacking before its verdict is trusted.
   *
   * Optional, and its result can only ever *lower* confidence: a defence
   * system that could upgrade a verdict would be a way to talk the loop into
   * accepting work nothing verified.
   */
  /**
   * Screens the goal before the agent is given it.
   *
   * A rejection stops the attempt rather than annotating it: running an agent
   * on input the security layer has already refused would make the screening
   * advisory.
   */
  /**
   * Chooses the model for this task before the agent runs.
   *
   * Advisory by design: the decision is recorded so a run can be explained, and
   * a caller may act on it, but a selection failure must not fail the task --
   * routing is an optimisation, not a precondition.
   */
  /**
   * Predicts before the agent acts and records the outcome afterwards.
   *
   * Both halves are required and they are deliberately separate calls. A world
   * model that only predicts never finds out it was wrong, and one that only
   * records has nothing to compare against. The surprise and prediction error
   * that make it worth running are computed from the pair.
   *
   * Advisory throughout: a prediction failure must not fail the task.
   */
  /**
   * Proposes goals by analysing the task's workspace.
   *
   * Advisory: a proposal is recorded and nothing acts on it. A system that
   * started work on goals it discovered from a directory listing would be
   * inventing its own tasks.
   */
  /**
   * Matches the task against known cognitive patterns, then grades the match.
   *
   * Two calls, and the order matters. `activate` is what increments a pattern's
   * usage count, and `recordOutcome` divides by it -- so recording an outcome
   * for a pattern that never activated produces a meaningless success rate, and
   * a negative one when the task failed. The record step is therefore skipped
   * entirely when nothing matched.
   *
   * Advisory: a matched pattern is recorded as a hint. It does not replace the
   * agent's work.
   */
  /**
   * Consults a domain expert when the goal touches a regulated domain.
   *
   * The caller decides whether to consult at all, and returning `undefined` is
   * the normal answer: the available domains are all high-risk regulated ones
   * -- legal, finance, health, tax, compliance and similar -- so consulting one
   * about an ordinary task would be noise, and worse, would dress an ordinary
   * task in the language of professional advice it did not need.
   *
   * Advisory, with one part that is not merely advisory: when an expert says the
   * matter requires professional review, that is recorded verbatim rather than
   * summarised away.
   */
  readonly consultDomainExpert?:
    | ((
        context: TaskContext,
      ) => Promise<
        | {
            readonly domain: string;
            readonly expert: string;
            readonly confidence: number;
            readonly requiresProfessionalReview: boolean;
            readonly disclaimers: readonly string[];
          }
        | undefined
      >)
    | undefined;

  readonly cognitiveCore?:
    | {
        readonly activate: (
          context: TaskContext,
        ) => Promise<{
          readonly patternId: string | undefined;
          readonly patternName: string | undefined;
          readonly confidence: number;
        }>;
        readonly record: (
          report: TaskReport,
          patternId: string,
        ) => Promise<void>;
      }
    | undefined;

  readonly discoverGoals?:
    | ((
        context: TaskContext,
      ) => Promise<{
        readonly anomalies: number;
        readonly goals: number;
        readonly verifiers: number;
      }>)
    | undefined;

  readonly worldModel?:
    | {
        readonly predict: (
          context: TaskContext,
        ) => Promise<{ readonly predictionId: string; readonly confidence: number }>;
        readonly record: (
          context: TaskContext,
          report: TaskReport,
          predictionId: string,
        ) => Promise<void>;
      }
    | undefined;

  /**
   * F4 / P1.25: consulted once, before the first attempt, when the caller has
   * bound the task to a multi-world analysis. The gate is where the
   * perspectives' consensus stands in front of execution: a "reject" or "hold"
   * consensus stops the task before any work happens.
   *
   * Fail-closed by contract: a gate that throws blocks the task rather than
   * bypassing the analysis. A perspectives-gate-execution feature that runs
   * the task anyway when its own machinery errors is a rubber stamp wearing
   * the word "gate".
   */
  readonly worldAnalysisGate?:
    | ((
        context: TaskContext,
      ) => Promise<{
        readonly allowed: boolean;
        readonly note: string;
      }>)
    | undefined;

  /**
   * E5 + E6 + E7: the cognitive-attention gate. Runs after the analysis gate
   * (if any) and before the first attempt, enforcing the Global Workspace's
   * budget on the real execution path: mode policy (P1.13), the daily token
   * budget and the focus-slot economy (P1.12).
   *
   * Fail-closed like the analysis gate: attention state that cannot be read
   * is not permission to spend an unknown budget.
   */
  readonly attentionGate?:
    | ((
        context: TaskContext,
      ) => Promise<{
        readonly allowed: boolean;
        readonly note: string;
      }>)
    | undefined;

  /**
   * E2 / P1.9: the internal critic reviews the plan before the first attempt
   * acts on it. "reject" blocks the task (a plan the critic rejects must not
   * be executed as if nothing was said), "revise" reaches the agent through
   * the briefing (the same channel B2's understanding uses), "approve" is
   * recorded. Advisory on errors: a critic that cannot run is a lost review,
   * not a failed task — unlike the gates, this is a reviewer, not an
   * authorizer.
   */
  readonly critiquePlan?:
    | ((
        context: TaskContext,
      ) => Promise<{
        readonly recommendation: "approve" | "revise" | "reject";
        readonly critiques: readonly {
          readonly severity: string;
          readonly description: string;
          readonly suggestion: string;
        }[];
      }>)
    | undefined;

  /**
   * E1 / P1.9: recovery decisions as explicit, competing, outcome-tested
   * hypotheses. `open` is called when a failed attempt's recovery strategy is
   * chosen — the strategy is a bet, and the bet deserves to be written down
   * as one. `test` is called when the NEXT attempt's verification produces a
   * clean verdict: the bet was either supported or refuted. An exit without a
   * clean verdict leaves the hypothesis honestly untested.
   */
  readonly recoveryHypothesis?:
    | {
        readonly open: (info: {
          readonly attempt: number;
          readonly failureKind: string;
          readonly strategy: string;
          readonly rationale: string;
          readonly goal: string;
        }) => Promise<void>;
        readonly test: (info: {
          readonly attempt: number;
          readonly verified: boolean;
          readonly evidence: string;
        }) => Promise<void>;
      }
    | undefined;

  readonly selectModel?:
    | ((
        context: TaskContext,
      ) => Promise<{
        readonly selectedModel: string;
        readonly reason: string;
        readonly confidence: number;
        readonly taskType: string;
        /**
         * The router's id for this decision, when the selector produced one.
         * Carried so the outcome recorded after verification can be attached to
         * the decision that caused it.
         */
        readonly decisionId?: string | undefined;
      }>)
    | undefined;

  readonly screenInput?:
    | ((
        context: TaskContext,
      ) => Promise<{
        readonly allowed: boolean;
        readonly reason: string;
        readonly detections: readonly {
          readonly pattern: string;
          readonly severity: string;
          readonly match: string;
        }[];
      }>)
    | undefined;

  readonly auditOutcome?:
    | ((
        context: TaskContext,
        verification: VerificationReport,
      ) => Promise<{
        readonly overallRisk: "low" | "medium" | "high" | "critical";
        readonly evidenceSupplied: boolean;
        readonly summary: string;
      }>)
    | undefined;

  /** Persists what was learned. */
  readonly learn?: ((context: TaskContext, report: TaskReport) => Promise<void>) | undefined;

  /**
   * Lists what the agent can currently do, so a gap can be named.
   *
   * Without this, gap detection falls back to the failure message alone and
   * says so — it does not pretend the inventory was empty.
   */
  readonly inventory?: (() => Promise<CapabilityInventory>) | undefined;

  /**
   * Offered a detected gap; returns true if it closed it.
   *
   * This is the seam for capability acquisition (spec items 12-16). The loop
   * calls it, records the result honestly, and retries the ORIGINAL task only
   * if the gap was genuinely closed.
   */
  readonly acquireCapability?: ((gap: DetectedGap, context: TaskContext) => Promise<boolean>) | undefined;

  /** Emits a trace event. */
  readonly emit?: ((event: LoopEvent) => Promise<void>) | undefined;
}

export interface AgentRunResult {
  /** Did the agent's own execution complete without throwing? */
  readonly completed: boolean;
  readonly summary: string;
  readonly sessionId?: string | undefined;
  readonly toolCalls?: number | undefined;
  readonly tokens?: number | undefined;
  readonly costUsd?: number | undefined;
  readonly error?: string | undefined;
  /**
   * The tool that failed, when the adapter could name it.
   *
   * `change_tool` needs a subject. Left undefined when no tool errored — the
   * loop then says it could not identify one instead of inventing a switch.
   */
  readonly failedTool?: string | undefined;
  /**
   * Per-step outcomes, when the adapter can attribute work to plan steps.
   *
   * Most adapters cannot: the agent is handed the whole goal and reports once.
   * When this is absent the loop marks executed steps `unverified` rather than
   * `succeeded` — work happened, but nothing proved it was *this* step's work.
   * Inventing a green status per step from a single aggregate result is how a
   * report ends up more confident than the evidence behind it.
   */
  readonly stepResults?:
    | ReadonlyArray<{ id: string; status: ExecutionStatus; detail?: string | undefined }>
    | undefined;
}

export interface LoopEvent {
  readonly type: string;
  readonly taskId: string;
  readonly sessionId?: string | undefined;
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly at: string;
  readonly payload: Record<string, unknown>;
}

export interface TaskReport {
  readonly taskId: string;
  /**
   * The tenant the task ran for (P1.1). The report crosses process boundaries
   * — it is serialized into API responses and stored by callers — and without
   * this field every downstream reader had to be told the tenant out of band,
   * which is exactly how one tenant's report ends up read as another's.
   */
  readonly tenantId: string;
  readonly status: ExecutionStatus;
  readonly goal: string;
  /**
   * Task identity beyond the id (P1.1): who asked, whether this is a sub-task,
   * its scheduling class, its finish-by instant, and which surface produced it.
   * All optional because the primitive does not invent them — a task with no
   * user is system-initiated, and the report says so by omitting the field.
   */
  readonly userId?: string | undefined;
  readonly parentTaskId?: string | undefined;
  readonly priority?: string | undefined;
  readonly deadline?: string | undefined;
  readonly provenance?: TaskContext["provenance"] | undefined;
  /**
   * What was understood about the goal before any work started (B2), when
   * understanding ran. Absent when no understanding dependency was supplied —
   * which is different from "the model read it and found nothing", and the
   * `source` field inside is what distinguishes them.
   */
  readonly understanding?: TaskContext["understanding"] | undefined;
  /**
   * Why the task stopped before starting (B2): the questions a human must
   * answer, machine-readably. Present only on an "ask" stop; a task that ran
   * has no business carrying one.
   */
  readonly clarification?: TaskContext["clarification"] | undefined;
  /**
   * The goal's stated requirements against the verifiers that checked them
   * (B7 / P1.7): each requirement, whether anything checked it, and which
   * verifier said what. Absent when the goal stated no requirements.
   */
  readonly evidence?: TaskContext["evidenceCoverage"] | undefined;
  readonly verification: VerificationReport | undefined;
  readonly attempts: number;
  readonly failures: readonly { classification: FailureClassification; recovery: RecoveryDecision }[];
  /** Capability gaps detected while trying to complete this task. */
  readonly gaps: readonly DetectedGap[];
  readonly outcomes: readonly ExecutionOutcome[];
  /**
   * The plan the task ran under, or `undefined` when no planner was supplied.
   *
   * The plan used to stay inside `TaskContext` and never reach the caller, so
   * "a plan was produced" was only observable as a step count buried in the
   * outcome evidence. Exposing it lets a caller — or an eval — check what was
   * actually planned rather than that planning merely happened.
   */
  readonly plan: TaskContext["plan"];
  readonly spend: TaskContext["spend"];
  readonly durationMs: number;
  readonly trace: TaskContext["trace"];
  readonly summary: string;
  /**
   * Capability ids invoked during this task, in first-use order.
   *
   * The trace cannot substitute for this: it records phase transitions, not
   * actions, so "what did this task run" was previously unanswerable from the
   * report alone. Empty when the task invoked nothing -- which is a real outcome,
   * not a missing measurement.
   */
  readonly capabilitiesInvoked: readonly string[];
  /**
   * Everything the task observed about itself while running: routing decisions,
   * screening results, acquisition attempts.
   *
   * These were recorded onto the context and then lost -- `TaskReport` carried
   * the trace but not the observations, and the only reader took their *count*.
   * The model-routing decision in particular was written here, so a caller could
   * not see which model the loop chose or how confident it was, even though the
   * loop had worked it out.
   */
  readonly observations: TaskContext["observations"];
}

export interface LoopConfig {
  readonly maxAttempts?: number | undefined;
  /**
   * Whether an unverified-but-completed run counts as done.
   *
   * Default false. Turning this on means accepting the agent's own word, which
   * is exactly what the verification layer exists to avoid.
   */
  readonly acceptUnverified?: boolean | undefined;
  /**
   * Model route the first attempt runs on.
   *
   * Recovery needs to know what it is escalating *from*; without it,
   * `change_model` can only produce advice, not a different model.
   */
  readonly modelRoute?: string | undefined;
  /**
   * Routes to escalate through, in order, when a failure is blamed on the model.
   *
   * `ModelRouter.stream()` already walks `[model, ...fallbackModels]` for
   * transport errors. This is the deliberate, per-attempt version of the same
   * move: a reasoning failure is not retried on the model that produced it.
   */
  readonly fallbackModels?: readonly string[] | undefined;
}

/**
 * Failure kinds where something is plausibly *missing*.
 *
 * A timeout or a resource exhaustion is not a capability gap; inferring one
 * would send synthesis off to build something nobody needs.
 */
const GAP_WORTHY = new Set<FailureClassification["kind"]>([
  "tool_gap",
  "skill_gap",
  "knowledge_gap",
  "interface_gap",
  "permission_gap",
  "verification_gap",
]);

/** Wait, so `retry_with_backoff` means what it says. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Critical unknowns in an understanding, for outcome evidence (B2). */
function understandingCount(understanding: GoalUnderstanding): number {
  return understanding.missingInformation.filter((item) => item.critical).length;
}

/**
 * How many times one task may be replanned (B5).
 *
 * Small on purpose. A replan costs a planner call and, if the planner is
 * model-backed, a model call; a task that needs three of them is not suffering
 * from a bad plan, it is suffering from something else, and the attempt budget
 * should go to the work.
 */
const MAX_REPLANS_PER_TASK = 2;

export class UnifiedExecutionLoop {
  /**
   * Index into `context.outcomes` where the final attempt began.
   *
   * Used so the end-of-run cross-check judges the last attempt rather than the
   * whole history: a run that failed, closed a gap and then succeeded must
   * report success.
   */
  private finalAttemptStart = 0;

  constructor(
    private readonly deps: ExecutionDependencies,
    private readonly config: LoopConfig = {},
  ) {
    if (typeof deps.runAgent !== "function") {
      throw new Error(
        "UnifiedExecutionLoop requires a `runAgent` dependency. " +
          "Without one the loop would report outcomes for work no agent performed.",
      );
    }
  }

  async run(init: TaskContextInit): Promise<TaskReport> {
    const context = new TaskContext(init);
    this.finalAttemptStart = 0;
    const maxAttempts = this.config.maxAttempts ?? init.budget?.maxRecoveryAttempts ?? 3;
    const failures: Array<{ classification: FailureClassification; recovery: RecoveryDecision }> = [];
    const gaps: DetectedGap[] = [];

    if (this.config.modelRoute !== undefined) context.modelRoute = this.config.modelRoute;
    if (this.config.fallbackModels !== undefined) {
      context.fallbackModels = [...this.config.fallbackModels];
    }

    // The identity travels with the event (P1.1): a trace consumer that only
    // sees events should not have to call back into the engine to learn who
    // asked for the work or where it came from.
    await this.emit(context, "task.received", {
      goal: context.goal,
      ...(context.userId !== undefined ? { userId: context.userId } : {}),
      ...(context.parentTaskId !== undefined ? { parentTaskId: context.parentTaskId } : {}),
      ...(context.priority !== undefined ? { priority: context.priority } : {}),
      ...(context.deadline !== undefined ? { deadline: context.deadline } : {}),
      ...(context.provenance !== undefined ? { provenance: context.provenance } : {}),
    });

    let lastStatus: ExecutionStatus = "skipped";

    // ── UNDERSTAND: what is actually being asked (B2 / P1.2) ───────────
    //
    // Before this existed the goal went into planning and execution as an
    // opaque string. A task built on a critical unknown ("migrate the
    // database" — which database?) ran anyway and failed at runtime. The
    // understanding runs once, before the attempts, and its recommendation is
    // derived in code — the model extracts, the policy decides.
    if (this.deps.understandGoal) {
      context.enterPhase("observing", "Understanding the goal");
      let understood: GoalUnderstanding | undefined;
      try {
        understood = await this.deps.understandGoal(context);
      } catch (error) {
        // An understanding failure must not become a task failure: the goal
        // text is still a goal. Proceed on the text, visibly un-understood.
        context.observe(
          "understanding",
          `Goal understanding failed, proceeding on the text alone: ${this.messageOf(error)}`,
        );
      }

      if (understood !== undefined) {
        context.understanding = understood;
        context.addOutcome(
          outcome(
            "executed",
            `Understood the goal (source: ${understood.source}): ` +
              `${understood.constraints.length} constraint(s), ` +
              `${understandingCount(understood)} critical unknown(s), ` +
              `ambiguity ${understood.ambiguity.toFixed(2)}, ` +
              `recommendation "${understood.recommendation}"`,
          ),
        );
        context.observe(
          "understanding",
          `Recommendation "${understood.recommendation}"` +
            (understood.source === "fallback" ? ` (fallback: ${understood.fallbackReason ?? "unspecified"})` : ""),
        );

        // What understanding extracted reaches the agent through the briefing
        // it already reads: `context.constraints` is a hard-requirements
        // section there. Constraints pass as-is; preferences are labelled so
        // "hard" does not lie about them. Risks stay on the understanding
        // record — forcing them into a constraints section would mislabel
        // them, and the report already carries them.
        const existing = new Set(context.constraints);
        for (const constraint of understood.constraints) {
          if (!existing.has(constraint)) context.constraints.push(constraint);
        }
        for (const preference of understood.preferences) {
          const entry = `Preference: ${preference}`;
          if (!existing.has(entry)) context.constraints.push(entry);
        }

        // A deadline the caller set outranks one the model read out of the
        // goal text: an explicit instruction beats an inference.
        if (context.deadline === undefined && understood.deadline !== undefined) {
          context.deadline = understood.deadline;
        }

        if (understood.recommendation === "ask") {
          context.clarification = {
            questions: understood.clarifyingQuestions,
            missing: understood.missingInformation.filter((item) => item.critical),
            understanding: understood,
          };
          context.addOutcome(
            outcome(
              "skipped",
              `Not started: ${context.clarification.missing.length} critical unknown(s) need answers first — ` +
                context.clarification.questions.map((q, i) => `(${i + 1}) ${q}`).join(" "),
            ),
          );
          // "blocked", not "failed": nothing went wrong, and "skipped" would
          // read as a decision to pass the task over. It is waiting on
          // answers only a human can give.
          lastStatus = "blocked";
        } else if (understood.recommendation === "research") {
          // The information exists; it has not been gathered. The directive
          // reaches the agent through the briefing like any other constraint.
          const note = "Research needed before acting: " +
            understood.missingInformation
              .filter((item) => item.critical && item.whoCanAnswer === "system")
              .map((item) => item.what)
              .join("; ");
          if (note.trim() !== "Research needed before acting:") context.constraints.push(note);
        } else if (understood.recommendation === "think") {
          context.constraints.push(
            "The goal is ambiguous: restate your interpretation of it before acting, " +
              "then proceed on that interpretation.",
          );
        }
      }
    }

    // ── DISCOVER: what else could be done here ─────────────────────────
    //
    // Runs once, before the attempts, and only when the caller supplied a
    // workspace -- there is nothing to analyse otherwise. The result is recorded
    // and nothing acts on it: discovered goals are a proposal, and acting on
    // them would mean the system assigning itself work from a directory listing.
    if (this.deps.discoverGoals && context.workspace) {
      try {
        const discovery = await this.deps.discoverGoals(context);
        context.observe(
          "goal-discovery",
          `Workspace analysis found ${discovery.anomalies} anomaly/anomalies, ` +
            `proposed ${discovery.goals} goal(s) with ${discovery.verifiers} auto-verifier(s)`,
        );
      } catch (error) {
        // A discovery failure must not fail the task the caller actually asked
        // for. The caller's goal is the task; this is a side observation.
        context.observe(
          "goal-discovery",
          `Workspace analysis failed, so no goals were proposed: ${this.messageOf(error)}`,
        );
      }
    }

    let attempt = 0;
    let verification: VerificationReport | undefined;
    // Held across attempts so the record step can grade the prediction that was
    // actually made. Undefined means no prediction was recorded, in which case
    // there is nothing to grade and the record step is skipped rather than
    // inventing a baseline.
    let lastPredictionId: string | undefined;
    // The cognitive pattern this run matched, if any. Undefined means nothing
    // matched, in which case there is no outcome to grade.
    /** Routing decision behind the current attempt, so its outcome can be attached. */
    let lastDecisionId: string | undefined;
    let lastPatternId: string | undefined;

    // ── GATES (F4 analysis, then E5/E6 attention): may execution start at all
    // ─────────────────────────────────────────────────────────────────
    //
    // Both run once, before any attempt, in a fixed order: authorization
    // (multi-world consensus) first, budget (cognitive attention) second —
    // there is no point budgeting work that is not allowed. "blocked", not
    // "failed": a gate refusal is a decision working as intended. A gate
    // failure is also "blocked" (fail-closed): bypassing a gate because its
    // own machinery errored would make the gate decorative.
    let gateBlocked = false;
    const gates: Array<[string, () => Promise<{ readonly allowed: boolean; readonly note: string }>]> = [];
    if (this.deps.worldAnalysisGate) {
      gates.push(["world-analysis", () => this.deps.worldAnalysisGate!(context)]);
    }
    if (this.deps.attentionGate) {
      gates.push(["attention", () => this.deps.attentionGate!(context)]);
    }
    for (const [source, runGate] of gates) {
      if (gateBlocked) break;
      try {
        const gate = await runGate();
        context.observe(source, gate.note);
        if (!gate.allowed) {
          context.addOutcome(
            outcome(
              "skipped",
              `Not started: the ${source === "world-analysis" ? "multi-world consensus" : "cognitive attention budget"} blocked execution — ${gate.note}`,
            ),
          );
          lastStatus = "blocked";
          gateBlocked = true;
        }
      } catch (error) {
        context.observe(
          source,
          `Gate failed, so the task did not run (fail-closed): ${this.messageOf(error)}`,
        );
        context.addOutcome(
          outcome("skipped", `Not started: the ${source} gate itself failed (fail-closed).`),
        );
        lastStatus = "blocked";
        gateBlocked = true;
      }
    }

    // B2: a task that must ask first does not enter the attempt loop at all.
    // Spending an attempt to discover a question is the failure mode the
    // understanding phase exists to remove.
    while (attempt < maxAttempts && context.clarification === undefined && !gateBlocked) {
      attempt += 1;
      context.spend.recoveryAttempts = attempt - 1;
      this.finalAttemptStart = context.outcomes.length;
      // The agent is told which attempt this is; retrying without saying so
      // invites the same failing move a second time.
      context.attempt = attempt;

      const overBudget = context.budgetExceeded();
      if (overBudget) {
        context.addOutcome(outcome("blocked", `Stopped before attempt ${attempt}: ${overBudget}`));
        lastStatus = "blocked";
        break;
      }

      // ── OBSERVE / UNDERSTAND ─────────────────────────────────────────
      context.enterPhase("observing", `Attempt ${attempt}`);
      context.observe("loop", `Attempt ${attempt} of ${maxAttempts} for: ${context.goal}`);

      // ── RECALL ───────────────────────────────────────────────────────
      context.enterPhase("recalling", "Retrieving relevant memory");
      if (this.deps.recall) {
        try {
          const memories = await this.deps.recall(context);
          context.memories.push(...memories);
          context.addOutcome(
            outcome("executed", `Recalled ${memories.length} memories`, { value: memories.length }),
          );
        } catch (error) {
          context.addOutcome(
            outcome("failed", `Recall failed: ${this.messageOf(error)}`, { error: this.messageOf(error) }),
          );
        }
      } else {
        context.addOutcome(outcome("unavailable", "No recall provider was supplied"));
      }

      // ── PLAN ─────────────────────────────────────────────────────────
      //
      // B4: a plan is produced once per task, not once per attempt. Rebuilding
      // it here used to reset every step to `not_implemented`, so the statuses
      // the previous attempt had just recorded were thrown away before the next
      // one could build on them — measured as `a:unverified(att=1)
      // b:not_implemented c:not_implemented` after three attempts. Re-planning
      // after a failure is a real feature (B5) and it has to preserve finished
      // steps deliberately; silently discarding them is not that feature.
      context.enterPhase("planning", context.plan === undefined ? "Producing a plan" : "Continuing the plan");
      if (context.plan !== undefined) {
        context.addOutcome(
          outcome(
            "executed",
            `Reusing the plan from attempt 1: ${context.plan.steps.filter((step) => step.status !== "not_implemented").length}/${context.plan.steps.length} step(s) already resolved`,
          ),
        );
      } else if (this.deps.plan) {
        try {
          const steps = await this.deps.plan(context);
          const plan = buildPlan(steps);
          context.plan = plan;

          // A plan is only usable if its graph is. Both checks below used to be
          // impossible to make, because the loop flattened plans to strings and
          // discarded the edges the planner had already computed.
          const unresolved = unresolvedDependencies(plan);
          const cycles = cyclicSteps(plan);

          if (steps.length === 0) {
            // An empty plan is a planning failure, not a silent pass. This is
            // the precise shape of the original bug.
            context.addOutcome(outcome("failed", "Planner produced zero steps"));
          } else if (cycles.length > 0) {
            // No step in a cycle can ever become ready, so the plan cannot be
            // executed in any order. Reporting `executed` here would hand the
            // agent a plan guaranteed to stall.
            context.addOutcome(
              outcome("failed", `Plan has a dependency cycle: ${cycles.join(" → ")}`, {
                error: "cyclic_plan",
              }),
            );
          } else if (unresolved.length > 0) {
            context.addOutcome(
              outcome("failed", `Plan depends on unknown steps: ${unresolved.join(", ")}`, {
                error: "unresolved_dependencies",
              }),
            );
          } else {
            const withEdges = plan.steps.filter((step) => step.dependencies.length > 0).length;
            context.addOutcome(
              outcome(
                "executed",
                `Planned ${steps.length} steps (${readySteps(plan).length} ready, ${withEdges} with dependencies)`,
                { value: steps.length },
              ),
            );
          }
        } catch (error) {
          context.addOutcome(
            outcome("failed", `Planning failed: ${this.messageOf(error)}`, { error: this.messageOf(error) }),
          );
        }
      } else {
        context.addOutcome(outcome("unavailable", "No planner was supplied"));
      }

      // ── CRITIQUE (E2 / P1.9): the plan gets reviewed before it is acted on
      //
      // Attempt 1 only, and only when a plan with steps exists — the critic's
      // subject is the plan, not the goal (B2 already handles goals). "reject"
      // stops the task: executing a plan the critic rejected while pretending
      // the review happened would be the rubber-stamp failure mode. "revise"
      // reaches the agent through the briefing, the same channel B2's
      // understanding uses — the critique changes how the plan is executed.
      // Errors are recorded and the task proceeds: a reviewer that cannot run
      // is a lost review, not a failed task.
      if (attempt === 1 && this.deps.critiquePlan && (context.plan?.steps.length ?? 0) > 0) {
        try {
          const critique = await this.deps.critiquePlan(context);
          const summary = `Internal critic: ${critique.recommendation} — ${critique.critiques.length} finding(s)`;
          context.observe("internal-critic", summary);
          if (critique.recommendation === "reject") {
            context.addOutcome(
              outcome(
                "skipped",
                `Not executed: the internal critic rejected the plan — ` +
                  critique.critiques.map((item) => `${item.severity}: ${item.description}`).join("; ").slice(0, 1500),
              ),
            );
            lastStatus = "blocked";
            break;
          }
          if (critique.recommendation === "revise") {
            for (const item of critique.critiques) {
              const line = `Critic (${item.severity}): ${item.description} — ${item.suggestion}`;
              if (!context.constraints.includes(line)) context.constraints.push(line);
            }
            context.addOutcome(
              outcome(
                "executed",
                `Plan revised in briefing: ${critique.critiques.length} critic finding(s) forwarded to the agent`,
              ),
            );
          }
        } catch (error) {
          context.observe(
            "internal-critic",
            `Plan critique failed, so the plan ran unreviewed: ${this.messageOf(error)}`,
          );
        }
      }

      // ── ACT: the real agent ──────────────────────────────────────────
      context.enterPhase("acting", "Running the agent");
      await this.emit(context, "task.acting", { attempt });

      let agentResult: AgentRunResult;
      const actStartedAt = Date.now();

      // ── SCREEN: untrusted input, before anything acts on it ──────────
      //
      // Runs here rather than once at the top of `run()` so a retry is screened
      // again: recovery can reword the goal between attempts, and a screening
      // decision made on attempt 1 says nothing about attempt 2.
      let refusal: string | undefined;
      if (this.deps.screenInput) {
        try {
          const screening = await this.deps.screenInput(context);
          if (!screening.allowed) {
            const detail =
              screening.detections.length > 0
                ? ` (${screening.detections.map((item) => item.pattern).join(", ")})`
                : "";
            refusal = `${screening.reason}${detail}`;
            context.observe(
              "security",
              `Input refused before the agent ran: ${refusal}`,
            );
          }
        } catch (error) {
          // A screening layer that throws must not silently become one that
          // approved everything. Say so, and keep going: the alternative is a
          // security outage taking the whole loop down.
          context.observe(
            "security",
            `Security screening failed, so the input was not cleared: ${this.messageOf(error)}`,
          );
        }
      }

      // ── CONSULT: a domain expert, only when the goal is in their domain
      if (this.deps.consultDomainExpert) {
        try {
          const advice = await this.deps.consultDomainExpert(context);
          if (advice === undefined) {
            context.observe(
              "domain-experts",
              "Goal is not in a regulated domain; no expert consulted",
            );
          } else {
            context.observe(
              "domain-experts",
              `${advice.expert} (${advice.domain}, confidence ` +
                `${advice.confidence.toFixed(2)}): ` +
                (advice.requiresProfessionalReview
                  ? "REQUIRES PROFESSIONAL REVIEW"
                  : "no professional review flagged") +
                (advice.disclaimers.length > 0
                  ? ` -- ${advice.disclaimers[0]}`
                  : ""),
            );
          }
        } catch (error) {
          context.observe(
            "domain-experts",
            `Expert consultation failed: ${this.messageOf(error)}`,
          );
        }
      }

      // ── MATCH: known cognitive patterns, before the agent works from scratch
      if (this.deps.cognitiveCore) {
        try {
          const match = await this.deps.cognitiveCore.activate(context);
          if (match.patternId !== undefined) {
            lastPatternId = match.patternId;
            context.observe(
              "cognitive-core",
              `Matched pattern "${match.patternName}" ` +
                `(confidence ${match.confidence.toFixed(2)})`,
            );
          } else {
            context.observe("cognitive-core", "No known pattern matched this task");
          }
        } catch (error) {
          context.observe(
            "cognitive-core",
            `Pattern matching failed: ${this.messageOf(error)}`,
          );
        }
      }

      // ── PREDICT: before the action, so there is something to be wrong about
      //
      // Runs before the agent rather than after, which is the whole point: a
      // prediction made once the outcome is known is a description.
      if (this.deps.worldModel) {
        try {
          const prediction = await this.deps.worldModel.predict(context);
          lastPredictionId = prediction.predictionId;
          context.observe(
            "world-model",
            `Predicted the task will complete (confidence ` +
              `${prediction.confidence.toFixed(2)}) before attempt ${attempt}`,
          );
        } catch (error) {
          context.observe(
            "world-model",
            `Prediction failed, so no prediction was recorded: ${this.messageOf(error)}`,
          );
        }
      }

      // ── ROUTE: pick the model before paying to run one ───────────────
      //
      // Advisory. The decision is recorded on the context so a run can explain
      // why it used the model it used, and a low-confidence selection is visible
      // rather than looking like a considered choice. A routing failure does not
      // fail the task: routing is an optimisation, not a precondition.
      if (this.deps.selectModel) {
        try {
          const decision = await this.deps.selectModel(context);
          // Kept so the outcome recorded after verification can be attached to
          // the decision that produced it; without the id the router's learned
          // rules could never be fed by real tasks.
          lastDecisionId = decision.decisionId;
          context.observe(
            "routing",
            `Model ${decision.selectedModel} selected for task type ` +
              `"${decision.taskType}" (confidence ${decision.confidence.toFixed(2)}): ` +
              decision.reason,
          );
        } catch (error) {
          context.observe(
            "routing",
            `Model routing failed, so no routing decision was recorded: ${this.messageOf(error)}`,
          );
        }
      }

      if (refusal !== undefined) {
        // The attempt fails through the ordinary failure path, so the taxonomy
        // classifies it and recovery decides what happens next. It is neither
        // swallowed nor reported as a normal run.
        agentResult = {
          completed: false,
          summary: "Blocked by security screening",
          error: refusal,
        };
      } else {
        try {
          agentResult = await this.deps.runAgent(context);
        } catch (error) {
          agentResult = {
            completed: false,
            summary: "Agent threw",
            error: this.messageOf(error),
          };
        }
      }
      const actDurationMs = Date.now() - actStartedAt;

      if (agentResult.sessionId) context.sessionId = agentResult.sessionId;
      if (agentResult.tokens) context.spendTokens(agentResult.tokens);
      if (agentResult.toolCalls) context.spendToolCall(agentResult.toolCalls);
      if (agentResult.costUsd) context.spendCost(agentResult.costUsd);

      context.addOutcome(
        outcome(agentResult.completed ? "executed" : "failed", agentResult.summary, {
          durationMs: actDurationMs,
          error: agentResult.error,
        }),
      );
      context.observe("agent", agentResult.summary);
      this.recordStepProgress(context, agentResult, actDurationMs);

      // Carry this attempt's failure into the next briefing. Without it the
      // retry is identical to the try that just failed, which is how a loop
      // burns three attempts producing the same error three times.
      if (!agentResult.completed) {
        context.priorFailures.push(agentResult.error ?? agentResult.summary);
      }

      // ── VERIFY ───────────────────────────────────────────────────────
      context.enterPhase("verifying", "Checking the result");
      // B6: the pool is fetched once per attempt and shared by both levels —
      // fetching it separately for steps and for the goal would double the
      // side effects of whatever `verifiersFor` does to build its answer.
      const verifierPool = await this.fetchVerifiers(context);
      await this.verifySteps(context, verifierPool);
      verification = await this.verify(context, verifierPool);

      // B7: what did the verifiers actually cover of what the goal asked for?
      // Computed here — after the verdict — because coverage without the
      // verdicts it produced would be half a fact. Recorded, never consulted
      // for control flow: the status rules above are unchanged, and this
      // exists so the report can show what was checked and what was not.
      const requirements = buildEvidenceRequirements(context.understanding);
      if (requirements.length > 0) {
        context.evidenceCoverage = assessEvidenceCoverage(requirements, verifierPool, verification);
        context.observe(
          "verification",
          `Evidence coverage: ${context.evidenceCoverage.checked}/${context.evidenceCoverage.requirements.length} ` +
            `requirement(s) checked` +
            (context.evidenceCoverage.checked < context.evidenceCoverage.requirements.length
              ? `; unchecked: ${context.evidenceCoverage.requirements
                  .filter((a) => a.status === "unchecked")
                  .map((a) => a.requirement.description)
                  .join("; ")}`
              : ""),
        );
      }

      context.addOutcome(
        outcome(verification.status, verification.summary, { durationMs: undefined }),
      );

      // A failed verification is the most useful thing to tell the next
      // attempt: it is concrete, external and reproducible.
      if (verification.verdict === "fail") {
        context.priorFailures.push(`Verification failed: ${verification.summary}`);
      }

      // ── TEST THE RECOVERY HYPOTHESIS (E1 / P1.9) ─────────────────────
      //
      // The previous attempt's recovery strategy was a bet, written down as
      // two competing hypotheses when it was chosen. A clean verdict settles
      // that bet; "uncertain" does not, and is honestly left untested rather
      // than counted for either side. Only graded once at least one recovery
      // has been chosen: attempt 1's own failure has no bet behind it yet.
      if (
        this.deps.recoveryHypothesis &&
        failures.length > 0 &&
        (verification.verdict === "pass" || verification.verdict === "fail")
      ) {
        try {
          await this.deps.recoveryHypothesis.test({
            attempt,
            verified: verification.verdict === "pass",
            evidence: verification.summary,
          });
        } catch (error) {
          context.observe(
            "reasoning",
            `The recovery hypothesis was left ungraded: ${this.messageOf(error)}`,
          );
        }
      }

      await this.emit(context, "task.verified", {
        attempt,
        verdict: verification.verdict,
        tier: verification.strongestTier,
      });

      // ── RECORD WHAT THE MODEL ACTUALLY DID ──────────────────────────
      // Measured here rather than inside the agent because only this point
      // knows both the real latency and whether the result verified. The
      // success signal is the verdict, not the agent's own `completed` flag.
      if (this.deps.recordModelOutcome) {
        const sample: ModelOutcomeSample = {
          route: context.modelRoute ?? "default",
          latencyMs: actDurationMs,
          verified: verification.verdict === "pass",
          completed: agentResult.completed,
          uncertain: verification.verdict === "uncertain",
          tokens: agentResult.tokens,
          costUsd: agentResult.costUsd,
          toolCalls: agentResult.toolCalls,
          attempt,
          taskId: context.taskId,
          tenantId: context.tenantId,
          decisionId: lastDecisionId,
        };
        try {
          await this.deps.recordModelOutcome(sample);
        } catch (error) {
          // Telemetry must not fail the task it is describing. The loss is
          // recorded so a silent hole in the evidence is visible.
          context.observe(
            "routing",
            `Model outcome was not recorded: ${this.messageOf(error)}`,
          );
        }
      }

      // ── BRANCH ───────────────────────────────────────────────────────
      //
      // B4: does the plan still have steps that can start?
      //
      // This governs the *unverified* path only, and the restriction is
      // deliberate. When a verifier says `pass`, the caller's acceptance
      // criterion is met and the task is done — continuing so that Aurora's own
      // decomposition finishes would spend budget the caller did not ask for,
      // and (measured) turn `succeeded` into `failed` once the extra attempts
      // hit recovery. The plan is Aurora's business; the verdict is the
      // caller's.
      const planWalkIncomplete =
        context.plan !== undefined && nextSteps(context.plan).length > 0;

      if (verification.verdict === "pass") {
        lastStatus = "succeeded";
        context.enterPhase("learning", "Recording what worked");
        break;
      }

      if (verification.verdict === "uncertain" && agentResult.completed) {
        // The honest middle: work happened, nothing can confirm it.
        lastStatus = this.config.acceptUnverified ? "executed" : "unverified";
        if (this.config.acceptUnverified && !planWalkIncomplete) {
          break;
        }
      } else {
        lastStatus = "failed";
      }

      // ── ANALYSE FAILURE ──────────────────────────────────────────────
      context.enterPhase("recovering", `Attempt ${attempt} did not verify`);

      const failureMessage =
        agentResult.error ??
        (verification.verdict === "uncertain" ? verification.summary : verification.summary);

      const classification = classifyFailure(failureMessage, { attemptCount: attempt, phase: "verifying" });
      const recovery = chooseRecovery(classification, {
        attemptsUsed: attempt,
        maxAttempts,
        budgetExceeded: context.budgetExceeded(),
      });

      failures.push({ classification, recovery });

      // ── OPEN THE RECOVERY HYPOTHESIS (E1 / P1.9) ──────────────────────
      //
      // "Retry", "replan", "change_model" are bets about why the attempt
      // failed. Written as competing hypotheses, the next attempt's verdict
      // becomes the test that separates them — durable, per-tenant, and
      // queryable, instead of an implicit bet that vanishes with the task.
      if (this.deps.recoveryHypothesis) {
        try {
          await this.deps.recoveryHypothesis.open({
            attempt,
            failureKind: classification.kind,
            strategy: recovery.strategy,
            rationale: recovery.rationale,
            goal: context.goal,
          });
        } catch (error) {
          context.observe(
            "reasoning",
            `The recovery bet was not recorded as a hypothesis: ${this.messageOf(error)}`,
          );
        }
      }

      // ── REPLAN ───────────────────────────────────────────────────────
      //
      // B5. `chooseRecovery` has returned `"replan"` for `skill_gap`,
      // `knowledge_gap` and `planning_failure` since the taxonomy was written,
      // and nothing in this file ever read it: the strategy fell through to a
      // plain retry, so a task whose *plan* was the problem was handed the same
      // plan again. Measured before this existed — three failure messages that
      // classify to `strategy=replan`:
      //
      //     "The plan was invalid: circular dependency between steps"
      //     "The plan was empty"
      //     "I do not know which version is deployed"
      //
      // The directive was already carried into the next briefing, so the agent
      // was *told* to take a different approach while being handed the identical
      // step list. Telling is not doing.
      //
      // Capped, because a planner that keeps producing unusable plans must not
      // be able to spend the whole attempt budget on planning.
      if (recovery.strategy === "replan" && this.deps.plan) {
        if (context.replans >= MAX_REPLANS_PER_TASK) {
          context.addOutcome(
            outcome(
              "skipped",
              `Recovery asked for a replan but this task has already been replanned ` +
                `${context.replans} time(s); continuing with the current plan`,
            ),
          );
        } else {
          context.enterPhase("planning", `Replanning after ${classification.kind}`);
          try {
            const proposed = await this.deps.plan(context);
            const merged = mergeReplan(context.plan ?? { steps: [] }, proposed);
            context.replans += 1;

            if (merged.rejected !== undefined) {
              // Not an abort: the old plan is still walkable and giving up here
              // would turn a planning problem into a task failure. But the
              // refusal is recorded, because "we replanned" and "we could not"
              // are different facts and only one of them is true.
              context.addOutcome(
                outcome("failed", `Replan rejected: ${merged.rejected}`, { error: merged.rejected }),
              );
              context.observe("planning", `Replan rejected: ${merged.rejected}`);
            } else {
              context.plan = merged.plan;
              context.replanReasons.push(classification.kind);
              context.addOutcome(
                outcome(
                  "executed",
                  `Replanned after ${classification.kind}: kept ${merged.kept.length} attempted step(s), ` +
                    `replaced ${merged.replaced.length} unattempted, added ${merged.added.length} new`,
                  { value: merged.added.length },
                ),
              );
              context.observe(
                "planning",
                `Replan ${context.replans} after ${classification.kind}: kept [${merged.kept.join(", ")}], ` +
                  `dropped [${merged.replaced.join(", ")}], added [${merged.added.join(", ")}]`,
              );
              await this.emit(context, "task.replanned", {
                attempt,
                reason: classification.kind,
                replan: context.replans,
                kept: merged.kept,
                replaced: merged.replaced,
                added: merged.added,
              });
            }
          } catch (error) {
            context.addOutcome(
              outcome("failed", `Replanning failed: ${this.messageOf(error)}`, {
                error: this.messageOf(error),
              }),
            );
          }
        }
      }

      // ── DETECT GAP ───────────────────────────────────────────────────
      // Only worth doing when the failure suggests something is missing.
      // Running it on, say, a timeout would manufacture a gap that is not there.
      if (GAP_WORTHY.has(classification.kind)) {
        const inventory = this.deps.inventory
          ? await this.deps.inventory().catch(() => undefined)
          : undefined;

        const report = detectGaps({
          goal: context.goal,
          inventory: inventory ?? { capabilityIds: [] },
          failureKind: classification.kind,
          failureMessage,
        });

        for (const gap of report.gaps) {
          if (!gaps.some((existing) => existing.missing === gap.missing)) gaps.push(gap);
        }

        if (report.gaps.length > 0) {
          context.addOutcome(
            outcome("executed", `Gap detection: ${report.summary}`, { value: report.gaps.length }),
          );
          await this.emit(context, "task.gap.detected", {
            attempt,
            gaps: report.gaps.map((gap) => ({ missing: gap.missing, type: gap.type, confidence: gap.confidence })),
            inventoryKnown: inventory !== undefined,
          });
        }

        // ── ACQUIRE CAPABILITY → RETRY ORIGINAL TASK ───────────────────
        if (recovery.strategy === "acquire_capability" && report.actionable) {
          if (!this.deps.acquireCapability) {
            // The gap is named and actionable, but nothing can build it. Say
            // exactly that instead of retrying an action that cannot work.
            context.addOutcome(
              outcome(
                "unavailable",
                `Gap '${report.actionable.missing}' identified but no capability-acquisition provider is wired. ` +
                  `Retrying would fail identically.`,
              ),
            );
            lastStatus = "failed";
            break;
          }

          const acquired = await this.deps
            .acquireCapability(report.actionable, context)
            .catch(() => false);

          context.addOutcome(
            outcome(
              acquired ? "executed" : "failed",
              acquired
                ? `Acquired capability '${report.actionable.missing}'; retrying the original task`
                : `Could not acquire capability '${report.actionable.missing}'`,
            ),
          );

          await this.emit(context, "task.capability.acquisition", {
            attempt,
            missing: report.actionable.missing,
            acquired,
          });

          if (!acquired) {
            lastStatus = "failed";
            break;
          }
          // Acquired: fall through to the next iteration, which re-runs the
          // ORIGINAL goal — the point of the whole exercise.
          continue;
        }
      }
      context.fail("verifying", failureMessage, {
        category: classification.kind,
        recoverable: recovery.canContinue,
      });

      // A verification gap is not fixed by doing the work again. The agent
      // completed; what is missing is a way to check it. Re-running would
      // produce the same unverifiable result and spend the budget twice, so
      // the loop stops and reports the honest answer instead.
      //
      // B4 carved out one exception, and it is not a softening of the rule
      // above. When the plan still has steps that can start, another pass is
      // not a repeat of the work that just went unverified — it is the *next*
      // step, which has not been attempted at all. Stopping here is what made a
      // three-step chain end with two steps `not_implemented`.
      if (recovery.strategy === "add_verification" && agentResult.completed && !planWalkIncomplete) {
        context.addOutcome(
          outcome(
            "unverified",
            "Stopped retrying: the work completed but no verifier exists for it. " +
              "Repeating the work cannot make it verifiable.",
          ),
        );
        lastStatus = "unverified";
        await this.emit(context, "task.verification.gap", {
          attempt,
          reason: "no verifier available; retry would not change the outcome",
        });
        break;
      }

      await this.emit(context, "task.failure.classified", {
        attempt,
        kind: classification.kind,
        confidence: classification.confidence,
        strategy: recovery.strategy,
        canContinue: recovery.canContinue,
      });

      if (!recovery.canContinue) {
        context.addOutcome(
          outcome(
            recovery.strategy === "abort" ? "blocked" : "failed",
            `Recovery stopped: ${recovery.rationale}`,
          ),
        );
        break;
      }

      // ── APPLY THE RECOVERY DECISION ──────────────────────────────────
      // Without this, every continuable strategy did the same thing: run the
      // same agent on the same input. `replan` did not replan, `reduce_scope`
      // reduced nothing, and `retry_with_backoff` never waited. The strategy
      // was a label on a report rather than a change in behaviour.
      context.recoveryDirective = recovery.directive;

      // `change_tool` used to be advice only. Now the failing tool is named
      // and carried forward, so the next attempt can steer away from it.
      if (recovery.strategy === "change_tool") {
        const failedTool = agentResult.failedTool;
        if (failedTool !== undefined && !context.avoidTools.includes(failedTool)) {
          context.avoidTools.push(failedTool);
          await this.emit(context, "task.recovery.tool_avoided", { attempt, tool: failedTool });
        } else if (failedTool === undefined) {
          // The interface failed but no tool could be named. Saying "switched
          // tools" here would be a recovery that never happened; the agent is
          // told to re-check the interface instead.
          context.addOutcome(
            outcome(
              "executed",
              "Interface failure, but could not identify a specific tool to avoid; " +
                "the next attempt is told to re-check the interface rather than switch blindly.",
            ),
          );
          await this.emit(context, "task.recovery.tool_unidentified", { attempt });
        }
      }

      // `change_model` used to be advice only. The route actually moves now,
      // so the next attempt does not re-run the model that just failed.
      if (recovery.strategy === "change_model") {
        const previous = context.modelRoute;
        const next = context.escalateModel();
        if (next === undefined) {
          // No alternative exists. Say so — a report claiming a model change
          // that did not happen is the same lie as a fabricated success.
          context.addOutcome(
            outcome(
              "failed",
              `No alternative model to escalate to (still on ${previous ?? "the default route"}); ` +
                "retrying the same model is unlikely to help.",
            ),
          );
          await this.emit(context, "task.recovery.model_exhausted", {
            attempt,
            route: previous ?? null,
          });
        } else {
          await this.emit(context, "task.recovery.model_changed", {
            attempt,
            from: previous ?? null,
            to: next,
          });
        }
      }

      if (recovery.backoffMs !== undefined && recovery.backoffMs > 0) {
        await this.emit(context, "task.recovery.backoff", {
          attempt,
          waitMs: recovery.backoffMs,
          reason: classification.kind,
        });
        await sleep(recovery.backoffMs);
      }
    }

    // ── LEARN ──────────────────────────────────────────────────────────
    const report = this.buildReport(context, lastStatus, verification, attempt, failures, gaps);

    // ── RECORD: what actually happened, against what was predicted ─────
    //
    // The other half of the world model. Without this the prediction is never
    // compared to anything and the model cannot compute surprise, which is the
    // only thing it learns from.
    // Grade the matched pattern against what actually happened. Skipped when
    // nothing matched: `recordOutcome` divides by the usage count that only
    // `activate` increments, so grading an un-activated pattern would write a
    // nonsense -- and on failure, negative -- success rate into the store.
    if (this.deps.cognitiveCore && lastPatternId !== undefined) {
      try {
        await this.deps.cognitiveCore.record(report, lastPatternId);
      } catch (error) {
        context.observe(
          "cognitive-core",
          `Recording the pattern outcome failed: ${this.messageOf(error)}`,
        );
      }
    }

    if (this.deps.worldModel && lastPredictionId !== undefined) {
      try {
        await this.deps.worldModel.record(context, report, lastPredictionId);
      } catch (error) {
        context.observe(
          "world-model",
          `Recording the outcome failed, so the prediction was left ungraded: ${this.messageOf(error)}`,
        );
      }
    }

    if (this.deps.learn) {
      try {
        await this.deps.learn(context, report);
      } catch {
        // Learning must never change the verdict of the task it learned from.
      }
    }

    context.enterPhase("idle", `Finished as ${report.status}`);
    await this.emit(context, report.status === "succeeded" ? "task.completed" : "task.failed", {
      status: report.status,
      attempts: attempt,
      // J1 (P1.44): task outcomes must carry who asked for the work so the
      // user-model wiring can attribute signals without guessing.
      ...(context.userId !== undefined ? { userId: context.userId } : {}),
    });

    return report;
  }

  /**
   * Fetch this attempt's verifier pool (B6).
   *
   * Extracted from `verify` so step verification and goal verification share
   * one fetch. A `verifiersFor` that throws must not take the attempt with it:
   * the honest fallback is an empty pool, which leaves everything `unverified`
   * — the same answer as when no verifier was ever supplied.
   */
  private async fetchVerifiers(context: TaskContext): Promise<readonly Verifier[]> {
    if (!this.deps.verifiersFor) return [];
    try {
      return await this.deps.verifiersFor(context);
    } catch (error) {
      context.observe("verification", `Could not build verifiers: ${this.messageOf(error)}`);
      return [];
    }
  }

  /**
   * Verify the plan's steps against their own criteria (B6).
   *
   * Measured before this existed: a task whose goal was "create hello.txt with
   * Hi" ran a goal-scoped verifier that confirmed "hello.txt contains Hi" and
   * reported `succeeded` — while the step that wrote the file stayed
   * `unverified`, because the evidence existed only at the goal level and
   * nothing attached it to the step that produced the work.
   *
   * Rules, in the order they matter:
   *
   *  - Only `unverified` steps are checked. A step the adapter already
   *    attributed (succeeded/failed) has a status from someone closer to the
   *    work; `not_implemented` steps have nothing to check yet.
   *  - The panel comes from `selectStepVerifiers`: verifiers that declared they
   *    can evaluate this step's claim. No panel → the step stays `unverified`
   *    and, when it declared a criterion, that fact is observed rather than
   *    swallowed.
   *  - `pass` upgrades the step to `succeeded` — a *checked* success, recorded
   *    in `step.verification`. `fail` marks it `failed` and blocks its
   *    dependants from now on, which is the difference between a refuted step
   *    and an unconfirmed one. `uncertain` changes nothing except the record.
   *  - This never spends agent attempts and never overrides the goal verdict:
   *    the caller's acceptance criterion still ends the task (the B4
   *    regression is one test away, and it stays).
   */
  private async verifySteps(context: TaskContext, pool: readonly Verifier[]): Promise<void> {
    const plan = context.plan;
    if (plan === undefined || plan.steps.length === 0 || pool.length === 0) return;

    const candidates = plan.steps.filter((step) => step.status === "unverified");
    let changed = false;
    for (const step of candidates) {
      const panel = selectStepVerifiers(step, pool);
      if (panel.length === 0) {
        if (step.successCriterion !== undefined) {
          context.observe(
            "verification",
            `Step "${step.id}" declares a success criterion but no verifier applies to it, ` +
              `so it stays unverified`,
          );
        }
        continue;
      }

      const factory = new VerificationFactory();
      for (const verifier of panel) factory.register(verifier);
      const claim = step.successCriterion ?? step.description;

      let report;
      try {
        report = await factory.verify(claim);
      } catch (error) {
        // A panel that throws has not passed. Recorded, not swallowed.
        context.observe(
          "verification",
          `Step "${step.id}" could not be verified: ${this.messageOf(error)}`,
        );
        continue;
      }

      const names = report.results.map((result) => result.verifier);
      step.verification = {
        attempt: context.attempt,
        verdict: report.verdict,
        verifiers: names,
        ...(report.strongestTier !== undefined ? { strongestTier: report.strongestTier } : {}),
        summary: report.summary,
        at: new Date().toISOString(),
      };

      if (report.verdict === "pass") {
        markStep(plan, step.id, "succeeded", `Verified by ${names.join(", ")}: ${report.summary}`);
        changed = true;
        context.observe("verification", `Step "${step.id}" verified by ${names.join(", ")}`);
      } else if (report.verdict === "fail") {
        markStep(
          plan,
          step.id,
          "failed",
          `Refuted by ${names.join(", ")}: ${report.summary}`,
        );
        changed = true;
        // The most useful thing to tell the next attempt: concrete, external
        // and reproducible, exactly like a failed goal verification.
        context.priorFailures.push(`Step "${step.id}" was refuted: ${report.summary}`);
        context.observe("verification", `Step "${step.id}" refuted by ${names.join(", ")}`);
      } else {
        step.detail = `Step verification was uncertain: ${report.summary}`;
      }
    }

    // A refuted step changes which dependants can still run, so reachability
    // has to be re-derived here too — `recordStepProgress` already did it, but
    // it ran before these statuses existed.
    if (changed) blockUnreachable(plan);
  }

  private async verify(context: TaskContext, pool: readonly Verifier[]): Promise<VerificationReport> {
    const factory = new VerificationFactory();

    for (const verifier of pool) factory.register(verifier);

    // With no verifiers this returns `uncertain`, which is correct and is the
    // whole point: nothing checked the work, so nothing may claim it passed.
    const verification = await factory.verify(context.goal);

    // Evidence about the wrong thing is not evidence.
    //
    // A toolchain verifier proves the workspace still builds and its suite still
    // passes. That is necessary and it is not sufficient: measured on this very
    // path, a task whose goal was to create a file reported `succeeded` with
    // verification `pass` while the file did not exist, because the build was the
    // only thing anybody checked.
    //
    // So a `pass` built entirely out of workspace-scope evidence is reported as
    // `uncertain`, with the reason stated. It is not reported as `fail` -- the
    // workspace really is sound -- and it is not left as `pass`, because nothing
    // checked the goal. A caller who wants a stronger claim supplies a
    // goal-scoped verifier, which is what `input.verifiers` is for.
    const goalScopedPass = verification.results.some(
      (result) => result.scope === "goal" && result.verdict === "pass",
    );
    if (verification.verdict === "pass" && !goalScopedPass) {
      const names = verification.results
        .filter((result) => result.verdict === "pass")
        .map((result) => result.verifier);
      return {
        ...verification,
        verdict: "uncertain",
        status: "unverified",
        summary:
          `${verification.summary} — downgraded to uncertain: the evidence is ` +
          `workspace-scoped (${names.join(", ")}), so it shows the workspace is ` +
          `sound but not that the goal "${context.goal}" was achieved`,
      };
    }

    if (!this.deps.auditOutcome) return verification;

    // Reward-hacking defence. This is where it belongs: the moment a verdict is
    // about to be trusted is the moment it should be checked for being gamed.
    //
    // A `pass` can be a pass for the wrong reason. Measured on this very path
    // before the defence was wired: a task whose goal was to create a file
    // reported `succeeded` with verification `pass` while the file did not
    // exist, because the verifier checked the build and not the goal. Nothing
    // in the loop could see that.
    //
    // The audit can only lower confidence, never raise it, and it never
    // fabricates a `fail`: an unexplained downgrade to `uncertain` says "this
    // could not be confirmed", which is what a suspicious pass actually is.
    try {
      const audit = await this.deps.auditOutcome(context, verification);
      context.observe("verification", audit.summary);

      const risky = audit.overallRisk === "high" || audit.overallRisk === "critical";
      if (risky && verification.verdict === "pass") {
        return {
          ...verification,
          verdict: "uncertain",
          status: "unverified",
          summary: `${verification.summary} — downgraded to uncertain by ${audit.summary}`,
        };
      }
    } catch (error) {
      // A defence that throws must not silently become a defence that passed.
      context.observe(
        "verification",
        `Reward-hacking defence failed, so its verdict was not applied: ${this.messageOf(error)}`,
      );
    }

    return verification;
  }

  private buildReport(
    context: TaskContext,
    status: ExecutionStatus,
    verification: VerificationReport | undefined,
    attempts: number,
    failures: ReadonlyArray<{ classification: FailureClassification; recovery: RecoveryDecision }>,
    gaps: readonly DetectedGap[],
  ): TaskReport {
    // Cross-check the narrative status against the accumulated evidence, so a
    // headline of "succeeded" cannot outrun what actually happened.
    //
    // Scope matters here. Earlier attempts are *expected* to contain failures —
    // that is what recovery is for. Judging the whole run by every outcome ever
    // recorded would mean a task that failed, acquired the missing capability
    // and then succeeded still reported `failed`, which punishes the recovery
    // loop for doing its job. Only evidence from the final attempt can
    // contradict the final verdict.
    const finalAttemptOutcomes = context.outcomes.slice(this.finalAttemptStart);
    const aggregated = aggregate(finalAttemptOutcomes);
    const finalStatus: ExecutionStatus =
      status === "succeeded" && aggregated === "failed" ? "failed" : status;

    return {
      taskId: context.taskId,
      tenantId: context.tenantId,
      userId: context.userId,
      parentTaskId: context.parentTaskId,
      priority: context.priority,
      deadline: context.deadline,
      provenance: context.provenance,
      ...(context.understanding !== undefined ? { understanding: context.understanding } : {}),
      ...(context.clarification !== undefined ? { clarification: context.clarification } : {}),
      ...(context.evidenceCoverage !== undefined ? { evidence: context.evidenceCoverage } : {}),
      status: finalStatus,
      goal: context.goal,
      verification,
      attempts,
      failures,
      gaps,
      outcomes: context.outcomes,
      plan: context.plan,
      spend: context.spend,
      durationMs: context.elapsedMs,
      trace: context.trace,
      summary: this.summarise(
        finalStatus,
        verification,
        attempts,
        failures,
        context.plan,
        { count: context.replans, reasons: context.replanReasons },
        evidenceCoverageNote(context.evidenceCoverage),
      ),
      capabilitiesInvoked: this.deps.invokedCapabilities ? [...this.deps.invokedCapabilities()] : [],
      observations: context.observations,
    };
  }

  /**
   * Give every plan step the truest status the evidence supports.
   *
   * Three cases, in descending order of evidence:
   *
   *  - The adapter attributed outcomes to steps → use them verbatim.
   *  - The agent ran and finished → steps that were ready are `unverified`.
   *    Work happened, but nothing tied it to a specific step, and `succeeded`
   *    would claim more than is known.
   *  - The agent failed → nothing is marked done; `blockUnreachable` then
   *    distinguishes steps that were blocked from steps never reached.
   *
   * The temptation is to mark ready steps `succeeded` when the agent reports
   * completion. That is precisely the inference that produced "10/10, score
   * 1.0" from an agent that never ran.
   */
  /**
   * Apply one attempt's result to the plan (B4).
   *
   * What this used to do: if the adapter attributed work to steps, copy those
   * statuses across; otherwise, if the agent completed, mark every *ready* step
   * `unverified`. The second branch is why plans stalled — `readySteps()` gates
   * on `isSuccess`, so an `unverified` step never satisfied its dependants and
   * the rest of the graph stayed `not_implemented` forever. Measured on a
   * three-step chain: `a=unverified b=not_implemented c=not_implemented`, next
   * ready `(none)`, for a task the agent had finished.
   *
   * `advancePlan` decides the marks; this only applies them and records the
   * evidence, so the loop stays the single writer of a plan.
   */
  private recordStepProgress(
    context: TaskContext,
    result: AgentRunResult,
    durationMs: number,
  ): void {
    const plan = context.plan;
    if (plan === undefined || plan.steps.length === 0) return;

    const marks = advancePlan(plan, {
      attempt: context.attempt,
      completed: result.completed,
      summary: result.summary,
      ...(result.error ? { error: result.error } : {}),
      durationMs,
      ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
      ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
      ...(result.stepResults ? { stepResults: result.stepResults } : {}),
    });

    for (const mark of marks) {
      markStep(plan, mark.id, mark.status, mark.detail);
      const step = plan.steps.find((candidate) => candidate.id === mark.id);
      if (step) {
        step.evidence = mark.evidence;
        // Retries are visible per step, not just per task: a step that took
        // three attempts to get anywhere is a different thing from one that
        // worked first time, and the final status alone does not say which.
        step.attempts = (step.attempts ?? 0) + 1;
      }
    }

    if (marks.length > 0) {
      context.observe(
        "planning",
        `Step walk, attempt ${context.attempt}: ` +
          marks.map((mark) => `${mark.id}=${mark.status}`).join(", "),
      );
    }

    // Steps whose prerequisites can no longer succeed are blocked, not failed:
    // they never got their turn. Runs after every attempt so a later attempt
    // can still unblock them.
    blockUnreachable(plan);
  }

  private summarise(
    status: ExecutionStatus,
    verification: VerificationReport | undefined,
    attempts: number,
    failures: ReadonlyArray<{ classification: FailureClassification; recovery: RecoveryDecision }>,
    plan: TaskContext["plan"],
    replan: { count: number; reasons: readonly string[] },
    evidenceNote: string,
  ): string {
    // Plan progress belongs in the sentence a human reads. A report that says
    // "succeeded" while four of six steps were never reached is technically
    // true about the goal and misleading about the work.
    const planNote = ((): string => {
      if (plan === undefined || plan.steps.length === 0) return "";
      const counts = planSummary(plan);
      const parts = [`${counts.total} step(s)`];
      if (counts.succeeded > 0) parts.push(`${counts.succeeded} succeeded`);
      if (counts.failed > 0) parts.push(`${counts.failed} failed`);
      if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
      if (counts.unverified > 0) parts.push(`${counts.unverified} unverified`);
      if (counts.untouched > 0) parts.push(`${counts.untouched} not attempted`);
      // A plan that changed mid-task must say so, or "3 step(s)" reads as one
      // plan's worth of work when it is the residue of two (B5).
      if (replan.count > 0) {
        const reasons = [...new Set(replan.reasons)].join(", ");
        parts.push(`replanned ${replan.count} time(s) after ${reasons}`);
      }
      return ` Plan: ${parts.join(", ")}.`;
    })();

    if (status === "succeeded") {
      return `Verified after ${attempts} attempt(s). ${verification?.summary ?? ""}${evidenceNote}${planNote}`.trim();
    }
    if (status === "unverified") {
      return (
        `The agent completed its run but nothing could confirm the result, so this is not reported ` +
        `as success. ${verification?.summary ?? ""}${evidenceNote}${planNote}`
      ).trim();
    }
    if (status === "executed") {
      // Only the acceptUnverified path sets "executed" (grep-verified), so
      // this sentence names the actual reason: the agent's word, accepted by
      // configuration. Hiding that behind "ran to completion" would make a
      // policy choice look like a measurement.
      return (
        `Accepted on the agent's word (acceptUnverified): the run finished but nothing could ` +
        `confirm the result. ${verification?.summary ?? ""}${evidenceNote}${planNote}`
      ).trim();
    }
    const last = failures[failures.length - 1];
    if (last) {
      return `Stopped after ${attempts} attempt(s) as ${status}: ${last.classification.kind} — ${last.recovery.rationale}${planNote}`;
    }
    return `Stopped after ${attempts} attempt(s) as ${status}.${planNote}`;
  }

  private async emit(context: TaskContext, type: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.deps.emit) return;
    try {
      await this.deps.emit({
        type,
        taskId: context.taskId,
        sessionId: context.sessionId,
        traceId: context.traceId,
        correlationId: context.correlationId,
        causationId: randomUUID(),
        at: new Date().toISOString(),
        payload,
      });
    } catch {
      // An observer must not be able to fail the thing it observes.
    }
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

// ═══ P3.3: ablation — measure what each layer actually contributes ═══

/**
 * Which dependency keys each ablation flag removes. An ablation study is only
 * honest if removing the flag measurably removes the layer: every entry here
 * maps to an observable difference in the TaskReport (no "Recalled" outcome,
 * no "Planned" outcome, no verification, no routing observation, ...), and the
 * benchmark tests assert those differences rather than trusting the flag.
 */
export const ABLATION_FLAGS = {
  /** Memory recall into the task context. */
  memory: ["recall"],
  /** The cognitive planner. */
  planning: ["plan"],
  /** Verifier discovery and caller-supplied verifiers. */
  verification: ["verifiersFor"],
  /** Pre-action prediction and outcome recording. */
  "world-model": ["worldModel"],
  /** Model selection before the agent runs. */
  "adaptive-routing": ["selectModel"],
  /** Cognitive pattern matching. */
  "cognitive-core": ["cognitiveCore"],
  /** Post-task learning and capability acquisition. */
  "self-improvement": ["learn", "acquireCapability"],
  /** Workspace goal discovery. */
  "goal-discovery": ["discoverGoals"],
  /** Regulated-domain expert consultation. */
  "domain-expert": ["consultDomainExpert"],
} as const satisfies Record<string, readonly string[]>;

export type AblationFlag = keyof typeof ABLATION_FLAGS;

/**
 * Removes the dependency keys named by the ablation flags, in place — the
 * engine builds a fresh dependency object per task, so there is no shared
 * state to corrupt. An unknown flag throws with the list of known flags: a
 * typo silently ablating nothing would produce a benchmark that measures the
 * full system five times and calls it an ablation study.
 */
export function ablateExecutionDependencies(
  deps: ExecutionDependencies,
  flags: readonly string[] | undefined,
): ExecutionDependencies {
  if (!flags || flags.length === 0) return deps;
  for (const flag of flags) {
    const keys: readonly string[] | undefined = (ABLATION_FLAGS as Record<string, readonly string[]>)[flag];
    if (!keys) {
      throw new Error(
        `Unknown ablation flag "${flag}". Known flags: ${Object.keys(ABLATION_FLAGS).join(", ")}.`,
      );
    }
    for (const key of keys) {
      delete (deps as unknown as Record<string, unknown>)[key];
    }
  }
  return deps;
}
