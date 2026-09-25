import { join } from "node:path";
import type { AgentSocietyService, SocietyTask } from "../society/agent-society-service.js";
import type { EventEnvelope, SessionSnapshot } from "../types.js";
import { auroraInteger, auroraRound, auroraText, auroraUnit, DurableJsonState } from "../util/aurora-state.js";
import type { AuroraExecutionBridge, DelegationLink } from "./execution-bridge.js";
import type { ExperienceDistiller } from "./experience-distiller.js";
import type { SkillEvolutionService } from "../evolution/skill-evolution-service.js";

const MAX_ASSESSMENTS = 20_000;
const MAX_EVENTS = 2_000;

export interface OutcomeCriterion {
  code: string;
  weight: number;
  score: number;
  detail: string;
}

export interface OutcomeAssessment {
  id: string;
  tenantId: string;
  linkId: string;
  planId: string;
  stepKey: string;
  taskId: string;
  childSessionId: string;
  sessionStatus: string;
  /** "recorded" — the outcome was written to the society; "review" — ambiguous, left for a human. */
  disposition: "recorded" | "review" | "skipped";
  success: boolean;
  quality: number;
  actualTokens: number;
  criteria: OutcomeCriterion[];
  evidenceEventIds: string[];
  reason: string;
  /** What the failure taught the system, if anything. Candidate-only: nothing is auto-applied. */
  learning?: { gapId?: string; gapOccurrences?: number; distilledProposals?: number; note?: string };
  at: string;
}

export interface HarvestPolicy {
  tenantId: string;
  /** Write the outcome to the society automatically when the evidence is unambiguous. */
  autoRecord: boolean;
  /** Quality at or above this is a success. */
  successAtOrAbove: number;
  /** Quality below this is a failure. Between the two is ambiguous and goes to review. */
  failBelow: number;
  /** How long a settled-but-not-closed child session must be quiet before it counts as finished. */
  settleAfterMs: number;
  maxPerRun: number;
  /** Turn a failed delegation into an evidence-backed capability gap and candidate lessons. */
  learnFromFailures: boolean;
  updatedAt: string;
}

interface HarvesterStateShape {
  schemaVersion: 1;
  assessments: OutcomeAssessment[];
  policies: HarvestPolicy[];
}

export interface HarvestResult {
  considered: number;
  recorded: number;
  review: number;
  skipped: number;
  assessments: OutcomeAssessment[];
  generatedAt: string;
}

interface CapabilityPayload { capabilityId?: string; status?: string; error?: string }

/**
 * Aurora delegated-outcome harvester: the last open link in the execution loop.
 *
 * Delegation could post work and reconcile a society outcome, but *someone still had to declare that
 * outcome by hand*. Until that happened a finished child session simply looked like work in progress,
 * so plans stalled on completed work and role reputation never moved.
 *
 * The harvester closes that gap without inventing success:
 *
 * - it only looks at child sessions that have actually settled (closed, failed, or idle and quiet for
 *   the configured settle window) — never at work still in flight;
 * - quality is a **scorecard**, not a judgement: named criteria with fixed weights, each derived from
 *   recorded events (assistant output, tool failure ratio, guardrail trips, denied capabilities,
 *   budget overrun, session failure). Every criterion is stored, so any score can be re-derived;
 * - hard failures are absolute: a session that failed, or produced no assistant output at all, is a
 *   failure regardless of the weighted score;
 * - the ambiguous middle band is *not* auto-recorded. It becomes a review item, because a system that
 *   guesses at its own success rate corrupts every calibration built on top of it;
 * - evidence is mandatory and real: outcomes carry event IDs from the child session (failures first),
 *   which the society itself verifies before accepting them.
 */
export class AuroraOutcomeHarvester {
  private readonly store: DurableJsonState<HarvesterStateShape>;

