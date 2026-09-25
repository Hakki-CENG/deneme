/**
 * B7 (P1.7): evidence-first completion.
 *
 * What was measured before this existed. A task whose understanding extracted
 * an expected artifact ("hello.txt containing Hi") and two success criteria,
 * run with a workspace-scoped verifier that passed ("tsc clean, 0 errors"),
 * reported `unverified` with a correct downgrade reason — and never said that
 * the artifact the goal asked for and the criteria it named were checked by
 * nothing. The reader had to diff `report.understanding` against
 * `report.verification.results` by hand. And when `acceptUnverified` was on,
 * the report said "executed" without naming the actual reason: the agent's
 * word, accepted by configuration.
 */
import { describe, expect, it } from "vitest";

import {
  assessEvidenceCoverage,
  buildEvidenceRequirements,
  evidenceCoverageNote,
} from "../src/execution/evidence-coverage.js";
import { UnifiedExecutionLoop } from "../src/execution/unified-execution-loop.js";
import { formalVerifier, type Verifier } from "../src/execution/verification-factory.js";
import type { GoalUnderstanding } from "../src/execution/task-context.js";

const goal = "Create hello.txt with Hi";

function understanding(partial: Partial<GoalUnderstanding> = {}): GoalUnderstanding {
  return {
    goal,
    constraints: [],
    preferences: [],
    risks: [],
    expectedArtifact: "hello.txt containing Hi",
    successCriteria: ["hello.txt exists", "hello.txt contains Hi"],
    missingInformation: [],
    ambiguity: 0,
    clarifyingQuestions: [],
    recommendation: "act",
    source: "model",
    ...partial,
  };
}

describe("requirements come from what the goal actually stated", () => {
  it("builds one artifact requirement and one per success criterion", () => {
    const requirements = buildEvidenceRequirements(understanding());
    expect(requirements).toEqual([
      { kind: "artifact", description: "hello.txt containing Hi" },
      { kind: "criterion", description: "hello.txt exists" },
      { kind: "criterion", description: "hello.txt contains Hi" },
    ]);
  });

  it("builds nothing when the goal stated nothing — an empty inventory, not a guess", () => {
    expect(buildEvidenceRequirements(undefined)).toEqual([]);
    expect(buildEvidenceRequirements(understanding({ expectedArtifact: undefined, successCriteria: [] }))).toEqual([]);
  });
});

describe("coverage is declared by verifiers, not inferred", () => {
  it("marks a requirement unchecked when no verifier declared coverage of it", () => {
    const build = formalVerifier("build", async () => ({ ok: true, output: "tsc clean" }), "workspace");
    const coverage = assessEvidenceCoverage(
      buildEvidenceRequirements(understanding()),
      [build],
      { verdict: "uncertain", results: [], strongestTier: undefined, autonomy: "ask", status: "unverified", summary: "" },
    );

    expect(coverage.checked).toBe(0);
    expect(coverage.requirements.every((a) => a.status === "unchecked")).toBe(true);
  });

  it("marks a requirement checked when a verifier declared it and ran", () => {
    const hello: Verifier = {
      ...formalVerifier("file-hello", async () => ({ ok: true, output: "hello.txt contains Hi" })),
      appliesTo: (claim) => (claim.successCriterion ?? "").includes("hello.txt"),
    };
    const coverage = assessEvidenceCoverage(
      buildEvidenceRequirements(understanding()),
      [hello],
      {
        verdict: "pass",
        strongestTier: "V1_formal",
        autonomy: "autonomous",
        status: "succeeded",
        summary: "",
        results: [
          { verdict: "pass", tier: "V1_formal", verifier: "file-hello", evidence: "read the file", confidence: 0.95, scope: "goal" },
        ],
      },
    );

    expect(coverage.checked).toBe(3);
    expect(coverage.requirements.every((a) => a.status === "checked")).toBe(true);
    expect(coverage.requirements[0]?.verifiers).toEqual([{ name: "file-hello", verdict: "pass" }]);
  });

  it("does not count a goal verifier that never declared what it checks", () => {
    // The core honesty rule: a verifier with no `appliesTo` may well have
    // checked the right thing — but it never said so, and "probably checked"
    // is not a reportable fact. This is the case the assessment must not
    // round up to "checked".
    const goalScopedButSilent = formalVerifier("goal-vibes", async () => ({
      ok: true,
      output: "seems fine",
    }));
    const coverage = assessEvidenceCoverage(
      buildEvidenceRequirements(understanding()),
      [goalScopedButSilent],
      {
        verdict: "pass",
        strongestTier: "V1_formal",
        autonomy: "autonomous",
        status: "succeeded",
        summary: "",
        results: [
          { verdict: "pass", tier: "V1_formal", verifier: "goal-vibes", evidence: "seems fine", confidence: 0.95, scope: "goal" },
        ],
      },
    );

    // The goal itself verified; the stated requirements were still not shown
    // to be checked, and the report must keep those two facts apart.
    expect(coverage.checked).toBe(0);
    expect(coverage.requirements.every((a) => a.status === "unchecked")).toBe(true);
  });

  it("records the verdict a declaring verifier actually produced", () => {
    const refuting: Verifier = {
      ...formalVerifier("file-hello", async () => ({ ok: false, output: "no such file" })),
      appliesTo: () => true,
    };
    const coverage = assessEvidenceCoverage(
      [{ kind: "artifact", description: "hello.txt" }],
      [refuting],
      {
        verdict: "fail",
        strongestTier: "V1_formal",
        autonomy: "ask",
        status: "failed",
        summary: "",
        results: [
          { verdict: "fail", tier: "V1_formal", verifier: "file-hello", evidence: "no such file", confidence: 0.95, scope: "goal" },
        ],
      },
    );

    // Checked — and the check refuted it. "Checked" reports that the question
    // was asked, not that the answer was nice.
    expect(coverage.requirements[0]?.status).toBe("checked");
    expect(coverage.requirements[0]?.verifiers).toEqual([{ name: "file-hello", verdict: "fail" }]);
  });

  it("treats a declaring verifier that produced no result as uncertain, not as a pass", () => {
    const silent: Verifier = {
      ...formalVerifier("file-hello", async () => ({ ok: true, output: "never ran" })),
      appliesTo: () => true,
      canRun: async () => false,
    };
    const coverage = assessEvidenceCoverage(
      [{ kind: "artifact", description: "hello.txt" }],
      [silent],
      undefined,
    );
    expect(coverage.requirements[0]?.verifiers).toEqual([{ name: "file-hello", verdict: "uncertain" }]);
  });

  it("renders the summary note only when there was something to check", () => {
    expect(evidenceCoverageNote(undefined)).toBe("");
    const coverage = assessEvidenceCoverage(
      [{ kind: "artifact", description: "x" }],
      [],
      undefined,
    );
    expect(evidenceCoverageNote(coverage)).toBe(" Evidence: 0/1 requirement(s) checked.");
  });
});

