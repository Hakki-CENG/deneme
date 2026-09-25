import { describe, it, expect } from "vitest";

import {
  recallAtK,
  precisionAtK,
  reciprocalRank,
  ndcgAtK,
  evaluateRetrieval,
  compareRetrieval,
  formatRetrievalReport,
  type RetrievalCase,
  type RetrievalRun,
} from "../src/metrics/recall-metrics.js";

describe("recallAtK", () => {
  it("returns 1 when all relevant docs are in the top k", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "b"], 3)).toBe(1);
  });

  it("respects the k cutoff", () => {
    // 'b' sits at rank 3, outside k=2.
    expect(recallAtK(["a", "x", "b"], ["a", "b"], 2)).toBe(0.5);
  });

  it("returns 0 when nothing relevant is retrieved", () => {
    expect(recallAtK(["x", "y"], ["a", "b"], 8)).toBe(0);
  });

  it("returns 0 when there is no ground truth", () => {
    expect(recallAtK(["a"], [], 8)).toBe(0);
  });

  it("deduplicates repeated relevant ids", () => {
    expect(recallAtK(["a"], ["a", "a"], 8)).toBe(1);
  });
});

describe("precisionAtK", () => {
  it("measures the relevant fraction of the top k", () => {
    expect(precisionAtK(["a", "x", "b", "y"], ["a", "b"], 4)).toBe(0.5);
  });

  it("handles an empty result list", () => {
    expect(precisionAtK([], ["a"], 8)).toBe(0);
  });
});

describe("reciprocalRank", () => {
  it("rewards an early first hit", () => {
    expect(reciprocalRank(["a", "x"], ["a"])).toBe(1);
    expect(reciprocalRank(["x", "x", "a"], ["a"])).toBeCloseTo(1 / 3);
  });

  it("returns 0 when there is no hit", () => {
    expect(reciprocalRank(["x"], ["a"])).toBe(0);
  });
});

describe("ndcgAtK", () => {
  it("scores a perfect ranking as 1", () => {
    expect(ndcgAtK(["a", "b"], ["a", "b"], 2)).toBeCloseTo(1);
  });

  it("penalises relevant results ranked lower", () => {
    const good = ndcgAtK(["a", "x", "y"], ["a"], 3);
    const worse = ndcgAtK(["x", "y", "a"], ["a"], 3);
    expect(good).toBeGreaterThan(worse);
  });

  it("returns 0 with no relevant docs", () => {
    expect(ndcgAtK(["x"], [], 3)).toBe(0);
  });
});

describe("evaluateRetrieval", () => {
  const cases: RetrievalCase[] = [
    { queryId: "q1", query: "one", relevantIds: ["a", "b"] },
    { queryId: "q2", query: "two", relevantIds: ["c"] },
  ];

  it("aggregates metrics across queries", () => {
    const runs: RetrievalRun[] = [
      { queryId: "q1", rankedIds: ["a", "b"] },
      { queryId: "q2", rankedIds: ["c"] },
    ];
    const metrics = evaluateRetrieval(cases, runs, 8);
    expect(metrics.recallAtK).toBe(1);
    expect(metrics.mrr).toBe(1);
    expect(metrics.queries).toBe(2);
  });

  it("counts a missing run as zero rather than skipping it", () => {
    const runs: RetrievalRun[] = [{ queryId: "q1", rankedIds: ["a", "b"] }];
    const metrics = evaluateRetrieval(cases, runs, 8);
    // q2 answered nothing => mean recall is 0.5, not 1.
    expect(metrics.recallAtK).toBe(0.5);
  });

  it("reports per-query detail", () => {
    const runs: RetrievalRun[] = [
      { queryId: "q1", rankedIds: ["a"] },
      { queryId: "q2", rankedIds: ["c"] },
    ];
    const metrics = evaluateRetrieval(cases, runs, 8);
    const q1 = metrics.perQuery.find((q) => q.queryId === "q1");
    expect(q1?.relevantFound).toBe(1);
    expect(q1?.relevantTotal).toBe(2);
  });
});

describe("compareRetrieval — the FAZ 11 gate decision", () => {
  const cases: RetrievalCase[] = [
    { queryId: "q1", query: "one", relevantIds: ["a", "b"] },
    { queryId: "q2", query: "two", relevantIds: ["c", "d"] },
  ];

  it("passes when the candidate clears the margin and wins more queries", () => {
    const result = compareRetrieval({
      cases,
      baselineRuns: [
        { queryId: "q1", rankedIds: ["a"] },
        { queryId: "q2", rankedIds: [] },
      ],
      candidateRuns: [
        { queryId: "q1", rankedIds: ["a", "b"] },
        { queryId: "q2", rankedIds: ["c", "d"] },
      ],
      k: 8,
      margin: 0.05,
    });

    expect(result.passesGate).toBe(true);
    expect(result.wins).toBeGreaterThan(result.losses);
  });

  it("fails on a tie", () => {
    const same: RetrievalRun[] = [
      { queryId: "q1", rankedIds: ["a", "b"] },
      { queryId: "q2", rankedIds: ["c", "d"] },
    ];
    const result = compareRetrieval({
      cases,
      baselineRuns: same,
      candidateRuns: same,
      margin: 0.05,
    });
    expect(result.passesGate).toBe(false);
  });

  it("fails when the improvement is below the margin", () => {
    const result = compareRetrieval({
      cases,
      baselineRuns: [
        { queryId: "q1", rankedIds: ["a", "b"] },
        { queryId: "q2", rankedIds: ["c"] },
      ],
      candidateRuns: [
        { queryId: "q1", rankedIds: ["a", "b"] },
        { queryId: "q2", rankedIds: ["c", "d"] },
      ],
      margin: 0.5,
    });
    expect(result.passesGate).toBe(false);
  });

  it("fails when the candidate regresses", () => {
    const result = compareRetrieval({
      cases,
      baselineRuns: [
        { queryId: "q1", rankedIds: ["a", "b"] },
        { queryId: "q2", rankedIds: ["c", "d"] },
      ],
      candidateRuns: [
        { queryId: "q1", rankedIds: [] },
        { queryId: "q2", rankedIds: [] },
      ],
      margin: 0.05,
    });
    expect(result.passesGate).toBe(false);
    expect(result.recallDelta).toBeLessThan(0);
  });

  it("produces a readable report", () => {
    const result = compareRetrieval({
      cases,
      baselineRuns: [{ queryId: "q1", rankedIds: ["a"] }],
      candidateRuns: [
        { queryId: "q1", rankedIds: ["a", "b"] },
        { queryId: "q2", rankedIds: ["c", "d"] },
      ],
      margin: 0.05,
    });

    const report = formatRetrievalReport(result);
    expect(report).toContain("Recall@8 Gate Report");
    expect(report).toContain("| Metric | Baseline | Candidate |");
    expect(report).toMatch(/PASS|FAIL/);
  });
});
