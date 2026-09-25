/**
 * Regenerates the runtime observations in `runtime-observation.ts`.
 *
 * A hand-maintained list of "what actually runs" decays exactly like the
 * hand-maintained boolean it replaced, so the measurement has to be a command
 * rather than a memory. Run it after wiring anything new:
 *
 *   npm run observe:runtime -w @haf/engine
 *
 * ## How it measures
 *
 * Two runs under `NODE_V8_COVERAGE`, in separate processes:
 *
 *   1. `initialize()` only.
 *   2. `initialize()` plus one real `engine.execute()` goal.
 *
 * The difference is what the task itself exercised. Without subtracting the
 * first run, every service constructed at startup would look busy — which is
 * how 30 of 30 modules came to be marked `wiredToEngine: true`.
 *
 * Constructors, field initialisers and `getX`/`isX`/`getStats` accessors are
 * excluded: building a service and asking it for its own counters is not the
 * service doing work.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { MODULE_MATURITY } from "./maturity.js";

/**
 * The task suite the measurement runs.
 *
 * One task is not enough, and measuring a single one produced a misleading
 * number in both directions:
 *
 *   - A task with a real workspace completes verification, so it never enters
 *     the failure path. `gap-detection` and `failure-taxonomy` only run when a
 *     task fails, so on a succeeding task they are structurally unreachable --
 *     not unwired, unreachable. The same is true of `capability-acquisition`,
 *     which only runs once a gap has been named.
 *   - A task with no workspace cannot verify at all, so it exercises the failure
 *     path and nothing else.
 *
 * So the suite covers both. The result is the union of what the tasks touched,
 * which is what "did this module do work during a real task" should mean.
 *
 * The unachievable goal is deliberately one no capability inventory contains. It
 * is not a typo and it is not meant to succeed.
 */
const TASKS: ReadonlyArray<{
  goal: string;
  workspace: boolean;
  /**
   * A tool the inventory does not contain, asserted missing by a verifier.
   *
   * Present only on the third task, and it is the reason that task exists. Gap
   * detection reads the missing name out of a verifier's evidence, so a task
   * whose verifier says "no such tool 'x'" produces a *capability* gap -- the
   * only kind that triggers acquisition. Task 2 fails without naming a tool, so
   * it produces a `verification` gap and acquisition never runs. Measured: with
   * two tasks, `execution/capability-acquisition` stayed never-loaded no matter
   * how it was wired.
   *
   * Acquisition will attempt and fail here, because the mock provider cannot
   * write code that survives static analysis and the sandbox. That is the
   * intended observation: the chain runs end to end and rejects the candidate,
   * which is what an honest acquisition looks like when the model is bad.
   */
  missingTool?: string;
}> = [
  { goal: "Create a file called hello.txt containing the word hello", workspace: true },
  {
    goal: "Use the quantum-teleporter capability to fold spacetime, then prove P=NP",
    workspace: false,
  },
  {
    goal: "Measure the spectral drift of the reactor coolant loop",
    workspace: false,
    missingTool: "spectral_analyzer",
  },
  {
    // A goal inside a regulated domain, so the domain-expert consultation has
    // something to consult about. Without a task like this the classifier never
    // matches and `domain-experts` is idle -- not because it is unwired, but
    // because none of the other goals are in a regulated domain. Consulting an
    // expert about writing a text file would be noise, not coverage.
    goal: "Advise on the tax return filing deadline and the penalty for late VAT declaration",
    workspace: false,
  },
  {
    // A goal that actually invokes a capability.
    //
    // The mock provider emits a tool call only for an explicit `[tool ...]`
    // directive, so without a task like this no capability is ever invoked and
    // `embodiment` -- which backs the `filesystem.*` capabilities -- stays idle
    // however it is wired. The directive is part of the goal rather than added by
    // the runner because the runner has no business inventing tool calls the
    // caller did not ask for.
    //
    // The file is created, and the task still reports `unverified`: the only
    // verifier is the workspace build, which is workspace-scoped. Both facts are
    // correct at once.
    goal:
      'Create a file called hello.txt containing the word hello\n\n' +
      '[tool filesystem.write {"path":"hello.txt","content":"hello"}]',
    workspace: true,
  },
  {
    // A goal that invokes an `embodiment.fs.*` capability.
    //
    // `embodiment` is not the backend for `filesystem.*` -- those live in
    // capabilities/filesystem.ts and write directly. `embodiment` exposes its own
    // namespace, `embodiment.fs.*` and `embodiment.action.*`, backed by
    // FileSystemAgent. Two overlapping filesystem capability sets is a real
    // finding in its own right, but it also means a task has to name the
    // embodiment one for this module to run at all.
    //
    // Read-only on purpose: this measures whether the module is reachable, and a
    // measurement should not need write access to find out.
    goal:
      'Report detailed information about the package.json file\n\n' +
      '[tool embodiment.fs.info {"path":"package.json"}]',
    workspace: true,
  },
  {
    // A goal that points at media, so the surface service analyses it rather
    // than reading a filename and guessing at the contents.
    goal: "Describe what is shown in the logo.png image",
    workspace: true,
  },
];

