/**
 * B2 (P1.2): model-backed goal understanding.
 *
 * What existed before: nothing. The goal arrived as a string and went straight
 * into planning and execution. Constraints were only what the caller happened
 * to pass; deadlines, expected artifacts and success criteria lived nowhere
 * unless a human encoded them by hand; a task built on a critical unknown
 * ("migrate the database" — which database?) ran anyway and failed at runtime,
 * spending the whole attempt budget to discover a question it could have asked
 * at the start.
 *
 * The shape follows the task planner (B3) deliberately: the model is asked
 * first and its reply is validated like the untrusted text it is; the fallback
 * is honest — it extracts nothing and says so — and the result always records
 * which one ran.
 *
 * The split that matters: **the model extracts, the code decides.** Ambiguity
 * thresholds and the ask/think/research policy live here, in code, because a
 * policy a model can talk its way around is not a policy.
 */
import { randomUUID } from "node:crypto";

import type { ModelRequest, ModelStreamEvent } from "../types.js";
import type { GoalUnderstanding, MissingInformation } from "../execution/task-context.js";

/**
 * The slice of `ModelProvider` this service needs.
 *
 * Typed structurally so a test can hand over a stub that yields canned JSON
 * without standing up a provider registry.
 */
export interface UnderstandingModel {
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

/** What an understanding reply must satisfy. Shared by the validator and the tests. */
export interface UnderstandingConstraints {
  /** Refuse restated goals longer than this. */
  readonly maxGoalLength: number;
  /** Per-list item ceiling, applied to every extracted list. */
  readonly maxItems: number;
  readonly maxItemLength: number;
  /** Refuse more clarifying questions than a human will read. */
  readonly maxQuestions: number;
  /** Ambiguity at or above this means "do not act yet" (P1.2). */
  readonly ambiguityThreshold: number;
  /** How long to wait for the model before falling back. */
  readonly modelTimeoutMs: number;
}

export const DEFAULT_UNDERSTANDING_CONSTRAINTS: UnderstandingConstraints = {
  maxGoalLength: 2000,
  maxItems: 16,
  maxItemLength: 500,
  maxQuestions: 5,
  ambiguityThreshold: 0.7,
  modelTimeoutMs: 30_000,
};

const SYSTEM_PROMPT = `You extract what a task actually requires before any work starts.

Read the goal and reply with ONE JSON object and nothing else:

{
  "goal": "the user's actual goal, restated in one plain sentence",
  "constraints": ["hard requirements the work must satisfy"],
  "preferences": ["soft preferences - how the user would like it done"],
  "risks": ["what could go wrong if this is attempted as stated"],
  "deadline": "ISO 8601 instant the work must be finished by, or null",
  "expectedArtifact": "what must exist afterwards (a file, a report, a deployed service), or null",
  "successCriteria": ["how "done" will be judged, as checkable statements"],
  "missingInformation": [{"what": "a specific unknown", "critical": true, "whoCanAnswer": "user"|"system"}],
  "ambiguity": 0.0,
  "clarifyingQuestions": ["questions to ask only if critical information is missing"]
}

Rules:
- Extract only what the goal text or the supplied context actually supports. Never invent a deadline, artifact or criterion.
- "critical" means the work cannot proceed sensibly without it. Preferences are not critical.
- "whoCanAnswer": "user" if only the requester can answer (credentials, intent, taste); "system" if the answer can be found by inspecting the environment (which version is deployed, what a file contains).
- "ambiguity" is 0..1: 0 = the goal states exactly what success is; 1 = the goal could mean several unrelated things.
- Ask no question you can answer yourself by reading the environment.
- Reply with the JSON object only.`;

/** What the validator produces: the extraction, with every field bounded. */
export interface ValidatedUnderstanding {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly preferences: readonly string[];
  readonly risks: readonly string[];
  readonly deadline?: string | undefined;
  readonly expectedArtifact?: string | undefined;
  readonly successCriteria: readonly string[];
  readonly missingInformation: readonly MissingInformation[];
  readonly ambiguity: number;
  readonly clarifyingQuestions: readonly string[];
}

/**
 * Validate the model's reply.
 *
 * The model is untrusted. Every bound below has a downstream cost: a deadline
 * that does not parse becomes a lie the report repeats; an ambiguity outside
 * 0..1 breaks the threshold comparison; a "critical" flag that is not a boolean
 * turns the ask-policy into whatever truthiness coercion produces.
 */
export function validateUnderstanding(
  raw: unknown,
  constraints: UnderstandingConstraints = DEFAULT_UNDERSTANDING_CONSTRAINTS,
): { ok: true; value: ValidatedUnderstanding } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "the reply was not a JSON object" };
  }
  const record = raw as Record<string, unknown>;

  const goal = record.goal;
  if (typeof goal !== "string" || goal.trim() === "") {
    return { ok: false, reason: "the reply had no goal string" };
  }
  if (goal.length > constraints.maxGoalLength) {
    return { ok: false, reason: `the restated goal exceeded ${constraints.maxGoalLength} characters` };
  }

  const strings = (key: string): { ok: true; items: string[] } | { ok: false; reason: string } => {
    const value = record[key];
    if (value === undefined) return { ok: true, items: [] };
    if (!Array.isArray(value)) return { ok: false, reason: `"${key}" was not an array` };
    if (value.length > constraints.maxItems) {
      return { ok: false, reason: `"${key}" had more than ${constraints.maxItems} item(s)` };
    }
    const items: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || item.trim() === "") {
        return { ok: false, reason: `"${key}" contained a non-string or empty item` };
      }
      if (item.length > constraints.maxItemLength) {
        return { ok: false, reason: `"${key}" contained an item longer than ${constraints.maxItemLength} characters` };
      }
      items.push(item);
    }
    return { ok: true, items };
  };

  const constraintsOut = strings("constraints");
  if (!constraintsOut.ok) return constraintsOut;
  const preferences = strings("preferences");
  if (!preferences.ok) return preferences;
  const risks = strings("risks");
  if (!risks.ok) return risks;
  const successCriteria = strings("successCriteria");
  if (!successCriteria.ok) return successCriteria;
  const questions = strings("clarifyingQuestions");
  if (!questions.ok) return questions;
  if (questions.items.length > constraints.maxQuestions) {
    return { ok: false, reason: `more than ${constraints.maxQuestions} clarifying question(s)` };
  }

  let deadline: string | undefined;
  if (record.deadline !== undefined && record.deadline !== null) {
    if (typeof record.deadline !== "string") {
      return { ok: false, reason: '"deadline" was neither a string nor null' };
    }
    const parsed = Date.parse(record.deadline);
    if (Number.isNaN(parsed)) {
      return { ok: false, reason: '"deadline" was not a parseable instant' };
    }
    deadline = new Date(parsed).toISOString();
  }

  let expectedArtifact: string | undefined;
  if (record.expectedArtifact !== undefined && record.expectedArtifact !== null) {
    if (typeof record.expectedArtifact !== "string" || record.expectedArtifact.trim() === "") {
      return { ok: false, reason: '"expectedArtifact" was neither a non-empty string nor null' };
    }
    if (record.expectedArtifact.length > constraints.maxItemLength) {
      return { ok: false, reason: '"expectedArtifact" exceeded the length ceiling' };
    }
    expectedArtifact = record.expectedArtifact;
  }

  const missingRaw = record.missingInformation;
  const missing: MissingInformation[] = [];
  if (missingRaw !== undefined) {
    if (!Array.isArray(missingRaw)) {
      return { ok: false, reason: '"missingInformation" was not an array' };
    }
    if (missingRaw.length > constraints.maxItems) {
      return { ok: false, reason: `"missingInformation" had more than ${constraints.maxItems} item(s)` };
    }
    for (const item of missingRaw) {
      if (typeof item !== "object" || item === null) {
        return { ok: false, reason: '"missingInformation" contained a non-object item' };
      }
      const entry = item as Record<string, unknown>;
      if (typeof entry.what !== "string" || entry.what.trim() === "") {
        return { ok: false, reason: 'a "missingInformation" item had no "what" string' };
      }
      if (entry.what.length > constraints.maxItemLength) {
        return { ok: false, reason: 'a "missingInformation" item exceeded the length ceiling' };
      }
      // Absent defaults to false: an unclassified unknown must not stop the
      // task, because "critical" is the branch that halts work.
      const critical = entry.critical === undefined ? false : entry.critical;
      if (typeof critical !== "boolean") {
        return { ok: false, reason: 'a "missingInformation" item had a non-boolean "critical"' };
      }
      // Absent defaults to "user": when the answer's owner is unknown, asking
      // beats charging ahead, and a wrong "user" costs one round trip while a
      // wrong "system" costs the whole attempt.
      const who = entry.whoCanAnswer === undefined ? "user" : entry.whoCanAnswer;
      if (who !== "user" && who !== "system") {
        return { ok: false, reason: 'a "missingInformation" item had a "whoCanAnswer" other than "user"|"system"' };
      }
      missing.push({ what: entry.what, critical, whoCanAnswer: who });
    }
  }

  let ambiguity = 0;
  if (record.ambiguity !== undefined) {
    if (typeof record.ambiguity !== "number" || !Number.isFinite(record.ambiguity)) {
      return { ok: false, reason: '"ambiguity" was not a finite number' };
    }
    if (record.ambiguity < 0 || record.ambiguity > 1) {
      return { ok: false, reason: '"ambiguity" was outside 0..1' };
    }
    ambiguity = record.ambiguity;
  }

  return {
    ok: true,
    value: {
      goal: goal.trim(),
      constraints: constraintsOut.items,
      preferences: preferences.items,
      risks: risks.items,
      ...(deadline !== undefined ? { deadline } : {}),
      ...(expectedArtifact !== undefined ? { expectedArtifact } : {}),
      successCriteria: successCriteria.items,
      missingInformation: missing,
      ambiguity,
      clarifyingQuestions: questions.items,
    },
  };
}

