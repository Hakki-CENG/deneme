/**
 * TaskContext — everything one task knows, owned by that task alone.
 *
 * The problem this solves: `engine.cognitiveState` is a single instance shared
 * by every task in the process. `MetaController` calls `setMode("planning")`,
 * `UnifiedCognitiveLoop` keeps `eventsEmitted` and `recoveryAttempts` as
 * class-level fields. Two concurrent tasks therefore overwrite each other's
 * mode, and a recovery in task B increments a counter task A will report.
 *
 * The fix is ownership, not locking. State that belongs to one execution lives
 * in a value created at the start of that execution and discarded at the end.
 *
 *     Engine
 *      └── Tenant
 *           └── Session
 *                └── Task
 *                     └── CognitiveContext
 */

import { createHash, randomUUID } from "node:crypto";

import type { ExecutionOutcome, ExecutionStatus } from "./execution-status.js";
import { canonicalJson } from "../util/canonical-json.js";

/** Cognitive phase of the main loop. */
export type CognitivePhase =
  | "observing"
  | "understanding"
  | "recalling"
  | "planning"
  | "acting"
  | "verifying"
  | "learning"
  | "recovering"
  | "idle";

/** Spend limits for one task. Absent means unlimited, which is rarely right. */
export interface TaskBudget {
  readonly tokens?: number | undefined;
  readonly timeMs?: number | undefined;
  readonly toolCalls?: number | undefined;
  readonly costUsd?: number | undefined;
  /** How many recovery attempts before giving up. Prevents infinite loops. */
  readonly maxRecoveryAttempts?: number | undefined;
}

/** What has actually been spent. */
export interface BudgetSpend {
  tokens: number;
  timeMs: number;
  toolCalls: number;
  costUsd: number;
  recoveryAttempts: number;
}

export interface Observation {
  readonly at: string;
  readonly source: string;
  readonly summary: string;
  readonly detail?: unknown;
}

export interface RecordedFailure {
  readonly at: string;
  readonly phase: CognitivePhase;
  readonly message: string;
  /** Set once the failure has been classified by the taxonomy. */
  readonly category?: string | undefined;
  readonly recoverable?: boolean | undefined;
}

/**
 * One step of a task plan.
 *
 * Named `TaskPlanStep` rather than `PlanStep` because `aurora/planning-service`
 * already exports a different `PlanStep` with its own lifecycle vocabulary
 * (`pending`/`ready`/`in-progress`/...). Two types with one name would have
 * forced every reader to work out which was meant.
 *
 * Steps carry `dependencies` because the planner already computes them —
 * `PlanningEngine.decomposeGoal` returns a real DAG — and the execution loop
 * used to throw that structure away, flattening every plan to a list of
 * strings. A plan without edges cannot tell you whether step 4 was skipped
 * because it failed or because step 2 never produced what it needed.
 */
export interface TaskPlanStep {
  /** Stable within a plan; `dependencies` refer to these. */
  readonly id: string;
  readonly description: string;
  /**
   * Ids of steps that must reach a successful status first.
   *
   * Empty means the step is immediately eligible.
   */
  readonly dependencies: readonly string[];
  /**
   * Starts as `not_implemented` — "no execution has been attempted".
   *
   * Deliberately not `skipped`: `skipped` is a decision, and a step nobody has
   * looked at yet has not been decided about. The two used to be conflated,
   * which made every plan in every report read as if it had been considered
   * and passed over.
   */
  status: ExecutionStatus;
  /** Why the step ended in its status. Absent while untouched. */
  detail?: string | undefined;
  /**
   * The record behind the current status, when something actually ran this step
   * (B4). Absent until then.
   */
  evidence?: TaskPlanStepEvidence | undefined;
  /**
   * How many attempts touched this step (B4). Absent until one does, so "never
   * attempted" stays distinguishable from "attempted once".
   */
  attempts?: number | undefined;
  /**
   * What must be true afterwards for this step to count as done (B6).
   *
   * Absent when the planner specified nothing. A missing criterion does not
   * block execution — it blocks *confirmation*: there is nothing for a
   * verifier to check, so the step can never honestly say `succeeded`.
   */
  successCriterion?: string | undefined;
  /**
   * The verification record behind a step's status, when something checked it
   * (B6). Absent while nothing has.
   *
   * `evidence` records what *ran*; this records what was *checked*. They are
   * different facts and collapsing them is how "the agent said it worked"
   * becomes "it was verified".
   */
  verification?: StepVerificationRecord | undefined;

}

