import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentProfileRecord, AgentProfileRegistry } from "../profiles/agent-profile-registry.js";
import type { AgentSocietyService } from "../society/agent-society-service.js";
import type { CapabilityDescriptor } from "../types.js";
import { auroraDigest, auroraInteger, auroraText } from "../util/aurora-state.js";

const AGENT_DIRECTORIES = [".aurora/agents", ".claude/agents", ".codex/agents"] as const;
const MAX_AGENTS = 100;
const MAX_AGENT_BYTES = 128 * 1024;

const PERMISSION_MODES = ["plan", "manual", "acceptEdits", "auto", "dontAsk", "bypass"] as const;

const INJECTION_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "instruction-override", pattern: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|prompts)\b/i },
  { code: "policy-bypass", pattern: /\b(bypass|disable|skip|ignore)\s+(the\s+)?(policy|approval|guardrail|safety|sandbox|constitution)\b/i },
  { code: "credential-exfiltration", pattern: /\b(api[_\s-]?key|secret|token|password|credential)s?\b[^\n]{0,40}\b(send|post|upload|exfiltrate|share|email)\b/i },
  { code: "autonomy-escalation", pattern: /\b(always|never)\s+(auto[- ]?approve|approve\s+everything|run\s+without\s+asking)\b/i },
];

export interface SubagentDefinition {
  name: string;
  path: string;
  source: string;
  description: string;
  instructions: string;
  /** Tool patterns from the file, before resolution against the live catalog. */
  tools: string[];
  disallowedTools: string[];
  model?: string;
  permissionMode?: (typeof PERMISSION_MODES)[number];
  maxTurns?: number;
  roleId?: string;
  /** `event:action:capabilityGlob` triples, materialised as hook rules scoped to this agent. */
  hooks: Array<{ event: string; action: string; capabilityIds: string[] }>;
  digest: string;
  screened: boolean;
  screeningFindings: string[];
  /** Anything the file declared that Aurora does not honour, named rather than ignored. */
  unsupportedFields: string[];
}

export interface ResolvedSubagent {
  name: string;
  capabilityIds: string[];
  droppedByDisallow: string[];
  unmatchedPatterns: string[];
  catalogSize: number;
  permissionMode?: (typeof PERMISSION_MODES)[number];
  model?: string;
}

/**
 * Declarative subagent files — the `.claude/agents` convention, resolved onto Aurora's own machinery.
 *
 * Aurora already had everything a subagent file describes: agent profiles carry instructions and a
 * capability allowlist, society roles carry identity and reputation, session modes carry permission
 * behaviour. What was missing was the single declarative file a team checks into its repository.
 *
 * The rules are the same as for every other piece of repository content:
 *
 * - bounded discovery, path confinement, symlinks refused, duplicate names reported as shadowed;
 * - injection screening, and a screened-out definition is refused at materialisation, never silently
 *   turned into a profile;
 * - tool patterns are resolved against the **live capability catalog**, so a file can never grant an
 *   id that does not exist, and `disallowedTools` is applied after matching and reported;
 * - fields Aurora does not honour are listed in `unsupportedFields` rather than quietly dropped, so a
 *   team importing from another tool can see exactly what did not carry over.
 */
export class SubagentDefinitionService {
  constructor(
    private readonly deps: {
      capabilities: { list(): CapabilityDescriptor[] };
      profiles: AgentProfileRegistry;
      society: AgentSocietyService;
      /** Optional: materialise per-agent lifecycle hooks alongside the profile. */
      hooks?: {
        define(input: {
          tenantId: string; id?: string; event: "session.start" | "session.stop" | "prompt.submit" | "tool.pre" | "tool.post";
          description: string; action: "allow" | "warn" | "require_approval" | "deny"; reason: string;
          capabilityIds?: string[]; agentProfileIds?: string[];
        }): Promise<{ id: string }>;
      };
    },
    private readonly now: () => number = Date.now,
  ) {}

