/**
 * P0-7: the recovery half of "failure taxonomy + recovery loop".
 *
 * Classification already works: 11 failure kinds, matched by pattern, each
 * mapped to one of 11 recovery strategies. What was measured missing is the
 * second half — the loop reads `canContinue` and nothing else, so every
 * continuable strategy does the identical thing: run the same agent, with the
 * same input, and hope.
 *
 * Concretely, before this file:
 *   - `retry_with_backoff` never waited (no timer anywhere in the loop)
 *   - `replan` did not replan
 *   - `reduce_scope` did not reduce anything
 *   - `change_model` / `change_tool` changed nothing
 *
 * A strategy name that promises an action the code does not take is the same
 * class of dishonesty as a fabricated success: the report says "recovering by
 * reducing scope" while the system repeats itself verbatim.
 *
 * These tests pin the behaviour each strategy is supposed to produce.
 */
import { describe, expect, it, vi } from "vitest";
import { UnifiedExecutionLoop } from "../src/execution/unified-execution-loop.js";
import { chooseRecovery, classifyFailure } from "../src/execution/failure-taxonomy.js";

describe("recovery strategies are distinguishable, not just labels", () => {
  it("retry_with_backoff actually delays before the next attempt", async () => {
    vi.useFakeTimers();
    try {
      const startedAt: number[] = [];
      let call = 0;

      const loop = new UnifiedExecutionLoop(
        {
          runAgent: async () => {
            startedAt.push(Date.now());
            call += 1;
            // ECONNREFUSED classifies as environment_failure → retry_with_backoff.
            // ("rate limit" is resource_failure → abort, which is correct:
            // waiting does not restore an exhausted quota.)
            return call < 3
              ? { completed: false, summary: "connection refused", error: "ECONNREFUSED 127.0.0.1:5432" }
              : { completed: true, summary: "ok" };
          },
        },
        { maxAttempts: 3 },
      );

      const run = loop.run({ tenantId: "t", goal: "Call the API" });
      await vi.runAllTimersAsync();
      await run;

      expect(startedAt).toHaveLength(3);
      // Each gap must be non-zero and growing — that is what "backoff" means.
      const firstGap = startedAt[1]! - startedAt[0]!;
      const secondGap = startedAt[2]! - startedAt[1]!;
      expect(firstGap).toBeGreaterThan(0);
      expect(secondGap).toBeGreaterThan(firstGap);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a plain retry does not sleep", async () => {
    // Backoff is for environment failures. A plain execution failure should
    // retry immediately; adding a delay everywhere would just be slower.
    const classification = classifyFailure("npm run build: exit code 1", {
      attemptCount: 1,
      phase: "executing",
    });
    const recovery = chooseRecovery(classification, {
      attemptsUsed: 1,
      maxAttempts: 3,
      budgetExceeded: false,
    });

    expect(recovery.strategy).toBe("retry");
    expect(recovery.backoffMs ?? 0).toBe(0);
  });

  it("environment failures carry a growing backoff", () => {
    const classification = classifyFailure("ECONNREFUSED 127.0.0.1:5432", {
      attemptCount: 2,
      phase: "executing",
    });
    const first = chooseRecovery(classification, {
      attemptsUsed: 1,
      maxAttempts: 3,
      budgetExceeded: false,
    });
    const later = chooseRecovery(classification, {
      attemptsUsed: 2,
      maxAttempts: 3,
      budgetExceeded: false,
    });

    expect(first.strategy).toBe("retry_with_backoff");
    expect(first.backoffMs).toBeGreaterThan(0);
    expect(later.backoffMs).toBeGreaterThan(first.backoffMs!);
  });

  it("replan tells the next attempt to plan differently", async () => {
    const briefings: string[] = [];
    let call = 0;

    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async (context) => {
          call += 1;
          briefings.push(context.recoveryDirective ?? "");
          return call === 1
            ? { completed: false, summary: "bad plan", error: "plan was incoherent" }
            : { completed: true, summary: "ok" };
        },
      },
      { maxAttempts: 2 },
    );

    await loop.run({ tenantId: "t", goal: "Ship the feature" });

    expect(call).toBe(2);
    // The retry must know it is meant to change approach, not repeat itself.
    expect(briefings[0]).toBe("");
    expect(briefings[1]).toMatch(/different approach|replan/i);
  });

  it("reduce_scope tells the next attempt to narrow the goal", async () => {
    const directives: string[] = [];
    let call = 0;

    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async (context) => {
          call += 1;
          directives.push(context.recoveryDirective ?? "");
          return call === 1
            ? { completed: false, summary: "timeout", error: "operation timed out after 30s" }
            : { completed: true, summary: "ok" };
        },
      },
      { maxAttempts: 2 },
    );

    await loop.run({ tenantId: "t", goal: "Migrate the whole database" });

    expect(call).toBe(2);
    expect(directives[1]).toMatch(/smaller|narrow|reduce/i);
  });

  it("the directive reaches the agent's briefing, not just the context", async () => {
    const { buildAgentBriefing } = await import("../src/execution/session-agent-adapter.js");
    const { TaskContext } = await import("../src/execution/task-context.js");

    const context = new TaskContext({ tenantId: "t", goal: "Ship the feature" });
    context.attempt = 2;
    context.priorFailures.push("plan was incoherent");
    context.recoveryDirective = "Try a different approach: the previous plan did not work.";

    const briefing = buildAgentBriefing(context);
    expect(briefing).toContain("different approach");
  });

  it("no directive is emitted on the first attempt", async () => {
    const { buildAgentBriefing } = await import("../src/execution/session-agent-adapter.js");
    const { TaskContext } = await import("../src/execution/task-context.js");

    const context = new TaskContext({ tenantId: "t", goal: "Ship the feature" });
    const briefing = buildAgentBriefing(context);

    // Nothing has failed yet, so there is nothing to change.
    expect(briefing).not.toMatch(/different approach/i);
    expect(briefing).not.toMatch(/RECOVERY/i);
  });
});
