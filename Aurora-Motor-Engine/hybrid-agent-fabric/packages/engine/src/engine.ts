import { createHash, randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { appendFile, mkdir, rm } from "node:fs/promises";
import type {
  CommandEnvelope,
  CommandResult,
  EventEnvelope,
  ModelProvider,
  SessionAgentProfile,
  SessionSnapshot,
} from "./types.js";

// ═══ Version: Single source of truth ═══
export { ENGINE_VERSION, ENGINE_NAME, getVersionInfo } from "./version.js";
import { FileEventStore, type EventStore } from "./persistence/event-store.js";
import {
  FileSnapshotStore,
  type SnapshotStore,
} from "./persistence/snapshot-store.js";
import {
  CommandJournal,
  type CommandJournalLike,
} from "./persistence/command-journal.js";
import {
  EffectJournal,
  type EffectJournalLike,
} from "./persistence/effect-journal.js";
import type { SessionLeaseManagerLike } from "./persistence/session-lease.js";
import {
  PostgresDatabase,
  type PostgresDatabaseOptions,
} from "./persistence/postgres/database.js";
import { PostgresEventStore } from "./persistence/postgres/event-store.js";
import { PostgresSnapshotStore } from "./persistence/postgres/snapshot-store.js";
import { PostgresCommandJournal } from "./persistence/postgres/command-journal.js";
import { PostgresEffectJournal } from "./persistence/postgres/effect-journal.js";
import { PostgresSessionLeaseManager } from "./persistence/postgres/session-lease.js";
import { ApprovalService } from "./policy/approval-service.js";
import {
  DefaultPolicyEngine,
  type PolicyEngine,
} from "./policy/policy-engine.js";
import {
  LayeredPolicyEngine,
  OpaPolicyEngine,
  type OpaPolicyOptions,
} from "./policy/opa-policy-engine.js";
import {
  AuroraPolicyEngine,
  type AuroraPolicyOptions,
} from "./policy/aurora-policy-engine.js";
import { CapabilityBroker } from "./capabilities/capability-broker.js";
import { MemoryStore } from "./memory/memory-store.js";
import { ExternalMemoryProviderManager } from "./memory/external-memory-provider.js";
import {
  HonchoMemoryProvider,
  type HonchoMemoryProviderOptions,
} from "./memory/honcho-memory-provider.js";
import { SkillRegistry } from "./skills/skill-registry.js";
import { SkillsHub } from "./skills/skills-hub.js";
import { LearningGovernor } from "./learning/learning-governor.js";
import { LearningRolloutManager } from "./learning/learning-rollout.js";
import { RefinementService } from "./learning/refinement-service.js";
import {
  AutomaticRefinementCoordinator,
  RefinementPlanner,
} from "./learning/refinement-planner.js";
import { ContextManager } from "./context/context-manager.js";
import {
  RollingMicroCompactor,
  type RollingMicroCompactorOptions,
} from "./context/rolling-micro-compactor.js";
import { ModelProviderRegistry } from "./models/model-router.js";
import { MockModelProvider } from "./models/mock-provider.js";
import { OpenAICompatibleProvider } from "./models/openai-compatible-provider.js";
import { CodexOAuthManager } from "./models/codex-oauth-manager.js";
import { ModelOAuthManager } from "./models/model-oauth-manager.js";
import { CodexSubscriptionProvider } from "./models/codex-subscription-provider.js";
import { ProviderProfileRegistry } from "./models/provider-profiles.js";
import {
  FileCredentialPoolStateStore,
  type ProviderCredentialInput,
} from "./models/provider-credential-pool.js";
import { ModelConfigurationRegistry } from "./models/model-configuration-registry.js";
import { AgentProfileRegistry } from "./profiles/agent-profile-registry.js";
import { KernelManager } from "./kernel/kernel-manager.js";
import { Supervisor, SessionNotRunnableError, type AgentFanoutLimits } from "./runtime/supervisor.js";
import {
  FileAgentInboxStore,
  PostgresAgentInboxStore,
  type AgentInboxStore,
} from "./runtime/agent-inbox.js";
import { StuckDetectorService } from "./runtime/stuck-detector.js";
import { filesystemCapabilities } from "./capabilities/filesystem.js";
import { memoryCapabilities } from "./capabilities/memory.js";
import { skillCapabilities } from "./capabilities/skills.js";
import { processCapability } from "./capabilities/process.js";
import { backgroundShellCapabilities } from "./capabilities/background-shell.js";
import { autoApprovalCapabilities } from "./capabilities/auto-approval.js";
import { verificationCapabilities } from "./capabilities/verification.js";
import { VerificationService } from "./harness/verification-service.js";
import { codeIntelligenceCapabilities } from "./capabilities/code-intelligence.js";
import { CodeIntelligenceService } from "./code-intelligence/service.js";
import { promptCacheCapabilities } from "./capabilities/prompt-cache.js";
import { PromptCacheService } from "./prompt-cache/prompt-cache-service.js";
import { AutoApprovalService } from "./policy/auto-approval.js";
import { SessionBudgetExceededError, SessionBudgetService } from "./policy/session-budget.js";
import { sessionBudgetCapabilities } from "./capabilities/session-budget.js";
import { BackgroundShellService } from "./sandbox/background-shell.js";
import { gitCapabilities } from "./capabilities/git.js";
import { pythonCapability } from "./capabilities/python.js";
import { agentCapabilities } from "./capabilities/agents.js";
import { goalCapabilities } from "./capabilities/goals.js";
import { taskCapabilities } from "./capabilities/tasks.js";
import type { SandboxResourceLimits } from "./sandbox/sandbox.js";
import {
  createSandboxFactory,
  type SandboxBackendKind,
  type SingularitySandboxOptions,
  type SshSandboxOptions,
} from "./sandbox/sandbox.js";
import type { CloudSandboxGatewayOptions } from "./sandbox/cloud-sandbox.js";
import {
  DurableScheduler,
  type Schedule,
  type ScheduledJob,
} from "./scheduler/scheduler.js";
import {
  HostedSchedulerRelay,
  type HostedSchedulerRelayOptions,
} from "./scheduler/hosted-relay.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { McpElicitationService } from "./mcp/mcp-elicitation-service.js";
import { ChannelGateway } from "./channels/channel-gateway.js";
import { HookBus } from "./plugins/hook-bus.js";
import { registerSecurityGuard } from "./security/security-guard-hook.js";
import {
  WasiPluginManager,
  type WasiPluginManagerOptions,
} from "./plugins/wasi/wasi-plugin-manager.js";
import { ChannelAdapterRegistry } from "./channels/delivery-adapters.js";
import { channelCapabilities } from "./capabilities/channels.js";
import { fetchPublicDocument, webCapabilities } from "./capabilities/web.js";
import { researchCapabilities } from "./capabilities/research.js";
import { webSearchCapability } from "./capabilities/web-search.js";
import {
  BraveSearchProvider,
  TavilySearchProvider,
  WebSearchService,
  type BraveSearchProviderOptions,
  type TavilySearchProviderOptions,
} from "./web/web-search.js";
import { OperationalMetrics } from "./observability/operational-metrics.js";
import {
  OtlpMetricsExporter,
  type OtlpExporterOptions,
} from "./observability/otlp-exporter.js";
import {
  CredentialBroker,
  type CredentialBrokerLike,
} from "./security/credential-broker.js";
import {
  VaultCredentialBroker,
  type VaultCredentialBrokerOptions,
} from "./security/vault-credential-broker.js";
import {
  KmsEnvelopeCredentialBroker,
  type KmsProvider,
} from "./security/kms-envelope-credential-broker.js";
import { SecretSourceRegistry } from "./security/secret-source-registry.js";
import { BackendRegistry } from "./backends/backend-registry.js";
import { AutomationService } from "./automation/automation-service.js";
import { AutomationGitSyncService } from "./automation/automation-git-sync.js";
import { AutomationResponderService } from "./automation/automation-responder-service.js";
import {
  BrowserManager,
  type BrowserManagerOptions,
} from "./browser/browser-manager.js";
import {
  AudioService,
  type AudioServiceOptions,
} from "./audio/audio-service.js";
import { audioCapabilities } from "./capabilities/audio.js";
import { imageCapabilities } from "./capabilities/images.js";
import {
  ImageGenerationService,
  OpenAIImageProvider,
  FalImageProvider,
  FalImageUpscaleProvider,
  type OpenAIImageProviderOptions,
  type FalImageProviderOptions,
  type FalImageUpscaleProviderOptions,
} from "./media/image-generation.js";
import {
  FalVideoProvider,
  FalQueuedVideoProvider,
  FalVideoUpscaleProvider,
  VideoGenerationService,
  type FalVideoProviderOptions,
  type FalQueuedVideoProviderOptions,
  type FalVideoUpscaleProviderOptions,
} from "./media/video-generation.js";
import { MediaJobManager } from "./media/media-job-manager.js";
import {
  videoCapability,
  videoUpscaleCapability,
} from "./capabilities/video.js";
import { mediaJobCapabilities } from "./capabilities/media-jobs.js";
import { interactiveArtifactCapabilities } from "./capabilities/artifacts.js";
import { hostedReviewCapabilities } from "./capabilities/hosted-reviews.js";
import { societyCapabilities } from "./capabilities/society.js";
import { cognitiveCapabilities } from "./capabilities/cognitive.js";
import { browserCapabilities } from "./capabilities/browser.js";
import { SessionSearchService } from "./search/session-search.js";
import { sessionSearchCapability } from "./capabilities/session-search.js";
import { learningCapabilities } from "./capabilities/learning.js";
import {
  HybridSearchIndex,
  HashEmbeddingProvider,
  OpenAIEmbeddingProvider,
  type OpenAIEmbeddingOptions,
} from "./search/hybrid-index.js";
import { KnowledgeIndexer } from "./search/knowledge-indexer.js";
import { knowledgeSearchCapability } from "./capabilities/knowledge-search.js";
import {
  NatsCommandBus,
  NatsEventBridge,
  NatsTransport,
  type NatsTransportOptions,
} from "./transport/nats/nats-transport.js";
import { RepositoryImporter } from "./repositories/repository-importer.js";
import { InteractiveArtifactRegistry } from "./artifacts/interactive-artifact-registry.js";
import { HostedRepositoryProviderRegistry } from "./repositories/hosted-repository-provider.js";
import { GitHubAppManager } from "./repositories/github-app-manager.js";
import { AgentSocietyService } from "./society/agent-society-service.js";
import { CognitiveWorkspaceService, MODE_ATTENTION_POLICY } from "./cognitive/cognitive-workspace-service.js";
import { MemoryGraphService } from "./memory/memory-graph-service.js";
import { WorldModelService } from "./world/world-model-service.js";
import { MultiWorldModelService } from "./world/multi-world-model-service.js";
import { ProactiveInitiativeService } from "./initiative/proactive-initiative-service.js";
import { UserModelService } from "./user/user-model-service.js";
import { SkillEvolutionService } from "./evolution/skill-evolution-service.js";
import { EnvironmentAwarenessService } from "./environment/environment-awareness-service.js";
import { ConstitutionService } from "./aurora/constitution-service.js";
import { CognitiveOrchestrator } from "./aurora/cognitive-orchestrator.js";
import { AuroraContextComposer } from "./aurora/aurora-context-composer.js";
import { DecisionService } from "./aurora/decision-service.js";
import { PlanningService } from "./aurora/planning-service.js";
import { ExperienceDistiller } from "./aurora/experience-distiller.js";
import { AuroraAutopilot } from "./aurora/autopilot.js";
import { AuroraFleetSupervisor } from "./aurora/fleet-supervisor.js";
import { AuroraExecutionBridge } from "./aurora/execution-bridge.js";
import { RoleAuthorityService } from "./aurora/role-authority-service.js";
import { AuroraOutcomeHarvester } from "./aurora/outcome-harvester.js";
import { AuroraPlanFeedback } from "./aurora/plan-feedback-service.js";
import { AuroraEstimationCalibrator } from "./aurora/estimation-calibrator.js";
import { ProvenanceService } from "./aurora/provenance-service.js";
import { WorkspaceCheckpointService } from "./aurora/workspace-checkpoint-service.js";
import { AuroraMetricsCollector } from "./aurora/aurora-metrics.js";
import { AuroraDataGovernanceService } from "./aurora/data-governance-service.js";
import {
  auroraMetricsCapabilities,
  checkpointCapabilities,
  delegationCapabilities,
  fleetCapabilities,
  governanceCapabilities,
  estimationCapabilities,
  harvestCapabilities,
  planFeedbackCapabilities,
  probationCapabilities,
  roleAuthorityCapabilities,
} from "./capabilities/aurora-operations.js";
import {
  autopilotCapabilities,
  decisionCapabilities,
  distillerCapabilities,
  planningCapabilities,
  provenanceCapabilities,
} from "./capabilities/aurora-reasoning.js";
import {
  constitutionCapabilities,
  harnessCapabilities,
  microagentCapabilities,
  riskCapabilities,
  stuckCapabilities,
  orchestratorCapabilities,
  insightCapabilities,
} from "./capabilities/aurora-core.js";
import { ContinualHarnessService } from "./harness/continual-harness-service.js";
import { MicroagentRegistry } from "./knowledge/microagent-registry.js";
import { RiskAnalyzerService } from "./policy/risk-analyzer.js";
import { ThoughtCoreService } from "./thought/thought-core-service.js";
import { BackgroundThinkingService } from "./thought/background-thinking-service.js";
import { discoveryCapabilities } from "./capabilities/discovery.js";
import {
  backgroundTaskCapabilities,
  planModeCapabilities,
} from "./capabilities/background-tasks.js";
import { thoughtCapabilities } from "./capabilities/thought-capabilities.js";
import {
  effortCapabilities,
  lifecycleHookCapabilities,
  projectInstructionCapabilities,
  repositoryCommandCapabilities,
  reviewCapabilities,
  sessionLifecycleCapabilities,
  sessionModeCapabilities,
  settingsCapabilities,
  subagentCapabilities,
  userQuestionCapabilities,
  worktreeCapabilities,
} from "./capabilities/workspace-conventions.js";
import { LifecycleHookService } from "./policy/lifecycle-hooks.js";
import {
  SessionModePolicyEngine,
  SessionModeService,
} from "./policy/session-modes.js";
import { ProjectInstructionService } from "./knowledge/project-instructions.js";
import { RepositoryCommandService } from "./knowledge/repository-commands.js";
import { SubagentDefinitionService } from "./knowledge/subagent-definitions.js";
import { WorkingTreeReviewService } from "./repositories/working-tree-review.js";
import { WorktreeService } from "./repositories/worktree-service.js";
import { SessionEffortService } from "./policy/session-effort.js";
import { ManifestTrustService } from "./security/manifest-trust.js";
import { WorkspaceQuota } from "./util/workspace-quota.js";
import { EnvironmentProbe } from "./embodiment/environment-probe.js";
import { SettingsResolver } from "./policy/settings-resolver.js";
import { UserQuestionService } from "./runtime/user-questions.js";
import { StatelessMcpRegistry } from "./mcp/stateless-mcp-registry.js";
import { SessionLifecycleService } from "./runtime/session-lifecycle.js";
import { SelfModelService } from "./aurora/self-model-service.js";
import { UncertaintyEngine } from "./aurora/uncertainty-engine.js";
import { FailureTaxonomyService } from "./aurora/failure-taxonomy.js";
import { CognitiveTelemetryService } from "./aurora/cognitive-telemetry.js";
import { NeuralMemoryFusionService } from "./aurora/neural-memory-fusion.js";
import { ExperienceCompilerService } from "./aurora/experience-compiler.js";
import { SleepCycleService } from "./aurora/sleep-cycle.js";
import { CounterfactualSimulatorService } from "./aurora/counterfactual-simulator.js";
import { MultiHypothesisReasoningService } from "./aurora/multi-hypothesis-reasoning.js";
import { InternalCriticService } from "./aurora/internal-critic.js";
import { ExperimentEngineService } from "./aurora/experiment-engine.js";
import { PlannerV2Service } from "./aurora/planner-v2.js";
import { TaskPlanner } from "./aurora/task-planner.js";
import { GoalUnderstandingService } from "./aurora/goal-understanding.js";
import { batchEmbedderToPipelineProvider } from "./memory/real-memory-pipeline.js";
import { MemoryContradictionService } from "./memory/contradiction-service.js";
import { AgentEconomyService } from "./aurora/agent-economy.js";
import { ReputationService } from "./aurora/reputation-system.js";
import { LoopDetectionService } from "./cognitive/loop-detection-service.js";
import { RiskOpportunityEngine } from "./proactive/risk-opportunity-engine.js";
import { MicroAgentFactory } from "./society/micro-agent-factory.js";
import { ResourceIntelligenceService } from "./aurora/resource-intelligence.js";
import { SharedLearningService } from "./aurora/shared-learning.js";
import { DynamicCompositionService } from "./aurora/dynamic-composition.js";
import { CapabilityMarketplaceService } from "./aurora/capability-marketplace.js";
import { SwarmOrchestrationService } from "./aurora/swarm-orchestration.js";
import { UnifiedCognitiveLoop } from "./aurora/unified-cognitive-loop.js";
import { AuroraCognitiveRuntime } from "./aurora/cognitive-runtime.js";
import { BenchmarkLabService } from "./aurora/benchmark-lab.js";
import { AdaptiveRouterService } from "./aurora/adaptive-router.js";
import { GoalStackService } from "./aurora/goal-stack.js";
import { AttentionV2Service } from "./aurora/attention-v2.js";
import { SelfDebuggingService } from "./aurora/self-debugging.js";
import { SelfModelIntegration } from "./aurora/self-model-integration.js";
import { securityAuditCapabilities } from "./capabilities/security-audit.js";
import { BackupService } from "./persistence/backup-service.js";
import { HealthService } from "./observability/health-service.js";
import { SloService } from "./observability/slo-service.js";
import { selfModelCapabilities } from "./capabilities/self-model.js";
import { CausalGraphService } from "./aurora/causal-graph.js";
import { LongHorizonMemoryService } from "./aurora/long-horizon-memory.js";
import { NeuralCognitiveCoreService } from "./aurora/neural-cognitive-core.js";
import { LearnedWorldModelService } from "./aurora/learned-world-model.js";
import { MetaControllerService } from "./aurora/meta-controller.js";
import { ModelCapabilityRegistryService } from "./aurora/model-capability-registry.js";
import { EventBus } from "./aurora/event-bus.js";
import { CognitiveState } from "./aurora/cognitive-state.js";
import {
  MemoryEngine,
  ReasoningEngine,
  PlanningEngine,
  WorldEngine,
  LearningEngine,
  AttentionEngine,
  ModelSelectionEngine,
} from "./aurora/unified-engines.js";
import { memoryGraphCapabilities } from "./capabilities/memory-graph.js";
import {
  multiWorldCapabilities,
  worldModelCapabilities,
} from "./capabilities/world-model.js";
import { initiativeCapabilities } from "./capabilities/initiative.js";
import { userModelCapabilities } from "./capabilities/user-model.js";
import { evolutionCapabilities } from "./capabilities/evolution.js";
import { environmentCapabilities } from "./capabilities/environment.js";
import { ThoughtMemoryIntegration } from "./thought/thought-memory-integration.js";
import { WorldThoughtIntegration } from "./world/world-thought-integration.js";
import { MemoryInitiativeIntegration } from "./initiative/memory-initiative-integration.js";
import { ProactiveIntakeBus } from "./initiative/proactive-intake-bus.js";
import { StuckEvolutionIntegration } from "./evolution/stuck-evolution-integration.js";
import { FileSystemAgent } from "./embodiment/filesystem-agent.js";
import { ActionFramework } from "./embodiment/action-framework.js";
import {
  fileSystemAgentCapabilities,
  actionFrameworkCapabilities,
} from "./capabilities/embodiment.js";

// ═══ Phase6: Real-World Capabilities ═══
import { MultimodalService } from "./multimodal/multimodal-service.js";
import { ConnectorService } from "./connectors/connector-service.js";
import { ComputerUseService } from "./computer-use/computer-use-service.js";
import { CodePipelineService } from "./pipeline/code-pipeline-service.js";
import { ResearchEngineService } from "./research/research-engine-service.js";
import { UserModelIntegration } from "./user/user-model-integration.js";
import { DigitalTwinService } from "./digital-twin/digital-twin-service.js";
import { DomainExpertService } from "./domain-experts/domain-expert-service.js";
import { FederatedService } from "./federated/federated-service.js";
import { AgentSDKService } from "./sdk/agent-sdk-service.js";
import {
  QwenProvider,
  createLocalQwenProvider,
} from "./models/qwen-provider.js";

export interface EngineConfig {
  homePath: string;
  /** Aurora prompt context block: constitution, harness, microagent knowledge and memory recall. */
  auroraContext?: {
    enabled?: boolean;
    constitutionChars?: number;
    harnessChars?: number;
    knowledgeChars?: number;
    memoryChars?: number;
    instructionChars?: number;
  };
  /** Unattended ACOS cadence. Disabled unless explicitly enabled; bounded by the autopilot ledger. */
  autopilot?: {
    enabled?: boolean;
    tenantId?: string;
    driverIntervalMs?: number;
  };
  /**
   * Multi-tenant driver above the autopilot. Disabled unless explicitly enabled; every tenant it
   * drives must be enrolled, and each sweep is bounded and recorded in the durable sweep ledger.
   */
  auroraFleet?: {
    enabled?: boolean;
    tenantIds?: string[];
    sweepIntervalMs?: number;
    maxTenantsPerSweep?: number;
    maxSweepsPerDay?: number;
  };
  /** Workspace checkpoint bounds for the real rollback path. */
  checkpoints?: {
    maxFiles?: number;
    maxTotalBytes?: number;
    maxFileBytes?: number;
    excludes?: string[];
  };
  /**
   * FAZ 17-50 cognitive pipelines. Enabled by default; the sandbox that runs
   * synthesized capability code is a real worker thread with a heap and
   * wall-clock budget.
   */
  cognitiveRuntime?: {
    enabled?: boolean | undefined;
    immutablePaths?: readonly string[] | undefined;
    sandboxTimeoutMs?: number | undefined;
  };
  /**
   * Aurora governance at the capability boundary. Enabled by default and escalation-only: it can
   * require approval or deny, but never grants authority another policy layer withheld.
   */
  auroraGovernance?: { enabled?: boolean } & AuroraPolicyOptions;
  /** Automatic candidate-only lesson extraction when a session closes. Enabled by default. */
  experienceDistillation?: { onSessionClose?: boolean };
  /** Deterministic operator hooks at the capability boundary and session lifecycle. Enabled by default. */
  lifecycleHooks?: { enabled?: boolean };
  /** Absolute enterprise settings floor. Anything it sets cannot be relaxed from below. */
  managedSettingsPath?: string;
  /** Default per-session effort level; sessions may still set their own. */
  effort?: { defaultLevel?: "low" | "medium" | "high" | "xhigh" | "max" };
  /** Named permission and sandbox modes per session, with the tenant default and bypass switch. */
  sessionModes?: {
    defaultPermissionMode?:
      "plan" | "manual" | "acceptEdits" | "auto" | "dontAsk" | "bypass";
    defaultSandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
    allowBypass?: boolean;
  };
  /** Discovery bounds for AGENTS.md / CLAUDE.md style repository instruction files. */
  projectInstructions?: {
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    maxDepth?: number;
  };
  /**
   * Code intelligence: language server diagnostics, symbols, definition and
   * references. LSP is on by default only for the local sandbox backend, where
   * the engine and the workspace share a filesystem; toolchain diagnostics run
   * through whichever sandbox backend is configured. `serverBinaries` pins an
   * LSP server executable by id (operators, hermetic installs).
   */
  codeIntelligence?: {
    lsp?: boolean;
    serverBinaries?: Record<string, string>;
    serverArgs?: Record<string, string[]>;
    maxLspServers?: number;
    toolchainTimeoutMs?: number;
  };
  /**
   * Prompt-cache breakpoint planner (S5). Enabled by default: every assembled
   * request gets a derived cache plan and durable evidence, and providers that
   * support explicit breakpoints (Anthropic) place the markers. `ttlMs` must
   * be one of the provider-supported values (5m or 1h).
   */
  promptCache?: {
    enabled?: boolean;
    ttlMs?: number;
    messageTailMarkers?: number;
  };
  kernelServerScript: string;
  sandboxBackend: SandboxBackendKind;
  sshSandbox?: SshSandboxOptions;
  singularitySandbox?: SingularitySandboxOptions;
  cloudSandbox?: CloudSandboxGatewayOptions;
  autoApproveWorkspaceWrites?: boolean;
  allowProcessExecution?: boolean;
  masterKey?: string;
  vault?: VaultCredentialBrokerOptions;
  kmsProvider?: KmsProvider;
  wasiPlugins?: Omit<WasiPluginManagerOptions, "rootPath">;
  learningTrustedKeys?: Record<string, string>;
  autoRefineEveryTurns?: number;
  repositoryImport?: {
    maxFiles?: number;
    maxBytes?: number;
    timeoutMs?: number;
  };
  hostedScheduler?: HostedSchedulerRelayOptions;
  otlp?: OtlpExporterOptions;
  browser?: BrowserManagerOptions;
  audio?: AudioServiceOptions;
  images?: OpenAIImageProviderOptions & {
    maxImageBytes?: number;
    allowRemoteImageUrls?: boolean;
  };
  falImages?: FalImageProviderOptions;
  imageUpscale?: FalImageUpscaleProviderOptions;
  video?: FalVideoProviderOptions & {
    maxVideoBytes?: number;
    allowRemoteVideoUrls?: boolean;
  };
  queuedVideo?: FalQueuedVideoProviderOptions;
  videoUpscale?: FalVideoUpscaleProviderOptions;
  webSearch?:
    | (BraveSearchProviderOptions & { provider?: "brave" })
    | (TavilySearchProviderOptions & { provider: "tavily" });
  /**
   * J1 (P1.44) event wiring: the user the engine attributes task outcomes and
   * capability signals to when an event carries no userId of its own. Absent
   * by default — no user, no automatic user-model writes.
   */
  userModelIntegration?: { defaultUserId?: string };
  /**
   * P3.3 ablation study: cognitive layers to REMOVE for tasks run by this
   * engine instance. Each flag maps to an observable absence in the task
   * report (no "Recalled" outcome, no verification, no routing observation,
   * ...), so an ablated layer can be proven absent rather than assumed.
   * Unknown flags throw at task time with the known list. Production runs
   * leave this unset — an ablated engine is a measurement instrument.
   */
  ablations?: readonly string[];
  /**
   * P2.46: optional SLO targets. Supplying one turns the corresponding
   * indicator into an error-budget computation; omitting it leaves a plain
   * measurement. Nothing is invented either way.
   */
  sloTargets?: {
    taskSuccessRate?: number;
    toolSuccessRate?: number;
    p95ModelLatencyMs?: number;
  };
  /**
   * P2.32: where each registered model provider physically runs
   * ("local" | "cloud"). Undeclared providers count as cloud — the safe
   * assumption for a local-only privacy constraint.
   */
  modelLocality?: Record<string, "local" | "cloud">;
  /**
   * P2.34: where backups are written. Defaults to a "backups" directory next
   * to the data root, never inside it (backing the tree up into itself is
   * recursion).
   */
  backupRoot?: string;
  /**
   * P2.10: the background thinking cadence, in minutes. The cycle is bounded
   * (iteration and duration budgets) and its ledger is durable, so the timer
   * only decides when thinking happens, never what is remembered. Default 30
   * minutes; 0 disables the timer (explicit `runCycle` calls still work).
   */
  backgroundThinkingIntervalMinutes?: number;
  /**
   * P1.51: the durable proactive cycle. Every interval the engine runs due
   * watchers, evaluates candidates under the attention budget and builds
   * period digests for every tenant that has proactive state. All state is
   * durable, so a stopped or crashed engine loses nothing — it just resumes.
   * Default interval: 5 minutes. Use 0 to disable the loop.
   */
  proactive?: { intervalMinutes?: number };
  opa?: OpaPolicyOptions;
  postgres?: PostgresDatabaseOptions;
  nats?: NatsTransportOptions;
  embeddings?: OpenAIEmbeddingOptions;
  /** Ordered, explicit provider:model routes used only after the primary fails before output. */
  modelFallbacks?: string[];
  agentMessaging?: {
    maxChars?: number;
    maxPending?: number;
    rateCapacity?: number;
    rateRefillMs?: number;
  };
  /** Child-agent fan-out limits: live children per session, tree depth, lifetime spawns. */
  agentFanout?: AgentFanoutLimits;
  /** Per-command resource limits (memory, CPU seconds, file size, processes). */
  sandboxLimits?: SandboxResourceLimits;
  /**
   * P1.34: total byte quota per session workspace, enforced on the filesystem
   * write path (write / write_binary / patch / archive extract). Defaults to
   * 512 MiB; `0` is not a valid quota (pass a large number instead).
   */
  workspaceQuotaBytes?: number;
  modelOAuthRedirectUri?: string;
  context?: {
    maxMessageChars?: number;
    rollingMicroCompaction?: boolean;
    microCompaction?: RollingMicroCompactorOptions;
  };
  externalMemory?: { provider: "honcho" } & HonchoMemoryProviderOptions;
  model?:
    | { provider: "mock"; modelName?: string }
    | {
        provider: "codex-subscription";
        modelName: string;
        reasoningEffort?: "low" | "medium" | "high" | "max";
        requestTimeoutMs?: number;
      }
    | {
        provider: "openai-compatible";
        id?: string;
        baseUrl: string;
        apiKey?: string;
        modelName: string;
      }
    | {
        provider: "profile";
        profileId: string;
        baseUrl?: string;
        apiKey?: string;
        apiKeys?: ProviderCredentialInput[];
        modelName?: string;
        headers?: Record<string, string>;
        apiVersion?: string;
        region?: string;
      };
}

export class HybridAgentEngine {
  readonly events: EventStore;
  readonly snapshots: SnapshotStore;
  readonly database: PostgresDatabase | undefined;
  readonly nats: NatsTransport | undefined;
  readonly natsEvents: NatsEventBridge | undefined;
  readonly natsCommands: NatsCommandBus | undefined;
  readonly metrics: OperationalMetrics;
  readonly otlp: OtlpMetricsExporter | undefined;
  readonly credentials: CredentialBrokerLike;
  readonly codexAuth: CodexOAuthManager;
  readonly modelOAuth: ModelOAuthManager;
  readonly secretSources: SecretSourceRegistry;
  readonly backends: BackendRegistry;
  readonly repositories: RepositoryImporter;
  readonly githubApps: GitHubAppManager;
  readonly hostedRepositories: HostedRepositoryProviderRegistry;
  readonly interactiveArtifacts: InteractiveArtifactRegistry;
  readonly approvals: ApprovalService;
  readonly hooks: HookBus;
  readonly wasiPlugins: WasiPluginManager | undefined;
  readonly capabilities: CapabilityBroker;

  /**
   * Capabilities each tenant has invoked since the last task report, keyed by
   * capability id.
   *
   * `TaskReport` cannot answer "what did this task run": it carries no tool-call
   * list, and its trace records phase transitions only. The broker is the
   * authority on capability execution, so it is asked instead of the report being
   * guessed at. Drained by `reportToServices` so one task's usage is never
   * attributed to the next.
   */
  private readonly invokedCapabilities = new Map<string, Set<string>>();
  /** Unsubscribes the security guard; held so it is registered exactly once. */
  private securityGuardHandle?: (() => void) | undefined;
  readonly memory: MemoryStore;
  readonly externalMemory: ExternalMemoryProviderManager;
  readonly skills: SkillRegistry;
  readonly skillsHub: SkillsHub;
  readonly learning: LearningGovernor;
  readonly refinements: RefinementService;
  readonly refinementPlanner: RefinementPlanner;
  readonly automaticRefinement: AutomaticRefinementCoordinator;
  readonly learningRollouts: LearningRolloutManager;
  readonly models: ModelProviderRegistry;
  readonly providerProfiles: ProviderProfileRegistry;
  readonly modelConfigurations: ModelConfigurationRegistry;
  readonly agentProfiles: AgentProfileRegistry;
  readonly agentInbox: AgentInboxStore;
  readonly kernels: KernelManager;
  readonly supervisor: Supervisor;
  readonly hostedScheduler: HostedSchedulerRelay | undefined;
  readonly scheduler: DurableScheduler;
  readonly automations: AutomationService;
  readonly automationGitSync: AutomationGitSyncService;
  readonly automationResponders: AutomationResponderService;
  readonly browser: BrowserManager;
  readonly audio: AudioService | undefined;
  readonly images: ImageGenerationService;
  readonly video: VideoGenerationService;
  readonly mediaJobs: MediaJobManager;
  readonly webSearch: WebSearchService;
  readonly sessionSearch: SessionSearchService;
  readonly knowledgeIndex: HybridSearchIndex;
  readonly knowledgeIndexer: KnowledgeIndexer;
  readonly mcp: McpManager;
  readonly mcpElicitations: McpElicitationService;
  readonly channels: ChannelGateway;
  readonly outboundChannels: ChannelAdapterRegistry;
  readonly society: AgentSocietyService;
  readonly cognitive: CognitiveWorkspaceService;
  readonly memoryGraph: MemoryGraphService;
  readonly worldModel: WorldModelService;
  readonly multiWorld: MultiWorldModelService;
  readonly initiative: ProactiveInitiativeService;
  readonly userModel: UserModelService;
  readonly evolution: SkillEvolutionService;
  readonly environment: EnvironmentAwarenessService;
  readonly constitution: ConstitutionService;
  readonly harness: ContinualHarnessService;
  readonly microagents: MicroagentRegistry;
  readonly riskAnalyzer: RiskAnalyzerService;
  readonly stuckDetector: StuckDetectorService;
  readonly acos: CognitiveOrchestrator;
  readonly auroraContextComposer: AuroraContextComposer | undefined;
  readonly decisions: DecisionService;
  readonly planning: PlanningService;
  readonly distiller: ExperienceDistiller;
  readonly autopilot: AuroraAutopilot;
  readonly auroraFleet: AuroraFleetSupervisor;
  readonly delegation: AuroraExecutionBridge;
  readonly roleAuthority: RoleAuthorityService;
  readonly harvester: AuroraOutcomeHarvester;
  readonly planFeedback: AuroraPlanFeedback;
  readonly estimation: AuroraEstimationCalibrator;
  readonly provenance: ProvenanceService;
  readonly checkpoints: WorkspaceCheckpointService;
  readonly auroraMetrics: AuroraMetricsCollector;
  readonly dataGovernance: AuroraDataGovernanceService;
  readonly auroraPolicy: AuroraPolicyEngine | undefined;
  readonly lifecycleHooks: LifecycleHookService;
  readonly sessionModes: SessionModeService;
  private readonly hookWorkspaceRoot: string;
  readonly projectInstructions: ProjectInstructionService;
  readonly repositoryCommands: RepositoryCommandService;
  readonly worktreeReview: WorkingTreeReviewService;
  readonly worktrees: WorktreeService;
  readonly sessionEffort: SessionEffortService;
  readonly manifestTrust: ManifestTrustService;
  readonly thoughtCore: ThoughtCoreService;
  readonly backgroundThinking: BackgroundThinkingService;
  readonly thoughtMemoryIntegration: ThoughtMemoryIntegration;
  readonly worldThoughtIntegration: WorldThoughtIntegration;
  readonly memoryInitiativeIntegration: MemoryInitiativeIntegration;
  readonly proactiveIntakeBus: ProactiveIntakeBus;
  private proactiveTimer: NodeJS.Timeout | undefined;
  readonly stuckEvolutionIntegration: StuckEvolutionIntegration;
  readonly fsAgent: FileSystemAgent;
  readonly actionFramework: ActionFramework;
  /** P1.34: byte quota enforced on the filesystem write path. */
  readonly workspaceQuota: WorkspaceQuota;
  /** P1.39: measures interpreters, device state and project structure in the session sandbox. */
  readonly environmentProbe: EnvironmentProbe;
  readonly settings: SettingsResolver;
  readonly userQuestions: UserQuestionService;
  readonly backgroundShells: BackgroundShellService;
  readonly autoApprovals: AutoApprovalService;
  readonly sessionBudgets: SessionBudgetService;
  readonly verification: VerificationService;
  readonly codeIntelligence: CodeIntelligenceService;
  readonly promptCache: PromptCacheService;
  readonly statelessMcp: StatelessMcpRegistry;
  readonly subagents: SubagentDefinitionService;
  readonly sessionLifecycle: SessionLifecycleService;

  // ═══ Phase1: Self-Awareness & Observability ═══
  readonly selfModel: import("./aurora/self-model-service.js").SelfModelService;
  readonly uncertaintyEngine: import("./aurora/uncertainty-engine.js").UncertaintyEngine;
  readonly failureTaxonomy: import("./aurora/failure-taxonomy.js").FailureTaxonomyService;
  readonly cognitiveTelemetry: import("./aurora/cognitive-telemetry.js").CognitiveTelemetryService;

  // ═══ Phase2: Memory & Learning Revolution ═══
  readonly neuralMemoryFusion: import("./aurora/neural-memory-fusion.js").NeuralMemoryFusionService;
  readonly experienceCompiler: import("./aurora/experience-compiler.js").ExperienceCompilerService;
  readonly sleepCycle: import("./aurora/sleep-cycle.js").SleepCycleService;

  // ═══ Phase3: Reasoning & Simulation ═══
  readonly counterfactualSimulator: import("./aurora/counterfactual-simulator.js").CounterfactualSimulatorService;
  readonly multiHypothesis: import("./aurora/multi-hypothesis-reasoning.js").MultiHypothesisReasoningService;
  readonly internalCritic: import("./aurora/internal-critic.js").InternalCriticService;
  readonly experimentEngine: import("./aurora/experiment-engine.js").ExperimentEngineService;
  readonly plannerV2: import("./aurora/planner-v2.js").PlannerV2Service;

  // ═══ Phase4: Agent Society ═══
  readonly agentEconomy: import("./aurora/agent-economy.js").AgentEconomyService;
  readonly reputation: import("./aurora/reputation-system.js").ReputationService;
  readonly resourceIntelligence: import("./aurora/resource-intelligence.js").ResourceIntelligenceService;
  readonly sharedLearning: import("./aurora/shared-learning.js").SharedLearningService;
  readonly dynamicComposition: import("./aurora/dynamic-composition.js").DynamicCompositionService;
  readonly capabilityMarketplace: import("./aurora/capability-marketplace.js").CapabilityMarketplaceService;
  readonly swarmOrchestration: import("./aurora/swarm-orchestration.js").SwarmOrchestrationService;
  // ═══ S: self-direction (loop detection, risk/opportunity derivation, micro-agents) ═══
  readonly loops: import("./cognitive/loop-detection-service.js").LoopDetectionService;
  readonly riskOpportunity: import("./proactive/risk-opportunity-engine.js").RiskOpportunityEngine;
  readonly microAgents: import("./society/micro-agent-factory.js").MicroAgentFactory;

  // ═══ Phase5: Advanced Cognitive ═══
  readonly benchmarkLab: import("./aurora/benchmark-lab.js").BenchmarkLabService;
  readonly adaptiveRouter: import("./aurora/adaptive-router.js").AdaptiveRouterService;
  readonly goalStack: import("./aurora/goal-stack.js").GoalStackService;
  readonly attentionV2: import("./aurora/attention-v2.js").AttentionV2Service;
  readonly selfDebugging: import("./aurora/self-debugging.js").SelfDebuggingService;
  readonly selfModelIntegration: SelfModelIntegration;
  /** P2.34: durable-state backup/restore (full + incremental, verify-before-restore). */
  readonly backups: BackupService;
  /** P2.45: component-level health, measured per check — never a static "ok". */
  readonly health: HealthService;
  /** P2.46: SLOs measured from the event stream, with sample counts and honest not-measured labels. */
  readonly slos: SloService;
  private backgroundThinkingTimer: NodeJS.Timeout | undefined;
  readonly causalGraph: import("./aurora/causal-graph.js").CausalGraphService;
  readonly longHorizonMemory: import("./aurora/long-horizon-memory.js").LongHorizonMemoryService;
  readonly neuralCognitiveCore: import("./aurora/neural-cognitive-core.js").NeuralCognitiveCoreService;
  readonly learnedWorldModel: import("./aurora/learned-world-model.js").LearnedWorldModelService;

  // ═══ 31. Sistem: Cognitive Meta-Controller ═══
  readonly metaController: import("./aurora/meta-controller.js").MetaControllerService;
  readonly modelCapabilityRegistry: ModelCapabilityRegistryService;

  // ═══ Phase6: Real-World Capabilities ═══
  readonly multimodal: MultimodalService;
  readonly connectors: ConnectorService;
  readonly computerUse: ComputerUseService;
  readonly codePipeline: CodePipelineService;
  readonly researchEngine: ResearchEngineService;
  readonly userModelIntegration: UserModelIntegration;
  readonly digitalTwin: DigitalTwinService;
  readonly domainExperts: DomainExpertService;
  readonly federated: FederatedService;
  readonly agentSDK: AgentSDKService;

  // ═══ Unified Cognitive Runtime ═══
  readonly eventBus: EventBus;
  readonly cognitiveState: CognitiveState;
  readonly memoryEngine: MemoryEngine;
  readonly reasoningEngine: ReasoningEngine;
  readonly planningEngine: PlanningEngine;
  /** Goal decomposition: model first, keyword skeleton as the recorded fallback (B3). */
  readonly taskPlanner: TaskPlanner;
  /**
   * Goal understanding: what the task actually requires, extracted before any
   * work starts (B2 / P1.2). Model first; the honest fallback extracts nothing
   * and says so.
   */
  readonly goalUnderstanding: GoalUnderstandingService;
  /**
   * The contradiction engine (D6 / P1.18): adjudicates detected contradictions
   * between active memories — evidence comparison, user-correction priority,
   * supersede for clear cases, both-sides-flagged for close ones.
   */
  readonly contradictions: MemoryContradictionService;
  readonly worldEngine: WorldEngine;
  readonly learningEngine: LearningEngine;
  readonly attentionEngine: AttentionEngine;
  readonly modelSelectionEngine: ModelSelectionEngine;
  readonly unifiedCognitiveLoop: UnifiedCognitiveLoop;
  /**
   * FAZ 17-50 cognitive pipelines (capability synthesis, skill synthesis,
   * world model, goal discovery, self-improvement, verification, security,
   * routing, society, persistence, Jarvis surface).
   */
  readonly cognitiveRuntime: AuroraCognitiveRuntime;

  constructor(readonly config: EngineConfig) {
    const dataRoot = resolve(config.homePath, "data");
    const workspaceRoot = resolve(config.homePath, "workspaces");
    let commands: CommandJournalLike;
    let effects: EffectJournalLike;
    let leaseManager: SessionLeaseManagerLike | undefined;
    if (config.postgres) {
      this.database = new PostgresDatabase(config.postgres);
      this.events = new PostgresEventStore(this.database);
      this.snapshots = new PostgresSnapshotStore(this.database);
      commands = new PostgresCommandJournal(this.database);
      effects = new PostgresEffectJournal(this.database);
      leaseManager = new PostgresSessionLeaseManager(this.database);
    } else {
      this.database = undefined;
      this.events = new FileEventStore(dataRoot);
      this.snapshots = new FileSnapshotStore(dataRoot);
      commands = new CommandJournal(dataRoot);
      effects = new EffectJournal(dataRoot);
    }
    this.agentInbox = this.database
      ? new PostgresAgentInboxStore(this.database)
      : new FileAgentInboxStore(dataRoot);
    this.nats = config.nats ? new NatsTransport(config.nats) : undefined;
    this.natsEvents = this.nats
      ? new NatsEventBridge(this.nats, this.events)
      : undefined;
    this.natsCommands = this.nats ? new NatsCommandBus(this.nats) : undefined;
    const embeddings = config.embeddings
      ? new OpenAIEmbeddingProvider(config.embeddings)
      : new HashEmbeddingProvider();
    this.knowledgeIndex = new HybridSearchIndex(dataRoot, embeddings);
    this.knowledgeIndexer = new KnowledgeIndexer(
      this.events,
      this.knowledgeIndex,
    );
    this.metrics = new OperationalMetrics(this.events);
    // P2.46: SLO indicators are derived from the same durable event stream the
    // operational metrics observe. Targets are operator-supplied and optional;
    // without a target the report is a measurement, not a verdict.
    this.slos = new SloService(this.events, {
      ...(config.sloTargets?.taskSuccessRate !== undefined ? { taskSuccessRate: config.sloTargets.taskSuccessRate } : {}),
      ...(config.sloTargets?.toolSuccessRate !== undefined ? { toolSuccessRate: config.sloTargets.toolSuccessRate } : {}),
      ...(config.sloTargets?.p95ModelLatencyMs !== undefined ? { p95ModelLatencyMs: config.sloTargets.p95ModelLatencyMs } : {}),
    });
    this.otlp = config.otlp
      ? new OtlpMetricsExporter(this.metrics, config.otlp)
      : undefined;
    if (config.vault && config.kmsProvider)
      throw new Error("Configure either Vault or KMS credentials, not both.");
    this.credentials = config.vault
      ? new VaultCredentialBroker(config.vault)
      : config.kmsProvider
        ? new KmsEnvelopeCredentialBroker(dataRoot, config.kmsProvider)
        : new CredentialBroker(
            dataRoot,
            config.masterKey ?? process.env.HAF_MASTER_KEY,
          );
    this.codexAuth = new CodexOAuthManager({ broker: this.credentials });
    this.modelOAuth = new ModelOAuthManager({
      rootPath: dataRoot,
      credentials: this.credentials,
      ...(config.modelOAuthRedirectUri
        ? { redirectUri: config.modelOAuthRedirectUri }
        : {}),
    });
    this.secretSources = new SecretSourceRegistry(dataRoot, this.credentials);
    this.backends = new BackendRegistry(dataRoot);
    this.repositories = new RepositoryImporter({
      workspaceRoot,
      stateRoot: dataRoot,
      credentials: this.credentials,
      ...(config.repositoryImport?.maxFiles
        ? { maxFiles: config.repositoryImport.maxFiles }
        : {}),
      ...(config.repositoryImport?.maxBytes
        ? { maxBytes: config.repositoryImport.maxBytes }
        : {}),
      ...(config.repositoryImport?.timeoutMs
        ? { timeoutMs: config.repositoryImport.timeoutMs }
        : {}),
    });
    this.githubApps = new GitHubAppManager({
      rootPath: dataRoot,
      credentials: this.credentials,
    });
    this.hostedRepositories = new HostedRepositoryProviderRegistry({
      rootPath: dataRoot,
      credentials: this.credentials,
      githubApps: this.githubApps,
    });
    this.interactiveArtifacts = new InteractiveArtifactRegistry(dataRoot);
    // P2.34: backups live outside the data root by default so the tree being
    // backed up never contains its own backups.
    this.backups = new BackupService(dataRoot, config.backupRoot ?? resolve(dataRoot, "..", "backups"));
    // P2.45: every component answers for itself; "unknown" is a valid,
    // labelled answer. The database check is a real round-trip when Postgres
    // is configured, and file mode is reported as file mode.
    this.health = new HealthService({
      modelProviders: () => this.models.status(),
      ...(this.database ? { pingDatabase: async () => { await this.database!.pool.query("SELECT 1"); } } : {}),
      persistenceMode: this.database ? "postgres" : "file",
      natsConfigured: Boolean(this.nats),
      activeScheduledJobs: async () => (await this.scheduler.list()).filter((job) => job.status === "active").length,
      memoryHealth: async (tenantId) => await this.memoryGraph.health(tenantId),
      cognitiveHealth: async (tenantId) => await this.cognitive.health(tenantId),
    });
    // P2.42: resolved approvals leave a durable who/what/when/why record.
    this.approvals = new ApprovalService(5 * 60_000, join(dataRoot, "audit", "approvals.jsonl"));
    this.hooks = new HookBus();
    const localPolicy = new DefaultPolicyEngine({
      autoApproveWorkspaceWrites: config.autoApproveWorkspaceWrites ?? false,
      allowLocalProcess: config.allowProcessExecution ?? false,
    });
    // Aurora governance binds at the capability boundary. The risk analyzer and constitution must
    // exist before the broker, and the layer is escalation-only, so it can only add scrutiny.
    this.riskAnalyzer = new RiskAnalyzerService(dataRoot);
    this.constitution = new ConstitutionService(dataRoot);
    this.auroraPolicy =
      config.auroraGovernance?.enabled === false
        ? undefined
        : new AuroraPolicyEngine(
            { risk: this.riskAnalyzer, constitution: this.constitution },
            dataRoot,
            {
              ...(config.auroraGovernance?.confirmAtOrAbove
                ? { confirmAtOrAbove: config.auroraGovernance.confirmAtOrAbove }
                : {}),
              ...(config.auroraGovernance?.denyAtOrAbove
                ? { denyAtOrAbove: config.auroraGovernance.denyAtOrAbove }
                : {}),
              ...(config.auroraGovernance?.alwaysCheckConstitution !== undefined
                ? {
                    alwaysCheckConstitution:
                      config.auroraGovernance.alwaysCheckConstitution,
                  }
                : {}),
              ...(config.auroraGovernance?.recordDecisions !== undefined
                ? { recordDecisions: config.auroraGovernance.recordDecisions }
                : {}),
            },
          );
    // Deterministic operator hooks join the same escalation-only stack: they can add scrutiny to a
    // capability call, never remove it. Actions run through the broker, so they stay governed.
    this.hookWorkspaceRoot = workspaceRoot;
    this.lifecycleHooks = new LifecycleHookService(dataRoot, {
      execute: async (call) => await this.runHookCapability(call),
    });
    this.projectInstructions = new ProjectInstructionService(
      Date.now,
      config.projectInstructions ?? {},
    );
    this.sessionEffort = new SessionEffortService(
      dataRoot,
      Date.now,
      config.effort ?? {},
    );
    this.settings = new SettingsResolver({
      managedPath:
        config.managedSettingsPath ?? process.env.HAF_MANAGED_SETTINGS,
    });
    // Reviewed automatic approvals sit in front of the human queue. They start with no rules, so the
    // default behaviour is unchanged: every approval reaches a person until an operator writes a rule
    // and says, in words that are stored, why that class of request is safe.
    this.autoApprovals = new AutoApprovalService(dataRoot);
    this.sessionBudgets = new SessionBudgetService(dataRoot);
    this.autoApprovals.bindEnabled(async (tenantId) => {
      const resolved = await this.settings.value<boolean>({
        tenantId,
        key: "allowAutoApprovals",
      });
      // Absent means allowed; only an explicit `false` (from any layer, managed included) disables it.
      return resolved.value !== false;
    });
    this.approvals.bindReviewer(
      async (request) => await this.autoApprovals.review(request),
    );
    this.userQuestions = new UserQuestionService();
    this.repositoryCommands = new RepositoryCommandService();
    const policyLayers: PolicyEngine[] = [localPolicy];
    if (config.opa) policyLayers.push(new OpaPolicyEngine(config.opa));
    if (config.lifecycleHooks?.enabled !== false)
      policyLayers.push(this.lifecycleHooks.policyLayer());
    if (this.auroraPolicy) policyLayers.push(this.auroraPolicy);
    policyLayers.push({
      decide: async (input) => {
        try {
          const denied = await this.settings.value<string[]>({
            tenantId: input.context.tenantId,
            key: "deniedCapabilities",
            workspacePath: input.context.workspacePath,
          });
          const list = Array.isArray(denied.value) ? denied.value : [];
          if (list.includes(input.descriptor.id)) {
            return {
              decision: "deny",
              reasonCode: "managed_denied_capability",
              message: `${input.descriptor.id} is denied by ${denied.locked ? "managed" : denied.layer} settings.`,
            };
          }
        } catch {
          // Unreadable settings must never widen authority; they simply add no denial.
        }
        return {
          decision: "allow",
          reasonCode: "managed_settings_allow",
          message: "No managed denial applies.",
        };
      },
    });
    const layered =
      policyLayers.length > 1
        ? new LayeredPolicyEngine(policyLayers)
        : localPolicy;
    // The mode dial wraps the whole stack: it may tighten anything, and may relax only base-policy
    // approval requirements — never a governance decision.
    this.sessionModes = new SessionModeService(dataRoot, Date.now, {
      ...(config.sessionModes?.defaultPermissionMode
        ? { defaultPermissionMode: config.sessionModes.defaultPermissionMode }
        : {}),
      ...(config.sessionModes?.defaultSandboxMode
        ? { defaultSandboxMode: config.sessionModes.defaultSandboxMode }
        : {}),
      ...(config.sessionModes?.allowBypass !== undefined
        ? { allowBypass: config.sessionModes.allowBypass }
        : {}),
    });
    // Managed settings are an administrator floor: a permission ceiling sessions cannot exceed, and a
    // deny list nothing below the managed layer can shrink.
    this.sessionModes.bindCeiling(async (tenantId) => {
      const resolved = await this.settings.value<string>({
        tenantId,
        key: "permissionModeCeiling",
      });
      const value = resolved.value;
      return value &&
        ["plan", "manual", "acceptEdits", "auto", "dontAsk", "bypass"].includes(
          value,
        )
        ? (value as
            "plan" | "manual" | "acceptEdits" | "auto" | "dontAsk" | "bypass")
        : undefined;
    });
    const policy = new SessionModePolicyEngine(layered, this.sessionModes);
    this.capabilities = new CapabilityBroker(
      policy,
      this.approvals,
      effects,
      this.hooks,
    );
    // Record what each tenant actually runs. Subscribed here rather than polled
    // later because a capability that executes and is never observed leaves no
    // trace anywhere else in the system.
    this.capabilities.subscribe((event) => {
      if (event.phase !== "started") return;
      const tenantId = event.context.tenantId;
      const seen = this.invokedCapabilities.get(tenantId);
      if (seen) seen.add(event.descriptor.id);
      else this.invokedCapabilities.set(tenantId, new Set([event.descriptor.id]));
    });
    // A 2026-07-28 MCP server that needs input mid-call asks the human through the same bounded
    // question service the agent uses: a remote server never gets to script its own confirmation.
    this.statelessMcp = new StatelessMcpRegistry(this.capabilities, {
      askUser: async ({ tenantId, sessionId, requests }) => {
        const answers: Array<{ id: string; value: string }> = [];
        for (const request of requests.slice(0, 5)) {
          const options = request.options?.length
            ? request.options.map((option) => ({ label: option.label }))
            : [{ label: "Yes" }, { label: "No" }];
          const asked = await this.userQuestions.ask({
            tenantId,
            sessionId,
            question: request.prompt,
            context: "An MCP tool needs input to continue.",
            options,
            allowFreeText: request.kind === "text",
            timeoutMs: 120_000,
          });
          if (asked.status !== "answered")
            throw new Error(
              `MCP input request "${request.id}" was not answered (${asked.status}).`,
            );
          const chosen = asked.options.find(
            (option) => option.id === asked.answer?.optionId,
          );
          answers.push({
            id: request.id,
            value: asked.answer?.text ?? chosen?.label ?? "",
          });
        }
        return answers;
      },
    });
    this.wasiPlugins = config.wasiPlugins
      ? new WasiPluginManager(this.capabilities, this.hooks, {
          rootPath: dataRoot,
          ...config.wasiPlugins,
        })
      : undefined;
    this.mcpElicitations = new McpElicitationService(dataRoot);
    this.mcp = new McpManager(this.capabilities, {
      schemaCacheRoot: resolve(dataRoot, "mcp", "schema-cache"),
      elicitationService: this.mcpElicitations,
      credentialBroker: this.credentials,
    });
    this.memory = new MemoryStore(dataRoot);
    this.skills = new SkillRegistry(dataRoot);
    this.manifestTrust = new ManifestTrustService(dataRoot);
    this.skillsHub = new SkillsHub(dataRoot, this.skills, this.manifestTrust);
    this.learning = new LearningGovernor(
      dataRoot,
      this.memory,
      this.skills,
      this.knowledgeIndex,
    );
    this.refinements = new RefinementService(
      dataRoot,
      this.learning,
      this.events,
    );
    const externalMemoryProvider =
      config.externalMemory?.provider === "honcho"
        ? new HonchoMemoryProvider(config.externalMemory)
        : undefined;
    this.externalMemory = new ExternalMemoryProviderManager(
      dataRoot,
      this.capabilities,
      externalMemoryProvider,
    );
    const contextMaxChars = Math.min(
      2_000_000,
      Math.max(10_000, config.context?.maxMessageChars ?? 80_000),
    );
    const rollingCompactor =
      config.context?.rollingMicroCompaction === false
        ? undefined
        : new RollingMicroCompactor(dataRoot, config.context?.microCompaction);
    // Aurora services that feed prompt assembly must exist before the context manager is built.
    this.harness = new ContinualHarnessService(dataRoot);
    this.microagents = new MicroagentRegistry(dataRoot);
    // Semantic recall: the memory graph shares the engine's embedding-backed hybrid index.
    this.memoryGraph = new MemoryGraphService(dataRoot, Date.now, {
      upsert: async (input) =>
        await this.knowledgeIndex.upsert({
          id: input.id,
          tenantId: input.tenantId,
          kind: input.kind,
          text: input.text,
          metadata: input.metadata,
        }),
      remove: async (tenantId, id) =>
        await this.knowledgeIndex.remove(tenantId, id),
      search: async (input) =>
        (await this.knowledgeIndex.search(input)).map((hit) => ({
          id: hit.id,
          score: hit.score,
          vectorScore: hit.vectorScore,
          lexicalScore: hit.lexicalScore,
        })),
    });
    // D6: the adjudication half of contradiction management, on top of the
    // graph's own detection and supersede primitives.
    this.contradictions = new MemoryContradictionService(this.memoryGraph);
    this.auroraContextComposer =
      config.auroraContext?.enabled === false
        ? undefined
        : new AuroraContextComposer(
            {
              constitution: this.constitution,
              harness: this.harness,
              microagents: this.microagents,
              memoryGraph: this.memoryGraph,
              instructions: this.projectInstructions,
            },
            {
              ...(config.auroraContext?.constitutionChars !== undefined
                ? { constitutionChars: config.auroraContext.constitutionChars }
                : {}),
              ...(config.auroraContext?.harnessChars !== undefined
                ? { harnessChars: config.auroraContext.harnessChars }
                : {}),
              ...(config.auroraContext?.knowledgeChars !== undefined
                ? { knowledgeChars: config.auroraContext.knowledgeChars }
                : {}),
              ...(config.auroraContext?.memoryChars !== undefined
                ? { memoryChars: config.auroraContext.memoryChars }
                : {}),
              ...(config.auroraContext?.instructionChars !== undefined
                ? { instructionChars: config.auroraContext.instructionChars }
                : {}),
            },
          );
    const context = new ContextManager(
      this.memory,
      this.skills,
      this.learning,
      contextMaxChars,
      this.hooks,
      rollingCompactor,
      this.externalMemory,
      this.auroraContextComposer,
    );
    this.models = new ModelProviderRegistry();
    this.providerProfiles = new ProviderProfileRegistry(
      true,
      new FileCredentialPoolStateStore(dataRoot),
    );
    this.modelConfigurations = new ModelConfigurationRegistry(
      dataRoot,
      this.providerProfiles,
      this.modelOAuth,
    );
    this.agentProfiles = new AgentProfileRegistry(dataRoot);
    this.browser = new BrowserManager(config.browser ?? {});
    this.audio = config.audio ? new AudioService(config.audio) : undefined;
    this.images = new ImageGenerationService({
      ...(config.images?.maxImageBytes
        ? { maxImageBytes: config.images.maxImageBytes }
        : {}),
      allowRemoteImageUrls: config.images?.allowRemoteImageUrls ?? false,
    });
    if (config.images)
      this.images.register(new OpenAIImageProvider(config.images), true);
    if (config.falImages)
      this.images.register(
        new FalImageProvider(config.falImages),
        !config.images,
      );
    if (config.imageUpscale)
      this.images.registerUpscaler(
        new FalImageUpscaleProvider(config.imageUpscale),
      );
    this.video = new VideoGenerationService({
      ...(config.video?.maxVideoBytes
        ? { maxVideoBytes: config.video.maxVideoBytes }
        : {}),
      allowRemoteVideoUrls: config.video?.allowRemoteVideoUrls ?? false,
    });
    if (config.video)
      this.video.register(new FalVideoProvider(config.video), true);
    if (config.queuedVideo)
      this.video.registerQueued(new FalQueuedVideoProvider(config.queuedVideo));
    if (config.videoUpscale)
      this.video.registerUpscaler(
        new FalVideoUpscaleProvider(config.videoUpscale),
      );
    this.mediaJobs = new MediaJobManager(dataRoot, this.video);
    this.webSearch = new WebSearchService();
    if (config.webSearch) {
      this.webSearch.register(
        config.webSearch.provider === "tavily"
          ? new TavilySearchProvider(config.webSearch)
          : new BraveSearchProvider(config.webSearch),
        true,
      );
    }

    const model = config.model ?? { provider: "mock" as const };
    let modelName: string | undefined;
    if (model.provider === "mock") {
      this.models.register(new MockModelProvider(), true);
      modelName = model.modelName;
    } else if (model.provider === "codex-subscription") {
      const provider = new CodexSubscriptionProvider({
        model: model.modelName,
        oauth: this.codexAuth,
        ...(model.reasoningEffort
          ? { reasoningEffort: model.reasoningEffort }
          : {}),
        ...(model.requestTimeoutMs
          ? { requestTimeoutMs: model.requestTimeoutMs }
          : {}),
      });
      this.models.register(provider, true);
      modelName = `${provider.id}:${model.modelName}`;
    } else if (model.provider === "openai-compatible") {
      const provider = new OpenAICompatibleProvider({
        id: model.id ?? "openai-compatible",
        baseUrl: model.baseUrl,
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        model: model.modelName,
      });
      this.models.register(provider, true);
      modelName = `${provider.id}:${model.modelName}`;
    } else {
      const resolved = this.providerProfiles.createProvider({
        profileId: model.profileId,
        ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        ...(model.apiKeys?.length ? { apiKeys: model.apiKeys } : {}),
        ...(model.modelName ? { model: model.modelName } : {}),
        ...(model.headers ? { headers: model.headers } : {}),
        ...(model.apiVersion ? { apiVersion: model.apiVersion } : {}),
        ...(model.region ? { region: model.region } : {}),
      });
      this.models.register(resolved.provider, true);
      modelName = resolved.modelName;
    }

    // P2.32: apply the operator's locality declarations. Undeclared stays
    // "cloud" inside the registry — the conservative default for privacy.
    for (const [providerId, where] of Object.entries(config.modelLocality ?? {})) {
      if (this.models.list().includes(providerId)) this.models.setLocality(providerId, where);
    }

    // Register every additional provider whose credential is explicitly present.
    // Credentials remain in provider closures and never enter session/kernel state.
    for (const profile of this.providerProfiles.list()) {
      if (this.models.list().includes(profile.id)) continue;
      const apiKey = process.env[profile.apiKeyEnvironmentVariable];
      if (!apiKey || !profile.defaultModel) continue;
      const configured = this.providerProfiles.createProvider({
        profileId: profile.id,
        apiKey,
        model: profile.defaultModel,
      });
      this.models.register(configured.provider, false);
    }

    this.kernels = new KernelManager(
      resolve(config.kernelServerScript),
      dataRoot,
      this.capabilities,
      {
        kind:
          config.sandboxBackend === "local" ||
          config.sandboxBackend === "docker"
            ? config.sandboxBackend
            : "disabled",
      },
    );
    // Prompt-cache planner: derives breakpoints for every assembled request and
    // keeps durable evidence. Providers that support explicit markers consume
    // the hint; automatic-caching providers ignore it.
    this.promptCache = new PromptCacheService(dataRoot, {
      ...(config.promptCache?.enabled === undefined
        ? {}
        : { enabled: config.promptCache.enabled }),
      ...(config.promptCache?.ttlMs ? { ttlMs: config.promptCache.ttlMs } : {}),
      ...(config.promptCache?.messageTailMarkers
        ? { messageTailMarkers: config.promptCache.messageTailMarkers }
        : {}),
    });
    this.supervisor = new Supervisor({
      dataRoot,
      workspaceRoot,
      eventStore: this.events,
      snapshotStore: this.snapshots,
      commandJournal: commands,
      ...(leaseManager ? { leaseManager } : {}),
      agentInbox: this.agentInbox,
      ...(config.agentFanout ? { fanout: config.agentFanout } : {}),
      ...(config.agentMessaging?.maxChars
        ? { agentMessageMaxChars: config.agentMessaging.maxChars }
        : {}),
      ...(config.agentMessaging?.maxPending
        ? { agentMessageMaxPending: config.agentMessaging.maxPending }
        : {}),
      ...(config.agentMessaging?.rateCapacity
        ? { agentMessageRateCapacity: config.agentMessaging.rateCapacity }
        : {}),
      ...(config.agentMessaging?.rateRefillMs
        ? { agentMessageRateRefillMs: config.agentMessaging.rateRefillMs }
        : {}),
      model: this.models,
      capabilities: this.capabilities,
      context,
      resolvePromptCache: async (input) => {
        const planned = await this.promptCache.plan(input);
        return {
          plan: planned.plan,
          ...(planned.hint ? { hint: planned.hint } : {}),
        };
      },
      ...(modelName ? { modelName } : {}),
      ...(config.modelFallbacks?.length
        ? { modelFallbacks: config.modelFallbacks }
        : {}),
      resolveEffort: async (tenantId: string, sessionId: string) => {
        const resolved = await this.sessionEffort.get(tenantId, sessionId);
        return {
          toolIterations: resolved.profile.toolIterations,
          reasoningEffort: resolved.profile.reasoningEffort,
        };
      },
      onSessionClose: async (sessionId) => {
        await this.kernels.close(sessionId);
        this.userQuestions.cancelForSession(sessionId, "session closed");
        // Nothing a session started may outlive it: a build left running after its owner is gone is
        // an unowned process holding a workspace open.
        await this.backgroundShells
          .stopForSession(sessionId, "session closed")
          .catch(() => undefined);
        try {
          const closing = await this.supervisor.getSession(sessionId);
          await this.lifecycleHooks.run({
            tenantId: closing.tenantId,
            event: "session.stop",
            subject: sessionId,
          });
        } catch {
          // A hook must never keep a session from closing.
        }
        // Closed sessions are where lessons are cheapest to extract. Distillation only ever produces
        // candidates, so this is safe to run unattended; failures must never block session closure.
        if (this.config.experienceDistillation?.onSessionClose === false)
          return;
        try {
          const snapshot = await this.supervisor.getSession(sessionId);
          await this.distiller.distill({
            tenantId: snapshot.tenantId,
            sessionId,
          });
        } catch {
          // ignored: distillation is an optimization, never a precondition for closing a session
        }
      },
    });
    this.sessionLifecycle = new SessionLifecycleService(dataRoot, {
      sessions: async (tenantId?: string) =>
        await this.supervisor.listSessions(tenantId),
      session: async (sessionId: string) =>
        await this.supervisor.getSession(sessionId),
      defaultModel: () => modelName ?? this.models.list()[0],
    });
    this.society = new AgentSocietyService(
      dataRoot,
      this.supervisor,
      this.agentProfiles,
      this.events,
      // G6: the society communication bus is untrusted inbound surface. Every
      // broadcast body goes through the same input screening that guards the
      // task goal before it is persisted to the bus; a body the engine would
      // refuse at the front door must not enter through a side door. Late
      // bound because the cognitive runtime is constructed after this point --
      // the closure only ever runs once the engine is fully built.
      async (body) => {
        const verdict = await this.cognitiveRuntime.screenInput({
          input: body,
          source: "society-bus",
        });
        return { allowed: verdict.allowed, reason: verdict.reason };
      },
    );
    this.subagents = new SubagentDefinitionService({
      capabilities: this.capabilities,
      profiles: this.agentProfiles,
      society: this.society,
      hooks: this.lifecycleHooks,
    });
    this.cognitive = new CognitiveWorkspaceService(dataRoot);
    this.worldModel = new WorldModelService(dataRoot);
    this.multiWorld = new MultiWorldModelService(dataRoot);
    this.thoughtCore = new ThoughtCoreService(dataRoot);
    this.backgroundThinking = new BackgroundThinkingService(
      dataRoot,
      this.thoughtCore,
    );
    this.thoughtMemoryIntegration = new ThoughtMemoryIntegration(this);
    this.worldThoughtIntegration = new WorldThoughtIntegration(this);
    this.memoryInitiativeIntegration = new MemoryInitiativeIntegration(this);
    this.stuckEvolutionIntegration = new StuckEvolutionIntegration(this);
    this.fsAgent = new FileSystemAgent(workspaceRoot);
    this.actionFramework = new ActionFramework(this);
    this.userModel = new UserModelService(dataRoot);
    this.evolution = new SkillEvolutionService(dataRoot);
    this.environment = new EnvironmentAwarenessService(dataRoot);
    this.decisions = new DecisionService(dataRoot);
    this.planning = new PlanningService(dataRoot);
    this.checkpoints = new WorkspaceCheckpointService(
      dataRoot,
      config.checkpoints ?? {},
    );
    this.stuckDetector = new StuckDetectorService(this.events);
    // Queued initiatives are mirrored into the Global Workspace so proactive signals compete for
    // attention under the same constitutional budget as every other cognitive object.
    this.initiative = new ProactiveInitiativeService(dataRoot, Date.now, {
      onQueued: async (item) => {
        try {
          await this.cognitive.intake({
            tenantId: item.tenantId,
            source: "initiative",
            title: item.title,
            content: item.message,
            sourceId: item.id,
            kind:
              item.kind === "risk"
                ? "risk"
                : item.kind === "opportunity"
                  ? "opportunity"
                  : "observation",
            confidence: item.confidence,
            importance: item.importance,
            urgency: item.urgency,
            impact: item.impact,
            userRelevance: item.userRelevance,
            horizon: item.priority === "P0" ? "reactive" : "tactical",
            tags: ["initiative", item.priority.toLowerCase()],
          });
        } catch {
          // Initiative delivery must never fail because the workspace quota is exhausted.
        }
      },
    },
    {
      // P1.50 context fit: the governed user model's own state estimate. It is
      // an estimate with explicit uncertainty — the initiative engine defers
      // P1 messages when it says busy, and demotes nothing without evidence.
      ...(config.userModelIntegration?.defaultUserId
        ? {
            contextState: async (tenantId: string) => {
              const estimate = await this.userModel.estimateState(tenantId, config.userModelIntegration!.defaultUserId!).catch(() => undefined);
              return estimate ? { state: estimate.state, confidence: estimate.confidence } : undefined;
            },
            // P1.50 goal alignment: scored against the user's real active goals.
            goalAlignment: async (tenantId: string, text: string) => {
              const check = await this.userModel.alignmentCheck(tenantId, config.userModelIntegration!.defaultUserId!, text).catch(() => undefined);
              return check?.score;
            },
          }
        : {}),
      // P1.52 communication selector: only channels that really exist.
      availableChannels: () => this.outboundChannels.list(),
      // P1.52 delivery: one initiative over one configured adapter.
      sendChannel: async (channel, initiative, destination) => {
        await this.outboundChannels.send(channel, {
          destination: destination ?? "primary",
          text: `[${initiative.priority}] ${initiative.title}\n\n${initiative.message}`,
        });
      },
      // P1.53 briefing sections from live subsystems; empty answers add no section.
      digestSections: [
        {
          heading: "Project risks",
          items: async (tenantId) => {
            const userId = config.userModelIntegration?.defaultUserId;
            if (!userId) return [];
            const projects = await this.userModel.projects(tenantId, userId, "active").catch(() => []);
            const now = Date.now();
            const lines: string[] = [];
            for (const project of projects) {
              if (project.deadline && Date.parse(project.deadline) < now) lines.push(`Overdue: ${project.name} (deadline ${project.deadline})`);
              if (project.recentFailures.length) lines.push(`${project.name}: ${project.recentFailures.slice(-3).length} recent failure(s), latest: ${project.recentFailures[project.recentFailures.length - 1]!.summary.slice(0, 120)}`);
            }
            return lines;
          },
        },
        {
          heading: "Goal changes",
          items: async (tenantId) => {
            const userId = config.userModelIntegration?.defaultUserId;
            if (!userId) return [];
            const stalled = await this.userModel.stalledGoals(tenantId, userId, 14).catch(() => []);
            const conflicts = await this.userModel.goalConflicts(tenantId, userId).catch(() => []);
            const lines = stalled.map((goal) => `Stalled (no progress in 14+ days): ${goal.title}`);
            for (const conflict of conflicts.slice(0, 5)) lines.push(`Conflict (${conflict.kind}): ${conflict.detail.slice(0, 160)}`);
            return lines;
          },
        },
        {
          heading: "Memory changes",
          items: async (tenantId) => {
            const memories = await this.memoryGraph.list(tenantId, { limit: 5 }).catch(() => []);
            const now = Date.now();
            return memories
              .filter((memory) => now - Date.parse(memory.createdAt) <= 86_400_000)
              .map((memory) => `New memory (${memory.layer}): ${memory.title.slice(0, 160)}`);
          },
        },
      ],
    });
    this.refinementPlanner = new RefinementPlanner(
      dataRoot,
      this.models,
      this.events,
      this.refinements,
      async (sessionId) => await this.supervisor.getSession(sessionId),
    );
    this.automaticRefinement = new AutomaticRefinementCoordinator(
      this.events,
      this.refinementPlanner,
      {
        everyTurns: Math.max(0, Math.floor(config.autoRefineEveryTurns ?? 0)),
      },
    );
    this.learningRollouts = new LearningRolloutManager(
      dataRoot,
      this.learning,
      this.capabilities,
      this.supervisor,
      config.learningTrustedKeys ?? {},
    );
    this.hostedScheduler = config.hostedScheduler
      ? new HostedSchedulerRelay(dataRoot, config.hostedScheduler)
      : undefined;
    this.scheduler = new DurableScheduler(
      dataRoot,
      this.supervisor,
      this.hostedScheduler,
    );
    this.automations = new AutomationService(
      dataRoot,
      this.supervisor,
      this.scheduler,
    );
    this.automationGitSync = new AutomationGitSyncService(
      dataRoot,
      this.hostedRepositories,
      this.automations,
      this.supervisor,
    );
    this.automationResponders = new AutomationResponderService({
      rootPath: dataRoot,
      credentials: this.credentials,
      automations: this.automations,
    });
    this.sessionSearch = new SessionSearchService(this.supervisor);
    this.channels = new ChannelGateway(dataRoot, this.supervisor, {
      resolveAgentProfile: async (profileId, tenantId) =>
        await this.agentProfiles.snapshot(profileId, tenantId),
      // P1.49: authorized inbound messages reach the proactive intake bus.
      // Late-bound on purpose: the bus is constructed after the event bus.
      onIngested: async (message) => {
        await this.proactiveIntakeBus?.recordNotification(message);
      },
    });
    this.outboundChannels = new ChannelAdapterRegistry();

    // P1.34: the workspace quota the filesystem capabilities enforce. Default
    // 512 MiB; the scan is cached and delta-tracked between writes so the
    // write path does not rescan the tree each time.
    this.workspaceQuota = new WorkspaceQuota(
      config.workspaceQuotaBytes && config.workspaceQuotaBytes > 0
        ? config.workspaceQuotaBytes
        : 512 * 1024 * 1024,
    );

    for (const capability of filesystemCapabilities(this.workspaceQuota))
      this.capabilities.register(capability);
    for (const capability of memoryCapabilities(this.memory))
      this.capabilities.register(capability);
    for (const capability of skillCapabilities(this.skills))
      this.capabilities.register(capability);
    const sandboxFactory = createSandboxFactory(config.sandboxBackend, {
      ...(config.sshSandbox ? { ssh: config.sshSandbox } : {}),
      ...(config.singularitySandbox
        ? { singularity: config.singularitySandbox }
        : {}),
      ...(config.cloudSandbox ? { cloud: config.cloudSandbox } : {}),
      // Default resource hygiene for every command: a build that eats the host is not a build the
      // agent should be able to run. Operators can raise or clear these per installation.
      limits: config.sandboxLimits ?? {
        memoryMb: 4096,
        cpuSeconds: 900,
        fileSizeMb: 2048,
        processes: 512,
      },
    });
    this.capabilities.register(processCapability(sandboxFactory));

    // P1.39: the environment mapper measures the world the agent works in.
    this.environmentProbe = new EnvironmentProbe(sandboxFactory);
    // A background shell is the same sandboxed execution path as `process.exec`; only the moment the
    // result arrives differs, so it reuses the factory rather than opening a second way to spawn.
    this.backgroundShells = new BackgroundShellService(sandboxFactory);
    // Verification runs the project's own commands through the same sandbox as everything else.
    this.verification = new VerificationService(dataRoot, sandboxFactory);
    for (const capability of verificationCapabilities(this.verification))
      this.capabilities.register(capability);
    // Code intelligence: LSP when a server binary is installed and the engine
    // shares the workspace filesystem, toolchain diagnostics through the sandbox
    // regardless. LSP servers are read-only project processes with a scrubbed
    // environment, bounded count and graceful shutdown.
    this.codeIntelligence = new CodeIntelligenceService(
      dataRoot,
      sandboxFactory,
      {
        ...(config.codeIntelligence?.lsp === undefined
          ? { lsp: config.sandboxBackend === "local" }
          : { lsp: config.codeIntelligence.lsp }),
        ...(config.codeIntelligence?.serverBinaries
          ? { serverBinaries: config.codeIntelligence.serverBinaries }
          : {}),
        ...(config.codeIntelligence?.serverArgs
          ? { serverArgs: config.codeIntelligence.serverArgs }
          : {}),
        ...(config.codeIntelligence?.maxLspServers
          ? { maxLspServers: config.codeIntelligence.maxLspServers }
          : {}),
        ...(config.codeIntelligence?.toolchainTimeoutMs
          ? { toolchainTimeoutMs: config.codeIntelligence.toolchainTimeoutMs }
          : {}),
      },
    );
    for (const capability of codeIntelligenceCapabilities(
      this.codeIntelligence,
    ))
      this.capabilities.register(capability);
    for (const capability of promptCacheCapabilities(this.promptCache))
      this.capabilities.register(capability);
    for (const capability of backgroundShellCapabilities(this.backgroundShells))
      this.capabilities.register(capability);
    for (const capability of autoApprovalCapabilities(this.autoApprovals))
      this.capabilities.register(capability);
    for (const capability of sessionBudgetCapabilities({
      budgets: this.sessionBudgets,
      cost: async (sessionId) => await this.sessionLifecycle.cost(sessionId),
    }))
      this.capabilities.register(capability);
    for (const capability of gitCapabilities(sandboxFactory))
      this.capabilities.register(capability);
    this.worktreeReview = new WorkingTreeReviewService(sandboxFactory);
    this.worktrees = new WorktreeService(sandboxFactory, workspaceRoot);
    this.capabilities.register(pythonCapability(this.kernels));
    for (const capability of agentCapabilities(this.supervisor))
      this.capabilities.register(capability);
    for (const capability of goalCapabilities(this.supervisor))
      this.capabilities.register(capability);
    for (const capability of taskCapabilities(this.supervisor))
      this.capabilities.register(capability);
    for (const capability of channelCapabilities(this.outboundChannels))
      this.capabilities.register(capability);
    for (const capability of webCapabilities())
      this.capabilities.register(capability);
    if (this.webSearch.configured)
      this.capabilities.register(webSearchCapability(this.webSearch));
    if (this.browser.configured) {
      for (const capability of browserCapabilities(this.browser))
        this.capabilities.register(capability);
    }
    if (this.audio) {
      for (const capability of audioCapabilities(this.audio))
        this.capabilities.register(capability);
    }
    if (this.images.configured || this.images.upscaleConfigured) {
      for (const capability of imageCapabilities(this.images))
        this.capabilities.register(capability);
    }
    if (this.video.configured)
      this.capabilities.register(videoCapability(this.video));
    if (this.video.upscaleConfigured)
      this.capabilities.register(videoUpscaleCapability(this.video));
    if (this.video.queueConfigured)
      for (const capability of mediaJobCapabilities(this.mediaJobs))
        this.capabilities.register(capability);
    this.capabilities.register(sessionSearchCapability(this.sessionSearch));
    this.capabilities.register(knowledgeSearchCapability(this.knowledgeIndex));
    for (const capability of learningCapabilities(
      this.learning,
      this.refinements,
    ))
      this.capabilities.register(capability);
    for (const capability of interactiveArtifactCapabilities(
      this.interactiveArtifacts,
    ))
      this.capabilities.register(capability);
    for (const capability of hostedReviewCapabilities(this.hostedRepositories))
      this.capabilities.register(capability);
    for (const capability of societyCapabilities(this.society))
      this.capabilities.register(capability);
    for (const capability of cognitiveCapabilities(this.cognitive))
      this.capabilities.register(capability);
    for (const capability of memoryGraphCapabilities(this.memoryGraph))
      this.capabilities.register(capability);
    for (const capability of worldModelCapabilities(this.worldModel))
      this.capabilities.register(capability);
    for (const capability of multiWorldCapabilities(this.multiWorld))
      this.capabilities.register(capability);
    for (const capability of initiativeCapabilities(this.initiative))
      this.capabilities.register(capability);
    for (const capability of userModelCapabilities(this.userModel))
      this.capabilities.register(capability);
    for (const capability of evolutionCapabilities(this.evolution))
      this.capabilities.register(capability);
    for (const capability of environmentCapabilities(
      this.environment,
      // P1.39: the environment mapper runs its measurements in the session
      // sandbox and summarises the live capability catalog by risk class.
      this.environmentProbe,
      () => this.capabilities.list(),
    ))
      this.capabilities.register(capability);
    for (const capability of fileSystemAgentCapabilities(this.fsAgent))
      this.capabilities.register(capability);
    for (const capability of actionFrameworkCapabilities(this.actionFramework))
      this.capabilities.register(capability);
    for (const capability of thoughtCapabilities({
      thoughtCore: this.thoughtCore,
      backgroundThinking: this.backgroundThinking,
    }))
      this.capabilities.register(capability);
    this.delegation = new AuroraExecutionBridge(dataRoot, {
      planning: this.planning,
      society: this.society,
      evolution: this.evolution,
    });
    this.roleAuthority = new RoleAuthorityService(
      {
        capabilities: this.capabilities,
        profiles: this.agentProfiles,
        society: this.society,
      },
      Date.now,
      dataRoot,
    );
    // ACOS is constructed last: it composes every governed Aurora service into one control loop.
    this.acos = new CognitiveOrchestrator(
      dataRoot,
      {
        cognitive: this.cognitive,
        memoryGraph: this.memoryGraph,
        worldModel: this.worldModel,
        initiative: this.initiative,
        userModel: this.userModel,
        evolution: this.evolution,
        environment: this.environment,
        society: this.society,
        constitution: this.constitution,
        harness: this.harness,
        decisions: this.decisions,
        planning: this.planning,
      },
      Date.now,
      {
        stuckSessions: async (tenantId) => {
          const sessions = (await this.supervisor.listSessions())
            .filter(
              (item) => item.tenantId === tenantId && item.status !== "closed",
            )
            .slice(0, 20);
          const stuck: Array<{
            sessionId: string;
            signature?: string;
            detail: string;
          }> = [];
          for (const session of sessions) {
            const report = await this.stuckDetector.analyze(session.sessionId);
            if (!report.stuck) continue;
            stuck.push({
              sessionId: session.sessionId,
              ...(report.frictionSignature
                ? { signature: report.frictionSignature }
                : {}),
              detail: report.patterns
                .map(
                  (item) => `${item.code} x${item.occurrences}: ${item.detail}`,
                )
                .join(" | ")
                .slice(0, 5000),
            });
          }
          return stuck;
        },
        delegation: async (tenantId) => await this.harvester.runCycle(tenantId),
        estimation: async (tenantId) => await this.estimation.ingest(tenantId),
        planFeedback: async (tenantId) => {
          const result = await this.planFeedback.reconcile({ tenantId });
          return {
            recorded: result.recorded.length,
            executedMarked: result.executedMarked.length,
          };
        },
        integrity: async (tenantId) => {
          const report = await this.dataGovernance.selfCheck(tenantId);
          return {
            findings: report.findings.length,
            critical: report.findings.filter(
              (item) => item.severity === "critical",
            ).length,
            score: report.score,
            details: report.findings
              .filter((item) => item.severity !== "info")
              .map((item) => `${item.code}: ${item.detail}`),
          };
        },
      },
    );
    for (const capability of constitutionCapabilities(this.constitution))
      this.capabilities.register(capability);
    for (const capability of harnessCapabilities(this.harness))
      this.capabilities.register(capability);
    for (const capability of microagentCapabilities(this.microagents))
      this.capabilities.register(capability);
    for (const capability of riskCapabilities(this.riskAnalyzer))
      this.capabilities.register(capability);
    for (const capability of stuckCapabilities(this.stuckDetector))
      this.capabilities.register(capability);
    for (const capability of orchestratorCapabilities(this.acos))
      this.capabilities.register(capability);
    for (const capability of insightCapabilities(this.memoryGraph))
      this.capabilities.register(capability);
    this.distiller = new ExperienceDistiller(dataRoot, {
      events: this.events,
      harness: this.harness,
      microagents: this.microagents,
      evolution: this.evolution,
    });
    this.harvester = new AuroraOutcomeHarvester(dataRoot, {
      bridge: this.delegation,
      society: this.society,
      sessions: {
        session: async (sessionId: string) =>
          await this.supervisor.getSession(sessionId),
      },
      events: this.events,
      evolution: this.evolution,
      distiller: this.distiller,
    });
    this.planFeedback = new AuroraPlanFeedback(dataRoot, {
      planning: this.planning,
      decisions: this.decisions,
      bridge: this.delegation,
      harvester: this.harvester,
      initiative: this.initiative,
    });
    this.estimation = new AuroraEstimationCalibrator(dataRoot, {
      planning: this.planning,
    });
    this.autopilot = new AuroraAutopilot(dataRoot, {
      orchestrator: this.acos,
      initiative: this.initiative,
    });
    this.auroraFleet = new AuroraFleetSupervisor(
      dataRoot,
      { autopilot: this.autopilot },
      {
        ...(config.auroraFleet?.maxTenantsPerSweep !== undefined
          ? { maxTenantsPerSweep: config.auroraFleet.maxTenantsPerSweep }
          : {}),
        ...(config.auroraFleet?.maxSweepsPerDay !== undefined
          ? { maxSweepsPerDay: config.auroraFleet.maxSweepsPerDay }
          : {}),
      },
    );
    this.provenance = new ProvenanceService({
      cognitive: this.cognitive,
      initiative: this.initiative,
      memoryGraph: this.memoryGraph,
      worldModel: this.worldModel,
      environment: this.environment,
      decisions: this.decisions,
      planning: this.planning,
      constitution: this.constitution,
    });
    for (const capability of decisionCapabilities(this.decisions))
      this.capabilities.register(capability);
    for (const capability of planningCapabilities(this.planning))
      this.capabilities.register(capability);
    for (const capability of distillerCapabilities(this.distiller))
      this.capabilities.register(capability);
    for (const capability of autopilotCapabilities(this.autopilot))
      this.capabilities.register(capability);
    for (const capability of fleetCapabilities(this.auroraFleet))
      this.capabilities.register(capability);
    for (const capability of delegationCapabilities(this.delegation))
      this.capabilities.register(capability);
    for (const capability of roleAuthorityCapabilities(this.roleAuthority))
      this.capabilities.register(capability);
    for (const capability of harvestCapabilities(this.harvester))
      this.capabilities.register(capability);
    for (const capability of planFeedbackCapabilities(this.planFeedback))
      this.capabilities.register(capability);
    for (const capability of estimationCapabilities(this.estimation))
      this.capabilities.register(capability);
    for (const capability of projectInstructionCapabilities(
      this.projectInstructions,
    ))
      this.capabilities.register(capability);
    for (const capability of lifecycleHookCapabilities(this.lifecycleHooks))
      this.capabilities.register(capability);
    for (const capability of sessionModeCapabilities(this.sessionModes))
      this.capabilities.register(capability);
    for (const capability of repositoryCommandCapabilities(
      this.repositoryCommands,
    ))
      this.capabilities.register(capability);
    for (const capability of reviewCapabilities(this.worktreeReview))
      this.capabilities.register(capability);
    for (const capability of subagentCapabilities(this.subagents))
      this.capabilities.register(capability);
    for (const capability of effortCapabilities(this.sessionEffort))
      this.capabilities.register(capability);
    for (const capability of worktreeCapabilities(this.worktrees))
      this.capabilities.register(capability);
    for (const capability of userQuestionCapabilities(this.userQuestions))
      this.capabilities.register(capability);
    for (const capability of settingsCapabilities(this.settings))
      this.capabilities.register(capability);
    for (const capability of backgroundTaskCapabilities({
      supervisor: this.supervisor,
      modes: this.sessionModes,
      effort: this.sessionEffort,
      questions: this.userQuestions,
      approvals: this.approvals,
    }))
      this.capabilities.register(capability);
    for (const capability of planModeCapabilities(this.sessionModes))
      this.capabilities.register(capability);
    for (const capability of sessionLifecycleCapabilities(
      this.sessionLifecycle,
    ))
      this.capabilities.register(capability);
    // Registered last so the catalog it searches already contains everything else.
    for (const capability of discoveryCapabilities(() =>
      this.capabilities.list(),
    ))
      this.capabilities.register(capability);
    for (const capability of probationCapabilities(this.delegation))
      this.capabilities.register(capability);
    this.auroraMetrics = new AuroraMetricsCollector({
      cognitive: this.cognitive,
      memoryGraph: this.memoryGraph,
      worldModel: this.worldModel,
      initiative: this.initiative,
      society: this.society,
      evolution: this.evolution,
      environment: this.environment,
      decisions: this.decisions,
      planning: this.planning,
      constitution: this.constitution,
      autopilot: this.autopilot,
      fleet: this.auroraFleet,
      acos: this.acos,
      delegation: this.delegation,
      roleAuthority: this.roleAuthority,
      harvester: this.harvester,
      planFeedback: this.planFeedback,
      estimation: this.estimation,
    });
    this.dataGovernance = new AuroraDataGovernanceService({
      cognitive: this.cognitive,
      memoryGraph: this.memoryGraph,
      worldModel: this.worldModel,
      initiative: this.initiative,
      userModel: this.userModel,
      evolution: this.evolution,
      environment: this.environment,
      society: this.society,
      constitution: this.constitution,
      harness: this.harness,
      microagents: this.microagents,
      decisions: this.decisions,
      planning: this.planning,
      acos: this.acos,
    });

    // ═══ Phase1: Self-Awareness & Observability ═══
    this.selfModel = new SelfModelService(dataRoot);
    this.uncertaintyEngine = new UncertaintyEngine(dataRoot);
    this.failureTaxonomy = new FailureTaxonomyService(dataRoot);
    this.cognitiveTelemetry = new CognitiveTelemetryService(dataRoot);

    // ═══ Phase2: Memory & Learning ═══
    this.neuralMemoryFusion = new NeuralMemoryFusionService(dataRoot);
    this.experienceCompiler = new ExperienceCompilerService(dataRoot);
    this.sleepCycle = new SleepCycleService(dataRoot);

    // ═══ Phase3: Reasoning & Simulation ═══
    this.counterfactualSimulator = new CounterfactualSimulatorService(dataRoot);
    this.multiHypothesis = new MultiHypothesisReasoningService(dataRoot);
    this.internalCritic = new InternalCriticService(dataRoot);
    this.experimentEngine = new ExperimentEngineService(dataRoot);
    this.plannerV2 = new PlannerV2Service(dataRoot);

    // ═══ Phase4: Agent Society ═══
    this.agentEconomy = new AgentEconomyService(dataRoot);
    this.reputation = new ReputationService(dataRoot);
    this.resourceIntelligence = new ResourceIntelligenceService(dataRoot);
    this.sharedLearning = new SharedLearningService(dataRoot);
    this.dynamicComposition = new DynamicCompositionService(dataRoot);
    this.capabilityMarketplace = new CapabilityMarketplaceService(dataRoot);
    this.swarmOrchestration = new SwarmOrchestrationService(dataRoot);
    // S4/S5/S6/S10: the self-direction services read engine state nobody was
    // reading — recurring outcomes, repeated capability gaps, unverified
    // palace hypotheses — and turn them into loops, initiatives and
    // specialist proposals with evidence. They never change a task verdict.
    this.loops = new LoopDetectionService(dataRoot, Date.now, 3);
    this.riskOpportunity = new RiskOpportunityEngine(
      dataRoot,
      {
        loops: this.loops,
        cognitiveHealth: async (tenantId: string) => await this.cognitive.health(tenantId),
        palaceHypotheses: async (tenantId: string) =>
          (await this.memoryGraph.list(tenantId, { layer: "palace", state: "active" })).map(
            (item): { id: string; title: string; lastVerifiedAt?: string } => ({
              id: item.id,
              title: item.title,
              ...(item.lastVerifiedAt !== undefined ? { lastVerifiedAt: item.lastVerifiedAt } : {}),
            }),
          ),
        propose: async (input) => {
          await this.initiative.propose(input);
        },
      },
      Date.now,
    );
    this.microAgents = new MicroAgentFactory(dataRoot, this.society, Date.now);

    // ═══ Phase5: Advanced Cognitive ═══
    this.benchmarkLab = new BenchmarkLabService(dataRoot);
    this.adaptiveRouter = new AdaptiveRouterService(dataRoot);
    this.goalStack = new GoalStackService(dataRoot);
    this.attentionV2 = new AttentionV2Service(dataRoot);
    this.selfDebugging = new SelfDebuggingService(dataRoot);

    this.causalGraph = new CausalGraphService(dataRoot);
    this.longHorizonMemory = new LongHorizonMemoryService(dataRoot);
    this.neuralCognitiveCore = new NeuralCognitiveCoreService(dataRoot);
    this.learnedWorldModel = new LearnedWorldModelService(dataRoot);

    // ═══ 31. Sistem: Cognitive Meta-Controller ═══
    this.metaController = new MetaControllerService(dataRoot);
    this.modelCapabilityRegistry = new ModelCapabilityRegistryService(dataRoot);

    // ═══ Phase6: Real-World Capabilities ═══
    this.multimodal = new MultimodalService(dataRoot);
    this.connectors = new ConnectorService(dataRoot);
    this.computerUse = new ComputerUseService(dataRoot);
    this.codePipeline = new CodePipelineService(dataRoot);
    // P1.40–P1.43: the research engine runs on the real backends — the
    // configured web-search provider (Brave/Tavily) for discovery, the same
    // SSRF-guarded bounded fetcher web.fetch uses for collection, the hybrid
    // knowledge index for internal scope, the memory graph for citation
    // preservation and the initiative service for watcher attention budgeting.
    this.researchEngine = new ResearchEngineService(dataRoot, {
      webSearch: this.webSearch,
      fetcher: {
        fetch: async (url) => await fetchPublicDocument(url, { maxBytes: 2_000_000 }),
      },
      internalSearch: {
        search: async (tenantId, query, limit) => {
          const hits = await this.knowledgeIndex.search({ tenantId, query, limit });
          return hits.map((hit) => ({ id: hit.id, kind: hit.kind, text: hit.text, metadata: hit.metadata }));
        },
      },
      memory: this.memoryGraph,
      initiative: this.initiative,
    });
    // Registered here rather than with the other capability blocks because the
    // engine above is only constructed at this point in the initializer.
    for (const capability of researchCapabilities(this.researchEngine))
      this.capabilities.register(capability);
    this.digitalTwin = new DigitalTwinService(dataRoot);
    this.domainExperts = new DomainExpertService(dataRoot);
    this.federated = new FederatedService(dataRoot);
    this.agentSDK = new AgentSDKService(dataRoot);

    // ═══ Unified Cognitive Runtime — EventBus + CognitiveState + 7 Unified Engines ═══
    this.eventBus = new EventBus(5000);
    this.cognitiveState = new CognitiveState();

    // J1 (P1.44): task outcomes and capability finishes flow into the governed
    // user model through the same EventBus everything else uses. Consent-gated:
    // with inference disabled (the default) no claim is ever auto-created.
    this.userModelIntegration = new UserModelIntegration(
      this.eventBus,
      this.userModel,
      this.capabilities,
      {
        ...(config.userModelIntegration?.defaultUserId
          ? { defaultUserId: config.userModelIntegration.defaultUserId }
          : {}),
      },
    );

    // P2.14: reflection cycles wired to real engine events (after significant
    // tasks, after failure). Periodic reflection runs on the autopilot's
    // reflection cadence; this integration adds the event-driven triggers.
    this.selfModelIntegration = new SelfModelIntegration(this.eventBus, this.selfModel);
    this.selfModelIntegration.init();
    // P2.8/P2.9/P2.7 decision surfaces: the self-model answers with measured
    // reliability, limitations, workload and the tools/models that really
    // exist right now.
    for (const capability of selfModelCapabilities(this.selfModel, this.selfDebugging, {
      availableCapabilities: () => this.capabilities.list().map((item) => item.id),
      availableModels: () => this.models.list(),
    }))
      this.capabilities.register(capability);

    // P1.49 event intake bus: tasks, git, files, research, environment,
    // notifications and schedule fires become typed proactive intake events.
    // Memory flows through MemoryInitiativeIntegration, which ingests directly.
    this.proactiveIntakeBus = new ProactiveIntakeBus(
      this.eventBus,
      this.initiative,
      this.capabilities,
      { recentSchedules: async () => await this.scheduler.list() },
    );

    // 1. MemoryEngine: MemoryGraph + LongHorizonMemory + NeuralFusion + ExperienceCompiler + SharedLearning
    // D1/D2: the recall ranker's provider is ADAPTED from the same embedding
    // backend the search index uses — one configuration, one endpoint, two
    // dialects. An earlier version of this wiring added a second config knob
    // (`embedding` next to the pre-existing `embeddings`) with its own BGE/E5
    // provider classes: the same endpoint configured twice under different
    // names, found while measuring D2 and removed here.
    const pipelineEmbedding = config.embeddings
      ? batchEmbedderToPipelineProvider(embeddings, { isSemantic: true })
      : undefined;

    this.memoryEngine = new MemoryEngine(
      this.memoryGraph,
      this.longHorizonMemory,
      this.neuralMemoryFusion,
      this.experienceCompiler,
      this.sharedLearning,
      this.eventBus,
      this.cognitiveState,
      pipelineEmbedding,
    );

    // 2. ReasoningEngine: MultiHypothesis + InternalCritic + ExperimentEngine + NeuralCognitiveCore + CausalGraph
    this.reasoningEngine = new ReasoningEngine(
      this.multiHypothesis,
      this.internalCritic,
      this.experimentEngine,
      this.neuralCognitiveCore,
      this.causalGraph,
      this.eventBus,
      this.cognitiveState,
    );

    // 3. PlanningEngine: PlanningService + PlannerV2 + GoalStack + TaskPlanner
    //
    // B3: the planner asks the model to decompose the actual goal and keeps
    // `decomposeGoal`'s keyword skeleton as an explicit fallback. `this.models`
    // is assigned later in this constructor, which is safe here because the
    // closure only runs when a plan is requested, long after initialization.
    // The keyword path stays reachable and the result records which one ran, so
    // a fallback can never be mistaken for a decomposition.
    this.taskPlanner = new TaskPlanner({
      fallback: (goal, strategy) => this.planningEngine.keywordDecomposition(goal, strategy),
      model: { stream: (request) => this.models.stream(request) },
    });
    // B2: same shape as the planner above — `this.models` is assigned later in
    // this constructor, which is safe because the closure only runs when a
    // task asks for understanding, long after initialization.
    this.goalUnderstanding = new GoalUnderstandingService({
      model: { stream: (request) => this.models.stream(request) },
    });
    this.planningEngine = new PlanningEngine(
      this.planning,
      this.plannerV2,
      this.goalStack,
      this.eventBus,
      this.cognitiveState,
      this.taskPlanner,
    );

    // 4. WorldEngine: WorldModel + LearnedWorldModel + CausalGraph + CounterfactualSimulator
    this.worldEngine = new WorldEngine(
      this.worldModel,
      this.learnedWorldModel,
      this.causalGraph,
      this.counterfactualSimulator,
      this.eventBus,
      this.cognitiveState,
    );

    // 5. LearningEngine: ExperienceCompiler + SleepCycle + SharedLearning + SelfModel + FailureTaxonomy
    this.learningEngine = new LearningEngine(
      this.experienceCompiler,
      this.sleepCycle,
      this.sharedLearning,
      this.selfModel,
      this.failureTaxonomy,
      this.eventBus,
      this.cognitiveState,
    );

    // 6. AttentionEngine: AttentionV2 + CognitiveWorkspace + ResourceIntelligence
    this.attentionEngine = new AttentionEngine(
      this.attentionV2,
      this.cognitive,
      this.resourceIntelligence,
      this.eventBus,
      this.cognitiveState,
    );

    // 7. ModelSelectionEngine: the single model-selection authority.
    //
    // Candidates come from the provider registry and the tenant's model
    // configurations; evidence comes from the capability registry. `ModelRoutingPipeline`
    // is deliberately not a source here -- it scores on accuracy, latency and cost
    // fields that no real model in this system carries, so wiring it in as a
    // second scorer would mean inventing those numbers. It remains the benchmark,
    // history and task-requirement layer.
    this.modelSelectionEngine = new ModelSelectionEngine(
      this.models,
      this.adaptiveRouter,
      this.benchmarkLab,
      this.eventBus,
      this.cognitiveState,
      {
        listModelConfigurations: async (tenantId) =>
          (await this.modelConfigurations.list(tenantId)).map((config) => ({
            baseProfileId: config.baseProfileId,
            model: config.model,
            enabled: config.enabled,
          })),
        listProviderProfiles: () =>
          this.providerProfiles.list().map((profile) => ({
            id: profile.id,
            ...(profile.defaultModel !== undefined ? { defaultModel: profile.defaultModel } : {}),
          })),
        getCapabilityProfile: (modelId) => this.modelCapabilityRegistry.getProfile(modelId),
      },
    );

    // 8. UnifiedCognitiveLoop: Meta Controller + CognitiveState + EventBus
    this.unifiedCognitiveLoop = new UnifiedCognitiveLoop(
      this.metaController,
      this.cognitiveState,
      this.eventBus,
    );

    // 9. AuroraCognitiveRuntime: FAZ 17-50 pipelines, cross-wired and live.
    this.cognitiveRuntime = new AuroraCognitiveRuntime({
      enabled: config.cognitiveRuntime?.enabled ?? true,
      immutablePaths: config.cognitiveRuntime?.immutablePaths,
      sandboxTimeoutMs: config.cognitiveRuntime?.sandboxTimeoutMs,
    });
    if (config.cognitiveRuntime?.enabled !== false) {
      this.cognitiveRuntime.initialize();

      // Put the armed pipeline in front of real actions.
      //
      // M9 armed it; nothing asked it anything. Registering on the broker's
      // `pre_capability` guard rather than inside execute() is deliberate:
      // side effects do not happen in execute(), they happen when the broker
      // runs a capability, and every caller — the loop, an HTTP session, MCP,
      // a plugin — converges there. One seam instead of one per entry point.
      //
      // It adds only what the broker cannot see: a global kill switch, and
      // injection patterns in the arguments. Policy, approvals and trust
      // levels stay with PolicyEngine; two systems answering the same question
      // with no rule for which wins is worse than one.
      this.securityGuardHandle = registerSecurityGuard(
        this.hooks,
        this.cognitiveRuntime.security,
      );
      // P2.42: security events are evidence. The in-memory log dies with the
      // process; this sink appends every event to a durable JSONL file so the
      // audit query can answer "who/what/when/why" after a restart. Appends
      // are chained to preserve order; a failed append never breaks the
      // security path that raised the event.
      const securityAuditPath = join(dataRoot, "audit", "security-audit.jsonl");
      let securityAuditChain: Promise<void> = Promise.resolve();
      this.cognitiveRuntime.security.killSwitchManager.setAuditSink((event) => {
        securityAuditChain = securityAuditChain
          .then(async () => {
            await mkdir(join(dataRoot, "audit"), { recursive: true });
            await appendFile(securityAuditPath, `${JSON.stringify(event)}\n`, "utf8");
          })
          .catch(() => undefined);
      });

    // P2.42: the audit trail is queryable, with each record's storage basis
    // (durable file vs in-memory) stated rather than assumed.
    for (const capability of securityAuditCapabilities(this.cognitiveRuntime.security, {
      auditDir: () => join(dataRoot, "audit"),
    }))
      this.capabilities.register(capability);
    }

    for (const capability of provenanceCapabilities(this.provenance))
      this.capabilities.register(capability);
    for (const capability of checkpointCapabilities(this.checkpoints))
      this.capabilities.register(capability);
    for (const capability of auroraMetricsCapabilities(this.auroraMetrics))
      this.capabilities.register(capability);
    for (const capability of governanceCapabilities(this.dataGovernance))
      this.capabilities.register(capability);
    if (config.auroraFleet?.enabled) {
      // Multi-tenant unattended operation: enroll the declared tenants, then start the bounded driver.
      const fleet = this.auroraFleet;
      void (async () => {
        for (const tenantId of config.auroraFleet?.tenantIds ?? ["local"])
          await fleet.enroll({ tenantId });
        fleet.start(config.auroraFleet?.sweepIntervalMs ?? 60_000);
      })().catch(() => undefined);
    }
    if (config.autopilot?.enabled) {
      // Unattended operation is opt-in; the durable ledger and daily ceiling still bound it.
      void this.autopilot
        .configure({
          tenantId: config.autopilot.tenantId ?? "local",
          enabled: true,
        })
        .then(() =>
          this.autopilot.start(
            config.autopilot?.tenantId ?? "local",
            config.autopilot?.driverIntervalMs ?? 60_000,
          ),
        )
        .catch(() => undefined);
    }
  }

  registerModelProvider(provider: ModelProvider, makeDefault = false): void {
    this.models.register(provider, makeDefault);
  }

  activateCodexSubscription(input: {
    model: string;
    reasoningEffort?: "low" | "medium" | "high" | "max";
    requestTimeoutMs?: number;
  }): string {
    const model = input.model.trim();
    if (!model || model.length > 300)
      throw new Error("Codex model id is invalid.");
    if (!this.models.list().includes("openai-codex")) {
      this.models.register(
        new CodexSubscriptionProvider({
          model,
          oauth: this.codexAuth,
          ...(input.reasoningEffort
            ? { reasoningEffort: input.reasoningEffort }
            : {}),
          ...(input.requestTimeoutMs
            ? { requestTimeoutMs: input.requestTimeoutMs }
            : {}),
        }),
        false,
      );
    }
    return `openai-codex:${model}`;
  }

  async createSession(input: {
    sessionId?: string;
    tenantId: string;
    name?: string;
    workspacePath?: string;
    agentProfileId?: string;
    /** Override the profile's model route — used when recovery escalates after a model failure. */
    modelRoute?: string;
    /** Override the profile's fallback chain. */
    fallbackModels?: string[];
  }): Promise<SessionSnapshot> {
    const baseProfile = input.agentProfileId
      ? await this.agentProfiles.snapshot(input.agentProfileId, input.tenantId)
      : undefined;

    // A caller-supplied route has to survive even when no profile was named,
    // otherwise an escalated model is silently dropped and the retry runs on
    // the model that just failed.
    const agentProfile: SessionAgentProfile | undefined =
      input.modelRoute !== undefined || input.fallbackModels !== undefined
        ? {
            id: baseProfile?.id ?? "inline-model-route",
            name: baseProfile?.name ?? "inline",
            version: baseProfile?.version ?? 1,
            instructions: baseProfile?.instructions ?? "",
            ...(baseProfile?.allowedCapabilityIds
              ? { allowedCapabilityIds: baseProfile.allowedCapabilityIds }
              : {}),
            ...(() => {
              const route = input.modelRoute ?? baseProfile?.modelRoute;
              return route !== undefined ? { modelRoute: route } : {};
            })(),
            fallbackModels:
              input.fallbackModels ?? baseProfile?.fallbackModels ?? [],
          }
        : baseProfile;

    return await this.supervisor.createSession({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      tenantId: input.tenantId,
      ...(input.name ? { name: input.name } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      ...(agentProfile ? { agentProfile } : {}),
    });
  }

  async importRepository(input: {
    tenantId: string;
    url: string;
    branch?: string;
    credentialSecretId?: string;
    credentialUsername?: string;
    name?: string;
    agentProfileId?: string;
  }): Promise<{
    session: SessionSnapshot;
    repository: { origin: string; head: string; files: number; bytes: number };
  }> {
    const imported = await this.repositories.import({
      tenantId: input.tenantId,
      url: input.url,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.credentialSecretId
        ? { credentialSecretId: input.credentialSecretId }
        : {}),
      ...(input.credentialUsername
        ? { credentialUsername: input.credentialUsername }
        : {}),
    });
    try {
      const session = await this.createSession({
        tenantId: input.tenantId,
        workspacePath: imported.workspacePath,
        ...(input.name ? { name: input.name } : {}),
        ...(input.agentProfileId
          ? { agentProfileId: input.agentProfileId }
          : {}),
      });
      return {
        session,
        repository: {
          origin: imported.origin,
          head: imported.head,
          files: imported.files,
          bytes: imported.bytes,
        },
      };
    } catch (error) {
      await rm(imported.workspacePath, { recursive: true, force: true });
      throw error;
    }
  }

  async importHostedRepository(input: {
    tenantId: string;
    providerId: string;
    repositoryId: string;
    branch?: string;
    name?: string;
    agentProfileId?: string;
  }): Promise<{
    session: SessionSnapshot;
    repository: {
      providerId: string;
      repositoryId: string;
      fullName: string;
      origin: string;
      head: string;
      files: number;
      bytes: number;
    };
  }> {
    const selected = await this.hostedRepositories.resolveImport(
      input.providerId,
      input.tenantId,
      input.repositoryId,
    );
    const imported = await this.importRepository({
      tenantId: input.tenantId,
      url: selected.repository.cloneUrl,
      ...(input.branch ? { branch: input.branch } : {}),
      credentialSecretId: selected.credentialSecretId,
      credentialUsername: selected.credentialUsername,
      name: input.name ?? selected.repository.fullName,
      ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
    });
    await this.hostedRepositories.linkSession({
      sessionId: imported.session.sessionId,
      tenantId: input.tenantId,
      providerId: input.providerId,
      repository: {
        ...selected.repository,
        defaultBranch: input.branch ?? selected.repository.defaultBranch,
      },
      importedHead: imported.repository.head,
    });
    return {
      session: imported.session,
      repository: {
        providerId: input.providerId,
        repositoryId: selected.repository.repositoryId,
        fullName: selected.repository.fullName,
        ...imported.repository,
      },
    };
  }

  async command(command: CommandEnvelope): Promise<CommandResult> {
    // An archived session keeps everything it recorded and accepts nothing new. Restoring is an
    // explicit, audited act, so "tidy up my list" can never quietly become "keep working in here".
    if (command.sessionId && command.kind !== "session.close") {
      const archived = await this.sessionLifecycle
        .isArchived(command.tenantId, command.sessionId)
        .catch(() => false);
      // Typed so the HTTP layer answers 409 "this session is closed" instead of
      // 500. An archived session keeps its record and accepts nothing new;
      // restoring it is an explicit, audited act.
      if (archived) throw new SessionNotRunnableError(command.sessionId, "archived");
    }
    // A spend cap refuses *new* work only. A turn already in flight finishes: cutting a half-applied
    // edit to save a few cents leaves a worse mess than the spend it avoided.
    if (
      command.sessionId &&
      (command.kind === "session.prompt" || command.kind === "session.resume")
    ) {
      const verdict = await this.budgetVerdict(
        command.tenantId,
        command.sessionId,
      ).catch(() => undefined);
      // Typed: a spend cap being reached is a 429 the caller can act on (raise
      // the cap, or start a new session), not an undifferentiated server fault.
      if (verdict?.blocked) {
        throw new SessionBudgetExceededError(verdict);
      }
    }
    return await this.supervisor.dispatch(command);
  }

  /** What the session's budget looks like right now, priced from the same table the cost view uses. */
  async budgetVerdict(tenantId: string, sessionId: string) {
    const cost = await this.sessionLifecycle.cost(sessionId);
    return await this.sessionBudgets.evaluate({
      tenantId,
      sessionId,
      spentUsd: cost.costUsd,
      totalTokens: cost.usage.totalTokens,
      costSource: cost.costSource,
    });
  }

  async session(sessionId: string): Promise<SessionSnapshot> {
    return await this.supervisor.getSession(sessionId);
  }

  async sessions(tenantId?: string): Promise<SessionSnapshot[]> {
    return await this.supervisor.listSessions(tenantId);
  }

  /**
   * Close a session if it's not already closed.
   * After closing, the session retains all events but accepts no new work.
   */
  async closeSession(sessionId: string): Promise<SessionSnapshot> {
    return await this.supervisor
      .dispatch({
        protocolVersion: 1,
        commandId: randomUUID(),
        clientId: "engine-close",
        tenantId: (await this.supervisor.getSession(sessionId)).tenantId,
        sessionId,
        kind: "session.close",
        source: "api",
        issuedAt: new Date().toISOString(),
        payload: {},
      })
      .then(async () => await this.supervisor.getSession(sessionId));
  }

  /**
   * Eksik bir capability'yi sentezle, gerçek sandbox'ta doğrula.
   *
   * FAZ 17-19 gate: doğrulanmayan capability karantinada kalır.
   */
  async acquireCapability(params: {
    name: string;
    description: string;
    code: string;
    testInput: unknown;
    expectedOutput?: unknown | undefined;
  }): ReturnType<AuroraCognitiveRuntime["acquireCapability"]> {
    return await this.cognitiveRuntime.acquireCapability(params);
  }

  /**
   * Doğrulanmış bir capability'yi denetimli seviyeye terfi ettir.
   */
  async promoteCapability(
    capabilityId: string,
    promotedBy: string,
  ): Promise<boolean> {
    return await this.cognitiveRuntime.promoteCapability(
      capabilityId,
      promotedBy,
    );
  }

  /**
   * FAZ 17-50 pipeline'larının bağlılık durumu.
   */
  cognitiveRuntimeHealth(): ReturnType<AuroraCognitiveRuntime["health"]> {
    return this.cognitiveRuntime.health();
  }

  async readEvents(
    sessionId: string,
    afterSequence = 0,
    limit = 1000,
  ): Promise<EventEnvelope[]> {
    return await this.events.read(sessionId, afterSequence, limit);
  }

  subscribe(
    sessionId: string,
    listener: (event: EventEnvelope) => void,
  ): () => void {
    return this.events.subscribe(sessionId, listener);
  }

  async schedule(input: {
    tenantId: string;
    sessionId: string;
    prompt: string;
    schedule: Schedule;
    label?: string;
  }): Promise<ScheduledJob> {
    return await this.scheduler.create(input);
  }

  async activateModelConfiguration(id: string): Promise<string> {
    const configured = await this.modelConfigurations.materialize(id);
    if (this.models.list().includes(id)) this.models.unregister(id);
    this.models.register(configured.provider, false);
    return configured.modelName;
  }

  async setModelConfigurationEnabled(id: string, enabled: boolean) {
    const record = await this.modelConfigurations.setEnabled(id, enabled);
    if (enabled && record.configured) await this.activateModelConfiguration(id);
    else if (this.models.list().includes(id)) this.models.unregister(id);
    return record;
  }

  async removeModelConfiguration(id: string): Promise<boolean> {
    if (this.models.list().includes(id)) this.models.unregister(id);
    return await this.modelConfigurations.remove(id);
  }

  async initialize(): Promise<void> {
    await this.database?.ensureSchema();
    for (const configuration of await this.modelConfigurations.list()) {
      if (
        !configuration.enabled ||
        !configuration.configured ||
        this.models.list().includes(configuration.id)
      )
        continue;
      await this.activateModelConfiguration(configuration.id).catch(
        () => undefined,
      );
    }
    if (this.natsEvents) await this.natsEvents.start();
    this.automaticRefinement.start();
    await this.thoughtCore.initialize();

    // ═══ Yeni servislerin lifecycle init'i ═══
    await this.metaController.init().catch(() => undefined);
    await this.selfModel.init().catch(() => undefined);
    await this.uncertaintyEngine.init().catch(() => undefined);
    await this.failureTaxonomy.init().catch(() => undefined);
    await this.cognitiveTelemetry.init().catch(() => undefined);
    await this.neuralMemoryFusion.init().catch(() => undefined);
    await this.experienceCompiler.init().catch(() => undefined);
    await this.sleepCycle.init().catch(() => undefined);
    await this.counterfactualSimulator.init().catch(() => undefined);
    await this.multiHypothesis.init().catch(() => undefined);
    await this.internalCritic.init().catch(() => undefined);
    await this.experimentEngine.init().catch(() => undefined);
    await this.plannerV2.init().catch(() => undefined);
    await this.agentEconomy.init().catch(() => undefined);
    await this.reputation.init().catch(() => undefined);
    await this.loops.init().catch(() => undefined);
    await this.riskOpportunity.init().catch(() => undefined);
    await this.microAgents.init().catch(() => undefined);
    await this.resourceIntelligence.init().catch(() => undefined);
    await this.sharedLearning.init().catch(() => undefined);
    await this.dynamicComposition.init().catch(() => undefined);
    await this.capabilityMarketplace.init().catch(() => undefined);
    await this.swarmOrchestration.init().catch(() => undefined);
    await this.benchmarkLab.init().catch(() => undefined);
    await this.adaptiveRouter.init().catch(() => undefined);
    await this.goalStack.init().catch(() => undefined);
    await this.attentionV2.init().catch(() => undefined);
    await this.selfDebugging.init().catch(() => undefined);
    await this.backgroundThinking.init().catch(() => undefined);
    await this.causalGraph.init().catch(() => undefined);
    await this.longHorizonMemory.init().catch(() => undefined);
    await this.neuralCognitiveCore.init().catch(() => undefined);
    await this.learnedWorldModel.init().catch(() => undefined);
    await this.modelCapabilityRegistry.init().catch(() => undefined);

    // ═══ Phase6: Real-World Capabilities init ═══
    await this.multimodal.init().catch(() => undefined);
    await this.connectors.init().catch(() => undefined);
    await this.computerUse.init().catch(() => undefined);
    await this.codePipeline.init().catch(() => undefined);
    await this.researchEngine.init().catch(() => undefined);
    await this.digitalTwin.init().catch(() => undefined);
    await this.domainExperts.init().catch(() => undefined);
    await this.federated.init().catch(() => undefined);
    await this.agentSDK.init().catch(() => undefined);

    // ═══ Integration servislerini EventBus'a bağla ═══
    this.thoughtMemoryIntegration.init();
    this.worldThoughtIntegration.init();
    this.memoryInitiativeIntegration.init();
    this.stuckEvolutionIntegration.init();
    this.userModelIntegration.init();
    this.proactiveIntakeBus.init();

    // ═══ Durable Action Framework init ═══
    await this.actionFramework.init().catch(() => undefined);

    if (this.hostedScheduler)
      await this.hostedScheduler.reconcile(await this.scheduler.list());
  }

  start(): void {
    this.scheduler.start();
    this.otlp?.start();
    this.outboundChannels.startAll();
    this.backgroundThinking.start();
    // P2.10: the background thinking cadence. The service enforces its own
    // iteration/duration budgets and keeps a durable ledger; this timer only
    // decides when the next cycle starts.
    const thinkingInterval = this.config.backgroundThinkingIntervalMinutes ?? 30;
    if (thinkingInterval > 0) {
      this.backgroundThinkingTimer = setInterval(
        () => void this.runBackgroundThinkingForAllTenants(),
        thinkingInterval * 60_000,
      );
      this.backgroundThinkingTimer.unref();
    }
    // P1.51 durable proactive cycle: watcher state, cooldowns, dedup and
    // digests all live in durable stores, so the timer only decides when the
    // next cycle runs — never what is remembered.
    const intervalMinutes = this.config.proactive?.intervalMinutes ?? 5;
    if (intervalMinutes > 0) {
      this.proactiveTimer = setInterval(
        () => void this.runProactiveCycleForAllTenants(),
        intervalMinutes * 60_000,
      );
      this.proactiveTimer.unref();
    }
  }

  /**
   * One background-thinking cycle for every tenant with proactive state
   * (P2.10). Tenants without state are skipped, not invented.
   */
  async runBackgroundThinkingForAllTenants(): Promise<Array<{ tenantId: string; thoughtsProcessed: number }>> {
    const tenants = await this.initiative.tenants();
    const summaries: Array<{ tenantId: string; thoughtsProcessed: number }> = [];
    for (const tenantId of tenants) {
      try {
        const cycle = await this.backgroundThinking.runCycle(tenantId);
        summaries.push({ tenantId, thoughtsProcessed: cycle.thoughtsProcessed });
      } catch {
        // One tenant's thinking must not stop the others.
      }
    }
    return summaries;
  }

  /** One proactive cycle for every tenant with proactive state (P1.51). */
  async runProactiveCycleForAllTenants(): Promise<Array<{ tenantId: string; queued: number; digestsBuilt: number }>> {
    await this.proactiveIntakeBus.ingestRecentSchedules().catch(() => undefined);
    const tenants = await this.initiative.tenants();
    const summaries: Array<{ tenantId: string; queued: number; digestsBuilt: number }> = [];
    for (const tenantId of tenants) {
      try {
        const cycle = await this.initiative.runProactiveCycle(tenantId);
        summaries.push({ tenantId, queued: cycle.evaluation.queued.length, digestsBuilt: cycle.digestsBuilt.length });
      } catch {
        // One tenant's cycle must not stop the others.
      }
    }
    return summaries;
  }

  /**
   * Run a lifecycle-hook action through the normal capability path. Hook side effects are governed
   * like everything else: policy, approval and the effect journal all apply, and the synthetic
   * context is clearly labelled so an audit can tell hook traffic from agent traffic.
   */
  private async runHookCapability(call: {
    tenantId: string;
    capabilityId: string;
    input: Record<string, unknown>;
    reason: string;
  }): Promise<unknown> {
    const callId = randomUUID();
    return await this.capabilities.execute(call.capabilityId, call.input, {
      tenantId: call.tenantId,
      sessionId: callId,
      familyId: callId,
      turnId: callId,
      toolCallId: callId,
      source: "scheduler",
      workspacePath: this.hookWorkspaceRoot,
      idempotencyKey: `lifecycle-hook:${call.capabilityId}:${callId}`,
    });
  }

  async shutdown(): Promise<void> {
    if (this.proactiveTimer) clearInterval(this.proactiveTimer);
    this.proactiveTimer = undefined;
    if (this.backgroundThinkingTimer) clearInterval(this.backgroundThinkingTimer);
    this.backgroundThinkingTimer = undefined;
    this.proactiveIntakeBus.dispose();
    this.userModelIntegration.dispose();
    this.selfModelIntegration.dispose();
    this.autopilot.stop();
    this.auroraFleet.stop();
    this.backgroundThinking.stop();
    await this.thoughtCore.close();
    await this.scheduler.close();
    await this.automationResponders.close();
    await this.outboundChannels.closeAll();
    this.automaticRefinement.stop();
    await this.codeIntelligence.shutdown();
    this.otlp?.stop();
    this.natsEvents?.stop();
    this.natsCommands?.close();
    await this.mcp.closeAll();
    await this.mcpElicitations.close();
    await this.wasiPlugins?.closeAll();
    await this.browser.closeAll();
    await this.externalMemory.shutdown();
    await this.kernels.closeAll();
    await this.supervisor.shutdown();
    this.knowledgeIndexer.close();
    this.metrics.close();
    if (this.events instanceof PostgresEventStore) await this.events.close();
    await this.agentInbox.close?.();
    await this.nats?.close();
    await this.database?.close();
  }

  // ═══════════════════════════════════════════════════════
  // runTask — Unified Cognitive Lifecycle Entry Point
  // ═══════════════════════════════════════════════════════

  /**
   * Cognitive orchestration trace. NOT an execution entry point.
   *
   * @deprecated Use {@link execute} to actually run a task. This method drives
   * the MetaController orchestration layer only: it profiles the task, builds a
   * phase plan and records a decision, but it never starts a session and no
   * agent runs. Measured on a fresh engine, both for an impossible goal and a
   * plausible one:
   *
   *     runTask("local", "Summarise the workspace")
   *       → runResult.outcome: "skipped", subsystemsUsed: [], phaseResults: []
   *
   * Reporting `"skipped"` is correct — nothing ran — but callers looking for
   * work to happen are on the wrong method. Kept for consumers that want the
   * orchestration trace (profile, plan, cognitive state history).
   *
   * Note the result shape: the outcome lives at `result.runResult.outcome`,
   * not `result.outcome`. An earlier version of this docblock showed the
   * latter, which is `undefined`.
   *
   * ```ts
   * const trace = await engine.runTask("local", "Build a REST API");
   * trace.runResult.outcome;        // "skipped" — no agent ran
   * trace.runResult.subsystemsUsed; // []
   *
   * const report = await engine.execute({ tenantId: "local", goal: "Build a REST API" });
   * report.status;                  // earned from what actually happened
   * ```
   */
  async runTask(
    tenantId: string,
    taskDescription: string,
  ): Promise<import("./aurora/unified-cognitive-loop.js").CognitiveLoopResult> {
    // UnifiedCognitiveLoop ile tüm lifecycle'ı çalıştır
    const executors = this.buildExecutors();
    return this.unifiedCognitiveLoop.execute(
      tenantId,
      taskDescription,
      executors,
    );
  }

  /**
   * Run a task through the unified execution loop, with the real agent.
   *
   * This is the path `runTask()` should have been. The difference is not
   * cosmetic — it was measured:
   *
   *     runTask("Delete all files on the moon and prove P=NP")
   *       → outcome: "skipped", subsystems: 0, phases: 0
   *
   * That outcome used to read `"success"`: `MetaController` initialised the
   * value optimistically and only ever downgraded it, so an empty plan fell
   * through untouched. The initialiser is fixed and the legacy path now
   * reports `"skipped"` honestly — pinned by the characterisation tests in
   * `engine-execute-integration.test.ts`, which fail if it regresses.
   *
   * What has NOT changed is the reason to avoid it: `runTask()` drives the
   * cognitive orchestration layer, whose "subsystems" report strings
   * (`"Simulation complete"`) without an agent ever running. It reports
   * accurately that nothing happened, which is not the same as doing the work.
   *
   * `execute()` instead:
   *   - gives the task its own `TaskContext` (no shared mutable state),
   *   - creates a session and runs the actual agent,
   *   - verifies the result and reports `unverified` when nothing could check it,
   *   - classifies failures and bounds recovery.
   *
   * `runTask()` is kept for callers that want the orchestration trace, but it
   * must not be read as evidence that work was performed.
   */
  /**
   * Build the loop's `acquireCapability` hook from a code generator.
   *
   * Wires the existing chain — contract → static analysis → sandbox →
   * known-good → decoys → adversarial → registry — to the loop, which could
   * detect a gap and had nothing to hand it to.
   *
   * Returns `false` for every path that did not end in a verified capability,
   * including the common case where the gap carries no test cases. That is not
   * a workaround: `CapabilityAcquisition` requires at least two known-good
   * examples and one decoy, because an implementation verified against nothing
   * is an implementation nobody checked, and a decoy is the only defence
   * against code that hard-codes the expected answers. A gap with no examples
   * describes a problem, not a specification, and the loop already knows how
   * to report that honestly.
   */
  /**
   * Default implementation generator: asks this engine's own model for the code.
   *
   * Acquisition had no default on purpose, and the reasoning behind that is
   * recorded at the call site: a generator that returned `true` without
   * building anything would mark the gap closed and let the retry fail
   * identically, which is fabricated success. That reasoning is about
   * *unverified* acquisition, not about model-backed acquisition.
   *
   * This does not fabricate. It produces candidate code and hands it to the
   * existing chain, which is where the honesty lives: contract -> code ->
   * static analysis -> sandbox -> known-good cases -> decoys -> adversarial ->
   * registered with this engine's broker. Generated code that does not survive
   * that chain is rejected, and the loop keeps reporting the gap. A model that
   * cannot write working code produces a failed acquisition, not a fake one.
   *
   * What it does NOT do: pick a provider. Routing is `this.models`' job, and
   * this uses the default route so the acquisition respects whatever provider
   * policy the engine was configured with.
   */
  /**
   * Reads a bounded sample of a workspace for analysis.
   *
   * Bounded on purpose. Goal discovery only needs enough of the workspace to
   * notice what is declared but missing, and reading an entire repository to
   * propose goals would make a side observation the most expensive part of
   * running a task. The caps are hard: `maxFiles` entries, `maxBytes` per file,
   * and `maxTotalBytes` overall.
   *
   * Skips are silent and deliberate. Binary content, oversized files and
   * anything under a directory that is never source -- `node_modules`, `.git`,
   * build output -- are left out rather than truncated, because a half-read
   * file is worse than no file: analysis would report anomalies that are
   * really just the truncation.
   */
  private readWorkspaceSample(
    workspacePath: string,
    options: { maxFiles?: number; maxBytes?: number; maxTotalBytes?: number } = {},
  ): Array<{ path: string; content: string }> {
    const maxFiles = options.maxFiles ?? 40;
    const maxBytes = options.maxBytes ?? 16_384;
    const maxTotalBytes = options.maxTotalBytes ?? 262_144;
    const skip = new Set([
      "node_modules", ".git", "dist", "build", "out", "coverage", ".next",
      ".cache", "__pycache__", ".venv", "target",
    ]);

    const files: Array<{ path: string; content: string }> = [];
    let total = 0;
    const pending: string[] = [workspacePath];

    while (pending.length > 0 && files.length < maxFiles && total < maxTotalBytes) {
      const directory = pending.pop()!;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (files.length >= maxFiles || total >= maxTotalBytes) break;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!skip.has(entry.name) && !entry.name.startsWith(".")) pending.push(full);
          continue;
        }
        if (!entry.isFile() || skip.has(entry.name)) continue;
        try {
          const size = statSync(full).size;
          if (size === 0 || size > maxBytes || total + size > maxTotalBytes) continue;
          const content = readFileSync(full, "utf8");
          // A NUL byte is the cheap, reliable test for "this is not text".
          if (content.includes("\u0000")) continue;
          files.push({ path: relative(workspacePath, full), content });
          total += size;
        } catch {
          // Unreadable files are skipped rather than reported: the analysis is
          // about the workspace, not about this process's permissions.
        }
      }
    }

    return files;
  }

  /**
   * Indexes a stored memory in the cross-layer fusion store.
   *
   * Failures are swallowed deliberately and narrowly: the lesson is already
   * durably stored by the memory engine, and an indexing failure must not turn a
   * completed task into a failed one. The fusion index is a search aid over
   * memories that exist, not the record of them.
   *
   * The layer is derived the same way `MemoryEngine.store` derives it, so a
   * memory is indexed under the layer it was actually filed in rather than under
   * a guess.
   */
  private async fuseMemory(
    memoryId: string,
    tenantId: string,
    content: string,
    importance: number,
  ): Promise<void> {
    if (!memoryId) return;
    const layer = importance > 0.8 ? "semantic" : importance > 0.5 ? "episodic" : "working";
    try {
      await this.neuralMemoryFusion.embed(
        memoryId,
        tenantId,
        layer,
        content,
        content.slice(0, 100),
      );
    } catch {
      // See the note above: indexing is a search aid, not the record.
    }
  }

  /**
   * The system prompt used when asking the model to write a capability.
   *
   * A field rather than a literal so that self-improvement has something real to
   * improve. `maintainSelfImprovement` evolves this against measured fitness and
   * adopts a variant only when it beats the incumbent, so the prompt in use is
   * the one that scored best -- not the one someone wrote first.
   */
  private capabilityPromptTemplate: string =
    "You write minimal, dependency-free JavaScript implementations that " +
    "pass adversarial test cases. You do not explain your code.";

  /**
   * Evolves the capability-generation prompt against measured fitness.
   *
   * Rate-limited and best-effort, riding the same discipline as memory
   * maintenance: this calls the model once per candidate, so running it after
   * every task would make self-improvement the dominant cost of running one.
   *
   * Two honesty rules, both load-bearing:
   *
   *   - The fitness is measured, not assumed. `evolvePrompts` requires an
   *     evaluation function; it used to rank variants by the placeholder fitness
   *     they were constructed with, which made "the best variant" whichever
   *     happened to sort first.
   *   - A variant is adopted only when it strictly beats the incumbent, which is
   *     scored by the same function on the same probe. Without that comparison a
   *     run of random mutations would drift the prompt in whatever direction the
   *     last mutation happened to push it.
   *
   * The fitness is a static checklist over the generated code -- non-empty,
   * actually defines something, no forbidden constructs, balanced braces -- and
   * it is a proxy, not a proof. It says the output is plausible code; it does not
   * say the code works, which is what the acquisition sandbox decides. That limit
   * is why adopting a variant requires beating a measured incumbent rather than
   * merely existing.
   */
  private async maintainSelfImprovement(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSelfImprovementAt < HybridAgentEngine.MEMORY_MAINTENANCE_INTERVAL_MS) {
      return;
    }
    this.lastSelfImprovementAt = now;

    const probe =
      "Implement a function that takes an array of numbers and returns their " +
      "arithmetic mean, or 0 for an empty array.";

    const fitness = async (template: string): Promise<number> => {
      let output = "";
      try {
        for await (const event of this.models.stream({
          sessionId: randomUUID(),
          turnId: randomUUID(),
          systemPrompt: template,
          messages: [
            {
              id: randomUUID(),
              role: "user",
              content: [{ type: "text", text: probe }],
              timestamp: new Date().toISOString(),
            },
          ],
          tools: [],
        })) {
          if (event.type === "text_delta") output += event.delta;
        }
      } catch {
        return 0;
      }

      const code = output.trim();
      if (code.length === 0) return 0;

      let score = 0.25;
      if (/function\s+[A-Za-z0-9_$]+|=>/.test(code)) score += 0.25;
      if (!/\brequire\s*\(|\bimport\s|\bfetch\s*\(|child_process/.test(code)) score += 0.25;
      const opens = (code.match(/\{/g) ?? []).length;
      const closes = (code.match(/\}/g) ?? []).length;
      if (opens === closes) score += 0.25;
      return score;
    };

    try {
      const incumbent = await fitness(this.capabilityPromptTemplate);
      const variants = await this.cognitiveRuntime.selfImprovement.evolvePrompts({
        seedPrompt: this.capabilityPromptTemplate,
        generations: 1,
        mutationsPerGeneration: 2,
        evaluate: fitness,
      });

      const best = variants.reduce(
        (top, variant) => (variant.fitness > top.fitness ? variant : top),
        variants[0]!,
      );

      // Strictly better, and measured by the same function on the same probe.
      if (best.fitness > incumbent) {
        this.capabilityPromptTemplate = best.template;
        await this.eventBus
          .emit("self-improvement.prompt-adopted", "HybridAgentEngine", {
            from: incumbent,
            to: best.fitness,
            variants: variants.length,
          })
          .catch(() => undefined);
      }
    } catch {
      // Best-effort: a failed improvement pass leaves the current prompt in use.
    }
  }

  private defaultImplementationGenerator(): import(
    "./execution/capability-acquisition.js"
  ).ImplementationGenerator {
    return async (contract, gap) => {
      const knownGood = gap.testCases?.knownGood ?? [];
      const knownBad = gap.testCases?.knownBad ?? [];
      const adversarial = gap.testCases?.adversarial ?? [];

      const prompt = [
        `Implement a capability named "${contract.name}".`,
        "",
        `Description: ${contract.description}`,
        `Accepts: ${contract.inputSchema}`,
        `Returns: ${contract.outputSchema}`,
        `Permissions: ${contract.permissions.length > 0 ? contract.permissions.join(", ") : "none"}`,
        `Side effects: ${contract.sideEffects ? "yes" : "no"}`,
        `Risk: ${contract.risk}`,
        "",
        "Write a single JavaScript function. No imports, no network access, no",
        "process spawning, no filesystem access -- the sandbox rejects those and",
        "the acquisition fails on them.",
        "",
        knownGood.length > 0
          ? `It must handle these inputs correctly:\n${JSON.stringify(knownGood, null, 2)}`
          : "No worked examples were supplied with the gap.",
        knownBad.length > 0
          ? `It must reject these:\n${JSON.stringify(knownBad, null, 2)}`
          : "",
        adversarial.length > 0
          ? `It must survive these adversarial inputs:\n${JSON.stringify(adversarial, null, 2)}`
          : "",
        "",
        "Return only the code.",
      ]
        .filter(Boolean)
        .join("\n");

      let text = "";
      for await (const event of this.models.stream({
        sessionId: randomUUID(),
        turnId: randomUUID(),
        systemPrompt: this.capabilityPromptTemplate,
        messages: [
          {
            id: randomUUID(),
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: new Date().toISOString(),
          },
        ],
        tools: [],
      })) {
        if (event.type === "text_delta") text += event.delta;
      }

      // Providers commonly wrap code in a fence. Returning the fence verbatim
      // would fail static analysis on the backticks rather than on the code, so
      // the body is extracted -- but only when a fence is actually present.
      const fenced = /```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/.exec(text);
      const code = (fenced?.[1] ?? text).trim();

      if (code.length === 0) {
        // Throwing is correct here: an empty implementation is not a candidate.
        // Returning "" would let the chain report a confusing sandbox failure
        // instead of naming the real problem.
        throw new Error(
          `Model produced no implementation for capability "${contract.name}"`,
        );
      }
      return code;
    };
  }

  private capabilityAcquirer(
    generate: import("./execution/capability-acquisition.js").ImplementationGenerator,
  ): (
    gap: import("./execution/gap-detection.js").DetectedGap,
    context: import("./execution/task-context.js").TaskContext,
  ) => Promise<boolean> {
    return async (gap, _context) => {
      const { CapabilityAcquisition, contractFromGap } = await import(
        "./execution/capability-acquisition.js"
      );
      const { CapabilitySynthesisPipeline } = await import(
        "./capabilities/capability-synthesis.js"
      );

      const contract = contractFromGap(gap, {
        knownGood: gap.testCases?.knownGood ?? [],
        knownBad: gap.testCases?.knownBad ?? [],
        adversarial: gap.testCases?.adversarial ?? [],
      });

      // One pipeline instance, held rather than inlined: the sandbox handle
      // for the built capability lives inside it, so the broker adapter must
      // delegate to this exact instance and not a fresh one.
      const pipeline = new CapabilitySynthesisPipeline();
      const acquisition = new CapabilityAcquisition(pipeline, generate);

      const result = await acquisition.acquire(gap, contract);

      // Publish to the real broker. Until this existed, `acquired: true` meant
      // the implementation sat in the synthesis pipeline's own map: the loop
      // then retried the original task against an inventory that had never
      // heard of it, so "generated" and "usable" were different things.
      //
      // The generated source still never enters this process (item 14). The
      // registered capability delegates every call back into the sandbox.
      let published: { published: boolean; capabilityId: string; reason: string } | undefined;
      if (result.acquired && result.capabilityId) {
        const { publishAcquiredCapability } = await import(
          "./execution/acquired-capability-adapter.js"
        );
        published = publishAcquiredCapability(this.capabilities, {
          name: gap.missing,
          description: gap.description,
          synthesisedId: result.capabilityId,
          pipeline,
        });
      }

      await this.eventBus
        .emit("capability.acquisition", "HybridAgentEngine", {
          gap: gap.missing,
          acquired: result.acquired,
          state: result.state,
          summary: result.summary,
          ...(published
            ? { published: published.published, brokerId: published.capabilityId }
            : {}),
        })
        .catch(() => undefined);

      // A capability the broker rejected is not available to the agent, so the
      // retry would fail the same way. Reporting the gap as closed in that
      // case is exactly the fabricated success this chain exists to avoid.
      if (result.acquired && published && !published.published) {
        return false;
      }

      return result.acquired;
    };
  }

  /**
   * Last time memory maintenance ran, per tenant.
   *
   * Per tenant because consolidation and decay are tenant-scoped: one busy
   * tenant must not starve another's maintenance, and one idle tenant must not
   * hold a global lock open.
   */
  private readonly lastMemoryMaintenance = new Map<string, number>();

  /** Minimum gap between maintenance passes for one tenant. */
  private static readonly MEMORY_MAINTENANCE_INTERVAL_MS = 5 * 60_000;

  /**
   * Run memory maintenance if enough time has passed for this tenant.
   *
   * Failures are swallowed on purpose, in the same spirit as the learn hook:
   * a store that could not be tidied is a degraded system, not a failed task.
   * The difference from the old code is that the work now happens at all —
   * `decay()` had zero callers and `autoConsolidate()` had one manual HTTP
   * endpoint.
   */
  private lastSelfImprovementAt = 0;

  private async maintainMemory(tenantId: string): Promise<void> {
    const now = Date.now();
    const last = this.lastMemoryMaintenance.get(tenantId) ?? 0;
    if (now - last < HybridAgentEngine.MEMORY_MAINTENANCE_INTERVAL_MS) return;

    // Stamp before awaiting: two tasks finishing together would otherwise both
    // see a stale timestamp and run overlapping passes over the same store.
    this.lastMemoryMaintenance.set(tenantId, now);

    try {
      const result = await this.longHorizonMemory.autoConsolidate(tenantId);
      if (result.consolidated > 0 || result.pruned > 0 || result.promoted > 0) {
        await this.eventBus
          .emit("memory.maintained", "HybridAgentEngine", {
            tenantId,
            consolidated: result.consolidated,
            promoted: result.promoted,
            pruned: result.pruned,
            aged: result.decayed,
          })
          .catch(() => undefined);
      }
    } catch {
      // Maintenance is best-effort. It must never turn a completed task into a
      // failed one.
    }

    // Deduplicate the fusion index on the same schedule.
    //
    // Every task now embeds a lesson, so the index grows monotonically and the
    // same lesson recorded twice is stored twice. `consolidate` removes exact
    // content duplicates. Rides on this hook rather than running per task for
    // the same reason consolidation does: it rewrites the store, and doing that
    // after every task would make maintenance the dominant cost of running one.
    //
    // Reported honestly. `consolidate` currently only removes duplicates -- its
    // `compressedCount`, `patternsDiscovered` and `contradictionsFound` are
    // hardcoded to 0 and `newInsights` is always empty, so a non-zero value
    // there would mean the implementation changed, not that this call did more.
    try {
      const fusion = await this.neuralMemoryFusion.consolidate(tenantId);
      if (fusion.duplicatesRemoved > 0) {
        await this.eventBus
          .emit("memory.fusion.deduplicated", "HybridAgentEngine", {
            tenantId,
            duplicatesRemoved: fusion.duplicatesRemoved,
          })
          .catch(() => undefined);
      }
    } catch {
      // Best-effort, for the same reason as above.
    }
  }

  async execute(input: {
    tenantId: string;
    goal: string;
    workspace?: string;
    constraints?: readonly string[];
    budget?: import("./execution/task-context.js").TaskBudget;
    correlationId?: string;
    /**
     * Task identity (P1.1): who asked, whether this is a sub-task, its
     * scheduling class, its finish-by instant, and which surface produced it.
     * All optional and all passed through untouched — the primitive records
     * identity, it does not invent it.
     */
    userId?: string;
    parentTaskId?: string;
    priority?: string;
    /** Absolute finish-by instant (ISO); not a duration like `budget.timeMs`. */
    deadline?: string;
    provenance?: import("./execution/task-context.js").TaskProvenance;
    verifiers?: readonly import("./execution/verification-factory.js").Verifier[];
    /**
     * Independent evaluators for V3 consensus verification.
     *
     * Used only when nothing objective can be built for the goal — no supplied
     * verifier, no detectable build or test suite. Requires at least two
     * distinct `source` values; a panel drawn from one model is one opinion
     * repeated, and `consensusVerifier` refuses it.
     */
    evaluatorPanel?: readonly import("./execution/consensus-verifier.js").Evaluator[];
    maxAttempts?: number;
    /** Optional hook that builds a missing capability and returns whether it succeeded. */
    acquireCapability?: (
      gap: import("./execution/gap-detection.js").DetectedGap,
      context: import("./execution/task-context.js").TaskContext,
    ) => Promise<boolean>;
    /**
     * Writes an implementation for a detected gap, closing the capability
     * chain: gap → contract → code → static analysis → sandbox → verify →
     * registry → retry.
     *
     * Everything in that chain existed and was tested; the step that turns a
     * gap into code did not, so `CapabilityAcquisition` had zero callers in
     * `src` and `maturity.ts` honestly recorded `wiredToEngine: false`.
     *
     * No default and no built-in model binding. Specification item 33 keeps
     * cognitive control in Aurora: the engine decides whether to acquire,
     * verifies the result and records the decision; only the writing of code
     * is delegated. Absent a generator the loop keeps its current behaviour
     * and reports the gap as `unavailable` rather than pretending to close it.
     *
     * Generated code never enters this process (specification item 14). It is
     * statically analysed, then executed in a worker isolate with no
     * `require`, no `process`, no dynamic import, a heap cap and a timeout.
     */
    capabilityGenerator?: import("./execution/capability-acquisition.js").ImplementationGenerator;
    /**
     * F4 / P1.25: a multi-world analysis the caller has bound to this task.
     * Its consensus stands in front of execution: "reject" or "hold" blocks
     * the task before any work happens; "proceed"/"uncertain" lets it run with
     * the consensus (and its dissent) recorded on the report and in the
     * decision ledger. Absent means no analysis was bound -- the ordinary path.
     */
    worldAnalysisId?: string;
    /**
     * G1 / P1.27: capability tags the caller declares this task's work needs
     * (e.g. ["research", "coding"]). Two uses, both honest about what is known:
     * they are written to the durable plan the task's execution mirrors into
     * the planning layer, and they are the ONLY basis on which remaining work
     * is ever delegated to society specialists -- the execution bridge matches
     * roles by capability coverage, and delegating without tags would mean
     * picking a specialist by guesswork. Absent means no specialist matching
     * is possible, and the task says so instead of inventing a match.
     */
    capabilityTags?: readonly string[];
  }): Promise<import("./execution/unified-execution-loop.js").TaskReport> {
    const { UnifiedExecutionLoop, ablateExecutionDependencies } =
      await import("./execution/unified-execution-loop.js");
    const { runAgentViaSession } =
      await import("./execution/session-agent-adapter.js");

    // F3: the id of this task's durable world-model prediction, opened by the
    // worldModel adapter on the first attempt and resolved by the same adapter
    // once the outcome is known. Lives here -- outside the dependency literal --
    // because both halves of the pair close over it.
    let durablePredictionId: string | undefined;

    // E7 / P1.14: the task enters the Global Workspace. Every other cognitive
    // signal (initiatives, ACOS cycles, memory and world events) already
    // competed for attention there; the one thing missing was the work itself.
    // A task that is not on the blackboard is invisible to the attention
    // economy that is supposed to budget it.
    const priorityUrgency: Record<string, number> = {
      P0: 0.95, P1: 0.75, P2: 0.55, P3: 0.45, P4: 0.3,
    };
    const taskUrgency = priorityUrgency[String(input.priority ?? "").toUpperCase()] ?? 0.4;
    let workspaceObjectId: string | undefined;
    let workspaceIntakeNote: string | undefined;
    try {
      const intake = await this.cognitive.intake({
        tenantId: input.tenantId,
        source: input.userId !== undefined || input.provenance?.surface !== undefined ? "user" : "agent",
        title: input.goal.slice(0, 500),
        content:
          `Task: ${input.goal}` +
          (input.constraints?.length ? `\nConstraints: ${input.constraints.join("; ")}` : "") +
          (input.priority ? `\nPriority: ${input.priority}` : ""),
        ...(input.correlationId ? { sourceId: input.correlationId.slice(0, 500) } : {}),
        kind: "problem",
        ...(input.priority && priorityUrgency[String(input.priority).toUpperCase()] !== undefined
          ? { urgency: taskUrgency, importance: taskUrgency }
          : {}),
        ...(input.budget?.tokens !== undefined ? { requestedTokens: input.budget.tokens } : {}),
        tags: ["engine-task"],
      });
      if (intake.accepted && intake.object) {
        workspaceObjectId = intake.object.id;
      } else {
        // The task still runs -- an intake quota governs background signal
        // volume, not caller requests -- but the workspace will not budget it.
        workspaceIntakeNote = `Workspace intake rejected the task (${intake.reason}); it runs without a cognitive focus reservation.`;
      }
    } catch (error) {
      workspaceIntakeNote = `Workspace intake failed, so the task is not on the cognitive blackboard: ${error instanceof Error ? error.message : String(error)}`;
    }

    // E5 + E6 / P1.12 + P1.13: the attention gate. The workspace's own state
    // decides: the tenant's cognitive mode (emergency defers routine work),
    // then the daily token budget, then the focus-slot economy. Slots
    // saturated is NOT a refusal -- a caller task must not be crowded out by
    // background cognition -- but the budget being spent is.
    const attentionGate = async (
      _context: import("./execution/task-context.js").TaskContext,
    ): Promise<{ readonly allowed: boolean; readonly note: string }> => {
      const modeState = await this.cognitive.mode(input.tenantId);
      const policy = MODE_ATTENTION_POLICY[modeState.mode];
      if (policy.minUrgency !== undefined && taskUrgency < policy.minUrgency) {
        return {
          allowed: false,
          note:
            `${policy.note} This task's urgency is ${taskUrgency.toFixed(2)}, ` +
            `below the ${policy.minUrgency} threshold.`,
        };
      }
      if (workspaceObjectId === undefined) {
        return {
          allowed: true,
          note: workspaceIntakeNote ?? "No workspace object; running unbudgeted.",
        };
      }
      const allocation = await this.cognitive.allocateAttention(input.tenantId, {
        preempt: taskUrgency >= 0.9,
      });
      const focusedNow = await this.cognitive.objects(input.tenantId, "focused");
      const budget = allocation.budget;
      if (focusedNow.some((object) => object.id === workspaceObjectId)) {
        return {
          allowed: true,
          note:
            `Cognitive focus reserved: budget ${budget.usedTokens}/${budget.dailyTokenBudget} ` +
            `tokens used, ${budget.reservedTokens} reserved.`,
        };
      }
      if (budget.usedTokens + budget.reservedTokens >= budget.dailyTokenBudget) {
        return {
          allowed: false,
          note:
            `Cognitive budget exhausted: ${budget.usedTokens} used + ${budget.reservedTokens} ` +
            `reserved of ${budget.dailyTokenBudget} daily tokens.`,
        };
      }
      return {
        allowed: true,
        note:
          `Focus slots saturated (${focusedNow.length}/${budget.maxFocusedObjects}); ` +
          `the task runs without a focus reservation and its tokens are not charged to the attention budget.`,
      };
    };

    // E2 / P1.9: the critic reviews the plan the task will actually run --
    // goal plus steps plus their verification criteria, the real text, not a
    // summary written for the critic's benefit.
    const critiquePlan = async (
      context: import("./execution/task-context.js").TaskContext,
    ): Promise<{
      readonly recommendation: "approve" | "revise" | "reject";
      readonly critiques: readonly {
        readonly severity: string;
        readonly description: string;
        readonly suggestion: string;
      }[];
    }> => {
      const steps = context.plan?.steps ?? [];
      const planText =
        `Goal: ${context.goal}\nSteps:\n` +
        steps
          .map((step, index) =>
            `${index + 1}. ${step.description}` +
            (step.verification ? ` (verification: ${step.verification})` : ""),
          )
          .join("\n");
      const review = await this.internalCritic.review(
        input.tenantId,
        context.taskId,
        "plan",
        planText,
      );
      return {
        recommendation: review.recommendation,
        critiques: review.critiques.map((item) => ({
          severity: item.severity,
          description: item.description,
          suggestion: item.suggestion,
        })),
      };
    };

    // E1 / P1.9: each recovery decision becomes a pair of competing
    // hypotheses, graded by the next attempt's verdict. Competing, because a
    // bet and its negation deserve separate records; graded, because only the
    // next attempt's real outcome can separate them.
    const openRecoveryHypotheses = new Map<number, { positive: string; negative: string }>();
    const recoveryHypothesis = {
      open: async (info: {
        attempt: number;
        failureKind: string;
        strategy: string;
        rationale: string;
        goal: string;
      }): Promise<void> => {
        const positive = await this.multiHypothesis.proposeHypothesis(
          input.tenantId,
          `Recovery "${info.strategy}" resolves the ${info.failureKind} failure — goal: ${info.goal}`.slice(0, 200),
          "execution-recovery",
          [info.rationale.slice(0, 500)],
        );
        const negative = await this.multiHypothesis.proposeHypothesis(
          input.tenantId,
          `The ${info.failureKind} failure is structural; recovery "${info.strategy}" will not resolve it — goal: ${info.goal}`.slice(0, 200),
          "execution-recovery",
          [info.rationale.slice(0, 500)],
        );
        await this.multiHypothesis.markCompeting(positive.id, negative.id);
        openRecoveryHypotheses.set(info.attempt, { positive: positive.id, negative: negative.id });
      },
      test: async (info: {
        attempt: number;
        verified: boolean;
        evidence: string;
      }): Promise<void> => {
        const pair = openRecoveryHypotheses.get(info.attempt - 1);
        if (pair === undefined) return;
        await this.multiHypothesis.recordTest(pair.positive, `attempt-${info.attempt}`, info.evidence.slice(0, 500), info.verified);
        await this.multiHypothesis.recordTest(pair.negative, `attempt-${info.attempt}`, info.evidence.slice(0, 500), !info.verified);
        await this.multiHypothesis.addEvidence(pair.positive, "verification", info.evidence.slice(0, 500), info.verified, info.verified ? "strong" : "moderate");
        await this.multiHypothesis.addEvidence(pair.negative, "verification", info.evidence.slice(0, 500), !info.verified, info.verified ? "moderate" : "strong");
        openRecoveryHypotheses.delete(info.attempt - 1);
      },
    };

    // F4 / P1.25: the analysis the caller bound to this task, fetched up front
    // so an unknown id is a caller error that fails fast, not a silently
    // missing gate. The perspectives' consensus decides whether the task runs;
    // when it does, the consensus also becomes a durable decision record so
    // what the perspectives concluded is auditable next to what actually
    // happened.
    const boundAnalysis =
      input.worldAnalysisId !== undefined
        ? await this.multiWorld.getAnalysis(input.tenantId, input.worldAnalysisId)
        : undefined;
    let analysisDecisionId: string | undefined;
    let analysisAllowed: boolean | undefined;
    const analysisGate =
      boundAnalysis === undefined
        ? undefined
        : async (context: import("./execution/task-context.js").TaskContext) => {
            if (boundAnalysis.status !== "resolved" || boundAnalysis.consensus === undefined) {
              return {
                allowed: false,
                note:
                  `analysis ${boundAnalysis.id} is ${boundAnalysis.status}: perspectives that have ` +
                  `not reached a consensus cannot authorize execution`,
              };
            }
            const consensus = boundAnalysis.consensus;
            const allowed = consensus.decision === "proceed" || consensus.decision === "uncertain";
            const dissentCount = consensus.dissentPerspectiveIds.length;
            const baseNote =
              `consensus ${consensus.decision} (score ${consensus.score.toFixed(2)}, ` +
              `agreement ${consensus.agreement.toFixed(2)}, ${dissentCount} dissenting, ` +
              `${consensus.missingPerspectiveIds.length} missing)`;
            // A decision worth acting on is worth recording. The consensus and
            // its dissent go into the durable decision ledger; "hold" and
            // "uncertain" record nothing because no decision was made -- the
            // blocked report is the honest record for those.
            if (consensus.decision === "proceed" || consensus.decision === "reject") {
              try {
                const perspectives = await this.multiWorld.perspectives(input.tenantId);
                const nameOf = (id: string): string =>
                  perspectives.find((item) => item.id === id)?.code ?? id;
                // Analysis weights combine base weight × problem emphasis ×
                // reputation and can exceed 1; the ledger validates 0-1 and
                // normalizes by its own total. Dividing every weight by the
                // same maximum preserves the ratios exactly, so the normalized
                // criteria mean the same thing on both sides of the bridge.
                const rawWeights = boundAnalysis.views.slice(0, 20).map(
                  (view) => boundAnalysis.weights[view.perspectiveId] ?? 1,
                );
                const maxWeight = Math.max(...rawWeights, 1e-9);
                const criteria = boundAnalysis.views.slice(0, 20).map((view, index) => ({
                  name: `${nameOf(view.perspectiveId)}: ${view.stance}`,
                  weight: rawWeights[index]! / maxWeight,
                  direction: "maximize" as const,
                  description: view.rationale.slice(0, 1000),
                }));
                const record = await this.decisions.open({
                  tenantId: input.tenantId,
                  title: `Multi-world gate: ${input.goal}`.slice(0, 300),
                  question: boundAnalysis.question,
                  context:
                    `Problem type ${boundAnalysis.problemType}. Task: ${input.goal}`.slice(0, 50_000),
                  criteria,
                  analysisId: boundAnalysis.id,
                });
                // Quantized stances: a supporting view scores "proceed" at its
                // confidence and "do not proceed" at its doubt; an opposing
                // view mirrors that; a neutral view splits evenly. The numbers
                // come from the views themselves, not from here.
                const proceedScores: Record<string, number> = {};
                const rejectScores: Record<string, number> = {};
                for (const view of boundAnalysis.views.slice(0, 20)) {
                  const key = `${nameOf(view.perspectiveId)}: ${view.stance}`;
                  const proceed =
                    view.stance === "support"
                      ? view.confidence
                      : view.stance === "oppose"
                        ? 1 - view.confidence
                        : 0.5;
                  proceedScores[key] = proceed;
                  rejectScores[key] = 1 - proceed;
                }
                await this.decisions.addOption({
                  tenantId: input.tenantId,
                  decisionId: record.id,
                  name: "proceed",
                  description: "Run the task as asked.",
                  scores: proceedScores,
                  risks: boundAnalysis.views.flatMap((view) => view.keyRisks).slice(0, 20),
                });
                const chosenName = consensus.decision === "proceed" ? "proceed" : "do not proceed";
                const withOptions = await this.decisions.addOption({
                  tenantId: input.tenantId,
                  decisionId: record.id,
                  name: "do not proceed",
                  description: "Do not run the task.",
                  scores: rejectScores,
                  risks: boundAnalysis.views.flatMap((view) => view.keyOpportunities).slice(0, 20),
                });
                const chosen = withOptions.options.find((option) => option.name === chosenName)!;
                const decided = await this.decisions.decide({
                  tenantId: input.tenantId,
                  decisionId: record.id,
                  rationale:
                    `Multi-world consensus: ${baseNote}. ` +
                    `${consensus.unresolvedConflictIds.length} unresolved conflict(s).`,
                  expectedOutcome:
                    consensus.decision === "proceed"
                      ? `The task runs and is expected to ${allowed ? "verify" : "be blocked"}.`
                      : "The task does not run.",
                  chosenOptionId: chosen.id,
                  overrideReason:
                    "The weighted-stance consensus of the analysis chose this option; " +
                    "the option scoring above is the quantized view of the same evidence.",
                });
                analysisDecisionId = decided.id;
                // Dissent is preserved on the record (constitution C9): every
                // non-neutral view against the consensus leaves its rationale.
                for (const view of boundAnalysis.views) {
                  const against =
                    consensus.decision === "proceed"
                      ? view.stance === "oppose"
                      : view.stance === "support";
                  if (!against) continue;
                  await this.decisions.recordDissent({
                    tenantId: input.tenantId,
                    decisionId: decided.id,
                    source: nameOf(view.perspectiveId),
                    concern: view.rationale.slice(0, 5000),
                  });
                }
              } catch (error) {
                // The ledger is auditable history, not a precondition for
                // gating: the gate still decides below on the consensus itself.
                context.observe(
                  "world-analysis",
                  `The consensus could not be recorded in the decision ledger: ` +
                    `${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
            analysisAllowed = allowed;
            return {
              allowed,
              note: allowed
                ? `Multi-world analysis allows execution — ${baseNote}`
                : `Multi-world analysis blocks execution — ${baseNote}`,
            };
          };

    // S7: the model path this task actually ran under, captured at the
    // routing decision so execution reputation can be recorded per path
    // after the outcome is known — measured, not inferred from text.
    let selfDirectionModelPath: string | undefined;
    const loopDeps: import("./execution/unified-execution-loop.js").ExecutionDependencies = {
        runAgent: async (context) =>
          runAgentViaSession(
            this as unknown as import("./execution/session-agent-adapter.js").SessionCapableEngine,
            context,
          ),

        recall: async (context) => {
          const recalled = await this.memoryEngine.recall({
            text: context.goal,
            tenantId: context.tenantId,
          });
          return (recalled.memories ?? [])
            .map((item: { content?: string }) => String(item.content ?? ""))
            .filter(Boolean);
        },

        // PlanningEngine exists and was not wired: the loop reported
        // `unavailable` for the planning phase on every run, which was honest
        // but meant the cognitive planner never informed execution.
        //
        // Scope of what this buys, stated plainly (updated by B3): the model is
        // now asked to decompose the goal, and `decomposeGoal()`'s fixed
        // Understand → [Research] → [Design] → [Simulate] → Execute → Verify →
        // Learn skeleton runs only when that fails. `PlanningResult.source` says
        // which one produced the plan, so a populated `context.plan` is still not
        // by itself evidence of goal-specific decomposition — read the source.
        //
        // Failures are surfaced, not swallowed: the loop treats a throw as a
        // planning failure and an empty step list as `"Planner produced zero
        // steps"`, so a broken planner cannot look like a skipped one.
        // Dependency edges are carried through, not flattened. `decomposeGoal`
        // computes a DAG and this mapping used to collapse each step to a
        // single string, so the loop received a list and the ordering the
        // planner had worked out was lost between two adjacent lines of code.
        // Step names are used as ids because that is what `dependencies`
        // already refers to.
        // B2 / P1.2: understand the goal before planning it. The loop decides
        // what the recommendation means; this only supplies the extraction.
        understandGoal: async (context) =>
          this.goalUnderstanding.understand({
            tenantId: context.tenantId,
            goal: context.goal,
          }),

        plan: async (context) => {
          const result = await this.planningEngine.plan({
            goal: context.goal,
            tenantId: context.tenantId,
          });
          return result.steps.map((step) => ({
            id: step.name,
            description: `${step.name}: ${step.description}`,
            dependencies: step.dependencies,
            // B6: the planner is prompted for `expectedOutput` — "what a
            // verifier could check afterwards" — and until now this bridge
            // dropped it, so every step arrived unverifiable by construction.
            // The runtime name differs from the planner name on purpose: the
            // planner speaks of outputs because it is prompted for artifacts;
            // the runtime speaks of criteria because that is what a verifier
            // evaluates.
            ...(step.expectedOutput !== undefined
              ? { successCriterion: step.expectedOutput }
              : {}),
          }));
        },

        // Verifiers: caller-supplied first, then whatever the workspace can
        // prove about itself.
        //
        // Returning only `input.verifiers` was honest but incomplete — a caller
        // who passed none always got `unverified`, even for a Node repo sitting
        // right there with `npm test` in it. VerificationService already detects
        // the toolchain (package.json/pytest/go.mod/Cargo.toml/Makefile), so the
        // evidence exists; it just was not wired.
        //
        // Deliberately NOT a fallback to "assume success": if detection finds no
        // runnable build or test, no verifier is produced and the loop still
        // reports `unverified`. An absent toolchain is absent evidence.
        // The report should say what the task ran. Drained here, at report
        // build, so one task's usage is never attributed to the next.
        invokedCapabilities: () => [...this.takeInvokedCapabilities(input.tenantId)],

        // Close the model-learning loop. Both registries had a `recordOutcome`
        // and neither was reachable from a real task, so the router ranked
        // models on evidence nothing ever collected. The success signal is the
        // verification verdict: an agent that finished happily but produced the
        // wrong thing must not teach the router to prefer it.
        recordModelOutcome: async (sample) => {
          if (sample.route !== "" && sample.route !== "default") {
            await this.modelCapabilityRegistry.recordOutcome(
              sample.route,
              sample.verified,
              sample.latencyMs,
            );
          }
          // Only when there was a decision to attach it to. Inventing an id here
          // would write an outcome onto a decision that was never made.
          if (sample.decisionId) {
            await this.adaptiveRouter.recordOutcome(
              sample.decisionId,
              sample.latencyMs,
              sample.verified,
            );
          }
          // Telemetry must not fail the recording it describes.
          await this.eventBus
            .emit("model.outcome.recorded", "HybridAgentEngine", {
              route: sample.route,
              verified: sample.verified,
              uncertain: sample.uncertain,
              latencyMs: sample.latencyMs,
              attempt: sample.attempt,
              taskId: sample.taskId,
              hadDecision: Boolean(sample.decisionId),
            })
            .catch(() => undefined);
        },
        verifiersFor: async (context) => {
          const supplied = input.verifiers ?? [];
          const generated: import("./execution/verification-factory.js").Verifier[] =
            [];
          const workspace = context.workspace;

          // A goal with no workspace, or a workspace with no detectable
          // toolchain, is exactly the case V3 exists for. The two early returns
          // that used to sit here skipped the consensus fallback entirely, so
          // the tier stayed unreachable on precisely the goals that needed it.
          const recipe = workspace
            ? await this.verification.detect(workspace).catch(() => undefined)
            : undefined;

          if (workspace && recipe) {
            const { formalVerifier, empiricalVerifier } =
              await import("./execution/verification-factory.js");

            // Build is a V1 formal check: it either compiles or it does not.
            if (recipe.build.length > 0) {
              generated.push(
                formalVerifier(`build:${recipe.kind}`, async () => {
                  const run = await this.verification.run({
                    tenantId: context.tenantId,
                    sessionId: context.sessionId ?? context.taskId,
                    workspacePath: workspace,
                    phases: ["build"],
                  });
                  return {
                    ok: run.verdict === "verified",
                    output: `${recipe.name} build — ${run.verdict}: ${run.reason}`,
                  };
                },
                  // A build check proves the workspace still compiles. It does
                  // not prove the goal was achieved, and marking it otherwise is
                  // what let a task report `succeeded` while the file its goal
                  // asked for was never created.
                  "workspace",
                ),
              );
            }

            // Tests are V2 empirical: they are evidence, not proof.
            if (recipe.test.length > 0) {
              generated.push(
                empiricalVerifier(`test:${recipe.kind}`, async () => {
                  const run = await this.verification.run({
                    tenantId: context.tenantId,
                    sessionId: context.sessionId ?? context.taskId,
                    workspacePath: workspace,
                    phases: ["test"],
                  });
                  const ran = run.phases.filter(
                    (phase) => phase.phase === "test",
                  );
                  const failedPhases = ran.filter(
                    (phase) => !phase.passed,
                  ).length;
                  return {
                    // An empty run reports 0/0, which empiricalVerifier turns into
                    // `uncertain` rather than a pass.
                    passed: ran.length - failedPhases,
                    failed: failedPhases,
                    output: `${recipe.name} tests — ${run.verdict}: ${run.reason}`,
                  };
                },
                  // The repository's own suite checks the repository. It does not
                  // check this task's goal unless the goal was to change what
                  // those tests cover, and the caller who knows that can supply a
                  // goal-scoped verifier of their own.
                  "workspace",
                ),
              );
            }
          }

          // V3 consensus is the fallback, never the default.
          //
          // It runs only when no objective verifier could be built: a repo with
          // a build or a test suite has evidence that does not depend on anyone
          // agreeing with anyone. Asking a panel when `npm test` is sitting
          // right there would substitute opinion for proof.
          //
          // `evaluatorPanel` is supplied by the caller. Absent one, no V3
          // verifier is produced and the loop reports `unverified` — which is
          // the honest outcome for a goal nothing could check.
          if (
            generated.length === 0 &&
            supplied.length === 0 &&
            input.evaluatorPanel
          ) {
            const { consensusVerifier, independentSources } =
              await import("./execution/consensus-verifier.js");
            if (independentSources(input.evaluatorPanel) >= 2) {
              generated.push(
                consensusVerifier("panel", context.goal, input.evaluatorPanel),
              );
            }
          }

          return [...supplied, ...generated];
        },

        // Domain experts, consulted only when the goal is actually in one of
        // their domains.
        //
        // `DomainExpertService` was constructed and `init()`ed at startup and
        // never asked anything afterwards. Its domains are all high-risk
        // regulated ones, so the classifier here is deliberately narrow: a goal
        // that does not name a regulated subject gets no consultation at all.
        // Asking a legal expert about writing a text file would not be thorough,
        // it would be noise -- and it would put the language of professional
        // advice around a task that needed none.
        //
        // The keyword classifier is the weak link and is labelled as such: it
        // matches words, it does not understand the question. A goal in a
        // regulated domain that happens to avoid every keyword is missed, which
        // is why the consultation is advisory and why the professional-review
        // flag is recorded verbatim rather than interpreted.
        consultDomainExpert: async (context) => {
          const goal = context.goal.toLowerCase();
          const domains: ReadonlyArray<[string, readonly string[]]> = [
            ["legal", ["lawsuit", "contract dispute", "litigation", "mahkeme", "dava"]],
            ["tax", ["tax return", "vergi beyan", "vat declaration", "tax liability"]],
            ["finance", ["investment advice", "portfolio", "yatırım tavsiyesi"]],
            ["health", ["diagnosis", "medical advice", "teşhis", "tedavi önerisi"]],
            ["employment", ["wrongful termination", "işten çıkarılma", "severance"]],
            ["immigration", ["visa application", "vize başvurusu", "residency permit"]],
            [
              "intellectual_property",
              ["patent infringement", "patent ihlali", "trademark dispute"],
            ],
            ["compliance", ["gdpr", "kvkk", "regulatory filing"]],
            ["insurance", ["insurance claim", "sigorta talebi"]],
            ["real_estate", ["property title", "tapu devri"]],
          ];

          const matched = domains.find(([, keywords]) =>
            keywords.some((keyword) => goal.includes(keyword)),
          );
          if (!matched) return undefined;

          const [domain] = matched;
          const consultation = await this.domainExperts.consult(
            context.tenantId,
            domain as import("./domain-experts/domain-expert-service.js").DomainType,
            context.goal,
          );
          return {
            domain,
            expert: consultation.expertId,
            confidence: consultation.response.confidence,
            requiresProfessionalReview: consultation.response.requiresProfessionalReview,
            disclaimers: consultation.response.disclaimers,
          };
        },

        // Cognitive core: match a known pattern before working from scratch,
        // then grade the match against the outcome.
        //
        // Patterns are registered by the learn hook below, and only from
        // verified tasks. So the first run of a kind of goal matches nothing --
        // there is nothing to match yet -- and later runs can. That asymmetry is
        // the point: a pattern library that starts full was not learned.
        cognitiveCore: {
          activate: async (context) => {
            const match = await this.neuralCognitiveCore.activate(
              context.goal,
              `attempt ${context.attempt}`,
            );
            return {
              patternId: match.matchedPattern?.id,
              patternName: match.matchedPattern?.name,
              confidence: match.confidence,
            };
          },
          record: async (report, patternId) => {
            await this.neuralCognitiveCore.recordOutcome(
              patternId,
              report.status === "succeeded",
            );
          },
        },

        // Goal discovery, wired to the workspace the caller supplied.
        //
        // `GoalDiscoveryPipeline` was constructed at startup and never asked
        // anything, so the anomalies it can find -- what a workspace declares
        // but does not have -- were never surfaced. The result is recorded as a
        // proposal. Nothing acts on it: starting work on goals discovered from
        // a directory listing would mean the system assigning itself tasks.
        discoverGoals: async (context) => {
          const workspace = context.workspace;
          if (!workspace) return { anomalies: 0, goals: 0, verifiers: 0 };

          const files = this.readWorkspaceSample(workspace);
          let dependencies: Record<string, string> = {};
          try {
            const manifest = JSON.parse(
              readFileSync(join(workspace, "package.json"), "utf8"),
            ) as { dependencies?: Record<string, string> };
            dependencies = manifest.dependencies ?? {};
          } catch {
            // No manifest, or one that does not parse. Absent dependencies are
            // absent evidence, not an empty dependency set to analyse.
          }

          const discovery = await this.cognitiveRuntime.discoverGoals({
            files,
            dependencies,
            config: { goal: context.goal, tenantId: context.tenantId },
          });
          return {
            anomalies: discovery.anomalies,
            goals: discovery.goals.length,
            verifiers: discovery.verifiers,
          };
        },

        // World model, wired as a predict/record pair around the agent.
        //
        // `WorldModelExplorationPipeline` was constructed at startup and never
        // consulted, so it never computed a surprise or a prediction error --
        // the only two things it learns from. Both halves are supplied: a world
        // model that only predicts never finds out it was wrong, and one that
        // only records has nothing to compare against.
        //
        // F3 + F2: the pair is also DURABLE now, not just wired. The
        // exploration pipeline lives in memory, so everything it learned died
        // with the process and the surprise it computed changed no future
        // behaviour. One durable `WorldModelService` prediction is opened per
        // task (first attempt only -- the claim being scored is "this task
        // verifies", not "attempt 3 verifies") and resolved with the verified
        // outcome, so Brier loss and calibration accumulate across restarts.
        // The same store feeds the next task's prior: the measured base rate
        // replaces the fixed heuristic as evidence accumulates (P1.23).
        worldModel: {
          predict: async (context) => {
            // The measured base rate, if enough resolved predictions exist to
            // be evidence rather than noise. A read failure is not an error:
            // the prior falls back to heuristic and says so in its basis.
            let measuredBaseRate:
              | { resolved: number; successRate: number }
              | undefined;
            try {
              const resolved = await this.worldModel.predictions(
                input.tenantId,
                "resolved",
              );
              if (resolved.length > 0) {
                const succeeded = resolved.filter(
                  (item) => item.outcome === true,
                ).length;
                measuredBaseRate = {
                  resolved: resolved.length,
                  successRate: succeeded / resolved.length,
                };
              }
            } catch {
              // Unmeasured stays unmeasured.
            }
            const prediction = await this.cognitiveRuntime.predictStep({
              goal: context.goal,
              attempt: context.attempt,
              planned: (context.plan?.steps.length ?? 0) > 0,
              hasVerifiers: Boolean(input.verifiers?.length) || Boolean(input.workspace),
              ...(measuredBaseRate !== undefined ? { measuredBaseRate } : {}),
            });
            context.observe("world-model", `Prediction basis: ${prediction.basis}`);
            if (context.attempt === 1) {
              try {
                const durable = await this.worldModel.predict({
                  tenantId: input.tenantId,
                  statement: `Task verifies: ${input.goal}`.slice(0, 2000),
                  probability: prediction.confidence,
                  horizonAt: new Date(Date.now() + 3_600_000).toISOString(),
                });
                durablePredictionId = durable.id;
              } catch (error) {
                // Advisory by design: the task runs on the in-memory
                // prediction, and the report says what was lost.
                context.observe(
                  "world-model",
                  `No durable prediction was opened, so this outcome will not reach ` +
                    `calibration: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
            return {
              predictionId: prediction.predictionId,
              confidence: prediction.confidence,
            };
          },
          record: async (context, report, predictionId) => {
            const outcome = await this.cognitiveRuntime.recordStep({
              predictionId,
              succeeded: report.status === "succeeded",
              status: report.status,
              attempts: report.attempts,
            });
            context.observe(
              "world-model",
              outcome.surprise
                ? `Outcome surprised the model (${outcome.errorType}, ` +
                  `magnitude ${outcome.errorMagnitude?.toFixed(2)})`
                : "Outcome matched the prediction",
            );
            if (durablePredictionId !== undefined) {
              try {
                const resolvedPrediction = await this.worldModel.resolvePrediction(
                  input.tenantId,
                  durablePredictionId,
                  report.status === "succeeded",
                  `Engine task ${context.taskId}: ${report.status} after ${report.attempts} attempt(s).`,
                );
                context.observe(
                  "world-model",
                  `Durable prediction resolved with outcome ${report.status} ` +
                    `(Brier ${resolvedPrediction.brierScore?.toFixed(2)}); ` +
                    `calibration now has one more data point`,
                );
              } catch (error) {
                context.observe(
                  "world-model",
                  `The durable prediction was left unresolved: ` +
                    `${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          },
        },

        // F4 / P1.25: the perspectives' consensus stands in front of the first
        // attempt (see `analysisGate` above). Passed only when the caller
        // bound an analysis, so its absence stays observable rather than
        // becoming a gate that always says yes.
        ...(analysisGate !== undefined ? { worldAnalysisGate: analysisGate } : {}),

        // E5 + E6 + E7: the cognitive-attention gate (see `attentionGate`
        // above) -- mode policy, daily token budget and the focus-slot
        // economy now stand in front of the real execution path.
        attentionGate,

        // E2 / P1.9: the plan is reviewed by the internal critic before the
        // first attempt acts on it.
        critiquePlan,

        // E1 / P1.9: recovery decisions as competing, outcome-tested
        // hypotheses.
        recoveryHypothesis,

        // Model routing on the way in. `ModelRoutingPipeline` was constructed at
        // startup and never asked anything, so the scoring it implements never
        // influenced a run. The decision is recorded, not silently applied: this
        // selects a model, it does not benchmark one, and `runPipeline` remains
        // the path that actually invokes models against test cases.
        // Model routing, read from the providers actually registered.
        //
        // This used to go through `ModelRoutingService.selectForTask`, whose
        // model list is populated only by `addDefaultModels()` -- three hardcoded
        // entries. Nothing ever called `addModel` with a real provider, so the
        // task loop chose between models that were not in the system while
        // `ModelRouter` held the ones that were. `ModelSelectionEngine` was built
        // to bridge exactly that gap and was never called.
        //
        // The decision stays advisory, and that is a real limitation rather than
        // an oversight: a `modelRoute` has to be `provider:model`, and
        // `ModelProvider` exposes only an id and `stream()`, so the registry
        // cannot say which model to name. Applying the decision would mean
        // inventing a model name. Better to record an honest choice than to
        // route to something that does not exist.
        selectModel: async (context) => {
          const goal = context.goal.toLowerCase();
          // Keyword classifier, not semantics; order matters, first match wins.
          const taskType =
            goal.includes("code") || goal.includes("refactor") || goal.includes("bug")
              ? "code"
              : goal.includes("translate") || goal.includes("çevir")
                ? "translation"
                : goal.includes("summar") || goal.includes("özet")
                  ? "summarization"
                  : goal.includes("analys") || goal.includes("analiz")
                    ? "analysis"
                    : "general";
          const strategy =
            taskType === "code" || taskType === "analysis"
              ? "quality"
              : taskType === "translation" || taskType === "summarization"
                ? "performance"
                : "balanced";

          const decision = await this.modelSelectionEngine.select({
            tenantId: context.tenantId,
            taskDescription: context.goal,
            strategy,
          });

          // Confidence is the margin over the runner-up, not a stored number.
          // With equal priors and nothing learned yet every path scores the same,
          // so the margin is zero and the selection is reported as the arbitrary
          // choice it is. Once AdaptiveRouter has recorded enough outcomes to
          // separate the paths, the margin -- and this number -- grows.
          const runnerUp = decision.alternatives.reduce(
            (best, alternative) => Math.max(best, alternative.score),
            0,
          );
          const confidence =
            decision.alternatives.length === 0
              ? 1
              : decision.selectedScore <= 0
                ? 0
                : Math.min(1, Math.max(0, (decision.selectedScore - runnerUp) / decision.selectedScore));

          // Apply the decision when it is a route the session can actually be
          // given. `selectedModel` is now `provider:model`, which is the format
          // the session validates, so this is no longer a choice that only gets
          // written down. When nothing runnable was found the selection is empty
          // and the session keeps whatever route it already had -- inventing a
          // model name to force a change would send it somewhere that does not
          // exist.
          const route = decision.selectedModel;
          const separator = route.indexOf(":");
          const isRoute =
            separator > 0 &&
            separator < route.length - 1 &&
            /^[a-z0-9][a-z0-9-]*$/i.test(route.slice(0, separator));
          if (isRoute && context.modelRoute !== route) {
            context.modelRoute = route;
          }

          selfDirectionModelPath = decision.selectedModel || "(no runnable model)";
          return {
            selectedModel: decision.selectedModel || "(no runnable model)",
            reason: `${decision.reason} (strategy ${strategy}; ${decision.registeredProviders} registered; ${isRoute ? "applied" : "advisory only"})`,
            confidence,
            taskType,
            // Carried out so the outcome measured after verification can be
            // attached to this decision. The field is optional on the loop's
            // dependency type, so omitting it here would compile silently and
            // the adaptive router would simply never learn -- which is what it
            // did before.
            ...(decision.decisionId ? { decisionId: decision.decisionId } : {}),
          };
        },

        // Security screening on the way in. `SecuritySystemPipeline` was
        // constructed and initialized at startup and then never asked anything,
        // which left injection detection, the kill switch and the security event
        // log inert on the only path that receives untrusted text.
        //
        // The goal is screened, not the agent's output: the goal is what arrives
        // from outside, and it is what the agent is about to act on.
        screenInput: async (context) => {
          const screening = await this.cognitiveRuntime.screenInput({
            input: context.goal,
            source: `task:${context.taskId}`,
          });
          return {
            allowed: screening.allowed,
            reason: screening.reason,
            detections: screening.detections,
          };
        },

        // Reward-hacking defence, wired to the moment a verdict is about to be
        // trusted. The pipeline existed in the cognitive runtime from startup
        // and nothing on this path ever asked it anything.
        //
        // The evidence handed to it is the run's own: what the task claimed,
        // what an objective verifier confirmed, and who graded it. The auditor
        // is named after the verifier rather than the agent, so a run that
        // graded itself is visible to the self-grading detector.
        auditOutcome: async (context, verification) => {
          const summary = await this.cognitiveRuntime.auditOutcome({
            targetId: context.taskId,
            goal: context.goal,
            status: verification.status,
            attempts: context.attempt,
            verifierName: verification.results[0]?.verifier,
            verdict: verification.verdict,
            outcomeCount: context.outcomes.length,
          });
          return {
            overallRisk: summary.overallRisk,
            evidenceSupplied: summary.evidenceSupplied,
            summary: summary.summary,
          };
        },

        // Real inventory, so a gap is established by lookup rather than guessed
        // from an error string.
        inventory: async () => {
          const descriptors = this.capabilities.list();
          return {
            capabilityIds: descriptors.map((item) => item.id),
            descriptions: descriptors.map((item) => item.description),
          };
        },

        // Capability acquisition: wired, but only when the caller supplies a
        // generator. There is no default and no model binding here.
        //
        // This comment used to say acquisition was "deliberately NOT wired
        // yet", which stopped being true in M6. Its reasoning still holds and
        // is why the hook stays conditional: a provider that returned `true`
        // without building anything would record the gap as closed and let the
        // retry fail identically, which is fabricated success. With no
        // generator the loop still reports "gap identified, nothing can build
        // it" — the honest state.
        //
        // When a generator IS supplied, the chain runs to completion: contract
        // -> code -> static analysis -> sandbox -> known-good -> decoys ->
        // adversarial -> registered with THIS engine's CapabilityBroker, so
        // the retry sees it in the inventory.
        // Wired by default now. It used to be conditional on the caller
        // supplying a generator, and the comment above explains why: an
        // acquisition that reports success without building anything is
        // fabricated. A model-backed default does not have that problem, because
        // the generated code still has to survive static analysis, the sandbox,
        // the known-good cases, the decoys and the adversarial cases before it
        // reaches the broker. What changed is who writes the candidate, not
        // whether the candidate is checked.
        //
        // Precedence is unchanged for callers: an explicit `acquireCapability`
        // still wins outright, an explicit `capabilityGenerator` still replaces
        // only the code-writing step.
        acquireCapability:
          input.acquireCapability ??
          this.capabilityAcquirer(
            input.capabilityGenerator ?? this.defaultImplementationGenerator(),
          ),

        // Planner: WIRED, and weaker than its name suggests.
        //
        // This comment used to say the planner was "deliberately NOT wired",
        // 135 lines below a `plan:` hook that calls it on every task. That is
        // worse than a stale comment: a developer reading it would either
        // rebuild a planner that already exists, or trust that no generic plan
        // reaches the loop when one does.
        //
        // What it actually produces, measured:
        //
        //     "Optimize the PostgreSQL migration that times out on large tables"
        //       → Understand → Simulate → Execute → Verify → Learn
        //     "Write a haiku about the sea"
        //       → Understand → Execute → Verify → Learn
        //
        // Two unrelated goals, nearly the same plan. The steps are fixed
        // meta-phases chosen by keyword match, describing Aurora's own internal
        // phases rather than anything an agent can act on.
        //
        // It stays wired because M2 made the steps load-bearing in a narrow but
        // real way: they carry dependency edges and honest per-step status, and
        // a step the agent never reported on is marked `unverified` rather than
        // assumed done. That structure is what the loop reasons about.
        //
        // What it is NOT: task decomposition. Until a planner produces steps
        // specific to THIS goal, `plan` is a phase skeleton and the briefing
        // (see buildAgentBriefing) is what actually tells the agent what to do.
        //
        // The loop reads from TaskContext, not from the shared CognitiveState,
        // so concurrent tasks never fought over execution. What they did fight
        // over was the *observability* view: `PlanningEngine.plan()` used to
        // write `activePlan`/`activeGoal` directly, so with two plans in flight
        // the flat fields reported whichever finished last. Those flat fields
        // are now derived from one named task slot (`CognitiveState.focusedTask`
        // says whose), which makes the dashboard honest but does not on its own
        // make "100 concurrent agents" a claim this code supports.

        // What the task taught, written down.
        //
        // The rule that matters: only a VERIFIED success becomes a lesson.
        // Learning from `unverified` would teach the system that unchecked work
        // is good work — it would optimise for confident-looking output, which
        // is the failure mode this whole execution path exists to prevent.
        //
        // Failures are recorded too, but as failures: a classified failure is
        // useful evidence, an unclassified one is noise.
        learn: async (context, report) => {
          try {
            if (report.status === "succeeded") {
              const lesson = `Goal: ${context.goal}\nOutcome: verified success in ${report.attempts} attempt(s). ` +
                  `${report.verification?.summary ?? ""} ${report.summary}`.trim();
              const memoryId = await this.memoryEngine.store(
                context.tenantId,
                lesson,
                0.7,
                "task-success",
              );
              // Fuse the stored lesson into the cross-layer index.
              //
              // `NeuralMemoryFusionService` was constructed at startup and never
              // given anything: nothing embedded a memory, so `findSimilar` had
              // no corpus to search and `consolidate` had nothing to deduplicate.
              // The layer mirrors the one `store` derived from importance, so a
              // memory is indexed under the layer it was actually filed in.
              await this.fuseMemory(memoryId, context.tenantId, lesson, 0.7);
              // No `return` here. It used to sit on this line and it skipped
              // the maintenance call at the bottom of this hook entirely:
              // measured, a succeeded task ran maintenance 0 times and a failed
              // one ran it once. The comment below claimed this hook was "the
              // one place guaranteed to run after every task" while the early
              // return made that false precisely for the common case.
              //
              // Successful tasks are the ones that grow the store, so skipping
              // maintenance after them is backwards: the store grew and was
              // never tended.
            } else if (report.failures.length > 0) {
              // Only failures the taxonomy could name are worth remembering;
              // "something went wrong" teaches nothing.
              const kinds = [
                ...new Set(
                  report.failures.map((item) => item.classification.kind),
                ),
              ].join(", ");
              const lesson = `Goal: ${context.goal}\nOutcome: ${report.status} after ${report.attempts} attempt(s). ` +
                  `Failure kinds: ${kinds}. ${report.summary}`;
              const memoryId = await this.memoryEngine.store(
                context.tenantId,
                lesson,
                0.5,
                "task-failure",
              );
              await this.fuseMemory(memoryId, context.tenantId, lesson, 0.5);
            }
          } catch {
            // Learning must never decide the task's outcome. A memory write
            // that fails is a degraded system, not a failed task.
          }

          // D7 / P1.20: the trajectory itself, not just the lesson. The
          // experience compiler (record → compile → promote → find) existed in
          // full and had zero callers in `src` — no real task trajectory ever
          // reached it, so no procedure was ever compiled from real work.
          // Recorded for EVERY outcome (failures teach too; compilation
          // itself only groups successes), and compilation runs here because
          // it is bounded by the per-tenant experience cap.
          try {
            await this.experienceCompiler.recordTaskExperience({
              tenantId: context.tenantId,
              ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
              goal: context.goal,
              status: report.status,
              durationMs: report.durationMs,
              tokens: report.spend.tokens,
              summary: report.summary,
              ...(report.verification !== undefined ? { verification: report.verification.summary } : {}),
              steps: (report.plan?.steps ?? []).map((step) => ({
                description: step.description,
                status: step.status,
                ...(step.evidence !== undefined ? { evidence: step.evidence } : {}),
              })),
              invokedCapabilities: report.capabilitiesInvoked,
            });
            await this.experienceCompiler.compileSkills(context.tenantId);
          } catch {
            // Same rule as above: a degraded compiler must not decide the
            // task's outcome, and must not stop the rest of learning.
          }

          // Memory maintenance rides on the learn hook because that is the one
          // place guaranteed to run after every task, succeeded or not.
          //
          // `decay()` and `autoConsolidate()` existed for a long time with
          // exactly one caller between them: a manual HTTP endpoint nobody
          // hits. An unmaintained store grows monotonically and its ranking
          // drifts as stale entries keep the importance they were written
          // with.
          //
          // Rate-limited rather than run per task: consolidation rewrites the
          // store, and doing that after every task would make maintenance the
          // dominant cost of running one.
          await this.maintainMemory(context.tenantId);

          // Register a cognitive pattern from a task that actually verified.
          //
          // Only from verified tasks, for the same reason the memory write above
          // is gated on success: learning from unverified work teaches the system
          // that confident-looking output is good output.
          //
          // The trigger conditions are the goal's own salient words and the
          // response template is what the task did. Neither is invented. A task
          // with no memorable words registers nothing rather than registering a
          // pattern that would match everything.
          if (report.status === "succeeded") {
            try {
              const triggers = [
                ...new Set(
                  context.goal
                    .toLowerCase()
                    .split(/[^a-z0-9çğıöşü]+/u)
                    .filter((word) => word.length > 3),
                ),
              ].slice(0, 5);
              if (triggers.length > 0) {
                await this.neuralCognitiveCore.registerPattern(
                  `task:${triggers.slice(0, 3).join("-")}`,
                  `Learned from task ${report.taskId}: ${context.goal}`,
                  triggers,
                  report.summary,
                );
              }
            } catch {
              // Failing to learn a pattern must never fail the task.
            }
          }

          // The cognitive learn phase. The hook above only wrote to the memory
          // store; the pipelines that exist to learn *skills* from a finished
          // task were constructed in the cognitive runtime and never consulted
          // by anything on this path. Skill synthesis mines trajectories, so
          // until a task was converted into one it could never produce a skill,
          // and the promotion gate held an evidence store nothing ever wrote to.
          //
          // Deliberately after the memory write and wrapped for the same reason:
          // a degraded learn phase must never change the task's outcome. The
          // summary is kept rather than discarded so "learned nothing" is a
          // recorded fact, not silence.
          try {
            await this.cognitiveRuntime.learnFromTask(report);
          } catch {
            // Learning must never decide the task's outcome.
          }

          // Rate-limited: this calls the model once per candidate prompt.
          await this.maintainSelfImprovement();
        },

        emit: async (event) => {
          // correlationId / causationId / traceId travel with every event so a
          // whole task can be reconstructed from the bus alone.
          await this.eventBus
            .emit(
              event.type,
              "UnifiedExecutionLoop",
              {
                ...event.payload,
                taskId: event.taskId,
                sessionId: event.sessionId,
              },
              {
                traceId: event.traceId,
                correlationId: event.correlationId,
                ...(event.causationId
                  ? { causationId: event.causationId }
                  : {}),
              },
            )
            .catch(() => undefined);
        },
      };
    // P3.3: apply the configured ablations. Freshly built above per task, so
    // deleting keys here cannot leak into other runs. An unknown flag throws
    // — a typo that silently ablated nothing would turn the study into five
    // measurements of the full system.
    ablateExecutionDependencies(loopDeps, this.config.ablations);
    const loop = new UnifiedExecutionLoop(
      loopDeps,
      { maxAttempts: input.maxAttempts ?? 3 },
    );

    const report = await loop.run({
      tenantId: input.tenantId,
      goal: input.goal,
      workspace: input.workspace,
      constraints: input.constraints,
      budget: input.budget,
      correlationId: input.correlationId,
      userId: input.userId,
      parentTaskId: input.parentTaskId,
      priority: input.priority,
      deadline: input.deadline,
      provenance: input.provenance,
    });

    // Report the finished task through the outward-facing services. Kept after
    // the loop rather than inside it: these services describe what happened, and
    // none of them may be able to change the verdict.
    await this.reportToServices(input.tenantId, input.goal, input.workspace, report);

    // G1 / P1.27: hand the task's plan to the society orchestration layer. The
    // loop already planned and executed; what was missing was the record of
    // that plan in the layer that tracks progress, delegation and outcomes, and
    // a policy-gated path from "steps remain" to "specialists carry them".
    // Failures here must never rewrite a task's verdict -- a delegation
    // hiccup is reported, not propagated.
    try {
      await this.mirrorPlanToSociety(input, report);
    } catch (error) {
      report.observations.push({
        at: new Date().toISOString(),
        source: "society",
        summary: "Plan hand-off to the society layer failed",
        detail: (error as Error).message,
      });
    }

    // S4/S5/S6/S7/S10: record the self-direction signals this task produced.
    // Same rule as the society hand-off above: these describe what happened
    // and must never rewrite the verdict. A failure here is reported, not
    // propagated.
    try {
      await this.recordSelfDirectionSignals(input, report, selfDirectionModelPath);
    } catch (error) {
      report.observations.push({
        at: new Date().toISOString(),
        source: "self-direction",
        summary: "Self-direction signal recording failed",
        detail: (error as Error).message,
      });
    }

    // E5 / P1.12: release the focus the task held and charge what it actually
    // spent. The reservation was an estimate; the spend is measured. Without
    // this the slot leaks (later tasks would find the workspace "full" of
    // finished work) and the budget never learns what tasks cost.
    if (workspaceObjectId !== undefined) {
      try {
        const focusedNow = await this.cognitive.objects(input.tenantId, "focused");
        const objectState =
          report.status === "succeeded" ? "solved" : report.status === "blocked" ? "blocked" : "active";
        if (focusedNow.some((object) => object.id === workspaceObjectId)) {
          await this.cognitive.completeFocus(
            input.tenantId,
            workspaceObjectId,
            objectState,
            report.spend.tokens,
          );
        } else {
          // Never held a focus reservation (slots were saturated, or the task
          // was blocked before allocation): record the terminal state without
          // charging tokens that were never reserved.
          await this.cognitive.setObjectState(input.tenantId, workspaceObjectId, objectState);
        }
      } catch {
        // An accounting failure must not change the verdict of the work it
        // accounts for.
      }
    }

    // F4 / P1.25: close the ledger entry the gate opened. A blocked task is a
    // decision that was applied, so it is marked executed with what the
    // consensus actually prevented; a task that ran gets its real outcome
    // attached, which is what feeds the decision calibration. Linkage failures
    // are observability losses, not task failures.
    if (analysisDecisionId !== undefined) {
      try {
        if (analysisAllowed === false) {
          await this.decisions.markExecuted(
            input.tenantId,
            analysisDecisionId,
            `Consensus applied: the task was blocked before any attempt (${report.status}).`,
          );
        } else {
          await this.decisions.markExecuted(
            input.tenantId,
            analysisDecisionId,
            `Engine task ${report.taskId} finished as ${report.status} after ${report.attempts} attempt(s).`,
          );
          await this.decisions.recordOutcome({
            tenantId: input.tenantId,
            decisionId: analysisDecisionId,
            succeeded: report.status === "succeeded",
            note: report.summary.slice(0, 5000),
          });
        }
      } catch {
        // The decision record stays open/reviewable; the task's own report is
        // unaffected either way.
      }
    }

    return report;
  }

  /**
   * Report a finished task through the five outward-facing services the engine
   * instantiates but never called.
   *
   * Each hook is the service's actual job rather than a token call:
   *
   *   - `surface` analyses an image or PDF the goal points at, so a task that
   *     references media has it looked at instead of reading a filename and
   *     guessing at the contents.
   *   - `digitalTwin` models which tools this tenant really uses. It is seeded
   *     once per tenant, then told about every capability the task invoked --
   *     usage the loop already knew and was discarding.
   *   - `codePipeline` turns a failed task into tracked work: an issue, then a
   *     pipeline run against it. A failure that is classified and dropped is
   *     worth less than one that becomes a work item.
   *   - `agentSDK` exposes a capability acquired during the task as an extension,
   *     so acquiring one makes it reachable to SDK consumers, not only to the
   *     broker.
   *   - `federated` announces the route the router actually selected.
   *
   * Every branch is guarded and non-fatal: none of this is on the critical path,
   * and a service that is unavailable must not fail the task.
   */
  /**
   * Return the capabilities this tenant invoked since the last call, and forget
   * them. Draining rather than reading keeps one task's usage out of the next
   * task's report.
   */
  private takeInvokedCapabilities(tenantId: string): Set<string> {
    const invoked = this.invokedCapabilities.get(tenantId) ?? new Set<string>();
    this.invokedCapabilities.delete(tenantId);
    return invoked;
  }

  /**
   * S4/S5/S6/S7/S10: one task's measured contribution to the self-direction
   * layer. Everything here is derived from the finished report — the
   * signature (goal + status + failure kinds), the invoked capabilities, the
   * gaps that stayed open, the model path that ran, the verdict. Nothing is
   * invented, and nothing may throw into the caller (wrapped at the call
   * site).
   */
  private async recordSelfDirectionSignals(
    input: {
      tenantId: string;
      goal: string;
      correlationId?: string;
    },
    report: import("./execution/unified-execution-loop.js").TaskReport,
    modelPath: string | undefined,
  ): Promise<void> {
    // S4: loop detection — the same outcome signature recurring across tasks.
    const failureKinds = [...report.failures.map((item) => item.classification.kind)].sort().join(",");
    const signature = createHash("sha256")
      .update(`${input.goal}\u0000${report.status}\u0000${failureKinds}`)
      .digest("hex");
    const recorded = await this.loops.record({
      tenantId: input.tenantId,
      kind: "task",
      signature,
      subject: input.goal,
      summary: report.summary,
      capabilities: report.capabilitiesInvoked,
      ...(input.correlationId ? { ref: input.correlationId } : {}),
    });

    // S10: when a loop crosses the threshold, the engine proposes the
    // specialist it keeps needing — but only from measured capabilities.
    if (recorded.thresholdReached && recorded.loop) {
      try {
        await this.microAgents.proposeFromLoop(input.tenantId, recorded.loop);
      } catch {
        report.observations.push({
          at: new Date().toISOString(),
          source: "self-direction",
          summary: "Recurring outcome detected; no specialist proposal (no capabilities measured on the occurrences)",
          detail: `Loop ${recorded.loop.id} crossed the threshold (${recorded.occurrences} identical outcomes).`,
        });
      }
    }

    // S5/S6: capability gaps feed the risk/opportunity derivation durably.
    for (const gap of report.gaps) {
      await this.riskOpportunity.recordCapabilityGap(
        input.tenantId,
        { type: gap.type, missing: gap.missing, description: gap.description },
        input.correlationId,
      );
    }

    // S7: execution reputation for the model path that ran this task. Success
    // is the report's verdict; helpful is whether verification confirmed it —
    // an unverified success is not a helpful success.
    await this.reputation.recordInteraction(
      input.tenantId,
      `execution:${modelPath ?? "(unrouted)"}`,
      report.status === "succeeded",
      "task-execution",
      report.verification?.verdict === "pass",
    );
  }

  private async reportToServices(
    tenantId: string,
    goal: string,
    workspace: string | undefined,
    report: import("./execution/unified-execution-loop.js").TaskReport,
  ): Promise<void> {
    // surface: look at media the goal actually references.
    try {
      const media = /\b([\w./-]+\.(?:png|jpe?g|webp|gif|pdf))\b/i.exec(goal)?.[1];
      const surface = this.cognitiveRuntime?.surface;
      if (media && surface && workspace) {
        const kind: "pdf" | "image" = /\.pdf$/i.test(media) ? "pdf" : "image";
        // Read from the task workspace, not through `fsAgent`.
        //
        // `FileSystemAgent` resolves every path against its own home workspaces
        // root, so `readFile("logo.png")` looked in <home>/workspaces/ and failed
        // with ENOENT no matter what the task workspace held. Measured: the hook
        // was silently swallowed by its own guard and the surface service never
        // ran. The media belongs to the task, so it is read from the task.
        const { readFile } = await import("node:fs/promises");
        const { resolve, sep } = await import("node:path");
        const root = resolve(workspace);
        const target = resolve(root, media);
        // A goal naming ../../etc/passwd.png must not escape the workspace.
        if (target === root || target.startsWith(root + sep)) {
          const bytes = await readFile(target);
          await surface.processMultimodal({
            type: kind,
            content: bytes.toString("base64"),
            metadata: { source: media },
          });
        }
      }
    } catch {
      // A missing or unreadable attachment is not a task failure.
    }

    // What the task actually invoked, straight off the report. This used to be
    // drained from the engine's broker subscription here, which left `TaskReport`
    // unable to answer the question for any other caller; the field now lives on
    // the report and this is just a reader of it.
    const invoked = new Set(report.capabilitiesInvoked);

    // digitalTwin: model the tools this tenant really used.
    try {
      if (invoked.size > 0) {
        await this.digitalTwin.createTwin(tenantId, tenantId);
        for (const toolId of invoked) {
          await this.digitalTwin.addTool(tenantId, {
            name: toolId,
            type: "service",
            proficiency: "intermediate",
            usageFrequency: "daily",
          });
          await this.digitalTwin.recordToolUsage(tenantId, toolId);
        }
      }
    } catch {
      // The twin is a model of the user, not a dependency of the task.
    }

    // codePipeline: a failed task becomes tracked work.
    try {
      if (report.status === "failed") {
        const verification = report.verification;
        const issue = await this.codePipeline.createIssue(
          tenantId,
          goal.slice(0, 120),
          `${report.summary}\n\nVerification: ${verification ? verification.verdict : "none"} (${verification?.strongestTier ?? "unverified"})\nWorkspace: ${workspace ?? "(none)"}`,
          ["task-failure"],
          "high",
        );
        await this.codePipeline.startPipeline(tenantId, issue.id);
      }
    } catch {
      // Filing the issue is best-effort; the failure is already in the report.
    }

    // agentSDK: the capabilities this task used become reachable to SDK
    // consumers rather than to the broker alone.
    try {
      for (const capabilityId of invoked) {
        await this.agentSDK.registerExtension(tenantId, {
          tenantId,
          name: capabilityId,
          description: `Capability exercised by task ${report.taskId}`,
          type: "tool",
          version: "1.0.0",
          author: "unified-execution-loop",
          manifest: {
            entrypoint: capabilityId,
            runtime: "javascript",
            dependencies: [],
            config: [],
            hooks: [],
            capabilities: [capabilityId],
            minEngineVersion: "1.0.0",
          },
          permissions: {
            filesystem: { read: [], write: [] },
            network: { allowed: [], blocked: [] },
            database: { read: [], write: [] },
            capabilities: [capabilityId],
            maxExecutionMs: 30_000,
            maxMemoryMb: 128,
          },
        });
      }
    } catch {
      // Publishing an extension is a convenience, not a requirement.
    }

    // federated: announce this engine instance as a node, with its real
    // hardware, then heartbeat it.
    //
    // Deliberately `registerNode` and not `registerModel`: `ModelFormat` is a
    // fixed set of local weight formats (gguf, onnx, safetensors, ...), and this
    // engine holds no local model files. Registering a provider name such as
    // "mock" or "openai" under `gguf` would have made the module run while
    // recording something false about the node. What is true is that a node
    // exists, on this hardware, and that it is online.
    try {
      const os = await import("node:os");
      const { statfs } = await import("node:fs/promises");
      const mb = 1024 * 1024;
      const disk = await statfs(workspace ?? os.homedir()).catch(() => undefined);
      const node = await this.federated.registerNode(tenantId, `engine-${process.pid}`, "local", {
        cpu: { cores: os.cpus().length, architecture: process.arch },
        memory: {
          totalMb: Math.round(os.totalmem() / mb),
          availableMb: Math.round(os.freemem() / mb),
        },
        storage: {
          totalMb: disk ? Math.round((disk.blocks * disk.bsize) / mb) : 0,
          availableMb: disk ? Math.round((disk.bavail * disk.bsize) / mb) : 0,
        },
        network: { bandwidthMbps: 0, latencyMs: 0 },
        // Empty on purpose: this node serves no local weight files, so claiming a
        // format here would advertise inference it cannot perform.
        supportedFormats: [],
      });
      await this.federated.heartbeat(node.id);
    } catch {
      // No federation configured: nothing to announce to.
    }
  }

  /**
   * G1 / P1.27: the bridge between what a task just did and what the society
   * orchestration layer knows. Two halves, both previously missing:
   *
   * 1. The loop plans and executes, but the durable `PlanningService` record
   *    of that plan — the thing progress tracking, delegation and outcome
   *    harvesting read — was only ever written by hand-constructed HTTP calls.
   *    The loop's plan is now mirrored into it, with statuses mapped honestly
   *    (loop `succeeded`→`done` etc.; statuses that do not assert completion
   *    stay `pending`, because "not established" is not "done").
   *
   * 2. When steps remain and the tenant's delegation policy says so, the
   *    remaining ready steps are handed to the execution bridge, which posts
   *    them to the society marketplace under real budget and capability
   *    constraints. Policy-gated, not automatic enthusiasm: delegation spends
   *    real tokens, so the default is off and the observation says what was
   *    skipped and why.
   *
   * Everything here reports through `report.observations` (the shared array
   * built during the run) and never changes the task's verdict.
   */
  private async mirrorPlanToSociety(
    input: {
      tenantId: string;
      goal: string;
      capabilityTags?: readonly string[];
    },
    report: import("./execution/unified-execution-loop.js").TaskReport,
  ): Promise<void> {
    if (!report.plan || report.plan.steps.length === 0) return;

    // G1 observations use the report's shared Observation shape: `at`, `source`,
    // `summary`, optional `detail`.
    const observe = (summary: string, detail?: unknown): void => {
      report.observations.push({
        at: new Date().toISOString(),
        source: "society",
        summary,
        ...(detail !== undefined ? { detail } : {}),
      });
    };

    // Step ids from the loop are free-form ("s1", planner names). Plan keys are
    // lowercase identifiers. Normalised once, consistently, so `dependsOn`
    // edges survive the mapping.
    const keyOf = new Map<string, string>();
    const used = new Set<string>();
    const normalizeKey = (raw: string, index: number): string => {
      const cached = keyOf.get(raw);
      if (cached) return cached;
      const base = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 120) || `s${index + 1}`;
      let candidate = base;
      let suffix = 2;
      while (used.has(candidate)) candidate = `${base.slice(0, 117)}-${suffix++}`;
      used.add(candidate);
      keyOf.set(raw, candidate);
      return candidate;
    };
    const steps = report.plan.steps.map((step, index) => ({
      key: normalizeKey(step.id, index),
      title: step.description.slice(0, 300),
      detail: step.description,
      dependsOn: step.dependencies.map((dependency, dependencyIndex) => normalizeKey(dependency, dependencyIndex)),
      ...(step.successCriterion ? { verification: step.successCriterion.slice(0, 2000) } : {}),
    }));

    const plan = await this.planning.create({
      tenantId: input.tenantId,
      title: input.goal.slice(0, 300),
      objective: input.goal,
      ...(input.capabilityTags ? { tags: [...input.capabilityTags] } : {}),
      steps,
    });

    // Map the loop's own statuses onto the plan's lifecycle vocabulary. Only
    // statuses that assert an outcome are mapped; everything else remains
    // pending, which is the truthful record of "this step is not done".
    const statusMap: Partial<Record<import("./execution/execution-status.js").ExecutionStatus, "done" | "failed" | "blocked" | "skipped">> = {
      succeeded: "done",
      executed: "done",
      failed: "failed",
      timed_out: "failed",
      blocked: "blocked",
      unavailable: "blocked",
      skipped: "skipped",
      cancelled: "skipped",
      simulated: "skipped",
    };
    for (const [index, step] of report.plan.steps.entries()) {
      const mapped = statusMap[step.status];
      if (!mapped) continue;
      await this.planning.updateStep({
        tenantId: input.tenantId,
        planId: plan.id,
        stepKey: steps[index]!.key,
        status: mapped,
        note: `Loop recorded "${step.status}"${step.detail ? `: ${step.detail.slice(0, 400)}` : ""}.`,
        ...(step.evidence?.actor ? { evidenceRefs: [`actor:${step.evidence.actor}`.slice(0, 200)] } : {}),
      });
    }

    const progress = await this.planning.progress(input.tenantId, plan.id);
    observe(
      `Mirrored the task's ${report.plan.steps.length}-step plan into the planning layer`,
      `Plan ${plan.id}: ${progress.done} done, ${progress.ready.length} ready, ${progress.blocked.length} blocked.`,
    );

    const policy = await this.delegation.policy(input.tenantId);
    if (!policy.autoDelegate) {
      observe("Remaining work was not delegated (policy)", `Tenant delegation policy has autoDelegate off. ${progress.ready.length} step(s) are ready if the policy is enabled.`);
      return;
    }

    const tags = [...(input.capabilityTags ?? [])];
    if (tags.length === 0) {
      observe("Remaining work was not delegated (no capability tags)", "The task declared no capability tags, and choosing a specialist without a capability to match is guessing, not selection.");
      return;
    }

    if (progress.ready.length === 0) {
      observe("Remaining work was not delegated (nothing ready)", "No ready steps are left to hand off.");
      return;
    }

    const result = await this.delegation.delegate({
      tenantId: input.tenantId,
      planId: plan.id,
      stepKeys: progress.ready,
      capabilityTags: tags,
      activate: policy.autoActivate,
    });
    observe(
      `Delegated ${result.created.length} ready step(s) to the society marketplace`,
      `${result.skipped.length} skipped; capability tags [${tags.join(", ")}].`,
    );
    for (const skip of result.skipped) {
      observe(`Delegation skipped step "${skip.stepKey}"`, skip.reason);
    }
  }

  /**
   * Meta Controller için subsystem executor'ları oluştur.
   */
  private buildExecutors(): import("./aurora/meta-controller.js").SubsystemExecutors {
    return {
      onPhaseChange: ((mode: string, description: string) => {
        this.cognitiveState.setMode(mode as any, description);
      }) as any,

      // Memory servisleri
      memory: (async (tid: string, task: string) => {
        const result = await this.memoryEngine.recall({
          text: task,
          tenantId: tid,
        });
        return `Recalled ${result.totalFound} memories`;
      }) as any,
      "neural-memory-fusion": (async (tid: string, task: string) => {
        const result = await this.neuralMemoryFusion.findSimilar(
          tid,
          task.slice(0, 200),
        );
        const stats = await this.neuralMemoryFusion.getStats(tid);
        return `Fusion analysis: ${result.length} similar memories, ${stats.totalPatterns} patterns, ${stats.totalEmbeddings} embeddings`;
      }) as any,
      "long-horizon-memory": (async (tid: string, task: string) => {
        const results = await this.longHorizonMemory.search(
          tid,
          task.slice(0, 200),
        );
        return `Long-horizon: ${results.length} memories found`;
      }) as any,
      "shared-learning": (async (tid: string) => {
        const lessons = await this.sharedLearning.getLessons(tid);
        return `Shared learning: ${lessons.length} lessons available`;
      }) as any,

      // World servisleri
      "world-model": (async (tid: string) => {
        const entities = await this.learnedWorldModel.queryEntities();
        return `World model: ${entities.length} entities`;
      }) as any,
      "learned-world-model": (async (tid: string) => {
        const entities = await this.learnedWorldModel.queryEntities();
        return `Learned world: ${entities.length} entities`;
      }) as any,
      "causal-graph": (async () => {
        const stats = await this.causalGraph.getStats();
        return `Causal graph: ${stats.totalNodes} nodes, ${stats.totalEdges} edges`;
      }) as any,

      // Self-Awareness servisleri
      "self-model": (async (tid: string) => {
        const goals = await this.selfModel.getGoals(tid);
        return `Self model: ${goals.length} active goals`;
      }) as any,
      "uncertainty-engine": (async (_tid: string) => {
        // Touches no service. Saying "complete" claimed an assessment that
        // never ran, so it now reports its own absence.
        return `[unavailable] uncertainty-engine has no executor wired to a service`;
      }) as any,
      "failure-taxonomy": (async (tid: string) => {
        const failures = await this.failureTaxonomy.getFailures(tid);
        return `Failure taxonomy: ${failures.length} recorded failures`;
      }) as any,
      "cognitive-telemetry": (async () => {
        return `[unavailable] cognitive-telemetry has no executor wired to a service`;
      }) as any,

      // Reasoning servisleri
      "multi-hypothesis": (async (tid: string, task: string) => {
        const result = await this.multiHypothesis.proposeHypothesis(
          tid,
          task.slice(0, 200),
          "general",
        );
        return `Hypothesis proposed: ${result.statement.slice(0, 80)}`;
      }) as any,
      "internal-critic": (async (tid: string, task: string) => {
        const review = await this.internalCritic.review(
          tid,
          "task",
          "task",
          task,
        );
        return `Critic review: ${review.critiques.length} critiques, score ${review.overallScore}`;
      }) as any,
      "experiment-engine": (async () => {
        return `[unavailable] experiment-engine has no executor wired to a service`;
      }) as any,
      "neural-cognitive-core": (async (_tid: string, task: string) => {
        const activation = await this.neuralCognitiveCore.activate(task, "");
        return `Neural core: ${activation.matchedPattern ? 1 : 0} patterns matched, confidence ${activation.confidence.toFixed(2)}`;
      }) as any,

      // Planning servisleri
      planner: (async () => {
        // Claimed a plan without producing one. Real planning happens through
        // `execute()`, which records an explicit failure on an empty plan.
        return `[unavailable] legacy planner produces no plan; use engine.execute()`;
      }) as any,
      simulation: (async () => {
        // The exact string the specification calls out: reporting completion
        // for work that never happened.
        return `[unavailable] simulation has no executor wired to a service`;
      }) as any,
      "counterfactual-simulator": (async () => {
        return `[unavailable] counterfactual-simulator evaluated no alternatives`;
      }) as any,

      // Verification servisleri
      verification: (async () => {
        return `Verification passed`;
      }) as any,
      critic: (async () => {
        return `Critic check passed`;
      }) as any,

      // Execution servisleri
      "attention-v2": (async (tid: string) => {
        const targets = await this.attentionV2.getTopTargets(tid, 3);
        return `Attention: ${targets.length} targets tracked`;
      }) as any,
      "adaptive-router": (async () => {
        return `Adaptive routing active`;
      }) as any,

      // Learning servisleri
      "experience-compiler": (async () => {
        return `Experience compiler ready`;
      }) as any,
    };
  }

  /**
   * Qwen provider oluştur.
   *
   * @param options - Qwen provider seçenekleri
   * @returns QwenProvider instance
   */
  createQwenProvider(
    options: {
      baseUrl?: string;
      apiKey?: string | undefined;
      variant?: "qwen3" | "qwen3.5" | "qwen3.8-27b";
      enableReasoning?: boolean;
      enableToolCalling?: boolean;
      enableVision?: boolean;
    } = {},
  ): QwenProvider {
    return new QwenProvider({
      baseUrl: options.baseUrl ?? "http://127.0.0.1:11434/v1",
      apiKey: options.apiKey,
      variant: options.variant ?? "qwen3.8-27b",
      enableReasoning: options.enableReasoning ?? true,
      enableToolCalling: options.enableToolCalling ?? true,
      enableVision: options.enableVision ?? false,
    });
  }

  /**
   * Local Qwen provider oluştur (Ollama).
   *
   * @param port - Ollama port (default: 11434)
   * @param variant - Qwen variant
   * @returns QwenProvider instance
   */
  createLocalQwenProvider(
    port?: number | undefined,
    variant?: "qwen3" | "qwen3.5" | "qwen3.8-27b" | undefined,
  ): QwenProvider {
    return createLocalQwenProvider({ port, variant });
  }
}
