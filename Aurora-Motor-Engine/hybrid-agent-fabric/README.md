# Hybrid Agent Fabric

A single, durable agent engine combining the strongest architectural ideas from:

- **OpenHands Agent Canvas:** control-center UX, backend abstraction and ACP interoperability.
- **Prime Agent:** supervisor/session ownership, replay, idempotency, persistent RLM and subagents.
- **Hermes Agent:** governed capabilities, sandbox adapters, channels, MCP, memory, skills and security posture.

This repository is a new implementation, not a claim that three multi-million-line products can be safely concatenated. The engine is built around explicit control-plane, runtime-plane and execution-plane contracts so integrations can be ported without recreating a monolith.

## Project status

Three documents describe what this system actually does. They are **generated
from the code** by `npm run docs:state -w @haf/eval`, and a test fails if they
drift, because the repo previously accumulated 27 hand-written
"PHASE NN COMPLETED ✅" files that were false within days of being written.

| Document | Answers |
|---|---|
| [`CURRENT_STATE.md`](CURRENT_STATE.md) | What works right now, measured |
| [`MATURITY_MATRIX.md`](MATURITY_MATRIX.md) | Per module: implemented → integrated → exercised → verified → production |
| [`KNOWN_GAPS.md`](KNOWN_GAPS.md) | What is missing, confirmed by command rather than impression |

A feature is only `completed` when five things hold: code exists, it is on a
real execution path, tests cover it, an eval measures it, and its failure
behaviour is defined. Missing any one of those, it is `implemented` — not
`completed`. Feature counts are not progress; wired-up depth is.

Claims in this README are scoped accordingly: read the maturity matrix before
treating any subsystem name as a promise about its mechanism.

## Current milestone — 1.65.0

Phase6: **Real-World Capabilities**. Nine new services adding multimodal understanding, real-world
connectors, computer use automation, full SDLC pipeline, research engine, digital twin, domain
experts, federated/edge computing and an agent SDK. 76 new API endpoints. 24 security/quality
issues resolved (7 P0, 13 P1, 4 P2). See [`PHASE6-FEATURES.md`](PHASE6-FEATURES.md).

