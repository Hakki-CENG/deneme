/**
 * Generate CURRENT_STATE.md, MATURITY_MATRIX.md and KNOWN_GAPS.md from the code.
 *
 * These three documents are generated, not written, for one reason: the repo
 * already accumulated 27 hand-written "PHASE NN COMPLETED ✅" files and a
 * `difficulty-analysis.md` claiming `Weighted Score: 100.0%`, all produced
 * before `runTask()` was fixed and none of them true afterwards. A status
 * document that a human updates is a status document that goes stale silently.
 *
 * Everything below is derived from things that fail loudly when wrong:
 *   - MODULE_MATURITY, which `maturity.test.ts` checks for honesty
 *   - the real test files on disk
 *   - the real npm scripts
 *
 * Run: npm run docs:state -w @haf/eval
 *
 * `state-docs.test.ts` regenerates these in memory and compares them to what is
 * on disk, so a hand edit or an un-regenerated change to the maturity register
 * fails the suite instead of rotting quietly.
 */
import { readdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODULE_MATURITY,
  effectiveLevelOf,
  type ModuleMaturity,
} from "@haf/engine/experimental/maturity.js";
import { observationOf, observationSummary } from "@haf/engine/experimental/runtime-observation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");

/**
 * The seven levels the roadmap asks for, as a strict ladder.
 *
 * Each level implies the ones before it, so a module sits at the highest rung
 * it can actually reach. The point of separating `integrated` from `exercised`
 * from `verified` is that "the code is wired up" and "a test drives it" and
 * "a gate measures it" are three different claims, and collapsing them is how
 * a system ends up reporting confidence it has not earned.
 */
const LEVELS = [
  "implemented", // source exists
  "initialized", // constructed by the engine
  "reachable", // callable from a public entry point
  "integrated", // wired into the real execution path
  "exercised", // a test drives it
  "verified", // an acceptance gate measures it
  "production", // verified + production evidence recorded in the maturity registry
] as const;
type Level = (typeof LEVELS)[number];

/** Modules measured by an acceptance gate in `npm run eval:gates`. */
const GATE_COVERED = new Set([
  "memory/real-memory-pipeline", // eval:recall:lock
  "aurora/self-improvement", // eval:learning
  "execution/unified-execution-loop", // eval:learning drives it end to end
]);

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".turbo"]);

/**
 * Find every `*.test.ts` under the repo.
 *
 * Deliberately a recursive walk rather than a list of known directories. The
 * first version of this function hard-coded `packages/engine/test` and
 * `packages/eval/test` and silently under-reported by 10 files, because tests
 * also live under `apps/control-api`, `apps/headless-client`, `apps/desktop`,
 * `apps/release-tool` and `apps/canvas-web/src`. A status generator that
 * quietly counts the wrong thing is the exact failure it exists to prevent.
 */
