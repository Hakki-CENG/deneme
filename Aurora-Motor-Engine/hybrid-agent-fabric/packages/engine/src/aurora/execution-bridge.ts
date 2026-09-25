import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentSocietyService, SocietyRole, SocietyTask } from "../society/agent-society-service.js";
import type { SkillEvolutionService } from "../evolution/skill-evolution-service.js";
import type { PlanRecord, PlanningService, PlanStep } from "./planning-service.js";
import { auroraInteger, auroraOptionalText, auroraRound, auroraTags, auroraText, auroraUnit, DurableJsonState } from "../util/aurora-state.js";

const MAX_LINKS = 20_000;
const MAX_PER_DELEGATION = 25;

export type DelegationLinkStatus = "posted" | "nominated" | "assigned" | "running" | "completed" | "failed" | "cancelled" | "detached";

export interface DelegationLink {
  id: string;
  tenantId: string;
  planId: string;
  planTitle: string;
  stepKey: string;
  taskId: string;
  rootSessionId: string;
  requiredCapabilityTags: string[];
  nominatedRoleId?: string;
  assignedRoleId?: string;
  status: DelegationLinkStatus;
  /** Deterministic match evidence, so "why this role?" never needs a model to answer. */
  match?: { roleId: string; coverage: number; reputation: number; score: number };
  outcome?: { success: boolean; quality: number; evidenceEventIds: string[] };
  note?: string;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt?: string;
}

export interface DelegationPolicy {
  tenantId: string;
  /** Let the ACOS execute phase delegate ready steps without a human asking. Off by default. */
  autoDelegate: boolean;
  /** Spawn the child session automatically once a task is awarded. Off by default. */
  autoActivate: boolean;
  /** Root session used by unattended delegation; without it auto-delegation stays inert. */
  rootSessionId?: string;
  maxActiveTasksPerPlan: number;
  maxTasksPerRun: number;
  /** Refuse to post work no active role can satisfy instead of leaving an orphan task open. */
  requireRoleMatch: boolean;
  /**
   * Soft, reversible protection for consequential work: a role that has earned a bad record is not
   * nominated for high-risk steps. It keeps its low-risk work, so it can also earn its way back.
   */
  probation: { minAttempts: number; maxFailureRate: number; riskFloor: number };
  updatedAt: string;
}

interface BridgeStateShape {
  schemaVersion: 1;
  links: DelegationLink[];
  policies: DelegationPolicy[];
}

export interface DelegationResult {
  planId: string;
  created: DelegationLink[];
  skipped: Array<{ stepKey: string; reason: string }>;
  generatedAt: string;
}

export interface DelegationSyncResult {
  synced: number;
  updatedSteps: Array<{ planId: string; stepKey: string; from: string; to: string; taskId: string }>;
  closed: number;
  generatedAt: string;
}

const TERMINAL_LINK_STATUS: DelegationLinkStatus[] = ["completed", "failed", "cancelled", "detached"];

/**
 * Aurora execution bridge: the missing edge between "Aurora decided what to do" and "the society
 * actually did it".
 *
 * Before this layer, plans and the agent society were two healthy organs with no nerve between them:
 * a plan step named work nobody was ever asked to perform, and society tasks existed with no link
 * back to the plan that justified them. The bridge closes that loop while keeping every existing
 * guarantee intact:
 *
 * - it only delegates steps the planner itself reports as **ready** (dependencies satisfied), so the
 *   dependency graph still governs execution order;
 * - role selection is deterministic and recorded (tag coverage, reputation, bid economics) — the
 *   match evidence is stored on the link, so "why this role?" is answered from state, never narrated;
 * - a nomination is explicitly labelled as machine-authored in the bid rationale; the bridge never
 *   pretends a role volunteered;
 * - spawning a child session (the real side effect) is opt-in per tenant and never implicit;
 * - every society outcome flows back into the plan step with its evidence event IDs, so plan progress
 *   is backed by the child session's events rather than by an assertion;
 * - bounds everywhere: active tasks per plan, tasks per run, links per tenant, and a hard refusal to
 *   post work that no active role can satisfy.
 */
export class AuroraExecutionBridge {
  private readonly store: DurableJsonState<BridgeStateShape>;

