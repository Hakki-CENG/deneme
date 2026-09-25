/**
 * Session agent adapter — connects the cognitive loop to the real agent.
 *
 * This is the join the architecture was missing. `SessionActor` (via
 * `Supervisor`) is the component that actually talks to a model, calls tools
 * and edits a workspace. The cognitive layer never called it; it called 23
 * "subsystem executors" that returned strings like `"Simulation complete"`.
 *
 * `runAgentViaSession` is a `runAgent` implementation for
 * `UnifiedExecutionLoop`: it creates a session, sends the goal as a prompt,
 * waits for the session to settle, and reports what measurably happened.
 *
 * Deliberate choices:
 *
 *   - A rejected command is a failure, not a completion.
 *   - Reaching the timeout is `completed: false`. A run that was cut off has
 *     not finished, however much it did first.
 *   - Token and cost figures come from session events. When the events carry
 *     no usage data the fields are left undefined rather than zero: zero is a
 *     measurement, `undefined` is an admission that nothing was measured.
 */

import { randomUUID } from "node:crypto";

import type { AgentRunResult } from "./unified-execution-loop.js";
import type { TaskContext } from "./task-context.js";

/** The slice of the engine this adapter needs. */
export interface SessionCapableEngine {
  createSession(input: {
    tenantId: string;
    name?: string;
    workspacePath?: string;
    /**
     * Route this session's model calls. Set when recovery escalated after a
     * reasoning or model failure, so the retry does not run on the model that
     * just failed.
     */
    modelRoute?: string;
    fallbackModels?: string[];
  }): Promise<{ sessionId: string }>;

  command(command: {
    protocolVersion: 1;
    commandId: string;
    clientId: string;
    tenantId: string;
    sessionId: string;
    kind: string;
    source: string;
    issuedAt: string;
    payload: Record<string, unknown>;
  }): Promise<{ status: "completed" | "rejected" | "uncertain"; error?: { message: string } | undefined }>;

  session(sessionId: string): Promise<{ status: string }>;

  readEvents(sessionId: string, afterSequence?: number, limit?: number): Promise<unknown[]>;
}

export interface SessionAgentOptions {
  readonly clientId?: string | undefined;
  /** How long to wait for the session to settle. */
  readonly timeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
}

/** Session states meaning the agent has stopped working. */
const SETTLED = new Set(["idle", "closed", "failed", "waiting_approval", "paused"]);

/** Caps that keep the briefing from crowding out the goal. */
const MAX_MEMORIES = 5;

/**
 * A tool directive that arrived inside recalled text, neutralised.
 *
 * Memories are things the system previously learned, not instructions for the
 * current task -- but they reach the model through the same channel as the goal,
 * so a memory containing `[tool ...]` is indistinguishable from the caller asking
 * for that tool. Measured: a task that wrote a file left its directive in memory,
 * the next task recalled it, and the tool ran again on a task that had asked for
 * no tools at all.
 *
 * The directive is replaced rather than deleted so the reader can still see that
 * something was there; silently dropping text would hide the reason a memory
 * looks truncated.
 */
function defangDirectives(text: string): string {
  return text.replace(/\[\s*tool\s+[^\]]*\]/gi, "[tool directive removed from recalled memory]");
}
const MAX_MEMORY_CHARS = 400;
const MAX_FAILURE_CHARS = 500;
/** Recovery directives are written by us and short; the cap is a guard, not a squeeze. */
const MAX_DIRECTIVE_CHARS = 600;

/**
 * Turn what the loop knows into what the agent is told.
 *
 * The loop already recalls memory and computes a plan into `TaskContext`. Until
 * this existed the adapter sent `{ text: context.goal }` — so planning burned
 * time and tokens and changed nothing the agent did. A plan the agent never
 * sees is dead computation.
 *
 * Two rules keep the briefing from doing harm:
 *
 *   - **Every section is omitted when empty.** An empty "PLAN:" heading is an
 *     invitation for the model to invent a plan and then report against its own
 *     invention.
 *   - **Memory is capped.** Everything recalled is not everything worth
 *     sending; an unbounded briefing pushes the actual goal out of attention.
 *
 * The goal always comes first, so the briefing stays subordinate to the task.
 */
