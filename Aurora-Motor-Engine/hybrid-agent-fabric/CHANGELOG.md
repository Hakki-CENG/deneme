# Changelog

## Unreleased

### Fixed — memory recall ignored its limit

- **`MemoryEngine.recall()` returned far more memories than requested.** The
  memory graph honoured `query.limit`; long-horizon memory was called without
  one and returns up to 20 rows of its own, and the two result sets were
  concatenated raw. Measured: `recall({ limit: 3 })` returned **23** memories.
  Because `engine.execute()` calls it without a limit and the execution loop
  writes a memory after every task, the overflow grew with use and inflated
  every agent prompt. Both stores are now bounded, and the merged set is
  ranked by importance before truncation — truncating the raw concatenation
  would have dropped a more important long-horizon memory in favour of the
  graph's, purely because the graph is queried first.

### Added — the planning phase actually runs

- **`engine.execute()` now supplies the loop's `plan` dependency.**
  `UnifiedExecutionLoop` has always had the hook and `PlanningEngine` has
  always existed, but they were never connected, so every run recorded
  `unavailable: "No planner was supplied"`. Note the honest scope:
  `decomposeGoal()` produces a fixed Understand → Execute → Verify → Learn
  skeleton with goal-adapted step descriptions, not goal-specific
  decomposition.
- **`TaskReport.plan`** exposes the plan a task ran under. It previously stayed
  inside `TaskContext`, so callers could only see a step count buried in
  outcome evidence.

### CI now runs the acceptance gates

- **Eval gates in CI.** `npm run eval:gates` (validate + baseline + learning +
  recall regression lock, 5.3s) runs on every push. Previously none of the four
  eval gates ran in CI, so FAZ 11 and FAZ 30 could regress to zero while CI
  stayed green.
- **`recall-nightly` job.** The FAZ 11 acceptance criterion needs a real
  embedding model, so it runs nightly with the `EMBEDDINGS_URL` secret rather
  than being weakened to fit per-push CI. Without the secret it emits a warning
  stating the criterion was not measured, instead of a red X people learn to
  ignore.
- **`eval:recall:lock`.** New regression-lock mode pinning hash-encoder
  retrieval behaviour (Recall@8 0.338889, Precision 0.508333, nDCG 0.603330).
  It proves the fusion/ranking logic did not change; it explicitly does not
  claim the retriever is good.

### Fixed

- **`adaptive-router.why()`** never reported the path it had selected: it
  returned `routeName` as a UUID and `target` as the strategy name, and
  `alternativeRoutes` listed unrelated decision ids. It also treated a decision
  whose outcome had not been recorded yet as a failure, reporting 0.8
  confidence alongside a "last use was a failure" warning. Unmeasured and
  measured-bad are now distinguished.
- **`cognitive-telemetry.why()`** returned an empty summary for decision
  traces: it probed for `description`/`statement` fields that `DecisionTrace`
  does not have. It now explains goal, outcome, confidence movement, span and
  decision counts, cost and extracted lessons.

### Changed

- **`engine.runTask()` marked `@deprecated`** in favour of `execute()`, with
  characterisation tests pinning its behaviour. Measurement during this work
  showed the long-repeated claim that it returns `outcome: "success"` for
  zero work is **out of date** — it now returns `"skipped"`, because the
  MetaController initialiser was fixed. Comments in six files that still
  asserted the old behaviour were corrected. Its docblock also showed
  `result.outcome`, which is `undefined`; the real path is
  `result.runResult.outcome`.
- **Tautological tests replaced with measurements** in
  `p2-cognitive-telemetry`, `p2-adaptive-router`, `p2-causal-graph` and
  `live-suite-baseline`. These asserted `typeof x === "number"` or
  `toBeInstanceOf(Array)`, which any do-nothing implementation satisfies; they
  now assert real totals, which route each strategy picks, and which nodes a
  graph traversal returns. Each is verified by sabotage.

### Removed

- **`compareResults()`** from `packages/eval/src/metrics/metrics.ts` — zero
  callers repo-wide, and it expected fields (`overallScore`,
  `aggregateMetrics`) the suite JSON does not carry, so it could not have run
  against real results. The live equivalent is in `dashboard/eval-dashboard.ts`.


## 1.65.0 - 2026-09-16

Phase6: Real-World Capabilities — 15 features added to make Aurora a complete Cognitive Operating System.

### Security & Quality Fixes (24 issues resolved)

