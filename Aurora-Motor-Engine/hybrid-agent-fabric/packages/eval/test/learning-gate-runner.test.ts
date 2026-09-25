/**
 * FAZ 30 gate — the MEASUREMENT, not the metric.
 *
 * `learning-metrics.test.ts` already proves `evaluateLearningGate` does the
 * right arithmetic on hand-written numbers. That is necessary and not
 * sufficient: a gate can compute perfectly over numbers that were never
 * produced by running anything. Until `eval:learning` existed, nothing fed the
 * metric real figures — the same shape of hole that let FAZ 11 be recorded as
 * met while the retriever added nothing.
 *
 * These tests pin the property that makes the runner's number mean something:
 * the second encounter is cheaper BECAUSE the lesson was recalled. Break
 * recall and the improvement must vanish. If it survives, the runner is
 * measuring an encounter counter, not learning.
 */

import { describe, it, expect } from "vitest";
import { UnifiedExecutionLoop } from "@haf/engine/execution/unified-execution-loop.js";
import { buildAgentBriefing } from "@haf/engine/execution/session-agent-adapter.js";
import type { Verifier } from "@haf/engine/execution/verification-factory.js";
import { evaluateLearningGate, type TaskEncounter } from "../src/metrics/learning-metrics.js";

const LESSON = "the connection pool must be drained before the migration runs";
const GOAL = "Run the postgres migration on the reporting database";
const STEPS_BLIND = 10;
const STEPS_INFORMED = 6;

function makeMemory() {
  const rows: string[] = [];
  return {
    rows,
    store: async (content: string) => {
      rows.push(content);
    },
    recall: async (text: string): Promise<string[]> => {
      const terms = text.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
      return rows.filter((row) => terms.some((term) => row.toLowerCase().includes(term)));
    },
  };
}

/** One encounter through the real loop. Returns steps taken and whether the lesson arrived. */
async function encounter(
  memory: ReturnType<typeof makeMemory>,
  options: { recallEnabled: boolean },
): Promise<{ steps: number; knewLesson: boolean; status: string }> {
  let steps = STEPS_BLIND;
  let knewLesson = false;
  let artifact: string | undefined;

  const loop = new UnifiedExecutionLoop(
    {
      runAgent: async (context) => {
        knewLesson = buildAgentBriefing(context).toLowerCase().includes(LESSON);
        steps = knewLesson ? STEPS_INFORMED : STEPS_BLIND;
        artifact = `resolved:${steps}`;
        return { completed: true, summary: `done in ${steps} steps` };
      },
      recall: async (context) => (options.recallEnabled ? memory.recall(context.goal) : []),
      verifiersFor: async (): Promise<readonly Verifier[]> => [
        {
          name: "artifact-present",
          tier: "V1_formal",
          run: async () =>
            artifact?.startsWith("resolved:")
              ? { verdict: "pass", evidence: `Artifact ${artifact}`, confidence: 1 }
              : { verdict: "fail", evidence: "No artifact produced", confidence: 1 },
        },
      ],
      learn: async (context, report) => {
        if (report.status !== "succeeded") return;
        const seen = await memory.recall(context.goal);
        if (seen.some((m) => m.toLowerCase().includes(LESSON))) return;
        await memory.store(`Goal: ${context.goal}. Lesson: ${LESSON}`);
      },
    },
    { maxAttempts: 1 },
  );

  const report = await loop.run({ tenantId: "t", goal: GOAL });
  return { steps, knewLesson, status: report.status };
}

function toEncounters(
  runs: readonly { steps: number }[],
  familyId = "postgres-migration",
): TaskEncounter[] {
  return runs.map((run, i) => ({
    familyId,
    taskId: `${familyId}-${i + 1}`,
    encounterIndex: i + 1,
    outcome: "success" as const,
    steps: run.steps,
    totalTokens: run.steps * 100,
    totalCostUsd: run.steps * 0.01,
    durationMs: run.steps * 500,
  }));
}

describe("FAZ 30 runner — the saving comes from recall", () => {
  it("writes the lesson on the first encounter and applies it on the second", async () => {
    const memory = makeMemory();

    const first = await encounter(memory, { recallEnabled: true });
    expect(first.status).toBe("succeeded");
    // Nothing was known yet, so the expensive path was taken.
    expect(first.knewLesson).toBe(false);
    expect(first.steps).toBe(STEPS_BLIND);
    // ...and the lesson was recorded.
    expect(memory.rows).toHaveLength(1);

    const second = await encounter(memory, { recallEnabled: true });
    expect(second.status).toBe("succeeded");
    // The lesson came back through recall and shortened the work.
    expect(second.knewLesson).toBe(true);
    expect(second.steps).toBe(STEPS_INFORMED);
    expect(second.steps).toBeLessThan(first.steps);

    // The lesson is stored once, not re-appended on every encounter.
    expect(memory.rows).toHaveLength(1);
  }, 60_000);

  it("shows no improvement at all when recall is disabled", async () => {
    const memory = makeMemory();

    const first = await encounter(memory, { recallEnabled: false });
    const second = await encounter(memory, { recallEnabled: false });

    // This is the control. The loop still runs twice and the lesson is still
    // written down; only the retrieval path is cut. If the second run were
    // cheaper anyway, the runner would be measuring "ran before" instead of
    // "learned something".
    expect(second.knewLesson).toBe(false);
    expect(second.steps).toBe(first.steps);

    const result = evaluateLearningGate([
      ...toEncounters([first, second], "family-a"),
      ...toEncounters([first, second], "family-b"),
      ...toEncounters([first, second], "family-c"),
    ]);
    expect(result.passed).toBe(false);
    expect(result.improvedFamilies).toBe(0);
  }, 60_000);

  it("excludes a run that claims success but fails verification", async () => {
    // A run whose artifact never appears must not be counted as a cheap win.
    // `skipped`/`unverified` must never read as `success` — so the family is
    // excluded from the gate rather than scored.
    let artifact: string | undefined;
    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async () => {
          artifact = undefined; // claims completion, produces nothing
          return { completed: true, summary: "all done (allegedly)" };
        },
        verifiersFor: async (): Promise<readonly Verifier[]> => [
          {
            name: "artifact-present",
            tier: "V1_formal",
            run: async () =>
              artifact?.startsWith("resolved:")
                ? { verdict: "pass", evidence: `Artifact ${artifact}`, confidence: 1 }
                : { verdict: "fail", evidence: "No artifact produced", confidence: 1 },
          },
        ],
      },
      { maxAttempts: 1 },
    );

    const report = await loop.run({ tenantId: "t", goal: GOAL });
    expect(report.status).not.toBe("succeeded");

    const result = evaluateLearningGate([
      {
        familyId: "f",
        taskId: "t1",
        encounterIndex: 1,
        outcome: "failure",
        steps: 10,
        totalTokens: 1000,
        totalCostUsd: 0.1,
        durationMs: 5000,
      },
      {
        familyId: "f",
        taskId: "t2",
        encounterIndex: 2,
        outcome: "success",
        steps: 2,
        totalTokens: 200,
        totalCostUsd: 0.02,
        durationMs: 1000,
      },
    ]);
    // Dramatically "cheaper", but the first run never succeeded, so there is
    // no honest baseline to improve on.
    expect(result.passed).toBe(false);
    expect(result.countedFamilies).toBe(0);
  }, 60_000);
});
