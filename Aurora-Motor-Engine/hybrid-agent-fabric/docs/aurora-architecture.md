# Aurora system architecture — the complete map

This is the single reference for what Aurora is in this repository: every layer of the source
architecture, the service that implements it, the governed capability and REST surfaces it exposes,
and the tests that prove it. It complements rather than replaces:

- [`aurora-pdf-feature-audit.md`](aurora-pdf-feature-audit.md) — the original 125-page audit and phase plan
- [`aurora-upstream-adoption-2026-08-19.md`](aurora-upstream-adoption-2026-08-19.md) — what was taken from OpenHands, Prime Agent and Hermes, and what was refused
- [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) — the checklist view

## The shape of the system

```
                       ┌──────────────────────────────────────────────┐
                       │  Constitution + Long-Term Identity Core       │  binding
                       │  (principles C1-C12, P1-P4, versioned mission)│
                       └───────────────────────┬──────────────────────┘
                                               │ every decision is checked
┌───────────────┐   ┌──────────────────────────▼──────────────────────┐   ┌──────────────────┐
│ Intake        │──▶│  ACOS control loop                              │──▶│ Proactive        │
│ world, git,   │   │  observe → update-world → prioritize → allocate │   │ initiative       │
│ files, memory │   │  → execute → evaluate → learn → remember        │   │ P0-P4, budget,   │
│ calendar, ... │   │  → reflect → evolve                             │   │ silence, digests │
└───────────────┘   └──┬───────┬───────┬────────┬────────┬───────┬────┘   └──────────────────┘
                       │       │       │        │        │       │
              ┌────────▼─┐ ┌───▼────┐ ┌▼──────┐ ┌▼─────┐ ┌▼─────┐ ┌▼──────────┐
              │Cognitive │ │Memory  │ │World +│ │Deci- │ │Plans │ │Society     │
              │workspace │ │pyramid │ │multi- │ │sions │ │      │ │marketplace │
              │attention │ │+ graph │ │world  │ │      │ │      │ │+ bus       │
              └──────────┘ └────────┘ └───────┘ └──────┘ └──────┘ └────────────┘
                       │       │        │         │        │            │
              ┌────────▼───────▼────────▼─────────▼────────▼────────────▼──────┐
              │ Embodiment: environment inventory, zone 0-4 action records,     │
              │ mandatory verification, rollback, tool reputation               │
              └────────────────────────────┬───────────────────────────────────┘
                                           │ evidence
              ┌────────────────────────────▼───────────────────────────────────┐
              │ Learning: experience distillation → continual harness /         │
              │ microagent knowledge / staged skill evolution → evolution index │
              └─────────────────────────────────────────────────────────────────┘

  Prompt assembly: constitution (binding) + harness (guidance) + knowledge (untrusted) +
  memory recall (untrusted), each character-budgeted, digested and fail-open.
  Autopilot: bounded unattended cadence that drives the loop between conversations.
  Provenance: any artifact can be traced back through every layer above.
```

Everything above sits **on top of** the existing HAF runtime — supervisor, session actors, event
store, capability broker, policy engine, approvals, effect journal, sandboxes and credential broker —
and none of it can widen that runtime's authority.

## Layer map