- **P0-1 XSS:** Added `escapeHtml()` to `App.tsx` and `ChatPanel.tsx` markdown renderers; all user content escaped before HTML conversion
- **P0-2 Service Worker:** Removed API/auth response caching from `sw.js`; `/v1/` and `/auth/` now network-only with503 offline fallback
- **P0-3 Tenant Bypass:** Added `validateTenant()` helper to aurora-services.ts routes
- **P0-5 Error Handler:** Removed duplicate `setErrorHandler` at main.ts:3447 that overrode the middleware handler
- **P0-6 Fake Tasks:** `neural-memory-fusion` executor now calls `findSimilar()` and `getStats()` instead of returning static strings
- **P0-7 Dependencies:** Downgraded Nodemailer from `^9.0.5` to `^7.0.5` (DoS vulnerability)
- **P1-1 Rate Limiter:** `X-Forwarded-For` now gated behind `TRUST_PROXY` environment variable
- **P1-2 Playwright:** Port aligned from3000 to5173 (Vite dev server port)
- **P1-3 Adaptive Router:** Learned rules now influence route scoring with up to30% boost
- **P1-4 Tests:** Added XSS-specific test cases (script injection, event handlers)
- **P1-5 Sandbox:** Windows support via `cmd.exe` detection on `process.platform === "win32"`
- **P1-6 FileSystem:** Cross-platform path normalization (`/` vs `\`) in blocked/allowed path matching
- **P1-11 Whitespace:** Added `.editorconfig` for consistent whitespace management
- **P1-12 CI:** Added `canvas-e2e` job with Playwright for CI pipeline
- **P1-13 CI:** Added Windows matrix to `ci.yml` (ubuntu-24.04 + windows-latest)
- **P2-2 PWA:** Enhanced manifest.json with scope, categories, lang, shortcuts

### Phase6: New Services (9 services,76 API endpoints)

- **MultimodalService** — OCR, document analysis, image/video understanding, audio transcription, CAD/3D model parsing, map/spatial analysis, time series analysis.10 endpoints under `/v1/multimodal/*`
- **ConnectorService** — Email (Gmail/Outlook), Calendar (Google/Outlook), CRM (Salesforce/HubSpot), ERP (SAP), Accounting (QuickBooks), Customer Support (Zendesk), Sales (Pipedrive), Social Media, Warehouse (Shopify), IoT (MQTT).12 endpoints under `/v1/connectors/*`
- **ComputerUseService** — Browser/desktop automation, visual grounding, safe form filling, long-running task rollback with inverse operations.9 endpoints under `/v1/computer-use/*`
- **CodePipelineService** — Full SDLC pipeline: issue → plan → branch → implement → test → security review → PR → CI → deploy with rollback.7 endpoints under `/v1/pipeline/*`
- **ResearchEngineService** — Multi-source search, source trust scoring (0-1), citation verification, contradiction analysis, report generation.7 endpoints under `/v1/research/*`
- **DigitalTwinService** — User profile, project/tool/workflow/constraint/preference context, learning history with sync.9 endpoints under `/v1/digital-twin/*`
- **DomainExpertService** — Law, Finance, Health, Tax, Compliance experts with source-showing, controlled modes, risk assessment, compliance checking.5 endpoints under `/v1/domain-experts/*`
- **FederatedService** — Local model management (GGUF/ONNX/SafeTensors), edge node management, data policies, air-gap mode, offline inference.10 endpoints under `/v1/federated/*`
- **AgentSDKService** — Third-party extensions (tool/workflow/agent/connector), sandbox execution, signature verification, review system.9 endpoints under `/v1/sdk/*`

### Integration

- All9 services imported, declared as `readonly` fields, initialized in constructor and `initialize()` method
-76 API routes added to `aurora-services.ts` with Zod validation
- All services use `DurableJsonState` for persistence
- Tenant isolation enforced on all endpoints

## 1.64.0 - 2026-08-26

Round-four audit, gap **S5: prompt-cache breakpoints**. Hermes ships a cache *planner*
(`prompt_caching.py`, `prompt_cache_boundary.py`, `prompt_cache_scope.py`) that marks stable
prefixes explicitly; Aurora priced cache reads and wrote no markers, so a long session paid full
price for a prefix it had already sent.

- **Derived cache plans.** `PromptCacheService` labels the assembled request's regions as stable or
  volatile — the system block, the conversation prefix (everything before the tail markers) and the
  message tail — and emits breakpoints Hermes-style: end of the static system prefix, end of the
  system prompt, the last tool and the last two non-system messages.
- **`prefixHit` is a digest comparison, not a guess.** Stability is checked against the previous
  plan's SHA-256 digests; a plan claims a cache hit only when both stable regions are byte-identical
  to what the previous request shipped (clock-free, same discipline as code diagnostics).
- **Correct scope, stated in code.** Aurora compacts in place, so the physical session id is the
  cache scope; `/branch`/delegate children own their own id and therefore an isolated scope, exactly
  Hermes' `prompt_cache_scope` fork isolation. No lineage walk is needed because Aurora never mints a
  new physical id for a compaction.
- **Durable evidence.** Every plan is recorded (`prompt-cache/plans.json`) with a sequence number,
  marker count, stable/volatile char counts and hit/miss verdict (500 bounded), so "why did this
  request miss cache?" is answerable from data after the fact.
- **Provider support.** `AnthropicProvider` places `cache_control` markers on the system block
  (array form with TTL), the last tool and the last N text-bearing messages; messages without text
  blocks are skipped rather than malformed. Providers with automatic caching ignore the hint
  (OpenAI-compatible, Gemini) with no behavioral change.
- **Governed and operator-controllable.** `session.cache.plan` (read evidence) and
  `session.cache.config` (privileged: enable/disable, TTL 5m or 1h — an approval like any session
  configuration). REST: `GET /v1/sessions/:id/cache/plan`, `POST /v1/sessions/:id/cache/config`;
  Canvas "Cache" row in the session inspector. Engine option `promptCache.{enabled,ttlMs,
  messageTailMarkers}` for deployment defaults.
- Added 5 tests: plan derivation with a byte-identical hit, miss on system change and bounded
  history, disable/coerce behavior, Anthropic marker placement (system/tool/tail, textless messages
  skipped), and an end-to-end actor test proving every model request records a plan and that the
  privileged config capability resolves through the approval channel.

## 1.63.0 - 2026-08-26

Round-four audit, gap **S4: language-server integration** — Aurora's first real code intelligence. Hermes
keeps a per-workspace LSP client (`agent/lsp/*`); an agent that edits code without being able to read its
own type errors is working blind. Aurora now does the same, with the invariants it insists on elsewhere.

- **A real LSP client over stdio.** `code-intelligence/client.ts` speaks the Language Server Protocol:
  `Content-Length` framing with corrupt-frame tolerance, `initialize`/`initialized` handshake,
  whole-document text sync with **version-based freshness** (never clock-based, so a slow server's
  leftovers cannot pass as a verdict on current content), `ContentModified` retries (Hermes/OpenCode
  behaviour), per-request timeouts, bounded frame sizes and a graceful shutdown → SIGTERM → SIGKILL
  sequence. Servers are spawned with the same scrubbed environment allow-list as the command sandbox.
- **Server discovery and language profiles.** TypeScript/JavaScript (typescript-language-server),
  Python (pyright), Go (gopls), Rust (rust-analyzer), each with workspace markers and extension counts;
  binaries resolve from the workspace's own `node_modules/.bin` first, then PATH. `code.catalog` reports
  what is installed and *why* something is unavailable.
- **Toolchain fallback through the sandbox.** When no server binary exists (`tsc --noEmit`, `ruff` or a
  read-only Python AST syntax check, `go vet`, `cargo check --message-format=json`), diagnostics still
  run with the same confinement, resource limits and timeouts as any other command Aurora runs.
- **Structured, sanitized, bounded diagnostics.** Every diagnostic is normalized to
  `{path, line, column, severity, message, source, code}` with 1-based positions. Server-produced fields
  pass through Hermes-style sanitization (newline collapse, control-char neutralising, 300/80/80 char
  caps), because a hostile repository can shape an identifier so the compiler echoes prompt-shaped text
  back into the model.
- **Durable, content-addressed evidence.** Runs are stored in `code-intelligence/diagnostics.json` with
  monotonic sequence numbers and a per-file SHA-256 of the exact text the server saw. `latest()` answers
  "is this still true?" by hashing the files again — a run goes stale the moment content changes, by
  construction, and old runs are pruned (200 max, 60 files, 500 diagnostics).
- **Symbols, definition and references.** `code.symbols` (one file or whole workspace), `code.definition`
  and `code.references` use the language server when it is installed and fall back to a dependency-free
  structural scanner (tokenizer + declaration patterns for TS/JS, Python with indentation-based
  containers, Go, Rust) otherwise. Bounded: 400 files, 5000 symbols, 200 references.
- Guarded by governed capabilities: `code.catalog`, `code.diagnostics.run` (risk `process`),
  `code.diagnostics.evidence`, `code.symbols`, `code.definition`, `code.references`.
- Control API: `GET /v1/sessions/:id/code`, `GET /v1/sessions/:id/diagnostics`,
  `POST /v1/sessions/:id/code/diagnostics/run`, `POST /v1/sessions/:id/code/symbols`,
  `POST /v1/sessions/:id/code/definition`, `POST /v1/sessions/:id/code/references`;
  `HAF_CODE_INTELLIGENCE_LSP=false` forces the toolchain path.
- Canvas session inspector shows a Diagnostics row (count, backend/server, current vs stale).
- LSP is enabled by default only on the local sandbox backend, where the engine and the workspace share
  a filesystem; `codeIntelligence.serverBinaries` lets operators pin executables per server id.
- Added 11 tests (577 engine tests total): framing with hostile bodies, field sanitization, TS and Python
  symbol scanning, word-boundary occurrences, sandboxed Python syntax diagnostics with durable evidence
  and honest staleness, project-local tsc output parsing, LSP diagnostics with version checking and
  severity filtering, LSP symbols/definition/references, toolchain fallback + catalog reporting, and
  workspace-escape refusal.

## 1.62.0 - 2026-08-20

Round-four audit (`docs/peer-system-gap-audit-round4.md`), done by **reading the peers' source** rather
than their release notes: `OpenHands/software-agent-sdk`, `NousResearch/hermes-agent` and
`PrimeIntellect-ai/prime-agent` were cloned and read. That method finds different things - the notes
describe features, the tree describes primitives, and three of these are primitives every peer has had
for years and nobody writes a release note about.

- **`filesystem.glob` (S1).** Match files by pattern (`src/**/*.ts`), relative to the directory searched,
  newest first with size and mtime. Dependency and build directories are skipped, symlinks are never
  followed out of the workspace, the file count is bounded and truncation is reported.
- **`filesystem.grep` (S1).** Search contents by regular expression with an optional include filter and
  context lines, returning `path:line` with the matching text. Binary files are reported as skipped
  rather than dumped into the transcript, and an invalid pattern is an error rather than zero results.
  Aurora previously had `list`, `read` and a semantic search - the most common thing a coding agent does
  had to be done the most expensive way.
- **`filesystem.patch` (S2).** Apply a unified diff with every hunk's context verified against the file
  on disk, **all files or none**: a patch that fails on the second file does not leave the first edited.
  `dryRun` reports the same plan without writing. Stale context is refused rather than fuzzily matched,
  because guessing is how an agent silently corrupts work, and paths stay workspace-confined.
- **Project verification with durable evidence (S3).** `VerificationService` detects the project's own
  commands - Node with the package manager its lockfile implies, Python with uv/poetry, Go, Rust, Maven,
  Gradle, Make - runs build then test through the same sandbox as any other command, and stores the
  command, exit code, duration and a bounded output tail.
- Verification stops at the first failing phase (a test run against a build that did not compile answers
  a question nobody asked), and **`verified` requires that a build or test phase actually ran**: a
  project with no checks is `inconclusive`, never verified. Silence is not evidence.
- Every recipe carries the files that produced it, so a wrong guess is a visible wrong guess.
- Added `verify.recipe`, `verify.run` and `verify.evidence`, REST for both reading and running
  verification, and a "Verified" row in the Canvas session inspector.
- Added 9 tests (566 engine tests total) covering glob scoping and dependency-directory exclusion, grep
  filters, context lines and binary skipping, patch apply and dry run, all-or-nothing refusal on stale
  context, workspace escape refusal, recipe detection including package-manager choice, evidence
  recording, the inconclusive verdict for a bare project, first-failure stopping, and the capability
  surface end to end.

## 1.61.0 - 2026-08-20

Round three closed: the three remaining P1 gaps - cross-family messaging, conversation-inheriting spawn,
and the rest of MCP 2026-07-28.

- **Agent directory and directed messaging (R5).** `supervisor.directory()` lists every live agent in a
  tenant with the facts a sender needs before choosing one: status, whether it is resident, how deep it
  sits, and **whether its name is unique**. A directory is not a grant: `agent.message.direct` reaches a
  same-tenant agent outside family reach and is **privileged**, because putting text into an agent
  nobody in this tree supervises is a different act from messaging a child. Family messaging stays
  ungated - there, the tree itself is the authorisation.
- The refusals are the design: a tenant boundary is never crossed, a name matching two live agents is
  refused rather than guessed at, and an agent cannot message itself. Delivery reuses the family path
  entirely - same rate limit, same pending-inbox cap, same receipts and uncertain-delivery handling -
  because a second delivery path is a second thing to get wrong. Receipts report real kinship when it
  exists and `external` when it does not, so a receipt never invents a family tie.
- **Conversation-inheriting spawn (R7).** `agent.spawn` accepts `inheritConversation`, so a child can
  start from what the parent already knows instead of being re-briefed. The transcript is **copied, not
  shared**: a child cannot rewrite its parent's history, and the inherited count is recorded on the
  spawn prompt.
- **MCP 2026-07-28 remainder (R6).** `ttlMs` and `cacheScope` from list results now drive the cache, and
  `cacheScope: "none"` disables it outright. The renumbered error codes are named and acted on:
  HeaderMismatch (-32020), MissingRequiredClientCapability (-32021) and UnsupportedProtocolVersion
  (-32022), with an unsupported revision remembered per endpoint so the client stops asking a server
  that has already said no.
- The **Tasks extension** is implemented: a tool call that returns a task handle is polled through
  `tasks/get` to a terminal state with a bounded poll count and a server-suggested interval that cannot
  drop below a floor, `tasks/update` sends client-to-server input, and a failed task surfaces as an
  error rather than a silent non-result.
- **`subscriptions/listen`** is implemented as an opt-in, abortable, byte- and lifetime-bounded stream. A
  `toolsListChanged` notification invalidates exactly the cache it names and nothing else.
- Per-request `logLevel` rides in `_meta` (the revision removed `logging/setLevel`), the client advertises
  the tasks extension in its capabilities, and `serverInfo` echoed in result `_meta` is captured.
- Added REST for the agent directory and directed messages, plus an `agent-directory` headless view.
- Added 13 tests (557 engine tests total) covering directory scoping and duplicate-name flagging,
  external delivery and its refusals, the privilege boundary between family and directed messaging,
  inheritance on and off, copy-not-share, cache-scope honouring, the renumbered errors and the
  no-retry rule, task polling to completion, task input with a log level, notification-driven cache
  invalidation, captured server identity, and the header/body self-check.

## 1.60.0 - 2026-08-20

Round-three peer audit (`docs/peer-system-gap-audit-round3.md`) against Claude Code 2.1.235, Codex CLI
0.147, the OpenHands Agent SDK and the final MCP 2026-07-28 spec. Four P0 gaps found and closed.

- **Child-agent fan-out limits (R1).** `spawnChild` had no ceiling of any kind: one instruction could
  fan out into an exponential tree, each node holding a git worktree. Three bounds now apply before any
  workspace is created - live children per session (20), tree depth (**1 by default, so a subagent does
  not spawn subagents**), and lifetime spawns per session (200). The refusal names the limit that
  stopped it, and `agent.fanout` lets an agent read its own budget instead of discovering it by failing.
- **Per-command resource limits (R2).** A timeout bounds how *long* a command runs and says nothing
  about how much of the machine it takes. `SandboxResourceLimits` adds memory, CPU-second, file-size and
  process caps as a `ulimit` prefix inside the command's own shell, inherited by everything it starts,
  on the local and Docker backends. Defaults: 4 GB, 900 CPU-seconds, 2 GB files, 512 processes.
- **Approval preview integrity (R3).** The old preview was a flat 2000-character cut with no redaction:
  the tail of a long command - exactly where `&& rm -rf /` would sit - could vanish, and credentials
  passed straight through. `buildApprovalPreview` keeps decision-relevant fields (command, path, url,
  host, target) whole, keeps **both ends** when even those must be shortened with the omission stated
  inline, masks credentials by key name and value shape, counts every mask, drops only non-decision keys
  when over budget and names each one. The request carries a `previewIntegrity` report: an approver may
  be shown less content, never less intent.
- **Session spend budgets (R4).** Aurora could price a session and roll costs up per tenant, but nothing
  could stop at a number. `SessionBudgetService` adds tenant defaults and attributed per-session
  overrides with a spend cap, a token cap, a warning fraction and a block-or-warn policy. The cap refuses
  *new* turns and never truncates a turn in flight, because killing a half-applied edit to save cents is
  the worse outcome. An unpriced model reports `unpriced` rather than pretending a money cap holds - the
  token cap, always measurable, still applies.
- **Blocked versus busy (R8).** `tasks.monitor` now reports `waitingOn: "question" | "approval" | null`,
  so an agent sitting on an unanswered question no longer reads as working.
- Fixed as a side effect: `session.budget` and `agent.fanout` are pure reads, and neither can raise its
  own limit - a cap an agent can lift is not a cap.
- Added REST for fan-out status, session budgets and tenant budget defaults; Canvas shows budget state
  and fan-out occupancy in the session inspector; a `session-budgets` view in the headless client.
- Added 14 tests (544 engine tests total) covering nested-spawn refusal, the concurrency cap, the agent's
  own view of both budgets, `ulimit` rendering and a real file-size limit taking effect, preview tail
  preservation, credential masking that leaves the destination readable, budget warn-then-block, the
  unpriced refusal, tenant-default fallback with session override, and a live prompt blocked by a cap.

## 1.59.0 - 2026-08-20

Round-two audit, N6 and N7 - the last two items on the list: long-running shells and reviewed automatic
approvals. Round two is now closed.

- **Background shells (N6).** `shell.start` launches a command that outlives the call and returns an id
  immediately; `shell.output` reads from a cursor and can wait for new output rather than being polled;
  `shell.stop` kills it; `shell.list` shows what a session left running. Starting one carries the same
  `process` risk class as `process.exec` because it is the same authority - only the moment the result
  arrives differs.
- It reuses the sandbox factory rather than opening a second way to spawn processes, so workspace
  confinement, environment scrubbing and the chosen backend cannot drift between the synchronous and the
  background path. Added an incremental `onOutput` sink to `SandboxExecRequest` to make that possible.
- **Loss is reported, not hidden.** Output lives in a 200k-character ring buffer; when a reader falls
  behind, the evicted characters are counted and returned as `skippedChars`, because a transcript
  silently stitched across a gap is worse than an honest one with a hole in it.
- Bounded lifetime throughout: a per-shell timeout, a total-output ceiling that kills the process, at
  most four running shells per session, and shells killed when their session closes. Nothing outlives
  its owner.
- Fixed a latent bug the kill switch exposed: a command aborted in the gap between "spawn" and "running"
  never saw the abort, because an already-aborted signal fires no listener. `runProcess` now checks.
- **Reviewed automatic approvals (N7).** `AutoApprovalService` answers a *named class* of approval with a
  *stored rationale*, which is the difference between it and the `auto` mode dial: months later, "why was
  this allowed?" is answerable without reconstructing anyone's intent.
- A rule must name what it covers (`*` is refused), must carry a rationale, and may add argument patterns,
  refusal patterns that force an escalation even on a match, a session scope, an expiry and a use budget.
  Privileged capabilities are never answered automatically, and managed settings can switch the whole
  mechanism off with a lower layer unable to switch it back on.
- Escalations are written to the same log as approvals, so the record shows what the mechanism refused.
  An agent may `approvals.auto.propose` a rule; the proposal arrives disabled, because proposing a policy
  you live under is not the same as writing yourself one.
- Added REST for both surfaces, a Canvas inspector panel for background shells with a kill button, and
  two headless-client views.
- Added 13 tests (530 engine tests total) covering incremental cursor reads, kill-while-starting, cross-
  session refusal, the per-session cap, honest loss reporting, session-close cleanup, rule matching and
  budgets, refusal floors, argument and refusal patterns, expiry, agent proposals staying disabled, the
  managed off switch, and a live approval answered before it reached a human.

## 1.58.0 - 2026-08-20

Round-two audit, N4 and N5: background-task control and model-callable plan mode.

- **`tasks.monitor` (N4)** answers the question a supervising agent actually has: what is running under
  me, how far along is it, and what is it waiting on? One view over machinery that already existed -
  status, whether a turn is genuinely in flight, generation and sequence, token usage, open tasks, the
  session's permission mode and effort level, and how many questions it has outstanding.
- **`tasks.stop`** distinguishes what conflated verbs usually hide: `cancel` ends the current turn and
  leaves the agent alive, `close` ends the agent. The reason is recorded on the target either way.
  Deliberately **ungated**: stopping only ever reduces activity, and requiring an approval prompt to
  halt a runaway agent would be exactly backwards. It is still bounded by family reach - the roster is
  the authority, not a caller-supplied id - and a session cannot stop itself.
- **`tasks.resume`** delivers a follow-up through the durable inbox, so a stopped or idle agent picks up
  where it left off with the same reach rules and receipts as any other agent message.
- **Model-callable plan mode (N5).** `session.plan.enter` needs no approval, because entering plan mode
  only removes authority. `session.plan.exit` stays privileged, because leaving it grants authority -
  and it **refuses to leave without naming what the exploration produced**, a plan id or a summary, so
  "I explored" cannot quietly become "I am now allowed to write". Exiting lands in `manual` by default.
- Fixed a real trap found by writing the test: plan mode denied `session.plan.exit` and
  `session.mode.set` along with every other write, which made plan mode a room with no door. The escape
  hatch, and `user.ask`, are now explicitly reachable from inside plan mode.
- A managed permission ceiling still applies on the way out: an agent leaving plan mode cannot select a
  mode above what an administrator allows.
- Added REST for monitoring and stopping within a session's family reach.
- Added 7 tests (517 engine tests total) covering the monitor view, cancel versus close with the close
  evidenced on the child's own event stream, refusal to stop itself or an unreachable agent, resume
  receipts, plan entry, refusal to exit without evidence, refusal to exit a mode it is not in, and the
  managed ceiling holding against an agent's own exit request.

## 1.57.0 — 2026-08-20

Round-two audit, N1: **the MCP 2026-07-28 stateless revision**, the largest change to the protocol since
it launched and the one the ecosystem's servers are migrating to now.

- Added `StatelessMcpClient`, a client for the revision rather than an adapter over the old one. There is
  no `initialize` handshake and no `Mcp-Session-Id`: every request self-describes through `_meta`, and
  capabilities come from the new optional `server/discover`.
- **Routing headers are sent and self-checked.** `MCP-Protocol-Version`, `Mcp-Method` and — for named
  calls — `Mcp-Name` accompany every request, and the client refuses to construct a request whose header
  would disagree with its body, because that mismatch is exactly what gateway-confusion attacks rely on.
  A session id is stripped even if a caller configures one; the revision removed sessions outright.
- **Multi Round-Trip Requests** replace elicitation: a server answering `input_required` returns a
  `requestState`, and the client re-issues the original call — same request id — with `inputResponses`
  attached. `requestState` is treated as what it is, attacker-controlled input that round-trips through
  us: length-bounded, never parsed, never interpreted, echoed back verbatim and nothing more.
- **Cacheable listings** are cached with a TTL, since the revision made list results connection-invariant,
  with an explicit refresh. **Startup never blocks**: `server/discover` is optional, so a failure marks
  the server degraded, registers whatever tools it did manage to list, and lets calls fail on their own
  terms instead of hanging a turn.
- Added `StatelessMcpRegistry`, which registers a stateless server's tools as governed capabilities
  (`mcp.<server>.<tool>`, external-effect risk, the server's own JSON schema passed through to the model).
  A mid-call input request is routed to the **human** through the same bounded question service the agent
  uses — a remote server does not get to script its own confirmation — and an unanswered question ends
  the call rather than guessing. Interactive rounds are capped so a server cannot hold a turn open.
- Added REST to connect, list, refresh and disconnect stateless servers, and a CLI view.
- Added 9 tests (510 engine tests total) covering handshake-free discovery with no session id, header
  mirroring, list caching and forced refresh, a full MRTR round trip with verbatim state echo and a
  stable request id, the bounded interactive driver, oversized-state and server-error handling,
  non-blocking discovery failure, endpoint safety refusals, capability registration with a degraded
  server, and the human-in-the-loop input path.

## 1.56.0 — 2026-08-20

A **fresh** peer comparison ([`docs/peer-system-gap-audit-round2.md`](docs/peer-system-gap-audit-round2.md))
against what Claude Code, Codex and the MCP specification shipped most recently — not a re-read of the
closed list. It found seven new gaps; this release closes the two that were self-contained, and the
first (the stateless MCP revision) is scheduled next.

- **Managed settings with provenance (N2).** `SettingsResolver` merges six layers in a published order
  — `defaults`, `user`, `project` (`.aurora/settings.json`), `project-local`, `runtime`, `managed` — and
  returns every effective value together with the layer that produced it **and every layer that had an
  opinion**. "Why is this setting what it is?" is now answered from data instead of from source code.
- The managed layer is an **absolute floor**: a key it sets is `locked` and cannot be relaxed by a lower
  layer, a project file or a runtime flag. A developer's overridden value is *recorded as overridden*
  rather than dropped silently, because someone whose setting is being ignored deserves to see that.
  Arrays concatenate across lower layers but a managed array **replaces**: an administrator's deny list
  must be neither extendable nor shrinkable from below.
- Two enforcement points make it real rather than advisory: `permissionModeCeiling` is a ceiling
  `session.mode.set` refuses to exceed (tested against a tenant that had enabled `bypass`), and
  `deniedCapabilities` becomes a policy layer that denies with the layer named in the message.
- Project settings are treated as the untrusted repository content they are: bounded size, bounded key
  count, invalid key names ignored, and a malformed file becomes a warning rather than a broken session.
- **Structured user questions (N3).** `user.ask` poses a bounded multiple-choice question and waits.
  Aurora could always ask for *approval* of a chosen action; it could not ask "which of these three?",
  so an uncertain agent had to guess or stop.
- The refusals are the point: two to six options (a single option is not a question), at most three
  outstanding per session, free text only when the question offered it, and a timeout that returns
  `timedOut` **without inventing an answer**. Answers are attributed and timestamped. `dontAsk` denies
  the capability outright, matching the peer semantics, while plan mode allows it because asking changes
  nothing. Closing a session cancels its outstanding questions instead of leaving them hanging.
- Added governed `user.ask`, `user.questions` and `settings.effective` capabilities, REST for questions
  and effective settings, a Canvas inspector panel that answers a question with one click, and two CLI
  views.
- Added 12 tests (501 engine tests total) covering layer precedence and provenance, array concatenation,
  the managed floor with recorded overrides, malformed-settings tolerance, the governed settings path,
  question answering, timeout without a guess, all four refusals, subscriber notification with session
  scoping, `dontAsk` denial versus plan-mode allowance, the managed permission ceiling and the managed
  capability denial.

## 1.55.0 — 2026-08-20

The peer-gap audit is now closed: G10 (signed manifests with version pinning) lands, and G9 is finished
with per-agent lifecycle hooks.

- **Supply-chain trust (G10).** The skills hub already checked a bundle's SHA-256 against its index
  entry, which proves the bytes match what the index said and nothing about who wrote the index.
  `ManifestTrustService` adds the missing half: Ed25519 publisher keys registered by an administrator,
  signatures over `kind:artifactId:version:sha256`, and per-artefact version pins.
- Outcomes are reported separately rather than collapsed into "failed": a signature can be `valid`,
  `invalid`, `absent` or from an `unknown-publisher`, and a pin can be `matched`, `mismatched` or
  `absent`. A **valid signature over a different version is still refused** — that combination is
  precisely what a supply-chain attack looks like, and the test proves it is caught.
- Enforcement is opt-in per tenant (`requireSignature`, `requirePin`) and defaults to off, because
  switching it on without a key registry would break every existing install. Until it is on, the verdict
  is still computed and recorded, so an operator can see exactly what *would* be refused before flipping
  the switch. Non-Ed25519 keys are refused at registration rather than at install time, and the
  publisher listing exposes a key digest, never the key.
- The skills hub consults the gate **before downloading a byte**: a refused artefact is never fetched,
  let alone extracted.
- **Per-agent lifecycle hooks (G9 complete).** `CapabilityContext` now carries the agent profile a call
  runs under, hook rules accept `agentProfileIds`, and a subagent file can declare
  `hooks: tool.pre:deny:filesystem.write`. Materialising the agent creates those rules scoped to its
  profile, so they bite for that subagent and are inert for every other session — verified by a test
  that denies the write under the profile and allows it without.
- Added REST for publishers, pins, policy, verdicts and ad-hoc evaluation, plus three CLI views.
- Added 7 tests (489 engine tests total) covering signature verification and forgery rejection, the four
  distinct signature states, pin drift refused despite a valid signature, verdict recording with no key
  leakage, non-Ed25519 and malformed-digest refusals, the enforcement wrapper, and profile-scoped hooks.

## 1.54.0 — 2026-08-20

Peer-gap audit, wave five: G11 (per-session effort) and G12 (worktrees for the main session).

- **Effort is one dial that moves two things.** Peers expose "how hard should I think about this?", and
  it has always meant both *ask the provider for more reasoning* and *let the harness spend more*.
  Aurora had the first fixed per provider and the second hard-coded at actor construction. Now
  `low | medium | high | xhigh | max` selects an explicit profile: tool iterations (4 → 32), context
  scale (0.6 → 1.5), reasoning effort and a continuation ceiling.
- Nothing about it is a hidden multiplier: `session.effort` returns the exact numbers the runtime will
  use, so "why did this turn stop after four tool calls?" is answerable without reading the source. The
  guardrail event now records the ceiling and the effort that produced it.
- Effort is resolved **once per turn**, so a change mid-turn cannot move the ceiling under a running
  loop; it applies from the next turn. `ModelRequest` carries an optional `reasoningEffort` that
  providers may honour and must never break on — the Codex provider prefers it over its constructed
  default, every other provider ignores it.
- Levels are monotonic by test: a higher level never buys fewer iterations or a smaller context.
  Tenant defaults exist, per-session overrides do not leak between sessions, and an unresolvable
  session falls back to the runtime default instead of failing a turn.
- **Deliberate worktrees (G12).** Child sessions always got an isolated worktree; what was missing was
  "give me a clean branch to try this in". `worktree.create` makes one from the session's repository —
  inside the engine's own workspace root, never at a caller-supplied path — and the REST endpoint can
  bind a fresh session to it in the same call.
- Branch and base names are validated as plain git references so neither can smuggle shell syntax,
  removal refuses anything outside the workspace root, and a session can never remove the tree it is
  running in. Every command goes through the same sandbox factory the git capabilities use.
- Added governed `session.effort`, `session.effort.levels`, `session.effort.set`, `worktree.list`,
  `worktree.create` and `worktree.remove` capabilities, REST for all of them, an effort selector in the
  Canvas session header next to the mode selectors, and a new CLI view.
- Added 7 tests (482 engine tests total) covering monotonic level profiles, tenant defaults with
  per-session isolation, the ceiling applied to a real turn, the safe fallback, worktree creation with a
  session bound to it, refusal of unsafe references, outside paths and self-removal, and removal of a
  worktree Aurora created.

## 1.53.0 — 2026-08-20

Peer-gap audit, wave four: G8 (working-tree review) and G9 (declarative subagent files) are closed.

- **Working-tree review that does not start with a model.** `review.worktree` inspects uncommitted
  changes, the index, or the branch against a base, and returns the *evidence*: per-file add/remove
  counts, change kinds including untracked files, and deterministic findings. A review that begins with
  an LLM summarising a diff is a review that can be talked out of its own findings; these checks are
  mechanical, reproducible and cannot be argued away.
- Findings cover added credentials (AWS keys, private key blocks, bearer tokens, hard-coded secret
  assignments, Slack tokens), sensitive paths (`.env`, CI workflows, infrastructure, production config),
  a lockfile changed without its manifest, two or more source files changed with no test touched, a
  large deletion against a small addition, oversized changes and untracked files. A rollup verdict
  (`clean` / `review` / `blocked`) keeps the CLI and Canvas agreeing on what "clean" means.
- Bounded and confined by construction: file count, diff characters and command output are capped,
  binary files are counted rather than dumped, the base reference is validated so it cannot smuggle
  shell syntax, and every git call runs through the same sandbox factory the other git capabilities use.
  A clean tree, missing base branch or non-repository degrades to "nothing to review" instead of failing
  the turn.
- **Declarative subagent files (G9).** Aurora reads `.aurora/agents`, `.claude/agents` and
  `.codex/agents`, parses the front matter the ecosystem actually uses (`name`, `description`, `tools`,
  `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `role`) and resolves it onto machinery that
  already existed: an agent profile for the instructions and allowlist, a society role binding for
  identity and reputation, a declared permission mode for behaviour.
