import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DecisionService } from "../src/aurora/decision-service.js";
import { SelfDebuggingService } from "../src/aurora/self-debugging.js";
import { LongHorizonMemoryService } from "../src/aurora/long-horizon-memory.js";
import { ExperienceCompilerService } from "../src/aurora/experience-compiler.js";
import { GoalStackService } from "../src/aurora/goal-stack.js";
import { MultiHypothesisReasoningService } from "../src/aurora/multi-hypothesis-reasoning.js";
import { CausalGraphService } from "../src/aurora/causal-graph.js";
import { AdaptiveRouterService } from "../src/aurora/adaptive-router.js";

async function mkSvc<T>(Ctor: new (root: string) => T): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "haf-error-"));
  return new Ctor(root);
}

describe("P3: Error Handling — Graceful Failures", () => {
  describe("Decision Service", () => {
    it("throws on nonexistent decision get", async () => {
      const svc = await mkSvc(DecisionService);
      await expect(svc.get("tenant1", "nonexistent")).rejects.toThrow();
    });

    it("throws on nonexistent decision why()", async () => {
      const svc = await mkSvc(DecisionService);
      await expect(svc.why("tenant1", "nonexistent")).rejects.toThrow();
    });

    it("throws on nonexistent option add", async () => {
      const svc = await mkSvc(DecisionService);
      await expect(svc.addOption({ tenantId: "t1", decisionId: "nonexistent", name: "X", scores: {} })).rejects.toThrow();
    });
  });

  describe("Self-Debugging Service", () => {
    it("selfHeal handles empty symptoms", async () => {
      const svc = await mkSvc(SelfDebuggingService);
      const result = await svc.selfHeal("tenant1", "test-subsystem", []);
      expect(result).toBeDefined();
      expect(result.severity).toBeDefined();
    });

    it("selfHeal handles single symptom", async () => {
      const svc = await mkSvc(SelfDebuggingService);
      const result = await svc.selfHeal("tenant1", "service", ["timeout"]);
      expect(result.diagnosis).toContain("service");
      expect(result.healingSteps.length).toBeGreaterThan(0);
    });

    it("getBugs returns empty array for new tenant", async () => {
      const svc = await mkSvc(SelfDebuggingService);
      const bugs = await svc.getBugs("new-tenant");
      expect(bugs).toEqual([]);
    });
  });

  describe("Long-Horizon Memory Service", () => {
    it("recall returns null for nonexistent memory", async () => {
      const svc = await mkSvc(LongHorizonMemoryService);
      const result = await svc.recall("nonexistent-id");
      expect(result).toBeNull();
    });

    it("search returns empty for no matches", async () => {
      const svc = await mkSvc(LongHorizonMemoryService);
      const results = await svc.search("tenant1", "completely-unknown-query");
      expect(results).toEqual([]);
    });

    it("autoConsolidate handles empty memory store", async () => {
      const svc = await mkSvc(LongHorizonMemoryService);
      const result = await svc.autoConsolidate("tenant1");
      expect(result).toBeDefined();
      expect(result.consolidated).toBe(0);
      expect(result.insights).toBeInstanceOf(Array);
    });
  });

  describe("Experience Compiler Service", () => {
    it("transferSkill returns null for nonexistent skill", async () => {
      const svc = await mkSvc(ExperienceCompilerService);
      const result = await svc.transferSkill("nonexistent", "tenant2");
      expect(result).toBeNull();
    });

    it("findSimilarSkills returns empty for no matches", async () => {
      const svc = await mkSvc(ExperienceCompilerService);
      const results = await svc.findSimilarSkills("tenant1", ["unknown-tag"]);
      expect(results).toEqual([]);
    });

    it("getSkills returns empty for new tenant", async () => {
      const svc = await mkSvc(ExperienceCompilerService);
      const skills = await svc.getSkills("new-tenant");
      expect(skills).toEqual([]);
    });
  });

  describe("Goal Stack Service", () => {
    it("getActiveGoals returns empty for new tenant", async () => {
      const svc = await mkSvc(GoalStackService);
      const goals = await svc.getActiveGoals("new-tenant");
      expect(goals).toEqual([]);
    });

    it("why() throws for nonexistent goal", async () => {
      const svc = await mkSvc(GoalStackService);
      await expect(svc.why("tenant1", "nonexistent")).rejects.toThrow();
    });
  });

  describe("Multi-Hypothesis Reasoning Service", () => {
    it("getHypotheses returns empty for new tenant", async () => {
      const svc = await mkSvc(MultiHypothesisReasoningService);
      const hypotheses = await svc.getHypotheses("new-tenant");
      expect(hypotheses).toEqual([]);
    });

    it("why() throws for nonexistent hypothesis", async () => {
      const svc = await mkSvc(MultiHypothesisReasoningService);
      await expect(svc.why("tenant1", "nonexistent")).rejects.toThrow();
    });
  });

  describe("Causal Graph Service", () => {
    it("analyzeImpact returns null node for nonexistent", async () => {
      const svc = await mkSvc(CausalGraphService);
      const result = await svc.analyzeImpact("nonexistent");
      expect(result.node).toBeNull();
      expect(result.riskLevel).toBe("low");
    });

    it("findPaths returns empty for no paths", async () => {
      const svc = await mkSvc(CausalGraphService);
      const n1 = await svc.addNode("A", "event", "Node A");
      const n2 = await svc.addNode("B", "event", "Node B");
      const paths = await svc.findPaths(n1.id, n2.id);
      expect(paths).toEqual([]);
    });
  });

  describe("Adaptive Router Service", () => {
    it("smartRoute handles no rules gracefully", async () => {
      const svc = await mkSvc(AdaptiveRouterService);
      const result = await svc.smartRoute("tenant1", "/unknown/path");
      expect(result).toBeDefined();
      expect(result.recommendedPath).toBe("default");
      expect(result.confidence).toBeLessThan(0.5);
    });

    it("learnRoute handles empty decisions", async () => {
      const svc = await mkSvc(AdaptiveRouterService);
      const result = await svc.learnRoute("tenant1");
      expect(result).toBeDefined();
      expect(result.rulesUpdated).toBe(0);
      expect(result.rulesCreated).toBe(0);
    });

    it("why() throws for nonexistent route", async () => {
      const svc = await mkSvc(AdaptiveRouterService);
      await expect(svc.why("tenant1", "nonexistent")).rejects.toThrow();
    });
  });
});
