/**
 * B2 (P1.2): understand the goal before acting on it.
 *
 * What was measured before this existed: nothing ran. The goal arrived as an
 * opaque string and went straight into planning and execution. Constraints were
 * only what the caller passed; deadlines, expected artifacts and success
 * criteria lived nowhere; and a task built on a critical unknown ("migrate the
 * database" — which database?) ran anyway and spent its whole attempt budget
 * discovering a question it could have asked at the start.
 */
import { describe, expect, it } from "vitest";

import {
  GoalUnderstandingService,
  parseUnderstandingJson,
  recommendAction,
  validateUnderstanding,
  type ValidatedUnderstanding,
} from "../src/aurora/goal-understanding.js";
import { UnifiedExecutionLoop } from "../src/execution/unified-execution-loop.js";
import type { GoalUnderstanding } from "../src/execution/task-context.js";
import type { ModelRequest, ModelStreamEvent } from "../src/types.js";

function modelReturning(reply: string) {
  return {
    async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", delta: reply };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

const VALID_REPLY = JSON.stringify({
  goal: "Migrate the production database to the new schema",
  constraints: ["No downtime longer than 5 minutes"],
  preferences: ["Prefer running it at night"],
  risks: ["Lock contention during the copy phase"],
  deadline: "2026-09-26T09:00:00Z",
  expectedArtifact: "A migrated database and a rollback report",
  successCriteria: ["The new schema serves reads", "The rollback report exists"],
  missingInformation: [
    { what: "which database instance is production", critical: true, whoCanAnswer: "user" },
  ],
  ambiguity: 0.2,
  clarifyingQuestions: ["Which database instance is production?"],
});

describe("the service asks the model first and records what happened", () => {
  it("extracts a valid reply and derives the recommendation in code", async () => {
    const service = new GoalUnderstandingService({ model: modelReturning(VALID_REPLY) });
    const understanding = await service.understand({ tenantId: "local", goal: "Migrate the database" });

    expect(understanding.source).toBe("model");
    expect(understanding.constraints).toEqual(["No downtime longer than 5 minutes"]);
    expect(understanding.deadline).toBe(new Date("2026-09-26T09:00:00Z").toISOString());
    expect(understanding.expectedArtifact).toBe("A migrated database and a rollback report");
    // The model extracted; the policy in code decided.
    expect(understanding.recommendation).toBe("ask");
    expect(understanding.clarifyingQuestions).toEqual(["Which database instance is production?"]);
  });

  it("falls back honestly when the model replies with prose", async () => {
    const service = new GoalUnderstandingService({ model: modelReturning("Sure! What database?") });
    const understanding = await service.understand({ tenantId: "local", goal: "Migrate the database" });

    expect(understanding.source).toBe("fallback");
    expect(understanding.fallbackReason).toContain("no JSON object");
    // The fallback claims nothing it does not know.
    expect(understanding.constraints).toEqual([]);
    expect(understanding.ambiguity).toBe(0);
    expect(understanding.recommendation).toBe("act");
  });

  it("falls back when no model was supplied", async () => {
    const service = new GoalUnderstandingService({});
    const understanding = await service.understand({ tenantId: "local", goal: "g" });
    expect(understanding.source).toBe("fallback");
    expect(understanding.fallbackReason).toContain("no model");
  });

  it("rejects a deadline that does not parse, rather than repeating the lie", async () => {
    const service = new GoalUnderstandingService({
      model: modelReturning(JSON.stringify({ goal: "g", deadline: "next Tuesday-ish" })),
    });
    const understanding = await service.understand({ tenantId: "local", goal: "g" });
    expect(understanding.source).toBe("fallback");
    expect(understanding.fallbackReason).toContain("deadline");
  });

  it("rejects an ambiguity outside 0..1", async () => {
    const service = new GoalUnderstandingService({
      model: modelReturning(JSON.stringify({ goal: "g", ambiguity: 1.5 })),
    });
    const understanding = await service.understand({ tenantId: "local", goal: "g" });
    expect(understanding.source).toBe("fallback");
    expect(understanding.fallbackReason).toContain("ambiguity");
  });
});

describe("the ask/think/research/act policy is code, not model output", () => {
  const base: ValidatedUnderstanding = {
    goal: "g",
    constraints: [],
    preferences: [],
    risks: [],
    successCriteria: [],
    missingInformation: [],
    ambiguity: 0,
    clarifyingQuestions: [],
  };

  it("asks when a critical unknown only the user can answer", () => {
    const result = recommendAction({
      ...base,
      missingInformation: [{ what: "which instance is production", critical: true, whoCanAnswer: "user" }],
    });
    expect(result.recommendation).toBe("ask");
    // Questions derived from the unknowns when the model supplied none:
    // "critical but no question" must not silently degrade to "act".
    expect(result.questions).toEqual(["Please specify: which instance is production"]);
  });

  it("researches when a critical unknown the system can answer", () => {
    const result = recommendAction({
      ...base,
      missingInformation: [{ what: "which version is deployed", critical: true, whoCanAnswer: "system" }],
    });
    expect(result.recommendation).toBe("research");
  });

  it("thinks when ambiguity is at or above the threshold", () => {
    expect(recommendAction({ ...base, ambiguity: 0.7 }).recommendation).toBe("think");
    expect(recommendAction({ ...base, ambiguity: 0.69 }).recommendation).toBe("act");
  });

  it("acts when nothing stands in the way", () => {
    expect(recommendAction({ ...base }).recommendation).toBe("act");
  });

  it("prefers to ask over researching when both kinds are critical", () => {
    // Asking is the safe order: a wrong "user" costs one round trip, a wrong
    // "system" costs the whole attempt.
    const result = recommendAction({
      ...base,
      missingInformation: [
        { what: "which version is deployed", critical: true, whoCanAnswer: "system" },
        { what: "what downtime is acceptable", critical: true, whoCanAnswer: "user" },
      ],
    });
    expect(result.recommendation).toBe("ask");
  });
});

describe("the loop acts on the recommendation", () => {
  const runAgent = async () => ({ completed: true, summary: "done" });

  function understanding(partial: Partial<GoalUnderstanding>): GoalUnderstanding {
    return {
      goal: "g",
      constraints: [],
      preferences: [],
      risks: [],
      successCriteria: [],
      missingInformation: [],
      ambiguity: 0,
      clarifyingQuestions: [],
      recommendation: "act",
      source: "model",
      ...partial,
    };
  }

  it("does not start work when the recommendation is ask", async () => {
    let agentCalls = 0;
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => {
        agentCalls += 1;
        return { completed: true, summary: "done" };
      },
      understandGoal: async () =>
        understanding({
          recommendation: "ask",
          clarifyingQuestions: ["Which database is production?"],
          missingInformation: [
            { what: "which database is production", critical: true, whoCanAnswer: "user" },
          ],
        }),
    });

    const report = await loop.run({ tenantId: "local", goal: "Migrate the database" });

    // The questions ARE the deliverable; no attempt was spent discovering them.
    expect(agentCalls).toBe(0);
    expect(report.attempts).toBe(0);
    expect(report.status).toBe("blocked");
    expect(report.clarification?.questions).toEqual(["Which database is production?"]);
    expect(report.clarification?.missing[0]?.what).toBe("which database is production");
    expect(report.understanding?.recommendation).toBe("ask");
    const text = JSON.stringify(report.outcomes);
    expect(text).toContain("Which database is production?");
  });

  it("merges extracted constraints and preferences into the briefing's requirements", async () => {
    const seen: string[][] = [];
    const loop = new UnifiedExecutionLoop({
      runAgent: async (context) => {
        seen.push([...context.constraints]);
        return { completed: true, summary: "done" };
      },
      understandGoal: async () =>
        understanding({
          constraints: ["No downtime longer than 5 minutes"],
          preferences: ["Run it at night"],
        }),
    });

    await loop.run({ tenantId: "local", goal: "Migrate the database", constraints: ["Caller rule"] });

    // Caller's own constraint is kept; the extraction is appended, and
    // preferences are labelled so "hard requirement" does not lie about them.
    expect(seen[0]).toEqual(["Caller rule", "No downtime longer than 5 minutes", "Preference: Run it at night"]);
  });

  it("adopts an extracted deadline only when the caller set none", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent,
      understandGoal: async () => understanding({ deadline: "2026-09-26T09:00:00.000Z" }),
    });

    const adopted = await loop.run({ tenantId: "local", goal: "g" });
    expect(adopted.deadline).toBe("2026-09-26T09:00:00.000Z");

    // The caller's explicit instruction outranks the model's inference.
    const kept = await loop.run({
      tenantId: "local",
      goal: "g",
      deadline: "2026-09-30T00:00:00.000Z",
    });
    expect(kept.deadline).toBe("2026-09-30T00:00:00.000Z");
  });

  it("turns a research recommendation into a directive the agent can read", async () => {
    const seen: string[][] = [];
    const loop = new UnifiedExecutionLoop({
      runAgent: async (context) => {
        seen.push([...context.constraints]);
        return { completed: true, summary: "done" };
      },
      understandGoal: async () =>
        understanding({
          recommendation: "research",
          missingInformation: [
            { what: "which version is deployed", critical: true, whoCanAnswer: "system" },
          ],
        }),
    });

    await loop.run({ tenantId: "local", goal: "Roll out the fix" });
    expect(seen[0]?.join("\\n")).toContain("Research needed before acting: which version is deployed");
  });

  it("proceeds on the text when understanding itself fails", async () => {
    let agentCalls = 0;
    const loop = new UnifiedExecutionLoop({
      runAgent: async () => {
        agentCalls += 1;
        return { completed: true, summary: "done" };
      },
      understandGoal: async () => {
        throw new Error("understanding backend down");
      },
    });

    const report = await loop.run({ tenantId: "local", goal: "g" });

    expect(agentCalls).toBe(1);
    expect(report.status).not.toBe("blocked");
    expect(report.understanding).toBeUndefined();
    expect(report.observations.some((o) => o.summary.includes("proceeding on the text alone"))).toBe(true);
  });

  it("records the understanding on the report with its source", async () => {
    const loop = new UnifiedExecutionLoop({
      runAgent,
      understandGoal: async () => understanding({ source: "fallback", fallbackReason: "no model" }),
    });

    const report = await loop.run({ tenantId: "local", goal: "g" });

    expect(report.understanding?.source).toBe("fallback");
    expect(report.understanding?.fallbackReason).toBe("no model");
    expect(report.clarification).toBeUndefined();
  });
});

describe("the JSON scanner tolerates provider wrapping", () => {
  it("finds the object inside prose and a fence", () => {
    const text = 'Sure, here it is:\n```json\n{"goal":"g"}\n```\nHope that helps!';
    expect(parseUnderstandingJson(text)).toEqual({ ok: true, value: { goal: "g" } });
  });

  it("refuses text whose first object has no goal string", () => {
    expect(parseUnderstandingJson('{"steps":[]}')).toEqual({
      ok: false,
      reason: 'the reply had no "goal" string',
    });
  });
});

describe("validation bounds the untrusted reply", () => {
  it("accepts a full reply", () => {
    const parsed = parseUnderstandingJson(VALID_REPLY);
    expect(parsed.ok).toBe(true);
    const validated = validateUnderstanding(parsed.ok ? parsed.value : undefined);
    expect(validated.ok).toBe(true);
  });

  it("defaults an unclassified unknown to non-critical and user-answerable", () => {
    const validated = validateUnderstanding({
      goal: "g",
      missingInformation: [{ what: "something" }],
    });
    expect(validated.ok && validated.value.missingInformation[0]).toEqual({
      what: "something",
      critical: false,
      whoCanAnswer: "user",
    });
  });
});
