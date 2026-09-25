/**
 * Capability Maturity Registry — Aurora
 *
 * FAZ 0 gate: deneysel ayrımı.
 *
 * Single source of truth for how mature each subsystem actually is. The point
 * is honesty: a class called `DigitalTwinService` must not be presented as a
 * real digital twin until it behaves like one.
 *
 * Standing instruction this encodes:
 *   "NeuralCognitiveCore, CounterfactualSimulator gibi isimleri ancak
 *    implementasyon isimlerinin vaat ettiği seviyeye geldiğinde 'gerçek'
 *    olarak sun."
 */

import { observationOf, observationSummary } from "./runtime-observation.js";

/** How much a subsystem can be relied upon. */
export type MaturityLevel = "stable" | "beta" | "experimental";

/** Declared maturity of a single subsystem. */
export interface ModuleMaturity {
  /** Module directory under `packages/engine/src`. */
  readonly module: string;
  readonly level: MaturityLevel;
  /** What the name suggests the module does. */
  readonly promisedBehaviour: string;
  /** What the implementation actually does today. */
  readonly actualBehaviour: string;
  /** Whether a dedicated test file exercises it. */
  readonly hasTests: boolean;
  /**
   * Whether it is reachable from `Engine`.
   *
   * Declared by hand, and worth exactly what that is worth: every one of the
   * 30 entries says `true` and none says `false`. "Reachable" is a low bar —
   * it is satisfied by being constructed in `initialize()` and never asked
   * anything again, which is what 25 of these modules actually do.
   *
   * For what a real task touches, see `RUNTIME_OBSERVATIONS` in
   * `runtime-observation.ts`, which is measured rather than declared.
   */
  readonly wiredToEngine: boolean;
  /** What is still required to reach `stable`. */
  readonly gapToStable?: string | undefined;
  /**
   * What has actually been proven about this module in use.
   *
   * A10: this is the field `stable` was missing. `hasTests` says the module has
   * a test file and `wiredToEngine` says it is reachable — together they justify
   * "built and reachable", not "works in production". Eighteen modules were
   * declared `stable` on that basis alone.
   *
   * Only fill this in with something that was measured or witnessed. An entry
   * here is a claim about the world, and the whole point of the registry is that
   * claims get checked. Omit the field when nothing has been proven: absence is
   * honest, a hand-written `"verified"` is not.
   */
  readonly productionEvidence?: string | undefined;
}

/**
 * The registry.
 *
 * Entries are deliberately blunt. If `actualBehaviour` is narrower than
 * `promisedBehaviour`, the level must not be `stable`.
 */
