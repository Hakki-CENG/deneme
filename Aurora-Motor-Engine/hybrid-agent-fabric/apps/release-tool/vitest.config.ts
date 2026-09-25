import { defineConfig } from "vitest/config";

import { hafProject } from "../../vitest.project.js";

/**
 * Per-workspace config. Without this file vitest walks up the tree, finds the
 * root config and runs every project in the monorepo — see vitest.project.ts.
 */
export default defineConfig(hafProject("release-tool", "./apps/release-tool/"));
