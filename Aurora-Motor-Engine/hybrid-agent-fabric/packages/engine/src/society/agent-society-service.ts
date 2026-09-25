import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventStore } from "../persistence/event-store.js";
import type { AgentProfileRegistry } from "../profiles/agent-profile-registry.js";
import type { Supervisor } from "../runtime/supervisor.js";
import { atomicWrite } from "../util/atomic-file.js";

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_ROLES = 500;
const MAX_TASKS = 100_000;
const MAX_DELIBERATIONS = 10_000;

export type SocietyLayer = "prime" | "council" | "specialist" | "micro";
export interface SocietyRole {
  id: string;
  tenantId: string;
  name: string;
  layer: SocietyLayer;
  purpose: string;
  capabilityTags: string[];
  parentRoleId?: string;
  agentProfileId?: string;
  builtin: boolean;
  status: "active" | "retired";
  reputation: number;
  completedTasks: number;
  failedTasks: number;
  createdAt: string;
  updatedAt: string;
  /**
   * G6 reputation decay anchors. Reputation is evidence-bound, and evidence
   * ages: the last time a role produced an outcome, and the last time its
   * reputation was re-based (decayed or re-anchored by fresh evidence). Both
   * default to `createdAt` when absent, so pre-existing state decays from its
   * creation date instead of never.
   */
  lastOutcomeAt?: string;
  reputationUpdatedAt?: string;
}
export interface SocietyBid {
  id: string;
  roleId: string;
  confidence: number;
  estimatedTokens: number;
  estimatedDurationMs: number;
  rationale: string;
  score?: number;
  createdAt: string;
}
export interface SocietyTask {
  id: string;
  tenantId: string;
  rootSessionId: string;
  title: string;
  objective: string;
  requiredCapabilityTags: string[];
  priority: "critical" | "high" | "normal" | "low";
  status: "open" | "assigned" | "running" | "paused" | "completed" | "failed" | "cancelled";
  maxTokens: number;
  deadline?: string;
  bids: SocietyBid[];
  assignedRoleId?: string;
  childSessionId?: string;
  reservedTokens: number;
  actualTokens?: number;
  quality?: number;
  /** G2 lifecycle records: why a task was paused or cancelled, so the audit trail separates a withdrawer's decision from a performer's failure. */
  pauseReason?: string;
  cancelReason?: string;
  evidenceEventIds: string[];
  createdAt: string;
  updatedAt: string;
}
export interface SocietyPerspective {
  roleId: string;
  recommendation: "approve" | "reject" | "abstain";
  confidence: number;
  summary: string;
  evidenceEventIds: string[];
  submittedAt: string;
}
export interface SocietyDeliberation {
  id: string;
  tenantId: string;
  question: string;
  requiredRoleIds: string[];
  quorum: number;
  status: "open" | "resolved";
  perspectives: SocietyPerspective[];
  result?: {
    decision: "approve" | "reject" | "uncertain";
    confidence: number;
    approveWeight: number;
    rejectWeight: number;
    abstainWeight: number;
    dissentRoleIds: string[];
    missingRoleIds: string[];
  };
  createdAt: string;
  updatedAt: string;
}
interface SocietyBudget {
  tenantId: string;
  date: string;
  dailyTokenBudget: number;
  usedTokens: number;
  reservedTokens: number;
  maxConcurrentTasks: number;
}
/** Agent Communication Bus message: bounded, durable, role-addressed and retention-capped. */
export interface SocietyMessage {
  id: string;
  tenantId: string;
  fromRoleId: string;
  /** G6 provenance: the society layer the sender belongs to (prime|council|specialist|micro). Consumers use it to weigh advice by tier instead of treating every message as equal authority. */
  fromLayer: SocietyLayer;
  audienceRoleIds: string[];
  topic: string;
  body: string;
  taskId?: string;
  deliberationId?: string;
  importance: number;
  acknowledgedBy: string[];
  createdAt: string;
}
export interface SocietyAdvisory {
  code: "stalled-task" | "unbid-task" | "failing-role" | "idle-role" | "budget-saturated" | "concurrency-starved" | "duplicate-task" | "loop-risk";
  severity: "info" | "warning" | "critical";
  subjectId?: string;
  detail: string;
  recommendation: string;
}
export interface SocietyMetaReport {
  tenantId: string;
  advisories: SocietyAdvisory[];
  utilization: { openTasks: number; runningTasks: number; completedTasks: number; failedTasks: number; averageQuality: number };
  budgetSaturation: number;
  generatedAt: string;
}
interface SocietyState { schemaVersion: 1; roles: SocietyRole[]; tasks: SocietyTask[]; deliberations: SocietyDeliberation[]; budgets: SocietyBudget[]; messages: SocietyMessage[] }

