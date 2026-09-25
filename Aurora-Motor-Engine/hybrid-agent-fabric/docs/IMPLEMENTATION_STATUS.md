<!-- HAF-STATUS-BANNER -->
> ## ⚠️ Elle yazılmış anlık görüntü — doğrulanmamış
>
> Bu dosya **koddan üretilmez** ve yazıldığından bu yana doğrulanmamıştır.
> İçindeki test sayıları, tamamlanma yüzdeleri ve "production-ready" gibi
> iddialar ölçülmüş gerçekle çelişebilir (ör. bu dosya "612 test" derken
> ölçülen değer farklıdır).
>
> **Yetkili kaynaklar** — bunlar koddan üretilir ve `packages/eval/test/state-docs.test.ts`
> sapmayı yakalar:
>
> - `hybrid-agent-fabric/CURRENT_STATE.md` — ölçülen modül/test durumu
> - `hybrid-agent-fabric/MATURITY_MATRIX.md` — olgunluk seviyeleri
> - `hybrid-agent-fabric/KNOWN_GAPS.md` — bilinen eksikler
>
> Depo invariantları için: `npm run verify:integration`.
> Bu bandın varlığı `scripts/verify-integration.mjs` tarafından denetlenir.

# Implementation status

Updated: 2026-09-16 — current milestone 1.65

## Original 1.0 baseline (delivered)

### Runtime and durability

- [x] Session actor with serialized mutations
- [x] Supervisor and session catalog
- [x] Session leases with stale-process recovery
- [x] Stable family/session identities
- [x] Generation and monotonic sequence metadata
- [x] JSONL event persistence and SSE replay
- [x] Atomic snapshots
- [x] Command idempotency journal
- [x] Effect journal and uncertain outcome protection
- [x] Cancel, pause, resume, close and deterministic compaction
- [x] Persistent goals with token/continuation budgets
- [x] Bounded autonomous continuation and quality gates
- [x] Isolated session fork with optional abandoned-branch summary
- [x] Per-session provider:model selection

### Models and execution

- [x] Mock provider
- [x] OpenAI-compatible Chat Completions provider
- [x] Native Anthropic Messages provider
- [x] Nine-profile provider registry
- [x] Capability catalog and dynamic registration
- [x] Policy decisions and human approval promises
- [x] Confined filesystem read/write/list
- [x] Bounded local process execution
- [x] Hardened Docker execution adapter
- [x] Persistent Python kernel and host bridge
- [x] MCP stdio tool projection

### Multi-agent and automation

- [x] Child admission and family linking
- [x] Git worktree/copy isolation fallback
- [x] Direct agent messaging capability
- [x] Once, interval and cron schedules
- [x] Durable pre-dispatch schedule advancement
- [x] Declarative manual/schedule/webhook automations
- [x] Automation run ledger, timeout/cancel and enable/disable

### Knowledge and extension

- [x] Candidate/active memory lifecycle
- [x] Cross-session tenant-scoped ranked search
- [x] Evidence/provenance fields
- [x] Injection screening
- [x] Skill quarantine, scan, hash and promotion
- [x] Learning Governor: evidence, scan, evaluation, review, promotion and rollback
- [x] Observer/guard/transform hook failure semantics

### Surfaces

- [x] REST control API
- [x] Embedded dependency-free developer console
- [x] Server-Sent Event stream
- [x] ACP stdio adapter
- [x] Detached worker create/adopt/command/event/approval Control API
- [x] Normalized authorized webhook/channel ingress
- [x] Telegram, Discord, Slack and signed-webhook outbound adapters
- [x] AES-GCM local credential broker and scoped leases
- [x] SSRF-checked bounded web fetch
- [x] Content-free Prometheus operational metrics
- [x] Fail-open OTLP/HTTP JSON metrics exporter
- [x] WhatsApp Cloud, Matrix and Signal outbound adapters
- [x] SSH sandbox with rsync workspace synchronization
- [x] Browser/CDP automation and browser computer-use controls
- [x] Workspace-confined STT and TTS

## Aurora architecture integration (PDF phases)

Source audit: [`aurora-pdf-feature-audit.md`](aurora-pdf-feature-audit.md). Each item below has durable state, runtime integration, authority boundaries, capability/REST surface and automated tests.

### Phase A — society and constitutional substrate

- [x] Prime/council/specialist/micro role registry with capability tags and profile binding
- [x] Task marketplace with bids, deterministic awarding, reservations and concurrency limits
- [x] Evidence-bound reputation from child-session events
- [x] Dissent-preserving weighted council consensus with explicit uncertainty
- [x] Agent Communication Bus with addressed/broadcast messages, acknowledgement and retention bounds
- [x] Meta-agent monitoring for stalled, duplicated, unbid, failing, idle, saturated and starved conditions
- [x] Evidence-bound retirement of underperforming non-builtin roles

### Phase B — cognitive objects, Global Workspace and attention

- [x] Typed cognitive objects with source, confidence, importance, urgency, impact, relevance and horizon
- [x] Constitutional P0–P4 goals and class-first arbitration with preserved conflicts
- [x] Attention reservations, focus slots, deferral and daily rollover
- [x] Reactive/research/development/reflection/dream/emergency mode machine
- [x] Hash-only iteration tracking and repeated-loop blocking
- [x] Automatic deduplicated, quota-bounded intake with a hash-only ledger
- [x] Preemptive attention allocation and explicit focus interruption
- [x] Mini/deep/meta/Dream-Mode reflection scheduling gated by cognitive mode
- [x] Curiosity queue and cognitive health/constitution checks

### Phase C — memory object standard and temporal knowledge graph

- [x] Memory pyramid layers (working, session, episodic, semantic, procedural, user, palace)
- [x] Memory Object standard with claim typing, provenance, confidence, importance, tags and validity windows
- [x] Typed relation graph with strengthening and bounded traversal
- [x] Semantic, graph, temporal, goal and user retrieval with usage accounting
- [x] Consolidation/compression into provenance-linked summaries
- [x] Contradiction detection, supersession and staleness/usage/duplicate health
- [x] Long-term thought anchors with findings, next steps and review scheduling
- [x] Hard deletion for privacy requests

### Phase D — world model and Multi-World Model

- [x] Entity/state/relation/event representation with temporal validity
- [x] Causality assertions updated by confirmations and refutations
- [x] Falsifiable predictions with Brier scoring, expiry and calibration buckets
- [x] Consistency engine for conflicting current claims
- [x] Bounded simulation and counterfactual branches with explicit uncertainty
- [x] Personal/environment/digital/project/human/goal scope views and assumption reassessment
- [x] Twelve-perspective registry with meta weighting by problem type
- [x] Debate/conflict records and dissent-preserving weighted consensus
- [x] Scenario probabilities, future tree and reality-alignment perspective reputation

