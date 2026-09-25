import type { AgentProfileRecord, AgentProfileRegistry } from "../profiles/agent-profile-registry.js";
import type { AgentSocietyService } from "../society/agent-society-service.js";
import { join } from "node:path";
import type { CapabilityDescriptor, CapabilityRisk } from "../types.js";
import { auroraRound, auroraText, DurableJsonState } from "../util/aurora-state.js";

/** Ordered from least to most authority. A template can never resolve above its declared ceiling. */
const RISK_ORDER: CapabilityRisk[] = ["pure", "workspace_read", "workspace_write", "process", "network", "external_side_effect", "privileged"];

export interface RoleAuthorityTemplate {
  id: string;
  /** Built-in templates ship with the engine and cannot be edited; custom ones belong to a tenant. */
  builtin?: boolean;
  tenantId?: string;
  title: string;
  /** Why this role needs exactly this much authority — the justification an auditor will read. */
  rationale: string;
  /** Society roles this template is the default for. */
  roleIds: string[];
  /** Capability id patterns: exact ids or a single trailing `*` wildcard. */
  allow: string[];
  /** Patterns removed after the allow list resolves, whatever else matched. */
  deny: string[];
  /** Hard ceiling: any resolved capability above this risk class is dropped, not granted. */
  maxRisk: CapabilityRisk;
}

export interface ResolvedTemplate {
  templateId: string;
  title: string;
  maxRisk: CapabilityRisk;
  roleIds: string[];
  capabilityIds: string[];
  byRisk: Record<string, number>;
  /** Matched the allow list but exceeded the ceiling: proof the ceiling is doing work. */
  droppedByRisk: string[];
  /** Explicitly excluded by a deny pattern. */
  droppedByDeny: string[];
  /** Allow patterns that matched nothing in this deployment's catalog. */
  unmatchedPatterns: string[];
  catalogSize: number;
  reductionRatio: number;
  generatedAt: string;
}

interface RoleAuthorityStateShape {
  schemaVersion: 1;
  templates: RoleAuthorityTemplate[];
}

export interface RoleAuthorityFinding {
  severity: "info" | "warning" | "critical";
  code: string;
  roleId?: string;
  profileId?: string;
  detail: string;
}

/**
 * Least-authority profiles for the agent society.
 *
 * The society can already bind an agent profile to a role, and `society.execute` refuses a profile
 * that would exceed the parent session's authority. What was missing was the *content*: without a
 * profile, every delegated child session inherits the parent's full capability set, which is exactly
 * the opposite of what a role-specialised society should do.
 *
 * This service turns each role archetype into a reviewed capability allowlist:
 *
 * - templates are declarative (patterns plus a hard risk ceiling), never hand-maintained id lists;
 * - they resolve against the *live* capability catalog, so a template can never grant an id that does
 *   not exist and never silently misses a newly registered capability in its family;
 * - the risk ceiling is applied after matching, and everything it removes is reported, so an operator
 *   can see what the ceiling actually prevented;
 * - applying a template is idempotent and versioned through the existing profile registry;
 * - the audit reports roles still running with full inherited authority and profiles that have
 *   drifted above their template.
 */
export class RoleAuthorityService {
  private readonly store: DurableJsonState<RoleAuthorityStateShape> | undefined;

  constructor(
    private readonly deps: {
      capabilities: { list(): CapabilityDescriptor[] };
      profiles: AgentProfileRegistry;
      society: AgentSocietyService;
    },
    private readonly now: () => number = Date.now,
    rootPath?: string,
  ) {
    // Custom templates are optional: without a data root the service still serves the built-ins.
    this.store = rootPath
      ? new DurableJsonState<RoleAuthorityStateShape>(
        join(rootPath, "society", "authority-templates.json"),
        () => ({ schemaVersion: 1, templates: [] }),
        (value) => {
          const state = value as RoleAuthorityStateShape;
          return !!state && state.schemaVersion === 1 && Array.isArray(state.templates);
        },
        "Aurora role authority templates",
      )
      : undefined;
  }

