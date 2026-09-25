import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SelfDebuggingService } from "../src/aurora/self-debugging.js";

async function debugging(): Promise<SelfDebuggingService> {
  const root = await mkdtemp(join(tmpdir(), "haf-debugging-"));
  return new SelfDebuggingService(root);
}

describe("P2: Self-Debugging — Self-Healing", () => {
  it("reports bugs and retrieves them", async () => {
    const service = await debugging();
    
    const bug = await service.reportBug(
      "tenant1",
      "runtime",
      "Test bug description",
      ["symptom1", "symptom2"],
      "test-subsystem",
      ["step1", "step2"],
      "high"
    );
    
    expect(bug).toBeDefined();
    expect(bug.tenantId).toBe("tenant1");
    expect(bug.type).toBe("runtime");
    
    const bugs = await service.getBugs("tenant1");
    expect(bugs).toHaveLength(1);
    expect(bugs[0].description).toBe("Test bug description");
  });

  it("selfHeal diagnoses and provides healing steps", async () => {
    const service = await debugging();
    
    const result = await service.selfHeal("tenant1", "memory-service", [
      "timeout on memory recall",
      "slow response times",
    ]);
    
    expect(result).toBeDefined();
    expect(result.diagnosis).toContain("memory-service");
    expect(result.severity).toBeDefined();
    expect(result.healingSteps).toBeInstanceOf(Array);
    expect(result.healingSteps.length).toBeGreaterThan(0);
    expect(result.estimatedRecoveryMs).toBeGreaterThan(0);
  });

  it("selfHeal detects critical severity with many symptoms", async () => {
    const service = await debugging();
    
    const result = await service.selfHeal("tenant1", "critical-service", [
      "error in execution",
      "crash on startup",
      "memory leak detected",
    ]);
    
    expect(result.severity).toBe("critical");
    expect(result.healingSteps.length).toBeGreaterThanOrEqual(4);
  });

  it("provides getStats summary", async () => {
    const service = await debugging();
    
    // Report some bugs first
    await service.reportBug("tenant1", "logic", "Bug 1", ["s1"], "sub1", [], "low");
    await service.reportBug("tenant1", "runtime", "Bug 2", ["s2"], "sub2", [], "high");
    
    const stats = await service.getStats("tenant1");
    expect(stats).toBeDefined();
    expect(stats.totalBugs).toBe(2);
  });
});