/**
 * What a verifier panel concluded about one plan step (B6).
 *
 * The step's `evidence` stays the record of the work; this is the record of
 * the check — which verifiers ran, what they concluded together, and on which
 * attempt. A step marked `succeeded` with one of these is a *checked* success;
 * without one it is the adapter's word.
 */
export interface StepVerificationRecord {
  /** Which attempt's work was checked. */
  readonly attempt: number;
  /** The combined verdict of the verifier panel. */
  readonly verdict: "pass" | "fail" | "uncertain";
  /** Every verifier that ran for this step, by name. */
  readonly verifiers: readonly string[];
  /** Strongest tier that contributed a definite verdict, when one did. */
  readonly strongestTier?: string | undefined;
  /** The panel's own summary of its evidence. */
  readonly summary: string;
  readonly at: string;
}

export interface TaskPlan {
  readonly steps: TaskPlanStep[];
}

/**
 * What backs a step's status (B4).
 *
 * A step status on its own is a claim. This is the record behind it: which
 * attempt produced it, what the agent said, how long it took, what it cost, and
 * what went wrong. Optional because the keyword skeleton's steps have no
 * evidence until something runs them, and inventing some would be worse than
 * leaving the field absent.
 */
export interface TaskPlanStepEvidence {
  readonly attempt: number;
  readonly actor?: string | undefined;
  readonly detail?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly tokens?: number | undefined;
  readonly toolCalls?: number | undefined;
  readonly error?: string | undefined;
  readonly at: string;
}

export interface TraceEntry {
  readonly at: string;
  readonly phase: CognitivePhase;
  readonly event: string;
  readonly detail?: unknown;
  /** Links this entry to the event that caused it. */
  readonly causationId?: string | undefined;
}

/**
 * Where a task entered the system (P1.1 / B1).
 *
 * The list is the set of surfaces the architecture documents as task sources.
 * `internal` covers work the engine starts on its own behalf (recovery
 * sub-tasks, delegation), which is a real source and not a fallback: labelling
 * it `api` would be a lie about provenance.
 */
export type TaskSurface =
  | "api"
  | "chat"
  | "channel"
  | "scheduler"
  | "proactive"
  | "mcp"
  | "background"
  | "internal";

/**
 * Which surface produced this task, and that surface's own reference for it
 * (a request id, a channel message id, an automation run id…).
 */
export interface TaskProvenance {
  readonly surface: TaskSurface;
  readonly ref?: string | undefined;
}

/**
 * Something the goal needs that is not known yet (P1.2 / B2).
 *
 * `whoCanAnswer` separates the two honest ways to fill a gap: only the
 * requester can answer ("user" — credentials, intent, taste), or the answer
 * already exists in the environment ("system" — which version is deployed,
 * what a file contains). A gap with no owner is treated as "user", because
 * asking costs a round trip and guessing costs the whole attempt.
 */
export interface MissingInformation {
  readonly what: string;
  readonly critical: boolean;
  readonly whoCanAnswer: "user" | "system";
}

/**
 * What goal understanding extracted from a task before any work started
 * (P1.2 / B2).
 *
 * Produced by `GoalUnderstandingService` (model-backed, honest fallback) and
 * carried on the task so the report can show what the system believed it was
 * asked to do — not just what it did. `source` says whether a model actually
 * read the goal; `fallbackReason` says why not, when it did not.
 */
export interface GoalUnderstanding {
  /** The goal restated in one sentence. The original text remains `context.goal`. */
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly preferences: readonly string[];
  readonly risks: readonly string[];
  /** ISO instant, when the goal states one. Absent when it does not. */
  readonly deadline?: string | undefined;
  /** What must exist afterwards, when the goal says so. */
  readonly expectedArtifact?: string | undefined;
  readonly successCriteria: readonly string[];
  readonly missingInformation: readonly MissingInformation[];
  /** 0..1 as reported by the extraction; 0 on the fallback, which claims nothing. */
  readonly ambiguity: number;
  readonly clarifyingQuestions: readonly string[];
  /**
   * What should happen next, derived in code from the extraction — never by
   * the model. "ask" halts the task; the others proceed with a directive.
   */
  readonly recommendation: "act" | "ask" | "think" | "research";
  readonly source: "model" | "fallback";
  readonly fallbackReason?: string | undefined;
  readonly modelRoute?: string | undefined;
}