const BUILTIN_ROLES: Array<{ id: string; name: string; layer: SocietyLayer; purpose: string; tags: string[]; parent?: string }> = [
  { id: "aurora-prime", name: "Aurora Prime", layer: "prime", purpose: "Synthesize plans, priorities, reports and resource allocations without bypassing policy.", tags: ["coordination", "synthesis", "prioritization"] },
  { id: "memory-director", name: "Memory Director", layer: "council", purpose: "Govern recall, consolidation, compression, relations and archives.", tags: ["memory", "knowledge", "consolidation"], parent: "aurora-prime" },
  { id: "research-director", name: "Research Director", layer: "council", purpose: "Coordinate evidence gathering, trend analysis and source verification.", tags: ["research", "evidence", "sources"], parent: "aurora-prime" },
  { id: "planning-director", name: "Planning Director", layer: "council", purpose: "Coordinate roadmaps, decomposition and priority arbitration.", tags: ["planning", "roadmap", "tasks"], parent: "aurora-prime" },
  { id: "security-director", name: "Security Director", layer: "council", purpose: "Assess authority, access and operational risk.", tags: ["security", "risk", "policy"], parent: "aurora-prime" },
  { id: "skill-director", name: "Skill Director", layer: "council", purpose: "Govern skill evaluation, versions and quality.", tags: ["skills", "evaluation", "evolution"], parent: "aurora-prime" },
  { id: "world-model-director", name: "World Model Director", layer: "council", purpose: "Coordinate predictions, causality and scenarios.", tags: ["world-model", "prediction", "simulation"], parent: "aurora-prime" },
  { id: "user-director", name: "User Director", layer: "council", purpose: "Protect user goals, preferences and long-term alignment.", tags: ["user", "goals", "guardian"], parent: "aurora-prime" },
  { id: "research-agent", name: "Research Agent", layer: "specialist", purpose: "Research and compare evidence.", tags: ["research", "web", "analysis"], parent: "research-director" },
  { id: "coding-agent", name: "Coding Agent", layer: "specialist", purpose: "Implement, refactor and test software.", tags: ["coding", "testing", "debugging"], parent: "planning-director" },
  { id: "debug-agent", name: "Debug Agent", layer: "specialist", purpose: "Analyze failures, logs and performance defects.", tags: ["debugging", "logs", "performance"], parent: "planning-director" },
  { id: "architecture-agent", name: "Architecture Agent", layer: "specialist", purpose: "Design scalable module boundaries and systems.", tags: ["architecture", "scaling", "design"], parent: "planning-director" },
  { id: "planner-agent", name: "Planner Agent", layer: "specialist", purpose: "Decompose objectives into roadmaps and sprints.", tags: ["planning", "tasks", "roadmap"], parent: "planning-director" },
  { id: "reflection-agent", name: "Reflection Agent", layer: "specialist", purpose: "Review errors and extract lessons.", tags: ["reflection", "learning", "quality"], parent: "memory-director" },
  { id: "creativity-agent", name: "Creativity Agent", layer: "specialist", purpose: "Generate alternative and experimental approaches.", tags: ["creativity", "alternatives", "innovation"], parent: "world-model-director" },
  { id: "opportunity-agent", name: "Opportunity Agent", layer: "specialist", purpose: "Detect useful tools, programs and research opportunities.", tags: ["opportunity", "research", "initiative"], parent: "research-director" },
  { id: "risk-agent", name: "Risk Agent", layer: "specialist", purpose: "Identify hazards and mitigations.", tags: ["risk", "security", "mitigation"], parent: "security-director" },
  { id: "communication-agent", name: "Communication Agent", layer: "specialist", purpose: "Prepare notifications, reports and summaries.", tags: ["communication", "reports", "summaries"], parent: "user-director" },
  { id: "guardian-agent", name: "Guardian Agent", layer: "specialist", purpose: "Advocate for user safety and goals.", tags: ["guardian", "user", "safety"], parent: "user-director" },
  { id: "project-manager-agent", name: "Project Manager Agent", layer: "specialist", purpose: "Track progress, dependencies and delivery risks.", tags: ["projects", "progress", "dependencies"], parent: "planning-director" },
  { id: "knowledge-agent", name: "Knowledge Agent", layer: "specialist", purpose: "Manage concepts, relations and knowledge graphs.", tags: ["knowledge", "graph", "relations"], parent: "memory-director" },
  { id: "simulation-agent", name: "Simulation Agent", layer: "specialist", purpose: "Evaluate scenarios and counterfactuals.", tags: ["simulation", "scenarios", "counterfactual"], parent: "world-model-director" },
  { id: "skill-builder-agent", name: "Skill Builder Agent", layer: "specialist", purpose: "Design candidate skills, tests and controlled releases.", tags: ["skills", "coding", "testing"], parent: "skill-director" },
];

export class AgentSocietyService {
  private state: SocietyState = { schemaVersion: 1, roles: [], tasks: [], deliberations: [], budgets: [], messages: [] };
  private loaded = false;
  constructor(
    private readonly rootPath: string,
    private readonly supervisor: Supervisor,
    private readonly profiles: AgentProfileRegistry,
    private readonly events: EventStore,
    /**
     * G6 broadcast screening. The communication bus is untrusted inbound
     * surface exactly like a task goal: a role (or a compromised role) can put
     * arbitrary text in front of other agents. When supplied, every broadcast
     * body passes through it before being persisted; a refused body never
     * reaches the bus. Optional only so standalone/legacy constructions keep
     * compiling -- the engine always passes one.
     */
    private readonly screen?: (body: string) => Promise<{ allowed: boolean; reason: string }>,
  ) {}