### Phase E — proactive initiative and user model

- [x] Intake events with payload digests and watcher registry
- [x] Worthiness scoring, P0–P4 classes and channel selection
- [x] Daily attention budget, quiet hours, duplicate suppression and silence rules
- [x] Escalation with audit trail and daily/weekly/monthly digests
- [x] Trust-adaptive thresholds driven by delivery feedback
- [x] Governed typed user claims with evidence, consent, correction, retraction and deletion
- [x] Long/medium/short goal model with stall detection
- [x] Uncertainty-labelled state estimation, frustration risk and growth timeline
- [x] Advice effectiveness feedback and guardian alignment checks
- [x] Protected-topic refusal (health, belief, politics, ethnicity, sexuality, credentials)

### Phase F — skill and workflow evolution

- [x] Capability-gap, friction, bottleneck and error-pattern detection with signature deduplication
- [x] Skill blueprints with purpose, inputs, outputs, tools, risks and tests
- [x] Strict blueprint → sandbox → test → beta → production staging with evidence gates and production approval
- [x] Multidimensional accuracy/reliability/speed/utility/safety scores recomputed from evidence
- [x] Regression baselines and promotion-blocking regression checks
- [x] Composition graph with dependent protection and retirement policy sweeps
- [x] Workflow versioning, bottleneck detection and evolution journal
- [x] Cognitive Evolution Index with deltas

### Phase G — environment awareness and embodiment

- [x] Environment inventory with safe execution zones 0–4 and capability mapping
- [x] Standard action records: goal → plan → action → result → verification → memory update
- [x] Approval and rollback requirements for high-zone actions
- [x] Mandatory verification with evidence and verification-debt reporting
- [x] Unexpected-outcome flagging and tool execution reputation with automatic degradation
- [x] Workspace habit learning and continuous project awareness with stale-project detection


### Aurora core (upstream-derived, 1.40)

Adoption rationale: [`aurora-upstream-adoption-2026-08-19.md`](aurora-upstream-adoption-2026-08-19.md).

- [x] Constitutional principle registry with hard/soft severity and stable codes
- [x] Long-Term Identity Core: versioned mission and append-only continuity log
- [x] Deterministic Internal Constitution Checker with allow/review/deny, remedies and audit
- [x] Governed amendments; built-in hard principles cannot be softened or retired
- [x] Constitutional compliance reporting and bounded prompt projection
- [x] Continual Harness CRUD over prompt notes, memories, skill specs and sub-agent specs
- [x] Size-limited, rate-limited, evidence-backed refinement batches with snapshots
- [x] Ordered rollback by refinement ID plus effectiveness feedback and pruning
- [x] Character-budgeted harness projection with usage accounting
- [x] Microagent registry with always/keyword/glob/manual activation and recall budgets
- [x] Prompt-injection screening with quarantine and named human review
- [x] Escalation-only risk analyzer with built-in destructive-pattern rules and tenant rules
- [x] Confirmation policy modes plus undisableable critical rules and safe-zone hints
- [x] Model-free stuck detection across seven patterns with evidence event IDs
- [x] Dream-Mode concept formation with explicit materialization
- [x] ACOS control loop with cycle modes, durable reports, thought journal and degradation
- [x] Whole-organism status aggregation across every Aurora subsystem
- [x] Loop wiring: stuck/stalled signals to cognitive intake, friction to capability gaps
- [x] Aurora context composition into the session system prompt with per-section budgets and trust markers
- [x] Fail-open composition, audit digest and context-projection telemetry
- [x] Cognitive economy: named attention-allocation buckets with enforced caps and daily rollover

### Aurora reasoning and autonomy (1.41)

- [x] Decision records with normalized weighted criteria and deterministic ranking
- [x] Preserved dissent, computed confidence/margin and mandatory override reasons
- [x] Constitution-denial refusal and review scheduling by reversibility
- [x] Outcome capture with surprise, Brier score and overconfidence calibration
- [x] Dependency-ordered plans with cycle rejection, critical path and risk buffer
- [x] Dependency-enforced step transitions and ready/blocked derivation
- [x] Versioned replanning with mandatory trigger/reason and plan supersession
- [x] Estimate-accuracy measurement and stalled-plan detection
- [x] Experience distillation of procedures, pitfalls and capability gaps from real trajectories
- [x] Governed application of distilled proposals through harness/knowledge/evolution services
- [x] Opt-in autopilot cadences with daily ceiling, quiet hours, backoff and run ledger
- [x] Provenance explainer across intake, cognition, memory, world, decisions, plans and actions
- [x] Embedding-backed semantic memory recall with lexical fallback
- [x] ACOS integration of stalled plans, decision-review backlog and overconfidence

### Aurora operations (1.42)

- [x] Bounded, content-addressed workspace checkpoints with exclusion and path confinement
- [x] Exact restore with an automatic safety checkpoint and blob integrity verification
- [x] Content deduplication and reference-counted blob reclamation
- [x] Environment actions bound to a checkpoint as their concrete recovery path
- [x] Content-free Aurora telemetry snapshot and Prometheus exposition
- [x] Derived operational alerts across every Aurora subsystem
- [x] Whole-tenant and per-user export with per-section digests
- [x] Governed user purge with dry run and stated retention of audit-grade records
- [x] Cross-store integrity self-check with eleven checks
- [x] ACOS evaluate phase degradation on critical integrity findings

### Aurora enforcement (1.43)

- [x] Aurora policy layer inside the layered policy stack
- [x] Evidence-driven escalation: patterns must match the call's arguments
- [x] Critical denial, high-risk confirmation and configurable thresholds
- [x] Constitutional review of consequential calls at the capability boundary
- [x] Escalation-only composition that cannot grant withheld authority
- [x] Fail-closed behaviour when the analyzer or constitution is unavailable
- [x] Durable enforcement audit trail with per-tenant escalation summary
- [x] Automatic candidate-only distillation on session close

### Aurora fleet and terminal operations (1.44)

- [x] Multi-tenant fleet supervisor above the per-tenant autopilot
- [x] Explicit enrollment with priority bands, per-sweep run caps and durable counters
- [x] Priority-then-round-robin fairness with per-sweep and per-day bounds
- [x] Per-tenant failure isolation and an exponential circuit breaker with operator resume
- [x] Durable cross-tenant sweep ledger and fleet-wide health
- [x] System-admin-only fleet REST with tenant-scoped `aurora.fleet.*` capabilities
- [x] Fleet telemetry gauges and a paused-tenant alert
- [x] Canvas fleet section with enroll/enable/resume/withdraw/sweep controls
- [x] Allowlisted read-only Aurora CLI views plus three bounded CLI actions
- [x] Operator runbook: health checks, tuning, alert playbook, recovery and privacy requests

### Aurora execution bridge and role authority (1.45)

