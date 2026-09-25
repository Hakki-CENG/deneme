/**
 * Causal graph — path finding and impact analysis.
 *
 * The previous version asserted `paths).toBeInstanceOf(Array)` and
 * `impact.downstreamEffects).toBeInstanceOf(Array)`. An implementation that
 * returned `[]` for every query satisfied all of it, so traversal was never
 * actually tested.
 *
 * These assert the traversal result: which nodes a path runs through, that an
 * unreachable node yields no path, and that impact analysis distinguishes a
 * connected node from an isolated one.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CausalGraphService } from "../src/aurora/causal-graph.js";

async function causalGraph(): Promise<CausalGraphService> {
  const root = await mkdtemp(join(tmpdir(), "haf-causal-"));
  return new CausalGraphService(root);
}

describe("P2: Causal Graph — Impact Analysis", () => {
  it("adds nodes and edges to the graph", async () => {
    const service = await causalGraph();

    const node1 = await service.addNode("API Latency", "metric", "Response time for API calls");
    const node2 = await service.addNode("User Satisfaction", "outcome", "How satisfied users are");

    const edge = await service.addEdge(node1.id, node2.id, "causes", 0.8, 0.9);
    expect(edge.fromId).toBe(node1.id);
    expect(edge.toId).toBe(node2.id);
    expect(edge.strength).toBeCloseTo(0.8, 6);
    expect(edge.confidence).toBeCloseTo(0.9, 6);
  });

  it("traverses a multi-hop chain and reports the route taken", async () => {
    const service = await causalGraph();

    const n1 = await service.addNode("Root Cause", "event", "Initial event");
    const n2 = await service.addNode("Intermediate", "event", "Middle event");
    const n3 = await service.addNode("Effect", "outcome", "Final effect");

    await service.addEdge(n1.id, n2.id, "causes", 0.9, 0.8);
    await service.addEdge(n2.id, n3.id, "causes", 0.7, 0.9);

    const paths = await service.findPaths(n1.id, n3.id);

    // A real traversal: two hops, in order, through the intermediate node.
    expect(paths).toHaveLength(1);
    expect(paths[0]?.nodes).toEqual([n1.id, n2.id, n3.id]);
    expect(paths[0]?.edges).toHaveLength(2);
    expect(paths[0]?.description).toBe("Root Cause → Intermediate → Effect");

    // Strength combines both edges (mean of 0.9 and 0.7) rather than
    // reporting whichever one it saw last.
    expect(paths[0]?.totalStrength).toBeCloseTo(0.8, 6);
  });

  it("returns no path to an unreachable node", async () => {
    const service = await causalGraph();

    const n1 = await service.addNode("Root Cause", "event", "Initial event");
    const n2 = await service.addNode("Intermediate", "event", "Middle event");
    const isolated = await service.addNode("Isolated", "event", "No edges");
    await service.addEdge(n1.id, n2.id, "causes", 0.9, 0.8);

    // The control for the test above: without this, a function returning a
    // fabricated path for any pair would still pass.
    expect(await service.findPaths(n1.id, isolated.id)).toEqual([]);
  });

  it("names the downstream nodes a change would affect", async () => {
    const service = await causalGraph();

    const root = await service.addNode("System Change", "event", "Major system change");
    const effect1 = await service.addNode("Performance", "metric", "System performance");
    const effect2 = await service.addNode("Reliability", "metric", "System reliability");

    await service.addEdge(root.id, effect1.id, "affects", 0.9, 0.8);
    await service.addEdge(root.id, effect2.id, "affects", 0.7, 0.9);

    const impact = await service.analyzeImpact(root.id);

    expect(impact.node.id).toBe(root.id);

    // Both effects are found, and identified — not just counted.
    const affectedIds = impact.downstreamEffects.map((item) => item.node.id);
    expect(affectedIds).toContain(effect1.id);
    expect(affectedIds).toContain(effect2.id);
  });

  it("scores an isolated node as no impact", async () => {
    const service = await causalGraph();

    const connected = await service.addNode("Connected", "event", "Has an edge");
    const downstream = await service.addNode("Downstream", "metric", "Affected");
    await service.addEdge(connected.id, downstream.id, "affects", 0.9, 0.9);

    const isolated = await service.addNode("Isolated", "event", "No edges");
    const impact = await service.analyzeImpact(isolated.id);

    // Contrast with the connected node above: the score has to discriminate.
    expect(impact.downstreamEffects).toEqual([]);
    expect(impact.rootCauses).toEqual([]);
    expect(impact.impactScore).toBe(0);

    const connectedImpact = await service.analyzeImpact(connected.id);
    expect(connectedImpact.impactScore).toBeGreaterThan(impact.impactScore);
  });

  it("counts nodes and edges by type in getStats", async () => {
    const service = await causalGraph();

    const n1 = await service.addNode("Root Cause", "event", "Initial event");
    const n2 = await service.addNode("Intermediate", "event", "Middle event");
    const n3 = await service.addNode("Effect", "outcome", "Final effect");
    await service.addEdge(n1.id, n2.id, "causes", 0.9, 0.8);
    await service.addEdge(n2.id, n3.id, "causes", 0.7, 0.9);

    const stats = await service.getStats();

    expect(stats.totalNodes).toBe(3);
    expect(stats.totalEdges).toBe(2);
    expect(stats.nodeTypes).toMatchObject({ event: 2, outcome: 1 });
    expect(stats.edgeTypes).toMatchObject({ causes: 2 });
    // Mean of the two edge confidences, 0.8 and 0.9.
    expect(stats.avgConfidence).toBeCloseTo(0.85, 6);
  });
});
