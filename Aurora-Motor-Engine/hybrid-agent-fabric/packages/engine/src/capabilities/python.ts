import { z } from "zod";
import type { KernelManager } from "../kernel/kernel-manager.js";
import { defineCapability } from "./schema.js";

export function pythonCapability(kernels: KernelManager) {
  return defineCapability(
    {
      id: "python.execute",
      version: "1.0.0",
      description: "Execute Python in the session's persistent kernel. Use haf.call(capability, arguments) for governed host actions.",
      risk: "process",
      sideEffect: false,
      source: "core",
    },
    z.object({ code: z.string().min(1).max(200_000) }),
    async ({ code }, context) => await kernels.execute(code, context),
  );
}
