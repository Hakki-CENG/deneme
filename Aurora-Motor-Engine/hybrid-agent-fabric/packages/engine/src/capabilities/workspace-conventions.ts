import { z } from "zod";
import type { LifecycleHookService } from "../policy/lifecycle-hooks.js";
import type { SessionModeService } from "../policy/session-modes.js";
import type { ProjectInstructionService } from "../knowledge/project-instructions.js";
import type { RepositoryCommandService } from "../knowledge/repository-commands.js";
import type { SessionLifecycleService } from "../runtime/session-lifecycle.js";
import type { SubagentDefinitionService } from "../knowledge/subagent-definitions.js";
import type { SessionEffortService } from "../policy/session-effort.js";
import type { WorktreeService } from "../repositories/worktree-service.js";
import type { UserQuestionService } from "../runtime/user-questions.js";
import { reviewVerdict, type WorkingTreeReviewService } from "../repositories/working-tree-review.js";
import { auroraDefined } from "../util/aurora-state.js";
import { defineCapability } from "./schema.js";

const lifecycleEvent = z.enum(["session.start", "session.stop", "prompt.submit", "tool.pre", "tool.post"]);
const lifecycleAction = z.enum(["allow", "warn", "require_approval", "deny"]);

/** Repository-provided house rules: discovered, screened, budgeted and auditable. */
export function projectInstructionCapabilities(service: ProjectInstructionService) {
  return [
    defineCapability(
      { id: "project.instructions", version: "1.0.0", description: "Discover AGENTS.md, CLAUDE.md, AURORA.md, .cursorrules and copilot-instructions in the workspace, with injection screening and precedence.", risk: "workspace_read", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.scan(ctx.workspacePath),
    ),
    defineCapability(
      { id: "project.instructions.project", version: "1.0.0", description: "Render the screened repository instructions into one character-budgeted block with per-file digests.", risk: "workspace_read", sideEffect: false, source: "core" },
      z.object({ characterBudget: z.number().int().min(0).max(60_000).optional() }),
      async (input, ctx) => await service.project(auroraDefined({ workspacePath: ctx.workspacePath, characterBudget: input.characterBudget })),
    ),
  ];
}

/**
 * Deterministic lifecycle hooks. Defining and toggling rules changes what the engine will refuse, so
 * those are privileged; reading the rules and the firing ledger is pure.
 */
export function lifecycleHookCapabilities(service: LifecycleHookService) {
  return [
    defineCapability(
      { id: "hooks.list", version: "1.0.0", description: "List the deterministic lifecycle hook rules for this tenant.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ event: lifecycleEvent.optional() }),
      async (input, ctx) => ({ rules: await service.rules(ctx.tenantId, input.event) }),
    ),
    defineCapability(
      { id: "hooks.define", version: "1.0.0", description: "Define or replace a lifecycle hook rule that can warn, require approval or deny at the capability boundary.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({
        id: z.string().max(100).optional(),
        event: lifecycleEvent,
        description: z.string().min(1).max(500),
        action: lifecycleAction,
        reason: z.string().min(1).max(500),
        capabilityIds: z.array(z.string().min(1).max(200)).max(50).optional(),
        argumentPattern: z.string().max(500).optional(),
        runCapability: z.object({ capabilityId: z.string().min(1).max(200), input: z.record(z.unknown()).optional() }).optional(),
        priority: z.number().int().min(1).max(1000).optional(),
        enabled: z.boolean().optional(),
      }),
      async (input, ctx) => {
        const { runCapability, ...rest } = input;
        return await service.define(auroraDefined({
          tenantId: ctx.tenantId, ...rest,
          ...(runCapability ? { runCapability: { capabilityId: runCapability.capabilityId, input: (runCapability.input ?? {}) as Record<string, unknown> } } : {}),
        }));
      },
    ),
    defineCapability(
      { id: "hooks.enabled", version: "1.0.0", description: "Enable or disable one lifecycle hook rule.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ ruleId: z.string().min(1).max(200), enabled: z.boolean() }),
      async (input, ctx) => await service.setEnabled(ctx.tenantId, input.ruleId, input.enabled),
    ),
    defineCapability(
      { id: "hooks.remove", version: "1.0.0", description: "Remove a lifecycle hook rule.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ ruleId: z.string().min(1).max(200) }),
      async (input, ctx) => await service.remove(ctx.tenantId, input.ruleId),
    ),
    defineCapability(
      { id: "hooks.firings", version: "1.0.0", description: "The durable record of which hook fired on what, and what its action did.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ firings: await service.firings(ctx.tenantId, input.limit ?? 50) }),
    ),
    defineCapability(
      { id: "hooks.config", version: "1.0.0", description: "Read or change hook enablement and the allowlist of capabilities a hook action may invoke.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ enabled: z.boolean().optional(), allowCapabilityActions: z.boolean().optional(), actionAllowlist: z.array(z.string().min(1).max(200)).max(50).optional() }),
      async (input, ctx) => Object.keys(input).length
        ? await service.configure(auroraDefined({ tenantId: ctx.tenantId, ...input }))
        : await service.config(ctx.tenantId),
    ),
  ];
}

const permissionMode = z.enum(["plan", "manual", "acceptEdits", "auto", "dontAsk", "bypass"]);
const sandboxMode = z.enum(["read-only", "workspace-write", "danger-full-access"]);

/**
 * Session permission and sandbox modes: the single named dial over the enforcement Aurora already had.
 * Reading a mode is pure; changing one changes what the session may do, so it is privileged and every
 * change records an actor and a reason.
 */
export function sessionModeCapabilities(service: SessionModeService) {
  return [
    defineCapability(
      { id: "session.modes", version: "1.0.0", description: "List the available permission and sandbox modes with what each one means.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async () => service.modes(),
    ),
    defineCapability(
      { id: "session.mode", version: "1.0.0", description: "The effective permission and sandbox mode for this session.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.get(ctx.tenantId, ctx.sessionId),
    ),
    defineCapability(
      { id: "session.mode.set", version: "1.0.0", description: "Change this session's permission or sandbox mode. Leaving plan mode is how execution starts.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({
        permissionMode: permissionMode.optional(),
        sandboxMode: sandboxMode.optional(),
        reason: z.string().min(1).max(1000),
        note: z.string().max(1000).optional(),
      }),
      async (input, ctx) => await service.set(auroraDefined({ tenantId: ctx.tenantId, sessionId: ctx.sessionId, actor: "agent", ...input })),
    ),
    defineCapability(
      { id: "session.mode.history", version: "1.0.0", description: "Who changed this session's mode, when, and why.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ transitions: await service.transitions(ctx.tenantId, auroraDefined({ sessionId: ctx.sessionId, limit: input.limit })) }),
    ),
    defineCapability(
      { id: "session.mode.defaults", version: "1.0.0", description: "Read or change the tenant's default permission and sandbox mode, and whether bypass is allowed.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ permissionMode: permissionMode.optional(), sandboxMode: sandboxMode.optional(), allowBypass: z.boolean().optional() }),
      async (input, ctx) => Object.keys(input).length
        ? await service.setDefaults(auroraDefined({ tenantId: ctx.tenantId, ...input }))
        : await service.defaults(ctx.tenantId),
    ),
  ];
}

/** Repository-local command templates: read and render, never execute. */
export function repositoryCommandCapabilities(service: RepositoryCommandService) {
  return [
    defineCapability(
      { id: "commands.list", version: "1.0.0", description: "List repository command templates from .aurora/commands, .claude/commands, .codex/prompts and .github/prompts.", risk: "workspace_read", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.list(ctx.workspacePath),
    ),
    defineCapability(
      { id: "commands.render", version: "1.0.0", description: "Render one repository command with arguments. Returns text; it never executes anything.", risk: "workspace_read", sideEffect: false, source: "core" },
      z.object({ name: z.string().min(1).max(60), arguments: z.array(z.string().max(10_000)).max(20).optional() }),
      async (input, ctx) => await service.render(auroraDefined({ workspacePath: ctx.workspacePath, name: input.name, arguments: input.arguments })),
    ),
  ];
}

/** Session archive/restore and the cost surface. Archiving changes what a session accepts. */
export function sessionLifecycleCapabilities(service: SessionLifecycleService) {
  return [
    defineCapability(
      { id: "session.cost", version: "1.0.0", description: "Token usage and cost for this session, stating whether the number came from the provider or the price table.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.cost(ctx.sessionId),
    ),
    defineCapability(
      { id: "session.usage", version: "1.0.0", description: "Tenant-wide usage rollup by model, with the sessions that could not be priced called out.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ limit: z.number().int().min(1).max(100).optional() }),
      async (input, ctx) => await service.usage(ctx.tenantId, auroraDefined(input)),
    ),
    defineCapability(
      { id: "session.archive", version: "1.0.0", description: "Archive this session: it keeps every event and artefact but refuses new work until restored.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ reason: z.string().min(1).max(1000) }),
      async (input, ctx) => await service.archive({ tenantId: ctx.tenantId, sessionId: ctx.sessionId, reason: input.reason, actor: "agent" }),
    ),
    defineCapability(
      { id: "session.restore", version: "1.0.0", description: "Restore an archived session so it accepts work again.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ sessionId: z.string().min(1).max(200), reason: z.string().min(1).max(1000) }),
      async (input, ctx) => await service.restore({ tenantId: ctx.tenantId, sessionId: input.sessionId, reason: input.reason, actor: "agent" }),
    ),
    defineCapability(
      { id: "session.archives", version: "1.0.0", description: "List archived and restored sessions with who changed them and why.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ state: z.enum(["active", "archived"]).optional(), limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ records: await service.list(ctx.tenantId, auroraDefined(input)) }),
    ),
  ];
}

/** Deterministic working-tree review: evidence first, model reasoning afterwards. */
export function reviewCapabilities(service: WorkingTreeReviewService) {
  return [
    defineCapability(
      { id: "review.worktree", version: "1.0.0", description: "Review uncommitted changes, the index, or this branch against a base: file stats plus deterministic findings (secrets, sensitive paths, lockfile drift, missing tests, large deletions).", risk: "workspace_read", sideEffect: false, source: "core" },
      z.object({
        base: z.string().max(200).optional(),
        staged: z.boolean().optional(),
        maxFiles: z.number().int().min(1).max(5000).optional(),
        maxDiffChars: z.number().int().min(1000).max(2_000_000).optional(),
      }),
      async (input, ctx) => {
        const review = await service.review(auroraDefined({ workspacePath: ctx.workspacePath, ...input, signal: ctx.signal }));
        return { ...review, ...reviewVerdict(review) };
      },
    ),
  ];
}

/** Declarative subagent files resolved onto agent profiles and society roles. */
export function subagentCapabilities(service: SubagentDefinitionService) {
  return [
    defineCapability(
      { id: "subagents.list", version: "1.0.0", description: "List declarative subagent files from .aurora/agents, .claude/agents and .codex/agents.", risk: "workspace_read", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.list(ctx.workspacePath),
    ),
    defineCapability(
      { id: "subagents.resolve", version: "1.0.0", description: "Resolve one subagent's tool patterns against the live catalog without creating anything.", risk: "workspace_read", sideEffect: false, source: "core" },
      z.object({ name: z.string().min(1).max(60) }),
      async (input, ctx) => await service.resolve(ctx.workspacePath, input.name),
    ),
    defineCapability(
      { id: "subagents.materialize", version: "1.0.0", description: "Create or update the agent profile for a subagent definition and bind it to its society role.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ name: z.string().min(1).max(60), bindRole: z.boolean().optional() }),
      async (input, ctx) => await service.materialize(auroraDefined({ tenantId: ctx.tenantId, workspacePath: ctx.workspacePath, ...input })),
    ),
    defineCapability(
      { id: "subagents.materialize-all", version: "1.0.0", description: "Materialise every screened subagent definition in this workspace.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({}),
      async (_input, ctx) => ({ applied: await service.materializeAll({ tenantId: ctx.tenantId, workspacePath: ctx.workspacePath }) }),
    ),
  ];
}

/** Per-session effort: one dial for reasoning effort and what the harness is willing to spend. */
export function effortCapabilities(service: SessionEffortService) {
  return [
    defineCapability(
      { id: "session.effort", version: "1.0.0", description: "The effort level for this session and the exact numbers it implies: tool iterations, context scale, reasoning effort.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.get(ctx.tenantId, ctx.sessionId),
    ),
    defineCapability(
      { id: "session.effort.levels", version: "1.0.0", description: "List effort levels with the runtime budgets each one selects.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async () => ({ levels: service.levels() }),
    ),
    defineCapability(
      { id: "session.effort.set", version: "1.0.0", description: "Change this session's effort level. Takes effect on the next turn, never mid-turn.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ level: z.enum(["low", "medium", "high", "xhigh", "max"]), note: z.string().max(500).optional() }),
      async (input, ctx) => await service.set(auroraDefined({ tenantId: ctx.tenantId, sessionId: ctx.sessionId, actor: "agent", ...input })),
    ),
  ];
}

/** Deliberate git worktrees for the main session, confined to the engine workspace root. */
export function worktreeCapabilities(service: WorktreeService) {
  return [
    defineCapability(
      { id: "worktree.list", version: "1.0.0", description: "List the git worktrees attached to this session's repository.", risk: "workspace_read", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => ({ worktrees: await service.list(ctx.workspacePath, ctx.signal) }),
    ),
    defineCapability(
      { id: "worktree.create", version: "1.0.0", description: "Create a new branch in an isolated git worktree inside the engine workspace root, ready for a new session.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ branch: z.string().min(1).max(200), base: z.string().max(200).optional() }),
      async (input, ctx) => await service.create(auroraDefined({ workspacePath: ctx.workspacePath, branch: input.branch, base: input.base, signal: ctx.signal })),
    ),
    defineCapability(
      { id: "worktree.remove", version: "1.0.0", description: "Remove a worktree inside the engine workspace root. A session can never remove the tree it runs in.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ path: z.string().min(1).max(4096), force: z.boolean().optional() }),
      async (input, ctx) => await service.remove(auroraDefined({ workspacePath: ctx.workspacePath, path: input.path, force: input.force, signal: ctx.signal })),
    ),
  ];
}

/** Structured questions to the human: bounded, attributed, and never answered by default. */
export function userQuestionCapabilities(service: UserQuestionService) {
  return [
    defineCapability(
      { id: "user.ask", version: "1.0.0", description: "Ask the human a bounded multiple-choice question and wait for the answer. A timeout returns timedOut, never a guessed answer.", risk: "pure", sideEffect: false, source: "core" },
      z.object({
        question: z.string().min(1).max(2000),
        context: z.string().max(10_000).optional(),
        options: z.array(z.object({ label: z.string().min(1).max(200), description: z.string().max(1000).optional() })).min(2).max(6),
        allowFreeText: z.boolean().optional(),
        timeoutMs: z.number().int().min(5000).max(1_800_000).optional(),
      }),
      async (input, ctx) => {
        const asked = await service.ask(auroraDefined({ tenantId: ctx.tenantId, sessionId: ctx.sessionId, ...input }));
        const chosen = asked.answer?.optionId ? asked.options.find((item) => item.id === asked.answer?.optionId) : undefined;
        return {
          questionId: asked.id,
          status: asked.status,
          timedOut: asked.status === "timed-out",
          ...(chosen ? { chosen: { id: chosen.id, label: chosen.label } } : {}),
          ...(asked.answer?.text ? { text: asked.answer.text } : {}),
          answeredBy: asked.answer?.answeredBy ?? null,
        };
      },
    ),
    defineCapability(
      { id: "user.questions", version: "1.0.0", description: "List questions asked in this session and their answers.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ pendingOnly: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() }),
      async (input, ctx) => ({ questions: service.list(auroraDefined({ tenantId: ctx.tenantId, sessionId: ctx.sessionId, ...input })) }),
    ),
  ];
}

/** Layered settings: what is effective, which layer produced it, and what an administrator locked. */
export function settingsCapabilities(service: { effective(input: { tenantId: string; workspacePath?: string }): Promise<unknown> }) {
  return [
    defineCapability(
      { id: "settings.effective", version: "1.0.0", description: "The effective settings for this session with per-key provenance, plus the keys an administrator locked.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.effective({ tenantId: ctx.tenantId, workspacePath: ctx.workspacePath }),
    ),
  ];
}
