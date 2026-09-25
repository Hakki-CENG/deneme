/**
 * Aurora Eval System
 * Task runner, graders, trajectory recorder and metrics for evaluating Aurora's capabilities.
 */

export * from "./tasks/types.js";
export * from "./runner/eval-runner.js";
export * from "./graders/grader.js";
export { TrajectoryRecorder, TrajectoryAnalyzer, TrajectoryStore, TrajectoryComparator } from "./trajectory/index.js";
export type { Trajectory, TrajectoryAnalysis, TrajectoryComparison, TrajectoryPattern } from "./trajectory/index.js";
export * from "./metrics/metrics.js";
export * from "./reports/report-generator.js";
export * from "./integration/index.js";
export { calculateDifficultyScore, loadTaskDifficulties, formatDifficultyReport, selectAdaptiveTasks } from "./scoring/difficulty-scorer.js";
export { detectRegressions, runRegressionDetection, formatRegressionReport, analyzeTrend, type Regression, type RegressionReport } from "./monitoring/regression-detector.js";
export { runBenchmark, formatBenchmarkReport, type BenchmarkReport, type BenchmarkResult, type Bottleneck } from "./benchmarking/performance-benchmark.js";
export { runCostTracking, formatCostReport, DEFAULT_PRICING, type CostReport, type CostEntry, type BudgetAlert } from "./cost/cost-tracker.js";
export { runQualityGates, formatQualityGateReport, DEFAULT_GATES, type QualityGateConfig, type QualityGateResult, type GateCheck } from "./quality/quality-gates.js";
export { runContinuousMonitor, checkHealth, generateMonitorReport, formatMonitorReport, type MonitorStatus, type MonitorAlert, type MonitorReport } from "./monitoring/continuous-monitor.js";
export { runAutoRecovery, attemptRecovery, analyzeFailure, generateRecoveryReport, formatRecoveryReport, DEFAULT_RECOVERY_CONFIG, type RecoveryConfig, type RecoveryAttempt, type CircuitBreakerState, type RecoveryReport } from "./recovery/auto-recovery.js";
export { runABTest, runABTestAnalysis, formatABTestReport, createSampleExperiment, loadABTestResults, type ExperimentConfig, type VariantConfig, type VariantResult, type ABTestResult, type ComparisonResult } from "./testing/ab-testing.js";
export { createExperiment, saveExperiment, loadExperiment, loadAllExperiments, updateExperimentStatus, addExperimentResults, compareExperiments, filterExperimentsByTag, getExperimentSummary, generateExperimentReport, runExperimentTracking, type Experiment, type ExperimentResults, type ExperimentComparison, type ExperimentSummary } from "./tracking/experiment-tracker.js";
export { runDocGeneration, generateReadme, generateModuleDoc, type DocSection, type ModuleDoc, type ExportDoc } from "./docs/doc-generator.js";
export { CORE_EVAL_TASKS, CORE_EVAL_SUITE, tasksByCategory, tasksByDifficulty, deterministicTasks, suiteSummary } from "./tasks/core-tasks.js";

// FAZ 1 gate (second half): proves acceptance criteria actually discriminate.
export {
  validateTask,
  validateCoreSuite,
  formatCriteriaValidationReport,
  type TaskValidation,
  type CriteriaValidationReport,
} from "./runner/criteria-validation.js";
export { REFERENCE_SOLUTIONS, type ReferenceSolution } from "./tasks/reference-solutions.js";

// FAZ 11 gate: Recall@k retrieval comparison.
export * from "./metrics/recall-metrics.js";

// FAZ 30 gate: "second encounter costs fewer steps".
export {
  evaluateLearningGate,
  evaluateFamily,
  formatLearningReport,
  type TaskEncounter,
  type LearningGateResult,
  type FamilyLearningResult,
  type LearningGateOptions,
} from "./metrics/learning-metrics.js";
