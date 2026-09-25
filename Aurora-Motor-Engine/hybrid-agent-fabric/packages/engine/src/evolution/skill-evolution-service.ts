import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  auroraDigest, auroraIds, auroraInteger, auroraRound, auroraTags, auroraText, auroraTokens, auroraUnit, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_GAPS = 50_000;
const MAX_CANDIDATES = 20_000;
const MAX_JOURNAL = 50_000;
const MAX_WORKFLOWS = 5_000;

export type EvolutionGapKind = "capability-gap" | "friction" | "bottleneck" | "error-pattern";
export type SkillStage = "blueprint" | "sandbox" | "test" | "beta" | "production" | "archived";

export interface EvolutionGap {
  id: string;
  tenantId: string;
  kind: EvolutionGapKind;
  signature: string;
  description: string;
  context: string;
  occurrences: number;
  severity: number;
  status: "open" | "candidate-created" | "resolved" | "dismissed";
  evidenceRefs: string[];
  candidateId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

export interface SkillScoreCard {
  accuracy: number;
  reliability: number;
  speed: number;
  utility: number;
  safety: number;
  composite: number;
}

export interface SkillEvaluationRecord {
  id: string;
  suite: string;
  passed: number;
  failed: number;
  safetyFindings: number;
  averageLatencyMs: number;
  notes: string;
  recordedAt: string;
}

export interface SkillCandidate {
  id: string;
  tenantId: string;
  gapId?: string;
  name: string;
  purpose: string;
  version: string;
  inputs: string[];
  outputs: string[];
  tools: string[];
  risks: string[];
  tests: string[];
  stage: SkillStage;
  stageHistory: Array<{ from: SkillStage; to: SkillStage; reason: string; actor: string; at: string }>;
  scores: SkillScoreCard;
  usage: { invocations: number; successes: number; failures: number; totalDurationMs: number; lastUsedAt?: string };
  evaluations: SkillEvaluationRecord[];
  regressionBaseline: Array<{ suite: string; passRate: number; recordedAt: string }>;
  approvals: Array<{ actor: string; reason: string; at: string }>;
  compositeOfIds: string[];
  skillRegistryId?: string;
  retiredReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowVersion {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  steps: string[];
  bottleneckStep?: string;
  averageDurationMs: number;
  successRate: number;
  supersedesVersionId?: string;
  rationale: string;
  createdAt: string;
}

export interface EvolutionJournalEntry {
  id: string;
  tenantId: string;
  at: string;
  kind: "gap" | "stage" | "evaluation" | "retirement" | "workflow" | "regression" | "composition";
  subjectId: string;
  summary: string;
  detailDigest: string;
}

export interface EvolutionIndex {
  tenantId: string;
  productionSkills: number;
  betaSkills: number;
  averageComposite: number;
  successRate: number;
  gapClosureRate: number;
  workflowImprovement: number;
  index: number;
  delta: number;
  generatedAt: string;
}

interface EvolutionStateShape {
  schemaVersion: 1;
  gaps: EvolutionGap[];
  candidates: SkillCandidate[];
  workflows: WorkflowVersion[];
  journal: EvolutionJournalEntry[];
  indexHistory: Array<{ tenantId: string; index: number; at: string }>;
}

const STAGE_ORDER: SkillStage[] = ["blueprint", "sandbox", "test", "beta", "production"];

/**
 * Aurora Phase F — controlled skill and workflow evolution.
 *
 * Nothing self-promotes: a candidate walks blueprint -> sandbox -> test -> beta -> production and each
 * gate requires evidence (evaluations, safety findings, regression baseline) plus a human/system
 * approval for production. Retirement, journalling and the cognitive evolution index close the loop.
 */
export class SkillEvolutionService {
  private readonly store: DurableJsonState<EvolutionStateShape>;

  constructor(
    rootPath: string,
    private readonly now: () => number = Date.now,
    private readonly options: { candidateThreshold?: number } = {},
  ) {
    this.store = new DurableJsonState<EvolutionStateShape>(
      join(rootPath, "evolution", "state.json"),
      () => ({ schemaVersion: 1, gaps: [], candidates: [], workflows: [], journal: [], indexHistory: [] }),
      (value) => {
        const state = value as EvolutionStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.gaps) && Array.isArray(state.candidates)
          && Array.isArray(state.workflows) && Array.isArray(state.journal) && Array.isArray(state.indexHistory);
      },
      "Aurora evolution state",
    );
  }

