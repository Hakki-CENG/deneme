/**
 * F5 (P1.26): the future tree carries cost/risk/benefit, not just probability.
 *
 * What was measured before this existed: `futureTree` returned cumulative
 * branch probabilities — the "branching futures" and "probability estimate"
 * halves of P1.26 — while "cost/risk/benefit" existed nowhere in the scenario
 * model. A tree that cannot say what a branch costs or returns can rank
 * futures by likelihood but never by worth.
 *
 * The rule this file enforces: a missing estimate stays missing. A branch
 * with no cost/benefit gets NO expected value — not zero — and is counted in
 * `unmeasuredBranches`, because "we don't know what this costs" and "this
 * costs nothing" are different branches of different decisions.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MultiWorldModelService } from "../src/world/multi-world-model-service.js";

async function service() {
  const root = await mkdtemp(join(tmpdir(), "haf-mwft-"));
  return new MultiWorldModelService(root);
}

async function analysisWithScenarios() {
  const s = await service();
  const tenant = "t";
  const analysis = await s.createAnalysis({ tenantId: tenant, question: "Ship on Friday?", problemType: "operational" });
  return { s, tenant, analysisId: analysis.id };
}

describe("the future tree's expected value (F5)", () => {
  it("computes EV only where cost AND benefit are both measured, on cumulative probability", async () => {
    const { s, tenant, analysisId } = await analysisWithScenarios();

    const good = await s.addScenario({
      tenantId: tenant, analysisId, name: "smooth release",
      description: "d", probability: 0.5, cost: 0.2, benefit: 0.8,
    });
    await s.addScenario({
      tenantId: tenant, analysisId, name: "unmeasured outcome",
      description: "d", probability: 0.5,
    });
    await s.addScenario({
      tenantId: tenant, analysisId, name: "regression found late",
      description: "d", probability: 0.4, parentScenarioId: good.id, cost: 0.1, benefit: 0.9,
    });

    const branches = await s.futureTree(tenant, analysisId);
    const byName = new Map(branches.map((branch) => [branch.scenario.name, branch]));

    // Root: 0.5 × (0.8 − 0.2) = 0.3.
    expect(byName.get("smooth release")!.expectedValue).toBeCloseTo(0.3, 10);
    // Child: cumulative 0.5 × 0.4 = 0.2, then × (0.9 − 0.1) = 0.16.
    expect(byName.get("regression found late")!.expectedValue).toBeCloseTo(0.16, 10);
    // Unmeasured is undefined, not a disguised zero.
    expect(byName.get("unmeasured outcome")!.expectedValue).toBeUndefined();
  });

  it("outlook sums root EVs without double-counting children, and separates unmeasured branches", async () => {
    const { s, tenant, analysisId } = await analysisWithScenarios();
    const good = await s.addScenario({
      tenantId: tenant, analysisId, name: "smooth release",
      description: "d", probability: 0.5, cost: 0.2, benefit: 0.8,
    });
    await s.addScenario({ tenantId: tenant, analysisId, name: "unmeasured outcome", description: "d", probability: 0.5 });
    await s.addScenario({
      tenantId: tenant, analysisId, name: "regression found late",
      description: "d", probability: 0.4, parentScenarioId: good.id, cost: 0.1, benefit: 0.9,
    });

    const outlook = await s.futureTreeOutlook(tenant, analysisId);
    // Only the measured ROOT contributes (the child's EV is not added on top).
    expect(outlook.rootExpectedValue).toBeCloseTo(0.3, 10);
    expect(outlook.measuredBranches).toBe(2);
    expect(outlook.unmeasuredBranches).toBe(1);
    expect(outlook.riskMass).toBe(0);
  });

  it("risk mass is the probability sitting on measured net-negative roots, and an all-unmeasured tree has no EV at all", async () => {
    const s = await service();
    const tenant = "risk-t";
    const analysis = await s.createAnalysis({ tenantId: tenant, question: "Migrate the database?", problemType: "technical" });
    await s.addScenario({ tenantId: tenant, analysisId: analysis.id, name: "data loss", description: "d", probability: 0.6, cost: 0.8, benefit: 0.1 });
    await s.addScenario({ tenantId: tenant, analysisId: analysis.id, name: "clean migration", description: "d", probability: 0.4, cost: 0.1, benefit: 0.5 });

    const outlook = await s.futureTreeOutlook(tenant, analysis.id);
    // 0.6 × (0.1 − 0.8) + 0.4 × (0.5 − 0.1) = −0.42 + 0.16 = −0.26.
    expect(outlook.rootExpectedValue).toBeCloseTo(-0.26, 10);
    // The net-negative root carries 0.6 of the probability mass — that is the risk.
    expect(outlook.riskMass).toBeCloseTo(0.6, 10);

    const bare = await service();
    const bareAnalysis = await bare.createAnalysis({ tenantId: "bare-t", question: "Anything?", problemType: "general" });
    await bare.addScenario({ tenantId: "bare-t", analysisId: bareAnalysis.id, name: "only branch", description: "d", probability: 1 });
    const bareOutlook = await bare.futureTreeOutlook("bare-t", bareAnalysis.id);
    // No measurement anywhere: the honest outlook is "no EV", not 0.
    expect(bareOutlook.rootExpectedValue).toBeUndefined();
    expect(bareOutlook.unmeasuredBranches).toBe(1);
    expect(bareOutlook.riskMass).toBe(0);
  });

  it("validates the estimates it accepts", async () => {
    const { s, tenant, analysisId } = await analysisWithScenarios();
    await expect(
      s.addScenario({ tenantId: tenant, analysisId, name: "bad cost", description: "d", probability: 0.5, cost: 1.5, benefit: 0.5 }),
    ).rejects.toThrow(/Scenario cost/);
    await expect(
      s.addScenario({ tenantId: tenant, analysisId, name: "bad benefit", description: "d", probability: 0.5, cost: 0.5, benefit: -0.1 }),
    ).rejects.toThrow(/Scenario benefit/);
  });
});
