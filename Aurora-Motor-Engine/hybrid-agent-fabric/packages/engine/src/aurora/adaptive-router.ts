import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type RouteStrategy = "performance" | "cost" | "quality" | "balanced";

interface RouteDecision {
  id: string;
  tenantId: string;
  requestId: string;
  selectedPath: string;
  /**
   * Score of the winning path.
   *
   * `alternatives` deliberately excludes the winner, so without this a caller
   * could see how close the runner-up was but not what it was close to -- which
   * makes the strength of the decision unmeasurable from the outside.
   */
  selectedScore: number;
  selectedReason: string;
  strategy: RouteStrategy;
  alternatives: { path: string; score: number; reason: string; }[];
  latencyMs: number;
  success: boolean;
  createdAt: string;
}
interface RouteRule { id: string; pattern: string; preferredPath: string; strategy: RouteStrategy; successRate: number; avgLatencyMs: number; usageCount: number; }

interface RouterState { schemaVersion: number; decisions: RouteDecision[]; rules: RouteRule[]; }

export class AdaptiveRouterService {
  private store: DurableJsonState<RouterState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<RouterState>(
      join(baseDir, "adaptive-router.json"),
      () => ({ schemaVersion: 1, decisions: [], rules: [] }),
      (v) => { const s = v as RouterState; return !!s && s.schemaVersion === 1; },
      "Aurora adaptive router",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async route(tenantId: string, requestId: string, pattern: string, availablePaths: { path: string; latencyMs: number; cost: number; reliability: number; }[], strategy: RouteStrategy): Promise<RouteDecision> {
    return await this.store.mutate(s => {
      // Apply learned rules to boost scores of historically successful paths
      const scored = availablePaths.map(p => {
        let baseScore: number;
        if (strategy === "performance") baseScore = (1 / (p.latencyMs || 1)) * 1000;
        else if (strategy === "cost") baseScore = 1 / (p.cost || 1);
        else if (strategy === "quality") baseScore = p.reliability;
        else baseScore = p.reliability * 0.4 + (1 / (p.latencyMs || 1)) * 300 * 0.3 + (1 / (p.cost || 1)) * 0.3;

        // Boost score if a learned rule matches this path
        const matchingRule = s.rules.find(r => r.preferredPath === p.path);
        let ruleBoost = 0;
        let ruleReason = "";
        if (matchingRule && matchingRule.usageCount >= 3) {
          ruleBoost = matchingRule.successRate * 0.3; // up to 30% boost
          ruleReason = ` (learned: ${(matchingRule.successRate * 100).toFixed(0)}% success, ${matchingRule.usageCount} uses)`;
        }

        const score = baseScore * (1 + ruleBoost);
        return { path: p.path, score, reason: `${strategy} score: ${score.toFixed(3)}${ruleReason}` };
      }).sort((a, b) => b.score - a.score);
      const selected = scored[0]!;
      const decision: RouteDecision = {
        id: randomUUID(),
        tenantId,
        requestId,
        selectedPath: selected.path,
        selectedScore: selected.score,
        selectedReason: selected.reason,
        strategy,
        alternatives: scored.slice(1, 5),
        latencyMs: 0,
        success: true,
        createdAt: new Date().toISOString(),
      };
      s.decisions.push(decision);
      return decision;
    });
  }

  async recordOutcome(decisionId: string, latencyMs: number, success: boolean): Promise<void> {
    await this.store.mutate(s => {
      const d = s.decisions.find(x => x.id === decisionId);
      if (!d) return;
      d.latencyMs = latencyMs;
      d.success = success;
      // Update rules
      let rule = s.rules.find(r => r.pattern === d.selectedPath);
      if (!rule) { rule = { id: randomUUID(), pattern: d.selectedPath, preferredPath: d.selectedPath, strategy: d.strategy, successRate: 0, avgLatencyMs: 0, usageCount: 0 }; s.rules.push(rule); }
      rule.usageCount++;
      rule.avgLatencyMs = (rule.avgLatencyMs * (rule.usageCount - 1) + latencyMs) / rule.usageCount;
      rule.successRate = (rule.successRate * (rule.usageCount - 1) + (success ? 1 : 0)) / rule.usageCount;
    });
  }

  async addRule(pattern: string, preferredPath: string, strategy: RouteStrategy): Promise<RouteRule> {
    const rule: RouteRule = { id: randomUUID(), pattern, preferredPath, strategy, successRate: 0.5, avgLatencyMs: 0, usageCount: 0 };
    await this.store.mutate(s => { s.rules.push(rule); });
    return rule;
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const td = s.decisions.filter(d => d.tenantId === tenantId);
    const successRate = td.length ? td.filter(d => d.success).length / td.length : 0;
    const avgLatency = td.length ? td.reduce((sum, d) => sum + d.latencyMs, 0) / td.length : 0;
    const strategyDist: Record<string, number> = {};
    for (const d of td) strategyDist[d.strategy] = (strategyDist[d.strategy] ?? 0) + 1;
    return { totalRoutes: td.length, successRate, avgLatency, rules: s.rules.length, strategyDistribution: strategyDist };
  }

  // ═══ P2: Smart Routing ═══

  async smartRoute(tenantId: string, requestPattern: string): Promise<{
recommendedPath: string; strategy: string; confidence: number;
    rationale: string[]; alternatives: Array<{ path: string; score: number }>;
    }> {
    const s = await this.store.read();
    const rules = s.rules.filter(r => new RegExp(r.pattern.replace(/\*/g, ".*")).test(requestPattern));
    if (rules.length === 0) {
      return { recommendedPath: "default", strategy: "hybrid", confidence: 0.3, rationale: ["No matching rules found — using defaults"], alternatives: [] };
    }
    const scored = rules.map(r => ({
      path: r.preferredPath,
      score: r.successRate * 0.7 + (1 - Math.min(r.avgLatencyMs / 10000, 1)) * 0.3,
      strategy: r.strategy,
      successRate: r.successRate,
      usageCount: r.usageCount,
    })).sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) return { recommendedPath: "default", strategy: "hybrid", confidence: 0.3, rationale: ["No scored routes"], alternatives: [] };
    const rationale = [`Rule matched with ${best.successRate.toFixed(2)} success rate`, `Used ${best.usageCount} times`, `Avg latency: ${rules[0]?.avgLatencyMs?.toFixed(0) ?? "N/A"}ms`];
    return {
      recommendedPath: best.path, strategy: best.strategy, confidence: Math.min(1, best.score),
      rationale, alternatives: scored.slice(1).map(r => ({ path: r.path, score: r.score })),
    };
  }