  async roles(tenantId: string): Promise<SocietyRole[]> { await this.load(); await this.seed(tenantId); await this.decayReputations(tenantId); return this.state.roles.filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item)); }
  async bindProfile(tenantId: string, roleId: string, agentProfileId?: string): Promise<SocietyRole> {
    const role = await this.role(tenantId, roleId);
    if (agentProfileId) await this.profiles.snapshot(agentProfileId, tenantId);
    if (agentProfileId) role.agentProfileId = agentProfileId; else delete role.agentProfileId;
    role.updatedAt = new Date().toISOString(); await this.save(); return structuredClone(role);
  }
  async addRole(input: { tenantId: string; name: string; layer: SocietyLayer; purpose: string; capabilityTags: string[]; parentRoleId?: string; agentProfileId?: string }): Promise<SocietyRole> {
    await this.load(); await this.seed(input.tenantId);
    if (this.state.roles.filter((item) => item.tenantId === input.tenantId).length >= MAX_ROLES) throw new Error("Society role limit reached.");
    const id = `role-${randomUUID()}`, name = bounded(input.name, 200, "Society role name"), purpose = bounded(input.purpose, 2000, "Society role purpose"), tags = tagsOf(input.capabilityTags);
    if (input.parentRoleId) await this.role(input.tenantId, input.parentRoleId);
    if (input.agentProfileId) await this.profiles.snapshot(input.agentProfileId, input.tenantId);
    const now = new Date().toISOString(); const role: SocietyRole = { id, tenantId: input.tenantId, name, layer: input.layer, purpose, capabilityTags: tags, ...(input.parentRoleId ? { parentRoleId: input.parentRoleId } : {}), ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}), builtin: false, status: "active", reputation: 0.5, completedTasks: 0, failedTasks: 0, createdAt: now, updatedAt: now };
    this.state.roles.push(role); await this.save(); return structuredClone(role);
  }
  async retireRole(tenantId: string, roleId: string): Promise<SocietyRole> { const role = await this.role(tenantId, roleId); if (role.layer === "prime") throw new Error("Aurora Prime cannot be retired."); if (this.state.tasks.some((item) => item.assignedRoleId === roleId && ["assigned", "running"].includes(item.status))) throw new Error("Role has active assigned tasks."); role.status = "retired"; role.updatedAt = new Date().toISOString(); await this.save(); return structuredClone(role); }

  async configureBudget(tenantId: string, dailyTokenBudget: number, maxConcurrentTasks: number): Promise<SocietyBudget> {
    await this.load(); const date = day(this.now()); let budget = this.state.budgets.find((item) => item.tenantId === tenantId);
    if (!budget) { budget = { tenantId, date, dailyTokenBudget: 0, usedTokens: 0, reservedTokens: 0, maxConcurrentTasks: 1 }; this.state.budgets.push(budget); }
    this.rollBudget(budget); budget.dailyTokenBudget = integer(dailyTokenBudget, 1000, 100_000_000, "Daily society token budget"); budget.maxConcurrentTasks = integer(maxConcurrentTasks, 1, 100, "Society concurrency"); await this.save(); return structuredClone(budget);
  }
  async budget(tenantId: string): Promise<SocietyBudget> { await this.load(); let value = this.state.budgets.find((item) => item.tenantId === tenantId); if (!value) return await this.configureBudget(tenantId, 1_000_000, 8); this.rollBudget(value); return structuredClone(value); }

  async postTask(input: { tenantId: string; rootSessionId: string; title: string; objective: string; requiredCapabilityTags: string[]; priority?: SocietyTask["priority"]; maxTokens?: number; deadline?: string }): Promise<SocietyTask> {
    await this.load(); await this.seed(input.tenantId); const session = await this.supervisor.getSession(input.rootSessionId); if (session.tenantId !== input.tenantId) throw new Error("Society task root session tenant mismatch.");
    // G2 cycle guard: a society task roots the specialist's child session under
    // this session. If this session is itself a society child, accepting it as
    // a root would let delegations nest through their own descendants --
    // delegation feeding back into itself with no floor. The root of a
    // delegation tree must be a parent session.
    if (session.parentSessionId) throw new Error("Society task root session must be a parent session; a society child session cannot sponsor further delegation (delegation cycle).");
    if (this.state.tasks.length >= MAX_TASKS) throw new Error("Society task limit reached."); const deadline = input.deadline ? new Date(input.deadline) : undefined; if (deadline && (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= this.now())) throw new Error("Society task deadline must be in the future.");
    const now = new Date().toISOString(); const task: SocietyTask = { id: randomUUID(), tenantId: input.tenantId, rootSessionId: input.rootSessionId, title: bounded(input.title, 300, "Society task title"), objective: bounded(input.objective, 50_000, "Society task objective"), requiredCapabilityTags: tagsOf(input.requiredCapabilityTags), priority: input.priority ?? "normal", status: "open", maxTokens: integer(input.maxTokens ?? 100_000, 100, 10_000_000, "Society task token budget"), ...(deadline ? { deadline: deadline.toISOString() } : {}), bids: [], reservedTokens: 0, evidenceEventIds: [], createdAt: now, updatedAt: now };
    this.state.tasks.push(task); await this.save(); return structuredClone(task);
  }
  async bid(input: { tenantId: string; taskId: string; roleId: string; confidence: number; estimatedTokens: number; estimatedDurationMs: number; rationale: string }): Promise<SocietyTask> {
    const task = await this.task(input.tenantId, input.taskId); if (task.status !== "open") throw new Error("Society task is not accepting bids."); const role = await this.role(input.tenantId, input.roleId); if (role.status !== "active") throw new Error("Retired roles cannot bid.");
    if (!task.requiredCapabilityTags.every((tag) => role.capabilityTags.includes(tag))) throw new Error("Society role does not satisfy required capability tags."); if (task.bids.some((item) => item.roleId === role.id)) throw new Error("Society role already bid on this task.");
    task.bids.push({ id: randomUUID(), roleId: role.id, confidence: score(input.confidence, "Bid confidence"), estimatedTokens: integer(input.estimatedTokens, 1, task.maxTokens, "Bid token estimate"), estimatedDurationMs: integer(input.estimatedDurationMs, 1, 30 * 24 * 60 * 60_000, "Bid duration"), rationale: bounded(input.rationale, 2000, "Bid rationale"), createdAt: new Date().toISOString() }); task.updatedAt = new Date().toISOString(); await this.save(); return structuredClone(task);
  }
  async award(tenantId: string, taskId: string): Promise<SocietyTask> {
    const task = await this.task(tenantId, taskId); if (task.status !== "open" || !task.bids.length) throw new Error("Society task has no awardable bids."); const budget = await this.mutableBudget(tenantId); const running = this.state.tasks.filter((item) => item.tenantId === tenantId && ["assigned", "running"].includes(item.status)).length; if (running >= budget.maxConcurrentTasks) throw new Error("Society concurrency budget is exhausted.");
    const roleMap = new Map((await this.roles(tenantId)).map((item) => [item.id, item])); const ranked = task.bids.map((bid) => { const role = roleMap.get(bid.roleId)!; const coverage = task.requiredCapabilityTags.length ? task.requiredCapabilityTags.filter((tag) => role.capabilityTags.includes(tag)).length / task.requiredCapabilityTags.length : 1; const cost = 1 - Math.min(1, bid.estimatedTokens / task.maxTokens); const value = coverage * 0.4 + role.reputation * 0.3 + bid.confidence * 0.2 + cost * 0.1; bid.score = Number(value.toFixed(6)); return { bid, value }; }).sort((a, b) => b.value - a.value || a.bid.roleId.localeCompare(b.bid.roleId));
    const winner = ranked[0]!.bid; if (budget.usedTokens + budget.reservedTokens + winner.estimatedTokens > budget.dailyTokenBudget) throw new Error("Society daily token budget is exhausted."); budget.reservedTokens += winner.estimatedTokens; task.assignedRoleId = winner.roleId; task.reservedTokens = winner.estimatedTokens; task.status = "assigned"; task.updatedAt = new Date().toISOString(); await this.save(); return structuredClone(task);
  }
  async execute(tenantId: string, taskId: string): Promise<SocietyTask> {
    const task = await this.task(tenantId, taskId); if (task.status !== "assigned" || !task.assignedRoleId) throw new Error("Society task is not assigned."); const role = await this.role(tenantId, task.assignedRoleId); const parent = await this.supervisor.getSession(task.rootSessionId); let profile = parent.agentProfile;
    if (role.agentProfileId) { const candidate = await this.profiles.snapshot(role.agentProfileId, tenantId); if (parent.agentProfile?.allowedCapabilityIds && (!candidate.allowedCapabilityIds || candidate.allowedCapabilityIds.some((id) => !parent.agentProfile!.allowedCapabilityIds!.includes(id)))) throw new Error("Society role profile would exceed parent capability authority."); profile = candidate; }
    const child = await this.supervisor.spawnChild({ parentSessionId: task.rootSessionId, name: `${role.id}-${task.id.slice(0, 8)}`, task: `<SOCIETY_ROLE name="${role.name}" layer="${role.layer}">\n${role.purpose}\n</SOCIETY_ROLE>\n\nObjective:\n${task.objective}\n\nReturn evidence and explicitly state uncertainty.`, source: "agent", ...(profile ? { agentProfile: profile } : {}) });
    task.childSessionId = child.sessionId; task.status = "running"; task.updatedAt = new Date().toISOString(); await this.save(); return structuredClone(task);
  }
  async recordOutcome(input: { tenantId: string; taskId: string; success: boolean; quality: number; actualTokens: number; evidenceEventIds: string[] }): Promise<SocietyTask> {
    const task = await this.task(input.tenantId, input.taskId); if (task.status !== "running" || !task.assignedRoleId || !task.childSessionId) throw new Error("Society task is not running."); const quality = score(input.quality, "Outcome quality"), actual = integer(input.actualTokens, 0, task.maxTokens * 2, "Actual tokens"); const events = await this.events.read(task.childSessionId, 0, 5000); const known = new Set(events.map((item) => item.eventId)); if (!input.evidenceEventIds.length || input.evidenceEventIds.some((id) => !known.has(id))) throw new Error("Society outcome evidence must reference child-session events.");
    const role = await this.role(input.tenantId, task.assignedRoleId), previous = role.completedTasks + role.failedTasks; if (input.success) role.completedTasks++; else role.failedTasks++; role.reputation = Number(((role.reputation * previous + (input.success ? quality : 0)) / (previous + 1)).toFixed(6)); role.updatedAt = new Date().toISOString();
    // G6: fresh evidence re-bases the decay anchor. Without this, a role that
    // just delivered would keep decaying on a stale timestamp and its measured
    // reputation would be discounted below what the newest outcome earned.
    role.lastOutcomeAt = new Date().toISOString(); role.reputationUpdatedAt = new Date().toISOString(); const budget = await this.mutableBudget(input.tenantId); budget.reservedTokens = Math.max(0, budget.reservedTokens - task.reservedTokens); budget.usedTokens = Math.min(budget.dailyTokenBudget, budget.usedTokens + actual); task.status = input.success ? "completed" : "failed"; task.actualTokens = actual; task.quality = quality; task.evidenceEventIds = [...new Set(input.evidenceEventIds)].slice(0, 200); task.updatedAt = new Date().toISOString(); await this.save(); return structuredClone(task);
  }
  async tasks(tenantId: string): Promise<SocietyTask[]> { await this.load(); return this.state.tasks.filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item)); }
  async getTask(tenantId: string, id: string): Promise<SocietyTask> { return structuredClone(await this.task(tenantId, id)); }

  /**
   * G2 task lifecycle: pause. A running task is suspended by record, not by
   * force -- this layer owns orchestration state, not process control, and it
   * says so rather than pretending to freeze a sandbox. What suspension does
   * change is accounting: a paused task leaves the concurrency ceiling (award
   * counts only assigned+running) and leaves the stalled-task monitor (a
   * deliberate stop is not a stuck task). The token reservation is held: the
   * task still intends to run, and releasing the reservation would let the
   * daily budget be double-promised.
   */
  async pauseTask(tenantId: string, taskId: string, reason?: string): Promise<SocietyTask> {
    const task = await this.task(tenantId, taskId);
    if (task.status !== "running") throw new Error("Only running society tasks can be paused.");
    task.status = "paused"; task.updatedAt = new Date(this.now()).toISOString();
    if (reason) task.pauseReason = bounded(reason, 2000, "Pause reason");
    await this.save(); return structuredClone(task);
  }

  /** G2 task lifecycle: resume a paused task back to running. Only paused tasks resume -- any other transition must go through the endpoints that own it. */
  async resumeTask(tenantId: string, taskId: string): Promise<SocietyTask> {
    const task = await this.task(tenantId, taskId);
    if (task.status !== "paused") throw new Error("Only paused society tasks can be resumed.");
    task.status = "running"; task.updatedAt = new Date(this.now()).toISOString();
    await this.save(); return structuredClone(task);
  }

  /**
   * G2 task lifecycle: cancel an open/assigned/running/paused task. Terminal
   * and idempotent. Cancelling releases the token reservation back to the
   * daily budget -- an abandoned promise must not keep spending authority --
   * and records why, so the audit trail distinguishes a withdrawer's decision
   * from a performer's failure.
   */
  async cancelTask(tenantId: string, taskId: string, reason?: string): Promise<SocietyTask> {
    const task = await this.task(tenantId, taskId);
    if (!["open", "assigned", "running", "paused"].includes(task.status)) throw new Error("Society task is already terminal and cannot be cancelled.");
    const budget = await this.mutableBudget(tenantId);
    if (task.status !== "open") budget.reservedTokens = Math.max(0, budget.reservedTokens - task.reservedTokens);
    task.status = "cancelled"; task.updatedAt = new Date(this.now()).toISOString();
    if (reason) task.cancelReason = bounded(reason, 2000, "Cancel reason");
    await this.save(); return structuredClone(task);
  }


  async createDeliberation(input: { tenantId: string; question: string; requiredRoleIds: string[]; quorum?: number }): Promise<SocietyDeliberation> {
    await this.load(); await this.seed(input.tenantId); if (this.state.deliberations.length >= MAX_DELIBERATIONS) throw new Error("Society deliberation limit reached."); const roleIds = [...new Set(input.requiredRoleIds)]; if (roleIds.length < 2 || roleIds.length > 50) throw new Error("Society deliberation requires 2-50 distinct roles."); for (const id of roleIds) { const role = await this.role(input.tenantId, id); if (role.status !== "active") throw new Error("Society deliberation role is retired."); }
    const now = new Date().toISOString(); const value: SocietyDeliberation = { id: randomUUID(), tenantId: input.tenantId, question: bounded(input.question, 10_000, "Deliberation question"), requiredRoleIds: roleIds, quorum: integer(input.quorum ?? Math.ceil(roleIds.length * 0.67), 2, roleIds.length, "Deliberation quorum"), status: "open", perspectives: [], createdAt: now, updatedAt: now }; this.state.deliberations.push(value); await this.save(); return structuredClone(value);
  }
  async submitPerspective(input: { tenantId: string; deliberationId: string; roleId: string; recommendation: SocietyPerspective["recommendation"]; confidence: number; summary: string; evidenceEventIds?: string[] }): Promise<SocietyDeliberation> {
    const value = await this.deliberation(input.tenantId, input.deliberationId); if (value.status !== "open" || !value.requiredRoleIds.includes(input.roleId)) throw new Error("Role is not authorized for this open deliberation."); if (value.perspectives.some((item) => item.roleId === input.roleId)) throw new Error("Role already submitted a perspective.");
    value.perspectives.push({ roleId: input.roleId, recommendation: input.recommendation, confidence: score(input.confidence, "Perspective confidence"), summary: bounded(input.summary, 10_000, "Perspective summary"), evidenceEventIds: [...new Set(input.evidenceEventIds ?? [])].slice(0, 200), submittedAt: new Date().toISOString() }); value.updatedAt = new Date().toISOString(); await this.save(); return structuredClone(value);
  }
  async resolveDeliberation(tenantId: string, id: string): Promise<SocietyDeliberation> {
    const value = await this.deliberation(tenantId, id); if (value.status !== "open" || value.perspectives.length < value.quorum) throw new Error("Society deliberation has not reached quorum."); const roles = new Map((await this.roles(tenantId)).map((item) => [item.id, item])); let approve = 0, reject = 0, abstain = 0; for (const p of value.perspectives) { const weight = (0.25 + 0.75 * roles.get(p.roleId)!.reputation) * p.confidence; if (p.recommendation === "approve") approve += weight; else if (p.recommendation === "reject") reject += weight; else abstain += weight; } const decisive = approve + reject, total = decisive + abstain; const margin = decisive ? Math.abs(approve - reject) / decisive : 0; const decision = !decisive || margin < 0.15 ? "uncertain" : approve > reject ? "approve" : "reject"; const winner = decision === "approve" ? "approve" : decision === "reject" ? "reject" : undefined; const dissentRoleIds = value.perspectives.filter((p) => winner && p.recommendation !== winner && p.recommendation !== "abstain").map((p) => p.roleId); const missingRoleIds = value.requiredRoleIds.filter((roleId) => !value.perspectives.some((p) => p.roleId === roleId)); value.result = { decision, confidence: Number((total ? Math.max(approve, reject) / total : 0).toFixed(6)), approveWeight: Number(approve.toFixed(6)), rejectWeight: Number(reject.toFixed(6)), abstainWeight: Number(abstain.toFixed(6)), dissentRoleIds, missingRoleIds }; value.status = "resolved"; value.updatedAt = new Date().toISOString(); await this.save(); return structuredClone(value);
  }
  async deliberations(tenantId: string): Promise<SocietyDeliberation[]> { await this.load(); return this.state.deliberations.filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item)); }

  /** Agent Communication Bus: a role publishes a bounded message to named peers or the whole society. */
  async broadcast(input: { tenantId: string; fromRoleId: string; topic: string; body: string; audienceRoleIds?: string[]; taskId?: string; deliberationId?: string; importance?: number }): Promise<SocietyMessage> {
    const from = await this.role(input.tenantId, input.fromRoleId);
    if (from.status !== "active") throw new Error("Retired roles cannot publish to the communication bus.");
    // G6: the bus is an inbound surface for every role that reads it. A body
    // that the engine's input screening would refuse for a task goal must not
    // be persistable here either -- otherwise the bus becomes the injection
    // path that bypasses the front door. Screened before anything is persisted,
    // and the refusal names the reason.
    if (this.screen) {
      const verdict = await this.screen(input.body);
      if (!verdict.allowed) throw new Error(`Society broadcast rejected by input screening: ${verdict.reason}`);
    }
    const audience = [...new Set(input.audienceRoleIds ?? [])].slice(0, 50);
    for (const roleId of audience) await this.role(input.tenantId, roleId);
    if (input.taskId) await this.task(input.tenantId, input.taskId);
    if (input.deliberationId) await this.deliberation(input.tenantId, input.deliberationId);
    const message: SocietyMessage = {
      id: randomUUID(),
      tenantId: input.tenantId,
      fromRoleId: from.id,
      fromLayer: from.layer,
      audienceRoleIds: audience,
      topic: bounded(input.topic, 200, "Society message topic"),
      body: bounded(input.body, 20_000, "Society message body"),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.deliberationId ? { deliberationId: input.deliberationId } : {}),
      importance: score(input.importance ?? 0.5, "Society message importance"),
      acknowledgedBy: [],
      createdAt: new Date(this.now()).toISOString(),
    };
    this.state.messages.push(message);
    const tenantMessages = this.state.messages.filter((item) => item.tenantId === input.tenantId);
    if (tenantMessages.length > 20_000) {
      const drop = new Set(tenantMessages.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, tenantMessages.length - 20_000).map((item) => item.id));
      this.state.messages = this.state.messages.filter((item) => !drop.has(item.id));
    }
    await this.save();
    return structuredClone(message);
  }
  /** Messages addressed to a role (or broadcast to everyone), newest first. */
  async inbox(tenantId: string, roleId: string, options?: { unacknowledgedOnly?: boolean; limit?: number }): Promise<SocietyMessage[]> {
    await this.role(tenantId, roleId);
    const limit = integer(options?.limit ?? 100, 1, 1000, "Society inbox limit");
    return this.state.messages
      .filter((item) => item.tenantId === tenantId && (item.audienceRoleIds.length === 0 || item.audienceRoleIds.includes(roleId)) && item.fromRoleId !== roleId)
      .filter((item) => !options?.unacknowledgedOnly || !item.acknowledgedBy.includes(roleId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((item) => structuredClone(item));
  }
  async acknowledgeMessage(tenantId: string, messageId: string, roleId: string): Promise<SocietyMessage> {
    await this.role(tenantId, roleId);
    const message = this.state.messages.find((item) => item.tenantId === tenantId && item.id === messageId);
    if (!message) throw new Error("Society message not found in tenant.");
    if (!message.acknowledgedBy.includes(roleId)) message.acknowledgedBy.push(roleId);
    await this.save();
    return structuredClone(message);
  }

  /**
   * Meta-agent monitoring: stalled work, unbid tasks, failing or idle roles, duplicate objectives,
   * budget saturation and concurrency starvation. It only advises; retirement stays an explicit call.
   */
  async metaMonitor(tenantId: string, options?: { stalledAfterMs?: number; idleAfterMs?: number }): Promise<SocietyMetaReport> {
    await this.load(); await this.seed(tenantId);
    const now = this.now();
    const stalledAfterMs = integer(options?.stalledAfterMs ?? 6 * 60 * 60_000, 60_000, 30 * 24 * 60 * 60_000, "Stalled task window");
    const idleAfterMs = integer(options?.idleAfterMs ?? 30 * 24 * 60 * 60_000, 60_000, 365 * 24 * 60 * 60_000, "Idle role window");
    const tasks = this.state.tasks.filter((item) => item.tenantId === tenantId);
    const roles = this.state.roles.filter((item) => item.tenantId === tenantId && item.status === "active");
    const budget = await this.mutableBudget(tenantId);
    const advisories: SocietyAdvisory[] = [];
    for (const task of tasks.filter((item) => ["assigned", "running"].includes(item.status))) {
      const overDeadline = task.deadline ? Date.parse(task.deadline) < now : false;
      if (overDeadline || now - Date.parse(task.updatedAt) > stalledAfterMs) {
        advisories.push({
          code: "stalled-task",
          severity: overDeadline ? "critical" : "warning",
          subjectId: task.id,
          detail: `Task "${task.title}" has been ${task.status} without progress${overDeadline ? " and is past its deadline" : ""}.`,
          recommendation: "Re-plan, split the objective or record a failed outcome so the reservation is released.",
        });
      }
    }
    for (const task of tasks.filter((item) => item.status === "open" && !item.bids.length && now - Date.parse(item.createdAt) > stalledAfterMs)) {
      advisories.push({
        code: "unbid-task",
        severity: "warning",
        subjectId: task.id,
        detail: `Task "${task.title}" received no bids; required tags: ${task.requiredCapabilityTags.join(", ") || "none"}.`,
        recommendation: "Relax the required capability tags or create/bind a specialist role that covers them.",
      });
    }
    const titles = new Map<string, string[]>();
    for (const task of tasks.filter((item) => ["open", "assigned", "running"].includes(item.status))) {
      const key = task.title.trim().toLowerCase();
      titles.set(key, [...(titles.get(key) ?? []), task.id]);
    }
    for (const [title, ids] of titles) {
      if (ids.length < 2) continue;
      advisories.push({ code: "duplicate-task", severity: "info", subjectId: ids[0]!, detail: `${ids.length} active tasks share the objective "${title}".`, recommendation: "Merge duplicates to avoid parallel loops burning the same budget." });
    }
    for (const role of roles) {
      const attempts = role.completedTasks + role.failedTasks;
      if (attempts >= 3 && role.failedTasks / attempts > 0.5) {
        advisories.push({ code: "failing-role", severity: "warning", subjectId: role.id, detail: `${role.name} failed ${role.failedTasks}/${attempts} tasks (reputation ${role.reputation}).`, recommendation: "Narrow its capability tags, bind a stronger profile, or retire the role." });
      }
      if (!role.builtin && attempts === 0 && now - Date.parse(role.createdAt) > idleAfterMs) {
        advisories.push({ code: "idle-role", severity: "info", subjectId: role.id, detail: `${role.name} has never been awarded a task.`, recommendation: "Retire the role or give it distinguishing capability tags." });
      }
    }
    const saturation = budget.dailyTokenBudget ? Number(((budget.usedTokens + budget.reservedTokens) / budget.dailyTokenBudget).toFixed(6)) : 0;
    if (saturation >= 0.9) advisories.push({ code: "budget-saturated", severity: "critical", detail: `Society token budget is ${(saturation * 100).toFixed(1)}% consumed.`, recommendation: "Raise the daily budget deliberately or defer non-critical tasks to tomorrow." });
    const running = tasks.filter((item) => ["assigned", "running"].includes(item.status)).length;
    if (running >= budget.maxConcurrentTasks && tasks.some((item) => item.status === "open")) {
      advisories.push({ code: "concurrency-starved", severity: "warning", detail: `Concurrency limit ${budget.maxConcurrentTasks} reached while open tasks are waiting.`, recommendation: "Complete or cancel running tasks before awarding more work." });
    }
    const completed = tasks.filter((item) => item.status === "completed");
    return {
      tenantId,
      advisories,
      utilization: {
        openTasks: tasks.filter((item) => item.status === "open").length,
        runningTasks: running,
        completedTasks: completed.length,
        failedTasks: tasks.filter((item) => item.status === "failed").length,
        averageQuality: completed.length ? Number((completed.reduce((sum, item) => sum + (item.quality ?? 0), 0) / completed.length).toFixed(6)) : 0,
      },
      budgetSaturation: saturation,
      generatedAt: new Date(now).toISOString(),
    };
  }

  /** Evidence-bound lifecycle governance: retire non-builtin roles that keep failing. */
  async retireUnderperformers(tenantId: string, options?: { minAttempts?: number; maxFailureRate?: number }): Promise<Array<{ roleId: string; reason: string }>> {
    await this.load(); await this.seed(tenantId);
    const minAttempts = integer(options?.minAttempts ?? 5, 1, 1000, "Minimum attempts");
    const maxFailureRate = score(options?.maxFailureRate ?? 0.6, "Maximum failure rate");
    const retired: Array<{ roleId: string; reason: string }> = [];
    for (const role of this.state.roles.filter((item) => item.tenantId === tenantId && item.status === "active" && !item.builtin)) {
      const attempts = role.completedTasks + role.failedTasks;
      if (attempts < minAttempts) continue;
      const failureRate = role.failedTasks / attempts;
      if (failureRate <= maxFailureRate) continue;
      if (this.state.tasks.some((item) => item.tenantId === tenantId && item.assignedRoleId === role.id && ["assigned", "running"].includes(item.status))) continue;
      role.status = "retired";
      role.updatedAt = new Date(this.now()).toISOString();
      retired.push({ roleId: role.id, reason: `Failure rate ${failureRate.toFixed(2)} over ${attempts} evidence-bound outcomes.` });
    }
    if (retired.length) await this.save();
    return retired;
  }

  private now(): number { return Date.now(); }

  /**
   * G6 reputation decay. Reputation is evidence, and evidence ages: a role
   * that has not been exercised drifts back toward the neutral 0.5 with a
   * 30-day half-life on its distance from neutral. Anchor is
   * `reputationUpdatedAt` (last decay or last fresh outcome), so decay is
   * applied per elapsed time, not per read -- reading roles repeatedly must
   * not grind reputation to zero. Applied inside `roles()`, which every
   * reputation consumer (award ranking, bridge candidate scoring, retirement)
   * already flows through, so nobody can act on a stale number.
   */
  private async decayReputations(tenantId: string): Promise<void> {
    const nowMs = this.now(); let changed = false;
    for (const role of this.state.roles) {
      if (role.tenantId !== tenantId || role.status !== "active") continue;
      const anchorMs = Date.parse(role.reputationUpdatedAt ?? role.createdAt);
      if (!Number.isFinite(anchorMs)) continue;
      const elapsedDays = (nowMs - anchorMs) / 86_400_000;
      if (elapsedDays < 1) continue;
      const factor = Math.pow(2, -elapsedDays / 30);
      const decayed = 0.5 + (role.reputation - 0.5) * factor;
      role.reputation = Number(decayed.toFixed(6));
      role.reputationUpdatedAt = new Date(nowMs).toISOString();
      role.updatedAt = new Date(nowMs).toISOString();
      changed = true;
    }
    if (changed) await this.save();
  }

  private async seed(tenantId: string): Promise<void> { if (this.state.roles.some((item) => item.tenantId === tenantId && item.builtin)) return; const now = new Date().toISOString(); for (const role of BUILTIN_ROLES) this.state.roles.push({ id: role.id, tenantId, name: role.name, layer: role.layer, purpose: role.purpose, capabilityTags: role.tags, ...(role.parent ? { parentRoleId: role.parent } : {}), builtin: true, status: "active", reputation: 0.5, completedTasks: 0, failedTasks: 0, createdAt: now, updatedAt: now, reputationUpdatedAt: now }); await this.save(); }
  private async role(tenantId: string, id: string): Promise<SocietyRole> { await this.load(); await this.seed(tenantId); const role = this.state.roles.find((item) => item.tenantId === tenantId && item.id === id); if (!role) throw new Error("Society role not found in tenant."); return role; }
  private async task(tenantId: string, id: string): Promise<SocietyTask> { await this.load(); const task = this.state.tasks.find((item) => item.tenantId === tenantId && item.id === id); if (!task) throw new Error("Society task not found in tenant."); return task; }
  private async deliberation(tenantId: string, id: string): Promise<SocietyDeliberation> { await this.load(); const item = this.state.deliberations.find((value) => value.tenantId === tenantId && value.id === id); if (!item) throw new Error("Society deliberation not found in tenant."); return item; }
  private async mutableBudget(tenantId: string): Promise<SocietyBudget> { await this.load(); let value = this.state.budgets.find((item) => item.tenantId === tenantId); if (!value) { await this.configureBudget(tenantId, 1_000_000, 8); value = this.state.budgets.find((item) => item.tenantId === tenantId)!; } this.rollBudget(value); return value; }
  private rollBudget(value: SocietyBudget): void { const current = day(this.now()); if (value.date !== current) { value.date = current; value.usedTokens = 0; value.reservedTokens = 0; } }
  private get path(): string { return join(this.rootPath, "society", "state.json"); }
  private async load(): Promise<void> { if (this.loaded) return; try { const raw = await readFile(this.path, "utf8"); if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error("Society state exceeds its safety bound."); const parsed = JSON.parse(raw) as SocietyState; if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.roles) || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.deliberations) || !Array.isArray(parsed.budgets)) throw new Error("Society state is malformed."); if (!Array.isArray(parsed.messages)) parsed.messages = []; this.state = parsed; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } this.loaded = true; }
  private async save(): Promise<void> { const encoded = `${JSON.stringify(this.state, null, 2)}\n`; if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new Error("Society state exceeds its safety bound."); await atomicWrite(this.path, encoded); }
}

function tagsOf(values: string[]): string[] { const tags = [...new Set(values.map((item) => item.trim().toLowerCase()))]; if (tags.length > 100 || tags.some((item) => !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(item))) throw new Error("Society capability tags are invalid."); return tags; }
function bounded(value: string, max: number, label: string): string { const text = value.trim(); if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error(`${label} is invalid.`); return text; }
function integer(value: number, min: number, max: number, label: string): number { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} is invalid.`); return value; }
function score(value: number, label: string): number { if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1.`); return Number(value.toFixed(6)); }
function day(now: number): string { return new Date(now).toISOString().slice(0, 10); }
export function societyStateDigest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
