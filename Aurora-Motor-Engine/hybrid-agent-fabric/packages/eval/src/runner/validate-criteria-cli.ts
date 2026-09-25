#!/usr/bin/env node
/**
 * CLI: validate the core eval suite's acceptance criteria and persist the report.
 *
 * Run with: `npm run eval:validate -w @haf/eval`
 *
 * Writes `results/criteria-validation.{json,md}` and exits non-zero when any
 * task is vacuous (passes unsolved) or broken (rejects a known-good solution),
 * so CI fails loudly rather than silently scoring nothing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateCoreSuite, formatCriteriaValidationReport } from "./criteria-validation.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const resultsDir = resolve(packageRoot, "results");

const report = await validateCoreSuite();

await mkdir(resultsDir, { recursive: true });
await writeFile(
  resolve(resultsDir, "criteria-validation.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
await writeFile(
  resolve(resultsDir, "criteria-validation.md"),
  formatCriteriaValidationReport(report),
  "utf8",
);

console.log(`Suite:           ${report.suiteName}`);
console.log(`Tasks:           ${report.totalTasks} (${report.evaluatedTasks} statically checkable, ${report.skippedTasks} need a live run)`);
console.log(`Discriminative:  ${report.discriminative}/${report.evaluatedTasks}`);
console.log(`Reference-check: ${report.withReferenceSolution} tasks`);
console.log(`Vacuous:         ${report.vacuous}`);
console.log(`Broken:          ${report.brokenCriteria}`);
console.log(`\nSaved to ${resultsDir}/criteria-validation.{json,md}`);

if (report.vacuous > 0 || report.brokenCriteria > 0) {
  console.error("\n❌ Gate failed: the suite contains criteria that do not discriminate.");
  process.exit(1);
}
console.log("\n✅ Gate passed: every checkable task rejects the unsolved workspace.");
