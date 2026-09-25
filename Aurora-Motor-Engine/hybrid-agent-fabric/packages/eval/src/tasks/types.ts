/**
 * Eval Task Types
 * Defines the structure of evaluation tasks for Aurora.
 */

/** Task categories matching Aurora's cognitive layers */
export type EvalCategory =
  | "coding"          // Write, fix, refactor code
  | "tool_use"        // Use filesystem, git, browser, MCP
  | "memory"          // Recall, associate, consolidate
  | "planning"        // Plan, replan, handle dependencies
  | "recovery"        // Handle failures, find alternatives
  | "security"        // Refuse dangerous ops, detect injection
  | "reasoning"       // Multi-step reasoning, hypothesis testing
  | "multimodal"      // Image, audio, document understanding
  | "research"        // Search, verify, synthesize
  | "long_horizon"    // Multi-session, persistent goals
  | "capability_acquisition"; // Detect gap, synthesize capability

/** Grading method */
export type GradingMethod =
  | "command"    // Run a command and check exit code / output
  | "property"   // Check file exists, content matches, state changed
  | "judge"      // LLM judges the output
  | "human"      // Human reviews and grades
  | "trajectory" // Check that specific steps were taken
  | "composite"; // Multiple graders combined

/** Acceptance criteria */
export interface AcceptanceCriteria {
  type: GradingMethod;
  /** For "command": shell command to run */
  command?: string;
  /** For "command": expected exit code */
  exitCode?: number;
  /** For "command": output must contain */
  outputContains?: string[];
  /** For "command": output must NOT contain */
  outputNotContains?: string[];
  /** For "property": file must exist */
  fileExists?: string;
  /** For "property": file content regex */
  fileContentMatch?: string;
  /** For "property": file content must contain */
  fileContentContains?: string[];
  /** For "trajectory": required event kinds in order */
  requiredEvents?: string[];
  /** For "trajectory": forbidden event kinds */
  forbiddenEvents?: string[];
  /** For "composite": sub-graders */
  graders?: AcceptanceCriteria[];
  /** For "judge": rubric */
  rubric?: string;
  /** For "judge": minimum score (0-1) */
  minScore?: number;
}

/** Budget constraints */
export interface EvalBudget {
  maxTokens: number;
  maxSteps: number;
  maxCostUsd: number;
  timeoutMs: number;
}

/** A single evaluation task */
export interface EvalTask {
  /** Unique task ID */
  id: string;
  /** Category */
  category: EvalCategory;
  /** Human-readable name */
  name: string;
  /** Task instruction given to Aurora */
  instruction: string;
  /** Optional workspace setup (files to create, commands to run) */
  workspace?: WorkspaceSetup;
  /** Capabilities allowed for this task */
  allowedCapabilities?: string[];
  /** Acceptance criteria */
  acceptance: AcceptanceCriteria[];
  /** Budget constraints */
  budget: EvalBudget;
  /** Difficulty: 1-5 */
  difficulty: number;
  /** Tags for filtering */
  tags?: string[];
  /** Whether this task requires a model (vs pure tool use) */
  requiresModel?: boolean;
  /** Expected approximate steps (for metric comparison) */
  expectedSteps?: number;
  /** Expected approximate cost */
  expectedCostUsd?: number;
}

/** Workspace setup instructions */
export interface WorkspaceSetup {
  /** Files to create before task starts */
  files?: { path: string; content: string }[];
  /** Commands to run before task starts */
  setupCommands?: string[];
  /** Git repo to clone */
  gitRepo?: string;
  /** Git branch */
  gitBranch?: string;
}

/** Result of running an eval task */
export interface EvalResult {
  taskId: string;
  status: "pass" | "fail" | "error" | "timeout" | "budget_exceeded";
  score: number; // 0-1
  grades: GradeResult[];
  trajectory?: TrajectoryEvent[];
  metrics: TaskMetrics;
  error?: string | undefined;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

/** Individual grade result */
export interface GradeResult {
  criteria: GradingMethod;
  passed: boolean;
  score: number;
  details: string;
  evidence?: unknown;
}

/** Metrics for a single task run */
export interface TaskMetrics {
  totalTokens: number;
  totalCostUsd: number;
  totalSteps: number;
  toolCalls: number;
  toolFailures: number;
  replans: number;
  memoryRecalls: number;
  verificationAttempts: number;
  ttfbMs?: number; // Time to first byte
  tokensPerSecond?: number;
}

/** Trajectory event (simplified from engine's EventEnvelope) */
export interface TrajectoryEvent {
  sequence: number;
  kind: string;
  timestamp: string;
  source?: string;
  payload?: unknown;
}

/** Eval suite — a collection of tasks */
export interface EvalSuite {
  id: string;
  name: string;
  description: string;
  tasks: EvalTask[];
  /** Default budget for tasks that don't specify one */
  defaultBudget?: EvalBudget;
}

/** Summary of running a full suite */
export interface EvalSuiteResult {
  suiteId: string;
  totalTasks: number;
  passed: number;
  failed: number;
  errors: number;
  timeouts: number;
  overallScore: number; // weighted average
  results: EvalResult[];
  aggregateMetrics: TaskMetrics;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}