> The numbers above are a historical record, not a measurement: they are copied
> from the hand-written Phase6 report (`PHASE6-FEATURES.md:46`) and the
> security report (`SECURITY-FIXES.md:181`), and no command reproduces either of
> them. They are the only numbers in this README with no source, which is why
> they are labelled. For anything measured — test counts, module depth, maturity
> levels, open gaps — read the three generated documents in
> [Project status](#project-status); those are regenerated from the code and a
> test fails if they drift.

Previous milestone: **prompt-cache breakpoints**. Every assembled request now gets a derived
cache plan — stable system prefix, stable conversation prefix and volatile tail, with Harness-style
internal markers (system end, last tool, last two messages) — and the plan is durable evidence with an
honest `prefixHit`/miss verdict computed from content digests, so a session can say exactly what it
paid for and why. `AnthropicProvider` places the markers; providers with automatic caching ignore the
hint. Governance: `session.cache.plan` / `session.cache.config`; REST under
`/v1/sessions/:id/cache*`; Canvas Cache row.

Previous wave: **code intelligence** — a real Language Server Protocol client (diagnostics, symbols,
definition, references) per workspace, same shape as Hermes `agent/lsp/*`, with a sandboxed toolchain
fallback (`tsc --noEmit`, `ruff`/Python AST, `go vet`, `cargo check`), structured and sanitized
diagnostics and durable content-addressed evidence. Governance: `code.catalog`, `code.diagnostics.run`,
`code.diagnostics.evidence`, `code.symbols`, `code.definition`, `code.references`; REST under
`/v1/sessions/:id/code*`; Canvas Diagnostics row.

The current code is a **working integrated runtime and control-center foundation**, not yet full current-upstream feature parity with all three products. The exact re-audit against their 2026-08-18 default branches is recorded in [`docs/upstream-gap-audit-2026-08-18.md`](docs/upstream-gap-audit-2026-08-18.md).

### Maturity legend

Names in this repository are held to what the code actually does. The
authoritative, machine-checked record is
[`packages/engine/src/experimental/maturity.ts`](packages/engine/src/experimental/maturity.ts)
(29 modules: 7 stable, 16 beta, 6 experimental), enforced by
`maturity-registry.test.ts`.

| Label | Meaning |
|---|---|
| **Implemented** | Real behaviour, wired into the engine, covered by tests |
| **Beta** | Works and is wired, but the name promises more than it delivers; the shortfall is written in `gapToStable` |
| **Experimental** | Structure and persistence are real; the *doing* part raises a named `…NotImplemented` / `…Unavailable` error rather than faking a result |

Experimental subsystems do not pretend. For example, extension execution throws
`ExtensionSandboxUnavailableError` instead of returning `{ success: true }` —
it previously did the latter, which made never-executed extensions report a
100% success rate.

**Experimental — scaffolding real, execution not wired:**

- **code pipeline**: the SDLC chain is modelled and persisted; six of eight stages raise `CodePipelineStageNotImplementedError` until real backends exist
- **real-world connectors**: registration, credential refs and policy are real; connector *actions* (e.g. `listEmails`) throw pending a configured provider
- **computer use**: step planning and rollback bookkeeping are real; individual steps throw pending a driver
- **digital twin**: context modelling is real; there is no simulation/prediction loop yet
- **domain experts**: routing and disclosure controls are real; there are no specialised expert backends
- **federated/edge**: node and policy management are real; there is no parameter aggregation across nodes
- **agent SDK**: registry, publish lifecycle, instances and permissions are real; execution throws until an isolate is wired

**Implemented and tested:**

- multimodal service: OCR, document analysis, image/video/audio understanding, CAD/3D parsing, map/spatial analysis, time series analysis
- research engine: multi-source search, source trust scoring, citation verification, contradiction analysis, report generation
- unified execution loop: one real path from goal to verified outcome, with `succeeded` / `unverified` / `unavailable` / `skipped` kept distinct
- gap detection and capability acquisition: a missing tool is named, synthesised, verified in a Worker isolate against known-good cases **and known-bad decoys**, then retried on the original task
- verification factory: V1 formal, V2 empirical and workspace-acceptance verifiers; absent evidence reports `uncertain`, never `pass`
- durable session actor and supervisor
- process-safe stale-lock-aware session leases
- append-only event store with generation/sequence metadata
- snapshots and reconnectable REST/SSE replay
- command idempotency journal and explicit uncertain outcomes
- effect journal preventing silent replay of non-idempotent side effects
- mock, OpenAI-compatible Chat Completions, native OpenAI Responses, ChatGPT Codex subscription, Anthropic and Gemini providers
- explicit per-session fallback chains with no replay after partial output
- same-provider credential pools plus persistent audience-bound server-side model configurations
- OpenAI, Azure OpenAI, AWS Bedrock, Anthropic, OpenRouter, Google AI Studio, Vertex AI, Groq, xAI, DeepSeek, Mistral and Ollama profiles
- policy/approval-controlled capability broker
- prompt-cache planner: derived breakpoints per request, digest-verified hit/miss evidence, Anthropic markers, privileged session config
- language-server code intelligence: stdio LSP client (diagnostics, symbols, definition, references) with sandboxed toolchain fallback and durable content-addressed diagnostic evidence
- confined text/binary filesystem, bounded multimodal attachment upload, typed local Git operations and process capabilities
- local, hardened Docker and digest-pinned Singularity/Apptainer sandbox adapters
- persistent Python kernel with JSON-safe snapshots
- generation-fenced, cancellation-aware `haf.call(...)` host bridge from Python
- persistent child-agent admission, family roster, durable messaging and inherited least-privilege agent profiles
- persistent goals, bounded autonomous continuation and quality gates
- durable dependency-aware task board with model capabilities and Canvas panel
- packaged rolling micro-compaction plus intent-preserving projection that never silently drops older user instructions
- bounded HTTPS bootstrap plus hosted GitHub/GitLab account discovery, review metadata and linked sync status
- native GitHub App installation lifecycle with broker-confined RSA keys/installation IDs/tokens, rotation and verified webhooks
- per-session provider:model switching
- durable once/interval/cron scheduler
- declarative manual/schedule/webhook automations with run ledger and timeout cancellation
- server-side multi-backend registry and health checks
- candidate/promote local memory plus optional Honcho cross-session user modeling with bounded per-turn recall/writeback
- tenant-scoped cross-session search
- quarantined, scanned and hashed skill registry
- stdio and guarded Streamable HTTP MCP with restart-resumable broker-encrypted OAuth/PKCE coordination
- normalized channel gateway with authorization, message-id deduplication and tenant profile-routing rules
- Native bidirectional channel routing/verification for Telegram, Discord, Slack, WhatsApp, Matrix, Signal, Mattermost, LINE, Google Chat, Teams, Feishu/Lark and signed webhooks
- long-lived TLS-first IRC/IRCv3 with CAP, message tags, account/nickname allowlists, SASL and reconnect generations
- TLS-first SMTP/IMAP email with shared-header verification, durable UID cursors, bounded MIME and uncertain-reply journals
- signed bidirectional Twilio SMS with exact E.164 allowlists, MessageSid dedupe and uncertain-reply protection
- plan/apply hosted Git automation manifests with exact content hashes, bounded authority and managed provenance
- generic OIDC/PKCE model credentials with encrypted refresh rotation, exact resource audiences and pre-output-only retry
- restart-persistent same-provider cooldown/disable state plus explicit custom-route data-policy labels
- signed external automation responder heartbeats/events with health, dedupe and uncertain no-replay journals
- Aurora Society roles, task marketplace, reputation/resource budgets and dissent-preserving council consensus
- Aurora Global Workspace cognitive objects, P0-P4 goal arbitration, attention budgets, modes and loop detection
- Aurora automatic workspace intake, preemptive attention, reflection/Dream scheduling, curiosity queue and cognitive health checks
- Aurora Agent Communication Bus and meta-agent monitoring with evidence-bound role retirement
- Aurora memory pyramid, typed relation graph, consolidation, contradiction/staleness health and long-term thought anchors
- Aurora world model entities/states/relations/events, causality, temporal windows, Brier-scored prediction calibration and bounded simulation
- Aurora twelve-perspective Multi-World Model with debate, scenario future trees, reality alignment and dissent-preserving consensus
- Aurora Proactive Initiative Engine with worthiness scoring, P0-P4 attention budget, silence rules, digests and trust feedback
- Aurora governed user cognitive model with consent, correction, deletion, advice effectiveness and protected-topic refusal
- Aurora staged skill/workflow evolution with gap detection, evidence gates, regression protection, retirement and evolution index
- Aurora environment inventory, zone 0-4 action records with mandatory verification/rollback and tool execution reputation
- Aurora constitutional identity core with versioned mission, governed amendments and a deterministic decision checker
- Aurora Continual Harness: reviewable, snapshotted, rollback-capable self-improvement of prompts, memories, skill and sub-agent specs
- Aurora microagent knowledge with trigger activation, recall budgets and injection-screening quarantine
- Aurora escalation-only risk analyzer with destructive-pattern rules, confirmation policy and safe-zone hints
- Aurora model-free stuck detection over the event log, feeding cognitive intake and capability-gap learning
- Aurora ACOS control loop with cycle reports, thought journal and whole-organism status
- Aurora decision records with weighted criteria, preserved dissent, review scheduling and calibration
- Aurora dependency-ordered plans with critical path, verification steps and auditable replanning
- Aurora experience distillation: reusable lessons proposed from real trajectories, never auto-applied
- Aurora fleet supervision: explicit enrollment, fair bounded sweeps, per-tenant failure isolation and a circuit breaker
- Aurora terminal operations: an allowlisted read-only CLI surface plus bounded actions in the headless client
- Aurora execution bridge: ready plan steps delegated to society roles with recorded match evidence and evidence-bound completion
- Aurora role authority templates: least-privilege capability allowlists bound to society roles, with drift audit
- Aurora outcome harvesting: delegated work scored from recorded events, with an explicit review band for ambiguity
- Aurora plan feedback: decision outcomes derived from finished plans, so calibration reflects execution
- Aurora estimation calibration: plan estimates corrected by measured durations, applied as auditable revisions
- Repository instruction files (AGENTS.md/CLAUDE.md) with injection screening, precedence and budgeting
- Deterministic lifecycle hooks that can deny at the capability boundary and only run governed actions
- Tool search over the capability catalog for progressive disclosure
- Named permission modes (plan, manual, acceptEdits, auto, dontAsk, bypass) and sandbox modes per session
- Session archive/restore with an honest cost surface, and repository command templates
- Deterministic working-tree review and declarative subagent files resolved onto profiles and roles
- Per-session effort levels that move both provider reasoning and harness budgets, and deliberate git worktrees
- Signed artefact manifests with Ed25519 publisher keys, version pinning and per-agent lifecycle hooks
- Layered settings with provenance and an immovable managed floor, plus structured questions to the human
- MCP 2026-07-28 stateless client with server/discover, routing headers, cacheable listings and multi round-trip requests
- Background task control (monitor, stop, resume) and model-callable plan mode with an evidence requirement
- Long-running background shells with cursor-based output retrieval, honest loss reporting and a kill switch
- Reviewed automatic approvals: named rules with a stored rationale, a use budget, expiry and a full decision log
- Child-agent fan-out limits (concurrency, depth, lifetime) and per-command memory/CPU/file/process limits
- Approval previews that cannot hide the command or destination, plus enforced session spend budgets
- Tenant-wide agent directory with privileged cross-family messaging, and conversation-inheriting spawn
- MCP 2026-07-28 in full: cache hints, named error codes, the Tasks extension and subscription streams
- Workspace glob and grep primitives, all-or-nothing unified-diff patching
- Project verification that runs the repository's own build and tests and keeps the evidence
- Aurora autopilot: bounded unattended cadence with a durable run ledger
- Aurora provenance explainer reconstructing why any artifact exists
- Embedding-backed semantic memory recall
- Aurora workspace checkpoints with reversible restore, giving destructive work a real recovery path
- Content-free Aurora telemetry, derived operational alerts and a cross-store integrity self-check
- Whole-tenant and per-user Aurora export plus governed user purge with stated retention
- Aurora governance enforced at the capability boundary: evidence-driven, escalation-only, audited
- AES-256-GCM/Vault/KMS credential brokers, scoped leases and pinned 1Password/Bitwarden/command secret sources
- SSRF-checked bounded public web fetch and normalized Brave/Tavily web search
- Playwright/CDP browser automation and browser-scoped computer-use
- SSH sandbox with strict host verification and rsync workspace synchronization
- workspace-confined speech-to-text and text-to-speech
- bounded multi-reference image/video, verified upscaling and restart-persistent asynchronous media jobs
- versioned JSON/Markdown and privacy-preserving training trajectory export
- governed learning, model-planned evidence-bound refinement reviews, candidate promotion and rollback
- content-free Prometheus and OTLP/HTTP operational metrics
- ACP-compatible adapter plus dedicated remote TUI, one-shot and JSON-RPC/stdio headless client
- typed plugin hooks plus user-preserving context-engine and additive memory-provider transforms
- REST control API, multi-panel embedded control center, isolated interactive artifacts and live Server-Sent Events
- deterministic CycloneDX/SPDX SBOM, in-toto/SLSA provenance, checksums and optional Ed25519 release attestations

See [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) for the exact completed and remaining scope.

## Architecture

```mermaid
flowchart LR
  CLIENTS[Canvas · CLI · Channels · ACP] --> API[Control API]
  API --> SUP[Supervisor]
  SUP --> SESSION[Session Actor]
  SESSION --> MODEL[Model Router]
  SESSION --> KERNEL[Persistent Python Kernel]
  SESSION --> BROKER[Capability Broker]
  BROKER --> POLICY[Policy + Approval]
  BROKER --> SBOX[Local · Docker · Singularity · Remote Sandboxes]
  BROKER --> MCP[MCP Servers]
  SESSION --> EVENTS[(Event Log + Snapshots)]
  SESSION --> CHILDREN[Child Agent Family]
  SCHED[Durable Scheduler] --> SUP
  CHANNELS[Channel Gateway] --> SUP
  SESSION --> MULTI[Multimodal Service]
  SESSION --> CONN[Connector Service]
  SESSION --> COMP[Computer Use]
  SESSION --> PIPE[Code Pipeline]
  SESSION --> RES[Research Engine]
  SESSION --> TWIN[Digital Twin]
  SESSION --> EXPERT[Domain Experts]
  SESSION --> FED[Federated/Edge]
  SESSION --> SDK[Agent SDK]
```

## Security model

> [!WARNING]
> `HAF_SANDBOX_BACKEND=local` is a trusted-development backend. It confines the working directory used by built-in file tools, but a shell/Python process running as your OS user is **not** a security sandbox.

For untrusted repositories or prompts:

- use the Docker/gVisor/Kata/VM execution profile;
- keep sandbox network disabled or route it through an allowlist proxy;
- never inject long-lived provider credentials into the kernel;
- keep `HAF_API_TOKEN` set before exposing the API;
- require explicit approvals for process/network/external side effects.

The engine treats prompt instructions, approval regexes and file-tool denylists as defense in depth, not as the security boundary.

## Requirements

- Node.js 20+
- Python 3.10+
- Docker when `HAF_SANDBOX_BACKEND=docker`
- Apptainer/Singularity when `HAF_SANDBOX_BACKEND=singularity`

## Install and run

```bash
npm install
cp .env.example .env
npm run check

# Development mode. Environment values can be exported or loaded by your shell.
HAF_API_TOKEN=local-secret \
HAF_AUTO_APPROVE_WORKSPACE=true \
HAF_ALLOW_PROCESS=true \
npm run dev
```

Control API: `http://localhost:8787`.

`HAF_AUTO_APPROVE_WORKSPACE` and `HAF_ALLOW_PROCESS` are convenience switches for a trusted development machine. Leave them false for the normal approval workflow.

## First session

```bash
TOKEN=local-secret
SESSION=$(curl -sS -X POST http://localhost:8787/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"local","name":"first-agent"}')

SID=$(printf '%s' "$SESSION" | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["sessionId"])')

curl -sS -X POST "http://localhost:8787/v1/sessions/$SID/commands" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantId":"local",
    "kind":"session.prompt",
    "source":"api",
    "payload":{"text":"Inspect this workspace"}
  }'
```

Live events:

```bash
curl -N "http://localhost:8787/v1/sessions/$SID/events/stream?afterSequence=0" \
  -H "Authorization: Bearer $TOKEN"
```

### Mock-provider tool calls

The deterministic mock provider recognizes this test syntax:

```text
[tool filesystem.write {"path":"hello.txt","content":"hello"}]
```

It is used by integration tests to prove the model → policy → approval/effect journal → capability → event flow without spending model tokens.

## Approval flow

When policy returns `require_approval`, the command remains pending while the control plane stays responsive:

```bash
curl -sS http://localhost:8787/v1/approvals \
  -H "Authorization: Bearer $TOKEN"

curl -sS -X POST http://localhost:8787/v1/approvals/APPROVAL_ID/resolve \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"decision":"approve_once"}'
```

Decisions: `approve_once`, `approve_session`, `deny`.

## Persistent Python/RLM

The model-facing capability is `python.execute`. State survives calls and JSON-safe values are snapshotted:

```python
items = [1, 2, 3]
sum(items)
```

Governed host actions use the bridge:

```python
haf.call("filesystem.write", {
    "path": "result.txt",
    "content": str(sum(items)),
})
```

The bridge re-enters the same policy, approval, idempotency and audit pipeline as a normal model tool call. Protocol v2 binds every host request to a kernel generation, execution ID, per-execution token and request ID. Duplicate request IDs replay the prior response; cancellation or timeout kills the synchronous kernel and aborts in-flight host capabilities so late frames cannot regain authority.

## MCP

Connect a stdio MCP server:

```bash
curl -X POST http://localhost:8787/v1/mcp/servers/stdio \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"my-server",
    "command":"npx",
    "args":["-y","@example/mcp-server"],
    "defaultRisk":"network"
  }'
```

Discovered tools become namespaced capabilities such as `mcp.my-server.search`; they do not bypass policy.

Streamable HTTP servers use `/v1/mcp/servers/http`. Credentials are referenced by environment-variable name rather than accepted as raw API values:

```json
{
  "name": "remote-tools",
  "url": "https://mcp.example.com/mcp",
  "bearerTokenEnvironmentVariable": "REMOTE_MCP_TOKEN",
  "tlsCertificatePathEnvironmentVariable": "REMOTE_MCP_CERT_PATH",
  "tlsPrivateKeyPathEnvironmentVariable": "REMOTE_MCP_KEY_PATH",
  "tlsCaPathEnvironmentVariable": "REMOTE_MCP_CA_PATH",
  "defaultRisk": "network"
}
```

OAuth variant:

```json
{
  "name": "oauth-tools",
  "tenantId": "local",
  "url": "https://mcp.example.com/mcp",
  "oauth": {
    "clientIdEnvironmentVariable": "REMOTE_MCP_CLIENT_ID",
    "clientSecretEnvironmentVariable": "REMOTE_MCP_CLIENT_SECRET",
    "scopes": ["mcp:tools"],
    "authorizationServerOrigins": ["https://login.example.com"]
  }
}
```

Remote MCP enforces public HTTPS, the configured MCP origin plus explicitly allowlisted OAuth origins, no redirects, no URL query credentials, bounded tool timeouts and a circuit breaker. Tool-list change notifications update projected capabilities transactionally and persist a content-only schema cache. Optional mutual TLS reads certificate/key/CA paths from environment-variable references, validates bounded PEM, keeps material out of API/list responses and uses strict server verification.

OAuth-enabled servers use Authorization Code + PKCE through the same endpoint by adding an `oauth` object. State, verifier, access/refresh tokens, dynamic client registration, discovery data and the short-lived pending transport descriptor are encrypted by the credential broker. With a persistent master key, Vault or KMS, `/auth/mcp/callback` can reconstruct and complete an in-flight authorization after control-process replacement; duplicate callbacks are serialized and one-time state is cleared on success, denial or expiry. Client IDs/secrets are referenced through server environment variables, cross-origin authorization/token servers require an exact `authorizationServerOrigins` allowlist, and the browser receives only the authorization URL. Tokens and pending credentials never enter cookies, localStorage, session snapshots, schema caches or API lists.

Connected MCP clients advertise bounded form and URL elicitation. Requests create a five-minute human promise visible in Canvas and `/v1/mcp/elicitations`; nothing is auto-filled or auto-accepted. Forms are reduced to primitive fields with strict required/type/enum/range validation, URL requests must resolve to public HTTP(S), and the user explicitly accepts, declines or cancels. Submitted form values are passed only to the waiting MCP transport and are never persisted in elicitation metadata, session transcripts, model context or schema cache.

## Remote TUI and headless client

Build and run the dedicated API client:

```bash
npm run build -w @haf/headless-client
HAF_URL=https://haf.example.com HAF_API_TOKEN=... haf-client tui
```

`haf-client rpc` exposes JSON-RPC 2.0 over newline-delimited stdio for session
create/get/list, prompts, generic commands, event subscriptions and approval
resolution. Subscription notifications carry the durable event sequence and
reconnect from the last observed cursor without replaying duplicates.

One-shot automation reads prompt content from bounded stdin and emits one JSON
result:

```bash
printf '%s' 'inspect the repository and run tests' | \
  HAF_URL=https://haf.example.com HAF_API_TOKEN=... haf-client run --name ci-run
```

The TUI supports `/new`, `/load`, `/sessions`, `/multi`, `/model`,
`/pause`, `/resume`, `/cancel`, `/compact`, `/approvals`, `/approve`, `/deny`
and live text/tool/status events. `HAF_API_TOKEN` is accepted only through the
environment; credentials and prompt text are intentionally not accepted as
process arguments. REST and SSE requests are exact-origin, redirect-denying and
bounded. Configuration keys are `HAF_URL`, `HAF_API_TOKEN`, `HAF_TENANT` and
`HAF_CLIENT_TIMEOUT_MS`.

## ACP mode

Run the engine as an ACP JSON-RPC/stdio agent:

```bash
npm run acp
```

Supported methods in this milestone:

- `initialize`
- `session/new`
- `session/load`
- `session/prompt`
- `session/cancel`
- `session/close`

HAF-specific state is emitted under `_meta["ai.hybrid-agent-fabric"]` so standard ACP clients can ignore it safely.

## Channel webhook

Set a separate webhook token:

```bash
export HAF_WEBHOOK_TOKEN=webhook-secret
```

Then send a normalized channel message:

```bash
curl -X POST http://localhost:8787/v1/channels/webhook/telegram \
  -H 'x-haf-webhook-token: webhook-secret' \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantId":"local",
    "chatId":"123",
    "chatType":"dm",
    "userId":"456",
    "messageId":"789",
    "text":"hello"
  }'
```

Platform message IDs become command idempotency keys. Raw chat and user IDs are hashed in persisted route metadata.

`channel.send` accepts an optional confined `mediaPath`. HAF resolves the file
only at delivery time, refuses symlink/workspace escapes, caps it at 25 MiB and
recognizes raster image, MP4/WebM, MP3/M4A/OGG/WAV and PDF magic bytes. Telegram,
Discord, Slack, WhatsApp, Matrix, Signal, Mattermost and Feishu use native
upload/message contracts; signed webhooks receive an exact HMAC-covered base64
media envelope. LINE, Google Chat and Teams reject direct binary media rather
than inventing a public artifact URL. Mattermost thread roots, Google Chat
threads, Teams `chat:<id>` / `channel:<team>:<channel>` destinations and Feishu
reply IDs are supported. Shared channel HTTP handling rejects redirects, bounds
responses and redacts credential-shaped provider errors. Provider credentials
stay in adapter closures and are never embedded in payloads or capability
results.

Tenant administrators can define priority inbound routing rules matching
platform, chat type, exact chat/user IDs and bounded metadata. IDs are hashed
before rule/route persistence. Rules select per-chat, per-user or per-thread
session lanes and may freeze a tenant agent profile into newly admitted channel
sessions. Existing routes remain stable. `/v1/channel-routing-rules` and the
Canvas Channels panel manage rules; the same panel sends explicit text/media via
the selected outbound adapter.

### Long-lived IRC/IRCv3

Set `IRC_HOST`, `IRC_NICKNAME`, `IRC_CHANNELS` and at least one of
`IRC_ALLOWED_NICKNAMES` / `IRC_ALLOWED_ACCOUNTS` to activate the native IRC
transport. It participates in the same Channel Gateway lanes, frozen profile
routing, model turns and outbound `channel.send` adapter as webhook platforms.
The adapter performs IRCv3 CAP negotiation for message tags, server time and
account tags, answers PING immediately, joins only configured channels and
limits concurrent inbound turns.

TLS with normal certificate verification is the default. A bounded PEM CA bundle
may be referenced with `IRC_TLS_CA_PATH`. Private-address infrastructure requires
`IRC_ALLOW_PRIVATE_HOST=true`; plaintext additionally requires
`IRC_ALLOW_PLAINTEXT=true` and is rejected whenever PASS or SASL credentials are
configured. DNS is resolved before every connection and every returned address
must satisfy the selected public/private policy.

Optional `IRC_SASL_ACCOUNT` plus `IRC_SASL_PASSWORD` enable SASL PLAIN only over
verified TLS. Credentials remain in the transport closure and are absent from
status, session, model and persistence surfaces. Nickname or authentication
failure blocks reconnect until operator intervention; ordinary transport loss
uses bounded exponential jitter and increments a connection generation.

Inbound channel, nickname/account and direct-message targets are exact allowlists.
CTCP and IRC formatting controls are removed or rejected. Outbound text is split
on UTF-8 code-point boundaries into frames no larger than IRC's 512-byte wire
limit, destination-confined and rate-spaced. A successful socket write is
reported as accepted (`202`), not exactly-once delivery. `/v1/channels/adapters`
and Canvas expose content-free long-lived state, generation, TLS, joined-channel
counts and bounded error codes.

### TLS-first SMTP/IMAP email

`EMAIL_SMTP_*` enables outbound email through implicit TLS or mandatory STARTTLS.
The from address is fixed server-side; destinations must match an exact recipient
or authorized-sender allowlist. Text and already-confined `channel.send` media
bytes are handed to Nodemailer with URL/file access disabled. Header fields,
message IDs, filenames, body size and recipient count are independently bounded.
SMTP acceptance is reported as `202`; transport ambiguity is never described as
exactly-once delivery.

Optional `EMAIL_IMAP_*` keeps a TLS/STARTTLS IMAP connection open, selects one
read-only mailbox and polls a bounded UID range. First boot defaults to `latest`
so an existing mailbox is not replayed; `EMAIL_INITIAL_SYNC=all` is an explicit
bootstrap option. UIDVALIDITY and the last handled UID are stored without email
content. Mailbox replacement starts at its current tail rather than replaying an
unrelated UID namespace.

Inbound email must satisfy all three checks before dispatch: exact sender
allowlist, exact configured recipient, and a constant-time matching
`X-HAF-Email-Token` header. Auto-submitted/bulk/list messages and mail from the
configured HAF address are ignored to prevent loops. Subject/body are wrapped as
untrusted email data; sender IDs and subjects are hash-projected in routing
metadata.

The built-in bounded MIME parser handles folded headers, encoded words,
multipart nesting, base64 and quoted-printable text. MIME depth/part/header/body
and source bytes are capped; attachment bytes are omitted from model context.
Inbound state stores only UID/event/sender hashes and explicit
`processing/responding/done/ignored/failed/uncertain` outcomes. If a process
stops after a reply may have entered SMTP, the event becomes uncertain and that
reply is not automatically replayed. `/v1/channels/adapters` and Canvas show only
content-free UID/outcome/generation counters.

### Signed Twilio SMS

`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` and exact
`TWILIO_ALLOWED_NUMBERS` enable native outbound SMS. Requests use Twilio's
form-encoded Messages endpoint, fixed `From`, E.164 validation, exact API-origin
checks, manual redirects and bounded JSON responses. Basic credentials remain in
the Authorization header. Workspace media is rejected rather than converted to
an implicit public MMS URL.

Inbound SMS uses `/v1/platforms/twilio/webhook`. `TWILIO_WEBHOOK_URL` must equal
the exact public HTTPS URL configured at Twilio; HAF never reconstructs it from
an untrusted Host/proxy header. Before acknowledging, HAF verifies
`X-Twilio-Signature` in constant time over that URL plus the case-sorted decoded
form fields, binds `AccountSid`, requires the configured recipient number and an
exact sender allowlist, and validates MessageSid/body/media-count bounds.

The route immediately returns empty TwiML after verification and durable
admission. Agent work continues asynchronously through Channel Gateway, with
MessageSid as command idempotency. A content-free journal stores only event and
phone projections plus `processing/responding/done/failed/uncertain`. Duplicate
webhooks do not dispatch or reply again. State is written as `responding` before
outbound SMS; restart or any ambiguous REST outcome becomes `uncertain` and is
never automatically replayed. REST/Canvas status shows only counts.

## Durable schedules

```bash
curl -X POST http://localhost:8787/v1/schedules \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"tenantId\":\"local\",
    \"sessionId\":\"$SID\",
    \"prompt\":\"Run the periodic check\",
    \"schedule\":{\"kind\":\"cron\",\"expression\":\"0 9 * * 1-5\",\"timezone\":\"Europe/Istanbul\"}
  }"
```

The next occurrence is advanced durably before prompt dispatch, preventing an uncertain fire from being replayed after a crash.

## Commands

```bash
npm run dev        # control API
npm run acp        # ACP stdio adapter
npm run build
npm run typecheck
npm test
npm run check      # typecheck + tests
npm run eval:gates # acceptance gates: criteria, baseline, learning, recall lock
```

## Repository layout

```text
apps/control-api/       REST + SSE control plane
apps/acp-server/        ACP JSON-RPC/stdio adapter
packages/engine/        runtime, policy, tools, memory, scheduler, channels, MCP
python/kernel_server.py persistent Python protocol process
var/                    local durable state and workspaces
docs/adr/               architecture decisions
```

## License and upstream relationship

MIT. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). This is currently an independent implementation informed by the three upstream repositories. Any later verbatim source port must retain the upstream copyright/license header.

