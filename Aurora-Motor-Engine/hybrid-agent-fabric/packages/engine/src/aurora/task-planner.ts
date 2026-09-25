/**
 * Task-specific planner — Aurora (B3).
 *
 * What this replaces, measured: `PlanningEngine.decomposeGoal()` is a keyword
 * skeleton. It always emits the same six-or-seven step names —
 * `Understand, [Research], [Design], [Simulate], Execute, Verify, Learn` — and
 * the goal text only toggles which of the optional three appear, via
 * substring tests like `g.includes("create")` and `g.includes("implement")`.
 * Every duration is a literal (`4000`, `10000`, `20000`) and every risk label is
 * a literal too.
 *
 * The consequence is concrete. "Create a file called hello.txt" and "Create a
 * distributed consensus system that survives a Byzantine partition" both
 * contain "create", so both get `Design`, and both get the same `Execute`
 * budget. A plan that cannot tell those two goals apart is not a plan for
 * either of them; it is a template with the goal string pasted into step one.
 *
 * So this asks the model to decompose the actual goal, and keeps the keyword
 * skeleton as an explicit fallback. Three rules make that honest rather than
 * decorative:
 *
 *  1. **The source is recorded.** `TaskPlanDraft.source` is `"model"` or
 *     `"fallback"`, with the reason. A caller can always tell whether the plan
 *     in front of it was thought about or defaulted to. The engine's own comment
 *     already warned against the opposite: "do not read a populated
 *     `context.plan` as evidence of deep planning".
 *  2. **A rejected model plan is reported, not quietly dropped.** If the model
 *     returns prose instead of a plan, names two steps the same thing, or hands
 *     back a cycle, that is recorded verbatim in `fallbackReason`. The fallback
 *     still runs — a task must never stall because planning was ambitious — but
 *     the report says why.
 *  3. **Validation is the point, not a formality.** The model is untrusted
 *     input. Dependency edges it invents, step names it repeats and cycles it
 *     draws are all refused here rather than discovered three phases later as a
 *     stalled step.
 *
 * Not in scope here, deliberately: executing the steps (B4) and checking each
 * step's `expectedOutput` (B6). This module produces and validates a plan; it
 * does not claim to have carried one out.
 */
import { randomUUID } from "node:crypto";

import type { ModelRequest, ModelStreamEvent } from "../types.js";

/** Risk label a planner may attach. Anything else is rejected, not coerced. */
export type PlannedRisk = "low" | "medium" | "high";

/** One validated step of a task plan. */
export interface PlannedTaskStep {
  readonly name: string;
  readonly description: string;
  /** Names of steps that must finish first. Never undefined after validation. */
  readonly dependencies: readonly string[];
  readonly estimatedMs: number;
  readonly risk: PlannedRisk;
  /**
   * What this step must have produced for it to count as done.
   *
   * Optional because the fallback skeleton has none and inventing one would be
   * a claim about work nobody specified. B6 is what turns a present value into
   * a check.
   */
  readonly expectedOutput?: string | undefined;
}

/** Where a plan came from. */
export type PlanSource = "model" | "fallback";

/** A validated plan plus the provenance a reader needs to judge it. */
export interface TaskPlanDraft {
  readonly steps: readonly PlannedTaskStep[];
  readonly source: PlanSource;
  /** Set whenever `source` is `"fallback"`: why the model path was not used. */
  readonly fallbackReason?: string | undefined;
  /** The route that answered, when the model was asked and answered. */
  readonly modelRoute?: string | undefined;
  readonly totalEstimatedMs: number;
}

/**
 * The slice of `ModelProvider` this planner needs.
 *
 * Typed structurally so a test can hand over a stub that yields canned JSON
 * without standing up a provider registry, and so the planner cannot reach for
 * provider internals it has no business knowing about.
 */
