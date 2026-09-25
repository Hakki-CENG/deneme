# Aurora Motor Engine — P2 Feature Documentation

## Overview

This document describes the P2 (Phase 2) features implemented in the Aurora Motor Engine.

## Features

### 1. Cost Intelligence (`cognitive-telemetry.ts`)

Tracks token usage and cost across all operations.

**API Endpoints:**
- `GET /v1/cognitive-telemetry/cost` — Get cost statistics
- `GET /v1/budget/status` — Get budget status

**Key Methods:**
- `getCostStats(tenantId)` — Returns total cost, cost by model, cost by operation

### 2. Self-Healing (`self-debugging.ts`)

Automatically diagnoses and heals system issues.

**API Endpoints:**
- `POST /v1/self-debugging/heal` — Trigger self-healing

**Key Methods:**
- `selfHeal(tenantId, subsystem, symptoms)` — Diagnoses issues and provides healing steps

**Healing Steps:**
1. Diagnose — Analyze logs
2. Restart — Restart with clean state
3. Fallback — Enable fallback mode
4. Rollback — Rollback to last good state
5. Replace — Replace with alternative (critical only)

### 3. Explainability (30 services)

Every major service has a `why()` method that explains decisions.

**API Endpoints:**
- `POST /v1/decisions/why` — Explain a decision
- `POST /v1/routing/why` — Explain routing choice
- `POST /v1/planning/why` — Explain a plan
- `POST /v1/meta-controller/why` — Explain meta-decision
- `POST /v1/hypotheses/why` — Explain a hypothesis
- `POST /v1/goals/why` — Explain a goal
- `POST /v1/constitution/why` — Explain constitutional verdict

**Response Format:**
```json
{
  "entity": "Entity name",
  "summary": "Brief description",
  "rationale": ["Reason 1", "Reason 2"],
  "details": { ... }
}
```

### 4. Learned Routing (`adaptive-router.ts`)

Automatically improves routing based on past decisions.

**API Endpoints:**
- `POST /v1/routing/learn` — Auto-learn routing rules
- `POST /v1/routing/smart` — Smart route selection

**Key Methods:**
- `learnRoute(tenantId)` — Analyzes past decisions and creates/updates rules
- `smartRoute(tenantId, pattern)` — Selects best route based on learned rules

### 5. Memory Consolidation (`long-horizon-memory.ts`)

Automatically consolidates related memories.

**API Endpoints:**
- `POST /v1/memory/consolidate` — Trigger memory consolidation

**Key Methods:**
- `autoConsolidate(tenantId)` — Finds and consolidates related memories

### 6. Skill Transfer (`experience-compiler.ts`)

Transfers skills between agents/domains.

**API Endpoints:**
- `POST /v1/skills/transfer` — Transfer a skill
- `POST /v1/skills/similar` — Find similar skills

**Key Methods:**
- `transferSkill(skillId, targetTenantId, adaptation)` — Transfers skill with adaptation
- `findSimilarSkills(tenantId, tags)` — Finds skills matching tags

### 7. Proactive Intelligence (`self-model-service.ts`)

Anticipates user needs based on current state.

**API Endpoints:**
- `GET /v1/proactive/anticipate` — Get proactive suggestions

**Key Methods:**
- `anticipateNeeds(tenantId)` — Analyzes state and suggests actions

**Response includes:**
- Suggestions — Actions to take
- Risks — Potential issues
- Opportunities — Areas to explore

### 8. Causal Impact Analysis (`causal-graph.ts`)

Analyzes cause-effect relationships.

**API Endpoints:**
- `POST /v1/causal/impact` — Analyze impact of a node

**Key Methods:**
- `analyzeImpact(nodeId)` — Returns root causes, downstream effects, risk level

### 9. Context Optimization (`aurora-context-composer.ts`)

Optimizes context window usage.

**API Endpoints:**
- `POST /v1/context/optimize` — Get optimization recommendations

**Key Methods:**
- `optimizeContext(request)` — Returns optimization recommendations

### 10. Multi-Model Orchestration (`model-capability-registry.ts`)

Coordinates multiple LLMs for complex tasks.

**API Endpoints:**
- `POST /v1/models/orchestrate` — Select models for a task

**Key Methods:**
- `orchestrate(input)` — Selects best models based on capabilities

## Cross-Service Integration Endpoints

### System Health
- `GET /v1/system/health` — Aggregated health dashboard
- `GET /v1/system/diagnosis` — System self-diagnosis

### Cognitive Pipeline
- `POST /v1/cognitive/cycle` — Full cognitive cycle
- `POST /v1/feedback/outcome` — Record outcome and propagate learning
- `POST /v1/search/unified` — Search across all services
- `GET /v1/dashboard/metrics` — System-wide metrics

### Learning & Strategy
- `GET /v1/learning/summary` — Learning pipeline overview
- `GET /v1/learning/effectiveness` — Learning effectiveness metrics
- `GET /v1/strategy/recommendations` — Strategic recommendations
- `GET /v1/risk/assessment` — Risk assessment
- `GET /v1/cognitive/reflection` — Cognitive reflection

### Agent Society
- `GET /v1/society/overview` — Agent society overview
- `GET /v1/capabilities/assessment` — Capability assessment

## Testing

Run P2 tests:
```bash
cd packages/engine
npx vitest run test/p2-*.test.ts
```

Run endpoint tests:
```bash
cd apps/control-api
npx vitest run test/p2-endpoints.test.ts
```

## Metrics

- **Total Endpoints:** 725+
- **Services with getStats:** 42/50 (84%)
- **Services with why():** 30/50 (60%)
- **P2 Tests:** 33 passing
- **Endpoint Tests:** 14 passing
