# Peer-system gap audit, round three — 2026-08-20

Rounds one (`peer-system-gap-audit-2026-08-20.md`) and two (`peer-system-gap-audit-round2.md`) are closed:
nineteen gaps implemented across 1.50.0 – 1.59.0. This is a **fresh** comparison against what the peers
shipped most recently — Claude Code 2.1.198 → 2.1.235 (Aug 2026), Codex CLI 0.145 → 0.147, the OpenHands
Software Agent SDK, and the final MCP 2026-07-28 specification — not a re-read of the previous lists.

## 1. What changed on the other side since round two

| Peer | Recent capability | Why it is interesting |
|---|---|---|
| Claude Code | **Fan-out limits**: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20), nested subagent spawning **off by default**, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` to allow deeper trees | One message could otherwise fan out into an unbounded tree of agents |
| Claude Code | **Memory cgroup limits for shell commands** (`CLAUDE_CODE_TOOL_MEMORY_LIMIT`) "so a runaway build can't stall the session" | A timeout bounds duration, not resource consumption |
| Claude Code | **Preview integrity fix**: credential masking on permission previews "can no longer hide commands, paths, or destinations from the approver" | If the preview can hide the target, the approval is meaningless |
| Claude Code | Cross-session `SendMessage` / `ListAgents` **across machines**, `@`-mention a session by name, offline/cloud labels, failed delivery reported as an error | Reach beyond one family tree, with a name directory |
| Claude Code | Auto mode evaluates `SendMessage` **through the permission classifier before dispatch** | Agent-to-agent messages are an authority path, not a side channel |
| Claude Code | Subagent **forking** (`subagent_type: "fork"`) inherits the full conversation and prompt cache | Delegation without re-explaining the context |
| Claude Code | Sessions waiting on a sandbox, MCP-input or settings prompt show as **"Needs input"**, not "Working" | Blocked and busy look identical without it |
| Claude Developer Platform | **Session budgets**: a hard cap on a managed-agent session's spend, plus gateway spend limits | "Run overnight" needs a wall, not just a receipt |
| Codex CLI | Named **permission profiles**, `/import` of settings and sessions from other agents, indexed web search restricted to approved URLs | Portability and finer permission naming |
| OpenHands SDK | LLM-based per-action `security_risk` field with a `ConfirmRisky` policy; container resource limits (CPU, memory, disk) | Risk assessment separated from enforcement |
| MCP 2026-07-28 (final) | `subscriptions/listen` replacing GET/`resources/subscribe`; **Tasks** as an official extension polled via `tasks/get` / `tasks/update`; per-request `logLevel` in `_meta`; renumbered error codes (−32020/−32021/−32022); deterministic `tools/list` ordering with `ttlMs` / `cacheScope` | Our client implements the core revision; these are the parts still open |

## 2. Gaps, ranked

### P0

| # | Gap | Why it matters | Status |
|---|---|---|---|
| R1 | **Child-agent fan-out limits** | `spawnChild` had no concurrency cap, no depth cap and no lifetime cap. One instruction could produce an exponential tree of agents, each holding a worktree | **Done in 1.60.0** |
| R2 | **Per-command resource limits** | The local backend applied a timeout and an output bound but nothing on memory, CPU or file size. A runaway build takes the host down with the agent on it | **Done in 1.60.0** |
| R3 | **Approval preview integrity** | The preview was a flat 2000-character cut with no redaction. The tail of a long command — exactly where `&& rm -rf /` lives — could be silently dropped, and secrets passed through untouched | **Done in 1.60.0** |
| R4 | **Session spend budgets** | Aurora priced sessions and rolled costs up per tenant, but nothing could *stop* at a number. "Run this overnight" had no wall | **Done in 1.60.0** |

### P1

| # | Gap | Why it matters | Status |
|---|---|---|---|
| R5 | **Cross-family agent directory and named messaging**, with messages classified by policy before dispatch | Reach is currently family-bounded. Peers now message any session by name across machines, and pass those messages through the permission classifier first | **Done in 1.61.0** |
| R6 | **MCP 2026-07-28 remainder**: `subscriptions/listen`, the Tasks extension (`tasks/get`, `tasks/update`), per-request `logLevel`, the renumbered error codes, and honouring `ttlMs` / `cacheScope` ordering hints | The core revision is implemented; these are the optional halves that servers are starting to rely on | **Done in 1.61.0** |
| R7 | **Conversation-inheriting spawn** (`fork` subagents) | Aurora can fork a session and can spawn a child, but not spawn a child that *starts from* the parent's conversation. Delegation currently re-explains context it already has | **Done in 1.61.0** |
| R8 | **Blocked versus busy in the monitor** | `tasks.monitor` reported `busy` from an in-flight turn; an agent stuck on an unanswered question read the same as one doing work | **Done in 1.60.0** |

### P2 — considered and rejected

- Remote control, phone pairing, self-hosted runner fleets, plugin marketplace UX, voice dictation: distribution and
  product surface rather than engine capability.
- `/import` of another agent's settings and sessions: a migration convenience whose value depends on a user base
  moving *from* a specific competitor. Aurora already reads the peers' instruction and command files in place.
- LLM-scored per-action risk: Aurora's risk classes are declared by the capability and enforced deterministically.
  Asking a model to grade its own action introduces the failure mode the layered policy exists to avoid.

## 3. What 1.60.0 fixes

**R1 — Fan-out limits.** `Supervisor` now enforces three bounds before any child workspace is created:
live children per session (default 20), tree depth (default 1, so a subagent does **not** spawn
subagents unless an operator raises it), and lifetime spawns per session (default 200). The refusal
names the limit that stopped it, and `agent.fanout` lets an agent read its own budget and plan inside
it rather than discovering the wall by failing.

**R2 — Resource limits.** `SandboxResourceLimits` (memory, CPU seconds, file size, processes) is applied
as a `ulimit` prefix inside the command's own shell, so everything the command starts inherits it. It
covers the local and Docker backends and defaults to 4 GB / 900 CPU-seconds / 2 GB files / 512 processes.
This is resource hygiene, not a security boundary — the local backend never was one.

**R3 — Preview integrity.** `buildApprovalPreview` keeps decision-relevant fields (command, path, url,
host, target, …) whole to 20k characters, and when even that is exceeded it keeps **both ends** with the
omission stated inline, because a head-only cut hides exactly the dangerous tail. Credentials are masked
by key name and by value shape, every mask is counted, and the request carries a `previewIntegrity`
report so an approver is told what was hidden instead of left to guess. Non-decision keys are dropped
first when the payload is over budget, and each dropped key is named.

**R4 — Session budgets.** `SessionBudgetService` holds tenant defaults and attributed per-session
overrides with a spend cap, a token cap, a warning fraction and a `block` or `warn` policy. The cap
refuses *new* turns and never truncates work in flight. An unpriced model reports `unpriced` rather than
pretending a money cap holds; the token cap, always measurable, still applies.

**R8 — Blocked versus busy.** `tasks.monitor` now reports `waitingOn: "question" | "approval" | null`.

## 4. What 1.61.0 fixes

**R5 — Directory and directed messaging.** `supervisor.directory()` lists live agents per tenant with
unique-name flagging; `agent.message.direct` crosses a family boundary and is privileged for exactly
that reason, while family messaging stays ungated. Tenant boundaries are absolute, ambiguous names are
refused, and delivery reuses the family path with its existing limits and receipts.

**R6 — MCP remainder.** Cache hints (`ttlMs`, `cacheScope`), the renumbered error codes with a per-
endpoint "stop asking" rule for UnsupportedProtocolVersion, the Tasks extension (`tasks/get` polling
with bounds, `tasks/update`), `subscriptions/listen` as a bounded abortable stream that invalidates only
the cache it names, and per-request `logLevel`.

**R7 — Conversation-inheriting spawn.** `agent.spawn { inheritConversation }` copies a bounded tail of
the parent transcript into the child. Copied, never shared.

## 5. Status

**Round three is closed: R1–R8 are all implemented.** A fourth round should be opened against whatever
the peers ship next rather than re-reading this list.
