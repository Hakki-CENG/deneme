import type { EventEnvelope, JsonValue } from "../types.js";
import type { EventStore } from "../persistence/event-store.js";
import { auroraDigest, auroraInteger, auroraRound } from "../util/aurora-state.js";

/**
 * Stuck-pattern taxonomy (OpenHands-derived, extended for Aurora):
 * - `repeated-action`: the same capability is invoked with the same arguments over and over
 * - `repeated-error`: the same failure keeps coming back
 * - `alternating-loop`: two actions ping-pong without progress
 * - `monologue`: the agent keeps talking without acting
 * - `identical-output`: assistant output repeats verbatim
 * - `approval-starvation`: work is blocked on approvals nobody answers
 * - `tool-iteration-guardrail`: the runtime already tripped its tool-loop guard
 */
export type StuckPatternCode =
  | "repeated-action" | "repeated-error" | "alternating-loop" | "monologue"
  | "identical-output" | "approval-starvation" | "tool-iteration-guardrail";

export interface StuckPattern {
  code: StuckPatternCode;
  severity: "info" | "warning" | "critical";
  occurrences: number;
  detail: string;
  recommendation: string;
  evidenceEventIds: string[];
}

export interface StuckReport {
  sessionId: string;
  analyzedEvents: number;
  windowSize: number;
  stuck: boolean;
  confidence: number;
  patterns: StuckPattern[];
  frictionSignature?: string;
  generatedAt: string;
}

export interface StuckDetectorOptions {
  /** How many trailing events to inspect. */
  windowSize?: number;
  /** Identical action repetitions before the pattern is reported. */
  repeatThreshold?: number;
  /** Consecutive assistant messages without any capability call before a monologue is reported. */
  monologueThreshold?: number;
}

interface CapabilityPayload {
  capabilityId?: string;
  toolCallId?: string;
  status?: string | null;
  error?: string | null;
  decision?: string | null;
}

/**
 * Pure stuck analysis over a session's event window.
 *
 * This is deliberately model-free: repetition, oscillation and silence are structural properties of
 * the event log, so detection stays cheap, deterministic and testable. Aurora feeds the result into
 * cognitive health (Phase B) and capability-gap detection (Phase F).
 */
