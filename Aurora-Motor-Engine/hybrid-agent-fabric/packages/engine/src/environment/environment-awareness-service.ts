import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  auroraDigest, auroraIds, auroraInteger, auroraRound, auroraTags, auroraText, auroraTimestamp, auroraUnit, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_RESOURCES = 10_000;
const MAX_ACTIONS = 200_000;
const MAX_PROJECTS = 5_000;
const MAX_HABITS = 20_000;

export type EnvironmentResourceKind =
  | "filesystem" | "terminal" | "ide" | "browser" | "git" | "database" | "api" | "device"
  | "cloud" | "calendar" | "channel" | "kernel" | "sandbox" | "mcp-server";

/**
 * Safe execution zones 0-4 from the PDF.
 * 0 read-only, 1 workspace write, 2 process/network, 3 external side effect, 4 destructive/critical.
 */
export type EnvironmentZone = 0 | 1 | 2 | 3 | 4;

export interface EnvironmentResource {
  id: string;
  tenantId: string;
  kind: EnvironmentResourceKind;
  name: string;
  locatorDigest: string;
  zone: EnvironmentZone;
  status: "available" | "degraded" | "unavailable" | "retired";
  capabilityIds: string[];
  requiresApproval: boolean;
  tags: string[];
  health: { successes: number; failures: number; reputation: number; averageLatencyMs: number; lastCheckedAt?: string; lastError?: string };
  createdAt: string;
  updatedAt: string;
}

