/**
 * Shared Vitest project definition for every workspace in this monorepo.
 *
 * This exists because of a concrete defect: only `apps/canvas-web` had its own
 * `vitest.config.ts`. For the other six workspaces, `vitest run` walked up the
 * directory tree, found the ROOT config, and executed its `projects` list — so
 * `npm run test -w @haf/release-tool` (1 test file) collected all 206 files in
 * the repository. The root `npm test` chain therefore ran the whole suite six
 * times, and `test:adversarial` ran it twice more.
 *
 * Every workspace now has a config produced by this factory, so a per-workspace
 * run collects only that workspace, and the root config composes the very same
 * definitions into `projects`. One definition, two entrypoints, no drift.
 *
 * Two things the definition carries that a bare per-workspace config would miss:
 *
 * 1. `setupFiles` — vitest never changes `process.cwd()` per project; workers
 *    inherit the launch directory. Roughly sixty engine suites resolve fixtures
 *    with `resolve(process.cwd(), ...)` (the Python kernel, the tsx CLI, the
 *    WASI runner build, `test/fixtures/*`), so without the chdir a run from
 *    anywhere else fails with misleading "exited during startup" errors.
 *
 * 2. `exclude` — Playwright specs throw when vitest collects them, and eval
 *    task workspaces contain generated files literally named `*.test.js`.
 */

import { fileURLToPath } from "node:url";
import type { UserProjectOptions } from "vitest/config";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const SETUP_FILE = fileURLToPath(new URL("./vitest.setup.cwd.ts", import.meta.url));

/** Excludes that must hold identically for a root run and a per-workspace run. */
export const sharedExclude: string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.{idea,git,cache,output,temp}/**",
  // Playwright end-to-end specs — run with `npm run test:e2e -w @haf/canvas-web`.
  "**/e2e/**",
  // Generated eval artifacts. Task workspaces and graded outputs can contain
  // files literally named `*.test.js`; they are fixtures produced by a run,
  // not suites to execute.
  "**/packages/eval/results/**",
  "**/packages/eval/.workspaces/**",
];

/**
 * Build the project definition for one workspace.
 *
 * @param name         vitest project name, shown as `|name|` in reporter output
 * @param relativeRoot workspace directory relative to the repository root,
 *                     e.g. `"./packages/engine/"`. `"."` for the root itself.
 */
export function hafProject(name: string, relativeRoot: string): UserProjectOptions {
  const root = fileURLToPath(new URL(relativeRoot, import.meta.url));
  // Strip the trailing slash so `process.cwd()` comparisons in the setup file
  // are exact rather than off by one character.
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return {
    define: { __HAF_PROJECT_ROOT__: JSON.stringify(normalizedRoot) },
    test: {
      name,
      root: normalizedRoot,
      exclude: sharedExclude,
      setupFiles: [SETUP_FILE],
    },
  };
}

/**
 * The seven test-bearing workspaces, in the order `npm test` visits them.
 * Both the root config and this list must stay in step with the workspaces
 * globs in package.json; a workspace with no tests simply has no entry.
 */
export const HAF_TEST_PROJECTS: ReadonlyArray<{ name: string; root: string }> = [
  { name: "engine", root: "./packages/engine/" },
  { name: "eval", root: "./packages/eval/" },
  { name: "control-api", root: "./apps/control-api/" },
  { name: "headless-client", root: "./apps/headless-client/" },
  { name: "release-tool", root: "./apps/release-tool/" },
  { name: "canvas-web", root: "./apps/canvas-web/" },
  { name: "desktop", root: "./apps/desktop/" },
];

/** Repository root, for configs that need to resolve shared assets. */
export const REPO_ROOT: string = HERE.endsWith("/") ? HERE.slice(0, -1) : HERE;