function testFiles(dir: string = REPO, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) testFiles(full, acc);
    else if (name.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

/**
 * Count declared test cases.
 *
 * This is a **lower bound**, and the document says so. A table-driven
 * `it.each([...])` declaration counts once here but runs once per row — the
 * repo currently has one such case covering four sandbox providers, so the
 * static count reads 1213 where the runner reports 1217. Reporting the honest
 * lower bound beats reporting a number that looks precise and is wrong; the
 * runner remains the authority.
 */
function countTests(): { files: number; cases: number; tableDriven: number } {
  let cases = 0;
  let tableDriven = 0;
  const files = testFiles();
  for (const file of files) {
    const body = readFileSync(file, "utf8");
    cases += (body.match(/^\s*it\(/gm) ?? []).length;
    tableDriven += (body.match(/^\s*it\.each/gm) ?? []).length;
  }
  return { files: files.length, cases, tableDriven };
}

/**
 * Place a module on the ladder.
 *
 * Deliberately conservative: when the evidence for a rung is missing the module
 * stops at the rung below, because over-reporting is the failure mode this file
 * exists to prevent.
 */
function levelOf(entry: ModuleMaturity): Level {
  if (!entry.wiredToEngine) return "implemented";

  // `integrated` used to rest on `wiredToEngine` alone, which is hand-written
  // and says `true` for all 30 modules. Measured with V8 coverage over a real
  // task, 5 of them actually ran. A module the engine only constructs at
  // startup stops at `initialized` — that is what construction earns.
  if (observationOf(entry.module)?.depth !== "exercised") {
    return entry.hasTests ? "reachable" : "initialized";
  }

  if (!entry.hasTests) return "integrated";
  if (GATE_COVERED.has(entry.module)) {
    // A10: this used to read `entry.level === "stable" ? "production" : "verified"`,
    // which made `production` a function of a hand-written field. An acceptance
    // gate measures the module in this repository; that is `verified`. `production`
    // is a claim about the world outside it, and it now requires somebody to have
    // recorded that observation in `productionEvidence` — see `effectiveLevelOf`.
    return effectiveLevelOf(entry) === "stable" ? "production" : "verified";
  }
  return "exercised";
}

function table(rows: string[][], headers: string[]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `|${headers.map(() => "---").join("|")}|`;
  return [head, sep, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

export interface GeneratedDoc {
  readonly file: string;
  readonly content: string;
}

/** Build the three status documents. Pure: no writes, so tests can diff them. */
export function generateStateDocs(today: string = new Date().toISOString().slice(0, 10)): GeneratedDoc[] {
  const { files, cases, tableDriven } = countTests();
  const now = today;
  const byLevel = new Map<Level, ModuleMaturity[]>();
  for (const entry of MODULE_MATURITY) {
    const level = levelOf(entry);
    byLevel.set(level, [...(byLevel.get(level) ?? []), entry]);
  }

  const counts = LEVELS.map((l) => `${l}: ${byLevel.get(l)?.length ?? 0}`).join(" · ");

  // ── CURRENT_STATE.md ──────────────────────────────────────────────────
  const currentState = `# Aurora — Current State

**Generated:** ${now} by \`npm run docs:state -w @haf/eval\`. Do not edit by hand;
regenerate it. See the header of \`packages/eval/src/runner/state-docs-cli.ts\`
for why this file is generated.

## Measured baseline

| Measurement | Value |
|---|---|
| Test files | ${files} |
| Test cases (declared) | ${cases}${tableDriven > 0 ? ` + ${tableDriven} table-driven declaration(s), so the runner reports slightly more` : ""} |
| Modules in the maturity register | ${MODULE_MATURITY.length} |
| Modules declared wired (hand-written) | ${MODULE_MATURITY.filter((m) => m.wiredToEngine).length} |
| Modules observed doing work in a real task (measured) | ${observationSummary().exercised} |
| Acceptance gates in CI | 4 (\`npm run eval:gates\`) |

## What the levels mean

A module sits at the highest rung it can actually reach. Each rung implies the
ones before it.

${table(
  [
    ["`implemented`", "Source exists."],
    ["`initialized`", "The engine constructs it."],
    ["`reachable`", "Callable from a public entry point."],
    ["`integrated`", "Wired into the real execution path (`wiredToEngine`)."],
    ["`exercised`", "A test drives it (`hasTests`)."],
    ["`verified`", "An acceptance gate measures it."],
    [
      "`production`",
      "Verified **and** production evidence recorded in the maturity register " +
        "(`productionEvidence`). Declaring `stable` is not enough: an acceptance gate " +
        "measures this repository, which is what `verified` means. Nothing here can " +
        "produce that evidence on its own, so the row is empty until somebody records it.",
    ],
  ],
  ["Level", "Means"],
)}

**${counts}**

## Honest summary

- The distinction that matters most here is \`integrated\` vs \`exercised\` vs
  \`verified\`. Most of this system is *exercised* — tests drive it. Far less is
  *verified*, meaning an acceptance gate would fail if it regressed.
- Only ${byLevel.get("production")?.length ?? 0} module(s) reach \`production\`.
  That is not a defect report; it is the cost of using a strict definition.
- The full execution contract lives in
  \`packages/engine/src/execution/execution-status.ts\`:
  \`skipped\`, \`simulated\`, \`unverified\`, \`unavailable\` and \`blocked\` are each
  distinct from \`succeeded\`.

## Verifying this document

\`\`\`bash
npm run check          # typecheck + the full suite
npm run eval:gates     # the four acceptance gates
npm run docs:state -w @haf/eval   # regenerate these documents
\`\`\`
`;

  // ── MATURITY_MATRIX.md ────────────────────────────────────────────────
  const matrixRows = [...MODULE_MATURITY]
    .sort((a, b) => LEVELS.indexOf(levelOf(b)) - LEVELS.indexOf(levelOf(a)) || a.module.localeCompare(b.module))
    .map((entry) => [
      `\`${entry.module}\``,
      levelOf(entry),
      entry.level,
      entry.wiredToEngine ? "yes" : "**no**",
      entry.hasTests ? "yes" : "**no**",
      entry.actualBehaviour.length > 110
        ? `${entry.actualBehaviour.slice(0, 107)}...`
        : entry.actualBehaviour,
    ]);

  const maturityMatrix = `# Aurora — Maturity Matrix

**Generated:** ${now} by \`npm run docs:state -w @haf/eval\`. Do not edit by hand.

Source of truth: \`packages/engine/src/experimental/maturity.ts\`, whose honesty
is itself checked by \`maturity.test.ts\` — a module whose \`actualBehaviour\`
falls short of its \`promisedBehaviour\` may not be rated \`stable\`.

"Actual behaviour" below is what the module really does, not what its name
suggests (Madde 63).

${table(matrixRows, ["Module", "Level", "Maturity", "Wired", "Tests", "Actual behaviour"])}

## Reading this table

- **Level** is derived (see \`CURRENT_STATE.md\`). **Maturity** is the
  hand-reviewed rating from the register.
- \`Wired: no\` means the module exists and may be tested, but the real
  execution path never calls it. Those rows are the honest gaps — see
  \`KNOWN_GAPS.md\`.
`;

  // ── KNOWN_GAPS.md ─────────────────────────────────────────────────────
  const unwired = MODULE_MATURITY.filter((m) => !m.wiredToEngine);
  const observation = observationSummary();
  const idle = MODULE_MATURITY.filter(
    (m) => observationOf(m.module)?.depth !== "exercised",
  );
  const untested = MODULE_MATURITY.filter((m) => !m.hasTests);
  const withGap = MODULE_MATURITY.filter((m) => m.gapToStable);

  const knownGaps = `# Aurora — Known Gaps

**Generated:** ${now} by \`npm run docs:state -w @haf/eval\`. Do not edit by hand.

Measured gaps only. Anything listed here was confirmed by a command, not by
reading code and forming an impression.

## Not wired into the execution path (${unwired.length})

These exist and may be tested, but nothing on the real execution path calls them.

${
  unwired.length > 0
    ? table(
        unwired.map((m) => [`\`${m.module}\``, m.gapToStable ?? "—"]),
        ["Module", "Gap to stable"],
      )
    : "_None._"
}

## Constructed at startup but idle during a real task (${idle.length})

Measured with V8 coverage on ${observation.measuredAt}: two runs of the engine,
one calling only \`initialize()\` and one also running a real goal, with the
difference taken so that startup work is not counted as task work.

**Goal used:** _${observation.underGoal}_

${observation.exercised}/${observation.total} modules did work during the task.
The rest were constructed and never consulted. \`wiredToEngine\` says \`true\`
for ${MODULE_MATURITY.filter((m) => m.wiredToEngine).length}/${MODULE_MATURITY.length} of them,
which is the gap this section exists to show.

One task exercises one path, so a row here means "not reached by this goal",
not "dead code". Regenerate with \`npm run observe:runtime -w @haf/engine\`.

${
  idle.length > 0
    ? table(
        idle.map((m) => [`\`${m.module}\``, m.level, observationOf(m.module)?.depth ?? "unmeasured"]),
        ["Module", "Maturity", "Observed"],
      )
    : "_None._"
}