/** Not real work: construction, field init, and reading a module's own state. */
const NOT_WORK =
  /^<|^__name$|^constructor$|^get[A-Z]|^list[A-Z]|^is[A-Z]|^has[A-Z]|Stats$|^[A-Z][A-Za-z0-9_]*(\.|$)/;

function runnerSource(withTask: boolean): string {
  return `
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HybridAgentEngine } from "../src/engine.js";

// A real workspace with a real, dependency-free toolchain.
//
// Without this the task could not be verified at all: verifiersFor builds V1/V2
// verifiers from a toolchain detected in the workspace, and V3 consensus needs a
// caller-supplied evaluator panel. With neither, every run returned
// "unverified" -- the code calls that the honest outcome for a goal nothing
// could check -- so the measurement was scoring a task that never completed
// a verification. The build script is offline and side-effect-free on
// purpose: no install, no network, no dependency on the repo being measured.
// No backticks anywhere in this comment: it is interpolated into a template
// literal in the enclosing function, and one would terminate it early.
const workspace = mkdtempSync(join(tmpdir(), "observe-ws-"));
writeFileSync(join(workspace, "package.json"), JSON.stringify({
  name: "observe-fixture", version: "1.0.0", private: true,
  scripts: { build: "node -e \\"require('fs').writeFileSync('built.txt','ok')\\"" },
}, null, 2));
// A real one-pixel PNG, so a task can point at media that actually exists. The
// surface service reads and analyses it; a filename that resolves to nothing
// would only measure the error path.
writeFileSync(join(workspace, "logo.png"), Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
));

const engine = new HybridAgentEngine({
  homePath: mkdtempSync(join(tmpdir(), "observe-")),
  kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
  sandboxBackend: "local",
  model: { provider: "mock" },
  autoApproveWorkspaceWrites: true,
  allowProcessExecution: true,
});
await engine.initialize();

// Record whether each capability invocation actually succeeded.
//
// Coverage cannot tell a call that worked from one that threw: a capability that
// fails on its first line still executes that line, so the module shows up as
// exercised. That is exactly how embodiment.fs.* was reported as working while
// every invocation threw ENOENT. The broker knows the outcome, so it is asked.
const capabilityOutcomes = [];
engine.capabilities.subscribe((event) => {
  if (event.phase !== "finished") return;
  capabilityOutcomes.push({
    capabilityId: event.descriptor.id,
    status: event.status ?? "ok",
    durationMs: event.durationMs,
    ...(event.error ? { error: String(event.error).slice(0, 200) } : {}),
  });
});
${
  withTask
    ? TASKS.map((task, index) => {
        const verifier = task.missingTool
          ? `\n  verifiers: [{\n    name: "tooling",\n    tier: "V2_empirical",\n    run: async () => ({\n      verdict: "fail",\n      evidence: "no such tool '${task.missingTool}'",\n      confidence: 0.9,\n    }),\n  }],`
          : "";
        return `await engine.execute({
  tenantId: "local", sessionId: "observe-${index}", familyId: "observe-${index}",
  goal: ${JSON.stringify(task.goal)},${task.workspace ? "\n  workspace," : ""}${verifier}
}).catch(() => undefined);`;
      }).join("\n")
    : ""
}
const outcomesPath = process.env["OBSERVE_OUTCOMES"];
if (outcomesPath) writeFileSync(outcomesPath, JSON.stringify(capabilityOutcomes));
await engine.shutdown();
`;
}

