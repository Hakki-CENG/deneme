# Aurora — Known Gaps

**Generated:** 2026-09-25 by `npm run docs:state -w @haf/eval`. Do not edit by hand.

Measured gaps only. Anything listed here was confirmed by a command, not by
reading code and forming an impression.

## Not wired into the execution path (0)

These exist and may be tested, but nothing on the real execution path calls them.

_None._

## Constructed at startup but idle during a real task (2)

Measured with V8 coverage on 2026-09-20: two runs of the engine,
one calling only `initialize()` and one also running a real goal, with the
difference taken so that startup work is not counted as task work.

**Goal used:** _Create a file called hello.txt containing the word hello_

28/30 modules did work during the task.
The rest were constructed and never consulted. `wiredToEngine` says `true`
for 30/30 of them,
which is the gap this section exists to show.

One task exercises one path, so a row here means "not reached by this goal",
not "dead code". Regenerate with `npm run observe:runtime -w @haf/engine`.

| Module | Maturity | Observed |
|---|---|---|
| `capabilities/capability-synthesis` | stable | constructed |
| `routing/model-routing` | beta | constructed |

## Without tests (0)

_None._

## Declared distance to stable (24)

| Module | Maturity | What is missing |
|---|---|---|
| `security/security-system` | beta | The guard checks two things only: kill switch and prompt injection. Policy, approvals and trust deliberately stay with PolicyEngine rather than being answered twice. The payload patterns (SQL/command/path/script) are excluded at this boundary by measurement, not oversight: scanning arguments with them broke 5 passing tests, because a shell capability exists to receive '&&' and a patch carries '../' in its diff. Those belong to the capability that owns the interpreter, which escapes its own input and reports a more specific error. Still unproven: behaviour under a real model, where injected text arrives in model output rather than in capability arguments |
| `aurora/long-horizon-memory` | beta | Clustering is by exact shared association string, not semantic similarity; promotion and consolidation thresholds are fixed constants, not learned; search() matches on term overlap, not meaning, so a paraphrased question with no shared vocabulary still returns nothing |
| `aurora/self-improvement` | beta | Operator set is fixed; no learned search over the mutation space |
| `aurora/neural-memory-fusion` | beta | Either wire a real embedding model or rename to VectorMemoryFusion; the current name overstates the mechanism (specification item 63) |
| `aurora/neural-cognitive-core` | beta | Rename to CognitivePatternRegistry, or implement a mechanism the current name would justify (specification item 63) |
| `world/world-model-exploration` | beta | No learned forward model; predictions come from the caller |
| `routing/model-routing` | beta | No online learning from production outcomes |
| `society/agent-society` | beta | No emergent negotiation between agents |
| `aurora/goal-discovery` | beta | Anomaly detection is pattern-based, not semantic |
| `security/reward-hacking-defense` | beta | Attack library is static; no adaptive red-teaming |
| `execution/unified-execution-loop` | beta | Planner and learn hooks are optional and currently unsupplied by engine.execute(); capability acquisition is not yet in the recovery path |
| `execution/capability-acquisition` | beta | The implementation generator must still be supplied by the caller (no model binding here, per specification item 33). As of 2026-09 engine.execute() accepts `capabilityGenerator` and builds the acquireCapability hook from it, so the chain gap -> contract -> code -> static analysis -> sandbox -> known-good -> decoys -> CapabilityBroker runs end to end. A verified capability is now registered with the real broker under an `acquired.` namespace and delegates every call back into the sandbox, so generated source still never enters this process (item 14) while the agent can actually reach it. Before 2026-09 it stopped at the synthesis pipeline's private map, which meant 'generated' and 'usable' were different statements. The remaining limit is coverage, not wiring: test cases are hand-written per requirement rule, so exactly one capability can be acquired this way |
| `execution/gap-detection` | beta | Requirement table is a fixed 7-entry list, not learned, and the LLM tier throws rather than being implemented. Of those 7 entries only visual_diff carries test cases and is genuinely synthesisable; pdf_parsing was downgraded to synthesisable: false after measuring that the sandbox has no filesystem or binary decoding, so generated code could only have faked it. The remaining entries name their gap and stop there, which is honest but means one capability, not a general ability to acquire any missing tool |
| `execution/verification-factory` | beta | Callers still choose which verifiers apply to a given task; V3 consensus now has an implementation but needs a real evaluator panel supplied by the caller |
| `execution/failure-taxonomy` | beta | Classification is regex-based; no structural or LLM-assisted tier yet |
| `security/reward-hacking-detectors` | beta | Thresholds are fixed constants, not calibrated against a labelled corpus of real hacking attempts; detection is per-signal with no joint model |
| `pipeline/code-pipeline-service` | experimental | Six of eight stages need real backends before the pipeline can complete a run |
| `aurora/integration-verification` | beta | Rollback covers in-memory state, not the filesystem |
| `sdk/agent-sdk-service` | experimental | Needs a real isolate wired in (SandboxExecutor's Worker isolate or the signed WasiPluginManager) before extensions can execute at all |
| `surface/jarvis-surface` | beta | No bundled STT/TTS/vision implementation; no automation or connector backends |
| `digital-twin` | experimental | Needs an actual simulation/prediction loop before the name is honest |
| `embodiment` | experimental | Needs a real actuator/effector integration |
| `federated` | experimental | Needs real parameter aggregation across nodes; four of six policy rule types (encrypt_at_rest, encrypt_in_transit, retention, anonymize) are still unevaluated |
| `domain-experts` | experimental | Needs genuinely specialised expert backends and a real source database. Until then the value of this module is its refusals: compliance checks with no loaded requirements now report status unknown with score 0, not compliant with score 100, which is what they returned before 2026-09 for a high-risk legal question |

## Gaps outside the module register

The register covers subsystems. These were found by auditing the execution
path itself and are tracked in `packages/eval/results/54-merged-plan.md`:

| Gap | Detail |
|---|---|
| Capability acquisition chain | gap → synthesis → verify → registry → retry is not closed end to end |
| Real-model benchmark | every eval run to date used the mock provider; real-model numbers do not exist yet |
| State backend | 77 services persist to JSON files; only the event store has a Postgres backend |

## What is explicitly NOT a gap

Confirmed present during audit, listed so they are not re-reported:
Prometheus `/metrics`, `/health`, OTLP exporter, SSE streaming, the 11-value
execution status contract, the 15-kind failure taxonomy with 11 recovery
strategies, event pagination (`afterSequence`), `VerificationGapError`, all
four memory types, hybrid retrieval with RRF, context compaction, parallel tool
execution, reward-hacking defences, and durable persistence
(journal/snapshot/lease/Postgres).