/**
 * The ask/think/research/act policy (P1.2), in code.
 *
 * Deterministic on purpose: the model extracts facts, and this decides what
 * they mean for the next move. A model that could set its own policy could
 * talk itself into "act".
 *
 *   - a critical unknown only the user can answer → **ask**: running anyway
 *     spends the attempt budget discovering a question.
 *   - a critical unknown the system can answer → **research**: the information
 *     exists, it just has not been gathered yet.
 *   - ambiguity at or above the threshold → **think**: the goal could mean
 *     several things and acting picks one silently.
 *   - otherwise → **act**.
 *
 * Questions are derived from the critical user-answerable unknowns when the
 * model supplied none: "critical but no question" must not silently degrade to
 * "act".
 */
export function recommendAction(
  extraction: ValidatedUnderstanding,
  constraints: UnderstandingConstraints = DEFAULT_UNDERSTANDING_CONSTRAINTS,
): {
  recommendation: "act" | "ask" | "think" | "research";
  questions: readonly string[];
} {
  const criticalUser = extraction.missingInformation.filter(
    (item) => item.critical && item.whoCanAnswer === "user",
  );
  const criticalSystem = extraction.missingInformation.filter(
    (item) => item.critical && item.whoCanAnswer === "system",
  );

  if (criticalUser.length > 0) {
    const questions =
      extraction.clarifyingQuestions.length > 0
        ? extraction.clarifyingQuestions.slice(0, constraints.maxQuestions)
        : criticalUser.map((item) => `Please specify: ${item.what}`);
    return { recommendation: "ask", questions };
  }
  if (criticalSystem.length > 0) {
    return { recommendation: "research", questions: [] };
  }
  if (extraction.ambiguity >= constraints.ambiguityThreshold) {
    return { recommendation: "think", questions: [] };
  }
  return { recommendation: "act", questions: [] };
}

