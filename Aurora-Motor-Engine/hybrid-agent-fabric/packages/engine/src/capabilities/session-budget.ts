import { z } from "zod";
import type { SessionBudgetService } from "../policy/session-budget.js";
import { defineCapability } from "./schema.js";

export interface SessionBudgetCapabilityDeps {
  budgets: SessionBudgetService;
  cost: (sessionId: string) => Promise<{ costUsd: number; costSource: string; usage: { totalTokens: number } }>;
}

/**
 * The agent's view of its own budget.
 *
 * An agent that cannot see its remaining budget can only discover the wall by hitting it, usually
 * halfway through something. Reading it is a pure query; *raising* it is not on this surface at all,
 * because a spend cap an agent can lift is not a spend cap.
 */
export function sessionBudgetCapabilities(deps: SessionBudgetCapabilityDeps) {
  return [
    defineCapability(
      {
        id: "session.budget",
        version: "1.0.0",
        description: "This session's spend budget: what has been spent, what remains, and whether new turns would be refused. Read-only; only an operator can change a cap.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      async (_input, context) => {
        const cost = await deps.cost(context.sessionId);
        return await deps.budgets.evaluate({
          tenantId: context.tenantId,
          sessionId: context.sessionId,
          spentUsd: cost.costUsd,
          totalTokens: cost.usage.totalTokens,
          costSource: cost.costSource,
        });
      },
    ),
  ];
}