/**
 * Why a task stopped before starting, in machine-readable form (P1.2 / B2).
 *
 * A task that needs answers produces this instead of a run: the questions are
 * the deliverable. Burying them in the summary would leave the caller parsing
 * prose to find out what to answer.
 */
export interface TaskClarification {
  readonly questions: readonly string[];
  readonly missing: readonly MissingInformation[];
  readonly understanding: GoalUnderstanding;
}

export interface TaskContextInit {
  readonly tenantId: string;
  readonly goal: string;
  readonly taskId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly workspace?: string | undefined;
  readonly constraints?: readonly string[] | undefined;
  readonly budget?: TaskBudget | undefined;
  /** Ties this task to a wider trace (an eval run, a user conversation). */
  readonly correlationId?: string | undefined;
  /**
   * Who asked for this work (P1.1). Absent for system-initiated tasks rather
   * than defaulted to the tenant: "the tenant" and "a user of the tenant" are
   * different facts, and inventing a user would make every audit log claim
   * attribution that never happened.
   */
  readonly userId?: string | undefined;
  /**
   * The task this one was spawned to help with (P1.1). Absent on roots.
   * Delegation and long-horizon continuation (B8) are the writers; the report
   * is the reader that makes the linkage visible outside the process.
   */
  readonly parentTaskId?: string | undefined;
  /**
   * Scheduling class of this task (P1.1). A free string (`"P0"`…`"P4"` is the
   * convention the initiative service already uses) rather than an enum, so a
   * surface with its own scheme is not forced to translate it into a lie.
   */
  readonly priority?: string | undefined;
  /**
   * When this task must be *finished by* — an absolute instant (P1.1).
   *
   * Deliberately not `budget.timeMs`, which is a *duration*: "you may spend
   * 10 minutes" and "the user needs it by 17:00" are different constraints,
   * and collapsing them is how a system burns its whole budget finishing
   * beautifully after the deadline passed. Carried and reported here;
   * enforcement (checking it during the run, escalating when it is near) is
   * the long-horizon manager's job, not the primitive's.
   */
  readonly deadline?: string | undefined;
  /** Which surface produced this task and that surface's reference for it. */
  readonly provenance?: TaskProvenance | undefined;
}

/**
 * One task's complete, isolated state.
 *
 * Mutable by design — a task accumulates observations as it runs — but every
 * mutation is scoped to this instance, so concurrent tasks cannot interfere.
 */
export class TaskContext {
  readonly taskId: string;
  /** Who asked for this work; absent for system-initiated tasks (P1.1). */
  readonly userId?: string | undefined;
  /** The task this one was spawned to help with; absent on roots (P1.1). */
  readonly parentTaskId?: string | undefined;
  /** Scheduling class, in the calling surface's own scheme (P1.1). */
  readonly priority?: string | undefined;
  /**
   * Absolute finish-by instant. Set by the caller, or — only when the caller
   * did not — adopted from what goal understanding read out of the goal text
   * (B2): an explicit instruction outranks an inference, never the reverse.
   */
  deadline?: string | undefined;
  /** Which surface produced this task (P1.1). */
  readonly provenance?: TaskProvenance | undefined;
  /**
   * What was understood about the goal before the work started (B2), when
   * understanding ran. Absent when it did not.
   */
  understanding?: GoalUnderstanding | undefined;
  /**
   * Why the task stopped before starting (B2). Set only on an "ask" stop; its
   * presence is what distinguishes "blocked pending answers" from every other
   * kind of blocked.
   */
  clarification?: TaskClarification | undefined;
  /**
   * What the goal's stated requirements were, and which of them a verifier
   * actually checked (B7 / P1.7). Computed once per attempt, after goal
   * verification, from the understanding's artifact/criteria and the
   * `appliesTo` declarations of the pool that ran. Absent when the task has no
   * understanding or no requirements — an empty inventory, not a missing one.
   */
  evidenceCoverage?: import("./evidence-coverage.js").EvidenceCoverage | undefined;
  readonly tenantId: string;
  readonly goal: string;
  /**
   * Hard requirements the work must satisfy; they reach the agent briefing.
   *
   * The binding is readonly and the contents are not: goal understanding
   * (B2) appends what it extracts after construction — the same shape as
   * `priorFailures`. Constructed as a defensive copy, so a caller cannot
   * reach into a running task's constraints through the array it passed in.
   */
  readonly constraints: string[];
  readonly budget: TaskBudget;
  readonly correlationId: string;
  readonly traceId: string;
  readonly startedAt: number;

