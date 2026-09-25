import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MultiWorldModelService } from "../src/world/multi-world-model-service.js";
import { WorldModelService } from "../src/world/world-model-service.js";

async function worldService(now?: () => number): Promise<WorldModelService> {
  const root = await mkdtemp(join(tmpdir(), "haf-aurora-world-"));
  return now ? new WorldModelService(root, now) : new WorldModelService(root);
}

describe("Aurora Phase D world model", () => {
  it("represents entity, state, relation, event and outcome with temporal validity", async () => {
    let now = Date.parse("2026-03-01T09:00:00Z");
    const world = await worldService(() => now);
    const user = await world.upsertEntity({ tenantId: "tenant", type: "person", name: "Primary user", scope: "personal", attributes: { role: "engineer" }, confidence: 0.95, importance: 0.9 });
    const project = await world.upsertEntity({ tenantId: "tenant", type: "project", name: "Aurora", scope: "project", importance: 0.95 });
    await world.relate({ tenantId: "tenant", fromEntityId: user.id, toEntityId: project.id, type: "owns", strength: 0.9, confidence: 0.9 });
    const atUniversity = await world.recordState({ tenantId: "tenant", entityId: user.id, key: "location", value: "university", sourceType: "user", confidence: 0.9 });
    expect(atUniversity.claimType).toBe("observation");
    now += 3_600_000;
    await world.recordState({ tenantId: "tenant", entityId: user.id, key: "location", value: "home", sourceType: "user", confidence: 0.9 });
    const past = await world.stateAt("tenant", user.id, new Date(Date.parse("2026-03-01T09:30:00Z")).toISOString());
    expect(past["location"]?.value).toBe("university");
    const present = await world.stateAt("tenant", user.id);
    expect(present["location"]?.value).toBe("home");
    const view = await world.temporalView("tenant", user.id);
    expect(view.past).toHaveLength(1);
    expect(Object.keys(view.present)).toContain("location");
  });

  it("scores predictions with Brier calibration and feeds causal links from real outcomes", async () => {
    let now = Date.parse("2026-03-01T09:00:00Z");
    const world = await worldService(() => now);
    const repo = await world.upsertEntity({ tenantId: "tenant", type: "project", name: "Repo", scope: "digital" });
    const stalled = await world.recordEvent({ tenantId: "tenant", entityIds: [repo.id], summary: "No commits for seven days", sourceType: "system", confidence: 0.9, importance: 0.7 });
    const slipped = await world.recordEvent({ tenantId: "tenant", entityIds: [repo.id], summary: "Milestone slipped", sourceType: "system", confidence: 0.8, importance: 0.8 });
    const link = await world.assertCausality({ tenantId: "tenant", causeKind: "event", causeRef: stalled.id, effectKind: "event", effectRef: slipped.id, description: "Stalled work delays milestones.", strength: 0.7, confidence: 0.6 });
    const prediction = await world.predict({ tenantId: "tenant", statement: "The milestone will slip again", probability: 0.8, horizonAt: new Date(now + 86_400_000).toISOString(), entityId: repo.id, basisLinkIds: [link.id] });
    const resolved = await world.resolvePrediction("tenant", prediction.id, true);
    expect(resolved.brierScore).toBeCloseTo(0.04, 5);
    const calibration = await world.calibration("tenant");
    expect(calibration).toMatchObject({ resolved: 1, correct: 1, accuracy: 1 });
    expect(calibration.buckets[0]?.count).toBe(1);
    const updatedLink = (await world.causalLinks("tenant")).find((item) => item.id === link.id)!;
    expect(updatedLink.confirmations).toBe(1);
    expect(updatedLink.confidence).toBeGreaterThan(0.6);

    now += 3 * 86_400_000;
    const late = await world.predict({ tenantId: "tenant", statement: "A second slip occurs", probability: 0.4, horizonAt: new Date(now + 3_600_000).toISOString() });
    now += 3 * 86_400_000;
    expect(await world.expirePredictions("tenant")).toContain(late.id);
  });

  it("detects world inconsistencies between conflicting current claims", async () => {
    const world = await worldService();
    const user = await world.upsertEntity({ tenantId: "tenant", type: "person", name: "User" });
    await world.recordState({ tenantId: "tenant", entityId: user.id, key: "location", value: "home", sourceType: "user", confidence: 0.9 });
    await world.recordState({ tenantId: "tenant", entityId: user.id, key: "location", value: "home", claimType: "inference", sourceType: "system", confidence: 0.5 });
    expect(await world.inconsistencies("tenant")).toHaveLength(0);
    await world.recordState({ tenantId: "tenant", entityId: user.id, key: "battery", value: "full", sourceType: "system", confidence: 0.4, validTo: new Date(Date.now() + 86_400_000).toISOString() });
    await world.recordState({ tenantId: "tenant", entityId: user.id, key: "battery", value: "empty", claimType: "inference", sourceType: "agent", confidence: 0.8, validTo: new Date(Date.now() + 86_400_000).toISOString() });
    const found = await world.inconsistencies("tenant");
    expect(found).toHaveLength(1);
    expect(found[0]?.recommendation).toContain("empty");
  });

  it("simulates and counterfactually branches over causal links without writing state", async () => {
    const world = await worldService();
    const server = await world.upsertEntity({ tenantId: "tenant", type: "service", name: "Server", scope: "digital" });
    const outage = await world.recordEvent({ tenantId: "tenant", entityIds: [server.id], summary: "Server outage", sourceType: "system", confidence: 0.9 });
    const dataLoss = await world.recordEvent({ tenantId: "tenant", entityIds: [server.id], summary: "Unsaved data lost", sourceType: "system", confidence: 0.7 });
    const delay = await world.recordEvent({ tenantId: "tenant", entityIds: [server.id], summary: "Delivery delayed", sourceType: "system", confidence: 0.7 });
    await world.assertCausality({ tenantId: "tenant", causeKind: "event", causeRef: outage.id, effectKind: "event", effectRef: dataLoss.id, description: "Outage loses unsaved data.", strength: 0.8, confidence: 0.8 });
    await world.assertCausality({ tenantId: "tenant", causeKind: "event", causeRef: dataLoss.id, effectKind: "event", effectRef: delay.id, description: "Lost data delays delivery.", strength: 0.6, confidence: 0.7 });
    const simulation = await world.simulate({ tenantId: "tenant", premise: "The server goes down tonight", startKind: "event", startRef: outage.id, depth: 3 });
    expect(simulation.steps).toHaveLength(2);
    expect(simulation.terminalProbability).toBeGreaterThan(0);
    expect(simulation.uncertainty).toBeLessThan(1);
    const counterfactual = await world.simulate({ tenantId: "tenant", premise: "What if the outage never happened?", startKind: "event", startRef: outage.id, mode: "counterfactual" });
    expect(counterfactual.notes.some((note) => note.includes("Counterfactual"))).toBe(true);
    expect((await world.events("tenant")).length).toBe(3);
  });

  it("isolates tenants and validates references", async () => {
    const world = await worldService();
    const entity = await world.upsertEntity({ tenantId: "tenant", type: "tool", name: "Editor" });
    await expect(world.recordState({ tenantId: "other", entityId: entity.id, key: "state", value: "open", sourceType: "system", confidence: 0.5 })).rejects.toThrow("not found");
    await expect(world.assertCausality({ tenantId: "tenant", causeKind: "event", causeRef: "missing", effectKind: "event", effectRef: "missing", description: "x" })).rejects.toThrow("not found");
    await expect(world.predict({ tenantId: "tenant", statement: "past", probability: 0.5, horizonAt: new Date(Date.now() - 1000).toISOString() })).rejects.toThrow("future");
  });
});

