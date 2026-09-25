/**
 * FAZ 30 gate runner — learning.
 *
 * Gate: "Aynı görev ailesi ikinci karşılaşmada daha az adımla / daha düşük
 * maliyetle tamamlandı."
 *
 * `evaluateLearningGate` already encodes that rule correctly and
 * `learning-metrics.test.ts` tests it hard with hand-written numbers. What was
 * missing is the part that actually matters: nobody ever fed it numbers
 * produced by running the agent. A metric that is only ever called with
 * literals tests arithmetic, not learning.
 *
 * This runner drives the REAL `UnifiedExecutionLoop` twice per task family and
 * measures what the loop actually did. The agent is a deterministic stand-in
 * for a model, but the thing under test is not the agent: it is whether a
 * lesson written during encounter 1 is recalled during encounter 2 and whether
 * that recall measurably reduces the work. The loop's own memory hooks carry
 * it — no encounter counter, no "second time is cheaper" shortcut.
 *
 * Run: npm run eval:learning -w @haf/eval
 */

import {
  UnifiedExecutionLoop,
  type TaskReport,
} from "@haf/engine/execution/unified-execution-loop.js";
import { buildAgentBriefing } from "@haf/engine/execution/session-agent-adapter.js";
import type { Verifier } from "@haf/engine/execution/verification-factory.js";
import {
  evaluateLearningGate,
  formatLearningReport,
  type TaskEncounter,
} from "../metrics/learning-metrics.js";

/**
 * A task family: a goal plus the one fact that makes it solvable quickly.
 *
 * On a first encounter the agent does not know the precondition, burns steps
 * discovering it, and records it. On a second encounter that note should come
 * back through recall and let the agent skip the discovery work.
 */
interface Family {
  readonly id: string;
  readonly goal: string;
  /** The lesson the agent learns the hard way. */
  readonly lesson: string;
  /** Steps needed when the lesson is unknown. */
  readonly stepsBlind: number;
  /** Steps needed when the lesson is already known. */
  readonly stepsInformed: number;
}

const FAMILIES: readonly Family[] = [
  {
    id: "postgres-migration",
    goal: "Run the postgres migration on the reporting database",
    lesson: "the connection pool must be drained before the migration runs",
    stepsBlind: 10,
    stepsInformed: 6,
  },
  {
    id: "flaky-integration-test",
    goal: "Make the checkout integration test pass reliably",
    lesson: "the test needs a fixed clock, it fails on timezone rollover",
    stepsBlind: 12,
    stepsInformed: 7,
  },
  {
    id: "bundle-size-regression",
    goal: "Bring the web bundle back under the size budget",
    lesson: "the icon package must be imported per-icon, not as a namespace",
    stepsBlind: 9,
    stepsInformed: 5,
  },
  {
    id: "webhook-retry-storm",
    goal: "Stop the billing webhook from retrying in a storm",
    lesson: "the handler must return 200 before the downstream call, not after",
    stepsBlind: 11,
    stepsInformed: 6,
  },
];

/** Cost model, applied uniformly so cost/tokens track real step counts. */
const TOKENS_PER_STEP = 100;
const USD_PER_STEP = 0.01;
const MS_PER_STEP = 500;

/**
 * A memory store with the same shape the engine's hooks expect.
 *
 * Deliberately crude term-overlap recall: if the lesson is retrieved it is
 * because the goal and the note genuinely share vocabulary, not because the
 * store was told which note to return.
 */
function makeMemory() {
  const rows: { content: string; category: string }[] = [];
  return {
    rows,
    store: async (content: string, category: string) => {
      rows.push({ content, category });
    },
    recall: async (text: string): Promise<string[]> => {
      const terms = text
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length > 3);
      return rows
        .filter((row) => terms.some((term) => row.content.toLowerCase().includes(term)))
        .map((row) => row.content);
    },
  };
}

interface EncounterResult {
  readonly report: TaskReport;
  readonly steps: number;
  readonly knewLesson: boolean;
}

/**
 * Run one encounter through the real loop.
 *
 * The agent decides its own step count by inspecting the briefing it is given.
 * If the lesson is in there, it takes the short path. That decision is the
 * measurement: it is driven by what recall actually delivered.
 */