/** Module path -> method names that ran, from one coverage directory. */
function readCoverage(directory: string): {
  calls: Map<string, Set<string>>;
  loaded: Set<string>;
} {
  const calls = new Map<string, Set<string>>();
  // Tracked separately from `calls` on purpose. `calls` only records functions
  // that survive the NOT_WORK filter, so a module whose only executed code was
  // accessors never appears in it and would be misreported as "never loaded".
  // Presence in the coverage output is the real signal that V8 parsed and ran
  // the file, independent of what ran inside it.
  const loaded = new Set<string>();
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".json")) continue;
    const parsed = JSON.parse(readFileSync(join(directory, file), "utf8")) as {
      result?: Array<{
        url?: string;
        functions?: Array<{ functionName?: string; ranges?: Array<{ count?: number }> }>;
      }>;
    };
    for (const script of parsed.result ?? []) {
      const url = script.url ?? "";
      if (!url.includes("/src/") || url.includes("/node_modules/")) continue;
      const modulePath = url.split("/src/")[1]!.replace(/\.[cm]?[jt]s$/, "");
      loaded.add(modulePath);
      for (const fn of script.functions ?? []) {
        const name = fn.functionName ?? "";
        if (!name || NOT_WORK.test(name)) continue;
        if (!(fn.ranges ?? []).some((range) => (range.count ?? 0) > 0)) continue;
        let bucket = calls.get(modulePath);
        if (!bucket) calls.set(modulePath, (bucket = new Set()));
        bucket.add(name);
      }
    }
  }
  return { calls, loaded };
}

/** Same prefix rule as methodsFor, applied to module presence. */
function isLoaded(loaded: Set<string>, module: string): boolean {
  if (loaded.has(module)) return true;
  for (const path of loaded) if (path.startsWith(`${module}/`)) return true;
  return false;
}

/** A registry entry may be a file or a directory of files. */
function methodsFor(calls: Map<string, Set<string>>, module: string): Set<string> {
  const found = new Set(calls.get(module) ?? []);
  for (const [path, names] of calls) {
    if (path.startsWith(`${module}/`)) for (const name of names) found.add(name);
  }
  return found;
}

/** One recorded capability invocation, from the broker rather than from coverage. */
type CapabilityOutcome = {
  capabilityId: string;
  status: string;
  durationMs?: number;
  error?: string;
};

function measure(withTask: boolean): {
  calls: Map<string, Set<string>>;
  loaded: Set<string>;
  outcomes: readonly CapabilityOutcome[];
} {
  // The runner must live inside the package: it imports "../src/engine.js",
  // and a script in /tmp cannot resolve that or the workspace's dependencies.
  const probeDirectory = mkdtempSync(join(resolve("."), ".observe-"));
  const script = join(probeDirectory, "run.mts");
  const coverage = mkdtempSync(join(tmpdir(), "observe-cov-"));
  const outcomesFile = join(probeDirectory, "capability-outcomes.json");
  writeFileSync(script, runnerSource(withTask));
  try {
    execFileSync(resolve("../../node_modules/.bin/tsx"), [script], {
      env: { ...process.env, NODE_V8_COVERAGE: coverage, OBSERVE_OUTCOMES: outcomesFile },
      stdio: "ignore",
      timeout: 300_000,
    });
    const coverageResult = readCoverage(coverage);
    // Absent means the runner never wrote it -- an empty list would be a lie
    // about invocations that may well have happened.
    const outcomes: readonly CapabilityOutcome[] = existsSync(outcomesFile)
      ? (JSON.parse(readFileSync(outcomesFile, "utf-8")) as CapabilityOutcome[])
      : [];
    return { ...coverageResult, outcomes };
  } finally {
    rmSync(probeDirectory, { recursive: true, force: true });
    rmSync(coverage, { recursive: true, force: true });
  }
}

