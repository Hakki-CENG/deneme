import type { TaskReport } from "../execution/unified-execution-loop.js";

/**
 * P2.53 cognitive transparency — "Why did Aurora do this?"
 *
 * The answer is assembled strictly from what the task report already
 * measured: what was understood about the goal, which plan ran, which model
 * the routing observation says was selected, which capabilities did the
 * work, what verified the result, what failed and how it was recovered, and
 * which gaps stayed open. Fields the report does not carry are answered
 * with "not recorded" — an explanation that invents a reason is worse than
 * one that points at the gap.
 */

export interface TaskExplanation {
  question: "Why did Aurora do this?";
  /** Short human-readable sentences, in causal order. */
  answer: string[];
  /** The machine-checkable facts behind the sentences. */
  facts: {
    goal: string;
    status: string;
    attempts: number;
    selectedModel: string;
    modelBasis: string;
    understanding: string;
    plan: string[];
    capabilitiesInvoked: string[];
    verification: string;
    failures: string[];
    capabilityGaps: string[];
    evidenceCoverage: string;
  };
}

export function explainTask(report: TaskReport): TaskExplanation {
  // The routing observation is quoted verbatim: it was written by the loop at
  // decision time and carries the confidence with it. Parsing it would risk
  // restating the decision less faithfully than it was recorded.
  const routing = (report.observations ?? []).filter((observation) => observation.source === "routing").map((observation) => observation.summary);
  const selectedModel = routing.length > 0 ? routing[routing.length - 1]! : "not recorded";

  const understanding = report.understanding
    ? `Before acting, the goal was understood (source: ${report.understanding.source}) as "${report.understanding.goal}" with ${report.understanding.constraints.length} constraint(s) and ${report.understanding.successCriteria.length} success criterion/criteria; recommendation was to ${report.understanding.recommendation}.`
    : "No goal-understanding pass ran for this task, so the plan started from the raw goal text.";

  const plan = (report.plan?.steps ?? []).map((step) => step.description).slice(0, 10);

  const verification = report.verification
    ? `The result was verified (verdict: ${report.verification.verdict}, autonomy: ${report.verification.autonomy}): ${report.verification.summary}`
    : "Nothing verified the result — no verifier matched this goal, so the outcome is unverified by construction.";

  const failures = report.failures.slice(0, 5).map((entry) =>
    `${entry.classification.kind} → ${entry.recovery.strategy}${entry.recovery.canContinue ? "" : " (loop stopped)"}`);

  const capabilityGaps = report.gaps.slice(0, 5).map((gap) => `${gap.type}: ${gap.missing}`);

  const evidenceCoverage = report.evidence
    ? `${report.evidence.requirements.length} stated requirement(s); ${report.evidence.checked} checked by a declaring verifier.`
    : "The goal stated no machine-checkable requirements, so no evidence coverage was computed.";

  const facts: TaskExplanation["facts"] = {
    goal: report.goal,
    status: report.status,
    attempts: report.attempts,
    selectedModel,
    modelBasis: routing.length > 0 ? "routing observation recorded at decision time" : "no routing observation on the report",
    understanding,
    plan,
    capabilitiesInvoked: [...report.capabilitiesInvoked].slice(0, 12),
    verification,
    failures,
    capabilityGaps,
    evidenceCoverage,
  };

  const answer: string[] = [
    `The goal was "${facts.goal}"; the task finished as "${facts.status}" after ${facts.attempts} attempt(s).`,
    facts.understanding,
    ...(facts.plan.length > 0 ? [`It ran a ${facts.plan.length}-step plan: ${facts.plan.join("; ")}.`] : []),
    ...(facts.selectedModel !== "not recorded"
      ? [`Model selection: ${facts.selectedModel}`]
      : ["Which model served the turns is not recorded in this report; no claim is made about it."]),
    ...(facts.capabilitiesInvoked.length > 0
      ? [`The work was done through: ${facts.capabilitiesInvoked.join(", ")}.`]
      : ["No capabilities were invoked — the task completed (or stopped) without tool work."]),
    ...(facts.failures.length > 0 ? [`Failures along the way: ${facts.failures.join("; ")}.`] : []),
    facts.verification,
    facts.evidenceCoverage,
    ...(facts.capabilityGaps.length > 0 ? [`Capability gaps that stayed open: ${facts.capabilityGaps.join("; ")}.`] : []),
  ];

  return { question: "Why did Aurora do this?", answer, facts };
}
