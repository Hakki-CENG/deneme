import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { hafProject } from "../../vitest.project.js";

/**
 * Canvas Web per-workspace config.
 *
 * This was already the only workspace with its own config, which is why it was
 * also the only one that collected just its own files. It now shares the common
 * definition with the rest (see vitest.project.ts) and adds the React plugin,
 * so component tests can import .tsx without a second config change.
 *
 * `e2e/**` is excluded by the shared definition: those are Playwright specs
 * that throw when vitest collects them. Playwright owns them via
 * `playwright.config.ts` (`npm run test:e2e`).
 */
export default defineConfig({
  ...hafProject("canvas-web", "./apps/canvas-web/"),
  plugins: [react()],
});
