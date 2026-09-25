/**
 * Keep CURRENT_STATE.md, MATURITY_MATRIX.md and KNOWN_GAPS.md true.
 *
 * The repo previously carried 27 hand-written "PHASE NN COMPLETED ✅" files and
 * a `difficulty-analysis.md` reporting `Weighted Score: 100.0%`, all written
 * before `runTask()` was fixed and all false afterwards. Nothing failed when
 * they went stale, so nobody found out.
 *
 * These tests close that hole: the documents are regenerated in memory and
 * diffed against disk, so editing the maturity register without regenerating —
 * or editing a generated file by hand — breaks the suite.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  MODULE_MATURITY,
  maturityOf,
  stableWithoutProductionEvidence,
} from "@haf/engine/experimental/maturity.js";

import { generateStateDocs, stateDocPath, stalePairs, staleEngineBuilds } from "../src/runner/state-docs-cli.js";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Read the maturity register straight from TypeScript source.
 *
 * The generator imports the register from `@haf/engine`, which resolves to
 * `dist/`. That leaves a silent gap: edit `maturity.ts`, skip the build, and
 * the documents regenerate from the *old* register while every test stays
 * green. That gap was found by deliberately editing the source and watching
 * this suite pass when it should have failed.
 *
 * Parsing the source as text rather than importing it avoids the TS6059
 * project-boundary error that a relative import across packages would raise.
 */
function registerFromSource(): { module: string; level: string }[] {
  const source = readFileSync(
    resolve(__dirname, "../../engine/src/experimental/maturity.ts"),
    "utf8",
  );
  const entries: { module: string; level: string }[] = [];
  const pattern = /module:\s*"([^"]+)",\s*\n\s*level:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    entries.push({ module: match[1] ?? "", level: match[2] ?? "" });
  }
  return entries;
}

/**
 * Strip the parts that move on their own before comparing.
 *
 * Two kinds of noise are removed:
 *
 *  - The `**Generated:** <date>` line, which changes daily by design.
 *  - The measured test counts, which change whenever anyone adds a test —
 *    including when this very file was added, which is how the problem was
 *    found.
 *
 * Both would make the suite fail on the calendar or on unrelated work rather
 * than on a real change. A test that cries wolf teaches people to ignore it,
 * which would defeat the entire purpose of this file.
 *
 * What survives normalisation is the substance: every level assignment, every
 * maturity rating, every gap. Those only change when the register changes, and
 * when they do, this test demands the documents be regenerated.
 *
 * Staleness in the counts is still caught — by `stays close to reality` below,
 * which compares them numerically with tolerance instead of by exact text.
 */
function normalise(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("**Generated:**"))
    .map((line) =>
      line.startsWith("| Test files |") || line.startsWith("| Test cases (declared) |")
        ? line.replace(/\d+/g, "N")
        : line,
    )
    .join("\n");
}