export const MODULE_MATURITY: readonly ModuleMaturity[] = [
  // ── Stable: real behaviour, tested, wired ──
  {
    module: "capabilities/capability-synthesis",
    level: "stable",
    promisedBehaviour: "Synthesizes capabilities and verifies them in a sandbox",
    actualBehaviour:
      "Generates capability records and executes them in a real worker-thread isolate with heap and wall-clock limits; failures suspend the capability",
    hasTests: true,
    wiredToEngine: true,
  },
  {
    module: "skills/skill-synthesis",
    level: "stable",
    promisedBehaviour: "Mines trajectories into reusable, verified skills",
    actualBehaviour:
      "Mines candidates and executes skill steps through the sandbox, comparing real output against expected output",
    hasTests: true,
    wiredToEngine: true,
  },
  {
    module: "skills/skill-promotion",
    level: "stable",
    promisedBehaviour: "Gates skill trust promotion on measurable, independent evidence",
    actualBehaviour:
      "Enforces one-level-at-a-time transitions, rejects self-promotion by the author, excludes skipped runs from the success rate, and blocks on stale evidence or trailing regressions",
    hasTests: true,
    wiredToEngine: true,
  },
  {
    module: "skills/skill-composition",
    level: "stable",
    promisedBehaviour: "Composes skills with dependency resolution",
    actualBehaviour: "DAG with cycle detection and Kahn topological sort",
    hasTests: true,
    wiredToEngine: true,
  },
  {
    module: "security/security-system",
    level: "beta",
    promisedBehaviour: "Trust levels, approvals, kill switches, injection detection",
    actualBehaviour:
      "All four implemented; injection detector covers SQL/command/path/script plus prompt-injection " +
      "families. The protections live in initialize(), not the constructor, and until 2026-09 nothing " +
      "called it: the runtime held a pipeline with 0 patterns and 0 kill switches. Injections were still " +
      "refused, but only because the approval matrix was empty, so the first approval added would have " +
      "removed that accidental safety. AuroraCognitiveRuntime.initialize() now arms it, and a guard on " +
      "CapabilityBroker's pre_capability hook now asks it before every capability runs: a triggered " +
      "kill switch stops calls the policy engine would allow, and prompt-injection strings in the " +
      "arguments are refused by name. Measured through the engine's own broker, not the pipeline alone",
    hasTests: true,
    wiredToEngine: true,
    gapToStable:
      "The guard checks two things only: kill switch and prompt injection. Policy, approvals and trust " +
      "deliberately stay with PolicyEngine rather than being answered twice. The payload patterns " +
      "(SQL/command/path/script) are excluded at this boundary by measurement, not oversight: scanning " +
      "arguments with them broke 5 passing tests, because a shell capability exists to receive '&&' and " +
      "a patch carries '../' in its diff. Those belong to the capability that owns the interpreter, " +
      "which escapes its own input and reports a more specific error. Still unproven: behaviour under a " +
      "real model, where injected text arrives in model output rather than in capability arguments",
  },
  {
    module: "persistence/production-persistence",
    level: "stable",
    promisedBehaviour: "Transactional event store with per-aggregate versioning",
    actualBehaviour: "In-memory backend with monotonic per-aggregate versions and replay",
    hasTests: true,
    wiredToEngine: true,
    gapToStable: undefined,
  },
  {
    module: "aurora/long-horizon-memory",
    level: "beta",
    promisedBehaviour:
      "Long-horizon memory that consolidates, decays and promotes itself over time",
    actualBehaviour:
      "Stores memories across four horizons and runs a real maintenance pass from " +
      "engine.execute()'s learn hook, rate-limited to one pass per tenant per five " +
      "minutes. Consolidation clusters by shared association (min 3, each memory " +
      "claimed once) and is idempotent via consolidatedFrom back-links; decay ages " +
      "by decayFactor from lastAccessedAt and prunes below 0.01; promotion actually " +
      "mutates horizon and decayFactor. Before 2026-09 the maintenance was " +
      "unreachable in practice (decay had zero callers, autoConsolidate one manual " +
      "HTTP endpoint) and autoConsolidate reported promotions and decays it never " +
      "performed — it counted memories matching the criteria and mutated nothing.",
    hasTests: true,
    wiredToEngine: true,
    gapToStable:
      "Clustering is by exact shared association string, not semantic similarity; " +
      "promotion and consolidation thresholds are fixed constants, not learned; " +
      "search() matches on term overlap, not meaning, so a paraphrased question " +
      "with no shared vocabulary still returns nothing",
  },
  {
    module: "memory/real-memory-pipeline",
    level: "stable",
    promisedBehaviour: "Hybrid retrieval: BM25 + vector + RRF + rerank",
    actualBehaviour:
      "All four stages implemented and Recall@8 is measured (npm run eval:recall, " +
      "120 docs / 15 queries, half of them paraphrases sharing no vocabulary " +
      "with their documents). Measured 2026-09 with a real sentence-transformer " +
      "behind EMBEDDINGS_URL: 0.317 -> 0.400 (+0.083, 8W/1L/6T) — the FAZ 11 " +
      "margin of 0.05 is met, and reproducible in one command without an API " +
      "key: `npm run eval:recall:real -w @haf/eval` starts all-MiniLM-L6-v2 on " +
      "CPU and runs the gate against it (3 consecutive runs, identical numbers). " +
      "Five real defects were fixed to get there: RRF was " +
      "added as a weighted term instead of fusing, the tokenizer left punctuation " +
      "attached, avgDocLength counted characters while the formula divided by " +
      "tokens, docFreq used a different tokenizer than scoring, and documents " +
      "BM25 scored at zero were never ordered. The default hash encoder is NOT " +
      "semantic (it inverts relevance on paraphrases) so it carries zero fusion " +
      "weight; on that encoder the pipeline scores 0.339 and the gate reports " +
      "FAIL by design. As of 2026-09 it is also used on the main execution " +
      "path: MemoryEngine.recall() runs it as a ranker over candidates the " +
      "durable stores returned, ordering by bm25Score and falling back to " +
      "importance when scores are within a factor of two (equally-relevant " +
      "candidates) or when ranking throws. It is not the system of record — " +
      "the pipeline holds its corpus in memory, so storing there would lose " +
      "memories on restart. Before this it had zero references outside the " +
      "eval harness: the ranking the project measured was not the ranking the " +
      "agent received.",
    hasTests: true,
    wiredToEngine: true,
  },

  // ── Beta: works and is wired, but narrower than the name implies ──
  {
    module: "aurora/self-improvement",
    level: "beta",
    promisedBehaviour: "GEPA-style prompt evolution and DGM-style code evolution",
    actualBehaviour:
      "Deterministic mutation operators with sandbox validation and a held-out baseline challenge; the operator set is small and hand-written, not learned",
    hasTests: true,
    wiredToEngine: true,
    gapToStable: "Operator set is fixed; no learned search over the mutation space",
  },
  {
    module: "aurora/neural-memory-fusion",
    level: "beta",
    promisedBehaviour: "The name promises learned neural embeddings fused across memory layers",
    actualBehaviour:
      "Deterministic 64-dimensional hash vectors (Math.sin over a keyword hash), cosine similarity and " +
      "Jaccard keyword overlap. Real, useful retrieval — but there is no network, no training and no " +
      "learned weights anywhere in it",
    hasTests: true,
    wiredToEngine: true,
    gapToStable:
      "Either wire a real embedding model or rename to VectorMemoryFusion; the current name overstates " +
      "the mechanism (specification item 63)",
  },
  {
    module: "aurora/neural-cognitive-core",
    level: "beta",
    promisedBehaviour: "The name promises a neural cognitive substrate",
    actualBehaviour:
      "A durable pattern registry with activation counters and snapshots. Pattern matching and statistics " +
      "are real; nothing about it is neural",
    hasTests: true,
    wiredToEngine: true,
    gapToStable:
      "Rename to CognitivePatternRegistry, or implement a mechanism the current name would justify " +
      "(specification item 63)",
  },
  {
    module: "world/world-model-exploration",
    level: "beta",
    promisedBehaviour: "Predictive world model driving exploration",
    actualBehaviour:
      "Records state/action/prediction/outcome and computes surprise plus exploration value; predictions are supplied by callers, not learned",
    hasTests: true,
    wiredToEngine: true,
    gapToStable: "No learned forward model; predictions come from the caller",
  },
  {
    module: "routing/model-routing",
    level: "beta",
    promisedBehaviour: "Adaptive model routing informed by measured performance",
    actualBehaviour:
      "Constraint filtering plus scoring over registered profiles; adapts only from supplied benchmark data. " +
      "BenchmarkRunner now requires a caller-supplied `generate` function — it previously scored a fabricated " +
      "string, so a 'Qwen vs Qwen+Aurora' comparison compared two identical synthetic outputs",
    hasTests: true,
    wiredToEngine: true,
    gapToStable: "No online learning from production outcomes",
  },
  {
    module: "society/agent-society",
    level: "beta",
    promisedBehaviour: "Multi-agent society with reputation-based routing",
    actualBehaviour: "Reputation scoring and routing over declared agent profiles",
    hasTests: true,
    wiredToEngine: true,
    gapToStable: "No emergent negotiation between agents",
  },
  {
    module: "aurora/goal-discovery",
    level: "beta",
    promisedBehaviour: "Discovers its own goals from the workspace",
    actualBehaviour:
      "Detects concrete anomaly classes (TODO markers, dependency and config issues) and turns them into candidate goals with verifiers",
    hasTests: true,
    wiredToEngine: true,
    gapToStable: "Anomaly detection is pattern-based, not semantic",
  },
  {
    module: "security/reward-hacking-defense",
    level: "beta",
    promisedBehaviour: "Defends the evaluation layer against reward hacking",
    actualBehaviour:
      "Protected metric validation, a fixed attack-pattern library, and a pipeline that runs real detectors " +
      "over supplied evidence (it previously ran every check as `async () => true` and always reported clean)",
    hasTests: true,
    wiredToEngine: true,
    gapToStable: "Attack library is static; no adaptive red-teaming",
  },
  {
    module: "execution/unified-execution-loop",
    level: "beta",
    promisedBehaviour: "One path from task to verified result: observe, recall, plan, act, verify, learn, recover",
    actualBehaviour:
      "Runs the real agent through SessionActor, derives status from evidence, verifies via VerificationFactory, " +
      "classifies failures and bounds recovery. Replaces the orchestration-only runTask(), which returned " +
      "outcome:'success' with zero phases executed",
    hasTests: true,
    wiredToEngine: true,
    gapToStable:
      "Planner and learn hooks are optional and currently unsupplied by engine.execute(); " +
      "capability acquisition is not yet in the recovery path",
  },
  {
    module: "execution/capability-acquisition",
    level: "beta",
    promisedBehaviour: "Turns a detected gap into a verified, quarantined capability",
    actualBehaviour:
      "Contract → generator → static analysis → real Worker sandbox → known-good checks → known-bad decoys → " +
      "adversarial input → verified. Decoys catch implementations that memorise their tests (verified: a " +
      "lookup-table cheat passes every known-good case and is rejected by the decoy). Generated code is never " +
      "imported into the core process",
    hasTests: true,
    wiredToEngine: true,
    gapToStable:
      "The implementation generator must still be supplied by the caller (no model " +
      "binding here, per specification item 33). As of 2026-09 engine.execute() accepts " +
      "`capabilityGenerator` and builds the acquireCapability hook from it, so the chain " +
      "gap -> contract -> code -> static analysis -> sandbox -> known-good -> decoys -> " +
      "CapabilityBroker runs end to end. A verified capability is now registered with the real " +
      "broker under an `acquired.` namespace and delegates every call back into the sandbox, so " +
      "generated source still never enters this process (item 14) while the agent can actually " +
      "reach it. Before 2026-09 it stopped at the synthesis pipeline's private map, which meant " +
      "'generated' and 'usable' were different statements. The remaining limit is coverage, not " +
      "wiring: test cases are hand-written per requirement rule, so exactly one capability can " +
      "be acquired this way",
  },
  {
    module: "execution/gap-detection",
    level: "beta",
    promisedBehaviour: "Names the missing capability rather than only reporting that a task failed",
    actualBehaviour:
      "Two working tiers: deterministic (goal requirement vs real CapabilityBroker inventory, confidence 0.93) " +
      "and structural (failure-signature extraction, lower confidence). Wired into the recovery loop, so an " +
      "identified gap triggers capability acquisition and a retry of the ORIGINAL task",
    hasTests: true,
    wiredToEngine: true,
    gapToStable:
      "Requirement table is a fixed 7-entry list, not learned, and the LLM tier throws rather than " +
      "being implemented. Of those 7 entries only visual_diff carries test cases and is genuinely " +
      "synthesisable; pdf_parsing was downgraded to synthesisable: false after measuring that the " +
      "sandbox has no filesystem or binary decoding, so generated code could only have faked it. " +
      "The remaining entries name their gap and stop there, which is honest but means one capability, " +
      "not a general ability to acquire any missing tool",
  },
  {
    module: "execution/verification-factory",
    level: "beta",
    promisedBehaviour: "Formal, empirical, consensus and unverifiable verification tiers with PASS/FAIL/UNCERTAIN",
    actualBehaviour:
      "Runs verifiers strongest-first; a throwing or unavailable verifier yields UNCERTAIN, never PASS; " +
      "an empty test run is UNCERTAIN; VerificationGapError is raised when a claim cannot be checked. " +
      "Ships formalVerifier (V1 command), empiricalVerifier (V2 test run) and acceptanceVerifier (V2 " +
      "workspace file state) — the last refuses paths escaping the workspace and reports UNCERTAIN, never " +
      "PASS, when no workspace exists to inspect",
    hasTests: true,
    wiredToEngine: true,
    gapToStable:
      "Callers still choose which verifiers apply to a given task; V3 consensus now has an implementation but needs a real evaluator panel supplied by the caller",
  },
  {
    module: "execution/failure-taxonomy",
    level: "beta",
    promisedBehaviour: "15 failure kinds mapped to bounded recovery strategies",
    actualBehaviour:
      "Deterministic pattern classification with explicit abstention (fundamental_unknown) rather than guessing; " +
      "security blocks never auto-retry; resource exhaustion aborts instead of spending more. " +
      "Measured 2026-09: all 15 kinds are reachable from realistic messages and route to 11 distinct " +
      "recovery strategies, so the taxonomy discriminates rather than collapsing into one bucket. " +
      "security_block classifies at confidence 1.00 and aborts at every attempt count and budget " +
      "(verified by sabotaging the rule and confirming the tests fail)",
    hasTests: true,
    wiredToEngine: true,
    gapToStable: "Classification is regex-based; no structural or LLM-assisted tier yet",
  },
  {
    module: "security/reward-hacking-detectors",
    level: "beta",
    promisedBehaviour: "Detects reward curve manipulation, score spikes, evaluation cheating, metric gaming and data poisoning",
    actualBehaviour:
      "Statistical detectors over supplied evidence: reward/ground-truth divergence, z-score and flat-baseline spike tests, " +
      "self-grading and held-out collapse, cross-metric degradation, Tukey + median-absolute-deviation outlier detection. " +
      "Abstains explicitly when evidence is insufficient rather than reporting clean",
    hasTests: true,
    wiredToEngine: true,
    gapToStable:
      "Thresholds are fixed constants, not calibrated against a labelled corpus of real hacking attempts; " +
      "detection is per-signal with no joint model",
  },
  {
    module: "pipeline/code-pipeline-service",
    level: "experimental",
    promisedBehaviour: "Issue to deployment: plan, branch, implement, test, security review, PR, CI, deploy",
    actualBehaviour:
      "Issue tracking, run/stage state machine, plan and branch naming are real. Implement, test, security review, " +
      "PR, CI and deploy now throw CodePipelineStageNotImplementedError — they previously returned fabricated " +
      "success (security score 100, all CI jobs green, successful deployment, random PR number)",
    hasTests: true,
    wiredToEngine: true,
    gapToStable: "Six of eight stages need real backends before the pipeline can complete a run",
  },
  {
    module: "aurora/integration-verification",
    level: "beta",
    promisedBehaviour: "Verifies integrations and rolls back bad changes",
    actualBehaviour: "Rollback points, integration test runner, hash-based core guardian",
    hasTests: true,
    wiredToEngine: true,
    gapToStable: "Rollback covers in-memory state, not the filesystem",
  },
  {
    module: "sdk/agent-sdk-service",
    level: "experimental",
    promisedBehaviour: "Register, publish, instantiate and execute third-party extensions",
    actualBehaviour:
      "The registry, publish lifecycle, instance and permission model are real and persisted. Execution is " +
      "NOT: executeInSandbox throws ExtensionSandboxUnavailableError. It previously returned " +
      "`{ success: true, extension, input }` without running anything, which made getStats() report a 100% " +
      "success rate for extensions that had never executed",
    hasTests: true,
    wiredToEngine: true,
    gapToStable:
      "Needs a real isolate wired in (SandboxExecutor's Worker isolate or the signed WasiPluginManager) " +
      "before extensions can execute at all",
  },
  {
    module: "surface/jarvis-surface",
    level: "beta",
    promisedBehaviour: "Voice, multimodal, computer use and integrations",
    actualBehaviour:
      "Record-keeping and orchestration surfaces; the actual STT/TTS/vision work is delegated to configured " +
      "providers. Unbacked capabilities now throw rather than returning fabricated output: OCR/transcription " +
      "returned '[OCR placeholder for X]' strings, computer-use reported every click and keypress as performed " +
      "(including a literal 'base64...' screenshot), and connector actions returned `{ success: true }`",
    hasTests: true,
    wiredToEngine: true,
    gapToStable: "No bundled STT/TTS/vision implementation; no automation or connector backends",
  },

  // ── Experimental: the name promises more than the code delivers ──
  {
    module: "digital-twin",
    level: "experimental",
    promisedBehaviour: "A live digital twin simulating the target system",
    actualBehaviour:
      "Maintains a mirrored state record; no simulation loop. sync() now throws instead of returning " +
      "`{ synced: true }` with a fresh lastSyncedAt for a sync that contacted nothing",
    hasTests: true,
    wiredToEngine: true,
    gapToStable: "Needs an actual simulation/prediction loop before the name is honest",
  },
  {
    module: "embodiment",
    level: "experimental",
    promisedBehaviour: "Embodied agency over physical or virtual actuators",
    actualBehaviour: "Action descriptors and bookkeeping; no actuator backend",
    hasTests: true,
    wiredToEngine: true,
    gapToStable: "Needs a real actuator/effector integration",
  },
  {
    module: "federated",
    level: "experimental",
    promisedBehaviour: "Federated learning across nodes",
    actualBehaviour:
      "Node registry and round bookkeeping; no gradient exchange. Data-residency policy rules are now really " +
      "evaluated (checkResidency() previously always returned true) and rule types with no implementation are " +
      "reported via `unenforceable` rather than passing silently. Local inference throws instead of returning " +
      "a placeholder string",
    hasTests: true,
    wiredToEngine: true,
    gapToStable:
      "Needs real parameter aggregation across nodes; four of six policy rule types (encrypt_at_rest, " +
      "encrypt_in_transit, retention, anonymize) are still unevaluated",
  },
  {
    module: "domain-experts",
    level: "experimental",
    promisedBehaviour: "Specialised domain expert models",
    actualBehaviour:
      "Routing metadata for domain tagging; experts are configured, not trained. Every analysis "  +
      "helper returns a fixed template and no source database is searched, so a consultation is a "  +
      "disclaimer-bearing stub, which is what it reports: no sources, confidence 0.2, professional "  +
      "review required. Reachable over HTTP at /v1/domain-experts/*",
    hasTests: true,
    wiredToEngine: true,
    gapToStable:
      "Needs genuinely specialised expert backends and a real source database. Until then the "  +
      "value of this module is its refusals: compliance checks with no loaded requirements now "  +
      "report status unknown with score 0, not compliant with score 100, which is what they "  +
      "returned before 2026-09 for a high-risk legal question",
  },
] as const;

