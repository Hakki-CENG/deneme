import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

/**
 * One end-to-end journey through the whole Aurora organism, using only governed services:
 *
 *   world signal -> intake -> initiative -> attention -> memory -> multi-perspective analysis ->
 *   constitutional review -> decision -> plan -> environment action -> verification ->
 *   consolidation -> ACOS cycle -> provenance explanation
 *
 * The point of this test is not any single subsystem; it is that the seams hold: every stage reads
 * state the previous stage actually wrote, and the final explanation can reconstruct the chain.
 */
describe("Aurora end-to-end journey", () => {
  it("carries one real signal from observation to explained, verified action", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-aurora-journey-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
    });
    const tenantId = "local";

    // 1. The world changes and Aurora observes it.
    const repo = await engine.worldModel.upsertEntity({ tenantId, type: "project", name: "Aurora repo", scope: "digital", importance: 0.9 });
    const outage = await engine.worldModel.recordEvent({
      tenantId, entityIds: [repo.id], summary: "Backup remote unreachable for three nights",
      sourceType: "system", confidence: 0.9, importance: 0.9, userRelevance: 0.9,
    });
    const intake = await engine.initiative.ingest({ tenantId, source: "git", summary: "Backup remote unreachable for three nights.", tags: ["backup"] });

    // 2. It becomes a scored initiative and competes for attention under the constitutional budget.
    const initiative = await engine.initiative.propose({
      tenantId, kind: "risk", title: "Backup remote is unreachable",
      message: "The mirror remote has rejected the nightly push three times; the repository is effectively unbacked.",
      importance: 0.95, urgency: 0.9, impact: 0.95, confidence: 0.9, userRelevance: 0.95,
      mode: "guardian", intakeEventIds: [intake.id],
    });
    const evaluation = await engine.initiative.evaluate(tenantId);
    expect(evaluation.queued.map((item) => item.id)).toContain(initiative.id);
    const mirrored = (await engine.cognitive.objects(tenantId)).find((item) => item.sourceId === initiative.id);
    expect(mirrored?.kind).toBe("risk");

    // 3. Aurora records what it knows, with provenance and confidence.
    const memory = await engine.memoryGraph.remember({
      tenantId, layer: "procedural", claimType: "observation", title: "Backup runbook",
      content: "Re-add the mirror remote and push main; verify with git ls-remote before declaring success.",
      sourceType: "agent", confidence: 0.8, importance: 0.8, tags: ["backup", "runbook"], evidenceRefs: [outage.id],
    });

    // 4. Multiple perspectives argue before anything is chosen, and dissent survives.
    const perspectives = await engine.multiWorld.perspectives(tenantId);
    const security = perspectives.find((item) => item.code === "WM-07")!;
    const economic = perspectives.find((item) => item.code === "WM-02")!;
    const analysis = await engine.multiWorld.createAnalysis({
      tenantId, question: "Restore the mirror remote or move backups to object storage?",
      problemType: "security", perspectiveIds: [security.id, economic.id],
    });
    await engine.multiWorld.submitView({ tenantId, analysisId: analysis.id, perspectiveId: security.id, stance: "support", confidence: 0.9, rationale: "An unbacked repository is the larger risk." });
    await engine.multiWorld.submitView({ tenantId, analysisId: analysis.id, perspectiveId: economic.id, stance: "oppose", confidence: 0.6, rationale: "Object storage costs more per month." });
    const resolved = await engine.multiWorld.resolveAnalysis(tenantId, analysis.id, { minimumViews: 2 });
    expect(resolved.consensus?.dissentPerspectiveIds.length).toBeGreaterThan(0);

    // 5. The constitution reviews the intended action before it is decided.
    const verdict = await engine.constitution.check({
      tenantId, actor: "planning-director", summary: "Restore the backup mirror remote",
      attributes: { externalSideEffect: true, verificationPlanned: true, hasEvidence: true, claimType: "observation", confidence: 0.8, dissentPreserved: true, autonomous: true },
    });
    expect(verdict.verdict).toBe("allow");

    // 6. A decision is made with explicit criteria and a falsifiable expectation.
    const decision = await engine.decisions.open({
      tenantId, title: "Backup restoration approach", question: "How do we restore backups today?",
      reversibility: "reversible",
      criteria: [{ name: "risk-reduction", weight: 0.6 }, { name: "cost", weight: 0.4, direction: "minimize" }],
      analysisId: analysis.id, evidenceRefs: [memory.id],
    });
    await engine.decisions.addOption({ tenantId, decisionId: decision.id, name: "Re-add mirror remote", scores: { "risk-reduction": 0.8, cost: 0.1 } });
    await engine.decisions.addOption({ tenantId, decisionId: decision.id, name: "Move to object storage", scores: { "risk-reduction": 0.9, cost: 0.7 } });
    await engine.decisions.recordDissent({ tenantId, decisionId: decision.id, source: "WM-02", concern: "Object storage has a recurring cost." });
    const decided = await engine.decisions.decide({
      tenantId, decisionId: decision.id, rationale: "Restore the cheap path today; revisit storage next quarter.",
      expectedOutcome: "The mirror remote accepts a push and ls-remote confirms the head.",
      constitutionVerdictId: verdict.id, constitutionVerdict: verdict.verdict, reviewInDays: 7,
    });
    expect(decided.chosenOptionId).toBeTruthy();

    // 7. The decision becomes an executable plan with verification built in.
    const plan = await engine.planning.create({
      tenantId, title: "Restore backup mirror", objective: "Return the repository to a backed-up state",
      decisionId: decision.id, horizon: "reactive",
      steps: [
        { key: "inspect", title: "Inspect remotes", estimateMinutes: 5, verification: "git remote -v lists the mirror" },
        { key: "readd", title: "Re-add mirror remote", dependsOn: ["inspect"], estimateMinutes: 10, riskLevel: 0.3, verification: "git ls-remote succeeds" },
        { key: "push", title: "Push main", dependsOn: ["readd"], estimateMinutes: 10, riskLevel: 0.4, verification: "remote head matches local head" },
      ],
    });
    expect(plan.criticalPath).toEqual(["inspect", "readd", "push"]);

    // 8. The action is planned, executed and — crucially — verified against a resource with reputation.
    const resource = await engine.environment.registerResource({ tenantId, kind: "git", name: "Aurora repo", locator: "/workspaces/aurora/.git", zone: 2 });
    const risk = await engine.riskAnalyzer.assess({ tenantId, capabilityId: "git.push", declaredRisk: "external_side_effect", args: { command: "git push mirror main" } });
    expect(risk.level).not.toBe("critical");
    const action = await engine.environment.planAction({
      tenantId, resourceId: resource.id, goal: "Restore the backup mirror",
      plan: ["Inspect remotes", "Re-add mirror", "Push main"], action: "git.push",
      expectedOutcome: "Mirror remote contains the current head.",
    });
    await engine.environment.startAction(tenantId, action.id);
    await engine.environment.completeAction({ tenantId, actionId: action.id, success: true, summary: "Pushed 42 commits to mirror.", durationMs: 4200 });
    const verified = await engine.environment.verifyAction({
      tenantId, actionId: action.id, method: "git ls-remote mirror", passed: true,
      evidenceRefs: [outage.id], memoryUpdateRefs: [memory.id],
    });
    expect(verified.status).toBe("verified");
    for (const key of ["inspect", "readd", "push"]) {
      await engine.planning.updateStep({ tenantId, planId: plan.id, stepKey: key, status: "done", actualMinutes: 8 });
    }
    expect((await engine.planning.get(tenantId, plan.id)).status).toBe("completed");

    // 9. Reality feeds back: the decision is reviewed and the world model learns.
    const reviewed = await engine.decisions.recordOutcome({ tenantId, decisionId: decision.id, succeeded: true, note: "Mirror restored and verified." });
    expect(reviewed.outcome?.surprise).toBeLessThan(0.5);
    await engine.worldModel.recordState({ tenantId, entityId: repo.id, key: "backup", value: "healthy", sourceType: "agent", confidence: 0.9 });
    expect((await engine.worldModel.stateAt(tenantId, repo.id))["backup"]?.value).toBe("healthy");

    // 10. The organism runs a full cycle and the whole chain is explainable afterwards.
    const cycle = await engine.acos.tick(tenantId);
    expect(cycle.phases.every((item) => item.status !== "failed")).toBe(true);
    expect(cycle.constitutionVerdict).toBe("allow");

    const trace = await engine.provenance.explain({ tenantId, kind: "environment-action", id: action.id, depth: 3 });
    expect(trace.nodes.map((item) => item.kind)).toEqual(expect.arrayContaining(["environment-action", "environment-resource", "memory"]));
    const decisionTrace = await engine.provenance.explain({ tenantId, kind: "decision", id: decision.id, depth: 3 });
    expect(decisionTrace.nodes.map((item) => item.kind)).toContain("constitution-verdict");
    expect(decisionTrace.narrative.join(" ")).toContain("dissent");
    const planTrace = await engine.provenance.explain({ tenantId, kind: "plan", id: plan.id, depth: 3 });
    expect(planTrace.nodes.map((item) => item.kind)).toContain("decision");

    // 11. Status reflects the journey across every subsystem.
    const status = await engine.acos.status(tenantId) as Record<string, any>;
    expect(status["decisions"].reviewed).toBe(1);
    expect(status["plans"].active).toBe(0);
    expect(status["environment"].verificationDebt).toBe(0);
    expect(status["memory"].total).toBeGreaterThan(0);
    expect(status["identity"].version).toBe(1);

    await engine.shutdown();
  }, 60_000);
});
