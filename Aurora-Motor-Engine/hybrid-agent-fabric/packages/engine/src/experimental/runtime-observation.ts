/**
 * Runtime observation — what actually runs, not what we declared.
 *
 * `wiredToEngine` is a hand-written boolean, and at the time this file was
 * added all 30 entries said `true` and none said `false`. A field that never
 * discriminates is not measuring anything; it is a habit. N4 demonstrated the
 * failure mode concretely: deleting the security guard's registration from
 * `engine.ts` broke zero tests, because the tests proved the guard worked
 * rather than that the engine used it.
 *
 * So this does not add a second boolean for a human to fill in. It records
 * what V8 coverage observed while a real task ran, and the registry test
 * compares the declaration against the observation.
 *
 * ## The distinction that matters
 *
 * Three different things get called "wired", and only the last one is what the
 * word promises:
 *
 *  - **loaded** — the module was imported. Costs nothing, proves nothing.
 *  - **constructed** — `new Service()` ran during `initialize()`. This is what
 *    most of the registry actually had: a pipeline built at startup, holding
 *    state, answering `getStats()`, and never asked anything else.
 *  - **exercised** — a method of it was called *while a task was running*,
 *    beyond what startup already called.
 *
 * Measured on 2026-09-20 with one real `engine.execute()` goal: 5 of 30
 * modules were exercised. 25 were constructed and then never consulted.
 * That is the honest number, and it is the one this module exists to keep
 * visible.
 *
 * ## What this does not claim
 *
 * One task exercises one path. A module that is idle for a file-writing goal
 * may be essential for a different one — `society/agent-society` is not dead
 * code, it is unreachable from *this* goal. `RuntimeObservation` therefore
 * records the goal it was measured under, and `observed: false` means
 * "not seen on this path", never "broken".
 */

/** How deeply the runtime touched a module during an observed run. */
export type ObservationDepth =
  /** Never imported. */
  | "absent"
  /** Imported and/or constructed at startup; no method called afterwards. */
  | "constructed"
  /**
   * A method ran during the task itself, beyond startup.
   *
   * This says the code executed. It does not say the call succeeded — see
   * `failed`.
   */
  | "exercised"
  /**
   * A method ran during the task, and every capability of this module that the
   * broker recorded threw.
   *
   * Coverage cannot tell these apart: a function that throws on its first line
   * still executes that line. Counting it as `exercised` is what made
   * `embodiment.fs.*` look healthy while every invocation failed with ENOENT,
   * and it made the headline "N modules did work" untrue.
   *
   * Only assigned when there is outcome evidence, and only when *every* recorded
   * call failed — one success means the module demonstrably worked.
   */
  | "failed";

/** What one observation run saw for one module. */
export interface RuntimeObservation {
  readonly module: string;
  readonly depth: ObservationDepth;
  /** Methods seen during the task, excluding those startup already called. */
  readonly methodsDuringTask: readonly string[];
  /** The goal the engine was given, so the result can be reproduced. */
  readonly underGoal: string;
  /** ISO date of the measurement. */
  readonly measuredAt: string;
}

const GOAL = "Create a file called hello.txt containing the word hello";
const MEASURED_AT = "2026-09-20";

function exercised(module: string, methods: readonly string[]): RuntimeObservation {
  return {
    module,
    depth: "exercised",
    methodsDuringTask: methods,
    underGoal: GOAL,
    measuredAt: MEASURED_AT,
  };
}

function constructed(module: string): RuntimeObservation {
  return {
    module,
    depth: "constructed",
    methodsDuringTask: [],
    underGoal: GOAL,
    measuredAt: MEASURED_AT,
  };
}

/**
 * Observations from `probe: NODE_V8_COVERAGE` over two runs — one that only
 * called `initialize()`, one that also ran a real goal — with the difference
 * taken so that startup work is not counted as task work.
 *
 * Regenerate with `npm run observe:runtime -w @haf/engine`.
 */