/**
 * Pull the understanding object out of whatever the model actually sent.
 *
 * Providers wrap JSON in prose or a fence; taking the first balanced `{...}`
 * run that is an object with a `goal` string covers both.
 */
export function parseUnderstandingJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const start = text.indexOf("{");
  if (start === -1) return { ok: false, reason: "the reply contained no JSON object" };

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, index + 1);
        let value: unknown;
        try {
          value = JSON.parse(candidate);
        } catch {
          return { ok: false, reason: "the reply contained malformed JSON" };
        }
        if (
          typeof (value as { goal?: unknown }).goal !== "string" ||
          ((value as { goal?: unknown }).goal as string).trim() === ""
        ) {
          return { ok: false, reason: 'the reply had no "goal" string' };
        }
        return { ok: true, value };
      }
    }
  }
  return { ok: false, reason: "the reply contained an unterminated JSON object" };
}

/**
 * The goal-understanding service.
 *
 * Never throws for an understanding reason: the fallback always yields
 * something, because a task that cannot be understood should still be
 * attempted on its text — visibly labelled as un-understood — rather than
 * stall before starting.
 */
export class GoalUnderstandingService {
  constructor(
    private readonly deps: {
      model?: UnderstandingModel | undefined;
      modelRoute?: string | undefined;
    },
    private readonly constraints: UnderstandingConstraints = DEFAULT_UNDERSTANDING_CONSTRAINTS,
  ) {}

