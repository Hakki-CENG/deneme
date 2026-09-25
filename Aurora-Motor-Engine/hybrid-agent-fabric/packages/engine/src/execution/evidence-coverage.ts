/**
 * B7 (P1.7): evidence-first completion — say what was checked and what was not.
 *
 * What was measured before this existed. A task whose understanding extracted
 * an expected artifact ("hello.txt containing Hi") and two success criteria,
 * run with a workspace-scoped verifier that passed ("tsc clean"), reported:
 *
 *     status=unverified verdict=uncertain
 *     summary=…downgraded to uncertain: the evidence is workspace-scoped (build)…
 *
 * The downgrade was correct — but nowhere did the report say that the artifact
 * the goal asked for and the two criteria it named were never checked by
 * anything. The reader had to take `report.understanding` and
 * `report.verification.results` and do the comparison themselves. "Kullanıcıya
 * neyin doğrulandığını göster" (P1.7) is exactly the half that was missing.
 *
 * The rule that keeps this honest: **a verifier covers a requirement only by
 * declaring it.** Coverage comes from the same `appliesTo` declaration B6 uses
 * for steps (the planner cannot know what the host registered, and neither can
 * this module). A verifier with no `appliesTo` may well have checked the right
 * thing — but it never said so, and "probably checked" is not a reportable fact.
 */
import type { Verifier } from "./verification-factory.js";
import type { VerificationReport } from "./verification-factory.js";
import type { GoalUnderstanding, TaskContext } from "./task-context.js";

/** Something the goal says must be true of the finished work (P1.7). */
export interface EvidenceRequirement {
  /** Where the requirement came from: the goal's artifact, or a named criterion. */
  readonly kind: "artifact" | "criterion";
  readonly description: string;
}

/** One requirement, assessed against the verifier pool that ran. */
export interface EvidenceAssessment {
  readonly requirement: EvidenceRequirement;
  /**
   * "checked" when at least one verifier declared coverage of this requirement
   * (through `appliesTo`) and ran; "unchecked" when none did.
   */
  readonly status: "checked" | "unchecked";
  /** The verifiers that declared coverage, with the verdict each produced. */
  readonly verifiers: readonly { name: string; verdict: string }[];
}

/** The whole inventory, for the report. */
export interface EvidenceCoverage {
  readonly requirements: readonly EvidenceAssessment[];
  /** How many requirements were checked by a declaring verifier. */
  readonly checked: number;
}

/**
 * Turn an understanding into the requirements its goal states.
 *
 * Only what the understanding actually extracted: the expected artifact, when
 * there is one, and each success criterion. No artifact and no criteria means
 * no requirements — an empty inventory, which is a fact about the goal, not a
 * failure to look.
 */
export function buildEvidenceRequirements(
  understanding: GoalUnderstanding | undefined,
): readonly EvidenceRequirement[] {
  if (understanding === undefined) return [];
  const requirements: EvidenceRequirement[] = [];
  if (understanding.expectedArtifact !== undefined) {
    requirements.push({ kind: "artifact", description: understanding.expectedArtifact });
  }
  for (const criterion of understanding.successCriteria) {
    requirements.push({ kind: "criterion", description: criterion });
  }
  return requirements;
}

/**
 * Assess each requirement against the verifiers that ran for the goal.
 *
 * A verifier covers a requirement when its `appliesTo` declaration says so for
 * the requirement's claim. The verdict is read from the verification report by
 * verifier name; a declaring verifier that produced no result is recorded as
 * "uncertain", because absent evidence is not a pass — the same rule the
 * factory itself applies.
 */
export function assessEvidenceCoverage(
  requirements: readonly EvidenceRequirement[],
  pool: readonly Verifier[],
  verification: VerificationReport | undefined,
): EvidenceCoverage {
  const verdictByName = new Map(
    (verification?.results ?? []).map((result) => [result.verifier, result.verdict]),
  );

  const assessments: EvidenceAssessment[] = requirements.map((requirement) => {
    // The claim shape is the one `appliesTo` already understands (B6): the
    // requirement's description is the criterion a verifier would check.
    const claim = {
      description: requirement.description,
      successCriterion: requirement.description,
    };
    const covering = pool.filter((verifier) => verifier.appliesTo?.(claim) === true);
    const verifiers = covering.map((verifier) => ({
      name: verifier.name,
      verdict: verdictByName.get(verifier.name) ?? "uncertain",
    }));
    return {
      requirement,
      // Declared coverage is necessary but a run is what makes it "checked":
      // a verifier that never produced a result left the requirement no
      // better off, and the assessment shows that as verdict "uncertain"
      // rather than as silence.
      status: covering.length > 0 ? "checked" : "unchecked",
      verifiers,
    };
  });

  return { requirements: assessments, checked: assessments.filter((a) => a.status === "checked").length };
}

/** For summaries: `0/3 requirement(s) checked`, or nothing when there was nothing to check. */
export function evidenceCoverageNote(coverage: TaskContext["evidenceCoverage"]): string {
  if (coverage === undefined || coverage.requirements.length === 0) return "";
  return ` Evidence: ${coverage.checked}/${coverage.requirements.length} requirement(s) checked.`;
}