describe("generated state documents", () => {
  const docs = generateStateDocs();

  it("generates exactly the three documents the roadmap requires", () => {
    expect(docs.map((d) => d.file)).toEqual([
      "CURRENT_STATE.md",
      "MATURITY_MATRIX.md",
      "KNOWN_GAPS.md",
    ]);
  });

  for (const doc of docs) {
    describe(doc.file, () => {
      it("exists on disk", () => {
        expect(existsSync(stateDocPath(doc.file))).toBe(true);
      });

      it("matches what the generator produces today", () => {
        const onDisk = readFileSync(stateDocPath(doc.file), "utf8");
        // If this fails: run `npm run docs:state -w @haf/eval` and commit.
        expect(normalise(onDisk)).toBe(normalise(doc.content));
      });

      it("tells the reader not to hand-edit it", () => {
        expect(doc.content).toContain("Do not edit by hand");
      });
    });
  }

  it("reports the real number of test files, not a hard-coded guess", () => {
    const state = docs.find((d) => d.file === "CURRENT_STATE.md");
    const match = /\| Test files \| (\d+) \|/.exec(state?.content ?? "");
    expect(match).not.toBeNull();
    // The suite itself is one of the files being counted, so this can only
    // fail if the walker stops finding directories it used to find. An early
    // version hard-coded two directories and missed 10 files under apps/.
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(190);
  });

  it("keeps the counts on disk close to reality", () => {
    // The exact-match test above normalises these numbers away so that adding
    // one test does not break the build. This is what still catches a document
    // that drifted far from the truth.
    const fresh = docs.find((d) => d.file === "CURRENT_STATE.md")?.content ?? "";
    const onDisk = readFileSync(stateDocPath("CURRENT_STATE.md"), "utf8");
    const read = (text: string): number =>
      Number(/\| Test files \| (\d+) \|/.exec(text)?.[1] ?? "0");

    const actual = read(fresh);
    const documented = read(onDisk);
    expect(documented).toBeGreaterThan(0);
    expect(Math.abs(actual - documented)).toBeLessThanOrEqual(Math.ceil(actual * 0.05));
  });

  it("does not claim a perfect score anywhere", () => {
    // `difficulty-analysis.md` claimed "Weighted Score: 100.0%" while zero
    // tasks passed. No generated document may ever read that way again.
    for (const doc of docs) {
      expect(doc.content).not.toMatch(/100(\.0)?%/);
      expect(doc.content).not.toMatch(/\bTAMAMLANDI\b/);
    }
  });

  it("keeps unwired modules visible instead of rounding them up", () => {
    const gaps = docs.find((d) => d.file === "KNOWN_GAPS.md")?.content ?? "";
    expect(gaps).toContain("Not wired into the execution path");
    // The known honest gap: capability acquisition needs a caller-supplied
    // generator, so the engine leaves it unwired on purpose.
    expect(gaps).toContain("execution/capability-acquisition");
  });

  it("regenerates from a register that matches the TypeScript source", () => {
    // Guards the build-staleness gap described on `registerFromSource`: the
    // generator reads `dist/`, so an un-built edit to `maturity.ts` would
    // otherwise produce confidently wrong documents.
    const fromSource = registerFromSource();
    const fromDist = MODULE_MATURITY.map((m) => ({ module: m.module, level: m.level }));

    // If this fails: run `npm run build -w @haf/engine`, then
    // `npm run docs:state -w @haf/eval`.
    expect(fromSource).toEqual(fromDist);
  });

  it("separates 'a test drives it' from 'a gate measures it'", () => {
    const state = docs.find((d) => d.file === "CURRENT_STATE.md")?.content ?? "";
    expect(state).toContain("`exercised`");
    expect(state).toContain("`verified`");
    expect(state).toContain("An acceptance gate measures it.");
  });

  it("only claims `production` where production evidence is recorded (A10)", () => {
    // `levelOf` used to return "production" whenever `entry.level === "stable"`,
    // so the top rung of the ladder was granted by a hand-written field. The
    // row that showed it: `memory/real-memory-pipeline` read `production`
    // because it is declared stable and covered by `eval:recall`, which measures
    // recall inside this repository — that is `verified`, not production.
    const matrix = docs.find((d) => d.file === "MATURITY_MATRIX.md")?.content ?? "";
    const productionRows = matrix
      .split("\n")
      .filter((line) => /^\| `[^`]+` \| production \|/.test(line));
    expect(productionRows).toEqual([]);

    // Measured at the time of writing: all 6 declared-stable modules, so the
    // matrix holds no `production` row at all. When somebody records real
    // evidence for one, that row appears — which is the point of the rule.
    const declaredStable = MODULE_MATURITY.filter((entry) => entry.level === "stable");
    expect(declaredStable.length).toBe(6);
    expect(stableWithoutProductionEvidence().length).toBe(declaredStable.length);

    // A11: the document must not describe a rule the code no longer implements.
    // This row read "Verified **and** rated `stable` in the maturity register"
    // after A10 changed the rule, so the authoritative file was telling readers
    // that a hand-written field still grants the top rung.
    const state = docs.find((d) => d.file === "CURRENT_STATE.md")?.content ?? "";
    expect(state).toContain("production evidence recorded in the maturity register");
    expect(state).not.toContain("rated `stable` in the maturity register");

    const pipeline = maturityOf("memory/real-memory-pipeline");
    expect(pipeline?.level).toBe("stable");
    expect(pipeline?.productionEvidence).toBeUndefined();
    expect(matrix).toContain("| `memory/real-memory-pipeline` | verified | stable |");
  });
});

describe("the stale-build guard", () => {
  // The documents are generated from the built engine, so a source edit that has
  // not been compiled would be published as if it had. This is the failure that
  // produced documents claiming 20 exercised modules while the record said 29.
  it("flags a source file newer than its build", () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-"));
    const source = join(dir, "record.ts");
    const built = join(dir, "record.js");
    writeFileSync(source, "export const X = 1;");
    writeFileSync(built, "export const X = 1;");
    // Build is older than the source: the source was edited after compiling.
    const now = Date.now() / 1000;
    utimesSync(built, now - 3600, now - 3600);
    utimesSync(source, now, now);

    const stale = stalePairs([{ source, built }]);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.source).toBe(source);
  });

  it("accepts a build that is at least as new as its source", () => {
    const dir = mkdtempSync(join(tmpdir(), "fresh-"));
    const source = join(dir, "record.ts");
    const built = join(dir, "record.js");
    writeFileSync(source, "export const X = 1;");
    writeFileSync(built, "export const X = 1;");
    const now = Date.now() / 1000;
    utimesSync(source, now - 3600, now - 3600);
    utimesSync(built, now, now);

    expect(stalePairs([{ source, built }])).toHaveLength(0);
  });

  it("ignores a pair where either side is missing rather than guessing", () => {
    const dir = mkdtempSync(join(tmpdir(), "partial-"));
    const source = join(dir, "record.ts");
    writeFileSync(source, "export const X = 1;");

    // No build at all: not "stale", just absent. Reporting it as stale would
    // send the reader to rebuild something that was never built.
    expect(stalePairs([{ source, built: join(dir, "nope.js") }])).toHaveLength(0);
  });

  it("reports nothing for the repository's own engine build", () => {
    // The suite runs after the engine is built, so this is the fresh case. If it
    // ever fires here, the checked-in documents are about to be regenerated from
    // a build that predates the sources.
    expect(staleEngineBuilds()).toEqual([]);
  });
});
