import { z } from "zod";
import type { BackgroundShellService } from "../sandbox/background-shell.js";
import { defineCapability } from "./schema.js";

/**
 * Background shells as governed capabilities.
 *
 * `shell.start` carries the same `process` risk class as `process.exec`, because it is the same
 * authority — the only difference is that the result arrives later. `shell.output` and `shell.list`
 * are pure reads. `shell.stop` is ungated for the same reason `tasks.stop` is: needing permission to
 * halt a runaway build is exactly backwards. Every one of them is scoped to the calling session, so a
 * leaked shell id buys nothing.
 */
export function backgroundShellCapabilities(shells: BackgroundShellService) {
  return [
    defineCapability(
      {
        id: "shell.start",
        version: "1.0.0",
        description: "Start a long-running command in the session sandbox and return immediately with a shell id. Read its output with shell.output and end it with shell.stop.",
        risk: "process",
        sideEffect: true,
        source: "core",
      },
      z.object({
        command: z.string().min(1).max(50_000),
        cwd: z.string().max(1000).optional(),
        label: z.string().max(200).optional(),
        timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      }),
      async (input, context) => await shells.start({
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        workspacePath: context.workspacePath,
        command: input.command,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      }),
    ),
    defineCapability(
      {
        id: "shell.output",
        version: "1.0.0",
        description: "Read output produced by a background shell since a cursor. Optionally waits for new output instead of returning empty.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({
        shellId: z.string().min(1).max(200),
        cursor: z.number().int().min(0).optional(),
        maxChars: z.number().int().min(100).max(200_000).optional(),
        waitMs: z.number().int().min(0).max(60_000).optional(),
      }),
      async (input, context) => await shells.output({
        shellId: input.shellId,
        sessionId: context.sessionId,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
        ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
      }),
    ),
    defineCapability(
      {
        id: "shell.stop",
        version: "1.0.0",
        description: "Kill a background shell started by this session. The reason is recorded on the shell record.",
        risk: "pure",
        sideEffect: true,
        source: "core",
      },
      z.object({ shellId: z.string().min(1).max(200), reason: z.string().min(1).max(1000) }),
      async (input, context) => await shells.stop({ shellId: input.shellId, sessionId: context.sessionId, reason: input.reason }),
    ),
    defineCapability(
      {
        id: "shell.list",
        version: "1.0.0",
        description: "List background shells started by this session, running or recently finished.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({ runningOnly: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() }),
      async (input, context) => ({
        shells: shells.list({
          tenantId: context.tenantId,
          sessionId: context.sessionId,
          ...(input.runningOnly === undefined ? {} : { runningOnly: input.runningOnly }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      }),
    ),
  ];
}