/**
 * Classify recorded invocations per capability.
 *
 * Kept pure and exported so the one judgement this file makes -- whether a
 * capability worked or only threw -- can be tested without running the engine.
 * `onlyErrors` is the case that matters: coverage will happily report the module
 * as exercised while every invocation failed.
 */
export function classifyOutcomes(
  outcomes: ReadonlyArray<{ capabilityId: string; status: string; error?: string }>,
): Map<string, { ok: number; error: number; onlyErrors: boolean; lastError?: string }> {
  const byId = new Map<string, { ok: number; error: number; onlyErrors: boolean; lastError?: string }>();
  for (const outcome of outcomes) {
    const entry = byId.get(outcome.capabilityId) ?? { ok: 0, error: 0, onlyErrors: false };
    if (outcome.status === "ok") entry.ok += 1;
    else {
      entry.error += 1;
      if (outcome.error) entry.lastError = outcome.error;
    }
    entry.onlyErrors = entry.ok === 0 && entry.error > 0;
    byId.set(outcome.capabilityId, entry);
  }
  return byId;
}

/**
 * Which capabilities file declares each capability id.
 *
 * Read from the source rather than maintained by hand, for the same reason the
 * rest of this tool measures instead of declaring: a hand-written map from
 * `capabilityId` to module decays the moment a capability moves or is added, and
 * a stale map silently attributes an outcome to the wrong module.
 *
 * Only ids are read, never executed, so this cannot start a service.
 */
export function capabilityModules(sourceRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  const directory = join(sourceRoot, "capabilities");
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(join(directory, file), "utf-8");
    const module = `capabilities/${file.replace(/\.ts$/, "")}`;
    for (const match of text.matchAll(/\bid:\s*"([a-z0-9][a-z0-9._-]*)"/gi)) {
      // First declaration wins: a capability id is unique across the registry,
      // and the broker refuses to register a duplicate anyway.
      if (!map.has(match[1]!)) map.set(match[1]!, module);
    }
  }
  return map;
}

/**
 * The invocations of one module's own capabilities.
 *
 * An outcome with no known module is left out rather than guessed at: a
 * capability whose id appears nowhere in `capabilities/` cannot be attributed,
 * and attributing it by prefix would let one rename silently move a failure
 * between modules.
 */
export function moduleOutcomes(
  capabilityToModule: ReadonlyMap<string, string>,
  module: string,
  outcomes: ReadonlyArray<{ capabilityId: string; status: string; error?: string }>,
): Array<{ capabilityId: string; status: string; error?: string }> {
  return outcomes.filter(
    (outcome) => capabilityToModule.get(outcome.capabilityId) === module,
  );
}

/**
 * How deeply the runtime touched one module, judged from coverage *and* from
 * whether the calls worked.
 *
 * Coverage alone cannot make this judgement. A function that throws on its first
 * line still executes that line, so V8 reports the module as exercised — which
 * is exactly how `embodiment.fs.*` was reported as working while every
 * invocation threw ENOENT. The headline this tool prints is "N modules did work",
 * and counting a module whose every call failed as having done work makes that
 * sentence false.
 *
 * The demotion is deliberately narrow:
 * - it applies only when the module's capabilities were **all** failures. One
 *   success means the module demonstrably worked at least once.
 * - it applies only when there is outcome evidence at all. Most modules are not
 *   reached through the capability broker, so they have no outcomes, and "no
 *   evidence of failure" is not evidence of failure.
 */