/**
 * What the evidence supports, independent of what a module declares about
 * itself.
 *
 * Ordered weakest first. `verified` means it ran during a real task under
 * `observe:runtime` — measured, not asserted. `production` means observed in a
 * real deployment, which requires somebody to have witnessed it and recorded it
 * here; nothing in this repository can generate that evidence on its own.
 */
export type EvidenceLevel = "unproven" | "verified" | "production";

/**
 * The highest level this module's evidence supports, ignoring its declaration.
 *
 * Derived from the runtime observation rather than from a hand-written field, so
 * it cannot be claimed: the only way a module reaches `verified` here is for
 * `observe:runtime` to have seen its methods run during a real task.
 */
export function evidenceLevelOf(module: ModuleMaturity): EvidenceLevel {
  // A module with no observation was not measured at all, which is weaker than
  // `absent`: absent means the run loaded it and nothing touched it.
  const depth = observationOf(module.module)?.depth ?? "absent";
  if (depth === "exercised") return "verified";
  // `failed`, `constructed` and `absent`: the module exists and may well work,
  // but nothing has been observed of it working in use.
  return "unproven";
}

/**
 * The level this module may claim once the evidence is taken into account.
 *
 * The rule A10 adds: **`stable` requires production evidence.** A module with
 * tests and a call site is built and reachable — that is `beta`. Calling it
 * `stable` says it has been seen working in production, and until somebody
 * records that observation in `productionEvidence`, the declaration outruns the
 * evidence.
 *
 * This does not rewrite the registry. `MODULE_MATURITY` keeps what each module
 * claims, and `effectiveLevelOf` reports what the evidence supports. The gap
 * between the two is the finding; silently editing eighteen labels to `beta`
 * would hide it and lose the promise each entry makes.
 *
 * `experimental` never rises: it is a statement that the name promises more than
 * the code delivers, and no amount of runtime coverage changes that.
 */