  async understand(request: {
    tenantId: string;
    goal: string;
    sessionId?: string | undefined;
    modelRoute?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<GoalUnderstanding> {
    if (!this.deps.model) {
      return this.fallback(request.goal, "no model was supplied to goal understanding");
    }

    const asked = await this.askModel(request);
    if (!asked.ok) {
      return this.fallback(request.goal, asked.reason);
    }

    const validated = validateUnderstanding(asked.value, this.constraints);
    if (!validated.ok) {
      return this.fallback(request.goal, `model understanding rejected: ${validated.reason}`);
    }

    const policy = recommendAction(validated.value, this.constraints);
    return {
      ...validated.value,
      clarifyingQuestions: policy.questions,
      recommendation: policy.recommendation,
      source: "model",
      ...(asked.route ? { modelRoute: asked.route } : {}),
    };
  }

  /**
   * The honest fallback: the goal text, and nothing claimed about it.
   *
   * No invented constraints, no guessed ambiguity, and the recommendation is
   * "act" — which is exactly what the system did before understanding
   * existed, now labelled as such instead of passed off as understanding.
   */
  private fallback(goal: string, reason: string): GoalUnderstanding {
    return {
      goal,
      constraints: [],
      preferences: [],
      risks: [],
      successCriteria: [],
      missingInformation: [],
      ambiguity: 0,
      clarifyingQuestions: [],
      recommendation: "act",
      source: "fallback",
      fallbackReason: reason,
    };
  }

  private async askModel(request: {
    tenantId: string;
    goal: string;
    sessionId?: string | undefined;
    modelRoute?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<{ ok: true; value: unknown; route?: string | undefined } | { ok: false; reason: string }> {
    const id = randomUUID();
    const timeout = AbortSignal.timeout(this.constraints.modelTimeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;

    let text = "";
    let route: string | undefined;
    try {
      for await (const event of this.deps.model!.stream({
        tenantId: request.tenantId,
        sessionId: request.sessionId ?? `understanding-${id}`,
        turnId: `understanding-${id}`,
        ...(request.modelRoute ? { model: request.modelRoute } : {}),
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            id: `understanding-input-${id}`,
            role: "user",
            timestamp: new Date().toISOString(),
            // The goal is untrusted text from a caller. It is data to be
            // understood, never an instruction about how to understand it.
            content: [{ type: "text", text: `Goal:\n${request.goal}` }],
          },
        ],
        tools: [],
        signal,
      })) {
        if (event.type === "text_delta") text += event.delta;
        else if (event.type === "route_selected") route = `${event.provider}:${event.model}`;
      }
    } catch (error) {
      return {
        ok: false,
        reason: `the model call failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (text.trim() === "") return { ok: false, reason: "the model returned no text" };

    const parsed = parseUnderstandingJson(text);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    return { ok: true, value: parsed.value, ...(route ? { route } : {}) };
  }
}
