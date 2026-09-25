import { z } from "zod";
import type { Supervisor } from "../runtime/supervisor.js";
import { defineCapability } from "./schema.js";

export function goalCapabilities(supervisor: Supervisor) {
  return [
    defineCapability(
      {
        id: "goal.get",
        version: "1.0.0",
        description: "Inspect the current persistent goal and its budget/progress state.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      async (_input, context) => ({ goal: (await supervisor.getActor(context.sessionId)).goal ?? null }),
    ),
    defineCapability(
      {
        id: "goal.set",
        version: "1.0.0",
        description: "Create or replace the session's persistent goal with bounded continuation and optional token budget.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({
        objective: z.string().min(1).max(20_000),
        tokenBudget: z.number().int().positive().max(10_000_000).optional(),
        maxContinuations: z.number().int().positive().max(100).optional(),
      }),
      async (input, context) =>
        await (await supervisor.getActor(context.sessionId)).goalActionFromCapability(
          "set",
          {
            objective: input.objective,
            ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
            ...(input.maxContinuations !== undefined ? { maxContinuations: input.maxContinuations } : {}),
          },
          context.turnId,
        ),
    ),
    defineCapability(
      {
        id: "goal.complete",
        version: "1.0.0",
        description: "Mark the current persistent goal complete after verifiable success evidence exists.",
        risk: "pure",
        sideEffect: true,
        source: "core",
      },
      z.object({ evidence: z.string().max(10_000).optional() }),
      async (input, context) =>
        await (await supervisor.getActor(context.sessionId)).goalActionFromCapability(
          "complete",
          input.evidence !== undefined ? { evidence: input.evidence } : {},
          context.turnId,
        ),
    ),
  ];
}