export function judgeDepth(
  module: string,
  input: {
    methodsDuringTask: ReadonlyArray<string>;
    loaded: boolean;
    outcomes: ReadonlyArray<{ capabilityId: string; status: string; error?: string }>;
    capabilityToModule: ReadonlyMap<string, string>;
  },
): { depth: "exercised" | "failed" | "idle" | "never-loaded"; failingCapability?: string } {
  if (input.methodsDuringTask.length === 0) {
    return { depth: input.loaded ? "idle" : "never-loaded" };
  }
  const own = moduleOutcomes(input.capabilityToModule, module, input.outcomes);
  if (own.length > 0 && own.every((outcome) => outcome.status !== "ok")) {
    const failing = own.find((outcome) => outcome.error);
    return { depth: "failed", ...(failing?.error ? { failingCapability: `${failing.capabilityId}: ${failing.error}` } : {}) };
  }
  return { depth: "exercised" };
}

/**
 * The tool checks its own judgement before it reports anyone else's.
 *
 * `observe:runtime` exists to catch modules that look wired but do nothing. A
 * tool that can be wrong about that is worse than no tool, because its output is
 * copied into the state documents and believed. So on every run it re-derives
 * three facts about itself and refuses to finish quietly if any of them is off:
 *
 * 1. it can still attribute a capability to the file that declares it — the
 *    attribution is read from source, so a rename breaks it rather than lying;
 * 2. it still demotes a module whose every recorded call failed;
 * 3. it still does *not* demote one that has no outcome evidence, because most
 *    modules never go through the broker and "no evidence" is not "failure".
 *
 * Exits non-zero on failure, so a broken measurement cannot pass as a green run.
 */
function selfCheck(capabilityToModule: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  if (capabilityToModule.get("filesystem.write") !== "capabilities/filesystem") {
    problems.push(
      `attribution broke: filesystem.write -> ${String(capabilityToModule.get("filesystem.write"))}, expected capabilities/filesystem`,
    );
  }
  const failing = judgeDepth("capabilities/embodiment", {
    methodsDuringTask: ["readFile"],
    loaded: true,
    outcomes: [{ capabilityId: "embodiment.fs.info", status: "error", error: "ENOENT" }],
    capabilityToModule,
  });
  if (failing.depth !== "failed") {
    problems.push(`depth judgement broke: a module whose only call threw was called "${failing.depth}"`);
  }
  const unmeasured = judgeDepth("aurora/introspection", {
    methodsDuringTask: ["summarise"],
    loaded: true,
    outcomes: [],
    capabilityToModule,
  });
  if (unmeasured.depth !== "exercised") {
    problems.push(`depth judgement broke: a module with no outcome evidence was called "${unmeasured.depth}"`);
  }
  return problems;
}

