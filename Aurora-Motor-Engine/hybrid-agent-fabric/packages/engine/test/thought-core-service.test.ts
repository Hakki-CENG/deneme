/**
 * Thought Loop Architecture — ThoughtCoreService.
 *
 * This suite exists because the service was the largest untested module in the
 * engine (1189 lines, zero tests) while being wired into `engine.ts`, exposed as
 * `thought.*` capabilities and reachable over REST.
 *
 * The assertions target behaviour that would silently rot: the state machine's
 * activation accounting, priority derivation, tenant isolation, the research
 * queue's ordering contract, input bounds, and durability across instances.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { ThoughtCoreService } from "../src/thought/thought-core-service.js";

const TENANT = "local";
const OTHER = "other-tenant";

let root: string;
let clock: number;
let service: ThoughtCoreService;

/** Deterministic clock: every `tick()` advances exactly one second. */
const now = () => clock;
const tick = () => {
  clock += 1000;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thought-core-"));
  clock = Date.UTC(2026, 0, 1, 0, 0, 0);
  service = new ThoughtCoreService(root, now);
  await service.initialize();
});

function newThought(overrides: Partial<Parameters<ThoughtCoreService["createThought"]>[0]> = {}) {
  return service.createThought({
    tenantId: TENANT,
    title: "Why does the recall gate regress on paraphrases",
    content: "Hybrid search matches term overlap, so a paraphrased query returns nothing.",
    type: "problem",
    sourceType: "user",
    ...overrides,
  });
}

describe("thought creation and validation", () => {
  it("creates a thought in the 'new' state with bounded, trimmed fields", async () => {
    const thought = await newThought({ title: "  padded title  " });

    expect(thought.id).toMatch(/^thought-[0-9a-f-]{36}$/);
    expect(thought.tenantId).toBe(TENANT);
    expect(thought.state).toBe("new");
    expect(thought.title).toBe("padded title");
    expect(thought.activationCount).toBe(0);
    expect(thought.hypothesisRefs).toEqual([]);
    expect(thought.relatedThoughtIds).toEqual([]);
    expect(thought.createdAt).toBe(new Date(now()).toISOString());
  });

  it("rejects importance/urgency/impact/confidence/userRelevance outside 0..1", async () => {
    for (const field of ["importance", "urgency", "impact", "confidence", "userRelevance"] as const) {
      await expect(newThought({ [field]: 1.5 })).rejects.toThrow(/must be between 0 and 1/);
      await expect(newThought({ [field]: -0.1 })).rejects.toThrow(/must be between 0 and 1/);
      await expect(newThought({ [field]: Number.NaN })).rejects.toThrow(/must be between 0 and 1/);
    }
  });

  it("rejects an empty title and control characters in text fields", async () => {
    await expect(newThought({ title: "   " })).rejects.toThrow(/Thought title is invalid/);
    await expect(newThought({ content: "has\u0000nul" })).rejects.toThrow(/Thought content is invalid/);
  });

  it("derives priority from the mean of the five unit scores", async () => {
    // mean 1.0 -> P0, 0.6 -> P1, 0.4 -> P2, 0.2 -> P3, 0.0 -> P4
    const all = (value: number) => ({
      importance: value,
      urgency: value,
      impact: value,
      confidence: value,
      userRelevance: value,
    });

    expect((await newThought(all(1))).priority).toBe("P0");
    expect((await newThought(all(0.8))).priority).toBe("P0");
    expect((await newThought(all(0.6))).priority).toBe("P1");
    expect((await newThought(all(0.4))).priority).toBe("P2");
    expect((await newThought(all(0.2))).priority).toBe("P3");
    expect((await newThought(all(0))).priority).toBe("P4");
  });

  it("honours an explicit priority over the derived one, and weights the score by it", async () => {
    const derived = await newThought({ importance: 1, urgency: 1, impact: 1, confidence: 1, userRelevance: 1 });
    const forced = await newThought({
      importance: 1,
      urgency: 1,
      impact: 1,
      confidence: 1,
      userRelevance: 1,
      priority: "P4",
    });

    expect(derived.priority).toBe("P0");
    expect(forced.priority).toBe("P4");
    // Same unit scores, but P4 carries weight 0.2 against P0's 1.0.
    expect(forced.priorityScore).toBeCloseTo(derived.priorityScore * 0.2, 6);
  });
});

