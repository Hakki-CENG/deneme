import { join } from "node:path";
import type { PolicyDecision } from "../types.js";
import type { PolicyEngine, PolicyInput } from "./policy-engine.js";
import { auroraInteger, auroraText, DurableJsonState } from "../util/aurora-state.js";

const MAX_SESSIONS = 50_000;
const MAX_TRANSITIONS = 20_000;

/**
 * Permission modes, named after what an operator actually wants, and matching the vocabulary the rest
 * of the industry settled on so a team switching to Aurora does not have to relearn it.
 */
export type PermissionMode =
  /** Read-only exploration plus planning writes. Nothing touches the world. */
  | "plan"
  /** Ask before anything that needs approval. The safe default. */
  | "manual"
  /** Workspace edits proceed without prompting; everything else still asks. */
  | "acceptEdits"
  /** Edits and process execution proceed; network and external effects still ask. */
  | "auto"
  /** Never prompt: anything that would need approval is denied instead. Good for unattended runs. */
  | "dontAsk"
  /** Skip approval prompts entirely. Opt-in per deployment, and governance still applies. */
  | "bypass";

/** Sandbox modes borrowed from the Codex vocabulary, mapped onto the existing risk classes. */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface SessionModeState {
  sessionId: string;
  tenantId: string;
  permissionMode: PermissionMode;
  sandboxMode: SandboxMode;
  /** Free-text note explaining why this session runs in this mode. */
  note?: string;
  updatedAt: string;
  updatedBy: string;
}

export interface SessionModeTransition {
  id: string;
  /** Monotonic per-tenant order. Two transitions can share a millisecond; they cannot share this. */
  sequence: number;
  tenantId: string;
  sessionId: string;
  from: { permissionMode: PermissionMode; sandboxMode: SandboxMode };
  to: { permissionMode: PermissionMode; sandboxMode: SandboxMode };
  reason: string;
  actor: string;
  at: string;
}

export interface TenantModeDefaults {
  tenantId: string;
  permissionMode: PermissionMode;
  sandboxMode: SandboxMode;
  /** `bypass` is refused unless a deployment explicitly allows it. */
  allowBypass: boolean;
  updatedAt: string;
}

interface ModeStateShape {
  schemaVersion: 1;
  sessions: SessionModeState[];
  defaults: TenantModeDefaults[];
  transitions: SessionModeTransition[];
}

/** Capability families a plan-mode session may still write to: planning *about* work, never the work. */
const PLAN_MODE_WRITE_ALLOWLIST = [
  "plan.", "decision.", "acos.journal", "cognitive.object.create", "cognitive.intake",
  "memory.propose", "memory.graph.remember", "multiworld.", "world.prediction.create",
  "experience.distill", "task.",
  // The way out of plan mode must itself be reachable from inside plan mode, or the mode is a trap.
  "session.plan.exit", "session.mode.set", "user.ask",
  // Stopping a background shell and reading its output take nothing away from plan mode's promise:
  // one is a read, the other only ever ends activity. Starting one stays denied.
  "shell.stop",
];

const PERMISSION_MODES: PermissionMode[] = ["plan", "manual", "acceptEdits", "auto", "dontAsk", "bypass"];
/** How much authority each mode grants, for ceiling comparisons. `dontAsk` grants less, not more. */
const PERMISSION_STRENGTH: Record<PermissionMode, number> = { plan: 0, dontAsk: 1, manual: 2, acceptEdits: 3, auto: 4, bypass: 5 };
const SANDBOX_MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

/**
 * Session permission and sandbox modes.
 *
 * Aurora already had every enforcement mechanism a peer has — layered policy, approvals, sandbox
 * backends, governance — but no single named dial. Operators had to compose four separate flags to
 * express "this session may explore but not touch anything", which is exactly the sentence Claude Code
 * and Codex made one word.
 *
 * The service stores the dial; `SessionModePolicyEngine` applies it. Two rules keep it honest:
 *
 * - a mode may **tighten** anything: plan mode denies side effects, `dontAsk` converts every approval
 *   into a refusal, a read-only sandbox refuses writes;
 * - a mode may **relax only the base policy**. It can turn a base "require approval" into "allow" for
 *   the risk classes it names, but it can never weaken a decision that came from Aurora governance,
 *   OPA, a lifecycle hook or an explicit capability denial. Governance is not a preference.
 *
 * Every change of mode is a recorded transition with an actor and a reason, because "who put this
 * session in bypass?" must be answerable.
 */
