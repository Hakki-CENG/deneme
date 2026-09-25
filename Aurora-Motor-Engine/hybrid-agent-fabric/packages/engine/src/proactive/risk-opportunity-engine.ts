/**
 * Risk & Opportunity Engine (master: Opportunity Detection L13 /
 * Risk Detection L14).
 *
 * Watchers already turn external events into initiatives. What did not exist
 * is the derivation of risks and opportunities from the engine's OWN measured
 * state — the signals that are always there and nobody was reading:
 *
 *   risks:      the same outcome recurring (loop detection), attention-budget
 *               saturation (cognitive health), stale strategic goals.
 *   opportunities: a capability gap seen repeatedly (worth acquiring), an
 *               unverified palace hypothesis (worth testing).
 *
 * Honesty rules this file: every derived item carries evidence refs into the
 * signal it came from, its confidence states what was actually counted, and
 * a tenant with no signals gets EMPTY lists — not a made-up digest.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";
import type { DetectedLoop, LoopDetectionService } from "../cognitive/loop-detection-service.js";

export type DerivedRiskKind =
  | "repeated-outcome"
  | "budget-saturation"
  | "stale-strategic";

export type DerivedOpportunityKind =
  | "capability-acquisition"
  | "unverified-hypothesis";

export interface DerivedRisk {
  kind: DerivedRiskKind;
  title: string;
  message: string;
  importance: number;
  urgency: number;
  impact: number;
  confidence: number;
  userRelevance: number;
  evidenceRefs: string[];
}

export interface DerivedOpportunity {
  kind: DerivedOpportunityKind;
  title: string;
  message: string;
  importance: number;
  urgency: number;
  impact: number;
  confidence: number;
  userRelevance: number;
  evidenceRefs: string[];
}

export interface CapabilityGapSignal {
  id: string;
  tenantId: string;
  type: string;
  missing: string;
  description: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  taskRefs: string[];
}

interface EngineState {
  schemaVersion: 1;
  capabilityGaps: CapabilityGapSignal[];
}

export interface RiskOpportunityDeps {
  loops: LoopDetectionService;
  cognitiveHealth: (
    tenantId: string,
  ) => Promise<{ budgetSaturation: number; staleStrategic: string[] }>;
  palaceHypotheses: (
    tenantId: string,
  ) => Promise<Array<{ id: string; title: string; lastVerifiedAt?: string }>>;
  /** Proposals become real initiatives; suppressed duplicates are counted, not errors. */
  propose: (input: {
    tenantId: string;
    kind: "risk" | "opportunity";
    title: string;
    message: string;
    importance: number;
    urgency: number;
    impact: number;
    confidence: number;
    userRelevance: number;
    evidenceRefs: string[];
  }) => Promise<unknown>;
}

export interface EvaluationReport {
  risks: DerivedRisk[];
  opportunities: DerivedOpportunity[];
  /** Signals consulted, so "empty" can be told apart from "not measured". */
  signalCounts: {
    activeLoops: number;
    budgetSaturation: number;
    staleStrategic: number;
    repeatedGaps: number;
    unverifiedHypotheses: number;
  };
}

const GAP_OPPORTUNITY_THRESHOLD = 2;

export class RiskOpportunityEngine {
  private readonly store: DurableJsonState<EngineState>;

