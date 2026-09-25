/**
 * Closing the last honest gap in P0-7: `change_tool`.
 *
 * `change_model` now moves the route. `change_tool` still only produced
 * advice — the strategy name promised a tool change that never happened.
 *
 * The blocker was information, not plumbing: `AgentRunResult` carried
 * `toolCalls` (a count) but never *which* tool failed, so there was nothing to
 * change away from. The session events already contain the tool names; they
 * were being counted and thrown away.
 *
 * Design constraint that shapes these tests: when the failing tool cannot be
 * identified, the loop must say so rather than "changing" to an arbitrary
 * tool. An unidentified tool change is a fabricated recovery.
 */
import { describe, expect, it } from "vitest";
import { UnifiedExecutionLoop } from "../src/execution/unified-execution-loop.js";
import { TaskContext } from "../src/execution/task-context.js";
import { buildAgentBriefing } from "../src/execution/session-agent-adapter.js";

describe("change_tool avoids the tool that actually failed", () => {
  it("names the failing tool in the next attempt's briefing", async () => {
    const briefings: string[] = [];
    let call = 0;

    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async (context) => {
          call += 1;
          briefings.push(buildAgentBriefing(context));
          // "is not a function" → interface_gap → change_tool.
          return call === 1
            ? {
                completed: false,
                summary: "tool misuse",
                error: "browser.screenshot is not a function",
                failedTool: "browser.screenshot",
              }
            : { completed: true, summary: "ok" };
        },
      },
      { maxAttempts: 2 },
    );

    await loop.run({ tenantId: "t", goal: "Capture the page" });

    expect(call).toBe(2);
    expect(briefings[1]).toContain("browser.screenshot");
    // And it must be framed as "avoid this", not merely repeated back.
    expect(briefings[1]).toMatch(/avoid|do not use|different tool/i);
  });

  it("records the failing tool on the context so later attempts accumulate it", async () => {
    const seen: string[][] = [];

    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async (context) => {
          seen.push([...context.avoidTools]);
          const n = seen.length;
          return {
            completed: false,
            summary: "tool misuse",
            error: `tool_${n}.run is not a function`,
            failedTool: `tool_${n}.run`,
          };
        },
      },
      { maxAttempts: 3 },
    );

    await loop.run({ tenantId: "t", goal: "Do the thing" });

    // Each attempt knows about every tool that failed before it.
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual(["tool_1.run"]);
    expect(seen[2]).toEqual(["tool_1.run", "tool_2.run"]);
  });

  it("does not claim a tool change when the failing tool is unknown", async () => {
    let call = 0;

    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async () => {
          call += 1;
          // interface_gap, but the adapter could not identify a tool.
          return call === 1
            ? { completed: false, summary: "schema mismatch", error: "schema validation failed" }
            : { completed: true, summary: "ok" };
        },
      },
      { maxAttempts: 2 },
    );

    const report = await loop.run({ tenantId: "t", goal: "Do the thing" });
    const said = JSON.stringify(report.outcomes);

    // It may still retry, but it must not pretend it switched tools.
    expect(said).not.toMatch(/switched to|changed tool to/i);
    expect(said).toMatch(/could not identify|unknown tool|no specific tool/i);
  });

  it("the avoid-list reaches the briefing verbatim", () => {
    const context = new TaskContext({ tenantId: "t", goal: "Capture the page" });
    context.attempt = 2;
    context.priorFailures.push("browser.screenshot is not a function");
    context.avoidTools.push("browser.screenshot", "browser.pdf");

    const briefing = buildAgentBriefing(context);

    expect(briefing).toContain("browser.screenshot");
    expect(briefing).toContain("browser.pdf");
  });

  it("no avoid-list section on a clean first attempt", () => {
    const context = new TaskContext({ tenantId: "t", goal: "Capture the page" });
    const briefing = buildAgentBriefing(context);

    // Nothing has failed, so there is nothing to avoid.
    expect(briefing).not.toMatch(/avoid these tools/i);
  });
});

describe("the adapter extracts the failing tool from session events", () => {
  it("reports the tool from the last failed tool event", async () => {
    const { extractFailedTool } = await import("../src/execution/session-agent-adapter.js");

    const events = [
      { kind: "tool.call", payload: { name: "fs.read" } },
      { kind: "tool.result", payload: { name: "fs.read", ok: true } },
      { kind: "tool.call", payload: { name: "browser.screenshot" } },
      { kind: "tool.error", payload: { name: "browser.screenshot", error: "is not a function" } },
    ];

    expect(extractFailedTool(events)).toBe("browser.screenshot");
  });

  it("returns undefined rather than guessing when nothing failed", async () => {
    const { extractFailedTool } = await import("../src/execution/session-agent-adapter.js");

    const events = [
      { kind: "tool.call", payload: { name: "fs.read" } },
      { kind: "tool.result", payload: { name: "fs.read", ok: true } },
    ];

    // A successful tool must never be reported as the failing one.
    expect(extractFailedTool(events)).toBeUndefined();
  });
});
