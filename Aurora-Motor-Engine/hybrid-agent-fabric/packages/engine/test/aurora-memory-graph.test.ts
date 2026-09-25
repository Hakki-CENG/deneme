import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryGraphService } from "../src/memory/memory-graph-service.js";

async function service(now?: () => number): Promise<MemoryGraphService> {
  const root = await mkdtemp(join(tmpdir(), "haf-aurora-memory-"));
  return now ? new MemoryGraphService(root, now) : new MemoryGraphService(root);
}

describe("Aurora Phase C memory pyramid and temporal knowledge graph", () => {
  it("stores memory objects with the full Aurora standard and reinforces duplicates instead of cloning them", async () => {
    const graph = await service();
    const first = await graph.remember({
      tenantId: "tenant", layer: "semantic", claimType: "observation", title: "Qdrant", content: "Qdrant is a vector database.",
      sourceType: "external", sourceId: "docs", confidence: 0.9, importance: 0.7, tags: ["vector", "database"],
    });
    expect(first).toMatchObject({ layer: "semantic", claimType: "observation", confidence: 0.9, usageCount: 0, reinforcementCount: 0 });
    expect(first.validFrom).toBeTruthy();
    const again = await graph.remember({
      tenantId: "tenant", layer: "semantic", claimType: "observation", title: "Qdrant", content: "Qdrant is a vector database.",
      sourceType: "external", confidence: 0.8, importance: 0.9, tags: ["storage"],
    });
    expect(again.id).toBe(first.id);
    expect(again.reinforcementCount).toBe(1);
    expect(again.importance).toBe(0.9);
    expect(again.tags).toContain("storage");
    expect((await graph.list("tenant"))).toHaveLength(1);
  });

  it("keeps tenants isolated and supports semantic, goal and graph recall with usage accounting", async () => {
    const graph = await service();
    const loihi = await graph.remember({ tenantId: "tenant", layer: "semantic", claimType: "observation", title: "Loihi", content: "Loihi is a neuromorphic processor.", sourceType: "external", confidence: 0.95, importance: 0.8, goalIds: ["goal-1"], tags: ["loihi"] });
    const paper = await graph.remember({ tenantId: "tenant", layer: "episodic", claimType: "inference", title: "Neuromorphic paper", content: "A neuromorphic research paper was published today.", sourceType: "agent", confidence: 0.6, importance: 0.6 });
    await graph.remember({ tenantId: "other", layer: "semantic", claimType: "observation", title: "Loihi", content: "Loihi is a neuromorphic processor.", sourceType: "external", confidence: 0.9, importance: 0.9 });
    await graph.relate({ tenantId: "tenant", fromId: loihi.id, toId: paper.id, type: "supports", strength: 0.6 });

    const semantic = await graph.recall("tenant", "neuromorphic processor");
    expect(semantic[0]?.memory.id).toBe(loihi.id);
    expect(semantic.every((item) => item.memory.tenantId === "tenant")).toBe(true);

    const goalScoped = await graph.recall("tenant", "processor", { strategy: "goal", goalId: "goal-1" });
    expect(goalScoped.map((item) => item.memory.id)).toEqual([loihi.id]);

    const graphScoped = await graph.recall("tenant", "paper", { strategy: "graph", seedMemoryId: loihi.id });
    expect(graphScoped.map((item) => item.memory.id)).toContain(paper.id);

    expect((await graph.get("tenant", loihi.id)).usageCount).toBeGreaterThan(0);
    await expect(graph.get("other", paper.id)).rejects.toThrow("not found");
  });

  it("enforces temporal validity, supersession and layer promotion", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const graph = await service(() => now);
    const old = await graph.remember({ tenantId: "tenant", layer: "user", claimType: "observation", title: "Location", content: "The user studies at the university.", sourceType: "user", confidence: 0.9, importance: 0.5 });
    now += 86_400_000;
    const fresh = await graph.remember({ tenantId: "tenant", layer: "user", claimType: "observation", title: "Location", content: "The user moved to a new campus.", sourceType: "user", confidence: 0.9, importance: 0.5 });
    await graph.supersede("tenant", old.id, fresh.id);
    expect((await graph.get("tenant", old.id))).toMatchObject({ state: "superseded", supersededById: fresh.id });
    const temporal = await graph.recall("tenant", "campus", { strategy: "temporal" });
    expect(temporal.map((item) => item.memory.id)).toContain(fresh.id);
    expect(temporal.map((item) => item.memory.id)).not.toContain(old.id);
    expect((await graph.promoteLayer("tenant", fresh.id, "episodic")).layer).toBe("episodic");
  });

  it("consolidates near-duplicate episodes into one summary that keeps provenance edges", async () => {
    const graph = await service();
    const ids: string[] = [];
    for (const suffix of ["one", "two", "three"]) {
      const memory = await graph.remember({
        tenantId: "tenant", layer: "episodic", claimType: "observation",
        title: `Aurora design session ${suffix}`, content: `Worked on the Aurora memory architecture design session ${suffix}.`,
        sourceType: "agent", confidence: 0.7, importance: 0.6, tags: ["aurora", "memory"],
      });
      ids.push(memory.id);
    }
    const report = await graph.consolidate("tenant", { layer: "episodic", similarityThreshold: 0.5 });
    expect(report.clusters).toHaveLength(1);
    expect(report.archived).toBe(3);
    const summaryId = report.clusters[0]!.summaryMemoryId;
    const summary = await graph.get("tenant", summaryId);
    expect(summary.claimType).toBe("inference");
    expect(summary.consolidatedFromIds.sort()).toEqual([...ids].sort());
    for (const id of ids) expect((await graph.get("tenant", id)).state).toBe("archived");
    const relations = await graph.relations("tenant", summaryId);
    expect(relations.every((item) => item.type === "derived-from")).toBe(true);
  });

  it("detects contradictions, reports memory health and forgets on request", async () => {
    const graph = await service();
    const positive = await graph.remember({ tenantId: "tenant", layer: "semantic", claimType: "observation", title: "Backup", content: "The production repository backup is configured and running.", sourceType: "system", confidence: 0.8, importance: 0.9 });
    const negative = await graph.remember({ tenantId: "tenant", layer: "semantic", claimType: "observation", title: "Backup", content: "The production repository backup is not configured and running.", sourceType: "agent", confidence: 0.5, importance: 0.9 });
    const contradictions = await graph.detectContradictions("tenant");
    expect(contradictions).toHaveLength(1);
    expect((await graph.get("tenant", positive.id)).contradictionIds).toContain(negative.id);
    const health = await graph.health("tenant");
    expect(health.contradicted.sort()).toEqual([positive.id, negative.id].sort());
    expect(health.healthScore).toBeLessThan(1);
    const removal = await graph.forget("tenant", negative.id);
    expect(removal.removedRelations).toBeGreaterThan(0);
    expect((await graph.get("tenant", positive.id)).contradictionIds).toHaveLength(0);
  });

  it("keeps long-horizon thought anchors reviewable and expires working memory on sweep", async () => {
    let now = Date.parse("2026-02-01T00:00:00Z");
    const graph = await service(() => now);
    const anchor = await graph.createAnchor({ tenantId: "tenant", title: "AGI research", question: "Which architecture generalizes?", importance: 0.9, nextStep: "Scan new papers", reviewIntervalDays: 7 });
    expect(await graph.dueAnchors("tenant")).toHaveLength(0);
    now += 8 * 86_400_000;
    expect((await graph.dueAnchors("tenant")).map((item) => item.id)).toEqual([anchor.id]);
    const progressed = await graph.recordAnchorProgress({ tenantId: "tenant", anchorId: anchor.id, summary: "No conclusive result yet.", confidence: 0.35, nextStep: "Review three new papers" });
    expect(progressed.findings).toHaveLength(1);
    expect(progressed.confidence).toBe(0.35);
    expect(await graph.dueAnchors("tenant")).toHaveLength(0);

    const working = await graph.remember({ tenantId: "tenant", layer: "working", claimType: "observation", title: "Active thought", content: "Currently editing the memory module.", sourceType: "system", confidence: 0.6, importance: 0.3 });
    now += 60 * 60_000;
    const swept = await graph.sweep("tenant");
    expect(swept.archived).toContain(working.id);
  });

  it("rejects malformed input and bounds graph traversal", async () => {
    const graph = await service();
    await expect(graph.remember({ tenantId: "tenant", layer: "semantic", claimType: "observation", title: "  ", content: "x", sourceType: "system", confidence: 0.5, importance: 0.5 })).rejects.toThrow("invalid");
    const a = await graph.remember({ tenantId: "tenant", layer: "semantic", claimType: "observation", title: "A", content: "Alpha fact.", sourceType: "system", confidence: 1.5 as number, importance: 0.5 }).catch((error: Error) => error);
    expect(a).toBeInstanceOf(Error);
    const left = await graph.remember({ tenantId: "tenant", layer: "semantic", claimType: "observation", title: "A", content: "Alpha fact.", sourceType: "system", confidence: 0.5, importance: 0.5 });
    await expect(graph.relate({ tenantId: "tenant", fromId: left.id, toId: left.id, type: "relates" })).rejects.toThrow("distinct");
    await expect(graph.neighborhood("tenant", left.id, 9)).rejects.toThrow("invalid");
  });

  it("persists state atomically as bounded JSON on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-aurora-memory-disk-"));
    const graph = new MemoryGraphService(root);
    const memory = await graph.remember({ tenantId: "tenant", layer: "palace", claimType: "hypothesis", title: "World model", content: "A world model may improve prediction quality.", sourceType: "agent", confidence: 0.4, importance: 0.8 });
    const raw = JSON.parse(await readFile(join(root, "memory-graph", "state.json"), "utf8")) as { schemaVersion: number; memories: Array<{ id: string }> };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.memories.map((item) => item.id)).toContain(memory.id);
    const reopened = new MemoryGraphService(root);
    expect((await reopened.get("tenant", memory.id)).title).toBe("World model");
  });
});