| Source layer | Implementation | Capabilities | REST | Tests |
|---|---|---|---|---|
| L0 core infrastructure | existing HAF supervisor, event store, scheduler, policy, sandboxes | (runtime) | `/v1/sessions/*` | `engine.test.ts`, `event-store.test.ts` |
| L1 memory | `MemoryGraphService` — pyramid L1-L8, Memory Object standard, relation graph, consolidation, contradictions, anchors | `memory.graph.*`, `memory.anchor.*`, `memory.insights.*` | `/v1/memory-graph/*` | `aurora-memory-graph.test.ts` |
| L2 user model | `UserModelService` — typed claims, consent, correction, deletion, goals, signals, state estimate | `user.*` | `/v1/user-model/*` | `aurora-initiative-user-model.test.ts` |
| L3 context | `AuroraContextComposer` + existing context manager/compaction | (prompt assembly) | — | `aurora-context.test.ts` |
| L4 world model | `WorldModelService` — entity/state/relation/event, causality, temporal, calibration, simulation | `world.*` | `/v1/world/*` | `aurora-world-model.test.ts` |
| L5 multi-world model | `MultiWorldModelService` — 12 perspectives, debate, scenarios, future tree, reality alignment | `multiworld.*` | `/v1/multiworld/*` | `aurora-world-model.test.ts` |
| L6 reasoning | `DecisionService` + `PlanningService` — weighted decisions with calibration, dependency plans with critical path | `decision.*`, `plan.*` | `/v1/decisions/*`, `/v1/plans/*` | `aurora-reasoning.test.ts` |
| L7 thought loop | `CognitiveWorkspaceService` — objects, states, attention, loop detection, curiosity, intake | `cognitive.*` | `/v1/cognitive/*` | `cognitive-workspace.test.ts`, `aurora-cognitive-extensions.test.ts` |
| L8 reflection | reflection scheduling, ACOS reflect phase, thought journal | `cognitive.reflection.schedule`, `acos.journal` | `/v1/cognitive/reflections`, `/v1/acos/journal` | `aurora-cognitive-extensions.test.ts`, `aurora-acos.test.ts` |
| L9 self-improvement | `ExperienceDistiller` + `ContinualHarnessService` | `experience.*`, `harness.*` | `/v1/experience/*`, `/v1/harness/*` | `aurora-reasoning.test.ts`, `aurora-core-upstream.test.ts` |
| L10 skills | existing skill registry/hub plus `MicroagentRegistry` knowledge | `skills.*`, `microagents.*` | `/v1/skills/*`, `/v1/microagents/*` | `skills-hub.test.ts`, `aurora-core-upstream.test.ts` |
| L11 skill evolution | `SkillEvolutionService` — gaps, staged pipeline, scores, regression, retirement, index | `evolution.*` | `/v1/evolution/*` | `aurora-evolution-environment.test.ts` |
| L12 agent society | `AgentSocietyService` — roles, marketplace, reputation, deliberation, bus, meta-monitor | `society.*` | `/v1/society/*` | `agent-society.test.ts`, `aurora-society-extensions.test.ts` |
| L13/L14 opportunity + risk detection | `ProactiveInitiativeService` watchers and scoring | `initiative.*` | `/v1/initiative/*` | `aurora-initiative-user-model.test.ts` |
| L15 proactive initiative | worthiness, P0-P4, attention budget, silence, digests, trust | `initiative.evaluate`, `initiative.digest` | `/v1/initiative/evaluate` | `aurora-initiative-user-model.test.ts` |
| L16 communication | existing channel gateway and adapters plus society bus | `channels.*`, `society.bus.*` | `/v1/channels/*`, `/v1/society/messages` | `channel-*.test.ts`, `aurora-society-extensions.test.ts` |
| L17 computer control | existing filesystem/process/browser/git/kernel capabilities under policy | `filesystem.*`, `process.run`, `browser.*`, `git.*` | `/v1/sessions/*` | `engine.test.ts`, `browser-manager.test.ts` |
| L18 environment awareness | `EnvironmentAwarenessService` — inventory, zones, action records, verification, habits, projects | `environment.*` | `/v1/environment/*` | `aurora-evolution-environment.test.ts` |
| L19 safety | `ConstitutionService` + `RiskAnalyzerService` + existing policy/approvals/effect journal | `constitution.*`, `risk.*` | `/v1/constitution/*`, `/v1/risk/*` | `aurora-core-upstream.test.ts` |
| L19 enforcement | `AuroraPolicyEngine` in the layered policy stack — evidence-driven, escalation-only | (binds every capability) | `/v1/aurora/enforcement*` | `aurora-policy-enforcement.test.ts` |
| ACOS orchestration | `CognitiveOrchestrator` + `AuroraAutopilot` | `acos.*`, `autopilot.*` | `/v1/acos/*`, `/v1/autopilot` | `aurora-acos.test.ts`, `aurora-reasoning.test.ts` |
| Fleet supervision | `AuroraFleetSupervisor` | `aurora.fleet.*` | `/v1/aurora/fleet/*` (system admin) | `aurora-fleet.test.ts` |
| Execution bridge | `AuroraExecutionBridge` | `plan.delegate`, `plan.sync`, `plan.activate` | `/v1/plans/:id/delegate`, `/v1/delegations/*` | `aurora-delegation.test.ts` |
| Role authority | `RoleAuthorityService` | `society.authority.*` | `/v1/society/authority/*` | `aurora-role-authority.test.ts` |
| Outcome harvesting | `AuroraOutcomeHarvester` | `plan.harvest*` | `/v1/delegations/harvest`, `/v1/harvest-review` | `aurora-outcome-harvest.test.ts` |
| Plan feedback | `AuroraPlanFeedback` | `decision.feedback-*` | `/v1/decision-feedback/*` | `aurora-plan-feedback.test.ts` |
| Estimation calibration | `AuroraEstimationCalibrator` | `plan.estimation-*` | `/v1/estimation/*` | `aurora-estimation.test.ts` |
| Repository instructions | `ProjectInstructionService` | `project.instructions*` | `/v1/sessions/:id/instructions` | `project-instructions.test.ts` |
| Lifecycle hooks | `LifecycleHookService` | `hooks.*` | `/v1/hooks*` | `lifecycle-hooks.test.ts` |
| Tool discovery | `discoveryCapabilities` | `tool.search`, `tool.describe`, `tool.catalog` | `/v1/capabilities/search` | `project-instructions.test.ts` |
| Explainability | `ProvenanceService` | `aurora.explain` | `/v1/aurora/explain` | `aurora-reasoning.test.ts`, `aurora-end-to-end.test.ts` |
| Anomaly detection | `StuckDetectorService` | `session.stuck.analyze` | `/v1/sessions/:id/stuck` | `aurora-acos.test.ts` |
| Recovery | `WorkspaceCheckpointService` — bounded content-addressed snapshots, reversible restore | `checkpoint.*` | `/v1/checkpoints/*` | `aurora-operations.test.ts` |
| Telemetry | `AuroraMetricsCollector` — content-free gauges and derived alerts | `aurora.metrics`, `aurora.alerts` | `/v1/aurora/metrics`, `/metrics` | `aurora-operations.test.ts` |
| Governance | `AuroraDataGovernanceService` — export, purge, integrity self-check, footprint | `aurora.export`, `aurora.purge.user`, `aurora.selfcheck` | `/v1/aurora/*` | `aurora-operations.test.ts` |