describe("the loop reports what was checked and what was not", () => {
  it("says which requirements went unchecked, next to the verdict that could not confirm them", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "done, created it" }),
      understandGoal: async () => understanding(),
      verifiersFor: async () => [
        formalVerifier("build", async () => ({ ok: true, output: "tsc clean, 0 errors" }), "workspace"),
      ],
    }, { maxAttempts: 1 });

    const report = await loop.run({ tenantId: "local", goal });

    // Status rules are unchanged — this is the same unverified as before.
    expect(report.status).toBe("unverified");
    // …but the report now shows the inventory the goal stated.
    expect(report.evidence?.checked).toBe(0);
    expect(report.evidence?.requirements.map((a) => a.status)).toEqual(["unchecked", "unchecked", "unchecked"]);
    expect(report.summary).toContain("Evidence: 0/3 requirement(s) checked.");
    expect(report.observations.some((o) => o.summary.includes("unchecked: hello.txt containing Hi"))).toBe(true);
  });

  it("shows the requirements a declaring verifier covered, on a verified run", async () => {
    const hello: Verifier = {
      ...formalVerifier("file-hello", async () => ({ ok: true, output: "hello.txt exists and contains Hi" })),
      appliesTo: (claim) => (claim.successCriterion ?? "").includes("hello.txt"),
    };
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "done" }),
      understandGoal: async () => understanding(),
      verifiersFor: async () => [hello],
    }, { maxAttempts: 1 });

    const report = await loop.run({ tenantId: "local", goal });

    expect(report.status).toBe("succeeded");
    expect(report.evidence?.checked).toBe(3);
    expect(report.summary).toContain("Evidence: 3/3 requirement(s) checked.");
  });

  it("carries no inventory when the goal stated no requirements", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "done" }),
      understandGoal: async () => understanding({ expectedArtifact: undefined, successCriteria: [] }),
    }, { maxAttempts: 1 });

    const report = await loop.run({ tenantId: "local", goal });

    expect(report.evidence).toBeUndefined();
    expect(report.summary).not.toContain("requirement(s) checked");
  });

  it("names the actual reason when a run is accepted on the agent's word", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => ({ completed: true, summary: "done, trust me" }),
      understandGoal: async () => understanding(),
    }, { maxAttempts: 1, acceptUnverified: true });

    const report = await loop.run({ tenantId: "local", goal });

    // The policy choice is allowed — but the report must not dress it up as a
    // measurement.
    expect(report.status).toBe("executed");
    expect(report.summary).toContain("Accepted on the agent's word (acceptUnverified)");
    expect(report.summary).toContain("Evidence: 0/3 requirement(s) checked.");
  });
});
