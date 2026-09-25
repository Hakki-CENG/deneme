# Aurora Agent Society Architecture V1 — complete feature audit and HAF integration roadmap

Source: `Aurora Agent Society Architecture V1-birleştirildi(1).pdf`  
Read in full: 125 / 125 pages  
Audit date: 2026-08-19

## Interpretation rule

The PDF is a constitutional/product architecture, not an implementation specification. HAF will preserve its intent but will not count names, prompts, empty roles or unverified adapters as implementation. A PDF capability is complete only when it has durable state, runtime integration, authority boundaries, APIs/UX and automated evidence.

The existing architecture remains:

- OpenHands: experience/control plane
- Prime: actor/session/supervisor/RLM plane
- Hermes: capabilities/integrations/security/knowledge plane
- Aurora additions: cognitive society, world/user models, attention/initiative, thought continuity and controlled evolution

## 1. Agent Society (pages 1–14)

### Required capabilities

- Aurora Prime as synthesizer/orchestrator, not an unconstrained super-agent
- Executive Council: Memory, Research, Planning, Security, Skill, World Model and User directors
- Specialist roles: research, coding, debugging, architecture, planning, reflection, creativity, opportunity, risk, communication, guardian, project management, knowledge, simulation and skill building
- Optional micro-agents below specialists
- Agent Communication Bus
- Task Marketplace with task requests/bids/assignment
- Multi-agent consensus and conflict synthesis
- Reputation per agent based on verified outcomes
- Resource Allocation Engine
- Dynamic agent creation and retirement
- Meta-agent monitoring for loops, inefficiency and optimization

### Strength

Very high. This removes the single-agent bottleneck and gives HAF an explicit organizational substrate. The dangerous interpretation would be to grant every role broad tools; the correct implementation binds roles to immutable agent profiles and lets policy remain authoritative.

### HAF baseline

Already present: durable child sessions, family messaging, profiles, capability allowlists, task dependencies, detached workers, supervisor recovery. Missing: society role registry, marketplace bidding, reputation, consensus weighting, resource allocation and lifecycle governance.

## 2. Cognitive Companion OS and ACOS (pages 15–35)

### Required capabilities

- Continuous Observe → Understand → Think → Plan → Act → Learn → Remember → Reflect → Evolve loop
- Proactive operation while the user is offline
- Event bus, queue, state manager, scheduler, storage and security foundation
- Global Workspace for candidate observations and conclusions
- Attention allocation over CPU/GPU/RAM/token/time/API budget
- Goal stack and conflict arbitration
- Cognitive queue scored by priority, importance, urgency and impact
- Time horizons: reactive, tactical and strategic
- Consensus, confidence and explicit uncertainty
- Cognitive health and repeated-loop detection
- Reflection scheduling and Dream Mode for low-priority synthesis
- Internal constitution checker and long-term identity continuity
- Cognitive state machine: reactive/research/development/reflection/dream/emergency

### Strength

Foundational and very high. The Global Workspace plus Attention/Resource Governor is the bridge between many agents and one coherent system. It must be durable and bounded; an unbounded background thought loop would become a cost and safety failure.

### HAF baseline

Already present: scheduler, goals, autonomous limits, task graph, metrics, event log, continuation policy and refinement review. Missing: explicit cognitive modes, global workspace, attention budget across tasks, thought queue and constitution-bound arbitration.

## 3. Digital Embodiment and Computer Control (pages 36–49)

### Required capabilities

- Standard action record: goal, plan, action, result, verification, memory update
- Filesystem, terminal, IDE, browser, Git, databases and APIs
- Environment mapper and capability registry
- Project-isolated workspaces
- Execution planner, mandatory verification and recovery/rollback
- Safe execution zones 0–4
- Human approvals for destructive/critical operations
- Persistent multi-step work queue
- Observation of unexpected outcomes
- Workspace memory and digital habit learning
- Continuous project awareness and cross-system integrations
- Self-tool creation and execution reputation

### Strength

Very high but mostly security-sensitive. The PDF’s “body” must remain inside sandbox, credential and policy boundaries.

### HAF baseline

Strong coverage: workspaces, filesystem/process/browser/Git/database-facing capability patterns, approvals, OPA, effect journals, sandbox backends, task board, verification gates, hosted repositories and interactive artifacts. Missing: explicit action-object linkage and tool execution reputation/environment inventory.

## 4. Memory Architecture (pages 50–57)

### Required capabilities

- Working, session, episodic, semantic, procedural and user memory
- Knowledge Graph and Memory Palace
- Memory Object standard: ID, timestamp, type, source, confidence, importance, tags and relations
- Importance and confidence scores
- Consolidation, compression and relationship strengthening
- Semantic, graph, temporal, goal and user retrieval
- Long-term Thought Anchors
- Memory health: staleness, contradiction, low usage and uncertainty

### Strength

Critical. This is the continuity layer for every other PDF capability. Confidence, provenance and relation edges are more important than simply storing embeddings.

### HAF baseline

Present: candidate/active memory, provenance/evidence, hybrid retrieval, external Honcho, rolling micro-compaction and knowledge indexing. Missing: typed memory pyramid, explicit graph relation store, thought anchors, contradiction/staleness health and consolidation metrics.