describe("thought state machine", () => {
  it("counts an activation only when leaving waiting or blocked", async () => {
    const thought = await newThought();

    // new -> active is not a re-activation.
    expect((await service.activateThought(TENANT, thought.id)).activationCount).toBe(0);
    // active -> researching -> active is still not one.
    await service.startResearching(TENANT, thought.id);
    expect((await service.activateThought(TENANT, thought.id)).activationCount).toBe(0);

    // waiting -> active IS one, and stamps lastActivatedAt.
    await service.setWaiting(TENANT, thought.id);
    tick();
    const reactivated = await service.activateThought(TENANT, thought.id);
    expect(reactivated.activationCount).toBe(1);
    expect(reactivated.lastActivatedAt).toBe(new Date(now()).toISOString());

    // blocked -> active is another.
    await service.blockThought(TENANT, thought.id);
    tick();
    expect((await service.activateThought(TENANT, thought.id)).activationCount).toBe(2);
  });

  it("records a block reason as a sanitized, deduplicated tag", async () => {
    const thought = await newThought();

    const blocked = await service.blockThought(TENANT, thought.id, "Waiting on User Input!");
    expect(blocked.state).toBe("blocked");
    expect(blocked.tags).toContain("blocked:waiting-on-user-input");

    // The same reason twice must not duplicate the tag.
    const again = await service.blockThought(TENANT, thought.id, "Waiting on User Input!");
    expect(again.tags.filter((tag) => tag === "blocked:waiting-on-user-input")).toHaveLength(1);
  });

  it("normalizes a block reason so punctuation variants collapse to one tag", async () => {
    const thought = await newThought();

    // Regression: the slug used to keep a trailing separator, so "needs review"
    // and "needs review!" produced two distinct tags for one reason.
    await service.blockThought(TENANT, thought.id, "needs review");
    const variant = await service.blockThought(TENANT, thought.id, "needs review!!!");
    expect(variant.tags.filter((tag) => tag.startsWith("blocked:"))).toEqual(["blocked:needs-review"]);

    // Leading separators collapse too.
    const leading = await service.blockThought(TENANT, thought.id, "  ...upstream outage  ");
    expect(leading.tags.filter((tag) => tag.startsWith("blocked:"))).toEqual([
      "blocked:needs-review",
      "blocked:upstream-outage",
    ]);

    // A reason that is nothing but punctuation carries no information; it must
    // not add a bare `blocked:` tag.
    const punctuated = await service.blockThought(TENANT, thought.id, "!!!");
    expect(punctuated.tags.filter((tag) => tag.startsWith("blocked:"))).toEqual([
      "blocked:needs-review",
      "blocked:upstream-outage",
    ]);
  });

  it("appends the solution to the content when solving", async () => {
    const thought = await newThought();
    const solved = await service.solveThought(TENANT, thought.id, "Wire a real embedding model.");

    expect(solved.state).toBe("solved");
    expect(solved.content).toBe(`${thought.content}\n\n[SOLUTION] Wire a real embedding model.`);
  });

  it("leaves the content untouched when solving without a solution", async () => {
    const thought = await newThought();
    const solved = await service.solveThought(TENANT, thought.id);
    expect(solved.content).toBe(thought.content);
  });
});

describe("tenant isolation", () => {
  it("refuses to mutate another tenant's thought, even by exact id", async () => {
    const thought = await newThought();

    await expect(service.activateThought(OTHER, thought.id)).rejects.toThrow(
      /not found in tenant other-tenant/,
    );
    await expect(service.blockThought(OTHER, thought.id, "x")).rejects.toThrow(/not found in tenant/);
    await expect(service.solveThought(OTHER, thought.id)).rejects.toThrow(/not found in tenant/);

    // And the original is unchanged.
    const [listed] = await service.listThoughts(TENANT);
    expect(listed?.state).toBe("new");
  });

  it("lists and counts only the requesting tenant's data", async () => {
    await newThought();
    await newThought({ tenantId: OTHER, title: "another tenant's thought" });

    expect(await service.listThoughts(TENANT)).toHaveLength(1);
    expect(await service.listThoughts(OTHER)).toHaveLength(1);
    expect((await service.getMetrics(TENANT)).totalThoughts).toBe(1);
    expect((await service.getMetrics(OTHER)).totalThoughts).toBe(1);
  });

  it("throws for an unknown thought id rather than inventing one", async () => {
    await expect(service.activateThought(TENANT, "thought-does-not-exist")).rejects.toThrow(/not found/);
  });
});

