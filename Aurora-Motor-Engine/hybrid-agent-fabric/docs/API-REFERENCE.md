# Aurora Motor Engine — API Reference

## Overview
- **Total Endpoints:** 130
- **Base URL:** `/v1`
- **Content-Type:** `application/json`

## Authentication
All endpoints require a `tenantId` query parameter or body field for tenant isolation.

## Pagination
List endpoints support pagination with `page` and `pageSize` query parameters.
Response format: `{ data: [...], pagination: { page, pageSize, total, totalPages, hasNext, hasPrev } }`

---

## Adaptive Router

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/adaptive-router/stats` | Stats |
| `POST` | `/v1/adaptive-router/route` | Route |

## Attention V2

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/attention-v2/stats` | Stats |
| `GET` | `/v1/attention-v2/targets` | Targets |
| `POST` | `/v1/attention-v2/allocate` | Allocate |
| `POST` | `/v1/attention-v2/target` | Target |

## Benchmarks

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/benchmarks/runs` | Runs |
| `GET` | `/v1/benchmarks/stats` | Stats |
| `POST` | `/v1/benchmarks/run` | Run |

## Budget

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/budget/status` | Status |

## Capabilities

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/capabilities/assessment` | Assessment |

## Causal

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/causal/impact` | Impact |

## Causal Graph

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/causal-graph/stats` | Stats |
| `POST` | `/v1/causal-graph/edge` | Edge |
| `POST` | `/v1/causal-graph/node` | Node |
| `POST` | `/v1/causal-graph/paths` | Paths |

## Cognitive

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/cognitive/reflection` | Reflection |
| `POST` | `/v1/cognitive/cycle` | Cycle |

## Cognitive State

`/v1/cognitive-state` returns a single most-recent-wins view, which is
ambiguous whenever more than one task is in flight. The per-task endpoints
answer the same question per task.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/cognitive-state` | Flat snapshot (last writer wins) |
| `GET` | `/v1/cognitive-state/history` | Mode change history |
| `POST` | `/v1/cognitive-state/reset` | Clear state and all task slots |
| `GET` | `/v1/cognitive-state/tasks` | Tasks currently running, each with its own goal/plan |
| `GET` | `/v1/cognitive-state/tasks/:taskId` | One task's record; `404` if the id is unknown |

## Cognitive Telemetry

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/cognitive-telemetry/cost` | Cost |

## Composition

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/composition/stats` | Stats |
| `POST` | `/v1/composition/component` | Component |
| `POST` | `/v1/composition/compose` | Compose |

## Constitution

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/constitution/why` | Why |

## Context

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/context/optimize` | Optimize |

## Critic

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/critic/reviews` | Reviews |
| `GET` | `/v1/critic/stats` | Stats |
| `POST` | `/v1/critic/resolve` | Resolve |
| `POST` | `/v1/critic/review` | Review |

## Dashboard

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/dashboard/metrics` | Metrics |

## Decisions

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/decisions/lifecycle` | Lifecycle |
| `POST` | `/v1/decisions/why` | Why |

## Economy

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/economy/trades` | Trades |
| `GET` | `/v1/economy/wallets` | Wallets |
| `POST` | `/v1/economy/trade` | Trade |
| `POST` | `/v1/economy/trade/:id/accept` | Accept |

## Experiments

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/experiments` | Experiments |
| `GET` | `/v1/experiments/stats` | Stats |
| `POST` | `/v1/experiments` | Experiments |
| `POST` | `/v1/experiments/:id/complete` | Complete |
| `POST` | `/v1/experiments/:id/result` | Result |
| `POST` | `/v1/experiments/:id/start` | Start |

## Explain

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/explain/full` | Full |

## Feedback

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/feedback/outcome` | Outcome |

## Goal Stack

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/goal-stack/active` | Active |
| `GET` | `/v1/goal-stack/metrics` | Metrics |
| `GET` | `/v1/goal-stack/tree` | Tree |
| `POST` | `/v1/goal-stack` | Goal Stack |
| `POST` | `/v1/goal-stack/:id/progress` | Progress |

## Goals

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/goals/why` | Why |

## Hypotheses

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/hypotheses/why` | Why |

## Learned World

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/learned-world/stats` | Stats |
| `POST` | `/v1/learned-world/entity` | Entity |
| `POST` | `/v1/learned-world/query` | Query |
| `POST` | `/v1/learned-world/relation` | Relation |
| `POST` | `/v1/learned-world/rule` | Rule |

