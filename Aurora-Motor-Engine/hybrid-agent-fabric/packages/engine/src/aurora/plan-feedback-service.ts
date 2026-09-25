import { join } from "node:path";
import type { DecisionRecord, DecisionService } from "./decision-service.js";
import type { PlanningService, PlanRecord } from "./planning-service.js";
import type { AuroraExecutionBridge } from "./execution-bridge.js";
import type { AuroraOutcomeHarvester } from "./outcome-harvester.js";
import type { ProactiveInitiativeService } from "../initiative/proactive-initiative-service.js";
import { auroraInteger, auroraRound, auroraText, DurableJsonState } from "../util/aurora-state.js";

const MAX_RECORDS = 20_000;

export interface PlanFeedbackRecord {
  id: string;
  tenantId: string;
  planId: string;
  planTitle: string;
  decisionId: string;
  planStatus: PlanRecord["status"];
  succeeded: boolean;
  observedValue: number;
  doneRatio: number;
  delegatedQuality?: number;
  surprise: number;
  brierScore: number;
  evidenceRefs: string[];
  note: string;
  /** Raised when reality landed far from the expectation, or the plan failed outright. */
  advisory?: { initiativeId?: string; reason: string };
  at: string;
}

export interface PlanFeedbackCandidate {
  planId: string;
  planTitle: string;
  decisionId: string;
  planStatus: PlanRecord["status"];
  decisionStatus: DecisionRecord["status"];
  eligible: boolean;
  reason: string;
}

interface FeedbackStateShape {
  schemaVersion: 1;
  records: PlanFeedbackRecord[];
}

/**
 * Aurora plan feedback: the loop from "we decided this" to "here is what actually happened".
 *
 * Decision calibration — surprise, Brier score, overconfidence — is only worth anything if outcomes
 * are recorded, and until now they were recorded by hand, which meant mostly not at all. A decision
 * that produced a plan already has an execution record: the plan's own terminal state, its step
 * statuses, and (when the work was delegated) evidence-bound harvest assessments.
 *
 * This service turns that record into a decision outcome, under strict rules:
 *
 * - only plans that reached a terminal state (completed, abandoned, or blocked by a failed step) are
 *   considered, and only when they name the decision they came from;
 * - the observed value is derived, never invented: the fraction of steps genuinely finished, blended
 *   with the mean quality of harvested delegated work when such evidence exists;
 * - an existing outcome is never overwritten, and a decision that was abandoned or already reviewed
 *   is left alone;
 * - a decision still marked `decided` while its plan is executing is marked executed, so the
 *   lifecycle reflects reality without claiming a result;
 * - every record keeps the evidence references and the resulting surprise and Brier score, so the
 *   calibration numbers can be traced back to the execution that produced them.
 */
export class AuroraPlanFeedback {
  private readonly store: DurableJsonState<FeedbackStateShape>;

