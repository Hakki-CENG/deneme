/**
 * Pin `process.cwd()` to the project root for every test worker.
 *
 * Vitest resolves *module* paths against a project's `root`, but it never
 * changes the working directory — every worker inherits the cwd that `vitest`
 * itself was started from.
 *
 * Many suites in this monorepo resolve fixtures relative to `process.cwd()`,
 * for example:
 *
 *   resolve(process.cwd(), "../../python/kernel_server.py")
 *   resolve(process.cwd(), "test/fixtures/fake-kernel.mjs")
 *
 * Those are correct under the canonical entrypoint (`npm test`, which invokes
 * `vitest run` inside each package) but wrong for a whole-repo
 * `npx vitest run` from the root, which produced spurious failures such as
 * "Detached worker ... exited during startup" and "Cannot find module".
 *
 * Chdir'ing here makes both invocations behave identically, so a root-level run
 * is a truthful signal instead of a trap.
 *
 * `__HAF_PROJECT_ROOT__` is substituted per project by Vite's `define` in
 * `vitest.config.ts`.
 */

import { chdir, cwd } from "node:process";

declare const __HAF_PROJECT_ROOT__: string;

if (typeof __HAF_PROJECT_ROOT__ === "string" && cwd() !== __HAF_PROJECT_ROOT__) {
  chdir(__HAF_PROJECT_ROOT__);
}