- [x] Plan step to society task delegation restricted to planner-reported ready steps
- [x] Deterministic, recorded role matching (coverage, reputation, load) with machine-authored nomination
- [x] Award without implicit execution; child-session spawn as a separate privileged capability
- [x] Refusal to post work no active role can satisfy, with per-plan and per-run bounds
- [x] Evidence-bound reconciliation of society outcomes into plan steps
- [x] Detach-and-redelegate path for replanning
- [x] ACOS execute-phase reconciliation and opt-in unattended delegation
- [x] Eight least-authority role templates with allow/deny patterns and risk ceilings
- [x] Template resolution against the live capability catalog with drift reporting
- [x] Idempotent template application, role binding and least-authority audit
- [x] Delegation and authority telemetry with derived alerts

### Aurora outcome harvesting (1.46)

- [x] Event-derived outcome scorecard with named criteria, fixed weights and stored scores
- [x] Settle detection so work in flight is never scored
- [x] Absolute hard failures for failed or output-free sessions
- [x] Ambiguous band routed to human review instead of auto-recorded
- [x] Mandatory child-session evidence, verified by the society
- [x] Human review resolution with the machine scorecard retained
- [x] ACOS execute-phase harvesting with review-backlog recommendations
- [x] Harvest telemetry, review-backlog alert, REST, Canvas queue and CLI/TUI surfaces
- [x] Aurora panel in the interactive TUI

### Aurora delegation economics and learning (1.47)

- [x] Society token budget and concurrency consulted before posting work
- [x] Named skip reasons instead of orphan tasks that can never be awarded
- [x] Cross-plan fairness for unattended delegation
- [x] Delegated failures become deduplicated, evidence-backed capability gaps
- [x] Candidate-only distillation of failed delegation trajectories, disable-able
- [x] Tenant-defined role authority templates with validation and empty-template rejection
- [x] Built-in templates immutable and reserved; custom templates audited for drift

### Aurora plan feedback and scheduling intelligence (1.48)

- [x] Decision outcomes derived from terminal plans and delegated-work quality
- [x] Dry run, no overwriting of existing outcomes, execution marking without a verdict
- [x] Evidence, observed value, surprise and Brier score stored per record
- [x] ACOS evaluate folds reality in before reading calibration
- [x] Critical-path-first delegation under a tight budget
- [x] Criticality tie-break for unattended cross-plan delegation
- [x] Reversible role probation keeping poor records away from high-risk steps
- [x] Plan-feedback telemetry, expectation-drift alert, REST, Canvas, CLI and TUI surfaces

### Aurora estimation calibration and advisories (1.49)

- [x] Real elapsed duration recorded on plan steps from delegated society work
- [x] Median-based, clamped, bucketed estimate correction with minimum samples and confidence
- [x] Suggestions that explain untouched steps as clearly as corrected ones
- [x] Correction applied as an auditable plan revision naming factor and sample count
- [x] ACOS learn-phase sample ingestion
- [x] Candidate replanning initiative on failed or badly missed expectations
- [x] Coverage gap recorded when probation blocks high-risk work
- [x] Probation report with benched roles and the steps they block
- [x] Estimation telemetry, bias alert, REST, Canvas and CLI surfaces

### Peer parity, wave one (1.50)

- [x] Repository instruction discovery (AGENTS.md, CLAUDE.md, AURORA.md, .cursorrules, copilot-instructions)
- [x] Bounded, symlink-refusing, dependency-skipping discovery with per-file digests
- [x] Injection screening with quarantine instead of silent injection
- [x] Explicit precedence and budgeted projection with reported truncation
- [x] Deterministic lifecycle hooks on session start/stop, prompt submit and tool pre/post
- [x] Escalation-only `tool.pre` policy layer with the rule named in the refusal
- [x] Hook actions restricted to allowlisted governed capabilities, with a recursion guard
- [x] Durable hook firing ledger
- [x] Tool search, describe and catalog overview for progressive disclosure

### Peer parity, wave two (1.51)

- [x] Named permission modes: plan, manual, acceptEdits, auto, dontAsk, bypass
- [x] Sandbox modes: read-only, workspace-write, danger-full-access
- [x] Plan mode as read-only exploration that may still write plans and decisions
- [x] Mode engine that wraps the policy stack, tightening freely and relaxing only base policy
- [x] Governance decisions (Aurora, OPA, hooks, explicit denials) never relaxed by a mode
- [x] `dontAsk` fail-fast for unattended runs; `bypass` gated per tenant
- [x] Recorded mode transitions with actor and reason
- [x] Tenant defaults, REST, Canvas selectors and CLI views

### Peer parity, wave three (1.52)

- [x] Session archive and restore, enforced on the engine command path
- [x] Archive keeps all evidence; close still permitted; both directions audited
- [x] Cost with an explicit source: provider, price table or unpriced
- [x] Operator price table with longest-route matching and runtime-default model resolution
- [x] Tenant usage rollup by model with unpriced sessions called out
- [x] Repository command templates from Aurora, Claude, Codex and GitHub prompt folders
- [x] Argument substitution with filled and unresolved placeholders reported
- [x] Loud refusal for screened-out templates; symlink, size and shadowing refusals

### Peer parity, wave four (1.53)

- [x] Working-tree, staged and base-branch review with per-file statistics
- [x] Deterministic findings: secrets, sensitive paths, lockfile drift, missing tests, large deletions
- [x] Verdict rollup (clean / review / blocked) shared by every surface
- [x] Bounded diffs, validated base reference, sandboxed git calls, clean-tree degradation
- [x] Declarative subagent files from Aurora, Claude and Codex agent folders
- [x] Tool resolution against the live catalog with deny applied and reported
- [x] Unsupported front-matter fields named rather than dropped
- [x] Idempotent materialisation into agent profiles with society role binding

### Peer parity, wave five (1.54)

- [x] Effort levels with explicit, inspectable runtime profiles
- [x] Tool-iteration ceiling, context scale, reasoning effort and continuation ceiling per level
- [x] Effort resolved once per turn; `ModelRequest.reasoningEffort` honoured by providers that support it
- [x] Tenant default effort with per-session overrides and a safe fallback
- [x] Deliberate git worktrees for the main session, confined to the engine workspace root
- [x] Validated git references, confined removal, no self-removal
- [x] Worktree creation that can bind a new session in one call

### Peer parity, wave six (1.55) — audit closed

- [x] Ed25519 publisher registry with keys refused at registration if unusable
- [x] Signatures over kind:artifactId:version:sha256 with four distinct outcome states
- [x] Version and digest pinning, with drift refused despite a valid signature
- [x] Opt-in enforcement per tenant, with verdicts recorded while still advisory
- [x] Skills hub gated before download
- [x] Agent profile id on the capability context
- [x] Hook rules scoped to agent profiles
- [x] Subagent files declaring their own lifecycle hooks

