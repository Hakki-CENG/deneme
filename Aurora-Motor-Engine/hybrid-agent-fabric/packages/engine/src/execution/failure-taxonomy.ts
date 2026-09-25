/**
 * Failure taxonomy and recovery strategy.
 *
 * "It failed" is not actionable. A missing tool and a wrong plan both surface
 * as an error string, but the right response differs completely: one needs a
 * capability built, the other needs re-planning. Retrying the first is pure
 * waste — it will fail identically every time.
 *
 * So: classify first, then choose a strategy from the classification.
 */

export const FAILURE_KINDS = [
  /** The agent lacked information it needed. */
  "knowledge_gap",
  /** No tool exists for the required operation. */
  "tool_gap",
  /** A tool exists but the agent cannot drive it competently. */
  "skill_gap",
  /** The interface differed from what was expected (API/schema mismatch). */
  "interface_gap",
  /** Denied by permissions. */
  "permission_gap",
  /** The work may be correct but cannot be verified. */
  "verification_gap",
  /** The plan was wrong or incoherent. */
  "planning_failure",
  /** The reasoning was invalid even if the plan was sound. */
  "reasoning_failure",
  /** The action was right but execution broke. */
  "execution_failure",
  /** The environment was broken (network, disk, sandbox). */
  "environment_failure",
  /** Out of budget: tokens, money, time, quota. */
  "resource_failure",
  /** The model itself failed: refusal, malformed output, context overflow. */
  "model_failure",
  "timeout",
  /** A safety gate refused. Never auto-retry these. */
  "security_block",
  /** Genuinely unknown, possibly unknowable. */
  "fundamental_unknown",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

export const RECOVERY_STRATEGIES = [
  "retry",
  "retry_with_backoff",
  "replan",
  "change_model",
  "change_tool",
  "acquire_capability",
  "request_permission",
  "add_verification",
  "reduce_scope",
  "ask_human",
  "abort",
] as const;

export type RecoveryStrategy = (typeof RECOVERY_STRATEGIES)[number];

export interface FailureClassification {
  readonly kind: FailureKind;
  readonly confidence: number;
  readonly signals: readonly string[];
  readonly rationale: string;
}

export interface RecoveryDecision {
  readonly strategy: RecoveryStrategy;
  readonly rationale: string;
  /** False when the loop must stop: budget spent, or retrying cannot help. */
  readonly canContinue: boolean;
  /**
   * How long to wait before the next attempt, in milliseconds.
   *
   * Only `retry_with_backoff` sets this. A strategy named "backoff" that does
   * not wait is a label, not a behaviour — the loop must be able to act on it.
   */
  readonly backoffMs?: number | undefined;
  /**
   * What the next attempt must do differently, in plain language, or
   * `undefined` when repeating the same work is the right move.
   *
   * Without this, every continuable strategy collapses into "run the same
   * thing again": `replan` does not replan and `reduce_scope` reduces nothing.
   * The loop puts this in front of the agent.
   */
  readonly directive?: string | undefined;
}

/** Base delay for `retry_with_backoff`; doubles per attempt used. */
const BACKOFF_BASE_MS = 1000;
/** Ceiling so a long run cannot stall on one slow dependency. */
const BACKOFF_MAX_MS = 30000;

/** Exponential backoff, bounded. */
function backoffFor(attemptsUsed: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attemptsUsed - 1), BACKOFF_MAX_MS);
}

interface Rule {
  readonly kind: FailureKind;
  readonly patterns: readonly RegExp[];
  readonly weight: number;
}

/**
 * Deterministic classification rules.
 *
 * Deliberately pattern-based and ordered by specificity. Per the spec:
 * deterministic detection first, structural analysis second, an LLM only as a
 * last resort — a classifier that needs a model call cannot run when the model
 * is the thing that failed.
 */
