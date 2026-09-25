import { z } from "zod";
import type { SandboxFactory } from "../sandbox/sandbox.js";
import { sandboxResultAsJson } from "../sandbox/sandbox.js";
import { defineCapability } from "./schema.js";

export function processCapability(factory: SandboxFactory) {
  return defineCapability(
    {
      id: "process.exec",
      version: "1.0.0",
      description: "Execute a bounded shell command in the session sandbox.",
      risk: "process",
      sideEffect: true,
      source: "core",
    },
    z.object({
      command: z.string().min(1).max(50_000),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
      maxOutputChars: z.number().int().positive().max(1_000_000).optional(),
    }),
    async ({ command, cwd, timeoutMs, maxOutputChars }, context) => {
      const sandbox = await factory(context.workspacePath);
      try {
        const result = await sandbox.exec({
          command,
          ...(cwd ? { cwd } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
          ...(maxOutputChars ? { maxOutputChars } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return sandboxResultAsJson(result);
      } finally {
        await sandbox.destroy();
      }
    },
  );
}
