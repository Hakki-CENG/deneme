/**
 * Plan execution — Aurora (B4).
 *
 * What this replaces, measured rather than inferred. A three-step chain
 * (`a → b → c`) run through the existing walk:
 *
 *     wave1 ready:   a
 *     after wave 1:  a=unverified  b=not_implemented  c=not_implemented
 *     next ready:    (none)
 *
 * Two things were happening at once, and both are visible in that output.
 *
 *  1. **The runtime never walked the plan.** `runAgent(context)` is called once
 *     per attempt and `recordStepProgress` runs *after* it, so step statuses
 *     were a post-hoc reading of the agent's own report. Nothing iterated the
 *     steps, nothing asked for the second one.
 *
 *  2. **The walk could not get past wave 1 anyway.** When the agent completes
 *     without per-step outcomes the loop marks the ready steps `unverified`,
 *     and `readySteps()` gates on `isSuccess`, which is `"succeeded"` only. So
 *     `b` and `c` stayed `not_implemented` forever: not blocked (their
 *     prerequisite did not fail), not run, and the report read "3 step(s), 2
 *     not attempted" for a task the agent had finished.
 *
 * This module makes the walk explicit. Three rules:
 *
 *  - **A step that ran and was not checked does not stop the plan, and does not
 *    become a success either.** `unverified` satisfies a dependency here. That
 *    is not a softening of `execution-status.ts` — the task's overall status
 *    still cannot be `succeeded` on unverified work. This is about whether the
 *    *next* step may start, and refusing to start it does not make the first one
 *    verified; it just loses the rest of the plan.
 *  - **A step that failed still blocks its dependants.** Unchanged, and
 *    deliberate: `blockUnreachable` keeps calling those `blocked` rather than
 *    `failed`, because they never got their turn.
 *  - **Every mark carries evidence.** Which attempt, what the agent said, how
 *    long, what it cost. A step status with no evidence behind it is a claim;
 *    with evidence it is a record.
 */
import type { ExecutionStatus } from "./execution-status.js";
import { isFailure, isSuccess } from "./execution-status.js";
import { cyclicSteps, stepId, type PlannedStep } from "./plan-progress.js";
import type { Verifier } from "./verification-factory.js";
import type { TaskPlan, TaskPlanStep } from "./task-context.js";

/** What backs one step's status. */
export interface StepEvidence {
  /** Which attempt produced this. Retries are visible rather than overwritten. */
  readonly attempt: number;
  /** Who ran it, when the adapter could say. */
  readonly actor?: string | undefined;
  /** The agent's own words about this step, when it reported per step. */
  readonly detail?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly tokens?: number | undefined;
  readonly toolCalls?: number | undefined;
  readonly error?: string | undefined;
  readonly at: string;
}

/** One status change to apply to a plan. */
export interface StepMark {
  readonly id: string;
  readonly status: ExecutionStatus;
  readonly detail?: string | undefined;
  readonly evidence: StepEvidence;
}

/** What the runner observed, in the shape the walk needs. */
export interface StepRunOutcome {
  readonly attempt: number;
  /** Did the run finish without throwing? */
  readonly completed: boolean;
  readonly summary: string;
  readonly error?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly tokens?: number | undefined;
  readonly toolCalls?: number | undefined;
  /** Per-step results, when the adapter can attribute work to plan steps. */
  readonly stepResults?: ReadonlyArray<{ id: string; status: ExecutionStatus; detail?: string | undefined }> | undefined;
}

export interface WalkOptions {
  /**
   * Whether an `unverified` prerequisite lets its dependants start.
   *
   * Default `true`, and the reasoning is in the header: the alternative stalls
   * the plan at wave 1 for every task whose agent does not report per-step
   * outcomes, which is most of them. Set it to `false` to require a checked
   * prerequisite, which is the right setting once steps have real verifiers.
   */
  readonly unverifiedSatisfiesDependency?: boolean | undefined;
}

/**
 * Does a prerequisite at this status let its dependants run?
 *
 * Succeeded and executed do. Unverified does, by default, for the reason above.
 * Everything else — failed, blocked, timed_out, cancelled, simulated,
 * unavailable, not_implemented — does not.
 */
export function prerequisiteAllowsDependants(
  status: ExecutionStatus,
  options: WalkOptions = {},
): boolean {
  if (isSuccess(status)) return true;
  if (status === "executed") return true;
  if (status === "unverified") return options.unverifiedSatisfiesDependency ?? true;
  return false;
}

/**
 * The steps that may start now: untouched, with every prerequisite satisfied.
 *
 * Unlike `readySteps()` in `plan-progress.ts`, this does not require a
 * prerequisite to be `succeeded`; see `prerequisiteAllowsDependants`. Both are
 * kept because they answer different questions — "what is provably ready" and
 * "what may the runtime attempt next".
 */