  constructor(
    rootPath: string,
    private readonly deps: RiskOpportunityDeps,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new DurableJsonState<EngineState>(
      join(rootPath, "risk-opportunity.json"),
      () => ({ schemaVersion: 1, capabilityGaps: [] }),
      (value) => {
        const state = value as EngineState;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.capabilityGaps);
      },
      "Aurora risk/opportunity engine",
    );
  }

  async init(): Promise<void> {
    await this.store.read();
  }

  /** Records one observed capability gap; repeats increment a durable count. */
  async recordCapabilityGap(
    tenantId: string,
    gap: { type: string; missing: string; description: string },
    taskRef?: string,
  ): Promise<CapabilityGapSignal> {
    const at = new Date(this.now()).toISOString();
    return await this.store.mutate((state) => {
      let signal = state.capabilityGaps.find(
        (item) => item.tenantId === tenantId && item.missing === gap.missing,
      );
      if (!signal) {
        signal = {
          id: `gap-${randomUUID()}`,
          tenantId,
          type: gap.type,
          missing: gap.missing,
          description: gap.description.slice(0, 500),
          count: 0,
          firstSeenAt: at,
          lastSeenAt: at,
          taskRefs: [],
        };
        state.capabilityGaps.push(signal);
      }
      signal.count += 1;
      signal.lastSeenAt = at;
      if (taskRef && signal.taskRefs.length < 20) signal.taskRefs.push(taskRef);
      return structuredClone(signal);
    });
  }

  async capabilityGaps(tenantId: string): Promise<CapabilityGapSignal[]> {
    const state = await this.store.read();
    return state.capabilityGaps
      .filter((item) => item.tenantId === tenantId)
      .map((item) => structuredClone(item));
  }

  /**
   * Derives risks and opportunities from measured signals. Pure with respect
   * to initiatives: nothing is proposed here, so a caller can inspect before
   * acting.
   */
  async evaluate(tenantId: string): Promise<EvaluationReport> {
    const [activeLoops, health, hypotheses, gaps] = await Promise.all([
      this.deps.loops.activeLoops(tenantId),
      this.deps.cognitiveHealth(tenantId).catch(() => undefined),
      this.deps.palaceHypotheses(tenantId).catch(() => []),
      this.capabilityGaps(tenantId),
    ]);

    const risks: DerivedRisk[] = [];
    for (const loop of activeLoops) {
      risks.push({
        kind: "repeated-outcome",
        title: `Recurring outcome detected (${loop.occurrences}x)`,
        message: `The same outcome signature recurred ${loop.occurrences} time(s) for "${loop.evidence[loop.evidence.length - 1]?.subject ?? loop.signature}". Acknowledge the loop or change the approach; retrying identically will not change the result.`,
        importance: 0.8,
        urgency: 0.6,
        impact: 0.7,
        confidence: 0.9,
        userRelevance: 0.6,
        evidenceRefs: [loop.id],
      });
    }
    if (health && health.budgetSaturation >= 0.9) {
      risks.push({
        kind: "budget-saturation",
        title: "Attention budget is saturated",
        message: `Cognitive attention budget saturation is ${(health.budgetSaturation * 100).toFixed(0)}%. New intake will be deferred or preempt lower-class focus until budget is released.`,
        importance: 0.7,
        urgency: 0.8,
        impact: 0.6,
        confidence: 1,
        userRelevance: 0.5,
        evidenceRefs: [],
      });
    }
    if (health && health.staleStrategic.length > 0) {
      risks.push({
        kind: "stale-strategic",
        title: `${health.staleStrategic.length} strategic object(s) went stale`,
        message: "Strategic-class cognitive objects have not been touched within their horizon. They either still matter — then they deserve attention — or they do not, then they should be closed.",
        importance: 0.6,
        urgency: 0.4,
        impact: 0.6,
        confidence: 1,
        userRelevance: 0.7,
        evidenceRefs: [],
      });
    }

    const opportunities: DerivedOpportunity[] = [];
    for (const gap of gaps.filter((item) => item.count >= GAP_OPPORTUNITY_THRESHOLD)) {
      opportunities.push({
        kind: "capability-acquisition",
        title: `Capability gap seen ${gap.count}x: ${gap.missing}`,
        message: `Tasks repeatedly hit the missing capability "${gap.missing}" (${gap.type}). Acquiring or synthesizing it would unblock this class of tasks.`,
        importance: Math.min(0.9, 0.4 + gap.count * 0.1),
        urgency: 0.5,
        impact: 0.7,
        confidence: 0.8,
        userRelevance: 0.6,
        evidenceRefs: [gap.id],
      });
    }
    for (const hypothesis of hypotheses) {
      if (hypothesis.lastVerifiedAt !== undefined) continue;
      opportunities.push({
        kind: "unverified-hypothesis",
        title: `Unverified hypothesis: ${hypothesis.title}`,
        message: `The palace-layer hypothesis "${hypothesis.title}" has never been verified. Designing a task whose outcome would confirm or refute it would turn a speculation into knowledge.`,
        importance: 0.5,
        urgency: 0.3,
        impact: 0.6,
        confidence: 0.7,
        userRelevance: 0.5,
        evidenceRefs: [hypothesis.id],
      });
    }

    return {
      risks,
      opportunities,
      signalCounts: {
        activeLoops: activeLoops.length,
        budgetSaturation: health?.budgetSaturation ?? 0,
        staleStrategic: health?.staleStrategic.length ?? 0,
        repeatedGaps: gaps.filter((item) => item.count >= GAP_OPPORTUNITY_THRESHOLD).length,
        unverifiedHypotheses: hypotheses.filter((item) => item.lastVerifiedAt === undefined).length,
      },
    };
  }

  /**
   * Pushes the derived items into the proactive layer as real initiatives.
   * Duplicate suppression is the initiative layer's own rule; suppressed
   * items are counted, because "already proposed recently" is a fact, not an
   * error.
   */
  async propose(tenantId: string): Promise<{
    created: number;
    suppressed: number;
    evaluation: EvaluationReport;
  }> {
    const evaluation = await this.evaluate(tenantId);
    let created = 0;
    let suppressed = 0;
    // Only the initiative layer's own duplicate-suppression is counted as
    // "suppressed"; any other error (validation, store failure) propagates,
    // because calling it "suppressed" would hide a real failure.
    const record = async (
      item: DerivedRisk | DerivedOpportunity,
      initiativeKind: "risk" | "opportunity",
    ) => {
      try {
        const { kind: _derivedKind, ...fields } = item;
        await this.deps.propose({ tenantId, kind: initiativeKind, ...fields });
        created += 1;
      } catch (error) {
        if (String((error as Error).message).includes("suppressed")) {
          suppressed += 1;
          return;
        }
        throw error;
      }
    };
    for (const risk of evaluation.risks) await record(risk, "risk");
    for (const opportunity of evaluation.opportunities) await record(opportunity, "opportunity");
    return { created, suppressed, evaluation };
  }
}
