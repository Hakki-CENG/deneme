import { z } from "zod";
import type { InteractiveArtifactRegistry } from "../artifacts/interactive-artifact-registry.js";
import { defineCapability } from "./schema.js";

export function interactiveArtifactCapabilities(registry: InteractiveArtifactRegistry) {
  return [
    defineCapability(
      {
        id: "artifact.publish", version: "1.0.0",
        description: "Publish a bounded workspace HTML file as a script-isolated interactive artifact with an exact action allowlist.",
        risk: "workspace_read", sideEffect: true, source: "core",
      },
      z.object({ name: z.string().min(1).max(200), sourcePath: z.string().min(1), allowedActions: z.array(z.string().min(1).max(100)).min(1).max(32) }),
      async ({ name, sourcePath, allowedActions }, context) => await registry.publish({
        tenantId: context.tenantId, sessionId: context.sessionId, workspacePath: context.workspacePath,
        name, sourcePath, allowedActions,
      }),
    ),
    defineCapability(
      {
        id: "artifact.list", version: "1.0.0",
        description: "List metadata for interactive artifacts published by the current session without reading their HTML content.",
        risk: "workspace_read", sideEffect: false, source: "core",
      },
      z.object({}),
      async (_input, context) => ({ artifacts: await registry.list(context.tenantId, context.sessionId) }),
    ),
  ];
}