describe("research queue ordering", () => {
  it("serves by priority, then importance, then creation order", async () => {
    // Created out of order on purpose.
    await service.queueResearch({ tenantId: TENANT, title: "low", topic: "t", priority: "P3", sourceType: "system" });
    await service.queueResearch({ tenantId: TENANT, title: "p1-low-importance", topic: "t", priority: "P1", importance: 0.2, sourceType: "system" });
    tick();
    await service.queueResearch({ tenantId: TENANT, title: "p1-high-importance", topic: "t", priority: "P1", importance: 0.9, sourceType: "system" });
    await service.queueResearch({ tenantId: TENANT, title: "p0", topic: "t", priority: "P0", sourceType: "system" });

    expect((await service.processResearchQueue(TENANT))?.title).toBe("p0");
    expect((await service.processResearchQueue(TENANT))?.title).toBe("p1-high-importance");
    expect((await service.processResearchQueue(TENANT))?.title).toBe("p1-low-importance");
    expect((await service.processResearchQueue(TENANT))?.title).toBe("low");
    // Queue drained: an empty queue is null, not an error and not a fake item.
    expect(await service.processResearchQueue(TENANT)).toBeNull();
  });

  it("marks the served item in-progress so it is not served twice", async () => {
    await service.queueResearch({ tenantId: TENANT, title: "only", topic: "t", sourceType: "research" });
    const first = await service.processResearchQueue(TENANT);
    expect(first?.status).toBe("in-progress");
    expect(await service.processResearchQueue(TENANT)).toBeNull();
  });

  it("completes an item with notes and rejects an unknown id", async () => {
    await service.queueResearch({ tenantId: TENANT, title: "only", topic: "t", sourceType: "research" });
    const item = await service.processResearchQueue(TENANT);

    const done = await service.completeResearch(TENANT, item!.id, "Confirmed by measurement.");
    expect(done.status).toBe("completed");
    expect(done.completionNotes).toBe("Confirmed by measurement.");

    await expect(service.completeResearch(TENANT, "item-missing")).rejects.toThrow(/not found/);
    await expect(service.completeResearch(OTHER, item!.id)).rejects.toThrow(/not found/);
  });
});

describe("hypotheses, open problems, dialogues and journal", () => {
  it("tracks hypothesis status transitions with evidence", async () => {
    const thought = await newThought();
    const hypothesis = await service.createHypothesis({
      tenantId: TENANT,
      statement: "The hash encoder cannot separate paraphrases.",
      thoughtId: thought.id,
      confidence: 0.7,
    });

    expect(hypothesis.status).toBe("new");
    expect(hypothesis.evidenceFor).toEqual([]);

    const confirmed = await service.updateHypothesisStatus(
      TENANT,
      hypothesis.id,
      "confirmed",
      ["recall-gate run 1"],
      [],
    );
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.evidenceFor).toEqual(["recall-gate run 1"]);

    await expect(
      service.updateHypothesisStatus(OTHER, hypothesis.id, "refuted"),
    ).rejects.toThrow(/Hypothesis not found/);
  });

  it("accumulates findings on an open problem and validates confidence", async () => {
    const problem = await service.createOpenProblem({
      tenantId: TENANT,
      title: "Recall gate margin",
      description: "Hybrid beats bm25 by less than the 0.05 margin.",
      category: "retrieval",
    });
    expect(problem.status).toBe("open");
    expect(problem.findings).toEqual([]);

    const withFinding = await service.addProblemFinding({
      tenantId: TENANT,
      problemId: problem.id,
      summary: "13 ties, 1 win, 1 loss across 15 queries.",
      confidence: 0.8,
    });
    expect(withFinding.findings).toHaveLength(1);
    expect(withFinding.findings[0]?.summary).toContain("13 ties");

    await expect(
      service.addProblemFinding({ tenantId: TENANT, problemId: problem.id, summary: "x", confidence: 4 }),
    ).rejects.toThrow(/between 0 and 1/);
    await expect(
      service.addProblemFinding({ tenantId: TENANT, problemId: "problem-missing", summary: "x", confidence: 0.5 }),
    ).rejects.toThrow(/not found/);
  });

  it("runs a self dialogue to a recorded conclusion", async () => {
    const dialogue = await service.startSelfDialogue({
      tenantId: TENANT,
      topic: "Should the recall gate use a real encoder?",
      initialStatement: "The hash encoder cannot measure semantic recall.",
      initialAgentId: "critic",
      initialRole: "critic",
    });
    expect(dialogue.status).toBe("open");
    expect(dialogue.participants).toHaveLength(1);

    const withReply = await service.addDialogueParticipant({
      tenantId: TENANT,
      dialogueId: dialogue.id,
      agentId: "defender",
      role: "defender",
      statement: "Then run it nightly against a real embedding endpoint.",
      confidence: 0.6,
    });
    expect(withReply.participants).toHaveLength(2);

    const resolved = await service.resolveSelfDialogue(TENANT, dialogue.id, "Run the real gate nightly.");
    expect(resolved.status).toBe("resolved");
    expect(resolved.conclusion).toBe("Run the real gate nightly.");

    await expect(
      service.addDialogueParticipant({
        tenantId: OTHER,
        dialogueId: dialogue.id,
        agentId: "x",
        role: "y",
        statement: "z",
      }),
    ).rejects.toThrow(/not found/);
  });

  it("records journal entries with their references", async () => {
    const thought = await newThought();
    const entry = await service.addJournalEntry({
      tenantId: TENANT,
      summary: "Opened the recall-margin problem.",
      detail: "Measured 0.022 delta against a 0.05 margin.",
      thoughtIds: [thought.id],
      tags: ["recall"],
    });

    expect(entry.thoughtIds).toEqual([thought.id]);
    expect(entry.tags).toContain("recall");

    const journal = await service.listJournal(TENANT);
    expect(journal).toHaveLength(1);
    expect(await service.listJournal(OTHER)).toHaveLength(0);
  });
});

