import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  auroraIds, auroraInteger, auroraRound, auroraText, auroraTimestamp, auroraUnit, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_CLAIMS = 50_000;
const MAX_GOALS = 5_000;
const MAX_SIGNALS = 20_000;
const MAX_MILESTONES = 5_000;
const MAX_ADVICE = 50_000;
const MAX_PROJECTS = 2_000;
const MAX_NEXT_ACTIONS = 50;
const MAX_PROJECT_FAILURES = 50;
const MAX_RETENTION_DAYS = 3_650;

/**
 * Behavioural categories only. The PDF is explicit that this is a behaviour/goal/habit twin,
 * not an identity, personality or belief profile — the forbidden-topic guard below enforces that.
 */
export type UserClaimCategory =
  | "identity-context" | "goal" | "motivation" | "decision-style" | "learning-style" | "strength"
  | "weakness" | "habit" | "productivity" | "energy" | "attention" | "frustration"
  | "communication" | "trust" | "interest" | "project" | "tooling";

export type UserClaimStatus = "proposed" | "active" | "corrected" | "retracted" | "expired";
export type UserClaimSource = "user-stated" | "inferred" | "system";

export interface UserClaim {
  id: string;
  tenantId: string;
  userId: string;
  category: UserClaimCategory;
  key: string;
  value: string;
  confidence: number;
  source: UserClaimSource;
  status: UserClaimStatus;
  consent: "granted" | "pending" | "denied";
  evidenceRefs: string[];
  observations: number;
  correctionHistory: Array<{ previousValue: string; correctedValue: string; correctedBy: "user" | "system"; reason: string; at: string }>;
  validFrom: string;
  expiresAt?: string;
  lastConfirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserGoalModel {
  id: string;
  tenantId: string;
  userId: string;
  horizon: "long" | "medium" | "short";
  title: string;
  description: string;
  parentGoalId?: string;
  /** Other goals that must be achieved before this one can progress (P1.45 dependencies). */
  dependsOnGoalIds?: string[];
  /** Goals this one is explicitly known to conflict with (P1.45 conflicts). */
  conflictsWithGoalIds?: string[];
  progress: number;
  importance: number;
  status: "active" | "paused" | "achieved" | "abandoned";
  lastProgressAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserGoalConflict {
  kind: "declared" | "dependency-cycle" | "overcommit";
  goalIds: string[];
  detail: string;
}

export interface UserProjectNextAction {
  id: string;
  title: string;
  done: boolean;
  createdAt: string;
}

export interface UserProjectFailure {
  id: string;
  summary: string;
  at: string;
}

/** P1.46 project model: what Aurora knows about a user's project. */
export interface UserProject {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  repoUrl?: string;
  workspacePath?: string;
  status: "active" | "paused" | "archived";
  activeTasks: number;
  deadline?: string;
  /** Architecture understanding — bounded notes with their own provenance. */
  architectureNotes: string;
  nextActions: UserProjectNextAction[];
  recentFailures: UserProjectFailure[];
  expertise: string[];
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserSignal {
  id: string;
  tenantId: string;
  userId: string;
  kind: "activity" | "idle" | "message" | "commit" | "research" | "error" | "break";
  intensity: number;
  at: string;
  note?: string;
}

export interface UserMilestone {
  id: string;
  tenantId: string;
  userId: string;
  kind: "decision" | "success" | "failure" | "turning-point" | "start";
  title: string;
  summary: string;
  importance: number;
  occurredAt: string;
  createdAt: string;
}

export interface AdviceRecord {
  id: string;
  tenantId: string;
  userId: string;
  summary: string;
  initiativeId?: string;
  /** Task the advice was given in the context of, so completion can be auto-observed (J1). */
  taskRef?: string;
  claimRefs: string[];
  outcome?: {
    followed: boolean;
    /** Undefined while only the follow behaviour was auto-observed and the user has not rated helpfulness yet. */
    helpful?: boolean;
    note?: string;
    ratedAt: string;
    autoObserved?: boolean;
  };
  createdAt: string;
}

export interface AdvicePolicy {
  mode: "advise-less" | "normal" | "advise-more" | "insufficient-evidence";
  effectivenessScore: number;
  suggestedMinIntervalHours: number;
  ratedOutcomes: number;
  basis: string;
}

/** Per-feature privacy switches (P1.48). Defaults favour the user, not inference. */
export type UserFeatureId = "inference" | "signals" | "advice-tracking" | "research-memory" | "state-estimation";

export interface UserFeatureConsents {
  features: Record<UserFeatureId, boolean>;
  retentionDays?: number;
  updatedAt: string;
}

export interface UserStateEstimate {
  userId: string;
  state: "working" | "researching" | "resting" | "busy" | "idle" | "unknown";
  confidence: number;
  uncertainty: number;
  basis: string[];
  isEstimate: true;
  generatedAt: string;
}

export interface UserModelSummary {
  userId: string;
  tenantId: string;
  claims: Record<string, Array<{ key: string; value: string; confidence: number; source: UserClaimSource; status: UserClaimStatus }>>;
  goals: UserGoalModel[];
  projects: Array<Pick<UserProject, "id" | "name" | "status" | "deadline" | "activeTasks">>;
  trustScore: number;
  adviceEffectiveness: { total: number; followed: number; helpful: number; score: number };
  frustrationRisk: number;
  attentionLoad: number;
  generatedAt: string;
}

interface UserModelStateShape {
  schemaVersion: 1;
  claims: UserClaim[];
  goals: UserGoalModel[];
  signals: UserSignal[];
  milestones: UserMilestone[];
  advice: AdviceRecord[];
  projects?: UserProject[];
  privacy?: Array<{ tenantId: string; userId: string; features: Partial<Record<UserFeatureId, boolean>>; retentionDays?: number; updatedAt: string }>;
}

/** Constitutional privacy guard: Aurora may model behaviour, never these protected topics. */
const FORBIDDEN_TOPIC_PATTERNS = [
  /\b(health|illness|disease|diagnosis|medication|mental[- ]?health|depress\w*|hastalık|ilaç|teşhis)\b/i,
  /\b(religion|religious|faith|belief system|din|dini|inanç|ibadet)\b/i,
  /\b(politic\w*|party|vote[sd]?|ideolog\w*|siyas\w*|parti|oy verme)\b/i,
  /\b(ethnic\w*|race|racial|nationalit\w*|etnik|ırk)\b/i,
  /\b(sexual\w*|orientation|gender identity|cinsel)\b/i,
  /\b(salary|income|bank account|credit card|password|maaş|gelir|şifre|kredi kartı)\b/i,
];

/**
 * Aurora Phase E — governed user cognitive model.
 *
 * Every inference about the user is a typed, confidence-scored, evidence-backed, inspectable claim
 * that the user can correct, retract or delete. Inferred claims start as `proposed` and never
 * silently become facts. Protected topics are rejected at write time.
 */
export class UserModelService {
  private readonly store: DurableJsonState<UserModelStateShape>;

  constructor(rootPath: string, private readonly now: () => number = Date.now) {
    this.store = new DurableJsonState<UserModelStateShape>(
      join(rootPath, "user-model", "state.json"),
      () => ({ schemaVersion: 1, claims: [], goals: [], signals: [], milestones: [], advice: [] }),
      (value) => {
        const state = value as UserModelStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.claims) && Array.isArray(state.goals)
          && Array.isArray(state.signals) && Array.isArray(state.milestones) && Array.isArray(state.advice);
      },
      "Aurora user model",
    );
  }

  /**
   * Record or reinforce a behavioural claim. User-stated claims are active immediately;
   * inferred claims stay `proposed` until they are confirmed or explicitly promoted.
   */
  async observeClaim(input: {
    tenantId: string; userId: string; category: UserClaimCategory; key: string; value: string;
    confidence: number; source: UserClaimSource; evidenceRefs?: string[]; expiresAt?: string;
  }): Promise<UserClaim> {
    return await this.store.mutate((state) => {
      if (state.claims.length >= MAX_CLAIMS) throw new Error("User claim limit reached.");
      const key = auroraText(input.key, 200, "User claim key").toLowerCase();
      const value = auroraText(input.value, 5000, "User claim value");
      assertPermittedTopic(`${input.category} ${key} ${value}`);
      const timestamp = this.now();
      const nowIso = new Date(timestamp).toISOString();
      const existing = state.claims.find((item) => item.tenantId === input.tenantId && item.userId === input.userId
        && item.category === input.category && item.key === key && ["proposed", "active"].includes(item.status));
      if (existing) {
        if (existing.value === value) {
          existing.observations++;
          existing.confidence = auroraRound(Math.min(1, (existing.confidence * (existing.observations - 1) + auroraUnit(input.confidence, "Claim confidence")) / existing.observations + 0.02));
          existing.lastConfirmedAt = nowIso;
          if (existing.status === "proposed" && (input.source === "user-stated" || existing.observations >= 3)) existing.status = "active";
        } else {
          existing.correctionHistory.push({ previousValue: existing.value, correctedValue: value, correctedBy: "system", reason: "New observation replaced the previous value.", at: nowIso });
          existing.value = value;
          existing.confidence = auroraUnit(input.confidence, "Claim confidence");
          existing.observations = 1;
          existing.status = input.source === "user-stated" ? "active" : "proposed";
        }
        existing.evidenceRefs = [...new Set([...existing.evidenceRefs, ...auroraIds(input.evidenceRefs, 200, "Claim evidence refs")])].slice(0, 200);
        existing.source = input.source;
        existing.updatedAt = nowIso;
        return structuredClone(existing);
      }
      const claim: UserClaim = {
        id: `claim-${randomUUID()}`,
        tenantId: input.tenantId,
        userId: auroraText(input.userId, 200, "User ID"),
        category: input.category,
        key,
        value,
        confidence: auroraUnit(input.confidence, "Claim confidence"),
        source: input.source,
        status: input.source === "user-stated" ? "active" : "proposed",
        consent: input.source === "user-stated" ? "granted" : "pending",
        evidenceRefs: auroraIds(input.evidenceRefs, 200, "Claim evidence refs"),
        observations: 1,
        correctionHistory: [],
        validFrom: nowIso,
        ...(input.expiresAt ? { expiresAt: auroraTimestamp(input.expiresAt, timestamp, "Claim expiry") } : {}),
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.claims.push(claim);
      return structuredClone(claim);
    });
  }

  /** The user grants or denies consent for an inferred claim; denial retracts it immediately. */
  async setConsent(tenantId: string, claimId: string, consent: UserClaim["consent"]): Promise<UserClaim> {
    return await this.store.mutate((state) => {
      const claim = this.mutableClaim(state, tenantId, claimId);
      claim.consent = consent;
      if (consent === "granted" && claim.status === "proposed") claim.status = "active";
      if (consent === "denied") claim.status = "retracted";
      claim.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(claim);
    });
  }

  /** The user corrects Aurora. The previous value is kept in history so the mistake is auditable. */
  async correctClaim(input: { tenantId: string; claimId: string; correctedValue: string; reason: string; confidence?: number }): Promise<UserClaim> {
    return await this.store.mutate((state) => {
      const claim = this.mutableClaim(state, input.tenantId, input.claimId);
      const corrected = auroraText(input.correctedValue, 5000, "Corrected value");
      assertPermittedTopic(corrected);
      const nowIso = new Date(this.now()).toISOString();
      claim.correctionHistory.push({
        previousValue: claim.value,
        correctedValue: corrected,
        correctedBy: "user",
        reason: auroraText(input.reason, 2000, "Correction reason"),
        at: nowIso,
      });
      claim.value = corrected;
      claim.confidence = input.confidence === undefined ? 0.95 : auroraUnit(input.confidence, "Corrected confidence");
      claim.source = "user-stated";
      claim.status = "active";
      claim.consent = "granted";
      claim.observations = 1;
      claim.updatedAt = nowIso;
      return structuredClone(claim);
    });
  }

  async retractClaim(tenantId: string, claimId: string, reason: string): Promise<UserClaim> {
    return await this.store.mutate((state) => {
      const claim = this.mutableClaim(state, tenantId, claimId);
      claim.status = "retracted";
      claim.correctionHistory.push({ previousValue: claim.value, correctedValue: "", correctedBy: "user", reason: auroraText(reason, 2000, "Retraction reason"), at: new Date(this.now()).toISOString() });
      claim.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(claim);
    });
  }

  /** Right to be forgotten: delete every stored inference about a user (optionally one category). */
  async forgetUser(tenantId: string, userId: string, category?: UserClaimCategory): Promise<{ removedClaims: number; removedGoals: number; removedSignals: number; removedMilestones: number; removedAdvice: number; removedProjects: number }> {
    return await this.store.mutate((state) => {
      const before = {
        claims: state.claims.length,
        goals: state.goals.length,
        signals: state.signals.length,
        milestones: state.milestones.length,
        advice: state.advice.length,
        projects: (state.projects ?? []).length,
      };
      const matchesUser = (item: { tenantId: string; userId: string }) => item.tenantId === tenantId && item.userId === userId;
      state.claims = state.claims.filter((item) => !(matchesUser(item) && (!category || item.category === category)));
      if (!category) {
        state.goals = state.goals.filter((item) => !matchesUser(item));
        state.signals = state.signals.filter((item) => !matchesUser(item));
        state.milestones = state.milestones.filter((item) => !matchesUser(item));
        state.advice = state.advice.filter((item) => !matchesUser(item));
        state.projects = (state.projects ?? []).filter((item) => !matchesUser(item));
        state.privacy = (state.privacy ?? []).filter((item) => !matchesUser(item));
      }
      return {
        removedClaims: before.claims - state.claims.length,
        removedGoals: before.goals - state.goals.length,
        removedSignals: before.signals - state.signals.length,
        removedMilestones: before.milestones - state.milestones.length,
        removedAdvice: before.advice - state.advice.length,
        removedProjects: before.projects - (state.projects ?? []).length,
      };
    });
  }

  async claims(tenantId: string, userId: string, filter?: { category?: UserClaimCategory; status?: UserClaimStatus }): Promise<UserClaim[]> {
    const state = await this.store.read();
    return state.claims
      .filter((item) => item.tenantId === tenantId && item.userId === userId
        && (!filter?.category || item.category === filter.category)
        && (!filter?.status || item.status === filter.status))
      .sort((a, b) => b.confidence - a.confidence)
      .map((item) => structuredClone(item));
  }

  async upsertGoal(input: {
    tenantId: string; userId: string; horizon: UserGoalModel["horizon"]; title: string; description?: string;
    parentGoalId?: string; importance?: number; goalId?: string; progress?: number; status?: UserGoalModel["status"];
    dependsOnGoalIds?: string[]; conflictsWithGoalIds?: string[];
  }): Promise<UserGoalModel> {
    return await this.store.mutate((state) => {
      const nowIso = new Date(this.now()).toISOString();
      if (input.goalId) {
        const goal = state.goals.find((item) => item.tenantId === input.tenantId && item.id === input.goalId);
        if (!goal) throw new Error("User goal not found in tenant.");
        if (input.progress !== undefined) {
          goal.progress = auroraUnit(input.progress, "Goal progress");
          goal.lastProgressAt = nowIso;
        }
        if (input.status) goal.status = input.status;
        if (input.importance !== undefined) goal.importance = auroraUnit(input.importance, "Goal importance");
        if (input.description) goal.description = auroraText(input.description, 10_000, "Goal description");
        if (input.dependsOnGoalIds) {
          assertGoalRefs(state, input.tenantId, goal.id, input.dependsOnGoalIds, "dependsOn");
          goal.dependsOnGoalIds = [...new Set(input.dependsOnGoalIds)].slice(0, 20);
        }
        if (input.conflictsWithGoalIds) {
          assertGoalRefs(state, input.tenantId, goal.id, input.conflictsWithGoalIds, "conflictsWith");
          goal.conflictsWithGoalIds = [...new Set(input.conflictsWithGoalIds)].slice(0, 20);
        }
        goal.updatedAt = nowIso;
        return structuredClone(goal);
      }
      if (state.goals.length >= MAX_GOALS) throw new Error("User goal limit reached.");
      if (input.parentGoalId && !state.goals.some((item) => item.tenantId === input.tenantId && item.id === input.parentGoalId)) throw new Error("Parent user goal not found.");
      if (input.dependsOnGoalIds) assertGoalRefs(state, input.tenantId, undefined, input.dependsOnGoalIds, "dependsOn");
      if (input.conflictsWithGoalIds) assertGoalRefs(state, input.tenantId, undefined, input.conflictsWithGoalIds, "conflictsWith");
      const goal: UserGoalModel = {
        id: `ugoal-${randomUUID()}`,
        tenantId: input.tenantId,
        userId: auroraText(input.userId, 200, "User ID"),
        horizon: input.horizon,
        title: auroraText(input.title, 300, "Goal title"),
        description: input.description ? auroraText(input.description, 10_000, "Goal description") : "",
        ...(input.parentGoalId ? { parentGoalId: input.parentGoalId } : {}),
        ...(input.dependsOnGoalIds?.length ? { dependsOnGoalIds: [...new Set(input.dependsOnGoalIds)].slice(0, 20) } : {}),
        ...(input.conflictsWithGoalIds?.length ? { conflictsWithGoalIds: [...new Set(input.conflictsWithGoalIds)].slice(0, 20) } : {}),
        progress: auroraUnit(input.progress ?? 0, "Goal progress"),
        importance: auroraUnit(input.importance ?? 0.6, "Goal importance"),
        status: "active",
        lastProgressAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.goals.push(goal);
      return structuredClone(goal);
    });
  }

  async goals(tenantId: string, userId: string, status?: UserGoalModel["status"]): Promise<UserGoalModel[]> {
    const state = await this.store.read();
    const order = { long: 0, medium: 1, short: 2 } as const;
    return state.goals
      .filter((item) => item.tenantId === tenantId && item.userId === userId && (!status || item.status === status))
      .sort((a, b) => order[a.horizon] - order[b.horizon] || b.importance - a.importance)
      .map((item) => structuredClone(item));
  }

  /** Goals with no progress for a while — the input for stalled-progress interventions. */
  async stalledGoals(tenantId: string, userId: string, days = 14): Promise<UserGoalModel[]> {
    const state = await this.store.read();
    const threshold = this.now() - auroraInteger(days, 1, 365, "Stall window") * 86_400_000;
    return state.goals
      .filter((item) => item.tenantId === tenantId && item.userId === userId && item.status === "active" && Date.parse(item.lastProgressAt) < threshold)
      .map((item) => structuredClone(item));
  }

  /** P1.45 conflicts: declared pairs, dependency cycles and short-horizon overcommit. */
  async goalConflicts(tenantId: string, userId: string, overcommitThreshold = 8): Promise<UserGoalConflict[]> {
    const state = await this.store.read();
    const goals = state.goals.filter((item) => item.tenantId === tenantId && item.userId === userId);
    const conflicts: UserGoalConflict[] = [];
    const seen = new Set<string>();
    for (const goal of goals) {
      for (const otherId of goal.conflictsWithGoalIds ?? []) {
        const key = [goal.id, otherId].sort().join("|");
        if (seen.has(key)) continue;
        const other = goals.find((item) => item.id === otherId);
        if (!other) continue;
        seen.add(key);
        conflicts.push({
          kind: "declared",
          goalIds: [goal.id, otherId],
          detail: `"${goal.title}" and "${other.title}" are recorded as conflicting.`,
        });
      }
    }
    // Dependency cycles: follow dependsOn edges with a DFS from every goal.
    const depends = new Map(goals.map((goal) => [goal.id, goal.dependsOnGoalIds ?? []]));
    const reported = new Set<string>();
    for (const goal of goals) {
      const stack: Array<{ id: string; path: string[] }> = [{ id: goal.id, path: [goal.id] }];
      const visited = new Set<string>();
      while (stack.length) {
        const node = stack.pop()!;
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        for (const next of depends.get(node.id) ?? []) {
          if (next === goal.id) {
            const cycle = [...node.path, goal.id];
            const key = [...cycle].sort().join("|");
            if (!reported.has(key)) {
              reported.add(key);
              conflicts.push({
                kind: "dependency-cycle",
                goalIds: [...new Set(cycle)],
                detail: `Dependency cycle: ${cycle.map((id) => goals.find((g) => g.id === id)?.title ?? id).join(" → ")}.`,
              });
            }
            break;
          }
          stack.push({ id: next, path: [...node.path, next] });
        }
      }
    }
    const activeShort = goals.filter((item) => item.status === "active" && item.horizon === "short");
    if (activeShort.length > overcommitThreshold) {
      conflicts.push({
        kind: "overcommit",
        goalIds: activeShort.map((item) => item.id),
        detail: `${activeShort.length} active short-horizon goals exceed the attention threshold of ${overcommitThreshold}; progress on all of them at once is unlikely.`,
      });
    }
    return conflicts;
  }

  /** P1.45 dependencies: active goals waiting on goals that are not achieved yet. */
  async blockedGoals(tenantId: string, userId: string): Promise<Array<{ goalId: string; title: string; blockedByGoalIds: string[] }>> {
    const state = await this.store.read();
    const goals = state.goals.filter((item) => item.tenantId === tenantId && item.userId === userId);
    const byId = new Map(goals.map((goal) => [goal.id, goal]));
    const blocked: Array<{ goalId: string; title: string; blockedByGoalIds: string[] }> = [];
    for (const goal of goals) {
      if (goal.status !== "active" || !goal.dependsOnGoalIds?.length) continue;
      const blockers = goal.dependsOnGoalIds.filter((depId) => byId.get(depId)?.status !== "achieved");
      if (blockers.length) blocked.push({ goalId: goal.id, title: goal.title, blockedByGoalIds: blockers });
    }
    return blocked;
  }

  // ─── Project model (P1.46) ───

  async upsertProject(input: {
    tenantId: string; userId: string; projectId?: string; name: string;
    repoUrl?: string; workspacePath?: string; status?: UserProject["status"];
    activeTasks?: number; deadline?: string; architectureNotes?: string;
    expertise?: string[]; addNextAction?: string; completeNextActionId?: string; recordFailure?: string;
  }): Promise<UserProject> {
    return await this.store.mutate((state) => {
      state.projects = state.projects ?? [];
      const nowIso = new Date(this.now()).toISOString();
      const existing = input.projectId
        ? state.projects.find((item) => item.tenantId === input.tenantId && item.userId === input.userId && item.id === input.projectId)
        : state.projects.find((item) => item.tenantId === input.tenantId && item.userId === input.userId && item.name === input.name);
      let project = existing;
      if (!project) {
        if (state.projects.length >= MAX_PROJECTS) throw new Error("User project limit reached.");
        project = {
          id: `uproject-${randomUUID()}`,
          tenantId: input.tenantId,
          userId: auroraText(input.userId, 200, "User ID"),
          name: auroraText(input.name, 200, "Project name"),
          status: "active",
          activeTasks: 0,
          architectureNotes: "",
          nextActions: [],
          recentFailures: [],
          expertise: [],
          lastActivityAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        state.projects.push(project);
      }
      if (input.repoUrl !== undefined) {
        if (input.repoUrl === "") delete project.repoUrl;
        else {
          const repo = auroraText(input.repoUrl, 500, "Project repository URL");
          if (!/^https:\/\/|^git@/.test(repo)) throw new Error("Project repository must be an https:// URL or git@ SSH reference.");
          project.repoUrl = repo;
        }
      }
      if (input.workspacePath !== undefined) {
        if (input.workspacePath === "") delete project.workspacePath;
        else project.workspacePath = auroraText(input.workspacePath, 2000, "Project workspace path");
      }
      if (input.status) project.status = input.status;
      if (input.activeTasks !== undefined) project.activeTasks = auroraInteger(input.activeTasks, 0, 100_000, "Project active tasks");
      if (input.deadline !== undefined) {
        if (input.deadline === "") delete project.deadline;
        else project.deadline = auroraTimestamp(input.deadline, this.now(), "Project deadline");
      }
      if (input.architectureNotes !== undefined) project.architectureNotes = auroraText(input.architectureNotes, 50_000, "Project architecture notes");
      if (input.expertise) project.expertise = [...new Set(input.expertise.map((tag) => auroraText(tag, 100, "Project expertise tag")))].slice(0, 50);
      if (input.addNextAction) {
        if (project.nextActions.length >= MAX_NEXT_ACTIONS) throw new Error("Project next-action limit reached.");
        project.nextActions.push({ id: `action-${randomUUID()}`, title: auroraText(input.addNextAction, 500, "Next action title"), done: false, createdAt: nowIso });
      }
      if (input.completeNextActionId) {
        const action = project.nextActions.find((item) => item.id === input.completeNextActionId);
        if (!action) throw new Error("Project next action not found.");
        action.done = true;
      }
      if (input.recordFailure) {
        if (project.recentFailures.length >= MAX_PROJECT_FAILURES) project.recentFailures = project.recentFailures.slice(-Math.floor(MAX_PROJECT_FAILURES / 2));
        project.recentFailures.push({ id: `failure-${randomUUID()}`, summary: auroraText(input.recordFailure, 2000, "Project failure summary"), at: nowIso });
      }
      project.lastActivityAt = nowIso;
      project.updatedAt = nowIso;
      return structuredClone(project);
    });
  }

  async projects(tenantId: string, userId: string, status?: UserProject["status"]): Promise<UserProject[]> {
    const state = await this.store.read();
    return (state.projects ?? [])
      .filter((item) => item.tenantId === tenantId && item.userId === userId && (!status || item.status === status))
      .map((item) => structuredClone(item));
  }

  async projectOverview(tenantId: string, userId: string, projectId: string): Promise<{
    project: UserProject;
    overdue: boolean | null;
    pendingNextActions: Array<{ id: string; title: string }>;
    failuresLast7Days: number;
  }> {
    const state = await this.store.read();
    const project = (state.projects ?? []).find((item) => item.tenantId === tenantId && item.userId === userId && item.id === projectId);
    if (!project) throw new Error("User project not found in tenant.");
    const now = this.now();
    return {
      project: structuredClone(project),
      overdue: project.deadline ? Date.parse(project.deadline) < now : null,
      pendingNextActions: project.nextActions.filter((action) => !action.done).map((action) => ({ id: action.id, title: action.title })),
      failuresLast7Days: project.recentFailures.filter((failure) => now - Date.parse(failure.at) <= 7 * 86_400_000).length,
    };
  }

  async recordSignal(input: { tenantId: string; userId: string; kind: UserSignal["kind"]; intensity: number; at?: string; note?: string }): Promise<UserSignal> {
    return await this.store.mutate((state) => {
      const tenantSignals = state.signals.filter((item) => item.tenantId === input.tenantId);
      if (tenantSignals.length >= MAX_SIGNALS) {
        const oldest = tenantSignals.sort((a, b) => a.at.localeCompare(b.at)).slice(0, Math.ceil(MAX_SIGNALS * 0.1)).map((item) => item.id);
        state.signals = state.signals.filter((item) => !oldest.includes(item.id));
      }
      const signal: UserSignal = {
        id: `signal-${randomUUID()}`,
        tenantId: input.tenantId,
        userId: auroraText(input.userId, 200, "User ID"),
        kind: input.kind,
        intensity: auroraUnit(input.intensity, "Signal intensity"),
        at: auroraTimestamp(input.at, this.now(), "Signal timestamp"),
        ...(input.note ? { note: auroraText(input.note, 1000, "Signal note") } : {}),
      };
      state.signals.push(signal);
      return structuredClone(signal);
    });
  }

  /**
   * Current-state estimator. The result is explicitly labelled as an estimate with uncertainty,
   * because the PDF forbids treating this as ground truth.
   */
  async estimateState(tenantId: string, userId: string): Promise<UserStateEstimate> {
    const state = await this.store.read();
    const timestamp = this.now();
    const recent = state.signals
      .filter((item) => item.tenantId === tenantId && item.userId === userId && timestamp - Date.parse(item.at) <= 4 * 60 * 60_000)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 50);
    if (!recent.length) {
      return { userId, state: "unknown", confidence: 0.2, uncertainty: 0.8, basis: ["No recent behavioural signals."], isEstimate: true, generatedAt: new Date(timestamp).toISOString() };
    }
    const weights: Record<UserSignal["kind"], number> = { activity: 0, idle: 0, message: 0, commit: 0, research: 0, error: 0, break: 0 };
    for (const signal of recent) {
      const ageHours = (timestamp - Date.parse(signal.at)) / 3_600_000;
      weights[signal.kind] += signal.intensity * (1 / (1 + ageHours));
    }
    const mapping: Array<{ state: UserStateEstimate["state"]; score: number; because: string }> = ([
      { state: "working", score: weights.commit * 1.2 + weights.activity, because: "commit/activity signals" },
      { state: "researching", score: weights.research * 1.3, because: "research signals" },
      { state: "busy", score: weights.message + weights.error * 1.1, because: "message/error signals" },
      { state: "resting", score: weights.break * 1.4, because: "break signals" },
      { state: "idle", score: weights.idle * 1.2, because: "idle signals" },
    ] satisfies Array<{ state: UserStateEstimate["state"]; score: number; because: string }>).sort((a, b) => b.score - a.score);
    const best = mapping[0]!;
    const total = mapping.reduce((sum, item) => sum + item.score, 0);
    const confidence = total ? auroraRound(Math.min(0.9, best.score / total)) : 0.2;
    return {
      userId,
      state: best.score <= 0 ? "unknown" : best.state,
      confidence,
      uncertainty: auroraRound(1 - confidence),
      basis: [`${recent.length} signals in the last 4h`, `dominant evidence: ${best.because}`],
      isEstimate: true,
      generatedAt: new Date(timestamp).toISOString(),
    };
  }

  /** Frustration detector: repeated errors plus stalled goals in the recent window. */
  async frustrationRisk(tenantId: string, userId: string): Promise<{ risk: number; signals: number; stalledGoals: number; recommendation: string }> {
    const state = await this.store.read();
    const timestamp = this.now();
    const errors = state.signals.filter((item) => item.tenantId === tenantId && item.userId === userId && item.kind === "error" && timestamp - Date.parse(item.at) <= 7 * 86_400_000);
    const stalled = (await this.stalledGoals(tenantId, userId)).length;
    const risk = auroraRound(Math.min(1, errors.length * 0.08 + stalled * 0.15));
    return {
      risk,
      signals: errors.length,
      stalledGoals: stalled,
      recommendation: risk >= 0.6
        ? "Change the approach: decompose the blocked work and reduce proactive noise."
        : risk >= 0.3 ? "Offer one concrete unblocking suggestion, not a list." : "No intervention needed.",
    };
  }

  async addMilestone(input: { tenantId: string; userId: string; kind: UserMilestone["kind"]; title: string; summary: string; importance?: number; occurredAt?: string }): Promise<UserMilestone> {
    return await this.store.mutate((state) => {
      if (state.milestones.length >= MAX_MILESTONES) throw new Error("User milestone limit reached.");
      const milestone: UserMilestone = {
        id: `mile-${randomUUID()}`,
        tenantId: input.tenantId,
        userId: auroraText(input.userId, 200, "User ID"),
        kind: input.kind,
        title: auroraText(input.title, 300, "Milestone title"),
        summary: auroraText(input.summary, 10_000, "Milestone summary"),
        importance: auroraUnit(input.importance ?? 0.6, "Milestone importance"),
        occurredAt: auroraTimestamp(input.occurredAt, this.now(), "Milestone timestamp"),
        createdAt: new Date(this.now()).toISOString(),
      };
      state.milestones.push(milestone);
      return structuredClone(milestone);
    });
  }

  /** Personal growth timeline plus relationship memory. */
  async timeline(tenantId: string, userId: string): Promise<UserMilestone[]> {
    const state = await this.store.read();
    return state.milestones
      .filter((item) => item.tenantId === tenantId && item.userId === userId)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
      .map((item) => structuredClone(item));
  }

  async recordAdvice(input: { tenantId: string; userId: string; summary: string; initiativeId?: string; taskRef?: string; claimRefs?: string[] }): Promise<AdviceRecord> {
    return await this.store.mutate((state) => {
      if (state.advice.length >= MAX_ADVICE) throw new Error("Advice record limit reached.");
      const record: AdviceRecord = {
        id: `advice-${randomUUID()}`,
        tenantId: input.tenantId,
        userId: auroraText(input.userId, 200, "User ID"),
        summary: auroraText(input.summary, 10_000, "Advice summary"),
        ...(input.initiativeId ? { initiativeId: input.initiativeId } : {}),
        ...(input.taskRef ? { taskRef: input.taskRef } : {}),
        claimRefs: auroraIds(input.claimRefs, 100, "Advice claim refs"),
        createdAt: new Date(this.now()).toISOString(),
      };
      state.advice.push(record);
      return structuredClone(record);
    });
  }

  /** Advice effectiveness feedback loop; low effectiveness must make Aurora advise less, not more. */
  async recordAdviceOutcome(input: { tenantId: string; adviceId: string; followed: boolean; helpful: boolean; note?: string }): Promise<AdviceRecord> {
    return await this.store.mutate((state) => {
      const record = state.advice.find((item) => item.tenantId === input.tenantId && item.id === input.adviceId);
      if (!record) throw new Error("Advice record not found in tenant.");
      if (record.outcome?.helpful !== undefined) throw new Error("Advice outcome is already recorded.");
      record.outcome = {
        followed: input.followed,
        helpful: input.helpful,
        ...(input.note ? { note: auroraText(input.note, 2000, "Advice note") } : {}),
        ratedAt: new Date(this.now()).toISOString(),
      };
      return structuredClone(record);
    });
  }

  /**
   * J1 wiring helper: the engine can observe whether advice was followed
   * (a task the advice pointed at ran to completion) but can NOT observe
   * whether it helped — that stays undefined until the user rates it.
   */
  async observeAdviceFollowed(input: { tenantId: string; adviceId: string; followed: boolean; note?: string }): Promise<AdviceRecord> {
    return await this.store.mutate((state) => {
      const record = state.advice.find((item) => item.tenantId === input.tenantId && item.id === input.adviceId);
      if (!record) throw new Error("Advice record not found in tenant.");
      if (record.outcome?.helpful !== undefined) return structuredClone(record); // a user rating outranks observation
      record.outcome = {
        followed: input.followed,
        ratedAt: new Date(this.now()).toISOString(),
        autoObserved: true,
        ...(input.note ? { note: auroraText(input.note, 2000, "Advice note") } : {}),
      };
      return structuredClone(record);
    });
  }

  /**
   * J1: when a task an advice record pointed at completes, the follow-through
   * is observable; helpfulness is not, so it stays undefined until rated.
   */
  async observeAdviceFollowedByTask(tenantId: string, userId: string, taskRef: string): Promise<number> {
    return await this.store.mutate((state) => {
      let observed = 0;
      for (const record of state.advice) {
        if (record.tenantId !== tenantId || record.userId !== userId || record.taskRef !== taskRef) continue;
        if (record.outcome?.helpful !== undefined) continue; // already user-rated
        if (record.outcome?.followed) continue; // already observed
        record.outcome = { followed: true, ratedAt: new Date(this.now()).toISOString(), autoObserved: true, note: "The referenced task completed." };
        observed++;
      }
      return observed;
    });
  }

  /** P1.47 context-sensitive adjustment: effectiveness decides how often Aurora should advise. */
  async advicePolicy(tenantId: string, userId: string): Promise<AdvicePolicy> {
    const state = await this.store.read();
    const advice = state.advice.filter((item) => item.tenantId === tenantId && item.userId === userId && item.outcome);
    const rated = advice.filter((item) => item.outcome?.helpful !== undefined);
    if (rated.length < 3) {
      return {
        mode: "insufficient-evidence",
        effectivenessScore: 0,
        suggestedMinIntervalHours: 24,
        ratedOutcomes: rated.length,
        basis: `${rated.length} user-rated outcome(s); at least 3 are needed before advice frequency adapts.`,
      };
    }
    const followed = rated.filter((item) => item.outcome?.followed).length;
    const helpful = rated.filter((item) => item.outcome?.helpful).length;
    const effectivenessScore = auroraRound((followed * 0.4 + helpful * 0.6) / rated.length);
    if (effectivenessScore < 0.35) {
      return {
        mode: "advise-less",
        effectivenessScore,
        suggestedMinIntervalHours: 72,
        ratedOutcomes: rated.length,
        basis: `Effectiveness ${effectivenessScore.toFixed(2)} across ${rated.length} rated outcomes; Aurora advises less and waits longer.`,
      };
    }
    if (effectivenessScore > 0.7) {
      return {
        mode: "advise-more",
        effectivenessScore,
        suggestedMinIntervalHours: 6,
        ratedOutcomes: rated.length,
        basis: `Effectiveness ${effectivenessScore.toFixed(2)} across ${rated.length} rated outcomes; advice is landing, shorter intervals are justified.`,
      };
    }
    return {
      mode: "normal",
      effectivenessScore,
      suggestedMinIntervalHours: 24,
      ratedOutcomes: rated.length,
      basis: `Effectiveness ${effectivenessScore.toFixed(2)} across ${rated.length} rated outcomes.`,
    };
  }

  /** Guardian alignment check: does a proposed action serve the user's own active goals? */
  async alignmentCheck(tenantId: string, userId: string, proposal: string): Promise<{ aligned: boolean; score: number; supportingGoalIds: string[]; concerns: string[] }> {
    const state = await this.store.read();
    const text = auroraText(proposal, 10_000, "Alignment proposal").toLowerCase();
    const goals = state.goals.filter((item) => item.tenantId === tenantId && item.userId === userId && item.status === "active");
    const supporting = goals.filter((goal) => {
      const tokens = [...new Set(`${goal.title} ${goal.description}`.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/))]
        .filter((token) => token.length > 3)
        .slice(0, 40);
      return tokens.some((token) => text.includes(token));
    });
    const weakness = state.claims.filter((item) => item.tenantId === tenantId && item.userId === userId && item.category === "weakness" && item.status === "active");
    const concerns = weakness.filter((claim) => text.includes(claim.value.toLowerCase().split(/\s+/)[0] ?? "\u0000")).map((claim) => `Known difficulty: ${claim.value}`);
    const score = auroraRound(Math.min(1, supporting.reduce((sum, goal) => sum + goal.importance, 0) / Math.max(1, goals.length)));
    return { aligned: supporting.length > 0, score, supportingGoalIds: supporting.map((item) => item.id), concerns };
  }

  /** Full inspectable projection of everything Aurora believes about a user. */
  async summary(tenantId: string, userId: string): Promise<UserModelSummary> {
    const state = await this.store.read();
    const claims = state.claims.filter((item) => item.tenantId === tenantId && item.userId === userId && ["active", "proposed"].includes(item.status));
    const grouped: UserModelSummary["claims"] = {};
    for (const claim of claims) {
      grouped[claim.category] = [...(grouped[claim.category] ?? []), { key: claim.key, value: claim.value, confidence: claim.confidence, source: claim.source, status: claim.status }];
    }
    const advice = state.advice.filter((item) => item.tenantId === tenantId && item.userId === userId && item.outcome);
    const followed = advice.filter((item) => item.outcome?.followed).length;
    const helpful = advice.filter((item) => item.outcome?.helpful).length;
    const trustClaim = claims.find((item) => item.category === "trust");
    const attentionClaims = claims.filter((item) => item.category === "attention");
    const frustration = await this.frustrationRisk(tenantId, userId);
    return {
      userId,
      tenantId,
      claims: grouped,
      goals: (await this.goals(tenantId, userId, "active")),
      projects: (await this.projects(tenantId, userId)).map((project) => ({
        id: project.id, name: project.name, status: project.status,
        ...(project.deadline ? { deadline: project.deadline } : {}), activeTasks: project.activeTasks,
      })),
      trustScore: trustClaim ? trustClaim.confidence : 0.5,
      adviceEffectiveness: {
        total: advice.length,
        followed,
        helpful,
        score: advice.length ? auroraRound((followed * 0.4 + helpful * 0.6) / advice.length) : 0,
      },
      frustrationRisk: frustration.risk,
      attentionLoad: attentionClaims.length ? auroraRound(attentionClaims.reduce((sum, item) => sum + item.confidence, 0) / attentionClaims.length) : 0.5,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  // ─── P1.48 user controls: per-feature privacy, retention, export ───

  private static readonly DEFAULT_FEATURE_CONSENTS: Record<UserFeatureId, boolean> = {
    inference: false,          // inferred claims are opt-in
    signals: true,
    "advice-tracking": true,
    "research-memory": true,
    "state-estimation": true,
  };

  async setFeatureConsent(tenantId: string, userId: string, feature: UserFeatureId, enabled: boolean): Promise<UserFeatureConsents> {
    return await this.store.mutate((state) => {
      state.privacy = state.privacy ?? [];
      const record = this.mutablePrivacy(state, tenantId, userId);
      record.features[feature] = enabled;
      record.updatedAt = new Date(this.now()).toISOString();
      return this.projectConsents(record);
    });
  }

  async featureConsents(tenantId: string, userId: string): Promise<UserFeatureConsents> {
    const state = await this.store.read();
    const record = (state.privacy ?? []).find((item) => item.tenantId === tenantId && item.userId === userId);
    return this.projectConsents(record);
  }

  private projectConsents(record: { features: Partial<Record<UserFeatureId, boolean>>; retentionDays?: number; updatedAt: string } | undefined): UserFeatureConsents {
    return {
      features: { ...UserModelService.DEFAULT_FEATURE_CONSENTS, ...(record?.features ?? {}) },
      ...(record?.retentionDays !== undefined ? { retentionDays: record.retentionDays } : {}),
      updatedAt: record?.updatedAt ?? new Date(this.now()).toISOString(),
    };
  }

  private mutablePrivacy(state: UserModelStateShape, tenantId: string, userId: string): { tenantId: string; userId: string; features: Partial<Record<UserFeatureId, boolean>>; retentionDays?: number; updatedAt: string } {
    let record = (state.privacy ?? []).find((item) => item.tenantId === tenantId && item.userId === userId);
    if (!record) {
      record = { tenantId, userId, features: {}, updatedAt: new Date(this.now()).toISOString() };
      state.privacy = [...(state.privacy ?? []), record];
    }
    return record;
  }

  async setRetention(tenantId: string, userId: string, days: number): Promise<UserFeatureConsents> {
    return await this.store.mutate((state) => {
      const record = this.mutablePrivacy(state, tenantId, userId);
      record.retentionDays = auroraInteger(days, 1, MAX_RETENTION_DAYS, "Retention days");
      record.updatedAt = new Date(this.now()).toISOString();
      return this.projectConsents(record);
    });
  }

  /**
   * Apply the retention period. Inferred/system claims and behavioural
   * telemetry (signals, advice, milestones, projects) older than the window
   * are deleted; user-stated claims are kept and reported as kept, because
   * deleting what the user themselves stated is not retention, it is data
   * loss the user did not ask for.
   */
  async applyRetention(tenantId: string, userId: string): Promise<{
    retentionDays: number | null;
    removed: { claims: number; signals: number; advice: number; milestones: number; projects: number };
    keptUserStatedClaims: number;
  }> {
    const consents = await this.featureConsents(tenantId, userId);
    const days = consents.retentionDays ?? null;
    if (days === null) {
      return { retentionDays: null, removed: { claims: 0, signals: 0, advice: 0, milestones: 0, projects: 0 }, keptUserStatedClaims: 0 };
    }
    const cutoff = this.now() - days * 86_400_000;
    return await this.store.mutate((state) => {
      const before = { claims: state.claims.length, signals: state.signals.length, advice: state.advice.length, milestones: state.milestones.length, projects: (state.projects ?? []).length };
      state.claims = state.claims.filter((item) =>
        !(item.tenantId === tenantId && item.userId === userId
          && item.source !== "user-stated"
          && Date.parse(item.updatedAt) < cutoff));
      state.signals = state.signals.filter((item) => !(item.tenantId === tenantId && item.userId === userId && Date.parse(item.at) < cutoff));
      state.advice = state.advice.filter((item) => !(item.tenantId === tenantId && item.userId === userId && Date.parse(item.createdAt) < cutoff));
      state.milestones = state.milestones.filter((item) => !(item.tenantId === tenantId && item.userId === userId && Date.parse(item.occurredAt) < cutoff));
      state.projects = (state.projects ?? []).filter((item) => !(item.tenantId === tenantId && item.userId === userId && Date.parse(item.updatedAt) < cutoff));
      return {
        retentionDays: days,
        removed: {
          claims: before.claims - state.claims.length,
          signals: before.signals - state.signals.length,
          advice: before.advice - state.advice.length,
          milestones: before.milestones - state.milestones.length,
          projects: before.projects - (state.projects ?? []).length,
        },
        keptUserStatedClaims: state.claims.filter((item) => item.tenantId === tenantId && item.userId === userId && item.source === "user-stated").length,
      };
    });
  }

  /** P1.48 export: everything Aurora holds about one user, machine-readable. */
  async exportUser(tenantId: string, userId: string): Promise<{
    userId: string;
    tenantId: string;
    exportedAt: string;
    claims: UserClaim[];
    goals: UserGoalModel[];
    projects: UserProject[];
    signals: UserSignal[];
    milestones: UserMilestone[];
    advice: AdviceRecord[];
    privacy: UserFeatureConsents;
  }> {
    const state = await this.store.read();
    const scope = <T extends { tenantId: string; userId: string }>(items: T[]): T[] =>
      items.filter((item) => item.tenantId === tenantId && item.userId === userId).map((item) => structuredClone(item));
    return {
      userId,
      tenantId,
      exportedAt: new Date(this.now()).toISOString(),
      claims: scope(state.claims),
      goals: scope(state.goals),
      projects: scope(state.projects ?? []),
      signals: scope(state.signals),
      milestones: scope(state.milestones),
      advice: scope(state.advice),
      privacy: await this.featureConsents(tenantId, userId),
    };
  }

  private mutableClaim(state: UserModelStateShape, tenantId: string, claimId: string): UserClaim {
    const claim = state.claims.find((item) => item.tenantId === tenantId && item.id === claimId);
    if (!claim) throw new Error("User claim not found in tenant.");
    return claim;
  }
}

function assertPermittedTopic(text: string): void {
  for (const pattern of FORBIDDEN_TOPIC_PATTERNS) {
    if (pattern.test(text)) throw new Error("Aurora user model rejects protected-topic inferences (health, belief, politics, ethnicity, sexuality or credentials).");
  }
}

function assertGoalRefs(state: UserModelStateShape, tenantId: string, selfId: string | undefined, refs: string[], label: string): void {
  if (refs.length > 20) throw new Error(`Goal ${label} list is limited to 20 goals.`);
  for (const ref of refs) {
    if (ref === selfId) throw new Error(`A goal cannot ${label === "dependsOn" ? "depend on" : "conflict with"} itself.`);
    if (!state.goals.some((item) => item.tenantId === tenantId && item.id === ref)) throw new Error(`Goal ${label} reference not found: ${ref}`);
  }
}