## Provider profiles and per-session switching

Set `HAF_MODEL_PROVIDER` to `openai`, `openai-responses`, `openai-codex`, `azure-openai`,
`aws-bedrock`, `anthropic`, `openrouter`, `google`, `vertex`, `groq`, `xai`, `deepseek`,
`mistral` or `ollama`. The corresponding standard
credential variable is resolved only by the server-side provider registry.

```bash
HAF_MODEL_PROVIDER=anthropic \
ANTHROPIC_API_KEY=... \
HAF_MODEL_NAME=claude-sonnet-4-5-20250929 \
npm run dev
```

When several standard key environment variables are present, their providers
are registered concurrently. Select a model for one session with the
`model.select` command and a `provider:model` value. Provider keys are held in
provider closures and never persisted in session snapshots or passed to the
Python kernel. `google` uses Gemini's native GenerateContent API rather than the
OpenAI compatibility endpoint. `azure-openai` uses Azure's deployment-scoped
`api-key` endpoint; set `HAF_MODEL_BASE_URL` to the Azure resource endpoint and
`HAF_MODEL_NAME` to the deployment name. `vertex` uses native Gemini
GenerateContent with a server-side `GOOGLE_VERTEX_ACCESS_TOKEN` and requires a
full Vertex publisher base URL ending at `/publishers/google`. `aws-bedrock`
uses the native Bedrock Converse API and the standard AWS credential chain
(environment, profile, workload/instance role); it never accepts model API-key
pools. Set `HAF_MODEL_NAME` to the Bedrock model/inference-profile ID and
`HAF_MODEL_REGION` or `AWS_REGION` to the target region.

`openai-codex` is the native ChatGPT subscription route, not the public OpenAI
API. Start device authorization from the Canvas Models panel or
`POST /v1/model-auth/codex/start`, enter the returned code at OpenAI, then poll
`POST /v1/model-auth/codex/poll`. Access and rotating refresh tokens, pending
device state, expiry and cooldown are Credential Broker-encrypted. The account
catalog is read from `GET /v1/model-auth/codex/models`; HAF does not invent or
silently substitute model slugs. `POST /v1/model-auth/codex/activate` hot-adds
the selected `openai-codex:<model>` route. Requests use the confirmed Codex
Responses SSE contract, exact first-party origin/header set, Harmony-token
neutralization and no body-level token. One pre-output 401 can refresh/retry;
once any model event is emitted there is no retry or fallback.

### Generic OIDC model credentials

`HAF_MODEL_OAUTH_REDIRECT_URI` enables tenant-scoped model credential sources
through `/v1/model-oauth-sources` and the Canvas Models panel. Sources use OIDC
Authorization Code + PKCE S256 and require an operator-registered client ID. HAF
does not embed or impersonate another product's public OAuth client. Public
clients use `none`; confidential clients reference an existing Credential Broker
secret and explicitly choose `client_secret_basic` or `client_secret_post`.

Registration pins an HTTPS issuer, exact authorization-server origins, scopes
(including `openid`), and exact model resource origins. Discovery must return the
same issuer; authorization, token and JWKS endpoints are rechecked against the
allowlist and SSRF policy. Redirects are forbidden. State, PKCE verifier, nonce,
discovery metadata, access/rotating refresh tokens and account subject stay in
Credential Broker-encrypted state. ID tokens are verified for signature, issuer,
audience, expiration and nonce; status exposes only a one-way subject projection.

A model configuration may set `credentialOAuthSourceId` instead of an environment
key. Its base URL origin must be one of that source's explicit resource origins.
At model-call time HAF obtains or refreshes the bearer token and materializes the
same provider profile dynamically. One 401/403 may force refresh and retry only
if no model event has been emitted; once text, reasoning, tool or usage output
starts, there is no retry or fallback replay. Source disable/logout/removal makes
bound routes unavailable without exposing token values.

Configure an explicit fallback chain with `HAF_MODEL_FALLBACKS`, or pass
`fallbackModels` with `model.select`:

```json
{
  "kind": "model.select",
  "payload": {
    "model": "anthropic:claude-sonnet-4-5-20250929",
    "fallbackModels": ["google:gemini-pro-latest", "openai:gpt-4.1-mini"]
  }
}
```

Fallback never crosses providers unless listed, and never restarts after partial
model output. `HAF_MODEL_API_KEYS_JSON` configures a same-provider credential
pool. Pool status exposes opaque IDs/cooldowns only, never key material.

Same-provider pool health is persisted under content-free runtime state. A 401/403
disables only the rejected credential; retry-class failures store bounded
exponential/provider cooldowns. Failure count/code and last-use time survive
process replacement, while raw keys never enter the state file. Credentials no
longer present in the configured pool are ignored on restore; new IDs start
clean. System administrators can reset one or all entries with
`POST /v1/providers/:providerId/credentials/reset`, and Canvas Models exposes the
same explicit reset. Active cooldown windows are never bypassed implicitly.

Every custom model origin must now declare `dataPolicy` as `provider`,
`aggregator`, or `local`; built-in origins inherit their profile's label. The
label is persisted and shown in tenant-aware route inventories so an explicit
fallback cannot hide that it crosses a provider/data-residency boundary.

System administrators can persist custom routes through `/v1/model-configurations`
or the Canvas Models panel. Records contain provider/model/base URL and
environment-variable references only. A credential used with a custom endpoint
requires an exact `credentialAudienceOrigin` match, preventing a standard
provider key from being silently sent to another origin. Configurations can be
hot-enabled, disabled, removed and selected per session as
`model-<uuid>:model-id`.

## Agent profiles

Tenant administrators can create versioned profiles through `/v1/agent-profiles`
or the Canvas Profiles panel. A profile freezes supplemental instructions,
default model/fallback routes and an optional exact capability allowlist into
each new session. Updating or deleting the source profile never mutates already
running sessions.

Capability restrictions are enforced in three places: model tool projection,
normal tool dispatch and nested Python `haf.call(...)`. Child agents and session
forks inherit the parent's frozen profile, so delegation cannot recover hidden
capabilities. Profiles may specialize behavior but cannot weaken policy,
approvals, effect journals, sandbox or credential isolation.

## Aurora architecture map

[`docs/aurora-architecture.md`](docs/aurora-architecture.md) is the single reference for the Aurora
system: every architectural layer with the service, capability, REST surface and test that implements
it, where each constitutional invariant is enforced, the on-disk state layout, and the end-to-end
journey test that carries one signal from observation to explained, verified action.

## Aurora Agent Society

The 125-page Aurora architecture is tracked in
[`docs/aurora-pdf-feature-audit.md`](docs/aurora-pdf-feature-audit.md). Phase A
adds an organizational substrate above the existing Prime supervisor rather than
replacing it. Each tenant receives Aurora Prime, seven executive directors and
the research/coding/debug/architecture/planning/reflection/creativity/
opportunity/risk/communication/guardian/project/knowledge/simulation/skill
specialists described by the PDF. Roles carry bounded capability tags,
reputation and optional tenant agent-profile bindings; Prime synthesizes and
cannot be retired.

The durable task marketplace accepts a root session, objective, required tags,
priority, deadline and token ceiling. Active roles bid with confidence, token and
time estimates. Awarding is deterministic over tag coverage, reputation,
confidence and relative cost, while daily token reservations and concurrent-task
limits fail closed. Execution spawns an isolated child session with the role's
purpose and profile. A role profile may narrow parent authority but cannot add a
capability outside the parent's frozen allowlist.

Task completion requires real child-session event IDs. Verified quality updates
the assigned role's reputation, releases reserved tokens and records actual use;
failed tasks lower reputation rather than relying on self-reported success.
Council deliberations require a declared role set and quorum. Each role submits
approve/reject/abstain, confidence, summary and evidence references. Resolution
weights confidence by role reputation, preserves every perspective/dissent and
returns `uncertain` when the decisive margin is too small instead of fabricating
consensus.

Governed `society.*` capabilities and `/v1/society/*` REST routes expose roles,
budgets, marketplace tasks and deliberations. Spawning a specialist remains a
privileged capability and crosses normal policy/approval/effect-journal paths.
Canvas includes a Society panel for tasks, bids, awards, execution, reputation,
budget and council outcomes.

The Phase A extension adds the Agent Communication Bus: an active role publishes
a bounded topic/body message to named roles or to the whole society, recipients
read their own inbox and acknowledge, and retention is capped per tenant.
Meta-agent monitoring reports stalled or past-deadline work, duplicate
objectives, unbid tasks, failing or never-used roles, budget saturation and
concurrency starvation, each with a concrete recommendation. Role lifecycle
governance can retire non-builtin roles whose evidence-bound failure rate crosses
a policy threshold, but never Prime, never a builtin director and never a role
with running work.

## Aurora Global Workspace and cognitive control