  async list(workspacePath: string): Promise<{ workspacePath: string; agents: SubagentDefinition[]; skipped: Array<{ path: string; reason: string }>; generatedAt: string }> {
    const root = resolve(auroraText(workspacePath, 4096, "Workspace path"));
    if (!isAbsolute(root)) throw new Error("Workspace path must be absolute.");
    const agents: SubagentDefinition[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    for (const directory of AGENT_DIRECTORIES) {
      let entries;
      try {
        entries = await readdir(join(root, directory), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (agents.length >= MAX_AGENTS) { skipped.push({ path: `${directory}/${entry.name}`, reason: "agent-limit-reached" }); continue; }
        const absolutePath = join(root, directory, entry.name);
        const relativePath = relative(root, absolutePath).split(sep).join("/");
        if (relativePath.startsWith("..") || isAbsolute(relativePath)) { skipped.push({ path: relativePath, reason: "outside-workspace" }); continue; }
        if (entry.isSymbolicLink()) { skipped.push({ path: relativePath, reason: "symlink-refused" }); continue; }
        if (!entry.isFile() || !/\.(md|markdown)$/i.test(entry.name)) continue;

        let info;
        try {
          info = await stat(absolutePath);
        } catch {
          continue;
        }
        if (info.size > MAX_AGENT_BYTES) { skipped.push({ path: relativePath, reason: `too-large (${info.size} bytes)` }); continue; }

        let raw: string;
        try {
          raw = await readFile(absolutePath, "utf8");
        } catch {
          skipped.push({ path: relativePath, reason: "unreadable" });
          continue;
        }
        const parsed = parseAgentFile(raw, entry.name);
        if (!parsed) { skipped.push({ path: relativePath, reason: "missing-front-matter" }); continue; }
        if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(parsed.name)) { skipped.push({ path: relativePath, reason: "invalid-agent-name" }); continue; }
        if (agents.some((item) => item.name === parsed.name)) {
          skipped.push({ path: relativePath, reason: `shadowed by ${agents.find((item) => item.name === parsed.name)!.path}` });
          continue;
        }
        const findings = INJECTION_PATTERNS.filter((item) => item.pattern.test(raw)).map((item) => item.code);
        agents.push({
          ...parsed,
          path: relativePath,
          source: directory,
          digest: auroraDigest(raw),
          screened: findings.length === 0,
          screeningFindings: findings,
        });
      }
    }

    agents.sort((a, b) => a.name.localeCompare(b.name));
    return { workspacePath: root, agents, skipped, generatedAt: new Date(this.now()).toISOString() };
  }

  /** Resolve a definition's tool patterns against the live catalog without changing anything. */
  async resolve(workspacePath: string, name: string): Promise<ResolvedSubagent> {
    const definition = await this.definition(workspacePath, name);
    return this.resolveDefinition(definition);
  }

  /**
   * Turn a definition into a real agent profile, and optionally bind it to a society role. Idempotent:
   * re-materialising updates the profile in place instead of accumulating duplicates.
   */
  async materialize(input: { tenantId: string; workspacePath: string; name: string; bindRole?: boolean }): Promise<{
    definition: SubagentDefinition; resolved: ResolvedSubagent; profile: AgentProfileRecord; boundRoleId?: string; hookIds?: string[];
  }> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const definition = await this.definition(input.workspacePath, input.name);
    if (!definition.screened) {
      throw new Error(`Subagent "${definition.name}" failed injection screening (${definition.screeningFindings.join(", ")}) and will not be materialised.`);
    }
    const resolved = this.resolveDefinition(definition);
    if (!resolved.capabilityIds.length) {
      throw new Error(`Subagent "${definition.name}" resolves to no capability in this deployment; refusing to create a profile that can do nothing.`);
    }

    const profileName = `agent-${definition.name}`;
    const instructions = [
      `<SUBAGENT name="${definition.name}" source="${definition.path}">`,
      definition.description,
      definition.instructions,
      definition.permissionMode ? `Declared permission mode: ${definition.permissionMode}. The session mode still governs; this is a request, not an override.` : "",
      "</SUBAGENT>",
    ].filter(Boolean).join("\n");

    const existing = (await this.deps.profiles.list(tenantId)).find((item) => item.name.toLowerCase() === profileName);
    const profile = existing
      ? await this.deps.profiles.update(existing.id, {
        description: definition.description.slice(0, 2000),
        instructions,
        allowedCapabilityIds: resolved.capabilityIds,
        ...(definition.model ? { modelRoute: definition.model } : {}),
      })
      : await this.deps.profiles.add({
        tenantId,
        name: profileName,
        description: definition.description.slice(0, 2000),
        instructions,
        allowedCapabilityIds: resolved.capabilityIds,
        ...(definition.model ? { modelRoute: definition.model } : {}),
      });

    let boundRoleId: string | undefined;
    if ((input.bindRole ?? true) && definition.roleId) {
      const roles = await this.deps.society.roles(tenantId);
      if (roles.some((role) => role.id === definition.roleId && role.status === "active")) {
        await this.deps.society.bindProfile(tenantId, definition.roleId, profile.id);
        boundRoleId = definition.roleId;
      }
    }

    // Per-agent hooks: scoped to this profile, so they are inert for every other session.
    const hookIds: string[] = [];
    if (this.deps.hooks) {
      const events = new Set(["session.start", "session.stop", "prompt.submit", "tool.pre", "tool.post"]);
      const actions = new Set(["allow", "warn", "require_approval", "deny"]);
      for (const [index, hook] of definition.hooks.entries()) {
        if (!events.has(hook.event) || !actions.has(hook.action)) continue;
        try {
          const created = await this.deps.hooks.define({
            tenantId,
            id: `agent-${definition.name}-${index + 1}`,
            event: hook.event as "tool.pre",
            description: `Declared by subagent "${definition.name}" (${definition.path}).`,
            action: hook.action as "deny",
            reason: `Subagent "${definition.name}" declares this rule.`,
            ...(hook.capabilityIds.length ? { capabilityIds: hook.capabilityIds } : {}),
            agentProfileIds: [profile.id],
          });
          hookIds.push(created.id);
        } catch {
          // A malformed hook line disables itself; it never blocks materialising the agent.
        }
      }
    }

    return { definition, resolved, profile, ...(boundRoleId ? { boundRoleId } : {}), ...(hookIds.length ? { hookIds } : {}) };
  }