export function buildAgentBriefing(context: TaskContext): string {
  const sections: string[] = [context.goal];

  if (context.constraints.length > 0) {
    sections.push(
      ["CONSTRAINTS (these are hard requirements):", ...context.constraints.map((item) => `- ${item}`)].join("\n"),
    );
  }

  const steps = context.plan?.steps ?? [];
  if (steps.length > 0) {
    sections.push(
      [
        "PLAN (from prior analysis — follow it unless you find it wrong, and say so if you do):",
        ...steps.map((step, index) => `${index + 1}. ${step.description}`),
      ].join("\n"),
    );
  }

  if (context.memories.length > 0) {
    const memories = context.memories
      .slice(0, MAX_MEMORIES)
      .map((memory) => `- ${defangDirectives(memory).slice(0, MAX_MEMORY_CHARS)}`);
    sections.push(["RELEVANT MEMORY (from earlier work; verify before relying on it):", ...memories].join("\n"));
  }

  if (context.attempt > 1 && context.priorFailures.length > 0) {
    sections.push(
      [
        `PREVIOUS ATTEMPT FAILED (this is attempt ${context.attempt}) — do not repeat these:`,
        ...context.priorFailures.slice(-3).map((failure) => `- ${failure.slice(0, MAX_FAILURE_CHARS)}`),
      ].join("\n"),
    );
  }

  // What to do differently, chosen by the recovery decision from the failure
  // kind. Placed after the failures so the agent reads what went wrong first,
  // then the instruction. Absent on a plain retry: when the right move is to
  // repeat the work unchanged, inventing an instruction would be noise.
  if (context.avoidTools.length > 0) {
    sections.push(
      [
        "AVOID THESE TOOLS (they failed on an earlier attempt):",
        ...context.avoidTools.map((tool) => `- ${tool}`),
        "Use a different tool or a different calling convention.",
      ].join("\n"),
    );
  }

  if (context.recoveryDirective !== undefined && context.recoveryDirective.trim() !== "") {
    sections.push(
      ["HOW TO RECOVER:", context.recoveryDirective.slice(0, MAX_DIRECTIVE_CHARS)].join("\n"),
    );
  }

  // Said last so it is the final instruction the model reads: the outcome is
  // decided by a verifier, not by the agent's own report of success.
  sections.push(
    "HOW THIS IS JUDGED: the result is checked by an independent verifier. " +
      "Reporting success does not make the task succeed — unverifiable work is recorded as unverified. " +
      "If you cannot complete something, say so plainly instead of describing it as done.",
  );

  return sections.join("\n\n");
}