export function nextSteps(plan: TaskPlan, options: WalkOptions = {}): TaskPlanStep[] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  return plan.steps.filter((step) => {
    if (step.status !== "not_implemented") return false;
    return step.dependencies.every((dep) => {
      const prerequisite = byId.get(dep);
      // An unknown prerequisite can never be satisfied. Treating it as
      // satisfied would let a step run on work that does not exist.
      return prerequisite !== undefined && prerequisiteAllowsDependants(prerequisite.status, options);
    });
  });
}

/**
 * Is the walk finished — every step in a terminal state?
 *
 * `not_implemented` is the only non-terminal status a step can hold here.
 */
export function walkComplete(plan: TaskPlan): boolean {
  return plan.steps.every((step) => step.status !== "not_implemented");
}

/** The steps that have not been attempted yet. */
export function pendingSteps(plan: TaskPlan): TaskPlanStep[] {
  return plan.steps.filter((step) => step.status === "not_implemented");
}

/**
 * Decide what one run means for the plan.
 *
 * Pure: it returns the marks to apply and changes nothing, so the judgement can
 * be tested without an engine and the loop stays the only thing that mutates a
 * plan.
 *
 * Two cases, and the difference is the whole point of B4:
 *
 *  - **The adapter attributed work to steps.** Those steps get the statuses it
 *    reported. Anything it did not mention is left untouched — assuming the
 *    unmentioned ones succeeded would be inventing progress.
 *  - **The adapter reported nothing per step.** Only the steps that were
 *    actually ready get a status, and it is `unverified` (or `failed` if the
 *    run failed): the work that was in front of the agent ran, and nobody can
 *    say whether it worked. Steps further down the graph stay untouched, so the
 *    next attempt can pick them up — which is what the old walk never did.
 */
export function advancePlan(
  plan: TaskPlan,
  run: StepRunOutcome,
  options: WalkOptions = {},
): readonly StepMark[] {
  const base = {
    attempt: run.attempt,
    at: new Date().toISOString(),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    ...(run.tokens !== undefined ? { tokens: run.tokens } : {}),
    ...(run.toolCalls !== undefined ? { toolCalls: run.toolCalls } : {}),
    ...(run.error ? { error: run.error } : {}),
  };

  if (run.stepResults !== undefined && run.stepResults.length > 0) {
    const known = new Set(plan.steps.map((step) => step.id));
    return run.stepResults
      // An id the plan does not contain is the adapter's bug, not this plan's
      // progress. Dropping it silently would hide that.
      .filter((result) => known.has(result.id))
      .map((result) => ({
        id: result.id,
        status: result.status,
        ...(result.detail ? { detail: result.detail } : {}),
        evidence: { ...base, ...(result.detail ? { detail: result.detail } : {}) },
      }));
  }

  const ready = nextSteps(plan, options);
  if (ready.length === 0) return [];

  const status: ExecutionStatus = run.completed ? "unverified" : "failed";
  const detail = run.completed
    ? "Ran during this attempt; nothing could confirm the result for this step"
    : (run.error ?? run.summary);

  return ready.map((step) => ({
    id: step.id,
    status,
    detail,
    evidence: { ...base, detail },
  }));
}

/**
 * Group a plan into the waves the runtime will attempt, in order.
 *
 * A *topological* view: wave N holds the steps whose prerequisites all sit in
 * earlier waves. It deliberately ignores current statuses — this answers "how
 * is this plan shaped", which is a property of the graph, not of how far the
 * walk has got. (An earlier version mixed the two and could not see past the
 * first wave, because every step still read `not_implemented`.)
 *
 * Steps that can never be placed — an unknown prerequisite, or a cycle — are
 * omitted rather than silently positioned, so a wave list that does not cover
 * the plan is a finding.
 */
export function plannedWaves(plan: TaskPlan): string[][] {
  const placed = new Set<string>();
  const waves: string[][] = [];
  let remaining = [...plan.steps];

  while (remaining.length > 0) {
    const wave = remaining.filter((step) =>
      step.dependencies.every((dep) => {
        // An unknown prerequisite can never be placed.
        if (!plan.steps.some((candidate) => candidate.id === dep)) return false;
        return placed.has(dep);
      }),
    );
    if (wave.length === 0) break;
    waves.push(wave.map((step) => step.id));
    for (const step of wave) placed.add(step.id);
    remaining = remaining.filter((step) => !placed.has(step.id));
  }
  return waves;
}

/** Positional id, re-exported so callers do not have to import two modules. */
export { stepId };

/** What a replan kept, replaced and produced (B5). */
export interface ReplanResult {
  readonly plan: TaskPlan;
  /** Ids that had already been attempted and were carried over unchanged. */
  readonly kept: readonly string[];
  /** Ids that were never attempted and were dropped in favour of the new plan. */
  readonly replaced: readonly string[];
  /** Ids the new plan introduced. */
  readonly added: readonly string[];
  /**
   * Why the replan was refused, when it was. The caller must not silently fall
   * back to the old plan: "we replanned" and "we could not" are different facts
   * and the report has to say which one happened.
   */
  readonly rejected?: string | undefined;
}