## 5. Multi-World Model (pages 58–67)

### Required capabilities

- Technical, economic, risk, opportunity, human, strategic, security, scientific, creativity, user-centric, time and complexity perspectives
- Debate and conflict engine
- Weighted consensus score
- Scenario generation, branch simulation and probabilities
- Future tree and reality-alignment feedback
- Meta-world model selecting weights by problem type
- Per-perspective prediction reputation

### Strength

Very high for decision quality. It prevents one model perspective from being treated as truth. It must expose disagreement and uncertainty rather than manufacturing consensus.

### HAF baseline

Session trees, forks, child agents, evidence-bound review and explicit uncertainty exist. Missing: perspective registry, weighted deliberation, scenario probability/evidence, conflict records and prediction outcome calibration.

## 6. Proactive Initiative Engine (pages 68–80)

### Required capabilities

- Continuous event intake from memory, world model, Git, calendar, files, weather, research, location and notifications
- Opportunity and risk detection
- User-goal and context alignment
- Notification worthiness: importance × urgency × impact × confidence × relevance
- Daily attention budget and P0–P4 classes
- Channel selection
- Guardian and assistant modes
- Research/project/skill watchers
- Pattern, behavior and stalled-progress detection
- Escalation, daily briefing, weekly review and monthly strategy review
- Self-initiated conversations, intervention proposals, silence engine and trust preservation

### Strength

High product value and high spam risk. Silence/attention budgeting is as important as detection.

### HAF baseline

Scheduler, automations, many communication channels, fleet alerts and project sync exist. Missing: initiative object scoring, attention budget, suppression/digest policy, proactive trust feedback and watcher registry.

## 7. Skill Evolution and Self-Improvement (pages 81–93)

### Required capabilities

- Capability-gap and repeated-friction detection
- Skill candidate and blueprint generation
- Skill design/build agents
- Sandbox → test → beta → production lifecycle
- Safety/performance validation
- Accuracy, reliability, speed, utility and safety scores
- Skill relationship/composition/marketplace
- Usage, success and error tracking
- Retirement/archive policy
- Workflow evolution and bottleneck detection
- Meta-improvement, controlled evolution, evolution journal, regression protection and cognitive evolution index

### Strength

Very high and dangerous if self-promotion is allowed. Every generated skill must stay candidate-only until sandbox, evaluation and human/signature policy pass.

### HAF baseline

Strong coverage: quarantine, scan, hash, signed WASI plugins, learning candidates, evaluation, canary, promotion and rollback, model-planned refinement. Missing: explicit capability-gap/friction observations, multidimensional skill score, composition graph, usage-based retirement and evolution index.

## 8. Thought Loop (pages 94–102)

### Required capabilities

- Durable Thought Objects with ID, title, state, importance, confidence and timestamps
- States: NEW, ACTIVE, RESEARCHING, WAITING, BLOCKED, ARCHIVED, SOLVED
- Long-term thought anchors and open-problem tracker
- Background thinking and scheduled mini/deep/meta reflection
- Curiosity queue, hypothesis generation/test evidence and contradiction engine
- Insight generation and research queue
- Dream Mode for low-priority creative relations
- Priority/budget/interruption and user relevance
- Thought journal and internal self-dialogue

### Strength

Critical to the PDF’s “continuous mind” claim. Thought loops require budgets, loop detection and explicit stop states.

### HAF baseline

Goals, task board, scheduler, autonomous bounds, branches and refinement exist. Missing: first-class thought objects, hypotheses/contradictions, long-horizon anchors, curiosity queue and thought-specific budget/interruption.

## 9. User Cognitive Model and Relationship (pages 103–114)

### Required capabilities

- A behavioral digital twin, explicitly not identity/personality surveillance
- Identity/project/interest context
- Long/medium/short goal model
- Motivation, decision and learning-style models
- Strength/weakness, habit, productivity, energy, attention and frustration models
- Communication preferences and trust
- Advice effectiveness feedback
- Personal growth timeline and current-state estimator with uncertainty
- Relationship memory, guardian alignment and user advocacy

### Strength

High personalization value and highest privacy sensitivity. User inferences must be scoped, inspectable, confidence-labelled, correctable and deletable.

### HAF baseline

Agent profiles, goals, local user memory and optional Honcho representations exist. Missing: governed typed user-model claims, confidence/evidence, correction/consent lifecycle, advice feedback and privacy-facing UI.

## 10. World Model (pages 115–125)

### Required capabilities

- Entity → State → Relation → Event → Outcome representation
- Entity, state, relation and event stores
- Causality and prediction engines
- Temporal past/current/future state
- Personal, environment, digital, project, human and goal models
- Simulation and counterfactual branches
- Consistency/contradiction checks
- Confidence/uncertainty and user relevance filtering
- World updates that re-evaluate old assumptions

### Strength

Critical for prediction and proactive behavior. It must distinguish observation, inference, hypothesis and prediction.

### HAF baseline

Events, tasks, sessions, memory and knowledge retrieval exist. Missing: typed entity/relation/state/event graph, causality assertions, temporal validity, prediction/outcome calibration and consistency engine.