Aurora PDF Phase B introduces first-class cognitive objects rather than treating
every thought as transient chat text. Observation, problem, hypothesis, insight,
risk, opportunity and decision objects carry source type/ID, confidence,
importance, urgency, impact, user relevance, reactive/tactical/strategic horizon,
goal relation, tags, relations and bounded token/time requests. Objects remain in
a durable Global Workspace queue until explicit attention allocation.

Tenant cognitive goals use constitutional P0–P4 classes. Arbitration always
ranks the class before importance × urgency × user relevance, so a high-scoring
research goal cannot silently outrank user safety. Near-equal goals in the same
class are preserved as conflicts. Object attention priority additionally uses
importance × urgency × impact × confidence × user relevance and the goal-class
weight.

The Attention Allocation Engine reserves a daily token budget and one of a
bounded number of focused slots. Objects that do not fit are marked deferred,
not dropped. Completion releases reservations and records actual use; day
rollover clears stale reservations and safely requeues focused work.

The cognitive state machine supports reactive, research, development,
reflection, dream and emergency modes through an explicit transition graph and
durable reason/history. Arbitrary transitions fail closed. Thought iterations
store SHA-256 only; three consecutive identical results block the object and
release attention, preventing infinite reasoning loops without persisting raw
iteration output.

Governed `cognitive.*` capabilities and `/v1/cognitive/*` routes expose goals,
objects, attention, modes, arbitration and loop records. Privileged goal,
attention and mode changes still cross policy/approval. Canvas's Cognitive panel
shows the Global Workspace, priorities, confidence, horizons, focused/deferred
state, daily budget and operating mode.

The Phase B extension closes the loop between the environment and the workspace.
`cognitive.intake` accepts automatic signals from memory, the world model, the
society, the environment or the initiative engine, deduplicates them for six
hours, enforces a daily intake quota and records only a SHA-256 digest of each
signal. Preemptive allocation lets a constitutionally higher-ranked object
reclaim a focused slot; the preempted thought returns to the queue with its
reservation released rather than lost. Focus can be interrupted explicitly,
mini/deep/meta/Dream-Mode reflections can be scheduled but only in a compatible
cognitive mode, the curiosity queue ranks low-confidence high-impact questions,
and `cognitive.health` reports repeated loops, focus overruns, stale strategic
work, unsourced high-confidence claims, budget saturation and constitutional
violations.

## Aurora memory pyramid and temporal knowledge graph

Aurora PDF Phase C adds the Memory Object standard above the existing candidate/
active `MemoryStore`: every object carries ID, timestamps, pyramid layer
(working, session, episodic, semantic, procedural, user, palace), claim type
(observation, inference, hypothesis, prediction), source type/ID, confidence,
importance, tags, evidence references and a temporal validity window. Identical
content reinforces the existing object instead of duplicating it.

Typed relations (`relates`, `causes`, `supports`, `contradicts`, `part-of`,
`derived-from`, `precedes`) form the knowledge graph, strengthen with repetition
and support bounded traversal. Recall is multi-strategy — semantic, graph,
temporal, goal-scoped and user-scoped — and records usage so memory health can
detect unused knowledge.

Consolidation compresses near-duplicate episodes into one summary object,
archives (never silently deletes) the sources, links them with `derived-from`
edges and strengthens surrounding relations. Contradiction detection flags
overlapping claims with opposite polarity, supersession preserves history, and
`memory.graph.health` reports staleness, contradictions, low usage, low
confidence, expiry and duplicate clusters. Long-term thought anchors keep an open
problem alive for months with findings, next steps and scheduled reviews.
Privacy deletion (`forget`) removes the object and every edge that referenced it.

## Aurora world model and Multi-World Model

Phase D represents reality as Entity → State → Relation → Event → Outcome. State
facts are temporal: a new value closes the previous validity window instead of
overwriting it, so `world.state.at` answers "what did Aurora believe at that
time" and `world.temporal.view` returns past, present and open predictions.
Entities carry a scope so the personal, environment, digital, project, human and
goal sub-models from the PDF are queryable views rather than separate stores.

Causal links are assertions, not truths: every confirmation or refutation
recomputes their confidence. Predictions are falsifiable, are scored with Brier
loss when resolved, expire when their horizon passes unanswered and feed a
calibration report with probability buckets. The consistency engine surfaces
conflicting current claims, and simulation/counterfactual branches project
bounded causal chains with explicit terminal probability and uncertainty without
writing any state.

The Multi-World Model seeds the twelve PDF perspectives (technical, economic,
risk, opportunity, human, strategic, security, scientific, creativity,
user-centric, time, complexity). A meta layer weights them by problem type and by
each perspective's own prediction reputation. Perspectives submit stance,
confidence, rationale, risks and opportunities, may formally challenge each other,
and can attach scenarios whose sibling probabilities cannot exceed 1, forming a
future tree with cumulative probabilities. Recording a scenario outcome scores
its endorsing perspectives with Brier loss. Consensus reports support/oppose/
neutral weight, agreement, uncertainty, dissenting and missing perspectives and
unresolved conflicts; close or contested calls resolve to `hold` or `uncertain`
rather than manufacturing agreement.

## Aurora proactive initiative and user model

Phase E treats silence as a feature. Intake events (memory, world model, git,
calendar, filesystem, weather, research, location, notifications, cognitive,
society, skill) are stored as summaries plus payload digests. Watchers convert
matching intake into initiative candidates. Each initiative is scored
`importance × urgency × impact × confidence × user relevance`, classified P0–P4
and routed to immediate, message, daily digest, weekly digest or archive.

Delivery is bounded by a daily attention budget, quiet hours, 24-hour duplicate
suppression and trust: unhelpful notifications lower the trust score, which
raises every threshold until Aurora earns the bandwidth back. Escalation is
explicit and audited, and daily briefings, weekly reviews and monthly strategic
reviews are built from digested initiatives. Queued initiatives are also mirrored
into the Global Workspace, so proactive work competes for the same attention
budget as every other cognitive object instead of bypassing it.

The user cognitive model is a behavioural twin, not surveillance. Claims are
typed, evidence-backed and confidence-scored; inferred claims stay `proposed`
until confirmed or consented; users can correct (with auditable history),
retract, deny consent or delete everything, per category or entirely. Protected
topics — health, belief, politics, ethnicity, sexuality and credentials — are
rejected at write time. The model also tracks long/medium/short goals with
progress and stall detection, behavioural signals, an explicitly
uncertainty-labelled state estimate, frustration risk, a growth timeline, advice
effectiveness and guardian alignment checks against the user's own goals.

## Aurora skill and workflow evolution

Phase F makes capability growth measurable and refuses self-promotion. Repeated
friction, capability gaps, bottlenecks and error patterns are deduplicated by
signature and recommend a candidate only after recurrence or high severity.
Skills then walk a strictly staged path: blueprint → sandbox → test → beta →
production. Each gate needs evidence — declared tests and risks, recorded
evaluations, accuracy and safety floors, real beta usage, a regression baseline
and an explicit production approval actor and reason. Safety is remediable but
only through consecutive finding-free evaluations.

Scores are recomputed from evidence (accuracy, reliability, speed, utility,
safety and a composite), usage tracking reflects production behaviour, and the
composition graph prevents retiring a skill that active composites depend on.
Regression protection blocks promotion when any baseline suite loses ground.
Workflow versions record steps, duration, success rate and bottleneck, and the
Cognitive Evolution Index summarizes capability growth, quality, success rate,
gap closure and workflow improvement with a delta against the previous
measurement. Every change lands in the evolution journal.

## Aurora environment awareness and embodiment

Phase G inventories the digital body: filesystem, terminal, IDE, browser, Git,
databases, APIs, devices, cloud, calendar, channels, kernels, sandboxes and MCP
servers, each with a safe execution zone 0–4, capability IDs, approval
requirement and execution reputation. Repeated failures degrade a resource
automatically.

Every action is a standard record: goal, plan, action, parameter digest,
expected outcome, result, verification and the memory updates it produced. Zone
3+ actions require a rollback plan and approval before they can start;
verification is mandatory and tracked as debt when missing; unexpected outcomes
are flagged for the cognitive layer. Workspace habits are learned with observed
success rates, and continuous project awareness records open tasks, risks,
progress and stale projects for the project watcher. This layer records and
governs — execution itself still goes through the capability broker, policy
engine, sandboxes, credential broker and approval service.

## Aurora ACOS control loop

Every Aurora subsystem is durable and independently governed; ACOS is what makes them one organism.
`acos.cycle.run` executes one bounded tick — Observe, Update World, Prioritize, Allocate, Execute,
Evaluate, Learn, Remember, Reflect, Evolve — in `full`, `maintenance`, `reflection`, `dream` or
`emergency` mode. The cycle writes a durable report (phase results, attention allocation, health
scores, signal counts, recommendations) plus thought-journal entries, and a failing phase degrades the
cycle instead of aborting the organism.

The loop is wired to real signals, not just metrics: stuck sessions and stalled projects become
sourced cognitive objects, repeated-loop blocked thoughts become evidence-backed capability-gap
observations, expired predictions and contradictions are swept, initiatives are evaluated against the
attention budget and the harness is pruned. The cycle itself is constitution-checked, and it executes
nothing directly — every phase calls an already-governed service.

The cognitive economy splits the daily attention budget into named buckets (for example project 0.4,
research 0.25, user support 0.2). Allocation enforces each bucket's cap in addition to the global
budget and focus slots, reservations and consumption are accounted per bucket, and everything rolls
over daily.

`acos.status` returns the whole organism on one screen: identity version, cognitive mode and health,
attention budget, memory health, initiative trust, evolution index, environment inventory, society
advisories, constitutional compliance and the user-state estimate.

## Aurora context composition

All of this machinery only matters if it reaches the model. The Aurora context composer assembles one
bounded block that is appended to the session system prompt on every turn:

- `<AURORA_CONSTITUTION binding="true">` — mission plus principle summaries, governed system content;
- `<AURORA_HARNESS trust="reviewable-guidance">` — agent-authored lessons that explicitly cannot
  override policy, approvals or the constitution;
- `<AURORA_KNOWLEDGE untrusted="true">` — trigger-activated microagent documents, marked as data;
- `<AURORA_MEMORY untrusted="true">` — recalled memory-graph claims with their layer, type and
  confidence. Recall is embedding-backed: semantic similarity is blended with lexical overlap,
  importance, confidence and recency, and falls back to lexical scoring if the index is unavailable.

Each section has its own character budget, so a growing knowledge base can never crowd out the user's
own instructions; overflow is reported rather than silently dropped. Composition is fail-open (a
failing source degrades quality, never the turn), the block is SHA-256 digested for audit, and its
size/section count/digest appear in the context-projection stats of `model.request.started`. The whole
block can be tuned or disabled with the `auroraContext` engine option.

## Aurora constitution and identity core

Sixteen principles are seeded per tenant: the twelve cross-cutting rules extracted from the Aurora
architecture plus four ACOS operating principles, each with a stable code (`C1`–`C12`, `P1`–`P4`),
category and `hard`/`soft` severity. The Long-Term Identity Core holds the mission, an identity
version and an append-only continuity log.

`constitution.check` is a deterministic rule engine over declared decision attributes — destructive,
irreversible, external side effect, approval, evidence, rollback plan, verification, claim type,
confidence, user relevance, self-modification, staged evolution, dissent, budget. Hard violations deny,
soft violations require review, and every verdict is stored with the violated codes, remedies and an
attribute digest. Amendments require an approver, a reason and a version bump; built-in hard
principles can be clarified but never softened or retired — including by Aurora itself.

## Aurora Continual Harness

The harness is the scaffolding around the model — supplemental prompt notes, durable memories, skill
descriptions and sub-agent specifications — and Aurora may improve it from its own trajectory through
`harness.refine`. Refinements are batches (default maximum eight operations, rate-limited per day),
each one snapshots the affected scope first, records its trigger, rationale and evidence, and can be
rolled back by ID; newer refinements in the same scope must be rolled back first.

Entries carry origin, use count, helpful/unhelpful feedback and effectiveness, so `harness.prune`
removes agent-authored lessons that are unused or consistently unhelpful. Projection into a prompt is
character-budgeted and priority-ordered. The immutable base system prompt, policy engine, agent
profiles and capability allowlists are outside this surface by construction, so self-improvement can
never widen authority.

## Aurora microagents, risk analysis and stuck detection

Microagents are small knowledge documents that load themselves when relevant: `always`, `keyword`,
`glob` or `manual` activation, recall inside a character budget, effectiveness feedback and content
digests. Because knowledge is prompt content, every write is screened for instruction override, role
hijack, policy bypass, credential exfiltration, autonomy escalation and destructive instructions; a
finding quarantines the document until a named human reviewer clears it.

The risk analyzer scores a proposed capability call against eighteen built-in destructive-pattern
rules plus tenant rules, returning `low`/`medium`/`high`/`critical`, a confirmation requirement from
the tenant policy (`never`, `critical`, `high`, `medium`, `all`) and a safe execution zone hint. It is
escalation-only — it can require more scrutiny but never grants authority — and built-in critical
rules cannot be disabled.

Stuck detection is model-free analysis over the durable event log: repeated actions, repeated error
classes, two-capability oscillation, monologue, byte-identical output, approval starvation and fired
runtime guardrails, each with evidence event IDs. ACOS turns those findings into cognitive objects and
capability-gap observations, so being stuck becomes a learning signal instead of a silent stall.

## Aurora reasoning: decisions and plans

A decision record holds the options, the weighted criteria they were judged against, the dissent that
was raised, the option that was chosen, the expected outcome and — after the review window — what
actually happened. Ranking is computed, never asserted: choosing a lower-ranked option requires an
explicit override reason, a decision denied by the constitution cannot be recorded as decided, and a
"decision" with one option is rejected as a formality. Unscored criteria count as unknown rather than
zero, so a thin analysis cannot masquerade as a thorough one.

