import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DecisionService } from "../src/aurora/decision-service.js";
import { GoalStackService } from "../src/aurora/goal-stack.js";
import { ConstitutionService } from "../src/aurora/constitution-service.js";

async function decision(): Promise<DecisionService> {
  const root = await mkdtemp(join(tmpdir(), "haf-decision-"));
  return new DecisionService(root);
}
async function goals(): Promise<GoalStackService> {
  const root = await mkdtemp(join(tmpdir(), "haf-goals-"));
  return new GoalStackService(root);
}
async function constitution(): Promise<ConstitutionService> {
  const root = await mkdtemp(join(tmpdir(), "haf-const-"));
  return new ConstitutionService(root);
}

describe("P3: Decision Service Edge Cases", () => {
  it("handles empty options gracefully", async () => {
    const service = await decision();
    const d = await service.open({
      tenantId: "t1", title: "Empty Decision", question: "Which?",
      criteria: [{ name: "quality", weight: 1 }],
    });
    expect(d).toBeDefined();
    expect(d.options).toHaveLength(0);
  });

  it("tracks decision outcome correctly", async () => {
    const service = await decision();
    const d = await service.open({
      tenantId: "t1", title: "Track Outcome", question: "Which?",
      criteria: [{ name: "quality", weight: 1 }],
    });
    await service.addOption({ tenantId: "t1", decisionId: d.id, name: "A", description: "Option A", scores: { quality: 0.8 } });
    
    const updated = await service.get("t1", d.id);
    expect(updated).toBeDefined();
    expect(updated.options.length).toBeGreaterThanOrEqual(1);
  });

  it("why() returns meaningful explanation", async () => {
    const service = await decision();
    const d = await service.open({
      tenantId: "t1", title: "Explain Me", question: "Why?",
      criteria: [{ name: "cost", weight: 0.5 }, { name: "quality", weight: 0.5 }],
    });
    await service.addOption({ tenantId: "t1", decisionId: d.id, name: "Cheap", description: "Low cost", scores: { cost: 0.9, quality: 0.3 } });
    await service.addOption({ tenantId: "t1", decisionId: d.id, name: "Quality", description: "High quality", scores: { cost: 0.3, quality: 0.9 } });
    
    const explanation = await service.why("t1", d.id);
    expect(explanation).toBeDefined();
    expect(explanation.rationale).toBeInstanceOf(Array);
    expect(explanation.criteriaBreakdown).toBeInstanceOf(Array);
    expect(explanation.criteriaBreakdown).toHaveLength(2);
  });

  it("handles tenant isolation", async () => {
    const service = await decision();
    await service.open({ tenantId: "tenant-a", title: "A", question: "A?", criteria: [{ name: "x", weight: 1 }] });
    await service.open({ tenantId: "tenant-b", title: "B", question: "B?", criteria: [{ name: "x", weight: 1 }] });
    
    const listA = await service.list("tenant-a");
    const listB = await service.list("tenant-b");
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0].title).toBe("A");
    expect(listB[0].title).toBe("B");
  });
});

describe("P3: Goal Stack Edge Cases", () => {
  it("handles goal hierarchy", async () => {
    const service = await goals();
    const parent = await service.addGoal("t1", "Parent Goal", "Top level", 8, "Done");
    const child = await service.addGoal("t1", "Child Goal", "Sub task", 5, "Done", parent.id);
    
    expect(child.parentId).toBe(parent.id);
    const active = await service.getActiveGoals("t1");
    expect(active.length).toBeGreaterThanOrEqual(2);
  });

  it("tracks goal progress", async () => {
    const service = await goals();
    const goal = await service.addGoal("t1", "Progress Goal", "Track me", 7, "100%");
    
    await service.updateProgress(goal.id, 0.5, ["blocker1"]);
    const active = await service.getActiveGoals("t1");
    const updated = active.find(g => g.id === goal.id);
    expect(updated?.progress).toBe(0.5);
  });

  it("why() explains goals", async () => {
    const service = await goals();
    const goal = await service.addGoal("t1", "Explain Goal", "Why this goal?", 9, "Done");
    
    const explanation = await service.why("t1", goal.id);
    expect(explanation).toBeDefined();
    expect(explanation.rationale).toBeInstanceOf(Array);
    expect(explanation.goal).toBeDefined();
  });
});

describe("P3: Constitution Edge Cases", () => {
  it("verdicts include principle details", async () => {
    const service = await constitution();
    const principles = await service.principles("t1", "active");
    expect(principles.length).toBeGreaterThan(0);
    
    const projection = await service.projection("t1", 1000);
    expect(projection.text).toBeDefined();
    expect(projection.text.length).toBeLessThanOrEqual(1000);
  });
});