  /** The built-in templates only. Synchronous, because they ship with the engine. */
  templates(): RoleAuthorityTemplate[] {
    return BUILTIN_TEMPLATES.map((item) => structuredClone({ ...item, builtin: true }));
  }

  template(templateId: string): RoleAuthorityTemplate {
    const found = BUILTIN_TEMPLATES.find((item) => item.id === templateId.trim());
    if (!found) throw new Error(`Unknown role authority template "${templateId}".`);
    return structuredClone({ ...found, builtin: true });
  }

  /** Built-ins plus this tenant's own templates, built-ins first and always marked as such. */
  async allTemplates(tenantId: string): Promise<RoleAuthorityTemplate[]> {
    const custom = this.store
      ? (await this.store.read()).templates.filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item))
      : [];
    return [...this.templates(), ...custom.sort((a, b) => a.id.localeCompare(b.id))];
  }

  /**
   * Define or replace a tenant template. Built-in ids are reserved, every pattern is validated, and
   * a template that resolves to nothing is rejected rather than stored as a profile that grants zero
   * capabilities and silently breaks a role.
   */
  async defineTemplate(input: {
    tenantId: string; id: string; title: string; rationale: string; roleIds?: string[];
    allow: string[]; deny?: string[]; maxRisk: CapabilityRisk;
  }): Promise<{ template: RoleAuthorityTemplate; resolved: ResolvedTemplate }> {
    if (!this.store) throw new Error("Custom role authority templates require a persistent data root.");
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const id = auroraText(input.id, 60, "Template ID").toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,59}$/.test(id)) throw new Error("Template ID must be lowercase letters, digits and dashes.");
    if (BUILTIN_TEMPLATES.some((item) => item.id === id)) throw new Error(`Template ID "${id}" is reserved by a built-in template.`);
    if (!RISK_ORDER.includes(input.maxRisk)) throw new Error("Template risk ceiling is invalid.");
    const patterns = (values: readonly string[] | undefined, label: string): string[] => {
      const list = [...new Set((values ?? []).map((item) => item.trim()).filter(Boolean))];
      if (list.length > 100) throw new Error(`${label} is limited to 100 patterns.`);
      if (list.some((item) => !/^[a-zA-Z0-9_.:-]{1,200}\*?$/.test(item))) throw new Error(`${label} contains an invalid pattern.`);
      return list;
    };
    const allow = patterns(input.allow, "Allow list");
    if (!allow.length) throw new Error("A template needs at least one allow pattern.");

    const template: RoleAuthorityTemplate = {
      id,
      builtin: false,
      tenantId,
      title: auroraText(input.title, 200, "Template title"),
      rationale: auroraText(input.rationale, 2000, "Template rationale"),
      roleIds: [...new Set((input.roleIds ?? []).map((item) => auroraText(item, 200, "Role ID")))].slice(0, 50),
      allow,
      deny: patterns(input.deny, "Deny list"),
      maxRisk: input.maxRisk,
    };

    const resolved = this.resolveTemplate(template);
    if (!resolved.capabilityIds.length) throw new Error(`Template "${id}" resolves to no capability in this deployment; refusing to store it.`);

    await this.store.mutate((state) => {
      const index = state.templates.findIndex((item) => item.tenantId === tenantId && item.id === id);
      if (index >= 0) state.templates[index] = template;
      else state.templates.push(template);
      if (state.templates.length > 500) throw new Error("Role authority template limit reached.");
    });
    return { template, resolved };
  }

  async removeTemplate(tenantId: string, templateId: string): Promise<{ templateId: string; removed: boolean }> {
    if (!this.store) return { templateId, removed: false };
    if (BUILTIN_TEMPLATES.some((item) => item.id === templateId)) throw new Error("Built-in templates cannot be removed.");
    return await this.store.mutate((state) => {
      const index = state.templates.findIndex((item) => item.tenantId === tenantId && item.id === templateId);
      if (index < 0) return { templateId, removed: false };
      state.templates.splice(index, 1);
      return { templateId, removed: true };
    });
  }

  /** Resolve a built-in or tenant template against the live catalog without changing anything. */
  async resolveFor(tenantId: string, templateId: string): Promise<ResolvedTemplate> {
    const templates = await this.allTemplates(tenantId);
    const template = templates.find((item) => item.id === templateId.trim());
    if (!template) throw new Error(`Unknown role authority template "${templateId}".`);
    return this.resolveTemplate(template);
  }

  /** Resolve a built-in template against the live catalog without changing anything. */
  resolve(templateId: string): ResolvedTemplate {
    return this.resolveTemplate(this.template(templateId));
  }

  private resolveTemplate(template: RoleAuthorityTemplate): ResolvedTemplate {
    const catalog = this.deps.capabilities.list();
    const ceiling = RISK_ORDER.indexOf(template.maxRisk);
    const matched = new Set<string>();
    const unmatched: string[] = [];
    for (const pattern of template.allow) {
      const hits = catalog.filter((item) => matchesPattern(item.id, pattern));
      if (!hits.length) unmatched.push(pattern);
      for (const hit of hits) matched.add(hit.id);
    }
    const droppedByDeny: string[] = [];
    const droppedByRisk: string[] = [];
    const granted: CapabilityDescriptor[] = [];
    for (const id of matched) {
      const descriptor = catalog.find((item) => item.id === id)!;
      if (template.deny.some((pattern) => matchesPattern(id, pattern))) { droppedByDeny.push(id); continue; }
      if (RISK_ORDER.indexOf(descriptor.risk) > ceiling) { droppedByRisk.push(id); continue; }
      granted.push(descriptor);
    }
    const byRisk: Record<string, number> = {};
    for (const descriptor of granted) byRisk[descriptor.risk] = (byRisk[descriptor.risk] ?? 0) + 1;
    return {
      templateId: template.id,
      title: template.title,
      maxRisk: template.maxRisk,
      roleIds: template.roleIds,
      capabilityIds: granted.map((item) => item.id).sort(),
      byRisk,
      droppedByRisk: droppedByRisk.sort(),
      droppedByDeny: droppedByDeny.sort(),
      unmatchedPatterns: unmatched,
      catalogSize: catalog.length,
      reductionRatio: catalog.length ? auroraRound(1 - granted.length / catalog.length) : 0,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Create or update the profile for a template and (by default) bind it to the roles it was written
   * for. Existing hand-made profiles are never overwritten unless they were created from a template.
   */
  async apply(input: { tenantId: string; templateId: string; roleIds?: string[]; bind?: boolean; modelRoute?: string }): Promise<{
    templateId: string; profile: AgentProfileRecord; resolved: ResolvedTemplate; boundRoleIds: string[];
  }> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const templates = await this.allTemplates(tenantId);
    const template = templates.find((item) => item.id === input.templateId.trim());
    if (!template) throw new Error(`Unknown role authority template "${input.templateId}".`);
    const resolved = this.resolveTemplate(template);
    if (!resolved.capabilityIds.length) throw new Error(`Template "${template.id}" resolves to no capability in this deployment; refusing to create an empty profile.`);
    const name = `aurora-${template.id}`;
    const instructions = [
      `<AURORA_ROLE template="${template.id}">`,
      template.title,
      template.rationale,
      `Authority ceiling: ${template.maxRisk}. Work strictly inside this allowlist; if a task needs more, say so instead of improvising.`,
      "</AURORA_ROLE>",
    ].join("\n");

    const existing = (await this.deps.profiles.list(tenantId)).find((item) => item.name.toLowerCase() === name);
    const profile = existing
      ? await this.deps.profiles.update(existing.id, {
        description: template.title,
        instructions,
        allowedCapabilityIds: resolved.capabilityIds,
        ...(input.modelRoute ? { modelRoute: input.modelRoute } : {}),
      })
      : await this.deps.profiles.add({
        tenantId,
        name,
        description: template.title,
        instructions,
        allowedCapabilityIds: resolved.capabilityIds,
        ...(input.modelRoute ? { modelRoute: input.modelRoute } : {}),
      });

    const boundRoleIds: string[] = [];
    if (input.bind ?? true) {
      const roles = await this.deps.society.roles(tenantId);
      for (const roleId of input.roleIds ?? template.roleIds) {
        if (!roles.some((role) => role.id === roleId && role.status === "active")) continue;
        await this.deps.society.bindProfile(tenantId, roleId, profile.id);
        boundRoleIds.push(roleId);
      }
    }
    return { templateId: template.id, profile, resolved, boundRoleIds };
  }

  /** Apply every built-in template. Used to bring a fresh tenant to least authority in one call. */
  async applyAll(tenantId: string): Promise<Array<{ templateId: string; profileId: string; capabilities: number; boundRoleIds: string[] }>> {
    const results: Array<{ templateId: string; profileId: string; capabilities: number; boundRoleIds: string[] }> = [];
    for (const template of await this.allTemplates(tenantId)) {
      try {
        const applied = await this.apply({ tenantId, templateId: template.id });
        results.push({ templateId: template.id, profileId: applied.profile.id, capabilities: applied.resolved.capabilityIds.length, boundRoleIds: applied.boundRoleIds });
      } catch {
        // A template that resolves to nothing in a trimmed deployment is skipped, not fatal.
      }
    }
    return results;
  }

  /** Which roles are still running with inherited authority, and which profiles drifted above theirs. */
  async audit(tenantId: string): Promise<{
    tenantId: string; roles: number; boundRoles: number; unboundRoles: string[];
    findings: RoleAuthorityFinding[]; leastAuthorityRatio: number; generatedAt: string;
  }> {
    const [roles, profiles] = await Promise.all([this.deps.society.roles(tenantId), this.deps.profiles.list(tenantId)]);
    const active = roles.filter((role) => role.status === "active");
    const findings: RoleAuthorityFinding[] = [];
    const unbound: string[] = [];

    for (const role of active) {
      if (!role.agentProfileId) {
        unbound.push(role.id);
        findings.push({
          severity: role.layer === "specialist" ? "warning" : "info",
          code: "role-inherits-full-authority",
          roleId: role.id,
          detail: `Role "${role.name}" has no agent profile, so a delegated child session inherits the parent's entire capability set.`,
        });
        continue;
      }
      const profile = profiles.find((item) => item.id === role.agentProfileId);
      if (!profile) {
        findings.push({ severity: "critical", code: "role-profile-missing", roleId: role.id, detail: `Role "${role.name}" points at agent profile ${role.agentProfileId}, which no longer exists.` });
        continue;
      }
      if (!profile.allowedCapabilityIds?.length) {
        findings.push({ severity: "warning", code: "profile-without-allowlist", roleId: role.id, profileId: profile.id, detail: `Profile "${profile.name}" has no capability allowlist, so binding it grants nothing extra but restricts nothing either.` });
      }
    }

    for (const profile of profiles) {
      const templateId = profile.name.toLowerCase().startsWith("aurora-") ? profile.name.slice("aurora-".length) : undefined;
      const known = templateId ? (await this.allTemplates(tenantId)).find((item) => item.id === templateId) : undefined;
      if (!templateId || !known) continue;
      const resolved = this.resolveTemplate(known);
      const extra = (profile.allowedCapabilityIds ?? []).filter((id) => !resolved.capabilityIds.includes(id));
      if (extra.length) {
        findings.push({
          severity: "warning",
          code: "profile-drifted-above-template",
          profileId: profile.id,
          detail: `Profile "${profile.name}" grants ${extra.length} capability(ies) its template does not: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? " …" : ""}.`,
        });
      }
    }

    return {
      tenantId,
      roles: active.length,
      boundRoles: active.length - unbound.length,
      unboundRoles: unbound,
      findings,
      leastAuthorityRatio: active.length ? auroraRound((active.length - unbound.length) / active.length) : 0,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  // ═══ P3: Stats ═══

  getStats() {
    return { status: "active" };
  }

  // ═══ P3: Explainability ═══

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    return { entity: entityId, summary: "N/A", rationale: ["Service does not support entity lookup"], details: {} };
  }
}




function matchesPattern(id: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (trimmed.endsWith("*")) return id.startsWith(trimmed.slice(0, -1));
  return id === trimmed;
}

/**
 * The built-in templates. Each one is deliberately narrow: a specialist should be able to do its job
 * and nothing else, and every escalation should have to pass through a role that was designed for it.
 */
const BUILTIN_TEMPLATES: RoleAuthorityTemplate[] = [
  {
    id: "prime",
    title: "Aurora Prime — coordination without execution",
    rationale: "Prime synthesises plans, priorities and reports. It must be able to read everything Aurora knows and write coordination state, but it should never be the process that touches a shell, the network or a credential, and it may not start delegated work itself.",
    roleIds: ["aurora-prime"],
    allow: [
      "acos.status", "acos.cycles", "acos.journal", "acos.journal.note",
      "plan.*", "decision.*", "cognitive.*", "society.*", "initiative.*",
      "memory.graph.recall", "memory.search", "memory.graph.health",
      "constitution.check", "constitution.compliance", "constitution.principles", "constitution.identity", "constitution.projection",
      "world.*", "multiworld.*", "aurora.explain", "aurora.metrics", "aurora.alerts",
    ],
    deny: ["plan.activate", "plan.delegate", "society.task.execute", "society.roles.retire-underperformers"],
    maxRisk: "workspace_write",
  },
  {
    id: "researcher",
    title: "Research specialist — evidence in, no writes out",
    rationale: "Research needs the network and the knowledge stores, and nothing else. It cannot touch the filesystem, run processes or change society state, so a hostile search result cannot become a code change.",
    roleIds: ["research-agent", "research-director", "opportunity-agent", "knowledge-agent"],
    allow: [
      "web.fetch", "knowledge.search", "session.search", "artifact.list",
      "memory.search", "memory.propose", "memory.graph.recall", "memory.graph.remember", "memory.graph.neighborhood",
      "microagents.list", "microagents.recall", "microagents.register", "microagents.feedback",
      "world.entities.list", "world.entity.upsert", "world.event.record", "world.prediction.create",
    ],
    deny: ["memory.graph.supersede"],
    maxRisk: "network",
  },
  {
    id: "coder",
    title: "Coding specialist — workspace and tests, no external effects",
    rationale: "Implementation needs files, git and a process to run tests. It does not need the network, channels, credentials or the ability to change Aurora's own governance, and it may capture a checkpoint but never restore one.",
    roleIds: ["coding-agent", "debug-agent", "architecture-agent"],
    allow: [
      "filesystem.*", "git.*", "process.exec", "python.execute",
      "checkpoint.capture", "checkpoint.diff", "checkpoint.list", "checkpoint.usage",
      "artifact.list", "artifact.publish", "session.search", "session.stuck.analyze",
      "skills.list", "skills.get", "task.*", "memory.graph.recall",
    ],
    deny: ["checkpoint.restore", "repository.review.merge"],
    maxRisk: "process",
  },
  {
    id: "planner",
    title: "Planning specialist — decomposition and delegation, no hands",
    rationale: "Planning writes plans and decisions and posts work to the marketplace. It never performs the work itself, which keeps the plan an independent record of what was intended rather than a description of what already happened.",
    roleIds: ["planner-agent", "planning-director", "project-manager-agent"],
    allow: [
      "plan.*", "decision.*", "task.*",
      "society.task.post", "society.task.bid", "society.task.award", "society.tasks.list", "society.roles.list", "society.meta.monitor",
      "acos.status", "memory.graph.recall", "world.state.at", "world.simulate", "world.entities.list",
    ],
    deny: ["plan.activate", "plan.delegate", "society.task.execute"],
    maxRisk: "workspace_write",
  },
  {
    id: "memory-keeper",
    title: "Memory specialist — consolidation and recall only",
    rationale: "Memory work is high-volume and mostly reversible, but forgetting and exporting are not. Recall, storage, relation and consolidation are granted; deletion, export and user purges are not.",
    roleIds: ["memory-director", "reflection-agent"],
    allow: ["memory.*", "knowledge.search", "microagents.recall", "aurora.explain", "session.search"],
    deny: ["aurora.export", "aurora.purge.user", "user.model.forget"],
    maxRisk: "workspace_write",
  },
  {
    id: "guardian",
    title: "Guardian and security review — read everything, change nothing",
    rationale: "Review roles are only trustworthy if they cannot quietly fix what they are reviewing. They get broad read access across Aurora's state and no write authority at all: every capability in this template is side-effect free.",
    roleIds: ["guardian-agent", "risk-agent", "security-director", "user-director"],
    allow: [
      "risk.assess", "risk.posture", "risk.rules",
      "constitution.check", "constitution.compliance", "constitution.principles", "constitution.identity",
      "aurora.metrics", "aurora.alerts", "aurora.selfcheck", "aurora.footprint", "aurora.explain",
      "plan.list", "plan.progress", "plan.stalled", "plan.delegations", "plan.delegation-report",
      "environment.actions.list", "environment.actions.unverified", "environment.inventory",
      "society.roles.list", "society.meta.monitor", "session.search", "session.stuck.analyze",
      "checkpoint.list", "checkpoint.usage", "autopilot.status", "user.alignment.check", "user.goals.stalled",
    ],
    deny: [],
    maxRisk: "pure",
  },
  {
    id: "communicator",
    title: "Communication specialist — outward messages, no inward authority",
    rationale: "Notification and reporting roles need channels and digests. They must not be able to read the filesystem or run anything, so an injected instruction inside a message cannot reach into the system.",
    roleIds: ["communication-agent"],
    allow: [
      "channel.send", "initiative.digest", "initiative.list", "initiative.delivered", "initiative.feedback",
      "memory.graph.recall", "aurora.metrics", "user.timeline", "user.goals.list",
    ],
    deny: [],
    maxRisk: "external_side_effect",
  },
  {
    id: "world-modeler",
    title: "World model specialist — predict and simulate, resolve honestly",
    rationale: "World modelling writes entities, states, causal claims and predictions, and runs bounded simulations. It has no reach into the workspace, the network or the society, so a wrong model can only be wrong, never destructive.",
    roleIds: ["world-model-director", "simulation-agent"],
    allow: ["world.*", "multiworld.*", "memory.graph.recall", "memory.search", "aurora.explain"],
    deny: [],
    maxRisk: "workspace_write",
  },
  {
    id: "evolver",
    title: "Skill evolution — propose and evaluate, never self-promote",
    rationale: "Evolution roles may design, evaluate and regression-test skill candidates. Promotion, retirement and rollback stay with the staged evidence gates operated outside the role.",
    roleIds: ["skill-director", "creativity-agent", "skill-builder-agent"],
    allow: ["evolution.*", "experience.distill", "experience.proposals", "harness.entries", "harness.project", "harness.refine", "harness.refinements", "harness.refinement.outcome", "skills.*", "memory.graph.recall"],
    deny: ["evolution.retire", "evolution.retirement.sweep", "evolution.stage.advance", "harness.rollback", "experience.apply"],
    maxRisk: "workspace_write",
  },
];
