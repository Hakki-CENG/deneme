/**
 * Verification Factory — a task result is a verdict, not the word "done".
 *
 * The rule: the agent saying it finished is not evidence that it finished.
 * Something outside the agent has to check, and the strength of that check
 * determines how much autonomy the result earns.
 *
 *   V1 Formal     compiler, typecheck, schema, invariant      → strongest
 *   V2 Empirical  tests, benchmarks, actual execution         → strong
 *   V3 Consensus  several models or evaluators agreeing       → controlled
 *   V4 Unverifiable  no objective check exists                → needs a human
 *
 * A verifier returns PASS, FAIL or UNCERTAIN. UNCERTAIN is a first-class
 * answer: "the check could not run" must never quietly become "the check
 * passed" — that collapse is the bug class this codebase already had in its
 * security module, where every audit check was `async () => true`.
 */

import type { ExecutionStatus } from "./execution-status.js";

export type VerifierTier = "V1_formal" | "V2_empirical" | "V3_consensus" | "V4_unverifiable";

export type Verdict = "pass" | "fail" | "uncertain";

/**
 * What a verifier actually checks, as opposed to how strongly it checks it.
 *
 * `tier` measures the strength of the method: a formal check either passes or it
 * does not. It says nothing about relevance. A build check is V1_formal and it
 * is also completely silent on whether the task's goal was achieved -- it proves
 * the workspace still compiles, which is necessary and not sufficient.
 *
 * Measured, that distinction was the difference between a true and a false
 * report: a task whose goal was to create a file returned `succeeded` with
 * verification `pass` while the file did not exist, because the only verifier
 * was the toolchain build. Nothing in the loop could see that the evidence was
 * about the wrong thing.
 *
 *   goal      - checks the claim the task made.
 *   workspace - checks the workspace is still sound. Necessary, not sufficient.
 *
 * Optional, defaulting to `goal`, so every verifier written before this field
 * keeps the meaning it had.
 */
export type VerifierScope = "goal" | "workspace";

export interface VerifierOutcome {
  readonly verdict: Verdict;
  readonly tier: VerifierTier;
  readonly verifier: string;
  /** What justifies the verdict. Required — a verdict without evidence is an opinion. */
  readonly evidence: string;
  /** 0..1. Meaningful only for `pass`/`fail`; `uncertain` should report low. */
  readonly confidence: number;
  readonly durationMs?: number | undefined;
  /** Carried through from the verifier, so a caller can see what was checked. */
  readonly scope: VerifierScope;
}

/**
 * What a plan step asks to have checked (B6).
 *
 * Structural on purpose: `verification-factory` must not import the plan types,
 * because the plan types import the status types and the factory has to stay
 * buildable from either direction. Any object with these fields is a claim.
 */
export interface StepClaim {
  readonly description: string;
  /** What must be true afterwards. Absent when the planner specified nothing. */
  readonly successCriterion?: string | undefined;
}

export interface Verifier {
  readonly name: string;
  readonly tier: VerifierTier;
  /** Defaults to `goal`; see `VerifierScope`. */
  readonly scope?: VerifierScope | undefined;
  /**
   * Whether this verifier can check a plan step's claim (B6).
   *
   * This is the automated selection P1.6 asks for: the planner states *what
   * must be true*, not which verifier to use — a planner cannot know what the
   * host registered. Each verifier declares which claims it can evaluate, and
   * step verification assembles the panel from the verifiers that answered yes.
   *
   * Absent means "not a step verifier": the verifier only speaks about the
   * goal or the workspace as a whole.
   */
  readonly appliesTo?: ((step: StepClaim) => boolean) | undefined;
  /** Cheap check for whether this verifier can run at all in this context. */
  readonly canRun?: (() => Promise<boolean>) | undefined;
  /**
   * Produces the verdict and its evidence.
   *
   * `tier`, `verifier` and `scope` are omitted because the factory fills them
   * from the verifier itself: a run result that restated them could disagree
   * with the verifier that produced it, and there would be no way to tell which
   * was true.
   */
  readonly run: () => Promise<
    Omit<VerifierOutcome, "tier" | "verifier" | "scope">
  >;
}

