/**
 * Digital Twin Service
 * Workspace intelligence maintaining current model of user's projects,
 * tools, goals, constraints and workflows.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

// ─── Types ───

export interface DigitalTwin {
  id: string;
  tenantId: string;
  userId: string;
  profile: UserProfile;
  projects: ProjectContext[];
  tools: ToolContext[];
  workflows: WorkflowContext[];
  constraints: Constraint[];
  preferences: UserPreferences;
  learningHistory: LearningEntry[];
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile {
  name?: string;
  role?: string;
  expertise: string[];
  timezone: string;
  language: string;
  communicationStyle: "formal" | "casual" | "technical";
  workingHours?: { start: string; end: string; days: string[] };
}

export interface ProjectContext {
  id: string;
  name: string;
  description: string;
  repository?: string;
  status: "active" | "paused" | "completed" | "archived";
  technologies: string[];
  team: string[];
  deadlines: Deadline[];
  milestones: Milestone[];
  risks: Risk[];
  budget?: BudgetInfo;
  lastActivity: string;
}

export interface Deadline {
  id: string;
  title: string;
  date: string;
  priority: "critical" | "high" | "medium" | "low";
  status: "upcoming" | "at_risk" | "overdue" | "met";
}

export interface Milestone {
  id: string;
  title: string;
  targetDate: string;
  completedDate?: string;
  status: "pending" | "in_progress" | "completed" | "delayed";
  dependencies: string[];
}

export interface Risk {
  id: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  probability: number; // 0-1
  impact: string;
  mitigation?: string;
  status: "identified" | "mitigating" | "resolved" | "accepted";
}

export interface BudgetInfo {
  total: number;
  spent: number;
  currency: string;
  forecast: number;
}

export interface ToolContext {
  id: string;
  name: string;
  type: "ide" | "cli" | "service" | "database" | "cloud" | "monitoring" | "ci_cd" | "other";
  proficiency: "beginner" | "intermediate" | "advanced" | "expert";
  usageFrequency: "daily" | "weekly" | "monthly" | "rare";
  configuration?: Record<string, unknown>;
  lastUsed?: string;
}

export interface WorkflowContext {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  triggers: string[];
  frequency: "daily" | "weekly" | "monthly" | "on_demand" | "event_driven";
  efficiency: number; // 0-1
  lastExecuted?: string;
}

export interface WorkflowStep {
  id: string;
  name: string;
  tool?: string;
  action: string;
  estimatedMinutes: number;
  automatable: boolean;
}

export interface Constraint {
  id: string;
  type: "time" | "budget" | "resource" | "technical" | "legal" | "security";
  description: string;
  severity: "hard" | "soft";
  value?: string;
  expiresAt?: string;
}

export interface UserPreferences {
  codeStyle?: Record<string, string>;
  commitStyle?: string;
  reviewDepth?: "quick" | "thorough" | "exhaustive";
  automationLevel?: "minimal" | "moderate" | "full";
  notificationPreferences?: Record<string, boolean>;
  responseLength?: "concise" | "detailed" | "comprehensive";
}

export interface LearningEntry {
  id: string;
  type: "preference" | "pattern" | "correction" | "feedback";
  content: string;
  confidence: number;
  source: string;
  learnedAt: string;
}

// ─── State ───

interface DigitalTwinState {
  schemaVersion: number;
  twins: DigitalTwin[];
}

export class DigitalTwinService {
  private store: DurableJsonState<DigitalTwinState>;

  constructor(private baseDir: string) {
    this.store = new DurableJsonState<DigitalTwinState>(
      join(baseDir, "digital-twin.json"),
      () => ({ schemaVersion: 1, twins: [] }),
      (v) => { const s = v as DigitalTwinState; return !!s && s.schemaVersion === 1; },
      "Digital twin service",
    );
  }

  async init(): Promise<void> { await this.store.read(); }

  // ─── Twin Management ───

  async createTwin(tenantId: string, userId: string, profile: Partial<UserProfile> = {}): Promise<DigitalTwin> {
    const twin: DigitalTwin = {
      id: randomUUID(),
      tenantId,
      userId,
      profile: {
        expertise: [],
        timezone: "UTC",
        language: "en",
        communicationStyle: "technical",
        ...profile,
      },
      projects: [],
      tools: [],
      workflows: [],
      constraints: [],
      preferences: {},
      learningHistory: [],
      lastSyncedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.store.mutate(s => { s.twins.push(twin); });
    return twin;
  }

  async getTwin(tenantId: string, userId?: string): Promise<DigitalTwin | undefined> {
    const s = await this.store.read();
    return s.twins.find(t => t.tenantId === tenantId && (!userId || t.userId === userId));
  }

  async getTwins(tenantId: string): Promise<DigitalTwin[]> {
    const s = await this.store.read();
    return s.twins.filter(t => t.tenantId === tenantId);
  }

  // ─── Project Management ───

  async addProject(tenantId: string, project: Omit<ProjectContext, "id">): Promise<ProjectContext> {
    const twin = await this.getTwin(tenantId);
    if (!twin) throw new Error("Digital twin not found");

    const newProject: ProjectContext = { ...project, id: randomUUID() };
    twin.projects.push(newProject);
    twin.updatedAt = new Date().toISOString();
    await this.store.mutate(() => {});
    return newProject;
  }

  async updateProject(tenantId: string, projectId: string, updates: Partial<ProjectContext>): Promise<void> {
    await this.store.mutate(s => {
      const twin = s.twins.find(t => t.tenantId === tenantId);
      if (!twin) return;
      const project = twin.projects.find(p => p.id === projectId);
      if (project) { Object.assign(project, updates); twin.updatedAt = new Date().toISOString(); }
    });
  }

  // ─── Tool Management ───

  async addTool(tenantId: string, tool: Omit<ToolContext, "id">): Promise<ToolContext> {
    const newTool: ToolContext = { ...tool, id: randomUUID() };
    await this.store.mutate(s => {
      const twin = s.twins.find(t => t.tenantId === tenantId);
      if (twin) { twin.tools.push(newTool); twin.updatedAt = new Date().toISOString(); }
    });
    return newTool;
  }

  async recordToolUsage(tenantId: string, toolId: string): Promise<void> {
    await this.store.mutate(s => {
      const twin = s.twins.find(t => t.tenantId === tenantId);
      if (!twin) return;
      const tool = twin.tools.find(t => t.id === toolId);
      if (tool) { tool.lastUsed = new Date().toISOString(); }
    });
  }

  // ─── Workflow Management ───

  async addWorkflow(tenantId: string, workflow: Omit<WorkflowContext, "id">): Promise<WorkflowContext> {
    const newWorkflow: WorkflowContext = { ...workflow, id: randomUUID() };
    await this.store.mutate(s => {
      const twin = s.twins.find(t => t.tenantId === tenantId);
      if (twin) { twin.workflows.push(newWorkflow); twin.updatedAt = new Date().toISOString(); }
    });
    return newWorkflow;
  }

  async recordWorkflowExecution(tenantId: string, workflowId: string): Promise<void> {
    await this.store.mutate(s => {
      const twin = s.twins.find(t => t.tenantId === tenantId);
      if (!twin) return;
      const wf = twin.workflows.find(w => w.id === workflowId);
      if (wf) { wf.lastExecuted = new Date().toISOString(); }
    });
  }

  // ─── Constraints ───

  async addConstraint(tenantId: string, constraint: Omit<Constraint, "id">): Promise<Constraint> {
    const newConstraint: Constraint = { ...constraint, id: randomUUID() };
    await this.store.mutate(s => {
      const twin = s.twins.find(t => t.tenantId === tenantId);
      if (twin) { twin.constraints.push(newConstraint); twin.updatedAt = new Date().toISOString(); }
    });
    return newConstraint;
  }

  async getActiveConstraints(tenantId: string): Promise<Constraint[]> {
    const twin = await this.getTwin(tenantId);
    if (!twin) return [];
    const now = new Date().toISOString();
    return twin.constraints.filter(c => !c.expiresAt || c.expiresAt > now);
  }

  // ─── Preferences ───

  async updatePreferences(tenantId: string, preferences: Partial<UserPreferences>): Promise<void> {
    await this.store.mutate(s => {
      const twin = s.twins.find(t => t.tenantId === tenantId);
      if (twin) { Object.assign(twin.preferences, preferences); twin.updatedAt = new Date().toISOString(); }
    });
  }

  // ─── Learning ───

  async recordLearning(tenantId: string, entry: Omit<LearningEntry, "id" | "learnedAt">): Promise<void> {
    await this.store.mutate(s => {
      const twin = s.twins.find(t => t.tenantId === tenantId);
      if (twin) {
        twin.learningHistory.push({
          ...entry,
          id: randomUUID(),
          learnedAt: new Date().toISOString(),
        });
        twin.updatedAt = new Date().toISOString();
      }
    });
  }

  async getLearnings(tenantId: string, type?: LearningEntry["type"]): Promise<LearningEntry[]> {
    const twin = await this.getTwin(tenantId);
    if (!twin) return [];
    return twin.learningHistory.filter(l => !type || l.type === type);
  }

  // ─── Sync ───

  async sync(tenantId: string): Promise<{ synced: boolean; changes: string[] }> {
    const changes: string[] = [];
    // There is no external system wired up. This previously stamped
    // `lastSyncedAt`, reported the strings "projects", "tools", "workflows" as
    // changed, and returned `synced: true` — a sync that touched nothing but
    // looked successful, leaving a misleading freshness timestamp behind.
    throw new Error(
      "Digital twin sync is not implemented. It requires at least one configured external system; " +
        "no lastSyncedAt timestamp is written so the twin is not falsely marked fresh.",
    );
  }

  // ─── Stats ───

  async getStats(tenantId: string) {
    const twin = await this.getTwin(tenantId);
    if (!twin) return { exists: false };
    return {
      exists: true,
      projects: twin.projects.length,
      activeProjects: twin.projects.filter(p => p.status === "active").length,
      tools: twin.tools.length,
      workflows: twin.workflows.length,
      constraints: twin.constraints.length,
      learnings: twin.learningHistory.length,
      lastSynced: twin.lastSyncedAt,
    };
  }
}
