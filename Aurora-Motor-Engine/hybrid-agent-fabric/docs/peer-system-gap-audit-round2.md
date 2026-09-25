# Peer-system gap audit, round two — 2026-08-20

The first audit (`peer-system-gap-audit-2026-08-20.md`) is closed: all twelve gaps were implemented in
1.50.0 – 1.55.0. This is a **fresh** comparison against what the peers shipped most recently, rather than
a re-read of the old list.

## 1. What changed on the other side since the first audit

| Peer | Recent capability | Source |
|---|---|---|
| OpenAI Codex | Opt-in **MCP 2026-07-28** support: paginated discovery, multi-round requests, non-blocking server startup (0.147.0) | Codex release notes, Aug 2026 |
| MCP spec | **Stateless-first revision**: `initialize` handshake and `Mcp-Session-Id` removed, `server/discover` added, elicitation replaced by Multi Round-Trip Requests, mandatory `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers, cacheable listings | MCP 2026-07-28 specification |
| Claude Code | **Managed settings** as an absolute enterprise floor (file, MDM plist, HKLM), `allowManagedMcpServersOnly`, `allowManagedDomainsOnly`, settings-source reporting in `/status` | Claude Code docs, enterprise guides |
| Claude Code | **`AskUserQuestion`** as a first-class tool, explicitly denied under `dontAsk` | Claude Code subagent docs |
| Claude Code | Background-task control surface: `Monitor`, `TaskStop`, `SendMessage`, `BashOutput`, `KillShell`, auto-resume of a subagent that receives a message | Claude Code tool reference |
| Claude Code | `EnterPlanMode` / `ExitPlanMode` as tools the model itself can call mid-session | Claude Code tool reference |
| Codex | Automated approvals (`--approve-for-me`), agent plugins searchable across local/personal/workspace/remote catalogs | Codex release notes |

## 2. Gaps, ranked

### P0

| # | Gap | Why it matters | Status |
|---|---|---|---|
| N1 | **MCP 2026-07-28 stateless client**: `server/discover`, routing headers, cacheable listings, Multi Round-Trip Requests, no session id | The ecosystem's servers are migrating now. A client stuck on the handshake revision loses access to new servers, and MRTR is how mid-call confirmation works without a held-open stream | **Done in 1.57.0** |
| N2 | **Managed settings floor with provenance**: a layered settings tree where an enterprise layer cannot be relaxed by any lower layer or flag, and every effective value reports which layer produced it | This is the difference between "approved for use" and "blocked by security" in procurement. Aurora has strong per-tenant governance but no immovable admin floor and no answer to "why is this setting what it is?" | **Done in 1.56.0** |
| N3 | **Structured user questions**: an agent asking the human a bounded question with options and waiting for the answer | Aurora can request *approval* for an action, but it cannot ask "which of these three?" — so an uncertain agent either guesses or stops | **Done in 1.56.0** |

### P1

| # | Gap | Why it matters | Status |
|---|---|---|---|
| N4 | Background-task control surface: list running child work, stop one, message one, and have it resume | Aurora has children, an inbox and the society bus, but no single "what is running, stop that one" surface | **Done in 1.58.0** |
| N5 | Model-callable mode transitions (`EnterPlanMode` / `ExitPlanMode` equivalents) | Aurora's modes are operator-set; the agent itself cannot propose "let me explore first" and then hand back | **Done in 1.58.0** |
| N6 | Long-running shell with retrievable output and a kill switch (`BashOutput` / `KillShell`) | Process execution is currently synchronous and bounded; a build or test run that outlives the call has nowhere to live | **Done in 1.59.0** |
| N7 | Automated approval review (`--approve-for-me`): a policy that reviews and auto-answers a class of approvals with a recorded rationale | Aurora's `auto` mode is risk-class based; a reviewed-and-recorded auto-answer is a different, auditable thing | **Done in 1.59.0** |

### P2 — considered and rejected

- Voice input, MDM plist/registry transports, cloud execution farms: distribution and product surface, not engine capability. The managed-settings *file* layer is implemented; the OS-specific transports are packaging.
- Deprecated MCP features (Roots, Sampling, Logging, HTTP+SSE, dynamic client registration): the spec gives them twelve months and advises against new adoption.

## 3. What 1.56.0 fixes

**N2 — Managed settings with provenance.** `SettingsResolver` merges six layers in a fixed order —
`defaults`, `user`, `project` (`.aurora/settings.json`), `project-local` (`.aurora/settings.local.json`),
`runtime`, `managed` — and returns every effective value **with the layer that produced it**. The managed
layer is an absolute floor: any key it sets is marked `locked` and cannot be overridden by a lower layer,
a project file or a runtime flag. Two enforcement points make it real rather than advisory: a permission
ceiling that `session.mode.set` cannot exceed, and a managed deny list applied as a policy layer.

**N3 — Structured user questions.** `user.ask` poses a bounded question with two to six options, waits
for an answer with an explicit timeout, and returns the human's choice. A timeout returns `timedOut`
rather than a guess; `dontAsk` denies the capability outright, matching the peer semantics, and plan mode
allows it because asking a question changes nothing.

## 4. What 1.57.0 fixes

**N1 — MCP 2026-07-28.** `StatelessMcpClient` speaks the revision natively (no handshake, no session id,
`server/discover`, routing headers checked against the body, cacheable listings, MRTR with a bounded
verbatim `requestState`). `StatelessMcpRegistry` registers such a server's tools as governed capabilities
and routes mid-call input requests to a human through the bounded question service.

## 5. What 1.58.0 fixes

**N4 - Background tasks.** `tasks.monitor`, `tasks.stop` (cancel versus close, ungated but
reach-bounded) and `tasks.resume` through the durable inbox.

**N5 - Model-callable plan mode.** `session.plan.enter` is ungated because it only tightens;
`session.plan.exit` is privileged and refuses to leave without a plan id or summary. Writing the test
exposed that plan mode had denied its own exit - the escape hatch is now explicitly allowed.

## 6. What 1.59.0 fixes

**N6 - Background shells.** `shell.start|output|stop|list` over the same sandbox factory `process.exec`
uses, so there is one execution path to audit. Output lives in a bounded ring buffer read by absolute
cursor, and characters lost to a slow reader are *reported* rather than papered over. Every shell has a
timeout, an output ceiling and an owning session; closing the session kills them.

**N7 - Reviewed automatic approvals.** `AutoApprovalService` answers a named class of approval with a
stored rationale, subject to argument patterns, refusal patterns, session scope, expiry and a use budget.
`*` is refused, privileged capabilities are never automatic, managed settings can disable the mechanism
outright, and both approvals and escalations are logged. Agents may propose rules; proposals arrive
disabled.

## 7. Status

**Round two is closed: N1-N7 are all implemented.** The remaining P2 items were considered and rejected
as distribution or packaging concerns rather than engine capability. A third comparison round should be
opened against whatever the peers ship next rather than re-reading this list.
