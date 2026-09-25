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

# Current-upstream gap audit — 2026-08-18

This audit re-checks Hybrid Agent Fabric (HAF) against the current default branches of all three reference projects. It is intentionally stricter than the original 1.0 implementation matrix: a feature is counted as present only when HAF has an integrated implementation and test/build evidence. Similar names, prompts, diagrams, or unverified adapter contracts do not count as parity.

## Revisions inspected

Fetched on 2026-08-18 (Europe/Istanbul):

| Project | Current revision inspected | Previously inspected revision | Role in HAF |
|---|---|---|---|
| [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | `c41bda23d6b648bf3a30422ab9d71bd7675caea1` | `0d15c5e79e91a659f238954e1db8a3da289c4801` | Experience and control plane |
| [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) | `e85a67ac4ad7fef2f2a5b922a78fcede85786ac7` | `97b994c3d7c45ca1ae635190e91e9e58ddf2577c` | Runtime, session, supervisor and RLM plane |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | `77d6c78cf52ec9f2c3245174cf763ff32a75d572` | `165c889e5b4277b56dadd42949a4112c1e6175a6` | Capabilities, integrations, security and knowledge plane |

The audit inspected current source trees, architecture/reference documents, package manifests, tests, changelogs, provider/plugin catalogs, and the HAF implementation itself. Selected current source checkouts contained approximately 1,302 OpenHands files, 1,110 Prime files and 4,432 Hermes files in the inspected areas.

## Important upstream observations

### OpenHands / Agent Canvas

The current repository remains the Agent Canvas experience plane rather than the old monolithic Python runtime. Notable current surfaces include:

- conversation, terminal, browser, files, image/attachment and diff UX;
- separate agent profiles and LLM profiles;
- backend registry, device-flow authentication and backend health;
- MCP management and redacted MCP credentials;
- plugin discovery/install/enable UX;
- automation detail, activity, health, responder deployment and Git sync;
- task-tracking event rendering, transcript export, repository switching and workspace upload;
- reusable npm library entry points, i18n, Monaco/xterm and Electron distribution.

HAF 1.0 already covered the core control-center layout, backend registry, REST/SSE, terminal/files/browser/changes/tree/automations, secure browser session and Electron boundary. It did not have the current Canvas's full profile/plugin/MCP/settings depth, attachment flow, repository management, automation Git-sync detail, component-library packaging or UI maturity.

### Prime Agent

The current Prime architecture still validates HAF's resident worker/supervisor direction. The strongest current runtime details include:

- authenticated host requests with request IDs, generation fences, cancellation and currentness checks;
- daemon-owned append-only RLM spawn ledger and retained transcript tombstones;
- queued `auto` / `steer` / `follow_up` agent messaging with family reach rules, receipts, rate limits and pending limits;
- user and programmatic heartbeats distinct from general schedules;
- automatic compaction recovery that resumes unfinished work;
- continual-harness refinement for prompts, memories, skill descriptions and subagent specifications;
- extension events across session/model/tool/input/UI lifecycles;
- TUI, JSON, RPC, ACP and reconnectable agent-connection modes.

HAF 1.0 had the main runtime boundaries—serialized actors, generations/sequences, detached workers, replay/snapshot, recovery, persistent Python, children, goals, autonomy, schedules and direct messaging—but its direct-message semantics, host-request fencing, continual-harness refinement and extension surface remain less complete.

### Hermes Agent

Hermes has expanded substantially. Current high-value surfaces include:

- native Gemini in addition to native Anthropic and OpenAI-shaped providers;
- same-provider credential pools, cooldowns, OAuth sources and explicit provider fallback chains;
- a much larger provider-plugin catalog, including Responses/Codex, Bedrock, Vertex, Azure, Copilot, Qwen OAuth and others;
- model, image, video, browser, web-search, memory, context-engine, secret-source and observability plugin families;
- text-to-image/editing, video generation, streaming TTS and media delivery;
- Streamable HTTP MCP, OAuth, client certificates, elicitation, circuit breaking and dynamic discovery;
- Singularity/Apptainer, serverless sandboxes and egress isolation;
- many additional messaging adapters and profile-based inbound routing;
- desktop profiles, interactive frames/widgets, hidden interaction turns, Kanban orchestration and plugin SDK;
- micro-compaction, trajectory export, memory providers such as Honcho, and richer learning loops.

HAF 1.0 covered much of the security and deployment foundation, but not the full breadth above.

## Gap matrix

Legend: **done** means integrated and tested in HAF; **partial** means a real implementation exists but current-upstream depth is not yet matched; **open** means no equivalent implementation yet.

| Area | 1.0 state | 1.1 action in this pass | Current state |
|---|---|---|---|
| Native Gemini GenerateContent | OpenAI-compatible profile only | Added native message/tool/usage adapter, Gemini 3 tool IDs and no-key-in-URL transport | **done** |
| Explicit model fallback chain | missing | Added per-session ordered `provider:model` fallbacks; no implicit cross-policy fallback; no replay after partial output | **done** |
| Same-provider credential rotation | missing | Added opaque inventory, round-robin use, 401/403 disable, retry cooldown, pre-output failover and restart persistence | **done** |
| Provider error hygiene | upstream body could enter errors | Added bounded/redacted provider error envelopes and safe classification | **done** |
| Intent retention under context pressure | old messages were dropped from the left | Added non-destructive projection: user/system messages stay verbatim; old derived/tool output becomes bounded preview + SHA-256 | **done** |
| Hermes micro-compaction/context engines | batch compaction only | Added intent-preserving projection, signed transforms and packaged rolling micro-compaction | **partial** — optional auxiliary-model semantic summaries and more provider engines remain |
| OpenHands task tracking / Hermes Kanban core | missing | Added durable session task board, dependencies, cycle rejection, priorities, assignment, auto-block/unblock, capabilities, API commands and Canvas panel | **partial** — multi-board orchestration and routines remain |
| OpenHands transcript export | missing | Added versioned JSON and Markdown exports plus Canvas download action | **done** |
| Hermes image generation | missing | Added OpenAI/FAL generation/editing, 1–4 bounded artifacts, up to eight references and verified FAL upscaling | **partial** — additional provider catalogs remain |
| Hermes Singularity backend | missing | Added digest-pinned Apptainer/Singularity backend with clean environment, containment, workspace bind and network-off default | **done** at adapter/contract level; real HPC validation requires Apptainer infrastructure |
| OpenHands profile/settings depth | basic provider profiles | no full UI/profile store in this pass | **partial** |
| Prime direct-message queue semantics | basic target-session dispatch | 1.2 adds durable auto/steer/follow-up, family reach, broadcast, receipts, rate/pending limits and uncertainty | **done** for core queue semantics |
| Prime continual harness `/refine` | learning governor exists | 1.2 adds evidence-validated edit batches, persistent history, governed promotion tracking and batch rollback | **partial** — automatic model planning/review remains |
| Remote MCP + OAuth | stdio only | 1.2 added guarded Streamable HTTP; 1.3–1.6 added mTLS/OAuth/elicitation; 1.15 added restart recovery | **done** for the core client boundary; real third-party OAuth conformance remains external validation |
| Provider plugin breadth/OAuth | nine profiles | native Gemini/Responses/Azure/Vertex/Bedrock, Codex subscription and generic OIDC/PKCE bearer sources delivered | **partial** — provider-specific non-OIDC wire modes remain |
| Image editing/video generation | absent | Added confined multi-reference image/video, synchronous FAL and 2x/4x image upscale chains | **partial** — async job providers and video upscaling remain |
| Web-search provider plugins | bounded fetch only | 1.2 adds normalized Brave/Tavily providers and `web.search` | **partial** — additional providers remain |
| Memory/context/secret-source plugin families | built-in memory + local/Vault/KMS | hooks, rolling compaction, native Honcho and pinned command/1Password/Bitwarden sources delivered | **partial** — additional packaged memory engines remain |
| Additional messaging platforms and profile routing | six native platforms + signed webhook | Added rule routing, bidirectional Mattermost/LINE/Google Chat/Teams/Feishu, IRC/IRCv3, SMTP/IMAP and signed Twilio SMS | **partial** — additional providers/transports remain |
| Interactive desktop frames/widgets | secure Electron shell only | Added hash-bound opaque-origin frames, postMessage action bridge and hidden turns | **done** for the core isolated artifact boundary; richer desktop window/profile UX remains |
| Full TUI/JSON/RPC client | REST/SSE, ACP and Canvas | Added remote TUI, one-shot stdin and JSON-RPC stdio client with reconnecting SSE | **partial** — advanced widget/application parity remains |

## Implemented in HAF 1.1

### Model runtime

- `GeminiProvider` uses native `generateContent`, native function declarations/calls/responses, usage normalization and reasoning events.
- `ModelRouter` supports explicit per-session fallback routes and emits content-free route audit events.
- Fallback happens only before provider output. Once partial output has been emitted, HAF fails rather than duplicating a generation.
- `CredentialPoolModelProvider` rotates only within one provider and never returns raw keys in status.
- Provider HTTP errors have bounded, redacted diagnostics and structured cooldown/disable disposition.

### Context continuity

- Model-facing context projection no longer silently drops old user instructions.
- Durable transcripts and session trees remain unchanged.
- Old assistant/tool material is represented by bounded previews, hashes and original-size metadata.
- Projection telemetry is emitted with model-request audit events.
- The configured character budget is treated as soft when user-authored source-of-truth alone exceeds it; overflow is explicit rather than hidden.

### Durable task board

- Commands and model capabilities: `task.list`, `task.create`, `task.update`.
- States: backlog, ready, in progress, blocked, review, done, cancelled.
- Priorities, dependency validation, cycle rejection, direct-child assignment and automatic unblock.
- Tasks are part of snapshots, work with file or PostgreSQL snapshot persistence, appear in prompt context and are rendered in Canvas.

### Media and HPC execution

- `image.generate` materializes PNG/JPEG/WebP/GIF artifacts under `.haf/artifacts/images/`.
- Provider URLs are rejected by default; base64 is requested to avoid credential-bearing or SSRF-prone artifact retrieval.
- Byte caps, base64 validation, raster magic-byte validation, owner-only files and workspace confinement are enforced.
- Singularity/Apptainer images require a local SHA-256 or digest-pinned remote URI unless an administrator explicitly opts out.
- The backend uses a clean environment, containment, no home mount, writable temporary overlay, confined workspace bind and network `none` by default.
- The local Python kernel stays disabled in Singularity mode so it cannot bypass that execution boundary.

### Experience plane

- Added a Canvas Tasks panel and runtime counters.
- Added Markdown transcript download from Canvas.
- Added JSON/Markdown export API.
- Provider API now reports credential-pool state without secrets.

## Implemented in HAF 1.2

### Prime runtime depth

- Durable agent inbox backed by local atomic files or PostgreSQL/RLS.
- Explicit `pending`, `claimed`, `delivered` and `uncertain` outcomes; stale claims are not silently replayed.
- Direct parent/sibling/child reach, sibling-scoped names, bounded family broadcast, sender-derived identity, token-bucket rate limits and pending limits.
- `auto`, `steer` and `follow_up`; busy auto messages are injected at a model boundary while follow-ups remain serialized prompts.
- Family roster/inbox/message APIs, model capabilities and Canvas messaging controls.
- Python protocol v2 with execution/request IDs, kernel generations, per-execution authentication, duplicate response replay, stable idempotency and hard cancellation of synchronous kernels.
- Evidence-validated continual-harness refinement batches whose edits remain scanned/evaluated candidates, with persistent history, promotion-state tracking and reverse-order rollback.

### Hermes integration depth

- Streamable HTTP MCP with public URL checks, same-origin enforcement, URL-credential/query rejection, redirect rejection, server-side environment headers, tool timeout, circuit breaker and transactional dynamic tool refresh.
- Native OpenAI Responses API provider with tool history translation, normalized output/usage and `store:false`.
- Normalized Brave/Tavily-backed `web.search` with bounded provenance-bearing results and unsafe URL filtering.
- Confined, validated single-source image editing through multipart image edit endpoints.
- Privacy-preserving `haf.trajectory.v1` training export with normalized tool calls/results and no hidden system prompt or workspace path.
- Bounded binary attachment materialization through policy/effect journals, optional SHA-256 verification and Canvas upload-to-prompt UX.

## Implemented in HAF 1.3

- Typed sandbox-aware local Git status/diff/branch/create/switch/commit capabilities and Canvas controls.
- Git commit hooks are disabled and no push/fetch/credential surface is exposed to the model.
- Composite TypeScript builds are forced to re-emit excluded `dist` trees even when incremental metadata survives.
- Environment-referenced MCP mutual TLS with bounded PEM validation, strict server verification and no-secret list/API projection.
- Persistent content-only MCP schema cache; cache writes are observer behavior and cannot break live tools.
- Persistent custom model routes with environment-only credential/header references, exact custom-origin audience binding, hot lifecycle controls and Canvas management.

## Implemented in HAF 1.4

- Tenant-scoped persistent agent profiles with immutable session snapshots, supplemental instructions, default model/fallback routing and Canvas lifecycle management.
- Exact profile capability allowlists enforced at tool projection, broker dispatch and nested Python host-call boundaries.
- Child/fork profile inheritance prevents delegation from regaining hidden capabilities.
- Profile updates affect only future sessions, preserving replay and prompt reproducibility.

## Implemented in HAF 1.5

- Broker-encrypted MCP OAuth state, PKCE verifier, access/refresh tokens, dynamic registration and discovery cache.
- Authorization Code + PKCE pending connection lifecycle with short-lived constant-time state validation, public callback completion, denial cancellation and resource cleanup.
- Environment-only OAuth client credential references and Canvas MCP management; browser/API lists never receive token material.

## Implemented in HAF 1.6

- Human-gated MCP form and URL elicitation with advertised client capabilities and five-minute promises.
- Tenant-scoped pending metadata, primitive-only bounded schema sanitization, strict submitted-content validation and explicit accept/decline/cancel.
- Public URL validation, timeout/restart expiration and Canvas/API response workflows.
- Elicited values are live-transport-only and never persisted into audit metadata, transcripts, model context or cache.
- Native Azure OpenAI deployment routing with `api-key` auth and explicit API versions.
- Native Vertex AI Gemini routing with publisher resource paths and OAuth bearer auth.

## Implemented in HAF 1.7

- Native AWS Bedrock Converse with standard AWS credential-chain auth, tool history and cache usage normalization.
- Workspace-relative multimodal image references with late MIME/magic-byte/SHA-256 verification and no base64 snapshot persistence.
- Native image block projection across OpenAI Chat/Responses, Azure, Anthropic, Gemini/Vertex and Bedrock.
- Canvas image chips and privacy-preserving trajectory metadata, bounded to eight images per prompt.

## Implemented in HAF 1.8

- Pluggable FAL-backed text-to-video and confined image-to-video generation with normalized duration/aspect contracts.
- Owner-only MP4/WebM workspace materialization after bounded base64/download and magic-byte validation.
- Remote video URLs are opt-in and revalidated across redirects; Canvas Media and BFF surfaces expose no provider credentials.

## Implemented in HAF 1.9

- Strict model-planned continual-harness review over explicitly untrusted trajectory excerpts.
- Real event-log evidence binding, candidate-only output and immutable base prompt/policy boundaries.
- Optional single-flight turn cadence, durable review history, manual API planning and Canvas governance workflows.
- Evaluation/promotion/rollback remains Learning-Governor controlled; model review never self-promotes.

## Implemented in HAF 1.10

- Bounded credential-free HTTPS Git bootstrap with public-address checks, redirect denial, shallow/blob-filtered clone and post-clone quotas.
- Exact-origin Credential Broker leases and ephemeral askpass keep private tokens out of URLs, arguments, logs, sessions and model state.
- Verified HEAD, automatic failure cleanup, optional branch/profile assignment, Control API and Canvas bootstrap UX.

## Implemented in HAF 1.11

- Signed-plugin context projection transforms with immutable system construction and byte-equivalent preservation of every original user message.
- Invalid, timed-out or intent-dropping engines fall back to the last good built-in projection.
- Bounded additive memory-provider transforms preserve local governed memory and label external entries as untrusted.

## Implemented in HAF 1.12

- SHA-256-pinned external secret-source registry for generic commands, 1Password CLI and Bitwarden CLI.
- Shell-free bounded execution with clean environment allowlists and fixed provider argument contracts.
- Direct Credential Broker import while values, source references and command arguments remain absent from list/refresh/model/session surfaces.
- CRUD/refresh APIs and Canvas metadata/write-only management.

## Implemented in HAF 1.13

- Workspace-confined 25 MiB outbound media loading with raster/video/audio/PDF magic-byte checks.
- Native Telegram/Discord/Slack/WhatsApp/Matrix/Signal media contracts and HMAC-signed webhook base64 envelopes.
- Provider-specific upload/ID/message flows, captions/thread routing and no credential material in payload projections or results.

## Implemented in HAF 1.14

- Tenant-scoped priority inbound channel routing over platform, chat type, hashed chat/user identity and bounded metadata equality.
- Stable per-chat/per-user/per-thread lanes with frozen agent-profile assignment at first route admission.
- Rule CRUD, explicit outbound media BFF and Canvas Channels management; raw IDs remain absent from persistence/list output.

## Implemented in HAF 1.15

- Restart-resumable in-flight MCP Authorization Code + PKCE coordination backed by expiring encrypted Credential Broker descriptors.
- Callback lookup uses a SHA-256 projection of high-entropy state while raw state, PKCE verifier, static client credentials, headers and TLS material stay broker-encrypted.
- A replacement control process reconstructs the OAuth provider, SDK transport and MCP client before exchanging the authorization code; duplicate completion/denial callbacks are serialized.
- Success, denial and expiry clear the one-time state/verifier and pending descriptor, while graceful shutdown preserves an active browser flow.
- Cross-origin authorization servers require exact trusted origins; each server-side OAuth/MCP request remains SSRF-checked and redirects are rejected.

## Implemented in HAF 1.16

- Packaged rolling micro-compaction runs before the last-resort intent-preserving context projection and never mutates the durable transcript.
- Older contiguous assistant/tool windows become bounded SHA-256-bound summaries marked as untrusted derived data; original user/system messages and the protected recent tail remain exact.
- Tool calls/results retain names, status, hashes, shapes and bounded key inventories without copying result values into the cache.
- Tenant/session observer caches are bounded, atomically written and reusable across turns; cache corruption, oversize or write failure falls back to deterministic recomputation without blocking the model turn.
- Projection telemetry reports micro-compacted messages, windows and cache hits.

## Implemented in HAF 1.17

- Added an exclusive external-memory provider manager that always keeps local governed memory active and supplies provider context only to the transient model projection.
- Added native Honcho SDK integration for cross-session summaries, user representations, peer cards, configurable recall cadence and bounded/chunked turn writeback.
- Honcho peers and sessions use tenant/session hashes rather than raw tenant/session identifiers; provider output is bounded, fence-sanitized and marked as untrusted external memory.
- Added governed profile, search, session-context, dialectic-reasoning and conclusion capabilities, with cost/write operations crossing the external-side-effect approval boundary.
- Post-turn synchronization uses a content-free pending/delivered/uncertain journal. Uncertain external effects are not retried automatically, and raw turn content is absent from the journal/status API.
- The official SDK transport is patched fail-closed to enforce per-request SSRF checks, exact configured origin, manual redirects and bounded timeout; credentials remain in server-side closures.

## Implemented in HAF 1.18

- Added native ChatGPT Codex subscription routing after confirming current upstream device-auth, token refresh, account-model catalog and Codex Responses contracts rather than guessing public API semantics.
- Device flow, access/rotating refresh token, expiry and cooldown state are Credential Broker-encrypted and restart persistent; status exposes only timestamps and a one-way account projection.
- Live model discovery preserves account visibility/priority and intentionally does not filter `supported_in_api` or synthesize unavailable slugs.
- Codex requests use exact first-party origin/headers, content-addressed session cache routing, reserved Harmony token neutralization and bounded raw SSE event projection for text, reasoning, tools and usage.
- One pre-output 401/403 may force refresh and retry. Redirects are forbidden, 429 cooldown is persisted, and truncated streams after partial output are non-retryable.
- Added Control API and Canvas device login, polling, model discovery, hot activation and logout surfaces without browser token storage.

## Implemented in HAF 1.19

- Added a separately packaged remote `haf-client` rather than coupling automation clients to the in-process engine.
- JSON-RPC 2.0 stdio covers initialization, health, session lifecycle, arbitrary governed session commands, replay reads, event subscribe/unsubscribe and approval resolution with standard error envelopes.
- SSE subscriptions reconnect with the last durable sequence, suppress duplicate replay, back off exponentially and terminate through AbortSignal without browser storage.
- The terminal mode provides session create/load/list, live text/tool/status projection, multiline prompts, model switching, cancellation, compaction and approval controls.
- One-shot automation accepts prompt content only through bounded stdin and emits one machine-readable JSON result. Bearer credentials are environment-only and absent from process arguments/request bodies/errors.
- REST responses, errors, SSE frames and stdin are bounded; API redirects and origin changes fail closed.

## Implemented in HAF 1.20

- Added outbound Mattermost, LINE Messaging, Google Chat, Microsoft Teams and Feishu/Lark adapters to the governed channel registry and Canvas discovery surface.
- Mattermost supports channel posts, root-thread replies and native file upload; Feishu supports chat/reply messages plus bounded image/file upload keys.
- Google Chat supports space/thread messages, Teams distinguishes chat and team-channel destinations, and LINE uses its push-message contract.
- LINE, Google Chat and Teams reject workspace binary media explicitly because these contracts do not offer the same safe direct byte-upload path; HAF never creates an implicit public URL.
- The shared provider boundary now forces manual redirects, caps response bodies and redacts credential-shaped text from provider failures.

## Implemented in HAF 1.21

- Added tenant-scoped hosted GitHub/GitLab account records referencing existing Credential Broker secrets rather than persisting account tokens.
- GitHub supports user and installation-token repository catalogs; GitLab supports membership-scoped projects with bearer or private-token authentication.
- Normalized repository metadata and open pull-request/merge-request summaries are available through bounded control-plane APIs.
- Hosted import accepts only a provider-returned repository ID, resolves authoritative clone metadata, checks the exact configured clone origin and delegates to the existing askpass/size/time-confined importer.
- Imported sessions retain provider/repository/default-branch/imported-HEAD links. Read-only sync status compares local/imported/remote HEADs without hidden fetch, pull, merge or push.
- Every API request receives a one-use exact-audience lease, public-address validation, manual redirects and an 8 MiB response bound. Registry/list outputs remain token-free.

## Implemented in HAF 1.22

- Image generation/editing accepts up to eight unique workspace-confined references; video generation accepts four, with 40 MiB aggregate bounds and explicit provider feature negotiation.
- OpenAI multi-reference edits use repeated multipart image fields. Native FAL image generation/edit and FAL video use bounded server-side data-URI arrays without credential URL/body projection.
- Added a dedicated FAL image upscaler, standalone `image.upscale`, and optional generation→upscale chains with stage-level provider/model provenance.
- PNG, JPEG, GIF and WebP dimensions are parsed before/after upscaling; outputs smaller than the requested 2x/4x dimensions fail rather than being reported as successful.
- Provider responses are bounded, FAL/OpenAI redirects are denied, and every result still passes raster/video magic-byte and workspace artifact checks.
- REST, model capabilities and Canvas Media now expose multi-reference paths, configured upscalers, scale selection and direct-source upscale.

## Implemented in HAF 1.23

- Added a durable asynchronous video job manager and native FAL Queue transport for submit, status, result and cancellation operations.
- Job records carry explicit submitting/queued/running/succeeded/failed/cancelling/cancelled/uncertain state. Process restart converts interrupted submit/cancel boundaries to uncertain rather than replaying an external effect.
- Prompt text, workspace paths, source image data, credentials and provider-returned URLs remain absent from durable job state/list responses; idempotency keys are SHA-256 projected.
- FAL queue URLs are constructed from configured model plus validated request ID. Redirects and unknown statuses fail closed; result JSON is bounded before MP4/WebM materialization.
- Added model capabilities, REST lifecycle endpoints and Canvas submit/poll/cancel controls. Polling is explicit and does not create hidden background traffic.

## Implemented in HAF 1.24

- Added authenticated inbound Mattermost, LINE Messaging, Google Chat, Microsoft Teams and Feishu/Lark routes feeding the existing durable profile-routing/channel gateway.
- LINE verifies base64 HMAC-SHA256 over exact raw bytes; Feishu optionally verifies timestamp+nonce+encrypt-key+raw-body SHA-256 and rejects requests outside five minutes.
- Google Chat and Teams use an exact-origin JWKS verifier with 1 MiB bounds, redirect denial, one-hour cache and strict issuer/audience verification. Teams issuer/JWKS remain explicit operator configuration rather than guessed metadata.
- Every platform applies non-empty sender/chat/space/conversation allowlists, maps provider event IDs to command idempotency and stores only hashed channel identities.
- Authenticated webhooks are acknowledged before long agent execution; background failures log error class only and outbound responses use the registered platform adapter.

## Implemented in HAF 1.25

- Added a standalone release-tool package generating deterministic source manifests, CycloneDX 1.5 and SPDX 2.3 SBOMs, SHA-256 sums and in-toto/SLSA provenance v1.
- Provenance binds copied release artifacts, the source-manifest aggregate and the exact OpenHands/Prime/Hermes revisions used by the audit.
- Optional Ed25519 attestations sign a canonical checksum payload using an environment-only PKCS#8 key; bundles contain public verification material but never private keys.
- Verification rehashes every metadata/artifact file, validates traversal-safe checksum names, payload digest, key identity and signature.
- SOURCE_DATE_EPOCH controls timestamps/invocation IDs. Source walking excludes dependency/build/runtime/cache trees, environment/credential/session files and private-key extensions.

## Implemented in HAF 1.26

- Added workspace-confined UTF-8 HTML artifacts capped at 2 MiB, content-hashed at publication and invalidated on source mutation.
- Frames run at opaque origin with iframe and CSP sandbox `allow-scripts` only; network, nested frames, forms, objects and base URLs are denied.
- Short-lived in-memory frame channels cap interactions and a frozen `hafArtifact.emit/request` bridge validates parent source, channel, action and interaction ID.
- Artifact actions dispatch as hidden model turns. Internal message/tool/delta events remain available for model continuity/audit but are filtered from public snapshots/tree/events/SSE/ACP, all transcript formats, search/index and external-memory synchronization.
- Interaction persistence contains action/status plus payload/response SHA-256 only. Duplicate IDs are not replayed and failed/uncertain outcomes stay explicit.
- Added Canvas artifact publication/frame/interaction governance and Electron same-origin artifact-only subframe navigation.

## Implemented in HAF 1.27

- Added native FAL-backed standalone 2x/4x video upscaling over workspace-confined MP4/WebM sources.
- Inputs use bounded server-side data URIs; provider credentials remain header-only and exact HTTPS/redirect controls apply.
- MP4 dimensions are extracted through bounded container traversal to `tkhd` fixed-point fields; WebM dimensions use bounded PixelWidth/PixelHeight parsing.
- Outputs must satisfy both requested width and height factors and still pass normal MP4/WebM magic/byte/materialization controls.
- REST, model capability and Canvas Media surfaces expose configured video upscalers and return verified dimensions.

## Implemented in HAF 1.28

- Added GitHub pull-request and GitLab merge-request create/comment/close/merge capabilities and REST/Canvas governance surfaces.
- REST mutations resolve an authoritative session and therefore cross normal external-side-effect policy, approval and effect journals rather than calling hosted APIs as an ungoverned admin shortcut.
- Every write requires a bounded idempotency key. Durable records contain input/key hashes, status, review number and remote ID but omit title/body/comment/token material.
- Merge requires the expected remote review HEAD SHA; deferred pipeline merge and source-branch removal stay disabled.
- Pending/succeeded/failed/uncertain operation states distinguish deterministic 4xx failure from ambiguous transport, redirect, retry-class HTTP or provider-response outcomes. Uncertain writes are never replayed automatically.

## Implemented in HAF 1.29

- Added a tenant-scoped GitHub App registry referencing Credential Broker secret IDs for RSA private keys and webhook secrets; list APIs expose key status/counts but not secret references or values.
- Installation starts persist only a SHA-256 digest of high-entropy state. Setup callbacks verify the returned numeric installation through app-authenticated `GET /app/installations/{id}` before the ID is encrypted into Credential Broker.
- App JWTs follow current GitHub RS256, `iat`, `exp` and `iss` rules. Primary/secondary keys support no-downtime rotation and bounded failover only when GitHub deterministically rejects app authentication.
- Installation tokens are minted on demand, encrypted, cached only until the refresh window and integrated as a native credential source for hosted repository listing, import and governed PR writes.
- Raw-body `X-Hub-Signature-256` verification supports rotating webhook secrets. Delivery GUIDs are keyed-projectively deduplicated; installation/repository/pull-request lifecycle rows store payload hashes and bounded sync metadata, never the payload or installation ID.
- Control API and Canvas can register an app from existing secret IDs, open the official install URL, list verified installations and bind one as a hosted account.

## Implemented in HAF 1.30

- Added a native long-lived IRC/IRCv3 adapter that starts/stops with the engine, feeds authorized messages through Channel Gateway lanes and serves automatic/manual outbound replies through the existing governed channel registry.
- Public DNS plus certificate-verified TLS are defaults. Private destinations, plaintext and custom CA bundles require explicit bounded operator configuration; PASS/SASL credentials are never allowed on plaintext.
- CAP 302 negotiates message tags, server time and account tags. SASL PLAIN is attempted only when advertised and only over TLS; authentication/nickname failures block reconnect rather than looping credentials.
- Exact configured channels and nickname/account allowlists govern ingress and direct-message response authority. CTCP/control input, oversized buffers/lines, destination injection and unauthorized senders fail closed.
- PING/PONG bypasses model latency. Agent work is concurrency-bounded; normal transport loss reconnects with bounded jitter, a new generation and no credential/status persistence.
- Outbound Unicode is split by code point into at most 512-byte IRC wire frames, rate-spaced and reported as socket-accepted rather than exactly-once delivery. REST/Canvas status is content-free.

## Implemented in HAF 1.31

- Added fixed-origin SMTP outbound using implicit TLS or required STARTTLS. DNS/private-network policy is applied before every connection and provider credentials remain in transport closures.
- Added optional persistent read-only IMAP ingestion with UIDVALIDITY awareness, bounded UID batches and restart-safe cursors. Initial sync defaults to the current mailbox tail; full historical bootstrap is explicit.
- Inbound mail requires exact sender and recipient allowlists plus a constant-time shared `X-HAF-Email-Token` before a model turn can be created. Auto-generated/list/bulk loops are suppressed.
- Added a bounded in-tree MIME parser rather than accepting an unsafe HTML parser dependency: header folding/encoded words, multipart recursion, base64/quoted-printable text and HTML-to-text fallback are capped; attachments never enter context.
- Email input is fenced as untrusted data and routing metadata stores hashes/counts only. The durable journal stores UID, event key, sender hash, status and error code without subject/body/address/token content.
- Reply dispatch records `responding` before SMTP. Restart or ambiguous SMTP failure becomes `uncertain`, advances the UID cursor and is never automatically replayed.
- The existing channel capability supports confined email attachments, reply Message-ID threading and exact destination rules. Engine lifecycle and REST/Canvas expose content-free connection/outcome counters.

## Implemented in HAF 1.32

- Added native Twilio SMS as an outbound ChannelAdapter and signed public inbound route feeding the same durable Channel Gateway/profile-routing plane.
- Outbound messages require exact E.164 allowlists and a fixed configured sender. The exact Twilio REST origin/path is constructed locally; Basic auth stays header-only, responses are bounded and redirects are ambiguous failures.
- Inbound verification uses the exact operator-configured public webhook URL plus case-sorted decoded form fields, HMAC-SHA1 and constant-time comparison. Host/proxy headers cannot alter signed material.
- AccountSid, MessageSid, configured recipient, sender allowlist, body and media count are validated before durable admission. The route acknowledges with TwiML before model work.
- MessageSid becomes the Channel Gateway command key. A content-free journal prevents duplicate webhook dispatch/reply and contains only event/phone hashes, status and error code.
- Reply state is persisted before the Twilio POST. Process replacement or any ambiguous send failure becomes uncertain with no automatic replay; raw phone numbers, body, response and auth token remain absent from state.
- Binary MMS is refused because HAF does not invent a public workspace URL. REST/Canvas expose bounded delivery/outcome counts only.

## Implemented in HAF 1.33

- Added bounded authenticated file reads through existing hosted GitHub/GitLab providers. Exact provider/repository/ref/path boundaries, base64 size, remote blob version and UTF-8 are verified before JSON parsing.
- Added tenant Git source records bound to one authoritative session. Remote manifests cannot choose another session, credential reference or provider account; model overrides require an exact administrator allowlist and webhook entries inherit one admin-supplied secret environment reference.
- A strict version-1 manifest supports at most 100 keyed manual/schedule/webhook automations. Prompt/name/timeout/interval/cron/timezone/ref/path and duplicate-key constraints are validated before mutation.
- Synchronization is two-phase: plan emits create/update/unchanged/disable actions and a 15-minute SHA-256; apply re-fetches and rejects any branch/content movement.
- Managed automations retain source/key/entry/manifest provenance. Updates reconcile scheduler jobs and removed keys are disabled rather than deleted.
- Source state omits prompt and manifest content. Applying is persisted before reconciliation; restart or mid-apply failure becomes explicit partial/failed state and is never silently replayed or called atomic.
- Added REST and Canvas source creation, planning, exact-hash apply and lifecycle status.

## Implemented in HAF 1.34

- Added generic tenant-scoped OIDC Authorization Code + PKCE model credential sources using operator-registered client IDs. HAF does not ship another product's first-party client identity.
- Registration pins one HTTPS issuer, explicit authorization-server origins, `openid` scopes and exact model resource origins. Discovery issuer and authorization/token/JWKS endpoints are revalidated against SSRF and origin rules; redirects and oversized/malformed responses fail closed.
- State, verifier, nonce, discovery, access/rotating refresh tokens and optional confidential-client secret references remain Credential Broker-confined. ID-token signature, issuer, audience, expiry, nonce and subject are verified; list surfaces expose only hashes/timestamps.
- Public, client-secret Basic and client-secret POST methods are explicit. Refresh happens before expiry; invalid/missing refresh requires re-login rather than crossing to another credential source.
- Model configurations can reference an OAuth source instead of an environment key. Tenant and exact base-URL origin must match the source's resource audience.
- A dynamic bearer wrapper materializes the same provider profile for each call. One credential rejection may force refresh and retry only before any model event; partial output is never replayed.
- Added REST/Canvas source registration, authorization, logout, lifecycle and OAuth-backed route controls.

## Implemented in HAF 1.35

- Added file-backed same-provider pool state scoped to each runtime/provider ID. Only opaque credential IDs, disabled/cooldown state, bounded failure metadata and timestamps are persisted; key values are never written.
- Constructor restore merges only currently configured IDs. Removed credentials cannot reappear from stale state and newly introduced IDs receive clean authority.
- Credential rejection disablement and retry cooldowns survive process replacement. Active cooldown windows remain unavailable; expiration restores availability naturally.
- Failure-state persistence completes before another credential is attempted. Successful model output remains authoritative even if its observer-state write fails afterward.
- Added explicit system-admin one/all reset through ModelRouter/REST and per-entry Canvas controls; reset is persisted rather than mutating only the current process.
- Custom model endpoints now require an explicit provider/aggregator/local data-policy label, while built-in origins inherit their profile. Tenant-aware inventories expose the label alongside route state.

## Implemented in HAF 1.36

- Added external responder deployment records bound to one tenant webhook automation, its exact event type and a Credential Broker secret reference.
- Heartbeat/event ingress verifies HMAC-SHA256 over exact raw JSON plus bounded timestamp and nonce. Nonce hashes persist for a five-minute replay window; secret values never enter responder state or list APIs.
- Heartbeats persist bounded version/capability metadata and a one-way instance projection. Health is derived as pending/healthy/degraded/stale/disabled from report state and administrator-selected cadence.
- Signed events are durably admitted before asynchronous dispatch. Event IDs are hashed and deduplicated; retries cannot create a second automation run.
- Journals contain processing/delivered/failed/uncertain, run ID and bounded error code only. Restart during processing or unknown dispatch exceptions become uncertain with no automatic replay.
- Credential rotation immediately invalidates the prior signer and clears nonce state. Enable/disable/remove lifecycle is tenant-admin governed.
- Added public heartbeat/event endpoints plus REST/Canvas registration and health/outcome inspection.

## Implemented in HAF 1.37 — Aurora PDF Phase A

- Read and extracted all 125 PDF pages, grouped the architecture into Agent Society, ACOS, embodiment, memory, multi-world models, initiative, skill evolution, thought loops, user model and world model, and recorded the full gap map in `aurora-pdf-feature-audit.md`.
- Added tenant-seeded Aurora Prime, seven executive directors and specialist archetypes. Roles are organizational metadata, never a policy bypass; optional agent profiles may only preserve or narrow parent authority.
- Added a durable task marketplace with exact capability tags, role bids, deterministic coverage/reputation/confidence/cost scoring and explicit token/time estimates.
- Added daily token reserve/use accounting and concurrent-task limits. Awarding fails when resource budgets are exhausted rather than silently overspending.
- Awarded work spawns an isolated Prime child session with role purpose and bounded objective. Outcome completion requires real child event IDs and updates role reputation from verified success/quality.
- Added council deliberations with role set, quorum, weighted approve/reject/abstain perspectives, confidence, preserved summaries, dissent and missing-role output. Close conflicts resolve as uncertain.
- Added governed society capabilities, tenant-admin REST and a Canvas Society panel.

## Implemented in HAF 1.38 — Aurora PDF Phase B

- Added first-class observation/problem/hypothesis/insight/risk/opportunity/decision objects with source, confidence, importance, urgency, impact, user relevance, horizon, relations and bounded resource requests.
- Added a durable Global Workspace queue with queued/focused/deferred attention states; no candidate is silently dropped when attention is exhausted.
- Added constitutional P0-P4 cognitive goals and arbitration that ranks class before numeric score while preserving close same-class conflicts.
- Added daily token budgets, reservations, focused slots, actual-use completion accounting and safe day-rollover requeue.
- Added a constrained reactive/research/development/reflection/dream/emergency mode graph with durable reasons and transition history.
- Added hash-only thought iteration history; three consecutive identical results block the object and release attention without storing raw iteration text.
- Added governed cognitive capabilities, tenant-admin REST and a Canvas Cognitive/Global Workspace panel.

## Remaining work, ordered

### P0 — runtime and security depth

1. **Provider auth/runtime**: provider-specific non-OIDC OAuth/wire conformance beyond delivered generic OIDC/PKCE, native Codex subscription, persistent credential pools, custom-route data-policy labels, Azure OpenAI, Vertex Gemini and AWS Bedrock Converse.
2. **Real distributed validation**: PostgreSQL inbox wake-up now uses content-free LISTEN/NOTIFY, but PostgreSQL, NATS, Vault, OIDC and remote sandbox paths still require integration tests against external services.

### P1 — capability and experience breadth

3. Additional media providers beyond OpenAI/FAL and provider-specific visual quality/conformance environments. Multi-reference media, verified image/video upscaling and durable asynchronous FAL Queue jobs are delivered.
4. Additional web-search providers with the same citation/provenance contract.
5. Additional packaged memory engines beyond Honcho and optional auxiliary-model semantic summaries. Native Honcho user modeling, deterministic rolling micro-compaction, safe plugin contracts and model-planned review are delivered.
6. Hosted responder provisioning/scale deployment and broader OpenHands plugin settings. Signed responder health/events, two-phase Git manifests, GitHub App lifecycle, governed PR/MR writes, hosted import, local typed Git, persisted LLM routes and agent profiles are delivered.
7. Rich desktop profile/window orchestration beyond the delivered isolated artifact frame, action bridge and hidden-turn core.
8. Additional long-lived/stateful providers beyond the delivered native IRC/IRCv3, TLS-first SMTP/IMAP email, signed Twilio SMS, bidirectional Mattermost/LINE/Google Chat/Teams/Feishu and core platform set.

### P2 — distribution and operator polish

9. Advanced TUI widget/application parity beyond the delivered remote terminal and stable headless JSON-RPC client.
10. Reusable Canvas component package, i18n, accessibility, Monaco/xterm parity and richer event renderers.
11. Native installer builds/signing/notarization under Node 22.12+ and each target OS.
12. Deployment conformance suites and CI identity/keyless transparency-log integration beyond the delivered local SBOM/provenance/Ed25519 attestations.

## Verification evidence

Executed after the 1.1 changes:

- `npm run check`: passed.
- Engine: 92 suites, 236 tests passed.
- Control API: 2 suites, 10 tests passed.
- Headless client: 2 suites, 5 tests passed.
- Release tool: 1 suite, 3 tests passed.
- Desktop: 1 suite, 1 test passed.
- Total normal suite: 98 suites, 255 tests passed.
- `npm run test:adversarial`: 175 tests passed.
- `npm run test:chaos`: 14 tests passed.
- All TypeScript workspace typechecks passed.
- All application/package builds passed.
- Canvas production build: 1,590 modules; 292.07 kB JS / 84.69 kB gzip; 23.59 kB CSS / 4.57 kB gzip.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- HAF 1.15 restart OAuth smoke is covered by a real local HTTP authorization/token/MCP transport: control-manager replacement preserved the pending PKCE flow, one of two concurrent callbacks completed, the replay failed, the governed tool executed and raw state/client/header secrets were absent from plaintext storage.
- HAF 1.16 micro-compaction tests verify exact user preservation, deterministic cache reuse, no copied tool-result value in summaries/cache and fail-open recovery from malformed cache state.
- HAF 1.17 tests cover native Honcho context/writeback, tenant-projected identities, all five governed tools, exact-origin/redirect transport hardening, transient-only context injection, delivered/uncertain journaling and no replay after uncertainty. A real hosted Honcho credential was not available, so hosted conformance remains external validation.
- HAF 1.18 tests cover restart-resumable Codex device OAuth, encrypted token rotation, account projection/catalog filtering, first-party headers, Harmony neutralization, SSE text/reasoning/tool/usage output, one pre-output refresh and non-retryable partial-stream truncation. No ChatGPT subscription credential was available, so live OpenAI entitlement/quota conformance remains external validation.
- HAF 1.19 tests cover exact-origin/auth headers, bounded errors, redirect rejection, SSE reconnect/cursor deduplication and JSON-RPC lifecycle/errors. A live local smoke initialized RPC against the running API and completed a one-shot stdin prompt with persisted session/result.
- HAF 1.20 tests validate text contracts for five new platforms, native Mattermost/Feishu media upload, explicit unsupported-media rejection, redirect denial and provider-error credential redaction. Real platform credentials remain external validation.
- HAF 1.21 tests cover GitHub and GitLab catalogs, reviews, auth headers, broker-only tokens, hosted import selection, local/remote sync classification, unsafe API origins, redirects, disabled accounts and malicious clone-origin substitution. Real hosted account credentials remain external validation.
- HAF 1.22 tests cover OpenAI multi-part references, FAL multi-reference/data-URI contracts, generation→upscale provenance, direct upscaling, false-scale rejection and multi-reference video projection. Real FAL credentials and visual-quality conformance remain external validation.
- HAF 1.23 tests cover FAL Queue submit/status/result/cancel, restart polling, bounded MP4 materialization, hashed idempotency, duplicate suppression, redirect/request-ID rejection and uncertain submission/cancellation with no replay. Real queue credentials remain external validation.
- HAF 1.24 tests cover LINE and Feishu exact-byte signatures/replay rejection plus bounded cached JWT/JWKS issuer/audience verification and redirect denial. A live local route smoke accepted Mattermost form payload, LINE signed JSON and Feishu challenge, then created independent durable Mattermost/LINE sessions. Real Google/Teams platform JWTs remain external validation.
- HAF 1.25 tests cover deterministic manifests/SBOM/provenance, generated/sensitive exclusions, copied artifact checksums, Ed25519 signing/verification, tamper detection, output escape and duplicate artifact rejection. Hosted CI identity/keyless transparency remains external work.
- HAF 1.26 tests cover source confinement/hash invalidation, ephemeral grants, action/payload guards, content-free interactions, hidden engine turns excluded from every export/search/public event path, and Electron frame navigation allowlisting. A live frame smoke verified script-only CSP, delivered a hidden interaction, returned zero public session messages and persisted only payload/response hashes. Real Electron packaged-runtime UX remains Node 22/external OS validation.
- HAF 1.27 tests cover FAL request/auth/body handling, MP4 dimension traversal, successful verified 2x materialization, undersized-output rejection, path escape, redirects and unsafe model IDs. Real provider quality/codec conformance remains external validation.
- HAF 1.28 tests cover GitHub/GitLab create/comment/close/exact-SHA merge payloads, credential headers, hashed content/idempotency journals, duplicate suppression, uncertain transport outcomes, deterministic 422 failure and invalid merge SHA rejection. Real write-enabled hosted accounts remain external validation. The prior live Canvas/channel smoke and public GitHub import remain valid.
- HAF 1.29 tests generate real 2048-bit RSA keys, verify JWT signatures/claims, survive manager replacement during install state, reject spoofed/replayed callbacks, rotate from rejected primary to secondary keys, refresh encrypted installation tokens, bind the token source into hosted repositories, verify/deduplicate rotating-secret webhooks and assert private keys/webhook secrets/raw installation IDs/tokens never enter registry/list state. Real GitHub App credentials and organization approval flows remain external validation.
- HAF 1.30 tests run real local TCP and certificate-verified TLS IRC servers, exercise CAP/message-tags/PING, account allowlists, Channel Gateway ingress and reply, Unicode wire splitting, TLS-only SASL PLAIN, credential-free status, reconnect generation and private-network/protocol-injection guards. A real public IRC network credential was not available, so network-specific conformance remains external validation.
- HAF 1.31 tests run a real certificate-verified authenticated SMTP server, exercise text/media delivery and header-injection rejection, then use a protocol-shaped fake IMAP client to verify UIDVALIDITY/cursor restart behavior, exact token/sender/recipient gates, content-free state, reply threading, uncertain SMTP no-replay and bounded MIME parsing. Real Gmail/Outlook/other hosted mailbox credentials remain external validation.
- HAF 1.32 tests cover exact Twilio REST URL/form/Basic-auth contracts, E.164 confinement, signed asynchronous ingress, tamper rejection, MessageSid duplicate suppression, content-free state, and uncertain reply no-replay across adapter replacement. Real Twilio credentials and carrier delivery receipts remain external validation.
- HAF 1.33 tests cover hosted file decoding/version/hash checks, plan/apply create-update-disable reconciliation, unchanged detection, branch movement rejection, session/model/webhook authority confinement, traversal and duplicate-key rejection, expired schedules and prompt-free source state. Real hosted automation repositories and external scheduler responders remain external validation.
- HAF 1.34 tests cover PKCE parameters, restart-resumable state, encrypted token/refresh rotation, signed ID-token nonce/audience/issuer binding, resource-origin denial, poisoned discovery and redirect rejection, exact confidential-client secret audience, tenant route binding, one pre-output refresh and no retry after partial output. Real provider registrations/entitlements remain external validation.
- HAF 1.35 tests cover restart-restored cooldowns, persisted disablement, explicit reset, removed-entry filtering, key redaction and mandatory custom-origin data-policy labels. Existing pre-output rotation and no-partial-replay tests remain green.
- HAF 1.36 tests cover signed heartbeat health transitions, nonce replay, timestamp/tamper/event-type rejection, credential rotation, asynchronous event dispatch, event-ID dedupe, uncertain no-replay and secret/payload/instance redaction. Real hosted responder provisioning remains external validation.
- HAF 1.37 tests cover role seeding, marketplace tag rejection, deterministic award, token/concurrency budgets, isolated specialist spawn, child-event evidence, reputation updates, dissent-preserving uncertain consensus and profile escalation denial. Later Aurora PDF phases remain explicitly tracked rather than claimed complete.
- HAF 1.38 tests cover P0-P4 arbitration, attention ordering, slot/token deferral, reservation/use accounting, repeated-loop hash blocking, raw-iteration redaction, constrained mode transitions and daily rollover requeue.

These results validate local contracts and mocked transports. They do not replace the external-infrastructure validations listed in the backlog.

## Security conclusions

- Provider fallback is explicit because silently crossing from a direct provider to an aggregator can change data residency and policy.
- Credential-pool status contains IDs and cooldown metadata only; keys remain in server-side provider closures.
- Image generation defaults to base64 materialization. Remote artifact URLs are not fetched unless an administrator explicitly enables that path, and even then public-address and redirect checks apply.
- Singularity lifecycle isolation is not claimed to be equivalent to a VM. Its real boundary depends on the host's Apptainer configuration, kernel and site policy.
- HAF still does not claim exactly-once external side effects. Command/effect journals provide idempotency and explicit uncertain outcomes.

## Completion statement

HAF 1.38 adds the Aurora Global Workspace and cognitive-control core after 1.37 Agent Society and 1.36 signed automation responder deployment health/events, 1.35 restart-persistent credential pools and explicit custom-route data policy, 1.34 generic OIDC/PKCE model credentials, 1.33 two-phase hosted Git automation manifests, 1.32 signed Twilio SMS, 1.31 TLS-first SMTP/IMAP email, 1.30 native IRC/IRCv3, 1.29 GitHub App lifecycle, 1.28 governed hosted reviews, 1.27 verified video upscaling, 1.26 isolated artifacts, 1.25 SBOM/provenance, 1.24 inbound channel verification, 1.23 durable media jobs, 1.22 multi-reference media, 1.21 hosted GitHub/GitLab, 1.19 remote TUI/headless JSON-RPC, 1.18 Codex subscription, 1.17 Honcho user modeling, 1.16 rolling micro-compaction and 1.15 restart-resumable MCP OAuth. Current-upstream and Aurora-PDF parity are still not complete: Aurora cognitive-object/memory/world-model/initiative/evolution phases, additional provider OAuth conformance, hosted responder provisioning, more transport providers, rich desktop/TUI profile widgets, signed native installers and external deployment conformance remain open. These are recorded here rather than hidden behind a “complete” checkbox.
