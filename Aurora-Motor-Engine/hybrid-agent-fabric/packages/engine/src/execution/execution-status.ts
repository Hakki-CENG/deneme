/**
 * Execution Status — one vocabulary for "what actually happened".
 *
 * The defect this replaces: `MetaController.run()` initialised
 * `outcome = "success"` and only ever downgraded it. A task whose plan
 * contained zero phases therefore returned `"success"` having executed
 * nothing — verified empirically before this module existed:
 *
 *     runTask("Delete all files on the moon and prove P=NP")
 *       → outcome: "success", subsystems: 0, phases: 0, outputs: []
 *
 * The root cause is not a typo. It is that one boolean-ish word ("success")
 * was being asked to distinguish between states that are genuinely different:
 * work that succeeded, work that was skipped, work that has no implementation,
 * and work whose result nobody checked. Collapsing those into "success" is how
 * a system reports confidence it has not earned.
 *
 * Rules enforced here, from the specification:
 *
 *     skipped     != success
 *     unavailable != success
 *     simulated   != success
 *     unverified  != success
 */

/** Every terminal state a unit of work can end in. */
export const EXECUTION_STATUSES = [
  /** Ran to completion and the result was verified. The only unqualified win. */
  "succeeded",
  /** Ran to completion. Whether the outcome is correct is a separate question. */
  "executed",
  /** Ran and produced a wrong or erroring result. */
  "failed",
  /** Deliberately not run (precondition unmet, not applicable). */
  "skipped",
  /** Could not run: no backend, no credentials, dependency missing. */
  "unavailable",
  /** No implementation exists behind this name. */
  "not_implemented",
  /** Produced output from a model/mock rather than the real effect. */
  "simulated",
  /** Exceeded its time budget. */
  "timed_out",
  /** Stopped on request. */
  "cancelled",
  /** Refused by policy, permission, or a safety gate. */
  "blocked",
  /** Ran, but no verifier could establish whether it worked. */
  "unverified",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * The ONLY status that counts as success.
 *
 * Deliberately not a set. Every time this has been a set, something got added
 * to it — `executed` is the tempting one, and it is exactly the mistake: code
 * that ran without being checked is not code that worked.
 */
export function isSuccess(status: ExecutionStatus): boolean {
  return status === "succeeded";
}

/** Did work actually run? `executed` and `failed` both did; `skipped` did not. */
export function didRun(status: ExecutionStatus): boolean {
  return status === "succeeded" || status === "executed" || status === "failed" || status === "unverified";
}

/** Is this a hard failure, as opposed to an absence of work? */
export function isFailure(status: ExecutionStatus): boolean {
  return status === "failed" || status === "timed_out";
}

/**
 * Statuses meaning "nothing happened here".
 *
 * These must never be averaged into a success rate: a suite of 100 tasks where
 * 99 are `unavailable` and 1 `succeeded` is not a 100% success rate, and it is
 * not a 1% one either. It is one success and 99 non-measurements.
 */
export function isAbsence(status: ExecutionStatus): boolean {
  return (
    status === "skipped" ||
    status === "unavailable" ||
    status === "not_implemented" ||
    status === "cancelled" ||
    status === "blocked"
  );
}

/**
 * Can this status be presented to a user as a completed result?
 *
 * `simulated` and `unverified` deliberately return false. They are the two
 * statuses most likely to be mistaken for success, because output exists.
 */
export function isReportableAsDone(status: ExecutionStatus): boolean {
  return status === "succeeded";
}

/** Human-readable reason, for logs and trajectories. */
export const STATUS_MEANING: Record<ExecutionStatus, string> = {
  succeeded: "Ran and the result was verified",
  executed: "Ran to completion but the result was not verified",
  failed: "Ran and produced a wrong or erroring result",
  skipped: "Deliberately not run",
  unavailable: "Could not run: missing backend, credentials or dependency",
  not_implemented: "No implementation exists",
  simulated: "Output came from a model or mock, not the real effect",
  timed_out: "Exceeded its time budget",
  cancelled: "Stopped on request",
  blocked: "Refused by policy, permission or a safety gate",
  unverified: "Ran, but no verifier could establish whether it worked",
};

/**
 * One unit of work's outcome, with the evidence that justifies it.
 *
 * `evidence` is not decoration. A status without evidence is an assertion, and
 * assertions are what produced the bug this module exists to prevent.
 */
export interface ExecutionOutcome<T = unknown> {
  readonly status: ExecutionStatus;
  /** What justifies this status — command output, verifier name, error text. */
  readonly evidence: string;
  readonly value?: T | undefined;
  readonly durationMs?: number | undefined;
  readonly error?: string | undefined;
}

export function outcome<T>(
  status: ExecutionStatus,
  evidence: string,
  extra: { value?: T | undefined; durationMs?: number | undefined; error?: string | undefined } = {},
): ExecutionOutcome<T> {
  if (!evidence.trim()) {
    throw new Error(`An ExecutionOutcome needs evidence; '${status}' was reported with none.`);
  }
  return {
    status,
    evidence,
    value: extra.value,
    durationMs: extra.durationMs,
    error: extra.error,
  };
}

/**
 * Roll many outcomes into one.
 *
 * The aggregation rules matter more than they look:
 *
 *   - An EMPTY list is `skipped`, never `succeeded`. This is precisely the bug
 *     that let a zero-phase plan report success.
 *   - Any failure dominates.
 *   - If nothing failed but nothing was verified either, the result is
 *     `unverified` — not `succeeded`.
 *   - If every part was absent, the whole is absent.
 */
export function aggregate(outcomes: readonly ExecutionOutcome[]): ExecutionStatus {
  if (outcomes.length === 0) return "skipped";

  const statuses = outcomes.map((item) => item.status);

  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("timed_out")) return "timed_out";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("cancelled")) return "cancelled";

  if (statuses.every(isAbsence)) {
    return statuses.includes("not_implemented") ? "not_implemented" : "skipped";
  }

  if (statuses.includes("simulated")) return "simulated";
  if (statuses.includes("unverified")) return "unverified";
  if (statuses.includes("executed")) return "executed";

  return statuses.every((status) => status === "succeeded") ? "succeeded" : "executed";
}

/**
 * Success rate that refuses to lie.
 *
 * Absent work is excluded from the denominator and reported separately, so a
 * run of mostly-unavailable subsystems cannot masquerade as a high score.
 */
export function successRate(outcomes: readonly ExecutionOutcome[]): {
  rate: number;
  succeeded: number;
  measured: number;
  absent: number;
  note: string;
} {
  const succeeded = outcomes.filter((item) => isSuccess(item.status)).length;
  const absent = outcomes.filter((item) => isAbsence(item.status)).length;
  const measured = outcomes.length - absent;

  if (measured === 0) {
    return {
      rate: 0,
      succeeded: 0,
      measured: 0,
      absent,
      note: `No work was measured: all ${absent} unit(s) were skipped, unavailable or blocked.`,
    };
  }

  return {
    rate: succeeded / measured,
    succeeded,
    measured,
    absent,
    note:
      absent > 0
        ? `${succeeded}/${measured} measured; ${absent} excluded as absent (not counted as pass or fail).`
        : `${succeeded}/${measured} measured.`,
  };
}