## Without tests (${untested.length})

${
  untested.length > 0
    ? table(
        untested.map((m) => [`\`${m.module}\``, m.level]),
        ["Module", "Maturity"],
      )
    : "_None._"
}

## Declared distance to stable (${withGap.length})

${
  withGap.length > 0
    ? table(
        withGap.map((m) => [`\`${m.module}\``, m.level, m.gapToStable ?? ""]),
        ["Module", "Maturity", "What is missing"],
      )
    : "_None._"
}

## Gaps outside the module register

The register covers subsystems. These were found by auditing the execution
path itself and are tracked in \`packages/eval/results/54-merged-plan.md\`:

${table(
  [
    ["Capability acquisition chain", "gap → synthesis → verify → registry → retry is not closed end to end"],
    ["Real-model benchmark", "every eval run to date used the mock provider; real-model numbers do not exist yet"],
    ["State backend", "77 services persist to JSON files; only the event store has a Postgres backend"],
  ],
  ["Gap", "Detail"],
)}

## What is explicitly NOT a gap

Confirmed present during audit, listed so they are not re-reported:
Prometheus \`/metrics\`, \`/health\`, OTLP exporter, SSE streaming, the 11-value
execution status contract, the 15-kind failure taxonomy with 11 recovery
strategies, event pagination (\`afterSequence\`), \`VerificationGapError\`, all
four memory types, hybrid retrieval with RRF, context compaction, parallel tool
execution, reward-hacking defences, and durable persistence
(journal/snapshot/lease/Postgres).
`;

  return [
    { file: "CURRENT_STATE.md", content: currentState },
    { file: "MATURITY_MATRIX.md", content: maturityMatrix },
    { file: "KNOWN_GAPS.md", content: knownGaps },
  ];
}

