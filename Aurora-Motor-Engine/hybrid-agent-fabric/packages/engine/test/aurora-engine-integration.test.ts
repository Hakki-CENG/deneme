import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

async function engineFixture() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-aurora-engine-"));
  const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
  return engine;
}

describe("Aurora substrate engine integration", () => {
  it("registers every Aurora phase capability in the broker catalog", async () => {
    const engine = await engineFixture();
    const ids = new Set(engine.capabilities.list().map((item) => item.id));
    for (const id of [
      "society.roles.list", "society.bus.publish", "society.meta.monitor",
      "cognitive.workspace.list", "cognitive.intake", "cognitive.health", "cognitive.reflection.schedule", "cognitive.attention.preempt",
      "memory.graph.remember", "memory.graph.recall", "memory.graph.consolidate", "memory.anchor.create",
      "world.entity.upsert", "world.prediction.create", "world.calibration.report", "world.simulate",
      "multiworld.perspectives.list", "multiworld.analysis.create", "multiworld.analysis.resolve",
      "initiative.propose", "initiative.evaluate", "initiative.digest",
      "user.model.observe", "user.model.forget", "user.state.estimate",
      "evolution.gap.observe", "evolution.stage.advance", "evolution.index",
      "environment.resource.register", "environment.action.plan", "environment.action.verify", "environment.inventory",
      "constitution.principles", "constitution.check", "constitution.compliance", "constitution.projection",
      "harness.refine", "harness.rollback", "harness.project",
      "microagents.register", "microagents.recall",
      "risk.assess", "risk.policy.set", "session.stuck.analyze",
      "acos.cycle.run", "acos.status", "acos.journal", "memory.insights.propose",
      "decision.open", "decision.decide", "decision.calibration",
      "plan.create", "plan.step.update", "plan.progress",
      "experience.distill", "experience.apply", "autopilot.status", "autopilot.configure", "aurora.explain",
      "checkpoint.capture", "checkpoint.restore", "checkpoint.diff",
      "aurora.metrics", "aurora.alerts", "aurora.export", "aurora.purge.user", "aurora.selfcheck",
    ]) {
      expect(ids.has(id), `missing capability ${id}`).toBe(true);
    }
    const risky = engine.capabilities.list().filter((item) => item.id.startsWith("evolution.stage.advance") || item.id === "initiative.evaluate");
    expect(risky.every((item) => item.risk === "privileged")).toBe(true);
    await engine.shutdown();
  });

  it("mirrors queued initiatives into the Global Workspace under the same attention budget", async () => {
    const engine = await engineFixture();
    await engine.initiative.configureBudget({ tenantId: "tenant", dailyImmediateLimit: 2, dailyMessageLimit: 2 });
    const initiative = await engine.initiative.propose({
      tenantId: "tenant", kind: "risk", title: "Unbacked repository", message: "The main repository has no backup configured.",
      importance: 1, urgency: 1, impact: 1, confidence: 0.95, userRelevance: 1, mode: "guardian",
    });
    const evaluation = await engine.initiative.evaluate("tenant");
    expect(evaluation.queued.map((item) => item.id)).toContain(initiative.id);
    const objects = await engine.cognitive.objects("tenant");
    const mirrored = objects.find((item) => item.sourceId === initiative.id);
    expect(mirrored).toBeTruthy();
    expect(mirrored?.kind).toBe("risk");
    expect(mirrored?.tags).toContain("initiative");
    const intake = await engine.cognitive.intakeLog("tenant");
    expect(intake.some((item) => item.source === "initiative" && item.accepted)).toBe(true);
    await engine.shutdown();
  });

  it("keeps Aurora state scoped per tenant across services", async () => {
    const engine = await engineFixture();
    await engine.memoryGraph.remember({ tenantId: "a", layer: "semantic", claimType: "observation", title: "Fact", content: "Tenant A fact.", sourceType: "system", confidence: 0.8, importance: 0.5 });
    await engine.worldModel.upsertEntity({ tenantId: "a", type: "project", name: "Alpha" });
    await engine.environment.registerResource({ tenantId: "a", kind: "filesystem", name: "Workspace", locator: "/a", zone: 1 });
    expect(await engine.memoryGraph.list("b")).toHaveLength(0);
    expect(await engine.worldModel.entities("b")).toHaveLength(0);
    expect(await engine.environment.resources("b")).toHaveLength(0);
    expect((await engine.environment.inventory("a")).totals.resources).toBe(1);
    await engine.shutdown();
  });
});