- Tool patterns resolve against the **live catalog**, so a file can never grant a capability that does
  not exist; `disallowedTools` is applied after matching and what it removed is reported; fields Aurora
  does not honour are listed in `unsupportedFields` rather than quietly dropped, so a team importing
  from another tool can see exactly what did not carry over. Materialisation is idempotent, refuses a
  definition that fails injection screening, and refuses one that resolves to no capability at all.
- Added governed `review.worktree`, `subagents.list|resolve|materialize|materialize-all` capabilities
  and REST for all of them.
- Added 8 tests (475 engine tests total) covering working-tree statistics, critical secret detection,
  sensitive-path/lockfile/missing-test findings, base-branch review with clean degradation and reference
  validation, subagent parsing with unsupported fields named, tool resolution with deny applied,
  idempotent materialisation with role binding, and refusals for screened-out, empty, symlinked,
  front-matter-less and shadowed definitions.

## 1.52.0 — 2026-08-20

Peer-gap audit, wave three: G7 (session archive and the cost surface) and G6 (repository command
templates) are closed.

- **Archive, not delete.** An archived session keeps every event, snapshot and artefact and simply
  refuses new work until it is restored; the guard sits on the engine's command path, so it holds for
  REST, CLI, schedulers and agents alike. `session.close` is still allowed, because letting go of a
  session must never require reactivating it. Restoring is explicit, and both directions record an
  actor and a reason. "Tidy up my session list" and "destroy the evidence" stay different gestures.
- **Cost that says where the number came from.** A provider-reported cost is used and labelled
  `provider`; otherwise the operator's price table is applied and labelled `price-table`; a model with
  no price is reported as `unpriced` rather than silently counted as free, because a hidden zero
  produces a confidently wrong invoice. Longest-matching route wins, so `openai:gpt-5` beats a bare
  `gpt-5`, and a session that never chose a model is priced against the runtime default with the
  source stated (`session`, `runtime-default` or `unknown`).
- Added a tenant usage rollup: totals, per-model breakdown, the biggest sessions, and an explicit count
  of sessions that could not be priced.
- **Repository command templates (G6).** Aurora reads `.aurora/commands`, `.claude/commands`,
  `.codex/prompts` and `.github/prompts`, so a repository that already has team prompts works without
  migration. Front matter supplies the description; `$ARGUMENTS` and `$1`…`$9` are substituted with
  every filled and unresolved placeholder reported. Discovery is bounded and path-confined, symlinks
  are refused, duplicate names across folders are reported as shadowed instead of silently merged, and
  a template that fails injection screening is refused **loudly at render time** — a command is invoked
  deliberately, so silence would be worse than an error. Rendering returns text; it never executes.
- Added governed `session.cost`, `session.usage`, `session.archive`, `session.restore`,
  `session.archives`, `commands.list` and `commands.render` capabilities, REST for all of them
  (including a model price table), a Canvas archive/restore button with live cost in the session
  header, and three new CLI views.
- Added 10 tests (467 engine tests total) covering archive/refuse/restore round-trip, audit records and
  double-archive refusal, cross-tenant refusal, price-table costing with the unpriced case called out,
  longest-route matching and price removal, command discovery across all four folders, argument
  substitution, unknown and screened-out command refusal, symlink/size/shadowing refusals, and the
  governed capability path from a real session workspace.

## 1.51.0 — 2026-08-20

Continuing down the peer-gap audit: G4 (permission and sandbox modes) and G5 (plan mode) are closed.

- **Session permission modes.** Aurora had every enforcement mechanism a peer has but no single named
  dial, so "this session may explore but not touch anything" took four separate flags. It is now one
  word: `plan`, `manual`, `acceptEdits`, `auto`, `dontAsk` or `bypass`, using the vocabulary the rest of
  the industry settled on so a team switching does not have to relearn it.
- **Sandbox modes** follow the Codex naming — `read-only`, `workspace-write`, `danger-full-access` —
  mapped onto Aurora's existing risk classes. A read-only sandbox refuses side effects regardless of the
  permission mode, so the two dials cannot contradict each other into permissiveness.
- **Plan mode (G5)** is read-only exploration that can still write *plans*: planning, decision,
  cognitive-intake and memory-proposal capabilities remain available so a session can produce a real
  Aurora plan and then be switched out of plan mode to execute it. Everything else is refused with
  "Plan mode is read-only: leave plan mode to execute".
- The dial is applied by `SessionModePolicyEngine`, which **wraps** the layered stack rather than
  joining it, because the layered engine only ever takes the strongest decision — correct for
  governance, wrong for an operator saying "stop asking me about file edits". Two rules keep it honest:
  a mode may tighten anything, and may relax **only** a base-policy approval requirement for the risk
  classes it names. A denial is never reversed, and a decision from Aurora governance, OPA, a lifecycle
  hook or an explicit capability denial is never weakened — proven by tests that put a session in
  `bypass` and watch governance hold.