Calibration closes the loop. Every reviewed decision yields a surprise (expected value versus observed
value) and a Brier score for the stated confidence, and the tenant report exposes success rate, mean
surprise and **overconfidence** — how far Aurora's confidence runs ahead of its results, broken down by
reversibility class.

Plans are dependency graphs with per-step verification, estimates and risk. Cycles and unknown
dependencies are rejected at write time, the critical path and a risk-weighted buffer are computed,
steps cannot start before their dependencies are satisfied, and every change is a versioned revision
with a mandatory trigger and reason. Completed work survives replanning, estimate accuracy is measured
from actuals, and stalled plans with ready work become a proactive signal.

## Aurora experience distillation

After a substantial session, `experience.distill` reads the durable event log, measures complexity from
tool-call volume, capability diversity and duration, and proposes: the effective capability sequence as
a reusable procedure, recurring failure classes as pitfalls, and structural friction as capability
gaps. Every proposal carries evidence event IDs, a confidence and a dedupe signature, and repeats
strengthen the existing proposal instead of creating noise.

Nothing is applied automatically. Applying a proposal routes it through the service that owns that kind
of state: harness memories become a snapshotted, rollback-capable refinement; knowledge goes through
injection screening; capability gaps become evolution observations that still need the staged pipeline.

## Aurora autopilot

Unattended operation is opt-in and bounded. Cadences — pulse, maintenance, reflection, dream, daily
briefing, weekly review and monthly strategy — drive ACOS cycles and digests, subject to a daily run
ceiling, quiet hours during which only the fast pulse may run, per-cadence enable/disable and
exponential backoff on failure. Every run lands in a durable ledger with its outcome and duration, so
what Aurora did while nobody was watching is always reviewable.

## Aurora execution bridge

A plan that names work nobody is asked to perform is a document, not a system. The execution bridge
turns ready plan steps into society marketplace tasks and reconciles the results back into the plan.
Only steps the planner reports as ready may be delegated, so the dependency graph still decides what
can start. Role selection is deterministic — capability coverage, reputation and current load — and
the resulting score is stored on the link, so the reason a role was chosen is recorded rather than
narrated. The nomination bid says in plain words that it is machine-authored.

Completion is evidence-bound: a step becomes `done` because a society task completed and carried its
child session's event IDs back, not because anything asserted success. A failed task fails the step
and blocks the plan. Spawning the child session is a separate privileged capability, and unattended
delegation stays inert until a tenant enables it and names a root session.

## Aurora outcome harvesting

Delegation is only a loop if someone closes it. The harvester scores a settled child session from its
recorded events — assistant output, tool-call reliability, session health, guardrail trips, budget
adherence — as a stored scorecard with fixed weights, so every quality number can be recomputed from
the criteria that produced it. Nothing in flight is scored: a task is only judged once its session is
closed, failed, or idle and quiet.

A delegated failure is also the cheapest lesson the system ever gets: the work is done, the trajectory
is recorded and the verdict is evidence-bound. Failures and ambiguous outcomes become deduplicated
capability-gap observations and candidate lessons, with the weakest scoring criterion named. Successes
teach nothing here, and nothing is auto-applied.

Two refusals matter more than the scoring. A session that failed or produced no output is a failure
outright, not partial credit. And anything landing between the failure and success thresholds is
**not** recorded at all — it becomes a review item with a reason, because a system that guesses at its
own success rate poisons the calibration, reputation and evolution signals built on top of it. When a
human resolves a review item, the machine scorecard stays attached to their verdict.

## Aurora plan feedback

Calibration is only honest if outcomes are recorded, and outcomes recorded by hand are outcomes not
recorded at all. When a plan reaches a terminal state, Aurora derives the outcome of the decision that
produced it: how much of the plan genuinely finished, blended with the measured quality of delegated
work. It never overwrites a human verdict, never resolves a plan that is merely still executing (it
marks the decision executed instead), and supports a dry run that shows exactly what would be written.
Each record keeps its evidence, observed value, surprise and Brier score, so every calibration number
traces back to the execution behind it.

## Background tasks and model-callable plan mode

`tasks.monitor` shows what is running within a session's family reach - status, whether a turn is in
flight, usage, mode, effort and outstanding questions. `tasks.stop` separates `cancel` (end the turn)
from `close` (end the agent) and is ungated on purpose: stopping only reduces activity, and needing an
approval to halt a runaway agent would be backwards. `tasks.resume` sends a follow-up through the
durable inbox.

The agent can enter plan mode itself, because that only removes authority. Leaving requires approval
*and* evidence: a plan id or a summary of what the exploration produced, so exploration earns execution
rather than assuming it. A managed ceiling still caps where it can land.

## Search, patch and proof

`filesystem.glob` and `filesystem.grep` are the primitives a coding agent uses constantly: pattern match
and content search, bounded, dependency directories skipped, symlinks never followed out, truncation
reported, binary files named rather than dumped. `filesystem.patch` applies a unified diff with every
hunk's context verified against disk and **all files or none** — stale context is refused, not fuzzily
matched, because a half-applied patch is a silent corruption.

`verify.run` executes the project's *own* build and test commands — detected from its lockfiles,
manifests and script tables — and keeps the receipt: command, exit code, duration, output tail. It stops
at the first failure, and `verified` requires that something was actually run: a project with no checks
is `inconclusive`, never verified. `verify.evidence` is how an agent answers "prove it", and how a
reviewer finds out that it cannot.

## Agent directory and cross-family messaging

`agent.directory` lists every live agent in the tenant — name, status, depth, and whether the name is
unique — but listing is not permission. Messaging a child is ungated because the family tree *is* the
authorisation; `agent.message.direct` reaches an agent outside that tree and is privileged, because it
puts text into a session nobody here supervises. A tenant boundary is never crossed, an ambiguous name is
refused rather than guessed at, and delivery reuses the family path exactly, receipts included.

`agent.spawn` can also start a child from the parent's own conversation (`inheritConversation`), so
delegation stops meaning "re-explain everything you already know". The transcript is copied, never
shared: a child cannot rewrite its parent's history.

## Fan-out, resource and spend limits

Three ceilings that were missing. **Fan-out:** a session may hold 20 live children, the tree is one level
deep by default (a subagent does not spawn subagents unless an operator says so), and 200 spawns per
session over its life; the refusal names the limit, and `agent.fanout` lets an agent plan inside it.
**Resources:** every command carries memory, CPU-second, file-size and process limits applied as a
`ulimit` prefix in its own shell, so a runaway build cannot take the host down with the agent on it.
**Spend:** `SessionBudgetService` caps a session in dollars or tokens, warns before the wall, refuses new
turns at it without ever truncating a turn in flight, and reports `unpriced` rather than pretending a
money cap holds for a model with no price entry.

## Approval previews

The preview *is* the question being asked, so it cannot hide the answer. Decision-relevant fields —
command, path, url, host, target — are kept whole; when one must be shortened, both ends survive with the
omission stated inline, because a head-only cut removes exactly the dangerous tail. Credentials are
masked by key name and by value shape, every mask is counted, and non-decision keys are dropped first
with each one named. An approver may be shown less content, never less intent.

## Long-running shells

`shell.start` runs a build or a test suite that outlives the call and returns a shell id immediately.
`shell.output` reads from a cursor — an absolute produced-character offset — and can *wait* for new
output instead of being polled. `shell.stop` kills it, ungated, because needing permission to stop a
runaway build is backwards. `shell.list` shows what a session left running.

It is the same sandboxed execution path as `process.exec`, so workspace confinement, environment
scrubbing and the sandbox backend are not re-implemented and cannot drift; starting one carries the same
`process` risk class. Output lives in a bounded ring buffer, and when a reader falls behind the loss is
**reported** as `skippedChars` rather than stitched into a misleading transcript. Every shell has a
timeout, a total-output ceiling and an owner: when the session closes, its shells are killed.

## Reviewed automatic approvals

`auto` and `dontAsk` answer by risk class — a dial, with nothing left behind. A reviewed auto-approval is
a different thing: an operator names a capability or family, writes down *why* that class of request is
safe, and that rationale is copied onto every decision the rule makes. Rules may carry argument patterns,
refusal patterns that force an escalation even on a match, a session scope, an expiry and a use budget.

The floors are absolute: `*` is refused, privileged capabilities are never answered automatically, and an
installation can switch the whole mechanism off through managed settings. Escalations are logged next to
approvals, so the record shows what the mechanism refused as well as what it waved through. An agent may
`approvals.auto.propose` a rule, and the proposal arrives disabled — proposing is not granting.

## MCP 2026-07-28

Implemented in full, including the optional halves: server-supplied `ttlMs` / `cacheScope` drive the
client cache (`none` disables it), the renumbered error codes are named and acted on — an endpoint that
answers UnsupportedProtocolVersion is not asked again — the **Tasks extension** is polled through
`tasks/get` with a bounded poll count and `tasks/update` for mid-task input, and `subscriptions/listen`
is an opt-in, abortable, byte- and lifetime-bounded stream whose `toolsListChanged` invalidates exactly
the cache it names. The log level rides per request, because `logging/setLevel` is gone.

The stateless revision removed the `initialize` handshake and `Mcp-Session-Id` entirely. Aurora speaks it
natively: `server/discover` for capabilities, `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` routing
headers that the client refuses to let disagree with the body, cacheable list results, and Multi
Round-Trip Requests in place of elicitation. `requestState` is treated as attacker-controlled input —
bounded, never parsed, echoed back verbatim — and a mid-call input request is put to the *human* through
the same bounded question service the agent uses, so a remote server cannot script its own confirmation.
Discovery is optional in the revision, so a failing server degrades and registers what it could list
rather than hanging a turn. The existing SDK-backed manager keeps serving servers on the older revision.

## Managed settings and asking the human

Settings merge through six published layers — defaults, user, project, project-local, runtime, managed —
and every effective value reports the layer that produced it *and* every layer that had an opinion. The
managed layer is an absolute floor: what it sets is locked, a lower layer's override is recorded as
overridden rather than dropped, and a managed array replaces instead of merging so an administrator's
deny list cannot be widened or narrowed from below. Two enforcement points prove it is not advisory: a
permission-mode ceiling `session.mode.set` refuses to exceed, and a deny list applied as a policy layer.

`user.ask` lets an uncertain agent ask rather than guess: two to six options, bounded outstanding
questions, opt-in free text, attributed answers, and a timeout that returns `timedOut` instead of an
invented choice. `dontAsk` denies it; plan mode allows it, because asking changes nothing.

## Supply-chain trust

A digest check proves the bytes match the index; it says nothing about who wrote the index. Publishers
register Ed25519 keys, sign `kind:artifactId:version:sha256`, and tenants pin the exact version and
digest they approved. A valid signature over a *different* version is still refused, because that is
what a supply-chain attack looks like. Signature and pin states are reported separately — `valid`,
`invalid`, `absent`, `unknown-publisher`; `matched`, `mismatched`, `absent` — and enforcement is opt-in
per tenant, with verdicts recorded even while it is off so an operator can see what would be refused
before switching it on. The skills hub consults the gate before downloading anything.

## Effort and worktrees

Effort is one dial with two jobs: it asks the provider for more reasoning *and* changes what the harness
will spend. `low | medium | high | xhigh | max` selects an explicit profile — tool iterations, context
scale, reasoning effort, continuation ceiling — and `session.effort` returns those exact numbers, so a
turn that stopped after four tool calls can be explained rather than guessed at. Effort resolves once
per turn, so a change never moves the ceiling under a running loop.

`worktree.create` gives the main session what child sessions always had: a clean branch in an isolated
git worktree, created inside the engine's workspace root and optionally bound to a fresh session in one
call. References are validated as plain git names, removal is confined to the workspace root, and a
session can never remove the tree it is running in.

## Working-tree review and subagent files

`review.worktree` answers "what changed and what should worry me?" mechanically: per-file statistics
plus deterministic findings — added credentials, `.env` and CI workflow edits, a lockfile moving without
its manifest, source changes with no test touched, a large deletion against a small addition. No model
is consulted to produce the evidence, so no model can talk the evidence away. Everything is bounded and
runs through the session's sandbox, and a clean tree degrades to "nothing to review".

Subagent files (`.aurora/agents`, `.claude/agents`, `.codex/agents`) are read with the front matter the
ecosystem already uses and resolved onto machinery Aurora had: an agent profile for instructions and the
allowlist, a society role binding for identity and reputation, a declared permission mode for behaviour.
Tools resolve against the live catalog, `disallowedTools` is applied and reported, and fields Aurora does
not honour are named instead of dropped.

## Session archive and cost

Archiving a session keeps everything it recorded and refuses new work until it is restored, enforced on
the engine's command path rather than in one client. Cost always states its source: a provider number,
the operator's price table, or `unpriced` — an unpriced model is a configuration gap, and reporting it
as free would produce a confidently wrong invoice. The tenant rollup breaks spend down by model and
names the sessions that could not be priced.

Repository command templates come from `.aurora/commands`, `.claude/commands`, `.codex/prompts` and
`.github/prompts`, so an existing repository works unchanged. Arguments substitute into `$ARGUMENTS`
and `$1`…`$9`, every placeholder filled or left over is reported, and a template that fails injection
screening is refused with an error rather than quietly dropped. Rendering produces text; it never runs
anything.

## Session modes

One word instead of four flags: `plan`, `manual`, `acceptEdits`, `auto`, `dontAsk`, `bypass`, plus a
sandbox mode of `read-only`, `workspace-write` or `danger-full-access`. Plan mode is genuine read-only
exploration that can still write plans and decisions, so a session can propose real work and then be
switched out of plan mode to do it.