export interface PlanningModel {
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

/** What a plan step must satisfy. Shared by the parser and the tests. */
export interface PlanConstraints {
  /** Refuse plans longer than this; a runaway decomposition is a failure. */
  readonly maxSteps: number;
  /** Refuse plans whose budgets add up to more than this. */
  readonly maxTotalMs: number;
  /** Per-step budget ceiling, applied to anything the model claims. */
  readonly maxStepMs: number;
  /** How long to wait for the model before falling back. */
  readonly modelTimeoutMs: number;
}

export const DEFAULT_PLAN_CONSTRAINTS: PlanConstraints = {
  maxSteps: 24,
  maxTotalMs: 30 * 60_000,
  maxStepMs: 10 * 60_000,
  modelTimeoutMs: 30_000,
};

export interface TaskPlannerDeps {
  /**
   * The keyword decomposition, kept as the fallback.
   *
   * Injected rather than imported so there is exactly one implementation of it
   * (`PlanningEngine.decomposeGoal`) and so a test can supply a stub and prove
   * the fallback path without an engine.
   */
  readonly fallback: (goal: string, strategy: string) => readonly FallbackStep[];
  readonly model?: PlanningModel | undefined;
  readonly constraints?: Partial<PlanConstraints> | undefined;
}

/** The shape `decomposeGoal` returns today. */
export interface FallbackStep {
  readonly name: string;
  readonly description: string;
  readonly dependencies: readonly string[];
  readonly estimatedMs: number;
  readonly risk: PlannedRisk;
}

const SYSTEM_PROMPT = `You decompose one goal into an ordered plan.

Reply with a single JSON object and nothing else — no prose, no code fence:

{"steps":[{"name":"short unique label","description":"what to do and why",
"dependencies":["earlier step name"],"expectedOutput":"what must exist afterwards",
"estimatedMs":12000,"risk":"low|medium|high"}]}

Rules:
- Name steps after THIS goal. Do not reuse generic labels like "Execute".
- Every entry in "dependencies" must be the name of an earlier step in this list.
- No cycles. Steps that could run at the same time must not depend on each other.
- Only include steps this goal actually needs. A one-file change is one or two
  steps, not seven.
- "estimatedMs" is your real estimate for that step, not a constant.
- "expectedOutput" is what a verifier could check afterwards. Omit it if nothing
  observable follows from the step.`;

export class TaskPlanner {
  private readonly constraints: PlanConstraints;

  constructor(private readonly deps: TaskPlannerDeps) {
    this.constraints = { ...DEFAULT_PLAN_CONSTRAINTS, ...deps.constraints };
  }

