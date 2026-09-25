import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeStuck } from "../src/runtime/stuck-detector.js";
import { HybridAgentEngine } from "../src/engine.js";
import type { EventEnvelope, JsonValue } from "../src/types.js";

let sequence = 0;
function event(type: string, payload: JsonValue): EventEnvelope {
  sequence++;
  return {
    schemaVersion: 1,
    eventId: `evt-${sequence}`,
    tenantId: "tenant",
    sessionId: "session-1",
    familyId: "family-1",
    generation: 1,
    sequence,
    traceId: `trace-${sequence}`,
    type,
    timestamp: new Date(Date.parse("2026-09-01T00:00:00Z") + sequence * 1000).toISOString(),
    visibility: "user",
    redactionClass: "metadata-only",
    payload,
  };
}
function capabilityStarted(capabilityId: string): EventEnvelope {
  return event("capability.started", { capabilityId, toolCallId: `call-${sequence}`, risk: "process" });
}
function capabilityFailed(capabilityId: string, error: string): EventEnvelope {
  return event("capability.finished", { capabilityId, status: "failed", error });
}
function assistantMessage(text: string): EventEnvelope {
  return event("message.created", { message: { role: "assistant", content: [{ type: "text", text }] } });
}

describe("Aurora stuck detection", () => {
  it("detects a repeated action loop and identical failing errors", () => {
    const events = [
      capabilityStarted("process.run"), capabilityFailed("process.run", "ENOENT: missing file 12345"),
      capabilityStarted("process.run"), capabilityFailed("process.run", "ENOENT: missing file 67890"),
      capabilityStarted("process.run"), capabilityFailed("process.run", "ENOENT: missing file 11111"),
    ];
    const report = analyzeStuck("session-1", events);
    expect(report.stuck).toBe(true);
    const codes = report.patterns.map((item) => item.code);
    expect(codes).toContain("repeated-action");
    expect(codes).toContain("repeated-error");
    expect(report.confidence).toBeGreaterThan(0.4);
    expect(report.frictionSignature).toBeTruthy();
    const repeated = report.patterns.find((item) => item.code === "repeated-error")!;
    expect(repeated.occurrences).toBe(3);
    expect(repeated.evidenceEventIds.length).toBe(3);
  });

  it("detects oscillation between two capabilities", () => {
    const events = [
      capabilityStarted("fs.read"), capabilityStarted("fs.write"),
      capabilityStarted("fs.read"), capabilityStarted("fs.write"),
      capabilityStarted("fs.read"), capabilityStarted("fs.write"),
    ];
    const report = analyzeStuck("session-1", events, { repeatThreshold: 10 });
    const alternating = report.patterns.find((item) => item.code === "alternating-loop");
    expect(alternating).toBeTruthy();
    expect(alternating?.occurrences).toBeGreaterThanOrEqual(2);
  });

  it("detects monologue and byte-identical output", () => {
    const events = [
      assistantMessage("Let me think about this."),
      assistantMessage("Let me think about this."),
      assistantMessage("Let me think about this."),
      assistantMessage("Let me think about this."),
    ];
    const report = analyzeStuck("session-1", events);
    const codes = report.patterns.map((item) => item.code);
    expect(codes).toContain("monologue");
    expect(codes).toContain("identical-output");
    expect(report.stuck).toBe(true);
  });

  it("reports healthy progress as not stuck", () => {
    const events = [
      assistantMessage("Reading the failing test."), capabilityStarted("fs.read"),
      assistantMessage("Patching the bug."), capabilityStarted("fs.write"),
      assistantMessage("Running the suite."), capabilityStarted("process.run"),
      assistantMessage("Fixed, tests pass."),
    ];
    const report = analyzeStuck("session-1", events);
    expect(report.stuck).toBe(false);
    expect(report.patterns).toHaveLength(0);
  });

  it("treats a fired runtime guardrail as critical", () => {
    const report = analyzeStuck("session-1", [event("guardrail.tool_loop_limit", { maxIterations: 25 })]);
    expect(report.patterns[0]).toMatchObject({ code: "tool-iteration-guardrail", severity: "critical" });
  });
});

describe("Aurora dream-mode insight formation", () => {
  it("proposes unlinked but related memories and only writes when materialized", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-aurora-insight-"));
    const engine = new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
    const hardware = await engine.memoryGraph.remember({
      tenantId: "tenant", layer: "semantic", claimType: "observation", title: "Neuromorphic hardware",
      content: "Event-driven processors reduce idle power dramatically.", sourceType: "external", confidence: 0.9, importance: 0.8, tags: ["neuromorphic", "hardware"],
    });
    const memoryDesign = await engine.memoryGraph.remember({
      tenantId: "tenant", layer: "procedural", claimType: "inference", title: "Sparse recall pipeline",
      content: "Recall costs drop when only relevant graph regions are traversed.", sourceType: "agent", confidence: 0.6, importance: 0.7, tags: ["neuromorphic", "memory"],
    });
    const candidates = await engine.memoryGraph.proposeInsights("tenant", { minSharedTags: 1 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ leftId: hardware.id, rightId: memoryDesign.id });
    expect(candidates[0]?.sharedTags).toContain("neuromorphic");
    expect(candidates[0]?.noveltyScore).toBeGreaterThan(0);
    expect((await engine.memoryGraph.list("tenant")).length).toBe(2);

    const insight = await engine.memoryGraph.materializeInsight({
      tenantId: "tenant", leftId: hardware.id, rightId: memoryDesign.id,
      title: "Event-driven recall", content: "Sparse graph recall may map naturally onto event-driven hardware.",
    });
    expect(insight).toMatchObject({ layer: "palace", claimType: "hypothesis" });
    const relations = await engine.memoryGraph.relations("tenant", insight.id);
    expect(relations).toHaveLength(2);
    expect(relations.every((item) => item.type === "derived-from")).toBe(true);
    expect(await engine.memoryGraph.proposeInsights("tenant", { minSharedTags: 1 })).toHaveLength(0);
    await engine.shutdown();
  });
});