  constructor(
    rootPath: string,
    private readonly deps: {
      planning: PlanningService;
      society: AgentSocietyService;
      /** Optional: record "no reliable role for this risk level" as an evidence-backed gap. */
      evolution?: Pick<SkillEvolutionService, "observeGap">;
    },
    private readonly now: () => number = Date.now,
  ) {
    this.store = new DurableJsonState<BridgeStateShape>(
      join(rootPath, "planning", "delegation.json"),
      () => ({ schemaVersion: 1, links: [], policies: [] }),
      (value) => {
        const state = value as BridgeStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.links) && Array.isArray(state.policies);
      },
      "Aurora delegation state",
    );
  }

  async policy(tenantId: string): Promise<DelegationPolicy> {
    return await this.store.mutate((state) => structuredClone(this.mutablePolicy(state, tenantId)));
  }

  async configure(input: {
    tenantId: string; autoDelegate?: boolean; autoActivate?: boolean; rootSessionId?: string | null;
    maxActiveTasksPerPlan?: number; maxTasksPerRun?: number; requireRoleMatch?: boolean;
    probation?: { minAttempts?: number; maxFailureRate?: number; riskFloor?: number };
  }): Promise<DelegationPolicy> {
    return await this.store.mutate((state) => {
      const policy = this.mutablePolicy(state, input.tenantId);
      if (input.autoDelegate !== undefined) policy.autoDelegate = input.autoDelegate;
      if (input.autoActivate !== undefined) policy.autoActivate = input.autoActivate;
      if (input.rootSessionId !== undefined) {
        if (input.rootSessionId === null || !input.rootSessionId.trim()) delete policy.rootSessionId;
        else policy.rootSessionId = auroraText(input.rootSessionId, 200, "Root session ID");
      }
      if (input.maxActiveTasksPerPlan !== undefined) policy.maxActiveTasksPerPlan = auroraInteger(input.maxActiveTasksPerPlan, 1, 100, "Active tasks per plan");
      if (input.maxTasksPerRun !== undefined) policy.maxTasksPerRun = auroraInteger(input.maxTasksPerRun, 1, MAX_PER_DELEGATION, "Tasks per run");
      if (input.requireRoleMatch !== undefined) policy.requireRoleMatch = input.requireRoleMatch;
      if (input.probation) {
        if (input.probation.minAttempts !== undefined) policy.probation.minAttempts = auroraInteger(input.probation.minAttempts, 1, 1000, "Probation attempts");
        if (input.probation.maxFailureRate !== undefined) policy.probation.maxFailureRate = auroraUnit(input.probation.maxFailureRate, "Probation failure rate");
        if (input.probation.riskFloor !== undefined) policy.probation.riskFloor = auroraUnit(input.probation.riskFloor, "Probation risk floor");
      }
      policy.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(policy);
    });
  }

  /**
   * Rank the active roles that could take a piece of work. Deterministic and explainable: capability
   * coverage first, then earned reputation, then how recently the role has been loaded with work.
   */
  async candidates(tenantId: string, capabilityTags: string[]): Promise<Array<{ roleId: string; name: string; coverage: number; reputation: number; activeTasks: number; score: number; completedTasks: number; failedTasks: number; failureRate: number; onProbation: boolean }>> {
    const policy = await this.policy(tenantId);
    const tags = auroraTags(capabilityTags, "Required capability tags");
    const [roles, tasks] = await Promise.all([this.deps.society.roles(tenantId), this.deps.society.tasks(tenantId)]);
    const load = new Map<string, number>();
    for (const task of tasks) {
      if (task.assignedRoleId && ["assigned", "running"].includes(task.status)) {
        load.set(task.assignedRoleId, (load.get(task.assignedRoleId) ?? 0) + 1);
      }
    }
    return roles
      .filter((role) => role.status === "active")
      .map((role) => {
        const coverage = tags.length ? tags.filter((tag) => role.capabilityTags.includes(tag)).length / tags.length : 1;
        const activeTasks = load.get(role.id) ?? 0;
        const availability = 1 / (1 + activeTasks);
        const attempts = role.completedTasks + role.failedTasks;
        const failureRate = attempts ? auroraRound(role.failedTasks / attempts) : 0;
        return {
          roleId: role.id,
          name: role.name,
          coverage: auroraRound(coverage),
          reputation: role.reputation,
          activeTasks,
          score: auroraRound(coverage * 0.6 + role.reputation * 0.3 + availability * 0.1),
          completedTasks: role.completedTasks,
          failedTasks: role.failedTasks,
          failureRate,
          onProbation: attempts >= policy.probation.minAttempts && failureRate > policy.probation.maxFailureRate,
        };
      })
      .filter((item) => item.coverage > 0 || tags.length === 0)
      .sort((a, b) => b.score - a.score || a.roleId.localeCompare(b.roleId));
  }

  /**
   * Turn ready plan steps into society tasks. Nothing here can start work that the plan graph says is
   * not startable, and nothing spawns a session unless `activate` is explicitly requested.
   */
  async delegate(input: {
    tenantId: string; planId: string; rootSessionId?: string; stepKeys?: string[]; max?: number;
    priority?: SocietyTask["priority"]; capabilityTags?: string[]; nominate?: boolean; award?: boolean; activate?: boolean;
  }): Promise<DelegationResult> {
    const policy = await this.policy(input.tenantId);
    const rootSessionId = auroraText(input.rootSessionId ?? policy.rootSessionId ?? "", 200, "Root session ID");
    const plan = await this.deps.planning.get(input.tenantId, input.planId);
    if (!["draft", "active", "blocked"].includes(plan.status)) throw new Error(`Plan "${plan.id}" is ${plan.status}; only an open plan can be delegated.`);
    const progress = await this.deps.planning.progress(input.tenantId, input.planId);
    const requested = input.stepKeys?.map((key) => auroraText(key, 120, "Step key").toLowerCase());
    const max = auroraInteger(input.max ?? policy.maxTasksPerRun, 1, MAX_PER_DELEGATION, "Delegation limit");
    const nominate = input.nominate ?? true;
    const award = input.award ?? true;
    const activate = input.activate ?? policy.autoActivate;

    const state = await this.store.read();
    const existing = state.links.filter((link) => link.tenantId === input.tenantId && link.planId === plan.id);
    const liveForPlan = existing.filter((link) => !TERMINAL_LINK_STATUS.includes(link.status)).length;

    const created: DelegationLink[] = [];
    const skipped: Array<{ stepKey: string; reason: string }> = [];
    let budget = Math.max(0, policy.maxActiveTasksPerPlan - liveForPlan);

    // Society economics are consulted *before* posting rather than discovered at award time: a task
    // that can never be awarded today is worse than no task, because it sits open and hides the
    // real constraint. Both the daily token budget and the concurrency ceiling are respected, and
    // this call's own commitments are counted as it goes.
    const societyBudget = await this.deps.society.budget(input.tenantId);
    const societyTasks = await this.deps.society.tasks(input.tenantId);
    let remainingSlots = Math.max(0, societyBudget.maxConcurrentTasks
      - societyTasks.filter((item) => ["assigned", "running"].includes(item.status)).length);
    let remainingTokens = Math.max(0, societyBudget.dailyTokenBudget - societyBudget.usedTokens - societyBudget.reservedTokens);

    // When the budget is tight the longest pole should move first: critical-path steps, then risk,
    // then the biggest estimate. Explicitly requested steps keep the caller's order.
    const queue = requested ?? this.prioritiseReady(plan, progress.ready);
    for (const stepKey of queue) {
      const step = plan.steps.find((item) => item.key === stepKey);
      if (!step) { skipped.push({ stepKey, reason: "step-not-found" }); continue; }
      if (!progress.ready.includes(step.key)) { skipped.push({ stepKey: step.key, reason: `step-not-ready (${step.status})` }); continue; }
      if (existing.some((link) => link.stepKey === step.key && !TERMINAL_LINK_STATUS.includes(link.status))) {
        skipped.push({ stepKey: step.key, reason: "already-delegated" });
        continue;
      }
      if (created.length >= max) { skipped.push({ stepKey: step.key, reason: "run-limit-reached" }); continue; }
      if (budget <= 0) { skipped.push({ stepKey: step.key, reason: "plan-concurrency-limit" }); continue; }

      const planned = Math.min(10_000_000, Math.max(100, step.estimateTokens || 100_000));
      if (award && remainingSlots <= 0) { skipped.push({ stepKey: step.key, reason: "society-concurrency-exhausted" }); continue; }
      if (award && remainingTokens < planned) {
        skipped.push({ stepKey: step.key, reason: `society-token-budget-exhausted (needs ${planned}, ${remainingTokens} left today)` });
        continue;
      }

      const tags = await this.tagsFor(input.tenantId, plan, step, input.capabilityTags);
      const ranked = await this.candidates(input.tenantId, tags);
      // High-risk work is never nominated to a role on probation, even if it is the best match.
      const highRisk = step.riskLevel >= policy.probation.riskFloor;
      const eligible = highRisk ? ranked.filter((item) => !item.onProbation) : ranked;
      if (highRisk && !eligible.length && ranked.length) {
        skipped.push({ stepKey: step.key, reason: `all-matching-roles-on-probation (risk ${step.riskLevel})` });
        // The society has nobody trustworthy for work at this risk level. That is a capability gap,
        // and recording it is how the evolution pipeline ever hears about it.
        await this.deps.evolution?.observeGap({
          tenantId: input.tenantId,
          kind: "capability-gap",
          description: `No reliable society role for high-risk work tagged "${tags.join(", ") || "untagged"}"`,
          context: [
            `Plan: ${plan.title} · step: ${step.key} (risk ${step.riskLevel})`,
            `Candidates on probation: ${ranked.filter((item) => item.onProbation).map((item) => `${item.roleId} (${item.failedTasks}/${item.completedTasks + item.failedTasks} failed)`).join(", ")}`,
          ].join("\n").slice(0, 5000),
          severity: Math.min(1, step.riskLevel),
          evidenceRefs: [plan.id, ...ranked.slice(0, 10).map((item) => item.roleId)],
        }).catch(() => undefined);
        continue;
      }
      const best = eligible.find((item) => item.coverage >= 1) ?? eligible[0];
      if (policy.requireRoleMatch && (!best || best.coverage < 1)) {
        skipped.push({ stepKey: step.key, reason: `no-role-matches (${tags.join(", ") || "untagged"})` });
        continue;
      }

      const link = await this.createLink({
        tenantId: input.tenantId, plan, step, rootSessionId, tags,
        priority: input.priority ?? this.priorityFor(plan, step),
        ...(best ? { best } : {}),
        nominate, award, activate,
      });
      created.push(link);
      budget--;
      if (link.status === "assigned" || link.status === "running") {
        remainingSlots--;
        remainingTokens = Math.max(0, remainingTokens - planned);
      }
    }

    return { planId: plan.id, created, skipped, generatedAt: new Date(this.now()).toISOString() };
  }

  /** Spawn the child session for an awarded task. The one genuinely irreversible step, kept explicit. */
  async activate(tenantId: string, linkId: string): Promise<DelegationLink> {
    const link = await this.link(tenantId, linkId);
    if (link.status !== "assigned") throw new Error(`Delegation ${linkId} is ${link.status}; only an assigned delegation can be activated.`);
    const task = await this.deps.society.execute(tenantId, link.taskId);
    return await this.applyTask(tenantId, linkId, task);
  }

  /**
   * Reconcile society reality back into the plan. This is the half that makes plan progress
   * trustworthy: a step is only done because a task completed with evidence from its child session.
   */
  async sync(input: { tenantId: string; planId?: string; limit?: number }): Promise<DelegationSyncResult> {
    const limit = auroraInteger(input.limit ?? 200, 1, 2000, "Sync limit");
    const state = await this.store.read();
    const open = state.links
      .filter((link) => link.tenantId === input.tenantId && !TERMINAL_LINK_STATUS.includes(link.status))
      .filter((link) => (input.planId ? link.planId === input.planId : true))
      .slice(0, limit)
      .map((link) => structuredClone(link));

    const updatedSteps: DelegationSyncResult["updatedSteps"] = [];
    let closed = 0;
    for (const link of open) {
      let task: SocietyTask;
      try {
        task = await this.deps.society.getTask(input.tenantId, link.taskId);
      } catch {
        // The task vanished (state reset or manual pruning): detach rather than block the plan forever.
        await this.patch(input.tenantId, link.id, (item) => { item.status = "detached"; item.note = "Society task is no longer available."; });
        closed++;
        continue;
      }
      const change = await this.applyTaskToPlan(input.tenantId, link, task);
      if (change) updatedSteps.push(change);
      if (TERMINAL_LINK_STATUS.includes((await this.link(input.tenantId, link.id)).status)) closed++;
    }
    return { synced: open.length, updatedSteps, closed, generatedAt: new Date(this.now()).toISOString() };
  }

  /** Unhook a delegation without touching the society task: used when a plan is replanned. */
  async detach(tenantId: string, linkId: string, reason: string): Promise<DelegationLink> {
    const note = auroraText(reason, 1000, "Detach reason");
    return await this.patch(tenantId, linkId, (link) => {
      if (TERMINAL_LINK_STATUS.includes(link.status)) throw new Error(`Delegation ${linkId} is already ${link.status}.`);
      link.status = "detached";
      link.note = note;
    });
  }

  async links(tenantId: string, filter: { planId?: string; status?: DelegationLinkStatus; openOnly?: boolean; limit?: number } = {}): Promise<DelegationLink[]> {
    const state = await this.store.read();
    return state.links
      .filter((link) => link.tenantId === tenantId)
      .filter((link) => (filter.planId ? link.planId === filter.planId : true))
      .filter((link) => (filter.status ? link.status === filter.status : true))
      .filter((link) => (filter.openOnly ? !TERMINAL_LINK_STATUS.includes(link.status) : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, auroraInteger(filter.limit ?? 100, 1, 1000, "Link limit"))
      .map((link) => structuredClone(link));
  }

  /** How much of a plan is actually being executed, by whom, and with what result. */
  async report(tenantId: string, planId: string): Promise<{
    planId: string; planTitle: string; steps: number; ready: number; delegated: number; open: number;
    completed: number; failed: number; coverage: number; byRole: Array<{ roleId: string; tasks: number; completed: number; failed: number }>;
    undelegatedReady: string[]; generatedAt: string;
  }> {
    const [plan, progress, links] = await Promise.all([
      this.deps.planning.get(tenantId, planId),
      this.deps.planning.progress(tenantId, planId),
      this.links(tenantId, { planId, limit: 1000 }),
    ]);
    const byRole = new Map<string, { roleId: string; tasks: number; completed: number; failed: number }>();
    for (const link of links) {
      const roleId = link.assignedRoleId ?? link.nominatedRoleId;
      if (!roleId) continue;
      const entry = byRole.get(roleId) ?? { roleId, tasks: 0, completed: 0, failed: 0 };
      entry.tasks++;
      if (link.status === "completed") entry.completed++;
      if (link.status === "failed") entry.failed++;
      byRole.set(roleId, entry);
    }
    const delegatedKeys = new Set(links.map((link) => link.stepKey));
    return {
      planId: plan.id,
      planTitle: plan.title,
      steps: plan.steps.length,
      ready: progress.ready.length,
      delegated: delegatedKeys.size,
      open: links.filter((link) => !TERMINAL_LINK_STATUS.includes(link.status)).length,
      completed: links.filter((link) => link.status === "completed").length,
      failed: links.filter((link) => link.status === "failed").length,
      coverage: plan.steps.length ? auroraRound(delegatedKeys.size / plan.steps.length) : 0,
      byRole: [...byRole.values()].sort((a, b) => b.tasks - a.tasks || a.roleId.localeCompare(b.roleId)),
      undelegatedReady: progress.ready.filter((key) => !delegatedKeys.has(key)),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Roles whose own record has put them on probation, and what that currently blocks. */
  async probationReport(tenantId: string): Promise<{
    tenantId: string; policy: DelegationPolicy["probation"];
    roles: Array<{ roleId: string; name: string; completedTasks: number; failedTasks: number; failureRate: number; reputation: number; capabilityTags: string[] }>;
    blockedSteps: Array<{ planId: string; planTitle: string; stepKey: string; riskLevel: number }>;
    generatedAt: string;
  }> {
    const policy = await this.policy(tenantId);
    const candidates = await this.candidates(tenantId, []);
    const roles = await this.deps.society.roles(tenantId);
    const onProbation = candidates.filter((item) => item.onProbation).map((item) => {
      const role = roles.find((value) => value.id === item.roleId);
      return {
        roleId: item.roleId,
        name: item.name,
        completedTasks: item.completedTasks,
        failedTasks: item.failedTasks,
        failureRate: item.failureRate,
        reputation: item.reputation,
        capabilityTags: role?.capabilityTags ?? [],
      };
    });
    const blockedSteps: Array<{ planId: string; planTitle: string; stepKey: string; riskLevel: number }> = [];
    if (onProbation.length) {
      const plans = await this.deps.planning.list(tenantId, { status: "active", limit: 100 });
      for (const plan of plans) {
        const progress = await this.deps.planning.progress(tenantId, plan.id);
        for (const key of progress.ready) {
          const step = plan.steps.find((item) => item.key === key);
          if (step && step.riskLevel >= policy.probation.riskFloor) {
            blockedSteps.push({ planId: plan.id, planTitle: plan.title, stepKey: step.key, riskLevel: step.riskLevel });
          }
        }
      }
    }
    return { tenantId, policy: policy.probation, roles: onProbation, blockedSteps, generatedAt: new Date(this.now()).toISOString() };
  }

  /**
   * One unattended pass, called by the ACOS execute phase. Reconciliation always runs; new work is
   * only created when the tenant explicitly enabled auto-delegation and named a root session.
   */
  async runCycle(tenantId: string): Promise<{ synced: number; updatedSteps: number; delegated: number; skipped: number; autoDelegate: boolean }> {
    const policy = await this.policy(tenantId);
    const sync = await this.sync({ tenantId });
    let delegated = 0;
    let skipped = 0;
    if (policy.autoDelegate && policy.rootSessionId) {
      const plans = await this.deps.planning.list(tenantId, { status: "active", limit: 25 });
      // Fairness across plans, same principle as the fleet: the plan that waited longest for
      // delegation goes first, so one busy plan cannot monopolise the daily society budget.
      const state = await this.store.read();
      const lastDelegatedAt = new Map<string, string>();
      for (const link of state.links.filter((item) => item.tenantId === tenantId)) {
        const previous = lastDelegatedAt.get(link.planId);
        if (!previous || link.createdAt > previous) lastDelegatedAt.set(link.planId, link.createdAt);
      }
      const ordered = [...plans].sort((a, b) =>
        (lastDelegatedAt.get(a.id) ?? "").localeCompare(lastDelegatedAt.get(b.id) ?? "")
        // Fairness first; among equally-waiting plans the one with the longest remaining critical
        // path goes next, because that is the plan whose finish date the delay actually moves.
        || b.criticalPath.length - a.criticalPath.length
        || a.id.localeCompare(b.id));
      let budget = policy.maxTasksPerRun;
      for (const plan of ordered) {
        if (budget <= 0) break;
        try {
          const result = await this.delegate({ tenantId, planId: plan.id, rootSessionId: policy.rootSessionId, max: budget });
          delegated += result.created.length;
          skipped += result.skipped.length;
          budget -= result.created.length;
        } catch {
          // A single unhealthy plan must not stop reconciliation for the rest of the tenant.
          skipped++;
        }
      }
    }
    return { synced: sync.synced, updatedSteps: sync.updatedSteps.length, delegated, skipped, autoDelegate: policy.autoDelegate };
  }

  /** Deterministic scheduling order for ready work: critical path, then risk, then size. */
  private prioritiseReady(plan: PlanRecord, ready: string[]): string[] {
    const byKey = new Map(plan.steps.map((item) => [item.key, item]));
    return [...ready].sort((a, b) => {
      const left = byKey.get(a);
      const right = byKey.get(b);
      const criticality = Number(plan.criticalPath.includes(b)) - Number(plan.criticalPath.includes(a));
      if (criticality !== 0) return criticality;
      const risk = (right?.riskLevel ?? 0) - (left?.riskLevel ?? 0);
      if (risk !== 0) return risk;
      const size = (right?.estimateMinutes ?? 0) - (left?.estimateMinutes ?? 0);
      if (size !== 0) return size;
      return a.localeCompare(b);
    });
  }

  private async createLink(input: {
    tenantId: string; plan: PlanRecord; step: PlanStep; rootSessionId: string; tags: string[];
    priority: SocietyTask["priority"]; best?: { roleId: string; coverage: number; reputation: number; score: number };
    nominate: boolean; award: boolean; activate: boolean;
  }): Promise<DelegationLink> {
    const task = await this.deps.society.postTask({
      tenantId: input.tenantId,
      rootSessionId: input.rootSessionId,
      title: `${input.plan.title} · ${input.step.key}`,
      objective: [
        `Plan: ${input.plan.title}`,
        `Objective: ${input.plan.objective}`,
        `Step: ${input.step.title}`,
        input.step.detail ? `Detail: ${input.step.detail}` : "",
        `Verification required: ${input.step.verification}`,
      ].filter(Boolean).join("\n").slice(0, 50_000),
      requiredCapabilityTags: input.tags,
      priority: input.priority,
      maxTokens: Math.min(10_000_000, Math.max(100, input.step.estimateTokens || 100_000)),
    });

    const timestamp = new Date(this.now()).toISOString();
    let link: DelegationLink = {
      id: `delegation-${randomUUID()}`,
      tenantId: input.tenantId,
      planId: input.plan.id,
      planTitle: input.plan.title,
      stepKey: input.step.key,
      taskId: task.id,
      rootSessionId: input.rootSessionId,
      requiredCapabilityTags: input.tags,
      status: "posted",
      ...(input.best ? { nominatedRoleId: input.best.roleId, match: { roleId: input.best.roleId, coverage: input.best.coverage, reputation: input.best.reputation, score: input.best.score } } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.store.mutate((state) => {
      if (state.links.length >= MAX_LINKS) state.links.splice(0, state.links.length - MAX_LINKS + 1);
      state.links.push(link);
    });
    await this.deps.planning.updateStep({ tenantId: input.tenantId, planId: input.plan.id, stepKey: input.step.key, status: "ready", taskId: task.id });

    if (input.nominate && input.best && input.best.coverage >= 1) {
      try {
        await this.deps.society.bid({
          tenantId: input.tenantId,
          taskId: task.id,
          roleId: input.best.roleId,
          confidence: Math.min(1, Math.max(0.05, auroraRound(0.4 + input.best.reputation * 0.4 + input.best.coverage * 0.2))),
          estimatedTokens: Math.min(task.maxTokens, Math.max(1, input.step.estimateTokens || 10_000)),
          estimatedDurationMs: Math.min(30 * 24 * 60 * 60_000, Math.max(1, (input.step.estimateMinutes || 15) * 60_000)),
          rationale: `Nominated by the Aurora execution bridge for plan step "${input.step.key}": capability coverage ${input.best.coverage}, role reputation ${input.best.reputation}, match score ${input.best.score}. This bid is machine-authored, not a volunteered claim.`,
        });
        link = await this.patch(input.tenantId, link.id, (item) => { item.status = "nominated"; });
        if (input.award) {
          const awarded = await this.deps.society.award(input.tenantId, task.id);
          link = await this.applyTask(input.tenantId, link.id, awarded);
          if (input.activate && awarded.status === "assigned") {
            const running = await this.deps.society.execute(input.tenantId, task.id);
            link = await this.applyTask(input.tenantId, link.id, running);
          }
        }
      } catch (error) {
        // Nomination, award and activation are best-effort: the task stays open for a human or an
        // agent to pick up, and the reason is recorded on the link instead of thrown away.
        link = await this.patch(input.tenantId, link.id, (item) => { item.note = `${(error as Error).message}`.slice(0, 500); });
      }
    }
    return link;
  }

  private async applyTask(tenantId: string, linkId: string, task: SocietyTask): Promise<DelegationLink> {
    return await this.patch(tenantId, linkId, (link) => {
      if (task.assignedRoleId) link.assignedRoleId = task.assignedRoleId;
      link.status = this.linkStatusFor(task.status, link.status);
      if (task.status === "completed" || task.status === "failed") {
        link.outcome = { success: task.status === "completed", quality: task.quality ?? 0, evidenceEventIds: task.evidenceEventIds.slice(0, 200) };
      }
      link.lastSyncedAt = new Date(this.now()).toISOString();
    });
  }

  private async applyTaskToPlan(tenantId: string, link: DelegationLink, task: SocietyTask): Promise<DelegationSyncResult["updatedSteps"][number] | undefined> {
    await this.applyTask(tenantId, link.id, task);
    const plan = await this.deps.planning.get(tenantId, link.planId).catch(() => undefined);
    const step = plan?.steps.find((item) => item.key === link.stepKey);
    if (!plan || !step) {
      await this.patch(tenantId, link.id, (item) => { item.status = "detached"; item.note = "Plan or step no longer exists."; });
      return undefined;
    }
    const target = this.stepStatusFor(task.status);
    if (!target || step.status === target) return undefined;
    if (["done", "skipped"].includes(step.status)) return undefined;
    // Wall-clock from delegation to society completion is a recorded fact, and it is what makes
    // estimate accuracy real instead of an estimate about estimates.
    const elapsedMinutes = target === "done" || target === "failed"
      ? Math.max(0, Math.round((Date.parse(task.updatedAt) - Date.parse(link.createdAt)) / 60_000))
      : undefined;
    await this.deps.planning.updateStep({
      tenantId,
      planId: link.planId,
      stepKey: link.stepKey,
      status: target,
      taskId: task.id,
      ...(elapsedMinutes !== undefined ? { actualMinutes: elapsedMinutes } : {}),
      ...(task.evidenceEventIds.length ? { evidenceRefs: task.evidenceEventIds.slice(0, 200) } : {}),
      ...(task.status === "failed" ? { note: `Society task ${task.id} failed; the step needs replanning or another owner.` } : {}),
    });
    return { planId: link.planId, stepKey: link.stepKey, from: step.status, to: target, taskId: task.id };
  }

  private stepStatusFor(status: SocietyTask["status"]): "in-progress" | "done" | "failed" | "ready" | undefined {
    switch (status) {
      case "running": return "in-progress";
      case "completed": return "done";
      case "failed": return "failed";
      case "cancelled": return "ready";
      default: return undefined;
    }
  }

  private linkStatusFor(status: SocietyTask["status"], current: DelegationLinkStatus): DelegationLinkStatus {
    switch (status) {
      case "open": return current === "nominated" ? "nominated" : "posted";
      case "assigned": return "assigned";
      case "running": return "running";
      case "completed": return "completed";
      case "failed": return "failed";
      case "cancelled": return "cancelled";
      default: return current;
    }
  }

  /** Tags come from the caller, then the step's assigned role, then the plan's own tags. */
  private async tagsFor(tenantId: string, plan: PlanRecord, step: PlanStep, override?: string[]): Promise<string[]> {
    if (override?.length) return auroraTags(override, "Required capability tags");
    if (step.assignedRoleId) {
      const role = (await this.deps.society.roles(tenantId)).find((item: SocietyRole) => item.id === step.assignedRoleId);
      if (role?.capabilityTags.length) return role.capabilityTags.slice(0, 20);
    }
    if (plan.tags.length) {
      const known = new Set((await this.deps.society.roles(tenantId)).flatMap((role) => role.capabilityTags));
      const usable = plan.tags.filter((tag) => known.has(tag));
      if (usable.length) return usable.slice(0, 20);
    }
    return [];
  }

  private priorityFor(plan: PlanRecord, step: PlanStep): SocietyTask["priority"] {
    if (step.riskLevel >= 0.8) return "critical";
    if (plan.criticalPath.includes(step.key)) return "high";
    if (step.riskLevel >= 0.5) return "high";
    return "normal";
  }

  private async link(tenantId: string, linkId: string): Promise<DelegationLink> {
    const state = await this.store.read();
    const link = state.links.find((item) => item.tenantId === tenantId && item.id === linkId);
    if (!link) throw new Error("Aurora delegation not found in tenant.");
    return structuredClone(link);
  }

  private async patch(tenantId: string, linkId: string, mutate: (link: DelegationLink) => void): Promise<DelegationLink> {
    return await this.store.mutate((state) => {
      const link = state.links.find((item) => item.tenantId === tenantId && item.id === linkId);
      if (!link) throw new Error("Aurora delegation not found in tenant.");
      mutate(link);
      link.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(link);
    });
  }

  private mutablePolicy(state: BridgeStateShape, tenantId: string): DelegationPolicy {
    const id = auroraText(tenantId, 200, "Tenant ID");
    let policy = state.policies.find((item) => item.tenantId === id);
    if (!policy) {
      policy = {
        tenantId: id,
        autoDelegate: false,
        autoActivate: false,
        maxActiveTasksPerPlan: 3,
        maxTasksPerRun: 5,
        requireRoleMatch: true,
        probation: { minAttempts: 4, maxFailureRate: 0.5, riskFloor: 0.7 },
        updatedAt: new Date(this.now()).toISOString(),
      };
      state.policies.push(policy);
    }
    // Forward migration: a policy written by an older version has no probation block. Defaulting it
    // here keeps existing tenants working instead of throwing on the first read after an upgrade.
    if (!policy.probation) policy.probation = { minAttempts: 4, maxFailureRate: 0.5, riskFloor: 0.7 };
    return policy;
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const items = (s as any)[Object.keys(s).find(k => Array.isArray((s as any)[k])) ?? ""]?.filter((x: any) => x.tenantId === tenantId) ?? [];
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





/** Exported for tests and for callers that want the same notion of "still in flight". */
export function isOpenDelegation(status: DelegationLinkStatus): boolean {
  return !TERMINAL_LINK_STATUS.includes(status);
}

export function delegationNoteOf(link: DelegationLink): string | undefined {
  return auroraOptionalText(link.note, 1000, "Delegation note");
}