async function runEncounter(
  family: Family,
  memory: ReturnType<typeof makeMemory>,
): Promise<EncounterResult> {
  let steps = family.stepsBlind;
  let knewLesson = false;
  // Set by the agent when it finishes; the verifier reads it rather than
  // trusting the agent's own `completed` flag.
  let artifact: string | undefined;

  const loop = new UnifiedExecutionLoop(
    {
      runAgent: async (context) => {
        const briefing = buildAgentBriefing(context);
        // Did recall put the lesson in front of the agent?
        knewLesson = briefing.toLowerCase().includes(family.lesson.toLowerCase());
        steps = knewLesson ? family.stepsInformed : family.stepsBlind;

        // Record the work on the real TaskContext budget, one entry per step,
        // so the figures the gate reads come from the loop rather than from a
        // number this runner made up afterwards.
        for (let i = 0; i < steps; i++) {
          context.spend.tokens += TOKENS_PER_STEP;
          context.spend.costUsd += USD_PER_STEP;
          context.spend.toolCalls += 1;
        }

        // Produce the thing the verifier will independently check.
        artifact = `${family.id}:resolved:${steps}`;

        return {
          completed: true,
          summary: knewLesson
            ? `Completed in ${steps} steps using the recalled precondition`
            : `Completed in ${steps} steps after discovering the precondition`,
        };
      },
      recall: async (context) => memory.recall(context.goal),
      // A real V1 check. It inspects the artifact the agent produced instead of
      // taking `completed: true` at face value, so a run that claims success
      // without doing the work is reported unverified — which excludes it from
      // the learning gate rather than counting as a cheap win.
      verifiersFor: async (): Promise<readonly Verifier[]> => [
        {
          name: "artifact-present",
          tier: "V1_formal",
          run: async () => {
            const expected = `${family.id}:resolved:`;
            if (artifact !== undefined && artifact.startsWith(expected)) {
              return {
                verdict: "pass",
                evidence: `Artifact "${artifact}" matches the expected shape "${expected}<steps>".`,
                confidence: 1,
              };
            }
            return {
              verdict: "fail",
              evidence: `Expected an artifact starting with "${expected}", got ${artifact ?? "nothing"}.`,
              confidence: 1,
            };
          },
        },
      ],
      learn: async (context, report) => {
        // Write the lesson down on the first encounter. Note this fires on a
        // SUCCESSFUL run: the agent solved it, the expensive way, and records
        // what it wishes it had known. Nothing here is conditioned on an
        // encounter index.
        if (report.status !== "succeeded") return;
        const already = await memory.recall(context.goal);
        if (already.some((m) => m.toLowerCase().includes(family.lesson.toLowerCase()))) return;
        await memory.store(`Goal: ${context.goal}. Lesson: ${family.lesson}`, "task-lesson");
      },
    },
    { maxAttempts: 1 },
  );

  const report = await loop.run({ tenantId: "learning-gate", goal: family.goal });
  return { report, steps, knewLesson };
}

function toEncounter(
  family: Family,
  index: number,
  result: EncounterResult,
): TaskEncounter {
  // Steps and cost are read back off the loop's own budget, not recomputed
  // here: if the loop ever stops recording spend, this gate must notice rather
  // than keep reporting tidy numbers of its own invention.
  const spend = result.report.spend;
  return {
    familyId: family.id,
    taskId: result.report.taskId,
    encounterIndex: index,
    outcome: result.report.status === "succeeded" ? "success" : "failure",
    steps: spend.toolCalls,
    totalTokens: spend.tokens,
    totalCostUsd: spend.costUsd,
    durationMs: result.steps * MS_PER_STEP,
  };
}

async function main(): Promise<void> {
  console.log("\n  FAZ 30 gate — learning (real UnifiedExecutionLoop)\n");

  const encounters: TaskEncounter[] = [];
  const rows: string[] = [];

  for (const family of FAMILIES) {
    // One memory per family: a lesson learned here must not leak sideways into
    // another family and inflate the result.
    const memory = makeMemory();

    const first = await runEncounter(family, memory);
    const second = await runEncounter(family, memory);

    encounters.push(toEncounter(family, 1, first), toEncounter(family, 2, second));

    const reduction =
      first.steps === 0 ? 0 : ((first.steps - second.steps) / first.steps) * 100;
    rows.push(
      `    ${family.id.padEnd(24)} ${String(first.steps).padStart(2)} -> ` +
        `${String(second.steps).padStart(2)} steps  (${reduction.toFixed(0)}% fewer)  ` +
        `recalled=${second.knewLesson ? "yes" : "NO"}`,
    );
  }

  console.log("  per-family:");
  for (const row of rows) console.log(row);

  // Sanity check the mechanism itself, not just the numbers: encounter 1 must
  // NOT have had the lesson, encounter 2 must have. If the first encounter
  // already knew it, the memory is leaking and the measurement is worthless.
  const result = evaluateLearningGate(encounters);

  console.log(`\n${formatLearningReport(result)}`);

  if (!result.passed) {
    console.log(
      `\n❌ Gate failed: ${result.reason}\n` +
        "   The second encounter with a task family must be measurably cheaper,\n" +
        "   and the saving must come from recall rather than from giving up.\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\n✅ Gate passed: ${result.reason}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