function main(): void {
  const capabilityToModule = capabilityModules(resolve("src"));
  process.stdout.write("Measuring startup only...\n");
  const startup = measure(false);
  process.stdout.write("Measuring startup + one real task...\n");
  const withTask = measure(true);

  // Coverage says a module ran; the broker says whether the call worked. A
  // capability that throws on its first line still executes that line, so the
  // module counts as exercised. Reporting the failures next to the count is what
  // keeps "exercised" from meaning "working".
  const failed = withTask.outcomes.filter((outcome) => outcome.status !== "ok");
  if (withTask.outcomes.length === 0) {
    process.stdout.write("\nNo capability invocations were recorded.\n");
  } else {
    const byId = classifyOutcomes(withTask.outcomes);
    process.stdout.write(
      `\n${withTask.outcomes.length} capability invocations, ${failed.length} of them threw:\n`,
    );
    for (const [capabilityId, entry] of [...byId.entries()].sort()) {
      const verdict =
        entry.ok === 0
          ? "ONLY ERRORS"
          : entry.error === 0
            ? "ok"
            : `${entry.ok} ok / ${entry.error} threw`;
      process.stdout.write(`  ${capabilityId.padEnd(30)} ${verdict}\n`);
      if (entry.ok === 0 && entry.lastError) {
        process.stdout.write(`  ${"".padEnd(30)} ${entry.lastError}\n`);
      }
    }
    if (failed.length > 0) {
      process.stdout.write(
        "\nA module can be listed as exercised above while its only calls failed.\n",
      );
    }
  }

  const rows = MODULE_MATURITY.map((entry) => {
    const during = [...methodsFor(withTask.calls, entry.module)].filter(
      (name) => !methodsFor(startup.calls, entry.module).has(name),
    );
    const loaded = isLoaded(withTask.loaded, entry.module);
    // Four states, not two. This used to read
    // `loaded ? "constructed" : "constructed"` — both branches identical, so
    // `loaded` was computed and thrown away, and a module the engine never even
    // imported was reported as "constructed at startup". That distinction is
    // the whole basis for prioritising wiring work: "loaded but never consulted"
    // means a missing call site, while "never loaded" means nothing references
    // it on this path at all.
    //
    // `failed` is the fourth: the module ran, and every capability of its own
    // that the broker recorded threw. See `judgeDepth`.
    const judged = judgeDepth(entry.module, {
      methodsDuringTask: during,
      loaded,
      outcomes: withTask.outcomes,
      capabilityToModule,
    });
    return {
      module: entry.module,
      depth: judged.depth,
      methods: during.sort(),
      ...(judged.failingCapability ? { failingCapability: judged.failingCapability } : {}),
    };
  });

  const exercised = rows.filter((row) => row.depth === "exercised");
  const failedRows = rows.filter((row) => row.depth === "failed");
  const idle = rows.filter((row) => row.depth === "idle");
  const neverLoaded = rows.filter((row) => row.depth === "never-loaded");
  process.stdout.write(
    `\n${exercised.length}/${rows.length} modules did work during the task.\n` +
      `  ${failedRows.length} ran but every recorded call failed — not counted as work\n` +
      `  ${idle.length} loaded but never consulted — a call site is missing\n` +
      `  ${neverLoaded.length} never loaded — nothing on this path references them\n\n`,
  );
  const mark: Record<string, string> = { exercised: "✓", failed: "✗", idle: "○", "never-loaded": "·" };
  for (const row of rows) {
    const detail = row.methods.length > 0 ? row.methods.slice(0, 4).join(", ") : "—";
    process.stdout.write(
      `  ${mark[row.depth]} ${row.module.padEnd(40)} ${row.depth.padEnd(13)} ${detail}\n`,
    );
    if (row.failingCapability) {
      process.stdout.write(`  ${"".padEnd(42)} ${row.failingCapability}\n`);
    }
  }
  process.stdout.write(
    "\nLegend: ✓ did work · ✗ ran, every call failed · ○ loaded, no task work · · never loaded\n",
  );

  // Run before the closing line, so a measurement that cannot be trusted does
  // not end with the instruction to copy it into the state documents.
  const problems = selfCheck(capabilityToModule);
  if (problems.length > 0) {
    process.stdout.write("\nSelf-check FAILED — this measurement is not trustworthy:\n");
    for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    "Self-check passed: attribution and the exercised/failed distinction still behave as tested.\n" +
      "Update RUNTIME_OBSERVATIONS in src/experimental/runtime-observation.ts if this differs.\n",
  );

  // Machine-readable form of the same measurement, with the full method lists.
  //
  // The table above truncates each row to four methods so it stays readable.
  // Anything that regenerates `RUNTIME_OBSERVATIONS` must not parse that table:
  // doing so silently records the truncated list, and a module whose fifth
  // method happens to be the interesting one loses it. This happened -- adding
  // error paths made `messageOf` sort into the first four and pushed `run` out,
  // so a test asserting the loop ran broke on a measurement that had not
  // actually changed. Set OBSERVE_JSON=1 to get the untruncated data.
  if (process.env["OBSERVE_JSON"] === "1") {
    process.stdout.write(
      "\n---JSON---\n" +
        JSON.stringify(
          rows.map((row) => ({
            module: row.module,
            depth: row.depth,
            methods: row.methods,
          })),
        ) +
        "\n",
    );
  }
}

main();
