import { defineConfig } from "vitest/config";

import { hafProject } from "../../vitest.project";

export default defineConfig(hafProject("session-worker", "./apps/session-worker/"));
