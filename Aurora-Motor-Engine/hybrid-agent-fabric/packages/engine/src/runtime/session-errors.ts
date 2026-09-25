/**
 * Typed session failures.
 *
 * These live in their own module rather than in `supervisor.ts` for one reason:
 * the session actor has to throw them too, and the supervisor imports the
 * actor. A supervisor → actor → supervisor cycle would work at runtime today
 * because the classes are only referenced inside method bodies, but it breaks
 * the moment anything reads one at module-evaluation time, and nothing is
 * gained by taking that risk.
 *
 * The contract they exist to serve: an HTTP layer must be able to answer a
 * client without matching on error prose. Each class carries the facts (which
 * session, which state, which limit) as fields, so rewording a message can
 * never silently change an API's status code.
 */

/**
 * Fan-out limits for child agents.
 *
 * Declared here because {@link SessionLimitError} reports the limits that
 * fired, and the supervisor re-exports this module rather than the reverse.
 */
export interface AgentFanoutLimits {
  /** Live children one session may hold at once. */
  maxConcurrentChildren?: number;
  /** How deep the tree may go. 1 means a root session may spawn children, and those children may not. */
  maxDepth?: number;
  /** Children one session may spawn over its whole life, live or finished. 0 disables the cap. */
  maxLifetimeChildren?: number;
}

/**
 * A session the caller asked for does not exist.
 *
 * Typed rather than a plain `Error` so an HTTP layer can answer 404 instead of
 * 500. Matching on the message text would work until somebody reworded it, which
 * is exactly how an error contract goes stale without anybody noticing.
 */
export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string, reason: "unknown" | "no-snapshot" = "unknown") {
    super(
      reason === "no-snapshot"
        ? `Session ${sessionId} exists in the catalog but has no snapshot.`
        : `Session ${sessionId} does not exist.`,
    );
    this.name = "SessionNotFoundError";
  }
}

/** A session identifier that is already taken. */
export class SessionAlreadyExistsError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} already exists.`);
    this.name = "SessionAlreadyExistsError";
  }
}

/**
 * A session that exists but cannot take new work.
 *
 * Until this existed the refusal was a plain `Error` whose only distinguishing
 * feature was the sentence "Session is closed.", so an HTTP layer had to match
 * on prose to tell "you are posting to a finished conversation" — a 409 the
 * caller can act on — from an unexpected crash, which is a 500. The state is
 * carried on the object instead of in the wording.
 */
export class SessionNotRunnableError extends Error {
  constructor(
    readonly sessionId: string,
    readonly sessionStatus: "closed" | "paused" | "archived",
  ) {
    super(
      sessionStatus === "archived"
        ? `Session ${sessionId} is archived. Restore it before sending new work.`
        : `Session is ${sessionStatus}.`,
    );
    this.name = "SessionNotRunnableError";
  }
}

/** Which fan-out budget stopped a spawn. */
export type FanoutLimitKind = "depth" | "concurrency" | "lifetime";

/**
 * A child-agent fan-out budget was reached.
 *
 * This is not a malfunction: the system did exactly what it was configured to
 * do. It answers 429 rather than 500 because the caller can retry later or ask
 * for a higher limit, and it names which of the three caps fired so an operator
 * raises the right one.
 */
export class SessionLimitError extends Error {
  constructor(
    readonly sessionId: string,
    readonly limit: FanoutLimitKind,
    reason: string,
    readonly limits: Required<AgentFanoutLimits>,
  ) {
    super(reason);
    this.name = "SessionLimitError";
  }
}
