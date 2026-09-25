import { defineConfig } from "vitest/config";

import { hafProject } from "../../vitest.project";

export default defineConfig(hafProject("acp-server", "./apps/acp-server/"));
