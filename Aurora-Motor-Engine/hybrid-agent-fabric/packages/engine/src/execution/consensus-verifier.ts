/**
 * V3 consensus verification: several evaluators judging the same claim.
 *
 * `VerificationFactory` has always known how to *consume* V3 results — it
 * requires at least two non-uncertain V3 verdicts and fails the claim if any of
 * them dissents. Nothing ever *produced* one. The tier was declared, handled,
 * documented, and unreachable.
 *
 * Consensus is the weakest tier that can still pass a claim, and it earns that
 * position only under conditions that are easy to lose:
 *
 *  - **Independence.** Three evaluators sharing one model are one evaluator
 *    with three chances to repeat its mistake. `consensusVerifier` refuses to
 *    treat same-source judges as agreement.
 *  - **Dissent counts.** One "fail" among four "pass" verdicts blocks the
 *    claim. Majority voting would let a real objection be outvoted, and the
 *    objection is the only signal here with evidence behind it.
 *  - **Abstention is not assent.** An evaluator that errors or returns
 *    `uncertain` is removed from the pool, never counted as agreement.
 *
 * What this tier cannot do: establish ground truth. Agreement between
 * evaluators is evidence about evaluators. That is why a V3 pass yields
 * `controlled` autonomy rather than `high`, and why an available V1/V2 verifier
 * always outranks it.
 */
import type { Verifier, VerifierOutcome } from "./verification-factory.js";

/** What a verifier's `run()` returns: the outcome minus fields the factory fills in. */
// `scope` is omitted for the same reason `tier` and `verifier` are: the factory
// fills it from the verifier, and a run result that restated it could disagree
// with the verifier that produced it.
type RunResult = Omit<VerifierOutcome, "tier" | "verifier" | "scope">;

/** One evaluator's judgement of a claim. */
export interface EvaluatorJudgement {
  readonly verdict: "pass" | "fail" | "uncertain";
  /** Why. Required: a verdict with no reasoning cannot be reviewed. */
  readonly reasoning: string;
  /** Optional self-reported confidence in [0, 1]. */
  readonly confidence?: number | undefined;
}

export interface Evaluator {
  /** Identifies the judge in evidence. */
  readonly name: string;
  /**
   * What this evaluator's judgement depends on — usually a model id.
   *
   * Evaluators sharing a source are counted once. Two prompts against the same
   * model produce correlated errors, and correlated errors are exactly what
   * consensus is supposed to filter out.
   */
  readonly source: string;
  readonly judge: (claim: string) => Promise<EvaluatorJudgement>;
}

/** Minimum independent evaluators before consensus means anything. */
export const MIN_INDEPENDENT_EVALUATORS = 2;

interface Judged {
  readonly evaluator: Evaluator;
  readonly judgement: EvaluatorJudgement | undefined;
  readonly error: string | undefined;
}

/**
 * How many distinct sources are represented among these judgements.
 *
 * Exported because callers assembling evaluator panels need to check this
 * before they rely on the result, and because the number belongs in evidence.
 */
export function independentSources(evaluators: readonly Evaluator[]): number {
  return new Set(evaluators.map((evaluator) => evaluator.source)).size;
}

/**
 * Build a V3 verifier from a panel of evaluators.
 *
 * The claim is bound at construction because `Verifier.run()` takes no
 * arguments: the factory calls every verifier the same way.
 *
 * Returns `uncertain` — never `pass` — whenever the panel cannot support a
 * conclusion: too few independent sources, too many abstentions, any dissent.
 * `uncertain` routes to `unverified` in the factory, which is the honest
 * outcome for "we asked and did not find out".
 */
export function consensusVerifier(
  name: string,
  claim: string,
  evaluators: readonly Evaluator[],
  options: { minSources?: number | undefined } = {},
): Verifier {
  const minSources = options.minSources ?? MIN_INDEPENDENT_EVALUATORS;

  return {
    name,
    tier: "V3_consensus",
    // A panel is asked about the claim itself, so its scope is the goal.
    scope: "goal",
    run: async (): Promise<RunResult> => {
      if (independentSources(evaluators) < minSources) {
        // Refusing up front is deliberate: running the panel anyway would
        // produce agreement that looks like consensus and is not.
        return {
          verdict: "uncertain",
          evidence:
            `Consensus needs ${minSources} independent sources; ` +
            `got ${independentSources(evaluators)} across ${evaluators.length} evaluator(s).`,
          confidence: 0,
        };
      }

      // Evaluators run concurrently and independently. Sequential execution
      // would invite passing one judge's answer to the next, which destroys the
      // independence the tier depends on.
      const judged: Judged[] = await Promise.all(
        evaluators.map(async (evaluator) => {
          try {
            return { evaluator, judgement: await evaluator.judge(claim), error: undefined };
          } catch (error) {
            return {
              evaluator,
              judgement: undefined,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );

      const answered = judged.filter(
        (item): item is Judged & { judgement: EvaluatorJudgement } =>
          item.judgement !== undefined && item.judgement.verdict !== "uncertain",
      );
      const abstained = judged.length - answered.length;

      // One judgement per source. When a source is represented more than once,
      // its votes must not be double-counted; a dissent within a source is kept
      // over an assent, because the objection carries the evidence.
      const bySource = new Map<string, (typeof answered)[number]>();
      for (const item of answered) {
        const existing = bySource.get(item.evaluator.source);
        if (existing === undefined || item.judgement.verdict === "fail") {
          bySource.set(item.evaluator.source, item);
        }
      }
      const votes = [...bySource.values()];

      const describe = (items: typeof votes): string =>
        items
          .map(
            (item) =>
              `${item.evaluator.name} (${item.evaluator.source}): ${item.judgement.verdict} — ${item.judgement.reasoning}`,
          )
          .join(" | ");

      if (votes.length < minSources) {
        return {
          verdict: "uncertain",
          evidence:
            `Only ${votes.length} independent source(s) reached a verdict ` +
            `(${abstained} abstained or errored). ${describe(votes)}`.trim(),
          confidence: 0,
        };
      }

      const dissent = votes.filter((item) => item.judgement.verdict === "fail");
      if (dissent.length > 0) {
        // Any dissent blocks. Outvoting an objection discards the only verdict
        // in the panel that came with a reason to doubt the claim.
        return {
          verdict: "fail",
          evidence:
            `${dissent.length} of ${votes.length} independent evaluator(s) rejected the claim. ` +
            describe(votes),
          confidence: 0.8,
        };
      }

      // Confidence rises with the number of independent sources but is capped
      // below what V1/V2 report: agreeing evaluators are still only evaluators.
      const reported = votes
        .map((item) => item.judgement.confidence)
        .filter((value): value is number => typeof value === "number");
      const meanSelfReported =
        reported.length > 0 ? reported.reduce((a, b) => a + b, 0) / reported.length : 0.6;
      const confidence = Math.min(0.75, meanSelfReported * Math.min(1, votes.length / 3));

      return {
        verdict: "pass",
        evidence:
          `${votes.length} independent evaluator(s) agreed` +
          (abstained > 0 ? ` (${abstained} abstained)` : "") +
          `. ${describe(votes)}`,
        confidence,
      };
    },
  };
}
