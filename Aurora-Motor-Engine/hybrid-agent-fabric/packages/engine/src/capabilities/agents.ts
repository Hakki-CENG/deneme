import { z } from "zod";
import type { Supervisor } from "../runtime/supervisor.js";
import { defineCapability } from "./schema.js";

export function agentCapabilities(supervisor: Supervisor) {
  return [
    defineCapability(
      {
        id: "agent.spawn",
        version: "1.0.0",
        description: "Admit a persistent child agent in an isolated worktree/copy and return its handle immediately.",
        risk: "process",
        sideEffect: true,
        source: "core",
      },
      z.object({
        task: z.string().min(1).max(100_000),
        name: z.string().max(100).optional(),
        // A forked child starts from what the parent already knows, which is usually the difference
        // between a useful delegate and one that asks the same questions again.
        inheritConversation: z.union([z.boolean(), z.number().int().min(1).max(200)]).optional(),
      }),
      async ({ task, name, inheritConversation }, context) => {
        const child = await supervisor.spawnChild({
          parentSessionId: context.sessionId,
          task,
          ...(name ? { name } : {}),
          ...(inheritConversation === undefined ? {} : { inheritConversation }),
          source: "agent",
          insideParentTurn: true,
        });
        return {
          childSessionId: child.sessionId,
          familyId: child.familyId,
          name: child.name,
          workspacePath: child.workspacePath,
          status: child.status,
        };
      },
    ),
    defineCapability(
      {
        id: "agent.fanout",
        version: "1.0.0",
        description: "This session's child-agent budget: nesting depth, live and lifetime children, the limits in force, and whether another spawn would be accepted.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      // An agent that can see the limit can plan within it instead of discovering it by failing.
      async (_input, context) => await supervisor.fanoutStatus(context.sessionId),
    ),
    defineCapability(
      {
        id: "agent.directory",
        version: "1.0.0",
        description: "Every live agent in this tenant, family or not: name, status, whether the name is unique and how deep it sits. Listing is not permission to message.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({ query: z.string().max(200).optional(), includeClosed: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() }),
      async (input, context) => ({
        agents: await supervisor.directory(context.tenantId, {
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.includeClosed === undefined ? {} : { includeClosed: input.includeClosed }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      }),
    ),
    defineCapability(
      {
        id: "agent.message.direct",
        version: "1.0.0",
        description: "Message a same-tenant agent outside family reach, by session id or unique name. Crossing a family boundary is privileged and reviewed.",
        // Family messages are ungated because the family tree *is* the authorisation. Reaching outside
        // it is a different act: it puts text into an agent nobody in this tree supervises, so it goes
        // through the same review as any other privileged capability.
        risk: "privileged",
        sideEffect: true,
        source: "core",
      },
      z.object({
        message: z.string().min(1).max(16_384),
        targetSessionId: z.string().max(200).optional(),
        targetName: z.string().max(200).optional(),
        mode: z.enum(["auto", "steer", "follow_up"]).optional(),
      }),
      async (input, context) => await supervisor.sendDirectedMessage({
        senderSessionId: context.sessionId,
        message: input.message,
        ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
        ...(input.targetName ? { targetName: input.targetName } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      }),
    ),
    defineCapability(
      { id: "agent.list", version: "1.0.0", description: "List the current tenant's active and saved agents.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, context) => ({ sessions: await supervisor.listSessions(context.tenantId) }),
    ),
    defineCapability(
      { id: "agent.roster", version: "1.0.0", description: "List only directly reachable parent, sibling and child agents with relationship and status.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, context) => ({ currentSessionId: context.sessionId, agents: await supervisor.familyRoster(context.sessionId) }),
    ),
    defineCapability(
      {
        id: "agent.send",
        version: "2.0.0",
        description: "Send a rate-limited durable message within direct family reach. Supports auto, steer, follow_up and family-scoped broadcast delivery.",
        risk: "pure",
        sideEffect: true,
        source: "core",
      },
      z.object({
        message: z.string().min(1).max(16_384),
        mode: z.enum(["auto", "steer", "follow_up"]).default("auto"),
        targetSessionId: z.string().min(1).optional(),
        receiverRole: z.enum(["parent", "sibling", "child"]).optional(),
        receiverName: z.string().min(1).max(200).optional(),
        broadcast: z.boolean().default(false),
      }),
      async ({ targetSessionId, receiverRole, receiverName, broadcast, message, mode }, context) =>
        await supervisor.sendAgentMessage({
          senderSessionId: context.sessionId,
          message,
          mode,
          ...(targetSessionId ? { targetSessionId } : {}),
          ...(receiverRole ? { receiverRole } : {}),
          ...(receiverName ? { receiverName } : {}),
          broadcast,
        }),
    ),
  ];
}
