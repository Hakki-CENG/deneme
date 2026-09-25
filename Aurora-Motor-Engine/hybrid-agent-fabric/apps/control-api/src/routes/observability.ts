/**
 * Observability routes (T5): health, SLOs, task explanation, metrics and
 * fleet status — extracted from main.ts one group at a time. The extraction
 * is behaviour-neutral by construction: same paths, same handlers, same
 * response shapes; the OpenAPI registration count must not move (862).
 */

import type { FastifyInstance } from "fastify";
import { explainTask } from "@haf/engine";
import { type FleetMonitor, type HybridAgentEngine } from "@haf/engine";

export function registerObservabilityRoutes(
  app: FastifyInstance,
  engine: HybridAgentEngine,
  z: typeof import("zod").z,
  context: { fleetMonitor: FleetMonitor; engineVersion: string },
): void {
  app.get("/health", async () => ({
    // P2.45: component-level, measured health. The overall status is "ok" or
    // "degraded" — the process answering is by definition up, so "down" would
    // be unreachable, and the old unconditional "ok" could not fail.
    status: (await engine.health.report()).status,
    engine: "hybrid-agent-fabric",
    version: context.engineVersion,
    provider: engine.models.list(),
    sandbox: engine.config.sandboxBackend,
    persistence: engine.database ? "postgres" : "file",
    nats: Boolean(engine.nats),
  }));

  app.get("/v1/health/report", async (request) => {
    const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
    return await engine.health.report(tenantId);
  });

  app.get("/v1/slo", async () => await engine.slos.report());

  // P2.53: "Why did Aurora do this?" — assembled strictly from the report the
  // caller holds; absent fields are answered with "not recorded", never guessed.
  app.post("/v1/explain/task", async (request) => {
    const body = z.object({ report: z.record(z.string(), z.unknown()) }).parse(request.body);
    return explainTask(body.report as unknown as Parameters<typeof explainTask>[0]);
  });

  app.get("/metrics", async (request, reply) => {
    const { tenant } = z.object({ tenant: z.string().max(200).default("local") }).parse(request.query);
    // Aurora gauges are content-free by construction, so they are safe on the same scrape endpoint.
    const aurora = await engine.auroraMetrics.prometheus(tenant).catch(() => "");
    return await reply.type("text/plain; version=0.0.4; charset=utf-8").send(`${engine.metrics.prometheus()}${aurora}`);
  });

  app.get("/v1/metrics", async () => ({
    ...engine.metrics.snapshot(),
    ...(engine.otlp ? { otlp: engine.otlp.status() } : {}),
  }));

  app.get("/v1/fleet/status", async () => await context.fleetMonitor.snapshot());
  app.get("/v1/fleet/alerts", async () => ({ alerts: (await context.fleetMonitor.snapshot()).alerts }));
}