  // ═══ P2: Learned Routing ═══

  async learnRoute(tenantId: string): Promise<{
rulesUpdated: number; rulesCreated: number;
    insights: string[]; topRoutes: Array<{ path: string; successRate: number; avgLatencyMs: number }>;
    }> {
    const s = await this.store.read();
    const decisions = s.decisions.filter(d => d.tenantId === tenantId);
    // Group decisions by selectedPath
    const pathStats: Record<string, { successes: number; total: number; latencySum: number; strategies: Record<string, number> }> = {};
    for (const d of decisions) {
      if (!pathStats[d.selectedPath]) pathStats[d.selectedPath] = { successes: 0, total: 0, latencySum: 0, strategies: {} };
      const ps = pathStats[d.selectedPath]!;
      ps.total++;
      if (d.success) ps.successes++;
      ps.latencySum += d.latencyMs;
      ps.strategies[d.strategy] = (ps.strategies[d.strategy] ?? 0) + 1;
    }
    let rulesUpdated = 0;
    let rulesCreated = 0;
    const insights: string[] = [];
    await this.store.mutate(s => {
      for (const [path, stats] of Object.entries(pathStats)) {
        const successRate = stats.successes / stats.total;
        const avgLatency = stats.latencySum / stats.total;
        const bestStrategy = Object.entries(stats.strategies).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "hybrid";
        const existing = s.rules.find(r => r.preferredPath === path);
        if (existing) {
          existing.successRate = successRate;
          existing.avgLatencyMs = avgLatency;
          existing.usageCount = stats.total;
          rulesUpdated++;
        } else if (stats.total >= 3) {
          s.rules.push({ id: `rule-${Date.now()}`, pattern: `*${path}*`, preferredPath: path, strategy: bestStrategy as any, successRate, avgLatencyMs: avgLatency, usageCount: stats.total });
          rulesCreated++;
        }
        if (successRate < 0.5 && stats.total >= 5) insights.push(`Route "${path}" has ${(successRate * 100).toFixed(0)}% success — consider alternatives`);
        if (avgLatency > 10000) insights.push(`Route "${path}" averages ${avgLatency.toFixed(0)}ms — optimize or replace`);
      }
    });
    const topRoutes = Object.entries(pathStats)
      .map(([path, stats]) => ({ path, successRate: stats.successes / stats.total, avgLatencyMs: Math.round(stats.latencySum / stats.total) }))
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 10);
    return { rulesUpdated, rulesCreated, insights, topRoutes };
  }

  // ═══ P2: Explainability ═══

  async why(tenantId: string, routeId: string): Promise<{
routeName: string; target: string; confidence: number;
    rationale: string[]; recentPerformance: { successes: number; failures: number; avgLatencyMs: number };
    alternativeRoutes: string[]; riskFactors: string[];
    }> {
    const s = await this.store.read();
    const r = s.decisions.find((d: any) => d.tenantId === tenantId && d.id === routeId);
    if (!r) throw new Error("Aurora route not found");

    // An explanation of a routing decision has to name the route that was
    // chosen. This previously reported `routeName: r.id` (a UUID) and
    // `target: r.strategy`, so the selected path appeared nowhere in the
    // output, and `alternativeRoutes` listed the ids of unrelated decisions
    // instead of the paths that lost.
    const rationale: string[] = [
      `Selected ${r.selectedPath} using the ${r.strategy} strategy`,
    ];

    // `success` defaults to false until recordOutcome() runs. Reporting an
    // unrecorded decision as a failure is the skipped-is-not-success mistake
    // in miniature, so distinguish "not yet measured" from "measured bad".
    const outcomeRecorded = r.latencyMs > 0 || r.success;
    if (!outcomeRecorded) {
      rationale.push("Outcome not recorded yet — no performance evidence for this decision");
    } else {
      rationale.push(`Latency: ${r.latencyMs}ms`);
      if (!r.success) rationale.push("WARNING: Last use was a failure");
    }

    for (const alt of r.alternatives) {
      rationale.push(`Rejected ${alt.path} (score ${alt.score.toFixed(3)})${alt.reason ? `: ${alt.reason}` : ""}`);
    }

    const riskFactors: string[] = [];
    if (r.latencyMs > 5000) riskFactors.push("High latency");
    if (!outcomeRecorded) riskFactors.push("Unverified outcome");

    return {
      routeName: r.selectedPath,
      target: r.selectedPath,
      // Confidence must not claim 0.8 for a decision nobody has measured.
      confidence: !outcomeRecorded ? 0.3 : r.success ? 0.8 : 0.3,
      rationale,
      recentPerformance: {
        successes: r.success ? 1 : 0,
        failures: outcomeRecorded && !r.success ? 1 : 0,
        avgLatencyMs: r.latencyMs,
      },
      alternativeRoutes: r.alternatives.map((alt: { path: string }) => alt.path),
      riskFactors,
    };
  }
}