export function effectiveLevelOf(module: ModuleMaturity): MaturityLevel {
  if (module.level === "experimental") return "experimental";
  if (module.level === "stable" && !module.productionEvidence) return "beta";
  return module.level;
}

/**
 * Modules that declare `stable` without recording production evidence.
 *
 * A10: this used to be the same list as `mislabelledModules()` — the only rule
 * was "has tests and is wired". Reporting the two separately keeps the
 * distinction visible: a mislabelling is a broken claim, this is an unproven one.
 */
export function stableWithoutProductionEvidence(): ModuleMaturity[] {
  return MODULE_MATURITY.filter(
    (entry) => entry.level === "stable" && !entry.productionEvidence,
  );
}

/** Look up one module's declared maturity. */
export function maturityOf(module: string): ModuleMaturity | undefined {
  return MODULE_MATURITY.find((m) => m.module === module);
}

/** All modules at a given level. */
export function modulesAtLevel(level: MaturityLevel): ModuleMaturity[] {
  return MODULE_MATURITY.filter((m) => m.level === level);
}

/**
 * Modules whose declared level is not justified by the evidence.
 *
 * A `stable` module must have tests and be wired; anything else is a
 * mislabelling and should fail CI.
 */
export function mislabelledModules(): ModuleMaturity[] {
  return MODULE_MATURITY.filter(
    (m) => m.level === "stable" && (!m.hasTests || !m.wiredToEngine)
  );
}

