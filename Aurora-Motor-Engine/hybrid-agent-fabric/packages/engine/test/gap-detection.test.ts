/**
 * Gap detection and the capability-acquisition loop.
 *
 * The scenario from the specification:
 *
 *     "Analyse the visual changes in this GitHub PR."
 *       browser ✓  git ✓  image generation ✓  visual diff ✗
 *     → GAP: missing_capability = visual_diff, type = tool, confidence ≈ 0.93
 *
 * And the loop that makes it matter (spec item 16):
 *
 *     Task → FAIL → GAP → CAPABILITY ACQUIRED → RETRY ORIGINAL TASK → SUCCESS
 */

import { describe, expect, it, vi } from "vitest";

import {
  detectDeterministicGaps,
  detectGaps,
  detectStructuralGaps,
  llmTier,
} from "../src/execution/gap-detection.js";
import {
  UnifiedExecutionLoop,
  type AgentRunResult,
} from "../src/execution/unified-execution-loop.js";

const FULL_INVENTORY = {
  capabilityIds: ["browser.navigate", "browser.screenshot", "git.diff", "git.clone", "image.generate"],
  descriptions: ["Drive a browser", "Git operations", "Generate images"],
};

describe("the visual-diff scenario from the specification", () => {
  it("names visual_diff as missing when the inventory cannot compare images", () => {
    const gaps = detectDeterministicGaps(
      "Analyse the visual changes in this GitHub PR",
      FULL_INVENTORY,
    );

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.missing).toBe("visual_diff");
    expect(gaps[0]?.type).toBe("tool");
    expect(gaps[0]?.confidence).toBeCloseTo(0.93, 2);
    expect(gaps[0]?.tier).toBe("deterministic");
    expect(gaps[0]?.synthesisable).toBe(true);
  });

  it("does not report a gap once the capability is present", () => {
    const gaps = detectDeterministicGaps("Analyse the visual changes in this GitHub PR", {
      capabilityIds: [...FULL_INVENTORY.capabilityIds, "visual_diff.compare"],
    });

    expect(gaps).toHaveLength(0);
  });

  it("cites the evidence for its conclusion", () => {
    const [gap] = detectDeterministicGaps("compare the screenshots", FULL_INVENTORY);
    expect(gap?.evidence.join(" ")).toContain("No registered capability matches");
    expect(gap?.evidence.join(" ")).toContain("Inventory holds 5 capabilities");
  });

  it("works in Turkish as well as English", () => {
    const gaps = detectDeterministicGaps("PR'daki görsel değişiklikleri karşılaştır", FULL_INVENTORY);
    expect(gaps[0]?.missing).toBe("visual_diff");
  });
});

describe("structural detection from failures", () => {
  it("extracts the missing tool name from an error message", () => {
    const gaps = detectStructuralGaps("tool_gap", "Error: no such tool 'visual_diff'");
    expect(gaps[0]?.missing).toBe("visual_diff");
    expect(gaps[0]?.tier).toBe("structural");
  });

  it("is less confident than deterministic detection", () => {
    const structural = detectStructuralGaps("tool_gap", "no such tool 'x'")[0];
    const [deterministic] = detectDeterministicGaps("run ocr on this image", { capabilityIds: [] });

    expect(structural!.confidence).toBeLessThan(deterministic!.confidence);
  });

  it("reports lower confidence when no name can be extracted", () => {
    const vague = detectStructuralGaps("tool_gap", "something went wrong")[0];
    const named = detectStructuralGaps("tool_gap", "no such tool 'thing'")[0];
    expect(vague!.confidence).toBeLessThan(named!.confidence);
  });
});

describe("merging tiers", () => {
  it("prefers the deterministic finding over a structural guess about the same thing", () => {
    const report = detectGaps({
      goal: "compare the screenshots in the PR",
      inventory: FULL_INVENTORY,
      failureKind: "tool_gap",
      failureMessage: "no such tool 'visual_diff'",
    });

    const visual = report.gaps.filter((gap) => gap.missing === "visual_diff");
    expect(visual).toHaveLength(1);
    expect(visual[0]?.tier).toBe("deterministic");
  });

  it("surfaces the highest-confidence synthesisable gap as actionable", () => {
    const report = detectGaps({
      goal: "compare the screenshots and transcribe the audio",
      inventory: { capabilityIds: [] },
    });

    expect(report.actionable?.missing).toBe("visual_diff");
    // Transcription is detected but marked non-synthesisable: you cannot write
    // your way to a speech model.
    const transcription = report.gaps.find((gap) => gap.missing === "audio_transcription");
    expect(transcription?.synthesisable).toBe(false);
  });

  it("reports no gap for a goal that needs nothing special", () => {
    const report = detectGaps({ goal: "rename a variable", inventory: FULL_INVENTORY });
    expect(report.gaps).toHaveLength(0);
    expect(report.summary).toContain("No capability gap");
  });
});