  /** Capability-gap and repeated-friction detection. Identical signatures increment instead of duplicating. */
  async observeGap(input: { tenantId: string; kind: EvolutionGapKind; description: string; context?: string; severity?: number; evidenceRefs?: string[] }): Promise<{ gap: EvolutionGap; candidateRecommended: boolean }> {
    return await this.store.mutate((state) => {
      if (state.gaps.length >= MAX_GAPS) throw new Error("Evolution gap limit reached.");
      const description = auroraText(input.description, 5000, "Gap description");
      const signature = auroraDigest(`${input.kind}:${auroraTokens(description).sort().join(" ")}`);
      const nowIso = new Date(this.now()).toISOString();
      let gap = state.gaps.find((item) => item.tenantId === input.tenantId && item.signature === signature && item.status !== "dismissed");
      if (gap) {
        gap.occurrences++;
        gap.lastSeenAt = nowIso;
        gap.updatedAt = nowIso;
        if (input.severity !== undefined) gap.severity = Math.max(gap.severity, auroraUnit(input.severity, "Gap severity"));
        gap.evidenceRefs = [...new Set([...gap.evidenceRefs, ...auroraIds(input.evidenceRefs, 200, "Gap evidence refs")])].slice(0, 200);
      } else {
        gap = {
          id: `gap-${randomUUID()}`,
          tenantId: input.tenantId,
          kind: input.kind,
          signature,
          description,
          context: input.context ? auroraText(input.context, 20_000, "Gap context") : "",
          occurrences: 1,
          severity: auroraUnit(input.severity ?? 0.5, "Gap severity"),
          status: "open",
          evidenceRefs: auroraIds(input.evidenceRefs, 200, "Gap evidence refs"),
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          updatedAt: nowIso,
        };
        state.gaps.push(gap);
        this.journal(state, input.tenantId, "gap", gap.id, `New ${input.kind} detected: ${description.slice(0, 120)}`, description);
      }
      const threshold = this.options.candidateThreshold ?? 3;
      const recommended = gap.status === "open" && (gap.occurrences >= threshold || gap.severity >= 0.8);
      return { gap: structuredClone(gap), candidateRecommended: recommended };
    });
  }

  async gaps(tenantId: string, status?: EvolutionGap["status"]): Promise<EvolutionGap[]> {
    const state = await this.store.read();
    return state.gaps
      .filter((item) => item.tenantId === tenantId && (!status || item.status === status))
      .sort((a, b) => b.severity * b.occurrences - a.severity * a.occurrences)
      .map((item) => structuredClone(item));
  }

  async dismissGap(tenantId: string, gapId: string, reason: string): Promise<EvolutionGap> {
    return await this.store.mutate((state) => {
      const gap = this.mutableGap(state, tenantId, gapId);
      gap.status = "dismissed";
      gap.updatedAt = new Date(this.now()).toISOString();
      this.journal(state, tenantId, "gap", gap.id, `Gap dismissed: ${auroraText(reason, 1000, "Dismiss reason")}`, reason);
      return structuredClone(gap);
    });
  }

