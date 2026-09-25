# @haf/eval

Aurora Motor Engine evaluation framework with trajectory recording, difficulty scoring, and CI/CD integration.

## Features

- **Engine Eval** — Run tasks against Aurora engine
- **Trajectory Recording** — Record cognitive events during eval
- **Difficulty Scoring** — Weight tasks by difficulty level
- **Regression Detection** — Detect score regressions between runs
- **Performance Benchmarking** — Track execution times and bottlenecks
- **Cost Tracking** — Monitor token usage and costs
- **Quality Gates** — CI/CD integration with pass/fail gates
- **Continuous Monitoring** — Health checks and alerts
- **Auto-Recovery** — Circuit breaker and retry logic
- **A/B Testing** — Compare different configurations
- **Experiment Tracking** — Centralized experiment history

## Installation

```bash
npm install @haf/eval
```

## Quick Start

```typescript
import { runEngineEvalWithTrajectory } from '@haf/eval';

// Run full eval with all features
const result = await runEngineEvalWithTrajectory({
  maxTasks: 75,
  verbose: true,
  generateReport: true,
});

console.log(`Score: ${(result.overallScore * 100).toFixed(1)}%`);
```

## CLI Commands

```bash
# Full eval with trajectory recording
npx tsx packages/eval/src/runner/engine-eval-trajectory.ts --max-tasks 75

# Dashboard
npx tsx packages/eval/src/dashboard/eval-dashboard.ts

# Regression detection
npx tsx packages/eval/src/monitoring/regression-detector.ts

# Performance benchmark
npx tsx packages/eval/src/benchmarking/performance-benchmark.ts

# Cost tracking
npx tsx packages/eval/src/cost/cost-tracker.ts --model gpt-4

# Quality gates (CI/CD)
npx tsx packages/eval/src/quality/quality-gates.ts

# Continuous monitoring
npx tsx packages/eval/src/monitoring/continuous-monitor.ts

# Auto-recovery
npx tsx packages/eval/src/recovery/auto-recovery.ts

# A/B testing
npx tsx packages/eval/src/testing/ab-testing.ts

# Experiment tracking
npx tsx packages/eval/src/tracking/experiment-tracker.ts
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    ENGINE EVAL                           │
│         75 tasks × 11 categories × 5 difficulty        │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│         TRAJECTORY RECORDING                            │
│         EventBus → TrajectoryBridge → TrajectoryStore   │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│         ANALYSIS & SCORING                              │
│         Difficulty → Regression → Benchmark → Cost      │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│         QUALITY & RECOVERY                              │
│         Quality Gates → Auto-Recovery → Monitoring      │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│         TESTING & TRACKING                              │
│         A/B Testing → Experiment Tracking → Reports     │
└─────────────────────────────────────────────────────────┘
```

## Generated Reports

| Report | Description |
|--------|-------------|
| self-improvement-report.md | Category scores, service health |
| difficulty-analysis.md | Difficulty-based analysis |
| regression-report.md | Regression detection |
| benchmark-report.md | Performance benchmarking |
| cost-report.md | Cost tracking |
| quality-gate-report.md | CI/CD quality gates |
| monitor-report.md | Continuous monitoring |
| recovery-report.md | Auto-recovery |
| dashboard.md | Progress tracking |
| experiment-tracker-report.md | Experiment tracking |

## Configuration

```typescript
// Quality Gates configuration
const gates = {
  minScore: 0.95,           // 95% minimum score
  maxRegressions: 0,        // No regressions allowed
  maxBudgetUsd: 50,         // $50 max budget
  maxAvgDurationMs: 100,    // 100ms max avg duration
  minThroughput: 10,        // 10 tasks/sec minimum
  categoryGates: {
    security: { minScore: 1.0 },  // Security must be 100%
  },
};
```

## License

MIT
