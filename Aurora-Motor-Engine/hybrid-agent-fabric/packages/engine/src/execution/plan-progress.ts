/**
 * Track what actually happened to each step of a plan.
 *
 * Before this existed, `TaskReport.plan` was a list of descriptions that were
 * all permanently `"skipped"`. The field was present, serialized and shown, and
 * it carried no information: a plan whose every step succeeded and a plan that
 * was never started rendered identically. "The field exists" is not the same
 * claim as "the field means something".
 *
 * Two rules drive everything here:
 *
 *  1. A step nobody attempted is `not_implemented`, not `skipped`. `skipped`
 *     is a *decision* — it says someone looked at this step and chose to pass
 *     over it. Untouched work has not been decided about.
 *
 *  2. A step whose dependency failed is `blocked`, not `failed`. It did not
 *     fail; it never got the chance. Collapsing those two makes one root cause
 *     look like a cascade of independent defects, which is exactly the reading
 *     that sends people debugging the wrong step.
 */
import {
  type ExecutionStatus,
  isSuccess,
  isFailure,
} from "./execution-status.js";
import type { TaskPlanStep, TaskPlan } from "./task-context.js";

/** A step description plus the edges the planner computed for it. */
export interface PlannedStep {
  readonly description: string;
  /** Ids of prerequisite steps. Unknown ids are reported, not ignored. */
  readonly dependencies?: readonly string[] | undefined;
  /** Optional stable id. Generated positionally when absent. */
  readonly id?: string | undefined;
  /**
   * What must be true afterwards for this step to count as done (B6).
   *
   * The planner is prompted for this as `expectedOutput`; the runtime calls it
   * a criterion because that is what a verifier evaluates. Optional because a
   * planner that cannot name one must not be forced to invent one — a made-up
   * criterion is worse than none, since it would let a verifier "confirm" a
   * claim nobody actually specified.
   */
  readonly successCriterion?: string | undefined;
}

/** Positional id for a step the planner did not name. */
export function stepId(index: number): string {
  return `s${index + 1}`;
}

/**
 * Build a plan from planner output.
 *
 * Accepts bare strings so existing planners keep working: a planner that only
 * produces descriptions yields a dependency-free plan, which is honest, rather
 * than a plan with invented edges.
 */
export function buildPlan(steps: readonly (string | PlannedStep)[]): TaskPlan {
  const normalised: PlannedStep[] = steps.map((step) =>
    typeof step === "string" ? { description: step } : step,
  );

  const ids = normalised.map((step, index) => step.id ?? stepId(index));
  const known = new Set(ids);

  const planSteps: TaskPlanStep[] = normalised.map((step, index) => {
    // An edge pointing at a step that does not exist is a planner bug. Dropping
    // it silently would turn a broken plan into a plausible-looking one, so the
    // unknown id is kept and surfaced by `unresolvedDependencies`.
    const dependencies = (step.dependencies ?? []).filter((dep) => dep !== ids[index]);
    return {
      id: ids[index] ?? stepId(index),
      description: step.description,
      dependencies,
      status: "not_implemented" as ExecutionStatus,
      // B6: carried through so verification can check what the planner
      // promised. Dropped silently, this made every step unverifiable by
      // construction no matter what the planner said.
      ...(step.successCriterion !== undefined ? { successCriterion: step.successCriterion } : {}),
    };
  });

  void known;
  return { steps: planSteps };
}

/** Dependency ids that no step in the plan defines. */
export function unresolvedDependencies(plan: TaskPlan): string[] {
  const ids = new Set(plan.steps.map((step) => step.id));
  const missing = new Set<string>();
  for (const step of plan.steps) {
    for (const dep of step.dependencies) {
      if (!ids.has(dep)) missing.add(dep);
    }
  }
  return [...missing];
}

/**
 * Find dependency cycles.
 *
 * A cycle means no step in it can ever start, so the loop must report that
 * rather than stall or, worse, execute the steps in arbitrary order and appear
 * to succeed. Returns the ids involved in at least one cycle.
 */
export function cyclicSteps(plan: TaskPlan): string[] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const state = new Map<string, "visiting" | "done">();
  const cyclic = new Set<string>();

  const visit = (id: string, stack: string[]): void => {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "visiting") {
      // Everything from the first sighting of `id` onwards is in the cycle.
      const from = stack.indexOf(id);
      for (const member of stack.slice(from >= 0 ? from : 0)) cyclic.add(member);
      return;
    }
    state.set(id, "visiting");
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (byId.has(dep)) visit(dep, [...stack, id]);
    }
    state.set(id, "done");
  };

  for (const step of plan.steps) visit(step.id, []);
  return [...cyclic];
}

/**
 * Steps whose dependencies have all succeeded and which have not run yet.
 *
 * This is what makes the graph load-bearing instead of decorative: the order
 * comes from the edges, not from the order the planner happened to emit.
 */
export function readySteps(plan: TaskPlan): TaskPlanStep[] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  return plan.steps.filter((step) => {
    if (step.status !== "not_implemented") return false;
    return step.dependencies.every((dep) => {
      const prerequisite = byId.get(dep);
      // An unknown dependency cannot be satisfied. Treating it as satisfied
      // would let a step run on a prerequisite that does not exist.
      return prerequisite !== undefined && isSuccess(prerequisite.status);
    });
  });
}

/** Record the outcome of a single step. */
export function markStep(
  plan: TaskPlan,
  id: string,
  status: ExecutionStatus,
  detail?: string,
): void {
  const step = plan.steps.find((candidate) => candidate.id === id);
  if (step === undefined) return;
  step.status = status;
  if (detail !== undefined) step.detail = detail;
}

/**
 * Mark every step that can no longer run as `blocked`.
 *
 * Called once execution stops. Propagates transitively: if A fails, B depends
 * on A and C depends on B, both B and C are blocked — C's reason names its own
 * unmet prerequisite rather than the distant root cause, because that is what
 * someone reading C needs in order to walk backwards.
 */
export function blockUnreachable(plan: TaskPlan): void {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  let changed = true;

  while (changed) {
    changed = false;
    for (const step of plan.steps) {
      if (step.status !== "not_implemented") continue;

      for (const dep of step.dependencies) {
        const prerequisite = byId.get(dep);
        const unsatisfiable =
          prerequisite === undefined ||
          isFailure(prerequisite.status) ||
          prerequisite.status === "blocked" ||
          prerequisite.status === "skipped" ||
          prerequisite.status === "unavailable";

        if (unsatisfiable) {
          step.status = "blocked";
          step.detail =
            prerequisite === undefined
              ? `Depends on unknown step ${dep}`
              : `Blocked by ${dep} (${prerequisite.status})`;
          changed = true;
          break;
        }
      }
    }
  }
}

/** Counts by status, for summaries that should not have to re-derive them. */
export function planSummary(plan: TaskPlan): {
  total: number;
  succeeded: number;
  failed: number;
  blocked: number;
  unverified: number;
  untouched: number;
} {
  const total = plan.steps.length;
  const succeeded = plan.steps.filter((step) => isSuccess(step.status)).length;
  const failed = plan.steps.filter((step) => isFailure(step.status)).length;
  const blocked = plan.steps.filter((step) => step.status === "blocked").length;
  // B6: counted separately because "ran, nothing refuted it, nothing confirmed
  // it" is a different fact from both "succeeded" and "not attempted", and a
  // summary that cannot say it forces every reader to re-derive it.
  const unverified = plan.steps.filter((step) => step.status === "unverified").length;
  const untouched = plan.steps.filter((step) => step.status === "not_implemented").length;
  return { total, succeeded, failed, blocked, unverified, untouched };
}