  constructor(
    rootPath: string,
    private readonly deps: {
      bridge: AuroraExecutionBridge;
      society: AgentSocietyService;
      sessions: { session(sessionId: string): Promise<SessionSnapshot> };
      events: { read(sessionId: string, afterSequence?: number, limit?: number): Promise<EventEnvelope[]> };
      /** Optional learning sinks. Absent in tests and trimmed deployments; never required. */
      evolution?: SkillEvolutionService;
      distiller?: ExperienceDistiller;
    },
    private readonly now: () => number = Date.now,
  ) {
    this.store = new DurableJsonState<HarvesterStateShape>(
      join(rootPath, "planning", "harvest.json"),
      () => ({ schemaVersion: 1, assessments: [], policies: [] }),
      (value) => {
        const state = value as HarvesterStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.assessments) && Array.isArray(state.policies);
      },
      "Aurora outcome harvester",
    );
  }

  async policy(tenantId: string): Promise<HarvestPolicy> {
    return await this.store.mutate((state) => structuredClone(this.mutablePolicy(state, tenantId)));
  }

  async configure(input: {
    tenantId: string; autoRecord?: boolean; successAtOrAbove?: number; failBelow?: number;
    settleAfterMs?: number; maxPerRun?: number; learnFromFailures?: boolean;
  }): Promise<HarvestPolicy> {
    return await this.store.mutate((state) => {
      const policy = this.mutablePolicy(state, input.tenantId);
      if (input.autoRecord !== undefined) policy.autoRecord = input.autoRecord;
      if (input.successAtOrAbove !== undefined) policy.successAtOrAbove = auroraUnit(input.successAtOrAbove, "Success threshold");
      if (input.failBelow !== undefined) policy.failBelow = auroraUnit(input.failBelow, "Failure threshold");
      if (policy.failBelow > policy.successAtOrAbove) throw new Error("The failure threshold cannot sit above the success threshold.");
      if (input.settleAfterMs !== undefined) policy.settleAfterMs = auroraInteger(input.settleAfterMs, 0, 24 * 60 * 60_000, "Settle window");
      if (input.maxPerRun !== undefined) policy.maxPerRun = auroraInteger(input.maxPerRun, 1, 200, "Harvest limit");
      if (input.learnFromFailures !== undefined) policy.learnFromFailures = input.learnFromFailures;
      policy.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(policy);
    });
  }

  /** Score one delegated task from its child session's recorded events, changing nothing. */
  async assess(tenantId: string, linkId: string): Promise<Omit<OutcomeAssessment, "id" | "disposition" | "at">> {
    const link = (await this.deps.bridge.links(tenantId, { limit: 1000 })).find((item) => item.id === linkId);
    if (!link) throw new Error("Aurora delegation not found in tenant.");
    const task = await this.deps.society.getTask(tenantId, link.taskId);
    if (!task.childSessionId) throw new Error(`Delegation ${linkId} has no child session yet.`);
    const [session, events] = await Promise.all([
      this.deps.sessions.session(task.childSessionId),
      this.deps.events.read(task.childSessionId, 0, MAX_EVENTS),
    ]);
    const policy = await this.policy(tenantId);
    return this.score(tenantId, link, task, session, events, policy);
  }

  /**
   * Walk every delegation whose society task is running, score the settled ones, and record the
   * unambiguous outcomes. Ambiguity is preserved as a review item rather than resolved by guessing.
   */
  async harvest(input: { tenantId: string; planId?: string; linkId?: string; force?: boolean }): Promise<HarvestResult> {
    const policy = await this.policy(input.tenantId);
    const links = (await this.deps.bridge.links(input.tenantId, {
      openOnly: true,
      limit: 1000,
      ...(input.planId ? { planId: input.planId } : {}),
    })).filter((item) => (input.linkId ? item.id === input.linkId : true)).slice(0, policy.maxPerRun);

    const assessments: OutcomeAssessment[] = [];
    let recorded = 0;
    let review = 0;
    let skipped = 0;

    for (const link of links) {
      let task: SocietyTask;
      try {
        task = await this.deps.society.getTask(input.tenantId, link.taskId);
      } catch {
        skipped++;
        continue;
      }
      if (task.status !== "running" || !task.childSessionId) { skipped++; continue; }

      let session: SessionSnapshot;
      let events: EventEnvelope[];
      try {
        session = await this.deps.sessions.session(task.childSessionId);
        events = await this.deps.events.read(task.childSessionId, 0, MAX_EVENTS);
      } catch {
        skipped++;
        continue;
      }

      const settled = this.isSettled(session, events, policy, input.force ?? false);
      if (!settled.settled) { skipped++; continue; }

      const scored = this.score(input.tenantId, link, task, session, events, policy);
      let disposition: OutcomeAssessment["disposition"] = "review";
      let reason = scored.reason;

      // A hard failure is never ambiguous: no output or a failed session is a recorded failure.
      const hardFailure = scored.reason.startsWith("Hard failure");
      const ambiguous = !hardFailure && !scored.success && scored.quality >= policy.failBelow && scored.quality < policy.successAtOrAbove;
      if (!scored.evidenceEventIds.length) {
        disposition = "review";
        reason = "The child session produced no event that could serve as evidence; a human must judge this task.";
      } else if (!policy.autoRecord) {
        disposition = "review";
        reason = "Automatic recording is disabled for this tenant.";
      } else if (ambiguous) {
        disposition = "review";
        reason = `Quality ${scored.quality} sits between the failure (${policy.failBelow}) and success (${policy.successAtOrAbove}) thresholds; recording it either way would corrupt calibration.`;
      } else {
        try {
          await this.deps.society.recordOutcome({
            tenantId: input.tenantId,
            taskId: task.id,
            success: scored.success,
            quality: scored.quality,
            actualTokens: scored.actualTokens,
            evidenceEventIds: scored.evidenceEventIds,
          });
          disposition = "recorded";
        } catch (error) {
          disposition = "review";
          reason = `Society refused the outcome: ${(error as Error).message}`.slice(0, 500);
        }
      }

      const learning = await this.learn(input.tenantId, policy, link, scored, disposition, session.sessionId);
      const assessment: OutcomeAssessment = {
        id: `harvest-${task.id}-${events.length}-${Math.floor(this.now() / 1000)}`,
        ...scored,
        disposition,
        reason,
        ...(learning ? { learning } : {}),
        at: new Date(this.now()).toISOString(),
      };
      assessments.push(assessment);
      if (disposition === "recorded") recorded++;
      else if (disposition === "review") review++;
      else skipped++;
    }

    if (assessments.length) {
      await this.store.mutate((state) => {
        for (const assessment of assessments) state.assessments.push(assessment);
        if (state.assessments.length > MAX_ASSESSMENTS) state.assessments.splice(0, state.assessments.length - MAX_ASSESSMENTS);
      });
    }
    if (recorded) await this.deps.bridge.sync(input.planId ? { tenantId: input.tenantId, planId: input.planId } : { tenantId: input.tenantId });

    return { considered: links.length, recorded, review, skipped, assessments, generatedAt: new Date(this.now()).toISOString() };
  }

  /** Everything the harvester decided, including the criteria behind each score. */
  async assessments(tenantId: string, filter: { planId?: string; disposition?: OutcomeAssessment["disposition"]; limit?: number } = {}): Promise<OutcomeAssessment[]> {
    const state = await this.store.read();
    return state.assessments
      .filter((item) => item.tenantId === tenantId)
      .filter((item) => (filter.planId ? item.planId === filter.planId : true))
      .filter((item) => (filter.disposition ? item.disposition === filter.disposition : true))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, auroraInteger(filter.limit ?? 50, 1, 1000, "Assessment limit"))
      .map((item) => structuredClone(item));
  }

  /** The queue a human actually has to work: delegated tasks the harvester refused to judge. */
  async reviewQueue(tenantId: string, limit = 50): Promise<OutcomeAssessment[]> {
    return await this.assessments(tenantId, { disposition: "review", limit });
  }

  /**
   * Resolve a review item by hand. The human supplies the verdict; the recorded evidence and the
   * machine scorecard stay attached, so the disagreement itself is auditable.
   */
  async resolveReview(input: { tenantId: string; assessmentId: string; success: boolean; quality?: number; note?: string }): Promise<OutcomeAssessment> {
    const state = await this.store.read();
    const assessment = state.assessments.find((item) => item.tenantId === input.tenantId && item.id === input.assessmentId);
    if (!assessment) throw new Error("Aurora outcome assessment not found in tenant.");
    if (assessment.disposition !== "review") throw new Error(`Assessment ${input.assessmentId} is already ${assessment.disposition}.`);
    const quality = input.quality === undefined ? assessment.quality : auroraUnit(input.quality, "Quality");
    await this.deps.society.recordOutcome({
      tenantId: input.tenantId,
      taskId: assessment.taskId,
      success: input.success,
      quality,
      actualTokens: assessment.actualTokens,
      evidenceEventIds: assessment.evidenceEventIds,
    });
    const updated = await this.store.mutate((current) => {
      const record = current.assessments.find((item) => item.tenantId === input.tenantId && item.id === input.assessmentId)!;
      record.disposition = "recorded";
      record.success = input.success;
      record.quality = quality;
      record.reason = `Resolved by a human${input.note ? `: ${auroraText(input.note, 1000, "Review note")}` : "."}`;
      return structuredClone(record);
    });
    await this.deps.bridge.sync({ tenantId: input.tenantId, planId: assessment.planId });
    return updated;
  }

  /** One unattended pass: harvest settled work, then reconcile and (if enabled) delegate more. */
  async runCycle(tenantId: string): Promise<{ harvested: number; review: number; synced: number; updatedSteps: number; delegated: number; skipped: number; autoDelegate: boolean }> {
    let harvested = 0;
    let review = 0;
    try {
      const result = await this.harvest({ tenantId });
      harvested = result.recorded;
      review = result.review;
    } catch {
      // Harvesting is best-effort: reconciliation and delegation must still run.
    }
    const cycle = await this.deps.bridge.runCycle(tenantId);
    return { harvested, review, ...cycle };
  }

  /**
   * A delegated failure is the cheapest lesson Aurora ever gets: the work is already done, the
   * trajectory is already recorded, and the verdict is already evidence-bound. This turns it into a
   * deduplicated capability-gap signal and candidate lessons — both governed, neither auto-applied.
   */
  private async learn(
    tenantId: string,
    policy: HarvestPolicy,
    link: DelegationLink,
    scored: Omit<OutcomeAssessment, "id" | "disposition" | "at">,
    disposition: OutcomeAssessment["disposition"],
    childSessionId: string,
  ): Promise<OutcomeAssessment["learning"] | undefined> {
    if (!policy.learnFromFailures) return undefined;
    if (disposition === "skipped") return undefined;
    // Successes teach nothing new here; the interesting signal is failure and genuine ambiguity.
    if (disposition === "recorded" && scored.success) return undefined;

    const learning: NonNullable<OutcomeAssessment["learning"]> = {};
    const weakest = [...scored.criteria].sort((a, b) => a.score - b.score)[0];
    if (this.deps.evolution) {
      try {
        const observation = await this.deps.evolution.observeGap({
          tenantId,
          kind: "friction",
          description: `Delegated plan step "${link.stepKey}" did not succeed`,
          context: [
            `Plan: ${link.planTitle}`,
            `Role: ${link.assignedRoleId ?? link.nominatedRoleId ?? "unassigned"}`,
            `Quality: ${scored.quality} (${scored.reason})`,
            weakest ? `Weakest criterion: ${weakest.code} at ${weakest.score} — ${weakest.detail}` : "",
          ].filter(Boolean).join("\n").slice(0, 5000),
          severity: Math.min(1, Math.max(0.1, 1 - scored.quality)),
          evidenceRefs: [link.id, link.taskId, ...scored.evidenceEventIds.slice(0, 10)],
        });
        learning.gapId = observation.gap.id;
        learning.gapOccurrences = observation.gap.occurrences;
      } catch (error) {
        learning.note = `Gap observation failed: ${(error as Error).message}`.slice(0, 300);
      }
    }
    if (this.deps.distiller) {
      try {
        const report = await this.deps.distiller.distill({
          tenantId,
          sessionId: childSessionId,
          objective: `${link.planTitle} · ${link.stepKey}`,
        });
        learning.distilledProposals = report.proposals.length;
      } catch (error) {
        learning.note = `${learning.note ? `${learning.note}; ` : ""}Distillation failed: ${(error as Error).message}`.slice(0, 300);
      }
    }
    return Object.keys(learning).length ? learning : undefined;
  }

  private isSettled(session: SessionSnapshot, events: EventEnvelope[], policy: HarvestPolicy, force: boolean): { settled: boolean; why: string } {
    if (force) return { settled: true, why: "forced" };
    if (session.status === "closed" || session.status === "failed") return { settled: true, why: session.status };
    if (session.activeTurnId) return { settled: false, why: "a turn is still running" };
    if (["running", "compacting", "provisioning", "recovering", "waiting_children"].includes(session.status)) return { settled: false, why: session.status };
    if (session.status === "waiting_approval") return { settled: false, why: "waiting for approval" };
    if (session.status === "paused") return { settled: false, why: "paused" };
    const last = events[events.length - 1];
    const quietFor = last ? this.now() - Date.parse(last.timestamp) : Number.POSITIVE_INFINITY;
    if (quietFor < policy.settleAfterMs) return { settled: false, why: `quiet for only ${Math.max(0, Math.round(quietFor / 1000))}s` };
    return { settled: true, why: "idle and quiet" };
  }

  private score(
    tenantId: string,
    link: DelegationLink,
    task: SocietyTask,
    session: SessionSnapshot,
    events: EventEnvelope[],
    policy: HarvestPolicy,
  ): Omit<OutcomeAssessment, "id" | "disposition" | "at"> {
    const finished = events.filter((item) => item.type === "capability.finished");
    const failures = finished.filter((item) => {
      const payload = item.payload as CapabilityPayload;
      return payload?.status === "failed" || payload?.status === "error" || typeof payload?.error === "string";
    });
    const denied = events.filter((item) => item.type === "capability.policy" && JSON.stringify(item.payload ?? {}).includes("deny"));
    const guardrails = events.filter((item) => item.type.startsWith("guardrail."));
    const assistantMessages = events.filter((item) => {
      if (item.type !== "message.created") return false;
      const payload = item.payload as { message?: { role?: string } } | undefined;
      return payload?.message?.role === "assistant";
    });
    const usage = session.totalUsage;
    const totalTokens = Math.max(0, (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));
    const failureRatio = finished.length ? failures.length / finished.length : 0;
    const overrun = task.maxTokens ? Math.max(0, totalTokens - task.maxTokens) / task.maxTokens : 0;

    const criteria: OutcomeCriterion[] = [
      {
        code: "produced-output",
        weight: 0.35,
        score: assistantMessages.length ? 1 : 0,
        detail: `${assistantMessages.length} assistant message(s) recorded in the child session.`,
      },
      {
        code: "tool-reliability",
        weight: 0.3,
        score: auroraRound(1 - Math.min(1, failureRatio)),
        detail: `${failures.length} of ${finished.length} capability call(s) failed.`,
      },
      {
        code: "session-health",
        weight: 0.2,
        score: session.status === "failed" ? 0 : session.status === "closed" || session.status === "idle" ? 1 : 0.5,
        detail: `Child session ended in status "${session.status}".`,
      },
      {
        code: "no-guardrail-trips",
        weight: 0.1,
        score: guardrails.length ? 0 : denied.length ? 0.5 : 1,
        detail: `${guardrails.length} guardrail event(s), ${denied.length} policy denial(s).`,
      },
      {
        code: "within-budget",
        weight: 0.05,
        score: auroraRound(1 - Math.min(1, overrun)),
        detail: `${totalTokens} token(s) against a ${task.maxTokens} budget.`,
      },
    ];

    const weighted = criteria.reduce((sum, item) => sum + item.weight * item.score, 0);
    const totalWeight = criteria.reduce((sum, item) => sum + item.weight, 0);
    const quality = auroraRound(Math.max(0, Math.min(1, weighted / (totalWeight || 1))));

    // Hard failures override the weighted score: no output, or a failed session, is not partial credit.
    const hardFailure = session.status === "failed" ? "the child session failed"
      : !assistantMessages.length ? "the child session produced no assistant output"
        : undefined;

    // Evidence prefers failures (they explain a bad outcome) and always includes the final message.
    const evidence = [
      ...failures.slice(0, 5).map((item) => item.eventId),
      ...assistantMessages.slice(-3).map((item) => item.eventId),
      ...finished.slice(-2).map((item) => item.eventId),
    ];
    const evidenceEventIds = [...new Set(evidence)].filter(Boolean).slice(0, 20);
    if (!evidenceEventIds.length && events.length) evidenceEventIds.push(events[events.length - 1]!.eventId);

    return {
      tenantId,
      linkId: link.id,
      planId: link.planId,
      stepKey: link.stepKey,
      taskId: task.id,
      childSessionId: session.sessionId,
      sessionStatus: session.status,
      // The verdict uses the tenant's own thresholds; the middle band is neither success nor failure
      // and is filtered into review by the caller rather than rounded to the nearest answer.
      success: !hardFailure && quality >= policy.successAtOrAbove,
      quality: hardFailure ? Math.min(quality, 0.2) : quality,
      actualTokens: Math.min(task.maxTokens * 2, totalTokens),
      criteria,
      evidenceEventIds,
      reason: hardFailure
        ? `Hard failure: ${hardFailure}.`
        : `Weighted scorecard over ${criteria.length} criteria from ${events.length} recorded event(s).`,
    };
  }

  private mutablePolicy(state: HarvesterStateShape, tenantId: string): HarvestPolicy {
    const id = auroraText(tenantId, 200, "Tenant ID");
    let policy = state.policies.find((item) => item.tenantId === id);
    if (!policy) {
      policy = {
        tenantId: id,
        autoRecord: true,
        successAtOrAbove: 0.6,
        failBelow: 0.35,
        settleAfterMs: 60_000,
        maxPerRun: 25,
        learnFromFailures: true,
        updatedAt: new Date(this.now()).toISOString(),
      };
      state.policies.push(policy);
    }
    // Forward migration for policies written before failure learning existed.
    if (policy.learnFromFailures === undefined) policy.learnFromFailures = true;
    return policy;
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const items = (s as any).outcomes?.filter((x: any) => x.tenantId === tenantId) ?? [];
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
