# Peer-system gap audit, round four — 2026-08-20

Rounds one to three are closed (26 gaps, 1.50.0 – 1.61.0). This round is different in method: instead of
reading release notes, the peers' **source code** was cloned and read —
[`OpenHands/software-agent-sdk`](https://github.com/OpenHands/software-agent-sdk),
[`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) and
[`PrimeIntellect-ai/prime-agent`](https://github.com/PrimeIntellect-ai/prime-agent) — with Claude Code and
Codex compared from their published changelogs as before.

Reading the code rather than the notes changes what you find: the notes describe features, the tree
describes *primitives*. Three of the gaps below are things every peer has had for a long time and nobody
writes a release note about.

## 1. What the peers' trees contain

| Peer | Module | What it is |
|---|---|---|
| OpenHands SDK | `openhands-tools/tools/{glob,grep}` | Dedicated file-pattern and content-search tools, bounded and truncation-aware, separate from directory listing |
| OpenHands SDK | `openhands-tools/tools/apply_patch` | Patch application as a first-class tool rather than whole-file rewrites |
| OpenHands SDK | `sdk/critic`, `sdk/context/condenser`, `sdk/security` | Result critique, context condensation strategies, LLM risk analysis with a confirmation policy |
| OpenHands SDK | `tools/{task_tracker,planning_file_editor,delegate,workflow}` | Planning and delegation as tools |
| Hermes | `agent/lsp/*` (client, manager, servers, workspace, range_shift, reporter) | A real language-server client: diagnostics, symbols, definitions, kept in sync with edits |
| Hermes | `agent/verify/{recipes,runner,environment}`, `verification_evidence.py`, `verification_stop.py` | Detects the project's own build/test commands, runs them, keeps the evidence, and blocks "done" without it |
| Hermes | `prompt_cache_boundary.py`, `prompt_cache_scope.py`, `prompt_caching.py` | Explicit prompt-cache breakpoints, scoped per conversation |
| Hermes | `repetition_guard.py`, `empty_response_guard.py`, `estop.py`, `iteration_budget.py` | Loop and degeneracy guards distinct from a stuck detector |
| Hermes | `monitoring/otlp_exporter.py`, `monitoring/policy.py`, `redaction.py` | Telemetry export with a redaction policy |
| Prime Agent | `packages/{agent,ai,coding-agent,tui}` | Runtime/model/coding split; skills shipped with the coding agent |

## 2. Gaps, ranked and ordered for implementation

### P0 — daily-use primitives Aurora simply did not have

| # | Gap | Why it matters | Status |
|---|---|---|---|
| S1 | **`filesystem.glob` and `filesystem.grep`** | Aurora had `list` and `read` and a semantic `knowledge.search`. Finding "every file matching `src/**/*.ts`" or "every line matching `TODO\|FIXME`" meant listing a tree and reading files one by one — the most common thing a coding agent does, done the most expensive way | **Done in 1.62.0** |
| S2 | **`filesystem.patch`** | Editing meant rewriting a whole file, which costs tokens proportional to file size and silently discards concurrent changes. Every peer applies patches with verified context | **Done in 1.62.0** |
| S3 | **Project verification with durable evidence** | Aurora could plan, execute, review a diff and record confidence — but never ran the project's own build and tests and kept the receipt. "Done" rested on having written code | **Done in 1.62.0** |

### P1 — next

| # | Gap | Why it matters | Status |
|---|---|---|---|
| S4 | **Language-server integration** (diagnostics, symbols, definitions, references) | Hermes keeps an LSP client per workspace: after an edit, the compiler's own opinion is available without running a build. Aurora has no code intelligence at all | **Done in 1.63.0** |
| S5 | **Prompt-cache breakpoints** | Aurora prices cache reads but never *marks* cache boundaries, so long sessions pay full price for a stable prefix | **Done in 1.64.0** |
| S6 | **Degeneracy guards**: repeated identical tool calls, empty responses, iteration budgets distinct from the stuck detector | Aurora's stuck detector notices a session going nowhere over time; peers also refuse the specific pathologies as they happen | Planned |
| S7 | **Telemetry redaction policy** on the OTLP path | Aurora exports operational metrics; Hermes attaches an explicit redaction policy to what leaves the process | Planned |

### P2 — considered and rejected

- OpenHands' LLM-based `critic` and `security_risk` scoring: Aurora's risk classes are declared per capability and
  enforced deterministically by a layered policy. Asking a model to grade its own actions adds the failure mode the
  policy engine exists to remove. Aurora's `harness.refine` and plan-feedback calibration already cover the useful half.
- Prime's package split and TUI, OpenHands' agent-server: packaging and product surface, not engine capability.
- OpenHands' `condenser`: Aurora already has rolling micro-compaction plus the context composer.

## 3. What 1.62.0 fixes

**S1 — Search primitives.** `filesystem.glob` matches a pattern (relative to the searched directory,
`**` crossing separators) and returns matches newest-first with size and mtime. `filesystem.grep`
searches contents by regular expression with optional include filter and context lines, returning
`path:line` with the matching text. Both skip dependency and build directories, refuse to follow
symlinks out of the workspace, bound how many files they touch, and report truncation. Binary files are
reported as skipped rather than dumped into a transcript.

**S2 — Patch application.** `filesystem.patch` parses a unified diff, verifies every hunk's context
against the file on disk, and applies **all files or none** — a patch that fails on the second file does
not leave the first one edited. `dryRun` reports the same plan without writing. A stale context is an
error, not a fuzzy match: the diff was written against a file that has since changed, and guessing is
how an agent silently corrupts work. Paths are workspace-confined like every other write.

**S3 — Verification.** `VerificationService` detects the project's own commands from lockfiles,
manifests and script tables (Node with the right package manager, Python with uv/poetry, Go, Rust,
Maven, Gradle, Make), runs `build` then `test` through the same sandbox as any other command, and stores
durable evidence: command, exit code, duration and a bounded output tail. It stops at the first failing
phase, and `verified` requires that a build or test phase actually ran — a project with no checks is
`inconclusive`, never verified. `verify.recipe`, `verify.run` and `verify.evidence` expose it to the
agent; the Canvas inspector shows whether the session can currently prove anything.

**S4 — Language-server integration.** Aurora now runs a real LSP client — `code-intelligence/` with
`protocol.ts` (framing + sanitization), `client.ts` (one client per `(server, workspace)` pair,
whole-document sync, version-based freshness, `ContentModified` retry, graceful shutdown), `servers.ts`
(language profiles + binary discovery) and `service.ts` (orchestration). It serves **diagnostics**
(tsc/pyright/gopls/rust-analyzer when the binary is installed, sandboxed `tsc --noEmit`, `ruff` or
read-only Python AST, `go vet`, `cargo check` otherwise), **symbols**, **definition** and
**references**; the fallbacks are a dependency-free structural scanner and exact token search. Every
run is durable evidence: per-file SHA-256 digests make `fresh`/`stale` a content question rather than a
clock question, and the same guarantees Hermes' `reporter.py` enforces — server-produced fields are
sanitized and length-capped because a hostile repo can inject instruction-shaped text through an
identifier — are enforced before anything crosses into a tool result. Capabilities: `code.catalog`,
`code.diagnostics.run`, `code.diagnostics.evidence`, `code.symbols`, `code.definition`,
`code.references`; REST under `/v1/sessions/:id/code*`; Canvas Diagnostics row. LSP spawns are gated to
the local sandbox backend by default and bounded (2 live servers, per-request timeouts, frame caps).

**S5 — Prompt-cache breakpoints.** `PromptCacheService` derives a breakpoint plan for every assembled
request — system block, conversation prefix and message tail, each labeled stable or volatile by
SHA-256 digest comparison against the previous plan (same freshness discipline as code diagnostics) —
and emits Hermes' default four-breakpoint layout (end of the static system prefix via the system block,
end of system, last tool, last two non-system messages). `prefixHit` is a verdict, not a guess: it is
true only when both stable regions are byte-identical to what the previous request shipped. Cache scope
is the physical session id — Aurora compacts in place, so unlike Hermes there is no lineage walk, and
fork/delegate children keep their own isolated scope. Plans are durable evidence (bounded history, per
request), `AnthropicProvider` places the `cache_control` markers (skipping textless messages), and
`session.cache.config` is a privileged approval-gated operation because a marker at the wrong boundary
changes what a request costs.

## 4. Next steps

S6 degeneracy guards, S7 telemetry redaction.
