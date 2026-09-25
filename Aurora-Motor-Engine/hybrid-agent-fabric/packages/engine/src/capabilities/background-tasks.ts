import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Supervisor } from "../runtime/supervisor.js";
import type { SessionModeService } from "../policy/session-modes.js";
import type { SessionEffortService } from "../policy/session-effort.js";
import type { UserQuestionService } from "../runtime/user-questions.js";
import { auroraText } from "../util/aurora-state.js";
import { defineCapability } from "./schema.js";

export interface BackgroundTaskDeps {
  supervisor: Supervisor;
  approvals?: { list: (sessionId?: string) => Array<{ status: string }> };
  modes?: SessionModeService;
  effort?: SessionEffortService;
  questions?: UserQuestionService;
}

/**
 * Background-task control.
 *
 * Aurora could already spawn children, message them and read a family roster, but there was no single
 * answer to the operational question a supervising agent actually has: *what is running under me, how
 * far along is it, and how do I stop that one?* Peers made this three tools; here it is three
 * capabilities over machinery that already existed, with the same reach rules the messaging path uses.
 *
 * Two refusals matter: a session may only monitor and stop agents inside its own family reach — the
 * roster is the authority, not a caller-supplied id — and stopping is explicit about *what* it stops.
 * `cancel` ends the current turn and leaves the agent alive; `close` ends the agent. Conflating them
 * would make "stop that" mean two different things on two different days.
 */
