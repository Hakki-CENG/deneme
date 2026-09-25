import { join } from "node:path";
import type { PlanningService, PlanRecord, PlanStep } from "./planning-service.js";
import { auroraInteger, auroraRound, auroraTags, auroraText, DurableJsonState } from "../util/aurora-state.js";

const MAX_SAMPLES = 20_000;
const MIN_SAMPLES = 3;

export interface EstimateSample {
  tenantId: string;
  planId: string;
  stepKey: string;
  bucket: string;
  estimateMinutes: number;
  actualMinutes: number;
  ratio: number;
  at: string;
}

export interface EstimateBucketProfile {
  bucket: string;
  samples: number;
  /** Median actual/estimate ratio. Above 1 means the tenant systematically under-estimates. */
  factor: number;
  meanAbsoluteError: number;
  accuracy: number;
  confidence: number;
  lastSampleAt?: string;
}

export interface EstimateProfile {
  tenantId: string;
  overall: EstimateBucketProfile;
  buckets: EstimateBucketProfile[];
  generatedAt: string;
}

export interface EstimateSuggestion {
  stepKey: string;
  bucket: string;
  estimateMinutes: number;
  suggestedMinutes: number;
  factor: number;
  samples: number;
  confidence: number;
  rationale: string;
}

interface CalibratorStateShape {
  schemaVersion: 1;
  samples: EstimateSample[];
}

/**
 * Aurora estimation calibrator: planning that learns how wrong it usually is.
 *
 * The planner already records an estimate per step, and delegated execution now records the real
 * elapsed time. That pair is the only honest source of estimation skill, and it was being thrown
 * away. This service turns it into a bounded, explainable correction:
 *
 * - samples come only from steps that genuinely finished with a recorded actual duration;
 * - the correction is the **median** ratio, not the mean, so one pathological step cannot rewrite the
 *   tenant's planning; it is clamped to a sane range and requires a minimum number of samples;
 * - corrections are bucketed (by plan tag, falling back to the plan horizon), because "research is
 *   always slower than we think" is a different fact from "deploys are quick";
 * - confidence grows with sample count and is reported, so a caller can decide whether to trust it;
 * - suggestions are suggestions: applying one to a plan is an explicit call that records the factor
 *   and sample count in the step detail, so a corrected estimate never looks like a human's.
 */
export class AuroraEstimationCalibrator {
  private readonly store: DurableJsonState<CalibratorStateShape>;

