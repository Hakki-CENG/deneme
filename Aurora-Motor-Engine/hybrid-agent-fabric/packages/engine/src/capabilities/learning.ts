import { z } from "zod";
import type { Capability } from "../types.js";
import type { LearningGovernor } from "../learning/learning-governor.js";
import type { RefinementService } from "../learning/refinement-service.js";
import { defineCapability } from "./schema.js";

export function learningCapabilities(governor: LearningGovernor, refinements?: RefinementService) {
  const capabilities: Capability[] = [
    defineCapability(
      {
        id: "learning.propose",
        version: "1.0.0",
        description: "Propose evidence-backed memory, skill, prompt or subagent learning. Proposal never promotes itself.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({
        kind: z.enum(["memory", "skill", "prompt_addendum", "subagent_spec"]),
        scope: z.enum(["session", "project", "user", "org"]).default("session"),
        title: z.string().min(1).max(300),
        content: z.string().min(1).max(100_000),
        expectedOutcome: z.string().min(1).max(5000),
        evidenceEventIds: z.array(z.string()).min(1).max(200),
        risk: z.enum(["low", "medium", "high"]).optional(),
        skillName: z.string().optional(),
        memoryKind: z.enum(["episodic", "semantic", "preference", "decision"]).optional(),
      }),
      async (input, context) => await governor.propose({
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        kind: input.kind,
        scope: input.scope,
        title: input.title,
        content: input.content,
        payload: {
          ...(input.skillName ? { name: input.skillName } : {}),
          ...(input.memoryKind ? { memoryKind: input.memoryKind } : {}),
        },
        evidenceEventIds: input.evidenceEventIds,
        expectedOutcome: input.expectedOutcome,
        ...(input.risk ? { risk: input.risk } : {}),
        createdBy: "agent",
      }),
    ),
    defineCapability(
      {
        id: "learning.list",
        version: "1.0.0",
        description: "List governed learning candidates for this tenant.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({ status: z.enum(["candidate", "scanned", "evaluated", "approved", "promoted", "rejected", "rolled_back"]).optional() }),
      async ({ status }, context) => ({ candidates: await governor.list(context.tenantId, status) }),
    ),
  ];
  if (refinements) {
    const kind = z.enum(["memory", "skill", "prompt_addendum", "subagent_spec"]);
    const scope = z.enum(["session", "project", "user", "org"]);
    capabilities.push(
      defineCapability(
        {
          id: "learning.refine",
          version: "1.0.0",
          description: "Create a small evidence-backed continual-harness refinement batch. Edits remain governed candidates and never self-promote.",
          risk: "workspace_write",
          sideEffect: true,
          source: "core",
        },
        z.object({
          trigger: z.string().min(1).max(1000),
          rationale: z.string().min(1).max(5000),
          scope: scope.default("session"),
          evidenceEventIds: z.array(z.string()).min(1).max(200),
          edits: z.array(z.object({
            kind,
            title: z.string().min(1).max(300),
            content: z.string().min(1).max(100_000),
            expectedOutcome: z.string().min(1).max(5000),
            risk: z.enum(["low", "medium", "high"]).optional(),
            skillName: z.string().optional(),
            memoryKind: z.enum(["episodic", "semantic", "preference", "decision"]).optional(),
          })).min(1).max(8),
        }),
        async (input, context) => await refinements.create({
          tenantId: context.tenantId,
          sessionId: context.sessionId,
          trigger: input.trigger,
          rationale: input.rationale,
          scope: input.scope,
          evidenceEventIds: input.evidenceEventIds,
          edits: input.edits.map((edit) => ({
            kind: edit.kind,
            title: edit.title,
            content: edit.content,
            expectedOutcome: edit.expectedOutcome,
            payload: {
              ...(edit.skillName ? { name: edit.skillName } : {}),
              ...(edit.memoryKind ? { memoryKind: edit.memoryKind } : {}),
            },
            ...(edit.risk ? { risk: edit.risk } : {}),
          })),
          createdBy: "agent",
        }),
      ),
      defineCapability(
        {
          id: "learning.refinements",
          version: "1.0.0",
          description: "List continual-harness refinement batches for the current session.",
          risk: "pure",
          sideEffect: false,
          source: "core",
        },
        z.object({}),
        async (_input, context) => ({ batches: await refinements.list(context.tenantId, context.sessionId) }),
      ),
    );
  }
  return capabilities;
}
