import { z } from "zod";
import type { AutoApprovalService } from "../policy/auto-approval.js";
import { defineCapability } from "./schema.js";

/**
 * The agent's window onto reviewed automatic approvals.
 *
 * Reading which classes of request are answered automatically is useful to an agent — it can stop
 * asking for something that will be waved through, and it can tell the user why an action went
 * unchallenged. *Granting* is not on this surface: a rule is enabled by an operator through the
 * control API. An agent may only propose, and a proposal arrives disabled, which is the difference
 * between suggesting a policy and writing itself one.
 */
export function autoApprovalCapabilities(autoApprovals: AutoApprovalService) {
  return [
    defineCapability(
      {
        id: "approvals.auto.list",
        version: "1.0.0",
        description: "List the reviewed auto-approval rules in force for this tenant and the recent decisions they produced.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({ includeDecisions: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() }),
      async (input, context) => ({
        rules: await autoApprovals.listRules(context.tenantId),
        decisions: input.includeDecisions
          ? await autoApprovals.listDecisions({
              tenantId: context.tenantId,
              sessionId: context.sessionId,
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            })
          : [],
      }),
    ),
    defineCapability(
      {
        id: "approvals.auto.propose",
        version: "1.0.0",
        description: "Propose a reviewed auto-approval rule. The proposal is stored disabled and only an operator can enable it.",
        // Proposing is privileged even though it grants nothing: an agent shaping the approval policy
        // it lives under is exactly the kind of move that deserves a human in the loop.
        risk: "privileged",
        sideEffect: true,
        source: "core",
      },
      z.object({
        capabilityPattern: z.string().min(1).max(200),
        rationale: z.string().min(10).max(2000),
        argumentPatterns: z.array(z.string().min(1).max(300)).max(10).optional(),
        refusePatterns: z.array(z.string().min(1).max(300)).max(10).optional(),
        scopeToThisSession: z.boolean().optional(),
        maxUses: z.number().int().min(1).max(10_000).optional(),
      }),
      async (input, context) => await autoApprovals.upsertRule({
        tenantId: context.tenantId,
        capabilityPattern: input.capabilityPattern,
        rationale: input.rationale,
        ...(input.argumentPatterns ? { argumentPatterns: input.argumentPatterns } : {}),
        ...(input.refusePatterns ? { refusePatterns: input.refusePatterns } : {}),
        ...(input.scopeToThisSession ? { sessionIds: [context.sessionId] } : {}),
        ...(input.maxUses === undefined ? {} : { maxUses: input.maxUses }),
        createdBy: `agent:${context.sessionId}`,
        proposedByAgent: true,
      }),
    ),
  ];
}