export async function runAgentViaSession(
  engine: SessionCapableEngine,
  context: TaskContext,
  options: SessionAgentOptions = {},
): Promise<AgentRunResult> {
  const timeoutMs = options.timeoutMs ?? context.budget.timeMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;

  let sessionId: string;
  try {
    const session = await engine.createSession({
      tenantId: context.tenantId,
      name: `task-${context.taskId.slice(0, 24)}`,
      ...(context.workspace ? { workspacePath: context.workspace } : {}),
      // Without this the loop could escalate the route and the session would
      // still call the failing model — a model change in the report only.
      ...(context.modelRoute !== undefined ? { modelRoute: context.modelRoute } : {}),
      ...(context.fallbackModels.length > 0 ? { fallbackModels: [...context.fallbackModels] } : {}),
    });
    sessionId = session.sessionId;
  } catch (error) {
    return {
      completed: false,
      summary: "Could not create an agent session",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  context.sessionId = sessionId;
  context.record("acting", "session.created", { sessionId });

  let commandResult: Awaited<ReturnType<SessionCapableEngine["command"]>>;
  try {
    commandResult = await engine.command({
      protocolVersion: 1,
      commandId: randomUUID(),
      clientId: options.clientId ?? "unified-execution-loop",
      tenantId: context.tenantId,
      sessionId,
      kind: "session.prompt",
      source: "api",
      issuedAt: new Date().toISOString(),
      payload: { text: buildAgentBriefing(context) },
    });
  } catch (error) {
    return {
      completed: false,
      summary: "The agent rejected the prompt",
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (commandResult.status === "rejected") {
    return {
      completed: false,
      summary: "The agent rejected the prompt",
      sessionId,
      error: commandResult.error?.message ?? "rejected",
    };
  }

  // Wait for the session to settle.
  let settled = false;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    try {
      const snapshot = await engine.session(sessionId);
      lastStatus = snapshot.status;
      if (SETTLED.has(snapshot.status)) {
        settled = true;
        break;
      }
    } catch (error) {
      return {
        completed: false,
        summary: "Lost track of the agent session while waiting",
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const events = await engine.readEvents(sessionId, 0, 1000).catch(() => [] as unknown[]);
  const failedTool = extractFailedTool(events);
  const usage = {
    ...summariseUsage(events),
    // Only set when a tool actually errored. `change_tool` must not be handed
    // the name of a tool that worked.
    ...(failedTool !== undefined ? { failedTool } : {}),
  };

  context.record("acting", "session.settled", {
    sessionId,
    status: lastStatus,
    events: events.length,
    settled,
  });

  if (!settled) {
    return {
      completed: false,
      summary: `Agent did not settle within ${timeoutMs}ms (last status: ${lastStatus}, ${events.length} events)`,
      sessionId,
      error: `timed out after ${timeoutMs}ms`,
      ...usage,
    };
  }

  if (lastStatus === "failed") {
    return {
      completed: false,
      summary: `Agent session ended in a failed state after ${events.length} events`,
      sessionId,
      error: "session failed",
      ...usage,
    };
  }

  if (lastStatus === "waiting_approval") {
    return {
      completed: false,
      summary: "Agent paused awaiting approval",
      sessionId,
      error: "blocked by policy: approval required",
      ...usage,
    };
  }

  // `paused` is a stopped agent, not a finished one. It reached the final
  // return before this guard existed, so a paused session read as completed
  // work — the loop would then verify a task nobody had worked on.
  if (lastStatus === "paused") {
    return {
      completed: false,
      summary: `Agent session is paused after ${events.length} events; it has stopped, not finished`,
      sessionId,
      error: "session paused",
      ...usage,
    };
  }

  // Settling as `idle`/`closed` means the session stopped cleanly. It does NOT
  // by itself mean the agent did anything: a session that is created and
  // immediately goes idle settles exactly the same way as one that worked for
  // ten minutes. Require evidence that the agent actually acted.
  const acted = events.some((event) => {
    const kind = String((event as { kind?: unknown }).kind ?? (event as { type?: unknown }).type ?? "");
    return (
      kind.includes("tool") ||
      kind.includes("message") ||
      kind.includes("assistant") ||
      kind.includes("completed") ||
      kind.includes("output") ||
      kind.includes("patch")
    );
  });

  if (!acted) {
    return {
      completed: false,
      summary:
        `Agent session settled as ${lastStatus} with ${events.length} event(s), but none of them show the ` +
        "agent acting (no tool call, assistant turn or output). Reporting incomplete rather than " +
        "treating a quiet session as finished work",
      sessionId,
      error: "no execution evidence in session events",
      ...usage,
    };
  }

  return {
    completed: true,
    summary: `Agent session settled as ${lastStatus} after ${events.length} events`,
    sessionId,
    ...usage,
  };
}

/**
 * Pull usage out of session events.
 *
 * Returns `undefined` for anything the events do not report. Defaulting to 0
 * would claim a measurement that was never taken, and a cost report of "$0.00"
 * is read as free rather than as unknown.
 */
/**
 * Name the tool that failed, from the session's own events.
 *
 * `summariseUsage()` already walks these events and counts `tool.` kinds, but
 * the names were discarded — so `change_tool` had a strategy and no subject.
 *
 * Returns `undefined` when no tool error is present. That matters: a tool that
 * ran fine must never be reported as the failure, and "some tool broke" is not
 * a basis for telling the agent to avoid a specific one.
 */
export function extractFailedTool(events: readonly unknown[]): string | undefined {
  let failed: string | undefined;

  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) continue;
    const event = raw as Record<string, unknown>;
    const kind = String(event["kind"] ?? event["type"] ?? "");
    if (!kind.includes("tool.")) continue;

    const payload = (event["payload"] ?? {}) as Record<string, unknown>;
    const name = payload["name"] ?? payload["tool"] ?? payload["capabilityId"];
    if (typeof name !== "string" || name.trim() === "") continue;

    const errored =
      kind.includes("error") ||
      kind.includes("failed") ||
      payload["ok"] === false ||
      payload["error"] !== undefined;

    // Last failure wins: it is the one the agent stopped on.
    if (errored) failed = name;
  }

  return failed;
}

function summariseUsage(events: readonly unknown[]): {
  toolCalls?: number | undefined;
  tokens?: number | undefined;
  costUsd?: number | undefined;
} {
  let toolCalls = 0;
  let tokens = 0;
  let costUsd = 0;
  let sawTokens = false;
  let sawCost = false;

  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) continue;
    const event = raw as Record<string, unknown>;
    const kind = String(event["kind"] ?? event["type"] ?? "");

    if (kind.includes("tool.")) toolCalls += 1;

    const payload = (event["payload"] ?? {}) as Record<string, unknown>;
    const usage = (payload["usage"] ?? payload) as Record<string, unknown>;

    const input = Number(usage["inputTokens"] ?? usage["promptTokens"] ?? 0);
    const output = Number(usage["outputTokens"] ?? usage["completionTokens"] ?? 0);
    if (Number.isFinite(input) && input > 0) {
      tokens += input;
      sawTokens = true;
    }
    if (Number.isFinite(output) && output > 0) {
      tokens += output;
      sawTokens = true;
    }

    const cost = Number(usage["costUsd"] ?? usage["cost"] ?? 0);
    if (Number.isFinite(cost) && cost > 0) {
      costUsd += cost;
      sawCost = true;
    }
  }

  return {
    toolCalls: toolCalls > 0 ? toolCalls : undefined,
    tokens: sawTokens ? tokens : undefined,
    costUsd: sawCost ? costUsd : undefined,
  };
}