The dial wraps the policy stack rather than joining it, which is what lets it both tighten and relax.
Relaxation is deliberately narrow: only a base-policy approval requirement, only for the risk classes
the mode names. A denial is never reversed, and a decision that came from Aurora governance, OPA or a
lifecycle hook is never weakened — a mode is a preference, governance is not. `bypass` must be enabled
per tenant, and every change of mode is recorded with an actor and a reason.

## Repository instructions, hooks and tool search

Aurora reads the instruction file a repository ships — `AGENTS.md`, `CLAUDE.md`, `AURORA.md`,
`.cursorrules`, `.github/copilot-instructions.md` — because that file is the user's house rules. It
reads them defensively: bounded discovery, no symlinks, no dependency directories, injection screening
with quarantine, explicit precedence and a character budget that includes its own framing.

Deterministic hooks cover what a model must not be trusted to remember. Rules on session start/stop,
prompt submission and tool use can warn, require approval or deny, and the `tool.pre` half joins the
policy stack as an escalation-only layer. A hook never shells out: its action invokes an allowlisted
governed capability, so hook effects are policed and audited like everything else.

With 275 capabilities, pushing the whole catalog at a model is wasteful, so `tool.search` ranks it
deterministically with risk and side-effect filters and `tool.describe` returns a full schema only for
the capability actually chosen.

A full comparison against Claude Code, Codex CLI, OpenHands, Hermes and Prime — including the gaps
still open and their order — is in [`docs/peer-system-gap-audit-2026-08-20.md`](docs/peer-system-gap-audit-2026-08-20.md).

## Aurora estimation calibration

Delegated work records how long it really took, so estimate accuracy is measured rather than assumed.
The calibrator turns those pairs into a correction: the median actual/estimate ratio, clamped, bucketed
by plan tag, gated on a minimum sample count and reported with a confidence. Applying it is a plan
revision that names the factor and the sample count, so a machine-corrected estimate never passes as a
human's — and a plan with no history is left exactly as written, with the reason stated.

When a finished plan lands far from what its decision expected, Aurora raises a candidate replanning
initiative with the expected and observed values attached. It never replans on its own, and it stays
quiet when the plan went as expected.

## Aurora role authority

Without a profile, a delegated child session inherits the parent's entire capability set — the
opposite of what a role-specialised society should do. Aurora ships eight reviewed least-authority
templates (prime, researcher, coder, planner, memory-keeper, guardian, communicator, evolver). Each
declares allow patterns, deny patterns and a hard risk ceiling, and resolves against the live
capability catalog, so a template can never grant a capability that does not exist and never quietly
misses a new one in its family. Everything the ceiling removes is reported, and a pattern that
matches nothing is surfaced as drift. The guardian template is provably read-only: every capability
it grants is side-effect free. Tenants can define their own templates too — validated, resolved
against the same live catalog, rejected if they grant nothing, and audited for drift exactly like the
built-ins, which stay immutable.

## Aurora fleet supervision

The autopilot drives one tenant. The fleet supervisor drives many, and it is the layer that makes
unattended cognition safe at scale. A tenant is only driven after explicit enrollment; sweeps serve
the highest priority band first and, within a band, the least recently swept tenant, so a busy tenant
cannot starve a quiet one. Each sweep is bounded by tenants-per-sweep and runs-per-tenant, and the
fleet as a whole by a daily sweep ceiling. A tenant whose autopilot throws is contained, not fatal:
the sweep continues, the failure is recorded, and three consecutive failing sweeps open a circuit
breaker with an exponential pause that only an operator resume clears. The sweep ledger is durable,
so cross-tenant background activity is reviewable after the fact.

When the budget only allows a few tasks, the longest pole goes first: critical-path steps, then risk,
then size. And a role that keeps failing stops being nominated for high-risk work — soft, reversible
probation that still lets it earn its record back on routine steps.

Delegation also respects the society's economics before it posts: the daily token budget and the
concurrency ceiling are checked up front, so a task that could never be awarded today is never
created, and the unattended path serves the plan that has waited longest first.

Because the fleet is cross-tenant, its REST surface is system-admin only. A tenant's own agents can
see and change only their own membership, through the tenant-scoped `aurora.fleet.*` capabilities.

Day-two operations — health checks, tuning tables, the alert playbook and recovery procedures — are
documented in [`docs/aurora-operator-runbook.md`](docs/aurora-operator-runbook.md), and the whole
Aurora surface is reachable from a terminal with `haf-client aurora`.

## Aurora provenance

`aurora.explain` answers "why does this exist?" by walking recorded provenance across subsystems: an
environment action to its resource, verification and memory updates; an initiative to the intake signal
that raised it; a memory to its graph neighbourhood; a decision to its constitutional verdict; a plan to
the decision that justified it. The trace is reconstructed from durable state only — no model is asked
to narrate causality after the fact — and it reports unresolved references instead of guessing.

## Aurora governance at the capability boundary

Everything above is only real if it binds when a tool actually runs. `AuroraPolicyEngine` sits in the
layered policy stack next to the default engine and OPA, and it is evidence-driven and
escalation-only:

- it escalates when a **destructive pattern matches the call's own arguments**, not because a
  capability belongs to a risky class — so `allowProcessExecution` and `autoApproveWorkspaceWrites`
  keep meaning exactly what the operator configured;
- critical matches are denied, high matches require confirmation, and both thresholds are
  configurable (`confirmAtOrAbove`, `denyAtOrAbove`);
- consequential calls additionally pass the constitutional checker, which can deny or require review;
- it can raise `allow` to `require_approval` and `require_approval` to `deny`, but it can never grant
  authority another layer withheld, and a failing analyzer degrades to no escalation rather than an
  open gate.

Every decision lands in a durable enforcement trail with the matched rules and violated principles,
summarized as an escalation rate per tenant. The whole layer is opt-out via
`auroraGovernance.enabled: false`.

Closing a session automatically runs candidate-only experience distillation, so the learning loop
happens by default rather than by discipline.

## Aurora operations: checkpoints, telemetry and governance

A rollback plan written in prose is not a recovery path. `checkpoint.capture` takes a bounded,
content-addressed snapshot of the session workspace: limited by file count, per-file size and total
size, excluding dependency and build directories, confining every path to the workspace root and
refusing symlinks. `checkpoint.restore` puts the workspace back exactly, takes an automatic safety
checkpoint first so the rollback is itself reversible, verifies blob integrity before writing, and can
remove files that were added after the snapshot. Content is deduplicated by digest and reclaimed only
when no checkpoint still references it. An environment action can bind a checkpoint as its
`rollbackCheckpointId`, and a recorded rollback names the checkpoint it restored.

Aurora telemetry is content-free by construction: counts, rates and bounded scores across cognition,
memory, world calibration, initiative trust, society, evolution, environment, decisions, plans,
constitution, autopilot and ACOS. It is exposed as JSON and as Prometheus gauges on the existing
`/metrics` scrape, and it is paired with derived alerts — degraded health, exhausted attention budget,
world inconsistency, miscalibrated predictions, low proactive trust, verification debt, decision
overconfidence, stalled plans, low constitutional compliance, failing autopilot.

Data governance closes the loop that constitution rule C10 opens: `aurora.export` returns everything
Aurora holds for a tenant or one user with per-section digests, and `aurora.purge.user` deletes a
user's stored inferences — defaulting to a dry run and stating exactly which audit-grade records are
retained rather than silently keeping them.

`aurora.selfcheck` is the cross-store audit no single service can perform: dangling memory relations,
broken thought anchors, focus without a reservation, attention-reservation drift, verification debt,
high-zone actions that progressed without approval, decisions referencing a missing option or lacking a
falsifiable expectation, plans completed with open steps, tasks assigned to removed roles, quarantine
bypass, ungated production skills and damage to the constitutional hard floor. Critical findings
degrade the next ACOS cycle instead of sitting in a dashboard nobody reads.

## Repository bootstrap

`POST /v1/repositories/import` creates a new session from a credential-free
HTTPS Git URL. URLs are public-address checked, redirects and embedded/query
credentials are forbidden, and clones are shallow, no-tags and blob-filtered.
Optional private-repository tokens are referenced by Credential Broker secret ID,
leased to the exact repository origin and supplied only through an ephemeral
owner-only askpass helper—never URL, process arguments, logs, session state or
model context. File/byte/timeout limits and verified HEAD capture run before the
session is admitted; failures remove the workspace. Canvas exposes branch,
profile and secret-ID bootstrap controls.

## Persistent goals and autonomous gates

Create a bounded goal:

```json
{
  "kind": "goal.set",
  "payload": {
    "objective": "Implement and verify the migration",
    "tokenBudget": 200000,
    "maxContinuations": 10
  }
}
```

Configure autonomous quality gates:

```json
{
  "kind": "autonomous.configure",
  "payload": {
    "enabled": true,
    "maxContinuations": 8,
    "maxTurns": 30,
    "maxTokens": 200000,
    "timeoutMs": 3600000,
    "gates": ["npm test", "npm run typecheck"],
    "gateMaxRetries": 3
  }
}
```

A failed gate is returned to the model as bounded evidence. If the workspace
has not changed, the same command is not repeatedly executed. Passing a gate
proves only that gate; successful goal completion still requires
`goal.complete`.

## Durable task board

Session snapshots carry a dependency-aware task board. The model and API use
`task.list`, `task.create` and `task.update`; dependency cycles are rejected,
unfinished prerequisites force a blocked state, and dependants become ready
when prerequisites complete. Open tasks are projected into model context and
rendered in the Canvas Tasks panel.

## Durable agent messaging

`agent.roster` exposes only the current agent's direct parent, siblings and children. `agent.send` supports `auto`, `steer` and `follow_up`, plus family-scoped broadcast. Sender identity is host-derived; family reach, message size, rate and pending limits are enforced before enqueue.

Inbox rows are durable in files or PostgreSQL with `pending`, `claimed`, `delivered` and `uncertain` states; PostgreSQL uses content-free LISTEN/NOTIFY to wake the current session owner. Busy `auto` deliveries become steering messages and enter at a model boundary; idle and follow-up deliveries run as serialized prompts. A claim lost across a crash becomes explicit `uncertain` rather than being silently replayed. Canvas shows the family roster and can send through the same API.

## Encrypted secrets and scoped leases

`POST /v1/secrets` is write-only for values; list responses contain metadata
only. The local broker encrypts values with AES-256-GCM. Set `HAF_MASTER_KEY`
for restart-stable decryption. Capability workers receive a short-lived,
audience- and capability-bound lease rather than a raw long-lived secret.

The REST API deliberately does not expose lease redemption. In production the
same interface is intended to use Vault/KMS.

System administrators can register pinned external secret sources for generic
commands, 1Password CLI or Bitwarden CLI. Records contain only absolute
executable path, SHA-256, environment-variable names and redacted item metadata.
Each refresh re-resolves and hashes the executable, runs without a shell in a
clean allowlisted environment, bounds output/time and imports values directly
into Credential Broker. References, command arguments and values are omitted
from list/refresh responses. Canvas's Secrets panel shows metadata and provides
write-only manual entry plus explicit source refresh.

## Server-side backend registry

Remote/cloud backend metadata is stored by the control plane, not browser
`localStorage`. Auth configuration references an environment variable name;
the credential value is resolved only for server-side health/proxy calls.
Click a backend in the control center to run its health check.

## Declarative automations

Automations bind a session and prompt to one of three closed trigger kinds:

- `manual`
- `schedule` using the durable once/interval/cron scheduler
- `webhook` with an environment-referenced secret

Manual and webhook executions produce durable run records. A process restart
turns an in-flight run into `uncertain` rather than replaying it. Webhook event
JSON is fenced as untrusted data and dispatched with the restricted `webhook`
source policy. The control center can create, enable/disable and dispatch manual
automations.

### Hosted Git automation synchronization

Tenant administrators can register `/v1/automation-git-sources` against an
existing hosted GitHub/GitLab provider, repository ID, branch/ref, JSON manifest
path and one authoritative HAF session. A source may additionally carry one
administrator-selected webhook-secret environment-variable reference and an
exact model-route allowlist. The remote manifest cannot select another session,
credential reference, provider account or unapproved model route.

A version-1 manifest contains at most 100 strict automation definitions with a
stable key, bounded name/prompt, enabled state and manual, schedule or webhook
trigger. Webhook entries inherit the source's server-side secret reference;
schedule intervals, future one-shot times, cron expressions and timezones are
validated during planning. Hosted retrieval accepts one bounded base64 UTF-8
JSON file with a validated remote blob version.

Synchronization is deliberately two-phase. `POST .../:id/plan` fetches and
validates the manifest, computes create/update/unchanged/disable actions and
issues a 15-minute content SHA-256. It does not mutate automations. Apply
re-fetches the file and requires that exact planned hash; branch movement forces
a new plan. Canvas exposes the same Plan then Apply exact hash workflow.

Applied automations retain source/key/entry/manifest-hash provenance. Changed
schedule jobs are cancelled and recreated; keys removed from Git are disabled,
not deleted. Source state stores only repository references, hashes, status and
error code—never prompt or manifest contents. A process interruption while
applying becomes `partial` and is not silently replayed; this flow does not claim
atomic or exactly-once external scheduler effects.

### Signed external automation responders

`/v1/automation-responders` registers an external deployment against exactly one
tenant webhook automation and one existing Credential Broker secret. The remote
process sends JSON heartbeats and events to the responder-specific public URLs.
It signs the exact raw body with HMAC-SHA256 over
`timestamp + "." + nonce + "." + body` using `X-HAF-Responder-*` headers.
Timestamps must be within five minutes; nonce hashes are persisted and replayed
nonces are acknowledged without reprocessing.

Heartbeats carry bounded instance ID, version, reported ready/degraded status and
capability names. Raw instance identity and secret are never listed; Canvas and
REST expose a one-way instance projection and derive pending/healthy/degraded/
stale from the administrator-selected heartbeat interval.