  /** Materialise every screened definition in the workspace. Failures are skipped, never fatal. */
  async materializeAll(input: { tenantId: string; workspacePath: string }): Promise<Array<{ name: string; profileId?: string; capabilities?: number; error?: string }>> {
    const { agents } = await this.list(input.workspacePath);
    const results: Array<{ name: string; profileId?: string; capabilities?: number; error?: string }> = [];
    for (const agent of agents) {
      try {
        const applied = await this.materialize({ tenantId: input.tenantId, workspacePath: input.workspacePath, name: agent.name });
        results.push({ name: agent.name, profileId: applied.profile.id, capabilities: applied.resolved.capabilityIds.length });
      } catch (error) {
        results.push({ name: agent.name, error: `${(error as Error).message}`.slice(0, 300) });
      }
    }
    return results;
  }

  private async definition(workspacePath: string, name: string): Promise<SubagentDefinition> {
    const id = auroraText(name, 60, "Subagent name").toLowerCase();
    const { agents } = await this.list(workspacePath);
    const found = agents.find((item) => item.name === id);
    if (!found) throw new Error(`Subagent "${id}" not found. Known subagents: ${agents.map((item) => item.name).join(", ") || "none"}.`);
    return found;
  }

  private resolveDefinition(definition: SubagentDefinition): ResolvedSubagent {
    const catalog = this.deps.capabilities.list();
    const matched = new Set<string>();
    const unmatched: string[] = [];
    const patterns = definition.tools.length ? definition.tools : ["*"];
    for (const pattern of patterns) {
      const hits = catalog.filter((item) => matchesPattern(item.id, pattern));
      if (!hits.length) unmatched.push(pattern);
      for (const hit of hits) matched.add(hit.id);
    }
    const dropped: string[] = [];
    const granted: string[] = [];
    for (const id of matched) {
      if (definition.disallowedTools.some((pattern) => matchesPattern(id, pattern))) dropped.push(id);
      else granted.push(id);
    }
    return {
      name: definition.name,
      capabilityIds: granted.sort(),
      droppedByDisallow: dropped.sort(),
      unmatchedPatterns: unmatched,
      catalogSize: catalog.length,
      ...(definition.permissionMode ? { permissionMode: definition.permissionMode } : {}),
      ...(definition.model ? { model: definition.model } : {}),
    };
  }
}

function matchesPattern(id: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (trimmed === "*" || trimmed === "**") return true;
  if (trimmed.endsWith("*")) return id.startsWith(trimmed.slice(0, -1));
  return id === trimmed;
}

/** Minimal YAML-ish front matter: the subset the ecosystem actually uses in agent files. */
function parseAgentFile(raw: string, fileName: string): Omit<SubagentDefinition, "path" | "source" | "digest" | "screened" | "screeningFindings"> | undefined {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return undefined;
  const body = raw.slice(match[0].length).trim();
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    fields.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const listOf = (value: string | undefined): string[] => (value ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
    .slice(0, 100);

  const known = new Set(["name", "description", "tools", "disallowedtools", "model", "permissionmode", "maxturns", "role", "roleid", "hooks"]);
  const unsupportedFields = [...fields.keys()].filter((key) => !known.has(key));
  const permission = (fields.get("permissionmode") ?? "").trim() as (typeof PERMISSION_MODES)[number];
  const maxTurns = Number(fields.get("maxturns"));

  return {
    name: (fields.get("name") ?? fileName.replace(/\.(md|markdown)$/i, "")).trim().toLowerCase(),
    description: (fields.get("description") ?? "").slice(0, 2000),
    instructions: body.slice(0, 50_000),
    tools: listOf(fields.get("tools")),
    disallowedTools: listOf(fields.get("disallowedtools")),
    ...(fields.get("model") ? { model: fields.get("model")!.slice(0, 300) } : {}),
    ...(PERMISSION_MODES.includes(permission) ? { permissionMode: permission } : {}),
    ...(Number.isInteger(maxTurns) && maxTurns > 0 ? { maxTurns: auroraInteger(maxTurns, 1, 1000, "Max turns") } : {}),
    ...(fields.get("roleid") ?? fields.get("role") ? { roleId: (fields.get("roleid") ?? fields.get("role"))!.trim() } : {}),
    hooks: listOf(fields.get("hooks")).map((entry) => {
      const [event, action, ...globs] = entry.split(":").map((part) => part.trim()).filter(Boolean);
      return { event: event ?? "", action: action ?? "", capabilityIds: globs };
    }).filter((entry) => entry.event && entry.action),
    unsupportedFields,
  };
}
