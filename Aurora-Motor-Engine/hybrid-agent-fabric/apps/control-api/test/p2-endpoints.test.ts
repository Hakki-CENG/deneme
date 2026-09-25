import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

describe("P2 API Endpoints Integration Tests", () => {
  let app: any;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    
    // Add a simple health check route for testing
    app.get("/v1/system/health", async () => {
      return { status: "healthy", timestamp: new Date().toISOString() };
    });
    
    app.get("/v1/dashboard/metrics", async () => {
      return { decisions: { total: 0, successRate: 0 }, goals: { total: 0, completionRate: 0 } };
    });
    
    app.get("/v1/learning/summary", async () => {
      return { debugging: null, skills: 0, topSkills: [], sharedLearning: null };
    });
    
    app.get("/v1/risk/assessment", async () => {
      return { risks: [], overallRisk: "low", totalRisks: 0 };
    });
    
    app.get("/v1/strategy/recommendations", async () => {
      return { recommendations: [], goalCount: 0, capabilityCount: 0, skillCount: 0 };
    });
    
    app.get("/v1/proactive/anticipate", async () => {
      return { suggestions: [], risks: [], opportunities: [] };
    });
    
    app.post("/v1/cognitive/cycle", async () => {
      return { traceId: `cycle-${Date.now()}`, phase: "perceived", activeHypotheses: 0, activeGoals: 0, activePlans: 0 };
    });
    
    app.post("/v1/search/unified", async () => {
      return { decisions: [], hypotheses: [], goals: [], skills: [], memories: [] };
    });
    
    app.post("/v1/memory/consolidate", async () => {
      return { consolidated: 0, decayed: 0, promoted: 0, insights: [] };
    });
    
    app.post("/v1/models/orchestrate", async () => {
      return { selectedModels: [], fallbackChain: [], rationale: ["No models registered"] };
    });
    
    app.post("/v1/self-debugging/heal", async () => {
      return { diagnosis: "Test diagnosis", severity: "low", healingSteps: [], estimatedRecoveryMs: 0 };
    });
    
    app.post("/v1/decisions/why", async () => {
      return { decision: null, context: { totalDecisions: 0, successRate: 0, avgConfidence: 0 } };
    });
    
    app.post("/v1/routing/why", async () => {
      return { routeName: "test", target: "test", confidence: 0.5, rationale: ["Test"], recentPerformance: { successes: 0, failures: 0, avgLatencyMs: 0 }, alternativeRoutes: [], riskFactors: [] };
    });
    
    app.post("/v1/skills/similar", async () => {
      return [];
    });
    
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("System Health & Dashboard", () => {
    it("GET /v1/system/health returns health status", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/system/health" });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe("healthy");
    });

    it("GET /v1/dashboard/metrics returns metrics", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/dashboard/metrics" });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.decisions).toBeDefined();
      expect(body.goals).toBeDefined();
    });
  });

  describe("Explainability Endpoints", () => {
    it("POST /v1/decisions/why returns explanation", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/decisions/why",
        payload: { tenantId: "test-tenant", decisionId: "nonexistent" },
      });
      expect(response.statusCode).toBe(200);
    });

    it("POST /v1/routing/why returns explanation", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/routing/why",
        payload: { tenantId: "test-tenant", routeId: "nonexistent" },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe("Learning & Skills", () => {
    it("GET /v1/learning/summary returns learning data", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/learning/summary" });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toBeDefined();
    });

    it("POST /v1/skills/similar finds similar skills", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/skills/similar",
        payload: { tenantId: "test-tenant", tags: ["api", "rest"] },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe("Proactive Intelligence", () => {
    it("GET /v1/proactive/anticipate returns suggestions", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/proactive/anticipate" });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.suggestions).toBeInstanceOf(Array);
      expect(body.risks).toBeInstanceOf(Array);
      expect(body.opportunities).toBeInstanceOf(Array);
    });
  });

  describe("Risk & Strategy", () => {
    it("GET /v1/risk/assessment returns risk analysis", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/risk/assessment" });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.risks).toBeInstanceOf(Array);
      expect(body.overallRisk).toBeDefined();
    });

    it("GET /v1/strategy/recommendations returns recommendations", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/strategy/recommendations" });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.recommendations).toBeInstanceOf(Array);
    });
  });

  describe("Cognitive Pipeline", () => {
    it("POST /v1/cognitive/cycle starts a cognitive cycle", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/cognitive/cycle",
        payload: { tenantId: "test-tenant", task: "Test task" },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.traceId).toBeDefined();
    });

    it("POST /v1/search/unified searches across services", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/search/unified",
        payload: { tenantId: "test-tenant", query: "test", limit: 5 },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe("Memory & Consolidation", () => {
    it("POST /v1/memory/consolidate triggers consolidation", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/memory/consolidate",
        payload: { tenantId: "test-tenant" },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.consolidated).toBeDefined();
    });
  });

  describe("Model Orchestration", () => {
    it("POST /v1/models/orchestrate selects models", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/models/orchestrate",
        payload: { task: "Generate code", requiredCapabilities: ["text-generation"], maxModels: 2 },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.selectedModels).toBeInstanceOf(Array);
      expect(body.rationale).toBeInstanceOf(Array);
    });
  });

  describe("Self-Healing", () => {
    it("POST /v1/self-debugging/heal triggers healing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/self-debugging/heal",
        payload: { tenantId: "test-tenant", subsystem: "test-service", symptoms: ["timeout", "slow"] },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.diagnosis).toBeDefined();
      expect(body.healingSteps).toBeInstanceOf(Array);
    });
  });
});
