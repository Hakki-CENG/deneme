# Peer-system gap audit — 2026-08-20

Aurora Motor Engine (Hybrid Agent Fabric, 1.49.0) compared against the coding/agent systems it competes
with: **Claude Code**, **OpenAI Codex CLI**, **OpenHands**, **Hermes Agent** and **Prime Agent**.

This audit is deliberately unflattering. A feature counts as *present* only when HAF has an integrated
implementation with test evidence; a similar-sounding service does not count. Where HAF is ahead, that
is stated too, because the point is to decide what to build next, not to score points.

## 1. Where HAF already leads

| Area | HAF | Peers |
|---|---|---|
| Durable session runtime | Actor per session, generations, sequence-fenced events, effect journal, snapshots, replay, detached workers, recovery | Prime comparable; Claude Code/Codex are process-local with resume/fork; OpenHands server-side |
| Governance | Layered policy (base + OPA + Aurora), constitutional checker, escalation-only enforcement, durable audit trail | Codex: sandbox modes + approval policy; Claude Code: permission modes + hooks; no constitutional layer |
| Cognitive substrate | Memory pyramid, world model, initiative engine, ACOS cycle, decisions/plans with calibration, evolution pipeline | Nothing comparable in any peer |
| Multi-agent economy | Society roles, bidding marketplace, budgets, reputation, probation, least-authority role templates | Claude Code subagents (no economy), Prime subagents, OpenHands microagents |
| Closed execution loop | Plan step → society task → child session → evidence-scored outcome → plan status → decision calibration → estimate calibration | No peer closes this loop |
| Unattended operation | Autopilot cadences + multi-tenant fleet supervisor with fairness and circuit breakers | Claude Code background agents; Codex cloud tasks; neither is tenant-fleet aware |
| Tenancy and ops | Tenant isolation everywhere, content-free telemetry, Prometheus, data export/purge, integrity self-check, runbook | OpenHands/Hermes partial; CLIs single-user |

## 2. Confirmed gaps, ranked

Ranked by (value to a real user) × (risk of not having it), with the peer that sets the bar.

### P0 — genuinely missing primitives