describe("ACOS cognitive control loop", () => {
  async function engineFixture() {
    const homePath = await mkdtemp(join(tmpdir(), "haf-aurora-acos-"));
    return new HybridAgentEngine({ homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"), sandboxBackend: "local", model: { provider: "mock" } });
  }

  it("runs every phase, records a durable cycle report and journals it", async () => {
    const engine = await engineFixture();
    const report = await engine.acos.tick("tenant");
    expect(report.mode).toBe("full");
    expect(report.sequence).toBe(1);
    expect(report.phases.map((item) => item.phase)).toEqual([
      "observe", "update-world", "prioritize", "allocate", "execute", "evaluate", "learn", "remember", "reflect", "evolve",
    ]);
    expect(report.phases.every((item) => item.status === "ok" || item.status === "degraded")).toBe(true);
    expect(report.degraded).toHaveLength(0);
    expect(report.constitutionVerdict).toBe("allow");
    const journal = await engine.acos.journal("tenant");
    expect(journal[0]).toMatchObject({ kind: "cycle" });
    expect(journal[0]?.body).toContain("observe");
    const second = await engine.acos.tick("tenant", { mode: "maintenance" });
    expect(second.sequence).toBe(2);
    expect(second.phases.map((item) => item.phase)).toEqual(["observe", "update-world", "remember", "evaluate"]);
    await engine.shutdown();
  });

  it("moves real signals through the loop: initiative queueing, memory hygiene and friction learning", async () => {
    const engine = await engineFixture();
    await engine.initiative.configureBudget({ tenantId: "tenant", dailyImmediateLimit: 3, dailyMessageLimit: 3 });
    await engine.initiative.propose({
      tenantId: "tenant", kind: "risk", title: "Backups disabled", message: "Nightly backups have not run for three days.",
      importance: 0.95, urgency: 0.9, impact: 0.95, confidence: 0.9, userRelevance: 0.95, mode: "guardian",
    });
    await engine.environment.upsertProject({ tenantId: "tenant", name: "Aurora", workspacePath: "/workspaces/aurora", openTasks: 3, lastActivityAt: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    const blocked = await engine.cognitive.createObject({
      tenantId: "tenant", kind: "problem", title: "Flaky integration suite", content: "The same failure keeps returning.",
      sourceType: "agent", confidence: 0.5, importance: 0.8, urgency: 0.6, impact: 0.7, userRelevance: 0.7, horizon: "tactical",
    });
    for (let index = 0; index < 3; index++) await engine.cognitive.recordIteration("tenant", blocked.id, "same failure");

    const report = await engine.acos.tick("tenant");
    expect(report.signals.initiativesQueued).toBeGreaterThan(0);
    expect(report.signals.intake).toBeGreaterThan(0);
    expect(report.signals.gaps).toBeGreaterThan(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
    const gaps = await engine.evolution.gaps("tenant");
    expect(gaps[0]?.description).toContain("Flaky integration suite");
    const stalledObservation = (await engine.cognitive.objects("tenant")).find((item) => item.tags.includes("stalled"));
    expect(stalledObservation?.kind).toBe("risk");
    await engine.shutdown();
  });

  it("aggregates a whole-organism status view", async () => {
    const engine = await engineFixture();
    await engine.userModel.recordSignal({ tenantId: "tenant", userId: "primary", kind: "commit", intensity: 0.8 });
    await engine.acos.tick("tenant");
    const status = await engine.acos.status("tenant", "primary") as Record<string, any>;
    expect(status["identity"].version).toBe(1);
    expect(status["mode"]).toBe("reactive");
    expect(status["cognitive"]).toHaveProperty("health");
    expect(status["memory"]).toHaveProperty("health");
    expect(status["initiative"]).toHaveProperty("trust");
    expect(status["evolution"]).toHaveProperty("index");
    expect(status["environment"]).toHaveProperty("resources");
    expect(status["society"]).toHaveProperty("advisories");
    expect(status["constitution"]).toHaveProperty("complianceRate");
    expect(status["user"].state).toBe("working");
    expect(status["lastCycle"].sequence).toBe(1);
    await engine.shutdown();
  });

  it("keeps running when one phase fails and records the degradation", async () => {
    const engine = await engineFixture();
    const failing = new Error("world model unavailable");
    const original = engine.worldModel.expirePredictions.bind(engine.worldModel);
    engine.worldModel.expirePredictions = async () => { throw failing; };
    const report = await engine.acos.tick("tenant", { mode: "maintenance" });
    expect(report.degraded).toContain("update-world");
    expect(report.phases.find((item) => item.phase === "update-world")?.status).toBe("failed");
    expect(report.phases.find((item) => item.phase === "remember")?.status).toBe("ok");
    const anomalies = await engine.acos.journal("tenant", { kind: "anomaly" });
    expect(anomalies[0]?.title).toContain("update-world");
    engine.worldModel.expirePredictions = original;
    await engine.shutdown();
  });

  it("detects stuck sessions through the engine wiring", async () => {
    const engine = await engineFixture();
    const session = await engine.createSession({ tenantId: "tenant" });
    const report = await engine.stuckDetector.analyze(session.sessionId);
    expect(report.sessionId).toBe(session.sessionId);
    expect(report.stuck).toBe(false);
    await engine.shutdown();
  });
});
