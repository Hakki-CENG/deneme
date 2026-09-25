/**
 * Retrieval Quality Metrics — Aurora
 *
 * FAZ 11 gate: "Recall@8 ölçülüyor ve baseline'dan anlamlı şekilde daha iyi".
 *
 * Implements the standard IR metrics needed to make that gate measurable:
 * Recall@k, Precision@k, MRR and nDCG@k, plus a paired comparison that reports
 * whether a candidate retriever beats a baseline by a meaningful margin.
 */

/** A single retrieval query with its ground-truth relevant document ids. */
export interface RetrievalCase {
  readonly queryId: string;
  readonly query: string;
  /** Ids that are genuinely relevant for this query. */
  readonly relevantIds: readonly string[];
}

/** What a retriever returned for one query, best-first. */
export interface RetrievalRun {
  readonly queryId: string;
  /** Retrieved document ids in rank order (index 0 = rank 1). */
  readonly rankedIds: readonly string[];
}

/** Per-query metric breakdown. */
export interface QueryMetrics {
  readonly queryId: string;
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly reciprocalRank: number;
  readonly ndcgAtK: number;
  readonly relevantFound: number;
  readonly relevantTotal: number;
}

/** Aggregate metrics across a case set. */
export interface RetrievalMetrics {
  readonly k: number;
  readonly queries: number;
  /** Mean Recall@k — the headline number for the FAZ 11 gate. */
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly mrr: number;
  readonly ndcgAtK: number;
  readonly perQuery: readonly QueryMetrics[];
}

/** Outcome of comparing a candidate retriever against a baseline. */
export interface RetrievalComparison {
  readonly k: number;
  readonly baseline: RetrievalMetrics;
  readonly candidate: RetrievalMetrics;
  /** candidate.recallAtK - baseline.recallAtK */
  readonly recallDelta: number;
  /** Relative improvement over baseline, guarded against divide-by-zero. */
  readonly relativeImprovement: number;
  /** Queries where the candidate did strictly better / worse. */
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  /**
   * Whether the improvement clears the configured margin AND wins outnumber
   * losses. Both conditions must hold for the gate to pass.
   */
  readonly passesGate: boolean;
  readonly margin: number;
  readonly summary: string;
}

/**
 * Recall@k for one query: fraction of relevant items appearing in the top k.
 */
export function recallAtK(
  rankedIds: readonly string[],
  relevantIds: readonly string[],
  k: number
): number {
  if (relevantIds.length === 0) return 0;
  const topK = new Set(rankedIds.slice(0, k));
  let found = 0;
  for (const id of new Set(relevantIds)) {
    if (topK.has(id)) found += 1;
  }
  return found / new Set(relevantIds).size;
}

/**
 * Precision@k: fraction of the top k that are relevant.
 */
export function precisionAtK(
  rankedIds: readonly string[],
  relevantIds: readonly string[],
  k: number
): number {
  if (k <= 0) return 0;
  const relevant = new Set(relevantIds);
  const topK = rankedIds.slice(0, k);
  if (topK.length === 0) return 0;
  const hits = topK.filter((id) => relevant.has(id)).length;
  return hits / topK.length;
}

/**
 * Reciprocal rank: 1/rank of the first relevant hit, 0 if none.
 */
export function reciprocalRank(
  rankedIds: readonly string[],
  relevantIds: readonly string[]
): number {
  const relevant = new Set(relevantIds);
  for (let i = 0; i < rankedIds.length; i += 1) {
    if (relevant.has(rankedIds[i]!)) return 1 / (i + 1);
  }
  return 0;
}

/**
 * nDCG@k with binary relevance.
 */