describe("metrics, filtering and durability", () => {
  it("counts thoughts by state, type and priority", async () => {
    await newThought({ type: "problem", priority: "P0" });
    await newThought({ type: "insight", priority: "P2" });
    const blocked = await newThought({ type: "risk", priority: "P1" });
    await service.blockThought(TENANT, blocked.id);
    const solved = await newThought({ type: "question", priority: "P3" });
    await service.solveThought(TENANT, solved.id);

    const metrics = await service.getMetrics(TENANT);
    expect(metrics.totalThoughts).toBe(4);
    expect(metrics.byState.new).toBe(2);
    expect(metrics.byState.blocked).toBe(1);
    expect(metrics.byState.solved).toBe(1);
    expect(metrics.byType.problem).toBe(1);
    expect(metrics.byType.insight).toBe(1);
    expect(metrics.byPriority.P0).toBe(1);
    expect(metrics.activeThoughts).toBe(0);
    expect(metrics.blockedThoughts).toBe(1);
    expect(metrics.solvedThoughts).toBe(1);
    expect(metrics.tenantId).toBe(TENANT);
  });

  it("filters listings by state, type, priority and importance", async () => {
    await newThought({ type: "problem", priority: "P0", importance: 0.9 });
    await newThought({ type: "insight", priority: "P3", importance: 0.2 });
    const archived = await newThought({ type: "problem", priority: "P1", importance: 0.5 });
    await service.archiveThought(TENANT, archived.id);

    expect(await service.listThoughts(TENANT, { state: "archived" })).toHaveLength(1);
    expect(await service.listThoughts(TENANT, { type: "problem", state: "new" })).toHaveLength(1);
    expect(await service.listThoughts(TENANT, { priority: "P3" })).toHaveLength(1);
    expect(await service.listThoughts(TENANT, { minImportance: 0.5 })).toHaveLength(2);
    expect(await service.listThoughts(TENANT, { limit: 1 })).toHaveLength(1);

    await expect(service.listThoughts(TENANT, { minImportance: 2 })).rejects.toThrow(/between 0 and 1/);
    await expect(service.listThoughts(TENANT, { limit: 0 })).rejects.toThrow(/Thought limit is invalid/);
  });

  it("persists state to disk and reloads it in a fresh instance", async () => {
    const thought = await newThought({ title: "survives a restart" });
    await service.blockThought(TENANT, thought.id, "needs review");
    await service.close();

    const statePath = join(root, "thought", "core", "state.json");
    const onDisk = JSON.parse(await readFile(statePath, "utf8")) as {
      schemaVersion: number;
      thoughts: Array<{ id: string; state: string }>;
    };
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.thoughts).toHaveLength(1);

    const reopened = new ThoughtCoreService(root, now);
    await reopened.initialize();
    const [reloaded] = await reopened.listThoughts(TENANT);
    expect(reloaded?.title).toBe("survives a restart");
    expect(reloaded?.state).toBe("blocked");
    expect(reloaded?.tags).toContain("blocked:needs-review");
  });

  it("returns a health report for the tenant", async () => {
    await newThought();
    const health = await service.healthCheck(TENANT);
    expect(health).toEqual({ healthy: true, issues: [], recommendations: [] });
  });

  it("flags a tenant where blocked thoughts exceed 30% of the total", async () => {
    // 4 thoughts, 2 blocked = 50% > 30%.
    await newThought({ title: "fine one" });
    await newThought({ title: "fine two" });
    for (const title of ["stuck one", "stuck two"]) {
      const thought = await newThought({ title });
      await service.blockThought(TENANT, thought.id, "conflict");
    }

    const health = await service.healthCheck(TENANT);
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toMatch(/High blocked thoughts ratio: 2\/4/);
    expect(health.recommendations.length).toBeGreaterThan(0);
  });

  it("stays healthy just under the blocked threshold", async () => {
    // 10 thoughts, 3 blocked = 30%, which is NOT strictly greater than 30%.
    for (let index = 0; index < 7; index += 1) await newThought({ title: `fine ${index}` });
    for (let index = 0; index < 3; index += 1) {
      const thought = await newThought({ title: `stuck ${index}` });
      await service.blockThought(TENANT, thought.id, "conflict");
    }

    const health = await service.healthCheck(TENANT);
    expect(health.issues.filter((issue) => issue.startsWith("High blocked"))).toEqual([]);
  });
});