/** Standard Aurora action record: goal -> plan -> action -> result -> verification -> memory update. */
export interface EnvironmentAction {
  id: string;
  tenantId: string;
  sessionId?: string;
  resourceId: string;
  goal: string;
  plan: string[];
  action: string;
  parameterDigest: string;
  expectedOutcome: string;
  zone: EnvironmentZone;
  status: "planned" | "approved" | "executing" | "completed" | "verified" | "failed" | "rolled-back";
  approval?: { actor: string; reason: string; at: string };
  result?: { summary: string; success: boolean; durationMs: number; unexpected: boolean; at: string };
  verification?: { method: string; passed: boolean; evidenceRefs: string[]; note: string; at: string };
  memoryUpdateRefs: string[];
  rollbackPlan?: string;
  rollbackCheckpointId?: string;
  rolledBackAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceProject {
  id: string;
  tenantId: string;
  name: string;
  workspacePath: string;
  repositoryRef?: string;
  status: "active" | "paused" | "archived";
  openTasks: number;
  risks: string[];
  progress: number;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceHabit {
  id: string;
  tenantId: string;
  scope: string;
  pattern: string;
  occurrences: number;
  successRate: number;
  lastSeenAt: string;
  createdAt: string;
}

export interface EnvironmentInventory {
  tenantId: string;
  totals: { resources: number; available: number; degraded: number; unavailable: number };
  byKind: Record<string, number>;
  byZone: Record<string, number>;
  lowReputation: Array<{ resourceId: string; name: string; reputation: number }>;
  unverifiedActions: number;
  unexpectedOutcomes: number;
  generatedAt: string;
}

interface EnvironmentStateShape {
  schemaVersion: 1;
  resources: EnvironmentResource[];
  actions: EnvironmentAction[];
  projects: WorkspaceProject[];
  habits: WorkspaceHabit[];
}

/**
 * Aurora Phase G — environment inventory, embodiment action records with mandatory verification,
 * tool execution reputation, workspace habits and continuous project awareness.
 *
 * This layer records and governs; it never executes. Execution stays with the existing HAF
 * capability broker, policy engine, sandboxes and approval service.
 */
export class EnvironmentAwarenessService {
  private readonly store: DurableJsonState<EnvironmentStateShape>;

  constructor(rootPath: string, private readonly now: () => number = Date.now) {
    this.store = new DurableJsonState<EnvironmentStateShape>(
      join(rootPath, "environment", "state.json"),
      () => ({ schemaVersion: 1, resources: [], actions: [], projects: [], habits: [] }),
      (value) => {
        const state = value as EnvironmentStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.resources) && Array.isArray(state.actions)
          && Array.isArray(state.projects) && Array.isArray(state.habits);
      },
      "Aurora environment state",
    );
  }

  async registerResource(input: {
    tenantId: string; kind: EnvironmentResourceKind; name: string; locator: string; zone: EnvironmentZone;
    capabilityIds?: string[]; requiresApproval?: boolean; tags?: string[];
  }): Promise<EnvironmentResource> {
    return await this.store.mutate((state) => {
      if (state.resources.length >= MAX_RESOURCES) throw new Error("Environment resource limit reached.");
      const name = auroraText(input.name, 200, "Resource name");
      const locatorDigest = auroraDigest(auroraText(input.locator, 2000, "Resource locator"));
      const nowIso = new Date(this.now()).toISOString();
      const existing = state.resources.find((item) => item.tenantId === input.tenantId && item.kind === input.kind && item.locatorDigest === locatorDigest);
      if (existing) {
        existing.name = name;
        existing.zone = input.zone;
        existing.capabilityIds = auroraIds(input.capabilityIds, 100, "Resource capability IDs");
        existing.requiresApproval = input.requiresApproval ?? existing.requiresApproval;
        existing.tags = auroraTags(input.tags, "Resource tags");
        existing.status = existing.status === "retired" ? "available" : existing.status;
        existing.updatedAt = nowIso;
        return structuredClone(existing);
      }
      const resource: EnvironmentResource = {
        id: `res-${randomUUID()}`,
        tenantId: input.tenantId,
        kind: input.kind,
        name,
        locatorDigest,
        zone: input.zone,
        status: "available",
        capabilityIds: auroraIds(input.capabilityIds, 100, "Resource capability IDs"),
        requiresApproval: input.requiresApproval ?? input.zone >= 3,
        tags: auroraTags(input.tags, "Resource tags"),
        health: { successes: 0, failures: 0, reputation: 0.5, averageLatencyMs: 0 },
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.resources.push(resource);
      return structuredClone(resource);
    });
  }

  async setResourceStatus(tenantId: string, resourceId: string, status: EnvironmentResource["status"], note?: string): Promise<EnvironmentResource> {
    return await this.store.mutate((state) => {
      const resource = this.mutableResource(state, tenantId, resourceId);
      const nowIso = new Date(this.now()).toISOString();
      resource.status = status;
      resource.health.lastCheckedAt = nowIso;
      if (note) resource.health.lastError = auroraText(note, 1000, "Resource note");
      resource.updatedAt = nowIso;
      return structuredClone(resource);
    });
  }

  async resources(tenantId: string, filter?: { kind?: EnvironmentResourceKind; status?: EnvironmentResource["status"]; maxZone?: EnvironmentZone }): Promise<EnvironmentResource[]> {
    const state = await this.store.read();
    return state.resources
      .filter((item) => item.tenantId === tenantId
        && (!filter?.kind || item.kind === filter.kind)
        && (!filter?.status || item.status === filter.status)
        && (filter?.maxZone === undefined || item.zone <= filter.maxZone))
      .sort((a, b) => a.zone - b.zone || b.health.reputation - a.health.reputation)
      .map((item) => structuredClone(item));
  }

  /**
   * Plan an action against a resource. Zone 3+ actions require an explicit rollback plan and
   * cannot execute until approved; nothing here bypasses the policy engine, it mirrors it durably.
   */
  async planAction(input: {
    tenantId: string; resourceId: string; goal: string; plan: string[]; action: string; parameters?: unknown;
    expectedOutcome: string; sessionId?: string; rollbackPlan?: string; rollbackCheckpointId?: string;
  }): Promise<EnvironmentAction> {
    return await this.store.mutate((state) => {
      if (state.actions.length >= MAX_ACTIONS) throw new Error("Environment action limit reached.");
      const resource = this.mutableResource(state, input.tenantId, input.resourceId);
      if (resource.status === "retired" || resource.status === "unavailable") throw new Error("Environment resource is not usable.");
      const plan = (input.plan ?? []).map((item) => auroraText(item, 2000, "Action plan step"));
      if (!plan.length) throw new Error("An Aurora action requires an explicit plan.");
      if (resource.zone >= 3 && !input.rollbackPlan) throw new Error("Zone 3+ actions require a rollback plan.");
      const nowIso = new Date(this.now()).toISOString();
      const action: EnvironmentAction = {
        id: `act-${randomUUID()}`,
        tenantId: input.tenantId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        resourceId: resource.id,
        goal: auroraText(input.goal, 5000, "Action goal"),
        plan,
        action: auroraText(input.action, 2000, "Action name"),
        parameterDigest: auroraDigest(input.parameters ?? {}),
        expectedOutcome: auroraText(input.expectedOutcome, 5000, "Expected outcome"),
        zone: resource.zone,
        status: "planned",
        ...(input.rollbackPlan ? { rollbackPlan: auroraText(input.rollbackPlan, 5000, "Rollback plan") } : {}),
        ...(input.rollbackCheckpointId ? { rollbackCheckpointId: auroraText(input.rollbackCheckpointId, 300, "Rollback checkpoint ID") } : {}),
        memoryUpdateRefs: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.actions.push(action);
      return structuredClone(action);
    });
  }

  async approveAction(input: { tenantId: string; actionId: string; actor: string; reason: string }): Promise<EnvironmentAction> {
    return await this.store.mutate((state) => {
      const action = this.mutableAction(state, input.tenantId, input.actionId);
      if (action.status !== "planned") throw new Error("Only planned actions can be approved.");
      const nowIso = new Date(this.now()).toISOString();
      action.approval = { actor: auroraText(input.actor, 200, "Approval actor"), reason: auroraText(input.reason, 2000, "Approval reason"), at: nowIso };
      action.status = "approved";
      action.updatedAt = nowIso;
      return structuredClone(action);
    });
  }

  async startAction(tenantId: string, actionId: string): Promise<EnvironmentAction> {
    return await this.store.mutate((state) => {
      const action = this.mutableAction(state, tenantId, actionId);
      const resource = this.mutableResource(state, tenantId, action.resourceId);
      if (action.status === "planned" && (resource.requiresApproval || action.zone >= 3)) throw new Error("This action requires approval before execution.");
      if (!["planned", "approved"].includes(action.status)) throw new Error("Action is not startable.");
      action.status = "executing";
      action.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(action);
    });
  }

  /** Record the raw outcome. Unexpected outcomes are flagged so the cognitive layer can observe them. */
  async completeAction(input: { tenantId: string; actionId: string; success: boolean; summary: string; durationMs: number; unexpected?: boolean }): Promise<EnvironmentAction> {
    return await this.store.mutate((state) => {
      const action = this.mutableAction(state, input.tenantId, input.actionId);
      if (action.status !== "executing") throw new Error("Only executing actions can be completed.");
      const resource = this.mutableResource(state, input.tenantId, action.resourceId);
      const nowIso = new Date(this.now()).toISOString();
      const durationMs = auroraInteger(input.durationMs, 0, 30 * 86_400_000, "Action duration");
      action.result = {
        summary: auroraText(input.summary, 20_000, "Action result"),
        success: input.success,
        durationMs,
        unexpected: input.unexpected ?? false,
        at: nowIso,
      };
      action.status = input.success ? "completed" : "failed";
      action.updatedAt = nowIso;
      if (input.success) resource.health.successes++; else resource.health.failures++;
      const total = resource.health.successes + resource.health.failures;
      resource.health.reputation = auroraRound((resource.health.successes + 1) / (total + 2));
      resource.health.averageLatencyMs = Math.round((resource.health.averageLatencyMs * (total - 1) + durationMs) / Math.max(1, total));
      resource.health.lastCheckedAt = nowIso;
      if (!input.success) resource.health.lastError = action.result.summary.slice(0, 500);
      if (resource.health.failures >= 3 && resource.health.reputation < 0.4) resource.status = "degraded";
      resource.updatedAt = nowIso;
      return structuredClone(action);
    });
  }

  /**
   * Mandatory verification step: an action is only "verified" with an explicit method, outcome and
   * evidence. Failed verification of a completed action reopens it as failed.
   */
  async verifyAction(input: { tenantId: string; actionId: string; method: string; passed: boolean; evidenceRefs?: string[]; note?: string; memoryUpdateRefs?: string[] }): Promise<EnvironmentAction> {
    return await this.store.mutate((state) => {
      const action = this.mutableAction(state, input.tenantId, input.actionId);
      if (!["completed", "failed"].includes(action.status)) throw new Error("Only completed or failed actions can be verified.");
      const nowIso = new Date(this.now()).toISOString();
      action.verification = {
        method: auroraText(input.method, 500, "Verification method"),
        passed: input.passed,
        evidenceRefs: auroraIds(input.evidenceRefs, 200, "Verification evidence refs"),
        note: input.note ? auroraText(input.note, 5000, "Verification note") : "",
        at: nowIso,
      };
      action.memoryUpdateRefs = [...new Set([...action.memoryUpdateRefs, ...auroraIds(input.memoryUpdateRefs, 100, "Memory update refs")])].slice(0, 100);
      action.status = input.passed ? "verified" : "failed";
      action.updatedAt = nowIso;
      return structuredClone(action);
    });
  }

  async rollbackAction(input: { tenantId: string; actionId: string; reason: string; restoredCheckpointId?: string }): Promise<EnvironmentAction> {
    return await this.store.mutate((state) => {
      const action = this.mutableAction(state, input.tenantId, input.actionId);
      if (!action.rollbackPlan && !action.rollbackCheckpointId) throw new Error("This action has no recorded rollback plan.");
      if (!["completed", "failed", "verified"].includes(action.status)) throw new Error("Only finished actions can be rolled back.");
      const nowIso = new Date(this.now()).toISOString();
      action.status = "rolled-back";
      action.rolledBackAt = nowIso;
      const restored = input.restoredCheckpointId ?? action.rollbackCheckpointId;
      action.verification = {
        method: restored ? `rollback:checkpoint:${auroraText(restored, 300, "Restored checkpoint ID")}` : "rollback",
        passed: false,
        evidenceRefs: action.verification?.evidenceRefs ?? [],
        note: auroraText(input.reason, 5000, "Rollback reason"),
        at: nowIso,
      };
      action.updatedAt = nowIso;
      return structuredClone(action);
    });
  }

  async actions(tenantId: string, filter?: { status?: EnvironmentAction["status"]; resourceId?: string; limit?: number }): Promise<EnvironmentAction[]> {
    const state = await this.store.read();
    return state.actions
      .filter((item) => item.tenantId === tenantId && (!filter?.status || item.status === filter.status) && (!filter?.resourceId || item.resourceId === filter.resourceId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, auroraInteger(filter?.limit ?? 100, 1, 1000, "Action limit"))
      .map((item) => structuredClone(item));
  }

  /** Actions that completed but were never verified: the PDF's mandatory verification debt. */
  async unverifiedActions(tenantId: string): Promise<EnvironmentAction[]> {
    const state = await this.store.read();
    return state.actions
      .filter((item) => item.tenantId === tenantId && item.status === "completed" && !item.verification)
      .map((item) => structuredClone(item));
  }

  async upsertProject(input: { tenantId: string; name: string; workspacePath: string; repositoryRef?: string; openTasks?: number; risks?: string[]; progress?: number; status?: WorkspaceProject["status"]; lastActivityAt?: string }): Promise<WorkspaceProject> {
    return await this.store.mutate((state) => {
      const nowIso = new Date(this.now()).toISOString();
      const name = auroraText(input.name, 200, "Project name");
      const workspacePath = auroraText(input.workspacePath, 2000, "Project workspace path");
      let project = state.projects.find((item) => item.tenantId === input.tenantId && item.name === name);
      if (!project) {
        if (state.projects.length >= MAX_PROJECTS) throw new Error("Workspace project limit reached.");
        project = {
          id: `proj-${randomUUID()}`,
          tenantId: input.tenantId,
          name,
          workspacePath,
          status: "active",
          openTasks: 0,
          risks: [],
          progress: 0,
          lastActivityAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        state.projects.push(project);
      }
      project.workspacePath = workspacePath;
      if (input.repositoryRef) project.repositoryRef = auroraText(input.repositoryRef, 500, "Project repository ref");
      if (input.openTasks !== undefined) project.openTasks = auroraInteger(input.openTasks, 0, 100_000, "Project open tasks");
      if (input.risks) project.risks = input.risks.slice(0, 50).map((item) => auroraText(item, 1000, "Project risk"));
      if (input.progress !== undefined) project.progress = auroraUnit(input.progress, "Project progress");
      if (input.status) project.status = input.status;
      project.lastActivityAt = auroraTimestamp(input.lastActivityAt, this.now(), "Project activity timestamp");
      project.updatedAt = nowIso;
      return structuredClone(project);
    });
  }

  async projects(tenantId: string, status?: WorkspaceProject["status"]): Promise<WorkspaceProject[]> {
    const state = await this.store.read();
    return state.projects
      .filter((item) => item.tenantId === tenantId && (!status || item.status === status))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .map((item) => structuredClone(item));
  }

  /** Project watcher input: active projects with no activity for N days. */
  async staleProjects(tenantId: string, days = 7): Promise<Array<{ project: WorkspaceProject; idleDays: number }>> {
    const state = await this.store.read();
    const timestamp = this.now();
    const window = auroraInteger(days, 1, 365, "Stale project window") * 86_400_000;
    return state.projects
      .filter((item) => item.tenantId === tenantId && item.status === "active" && timestamp - Date.parse(item.lastActivityAt) >= window)
      .map((project) => ({ project: structuredClone(project), idleDays: Math.floor((timestamp - Date.parse(project.lastActivityAt)) / 86_400_000) }));
  }

  /** Digital habit learning: recurring workspace patterns with an observed success rate. */
  async recordHabit(input: { tenantId: string; scope: string; pattern: string; success: boolean }): Promise<WorkspaceHabit> {
    return await this.store.mutate((state) => {
      const scope = auroraText(input.scope, 300, "Habit scope");
      const pattern = auroraText(input.pattern, 500, "Habit pattern");
      const nowIso = new Date(this.now()).toISOString();
      let habit = state.habits.find((item) => item.tenantId === input.tenantId && item.scope === scope && item.pattern === pattern);
      if (!habit) {
        if (state.habits.length >= MAX_HABITS) throw new Error("Workspace habit limit reached.");
        habit = { id: `habit-${randomUUID()}`, tenantId: input.tenantId, scope, pattern, occurrences: 0, successRate: 0, lastSeenAt: nowIso, createdAt: nowIso };
        state.habits.push(habit);
      }
      const previousSuccesses = habit.successRate * habit.occurrences;
      habit.occurrences++;
      habit.successRate = auroraRound((previousSuccesses + (input.success ? 1 : 0)) / habit.occurrences);
      habit.lastSeenAt = nowIso;
      return structuredClone(habit);
    });
  }

  async habits(tenantId: string, scope?: string): Promise<WorkspaceHabit[]> {
    const state = await this.store.read();
    return state.habits
      .filter((item) => item.tenantId === tenantId && (!scope || item.scope === scope))
      .sort((a, b) => b.occurrences - a.occurrences)
      .map((item) => structuredClone(item));
  }

  async inventory(tenantId: string): Promise<EnvironmentInventory> {
    const state = await this.store.read();
    const resources = state.resources.filter((item) => item.tenantId === tenantId);
    const actions = state.actions.filter((item) => item.tenantId === tenantId);
    const byKind: Record<string, number> = {};
    const byZone: Record<string, number> = {};
    for (const resource of resources) {
      byKind[resource.kind] = (byKind[resource.kind] ?? 0) + 1;
      byZone[`zone-${resource.zone}`] = (byZone[`zone-${resource.zone}`] ?? 0) + 1;
    }
    return {
      tenantId,
      totals: {
        resources: resources.length,
        available: resources.filter((item) => item.status === "available").length,
        degraded: resources.filter((item) => item.status === "degraded").length,
        unavailable: resources.filter((item) => item.status === "unavailable").length,
      },
      byKind,
      byZone,
      lowReputation: resources.filter((item) => item.health.reputation < 0.4 && item.health.failures > 0)
        .map((item) => ({ resourceId: item.id, name: item.name, reputation: item.health.reputation })),
      unverifiedActions: actions.filter((item) => item.status === "completed" && !item.verification).length,
      unexpectedOutcomes: actions.filter((item) => item.result?.unexpected).length,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  private mutableResource(state: EnvironmentStateShape, tenantId: string, id: string): EnvironmentResource {
    const resource = state.resources.find((item) => item.tenantId === tenantId && item.id === id);
    if (!resource) throw new Error("Environment resource not found in tenant.");
    return resource;
  }

  private mutableAction(state: EnvironmentStateShape, tenantId: string, id: string): EnvironmentAction {
    const action = state.actions.find((item) => item.tenantId === tenantId && item.id === id);
    if (!action) throw new Error("Environment action not found in tenant.");
    return action;
  }
}