## Cross-cutting constitutional requirements extracted from all 125 pages

1. No single unconstrained super-agent.
2. Prime synthesizes; policy/constitution remains above all agents.
3. Every claim carries source, confidence, importance and time.
4. Observation, inference, hypothesis and prediction are distinct types.
5. Proactivity is bounded by user relevance, attention budget and silence rules.
6. Evolution is candidate → sandbox → test → review → deploy, never direct self-modification.
7. Critical actions require approval, verification, audit and recovery.
8. Resource/token/API budgets are explicit and multi-horizon.
9. Disagreement is preserved; consensus includes confidence and dissent.
10. User models are governed, correctable and privacy scoped.
11. Background loops are durable but interruptible and protected against repetition.
12. No component claims exactly-once external effects.

## Implementation order

### Aurora Phase A — Society and constitutional substrate (P0)

- Durable role/archetype registry
- Council/specialist/micro hierarchy
- Task marketplace and bids
- Reputation with evidence-bound updates
- Resource budgets
- Weighted consensus preserving dissent
- Profile-bound child execution

### Aurora Phase B — Cognitive objects and global workspace (P0)

- Thought/observation/hypothesis/decision objects
- Global workspace queue
- Attention scoring and budget
- Goal arbitration and modes
- Loop detection

### Aurora Phase C — Memory object/graph standard (P0)

- Typed memory pyramid
- Relation graph and temporal validity
- Consolidation and contradiction health
- Thought anchors

### Aurora Phase D — World and multi-world models (P1)

- Entity/state/relation/event/outcome graph
- Perspective registry and debate
- Scenario/future tree
- Prediction calibration

### Aurora Phase E — Initiative and relationship governance (P1)

- Risk/opportunity watchers
- Worthiness and attention budget
- Digests/escalation/silence
- Governed user-model claims and feedback

### Aurora Phase F — Skill/workflow evolution metrics (P1)

- Gap/friction detection
- Multidimensional skill reputation
- Composition and retirement
- Evolution index and regression journal

### Aurora Phase G — Environment and embodiment expansion (P2)

- Environment inventory
- Action-object verification links
- Workspace habit/project awareness
- Additional controlled device/cloud integrations

## Implementation progress

- Phase A core delivered in HAF 1.37: role hierarchy, task marketplace, reputation, resource budgets, profile-bound execution and dissent-preserving consensus.
- Phase B core delivered in HAF 1.38: typed cognitive objects, Global Workspace, P0-P4 goal arbitration, attention reservations, cognitive modes and repeated-loop blocking.
- HAF 1.39 completes the ordered roadmap:
  - Phase A extension: Agent Communication Bus, meta-agent monitoring and evidence-bound role retirement.
  - Phase B extension: automatic deduplicated intake with a hash-only ledger, preemptive attention, focus interruption, mini/deep/meta/Dream reflection scheduling, curiosity queue and cognitive health/constitution checks.
  - Phase C: memory pyramid, Memory Object standard, typed relation graph, multi-strategy recall, consolidation, contradiction/staleness health, supersession, deletion and long-term thought anchors.
  - Phase D: entity/state/relation/event world model with temporal windows, causality feedback, Brier-scored prediction calibration, consistency checks, bounded simulation/counterfactuals and the twelve-perspective Multi-World Model with debate, scenarios, future trees, reality alignment and dissent-preserving consensus.
  - Phase E: Proactive Initiative Engine (intake, watchers, worthiness, P0-P4, attention budget, quiet hours, suppression, escalation, digests, trust feedback) and the governed user cognitive model (typed claims, consent, correction, deletion, goals, signals, state estimate, frustration, timeline, advice effectiveness, guardian alignment, protected-topic refusal).
  - Phase F: gap/friction detection, staged skill evolution with evidence gates and production approval, multidimensional scores, regression protection, composition, retirement, workflow evolution and the Cognitive Evolution Index.
  - Phase G: environment inventory with zones 0-4, action objects with mandatory verification and rollback, tool execution reputation, workspace habits and project awareness.
- Constitutional cross-cutting rules 1-12 are enforced in code and covered by tests: no unconstrained super-agent, claim typing with source/confidence/importance/time, bounded proactivity, candidate-only evolution, approval/verification/rollback for critical actions, explicit multi-horizon budgets, preserved dissent, governed and deletable user models, interruptible loop-protected background work and no exactly-once external effect claims.
- HAF 1.40 adds the ACOS layer the PDF describes in chapters 15-35 and hardens it with upstream-derived ideas: the constitutional identity core and Internal Constitution Checker, the Continual Harness, trigger-activated microagent knowledge with injection screening, an escalation-only risk analyzer with confirmation policy, model-free stuck detection, Dream-Mode concept formation and the bounded cognitive control loop that composes every subsystem into one organism.
- Remaining follow-up (not required by the PDF order): richer device/cloud connectors for Phase G and optional embedding-backed recall for Phase C; both plug into the interfaces delivered here.

Existing HAF supervisor/profile/policy primitives remain authoritative and are reused rather than replaced.