Events must match the bound automation's exact event type. After signature and
JSON depth/size/prototype checks, HAF durably records a hash-only `processing`
entry and immediately acknowledges. Dispatch continues asynchronously through
the existing webhook automation policy. Event IDs deduplicate retries; records
contain only event hash/type, run ID, status and error code. Process replacement
or unknown dispatch outcome becomes `uncertain` and is never automatically
replayed. Credential rotation invalidates prior signatures and clears nonce
history without returning either secret.

## Content-free monitoring

`GET /metrics` exposes Prometheus counters and gauges for process uptime,
events, sessions by bounded state, model calls, token classes and capabilities.
No prompt, message, path, tenant ID, session ID, tool arguments or results are
exported. When `HAF_API_TOKEN` is configured, the metrics endpoint requires the
same bearer credential.

## Browser and computer use

Browser tools are registered only when either `HAF_BROWSER_CDP_ENDPOINT` or
`HAF_BROWSER_EXECUTABLE_PATH` is configured. The engine exposes navigation,
bounded text/element snapshots, stable-per-snapshot refs, click, fill, key
press, screenshot, coordinate click, typing and scrolling. Every top-level and
subresource HTTP(S) URL is checked against private/special-use destinations.
A private CDP endpoint requires the explicit operator switch
`HAF_BROWSER_ALLOW_PRIVATE_CDP=true`.

## SSH execution profile

`HAF_SANDBOX_BACKEND=ssh` runs process capabilities on a strict-host-key-checked
remote machine and synchronizes the assigned workspace with rsync before and
after execution. Host, user, port, remote root and cwd are validated before any
process starts. The local Python kernel is disabled in SSH mode so a model
cannot silently bypass the remote execution boundary.

`HAF_SANDBOX_BACKEND=singularity` targets Apptainer/Singularity clusters. Local
SIF files require `HAF_SINGULARITY_IMAGE_SHA256`; remote image URIs require an
`@sha256:` pin unless an administrator explicitly enables the unpinned escape
hatch. The adapter uses a clean contained environment, network `none` by
default, and disables the host Python kernel.

## Governed learning

Learning proposals are scanned and carry evidence event IDs, expected outcome,
scope, risk and provenance. Agent-created proposals require evidence. Promotion
requires evaluation; user/org/high-risk changes also require explicit human
approval. Promoted memory, skill, prompt addendum and subagent artifacts can be
rolled back. Prompt/subagent artifacts enter only a newly frozen session
context, preserving prompt-cache stability for already running sessions.

`learning.refine` groups one to eight small edits into a continual-harness batch.
Agent batches must reference real events from the same session log; every edit is
scanned and remains a candidate, so the batch cannot self-evaluate or
self-promote. Batch history tracks partial rejection/promotion and can roll back
all promoted members in reverse order.

`RefinementPlanner` can now review an untrusted trajectory excerpt with the
session's selected model and strict JSON output. It binds every proposed edit to
real event-log evidence and creates governed candidates only—never promotion or
direct prompt mutation. `HAF_AUTO_REFINE_EVERY_TURNS=0` keeps automation off by
default; a positive cadence enables single-flight interval reviews. Manual plans,
review history, candidate evaluation/promotion and rollback are exposed in the
Canvas Learning panel. Scope/risk and explicit human-approval rules still apply.

## STT and TTS

When `HAF_AUDIO_API_KEY` is configured, `audio.transcribe` accepts only bounded
workspace files and `audio.synthesize` writes only inside the workspace.
Provider credentials remain inside the audio service and never enter model,
session or Python-kernel state.

When `HAF_IMAGE_API_KEY` is configured, `image.generate` requests base64 output
from an OpenAI-compatible image endpoint and materializes 1–4 owner-only raster
artifacts under `.haf/artifacts/images/`. One `sourcePath` or up to eight
`sourcePaths` route to the multipart edit endpoint; multi-reference providers
must advertise support and references have a 40 MiB aggregate bound. Optional
FAL generation/editing uses `HAF_FAL_IMAGE_*`. `image.upscale` and an optional
generate→upscale chain use `HAF_IMAGE_UPSCALE_*` with 2x/4x factors. HAF parses
source/result dimensions and rejects a provider that returns less than the
requested scale. Pipeline provider/model/operation provenance is returned with
the artifact. PNG/JPEG/WebP/GIF magic/byte checks remain mandatory and remote
provider URLs are rejected by default.

Raster attachments uploaded from Canvas can be projected as structured image
parts instead of text-only paths. Session snapshots store only confined relative
path, MIME type, optional alt text and SHA-256—not base64 bytes. Immediately
before a model request, HAF resolves the file under the workspace, verifies
magic bytes/MIME/hash and enforces a 10 MiB per-image limit. OpenAI Chat and
Responses, Azure OpenAI, Anthropic, Gemini/Vertex and Bedrock receive their
native image block shape. A prompt is limited to eight images.

When `HAF_VIDEO_API_KEY` and `HAF_VIDEO_MODEL` are configured, `video.generate`
provides normalized text-to-video and confined generation from up to four
reference images through FAL's synchronous endpoint. Providers must explicitly
advertise multi-reference support and references share a 40 MiB aggregate bound.
Inputs are bounded to 30 seconds; output is materialized
under `.haf/artifacts/videos/` only after MP4/WebM magic-byte and byte-limit
validation. Remote result URLs are disabled by default and require
`HAF_VIDEO_ALLOW_REMOTE_URLS=true`; every hop is rechecked for SSRF. Canvas's
Media panel exposes configured image/video providers without moving provider
credentials into the browser. `HAF_VIDEO_UPSCALE_*` enables `video.upscale` for
workspace-confined MP4/WebM inputs. HAF parses MP4 `tkhd` fixed-point dimensions
or bounded WebM PixelWidth/PixelHeight elements before and after the provider
call; a claimed 2x/4x result is rejected unless both dimensions meet the factor.
The result includes verified width/height and is materialized only after normal
video magic/byte checks.

`HAF_VIDEO_QUEUE_API_KEY` plus `HAF_VIDEO_QUEUE_MODEL` enables durable FAL Queue
jobs. `video.job.submit/status/cancel/list` and `/v1/media/jobs` expose explicit
`submitting`, `queued`, `running`, `succeeded`, `failed`, `cancelling`,
`cancelled` and `uncertain` states. Only provider/model/status, tenant/session,
reference count and a validated final artifact are persisted—never prompt,
workspace path, input image bytes, credentials or provider result URLs. A
submission or cancellation interrupted after dispatch becomes `uncertain` and
is not replayed automatically. Client idempotency keys are stored only as
SHA-256 projections. Polling constructs exact FAL Queue URLs from the validated
model/request ID and materializes MP4/WebM only after bounded result and magic
checks.

When `HAF_WEB_SEARCH_API_KEY` is configured, `web.search` uses the selected
Brave or Tavily provider and returns normalized title, public provenance URL,
snippet and optional publication metadata. Provider credentials remain
server-side, fields are bounded, and private/special-use result URLs are dropped
before reaching the model.

## OPA/Rego organization policy

Set `HAF_OPA_ENDPOINT` to layer an organization policy decision over the local
least-privilege policy. Secret-like argument keys are redacted before the OPA
request. Local denial cannot be weakened by OPA; `require_approval` remains
stronger than `allow`. Timeout, unavailable service, non-2xx response or invalid
result all deny execution rather than falling back open.

## Detached resident session workers

The `@haf/session-worker` process owns a root session family independently from
the web control plane. It publishes an owner-only descriptor and listens on a
mode-0600 Unix socket using an authenticated binary frame protocol:

```text
4-byte JSON header length
4-byte opaque payload length
small JSON routing header
opaque payload bytes
```

Events carry worker generation and sequence cursors. Reconnecting supervisors
request bounded replay; a generation change or evicted replay interval causes a
chunked snapshot resync. A slow attachment is marked for resync instead of
building an unbounded queue or blocking the worker and other clients.

Control-plane shutdown closes only client attachments. Resident workers remain
alive, are reparented by the OS and are adopted from descriptors by the next
control-plane process. Worker stdout/stderr is retained in a per-worker forensic
log. The control center and `/v1/detached-workers` API expose create, status,
command, event stream, approval and stop operations without exposing the worker
authentication token.

## PostgreSQL and NATS distributed profile

The default remains the zero-dependency local file profile. Set
`HAF_POSTGRES_URL` to move session events, snapshots, command/effect journals
and leases to PostgreSQL. Migrations are idempotent and recorded in
`haf.schema_migrations` (or the configured schema).

PostgreSQL event delivery uses `LISTEN/NOTIFY` only as a wake-up signal; the
authoritative event is read from the table by event ID. Event IDs and
`(session_id, sequence)` are unique. Snapshot upserts reject generation/sequence
regression. Command and effect journals persist an execution owner so a second
runtime can distinguish its own insertion from another process's in-flight
operation and return `uncertain` instead of replaying it.

Session leases carry owner and expiration, are renewed by heartbeat and can be
taken over only after expiry or explicit release.

Set `HAF_NATS_SERVERS` to publish normalized events and enable typed worker
request/reply subjects. Tenant IDs are SHA-256 projected into subjects rather
than exposed raw. NATS is transport; PostgreSQL remains authoritative state.

```bash
HAF_POSTGRES_URL=postgresql://haf:haf@localhost:5432/haf \
HAF_NATS_SERVERS=nats://localhost:4222 \
npm run dev
```

## Branch-preserving session tree

Every message is a tree entry with a parent, labels and active-leaf state.
Branching changes only the active projection; abandoned alternatives remain
addressable. The Control Center Tree tab can label entries and continue from any
prior point. Compaction writes a `contextReset` summary entry followed by cloned
recent context, so the model stops walking older ancestors while the complete
pre-compaction tree remains available.

Commands:

- `session.tree.get`
- `session.tree.branch`
- `session.tree.label`

## Hybrid full-text and vector retrieval

The persistent knowledge index combines a BM25-style lexical score with cosine
vector similarity. Default vectors are deterministic and local, requiring no
external service. `HAF_EMBEDDING_API_KEY` enables an OpenAI-compatible embedding
provider. Tenant filtering occurs before scoring. Live `message.created` events
are indexed automatically; manual reindex covers restored sessions. Governed
learning promotion indexes memory, skills, prompt addenda and subagent specs,
and rollback removes the promoted search document.

Use `knowledge.search` from an agent or `/v1/knowledge/search` from the API.

## Skills Hub

Skills Hub sources publish a version-1 JSON index with name, version,
description, bundle URL and SHA-256. HAF validates source and bundle URLs against
SSRF, bounds index/archive/extracted size and entry count, verifies SHA-256,
rejects absolute/traversal paths and links, requires exactly one `SKILL.md` root,
then imports into the existing quarantine scanner. A clean download is still
not active until explicit promotion. Every source refresh, failure, hash
mismatch and quarantine result is appended to an owner-only JSONL audit log.

## Web sessions, OIDC and tenant RBAC

Browser authentication uses a random HttpOnly, SameSite=Strict cookie. Session
identity and CSRF values live only in an AES-256-GCM encrypted server-side
store. Cookie-authenticated mutations require `x-haf-csrf`. API bearer tokens
remain available for headless automation and map to a system administrator.

OIDC uses discovery, Authorization Code, PKCE S256, state, nonce, issuer,
audience and remote-JWKS verification. `haf_tenants` (configurable claim) maps
tenant names to `viewer`, `operator` or `admin`; undeclared tenants receive no
access. `haf:system-admin` is separate from a tenant admin. Session, automation
and learning IDs are resolved to their authoritative tenant before access is
checked, preventing a forged body/query tenant from crossing boundaries.

Roles:

- viewer: safe reads
- operator: normal session/agent/automation mutations
- admin: tenant secrets and governed-learning decisions
- system admin: backend, MCP, detached-worker and Skills-Hub administration

When no API token or OIDC provider is configured, the server enters an explicit
anonymous development-admin mode. Production should set `HAF_AUTH_DISABLED=false`,
`HAF_SESSION_SECRET`, secure cookies and either OIDC or an API token.

## Native inbound platform verification

Inbound endpoints validate the platform transport before channel authorization:

- Telegram: Bot API secret token plus user/chat allowlists
- Slack: raw-body v0 HMAC, five-minute replay window, user/channel allowlists
- Discord: Ed25519 signature over timestamp plus raw body, user/channel allowlists
- WhatsApp Cloud: hub challenge, raw-body SHA-256 HMAC, phone allowlists
- Signal REST bridge: shared secret and number allowlist
- Matrix bridge: shared secret and sender/room allowlists
- Mattermost outgoing webhook: constant-time token plus user/channel allowlists
- LINE Messaging: raw-body HMAC-SHA256/base64 plus user/chat allowlists
- Google Chat: bounded exact-origin JWKS, issuer/audience JWT and user/space allowlists
- Microsoft Teams: operator-configured issuer/JWKS, app-audience JWT and user/conversation allowlists
- Feishu/Lark: verification token plus optional timestamp/nonce/encrypt-key signature and user/chat allowlists

Google/Teams JWKS responses are capped at 1 MiB, redirect-denying and cached for
one hour. LINE/Feishu signatures operate on exact raw request bytes; Feishu and
Slack-style timestamp windows reject five-minute replays. New platform handlers
acknowledge authenticated events before long agent work and dispatch responses
through the configured outbound adapter. Platform event/message IDs become command idempotency keys. Discord interactions
are acknowledged immediately and completed through the outbound adapter so a
long agent turn does not exceed Discord's interaction deadline.

## Vault and KMS credential backends

All credential implementations share the same metadata and scoped-lease
contract. `HAF_VAULT_ADDRESS` plus `HAF_VAULT_TOKEN` selects Vault KV v2. Values
are written under a tenant/name path; API lists return only metadata. Lease
redemption reads Vault only after tenant, capability, audience, expiry and use
count match.

