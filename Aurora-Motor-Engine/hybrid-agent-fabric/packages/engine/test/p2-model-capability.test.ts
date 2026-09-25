import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelCapabilityRegistryService } from "../src/aurora/model-capability-registry.js";

async function registry(): Promise<ModelCapabilityRegistryService> {
  const root = await mkdtemp(join(tmpdir(), "haf-registry-"));
  return new ModelCapabilityRegistryService(root);
}

describe("P2: Model Capability Registry — Multi-Model Orchestration", () => {
  it("registers models and retrieves them", async () => {
    const service = await registry();
    
    const model = await service.register({
      modelId: "gpt-4",
      displayName: "GPT-4",
      provider: "openai",
      capabilities: [{ domain: "text-generation", level: "expert" }],
      contextWindow: 128000,
      maxOutputTokens: 4096,
      avgLatencyMs: 2000,
      costPer1kInput: 0.03,
      costPer1kOutput: 0.06,
    });
    
    expect(model).toBeDefined();
    expect(model.modelId).toBe("gpt-4");
    
    const profiles = await service.getProfiles();
    expect(profiles).toHaveLength(1);
  });

  it("records outcomes and updates model stats", async () => {
    const service = await registry();
    
    await service.register({
      modelId: "claude-3",
      displayName: "Claude 3",
      provider: "anthropic",
      capabilities: [{ domain: "reasoning", level: "expert" }],
      contextWindow: 200000,
      maxOutputTokens: 4096,
      avgLatencyMs: 1500,
      costPer1kInput: 0.015,
      costPer1kOutput: 0.075,
    });
    
    await service.recordOutcome("claude-3", true, 1200);
    await service.recordOutcome("claude-3", true, 1400);
    await service.recordOutcome("claude-3", false, 3000);
    
    const profile = await service.getProfile("claude-3");
    expect(profile).toBeDefined();
  });

  it("orchestrates multiple models for a task", async () => {
    const service = await registry();
    
    await service.register({
      modelId: "gpt-4",
      displayName: "GPT-4",
      provider: "openai",
      capabilities: [{ domain: "text-generation", level: "expert" }, { domain: "reasoning", level: "advanced" }],
      contextWindow: 128000,
      maxOutputTokens: 4096,
      avgLatencyMs: 2000,
      costPer1kInput: 0.03,
      costPer1kOutput: 0.06,
    });
    
    await service.register({
      modelId: "claude-3",
      displayName: "Claude 3",
      provider: "anthropic",
      capabilities: [{ domain: "reasoning", level: "expert" }, { domain: "analysis", level: "expert" }],
      contextWindow: 200000,
      maxOutputTokens: 4096,
      avgLatencyMs: 1500,
      costPer1kInput: 0.015,
      costPer1kOutput: 0.075,
    });
    
    const result = await service.orchestrate({
      task: "Analyze code and suggest improvements",
      requiredCapabilities: ["reasoning", "analysis"],
      maxModels: 2,
    });
    
    expect(result).toBeDefined();
    expect(result.selectedModels).toBeInstanceOf(Array);
    expect(result.rationale).toBeInstanceOf(Array);
  });

  it("provides getStats summary", async () => {
    const service = await registry();
    
    const stats = await service.getStats();
    expect(stats).toBeDefined();
  });
});