const RULES: readonly Rule[] = [
  {
    kind: "security_block",
    patterns: [/blocked by policy/i, /security (gate|policy) refused/i, /kill switch/i, /forbidden by guard/i],
    weight: 1.0,
  },
  {
    kind: "permission_gap",
    patterns: [/permission denied/i, /EACCES/, /unauthori[sz]ed/i, /\b403\b/, /not permitted/i],
    weight: 0.95,
  },
  {
    kind: "timeout",
    patterns: [/timed? ?out/i, /ETIMEDOUT/, /deadline exceeded/i],
    weight: 0.95,
  },
  {
    kind: "resource_failure",
    patterns: [/budget (exhausted|exceeded)/i, /quota/i, /rate limit/i, /\b429\b/, /out of memory/i, /ENOSPC/],
    weight: 0.9,
  },
  {
    kind: "tool_gap",
    patterns: [
      /not implemented/i,
      /no (such )?tool/i,
      /unknown (tool|command|capability)/i,
      /command not found/i,
      /is unavailable\./i,
      /requires (a|an) .* backend/i,
    ],
    weight: 0.9,
  },
  {
    kind: "verification_gap",
    patterns: [/cannot verify/i, /VerificationGapError/, /no verifier/i, /unverified/i],
    weight: 0.9,
  },
  {
    kind: "interface_gap",
    patterns: [
      /is not a function/i,
      /schema (mismatch|validation)/i,
      /unexpected (token|field|argument)/i,
      /invalid (argument|parameter|payload)/i,
      /TypeError/,
    ],
    weight: 0.8,
  },
  {
    kind: "environment_failure",
    patterns: [/ENOENT/, /ECONNREFUSED/, /ENOTFOUND/, /network (error|unreachable)/i, /sandbox (failed|unavailable)/i],
    weight: 0.8,
  },
  {
    kind: "model_failure",
    patterns: [/context (length|window) exceeded/i, /model (refused|declined)/i, /malformed (json|output)/i, /\b5\d\d\b.*model/i],
    weight: 0.75,
  },
  {
    // Was declared in FAILURE_KINDS and handled in chooseRecovery, but had no
    // patterns — so classifyFailure could never return it and the branch was
    // dead. These are the shapes an agent's own output takes when the thinking,
    // not the execution, is what failed.
    kind: "reasoning_failure",
    patterns: [
      /invalid reasoning/i,
      /(logic|reasoning) (error|flaw|mistake)/i,
      /contradicts (itself|the)/i,
      /hallucinat/i,
      /incorrect (conclusion|inference|assumption)/i,
      /wrong answer/i,
    ],
    weight: 0.7,
  },
  {
    kind: "knowledge_gap",
    patterns: [/i (don'?t|do not) know/i, /insufficient (information|context)/i, /unable to determine/i],
    weight: 0.7,
  },
  {
    kind: "planning_failure",
    patterns: [/no plan/i, /plan (was )?(empty|invalid|incoherent)/i, /circular dependency/i, /zero phases/i],
    weight: 0.7,
  },
  {
    kind: "execution_failure",
    patterns: [/exit code [1-9]/i, /process (failed|crashed)/i, /assertion failed/i, /test.* failed/i],
    weight: 0.6,
  },
  {
    kind: "skill_gap",
    patterns: [/repeated(ly)? failed/i, /same error/i, /could not complete after/i],
    weight: 0.5,
  },
];

/**
 * Classify a failure from its message and context.
 *
 * Returns `fundamental_unknown` with low confidence rather than guessing. An
 * over-confident misclassification sends recovery down the wrong path, which
 * costs more than admitting ignorance.
 */
export function classifyFailure(
  message: string,
  context: { attemptCount?: number; phase?: string } = {},
): FailureClassification {
  const text = message ?? "";
  const matches: Array<{ kind: FailureKind; weight: number; signal: string }> = [];

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        matches.push({ kind: rule.kind, weight: rule.weight, signal: pattern.source });
        break;
      }
    }
  }

  if (matches.length === 0) {
    // Repeated identical failures point to a skill gap even when the message
    // matches nothing: the agent is capable of issuing the action but not of
    // getting it right.
    if ((context.attemptCount ?? 0) >= 2) {
      return {
        kind: "skill_gap",
        confidence: 0.4,
        signals: [`${context.attemptCount} attempts with no matching signature`],
        rationale: "Unrecognised error repeated across attempts, suggesting the agent cannot drive this operation.",
      };
    }
    return {
      kind: "fundamental_unknown",
      confidence: 0.2,
      signals: [],
      rationale: "No classification rule matched. Treating as unknown rather than guessing a recovery path.",
    };
  }

  const best = matches.reduce((top, item) => (item.weight > top.weight ? item : top));
  // Competing classifications reduce confidence.
  const distinct = new Set(matches.map((item) => item.kind));
  const confidence = distinct.size > 1 ? best.weight * 0.8 : best.weight;

  return {
    kind: best.kind,
    confidence: Math.min(1, confidence),
    signals: matches.map((item) => `${item.kind}:/${item.signal}/`),
    rationale:
      distinct.size > 1
        ? `Matched ${distinct.size} categories; strongest is ${best.kind}.`
        : `Matched ${best.kind} signature.`,
  };
}

export interface RecoveryBudget {
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly budgetExceeded?: string | undefined;
}

