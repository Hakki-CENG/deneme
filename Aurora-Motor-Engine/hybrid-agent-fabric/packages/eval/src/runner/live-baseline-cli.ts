/** FAZ 1 live baseline: run the real engine over the real suite, save results. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HybridAgentEngine } from "@haf/engine";
import { EvalRunner } from "./eval-runner.js";
import { CORE_EVAL_SUITE } from "../tasks/core-tasks.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const resultsDir = resolve(packageRoot, "results");

const homePath = await mkdtemp(join(tmpdir(), "eval-baseline-"));
const engine = new HybridAgentEngine({
  homePath,
  kernelServerScript: resolve(packageRoot, "../../python/kernel_server.py"),
  sandboxBackend: "local",
  model: { provider: "mock" },
  autoApproveWorkspaceWrites: true,
  allowProcessExecution: true,
});
await engine.initialize();

const runner = new EvalRunner(engine, { outputDir: resultsDir, verbose: false, saveTrajectories: false });
const started = Date.now();
const suiteResult = await runner.runSuite(CORE_EVAL_SUITE);
const durationMs = Date.now() - started;

const byStatus: Record<string, number> = {};
for (const r of suiteResult.results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

const payload = {
  suiteId: CORE_EVAL_SUITE.id,
  model: "mock",
  note: "Baseline with the mock provider: it echoes input and cannot solve tasks. Non-zero pass rate here would indicate vacuous tasks.",
  generatedAt: new Date().toISOString(),
  durationMs,
  totalTasks: suiteResult.totalTasks,
  passed: suiteResult.passed,
  failed: suiteResult.failed,
  byStatus,
  results: suiteResult.results.map(r => ({
    taskId: r.taskId, status: r.status, score: r.score,
    steps: r.metrics.totalSteps, tokens: r.metrics.totalTokens, durationMs: r.durationMs,
  })),
};

await mkdir(resultsDir, { recursive: true });
await writeFile(resolve(resultsDir, "core-suite-baseline-mock.json"), JSON.stringify(payload, null, 2) + "\n");
console.log("TOTAL=" + suiteResult.totalTasks + " PASSED=" + suiteResult.passed + " MS=" + durationMs);
console.log("BY_STATUS=" + JSON.stringify(byStatus));
console.log("\nSaved to " + resolve(resultsDir, "core-suite-baseline-mock.json"));

// The mock provider echoes its input; it cannot write files or run commands.
// A pass here would mean the task's criteria are vacuous, so a non-zero pass
// count is a HARD failure of the eval suite itself, not a good result.
//
// The one legitimate exception is a task tagged `precondition-satisfied`: its
// seed workspace ALREADY meets the file-state criteria on purpose, because the
// task measures whether the agent recognises a no-op instead of doing
// redundant (or harmful) work. For those, the discriminating signal is the
// step budget, not the final file state. `criteria-validation.ts` makes the
// same exemption; this gate has to agree with it or the two contradict.
//
// Note this exemption only became reachable once the grader was fixed to judge
// the task's workspace instead of `process.cwd()`. Before that, these tasks
// failed for the wrong reason and the gate passed by accident.
const byDesignNoop = new Set(
  CORE_EVAL_SUITE.tasks.filter((task) => (task.tags ?? []).includes("precondition-satisfied")).map((task) => task.id),
);

const unexpectedPasses = suiteResult.results.filter(
  (result) => result.status === "pass" && !byDesignNoop.has(result.taskId),
);
const exemptPasses = suiteResult.passed - unexpectedPasses.length;

if (unexpectedPasses.length > 0) {
  console.error(
    "\n\u274c " + unexpectedPasses.length + " task(s) passed with a model that cannot act. Those tasks are vacuous: " +
      unexpectedPasses.map((result) => result.taskId).join(", "),
  );
  await engine.shutdown();
  process.exit(1);
}

console.log(
  "\n\u2705 " + unexpectedPasses.length + "/" + suiteResult.totalTasks +
    " passed with a non-acting model, as expected" +
    (exemptPasses > 0 ? " (" + exemptPasses + " by-design no-op task(s) exempt)." : "."),
);
await engine.shutdown();