export class SessionModeService {
  private readonly store: DurableJsonState<ModeStateShape>;
  /** Optional administrator floor: the highest permission mode a session may select. */
  private ceiling: ((tenantId: string) => Promise<PermissionMode | undefined>) | undefined;

  constructor(
    rootPath: string,
    private readonly now: () => number = Date.now,
    private readonly options: { allowBypass?: boolean; defaultPermissionMode?: PermissionMode; defaultSandboxMode?: SandboxMode } = {},
  ) {
    this.store = new DurableJsonState<ModeStateShape>(
      join(rootPath, "policy", "session-modes.json"),
      () => ({ schemaVersion: 1, sessions: [], defaults: [], transitions: [] }),
      (value) => {
        const state = value as ModeStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.sessions) && Array.isArray(state.defaults) && Array.isArray(state.transitions);
      },
      "Aurora session modes",
    );
  }

  /** Bind the managed-settings ceiling. Called by the engine; absent in unit tests. */
  bindCeiling(resolver: (tenantId: string) => Promise<PermissionMode | undefined>): void {
    this.ceiling = resolver;
  }

  modes(): { permissionModes: Array<{ mode: PermissionMode; description: string }>; sandboxModes: Array<{ mode: SandboxMode; description: string }> } {
    return {
      permissionModes: [
        { mode: "plan", description: "Read-only exploration. Planning and decision records may still be written; nothing else may touch the world." },
        { mode: "manual", description: "Ask before anything that needs approval. The safe default." },
        { mode: "acceptEdits", description: "Workspace edits proceed without prompting; process, network and external effects still ask." },
        { mode: "auto", description: "Workspace edits and process execution proceed; network and external effects still ask." },
        { mode: "dontAsk", description: "Never prompt: anything that would require approval is denied instead. Intended for unattended runs." },
        { mode: "bypass", description: "Skip approval prompts. Must be enabled per tenant, and Aurora governance still applies." },
      ],
      sandboxModes: [
        { mode: "read-only", description: "No workspace mutation, no process execution, no network." },
        { mode: "workspace-write", description: "Workspace mutation and process execution inside the sandbox; network still governed." },
        { mode: "danger-full-access", description: "No sandbox-mode restriction beyond the ordinary policy stack." },
      ],
    };
  }

  async defaults(tenantId: string): Promise<TenantModeDefaults> {
    return await this.store.mutate((state) => structuredClone(this.mutableDefaults(state, tenantId)));
  }

  async setDefaults(input: { tenantId: string; permissionMode?: PermissionMode; sandboxMode?: SandboxMode; allowBypass?: boolean }): Promise<TenantModeDefaults> {
    return await this.store.mutate((state) => {
      const defaults = this.mutableDefaults(state, input.tenantId);
      if (input.allowBypass !== undefined) defaults.allowBypass = input.allowBypass;
      if (input.permissionMode !== undefined) {
        this.assertMode(input.permissionMode, defaults);
        defaults.permissionMode = input.permissionMode;
      }
      if (input.sandboxMode !== undefined) defaults.sandboxMode = this.assertSandbox(input.sandboxMode);
      defaults.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(defaults);
    });
  }

  /** The effective mode for a session, falling back to the tenant default. Never throws. */
  async get(tenantId: string, sessionId: string): Promise<SessionModeState> {
    const state = await this.store.read();
    const found = state.sessions.find((item) => item.tenantId === tenantId && item.sessionId === sessionId);
    if (found) return structuredClone(found);
    const defaults = state.defaults.find((item) => item.tenantId === tenantId);
    return {
      sessionId,
      tenantId,
      permissionMode: defaults?.permissionMode ?? this.options.defaultPermissionMode ?? "manual",
      sandboxMode: defaults?.sandboxMode ?? this.options.defaultSandboxMode ?? "workspace-write",
      updatedAt: new Date(this.now()).toISOString(),
      updatedBy: "default",
    };
  }

  /** Change a session's dial. Recorded as a transition with an actor and a reason. */
  async set(input: {
    tenantId: string; sessionId: string; permissionMode?: PermissionMode; sandboxMode?: SandboxMode;
    reason: string; actor: string; note?: string;
  }): Promise<SessionModeState> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const sessionId = auroraText(input.sessionId, 200, "Session ID");
    const reason = auroraText(input.reason, 1000, "Mode change reason");
    const actor = auroraText(input.actor, 200, "Actor");
    const previous = await this.get(tenantId, sessionId);
    // An administrator ceiling is a floor for everyone else: a session cannot climb above it, whatever
    // the tenant default says and whoever is asking.
    const ceiling = this.ceiling ? await this.ceiling(tenantId).catch(() => undefined) : undefined;
    const requested = input.permissionMode ?? previous.permissionMode;
    if (ceiling && PERMISSION_STRENGTH[requested] > PERMISSION_STRENGTH[ceiling]) {
      throw new Error(`Permission mode "${requested}" exceeds the managed ceiling "${ceiling}".`);
    }

    return await this.store.mutate((state) => {
      const defaults = this.mutableDefaults(state, tenantId);
      const next: SessionModeState = {
        sessionId,
        tenantId,
        permissionMode: input.permissionMode ?? previous.permissionMode,
        sandboxMode: input.sandboxMode ? this.assertSandbox(input.sandboxMode) : previous.sandboxMode,
        ...(input.note ? { note: auroraText(input.note, 1000, "Mode note") } : {}),
        updatedAt: new Date(this.now()).toISOString(),
        updatedBy: actor,
      };
      this.assertMode(next.permissionMode, defaults);

      const index = state.sessions.findIndex((item) => item.tenantId === tenantId && item.sessionId === sessionId);
      if (index >= 0) state.sessions[index] = next;
      else {
        if (state.sessions.length >= MAX_SESSIONS) state.sessions.splice(0, state.sessions.length - MAX_SESSIONS + 1);
        state.sessions.push(next);
      }
      const sequence = state.transitions.reduce((highest, item) => Math.max(highest, item.sequence ?? 0), 0) + 1;
      state.transitions.push({
        id: `mode-${sessionId}-${sequence}`,
        sequence,
        tenantId,
        sessionId,
        from: { permissionMode: previous.permissionMode, sandboxMode: previous.sandboxMode },
        to: { permissionMode: next.permissionMode, sandboxMode: next.sandboxMode },
        reason,
        actor,
        at: next.updatedAt,
      });
      if (state.transitions.length > MAX_TRANSITIONS) state.transitions.splice(0, state.transitions.length - MAX_TRANSITIONS);
      return structuredClone(next);
    });
  }

  async transitions(tenantId: string, options: { sessionId?: string; limit?: number } = {}): Promise<SessionModeTransition[]> {
    const state = await this.store.read();
    return state.transitions
      .filter((item) => item.tenantId === tenantId && (options.sessionId ? item.sessionId === options.sessionId : true))
      .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0) || b.at.localeCompare(a.at))
      .slice(0, auroraInteger(options.limit ?? 50, 1, 1000, "Transition limit"))
      .map((item) => structuredClone(item));
  }

  /**
   * Decide what this mode does to an already-computed policy decision. Pure and synchronous so it can
   * be unit-tested exhaustively and reasoned about without a running engine.
   */
  adjust(input: {
    mode: SessionModeState;
    risk: string;
    sideEffect: boolean;
    capabilityId: string;
    decision: PolicyDecision;
  }): PolicyDecision {
    const { mode, risk, sideEffect, capabilityId, decision } = input;

    // A denial is final. No mode ever un-denies anything.
    if (decision.decision === "deny") return decision;

    // Sandbox mode first: it describes what the machine may do, regardless of who is asking.
    if (mode.sandboxMode === "read-only" && (sideEffect || !["pure", "workspace_read"].includes(risk))) {
      return { decision: "deny", reasonCode: "sandbox_read_only", message: `Sandbox mode "read-only" forbids ${capabilityId}.` };
    }
    if (mode.sandboxMode === "workspace-write" && ["external_side_effect"].includes(risk) && decision.decision === "allow") {
      return { decision: "require_approval", reasonCode: "sandbox_workspace_write", message: `Sandbox mode "workspace-write" wants confirmation before an external effect (${capabilityId}).`, approvalScope: "once" };
    }

    switch (mode.permissionMode) {
      case "plan": {
        const planningWrite = PLAN_MODE_WRITE_ALLOWLIST.some((prefix) => capabilityId.startsWith(prefix));
        if (!sideEffect && ["pure", "workspace_read"].includes(risk)) return decision;
        if (planningWrite) return decision;
        return { decision: "deny", reasonCode: "plan_mode_read_only", message: `Plan mode is read-only: ${capabilityId} would change something. Leave plan mode to execute.` };
      }
      case "dontAsk":
        // A question is a prompt too: "never prompt me" has to mean it, or an unattended run hangs.
        if (capabilityId === "user.ask") {
          return { decision: "deny", reasonCode: "dont_ask_denied", message: `Mode "dontAsk" refuses to prompt the user: ${capabilityId}.` };
        }
        return decision.decision === "require_approval"
          ? { decision: "deny", reasonCode: "dont_ask_denied", message: `Mode "dontAsk" refuses anything that would prompt: ${capabilityId}.` }
          : decision;
      case "acceptEdits":
        return this.relax(decision, risk, ["workspace_write"], "accept_edits");
      case "auto":
        return this.relax(decision, risk, ["workspace_write", "process"], "auto_mode");
      case "bypass":
        return this.relax(decision, risk, ["workspace_write", "process", "network", "external_side_effect", "privileged"], "bypass_mode");
      case "manual":
      default:
        return decision;
    }
  }

  /**
   * Relaxation is deliberately narrow: only a base-policy approval requirement, only for the named risk
   * classes, and never a governance decision. The reason codes below are the governance layers.
   */
  private relax(decision: PolicyDecision, risk: string, risks: string[], reasonCode: string): PolicyDecision {
    if (decision.decision !== "require_approval") return decision;
    if (!risks.includes(risk)) return decision;
    const governed = /^(aurora_|lifecycle_hook_|opa_|capability_denied|untrusted_)/.test(decision.reasonCode);
    if (governed) return decision;
    return { decision: "allow", reasonCode, message: `Approval waived by session mode (${reasonCode}); the original reason was: ${decision.message}` };
  }

  private assertMode(mode: PermissionMode, defaults: TenantModeDefaults): void {
    if (!PERMISSION_MODES.includes(mode)) throw new Error(`Unknown permission mode "${mode}".`);
    if (mode === "bypass" && !(defaults.allowBypass || this.options.allowBypass)) {
      throw new Error("Permission mode \"bypass\" is not enabled for this tenant.");
    }
  }

  private assertSandbox(mode: SandboxMode): SandboxMode {
    if (!SANDBOX_MODES.includes(mode)) throw new Error(`Unknown sandbox mode "${mode}".`);
    return mode;
  }

  private mutableDefaults(state: ModeStateShape, tenantId: string): TenantModeDefaults {
    const id = auroraText(tenantId, 200, "Tenant ID");
    let defaults = state.defaults.find((item) => item.tenantId === id);
    if (!defaults) {
      defaults = {
        tenantId: id,
        permissionMode: this.options.defaultPermissionMode ?? "manual",
        sandboxMode: this.options.defaultSandboxMode ?? "workspace-write",
        allowBypass: this.options.allowBypass ?? false,
        updatedAt: new Date(this.now()).toISOString(),
      };
      state.defaults.push(defaults);
    }
    return defaults;
  }
}

/**
 * Wraps the whole policy stack so a session mode can both tighten and (narrowly) relax the result.
 * It must wrap rather than join the stack, because the layered engine only ever takes the strongest
 * decision — correct for governance, wrong for an operator saying "stop asking me about file edits".
 */
export class SessionModePolicyEngine implements PolicyEngine {
  constructor(private readonly inner: PolicyEngine, private readonly modes: SessionModeService) {}

  async decide(input: PolicyInput): Promise<PolicyDecision> {
    const decision = await this.inner.decide(input);
    try {
      const mode = await this.modes.get(input.context.tenantId, input.context.sessionId);
      return this.modes.adjust({
        mode,
        risk: input.descriptor.risk,
        sideEffect: input.descriptor.sideEffect,
        capabilityId: input.descriptor.id,
        decision,
      });
    } catch {
      // An unreadable mode store must never widen authority: keep the underlying decision as-is.
      return decision;
    }
  }
}
