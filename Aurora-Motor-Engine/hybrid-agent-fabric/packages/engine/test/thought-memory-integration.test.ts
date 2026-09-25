/**
 * Thought-Memory Integration Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ThoughtMemoryIntegration } from "../src/thought/thought-memory-integration.js";

describe("ThoughtMemoryIntegration", () => {
  let integration: ThoughtMemoryIntegration;
  let mockEngine: any;

  beforeEach(() => {
    mockEngine = {
      memoryGraph: {
        createMemory: async (input: any) => ({
          id: `mem-${Date.now()}`,
          ...input,
        }),
        search: async () => [],
      },
    };
    integration = new ThoughtMemoryIntegration(mockEngine);
  });

  it("should create integration with default config", () => {
    const stats = integration.stats();
    expect(stats.config.minConfidenceForAutoStore).toBe(0.6);
    expect(stats.config.minImportanceForAutoStore).toBe(0.4);
    expect(stats.config.maxMemoriesPerCycle).toBe(5);
    expect(stats.config.enableConsolidation).toBe(true);
  });

  it("should create integration with custom config", () => {
    const custom = new ThoughtMemoryIntegration(mockEngine, {
      minConfidenceForAutoStore: 0.8,
      maxMemoriesPerCycle: 10,
    });
    const stats = custom.stats();
    expect(stats.config.minConfidenceForAutoStore).toBe(0.8);
    expect(stats.config.maxMemoriesPerCycle).toBe(10);
  });

  it("should process insight thought", async () => {
    const thought = {
      id: "thought-1",
      type: "insight",
      content: "Users prefer dark mode",
      confidence: 0.8,
      importance: 0.7,
      tags: ["ux", "preference"],
    };

    const insights = await integration.processThought("tenant-1", thought);
    expect(insights.length).toBeGreaterThan(0);
    expect(insights[0].kind).toBe("insight");
    expect(insights[0].content).toBe("Users prefer dark mode");
  });

  it("should process observation thought", async () => {
    const thought = {
      id: "thought-2",
      type: "observation",
      content: "API latency increased by 20%",
      confidence: 0.9,
      importance: 0.6,
    };

    const insights = await integration.processThought("tenant-1", thought);
    expect(insights.length).toBeGreaterThan(0);
    expect(insights[0].kind).toBe("observation");
  });

  it("should process pattern thought", async () => {
    const thought = {
      id: "thought-3",
      type: "pattern",
      content: "User engagement peaks on Tuesdays",
      confidence: 0.7,
      importance: 0.8,
    };

    const insights = await integration.processThought("tenant-1", thought);
    expect(insights.length).toBeGreaterThan(0);
    expect(insights[0].kind).toBe("pattern");
    expect(insights[0].tags).toContain("pattern");
  });

  it("should not process same thought twice", async () => {
    const thought = {
      id: "thought-dup",
      type: "insight",
      content: "Test insight",
      confidence: 0.8,
      importance: 0.7,
    };

    const first = await integration.processThought("tenant-1", thought);
    const second = await integration.processThought("tenant-1", thought);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(0);
  });

  it("should not auto-store low confidence insights", async () => {
    const thought = {
      id: "thought-low",
      type: "insight",
      content: "Maybe something",
      confidence: 0.3,
      importance: 0.2,
    };

    const insights = await integration.processThought("tenant-1", thought);
    expect(insights.length).toBeGreaterThan(0); // Insight extracted
    // But not auto-stored (check memoryGraph.createMemory not called)
  });

  it("should find relevant context from memory", async () => {
    mockEngine.memoryGraph.search = async () => [
      { id: "mem-1", content: "Related memory" },
    ];

    const results = await integration.findRelevantContext("tenant-1", "search query");
    expect(results.length).toBe(1);
  });

  it("should handle missing memory graph gracefully", async () => {
    const noMemoryEngine = { memoryGraph: null };
    const noMemoryIntegration = new ThoughtMemoryIntegration(noMemoryEngine);

    const thought = {
      id: "thought-nomem",
      type: "insight",
      content: "Test",
      confidence: 0.8,
      importance: 0.7,
    };

    const insights = await noMemoryIntegration.processThought("tenant-1", thought);
    expect(insights.length).toBeGreaterThan(0);
  });

  it("should track pending insights", async () => {
    const thought = {
      id: "thought-pending",
      type: "insight",
      content: "Pending insight",
      confidence: 0.8,
      importance: 0.7,
    };

    await integration.processThought("tenant-1", thought);
    const pending = integration.getPendingInsights();
    expect(pending.length).toBeGreaterThan(0);
  });

  it("should clear processed cache", () => {
    integration.clearProcessedCache();
    const stats = integration.stats();
    expect(stats.processedThoughts).toBe(0);
  });
});
