import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LongHorizonMemoryService } from "../src/aurora/long-horizon-memory.js";

async function memory(): Promise<LongHorizonMemoryService> {
  const root = await mkdtemp(join(tmpdir(), "haf-memory-"));
  return new LongHorizonMemoryService(root);
}

describe("P2: Long-Horizon Memory — Consolidation", () => {
  it("stores and retrieves memories", async () => {
    const service = await memory();
    
    const mem = await service.storeMemory(
      "tenant1",
      "episodic",
      "short",
      "Test Memory",
      "This is a test memory content",
      5,
      0.3,
      ["test", "memory"]
    );
    
    expect(mem).toBeDefined();
    expect(mem.title).toBe("Test Memory");
    
    const retrieved = await service.recall(mem.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.content).toBe("This is a test memory content");
  });

  it("searches memories by query", async () => {
    const service = await memory();
    
    await service.storeMemory("tenant1", "semantic", "long", "AI Concepts", "Machine learning fundamentals", 8, 0.5, ["ai", "ml"]);
    await service.storeMemory("tenant1", "episodic", "short", "Meeting Notes", "Discussed project timeline", 6, 0.2, ["meeting", "project"]);
    
    const results = await service.search("tenant1", "machine learning");
    expect(results).toBeInstanceOf(Array);
    expect(results.length).toBeGreaterThan(0);
  });

  it("autoConsolidate identifies consolidation opportunities", async () => {
    const service = await memory();
    
    // Store related memories
    for (let i = 0; i < 5; i++) {
      await service.storeMemory(
        "tenant1",
        "episodic",
        "short",
        `Related Memory ${i}`,
        `Content about topic A - part ${i}`,
        4,
        0.2,
        ["topicA"]
      );
    }
    
    const result = await service.autoConsolidate("tenant1");
    expect(result).toBeDefined();
    expect(result.consolidated).toBeGreaterThanOrEqual(0);
    expect(result.insights).toBeInstanceOf(Array);
  });

  it("provides getStats summary", async () => {
    const service = await memory();
    
    await service.storeMemory("tenant1", "semantic", "long", "Test", "Content", 5, 0.3, []);
    
    const stats = await service.getStats("tenant1");
    expect(stats).toBeDefined();
  });
});
