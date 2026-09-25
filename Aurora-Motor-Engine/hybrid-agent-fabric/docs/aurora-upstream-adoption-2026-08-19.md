# Aurora upstream adoption — 2026-08-19

This note records what HAF 1.40 deliberately adopted from the three reference projects to strengthen
Aurora, what it refused to copy, and how each borrowed idea is governed once it is inside Aurora.

Sources re-read for this pass:

| Project | What was studied | Adopted into Aurora |
|---|---|---|
| [OpenHands](https://github.com/OpenHands/OpenHands) + [software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) | event-sourced conversation state, condensers, microagents/skills with trigger activation, sub-agent delegation, stuck detection, LLM security analyzer with confirmation policy, budget accounting in state | microagent knowledge registry, stuck detector, risk analyzer + confirmation policy |
| [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) | RLM programmatic tool calling, daemon-owned sessions, retained sub-agents, heartbeats/goals/autonomous budgets, **Continual Harness** `H = (prompt, sub-agents, skills, memory)` with `/refine`, snapshots and rollback | continual harness with CRUD components, evidence-backed refinement batches, snapshots, rollback by ID and effectiveness feedback |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | closed learning loop (agent-curated memory, autonomous skill creation, skill self-improvement during use), pluggable memory/context engines, checkpoints and rollback, dangerous-command approval detection, personality/identity layering | destructive-pattern rule catalog, knowledge effectiveness feedback, identity/mission core, friction-to-skill learning inside the ACOS loop |

## What was adopted, and how Aurora governs it

### 1. Microagent knowledge (OpenHands) → `MicroagentRegistry`

OpenHands loads small knowledge documents when a trigger fires instead of permanently inflating the
system prompt. Aurora adopts the activation model (`always`, `keyword`, `glob`, `manual`) and adds
four governance properties the upstream model does not need but Aurora does:

- **Injection screening with quarantine.** Knowledge is prompt content, so every write is screened for
  instruction override, role hijack, policy bypass, credential exfiltration, autonomy escalation and
  destructive instructions. A finding disables the document until a human reviewer clears it, and the
  reviewer is recorded on the record.
- **Recall budgets.** Every recall is bounded in characters; overflow is reported as `omitted`, never
  silently dropped.
- **Effectiveness feedback.** Documents that never help lose priority instead of accumulating.
- **Content digests** so an audit can prove which knowledge text was in context.

### 2. Stuck detection (OpenHands) → `analyzeStuck` / `StuckDetectorService`

A model-free analyzer over the durable event log detects repeated actions, repeated error classes,
two-capability oscillation, monologue, byte-identical output, approval starvation and an already-fired
runtime guardrail. It is pure and deterministic, so it is cheap enough to run every ACOS cycle.

Aurora then *uses* the signal rather than only displaying it: the observe phase turns stuck sessions
into sourced cognitive objects, and the learn phase converts recurring friction into Phase F
capability-gap observations with evidence references.

### 3. Security analyzer and confirmation policy (OpenHands, Hermes) → `RiskAnalyzerService`

A rule catalog of genuinely destructive patterns (recursive root delete, `mkfs`/`dd` to a device, fork
bombs, force push, unscoped SQL `DELETE`/`DROP`, `curl | sh`, credential reads and exfiltration,
privilege escalation, mass process kills, cron/history tampering) raises a declared capability risk to
`low | medium | high | critical`, recommends a safe execution zone 0–4 and applies a tenant
confirmation policy (`never | critical | high | medium | all`).

Two constitutional constraints separate this from the upstream analyzers:

- it is **escalation-only** — it can require more scrutiny, never less, and it cannot grant authority
  the policy engine has not granted;
- built-in **critical rules cannot be disabled**, so a tenant cannot quietly turn off the floor.

### 4. Continual Harness (Prime) → `ContinualHarnessService`

Prime's strongest idea is that the harness around the model — supplemental prompts, memories, skill
descriptions and sub-agent specifications — is state the agent may improve from its own trajectory.
Aurora adopts the `H = (prompt, sub-agents, skills, memory)` decomposition with the same CRUD surface
and adds the governance that makes it safe to run unattended:

- refinements are **batches**, size-limited (default 8 operations) and **rate-limited per day**;
- every batch **snapshots** the affected scope before applying, so `rollback` restores exactly;
- rollback is **ordered** — newer refinements in the same scope must be rolled back first;
- entries carry origin, evidence references, use counts and helpful/unhelpful effectiveness, and
  `prune` removes agent-authored entries that are unused or consistently unhelpful;
- session scope and tenant scope are separate, and projection into a prompt is **character-budgeted**;
- the immutable base system prompt, policy, agent profiles and capability allowlists are **outside**
  this surface by construction, so self-improvement can never widen authority.

### 5. Identity and constitution (Hermes personality layering, ACOS) → `ConstitutionService`

The PDF's Internal Constitution Checker and Long-Term Identity Core become a real service: sixteen
seeded principles (the twelve cross-cutting rules plus four ACOS operating principles), a versioned
mission, an append-only continuity log, and a deterministic `check()` that evaluates declared decision
attributes and returns `allow | review | deny` with the violated principle codes and a concrete remedy.

Built-in **hard** principles cannot be softened or retired — including by Aurora itself — while every
amendment requires an approver, a reason and a version bump that lands in the identity continuity log.

### 6. Concept formation (Aurora Dream Mode) → `memoryGraph.proposeInsights`

Dream Mode is implemented as deterministic association: memories that share tags but have never been
connected, weighted by tag overlap, cross-layer/claim-type distance, textual dissimilarity and
importance. Candidates are proposals only; `materializeInsight` is the explicit write that stores a
palace-layer hypothesis linked to both sources.

### 7. ACOS control loop → `CognitiveOrchestrator`

Every Aurora subsystem was already durable and independently governed. The orchestrator is what makes
them one organism: a bounded tick walking Observe → Update World → Prioritize → Allocate → Execute →
Evaluate → Learn → Remember → Reflect → Evolve, with cycle modes (`full`, `maintenance`, `reflection`,
`dream`, `emergency`), a durable cycle report, thought-journal entries, whole-organism status and
per-phase degradation instead of an all-or-nothing failure.

The cycle itself is constitution-checked, and it never executes side effects directly: every phase
calls an already-governed service.

### 8. Prompt assembly (Hermes prompt layering, OpenHands microagent recall) → `AuroraContextComposer`

Hermes layers personality, memory and skill context into the system prompt; OpenHands injects
microagent knowledge as a recall observation. Aurora composes all four of its own sources into one
budgeted block with explicit trust markers, appends it to the session system prompt, digests it for
audit and reports its size in context-projection stats. Composition is fail-open, and the base prompt
and profile instructions stay ahead of it in precedence.

## What was deliberately not copied

- **Unbounded self-modification.** Prime's `/refine` is adopted; a general "agent edits its own code"
  path is not. Executable change still goes through the Phase F staged pipeline with approval.
- **LLM-based risk classification.** The upstream security analyzer can call a model; Aurora's is
  rule-based and deterministic so it cannot be talked out of a verdict, and it never lowers a level.
- **Prompt-visible raw knowledge without screening.** Microagents are prompt content and are screened.
- **Exactly-once external effects.** Nothing here weakens the effect journal's uncertain-outcome rule.
- **Cross-session chatter.** Aurora keeps Prime's nuclear-family messaging scope; the new
  communication bus is role-addressed inside one tenant society, with retention bounds.

## Evidence

`packages/engine/test/aurora-core-upstream.test.ts` and `packages/engine/test/aurora-acos.test.ts`
cover: constitutional deny/review/allow paths, hard-principle immutability, mission versioning,
harness batch limits, ordered rollback and pruning, microagent activation/budget/quarantine/demotion,
risk escalation, policy modes and undisableable critical rules, all seven stuck patterns, insight
proposal/materialization, full and degraded ACOS cycles, signal flow through the loop and the
whole-organism status view.