describe("Aurora Phase D multi-world model", () => {
  async function multi(): Promise<MultiWorldModelService> {
    const root = await mkdtemp(join(tmpdir(), "haf-aurora-multiworld-"));
    return new MultiWorldModelService(root);
  }

  it("seeds the twelve PDF perspectives and weights them by problem type", async () => {
    const service = await multi();
    const perspectives = await service.perspectives("tenant");
    expect(perspectives).toHaveLength(12);
    expect(perspectives.map((item) => item.code)).toContain("WM-07");
    const analysis = await service.createAnalysis({ tenantId: "tenant", question: "Should we expose a public API?", problemType: "security" });
    const security = perspectives.find((item) => item.code === "WM-07")!;
    const creativity = perspectives.find((item) => item.code === "WM-09")!;
    expect(analysis.weights[security.id]!).toBeGreaterThan(analysis.weights[creativity.id]!);
  });

  it("preserves dissent, missing perspectives and unresolved conflicts in the consensus", async () => {
    const service = await multi();
    const perspectives = await service.perspectives("tenant");
    const [technical, risk, economic] = [perspectives[0]!, perspectives[2]!, perspectives[1]!];
    const analysis = await service.createAnalysis({ tenantId: "tenant", question: "Ship the self-improvement loop?", problemType: "technical", perspectiveIds: [technical.id, risk.id, economic.id] });
    await service.submitView({ tenantId: "tenant", analysisId: analysis.id, perspectiveId: technical.id, stance: "support", confidence: 0.9, rationale: "Technically feasible." });
    await service.submitView({ tenantId: "tenant", analysisId: analysis.id, perspectiveId: risk.id, stance: "oppose", confidence: 0.8, rationale: "Uncontrolled self-promotion is dangerous." });
    const conflict = await service.challenge({ tenantId: "tenant", analysisId: analysis.id, fromPerspectiveId: risk.id, targetPerspectiveId: technical.id, argument: "Feasibility does not imply safety." });
    const held = await service.resolveAnalysis("tenant", analysis.id, { minimumViews: 2 });
    expect(held.consensus?.decision).not.toBe("proceed");
    expect(held.consensus?.unresolvedConflictIds).toEqual([conflict.id]);
    expect(held.consensus?.dissentPerspectiveIds.length).toBeGreaterThan(0);
    expect(held.consensus?.missingPerspectiveIds).toEqual([economic.id]);
    expect(held.consensus?.uncertainty).toBeGreaterThan(0);
    await expect(service.resolveAnalysis("tenant", analysis.id)).rejects.toThrow("already resolved");
  });

  it("builds a probability-bounded future tree and calibrates perspective reputation from reality", async () => {
    const service = await multi();
    const perspectives = await service.perspectives("tenant");
    const opportunity = perspectives.find((item) => item.code === "WM-04")!;
    const analysis = await service.createAnalysis({ tenantId: "tenant", question: "Will hardware access arrive?", problemType: "strategic" });
    const optimistic = await service.addScenario({ tenantId: "tenant", analysisId: analysis.id, name: "Access granted", description: "Hardware access is granted.", probability: 0.25, endorsingPerspectiveIds: [opportunity.id] });
    await service.addScenario({ tenantId: "tenant", analysisId: analysis.id, name: "Access denied", description: "Hardware access is denied.", probability: 0.55 });
    await expect(service.addScenario({ tenantId: "tenant", analysisId: analysis.id, name: "Overflow", description: "Impossible branch.", probability: 0.5 })).rejects.toThrow("cannot exceed 1");
    await service.addScenario({ tenantId: "tenant", analysisId: analysis.id, name: "Simulator fallback", description: "A simulator is used.", probability: 0.6, parentScenarioId: optimistic.id });
    const tree = await service.futureTree("tenant", analysis.id);
    const child = tree.find((item) => item.scenario.name === "Simulator fallback")!;
    expect(child.cumulativeProbability).toBeCloseTo(0.15, 5);
    const outcome = await service.recordScenarioOutcome({ tenantId: "tenant", analysisId: analysis.id, scenarioId: optimistic.id, occurred: false });
    expect(outcome.scenario.brierScore).toBeCloseTo(0.0625, 5);
    expect(outcome.updatedPerspectives[0]?.resolvedPredictions).toBe(1);
    expect(outcome.updatedPerspectives[0]?.reputation).toBeGreaterThan(0.5);
    await expect(service.recordScenarioOutcome({ tenantId: "tenant", analysisId: analysis.id, scenarioId: optimistic.id, occurred: true })).rejects.toThrow("already recorded");
  });
});