export function analyzeStuck(sessionId: string, events: EventEnvelope[], options: StuckDetectorOptions = {}): StuckReport {
  const windowSize = auroraInteger(options.windowSize ?? 40, 4, 500, "Stuck window");
  const repeatThreshold = auroraInteger(options.repeatThreshold ?? 3, 2, 50, "Stuck repeat threshold");
  const monologueThreshold = auroraInteger(options.monologueThreshold ?? 4, 2, 50, "Monologue threshold");
  const window = events.slice(-windowSize);
  const patterns: StuckPattern[] = [];

  const actionSignatures: Array<{ signature: string; eventId: string; capabilityId: string }> = [];
  const errorSignatures: Array<{ signature: string; eventId: string; capabilityId: string; error: string }> = [];
  const assistantDigests: Array<{ digest: string; eventId: string }> = [];
  let consecutiveAssistantMessages = 0;
  let maxConsecutiveAssistant = 0;
  const monologueEvidence: string[] = [];
  const approvalEvidence: string[] = [];
  const guardrailEvidence: string[] = [];

  for (const event of window) {
    if (event.type.startsWith("capability.")) {
      const payload = event.payload as CapabilityPayload;
      const capabilityId = typeof payload?.capabilityId === "string" ? payload.capabilityId : "unknown";
      if (event.type === "capability.started") {
        actionSignatures.push({ signature: `${capabilityId}:${payload.toolCallId ? "" : ""}`, eventId: event.eventId, capabilityId });
        consecutiveAssistantMessages = 0;
      }
      if (event.type === "capability.finished") {
        const error = typeof payload?.error === "string" ? payload.error : payload?.status === "failed" ? "failed" : "";
        if (error) errorSignatures.push({ signature: `${capabilityId}:${normalizeError(error)}`, eventId: event.eventId, capabilityId, error: normalizeError(error) });
        consecutiveAssistantMessages = 0;
      }
      if (event.type === "capability.approval") approvalEvidence.push(event.eventId);
      continue;
    }
    if (event.type === "guardrail.tool_loop_limit") {
      guardrailEvidence.push(event.eventId);
      continue;
    }
    if (event.type === "message.created") {
      const role = messageRole(event.payload);
      if (role === "assistant") {
        consecutiveAssistantMessages++;
        maxConsecutiveAssistant = Math.max(maxConsecutiveAssistant, consecutiveAssistantMessages);
        if (consecutiveAssistantMessages >= 2) monologueEvidence.push(event.eventId);
        assistantDigests.push({ digest: auroraDigest(messageText(event.payload)), eventId: event.eventId });
      } else {
        consecutiveAssistantMessages = 0;
      }
    }
  }

  const repeatedActions = groupBy(actionSignatures, (item) => item.signature);
  for (const [, group] of repeatedActions) {
    if (group.length < repeatThreshold) continue;
    patterns.push({
      code: "repeated-action",
      severity: group.length >= repeatThreshold * 2 ? "critical" : "warning",
      occurrences: group.length,
      detail: `Capability ${group[0]!.capabilityId} was invoked ${group.length} times inside the last ${window.length} events.`,
      recommendation: "Change approach, decompose the task or ask for the missing information instead of retrying the same call.",
      evidenceEventIds: group.slice(0, 20).map((item) => item.eventId),
    });
  }

  const repeatedErrors = groupBy(errorSignatures, (item) => item.signature);
  for (const [, group] of repeatedErrors) {
    if (group.length < 2) continue;
    patterns.push({
      code: "repeated-error",
      severity: group.length >= repeatThreshold ? "critical" : "warning",
      occurrences: group.length,
      detail: `Capability ${group[0]!.capabilityId} failed ${group.length} times with the same error class (${group[0]!.error}).`,
      recommendation: "Treat the failure as a capability gap: inspect the precondition, or record a friction observation for skill evolution.",
      evidenceEventIds: group.slice(0, 20).map((item) => item.eventId),
    });
  }

  const alternating = detectAlternating(actionSignatures.map((item) => item.capabilityId));
  if (alternating) {
    patterns.push({
      code: "alternating-loop",
      severity: "warning",
      occurrences: alternating.cycles,
      detail: `Capabilities ${alternating.left} and ${alternating.right} alternated ${alternating.cycles} times without another action between them.`,
      recommendation: "Break the oscillation: record what each call proved and pick a different strategy.",
      evidenceEventIds: actionSignatures.slice(-8).map((item) => item.eventId),
    });
  }

  if (maxConsecutiveAssistant >= monologueThreshold) {
    patterns.push({
      code: "monologue",
      severity: "warning",
      occurrences: maxConsecutiveAssistant,
      detail: `${maxConsecutiveAssistant} consecutive assistant messages without any capability call.`,
      recommendation: "Either act, ask the user a concrete question, or stop the turn.",
      evidenceEventIds: monologueEvidence.slice(0, 20),
    });
  }

  const repeatedOutputs = groupBy(assistantDigests, (item) => item.digest);
  for (const [, group] of repeatedOutputs) {
    if (group.length < 2) continue;
    patterns.push({
      code: "identical-output",
      severity: group.length >= repeatThreshold ? "critical" : "info",
      occurrences: group.length,
      detail: `The assistant produced byte-identical output ${group.length} times.`,
      recommendation: "The model is not making progress; compact context, change model route or escalate to the user.",
      evidenceEventIds: group.slice(0, 20).map((item) => item.eventId),
    });
  }

  if (approvalEvidence.length >= repeatThreshold) {
    patterns.push({
      code: "approval-starvation",
      severity: "warning",
      occurrences: approvalEvidence.length,
      detail: `${approvalEvidence.length} approval requests appeared in the window.`,
      recommendation: "Batch the requests, narrow the authority needed, or notify the user that work is blocked.",
      evidenceEventIds: approvalEvidence.slice(0, 20),
    });
  }

  if (guardrailEvidence.length) {
    patterns.push({
      code: "tool-iteration-guardrail",
      severity: "critical",
      occurrences: guardrailEvidence.length,
      detail: "The runtime tool-iteration guardrail already fired in this window.",
      recommendation: "Stop the loop and re-plan; the runtime has already had to intervene.",
      evidenceEventIds: guardrailEvidence.slice(0, 20),
    });
  }

  const weights: Record<StuckPattern["severity"], number> = { info: 0.1, warning: 0.3, critical: 0.5 };
  const confidence = auroraRound(Math.min(1, patterns.reduce((sum, item) => sum + weights[item.severity], 0)));
  const dominant = [...patterns].sort((a, b) => weights[b.severity] - weights[a.severity] || b.occurrences - a.occurrences)[0];
  return {
    sessionId,
    analyzedEvents: window.length,
    windowSize,
    stuck: patterns.some((item) => item.severity !== "info"),
    confidence,
    patterns,
    ...(dominant ? { frictionSignature: auroraDigest(`${dominant.code}:${dominant.detail}`) } : {}),
    generatedAt: new Date().toISOString(),
  };
}

/** Reads a session's recent events and analyzes them for stuck patterns. */
export class StuckDetectorService {
  constructor(private readonly events: EventStore, private readonly now: () => number = Date.now) {}

  async analyze(sessionId: string, options: StuckDetectorOptions = {}): Promise<StuckReport> {
    const windowSize = auroraInteger(options.windowSize ?? 40, 4, 500, "Stuck window");
    const events = await this.events.read(sessionId, 0, Math.max(windowSize * 4, 200));
    const report = analyzeStuck(sessionId, events, options);
    return { ...report, generatedAt: new Date(this.now()).toISOString() };
  }
}

function messageRole(payload: JsonValue): string {
  const message = (payload as { message?: { role?: string } } | undefined)?.message;
  return typeof message?.role === "string" ? message.role : "";
}

function messageText(payload: JsonValue): string {
  const message = (payload as { message?: { content?: Array<{ type?: string; text?: string }> } } | undefined)?.message;
  if (!message?.content || !Array.isArray(message.content)) return "";
  return message.content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n").trim();
}

function normalizeError(error: string): string {
  return error.toLowerCase().replace(/[0-9a-f]{8,}/g, "<id>").replace(/\d+/g, "<n>").slice(0, 160);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

function detectAlternating(sequence: string[]): { left: string; right: string; cycles: number } | undefined {
  if (sequence.length < 4) return undefined;
  const tail = sequence.slice(-8);
  let best: { left: string; right: string; cycles: number } | undefined;
  for (let index = 0; index + 3 < tail.length; index++) {
    const [a, b, c, d] = [tail[index]!, tail[index + 1]!, tail[index + 2]!, tail[index + 3]!];
    if (a === c && b === d && a !== b) {
      let cycles = 2;
      let cursor = index + 4;
      while (cursor + 1 < tail.length && tail[cursor] === a && tail[cursor + 1] === b) {
        cycles++;
        cursor += 2;
      }
      if (!best || cycles > best.cycles) best = { left: a, right: b, cycles };
    }
  }
  return best;
}