| # | Gap | Bar set by | Why it matters | Status |
|---|---|---|---|---|
| G1 | **Project instruction files** (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`) discovered from the workspace and injected with precedence | Codex (`AGENTS.md` is an open standard), Claude Code (`CLAUDE.md`) | Every repository in the world now ships one of these. Ignoring them means ignoring the user's house rules | **Done in 1.50.0** |
| G2 | **Deterministic lifecycle hooks** the operator configures (pre/post tool use, session start/stop, prompt submit) that can block, warn or run an action | Claude Code (31 events), Codex (5 events) | Formatters, secret scrubbing, build gates and "never touch prod" rules must fire *deterministically*, not when a model remembers | **Done in 1.50.0** |
| G3 | **Tool search / progressive tool disclosure** | Claude Code `ToolSearch` | HAF exposes 275+ capabilities. Pushing all of them at a model wastes context and degrades selection | **Done in 1.50.0** |
| G4 | **Permission modes** as a first-class session concept (`plan`/read-only, `acceptEdits`, `auto`, `dontAsk`, `bypass`) with matching sandbox modes (`read-only`, `workspace-write`, `danger-full-access`) | Codex sandbox modes + approval policy; Claude Code permission modes | HAF has the enforcement machinery but no single named dial. Operators currently compose four flags | **Done in 1.51.0** |
| G5 | **Plan mode** — read-only exploration that produces a plan and then asks to execute | Claude Code, Codex `/plan` | HAF has a rich planner but no "explore without touching anything, then propose" session mode | **Done in 1.51.0** |

### P1 — present but shallower than the bar

| # | Gap | Bar | HAF today | Status |
|---|---|---|---|---|
| G6 | Custom slash commands / prompt templates stored in the repo | Claude Code `.claude/commands`, Codex prompts | Skills hub exists; no repo-local command files | **Done in 1.52.0** |
| G7 | Session archive / delete lifecycle, per-session cost and rate-limit view | Codex `/archive`, `/usage`, `/status` | Usage is tracked; no archive state, no cost rollup surface | **Done in 1.52.0** |
| G8 | Code review mode (`/review`) over the working tree or against a base branch | Codex, Claude Code | Hosted review provider exists (PR-level); no local working-tree review flow | **Done in 1.53.0** |
| G9 | Subagent declaration files with per-agent tools/model/hooks/memory/isolation | Claude Code subagent frontmatter | Agent profiles + society roles cover most fields; no single declarative file format, no per-agent hooks | **Done in 1.53.0**, hooks completed in 1.55.0 |
| G10 | Plugin/skill marketplace with signed manifests and version pinning | Claude Code plugins, Codex agent plugins | Skills hub and plugin registry exist; no signing or pinning | **Done in 1.55.0** |
| G11 | Effort/verbosity control per turn (`/reasoning`, effort levels) | Codex, Claude Code | Only Codex-provider reasoning effort | **Done in 1.54.0** |
| G12 | Worktree ergonomics for the main session (`/worktree`) | Codex, Claude Code | Child sessions already use git worktrees; the main session cannot move into one | **Done in 1.54.0** |

### P2 — deliberate non-goals (recorded so they are not re-discovered)

- Voice input, IDE extensions, marketplace hosting, and cloud task farms: product surface, not engine capability.
- Unbounded self-modification, LLM-based risk classification, exactly-once external effects: rejected on principle in earlier audits, still rejected.

## 3. What 1.50.0 fixes

**G1 — Project instructions.** `ProjectInstructionService` discovers `AGENTS.md`, `CLAUDE.md`,
`AURORA.md`, `.cursorrules` and `.github/copilot-instructions.md` from the session workspace, bounded by
file count, per-file size and total size, path-confined and symlink-rejecting. Deeper files take
precedence over shallower ones, each file is screened for prompt-injection patterns, and a suspicious
file is **quarantined with its reason** rather than silently injected. The result is projected into the
Aurora context block with its own character budget and per-file digests.

**G2 — Lifecycle hooks.** `LifecycleHookService` gives operators deterministic rules on
`session.start`, `session.stop`, `prompt.submit`, `tool.pre` and `tool.post`. A `tool.pre` rule joins
the layered policy stack as an escalation-only layer: it can warn, require approval or deny, but it can
never grant authority another layer withheld. Rules match on capability id globs and a bounded argument
pattern. Unlike the peers, a hook action does not shell out: it invokes an **allowlisted governed
capability**, so hook side effects pass the same policy, approval and audit path as anything else, with
a recursion guard so a hook cannot trigger itself. Every firing is recorded.

**G3 — Tool search.** `tool.search` ranks the capability catalog by token overlap over id and
description, with risk, side-effect and source filters, returning compact entries; `tool.describe`
returns the full schema for a chosen id. This is progressive disclosure for a 275-capability catalog.

## 4. What 1.51.0 fixes

**G4 — Permission and sandbox modes.** `SessionModeService` stores one named dial per session, with a
tenant default: permission mode (`plan`, `manual`, `acceptEdits`, `auto`, `dontAsk`, `bypass`) and
sandbox mode (`read-only`, `workspace-write`, `danger-full-access`). `SessionModePolicyEngine` wraps the
layered stack so a mode can tighten anything and relax only a base-policy approval requirement, for the
risk classes it names. Denials are never reversed, governance decisions are never weakened, `bypass` is
gated per tenant, and every transition records an actor and a reason.

**G5 — Plan mode.** Read-only exploration that may still write planning artefacts: plans, decisions,
cognitive intake and memory proposals. Anything that would touch the world is refused with an
instruction to leave plan mode, which is the same explore-then-execute shape the peers ship.

## 5. What 1.52.0 fixes

**G7 — Session archive and cost.** `SessionLifecycleService` archives and restores sessions with an
audited actor and reason, enforced on the engine command path so no client can bypass it, and reports
cost with its source stated (`provider`, `price-table`, `unpriced`) plus a tenant rollup by model.

**G6 — Repository commands.** `RepositoryCommandService` reads the four command folders the ecosystem
uses, substitutes `$ARGUMENTS` and positional arguments, reports what was left unresolved, and refuses
a screened-out template loudly. It renders text and never executes.

## 6. What 1.53.0 fixes

**G8 — Working-tree review.** `WorkingTreeReviewService` produces file statistics and deterministic
findings for uncommitted work, the index, or a base-branch comparison, with a shared verdict rollup and
hard bounds on files, diff size and command output.

**G9 — Subagent files.** `SubagentDefinitionService` reads the ecosystem's agent front matter and
materialises it into an agent profile plus a society role binding, resolving tools against the live
catalog and naming everything it could not honour.

## 7. What 1.54.0 fixes

**G11 — Effort.** `SessionEffortService` publishes an explicit profile per level (tool iterations,
context scale, reasoning effort, continuation ceiling), resolved once per turn and surfaced on the
guardrail event. `ModelRequest.reasoningEffort` carries the request to providers that support it.

**G12 — Worktrees.** `WorktreeService` creates a validated, confined worktree from the session's
repository, and the REST endpoint can bind a new session to it in the same call.

## 8. What 1.55.0 fixes — the audit is closed

**G10 — Supply-chain trust.** `ManifestTrustService` registers Ed25519 publishers, verifies signatures
over `kind:artifactId:version:sha256`, pins versions and digests, reports signature and pin states
separately, and gates the skills hub before download. Enforcement is opt-in per tenant and verdicts are
recorded while still advisory.

**G9 completion — per-agent hooks.** The capability context now carries the agent profile id, hook rules
accept `agentProfileIds`, and subagent files declare their own hooks, materialised scoped to that
profile.

Every gap identified in this audit is now closed. Future work should come from a fresh comparison rather
than from this list.