/**
 * Raised when work claims completion that cannot be verified.
 *
 * Aurora's required response to this is not to guess. It is to say, in effect,
 * "I cannot reliably confirm this result" — which is the honest answer and the
 * single most effective guard against confidently reporting a hallucinated
 * success.
 */
export class VerificationGapError extends Error {
  readonly claim: string;
  readonly attempted: readonly string[];
  readonly reason: string;

  constructor(claim: string, attempted: readonly string[], reason: string) {
    super(
      `Cannot verify the claim "${claim}". ` +
        (attempted.length > 0
          ? `Attempted verifiers: ${attempted.join(", ")}. `
          : "No verifier was available. ") +
        reason,
    );
    this.name = "VerificationGapError";
    this.claim = claim;
    this.attempted = attempted;
    this.reason = reason;
  }
}

const TIER_RANK: Record<VerifierTier, number> = {
  V1_formal: 4,
  V2_empirical: 3,
  V3_consensus: 2,
  V4_unverifiable: 1,
};

/** How much autonomy a verdict at this tier justifies. */
export function autonomyFor(tier: VerifierTier): "high" | "controlled" | "approval_required" {
  if (tier === "V1_formal" || tier === "V2_empirical") return "high";
  if (tier === "V3_consensus") return "controlled";
  return "approval_required";
}

export interface VerificationReport {
  readonly verdict: Verdict;
  readonly results: readonly VerifierOutcome[];
  /** Strongest tier that returned a definite pass/fail. */
  readonly strongestTier: VerifierTier | undefined;
  readonly autonomy: "high" | "controlled" | "approval_required";
  readonly status: ExecutionStatus;
  readonly summary: string;
}

/**
 * Runs verifiers strongest-first and combines their verdicts.
 */
export class VerificationFactory {
  private readonly verifiers: Verifier[] = [];

  register(verifier: Verifier): this {
    if (this.verifiers.some((item) => item.name === verifier.name)) {
      throw new Error(`Verifier '${verifier.name}' is already registered.`);
    }
    this.verifiers.push(verifier);
    return this;
  }

  registered(): readonly Verifier[] {
    return this.verifiers;
  }