  /** Assigned when the agent session is created. */
  sessionId: string | undefined;
  workspace: string | undefined;

  private phaseValue: CognitivePhase = "observing";
  private readonly phaseHistoryValue: Array<{ at: number; phase: CognitivePhase; reason: string }> = [];

  readonly memories: string[] = [];
  readonly hypotheses: Array<{ statement: string; probability: number; evidence: string[] }> = [];
  readonly observations: Observation[] = [];
  readonly failures: RecordedFailure[] = [];
  readonly trace: TraceEntry[] = [];
  readonly outcomes: ExecutionOutcome[] = [];

  plan: TaskPlan | undefined;

  /**
   * Which attempt is running, 1-based.
   *
   * The agent needs this: retrying a task without telling the agent it is a
   * retry invites it to repeat the same failing move.
   */
  attempt = 1;
  /**
   * How many times this task has been replanned (B5).
   *
   * Counted on the context rather than in a loop local so the report and the
   * trace can see it, and so the cap cannot be bypassed by a code path that
   * does not know about the local.
   */
  replans = 0;
  /**
   * The failure kind that triggered each replan, in order (B5).
   *
   * The count alone cannot say *why* the plan changed: `planning_failure` and
   * `knowledge_gap` both replan, and a report that only says "replanned twice"
   * hides which problem the second plan was meant to fix.
   */
  replanReasons: string[] = [];

  /**
   * Why earlier attempts failed, in the agent's own terms.
   *
   * Kept separate from `failures` (which holds the loop's classification)
   * because this is briefing material, not bookkeeping.
   */
  readonly priorFailures: string[] = [];

  /**
   * What the next attempt must do differently, set by the recovery decision.
   *
   * `undefined` on the first attempt, and whenever the chosen strategy is a
   * plain retry — there is nothing to change, so saying something would be
   * noise.
   */
  recoveryDirective: string | undefined = undefined;

  /**
   * The model route this attempt runs on.
   *
   * Recovery escalates it on `change_model`, so a reasoning failure is not
   * retried on the model that just produced it.
   */
  /**
   * Tools that failed in earlier attempts and should not be reached for again.
   *
   * Accumulates: a tool that broke on attempt 1 is still a bad bet on
   * attempt 3. Empty on the first attempt, and left empty when the failing
   * tool could not be identified — guessing one would send the agent away
   * from a tool that was working.
   */
  readonly avoidTools: string[] = [];

  modelRoute: string | undefined = undefined;

  /** Routes still available to escalate to, in order. Consumed as they are used. */
  fallbackModels: string[] = [];

  /**
   * Move to the next fallback route.
   *
   * Returns the new route, or `undefined` when the list is exhausted — the
   * caller must report that honestly rather than re-running the same model
   * while claiming a switch happened.
   */
  escalateModel(): string | undefined {
    const next = this.fallbackModels.shift();
    if (next === undefined) return undefined;
    this.modelRoute = next;
    return next;
  }

  readonly spend: BudgetSpend = {
    tokens: 0,
    timeMs: 0,
    toolCalls: 0,
    costUsd: 0,
    recoveryAttempts: 0,
  };

  constructor(init: TaskContextInit) {
    if (!init.tenantId?.trim()) throw new Error("TaskContext requires a tenantId.");
    if (!init.goal?.trim()) throw new Error("TaskContext requires a goal.");

    this.taskId = init.taskId ?? `task-${randomUUID()}`;
    this.userId = init.userId;
    this.parentTaskId = init.parentTaskId;
    this.priority = init.priority;
    this.deadline = init.deadline;
    this.provenance = init.provenance;
    this.tenantId = init.tenantId;
    this.goal = init.goal;
    this.constraints = [...(init.constraints ?? [])];
    this.budget = init.budget ?? {};
    this.correlationId = init.correlationId ?? this.taskId;
    this.traceId = `trace-${randomUUID()}`;
    this.startedAt = Date.now();
    this.sessionId = init.sessionId;
    this.workspace = init.workspace;

    this.phaseHistoryValue.push({ at: this.startedAt, phase: "observing", reason: "Task created" });
  }

  get phase(): CognitivePhase {
    return this.phaseValue;
  }

