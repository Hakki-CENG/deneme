import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

import { HAF_TEST_PROJECTS, hafProject, sharedExclude } from "./vitest.project.js";

/**
 * Root vitest configuration.
 *
 * The canonical entrypoint is `npm test`, which runs `vitest run` inside each
 * workspace. This config makes a whole-repo `npx vitest run` from the root
 * behave identically, so an ad-hoc run is a truthful signal rather than a trap.
 *
 * Both this config and every per-workspace `vitest.config.ts` are built from the
 * same `hafProject()` definition in `vitest.project.ts`. That matters: before
 * the per-workspace configs existed, `vitest run` inside a workspace walked up,
 * found THIS file, and ran all seven projects — so a single-workspace
 * invocation silently executed the entire monorepo suite. See the header of
 * `vitest.project.ts` for the full account.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  test: {
    exclude: sharedExclude,
    projects: HAF_TEST_PROJECTS.map((project) => hafProject(project.name, project.root)),
  },
});
