/**
 * Meta Controller Routes
 * 31. Sistem: Cognitive Meta-Controller endpoint'leri
 */
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import type { HybridAgentEngine } from "@haf/engine";

export function registerMetaControllerRoutes(app: FastifyInstance, engine: HybridAgentEngine, z: typeof import("zod").z, auroraTenant: z.ZodObject<any>) {

  app.post("/v1/meta-controller/profile", async (request) => {
    const b = z.object({ tenantId: z.string().default("local"), taskDescription: z.string(), context: z.string().optional() }).parse(request.body);
    const profile = await engine.metaController.profileTask(b.tenantId, b.taskDescription, b.context);
    const plan = engine.metaController.createPlan(profile);
    return { profile, plan };
  });

  app.post("/v1/meta-controller/plan", async (request) => {
    const b = z.object({ tenantId: z.string().default("local"), taskDescription: z.string(), context: z.string().optional() }).parse(request.body);
    const profile = await engine.metaController.profileTask(b.tenantId, b.taskDescription, b.context);
    return { profile, plan: engine.metaController.createPlan(profile) };
  });

  app.get("/v1/meta-controller/stats", async (request) => {
    const q = auroraTenant.parse(request.query);
    return await engine.metaController.getStats(q.tenantId);
  });

  app.get("/v1/meta-controller/alerts", async (request) => {
    const q = z.object({ unacknowledgedOnly: z.coerce.boolean().default(true) }).parse(request.query);
    return { alerts: await engine.metaController.getAlerts(q.unacknowledgedOnly) };
  });

  app.post("/v1/meta-controller/alerts/:alertId/acknowledge", async (request) => {
    const { alertId } = z.object({ alertId: z.string() }).parse(request.params);
    await engine.metaController.acknowledgeAlert(alertId);
    return { ok: true };
  });

  app.get("/v1/meta-controller/health", async () => {
    return { subsystems: await engine.metaController.getSubsystemHealth() };
  });

  app.post("/v1/meta-controller/insights", async () => {
    return { insights: await engine.metaController.generateInsights() };
  });

  app.post("/v1/meta-controller/mode", async (request) => {
    const b = z.object({ mode: z.enum(["normal","conservative","aggressive","learning","recovery"]), reason: z.string() }).parse(request.body);
    await engine.metaController.setMode(b.mode, b.reason);
    return { ok: true };
  });

  app.get("/v1/meta-controller/config", async () => {
    return await engine.metaController.getConfig();
  });

  app.patch("/v1/meta-controller/config", async (request) => {
    const b = z.object({ mode: z.enum(["normal","conservative","aggressive","learning","recovery"]).optional(), maxConcurrentSubsystems: z.number().optional(), autoRecovery: z.boolean().optional(), learningRate: z.number().optional(), explorationRate: z.number().optional() }).parse(request.body);
    const patch: Record<string, unknown> = {};
    if (b.mode) patch.mode = b.mode;
    if (b.maxConcurrentSubsystems !== undefined) patch.maxConcurrentSubsystems = b.maxConcurrentSubsystems;
    if (b.autoRecovery !== undefined) patch.autoRecovery = b.autoRecovery;
    if (b.learningRate !== undefined) patch.learningRate = b.learningRate;
    if (b.explorationRate !== undefined) patch.explorationRate = b.explorationRate;
    await engine.metaController.updateConfig(patch as any);
    return { ok: true };
  });
}