export function ndcgAtK(
  rankedIds: readonly string[],
  relevantIds: readonly string[],
  k: number
): number {
  const relevant = new Set(relevantIds);
  let dcg = 0;
  const topK = rankedIds.slice(0, k);
  for (let i = 0; i < topK.length; i += 1) {
    if (relevant.has(topK[i]!)) {
      dcg += 1 / Math.log2(i + 2);
    }
  }

  const idealHits = Math.min(relevant.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i += 1) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Evaluate a set of retrieval runs against ground truth.
 *
 * Missing runs count as an empty result (recall 0) rather than being skipped,
 * so a retriever cannot improve its score by refusing to answer.
 */
export function evaluateRetrieval(
  cases: readonly RetrievalCase[],
  runs: readonly RetrievalRun[],
  k: number = 8
): RetrievalMetrics {
  const runByQuery = new Map(runs.map((r) => [r.queryId, r.rankedIds]));
  const perQuery: QueryMetrics[] = [];

  for (const testCase of cases) {
    const ranked = runByQuery.get(testCase.queryId) ?? [];
    const relevantSet = new Set(testCase.relevantIds);
    const topK = new Set(ranked.slice(0, k));
    let found = 0;
    for (const id of relevantSet) {
      if (topK.has(id)) found += 1;
    }

    perQuery.push({
      queryId: testCase.queryId,
      recallAtK: recallAtK(ranked, testCase.relevantIds, k),
      precisionAtK: precisionAtK(ranked, testCase.relevantIds, k),
      reciprocalRank: reciprocalRank(ranked, testCase.relevantIds),
      ndcgAtK: ndcgAtK(ranked, testCase.relevantIds, k),
      relevantFound: found,
      relevantTotal: relevantSet.size,
    });
  }

  const n = perQuery.length || 1;
  const mean = (pick: (q: QueryMetrics) => number): number =>
    perQuery.reduce((sum, q) => sum + pick(q), 0) / n;

  return {
    k,
    queries: perQuery.length,
    recallAtK: mean((q) => q.recallAtK),
    precisionAtK: mean((q) => q.precisionAtK),
    mrr: mean((q) => q.reciprocalRank),
    ndcgAtK: mean((q) => q.ndcgAtK),
    perQuery,
  };
}

/**
 * Compare a candidate retriever against a baseline on the same cases.
 *
 * The gate requires BOTH a margin-clearing mean improvement AND more per-query
 * wins than losses, so a single lucky query cannot carry the result.
 */
export function compareRetrieval(params: {
  cases: readonly RetrievalCase[];
  baselineRuns: readonly RetrievalRun[];
  candidateRuns: readonly RetrievalRun[];
  k?: number | undefined;
  /** Minimum absolute Recall@k improvement required. Default 0.05. */
  margin?: number | undefined;
}): RetrievalComparison {
  const k = params.k ?? 8;
  const margin = params.margin ?? 0.05;

  const baseline = evaluateRetrieval(params.cases, params.baselineRuns, k);
  const candidate = evaluateRetrieval(params.cases, params.candidateRuns, k);

  const baselineByQuery = new Map(baseline.perQuery.map((q) => [q.queryId, q.recallAtK]));
  let wins = 0;
  let losses = 0;
  let ties = 0;

  for (const q of candidate.perQuery) {
    const base = baselineByQuery.get(q.queryId) ?? 0;
    if (q.recallAtK > base) wins += 1;
    else if (q.recallAtK < base) losses += 1;
    else ties += 1;
  }

  const recallDelta = candidate.recallAtK - baseline.recallAtK;
  const relativeImprovement =
    baseline.recallAtK > 0 ? recallDelta / baseline.recallAtK : recallDelta > 0 ? 1 : 0;

  const passesGate = recallDelta >= margin && wins > losses;

  const summary = passesGate
    ? `PASS: Recall@${k} ${baseline.recallAtK.toFixed(3)} → ${candidate.recallAtK.toFixed(3)} (+${recallDelta.toFixed(3)}, ${wins}W/${losses}L/${ties}T)`
    : `FAIL: Recall@${k} ${baseline.recallAtK.toFixed(3)} → ${candidate.recallAtK.toFixed(3)} (Δ${recallDelta.toFixed(3)} < margin ${margin}, ${wins}W/${losses}L/${ties}T)`;

  return {
    k,
    baseline,
    candidate,
    recallDelta,
    relativeImprovement,
    wins,
    losses,
    ties,
    passesGate,
    margin,
    summary,
  };
}

/** Human-readable report for the FAZ 11 gate. */
export function formatRetrievalReport(comparison: RetrievalComparison): string {
  const lines: string[] = [];
  lines.push(`# Recall@${comparison.k} Gate Report`);
  lines.push("");
  lines.push(`**Result:** ${comparison.passesGate ? "✅ PASS" : "❌ FAIL"}`);
  lines.push("");
  lines.push("| Metric | Baseline | Candidate | Δ |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| Recall@${comparison.k} | ${comparison.baseline.recallAtK.toFixed(4)} | ${comparison.candidate.recallAtK.toFixed(4)} | ${comparison.recallDelta >= 0 ? "+" : ""}${comparison.recallDelta.toFixed(4)} |`
  );
  lines.push(
    `| Precision@${comparison.k} | ${comparison.baseline.precisionAtK.toFixed(4)} | ${comparison.candidate.precisionAtK.toFixed(4)} | ${(comparison.candidate.precisionAtK - comparison.baseline.precisionAtK).toFixed(4)} |`
  );
  lines.push(
    `| MRR | ${comparison.baseline.mrr.toFixed(4)} | ${comparison.candidate.mrr.toFixed(4)} | ${(comparison.candidate.mrr - comparison.baseline.mrr).toFixed(4)} |`
  );
  lines.push(
    `| nDCG@${comparison.k} | ${comparison.baseline.ndcgAtK.toFixed(4)} | ${comparison.candidate.ndcgAtK.toFixed(4)} | ${(comparison.candidate.ndcgAtK - comparison.baseline.ndcgAtK).toFixed(4)} |`
  );
  lines.push("");
  lines.push(
    `Per-query: **${comparison.wins} wins**, ${comparison.losses} losses, ${comparison.ties} ties over ${comparison.candidate.queries} queries.`
  );
  lines.push("");
  lines.push(`Required margin: ${comparison.margin}`);
  lines.push("");
  lines.push(comparison.summary);
  return lines.join("\n");
}