  constructor(
    rootPath: string,
    private readonly deps: { planning: PlanningService },
    private readonly now: () => number = Date.now,
    private readonly options: { minSamples?: number; minFactor?: number; maxFactor?: number } = {},
  ) {
    this.store = new DurableJsonState<CalibratorStateShape>(
      join(rootPath, "planning", "estimation.json"),
      () => ({ schemaVersion: 1, samples: [] }),
      (value) => {
        const state = value as CalibratorStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.samples);
      },
      "Aurora estimation calibrator",
    );
  }

  /** Harvest finished steps with a recorded duration into the sample set. Idempotent per step. */
  async ingest(tenantId: string, options: { planId?: string; limit?: number } = {}): Promise<{ ingested: number; skipped: number; samples: number }> {
    const plans = (await this.deps.planning.list(tenantId, { limit: auroraInteger(options.limit ?? 200, 1, 1000, "Ingest limit") }))
      .filter((plan) => (options.planId ? plan.id === options.planId : true));
    let ingested = 0;
    let skipped = 0;
    const total = await this.store.mutate((state) => {
      for (const plan of plans) {
        for (const step of plan.steps) {
          if (step.status !== "done" || step.actualMinutes === undefined || step.estimateMinutes <= 0) { skipped++; continue; }
          if (state.samples.some((item) => item.tenantId === tenantId && item.planId === plan.id && item.stepKey === step.key)) { skipped++; continue; }
          state.samples.push({
            tenantId,
            planId: plan.id,
            stepKey: step.key,
            bucket: this.bucketFor(plan),
            estimateMinutes: step.estimateMinutes,
            actualMinutes: step.actualMinutes,
            ratio: auroraRound(Math.max(0.01, step.actualMinutes) / Math.max(1, step.estimateMinutes)),
            at: step.finishedAt ?? new Date(this.now()).toISOString(),
          });
          ingested++;
        }
      }
      if (state.samples.length > MAX_SAMPLES) state.samples.splice(0, state.samples.length - MAX_SAMPLES);
      return state.samples.filter((item) => item.tenantId === tenantId).length;
    });
    return { ingested, skipped, samples: total };
  }

  /** What the recorded history says about this tenant's estimating, overall and per bucket. */
  async profile(tenantId: string): Promise<EstimateProfile> {
    const state = await this.store.read();
    const samples = state.samples.filter((item) => item.tenantId === tenantId);
    const buckets = new Map<string, EstimateSample[]>();
    for (const sample of samples) {
      const list = buckets.get(sample.bucket) ?? [];
      list.push(sample);
      buckets.set(sample.bucket, list);
    }
    return {
      tenantId,
      overall: this.profileOf("overall", samples),
      buckets: [...buckets.entries()].map(([bucket, list]) => this.profileOf(bucket, list)).sort((a, b) => b.samples - a.samples || a.bucket.localeCompare(b.bucket)),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Suggest corrected estimates for a plan's unfinished steps. Returns one entry per step, including
   * the ones left unchanged, so the caller sees why nothing happened as clearly as why it did.
   */
  async suggest(tenantId: string, planId: string): Promise<{ planId: string; suggestions: EstimateSuggestion[]; generatedAt: string }> {
    const plan = await this.deps.planning.get(tenantId, planId);
    const profile = await this.profile(tenantId);
    const bucket = this.bucketFor(plan);
    const suggestions = plan.steps
      .filter((step) => !["done", "skipped"].includes(step.status))
      .map((step) => this.suggestionFor(step, bucket, profile));
    return { planId: plan.id, suggestions, generatedAt: new Date(this.now()).toISOString() };
  }

  /**
   * Apply the correction to a plan as a proper revision. The plan's own audit trail records that the
   * change came from measured history, with the factor and the sample count, not from a new opinion.
   */
  async apply(input: { tenantId: string; planId: string; minSamples?: number }): Promise<{ planId: string; applied: EstimateSuggestion[]; skipped: EstimateSuggestion[]; plan?: PlanRecord }> {
    const minSamples = auroraInteger(input.minSamples ?? this.options.minSamples ?? MIN_SAMPLES, 1, 1000, "Minimum samples");
    const { suggestions } = await this.suggest(input.tenantId, input.planId);
    const applied = suggestions.filter((item) => item.samples >= minSamples && item.suggestedMinutes !== item.estimateMinutes);
    const skipped = suggestions.filter((item) => !applied.includes(item));
    if (!applied.length) return { planId: input.planId, applied, skipped };

    const plan = await this.deps.planning.get(input.tenantId, input.planId);
    const byKey = new Map(applied.map((item) => [item.stepKey, item]));
    const revised = await this.deps.planning.revise({
      tenantId: input.tenantId,
      planId: input.planId,
      trigger: "review",
      reason: `Estimates recalibrated from ${applied[0]!.samples} measured step(s): factor ${applied[0]!.factor}.`,
      steps: plan.steps.map((step) => {
        const suggestion = byKey.get(step.key);
        return {
          key: step.key,
          title: step.title,
          detail: suggestion
            ? `${step.detail ? `${step.detail}\n` : ""}Estimate recalibrated from ${suggestion.estimateMinutes} to ${suggestion.suggestedMinutes} minute(s) (${suggestion.rationale}).`.slice(0, 20_000)
            : step.detail,
          dependsOn: step.dependsOn,
          estimateMinutes: suggestion ? suggestion.suggestedMinutes : step.estimateMinutes,
          estimateTokens: step.estimateTokens,
          riskLevel: step.riskLevel,
          verification: step.verification,
          ...(step.assignedRoleId ? { assignedRoleId: step.assignedRoleId } : {}),
        };
      }),
    });
    return { planId: input.planId, applied, skipped, plan: revised };
  }

  async samples(tenantId: string, limit = 100): Promise<EstimateSample[]> {
    const state = await this.store.read();
    return state.samples
      .filter((item) => item.tenantId === tenantId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, auroraInteger(limit, 1, 1000, "Sample limit"))
      .map((item) => structuredClone(item));
  }

  private suggestionFor(step: PlanStep, bucket: string, profile: EstimateProfile): EstimateSuggestion {
    const bucketProfile = profile.buckets.find((item) => item.bucket === bucket);
    const chosen = bucketProfile && bucketProfile.samples >= (this.options.minSamples ?? MIN_SAMPLES) ? bucketProfile : profile.overall;
    const factor = chosen.samples >= (this.options.minSamples ?? MIN_SAMPLES) ? chosen.factor : 1;
    const suggested = factor === 1 ? step.estimateMinutes : Math.max(0, Math.round(step.estimateMinutes * factor));
    return {
      stepKey: step.key,
      bucket: chosen.bucket,
      estimateMinutes: step.estimateMinutes,
      suggestedMinutes: suggested,
      factor,
      samples: chosen.samples,
      confidence: chosen.confidence,
      rationale: chosen.samples >= (this.options.minSamples ?? MIN_SAMPLES)
        ? `median actual/estimate ratio ${chosen.factor} over ${chosen.samples} measured step(s) in "${chosen.bucket}"`
        : `only ${chosen.samples} measured step(s); not enough history to correct anything`,
    };
  }

  private profileOf(bucket: string, samples: EstimateSample[]): EstimateBucketProfile {
    if (!samples.length) {
      return { bucket, samples: 0, factor: 1, meanAbsoluteError: 0, accuracy: 0, confidence: 0 };
    }
    const ratios = samples.map((item) => item.ratio).sort((a, b) => a - b);
    const middle = Math.floor(ratios.length / 2);
    const median = ratios.length % 2 ? ratios[middle]! : (ratios[middle - 1]! + ratios[middle]!) / 2;
    const minFactor = this.options.minFactor ?? 0.25;
    const maxFactor = this.options.maxFactor ?? 4;
    const error = samples.reduce((sum, item) => sum + Math.abs(item.actualMinutes - item.estimateMinutes), 0) / samples.length;
    const relative = samples.reduce((sum, item) => sum + Math.abs(item.actualMinutes - item.estimateMinutes) / Math.max(1, item.estimateMinutes), 0) / samples.length;
    const last = samples.map((item) => item.at).sort().at(-1);
    return {
      bucket,
      samples: samples.length,
      factor: auroraRound(Math.min(maxFactor, Math.max(minFactor, median))),
      meanAbsoluteError: auroraRound(error),
      accuracy: auroraRound(Math.max(0, 1 - Math.min(1, relative))),
      // Confidence saturates around 20 samples: enough to trust, never enough to stop measuring.
      confidence: auroraRound(Math.min(1, samples.length / 20)),
      ...(last ? { lastSampleAt: last } : {}),
    };
  }

  private bucketFor(plan: PlanRecord): string {
    const tags = auroraTags(plan.tags, "Plan tags");
    return auroraText(tags[0] ?? plan.horizon, 100, "Estimate bucket");
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const items = (s as any).estimates?.filter((x: any) => x.tenantId === tenantId) ?? [];
    return { total: items.length }

};

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