The KMS envelope backend requests a new 256-bit data key per secret, encrypts the
value with AES-256-GCM, stores only the KMS-encrypted data key and ciphertext,
and zeroes plaintext key buffers after use. Cloud-specific KMS clients implement
the `KmsProvider` interface without changing the broker or capability workers.

## PostgreSQL row-level security

`HAF_POSTGRES_RLS=true` enables tenant policies on events, snapshots and
command/effect journals. Policies accept either an explicit system bypass or a
matching `haf.tenant_id`. `withTenant()` opens a transaction, disables bypass
and sets the tenant with transaction-local `set_config`; `withSystemBypass()` is
separate for internal maintenance. Application RBAC remains mandatory and RLS
acts as defense in depth.

## Cloud sandbox gateways

`HAF_SANDBOX_BACKEND` accepts `modal`, `daytona`, `vercel` or `kubernetes` when
`HAF_CLOUD_SANDBOX_GATEWAY` is set. All four use one versioned gateway contract:
provision with workspace/resource/network policy, bounded exec, snapshot and
destroy. Provider credentials stay in the gateway. The agent receives no cloud
credential. Local Python is disabled for cloud profiles so it cannot bypass the
remote execution boundary.

## Signed out-of-process WASI plugins

A plugin consists of `plugin.json` plus a SHA-256-pinned `.wasm` module. The
canonical manifest is Ed25519 signed by a configured trusted key. Installation
verifies API/schema version, identity, hash and signature before registration.
Capabilities are namespaced as `plugin.<plugin-id>.<capability>`; hooks retain
observer fail-open, guard fail-closed and transform fallback semantics.

Each invocation launches a separate WASI runner process. WASI Preview1 receives
only a read-only plugin preopen and a per-invocation scratch directory. No
network socket API or host credentials are imported. Input arrives on stdin,
JSON output is bounded, timeout kills the process, and non-zero/invalid output
fails the invocation. Uninstall unregisters every capability/hook and removes
installed files.

Before plugin transforms, the packaged rolling micro-compactor replaces only
older contiguous assistant/tool windows with bounded SHA-256-bound summaries.
Summaries remain assistant-role, explicitly untrusted derived data; original
user/system messages, the protected recent tail and the durable transcript are
unchanged. Its tenant/session cache is atomic, bounded to 2 MiB and fail-open.
Configure it with `HAF_CONTEXT_MAX_CHARS`, `HAF_ROLLING_MICRO_COMPACTION`,
`HAF_MICRO_COMPACTION_TAIL_CHARS`, `HAF_MICRO_COMPACTION_WINDOW_MESSAGES`,
`HAF_MICRO_COMPACTION_SUMMARY_CHARS` and `HAF_MICRO_COMPACTION_CACHE_WINDOWS`.

Set `HAF_MEMORY_PROVIDER=honcho` to add Honcho user modeling alongside local
governed memory. Recall is fetched once per non-trivial user message and inserted
as a separate assistant-role, explicitly untrusted projection immediately before
the unchanged user message; it is never persisted in the session transcript.
Successful turns are sent through a content-free sync journal with
`pending`/`delivered`/`uncertain` outcomes and no automatic replay after an
uncertain external effect. Cross-session profile, search, context, dialectic
reasoning and conclusion tools are exposed as governed `memory.honcho.*`
capabilities. `GET /v1/memory/providers/status` returns content-free health and
outcome counters. Honcho Cloud uses `HONCHO_API_KEY`; custom `HONCHO_URL` values
require explicit self-hosting flags. SDK traffic is exact-origin, SSRF-checked,
manual-redirect and credential values remain server-side.

Signed plugins may implement `context_projection` transforms over model-facing
messages. The immutable system/security prompt is assembled outside the hook;
all original user messages must remain byte-equivalent, so a transform can
compact derived assistant/tool material but cannot erase or rewrite user intent.
Invalid or timed-out output preserves the built-in projection. `memory_context`
transforms may append up to 100 bounded entries; local governed memory is never
replaced and provider additions are wrapped as explicitly untrusted external
data.

## Automated evaluation, signed promotion and canary

A learning release binds a candidate to bounded evaluation commands. Results
store exit codes, output hashes and bounded previews. Only a fully passing
release can be signed. Ed25519 signatures cover candidate, tenant, session,
commands, evaluation evidence and canary policy. High-risk/user/org candidates
still require human review before signature acceptance.

A verified release enters canary state. Success/failure outcomes are counted
until `minSamples`; meeting `requiredSuccessRate` promotes through Learning
Governor, while failure blocks promotion. Promoted releases can rollback the
underlying memory, skill, prompt or subagent artifact and remove its search
index document.

## Hosted GitHub and GitLab accounts

Tenant administrators can bind a GitHub or GitLab account to an existing
Credential Broker secret through `/v1/repository-providers` or the Canvas
Hosted Accounts controls. Provider records contain only the secret ID, API
base, clone origin, auth style and account mode; tokens never enter registry
files, API lists, model context or clone arguments.

GitHub supports user and installation-token repository catalogs. GitLab uses
membership-scoped project discovery with bearer or `PRIVATE-TOKEN`
authentication. HAF normalizes repository visibility/default branch/clone URL,
open pull-request or merge-request metadata and provider web URLs. Hosted import
resolves the clone URL from provider metadata, revalidates its exact configured
origin, and then enters the existing bounded askpass importer.

GitHub App registrations can instead reference one or more RSA private-key
secrets already held by Credential Broker. `POST /v1/github-apps/:id/installations/start`
creates a 15-minute high-entropy install state and returns the official
`/apps/{slug}/installations/new` URL. Configure the GitHub App setup callback as
`/auth/github-app/callback` and its webhook as
`/v1/platforms/github-app/webhook`. A callback installation ID is never trusted
on its own: HAF verifies it through the app-authenticated
`GET /app/installations/{id}` endpoint before admission.

App JWTs use RS256, a 60-second backdated `iat`, an expiration under ten minutes
and the configured client ID (recommended) or numeric app ID as `iss`.
Installation access tokens are minted from
`POST /app/installations/{id}/access_tokens`, encrypted in Credential Broker,
and refreshed before their one-hour expiry. Up to 25 private-key references can
be rotated; a rejected primary key may fail over only on app-auth 401/403, and
the last active key cannot be disabled while the app is enabled. Raw installation
IDs are also broker-encrypted; API/state lists expose only opaque record IDs and
keyed projections.

GitHub App webhooks require `X-Hub-Signature-256` over the exact raw body. Multiple
webhook secrets permit no-downtime rotation, `X-GitHub-Delivery` is deduplicated,
and normalized installation/repository/pull-request events contain hashes and
bounded synchronization metadata rather than payload bodies. Signed install,
suspend, unsuspend, delete and repository-selection events update the local
installation lifecycle; deletion/suspension clears cached access credentials.

Imported sessions receive a persistent provider/repository link. The
`/v1/sessions/:sessionId/repository-sync` read-only endpoint compares imported,
local and remote branch HEADs and returns `up_to_date`, `local_changed`,
`remote_changed` or `diverged_or_advanced`. It never performs an implicit
fetch, pull, push or merge. API requests are public-address checked per call,
redirect-denying, bounded to 8 MiB and use one-use exact-audience credential
leases.

Governed `repository.review.create/comment/close/merge` capabilities provide
write-side GitHub PR and GitLab MR workflows. Every REST mutation is tied to an
authoritative session, crosses the external-side-effect approval/effect journal,
and requires `x-idempotency-key`. Create/comment content and raw keys are not
persisted; the hosted operation journal stores SHA-256 projections, status,
review number and remote ID only. Merge requires an explicit expected review
HEAD SHA and disables deferred pipeline merge and source-branch deletion.
Ambiguous network/redirect/408/409/425/429/5xx outcomes become `uncertain` and
are not replayed; deterministic 4xx responses become `failed`.

## Hosted scale-to-zero scheduling

`HostedSchedulerRelay` implements provision, cancel, boot reconciliation and
external fire handling. Provisioning sends only job ID, fire time, callback URL
and dedup key—never the prompt. Inbound fire JWTs are verified against remote
JWKS for issuer, audience, expiration, purpose, job ID and fire time. Body and
JWT must agree. A persisted claim ledger accepts each `(job, fireAt)` once.
Scheduler state advances before prompt dispatch; recurring jobs are re-armed
after outcome persistence. The public callback returns 202 after cryptographic
verification and completes the agent turn in background.

## Fleet status and CI security gates

The fleet projection exports only bounded counts: session states, model/tool
counters, schedule states/overdue count, pending approval age and resident
worker health. Alert codes cover capability failure rate, approval wait,
scheduler overdue and unreachable workers without including tenant/session/job
identifiers or content. `/v1/fleet/status` and `/v1/fleet/alerts` feed the Control
Center.

CI runs normal tests plus explicit `test:adversarial` and `test:chaos` gates.
The adversarial gate covers SSRF, path/symlink escape, webhook least privilege,
malicious skill archives, plugin signatures, OPA fail-closed and credential
scope. Chaos covers worker death/adoption, child rehydration, binary replay,
PostgreSQL journals/leases and NATS request/reply.

### Acceptance gates

`npm run eval:gates` runs on every push and fails the build when a measured
criterion regresses:

| gate | asserts |
|---|---|
| `eval:validate` | every acceptance criterion rejects an unsolved workspace (60/60 discriminative) |
| `eval:baseline` | a non-acting model scores 0/61 — a pass here would prove the tasks are vacuous |
| `eval:learning` | a repeated task family completes in fewer steps (4/4 families, 42.9% mean reduction) |
| `eval:recall:lock` | hybrid retrieval's fusion and ranking behaviour is unchanged |

`eval:recall:lock` is a **regression lock, not a quality claim**. The FAZ 11
acceptance criterion — Recall@8 beating a BM25 baseline by ≥0.05 — requires a
real semantic encoder, which per-push CI does not have. That criterion runs in
the nightly `recall-nightly` job against `EMBEDDINGS_URL`; with a real encoder
the pipeline measures 0.317 → 0.400 (+0.083, 8W/1L/6T). Running the lock with
the deterministic hash encoder only proves the retrieval logic did not change,
and its output says so explicitly.

## SBOM, provenance and release verification

`@haf/release-tool` creates deterministic release metadata without requiring a
hosted CI service:

```bash
SOURCE_DATE_EPOCH=1700000000 npm run release:prepare -- \
  --artifact ../hybrid-agent-fabric-source.tar.gz
npm run release:verify
```

The bundle under `release-metadata/` contains `source-manifest.json`, CycloneDX
1.5 and SPDX 2.3 SBOMs, an in-toto Statement carrying SLSA provenance v1,
`SHA256SUMS`, copied release artifacts and an optional Ed25519 attestation.
Source walking excludes runtime state, dependency/build/cache trees, `.env`,
credential/session files and private-key material. Prompt/config secrets are
never read into metadata.

Set `HAF_RELEASE_SIGNING_KEY` to an Ed25519 PKCS#8 PEM only in the release-tool
environment to sign. The private key is never accepted as a command-line flag or
written to the bundle. `SOURCE_DATE_EPOCH` fixes timestamps and invocation IDs.
`release:verify` rehashes every metadata/artifact file, rejects traversal entries
and verifies payload hash, public-key identity and signature.

## Isolated interactive artifacts

`artifact.publish` turns a workspace HTML file into a hash-bound interactive
artifact. Sources must remain workspace-confined UTF-8 HTML under 2 MiB and
carry an exact 1–32 action allowlist. Any source change invalidates the frame
until republished.

Canvas opens artifacts in an iframe with `sandbox="allow-scripts"` and no
`allow-same-origin`. The frame response also enforces CSP `sandbox allow-scripts`,
`default-src 'none'`, no connect/frame/form/object/base targets, and only inline
scripts/styles plus data/blob media. A 15-minute in-memory channel grants at
most 100 interactions. The injected, non-configurable `hafArtifact.emit()` /
`hafArtifact.request()` bridge communicates only through structured
`postMessage`; Canvas validates `event.source`, channel, interaction ID and the
server-side action allowlist before dispatch.

Artifact actions run as `artifact.interaction` hidden model turns. Their
user/assistant/tool messages remain in internal model continuity, but public
session snapshots, tree projections, REST/SSE events, ACP updates, Markdown,
JSON/trajectory exports, session search, knowledge indexing and external-memory
sync omit them. The interaction journal stores action, payload/response hashes,
status and error code—never raw payload or model response. Electron additionally
blocks every subframe navigation except the exact same-origin artifact-frame
route.

## HAF Canvas

The production React/Vite control center is served at `/canvas/`. It uses the
same HttpOnly session, CSRF and tenant RBAC as the API. Panels include durable
conversation/SSE streaming, approval decisions, child navigation, terminal,
workspace file tree/editor, Git status/diff/branch/create/switch/commit controls,
browser/computer-use, branch-preserving tree, durable tasks, model routes, versioned agent profiles and automations. The conversation composer can upload a
bounded binary attachment into `.haf/uploads/` through the policy/effect path and
adds its workspace path to the prompt. Markdown and `haf.trajectory.v1` training
exports are available from the session header; trajectory export excludes hidden
system messages and workspace paths. Every file/process/browser action calls a BFF capability
endpoint and therefore still crosses policy, OPA, approval and effect journals.
The earlier dependency-free console remains at `/` for recovery/diagnostics.

## Electron desktop

`@haf/desktop` wraps the Canvas URL in a hardened Electron BrowserWindow:
context isolation, Chromium sandbox, no Node integration, web security,
navigation-origin restriction, denied webviews, allowlisted permissions and
external HTTPS links through the OS browser. electron-builder targets DMG/ZIP,
NSIS/ZIP, AppImage and DEB. Desktop packaging requires Node 22.12+; the server
runtime remains compatible with Node 20+.
