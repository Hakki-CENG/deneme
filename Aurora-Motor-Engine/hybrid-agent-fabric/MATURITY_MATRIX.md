# Aurora — Maturity Matrix

**Generated:** 2026-09-25 by `npm run docs:state -w @haf/eval`. Do not edit by hand.

Source of truth: `packages/engine/src/experimental/maturity.ts`, whose honesty
is itself checked by `maturity.test.ts` — a module whose `actualBehaviour`
falls short of its `promisedBehaviour` may not be rated `stable`.

"Actual behaviour" below is what the module really does, not what its name
suggests (Madde 63).

| Module | Level | Maturity | Wired | Tests | Actual behaviour |
|---|---|---|---|---|---|
| `aurora/self-improvement` | verified | beta | yes | yes | Deterministic mutation operators with sandbox validation and a held-out baseline challenge; the operator se... |
| `execution/unified-execution-loop` | verified | beta | yes | yes | Runs the real agent through SessionActor, derives status from evidence, verifies via VerificationFactory, c... |
| `memory/real-memory-pipeline` | verified | stable | yes | yes | All four stages implemented and Recall@8 is measured (npm run eval:recall, 120 docs / 15 queries, half of t... |
| `aurora/goal-discovery` | exercised | beta | yes | yes | Detects concrete anomaly classes (TODO markers, dependency and config issues) and turns them into candidate... |
| `aurora/integration-verification` | exercised | beta | yes | yes | Rollback points, integration test runner, hash-based core guardian |
| `aurora/long-horizon-memory` | exercised | beta | yes | yes | Stores memories across four horizons and runs a real maintenance pass from engine.execute()'s learn hook, r... |
| `aurora/neural-cognitive-core` | exercised | beta | yes | yes | A durable pattern registry with activation counters and snapshots. Pattern matching and statistics are real... |
| `aurora/neural-memory-fusion` | exercised | beta | yes | yes | Deterministic 64-dimensional hash vectors (Math.sin over a keyword hash), cosine similarity and Jaccard key... |
| `digital-twin` | exercised | experimental | yes | yes | Maintains a mirrored state record; no simulation loop. sync() now throws instead of returning `{ synced: tr... |
| `domain-experts` | exercised | experimental | yes | yes | Routing metadata for domain tagging; experts are configured, not trained. Every analysis helper returns a f... |
| `embodiment` | exercised | experimental | yes | yes | Action descriptors and bookkeeping; no actuator backend |
| `execution/capability-acquisition` | exercised | beta | yes | yes | Contract → generator → static analysis → real Worker sandbox → known-good checks → known-bad decoys → adver... |
| `execution/failure-taxonomy` | exercised | beta | yes | yes | Deterministic pattern classification with explicit abstention (fundamental_unknown) rather than guessing; s... |
| `execution/gap-detection` | exercised | beta | yes | yes | Two working tiers: deterministic (goal requirement vs real CapabilityBroker inventory, confidence 0.93) and... |
| `execution/verification-factory` | exercised | beta | yes | yes | Runs verifiers strongest-first; a throwing or unavailable verifier yields UNCERTAIN, never PASS; an empty t... |
| `federated` | exercised | experimental | yes | yes | Node registry and round bookkeeping; no gradient exchange. Data-residency policy rules are now really evalu... |
| `persistence/production-persistence` | exercised | stable | yes | yes | In-memory backend with monotonic per-aggregate versions and replay |
| `pipeline/code-pipeline-service` | exercised | experimental | yes | yes | Issue tracking, run/stage state machine, plan and branch naming are real. Implement, test, security review,... |
| `sdk/agent-sdk-service` | exercised | experimental | yes | yes | The registry, publish lifecycle, instance and permission model are real and persisted. Execution is NOT: ex... |
| `security/reward-hacking-defense` | exercised | beta | yes | yes | Protected metric validation, a fixed attack-pattern library, and a pipeline that runs real detectors over s... |
| `security/reward-hacking-detectors` | exercised | beta | yes | yes | Statistical detectors over supplied evidence: reward/ground-truth divergence, z-score and flat-baseline spi... |
| `security/security-system` | exercised | beta | yes | yes | All four implemented; injection detector covers SQL/command/path/script plus prompt-injection families. The... |
| `skills/skill-composition` | exercised | stable | yes | yes | DAG with cycle detection and Kahn topological sort |
| `skills/skill-promotion` | exercised | stable | yes | yes | Enforces one-level-at-a-time transitions, rejects self-promotion by the author, excludes skipped runs from ... |
| `skills/skill-synthesis` | exercised | stable | yes | yes | Mines candidates and executes skill steps through the sandbox, comparing real output against expected output |
| `society/agent-society` | exercised | beta | yes | yes | Reputation scoring and routing over declared agent profiles |
| `surface/jarvis-surface` | exercised | beta | yes | yes | Record-keeping and orchestration surfaces; the actual STT/TTS/vision work is delegated to configured provid... |
| `world/world-model-exploration` | exercised | beta | yes | yes | Records state/action/prediction/outcome and computes surprise plus exploration value; predictions are suppl... |
| `capabilities/capability-synthesis` | reachable | stable | yes | yes | Generates capability records and executes them in a real worker-thread isolate with heap and wall-clock lim... |
| `routing/model-routing` | reachable | beta | yes | yes | Constraint filtering plus scoring over registered profiles; adapts only from supplied benchmark data. Bench... |

## Reading this table

- **Level** is derived (see `CURRENT_STATE.md`). **Maturity** is the
  hand-reviewed rating from the register.
- `Wired: no` means the module exists and may be tested, but the real
  execution path never calls it. Those rows are the honest gaps — see
  `KNOWN_GAPS.md`.