  /**
   * Verify a claim.
   *
   * Combination rules:
   *   - Any FAIL from a formal or empirical verifier is decisive.
   *   - A PASS needs at least one V1/V2 verifier, or a V3 panel that reached
   *     agreement among independent evaluators (the panel enforces that; see
   *     `consensus-verifier.ts`).
   *   - No verifier able to run at all → UNCERTAIN, never PASS.
   */
  async verify(claim: string): Promise<VerificationReport> {
    const ordered = [...this.verifiers].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]);
    const results: VerifierOutcome[] = [];

    for (const verifier of ordered) {
      if (verifier.canRun) {
        const available = await verifier.canRun().catch(() => false);
        if (!available) {
          results.push({
            verdict: "uncertain",
            tier: verifier.tier,
            verifier: verifier.name,
            evidence: "Verifier reported it could not run in this environment.",
            confidence: 0,
            scope: verifier.scope ?? "goal",
          });
          continue;
        }
      }

      const startedAt = Date.now();
      try {
        const partial = await verifier.run();
        results.push({
          ...partial,
          tier: verifier.tier,
          verifier: verifier.name,
          durationMs: Date.now() - startedAt,
          scope: verifier.scope ?? "goal",
        });
      } catch (error) {
        // A verifier that throws has NOT passed. This is the trap: a try/catch
        // that swallows the error and moves on turns a broken check into a
        // silent pass.
        results.push({
          verdict: "uncertain",
          scope: verifier.scope ?? "goal",
          tier: verifier.tier,
          verifier: verifier.name,
          evidence: `Verifier threw: ${error instanceof Error ? error.message : String(error)}`,
          confidence: 0,
          durationMs: Date.now() - startedAt,
        });
      }
    }

    return this.combine(claim, results);
  }

  private combine(claim: string, results: readonly VerifierOutcome[]): VerificationReport {
    const definite = results.filter((item) => item.verdict !== "uncertain");
    const strongest = definite.length > 0
      ? definite.reduce((best, item) => (TIER_RANK[item.tier] > TIER_RANK[best.tier] ? item : best)).tier
      : undefined;

    const hardFail = results.find(
      (item) => item.verdict === "fail" && (item.tier === "V1_formal" || item.tier === "V2_empirical"),
    );
    if (hardFail) {
      return {
        verdict: "fail",
        results,
        strongestTier: hardFail.tier,
        autonomy: autonomyFor(hardFail.tier),
        status: "failed",
        summary: `Failed ${hardFail.verifier}: ${hardFail.evidence}`,
      };
    }

    const objectivePass = results.find(
      (item) => item.verdict === "pass" && (item.tier === "V1_formal" || item.tier === "V2_empirical"),
    );
    if (objectivePass) {
      return {
        verdict: "pass",
        results,
        strongestTier: objectivePass.tier,
        autonomy: autonomyFor(objectivePass.tier),
        status: "succeeded",
        summary: `Verified by ${objectivePass.verifier}: ${objectivePass.evidence}`,
      };
    }

    // Counting V3 *results* was the wrong unit. A single consensus verifier
    // that polls an independent panel and enforces independence internally
    // produces one result, and the old rule ignored it for not being two —
    // while two verifiers wrapping the same model would have satisfied it.
    // A V3 verifier is trusted to have established its own independence; the
    // factory's job is to prefer objective evidence over it, not to re-derive
    // it from the result count.
    const consensus = results.filter((item) => item.tier === "V3_consensus" && item.verdict !== "uncertain");
    if (consensus.length >= 1 && consensus.every((item) => item.verdict === "pass")) {
      return {
        verdict: "pass",
        results,
        strongestTier: "V3_consensus",
        autonomy: "controlled",
        status: "succeeded",
        summary: `Consensus pass from ${consensus.length} panel(s): ${consensus[0]?.evidence ?? ""}`.trim(),
      };
    }
    if (consensus.length >= 1 && consensus.some((item) => item.verdict === "fail")) {
      return {
        verdict: "fail",
        results,
        strongestTier: "V3_consensus",
        autonomy: "controlled",
        status: "failed",
        summary: "Evaluators disagreed or rejected the result.",
      };
    }

    return {
      verdict: "uncertain",
      results,
      strongestTier: strongest,
      autonomy: "approval_required",
      status: "unverified",
      summary:
        results.length === 0
          ? `No verifier was registered for "${claim}".`
          : `No verifier could establish whether "${claim}" holds (${results.length} attempted).`,
    };
  }

  /**
   * Verify, or refuse.
   *
   * Use where a caller would otherwise treat "unverified" as good news.
   */
  async verifyOrThrow(claim: string): Promise<VerificationReport> {
    const report = await this.verify(claim);
    if (report.verdict === "uncertain") {
      throw new VerificationGapError(
        claim,
        report.results.map((item) => item.verifier),
        report.summary,
      );
    }
    return report;
  }
}

/** A V1 verifier from a command that must exit zero (tsc, schema check). */
export function formalVerifier(
  name: string,
  run: () => Promise<{ ok: boolean; output: string }>,
  scope: VerifierScope = "goal",
): Verifier {
  return {
    name,
    tier: "V1_formal",
    scope,
    run: async () => {
      const { ok, output } = await run();
      return {
        verdict: ok ? ("pass" as const) : ("fail" as const),
        evidence: output.slice(0, 2000) || (ok ? "Exited zero." : "Exited non-zero."),
        confidence: ok ? 0.95 : 0.95,
      };
    },
  };
}