### Peer parity round two, wave one (1.56)

- [x] Six-layer settings resolution with per-key provenance and contribution history
- [x] Managed layer as an absolute floor, with overridden values recorded not dropped
- [x] Managed arrays replace rather than merge
- [x] Managed permission-mode ceiling enforced by `session.mode.set`
- [x] Managed capability deny list enforced as a policy layer
- [x] Bounded, warning-tolerant project settings files
- [x] Structured multiple-choice questions to the human with attributed answers
- [x] Timeout without an invented answer; `dontAsk` denial; plan-mode allowance
- [x] Outstanding questions cancelled when a session closes

### Peer parity round two, wave two (1.57)

- [x] MCP 2026-07-28 client: no handshake, no session id, `_meta` self-description
- [x] `server/discover` with caching and non-blocking failure
- [x] `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` headers, self-checked against the body
- [x] Cacheable list results with explicit refresh
- [x] Multi Round-Trip Requests with verbatim, bounded `requestState` and a stable request id
- [x] Stateless servers registered as governed capabilities with the server's schema
- [x] Mid-call input requests routed to a human, bounded rounds, no guessed answers

### Peer parity round two, wave three (1.58)

- [x] `tasks.monitor` over family reach with status, busy flag, usage, mode, effort and open questions
- [x] `tasks.stop` separating cancel from close, ungated but reach-bounded and reason-recorded
- [x] `tasks.resume` through the durable inbox with receipts
- [x] `session.plan.enter` ungated (it only tightens)
- [x] `session.plan.exit` privileged and evidence-required, landing in manual
- [x] Plan-mode escape hatch reachable from inside plan mode
- [x] Managed ceiling enforced against an agent's own exit request

### Peer parity round two, wave four (1.59) — round two closed

- [x] `shell.start` long-running commands over the same sandbox factory as `process.exec`
- [x] `shell.output` cursor reads with an optional wait instead of polling
- [x] Bounded ring buffer with reported `skippedChars` rather than a silently stitched transcript
- [x] `shell.stop` kill switch, ungated, session-scoped and reason-recorded
- [x] Per-shell timeout, total-output ceiling, per-session cap and kill-on-session-close
- [x] Abort honoured when it lands before the process is running
- [x] Reviewed auto-approval rules with a required rationale copied onto every decision
- [x] Argument patterns, refusal patterns, session scope, expiry and use budgets
- [x] Absolute floors: no wildcard rules, never privileged, managed off switch
- [x] Escalations logged beside approvals; agent proposals arrive disabled

### Peer parity round three, wave one (1.60)

- [x] Child-agent concurrency, depth and lifetime caps enforced before any workspace is created
- [x] Nested subagent spawning off by default, raisable by configuration
- [x] `agent.fanout` read-only view of a session's own spawn budget
- [x] Per-command memory, CPU-second, file-size and process limits on local and Docker backends
- [x] Approval previews that keep the command, path and destination readable
- [x] Credential masking by key name and value shape, with every mask counted
- [x] `previewIntegrity` report on approval requests naming what was shortened or dropped
- [x] Session spend budgets in dollars and tokens, tenant defaults plus attributed overrides
- [x] Budget blocks new turns only, never truncates a turn in flight
- [x] Unpriced models reported rather than treated as free
- [x] `waitingOn` in the monitor distinguishing blocked from busy

### Peer parity round three, wave two (1.61) — round three closed

- [x] Tenant-wide agent directory with unique-name flagging and resident/cold status
- [x] Directed messaging outside family reach, privileged, tenant-bounded, ambiguity refused
- [x] Directed delivery reusing the family rate limits, pending caps and receipts
- [x] `inheritConversation` spawn that copies (never shares) the parent transcript
- [x] MCP `ttlMs` / `cacheScope` cache hints honoured, including `none`
- [x] MCP renumbered error codes named, unsupported revision remembered per endpoint
- [x] MCP Tasks extension: `tasks/get` polling with bounds, `tasks/update` input, failure surfaced
- [x] MCP `subscriptions/listen` stream, abortable and bounded, invalidating only the named cache
- [x] Per-request `logLevel` in `_meta`, tasks extension advertised, `serverInfo` captured

### Peer parity round four, wave one (1.62) — source-level comparison

- [x] `filesystem.glob` with base-relative patterns, newest-first ordering and bounded scanning
- [x] `filesystem.grep` with include filters, context lines, binary skipping and truncation reporting
- [x] Both refuse to follow symlinks out of the workspace and skip dependency/build directories
- [x] `filesystem.patch`: unified diff, verified context, all-or-nothing application, dry run
- [x] Verification recipe detection for Node, Python, Go, Rust, Maven, Gradle and Make
- [x] Package manager chosen from the lockfile rather than assumed
- [x] Verification runs through the sandbox with durable evidence and bounded output tails
- [x] First-failure stopping, and `verified` requiring that a build or test phase actually ran
- [x] `verify.recipe` / `verify.run` / `verify.evidence` plus REST and a Canvas verification row

### Peer parity round four, wave two (1.63) — language-server integration

- [x] LSP client over stdio: `Content-Length` framing with corrupt-frame tolerance, initialize handshake, whole-document sync
- [x] Version-based diagnostic freshness (never clock-based) and `ContentModified` retry like Hermes/OpenCode
- [x] Server discovery: TypeScript/JS (typescript-language-server), Python (pyright), Go (gopls), Rust (rust-analyzer)
- [x] Binary resolution from workspace `node_modules/.bin` first, then PATH; catalog explains what is missing
- [x] Sandboxed toolchain fallback: `tsc --noEmit`, `ruff`/read-only Python AST, `go vet`, `cargo check` JSON
- [x] Structured diagnostics `{path,line,column,severity,message,source,code}` with Hermes-style field sanitization
- [x] Durable content-addressed evidence: per-file SHA-256 digests, honest `fresh`/`stale`, bounded history
- [x] Symbols, definition and references via LSP with a dependency-free structural scanner fallback
- [x] Governed capabilities `code.catalog`, `code.diagnostics.run`, `code.diagnostics.evidence`, `code.symbols`, `code.definition`, `code.references`
- [x] REST surface under `/v1/sessions/:id/code*` and `/v1/sessions/:id/diagnostics`; Canvas Diagnostics row
- [x] LSP gated to the local sandbox backend by default; `HAF_CODE_INTELLIGENCE_LSP=false` forces toolchain

### Peer parity round four, wave three (1.64) — prompt-cache breakpoints