  /** Create a skill blueprint. Blueprints are inert designs: purpose, inputs, outputs, tools, risks and tests. */
  async createBlueprint(input: {
    tenantId: string; name: string; purpose: string; gapId?: string; inputs?: string[]; outputs?: string[];
    tools?: string[]; risks?: string[]; tests?: string[]; compositeOfIds?: string[];
  }): Promise<SkillCandidate> {
    return await this.store.mutate((state) => {
      if (state.candidates.length >= MAX_CANDIDATES) throw new Error("Skill candidate limit reached.");
      const name = auroraText(input.name, 200, "Skill name");
      if (state.candidates.some((item) => item.tenantId === input.tenantId && item.name.toLowerCase() === name.toLowerCase() && item.stage !== "archived")) {
        throw new Error("An active skill candidate with this name already exists.");
      }
      let gap: EvolutionGap | undefined;
      if (input.gapId) {
        gap = this.mutableGap(state, input.tenantId, input.gapId);
        if (gap.status === "dismissed") throw new Error("Dismissed gaps cannot produce skill candidates.");
      }
      const members = auroraIds(input.compositeOfIds, 20, "Composite member IDs");
      for (const memberId of members) {
        const member = state.candidates.find((item) => item.tenantId === input.tenantId && item.id === memberId);
        if (!member) throw new Error("Composite member skill not found in tenant.");
        if (member.stage !== "production" && member.stage !== "beta") throw new Error("Composite skills may only combine beta or production members.");
      }
      const nowIso = new Date(this.now()).toISOString();
      const candidate: SkillCandidate = {
        id: `skill-${randomUUID()}`,
        tenantId: input.tenantId,
        ...(gap ? { gapId: gap.id } : {}),
        name,
        purpose: auroraText(input.purpose, 10_000, "Skill purpose"),
        version: "0.1.0",
        inputs: boundedList(input.inputs, "Skill inputs"),
        outputs: boundedList(input.outputs, "Skill outputs"),
        tools: boundedList(input.tools, "Skill tools"),
        risks: boundedList(input.risks, "Skill risks"),
        tests: boundedList(input.tests, "Skill tests"),
        stage: "blueprint",
        stageHistory: [],
        scores: { accuracy: 0, reliability: 0, speed: 0, utility: 0, safety: 0, composite: 0 },
        usage: { invocations: 0, successes: 0, failures: 0, totalDurationMs: 0 },
        evaluations: [],
        regressionBaseline: [],
        approvals: [],
        compositeOfIds: members,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.candidates.push(candidate);
      if (gap) {
        gap.status = "candidate-created";
        gap.candidateId = candidate.id;
        gap.updatedAt = nowIso;
      }
      this.journal(state, input.tenantId, "stage", candidate.id, `Blueprint created for ${candidate.name}`, candidate.purpose);
      return structuredClone(candidate);
    });
  }

  /** Record a sandbox/test/beta evaluation. Scores are always recomputed from evidence, never set by hand. */
  async recordEvaluation(input: {
    tenantId: string; candidateId: string; suite: string; passed: number; failed: number;
    safetyFindings?: number; averageLatencyMs?: number; utility?: number; notes?: string;
  }): Promise<SkillCandidate> {
    return await this.store.mutate((state) => {
      const candidate = this.mutableCandidate(state, input.tenantId, input.candidateId);
      if (candidate.stage === "archived") throw new Error("Archived skills cannot be evaluated.");
      const passed = auroraInteger(input.passed, 0, 1_000_000, "Passed assertions");
      const failed = auroraInteger(input.failed, 0, 1_000_000, "Failed assertions");
      if (passed + failed === 0) throw new Error("An evaluation must contain at least one assertion.");
      const safetyFindings = auroraInteger(input.safetyFindings ?? 0, 0, 10_000, "Safety findings");
      const latency = auroraInteger(input.averageLatencyMs ?? 1000, 0, 24 * 60 * 60_000, "Average latency");
      const nowIso = new Date(this.now()).toISOString();
      const record: SkillEvaluationRecord = {
        id: `eval-${randomUUID()}`,
        suite: auroraText(input.suite, 200, "Evaluation suite"),
        passed,
        failed,
        safetyFindings,
        averageLatencyMs: latency,
        notes: input.notes ? auroraText(input.notes, 5000, "Evaluation notes") : "",
        recordedAt: nowIso,
      };
      candidate.evaluations.push(record);
      if (candidate.evaluations.length > 200) candidate.evaluations.splice(0, candidate.evaluations.length - 200);
      const totals = candidate.evaluations.reduce((acc, item) => ({
        passed: acc.passed + item.passed,
        failed: acc.failed + item.failed,
        findings: acc.findings + item.safetyFindings,
        latency: acc.latency + item.averageLatencyMs,
      }), { passed: 0, failed: 0, findings: 0, latency: 0 });
      const accuracy = auroraRound(totals.passed / (totals.passed + totals.failed));
      const usage = candidate.usage;
      const reliability = usage.invocations ? auroraRound(usage.successes / usage.invocations) : accuracy;
      const speed = auroraRound(Math.max(0, 1 - Math.min(1, (totals.latency / candidate.evaluations.length) / 60_000)));
      const utility = input.utility === undefined ? candidate.scores.utility : auroraUnit(input.utility, "Skill utility");
      // Safety is remediable but only with evidence: after any finding, the score recovers through
      // consecutive finding-free evaluations instead of being averaged away.
      let cleanStreak = 0;
      for (const item of [...candidate.evaluations].reverse()) {
        if (item.safetyFindings > 0) break;
        cleanStreak++;
      }
      const safety = totals.findings === 0 ? 1 : auroraRound(Math.max(0, Math.min(1, 0.5 + cleanStreak * 0.25)));
      candidate.scores = {
        accuracy,
        reliability,
        speed,
        utility,
        safety,
        composite: auroraRound(accuracy * 0.25 + reliability * 0.25 + speed * 0.1 + utility * 0.15 + safety * 0.25),
      };
      candidate.updatedAt = nowIso;
      this.journal(state, input.tenantId, "evaluation", candidate.id, `${candidate.name} evaluated on ${record.suite}: ${passed}/${passed + failed} passing, ${safetyFindings} safety finding(s)`, record.notes);
      return structuredClone(candidate);
    });
  }

  /** Record real usage of a promoted skill: reliability and speed reflect production behaviour. */
  async recordUsage(input: { tenantId: string; candidateId: string; success: boolean; durationMs: number }): Promise<SkillCandidate> {
    return await this.store.mutate((state) => {
      const candidate = this.mutableCandidate(state, input.tenantId, input.candidateId);
      if (!["beta", "production"].includes(candidate.stage)) throw new Error("Only beta or production skills report usage.");
      const nowIso = new Date(this.now()).toISOString();
      candidate.usage.invocations++;
      if (input.success) candidate.usage.successes++; else candidate.usage.failures++;
      candidate.usage.totalDurationMs += auroraInteger(input.durationMs, 0, 24 * 60 * 60_000, "Usage duration");
      candidate.usage.lastUsedAt = nowIso;
      const reliability = auroraRound(candidate.usage.successes / candidate.usage.invocations);
      const averageMs = candidate.usage.totalDurationMs / candidate.usage.invocations;
      candidate.scores = {
        ...candidate.scores,
        reliability,
        speed: auroraRound(Math.max(0, 1 - Math.min(1, averageMs / 60_000))),
      };
      candidate.scores.composite = auroraRound(candidate.scores.accuracy * 0.25 + reliability * 0.25 + candidate.scores.speed * 0.1 + candidate.scores.utility * 0.15 + candidate.scores.safety * 0.25);
      candidate.updatedAt = nowIso;
      return structuredClone(candidate);
    });
  }

  async recordRegressionBaseline(tenantId: string, candidateId: string, suite: string, passRate: number): Promise<SkillCandidate> {
    return await this.store.mutate((state) => {
      const candidate = this.mutableCandidate(state, tenantId, candidateId);
      const entry = { suite: auroraText(suite, 200, "Baseline suite"), passRate: auroraUnit(passRate, "Baseline pass rate"), recordedAt: new Date(this.now()).toISOString() };
      const existing = candidate.regressionBaseline.find((item) => item.suite === entry.suite);
      if (existing) {
        existing.passRate = entry.passRate;
        existing.recordedAt = entry.recordedAt;
      } else candidate.regressionBaseline.push(entry);
      candidate.updatedAt = entry.recordedAt;
      return structuredClone(candidate);
    });
  }

  /** Regression protection: a new build may not lose ground against any recorded baseline suite. */
  async checkRegression(tenantId: string, candidateId: string, results: Array<{ suite: string; passRate: number }>): Promise<{ passed: boolean; violations: Array<{ suite: string; baseline: number; observed: number }> }> {
    return await this.store.mutate((state) => {
      const candidate = this.mutableCandidate(state, tenantId, candidateId);
      const violations: Array<{ suite: string; baseline: number; observed: number }> = [];
      for (const baseline of candidate.regressionBaseline) {
        const observed = results.find((item) => item.suite === baseline.suite);
        if (!observed) {
          violations.push({ suite: baseline.suite, baseline: baseline.passRate, observed: 0 });
          continue;
        }
        const rate = auroraUnit(observed.passRate, "Observed pass rate");
        if (rate + 1e-9 < baseline.passRate) violations.push({ suite: baseline.suite, baseline: baseline.passRate, observed: rate });
      }
      if (violations.length) {
        this.journal(state, tenantId, "regression", candidate.id, `${candidate.name} regressed on ${violations.length} suite(s)`, violations);
      }
      return { passed: violations.length === 0, violations };
    });
  }

  /**
   * Advance one stage. Gates are cumulative and evidence-based:
   * sandbox needs tests defined, test needs a sandbox evaluation, beta needs accuracy/safety,
   * production needs an approval, a regression baseline and a clean composite score.
   */
  async advanceStage(input: { tenantId: string; candidateId: string; to: SkillStage; actor: string; reason: string; approval?: { actor: string; reason: string } }): Promise<SkillCandidate> {
    return await this.store.mutate((state) => {
      const candidate = this.mutableCandidate(state, input.tenantId, input.candidateId);
      if (candidate.stage === "archived") throw new Error("Archived skills cannot be advanced.");
      if (input.to === "archived") throw new Error("Use retire() to archive a skill.");
      const fromIndex = STAGE_ORDER.indexOf(candidate.stage);
      const toIndex = STAGE_ORDER.indexOf(input.to);
      if (toIndex !== fromIndex + 1) throw new Error(`Skill stage transition ${candidate.stage} -> ${input.to} is forbidden; evolution is strictly staged.`);
      const violations = this.stageGateViolations(candidate, input.to, input.approval);
      if (violations.length) throw new Error(`Skill stage gate failed: ${violations.join(" ")}`);
      const nowIso = new Date(this.now()).toISOString();
      if (input.approval) candidate.approvals.push({ actor: auroraText(input.approval.actor, 200, "Approval actor"), reason: auroraText(input.approval.reason, 2000, "Approval reason"), at: nowIso });
      candidate.stageHistory.push({ from: candidate.stage, to: input.to, reason: auroraText(input.reason, 2000, "Stage reason"), actor: auroraText(input.actor, 200, "Stage actor"), at: nowIso });
      candidate.stage = input.to;
      candidate.version = bumpVersion(candidate.version, input.to);
      candidate.updatedAt = nowIso;
      if (input.to === "production" && candidate.gapId) {
        const gap = state.gaps.find((item) => item.tenantId === input.tenantId && item.id === candidate.gapId);
        if (gap) {
          gap.status = "resolved";
          gap.updatedAt = nowIso;
        }
      }
      this.journal(state, input.tenantId, "stage", candidate.id, `${candidate.name} advanced to ${input.to} (v${candidate.version})`, input.reason);
      return structuredClone(candidate);
    });
  }

  /** Explain exactly what a candidate still needs before the next gate opens. */
  async stageReadiness(tenantId: string, candidateId: string): Promise<{ stage: SkillStage; next?: SkillStage; blockers: string[]; scores: SkillScoreCard }> {
    const state = await this.store.read();
    const candidate = state.candidates.find((item) => item.tenantId === tenantId && item.id === candidateId);
    if (!candidate) throw new Error("Skill candidate not found in tenant.");
    const index = STAGE_ORDER.indexOf(candidate.stage);
    const next = index >= 0 && index + 1 < STAGE_ORDER.length ? STAGE_ORDER[index + 1] : undefined;
    return {
      stage: candidate.stage,
      ...(next ? { next } : {}),
      blockers: next ? this.stageGateViolations(candidate, next, undefined) : ["Skill is already at the final stage."],
      scores: candidate.scores,
    };
  }

  async retire(input: { tenantId: string; candidateId: string; reason: string }): Promise<SkillCandidate> {
    return await this.store.mutate((state) => {
      const candidate = this.mutableCandidate(state, input.tenantId, input.candidateId);
      const dependents = state.candidates.filter((item) => item.tenantId === input.tenantId && item.stage !== "archived" && item.compositeOfIds.includes(candidate.id));
      if (dependents.length) throw new Error(`Skill is a member of ${dependents.length} active composite skill(s) and cannot be retired.`);
      const nowIso = new Date(this.now()).toISOString();
      candidate.stageHistory.push({ from: candidate.stage, to: "archived", reason: auroraText(input.reason, 2000, "Retirement reason"), actor: "system", at: nowIso });
      candidate.stage = "archived";
      candidate.retiredReason = auroraText(input.reason, 2000, "Retirement reason");
      candidate.updatedAt = nowIso;
      this.journal(state, input.tenantId, "retirement", candidate.id, `${candidate.name} retired`, input.reason);
      return structuredClone(candidate);
    });
  }

  /** Retirement policy sweep: unused, low-utility or chronically failing skills are archived. */
  async sweepRetirement(tenantId: string, options?: { maxIdleDays?: number; minComposite?: number }): Promise<Array<{ candidateId: string; reason: string }>> {
    const maxIdleDays = auroraInteger(options?.maxIdleDays ?? 90, 1, 3650, "Retirement idle window");
    const minComposite = options?.minComposite === undefined ? 0.35 : auroraUnit(options.minComposite, "Retirement minimum composite");
    return await this.store.mutate((state) => {
      const timestamp = this.now();
      const nowIso = new Date(timestamp).toISOString();
      const retired: Array<{ candidateId: string; reason: string }> = [];
      for (const candidate of state.candidates.filter((item) => item.tenantId === tenantId && ["beta", "production"].includes(item.stage))) {
        if (state.candidates.some((item) => item.tenantId === tenantId && item.stage !== "archived" && item.compositeOfIds.includes(candidate.id))) continue;
        const idleMs = timestamp - Date.parse(candidate.usage.lastUsedAt ?? candidate.updatedAt);
        const reason = idleMs > maxIdleDays * 86_400_000
          ? `Unused for more than ${maxIdleDays} days.`
          : candidate.usage.invocations >= 10 && candidate.scores.composite < minComposite
            ? `Composite score ${candidate.scores.composite} is below the retirement floor ${minComposite}.`
            : undefined;
        if (!reason) continue;
        candidate.stageHistory.push({ from: candidate.stage, to: "archived", reason, actor: "retirement-policy", at: nowIso });
        candidate.stage = "archived";
        candidate.retiredReason = reason;
        candidate.updatedAt = nowIso;
        retired.push({ candidateId: candidate.id, reason });
        this.journal(state, tenantId, "retirement", candidate.id, `${candidate.name} auto-retired`, reason);
      }
      return retired;
    });
  }

  /** Composition graph: which skills build on which, and which are safe to change. */
  async compositionGraph(tenantId: string): Promise<Array<{ id: string; name: string; stage: SkillStage; members: string[]; dependents: string[] }>> {
    const state = await this.store.read();
    const candidates = state.candidates.filter((item) => item.tenantId === tenantId);
    return candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      stage: candidate.stage,
      members: [...candidate.compositeOfIds],
      dependents: candidates.filter((item) => item.compositeOfIds.includes(candidate.id)).map((item) => item.id),
    }));
  }

  async candidates(tenantId: string, stage?: SkillStage): Promise<SkillCandidate[]> {
    const state = await this.store.read();
    return state.candidates
      .filter((item) => item.tenantId === tenantId && (!stage || item.stage === stage))
      .sort((a, b) => b.scores.composite - a.scores.composite || a.name.localeCompare(b.name))
      .map((item) => structuredClone(item));
  }

  async linkRegisteredSkill(tenantId: string, candidateId: string, skillRegistryId: string): Promise<SkillCandidate> {
    return await this.store.mutate((state) => {
      const candidate = this.mutableCandidate(state, tenantId, candidateId);
      candidate.skillRegistryId = auroraText(skillRegistryId, 300, "Skill registry ID");
      candidate.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(candidate);
    });
  }

  /** Workflow evolution: a new version must justify itself against the previous one. */
  async recordWorkflowVersion(input: { tenantId: string; name: string; steps: string[]; averageDurationMs: number; successRate: number; rationale: string; bottleneckStep?: string }): Promise<WorkflowVersion> {
    return await this.store.mutate((state) => {
      if (state.workflows.length >= MAX_WORKFLOWS) throw new Error("Workflow version limit reached.");
      const name = auroraText(input.name, 200, "Workflow name");
      const previous = state.workflows.filter((item) => item.tenantId === input.tenantId && item.name === name).sort((a, b) => b.version - a.version)[0];
      const steps = boundedList(input.steps, "Workflow steps", 100);
      if (!steps.length) throw new Error("A workflow needs at least one step.");
      const version: WorkflowVersion = {
        id: `wf-${randomUUID()}`,
        tenantId: input.tenantId,
        name,
        version: (previous?.version ?? 0) + 1,
        steps,
        ...(input.bottleneckStep ? { bottleneckStep: auroraText(input.bottleneckStep, 300, "Workflow bottleneck") } : {}),
        averageDurationMs: auroraInteger(input.averageDurationMs, 0, 30 * 86_400_000, "Workflow duration"),
        successRate: auroraUnit(input.successRate, "Workflow success rate"),
        ...(previous ? { supersedesVersionId: previous.id } : {}),
        rationale: auroraText(input.rationale, 5000, "Workflow rationale"),
        createdAt: new Date(this.now()).toISOString(),
      };
      state.workflows.push(version);
      this.journal(state, input.tenantId, "workflow", version.id, `${name} v${version.version} recorded`, input.rationale);
      return structuredClone(version);
    });
  }

  /** Cognitive bottleneck detector across workflow versions. */
  async workflowBottlenecks(tenantId: string): Promise<Array<{ name: string; latestVersion: number; bottleneckStep?: string; durationTrendMs: number; successTrend: number; recommendation: string }>> {
    const state = await this.store.read();
    const names = [...new Set(state.workflows.filter((item) => item.tenantId === tenantId).map((item) => item.name))];
    return names.map((name) => {
      const versions = state.workflows.filter((item) => item.tenantId === tenantId && item.name === name).sort((a, b) => a.version - b.version);
      const latest = versions[versions.length - 1]!;
      const previous = versions.length > 1 ? versions[versions.length - 2]! : undefined;
      const durationTrend = previous ? latest.averageDurationMs - previous.averageDurationMs : 0;
      const successTrend = previous ? auroraRound(latest.successRate - previous.successRate) : 0;
      const recommendation = latest.bottleneckStep
        ? `Target "${latest.bottleneckStep}": consider a dedicated skill or parallel execution.`
        : durationTrend > 0 && successTrend <= 0 ? "Workflow got slower without quality gains; revert or redesign." : "No bottleneck detected.";
      return {
        name,
        latestVersion: latest.version,
        ...(latest.bottleneckStep ? { bottleneckStep: latest.bottleneckStep } : {}),
        durationTrendMs: durationTrend,
        successTrend,
        recommendation,
      };
    });
  }

  async journalEntries(tenantId: string, limit = 200): Promise<EvolutionJournalEntry[]> {
    const state = await this.store.read();
    return state.journal
      .filter((item) => item.tenantId === tenantId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, auroraInteger(limit, 1, 2000, "Journal limit"))
      .map((item) => structuredClone(item));
  }

  /** Cognitive Evolution Index: capability growth, quality, efficiency and gap closure in one score. */
  async evolutionIndex(tenantId: string): Promise<EvolutionIndex> {
    return await this.store.mutate((state) => {
      const candidates = state.candidates.filter((item) => item.tenantId === tenantId);
      const production = candidates.filter((item) => item.stage === "production");
      const beta = candidates.filter((item) => item.stage === "beta");
      const scored = candidates.filter((item) => item.stage !== "archived" && item.scores.composite > 0);
      const invocations = candidates.reduce((sum, item) => sum + item.usage.invocations, 0);
      const successes = candidates.reduce((sum, item) => sum + item.usage.successes, 0);
      const gaps = state.gaps.filter((item) => item.tenantId === tenantId);
      const resolved = gaps.filter((item) => item.status === "resolved").length;
      const workflows = state.workflows.filter((item) => item.tenantId === tenantId);
      const workflowNames = [...new Set(workflows.map((item) => item.name))];
      let improvement = 0;
      for (const name of workflowNames) {
        const versions = workflows.filter((item) => item.name === name).sort((a, b) => a.version - b.version);
        const first = versions[0]!;
        const last = versions[versions.length - 1]!;
        improvement += (last.successRate - first.successRate) + (first.averageDurationMs > 0 ? Math.max(-1, Math.min(1, (first.averageDurationMs - last.averageDurationMs) / first.averageDurationMs)) : 0);
      }
      const averageComposite = scored.length ? auroraRound(scored.reduce((sum, item) => sum + item.scores.composite, 0) / scored.length) : 0;
      const successRate = invocations ? auroraRound(successes / invocations) : 0;
      const gapClosureRate = gaps.length ? auroraRound(resolved / gaps.length) : 0;
      const workflowImprovement = workflowNames.length ? auroraRound(improvement / (workflowNames.length * 2)) : 0;
      const capability = Math.min(1, (production.length + beta.length * 0.5) / 10);
      const index = auroraRound(Math.max(0, Math.min(1,
        capability * 0.3 + averageComposite * 0.25 + successRate * 0.2 + gapClosureRate * 0.15 + Math.max(0, workflowImprovement) * 0.1)));
      const previous = state.indexHistory.filter((item) => item.tenantId === tenantId).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
      const nowIso = new Date(this.now()).toISOString();
      state.indexHistory.push({ tenantId, index, at: nowIso });
      if (state.indexHistory.length > 10_000) state.indexHistory.splice(0, state.indexHistory.length - 10_000);
      return {
        tenantId,
        productionSkills: production.length,
        betaSkills: beta.length,
        averageComposite,
        successRate,
        gapClosureRate,
        workflowImprovement,
        index,
        delta: previous ? auroraRound(index - previous.index) : 0,
        generatedAt: nowIso,
      } satisfies EvolutionIndex;
    });
  }

  private stageGateViolations(candidate: SkillCandidate, to: SkillStage, approval: { actor: string; reason: string } | undefined): string[] {
    const violations: string[] = [];
    const sandboxEvaluations = candidate.evaluations.length;
    if (to === "sandbox") {
      if (!candidate.tests.length) violations.push("A sandbox promotion requires at least one declared test.");
      if (!candidate.risks.length) violations.push("A sandbox promotion requires a declared risk list.");
    }
    if (to === "test" && sandboxEvaluations < 1) violations.push("A test promotion requires at least one recorded sandbox evaluation.");
    if (to === "beta") {
      if (sandboxEvaluations < 2) violations.push("A beta promotion requires at least two recorded evaluations.");
      if (candidate.scores.accuracy < 0.7) violations.push(`Accuracy ${candidate.scores.accuracy} is below the 0.7 beta floor.`);
      if (candidate.scores.safety < 0.8) violations.push(`Safety ${candidate.scores.safety} is below the 0.8 beta floor.`);
    }
    if (to === "production") {
      if (!approval) violations.push("A production promotion requires an explicit approval actor and reason.");
      if (!candidate.regressionBaseline.length) violations.push("A production promotion requires a recorded regression baseline.");
      if (candidate.scores.composite < 0.7) violations.push(`Composite score ${candidate.scores.composite} is below the 0.7 production floor.`);
      if (candidate.scores.safety < 0.9) violations.push(`Safety ${candidate.scores.safety} is below the 0.9 production floor.`);
      if (candidate.usage.invocations < 1) violations.push("A production promotion requires at least one recorded beta invocation.");
    }
    return violations;
  }

  private journal(state: EvolutionStateShape, tenantId: string, kind: EvolutionJournalEntry["kind"], subjectId: string, summary: string, detail: unknown): void {
    state.journal.push({
      id: `journal-${randomUUID()}`,
      tenantId,
      at: new Date(this.now()).toISOString(),
      kind,
      subjectId,
      summary: summary.slice(0, 500),
      detailDigest: auroraDigest(detail),
    });
    if (state.journal.length > MAX_JOURNAL) state.journal.splice(0, state.journal.length - MAX_JOURNAL);
  }

  private mutableGap(state: EvolutionStateShape, tenantId: string, id: string): EvolutionGap {
    const gap = state.gaps.find((item) => item.tenantId === tenantId && item.id === id);
    if (!gap) throw new Error("Evolution gap not found in tenant.");
    return gap;
  }

  private mutableCandidate(state: EvolutionStateShape, tenantId: string, id: string): SkillCandidate {
    const candidate = state.candidates.find((item) => item.tenantId === tenantId && item.id === id);
    if (!candidate) throw new Error("Skill candidate not found in tenant.");
    return candidate;
  }
}

function boundedList(values: string[] | undefined, label: string, max = 50): string[] {
  const list = (values ?? []).map((item) => auroraText(item, 1000, label));
  if (list.length > max) throw new Error(`${label} exceed the allowed count.`);
  return list;
}

function bumpVersion(version: string, stage: SkillStage): string {
  const [major = "0", minor = "1", patch = "0"] = version.split(".");
  if (stage === "production") return `${Number(major) + 1}.0.0`;
  if (stage === "beta") return `${major}.${Number(minor) + 1}.0`;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

export function skillEvolutionTags(candidate: SkillCandidate): string[] {
  return auroraTags([candidate.stage, ...candidate.tools.slice(0, 5).map((tool) => tool.toLowerCase().replace(/[^a-z0-9._-]/g, "-"))]);
}