export function backgroundTaskCapabilities(deps: BackgroundTaskDeps) {
  const reachable = async (sessionId: string, targetSessionId: string) => {
    const roster = await deps.supervisor.familyRoster(sessionId);
    const entry = roster.find((item) => item.sessionId === targetSessionId);
    if (!entry) throw new Error(`Agent ${targetSessionId} is not within this session's family reach.`);
    return entry;
  };

  return [
    defineCapability(
      {
        id: "tasks.monitor",
        version: "1.0.0",
        description: "What is running within this session's family reach: status, progress, usage, mode, effort and open questions per agent.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({ relationship: z.enum(["parent", "sibling", "child"]).optional(), includeSelf: z.boolean().optional() }),
      async (input, context) => {
        const roster = await deps.supervisor.familyRoster(context.sessionId);
        const targets = roster.filter((item) => (input.relationship ? item.relationship === input.relationship : true));
        const ids = [...targets.map((item) => item.sessionId), ...(input.includeSelf ? [context.sessionId] : [])];
        const agents = [];
        for (const sessionId of ids) {
          const snapshot = await deps.supervisor.getSession(sessionId).catch(() => undefined);
          if (!snapshot) continue;
          const entry = targets.find((item) => item.sessionId === sessionId);
          const usage = snapshot.totalUsage ?? { inputTokens: 0, outputTokens: 0 };
          agents.push({
            sessionId,
            name: snapshot.name,
            relationship: entry?.relationship ?? "self",
            status: snapshot.status,
            // "Busy" is the honest signal a supervisor needs: a turn is genuinely in flight.
            busy: Boolean(snapshot.activeTurnId),
            generation: snapshot.generation,
            lastSequence: snapshot.lastSequence,
            updatedAt: snapshot.updatedAt,
            totalTokens: usage.inputTokens + usage.outputTokens,
            openTasks: snapshot.tasks?.filter((task) => !["done", "cancelled"].includes(task.status)).length ?? 0,
            ...(deps.modes ? { mode: (await deps.modes.get(context.tenantId, sessionId).catch(() => undefined))?.permissionMode } : {}),
            ...(deps.effort ? { effort: (await deps.effort.get(context.tenantId, sessionId).catch(() => undefined))?.level } : {}),
            openQuestions: deps.questions ? deps.questions.list({ sessionId, pendingOnly: true }).length : 0,
            // "Busy" and "blocked" look identical from the outside unless something says so: an agent
            // sitting on an unanswered question is not working, it is waiting on a human.
            waitingOn: deps.questions && deps.questions.list({ sessionId, pendingOnly: true }).length > 0
              ? "question"
              : deps.approvals && deps.approvals.list(sessionId).some((item) => item.status === "pending")
                ? "approval"
                : null,
          });
        }
        return { currentSessionId: context.sessionId, agents, generatedAt: new Date().toISOString() };
      },
    ),
    defineCapability(
      {
        id: "tasks.stop",
        version: "1.0.0",
        description: "Stop an agent within family reach: cancel its current turn, or close it entirely. The reason is recorded on the target session.",
        // Stopping only ever reduces activity. Requiring an approval prompt to halt a runaway agent
        // would be exactly backwards, so this is ungated — but it is bounded by family reach and the
        // reason is recorded, so it is never an anonymous kill.
        risk: "pure",
        sideEffect: true,
        source: "core",
      },
      z.object({
        sessionId: z.string().min(1).max(200),
        mode: z.enum(["cancel", "close"]).optional(),
        reason: z.string().min(1).max(1000),
      }),
      async (input, context) => {
        const targetSessionId = auroraText(input.sessionId, 200, "Session ID");
        if (targetSessionId === context.sessionId) throw new Error("A session cannot stop itself; end the turn instead.");
        const entry = await reachable(context.sessionId, targetSessionId);
        const mode = input.mode ?? "cancel";
        const result = await deps.supervisor.dispatch({
          protocolVersion: 1,
          commandId: randomUUID(),
          clientId: "tasks.stop",
          tenantId: context.tenantId,
          sessionId: targetSessionId,
          kind: mode === "close" ? "session.close" : "session.cancel",
          source: "agent",
          issuedAt: new Date().toISOString(),
          payload: { reason: auroraText(input.reason, 1000, "Stop reason") },
        });
        return {
          sessionId: targetSessionId,
          name: entry.name,
          relationship: entry.relationship,
          mode,
          status: result.status,
          reason: input.reason,
        };
      },
    ),
    defineCapability(
      {
        id: "tasks.resume",
        version: "1.0.0",
        description: "Resume a stopped or idle agent within reach by delivering a follow-up instruction through the durable inbox.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({ sessionId: z.string().min(1).max(200), text: z.string().min(1).max(20_000) }),
      async (input, context) => {
        const entry = await reachable(context.sessionId, input.sessionId);
        const delivery = await deps.supervisor.sendAgentMessage({
          senderSessionId: context.sessionId,
          targetSessionId: input.sessionId,
          message: input.text,
          mode: "follow_up",
        });
        return {
          sessionId: input.sessionId,
          name: entry.name,
          relationship: entry.relationship,
          mode: "follow_up",
          receipts: delivery.receipts,
        };
      },
    ),
  ];
}

/**
 * Model-callable mode transitions.
 *
 * Aurora's session modes were operator-set, so the agent could not say "let me look around first" and
 * then hand control back. Peers expose entering and leaving plan mode as tools, and the discipline that
 * makes it useful is on the way *out*: leaving plan mode requires naming what the exploration produced,
 * so "I explored" cannot quietly become "I am now allowed to write".
 */
export function planModeCapabilities(modes: SessionModeService) {
  return [
    defineCapability(
      {
        id: "session.plan.enter",
        version: "1.0.0",
        description: "Enter plan mode: read-only exploration that can still write plans and decisions.",
        // Entering plan mode only removes authority, so it needs no approval. Leaving it grants
        // authority, which is why the exit below stays privileged.
        risk: "pure",
        sideEffect: true,
        source: "core",
      },
      z.object({ reason: z.string().min(1).max(1000) }),
      async (input, context) => await modes.set({
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        permissionMode: "plan",
        reason: `Agent entered plan mode: ${input.reason}`,
        actor: "agent",
      }),
    ),
    defineCapability(
      {
        id: "session.plan.exit",
        version: "1.0.0",
        description: "Leave plan mode for execution. Requires the plan id or a summary of what the exploration produced.",
        risk: "privileged",
        sideEffect: true,
        source: "core",
      },
      z.object({
        permissionMode: z.enum(["manual", "acceptEdits", "auto", "dontAsk"]).optional(),
        planId: z.string().max(300).optional(),
        summary: z.string().max(2000).optional(),
      }),
      async (input, context) => {
        const current = await modes.get(context.tenantId, context.sessionId);
        if (current.permissionMode !== "plan") throw new Error(`Session is in "${current.permissionMode}" mode, not plan mode.`);
        if (!input.planId && !input.summary) {
          throw new Error("Leaving plan mode requires the plan id it produced, or a summary of what was decided.");
        }
        return await modes.set({
          tenantId: context.tenantId,
          sessionId: context.sessionId,
          // Back to asking by default: exploration earns execution, not unattended authority.
          permissionMode: input.permissionMode ?? "manual",
          reason: `Agent left plan mode: ${input.planId ? `plan ${input.planId}` : input.summary!.slice(0, 900)}`,
          actor: "agent",
        });
      },
    ),
  ];
}