  constructor(
    rootPath: string,
    private readonly deps: {
      planning: PlanningService;
      decisions: DecisionService;
      bridge?: AuroraExecutionBridge;
      harvester?: AuroraOutcomeHarvester;
      /** Optional: raise a candidate replanning initiative when a decision was badly wrong. */
      initiative?: ProactiveInitiativeService;
    },
    private readonly now: () => number = Date.now,
    private readonly options: { surpriseThreshold?: number } = {},
  ) {
    this.store = new DurableJsonState<FeedbackStateShape>(
      join(rootPath, "planning", "feedback.json"),
      () => ({ schemaVersion: 1, records: [] }),
      (value) => {
        const state = value as FeedbackStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.records);
      },
      "Aurora plan feedback",
    );
  }

  /** Which decisions are waiting for reality, and which are not eligible and why. */
  async candidates(tenantId: string, limit = 50): Promise<PlanFeedbackCandidate[]> {
    const plans = await this.deps.planning.list(tenantId, { limit: auroraInteger(limit, 1, 1000, "Feedback limit") * 4 });
    const results: PlanFeedbackCandidate[] = [];
    for (const plan of plans) {
      if (!plan.decisionId) continue;
      let decision: DecisionRecord;
      try {
        decision = await this.deps.decisions.get(tenantId, plan.decisionId);
      } catch {
        results.push({ planId: plan.id, planTitle: plan.title, decisionId: plan.decisionId, planStatus: plan.status, decisionStatus: "abandoned", eligible: false, reason: "decision-not-found" });
        continue;
      }
      const terminal = this.terminalState(plan);
      const eligible = terminal !== undefined && !decision.outcome && ["decided", "executed"].includes(decision.status);
      results.push({
        planId: plan.id,
        planTitle: plan.title,
        decisionId: decision.id,
        planStatus: plan.status,
        decisionStatus: decision.status,
        eligible,
        reason: eligible ? `plan ${terminal}` : decision.outcome ? "outcome-already-recorded"
          : !["decided", "executed"].includes(decision.status) ? `decision-${decision.status}`
            : "plan-still-open",
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  /**
   * Record decision outcomes for terminal plans. `dryRun` returns exactly what would be written,
   * which is how an operator checks the derivation before it touches calibration.
   */
  async reconcile(input: { tenantId: string; planId?: string; dryRun?: boolean; limit?: number }): Promise<{
    considered: number; recorded: PlanFeedbackRecord[]; executedMarked: string[]; skipped: Array<{ planId: string; reason: string }>; dryRun: boolean; generatedAt: string;
  }> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const limit = auroraInteger(input.limit ?? 25, 1, 200, "Reconcile limit");
    const plans = (await this.deps.planning.list(tenantId, { limit: 500 }))
      .filter((plan) => (input.planId ? plan.id === input.planId : true))
      .filter((plan) => plan.decisionId);

    const recorded: PlanFeedbackRecord[] = [];
    const executedMarked: string[] = [];
    const skipped: Array<{ planId: string; reason: string }> = [];
    let considered = 0;

    for (const plan of plans) {
      if (recorded.length >= limit) break;
      considered++;
      let decision: DecisionRecord;
      try {
        decision = await this.deps.decisions.get(tenantId, plan.decisionId!);
      } catch {
        skipped.push({ planId: plan.id, reason: "decision-not-found" });
        continue;
      }
      if (decision.outcome) { skipped.push({ planId: plan.id, reason: "outcome-already-recorded" }); continue; }
      if (!["decided", "executed"].includes(decision.status)) { skipped.push({ planId: plan.id, reason: `decision-${decision.status}` }); continue; }

      const terminal = this.terminalState(plan);
      if (!terminal) {
        // The plan is still running. If work has genuinely started, at least reflect that.
        const started = plan.steps.some((step) => ["in-progress", "done", "failed"].includes(step.status));
        if (started && decision.status === "decided" && !input.dryRun) {
          await this.deps.decisions.markExecuted(tenantId, decision.id, `Plan "${plan.title}" started executing.`);
          executedMarked.push(decision.id);
        }
        skipped.push({ planId: plan.id, reason: started ? "plan-executing" : "plan-still-open" });
        continue;
      }

      const evidence = await this.evidenceFor(tenantId, plan);
      const doneRatio = plan.steps.length
        ? auroraRound(plan.steps.filter((step) => ["done", "skipped"].includes(step.status)).length / plan.steps.length)
        : 0;
      const observedValue = evidence.quality === undefined
        ? doneRatio
        : auroraRound(doneRatio * 0.6 + evidence.quality * 0.4);
      const succeeded = terminal === "completed" && observedValue >= 0.5;
      const note = [
        `Derived from plan "${plan.title}" (${terminal}).`,
        `${Math.round(doneRatio * 100)}% of steps finished`,
        evidence.quality === undefined ? "no delegated work to score" : `mean delegated quality ${evidence.quality} over ${evidence.assessments} assessment(s)`,
      ].join(" · ").slice(0, 10_000);

      const record: PlanFeedbackRecord = {
        id: `plan-feedback-${plan.id}`,
        tenantId,
        planId: plan.id,
        planTitle: plan.title,
        decisionId: decision.id,
        planStatus: plan.status,
        succeeded,
        observedValue,
        doneRatio,
        ...(evidence.quality === undefined ? {} : { delegatedQuality: evidence.quality }),
        surprise: auroraRound(Math.abs(decision.expectedValue - observedValue)),
        brierScore: auroraRound((decision.confidence - (succeeded ? 1 : 0)) ** 2),
        evidenceRefs: evidence.refs,
        note,
        at: new Date(this.now()).toISOString(),
      };

      if (input.dryRun) { recorded.push(record); continue; }

      try {
        if (decision.status === "decided") {
          await this.deps.decisions.markExecuted(tenantId, decision.id, `Plan "${plan.title}" reached ${terminal}.`);
          executedMarked.push(decision.id);
        }
        await this.deps.decisions.recordOutcome({
          tenantId,
          decisionId: decision.id,
          succeeded,
          observedValue,
          note,
          evidenceRefs: record.evidenceRefs,
        });
      } catch (error) {
        skipped.push({ planId: plan.id, reason: `decision-refused: ${(error as Error).message}`.slice(0, 300) });
        continue;
      }
      const advisory = await this.advise(tenantId, plan, decision, record);
      if (advisory) record.advisory = advisory;
      recorded.push(record);
    }

    if (recorded.length && !input.dryRun) {
      await this.store.mutate((state) => {
        for (const record of recorded) {
          const index = state.records.findIndex((item) => item.id === record.id);
          if (index >= 0) state.records[index] = record;
          else state.records.push(record);
        }
        if (state.records.length > MAX_RECORDS) state.records.splice(0, state.records.length - MAX_RECORDS);
      });
    }

    return { considered, recorded, executedMarked, skipped, dryRun: input.dryRun ?? false, generatedAt: new Date(this.now()).toISOString() };
  }

  async records(tenantId: string, limit = 50): Promise<PlanFeedbackRecord[]> {
    const state = await this.store.read();
    return state.records
      .filter((item) => item.tenantId === tenantId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, auroraInteger(limit, 1, 1000, "Feedback limit"))
      .map((item) => structuredClone(item));
  }

  /** How well plan-derived expectations matched plan-derived reality, for this loop specifically. */
  async summary(tenantId: string): Promise<{
    tenantId: string; recorded: number; succeeded: number; successRate: number;
    meanSurprise: number; meanBrier: number; meanDoneRatio: number; generatedAt: string;
  }> {
    const records = await this.records(tenantId, 1000);
    const succeeded = records.filter((item) => item.succeeded).length;
    const mean = (values: number[]): number => (values.length ? auroraRound(values.reduce((sum, value) => sum + value, 0) / values.length) : 0);
    return {
      tenantId,
      recorded: records.length,
      succeeded,
      successRate: records.length ? auroraRound(succeeded / records.length) : 0,
      meanSurprise: mean(records.map((item) => item.surprise)),
      meanBrier: mean(records.map((item) => item.brierScore)),
      meanDoneRatio: mean(records.map((item) => item.doneRatio)),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * A decision that missed badly is a signal, not a verdict: Aurora raises a candidate initiative so
   * a human (or the initiative engine's own worthiness rules) can decide whether to replan. It never
   * rewrites the plan by itself, and it never notifies about a plan that simply went as expected.
   */
  private async advise(
    tenantId: string,
    plan: PlanRecord,
    decision: DecisionRecord,
    record: PlanFeedbackRecord,
  ): Promise<PlanFeedbackRecord["advisory"] | undefined> {
    if (!this.deps.initiative) return undefined;
    const threshold = this.options.surpriseThreshold ?? 0.4;
    const badMiss = record.surprise >= threshold;
    if (record.succeeded && !badMiss) return undefined;
    const reason = record.succeeded
      ? `Plan finished, but reality landed ${record.surprise} away from the expected value.`
      : `Plan "${plan.title}" did not deliver what decision "${decision.title}" expected.`;
    try {
      const initiative = await this.deps.initiative.propose({
        tenantId,
        kind: record.succeeded ? "insight" : "risk",
        title: `Review the plan behind "${decision.title}"`,
        message: [
          reason,
          `Expected value ${decision.expectedValue}, observed ${record.observedValue} (${Math.round(record.doneRatio * 100)}% of steps finished).`,
          "Consider replanning, revising the estimate, or recording why the expectation was wrong.",
        ].join(" "),
        importance: Math.min(1, 0.4 + record.surprise / 2),
        urgency: record.succeeded ? 0.3 : 0.6,
        impact: Math.min(1, 0.3 + record.surprise),
        confidence: 0.9,
        userRelevance: 0.6,
        evidenceRefs: [plan.id, decision.id, ...record.evidenceRefs.slice(0, 20)],
      });
      return { initiativeId: initiative.id, reason };
    } catch (error) {
      return { reason: `${reason} (initiative not raised: ${(error as Error).message})`.slice(0, 500) };
    }
  }

  private terminalState(plan: PlanRecord): "completed" | "abandoned" | "failed" | undefined {
    if (plan.status === "completed") return "completed";
    if (plan.status === "abandoned") return "abandoned";
    if (plan.status === "blocked" && plan.steps.some((step) => step.status === "failed")) return "failed";
    return undefined;
  }

  private async evidenceFor(tenantId: string, plan: PlanRecord): Promise<{ refs: string[]; quality?: number; assessments: number }> {
    const refs = [plan.id, ...plan.steps.map((step) => step.taskId).filter((value): value is string => Boolean(value))];
    let quality: number | undefined;
    let assessments = 0;
    if (this.deps.harvester) {
      try {
        const scored = await this.deps.harvester.assessments(tenantId, { planId: plan.id, limit: 200 });
        const recordedOnes = scored.filter((item) => item.disposition === "recorded");
        assessments = recordedOnes.length;
        if (recordedOnes.length) {
          quality = auroraRound(recordedOnes.reduce((sum, item) => sum + item.quality, 0) / recordedOnes.length);
          refs.push(...recordedOnes.slice(0, 20).map((item) => item.id));
        }
      } catch {
        // Evidence is best-effort: plan step statuses are still a recorded, honest signal.
      }
    }
    if (this.deps.bridge) {
      try {
        const links = await this.deps.bridge.links(tenantId, { planId: plan.id, limit: 100 });
        refs.push(...links.slice(0, 20).map((item) => item.id));
      } catch {
        // ignored on purpose
      }
    }
    return { refs: [...new Set(refs)].slice(0, 200), ...(quality === undefined ? {} : { quality }), assessments };
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const items = (s as any).feedback?.filter((x: any) => x.tenantId === tenantId) ?? [];
    return { total: items.length };
  }

  // ═══ P2: Explainability ═══

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    const s = await this.store.read();
    const keys = Object.keys(s);
    const arrayKey = keys.find(k => Array.isArray((s as any)[k]));
    const items: any[] = arrayKey ? ((s as any)[arrayKey] as any[]).filter((x: any) => x.tenantId === tenantId) : [];
    const entity = items.find((x: any) => x.id === entityId);
    if (!entity) throw new Error("Entity not found");
    const rationale: string[] = [`Found entity: ${entity.name ?? entity.title ?? entity.id ?? entityId}`];
    return { entity: entity.name ?? entity.title ?? entityId, summary: entity.description ?? entity.statement ?? "", rationale, details: entity };
  }
}