/** A V2 verifier from a test run. */
export function empiricalVerifier(
  name: string,
  run: () => Promise<{ passed: number; failed: number; output: string }>,
  scope: VerifierScope = "goal",
): Verifier {
  return {
    name,
    tier: "V2_empirical",
    scope,
    run: async () => {
      const { passed, failed, output } = await run();
      // Zero tests is not a pass. An empty suite proves nothing.
      if (passed + failed === 0) {
        return {
          verdict: "uncertain" as const,
          evidence: `No tests ran. ${output.slice(0, 500)}`,
          confidence: 0,
        };
      }
      return {
        verdict: failed === 0 ? ("pass" as const) : ("fail" as const),
        evidence: `${passed} passed, ${failed} failed. ${output.slice(0, 1500)}`,
        confidence: 0.9,
      };
    },
  };
}

/** One workspace-level acceptance check. */
export interface AcceptanceCheck {
  /** Path relative to the workspace root. */
  readonly file: string;
  /** Substrings the file must contain. */
  readonly contains?: readonly string[] | undefined;
  /** Pattern the file content must match. */
  readonly matches?: RegExp | undefined;
}

/**
 * A V2 verifier that inspects the workspace the agent actually worked in.
 *
 * This is the check the eval suite leans on hardest — "did the file get
 * written, with the right content?" — and it is the one most easily faked. Two
 * rules keep it honest:
 *
 *   - **No workspace means `uncertain`, never `pass`.** A missing workspace is
 *     an absence of evidence, and absence of evidence is not proof of work.
 *   - **Paths may not escape the workspace.** A check that reads
 *     `../../package.json` would pass on a repository file the agent never
 *     touched. That is the file-grading version of fabricated success.
 */
export function acceptanceVerifier(
  name: string,
  workspace: string | undefined,
  checks: readonly AcceptanceCheck[],
): Verifier {
  return {
    name,
    tier: "V2_empirical",
    run: async () => {
      if (!workspace) {
        return {
          verdict: "uncertain" as const,
          evidence:
            "No workspace was supplied, so file-based acceptance could not be checked. " +
            "Reporting uncertain rather than assuming the work was done.",
          confidence: 0,
        };
      }
      if (checks.length === 0) {
        return {
          verdict: "uncertain" as const,
          evidence: "No acceptance checks were defined. An empty checklist proves nothing.",
          confidence: 0,
        };
      }

      const { readFile } = await import("node:fs/promises");
      const { resolve, sep } = await import("node:path");
      const root = resolve(workspace);
      const failures: string[] = [];
      const passes: string[] = [];

      for (const check of checks) {
        const target = resolve(root, check.file);
        if (target !== root && !target.startsWith(root + sep)) {
          failures.push(`${check.file}: resolves outside the workspace`);
          continue;
        }

        let content: string;
        try {
          content = await readFile(target, "utf8");
        } catch {
          failures.push(`${check.file}: not found`);
          continue;
        }

        const missing = (check.contains ?? []).filter((needle) => !content.includes(needle));
        if (missing.length > 0) {
          failures.push(`${check.file}: missing ${missing.map((item) => JSON.stringify(item)).join(", ")}`);
          continue;
        }
        if (check.matches && !check.matches.test(content)) {
          failures.push(`${check.file}: does not match ${String(check.matches)}`);
          continue;
        }
        passes.push(check.file);
      }

      return {
        verdict: failures.length === 0 ? ("pass" as const) : ("fail" as const),
        evidence:
          failures.length === 0
            ? `${passes.length} acceptance check(s) passed: ${passes.join(", ")}`
            : `${failures.length} of ${checks.length} failed. ${failures.join("; ")}`,
        confidence: 0.9,
      };
    },
  };
}