/** Registry summary. */
export function maturitySummary(): {
  total: number;
  stable: number;
  beta: number;
  experimental: number;
  mislabelled: number;
  /** Declared reachable from Engine. Hand-written; currently every entry. */
  declaredWired: number;
  /** Observed doing work during a real task. Measured. */
  observedExercised: number;
  /** Observed running during the task with every recorded call failing. Measured. */
  observedFailed: number;
  /** Declared `stable` with no recorded production evidence. A10. */
  unprovenStable: number;
  /** Counts by evidence-supported level rather than by declaration. A10. */
  effective: Record<MaturityLevel, number>;
} {
  const effectiveAt = (level: MaturityLevel) =>
    MODULE_MATURITY.filter((entry) => effectiveLevelOf(entry) === level).length;
  const observed = observationSummary();
  return {
    total: MODULE_MATURITY.length,
    stable: modulesAtLevel("stable").length,
    beta: modulesAtLevel("beta").length,
    experimental: modulesAtLevel("experimental").length,
    mislabelled: mislabelledModules().length,
    declaredWired: MODULE_MATURITY.filter((entry) => entry.wiredToEngine).length,
    observedExercised: observed.exercised,
    observedFailed: observed.failed,
    unprovenStable: stableWithoutProductionEvidence().length,
    effective: {
      stable: effectiveAt("stable"),
      beta: effectiveAt("beta"),
      experimental: effectiveAt("experimental"),
    },
  };
}