- `dontAsk` converts every approval requirement into a refusal, so an unattended run fails fast instead
  of hanging on a prompt nobody will answer. `bypass` must be enabled per tenant and is refused
  otherwise. Every mode change is a recorded transition with an actor and a reason, because "who put
  this session in bypass?" has to be answerable.
- Added governed `session.mode`, `session.mode.set`, `session.modes`, `session.mode.history` and
  `session.mode.defaults` capabilities, REST for all of them, two Canvas selectors in the session
  header, and two CLI views.
- Added 11 tests (457 engine tests total) covering plan-mode reads/planning/refusal and the switch to
  execution, `acceptEdits` scope, `dontAsk` fail-fast, read-only sandbox overriding `bypass`, the bypass
  gate, recorded transitions, tenant defaults, and an exhaustive unit sweep of the adjustment rules
  (denials never reversed, governance never relaxed, each mode confined to its own risk classes).

## 1.50.0 — 2026-08-20

Aurora was audited against the systems it competes with — Claude Code, OpenAI Codex CLI, OpenHands,
Hermes Agent and Prime Agent — and the result is recorded in
[`docs/peer-system-gap-audit-2026-08-20.md`](docs/peer-system-gap-audit-2026-08-20.md): where Aurora
leads, twelve ranked gaps where it does not, and the order they will be closed in. This release closes
the first three, which were genuinely missing primitives rather than shallower versions of something.

- **Repository instruction files (G1).** `AGENTS.md`, `CLAUDE.md`, `AURORA.md`, `.cursorrules` and
  `.github/copilot-instructions.md` are discovered from the session workspace and projected into the
  prompt. Every peer reads one of these; ignoring them meant ignoring the user's own house rules.
- Discovery is bounded (file count, per-file size, total size, directory depth), skips dependency and
  build directories, confines every path to the workspace root and **refuses symlinks**, so a link
  cannot pull a sibling tenant's workspace or `/etc/passwd` into a prompt.
- Each file is screened for prompt injection with the same vocabulary as the microagent registry. A
  suspicious file is **quarantined with its findings** instead of being injected — an instruction file
  is untrusted input that happens to look authoritative. Precedence is explicit: deeper files are more
  specific and come last, and the projection is character-budgeted (framing included) with per-file
  digests and reported truncation.
- **Deterministic lifecycle hooks (G2).** Operators can define rules on `session.start`,
  `session.stop`, `prompt.submit`, `tool.pre` and `tool.post` that warn, require approval or deny,
  matched by capability-id globs and a bounded argument pattern. A `tool.pre` rule joins the layered
  policy stack as an **escalation-only** layer: it can add scrutiny, never grant authority another
  layer withheld — proven by a test where an "allow" hook fails to enable disabled process execution.
- Unlike the peers, **a hook cannot shell out**. Its optional action invokes an allowlisted *governed
  capability*, so hook side effects pass policy, approval, the effect journal and the audit trail like
  anything else. Actions are inert until a tenant enables them and allowlists the capability, and a
  recursion guard stops a hook from triggering itself. Every firing is recorded with its outcome.
- **Tool search (G3).** `tool.search`, `tool.describe` and `tool.catalog` give progressive disclosure
  over a 275-capability catalog: deterministic lexical ranking (exact id, prefix, token overlap) with
  risk, side-effect and source filters, and full schemas fetched only for the capability chosen.
- Added REST for all three (`/v1/capabilities/search`, `/v1/sessions/:id/instructions`, `/v1/hooks*`),
  a Canvas hook panel with enable/disable/remove and the firing ledger, and two new CLI views.
- Added 14 tests (446 engine tests total) covering discovery and precedence, dependency-directory
  exclusion, injection quarantine, symlink and size refusal, budgeted projection with truncation,
  prompt integration, hook denial with the rule named, escalation-only composition, approval
  escalation, governed and allowlisted hook actions, recursion prevention, session lifecycle firing,
  tenant scoping, and tool-search ranking against both a fixture and the live catalog.

## 1.49.0 — 2026-08-20

Three more loops closed inside existing subsystems: planning now learns how wrong its estimates
usually are, a badly missed expectation raises a candidate replanning signal instead of disappearing
into a metric, and a benched role becomes a visible, actionable capability gap.

- **Measured durations.** Delegated work now records real elapsed time on the plan step when a society
  task finishes — wall-clock from delegation to completion, taken from recorded task timestamps. Plan
  estimate accuracy stops being an estimate about estimates.