  get phaseHistory(): ReadonlyArray<{ at: number; phase: CognitivePhase; reason: string }> {
    return this.phaseHistoryValue;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  enterPhase(phase: CognitivePhase, reason: string): void {
    this.phaseValue = phase;
    this.phaseHistoryValue.push({ at: Date.now(), phase, reason });
    this.record(phase, "phase.entered", { reason });
  }

  record(phase: CognitivePhase, event: string, detail?: unknown, causationId?: string): void {
    this.trace.push({
      at: new Date().toISOString(),
      phase,
      event,
      detail,
      causationId,
    });
  }

  observe(source: string, summary: string, detail?: unknown): void {
    this.observations.push({ at: new Date().toISOString(), source, summary, detail });
  }

  fail(phase: CognitivePhase, message: string, extra: { category?: string; recoverable?: boolean } = {}): void {
    this.failures.push({
      at: new Date().toISOString(),
      phase,
      message,
      category: extra.category,
      recoverable: extra.recoverable,
    });
  }

  addOutcome(item: ExecutionOutcome): void {
    this.outcomes.push(item);
  }

  spendTokens(count: number): void {
    this.spend.tokens += count;
  }

  spendToolCall(count = 1): void {
    this.spend.toolCalls += count;
  }

  spendCost(usd: number): void {
    this.spend.costUsd += usd;
  }

  /**
   * Has this task run out of room?
   *
   * Returns the reason rather than a boolean so callers can report *which*
   * limit stopped them, which matters when diagnosing a truncated run.
   */
  budgetExceeded(): string | undefined {
    const { budget, spend } = this;
    if (budget.tokens !== undefined && spend.tokens > budget.tokens) {
      return `token budget exhausted (${spend.tokens}/${budget.tokens})`;
    }
    if (budget.toolCalls !== undefined && spend.toolCalls > budget.toolCalls) {
      return `tool-call budget exhausted (${spend.toolCalls}/${budget.toolCalls})`;
    }
    if (budget.costUsd !== undefined && spend.costUsd > budget.costUsd) {
      return `cost budget exhausted ($${spend.costUsd.toFixed(4)}/$${budget.costUsd.toFixed(4)})`;
    }
    if (budget.timeMs !== undefined && this.elapsedMs > budget.timeMs) {
      return `time budget exhausted (${this.elapsedMs}ms/${budget.timeMs}ms)`;
    }
    const maxRecovery = budget.maxRecoveryAttempts ?? 3;
    if (spend.recoveryAttempts > maxRecovery) {
      return `recovery attempts exhausted (${spend.recoveryAttempts}/${maxRecovery})`;
    }
    return undefined;
  }

  /** Serialisable view, for trajectories and crash recovery. */
  /**
   * A stable idempotency key for one side effect of this task.
   *
   * Recovery re-runs a task, and a re-run whose side effects already landed
   * must not land them twice. The capability broker already dedupes by
   * `CapabilityContext.idempotencyKey` through the effect journal, but the key
   * it is given today is `${commandId}:${toolCallId}` — both fresh on every
   * attempt, so the journal could never recognise a repeated effect.
   *
   * Scoped to the attempt on purpose, and that is the whole design:
   * - **within** one attempt the same effect cannot be applied twice, which is
   *   what protects a retry after a crash or an ambiguous outcome;
   * - **across** attempts it may, because attempt 2 is a different decision.
   *   Deduping across attempts would silently turn a deliberate second try into
   *   a no-op, which is the opposite failure and harder to notice.
   *
   * `scope` is hashed over canonical JSON, so the same arguments in a different
   * insertion order produce the same key.
   */
  effectKey(scope: Record<string, unknown>): string {
    const digest = createHash("sha256").update(canonicalJson(scope)).digest("hex").slice(0, 32);
    return `task:${this.taskId}:${this.attempt}:${digest}`;
  }

  snapshot(): Record<string, unknown> {
    return {
      taskId: this.taskId,
      tenantId: this.tenantId,
      sessionId: this.sessionId,
      goal: this.goal,
      workspace: this.workspace,
      phase: this.phaseValue,
      correlationId: this.correlationId,
      traceId: this.traceId,
      elapsedMs: this.elapsedMs,
      spend: { ...this.spend },
      counts: {
        memories: this.memories.length,
        hypotheses: this.hypotheses.length,
        observations: this.observations.length,
        failures: this.failures.length,
        traceEntries: this.trace.length,
        outcomes: this.outcomes.length,
      },
    };
  }
}