## Learning

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/learning/effectiveness` | Effectiveness |
| `GET` | `/v1/learning/summary` | Summary |

## Long Horizon Memory

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/long-horizon-memory` | Long Horizon Memory |
| `GET` | `/v1/long-horizon-memory/stats` | Stats |
| `POST` | `/v1/long-horizon-memory` | Long Horizon Memory |
| `POST` | `/v1/long-horizon-memory/consolidate` | Consolidate |

## Marketplace

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/marketplace/search` | Search |
| `GET` | `/v1/marketplace/stats` | Stats |
| `POST` | `/v1/marketplace/list` | List |
| `POST` | `/v1/marketplace/request` | Request |

## Memory

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/memory/consolidate` | Consolidate |

## Meta Controller

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/meta-controller/why` | Why |

## Model Capabilities

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/model-capabilities` | Model Capabilities |
| `GET` | `/v1/model-capabilities/:modelId` | :Modelid |
| `GET` | `/v1/model-capabilities/stats` | Stats |
| `POST` | `/v1/model-capabilities` | Model Capabilities |
| `POST` | `/v1/model-capabilities/:modelId/benchmark` | Benchmark |
| `POST` | `/v1/model-capabilities/:modelId/outcome` | Outcome |
| `POST` | `/v1/model-capabilities/select` | Select |

## Models

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/models/orchestrate` | Orchestrate |

## Multi Hypothesis

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/multi-hypothesis` | Multi Hypothesis |
| `GET` | `/v1/multi-hypothesis/chains` | Chains |
| `GET` | `/v1/multi-hypothesis/evidence-graph` | Evidence Graph |
| `GET` | `/v1/multi-hypothesis/stats` | Stats |
| `POST` | `/v1/multi-hypothesis` | Multi Hypothesis |
| `POST` | `/v1/multi-hypothesis/:id/calibrate` | Calibrate |
| `POST` | `/v1/multi-hypothesis/:id/evidence` | Evidence |
| `POST` | `/v1/multi-hypothesis/:id/start-testing` | Start Testing |
| `POST` | `/v1/multi-hypothesis/reason` | Reason |
| `POST` | `/v1/multi-hypothesis/supersede` | Supersede |

## Neural Core

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/neural-core/stats` | Stats |
| `POST` | `/v1/neural-core/activate` | Activate |
| `POST` | `/v1/neural-core/pattern` | Pattern |

## Planner V2

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/planner-v2` | Planner V2 |
| `GET` | `/v1/planner-v2/stats` | Stats |
| `POST` | `/v1/planner-v2` | Planner V2 |
| `POST` | `/v1/planner-v2/:id/activate` | Activate |
| `POST` | `/v1/planner-v2/:id/step` | Step |

## Planning

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/planning/goal-driven` | Goal Driven |
| `POST` | `/v1/planning/why` | Why |

## Proactive

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/proactive/anticipate` | Anticipate |

## Reputation

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/reputation` | Reputation |
| `GET` | `/v1/reputation/stats` | Stats |
| `POST` | `/v1/reputation/endorse` | Endorse |
| `POST` | `/v1/reputation/interaction` | Interaction |

## Resources

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/resources/stats` | Stats |
| `POST` | `/v1/resources/allocate` | Allocate |
| `POST` | `/v1/resources/analyze` | Analyze |

## Risk

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/risk/assessment` | Assessment |

## Routing

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/routing/learn` | Learn |
| `POST` | `/v1/routing/smart` | Smart |
| `POST` | `/v1/routing/why` | Why |

## Search

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/search/unified` | Unified |

## Self Debugging

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/self-debugging/bugs` | Bugs |
| `GET` | `/v1/self-debugging/stats` | Stats |
| `POST` | `/v1/self-debugging/bug` | Bug |
| `POST` | `/v1/self-debugging/fix` | Fix |
| `POST` | `/v1/self-debugging/heal` | Heal |

## Self Model

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/self-model/awareness` | Awareness |
| `GET` | `/v1/self-model/gaps` | Gaps |

## Shared Learning

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/shared-learning` | Shared Learning |
| `GET` | `/v1/shared-learning/stats` | Stats |
| `POST` | `/v1/shared-learning` | Shared Learning |
| `POST` | `/v1/shared-learning/:id/adopt` | Adopt |

## Skills

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/skills/similar` | Similar |
| `POST` | `/v1/skills/transfer` | Transfer |

## Society

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/society/overview` | Overview |

## Strategy

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/strategy/recommendations` | Recommendations |

## Swarm

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/swarm` | Swarm |
| `GET` | `/v1/swarm/stats` | Stats |
| `POST` | `/v1/swarm` | Swarm |
| `POST` | `/v1/swarm/:id/member` | Member |
| `POST` | `/v1/swarm/:id/task` | Task |

## System

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/system/diagnosis` | Diagnosis |
| `GET` | `/v1/system/health` | Health |