/**
 * Fold a new plan into a partly-walked one (B5).
 *
 * The plan says what a *replanning* has to mean, and the two halves matter
 * equally:
 *
 *   - **Completed steps are preserved.** Work that already happened is evidence;
 *     throwing it away to get a tidy plan is how a system redoes finished work
 *     and reports progress it did not make.
 *   - **Only the affected subtree is replanned.** A step nobody attempted is
 *     replaced; a step that ran — succeeded, failed, blocked, unverified, any of
 *     it — is kept exactly as it is, status and evidence intact.
 *
 * Refusals are returned, not thrown, and never silently absorbed:
 *
 *   - an empty new plan is not a plan;
 *   - a new plan that duplicates the id of a step we are keeping would make
 *     `dependencies` ambiguous, so it is rejected rather than merged;
 *   - a new plan containing a cycle cannot be walked in any order.
 *
 * Dependencies the new plan points at are kept when the target survived the
 * merge and dropped when it did not — pointing at a step that no longer exists
 * would leave the new step permanently unready, which is the exact stall B4
 * removed.
 */
export function mergeReplan(
  current: TaskPlan,
  proposed: readonly (string | PlannedStep)[],
): ReplanResult {
  const keptSteps = current.steps.filter((step) => step.status !== "not_implemented");
  const droppedSteps = current.steps.filter((step) => step.status === "not_implemented");
  const keptIds = new Set(keptSteps.map((step) => step.id));
  const refusal = (rejected: string): ReplanResult => ({
    plan: current,
    kept: keptSteps.map((step) => step.id),
    replaced: droppedSteps.map((step) => step.id),
    added: [],
    rejected,
  });

  // A planner that emits bare descriptions gets the same positional ids
  // `buildPlan` would give it, so the two paths cannot disagree about what `s1`
  // means. A *named* plan is what makes a merge unambiguous; see the collision
  // check below.
  const named: readonly PlannedStep[] = proposed.map((step, index) =>
    typeof step === "string" ? { description: step, id: stepId(index) } : step,
  );

  if (named.length === 0) {
    return refusal("the planner returned no steps, so the existing plan stands");
  }

  const seen = new Set<string>();
  for (const step of named) {
    const id = step.id ?? "";
    if (id === "") {
      return refusal("a proposed step has no id, so its dependencies could not be resolved");
    }
    if (keptIds.has(id)) {
      // Not a pedantic check. `dependencies` refer to ids, so an id that means
      // both "the step that already ran" and "a brand new step" makes every
      // edge into it ambiguous. A planner that names its steps cannot hit this;
      // one that emits bare descriptions gets positional ids, which *will*
      // collide, and the honest answer is that it cannot be replanned safely.
      return refusal(
        `the proposed plan reuses "${id}", which has already been attempted — ` +
          "a planner must name its steps for a replan to be unambiguous",
      );
    }
    if (seen.has(id)) {
      return refusal(`the proposed plan names "${id}" twice`);
    }
    seen.add(id);
  }

  const validTargets = new Set([...keptIds, ...seen]);
  const newSteps: TaskPlanStep[] = named.map((step) => ({
    id: step.id ?? stepId(0),
    description: step.description,
    // An edge to a step this merge dropped would never be satisfied.
    dependencies: (step.dependencies ?? []).filter((dep) => validTargets.has(dep)),
    status: "not_implemented",
  }));

  const candidate: TaskPlan = { steps: [...keptSteps, ...newSteps] };
  if (cyclicSteps(candidate).length > 0) {
    return refusal("the proposed plan contains a cycle, so it cannot be walked in any order");
  }

  return {
    plan: candidate,
    kept: keptSteps.map((step) => step.id),
    replaced: droppedSteps.map((step) => step.id),
    added: newSteps.map((step) => step.id),
  };
}

/**
 * Assemble the verifier panel for one plan step (B6).
 *
 * Selection is automated in the only honest direction: the verifier declares
 * which claims it can evaluate (`appliesTo`), because the planner cannot know
 * what the host registered. Two rules keep the panel meaningful:
 *
 *  - **Workspace-scope verifiers are excluded.** A build or a test suite proves
 *    the workspace is sound; it says nothing about whether *this step's*
 *    criterion holds. Feeding general evidence into a step-specific claim is
 *    how a green build comes to vouch for a file that was never created.
 *    (P1.6: separate build/test-style general evidence from goal-specific
 *    verification.)
 *  - **A verifier without `appliesTo` is excluded.** It speaks about the goal
 *    or the workspace as a whole, not about steps.
 *
 * Empty result is a valid answer and means "nothing can check this step", which
 * leaves it `unverified` — not `failed`, because nothing went wrong.
 */
export function selectStepVerifiers(
  step: TaskPlanStep,
  pool: readonly Verifier[],
): readonly Verifier[] {
  return pool.filter((verifier) => {
    if ((verifier.scope ?? "goal") === "workspace") return false;
    return (
      verifier.appliesTo?.({
        description: step.description,
        ...(step.successCriterion !== undefined
          ? { successCriterion: step.successCriterion }
          : {}),
      }) === true
    );
  });
}