describe("the LLM tier refuses to fake a result", () => {
  it("throws rather than returning an empty list", () => {
    // Returning [] would read as "looked and found nothing".
    expect(() => llmTier()).toThrow(/not implemented/i);
  });
});

describe("gap → acquire → retry the original task", () => {
  it("retries the original goal after the capability is acquired, and succeeds", async () => {
    let capabilityExists = false;

    const runAgent = vi.fn(async (): Promise<AgentRunResult> =>
      capabilityExists
        ? { completed: true, summary: "Compared the screenshots" }
        : { completed: false, summary: "failed", error: "Error: no such tool 'visual_diff'" },
    );

    const acquireCapability = vi.fn(async () => {
      capabilityExists = true;
      return true;
    });

    const loop = new UnifiedExecutionLoop(
      {
        runAgent,
        inventory: async () => ({ capabilityIds: capabilityExists ? ["visual_diff.compare"] : [] }),
        acquireCapability,
        verifiersFor: async () =>
          capabilityExists
            ? [
                {
                  name: "acceptance",
                  tier: "V2_empirical" as const,
                  run: async () => ({ verdict: "pass" as const, evidence: "diff produced", confidence: 0.9 }),
                },
              ]
            : [],
      },
      { maxAttempts: 3 },
    );

    const report = await loop.run({
      tenantId: "t",
      goal: "Analyse the visual changes in this GitHub PR",
    });

    expect(acquireCapability).toHaveBeenCalledTimes(1);
    expect(acquireCapability.mock.calls[0]?.[0]?.missing).toBe("visual_diff");
    // The original goal was retried, not a substitute.
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(report.status).toBe("succeeded");
    expect(report.gaps.some((gap) => gap.missing === "visual_diff")).toBe(true);
  });

  it("stops honestly when nothing can build the missing capability", async () => {
    const runAgent = vi.fn(async (): Promise<AgentRunResult> => ({
      completed: false,
      summary: "failed",
      error: "Error: no such tool 'visual_diff'",
    }));

    // No acquireCapability provider supplied.
    const loop = new UnifiedExecutionLoop(
      { runAgent, inventory: async () => ({ capabilityIds: [] }) },
      { maxAttempts: 3 },
    );

    const report = await loop.run({
      tenantId: "t",
      goal: "Analyse the visual changes in this GitHub PR",
    });

    expect(report.status).not.toBe("succeeded");
    // It must not burn all three attempts on an action that cannot work.
    expect(runAgent).toHaveBeenCalledTimes(1);

    const explanation = report.outcomes.find((item) =>
      item.evidence.includes("no capability-acquisition provider"),
    );
    expect(explanation?.status).toBe("unavailable");
    expect(explanation?.evidence).toContain("Retrying would fail identically");
  });

  it("does not retry forever when acquisition fails", async () => {
    const runAgent = vi.fn(async (): Promise<AgentRunResult> => ({
      completed: false,
      summary: "failed",
      error: "Error: no such tool 'visual_diff'",
    }));

    const loop = new UnifiedExecutionLoop(
      {
        runAgent,
        inventory: async () => ({ capabilityIds: [] }),
        acquireCapability: async () => false,
      },
      { maxAttempts: 5 },
    );

    const report = await loop.run({
      tenantId: "t",
      goal: "Analyse the visual changes in this GitHub PR",
    });

    expect(report.status).toBe("failed");
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(
      report.outcomes.some((item) => item.evidence.includes("Could not acquire capability")),
    ).toBe(true);
  });

  it("does not invent a gap for a timeout", async () => {
    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async () => ({ completed: false, summary: "slow", error: "operation timed out after 30000ms" }),
        inventory: async () => ({ capabilityIds: [] }),
        acquireCapability: vi.fn(async () => true),
      },
      { maxAttempts: 2 },
    );

    const report = await loop.run({ tenantId: "t", goal: "Analyse the visual changes in this PR" });

    // A timeout is not a missing capability.
    expect(report.gaps).toHaveLength(0);
  });
});