## The constitutional invariants, and where they are enforced

| Rule | Enforced by |
|---|---|
| C1 no unconstrained super-agent | society role hierarchy; profile-bound child execution cannot exceed the parent allowlist |
| C2 policy above agents | capability broker + policy engine + approvals; every Aurora service is a capability caller, never a bypass |
| C7 enforced, not advised | `AuroraPolicyEngine` denies critical destructive patterns and confirms high-risk ones at the capability boundary |
| C3 sourced claims | memory object standard, world state facts, cognitive objects, constitution check `C3` |
| C4 typed epistemics | `claimType` on memory/world/cognitive records; constitution check `C4` |
| C5 bounded proactivity | initiative worthiness, attention budget, quiet hours, duplicate suppression, trust feedback |
| C6 staged evolution | skill evolution stage gates with approval and regression baseline; distiller proposals are candidates |
| C7 critical action discipline | environment zones, approval and rollback requirements, mandatory verification, risk analyzer |
| C8 explicit budgets | cognitive daily budget and allocation buckets, society budget, initiative budget, autopilot ceiling, fleet sweep ceiling |
| C9 preserved dissent | society deliberation, multi-world consensus, decision dissent records |
| C10 governed user model | typed claims with consent, correction, deletion and protected-topic refusal |
| C11 interruptible cognition | loop detection, focus interruption, preemption, autopilot backoff, fleet circuit breaker |
| C12 no exactly-once claims | existing effect journal and uncertain outcomes; nothing added weakens it |

## Data on disk

All Aurora state is durable, bounded, atomically written and tenant-scoped, under `<home>/data`:

```
acos/state.json            ACOS cycle reports and thought journal
acos/autopilot.json        cadence config and unattended run ledger
acos/fleet.json            fleet enrollment, circuit-breaker state and the sweep ledger
planning/delegation.json   plan-step to society-task links, match evidence and delegation policy
planning/harvest.json      outcome scorecards, review queue and harvesting policy
planning/feedback.json     decision outcomes derived from finished plans, with evidence
planning/estimation.json   measured estimate/actual pairs behind the correction factors
policy/lifecycle-hooks.json operator hook rules, configuration and the firing ledger
checkpoints/state.json     workspace checkpoint manifests (content blobs live under checkpoints/blobs)
cognitive/workspace.json   objects, goals, budgets, modes, intake ledger, allocation buckets
constitution/state.json    principles, amendments, decision verdicts, identity core
decisions/state.json       decision records and outcomes
distiller/state.json       distilled lesson proposals
environment/state.json     resources, action records, projects, habits
evolution/state.json       gaps, skill candidates, workflows, journal, index history
harness/state.json         harness entries, refinements, snapshots
initiative/state.json      watchers, intake, initiatives, budgets, digests
memory-graph/state.json    memory objects, relations, thought anchors
microagents/state.json     knowledge documents and screening findings
planning/state.json        plans, steps, revisions
policy/aurora-enforcement.json  capability-boundary enforcement audit trail
risk/state.json            rules, assessments, confirmation policy
society/state.json         roles, tasks, deliberations, budgets, bus messages
user-model/state.json      claims, goals, signals, milestones, advice
world-model/state.json     entities, states, relations, events, causal links, predictions
world-model/multi-world.json  perspectives and analyses
```

Every store enforces a 16 MB safety bound, validates its schema on load, tolerates older files that
predate newer fields, and writes atomically through a temporary file plus rename.

## The end-to-end journey

`packages/engine/test/aurora-end-to-end.test.ts` runs the whole organism in one test:

1. a world event is recorded and an intake signal arrives;
2. the signal becomes a scored initiative and is mirrored into the Global Workspace;
3. a procedural memory is stored with evidence;
4. two perspectives disagree and the consensus preserves the dissent;
5. the constitution reviews the intended action and allows it;
6. a decision is made with weighted criteria, dissent and a falsifiable expectation;
7. the decision becomes a dependency-ordered plan with verification per step;
8. the risk analyzer scores the call, the action executes and is **verified**;
9. the outcome is recorded, surprise is measured and the world model updates;
10. an ACOS cycle runs every phase without failure;
11. provenance reconstructs action → resource → memory, decision → constitutional verdict, plan → decision;
12. whole-organism status reflects the journey: one reviewed decision, zero verification debt, no
    active plans left.

## What Aurora will still not do

- promote a skill, a memory or a user inference without evidence and a governed gate;
- notify the user because something is merely interesting;
- claim an external effect succeeded without a tool result and a verification record;
- soften a hard constitutional principle, disable a critical risk rule, or amend its identity without
  a named approver;
- keep thinking in a loop that produces the same result;
- explain itself with a story instead of recorded provenance;
- claim a rollback happened without naming the checkpoint it restored;
- leak content into telemetry — every exported metric is a count, a rate or a bounded score;
- keep a user's inferences after a purge, or delete audit-grade records without saying so;
- drive a tenant unattended that nobody enrolled, or let one tenant's failures stop the rest of the fleet;
- mark a plan step done without a society outcome and its evidence, or start delegated work as a side effect of planning;
- let a delegated child session inherit more authority than its role's reviewed template grants;
- score its own delegated work as a success without recorded evidence, or resolve an ambiguous outcome by guessing;
- overwrite a human's recorded decision outcome, or claim a decision's result while its plan is still running;
- hand high-risk work to a role whose own record says it should not have it;
- silently rewrite an estimate: a correction is a revision that names its factor and its evidence;
- inject a repository instruction file that failed injection screening, or follow a symlink out of the workspace to read one;
- let a lifecycle hook shell out, widen authority, or fire without leaving a record.