/**
 * Choose a recovery strategy from a classification.
 *
 * The loop is bounded. Unbounded recovery is how an agent burns a budget
 * repeating an action that cannot succeed.
 */
export function chooseRecovery(
  classification: FailureClassification,
  budget: RecoveryBudget,
): RecoveryDecision {
  if (budget.budgetExceeded) {
    return {
      strategy: "abort",
      rationale: `Cannot recover: ${budget.budgetExceeded}.`,
      canContinue: false,
    };
  }

  if (budget.attemptsUsed >= budget.maxAttempts) {
    return {
      strategy: "ask_human",
      rationale: `Exhausted ${budget.maxAttempts} recovery attempts; escalating rather than looping.`,
      canContinue: false,
    };
  }

  switch (classification.kind) {
    case "security_block":
      // Never auto-retry a safety refusal. Retrying a blocked action is an
      // attempt to circumvent the block.
      return {
        strategy: "abort",
        rationale: "A safety gate refused this action. Retrying would be an attempt to bypass it.",
        canContinue: false,
      };

    case "permission_gap":
      return {
        strategy: "request_permission",
        rationale: "The operation is well-formed but denied; escalate for authorisation.",
        canContinue: true,
      };

    case "tool_gap":
      return {
        strategy: "acquire_capability",
        rationale: "No tool exists for this operation. Retrying cannot help; the capability must be built.",
        canContinue: true,
      };

    case "skill_gap":
      return {
        strategy: "replan",
        rationale: "The tool exists but the approach is not working. A different approach is needed.",
        canContinue: true,
        directive:
          "The tools are available but the approach is not working. Do not repeat the same steps: " +
          "choose a different approach and say what changed.",
      };

    case "knowledge_gap":
      return {
        strategy: "replan",
        rationale: "Missing information; re-plan with a research step before acting.",
        canContinue: true,
        directive:
          "Something needed is unknown. Find that information first — read the relevant file or " +
          "inspect the actual state — and only then act.",
      };

    case "interface_gap":
      return {
        strategy: "change_tool",
        rationale: "The interface did not match expectations; try a different tool or calling convention.",
        canContinue: true,
        directive:
          "The interface did not behave as assumed. Check its real signature or output shape " +
          "before calling it again, or use a different tool.",
      };

    case "verification_gap":
      return {
        strategy: "add_verification",
        rationale: "The work may be correct but nothing can confirm it. Add a verifier before claiming success.",
        canContinue: true,
      };

    case "planning_failure":
      return {
        directive:
          "The previous plan did not work. Take a different approach rather than repeating " +
          "the same steps: state the new approach first, then carry it out.",
        strategy: "replan",
        rationale: "The plan itself was the problem.",
        canContinue: true,
      };

    case "reasoning_failure":
      return {
        strategy: "change_model",
        rationale: "Invalid reasoning; a stronger reasoning model may succeed.",
        canContinue: true,
        directive:
          "The previous reasoning contained an error. Work through the problem step by step and " +
          "check each conclusion against the actual code or data before relying on it.",
      };

    case "model_failure":
      return {
        strategy: "change_model",
        rationale: "The model refused or produced unusable output.",
        canContinue: true,
        directive:
          "The previous response was unusable. Produce a direct, concrete answer in the expected " +
          "format.",
      };

    case "environment_failure":
      return {
        strategy: "retry_with_backoff",
        rationale: "Environment faults are often transient.",
        canContinue: true,
        backoffMs: backoffFor(budget.attemptsUsed),
        directive:
          "The environment failed, not your approach. Retry the same work after a short wait, " +
          "and check the dependency is reachable before repeating the failing step.",
      };

    case "timeout":
      return {
        strategy: "reduce_scope",
        rationale: "Repeating the same work under the same limit will time out again; narrow it.",
        canContinue: true,
        directive:
          "The previous attempt timed out. Do a smaller piece of the goal this time: " +
          "pick the narrowest slice that is still useful, and finish it rather than " +
          "attempting everything again.",
      };

    case "resource_failure":
      return {
        strategy: "abort",
        rationale: "Out of budget or quota. Continuing would spend resources that are not available.",
        canContinue: false,
      };

    case "execution_failure":
      return {
        strategy: "retry",
        rationale: "The action was appropriate; execution failed and may succeed on retry.",
        canContinue: true,
      };

    case "fundamental_unknown":
    default:
      return {
        strategy: "ask_human",
        rationale: "The failure could not be classified, so no recovery strategy can be justified.",
        canContinue: false,
      };
  }
}