/** Absolute path a generated document belongs at. */
export function stateDocPath(file: string): string {
  return join(REPO, file);
}

/**
 * Refuse to generate from a stale build.
 *
 * This CLI imports `RUNTIME_OBSERVATIONS` and `MODULE_MATURITY` through the
 * engine's package exports, which resolve to `packages/engine/dist` -- not to the
 * TypeScript source. Editing the record and running `docs:state` without
 * rebuilding the engine therefore regenerated the documents from the *previous*
 * record, silently.
 *
 * That is not hypothetical. It happened: the record was updated to 29 exercised
 * modules, `docs:state` was run, and the documents still said 20, because the
 * build predated the edit. Nothing at generation time complained; the mismatch
 * surfaced later as three failing tests in `state-docs.test.ts`.
 *
 * So compare timestamps and stop. A stale build is a cheap thing to detect and an
 * expensive thing to publish.
 *
 * Returns the offending pairs so a caller can report them; empty means fresh.
 */
/**
 * The pure comparison, separated so a test can drive it with real files instead
 * of having to rewind the mtime of the repository's own sources.
 */
export function stalePairs(
  pairs: ReadonlyArray<{ source: string; built: string }>,
): Array<{ source: string; built: string }> {
  return pairs.filter(
    ({ source, built }) =>
      existsSync(source) && existsSync(built) && statSync(source).mtimeMs > statSync(built).mtimeMs,
  );
}

export function staleEngineBuilds(): Array<{ source: string; built: string }> {
  const engineRoot = resolve(REPO, "packages/engine");
  const modules = ["experimental/maturity", "experimental/runtime-observation"];
  return stalePairs(
    modules.map((module) => ({
      source: join(engineRoot, "src", `${module}.ts`),
      built: join(engineRoot, "dist", `${module}.js`),
    })),
  ).map(({ source, built }) => ({
    source: source.replace(`${REPO}/`, ""),
    built: built.replace(`${REPO}/`, ""),
  }));
}

function main(): void {
  const stale = staleEngineBuilds();
  if (stale.length > 0) {
    console.error("Refusing to generate state documents from a stale engine build.");
    console.error("");
    for (const entry of stale) {
      console.error(`  ${entry.source} is newer than ${entry.built}`);
    }
    console.error("");
    console.error("These documents are generated from the built engine, not from the");
    console.error("TypeScript source, so they would report the previous measurement.");
    console.error("Rebuild first:  npm run build -w @haf/engine");
    process.exitCode = 1;
    return;
  }
  const docs = generateStateDocs();
  for (const doc of docs) writeFileSync(stateDocPath(doc.file), doc.content);
  const { files, cases } = countTests();
  console.log("Generated from code:");
  for (const doc of docs) console.log(`  ${doc.file}`);
  console.log(`\n  ${files} test files · ${cases} cases · ${MODULE_MATURITY.length} modules`);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