export const RUNTIME_OBSERVATIONS: readonly RuntimeObservation[] = [
  // Measured by `npm run observe:runtime`, not asserted by hand. The number is
  // the union of what a four-task suite touched, because no single task covers
  // both halves of the system: a task that verifies never enters the failure
  // path, and a task that cannot verify exercises nothing else.
  //
  //   - Task 1 runs against a real workspace with a real toolchain, so it
  //     completes verification instead of returning `unverified` every run.
  //   - Task 2 has no workspace and an unachievable goal, so it fails. That is
  //     what makes `gap-detection` and `failure-taxonomy` reachable; they are
  //     not unwired, they are unreachable from a task that succeeds.
  //   - Task 3 fails with a verifier naming a missing tool, which is the only
  //     way to get a *capability* gap rather than a `verification` gap. That is
  //     what makes `capability-acquisition` reachable, and what took the count
  //     of never-loaded modules to zero.
  //   - Task 4 asks about tax and VAT, which is the only kind of goal the
  //     domain experts are for. Without it the classifier never matches.
  //   - The loop consults the cognitive runtime on its `learn` path: skill
  //     synthesis, skill promotion, skill composition, production persistence,
  //     integration verification and the agent-society evaluation.
  //   - The loop screens the goal before acting and audits the verdict before
  //     trusting it: the security system and both reward-hacking modules.
  //   - The loop asks the model router which model fits the task, which required
  //     seeding the routing table -- an empty router answered "No suitable
  //     model found" for every task type.
  //   - The loop predicts the outcome before the agent acts and records what
  //     happened afterwards, which is what lets the world model compute
  //     surprise and exploration value at all.
  //   - The loop analyses the caller's workspace and records what it proposes,
  //     without acting on any of it.
  //   - The loop matches the goal against cognitive patterns learned from
  //     earlier verified tasks, and grades the match afterwards.
  //   - Every stored lesson is embedded in the cross-layer fusion index, which
  //     memory maintenance then deduplicates.
  //   - Maintenance evolves the capability-generation prompt against measured
  //     fitness and adopts a variant only when it beats the incumbent.
  //
  // `capabilities/capability-synthesis` is idle rather than exercised because
  // the mock provider cannot write code that survives static analysis, so
  // acquisition rejects the candidate before synthesis runs. That is the chain
  // working, not a missing wire. `embodiment` is idle because it backs the
  // `filesystem.*` capabilities and no task in this suite invokes one
  // successfully -- the same root cause as the goal-level verification gap.
  //
  // Task 1 is reported `unverified` rather than `succeeded`, and that is
  // correct rather than a regression. Its only verifier is the toolchain build,
  // which is workspace-scoped: it proves the workspace still compiles, not that
  // hello.txt was created. A `pass` built only out of workspace-scoped evidence
  // is now downgraded to `uncertain`. Before that change this task reported
  // `succeeded` with verification `pass` while the file did not exist.
  //
  // `embodiment` stays idle for a different and still-open reason: the
  // `filesystem.*` capabilities it backs are registered, but the agent session
  // settles idle without dispatching the tool call to the broker, so no
  // capability is ever invoked. That is a gap between the agent session and the
  // capability broker, not a missing call site in this module.
  //
  //   - Task 1 is reported `unverified` rather than `succeeded`, and that is
  //     correct rather than a regression. Its only verifier is the toolchain
  //     build, which is workspace-scoped: it proves the workspace still
  //     compiles, not that hello.txt was created. A `pass` built only out of
  //     workspace-scoped evidence is now downgraded to `uncertain`.
  //   - Task 5 invokes `filesystem.write` and does create the file, yet still
  //     reports `unverified`, for the same reason. Both facts are correct at
  //     once: the work happened and nothing checked that it did.
  //   - Task 6 invokes `embodiment.fs.info`. `embodiment` is NOT the backend
  //     for `filesystem.*` -- those live in capabilities/filesystem.ts and
  //     write directly. It exposes its own `embodiment.fs.*` and
  //     `embodiment.action.*` namespaces backed by FileSystemAgent, so a task
  //     has to name that one for the module to run. Two overlapping filesystem
  //     capability sets is a finding in its own right.
  //   - The mock provider only emits a tool call for an explicit `[tool ...]`
  //     directive. It used to require the directive at the very end of the
  //     prompt, and `buildAgentBriefing` appends the plan and recalled memories
  //     after the goal, so no task could ever produce a tool call and no
  //     capability was ever invoked.
  //
  //   - Task 1 is reported `unverified` rather than `succeeded`, and that is
  //     correct rather than a regression. Its only verifier is the toolchain
  //     build, which is workspace-scoped: it proves the workspace still
  //     compiles, not that hello.txt was created. A `pass` built only out of
  //     workspace-scoped evidence is now downgraded to `uncertain`.
  //   - Task 5 invokes `filesystem.write` and does create the file, yet still
  //     reports `unverified`, for the same reason. Both facts are correct at
  //     once: the work happened and nothing checked that it did.
  //   - Task 6 invokes `embodiment.fs.info`. `embodiment` is NOT the backend
  //     for `filesystem.*` -- those live in capabilities/filesystem.ts and
  //     write directly. It exposes its own `embodiment.fs.*` and
  //     `embodiment.action.*` namespaces backed by FileSystemAgent, so a task
  //     has to name that one for the module to run. Two overlapping filesystem
  //     capability sets is a finding in its own right.
  //   - Task 7 points at logo.png so the surface service analyses real media.
  //     The media is read from the task workspace, not through FileSystemAgent:
  //     that agent resolves paths against its own home workspaces root, so it
  //     could not see the task's files and the hook failed silently.
  //   - The mock provider only emits a tool call for an explicit `[tool ...]`
  //     directive. It used to require the directive at the very end of the
  //     prompt, and `buildAgentBriefing` appends the plan and recalled memories
  //     after the goal, so no task could ever produce a tool call and no
  //     capability was ever invoked.
  //   - `codePipeline`, `agentSDK`, `digitalTwin`, `federated` and `surface` run
  //     from `reportToServices`, after the loop has finished. Which capabilities
  //     a task invoked is taken from the broker's own lifecycle events, because
  //     `TaskReport` carries no tool-call list and its trace records phase
  //     transitions only -- the loop cannot say what it ran.
  //
  //   - Task 1 is reported `unverified` rather than `succeeded`, and that is
  //     correct rather than a regression. Its only verifier is the toolchain
  //     build, which is workspace-scoped: it proves the workspace still
  //     compiles, not that hello.txt was created. A `pass` built only out of
  //     workspace-scoped evidence is now downgraded to `uncertain`.
  //   - Task 6 invokes `embodiment.fs.info`, and `createFileInfo` appears in its
  //     method list. That is the evidence the call succeeded: `createFileInfo`
  //     only runs on the success path, whereas `resolveSafePath` alone ran when
  //     the call was throwing ENOENT. The `embodiment.fs.*` capabilities were
  //     bound to a single agent rooted at the engine's home workspaces
  //     directory, ignoring the session's workspace, so they could not see the
  //     task's files at all. Coverage counted the module as exercised either
  //     way -- a capability that throws on every invocation still executes its
  //     first line.
  //   - `TaskReport.capabilitiesInvoked` now says what a task ran. It could not
  //     before: capabilities execute in the session actor, several layers down,
  //     and the trace records phase transitions rather than actions. The field
  //     is filled from the capability broker, which is the authority on
  //     execution. Measured consequence: a second task that asked for no tools
  //     still reported `filesystem.write`, because the first task's directive
  //     had been written to memory and came back through recall. The report was
  //     telling the truth; the mock re-fires on a directive it finds anywhere in
  //     the assembled prompt.
  //   - `codePipeline`, `agentSDK`, `digitalTwin`, `federated` and `surface` run
  //     from `reportToServices`, after the loop has finished.
  //
  //   - `routing/model-routing` is idle because model routing was consolidated
  //     onto `ModelSelectionEngine`, which reads the providers actually
  //     registered in `ModelRouter`. The old path routed against a list filled
  //     only by `addDefaultModels()` -- three hardcoded entries that were not in
  //     the system. Two routers choosing between different sets of models was
  //     the defect; consolidating them necessarily idles one.
  //   - That consolidation lowers this count without losing any work, because
  //     `aurora/unified-engines` -- where `ModelSelectionEngine` lives -- is not
  //     one of the 30 modules in the maturity register. The routing is done by a
  //     live module the measurement does not track. Read the number alongside
  //     that, not on its own.
  exercised("skills/skill-synthesis", ["addSkill", "addTrajectory", "detectPatterns", "mineCandidates", "runPipeline", "synthesizeFromCandidate", "verifySkill"]),
  exercised("skills/skill-promotion", ["recordExecution", "register"]),
  exercised("skills/skill-composition", ["addEdge", "addNode", "createCompositeSkill", "detectCycles", "topologicalSort"]),
  exercised("security/security-system", ["detect", "screenText"]),
  exercised("persistence/production-persistence", ["createEvent"]),
  exercised("aurora/long-horizon-memory", ["autoConsolidate", "decay", "search"]),
  exercised("memory/real-memory-pipeline", ["addMemories", "calculateDocFreq", "contentRelevance", "fuse", "rerank", "score", "search", "tokenize"]),
  exercised("aurora/self-improvement", ["addSeedPrompt", "createMutation", "crossoverTemplate", "evaluateFitness", "evolvePrompts", "mutateTemplate", "mutations"]),
  exercised("aurora/neural-memory-fusion", ["consolidate", "digest", "embed", "extractKeywords", "extractPatterns", "generateDenseVector", "hash"]),
  exercised("aurora/neural-cognitive-core", ["activate"]),
  exercised("world/world-model-exploration", ["addAction", "addState", "calculateExplorationValue", "calculateSurprise", "calculateUncertainty", "createPrediction", "executeStep", "recordError", "recordOutcome", "recordResult", "visitState"]),
  exercised("society/agent-society", ["addAgent", "calculateReputation", "evaluateAgent"]),
  exercised("aurora/goal-discovery", ["analyzeConfig", "analyzeDependencies", "analyzeFiles", "analyzeWorkspace", "createGoalFromGroup", "createVerifierForGoal", "createVerifiersForGoals", "generateGoalsFromAnomalies", "runPipeline"]),
  exercised("security/reward-hacking-defense", ["runAttackTest", "runAudit", "runDefensePipeline"]),
  exercised("execution/unified-execution-loop", ["buildReport", "emit", "messageOf", "recordStepProgress", "run", "summarise", "verify"]),
  exercised("execution/capability-acquisition", ["acquire", "contractFromGap"]),
  exercised("execution/gap-detection", ["detectDeterministicGaps", "detectGaps", "detectStructuralGaps", "extractMissingName"]),
  exercised("execution/verification-factory", ["autonomyFor", "combine", "formalVerifier", "register", "verify"]),
  exercised("execution/failure-taxonomy", ["chooseRecovery", "classifyFailure"]),
  exercised("security/reward-hacking-detectors", ["buildDefenceChecks", "detectDataPoisoning", "detectEvaluationCheating", "detectMetricGaming", "detectRewardCurveManipulation", "detectScoreSpike", "detectorForCategory"]),
  exercised("pipeline/code-pipeline-service", ["createIssue", "startPipeline"]),
  exercised("aurora/integration-verification", ["createRollbackPoint", "rollback", "runPipeline", "verify"]),
  exercised("sdk/agent-sdk-service", ["registerExtension"]),
  exercised("surface/jarvis-surface", ["analyzeImage", "createInput", "processMultimodal"]),
  exercised("digital-twin", ["addTool", "createTwin", "recordToolUsage"]),
  exercised("embodiment", ["createFileInfo", "resolveSafePath"]),
  exercised("federated", ["heartbeat", "registerNode"]),
  exercised("domain-experts", ["consult"]),

  // Loaded, not consulted by this suite. Not dead code -- unreachable from
  // these seven goals. See the module note above.
  constructed("capabilities/capability-synthesis"),
  constructed("routing/model-routing"),
];

/** Observation for one module, if it was measured. */
export function observationOf(module: string): RuntimeObservation | undefined {
  return RUNTIME_OBSERVATIONS.find((entry) => entry.module === module);
}

/** Counts by depth, for the generated state documents. */
export function observationSummary(): {
  total: number;
  exercised: number;
  failed: number;
  constructed: number;
  absent: number;
  underGoal: string;
  measuredAt: string;
} {
  const count = (depth: ObservationDepth) =>
    RUNTIME_OBSERVATIONS.filter((entry) => entry.depth === depth).length;
  return {
    total: RUNTIME_OBSERVATIONS.length,
    exercised: count("exercised"),
    failed: count("failed"),
    constructed: count("constructed"),
    absent: count("absent"),
    underGoal: GOAL,
    measuredAt: MEASURED_AT,
  };
}