  /**
   * Produce a plan for one goal.
   *
   * Never throws for a planning reason: the fallback always yields something,
   * because a task that cannot be planned should still be attempted and fail
   * visibly rather than stall in the planning phase.
   */
  async plan(request: {
    tenantId: string;
    goal: string;
    strategy?: string | undefined;
    sessionId?: string | undefined;
    modelRoute?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<TaskPlanDraft> {
    const strategy = request.strategy ?? "balanced";

    if (!this.deps.model) {
      return this.fallbackPlan(request.goal, strategy, "no model was supplied to the planner");
    }

    const asked = await this.askModel(request);
    if (!asked.ok) {
      return this.fallbackPlan(request.goal, strategy, asked.reason);
    }

    const validated = validatePlanSteps(asked.steps, this.constraints);
    if (!validated.ok) {
      return this.fallbackPlan(request.goal, strategy, `model plan rejected: ${validated.reason}`);
    }

    const steps = validated.steps;
    return {
      steps,
      source: "model",
      ...(asked.route ? { modelRoute: asked.route } : {}),
      totalEstimatedMs: steps.reduce((sum, step) => sum + step.estimatedMs, 0),
    };
  }

  private fallbackPlan(goal: string, strategy: string, reason: string): TaskPlanDraft {
    const steps: readonly PlannedTaskStep[] = this.deps.fallback(goal, strategy).map((step) => ({
      name: step.name,
      description: step.description,
      dependencies: [...step.dependencies],
      estimatedMs: step.estimatedMs,
      risk: step.risk,
    }));
    return {
      steps,
      source: "fallback",
      fallbackReason: reason,
      totalEstimatedMs: steps.reduce((sum, step) => sum + step.estimatedMs, 0),
    };
  }

  private async askModel(request: {
    tenantId: string;
    goal: string;
    sessionId?: string | undefined;
    modelRoute?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<
    | { ok: true; steps: readonly unknown[]; route?: string | undefined }
    | { ok: false; reason: string }
  > {
    const id = randomUUID();
    const timeout = AbortSignal.timeout(this.constraints.modelTimeoutMs);
    // Either signal may fire: the caller giving up, or the planner's own budget.
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;

    let text = "";
    let route: string | undefined;
    try {
      for await (const event of this.deps.model!.stream({
        tenantId: request.tenantId,
        sessionId: request.sessionId ?? `planning-${id}`,
        turnId: `planning-${id}`,
        ...(request.modelRoute ? { model: request.modelRoute } : {}),
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            id: `planning-input-${id}`,
            role: "user",
            timestamp: new Date().toISOString(),
            // The goal is untrusted text from a caller. It is data for the plan,
            // never an instruction about how to build one.
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

    const parsed = parsePlanJson(text);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    return { ok: true, steps: parsed.steps, ...(route ? { route } : {}) };
  }
}

/**
 * Pull the plan object out of whatever the model actually sent.
 *
 * Providers wrap JSON in prose, in a ```json fence, or both. Taking the first
 * balanced `{...}` run is enough for all three, and refusing anything that is
 * not an object with a `steps` array keeps the fallback honest about why it ran.
 */
export function parsePlanJson(
  text: string,
): { ok: true; steps: readonly unknown[] } | { ok: false; reason: string } {
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
        const steps = (value as { steps?: unknown }).steps;
        if (!Array.isArray(steps)) return { ok: false, reason: 'the reply had no "steps" array' };
        return { ok: true, steps };
      }
    }
  }
  return { ok: false, reason: "the reply contained an unterminated JSON object" };
}

/**
 * Validate a decomposition before anything acts on it.
 *
 * The model is untrusted. Every failure mode below has an obvious downstream
 * cost: a repeated step name makes `dependencies` ambiguous, an unknown name
 * makes a step permanently unready, and a cycle makes the whole plan
 * unexecutable in any order. Catching them here is cheap; discovering them as a
 * stalled step three phases later is not.
 */
export function validatePlanSteps(
  rawSteps: readonly unknown[],
  constraints: PlanConstraints = DEFAULT_PLAN_CONSTRAINTS,
): { ok: true; steps: readonly PlannedTaskStep[] } | { ok: false; reason: string } {
  if (rawSteps.length === 0) return { ok: false, reason: "the model returned zero steps" };
  if (rawSteps.length > constraints.maxSteps) {
    return { ok: false, reason: `the model returned ${rawSteps.length} steps (limit ${constraints.maxSteps})` };
  }

  const steps: PlannedTaskStep[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of rawSteps.entries()) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, reason: `step ${index + 1} is not an object` };
    }
    const step = raw as Record<string, unknown>;

    const name = typeof step["name"] === "string" ? step["name"].trim() : "";
    if (name === "") return { ok: false, reason: `step ${index + 1} has no name` };
    if (seen.has(name)) return { ok: false, reason: `step name "${name}" appears twice` };
    seen.add(name);

    const description = typeof step["description"] === "string" ? step["description"].trim() : "";
    if (description === "") return { ok: false, reason: `step "${name}" has no description` };

    const rawDeps = step["dependencies"];
    const dependencies: string[] = [];
    if (rawDeps !== undefined && rawDeps !== null) {
      if (!Array.isArray(rawDeps)) {
        return { ok: false, reason: `step "${name}" has a "dependencies" value that is not a list` };
      }
      for (const dependency of rawDeps) {
        if (typeof dependency !== "string") {
          return { ok: false, reason: `step "${name}" depends on something that is not a step name` };
        }
        dependencies.push(dependency);
      }
    }

    const risk = step["risk"];
    if (risk !== "low" && risk !== "medium" && risk !== "high") {
      return { ok: false, reason: `step "${name}" has risk ${JSON.stringify(risk) ?? "nothing"}, not low/medium/high` };
    }

    const rawMs = step["estimatedMs"];
    const estimatedMs = typeof rawMs === "number" && Number.isFinite(rawMs) && rawMs > 0 ? rawMs : 0;
    if (estimatedMs > constraints.maxStepMs) {
      return {
        ok: false,
        reason: `step "${name}" estimates ${estimatedMs}ms, over the ${constraints.maxStepMs}ms per-step limit`,
      };
    }

    const expectedOutput =
      typeof step["expectedOutput"] === "string" && step["expectedOutput"].trim() !== ""
        ? step["expectedOutput"].trim()
        : undefined;

    steps.push({
      name,
      description,
      dependencies,
      estimatedMs,
      risk,
      ...(expectedOutput ? { expectedOutput } : {}),
    });
  }

  // Dependencies must name steps that exist, and must point backwards: a step
  // depending on a later one is a cycle in all but the strangest reading.
  for (const [index, step] of steps.entries()) {
    for (const dependency of step.dependencies) {
      if (dependency === step.name) {
        return { ok: false, reason: `step "${step.name}" depends on itself` };
      }
      const at = steps.findIndex((candidate) => candidate.name === dependency);
      if (at === -1) {
        return { ok: false, reason: `step "${step.name}" depends on unknown step "${dependency}"` };
      }
      if (at > index) {
        return { ok: false, reason: `step "${step.name}" depends on later step "${dependency}"` };
      }
    }
  }

  const total = steps.reduce((sum, step) => sum + step.estimatedMs, 0);
  if (total > constraints.maxTotalMs) {
    return { ok: false, reason: `the plan totals ${total}ms, over the ${constraints.maxTotalMs}ms budget` };
  }

  return { ok: true, steps };
}

/**
 * Which steps could run at the same time.
 *
 * Returned as waves in dependency order: everything in wave N depends only on
 * waves before it. This is what makes "parallelisable" a measured property of
 * the plan rather than an adjective in the roadmap — a plan whose every step
 * depends on the one before it has one step per wave and no parallelism to claim.
 */
export function parallelWaves(steps: readonly PlannedTaskStep[]): string[][] {
  const done = new Set<string>();
  const waves: string[][] = [];
  let remaining = [...steps];

  while (remaining.length > 0) {
    const ready = remaining.filter((step) => step.dependencies.every((d) => done.has(d)));
    if (ready.length === 0) break; // Unreachable with validated input; never loop forever.
    waves.push(ready.map((step) => step.name));
    for (const step of ready) done.add(step.name);
    remaining = remaining.filter((step) => !done.has(step.name));
  }
  return waves;
}