- [x] Derived cache plans per request: system, conversation prefix and message tail labeled stable/volatile
- [x] Digest-based stability (previous-plan SHA-256 comparison), honest `prefixHit`/miss verdict, no clocks
- [x] Hermes-style breakpoints: system end, last tool, last N non-system messages (default 2, max 4)
- [x] Correct cache scope: Aurora compacts in place, so physical session id is the scope; fork/delegate children stay isolated
- [x] Durable plan evidence with sequence numbers, bounded history (500), marker and char accounting
- [x] Anthropic provider places `cache_control` markers (system array form + TTL, last tool, text-bearing tail messages)
- [x] Automatic-caching providers (OpenAI-compatible, Gemini) unaffected
- [x] `session.cache.plan` (read) and `session.cache.config` (privileged, approval-gated) capabilities
- [x] REST `/v1/sessions/:id/cache/plan` and `/v1/sessions/:id/cache/config`; Canvas Cache row; engine `promptCache` defaults

### Phase6: Real-World Capabilities (1.65)

Security & quality audit closed (24 issues: 7 P0, 13 P1, 4 P2):

- [x] XSS prevention: `escapeHtml()` on all markdown renderers (App.tsx, ChatPanel.tsx)
- [x] Service Worker: API/auth endpoints no longer cached; network-only with 503 offline fallback
- [x] Tenant authorization bypass closed with `validateTenant()` on aurora routes
- [x] Duplicate `setErrorHandler` removed from main.ts
- [x] Fake system task executors replaced with real service calls
- [x] Nodemailer downgraded to ^7.0.5 (DoS fix)
- [x] Rate limiter trusts `X-Forwarded-For` only when `TRUST_PROXY=true`
- [x] Playwright port aligned to 5173
- [x] Adaptive Router learned rules influence route scoring
- [x] XSS test cases added
- [x] Sandbox Windows support (`cmd.exe` detection)
- [x] FileSystem cross-platform path normalization
- [x] `.editorconfig` for whitespace management
- [x] CI: Windows matrix + Playwright E2E job

Phase6 new services (9 services, 76 endpoints):

- [x] **MultimodalService** (`/v1/multimodal/*`) — OCR, document analysis, image/video/audio understanding, CAD/3D parsing, map/spatial analysis, time series analysis
- [x] **ConnectorService** (`/v1/connectors/*`) — Email, Calendar, CRM, ERP, Accounting, Customer Support, Sales, Social Media, Warehouse, IoT integrations
- [x] **ComputerUseService** (`/v1/computer-use/*`) — Browser/desktop automation, visual grounding, safe form filling, long-running task rollback
- [x] **CodePipelineService** (`/v1/pipeline/*`) — Issue → plan → branch → implement → test → security review → PR → CI → deploy chain
- [x] **ResearchEngineService** (`/v1/research/*`) — Multi-source search, trust scoring, citation verification, contradiction analysis, report generation
- [x] **DigitalTwinService** (`/v1/digital-twin/*`) — User project/tool/workflow/constraint/preference context with learning history
- [x] **DomainExpertService** (`/v1/domain-experts/*`) — Law, Finance, Health, Tax, Compliance experts with source-showing, controlled modes
- [x] **FederatedService** (`/v1/federated/*`) — Local model management, edge node management, data policies, air-gap mode
- [x] **AgentSDKService** (`/v1/sdk/*`) — Third-party extension framework with sandbox execution, signature verification, review system

- [x] All 9 services integrated into engine.ts (imports, fields, constructor, initialize)
- [x] 76 API routes with Zod validation and tenant isolation
- [x] All services use `DurableJsonState` for persistence
- [x] API documentation: `docs/API.md`

## Required for full target parity

These were the explicitly tracked engineering items for the original 1.0 target; every checked item below has implementation and test/build evidence:

### OpenHands-derived experience plane

- [x] Server-side multi-backend registry with credential references and health checks
- [x] Embedded control center for sessions/chat/tree/events/goals/autonomy/children/approvals/automations/schedules/providers/backends/search/metrics
- [x] React/Vite Canvas application integrated against HAF BFF contracts
- [x] Conversation, terminal, files/editor, browser/computer-use, tree, changes and automations panels
- [x] Multi-backend registry stored server-side
- [x] Secure Electron shell and electron-builder packaging targets
- [x] Declarative automation manifests (plugin setup manifests remain)
- [x] Browser CSP and no persistent browser token storage
- [x] Encrypted HttpOnly web session, CSRF and OIDC/PKCE SSO flow

### Prime-derived runtime depth

- [x] Detached resident worker processes that survive control-plane shutdown
- [x] Descriptor/socket-based supervisor adoption with per-worker authentication
- [x] Private binary worker transport and attachment-local backpressure/resync
- [x] Generation/sequence replay with chunked snapshot fallback
- [x] Launch-manifest worker respawn with same worker ID/home and snapshot rehydration
- [x] Retained child registry and child transcript rehydration after worker-process death
- [x] Full in-file session tree navigation, labels, active leaf and context-reset compaction
- [x] Kernel process hosted in hardened Docker when Docker sandbox profile is selected
- [x] PostgreSQL events/snapshots/journals/distributed leases and NATS event/command transport

### Hermes-derived capability breadth

- [x] Signature/secret and allowlist-protected inbound Telegram/Discord/Slack/WhatsApp/Signal/Matrix adapters
- [x] Browser/CDP automation and browser-scoped computer-use workers
- [x] OpenAI-compatible voice STT/TTS
- [x] Provider profile catalog beyond OpenAI-compatible
- [x] Modal, Daytona, Vercel and Kubernetes serverless sandbox gateway adapters
- [x] Vault KV v2 and KMS envelope credential backends; network policy carried to cloud sandbox gateway
- [x] Persistent BM25-style full-text plus vector hybrid retrieval
- [x] Remote Skills Hub catalog, hash verification, safe tar extraction, quarantine, scan and audit
- [x] Content-free fleet status/alert API and Control Center alert counters
- [x] Hosted scale-to-zero scheduler relay with JWT fire verification and at-most-once ledger

### Production governance

- [x] OPA/Rego policy service with layered decisions, redaction and fail-closed transport
- [x] Vault KV v2 and pluggable KMS envelope integration
- [x] Application tenant RBAC with resource-derived tenant checks
- [x] Optional PostgreSQL RLS policies and tenant-scoped transaction helper
- [x] Signed out-of-process WASI plugin runner with capability/hook registration
- [x] Automatic command eval, signed release, canary promotion and rollback
- [x] Separate adversarial security and worker/persistence chaos CI suites

## Current-upstream delta audit (2026-08-18)

The original 1.0 target matrix above is complete, but all three upstreams continued to evolve. The stricter current-upstream audit is in [`upstream-gap-audit-2026-08-18.md`](upstream-gap-audit-2026-08-18.md).

Delivered in 1.1:

- [x] Native Gemini GenerateContent provider with tool/usage normalization
- [x] Explicit per-session provider fallback chains with no replay after partial output
- [x] Same-provider credential rotation, cooldown/disable classification and secret-free status
- [x] Intent-preserving, non-destructive context projection
- [x] Durable dependency-aware task board and Canvas Tasks panel
- [x] Versioned JSON/Markdown transcript export
- [x] Bounded raster image generation and workspace artifact materialization
- [x] Digest-pinned Singularity/Apptainer sandbox adapter

Delivered in 1.2:

- [x] Durable PostgreSQL/file agent inbox with LISTEN/NOTIFY wake-up, `auto`/`steer`/`follow_up`, family reach, receipts, rate/pending limits and explicit uncertain claims
- [x] Generation-fenced, request-deduplicated and cancellation-aware Python host protocol v2
- [x] Same-origin SSRF-guarded Streamable HTTP MCP, timeouts, circuit breaker and dynamic tool refresh
- [x] Native OpenAI Responses API provider mode with server-side storage disabled
- [x] Confined single-source image editing
- [x] Normalized Brave/Tavily web-search providers and `web.search`
- [x] Canvas family roster, inbox warning and family message composer
- [x] Privacy-preserving `haf.trajectory.v1` training export with structured tool records
- [x] Bounded SHA-256-verifiable binary attachments and Canvas upload workflow
- [x] Evidence-validated continual-harness refinement batches with governed candidates, history, promotion tracking and batch rollback

Delivered in 1.3:

- [x] Typed sandbox-aware Git status/diff/branch/create/switch/commit capabilities and Canvas controls
- [x] Forced composite TypeScript builds that always re-emit excluded distribution directories
- [x] Environment-referenced MCP mutual TLS with bounded PEM validation and strict certificate verification
- [x] Persistent content-only MCP schema cache and administrative inspection API
- [x] Persistent audience-bound server-side model configurations and Canvas Models manager

Delivered in 1.4:

- [x] Tenant-scoped persistent agent profiles with immutable per-session versions and Canvas management
- [x] Supplemental profile instructions plus default model/fallback routes
- [x] Capability allowlists enforced across model tools, normal broker execution and nested Python host calls
- [x] Profile inheritance across child agents and forks

Delivered in 1.5:

- [x] Broker-encrypted MCP OAuth state/tokens, Authorization Code + PKCE and dynamic client registration persistence
- [x] Short-lived state-validated OAuth callback coordination and pending-flow cleanup
- [x] Environment-referenced OAuth client credentials and Canvas MCP manager

Delivered in 1.6:

- [x] Human-gated MCP form/URL elicitation with tenant isolation and bounded schema validation
- [x] Elicitation list/resolve APIs, restart/timeout expiration and Canvas response cards
- [x] No-content persistence for elicited values
- [x] Native Azure OpenAI deployment provider with API-key audience isolation
- [x] Native Vertex AI Gemini provider with OAuth bearer authentication

Delivered in 1.7:

- [x] Native AWS Bedrock Converse provider with standard AWS credential chain
- [x] Workspace-confined multimodal image message parts with MIME/hash validation
- [x] Native image projection for OpenAI/Azure/Anthropic/Gemini/Vertex/Bedrock
- [x] Canvas image chips and privacy-preserving image trajectory metadata

Delivered in 1.8:

- [x] Pluggable FAL text-to-video and confined image-to-video generation
- [x] Bounded MP4/WebM materialization with remote URL opt-in and SSRF revalidation
- [x] `video.generate`, media BFF endpoints and Canvas Media panel

Delivered in 1.9:

- [x] Model-planned evidence-bound continual-harness review with strict JSON contracts
- [x] Optional single-flight turn-interval review cadence and durable review history
- [x] Manual planning APIs and Canvas Learning governance workflows
- [x] Candidate-only output with no self-promotion or immutable prompt mutation

Delivered in 1.10:

- [x] Bounded HTTPS repository bootstrap with SSRF/redirect/size/timeout controls
- [x] Exact-origin credential leases and ephemeral askpass with no token URL/argument disclosure
- [x] Verified HEAD, failure cleanup, optional branch/profile selection and Canvas import UX

Delivered in 1.11:

- [x] Signed-plugin `context_projection` contract with immutable system/user intent boundaries
- [x] Fail-safe fallback for invalid/timed-out context engines
- [x] Additive bounded `memory_context` provider contract preserving local memory

Delivered in 1.12:

- [x] SHA-256-pinned command/1Password/Bitwarden secret-source registry
- [x] Clean environment, bounded execution and metadata/reference/value redaction
- [x] Credential Broker import, CRUD/refresh APIs and Canvas Secrets manager

Delivered in 1.13:

- [x] Workspace-confined bounded native channel media loading
- [x] Telegram/Discord/Slack/WhatsApp/Matrix/Signal media delivery and signed webhook envelopes
- [x] Media upload/ID flows, captions/thread routing and no-secret result projection

Delivered in 1.14:

- [x] Tenant-scoped priority channel routing rules with hashed identifiers
- [x] Per-chat/per-user/per-thread lanes and immutable agent-profile assignment
- [x] Routing CRUD, outbound media BFF and Canvas Channels management

Delivered in 1.15:

- [x] Restart-resumable in-flight MCP OAuth using expiring Credential Broker-encrypted transport descriptors
- [x] State-derived callback lookup without plaintext callback maps, plus duplicate callback serialization
- [x] Success/denial/expiry cleanup and graceful process-replacement suspension
- [x] Exact authorization-server origin allowlists with SSRF checks and redirect denial

Delivered in 1.16:

- [x] Packaged deterministic rolling micro-compaction ahead of intent-preserving projection
- [x] Exact user/system preservation, recent-tail protection and hash-bound untrusted derived summaries
- [x] Atomic bounded tenant/session observer cache with cache-hit telemetry and corruption fallback
- [x] Hash/shape-only tool-result summaries without copied tool values

Delivered in 1.17:

- [x] One-external-provider memory orchestration while local governed memory remains active
- [x] Native Honcho cross-session summaries, user representations, peer cards and post-turn synchronization
- [x] Transcript-free per-turn untrusted context injection with exact original user-message preservation
- [x] Governed Honcho profile/search/context/reason/conclusion capabilities
- [x] Content-free delivered/uncertain write journal with no automatic uncertain replay
- [x] Exact-origin SSRF/redirect-hardened SDK transport and content-free status API

Delivered in 1.18:

- [x] Native ChatGPT Codex subscription provider using device OAuth and rotating refresh tokens
- [x] Restart-persistent encrypted pending/auth/cooldown state with content-free status/logout APIs
- [x] Account-specific live model catalog and hot `openai-codex:model` route activation
- [x] First-party headers, Harmony-token neutralization, SSE text/reasoning/tool/usage projection
- [x] Exact-origin/manual-redirect transport and no retry/fallback after partial output
- [x] Canvas device login, authorization polling and account-model picker

Delivered in 1.19:

- [x] Dedicated remote `haf-client` application with TUI, one-shot and JSON-RPC stdio modes
- [x] Environment-only bearer auth, exact-origin REST, redirect denial and bounded JSON/error transport
- [x] Reconnecting SSE with monotonic cursor, duplicate suppression, backoff and abortable unsubscribe
- [x] JSON-RPC session/command/event/approval surface with standard error contracts
- [x] Live TUI text/tool/status events, multiline input, session/model/control and approval commands
- [x] Bounded stdin prompts with no prompt or credential command-line flags

Delivered in 1.20:

- [x] Native Mattermost, LINE Messaging, Google Chat, Microsoft Teams and Feishu/Lark outbound adapters
- [x] Mattermost and Feishu bounded native media upload/message flows
- [x] Mattermost/Google thread, Teams chat/channel and Feishu reply routing contracts
- [x] Explicit media rejection where a platform lacks safe direct binary upload
- [x] Manual redirect handling, bounded responses and credential-shaped error redaction across channel HTTP
- [x] Environment registration and Canvas adapter auto-discovery

Delivered in 1.21:

- [x] Tenant-scoped hosted GitHub/GitLab account records with Credential Broker secret references
- [x] GitHub user/installation and GitLab membership repository discovery
- [x] Normalized pull-request/merge-request metadata
- [x] Exact-provider-metadata hosted import through the existing bounded askpass clone path
- [x] Persistent session/repository links and read-only local/imported/remote HEAD sync status
- [x] Exact API/clone origin, SSRF/redirect/response bounds and no-token registry/list surfaces
- [x] Canvas hosted account/repository bootstrap controls

Delivered in 1.22:

- [x] Up to eight confined image and four video reference images with aggregate bounds
- [x] Multi-reference feature negotiation and native OpenAI multipart/FAL data-URI projection
- [x] Native FAL image generation/edit and 2x/4x upscale providers
- [x] Standalone `image.upscale` and optional generate→upscale provenance chains
- [x] PNG/JPEG/GIF/WebP dimension parsing and requested-scale enforcement
- [x] Multi-reference/upscale REST, capabilities and Canvas Media controls

Delivered in 1.23:

- [x] Restart-persistent asynchronous video job manager and native FAL Queue provider
- [x] Explicit lifecycle including `uncertain` submission/cancellation outcomes
- [x] Hashed idempotency keys and no automatic uncertain-effect replay
- [x] Content-free registry with no prompt/workspace/input bytes/credentials/provider URLs
- [x] Exact queue URL construction, bounded status/result parsing and validated MP4/WebM materialization
- [x] Job capabilities, REST list/submit/poll/cancel and Canvas controls

Delivered in 1.24:

- [x] Inbound Mattermost, LINE, Google Chat, Teams and Feishu/Lark routing endpoints
- [x] LINE raw-body HMAC and Feishu replay-bounded signature verification
- [x] Exact-origin bounded cached JWKS verification for Google Chat/Teams
- [x] Issuer/audience validation plus platform sender/conversation allowlists
- [x] Event-ID command idempotency and asynchronous outbound response delivery
- [x] Challenge/ignored event handling and content-free error logging

Delivered in 1.25:

- [x] Dedicated `haf-release` prepare/verify application
- [x] Deterministic source manifest with generated/runtime/secret/private-key exclusions
- [x] CycloneDX 1.5 and SPDX 2.3 SBOM generation from package-lock
- [x] in-toto Statement with SLSA provenance v1 and exact upstream materials
- [x] SHA-256 release metadata/artifact bundle and traversal-safe verification
- [x] Optional environment-only Ed25519 attestations with no private-key persistence
- [x] SOURCE_DATE_EPOCH reproducibility and tamper/signature/escape tests

Delivered in 1.26:

- [x] Hash-bound, workspace-confined HTML artifact registry and exact action allowlists
- [x] Opaque-origin script-only frames with network/form/object/base-denying CSP
- [x] Short-lived frame channels and frozen postMessage request/result bridge
- [x] Hidden artifact model turns omitted from public events/snapshots/exports/search/ACP/memory
- [x] Content-free interaction hashes/status journal and duplicate IDs
- [x] Canvas artifact manager and Electron subframe navigation restrictions

Delivered in 1.27:

- [x] Native FAL 2x/4x video upscaler and `video.upscale`
- [x] Workspace-confined bounded MP4/WebM source loading
- [x] MP4 tkhd and bounded WebM dimension extraction
- [x] Requested-factor verification with undersized/unverifiable output rejection
- [x] REST/capability/Canvas controls and verified width/height result metadata

Delivered in 1.28:

- [x] Governed GitHub PR / GitLab MR create, comment, close and merge operations
- [x] Session-bound capability/policy/approval/effect-journal routing for REST writes
- [x] Mandatory idempotency keys and content-free input/key hash journal
- [x] Explicit pending/succeeded/failed/uncertain external outcomes with no uncertain replay
- [x] Expected remote HEAD SHA required for merge with no deferred merge/branch deletion
- [x] Canvas hosted review controls and operation metadata APIs

Delivered in 1.29:

- [x] Restart-persistent GitHub App installation/setup state with app-authenticated installation verification
- [x] RS256 app JWT minting using current claim constraints and client-ID/app-ID issuer support
- [x] Credential-Broker-only private keys, raw installation IDs and expiring installation access tokens
- [x] Up to 25 private-key references with primary rotation, 401/403 failover and last-key disable guard
- [x] On-demand installation-token mint/refresh integrated into hosted catalogs/import/review operations
- [x] Raw-body SHA-256 webhook verification, multi-secret rotation and delivery deduplication
- [x] Installation/suspend/delete/repository/pull-request event lifecycle projections without payload persistence
- [x] GitHub App REST and Canvas registration/install/bind surfaces plus RSA/restart/rotation/webhook tests

Delivered in 1.30:

- [x] Native long-lived IRC/IRCv3 transport integrated with Channel Gateway and outbound capabilities
- [x] Public DNS and verified TLS defaults with bounded custom CA plus explicit private/plaintext switches
- [x] CAP 302, message-tags, server-time, account-tag, PING/PONG and TLS-only SASL PLAIN
- [x] Exact channel/nickname/account allowlists and confined authorized direct-message replies
- [x] Bounded protocol parser, CTCP/control stripping and 512-byte UTF-8-safe outbound splitting
- [x] Registration timeout, bounded in-flight turns and exponential jittered generation reconnect
- [x] Content-free long-lived status in REST/Canvas with no host/account/password projection
- [x] Real local TCP/TLS server tests for ingress/reply, SASL, reconnect and security guards

Delivered in 1.31:

- [x] TLS-first SMTP outbound with fixed from-address and exact destination confinement
- [x] Implicit TLS or mandatory STARTTLS, public DNS checks and bounded custom CA support
- [x] Persistent read-only IMAP polling with UIDVALIDITY and restart-safe UID cursor
- [x] Mandatory sender/recipient allowlists plus constant-time `X-HAF-Email-Token`
- [x] Bounded MIME header/encoded-word/multipart/base64/quoted-printable parser
- [x] Attachment omission, email loop suppression and explicit untrusted-data fencing
- [x] Content-free inbound/reply journal with no replay after uncertain SMTP outcomes
- [x] Reply threading, engine lifecycle, REST/Canvas status and SMTP/IMAP/MIME/security tests

Delivered in 1.32:

- [x] Native outbound and signed asynchronous inbound Twilio SMS
- [x] Exact E.164 sender/recipient allowlists, fixed from number and AccountSid binding
- [x] Exact public URL plus sorted-form HMAC-SHA1 `X-Twilio-Signature` verification
- [x] Immediate TwiML acknowledgment and MessageSid command idempotency
- [x] Content-free processing/responding/done/failed/uncertain SMS journal
- [x] Duplicate suppression and no reply replay after ambiguous REST outcomes or restart
- [x] Exact Twilio API boundary, redirect denial, response caps and header-only Basic auth
- [x] REST/Canvas lifecycle status and signed/tamper/dedupe/uncertainty/redaction tests

Delivered in 1.33:

- [x] Bounded authenticated GitHub/GitLab file reads for automation manifests
- [x] Explicit 15-minute plan followed by exact content-SHA apply
- [x] Create/update/unchanged/disable reconciliation with managed provenance
- [x] Fixed tenant session, admin webhook-secret reference and exact model allowlist authority
- [x] Strict 100-entry JSON schema with schedule/cron/ref/path/traversal validation
- [x] Branch-movement rejection between plan and apply
- [x] Content-free source state and explicit succeeded/failed/partial restart semantics
- [x] REST/Canvas source/plan/apply controls and full reconciliation/security tests

Delivered in 1.34:

- [x] Generic tenant-scoped OIDC Authorization Code + PKCE model credential sources
- [x] Operator-registered public/confidential clients without third-party client impersonation
- [x] Exact issuer/discovery/authorization/token/JWKS origin and SSRF boundaries
- [x] Verified ID-token signature, issuer, audience, expiry, nonce and subject projection
- [x] Broker-encrypted PKCE/pending/access/rotating-refresh/discovery state
- [x] Exact model resource-origin audience binding and tenant-aware model configurations
- [x] Dynamic bearer provider materialization with one pre-output-only 401/403 refresh
- [x] REST/Canvas source login/logout/lifecycle and route binding plus OAuth security tests

Delivered in 1.35:

- [x] Restart-persistent same-provider cooldown, disable, failure and last-use state
- [x] Content-free pool files keyed by runtime and opaque credential IDs only
- [x] Removed-entry ignore and clean state for newly configured credential IDs
- [x] Explicit one/all credential reset through system-admin REST and Canvas
- [x] No implicit bypass of active provider retry windows after restart
- [x] Custom-origin `provider`/`aggregator`/`local` data-policy labels
- [x] Tenant-aware configuration inventory with visible data-policy metadata
- [x] Cooldown/disable/reset/redaction/stale-entry/data-policy tests

Delivered in 1.36:

- [x] Tenant automation responder deployments bound to exact webhook automations
- [x] Broker-referenced responder secrets with rotation and no list disclosure
- [x] Raw-body timestamp/nonce HMAC-SHA256 and persistent replay prevention
- [x] Content-free heartbeat health, version, capability and instance projection
- [x] Immediate event admission plus asynchronous automation dispatch
- [x] Event-ID duplicate suppression and processing/delivered/failed/uncertain journal
- [x] Restart/unknown-outcome no-replay semantics and exact event-type authority
- [x] Public responder routes, admin REST/Canvas lifecycle and security tests

Delivered in 1.37 — Aurora PDF Phase A:

- [x] Complete 125-page Aurora PDF feature audit and phased HAF roadmap
- [x] Prime/council/specialist role hierarchy with custom/micro roles
- [x] Profile binding, retirement guards and no parent-authority escalation
- [x] Durable task marketplace with capability-tag bids and deterministic award score
- [x] Daily token reservation/use accounting and concurrent task governor
- [x] Isolated specialist child execution and event-evidence-bound outcomes
- [x] Role reputation updates from verified quality/success
- [x] Quorum consensus preserving confidence, abstention, dissent and uncertainty
- [x] Governed society capabilities, REST and Canvas Society panel

Delivered in 1.38 — Aurora PDF Phase B:

- [x] Sourced typed cognitive objects and durable Global Workspace queue
- [x] Confidence/importance/urgency/impact/user-relevance priority scoring
- [x] Constitutional P0-P4 goals and conflict-preserving arbitration
- [x] Daily attention token budget, reservations, focused slots and defer semantics
- [x] Reactive/tactical/strategic horizons and explicit object lifecycle
- [x] Reactive/research/development/reflection/dream/emergency mode state machine
- [x] Hash-only repeated-iteration loop detection and automatic blocking
- [x] Governed cognitive capabilities, REST and Canvas Cognitive panel

Open current-upstream deltas:

- [x] Provider-specific OAuth wire/conformance modes beyond delivered generic OIDC/PKCE and Codex/MCP lifecycles
- [x] Additional media providers beyond OpenAI/FAL and provider-specific quality/conformance environments
- [x] Additional packaged memory providers beyond Honcho and optional auxiliary-model summaries
- [x] Broader OpenHands plugin settings and hosted responder provisioning beyond delivered signed responder health/events
- [x] Rich desktop profile/window management beyond delivered isolated artifact frames
- [x] Advanced TUI widget parity plus reusable/i18n Canvas package
- [x] Additional stateful transports/providers beyond delivered IRC/IRCv3, SMTP/IMAP email and Twilio SMS
- [ ] External-infrastructure conformance matrix and signed native installers

Open Aurora PDF phases:

- [x] Phase B core: first-class cognitive objects, Global Workspace, attention budgets, cognitive modes, P0-P4 arbitration and loop detection
- [x] Phase B extensions: automatic event intake, interruption/preemption, constitution checker and cognitive-health diagnostics
- [x] Phase C: typed memory pyramid, temporal relation graph, contradiction health and thought anchors
- [x] Phase D: entity/state/relation/event world model, multi-perspective debate and scenario calibration
- [x] Phase E: proactive initiative scoring, silence/attention budgets, digests and governed user-model feedback
- [x] Phase F: capability-gap/friction detector, multidimensional skill reputation, composition and retirement
- [x] Phase G: environment inventory, action-object verification links and digital habit/project awareness

## Definition of “complete”

The target is complete only when the acceptance criteria from
[`reference-analysis.md`](reference-analysis.md) are automated and green. Feature
names or empty adapters do not count as delivery.