- **Estimation calibration.** `AuroraEstimationCalibrator` turns finished steps into a bounded,
  explainable correction: the **median** actual/estimate ratio (so one catastrophic step cannot rewrite
  a tenant's planning), clamped to a sane range, bucketed by plan tag with a fallback to the plan
  horizon, requiring a minimum sample count, and reporting a confidence that saturates around twenty
  samples. Suggestions list every unfinished step, including the ones deliberately left alone and why.
- Applying a correction is an **auditable plan revision**: the reason names the factor and the sample
  count, and each corrected step records where its new estimate came from, so a machine-adjusted
  estimate never passes as a human's. The ACOS learn phase ingests new samples every cycle.
- **Surprise-driven replanning advisories.** When a decision's plan fails, or reality lands far from
  the expected value, plan feedback raises a *candidate* initiative — evidence-bound, with the expected
  and observed values in the message — instead of quietly writing a number nobody reads. It stays
  silent when the plan went roughly as expected, and it never replans by itself.
- **Probation visibility.** A step blocked because every matching role is on probation now records a
  deduplicated capability-gap observation naming the risk level and each role's failure record, so the
  evolution pipeline hears about it. A new probation report lists benched roles with their record and
  the ready high-risk steps they are currently blocking.
- Added governed `plan.estimation-ingest|profile|suggest|apply|samples` and `society.probation`
  capabilities, REST for all of them, Canvas cards for the estimation profile, probation status and a
  per-plan "Apply calibration" control, two new CLI views, `haf_aurora_estimation` telemetry and an
  `estimates-biased` alert.
- Fixed forward compatibility: delegation and harvest policies written by earlier versions are migrated on read (probation and failure-learning defaults) instead of throwing after an upgrade — found by exercising the live server against pre-existing state.
- Added 9 tests (432 engine tests total) covering factor learning and idempotent ingest, suggestion
  rationale with and without history, auditable application, median resistance to a pathological
  outlier, ACOS learn-phase ingestion with tenant scoping, advisory creation on failure, silence on an
  expected outcome, and the probation report with its recorded coverage gap.

## 1.48.0 — 2026-08-20

Another deepening release: the decision loop finally closes, delegation schedules like something that
understands consequences, and a role that keeps failing stops being handed the dangerous work.

- **Plan feedback into decision calibration.** Surprise, Brier score and overconfidence were only ever
  as good as the outcomes someone remembered to record — which meant mostly none. `AuroraPlanFeedback`
  derives the outcome of a decision from the plan it produced: the fraction of steps genuinely
  finished, blended with the mean quality of harvested delegated work when that evidence exists.
- The derivation is conservative by construction: only terminal plans count (completed, abandoned, or
  blocked by a failed step), an existing outcome is never overwritten, abandoned and already-reviewed
  decisions are left alone, and a decision whose plan is merely *executing* is marked executed rather
  than resolved. `dryRun` shows precisely what would be written before calibration is touched.
- Every record keeps its evidence references, observed value, surprise and Brier score, so a
  calibration number can be traced back to the execution that produced it. The ACOS evaluate phase now
  folds reality in *before* reading calibration, so a finished plan is never still counted as an open bet.
- **Critical-path-aware delegation.** When the budget only allows a few tasks, the bridge now delegates
  the longest pole first: critical-path steps, then risk, then estimate size, deterministically. Among
  equally-waiting plans, the unattended path prefers the one with the longest critical path — fairness
  still comes first, criticality only breaks ties.
- **Role probation.** A role whose failure rate exceeds the configured threshold, over enough attempts,
  is no longer nominated for high-risk steps (`riskLevel >= riskFloor`), and the step is skipped with
  `all-matching-roles-on-probation` instead of quietly handing dangerous work to the least reliable
  candidate. Probation is soft and reversible: low-risk work still flows, so a role can earn its record
  back. Candidate listings now expose completed/failed counts, failure rate and probation status.
- Added governed `decision.feedback-candidates|reconcile|records|summary` capabilities, REST for all of
  them, a Canvas "Record decision outcomes" control with the derived outcomes and loop summary, CLI/TUI
  views and a bounded `decision-feedback-reconcile` action, plus `haf_aurora_plan_feedback` telemetry
  and a `plan-expectations-off` alert when finished plans keep landing far from what was expected.
- Added 9 tests (423 engine tests total) covering outcome derivation from step evidence, failure
  recording, dry runs, execution marking without a verdict, refusal to overwrite a human outcome, the
  loop summary, ACOS integration, critical-path ordering under a tight budget, and probation keeping a
  bad record away from high-risk work while leaving routine work untouched.

## 1.47.0 — 2026-08-20

This release deepens the three newest subsystems rather than adding a fourth: delegation now respects
the society's real economics, failures now teach, and role authority is no longer limited to the
templates that shipped with the engine.

- **Budget-aware delegation.** The execution bridge consults the society's daily token budget and
  concurrency ceiling *before* posting work, instead of discovering the limit at award time. A task
  that could never be awarded today is never created: the step is skipped with a named reason
  (`society-concurrency-exhausted`, `society-token-budget-exhausted (needs N, M left today)`), so the
  real constraint is visible instead of hidden behind an orphan task sitting open in the marketplace.
  Commitments made earlier in the same call are counted against the remaining budget, and the ceiling
  is only applied when the caller actually intends to award.
- **Fair unattended delegation across plans.** The autopilot path now serves the plan that has waited
  longest for delegation first — the same fairness rule the fleet supervisor uses for tenants — so one
  busy plan cannot consume a tenant's entire daily society budget.
- **Failures now teach.** A delegated task that fails or lands in the ambiguous band is turned into a
  deduplicated, evidence-backed capability-gap observation (severity derived from the measured
  quality, evidence referencing the delegation, the society task and the child session's events) and
  triggers candidate-only experience distillation on the child session trajectory. The weakest scoring
  criterion is named in the gap context, so the lesson points at the actual weakness. Successes teach
  nothing here, both sinks are optional, and the whole behaviour can be disabled with
  `learnFromFailures: false`. Nothing is auto-applied: gaps and lessons remain candidates behind their
  existing governed gates.
- **Tenant-defined role authority templates.** Least authority is no longer limited to the eight
  built-ins. A tenant can define its own template (allow patterns, deny patterns, risk ceiling) which
  is validated, resolved against the live capability catalog, and rejected if it grants nothing.
  Built-in ids are reserved and built-ins cannot be edited or removed. Custom templates take part in
  application, binding, `applyAll` and the drift audit exactly like built-ins, and stay tenant-scoped.
- Added `society.authority.define` and `society.authority.remove` capabilities, tenant-aware
  `society.authority.templates`/`resolve` (v1.1.0), REST for defining and removing templates, and a
  Canvas control to define or remove a template alongside the built-ins, plus learning provenance
  (gap recorded, lesson candidates) shown on each review item.
- Added 9 tests (414 engine tests total) covering the concurrency ceiling, the token shortfall message,
  post-without-award, cross-plan fairness, gap creation with deduplication from a failing child
  session, silence on success, custom template definition/resolution/application/removal, built-in
  protection, empty-template rejection and tenant scoping.

## 1.46.0 — 2026-08-20

- Added the **Aurora delegated-outcome harvester**: the last open link in the execution loop. Until now a finished child session still needed a human to declare the outcome, so completed delegated work looked like work in progress, plans stalled on finished steps and role reputation never moved.
- Outcomes are scored from **recorded events only**, as a stored scorecard rather than a judgement: five named criteria with fixed weights (assistant output produced, tool-call reliability, session health, guardrail/policy trips, budget adherence). Every criterion, its weight and its score are persisted, so any quality number can be re-derived — tested by recomputing the weighted mean from the stored criteria.
- **Hard failures are absolute**: a failed session, or one that produced no assistant output at all, is a failure regardless of the weighted score, and never lands in the ambiguous band.
- The **ambiguous middle band is never auto-recorded**. Between the configurable failure and success thresholds the task becomes a review item with an explicit reason, because a system that guesses at its own success rate corrupts every calibration built on top of it. The same applies when the child session left no usable evidence, or when a tenant disables automatic recording.
- Work still in flight is never harvested: a task is only scored once its child session is closed, failed, or idle and quiet for the configured settle window, with no active turn and nothing waiting on approval.
- Evidence is mandatory and real — failures first, then the last assistant messages — and the society itself verifies that every evidence ID belongs to the child session before accepting the outcome.
- Humans can resolve a review item with their own verdict; the machine scorecard stays attached to the record, so a disagreement between the system and its operator is itself auditable.
- The ACOS execute phase now harvests before reconciling, and surfaces the review backlog as a recommendation. Added `harvest-review-backlog` alert and `haf_aurora_harvest` telemetry.
- Added governed `plan.harvest|harvest-assess|harvest-assessments|harvest-review|harvest-resolve|harvest-policy` capabilities, tenant-admin REST for all of them, a Canvas review queue with one-click verdicts inside the delegation section, and two CLI views plus a bounded `harvest` action.
- Added an **Aurora panel to the interactive TUI**: `/aurora [view|action]` reaches the same allowlisted views and bounded actions from inside a conversation, so the cognitive layer no longer requires a second tool to inspect.
- Added 15 tests (405 engine tests, 8 headless-client tests) covering event-derived scoring, re-derivable quality, in-flight refusal, the ambiguous band, human resolution, hard failures, evidence-bound reputation movement, non-mutating assessment, threshold validation, ACOS integration, tenant isolation, tool-failure penalties, guardrail and budget penalties, evidence-free refusal and the CLI surface.

## 1.45.0 — 2026-08-20

- Added the **Aurora execution bridge**: the missing nerve between "Aurora decided what to do" and "the society actually did it". Plan steps become society marketplace tasks, and society outcomes flow back into plan steps with the child session's evidence event IDs.
- Only steps the planner itself reports as **ready** can be delegated, so the dependency graph still governs execution order; a step already in flight is never delegated twice, and a detached delegation frees the step for re-delegation after replanning.
- Role selection is deterministic and recorded: capability coverage, earned reputation and current load produce a match score that is stored on the link, so "why this role?" is answered from durable state instead of narrated. A nomination bid is explicitly labelled machine-authored — the bridge never pretends a role volunteered.
- Spawning the child session (`plan.activate`) is a separate, privileged step: posting and awarding work never starts real execution as a side effect of planning.
- By default the bridge refuses to post work no active role can satisfy, rather than leaving an orphan task open forever; bounds cover active tasks per plan, tasks per run and links per tenant.
- Reconciliation maps society reality onto the plan honestly: running → in-progress, completed → done with evidence, failed → failed (blocking the plan), cancelled → ready, and a vanished task detaches instead of freezing the plan.
- The ACOS **execute** phase now reconciles delegations every cycle and, only when a tenant explicitly enables auto-delegation and names a root session, delegates ready steps unattended.
- Added **role authority templates**: least-privilege capability allowlists for the agent society. Eight reviewed archetypes (prime, researcher, coder, planner, memory-keeper, guardian, communicator, evolver) each declare allow patterns, deny patterns and a hard risk ceiling.
- Templates resolve against the **live** capability catalog, so they can never grant an id that does not exist and never miss a newly registered capability in their family; everything the ceiling or a deny pattern removes is reported, and a pattern that matches nothing is surfaced as template drift.
- Applying a template creates or updates an agent profile and binds it to the roles it was written for, so delegated child sessions run with least authority instead of inheriting the parent's entire capability set. The audit reports roles still inheriting full authority, missing profiles and profiles that drifted above their template.
- The guardian template is provably read-only: every capability it grants is side-effect free, verified in test.
- Added governed `plan.delegate|activate|sync|delegations|delegation-report|delegation-candidates|delegation-detach|delegation-policy` and `society.authority.templates|resolve|apply|apply-all|audit` capabilities, tenant-admin REST for all of them, a Canvas "delegation" section (plan delegation, link inspection with match evidence, activate/detach, authority audit and one-click template application) and two new CLI views.
- Added delegation and authority telemetry (`haf_aurora_delegation`, `haf_aurora_authority`) plus `delegation-failing` and `roles-inherit-authority` alerts.
- Added 22 tests (391 engine tests total) covering ready-only delegation, deterministic match evidence, double-delegation refusal, the unsatisfiable-tags guard, evidence-carrying completion, failure propagation, per-plan concurrency, coverage reporting, detach-and-redelegate, inert unattended delegation, ACOS reconciliation, tenant isolation, template resolution against the live catalog, risk ceilings, deny patterns, read-only guardians, idempotent application, real session constraint, the authority audit, drift detection and tenant scoping.

## 1.44.0 — 2026-08-20

- Added the **Aurora fleet supervisor**: the multi-tenant driver above the per-tenant autopilot. Unattended cognition now scales past a single tenant without letting one tenant starve or poison the others.
- Enrollment is explicit, so multi-tenant background compute is never accidental. Each member carries a priority band (1-5), a per-sweep run cap, an optional note and durable counters.
- Sweeps are fair and bounded: tenants are served by priority band and then least-recently-swept first, a sweep touches at most `maxTenantsPerSweep` tenants, a tenant contributes at most `maxRunsPerSweep` runs, and the whole fleet is capped by `maxSweepsPerDay` (reset at midnight UTC).
- Failures are contained per tenant — a throwing autopilot never aborts the sweep — and three consecutive failing sweeps open a circuit breaker with an exponential pause (15 minutes to 4 hours) that an operator clears with an explicit resume. A clean sweep clears the counter by itself.
- Every sweep lands in a durable ledger with per-tenant outcomes, run counts and durations, so cross-tenant unattended activity is always reviewable.
- Fleet routes (`/v1/aurora/fleet…`) are **system-admin only** because they are cross-tenant; tenant agents reach only their own membership through the tenant-scoped `aurora.fleet.status|enroll|update|withdraw|sweep` capabilities. Multi-tenancy never leaks through a tool.
- Wired the fleet into engine configuration (`auroraFleet.enabled|tenantIds|sweepIntervalMs|maxTenantsPerSweep|maxSweepsPerDay`), into Aurora telemetry (`haf_aurora_fleet` gauges plus a `fleet-tenant-paused` alert) and into a new Canvas "fleet" section with enroll, enable/disable, resume, withdraw and sweep controls.
- Added an **Aurora CLI surface** to the headless client: `haf-client aurora VIEW|ACTION`. Views are a fixed allowlist of read-only endpoints (status, journal, metrics, alerts, selfcheck, footprint, enforcement, enforcement-summary, autopilot, autopilot-runs, fleet, fleet-members, fleet-sweeps, compliance, initiatives, checkpoints) with the tenant attached and the page size clamped client-side; only three bounded actions are reachable (`cycle`, `autopilot-run-due`, `fleet-sweep`). Aurora is now operable from a terminal with no browser.
- Added [`docs/aurora-operator-runbook.md`](docs/aurora-operator-runbook.md): the five-minute health check, unattended-operation configuration and tuning table, the circuit-breaker procedure, an alert-by-alert playbook, governance incident handling, five recovery paths, privacy request handling and a weekly operator ritual.
- Added 15 tests (369 engine tests, 7 headless-client tests) covering enrollment semantics, priority/round-robin fairness, per-sweep caps, failure isolation, the circuit breaker and resume, the daily ceiling, fleet status and ledger, tenant-scoped status, single-tenant sweeps, invalid settings, and the CLI view allowlist and action allowlist.

## 1.43.0 — 2026-08-19

- Aurora governance now **binds at the capability boundary** instead of being advisory. `AuroraPolicyEngine` joins the layered policy stack, scoring every capability call against the destructive-pattern rules and, for consequential calls, the constitutional checker.
- The layer is strictly escalation-only and evidence-driven: it escalates only when a destructive pattern actually matches the call's arguments, never on declared risk class alone, so operator intent (`autoApproveWorkspaceWrites`, `allowProcessExecution`, OPA rules) is preserved. It can raise allow to require-approval and require-approval to deny, but can never grant authority another layer withheld.
- Critical patterns are denied outright, high-risk patterns require confirmation, thresholds are configurable (`confirmAtOrAbove`, `denyAtOrAbove`, `alwaysCheckConstitution`), and the whole layer can be disabled with `auroraGovernance.enabled: false`.
- Constitutional attributes at the capability boundary are deliberately honest: the destructive/rollback dimension is not asserted there (it belongs to Aurora action records), `humanApproved` reflects whether the call is already gated, and verification is claimed only because capability outcomes are journaled.
- A failing risk analyzer or constitution service degrades to no escalation rather than opening a gate; the base policy layers still apply.
- Added a durable enforcement audit trail with a per-tenant summary: escalation rate, denials, distribution by risk level, most-triggered rules and most-violated principles, exposed over REST and in the Canvas operations panel.
- Closing a session now triggers candidate-only experience distillation automatically, so the learning loop no longer depends on someone remembering to run it. Failures never block session closure and it can be disabled with `experienceDistillation.onSessionClose: false`.
- Added 9 tests (356 engine tests total) covering non-escalation of ordinary calls, critical denial, high-risk confirmation, configurable thresholds, the audit trail and summary, fail-closed analyzer behaviour, real end-to-end denial through the capability broker, automatic distillation on session close and disabling the layer.

## 1.42.0 — 2026-08-19

- Added Aurora workspace checkpoints: bounded, content-addressed snapshots of a session workspace that turn the constitution's "recovery path" requirement into a real, executable rollback. Snapshots are limited by file count, per-file size and total size, exclude dependency/build directories, confine every path to the workspace root and reject symlink escapes.
- Restoring a checkpoint takes an automatic safety checkpoint first, so a rollback is itself reversible; content is deduplicated by digest and blobs are reclaimed only when no checkpoint still references them; restores verify blob integrity before writing.
- Environment actions can now bind a checkpoint as their concrete recovery path (`rollbackCheckpointId`), and a recorded rollback names the checkpoint that was restored in its verification record.
- Added content-free Aurora telemetry: a per-tenant snapshot and Prometheus exposition across cognition, memory, world calibration, initiative trust, society, evolution, environment, decisions, plans, constitution, autopilot and ACOS. Only counts, rates and bounded scores are exported — never titles, content or identifiers — and the public `/metrics` scrape now includes them.
- Added derived operational alerts: degraded cognitive or memory health, exhausted attention budget, world inconsistency, prediction miscalibration, low proactive trust, verification debt, decision overconfidence, review backlog, stalled plans, low constitutional compliance, failing autopilot and degraded cycles.
- Added Aurora data governance: whole-tenant or per-user export with per-section digests, user purge with an explicit dry run and a stated retention list for audit-grade records, and a retention footprint view.
- Added a cross-store integrity self-check with eleven checks no single service can perform alone: dangling memory relations, broken thought anchors, focus without reservation, attention-reservation drift, verification debt, high-zone actions without approval, decisions referencing missing options, decisions without a falsifiable expectation, plans completed with open steps, tasks assigned to removed roles, quarantine bypass, ungated production skills and constitutional-floor damage.
- The ACOS evaluate phase now consumes the integrity report: critical findings degrade the cycle and surface as recommendations.
- Added governed `checkpoint.*`, `aurora.metrics`, `aurora.alerts`, `aurora.export`, `aurora.purge.user`, `aurora.selfcheck` and `aurora.footprint` capabilities, tenant-admin REST for all of them, and a Canvas "operations" section for alerts, integrity findings, telemetry, footprint and checkpoints.
- Added 12 tests (347 engine tests total) covering checkpoint bounds, exclusion, diffing, exact restore, reversible rollback, deduplication and tenant isolation, content-free telemetry, alert derivation, export/purge governance, integrity detection, checkpoint-bound recovery and the ACOS integrity feed.

## 1.41.0 — 2026-08-19

- Added the Aurora reasoning layer (ACOS L6): durable decision records with normalized weighted criteria, deterministic option ranking, preserved dissent, computed confidence and margin, mandatory override reasons for lower-ranked choices, constitution-denial refusal, review scheduling, outcome capture and calibration (success rate, mean surprise, Brier score, overconfidence, worst decisions).
- Added the Aurora planning layer: dependency-ordered plans with per-step verification, estimates and risk, cycle-rejecting graph validation, computed critical path and risk buffer, ready/blocked derivation, dependency-enforced step transitions, versioned revisions with a mandatory trigger and reason, plan supersession, estimate-accuracy measurement and stalled-plan detection.
- Added the experience distiller: a closed learning loop that reads a finished session trajectory, measures complexity, and proposes reusable procedures, recurring-failure pitfalls and capability gaps as deduplicated, evidence-bound candidates. Nothing is auto-applied; applying routes through the governed harness, microagent or skill-evolution service.
- Added the Aurora autopilot: an opt-in unattended cadence (pulse, maintenance, reflection, dream, daily briefing, weekly review, monthly strategy) that drives ACOS cycles and digests, bounded by a daily run ceiling, quiet hours, per-cadence enable/disable, exponential failure backoff and a durable run ledger with outcomes.
- Added the provenance explainer: `aurora.explain` reconstructs the chain from intake signal to initiative, cognitive object, memory, world state, decision, plan, environment action, verification and constitutional review — from durable state only, never narrated by a model.
- Upgraded memory recall to semantic search: the memory graph now shares the engine's embedding-backed hybrid index, blending embedding similarity with lexical overlap, importance, confidence and recency so paraphrased questions recall the right memory. Indexing is fail-open and falls back to the previous lexical behaviour.
- Wired the new layers into ACOS: the prioritize phase surfaces stalled plans with their ready steps, and the evaluate phase surfaces the decision-review backlog and flags systematic overconfidence; whole-organism status now reports decision calibration and active-plan progress.
- Added governed `decision.*`, `plan.*`, `experience.*`, `autopilot.*` and `aurora.explain` capabilities, tenant-admin REST for all of them, and Canvas Aurora sections for reasoning (decisions, plans, distilled proposals with apply/reject) and autopilot (cadences and run ledger).
- Added `docs/aurora-architecture.md`: the complete layer map (L0-L19 plus ACOS, explainability and anomaly detection) with the service, capability, REST surface and test that implement each layer, where each constitutional invariant is enforced, the on-disk state layout and the end-to-end journey.
- Added an end-to-end journey test that carries one real signal through intake, initiative, attention, memory, multi-perspective dissent, constitutional review, decision, plan, verified action, outcome feedback, a full ACOS cycle and provenance reconstruction.
- Added 17 tests (335 engine tests total) covering decision ranking/override/calibration, plan cycles/critical path/revision/supersession/stall detection, distillation thresholds and governed application, autopilot bounds, provenance tracing and semantic recall.

## 1.40.0 — 2026-08-19

- Re-read the Aurora architecture source in full and re-audited OpenHands, Prime Agent and Hermes Agent, then adopted their strongest ideas into Aurora under explicit governance. Adoption rationale and refusals are recorded in `docs/aurora-upstream-adoption-2026-08-19.md`.
- Added the Aurora constitutional identity core: sixteen seeded principles (the twelve cross-cutting PDF rules plus four ACOS operating principles), a versioned mission, an append-only continuity log and governed amendments with an approver, reason and version bump.
- Added a deterministic Internal Constitution Checker: declared decision attributes produce allow/review/deny with violated principle codes, concrete remedies and a durable audit trail plus compliance reporting; built-in hard principles cannot be softened or retired, including by Aurora itself.
- Added the Continual Harness (Prime-derived): prompt notes, memories, skill specs and sub-agent specs as CRUD state the agent may refine from its own trajectory, with size-limited and rate-limited evidence-backed batches, per-scope snapshots, ordered rollback by ID, effectiveness feedback, pruning and character-budgeted prompt projection. The base system prompt, policy, profiles and capability allowlists stay outside this surface.
- Added the microagent knowledge registry (OpenHands-derived): always-on, keyword, glob and manual activation with recall budgets, prompt-injection screening that quarantines documents until a human review, effectiveness feedback and content digests.
- Added the escalation-only risk analyzer and confirmation policy: eighteen built-in destructive-pattern rules, tenant rules, risk levels, safe-zone hints, confirmation modes and a rolling risk posture. It can raise scrutiny but never grant authority, and built-in critical rules cannot be disabled.
- Added model-free stuck detection over the durable event log: repeated actions, repeated error classes, two-capability oscillation, monologue, byte-identical output, approval starvation and fired runtime guardrails, with evidence event IDs and a friction signature.
- Added Dream-Mode concept formation: proposes connections between related but unlinked memories scored by tag overlap, cross-layer distance, textual dissimilarity and importance; candidates only become memories through an explicit materialization that links both sources.
- Added ACOS, the Aurora Cognitive Operating System control loop: one bounded tick walking observe, update-world, prioritize, allocate, execute, evaluate, learn, remember, reflect and evolve across every Aurora subsystem, with cycle modes, durable cycle reports, a thought journal, whole-organism status and per-phase degradation instead of all-or-nothing failure. The cycle is itself constitution-checked and executes no side effects directly.
- Wired the loop end to end: stuck sessions and stalled projects become sourced cognitive objects, blocked repeated-loop thoughts become evidence-backed capability-gap observations, and queued initiatives compete for the same constitutional attention budget.
- Added governed `constitution.*`, `harness.*`, `microagents.*`, `risk.*`, `session.stuck.analyze`, `acos.*` and `memory.insights.*` capabilities, tenant-admin REST for every new subsystem and Canvas Aurora panel sections for ACOS cycles/journal, constitution, harness refinements with rollback, knowledge/microagent quarantine review and risk posture.
- Added the Aurora context composer: the constitution, continual harness, trigger-activated microagent knowledge and memory recall are now assembled into a per-section character-budgeted block that is appended to the session system prompt with explicit trust markers (binding constitution, reviewable harness guidance, untrusted knowledge and memory). Composition is fail-open, digested for audit and reported in context-projection stats; it can be tuned or disabled through `auroraContext` engine config.
- Added the ACOS cognitive economy: named attention-allocation buckets (for example project 0.4, research 0.25) with per-bucket caps enforced during attention allocation, per-bucket reservation and consumption accounting, daily rollover and a bucket view.
- Added 34 tests covering constitutional verdicts and immutability, harness batching/rollback/pruning, microagent activation/quarantine/demotion, risk escalation and policy floors, every stuck pattern, insight formation and full/degraded ACOS cycles.

## 1.39.0 — 2026-08-19

- Completed the Aurora PDF integration order: Phase A/B extensions plus Phases C, D, E, F and G, without removing or weakening any existing HAF capability.
- Phase A extension: durable Agent Communication Bus with role-addressed/broadcast messages, acknowledgements and retention bounds; meta-agent monitoring for stalled, duplicated and unbid tasks, failing or idle roles, budget saturation and concurrency starvation; evidence-bound retirement of underperforming non-builtin roles.
- Phase B extension: deduplicated, quota-bounded automatic Global Workspace intake with a hash-only intake ledger; preemptive attention allocation where a constitutionally higher-ranked object reclaims a focused slot without losing reservations; focus interruption; mini/deep/meta/Dream-Mode reflection scheduling gated by cognitive mode; curiosity queue; cognitive health and constitution checks.
- Phase C: Aurora Memory Object standard and memory pyramid (working, session, episodic, semantic, procedural, user, palace) with claim typing (observation/inference/hypothesis/prediction), confidence, importance, tags, provenance and temporal validity.
- Phase C: typed relation graph with strengthening, bounded traversal, supersession, sleep-like consolidation/compression into provenance-linked summaries, contradiction detection, staleness/usage/duplicate memory health, hard deletion and long-term thought anchors with scheduled reviews.
- Phase D: Entity → State → Relation → Event → Outcome world model with temporal state windows, causality assertions updated by real outcomes, Brier-scored prediction calibration, consistency/contradiction detection, bounded simulation and counterfactual branches, sub-scope views and assumption reassessment.
- Phase D: Multi-World Model with the twelve PDF perspectives, meta weighting per problem type, debate/conflict records, scenario probabilities and future trees, reality-alignment scenario outcomes, per-perspective prediction reputation and consensus that preserves dissent, missing perspectives and uncertainty.
- Phase E: Proactive Initiative Engine with intake events, watcher registry, importance × urgency × impact × confidence × user relevance worthiness, P0–P4 classes, channel selection, daily attention budget, quiet hours, duplicate suppression, escalation, daily/weekly/monthly digests and trust-adaptive thresholds driven by user feedback.
- Phase E: governed user cognitive model with typed behavioural claims, evidence, consent lifecycle, user corrections, retraction and deletion, long/medium/short goal model, stalled-goal detection, behavioural signals, uncertainty-labelled state estimation, frustration risk, growth timeline, advice effectiveness and guardian alignment checks; protected topics (health, belief, politics, ethnicity, sexuality, credentials) are rejected at write time.
- Phase F: capability-gap/friction/bottleneck detection with signature deduplication, skill blueprints, strictly staged blueprint → sandbox → test → beta → production evolution with evidence gates, remediable safety scoring, regression baselines and protection, multidimensional skill scores, composition graph, retirement policy, workflow evolution with bottleneck detection, evolution journal and the Cognitive Evolution Index.
- Phase G: environment inventory with safe execution zones 0–4 and tool execution reputation, standard action records (goal → plan → action → result → verification → memory update), approval and rollback requirements for high zones, unexpected-outcome and verification-debt tracking, workspace habit learning and continuous project awareness.
- Queued initiatives are mirrored into the Global Workspace so proactive signals compete for attention under the same constitutional budget instead of bypassing it.
- Added governed `memory.graph.*`, `memory.anchor.*`, `world.*`, `multiworld.*`, `initiative.*`, `user.*`, `evolution.*`, `environment.*`, `society.bus.*`, `society.meta.*` and extended `cognitive.*` capabilities, tenant-admin REST routes for every phase and a Canvas Aurora panel covering memory health, world calibration, initiative queue/trust, user model, evolution index and environment inventory.
- Added phase-level automated evidence: memory pyramid/graph/consolidation/health, world temporal/causal/calibration/simulation, multi-world dissent/future-tree/reputation, initiative budget/silence/trust, user-model governance/privacy, evolution gate/regression/retirement, environment verification/rollback/reputation and engine-level capability and tenant-isolation tests.

## 1.38.0 — 2026-08-19

- Added Aurora PDF Phase B: first-class sourced cognitive objects and a durable tenant Global Workspace.
- Added observation/problem/hypothesis/insight/risk/opportunity/decision objects with confidence, importance, urgency, impact, user relevance, horizon, relations, tags and resource requests.
- Added constitutional P0–P4 goals and deterministic goal arbitration that ranks class before numeric score while preserving close conflicts.
- Added daily attention token budgets, focused-object slot limits, reservations, deferred queues and explicit completion accounting.
- Added reactive/research/development/reflection/dream/emergency cognitive modes with a constrained transition graph and durable reasons/history.
- Added hash-only thought-iteration tracking and automatic blocking after three identical outcomes, preventing raw internal results from entering loop state.
- Added governed cognitive capabilities, tenant-admin REST and a Canvas Cognitive panel for Global Workspace, goals, modes, attention and loop state.

## 1.37.0 — 2026-08-19

- Read and audited all 125 pages of the Aurora Agent Society / Cognitive OS PDF, mapped every subsystem against HAF and added a phased implementation roadmap.
- Added the Aurora Society substrate with Prime, seven executive directors and specialist archetypes from the PDF, plus custom/micro-role lifecycle and optional agent-profile binding.
- Added a durable task marketplace with capability-tag bids, deterministic reputation/confidence/cost scoring, daily token reservations, concurrency governance and isolated profile-bound child execution.
- Added evidence-bound task outcomes that release reservations, account actual token use and update role reputation only from child-session event evidence.
- Added weighted council deliberations with quorum, approve/reject/abstain confidence, preserved dissent, missing-role reporting and explicit uncertain outcomes for close conflicts.
- Prevented society role profiles from exceeding the parent session's frozen capability authority; Aurora Prime is a synthesizer role and cannot be retired.
- Added governed society capabilities, tenant-admin REST and a Canvas Society panel for marketplace, roles, budgets and deliberations.

## 1.36.0 — 2026-08-19

- Added signed external automation responder deployments bound to one tenant webhook automation and one Credential Broker secret reference.
- Added raw-body HMAC-SHA256 verification over timestamp + nonce + payload, five-minute replay windows, persistent nonce hashes and immediate event admission.
- Added responder heartbeats with content-free ready/degraded/stale health derivation, version/capability inventory and one-way instance projection.
- Added asynchronous event dispatch with event-ID deduplication and content-free processing/delivered/failed/uncertain journals; interrupted or unknown outcomes are never replayed.
- Added credential rotation, enable/disable/remove lifecycle and exact event-type authority inherited from the bound automation.
- Added public heartbeat/event routes plus tenant-admin management REST and Canvas responder deployment/health controls.
- Added heartbeat health, signature/timestamp/tamper/event-type/rotation, dedupe, uncertain no-replay and state-redaction tests.

## 1.35.0 — 2026-08-19

- Added restart-persistent content-free state for same-provider credential pools: cooldowns, disablement, failure counts/codes and last-use timestamps survive control-process replacement.
- Pool state is keyed by runtime/provider and credential IDs only; API key values are never written. Removed credentials are ignored and newly added credentials start clean.
- A rejected credential remains disabled until an explicit system-admin reset; expired cooldowns become available without bypassing active retry windows.
- Failure-state persistence is fail-closed before trying another credential, while a persistence failure after successful model output cannot invalidate the already-delivered generation.
- Added model-router and REST reset controls plus Canvas per-credential state/cooldown/failure inspection and reset actions.
- Custom model origins now require an explicit `provider`, `aggregator`, or `local` data-policy label; tenant-aware configuration views surface the label.
- Added restart cooldown/disable/reset/redaction/stale-entry tests and explicit custom-origin data-policy tests.

## 1.34.0 — 2026-08-19

- Added generic tenant-scoped OIDC Authorization Code + PKCE credential sources for model providers, using only operator-registered client IDs instead of impersonating third-party public clients.
- Added exact issuer discovery, authorization/token/JWKS origin allowlists, SSRF checks, redirect denial, nonce/state/audience/issuer ID-token verification and bounded JSON/JWKS parsing.
- Access/rotating refresh tokens, PKCE verifier, nonce, discovery data and optional client-secret references remain Credential Broker-encrypted; list/status surfaces expose projections and timestamps only.
- Added public and confidential client methods (`none`, `client_secret_basic`, `client_secret_post`), refresh-before-expiry, local logout, source lifecycle and exact model resource-origin audiences.
- Model configurations can bind an OAuth source instead of an environment key. A dynamic bearer wrapper materializes fresh same-provider clients and performs one forced refresh only after a pre-output 401/403; partial output is never retried.
- Added tenant-aware model configuration lists, REST/Canvas OAuth source registration/authorization/logout and model-route binding.
- Added restart/PKCE/rotation/encryption/poisoned-discovery/confidential-secret/audience/pre-output-retry/no-partial-retry tests.

## 1.33.0 — 2026-08-19

- Added explicit plan/apply automation synchronization from bounded hosted GitHub/GitLab JSON manifests.
- Added authenticated hosted-file retrieval with exact provider/repository/ref/path boundaries, base64/size/UTF-8 checks and content SHA-256.
- Git sources bind one authoritative tenant session, administrator-supplied webhook-secret environment reference and exact model-route allowlist; remote manifests cannot choose broader authority.
- Plans expose create/update/unchanged/disable summaries and expire after 15 minutes. Apply re-fetches and requires the exact planned content hash, so branch movement forces a new review.
- Added managed automation provenance, schedule reconciliation, removed-key disable semantics and explicit succeeded/failed/partial/restart-during-apply states without claiming atomic external effects.
- Git source state persists hashes/status/provenance only, not prompts or manifest content; Canvas and REST gained source, plan and exact-hash apply workflows.
- Added create/update/disable, branch-race, authority, traversal, duplicate-key, expired-schedule and content-free-state tests.

## 1.32.0 — 2026-08-19

- Added native bidirectional Twilio SMS through the existing Channel Gateway and governed `channel.send` capability.
- Added exact E.164 sender/recipient allowlists, fixed configured Twilio number and account-SID binding.
- Added mandatory constant-time `X-Twilio-Signature` HMAC-SHA1 verification over the exact operator-configured public URL and sorted form parameters.
- Added immediate TwiML acknowledgment followed by asynchronous, MessageSid-idempotent agent processing and outbound reply.
- Added a content-free restart-safe SMS event journal; interrupted processing or ambiguous outbound reply becomes `uncertain` and is never automatically replayed.
- Added exact-origin, redirect-denying, bounded Twilio REST transport with Basic auth confined to headers and no binary MMS URL invention.
- Added REST/Canvas status, environment wiring, signed-ingress/tamper/dedupe/uncertainty/redaction/outbound contract tests and zero audit findings.

## 1.31.0 — 2026-08-19

- Added TLS-first SMTP outbound email with exact recipient confinement, bounded text/media attachments and STARTTLS or implicit-TLS enforcement.
- Added persistent IMAP inbound polling with public-DNS/private-network policy, TLS verification, mailbox UIDVALIDITY and restart-safe UID cursors.
- Added mandatory exact sender/recipient allowlists plus constant-time `X-HAF-Email-Token` verification before any email reaches a model turn.
- Added a bounded dependency-free MIME parser for folded headers, encoded words, multipart bodies, base64/quoted-printable text and attachment omission.
- Added content-free inbound journals with processing/responding/done/ignored/failed/uncertain outcomes; an interrupted/ambiguous SMTP reply is never automatically replayed.
- Added loop suppression, untrusted-email fencing, reply threading, reconnect generations, lifecycle status and Canvas email transport counters.
- Added real certificate-verified SMTP plus fake-IMAP restart/UID/token/uncertainty/MIME/security tests with zero npm audit findings.

## 1.30.0 — 2026-08-19

- Added a real long-lived IRC/IRCv3 transport integrated with the Channel Gateway and outbound `channel.send` registry.
- Added public-DNS enforcement, TLS certificate verification by default, optional bounded custom CA bundles and explicit private/plaintext development switches.
- Added IRCv3 CAP negotiation, message tags, server time/account tags, PING/PONG and TLS-only SASL PLAIN authentication.
- Added exact channel plus nickname/account allowlists, CTCP/formatting rejection, bounded parsing, 512-byte UTF-8-safe outbound framing and destination confinement.
- Added exponential jittered reconnect, generation tracking, registration timeouts, bounded in-flight turns and content-free transport status in API/Canvas.
- Added real local TCP/TLS IRC servers in tests covering CAP, allowlists, ingress/reply, PING, UTF-8 splitting, SASL credential isolation, reconnect and injection/private-network guards.

## 1.29.0 — 2026-08-19

- Added tenant-scoped GitHub App registration and restart-persistent installation/setup-state coordination with verified app-owned installation metadata.
- Added RS256 app JWT minting with current GitHub claim rules, primary/secondary private-key rotation, deterministic disable semantics and 401/403 key failover.
- Added on-demand one-hour installation-token mint/refresh and direct integration as a hosted repository credential source for catalogs, imports and governed PR operations.
- Raw installation IDs and access tokens are Credential Broker-encrypted; list/state surfaces contain only opaque IDs and keyed projections.
- Added raw-body SHA-256 GitHub webhook verification, rotating webhook secrets, delivery deduplication and installation/repository/pull-request lifecycle projections.
- Added GitHub App REST/Canvas registration, install, installation binding and lifecycle controls plus fake-GitHub RSA/rotation/restart/webhook/secret-redaction tests.

## 1.28.0 — 2026-08-19

- Added governed GitHub pull-request and GitLab merge-request create/comment/close/merge operations.
- Added mandatory session capability routing, external-side-effect approvals and required request idempotency keys for every hosted write.
- Added SHA-pinned merges: GitHub/GitLab merge calls require the caller's expected remote review HEAD and never enable deferred pipeline merge or branch deletion.
- Added durable content-free operation journals with input/idempotency hashes, remote IDs and explicit pending/succeeded/failed/uncertain outcomes.
- Transport ambiguity, 408/409/425/429/5xx and redirects become uncertain and are never automatically replayed; deterministic 4xx outcomes become failed.
- Added REST/model capabilities, Canvas review controls and GitHub/GitLab/idempotency/uncertain/failure/secret-redaction tests.

## 1.27.0 — 2026-08-19

- Added standalone `video.upscale` with native FAL 2x/4x provider configuration and workspace-confined MP4/WebM inputs.
- Added bounded data-URI upload, exact HTTPS endpoint/redirect handling and credential-free request bodies.
- Added MP4 box traversal (`moov`/`trak`/`tkhd`) and bounded WebM PixelWidth/PixelHeight extraction.
- Upscale success now requires output width and height at least the requested factor; unverifiable or undersized outputs fail closed.
- Added validated artifact dimensions to REST/capability results and Canvas video upscaler controls.
- Added FAL auth/body, output materialization, false-scale, path escape, redirect and unsafe-model tests.

## 1.26.0 — 2026-08-18

- Added workspace-confined, hash-bound interactive HTML artifacts with exact action allowlists and 2 MiB UTF-8 limits.
- Added opaque-origin `sandbox="allow-scripts"` frames, defense-in-depth CSP sandboxing, no network/forms/objects/base URLs and short-lived in-memory frame channels.
- Added a frozen `hafArtifact.emit/request` postMessage bridge with source/channel/interaction validation, payload depth/size/prototype guards and 100-interaction grants.
- Added hidden artifact model turns: internal user/assistant/tool events remain in model continuity but are removed from REST snapshots, SSE/events, exports, search, external memory and ACP updates.
- Added content-free interaction journals containing hashes/status only, duplicate interaction IDs and uncertain/failed delivery outcomes.
- Added Canvas Artifacts management and Electron subframe navigation restrictions plus registry/hidden-turn/export/search/desktop tests.

## 1.25.0 — 2026-08-18

- Added a dedicated `haf-release` application for deterministic source manifests, CycloneDX 1.5 and SPDX 2.3 SBOMs, SHA-256 checksums and in-toto/SLSA v1 provenance.
- Added bounded release artifact copying and provenance subjects with exact inspected upstream revisions and source-manifest material hashes.
- Added optional Ed25519 checksum attestations using an environment-only private key; bundles contain public verification material but never private keys.
- Added release verification for every metadata/artifact checksum, signature payload/key identity and traversal-safe checksum entries.
- Added SOURCE_DATE_EPOCH reproducibility, generated/sensitive/cache/runtime exclusions and deterministic canonical JSON/invocation IDs.
- Added `release:prepare` / `release:verify` scripts and deterministic, tamper, signing, escape and duplicate-artifact tests.

## 1.24.0 — 2026-08-18

- Added inbound Mattermost, LINE Messaging, Google Chat, Microsoft Teams and Feishu/Lark webhook routes wired into durable channel routing.
- Added LINE raw-body base64 HMAC and Feishu timestamp/nonce/encrypt-key SHA-256 verification with five-minute replay windows.
- Added bounded exact-origin JWKS caching and audience/issuer JWT verification for Google Chat and Teams.
- Added sender/chat/space/conversation allowlists, platform event-ID idempotency and asynchronous response dispatch through configured outbound adapters.
- Added challenge/ignored-event handling, content-free background errors and no-token/body persistence.
- Added cryptographic HMAC/replay/JWT/JWKS redirect/cache tests and integrated platform route type/build validation.

## 1.23.0 — 2026-08-18

- Added restart-persistent asynchronous video jobs with explicit submitting/queued/running/succeeded/failed/cancelling/cancelled/uncertain states.
- Added native FAL Queue submit, status, result and cancellation transport with exact-origin URL construction, bounded JSON and no trusted provider-returned callback URLs.
- Added content-free job persistence: prompts, workspace paths, credentials, source images and provider result URLs are never written to the job registry or list API.
- Submission/cancellation ambiguity becomes `uncertain` and is never automatically replayed; hashed idempotency keys deduplicate confirmed and uncertain submissions.
- Added `video.job.submit/status/cancel/list`, REST job APIs and Canvas async job controls with validated artifact materialization on completion.
- Added queue contract, restart recovery, idempotency, successful materialization, redirect and uncertain-outcome tests.

## 1.22.0 — 2026-08-18

- Added up to eight confined image references and four image-to-video references with provider feature negotiation and aggregate byte limits.
- Added native FAL image generation/editing and FAL 2x/4x upscale providers with server-side data-URI inputs and bounded response contracts.
- Added standalone `image.upscale` plus optional generate→upscale chains with per-stage provider/model provenance.
- Upscale completion now requires validated raster magic bytes and dimensions at least the requested factor; a provider cannot claim 2x/4x while returning the original size.
- Added multi-reference/upscale REST, capability and Canvas controls, explicit duplicate/reference bounds and FAL redirect denial.
- Added focused multipart, FAL body/auth, chained/direct upscale, false-upscale rejection and multi-reference video tests.

## 1.21.0 — 2026-08-18

- Added tenant-scoped hosted GitHub and GitLab account registries backed by Credential Broker secret references.
- Added GitHub user/installation repository discovery, GitLab membership discovery and normalized account repository metadata.
- Added open pull-request/merge-request metadata, safe hosted repository import and immutable session-to-provider links.
- Added local/imported/remote HEAD comparison with explicit up-to-date/local-changed/remote-changed/diverged status and no implicit pull/push.
- Enforced public exact API/clone origins, per-request credential leases, manual redirects, bounded JSON and token-free persistence/list responses.
- Added Hosted Accounts controls in Canvas and focused GitHub/GitLab/redirect/tenant/clone-substitution tests.

## 1.20.0 — 2026-08-18

- Added native outbound Mattermost, LINE Messaging, Google Chat, Microsoft Teams and Feishu/Lark adapters.
- Added Mattermost and Feishu bounded binary media upload paths; platforms without a safe direct-upload contract reject media explicitly instead of inventing public URLs.
- Added Mattermost thread roots, Google Chat threads, Teams chat/channel destination routing and Feishu reply semantics.
- Hardened the shared channel HTTP boundary with manual redirects, bounded provider responses and credential-shaped error redaction.
- Added server-side environment registration, Canvas auto-discovery and focused text/media/redirect/redaction contract tests.

## 1.19.0 — 2026-08-18

- Added a dedicated remote `haf-client` application with interactive terminal, one-shot stdin automation and JSON-RPC 2.0 stdio modes.
- Added exact-origin REST transport with environment-only bearer credentials, bounded response/error handling, redirect denial and command idempotency IDs.
- Added reconnecting SSE subscriptions with monotonic sequence cursors, replay deduplication, exponential backoff and abortable unsubscribe.
- Added JSON-RPC session lifecycle, generic command, event subscription and approval methods with standard parse/request/method/params errors.
- Added TUI session navigation, live text/tool/status rendering, multiline prompts, model switching, cancellation and approval controls.
- Prompt text and credentials are intentionally rejected as command-line flags; one-shot prompts arrive through bounded stdin.

## 1.18.0 — 2026-08-18

- Added native ChatGPT Codex subscription mode against the confirmed device-auth, token-refresh, model-catalog and `/backend-api/codex/responses` contracts.
- Added restart-persistent Credential Broker storage for device authorization, access/rotating refresh tokens, expiry, cooldown and content-free account projections.
- Added account-specific model discovery without synthetic model slugs, plus hot route activation and Canvas device-login/model-picker controls.
- Added first-party Codex headers, exact-origin/manual-redirect transport, Harmony control-token neutralization, prompt-cache routing and SSE text/reasoning/tool/usage projection.
- A pre-output 401 may trigger one refresh/retry; no retry or provider fallback is allowed after partial model output.
- Added focused OAuth restart/rotation/encryption, transport, catalog, truncation and full engine-route tests.

## 1.17.0 — 2026-08-18

- Added a one-external-provider memory orchestration boundary that preserves local governed memory and injects bounded per-turn recall without mutating transcripts or user messages.
- Added native Honcho SDK integration with tenant-projected peer/session identities, session summaries, user representations, peer cards, cadence and chunked post-turn synchronization.
- Added governed `memory.honcho.profile`, `search`, `context`, `reason` and `conclude` capabilities with untrusted output labels and external-side-effect approval boundaries.
- Added content-free `pending`/`delivered`/`uncertain` synchronization journals; uncertain writes are never automatically replayed or described as exactly-once.
- Hardened Honcho SDK requests to exact configured origins with SSRF checks, manual redirects, bounded timeouts and no credential projection.
- Added environment configuration, content-free provider status API and full manager/adapter/engine lifecycle tests.

## 1.16.0 — 2026-08-18

- Added a packaged deterministic rolling micro-compaction engine ahead of the existing intent-preserving context projection.
- Older contiguous assistant/tool windows become bounded, hash-bound, explicitly untrusted derived summaries while user/system messages and the recent tail remain exact.
- Added tenant/session-scoped bounded observer caches with atomic writes, cache reuse telemetry and fail-open recovery from missing, malformed or oversized cache files.
- Tool arguments/results are represented by hashes, status, shapes and key names rather than copied values; durable transcripts remain authoritative and unchanged.
- Added environment/config controls and focused preservation, secret-shape, cache-hit and corruption-recovery tests.

## 1.15.0 — 2026-08-18

- Added restart-resumable in-flight MCP OAuth coordination using encrypted, expiring Credential Broker descriptors rather than plaintext callback maps.
- OAuth callbacks now resolve directly from one-way state digests, rebuild SDK transport/provider state after control-process replacement and serialize duplicate completion/denial races.
- Pending state, PKCE verifier and encrypted transport credentials are cleared on success, denial or expiry; graceful shutdown suspends rather than cancels browser authorization.
- Added exact authorization-server origin allowlists for cross-origin OAuth discovery/token/authorization endpoints, with SSRF checks and redirect denial on every server-side request.
- Added full local OAuth/MCP restart, concurrent replay and denial-cleanup tests.

## 1.14.0 — 2026-08-18

- Added tenant-scoped priority inbound channel routing rules over platform, chat type, hashed chat/user IDs and bounded metadata equality.
- Added per-chat/per-user/per-thread lane selection and immutable agent-profile assignment for newly admitted channel sessions.
- Raw chat/user IDs are hashed before persistence/list projection; rule/profile tenant mismatch fails closed.
- Added rule CRUD APIs, outbound text/media BFF and a Canvas Channels panel for routing and adapter delivery.

## 1.13.0 — 2026-08-18

- Added workspace-confined native outbound media delivery with 25 MiB bounds and image/video/audio/PDF magic-byte detection.
- Added native media contracts for Telegram, Discord, Slack, WhatsApp Cloud, Matrix and Signal, plus HMAC-signed webhook base64 envelopes.
- Added media upload/ID flows where required, captions/thread routing, no-credential payload projection and `channel.send.mediaPath`.

## 1.12.0 — 2026-08-18

- Added pinned external secret-source registry with generic command, 1Password CLI and Bitwarden CLI adapters.
- Added absolute executable/SHA-256 verification, clean environment allowlists, fixed argument contracts, bounded output/time and per-item failure isolation.
- Imported values enter Credential Broker without appearing in source lists, refresh results, arguments, model/session state or Canvas; source references are redacted from list APIs.
- Added secret-source CRUD/refresh APIs and a Canvas Secrets panel with write-only manual secret entry and metadata-only inventories.

## 1.11.0 — 2026-08-18

- Added asynchronous `context_projection` transform hooks for signed plugins while preserving immutable system prompt construction and exact user-message content.
- Invalid, timed-out or user-dropping context transforms fall back to the last good intent-preserving projection.
- Added bounded `memory_context` augmentation hooks that preserve local memory and label provider additions as untrusted external data.
- Added focused tests for derived-message compaction, user-intent invariants and local-plus-provider memory assembly.

## 1.10.0 — 2026-08-18

- Added bounded HTTPS repository import with SSRF checks, redirect denial, shallow/blob-filtered cloning and post-clone file/byte limits.
- Added credential-broker leases scoped to the repository origin and an ephemeral askpass channel so tokens never enter clone URLs, arguments, logs, sessions or model state.
- Added automatic cleanup on clone/session failures, verified HEAD capture, optional branch/profile selection, repository import API and Canvas bootstrap controls.

## 1.9.0 — 2026-08-18

- Added model-planned continual-harness review with strict JSON parsing, untrusted-trajectory fencing and real event-log evidence binding.
- Planner output creates scanned/evaluated candidates only; it cannot edit the immutable prompt, self-promote or bypass the Learning Governor.
- Added optional single-flight turn-interval review cadence, durable review history, manual plan/review APIs and a Canvas Learning governance panel.
- Added Canvas candidate evaluation/promotion/rollback workflows while retaining scope/risk/human-approval enforcement.

## 1.8.0 — 2026-08-18

- Added pluggable text-to-video and image-to-video services with a native FAL synchronous adapter.
- Added confined source-image materialization, normalized aspect/duration inputs, bounded base64/remote retrieval and MP4/WebM magic-byte validation.
- Added `video.generate`, image/video BFF endpoints, server-side provider inventory and a Canvas Media panel.
- Remote video URL materialization remains explicitly disabled by default and generated artifacts are owner-only workspace files.

## 1.7.0 — 2026-08-18

- Added native AWS Bedrock Converse routing with standard AWS credential-chain authentication, system/tool history translation, cache usage and Bedrock retry/error classification.
- Added workspace-confined multimodal image message parts with MIME/magic-byte/SHA-256 validation and no base64 persistence in session state.
- Added native image projection for OpenAI Chat/Responses, Azure OpenAI, Anthropic Messages, Gemini/Vertex and AWS Bedrock.
- Added Canvas image chips, up to eight images per prompt, structured image metadata in transcript/trajectory exports and restoration on failed sends.

## 1.6.0 — 2026-08-18

- Added MCP form and URL elicitation capabilities with a five-minute human-response promise and no automatic submission.
- Added bounded primitive-only form schema sanitization, tenant isolation, strict response validation, public-URL checks and no-content persistence.
- Added restart/timeout expiration semantics, resolve/list APIs and Canvas human-input cards with explicit accept/decline/cancel actions.
- Elicited values remain in live request memory only and are never written to session transcripts, audit metadata, schema cache or model context.
- Added native Azure OpenAI deployment routing with `api-key` authentication, explicit API versioning and tool/usage normalization.
- Added native Vertex AI Gemini routing through resource-scoped publisher paths and OAuth bearer tokens, reusing Gemini tool/usage translation without API-key leakage.

## 1.5.0 — 2026-08-18

- Added broker-encrypted MCP OAuth state, PKCE verifiers, access/refresh tokens, dynamic client registration data and discovery cache.
- Added short-lived, state-validated OAuth connection coordination, public callback completion, denial/cancellation handling and pending-flow cleanup.
- Added server-side environment references for OAuth client IDs/secrets and a Canvas MCP manager for static bearer, OAuth/PKCE and mTLS connections.
- OAuth tokens and client secrets remain outside MCP lists, schema cache, session snapshots, model context and browser storage.

## 1.4.0 — 2026-08-18

- Added tenant-scoped persistent agent profiles with immutable per-session version snapshots, supplemental instructions, default model/fallback routes and enable/update/delete lifecycle.
- Added profile capability allowlists enforced in model tool projection, direct tool execution and nested Python `haf.call(...)`, preventing subagents or the kernel from escalating beyond profile visibility.
- Child agents and forks inherit the frozen parent profile, preserving least privilege across the session family.
- Added resource-derived RBAC Agent Profile APIs, Canvas Profiles manager, creation-time profile picker and runtime profile inspection.

## 1.3.0 — 2026-08-18

- Added typed sandbox-aware Git status/diff/branch/create/switch/commit capabilities and Canvas controls; commit hooks are disabled and no remote push capability is exposed.
- Forced composite TypeScript application builds so missing excluded `dist` directories are always re-emitted despite stale incremental metadata.
- Added server-side environment-referenced MCP mutual TLS with bounded PEM validation, strict certificate verification and no-secret API/list surfaces.
- Added persistent content-only MCP schema cache and an administrative cache-inspection endpoint; cache failures remain observer-only and fail open.
- Added persistent server-side custom model configurations with environment credential/header references, exact credential-audience binding, hot enable/disable/remove, session route selection and a Canvas Models panel.

## 1.2.0 — 2026-08-18

- Added a durable PostgreSQL/file-backed agent inbox with explicit pending, claimed, delivered and uncertain states.
- Added direct family-reach authorization, sibling-scoped names, family roster, bounded broadcast, token-bucket rate limiting and pending limits.
- Added `auto`, `steer` and `follow_up` delivery modes with immediate receipts; busy `auto` messages enter the active turn at a model boundary.
- Added agent roster/inbox/message APIs and Canvas family messaging controls.
- Upgraded the Python bridge to protocol v2 with execution IDs, kernel generations, per-execution host tokens, duplicate request replay, bounded request counts and stable idempotency keys.
- Kernel cancellation/timeout now kills synchronous execution, aborts in-flight host capabilities and prevents late frames from regaining currentness.
- Added same-origin, SSRF-guarded Streamable HTTP MCP with server-side environment headers, redirect rejection, tool timeouts, circuit breaking and dynamic tool-list refresh.
- Added native OpenAI Responses API message/tool translation with server-side storage disabled.
- Added Brave/Tavily-backed normalized `web.search` with bounded fields, provenance URLs and unsafe-result filtering.
- Added confined single-source image editing through OpenAI-compatible multipart image edit endpoints.
- Added PostgreSQL RLS and LISTEN/NOTIFY owner wake-up for durable agent inbox rows.
- Added privacy-preserving `haf.trajectory.v1` training export with structured tool calls/results and no hidden system prompt or workspace path.
- Added bounded SHA-256-verifiable binary workspace attachments and a Canvas upload-to-prompt workflow.
- Added evidence-validated continual-harness refinement batches with governed candidate edits, persistent history, promotion-state refresh and reverse-order batch rollback.
- Fixed `agent.spawn` invoked from inside a parent model turn so child linking does not re-enter and deadlock the parent actor mutex.

## 1.1.0 — 2026-08-18

- Re-audited current OpenHands, Prime Agent and Hermes Agent default branches at exact recorded revisions.
- Added native Gemini GenerateContent translation, including Gemini 3 tool-call IDs, reasoning events and usage normalization.
- Added explicit per-session provider fallback chains with safe route audit events and no fallback after partial output.
- Added same-provider credential pools with opaque inventory, round-robin selection, cooldowns and rejected-credential disablement.
- Added bounded/redacted provider error classification.
- Replaced left-truncating context selection with non-destructive intent-preserving projection.
- Added a durable dependency-aware task board, model capabilities, session commands and Canvas panel.
- Added versioned JSON/Markdown transcript export and Canvas download.
- Added bounded OpenAI-compatible image generation with raster magic-byte validation and workspace artifact materialization.
- Added a digest-pinned Singularity/Apptainer sandbox adapter with containment and network-off defaults.
- Added focused tests for model routing, credentials, Gemini, context projection, tasks, exports, images and Singularity.
- Added a transparent current-upstream gap backlog instead of extending the old “complete” claim.

## 0.1.0 — 2026-08-15

- Initial durable session engine and supervisor.
- Event/snapshot, command/effect journals and leases.
- Model router, governed capabilities, approvals and sandbox adapters.
- Persistent Python bridge, memory, skills, subagents, scheduler and channels.
- MCP stdio bridge, ACP adapter and REST/SSE control API.
- Plugin hook failure semantics and first integration test suite.

## 0.2.0 — 2026-08-15

- Added persistent goals and model-callable goal completion.
- Added bounded autonomous continuations, token/turn/time limits and quality gates.
- Added unchanged-workspace gate retry suppression.
- Added isolated session forks and optional abandoned-branch summaries.
- Added per-session provider:model selection.
- Added provider profiles for OpenAI, Anthropic, OpenRouter, Google, Groq, xAI, DeepSeek, Mistral and Ollama.
- Added native Anthropic Messages transport.
- Added Telegram, Discord, Slack and signed-webhook outbound adapters.
- Added content-free operational metrics and Prometheus projection.
- Added AES-256-GCM local credential broker with scoped, expiring, bounded-use leases.
- Added SSRF-checked bounded public web fetch capability.
- Expanded the embedded control center for sessions, chat, events, goals, autonomy, approvals, children, forks, automations, schedules, providers, backends, search and metrics.
- Added server-side multi-backend registry with environment-only credential references and health checks.
- Added declarative manual/schedule/webhook automations with run ledger and timeout cancellation.
- Added tenant-scoped cross-session search.
- Added Docker-isolated persistent Python kernels when the Docker sandbox profile is selected.
- Added allowlist- and secret-protected native Telegram webhook ingress.

## 0.3.0 — 2026-08-15

- Added fail-open OTLP/HTTP JSON metrics exporter with content-free payloads and status accounting.
- Added WhatsApp Cloud, Matrix and Signal REST outbound channel adapters.
- Added SSH sandbox with strict host checking, bounded execution and bidirectional rsync workspace synchronization.
- Disabled local Python execution in SSH mode to prevent execution-boundary bypass.
- Added Playwright/CDP browser navigation, bounded snapshots, element refs, click/type/press/screenshot and coordinate computer-use controls.
- Added per-subresource SSRF enforcement in browser contexts.
- Added OpenAI-compatible speech-to-text and text-to-speech with workspace confinement.
- Added Learning Governor with evidence, scanning, evaluation, human review, scope/risk gates, promotion and rollback.
- Added governed learning artifacts to frozen prompt context.
- Added learning candidate control-center workflows.
- Added layered OPA/Rego policy decisions with secret redaction and fail-closed timeout/network/schema handling.

## 0.4.0 — 2026-08-16

- Added length-prefixed private worker frames with bounded JSON routing headers and opaque payload bytes.
- Added authenticated Unix-domain worker sockets and owner-only descriptors.
- Added generation/sequence event replay, replay-capacity detection and snapshot fallback.
- Added chunked snapshots and attachment-local backpressure/resync signaling.
- Added detached worker process manager with stale descriptor cleanup, logs, stop and adoption.
- Added a real resident HAF session-worker process owning root session, kernel, children and approvals.
- Added Control API endpoints for resident worker create/list/adopt/state/commands/events/approvals/stop.
- Control-plane graceful shutdown now closes attachments without terminating resident workers.
- Added control-center resident worker management.
- Added secret-filtered launch manifests and same-ID worker respawn after process death.
- Session-worker recovery reloads durable snapshots with a new generation while preserving transcript state.

## 0.5.0 — 2026-08-16

- Added versioned PostgreSQL schema migrations.
- Added PostgreSQL event store with idempotent event IDs, sequence constraints and LISTEN/NOTIFY fan-out.
- Added PostgreSQL atomic snapshot upserts.
- Added cross-process PostgreSQL command/effect journals with explicit execution ownership and uncertain outcomes.
- Added TTL/heartbeat distributed session leases.
- Added complete PostgreSQL engine vertical-slice configuration.
- Added NATS event bridge with opaque tenant subjects.
- Added NATS typed request/reply command bus for workers.
- Session workers can serve NATS commands and publish events when configured.
- Added file/PostgreSQL and local/NATS runtime profile selection through environment configuration.

## 0.6.0 — 2026-08-18

- Added persistent branch-preserving in-session message trees with active leaf and labels.
- Added branch commands and a Control Center Tree view.
- Compaction now creates context-reset entries while retaining abandoned branches.
- Added persistent BM25-style lexical plus cosine-vector hybrid retrieval.
- Added deterministic local hash embeddings and optional OpenAI-compatible embeddings.
- Added live event-to-index session message ingestion and reindex APIs.
- Learning promotion now indexes memory, skill, prompt and subagent artifacts; rollback removes them.
- Added remote Skills Hub sources, catalog refresh/search and bounded bundle downloads.
- Added SHA-256 verification, tar traversal/link/bomb controls, quarantine import and audit logs.
- Skills Hub installation requires explicit promotion after quarantine.

## 0.7.0 — 2026-08-18

- Added encrypted server-side web sessions with random HttpOnly cookie IDs and CSRF tokens.
- Added API-token-to-cookie login, logout and identity introspection.
- Added OIDC discovery, Authorization Code + PKCE, nonce/state validation and JWKS ID-token verification.
- Added tenant claim mapping and admin/operator/viewer RBAC.
- Added resource-derived tenant authorization for sessions, automations and learning candidates.
- Added system-admin-only backend, MCP, detached-worker and Skills-Hub management.
- Added Slack raw-body HMAC verification with replay window and user/channel allowlists.
- Added Discord Ed25519 interaction verification and deferred background execution.
- Added WhatsApp Cloud HMAC verification, challenge flow and sender allowlists.
- Added Signal and Matrix shared-secret plus sender/room allowlists.
- Added Control Center cookie login and CSRF-aware API requests.

## 0.8.0 — 2026-08-18

- Added a common credential broker interface.
- Added HashiCorp Vault KV v2 secret storage with metadata-only lists and scoped leases.
- Added KMS envelope encryption with per-secret data keys and zeroed plaintext key buffers.
- Added tenant columns and optional PostgreSQL RLS policies for events, snapshots and journals.
- Added request-scoped tenant and system-bypass PostgreSQL transaction helpers.
- Added Modal, Daytona, Vercel and Kubernetes serverless sandbox gateway adapters.
- Added cloud sandbox provision/exec/snapshot/destroy lifecycle, resource limits and network policy contracts.
- Disabled local Python kernels for every remote/cloud execution backend to prevent boundary bypass.

## 0.9.0 — 2026-08-18

- Added Ed25519-signed, SHA-256-pinned WASI plugin manifests.
- Added a separate WASI runner process with no network imports and constrained read-only/scratch preopens.
- Added plugin capability and observer/guard/transform hook registration with bounded output and timeouts.
- Added automated learning command evaluation and output hashes.
- Added Ed25519-signed learning releases and trusted-key verification.
- Added canary percentage/sample/success thresholds, outcome accounting, automatic promotion and rollback.
- Added Control API and Control Center management for WASI plugins and signed learning rollouts.

## 0.10.0 — 2026-08-18

- Added external scheduler provider support to DurableScheduler.
- Added hosted scale-to-zero provision/cancel/reconcile and external-fire execution.
- Added JWKS-backed short-lived cron-fire JWT verification for issuer, audience, purpose, job and fire time.
- Added persisted at-most-once fire claims, duplicate suppression and recurring re-arm.
- Added content-free fleet snapshots and threshold-based alerts for capability failures, approvals, overdue jobs and workers.
- Added Fleet status/alerts APIs and Control Center counters.
- Added dedicated adversarial and worker/persistence chaos CI commands and gates.

## 1.0.0 — 2026-08-18

- Added React/Vite HAF Canvas served under `/canvas/`.
- Added Conversation, Terminal, Files/editor, Git Changes, Browser/computer-use, Tree and Automations panels.
- Added policy-governed workspace BFF endpoints for files, terminal, changes and browser actions.
- Added cookie/CSRF-aware Canvas login, SSE updates, approvals, child navigation and fleet indicators.
- Added secure Electron desktop shell with context isolation, sandbox, navigation restrictions and external-link handling.
- Added cross-platform electron-builder targets for macOS, Windows and Linux.
