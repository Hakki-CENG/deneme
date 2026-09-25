# FAZ 4: Cognitive State + Event Bus — Durum Analizi

**Tarih:** 2026-09-17

---

## ✅ Zaten Mevcut Olan Altyapı

Planın istediği mimarinin **büyük çoğunluğu zaten var**:

### 1. CognitiveState Interface ✅
```typescript
// packages/engine/src/aurora/cognitive-state.ts
export interface CognitiveStateSnapshot {
  mode: CognitiveMode;           // idle/observing/reasoning/planning/executing/verifying/learning/recovering/consolidating
  activeGoal: ActiveGoal | null;
  activePlan: ActivePlan | null;
  activeHypotheses: ActiveHypothesis[];
  overallConfidence: ConfidenceLevel;
  resourceBudget: ResourceBudget;
  attentionFocus: AttentionFocus | null;
  lastFailure: FailureContext | null;
  recentSuccessRate: number;
  activeAgentCount: number;
  activeToolCount: number;
  totalTasksProcessed: number;
  lastUpdated: number;
}
```

### 2. Unified Engines (7 adet) ✅
```typescript
// packages/engine/src/aurora/unified-engines.ts
export class MemoryEngine { ... }      // MemoryGraph + LongHorizon + NeuralFusion + Experience + SharedLearning
export class ReasoningEngine { ... }   // MultiHypothesis + InternalCritic + ExperimentEngine + NeuralCore
export class PlanningEngine { ... }    // PlanningService + PlannerV2 + GoalStack
export class WorldEngine { ... }       // WorldModel + LearnedWorld + CausalGraph + Counterfactual
export class LearningEngine { ... }    // ExperienceCompiler + SleepCycle + SharedLearning
export class AttentionEngine { ... }   // AttentionV2 + CognitiveWorkspace
export class ModelSelectionEngine { ... } // ModelRouter + AdaptiveRouter
```

### 3. EventBus ✅
```typescript
// packages/engine/src/aurora/event-bus.ts
export class EventBus {
  async emit(type, source, payload, opts): Promise<AuroraEvent>
  subscribe(eventType, handler, priority): string
  unsubscribe(subscriptionId): void
  getRecentEvents(count, type): AuroraEvent[]
  getTrace(traceId): AuroraEvent[]
  getStats(): { totalEvents, totalSubscriptions, eventsByType, recentCritical }
}
```

### 4. Meta Controller ✅
```typescript
// packages/engine/src/aurora/meta-controller.ts
export class MetaControllerService {
  async run(tenantId, taskDescription, executors): RunResult
}
```

### 5. Engine Integration ✅
```typescript
// packages/engine/src/engine.ts
async runTask(tenantId, taskDescription): Promise<RunResult> {
  // EventBus emit
  // CognitiveState update
  // Meta Controller run() with executors
  // Unified engines called
}
```

---

## 🔍 Plan ile Karşılaştırma

| Planın İstediği | Mevcut Durum | Durum |
|-----------------|--------------|-------|
| `CognitiveState` interface | `CognitiveStateSnapshot` var | ✅ |
| `mode` field (idle/observing/...) | 9 mod tanımlı | ✅ |
| `activeGoal` | Var | ✅ |
| `activePlan` | Var | ✅ |
| `activeHypotheses` | Var | ✅ |
| `resourceBudget` | Var | ✅ |
| `attentionFocus` | Var | ✅ |
| `lastFailure` | Var | ✅ |
| `recentSuccessRate` | Var | ✅ |
| Unified `MemoryEngine` | 7 alt servisi birleştirir | ✅ |
| Unified `PlanningEngine` | 3 alt servisi birleştirir | ✅ |
| Unified `WorldEngine` | 4 alt servisi birleştirir | ✅ |
| Unified `ReasoningEngine` | 4 alt servisi birleştirir | ✅ |
| Unified `LearningEngine` | 3 alt servisi birleştirir | ✅ |
| EventBus | 60+ event type | ✅ |
| Meta Controller `run()` | 15+ subsystem executor | ✅ |

---

## ⚠️ Eksik / İyileştirilmesi Gereken

### 1. Servisler Hala Kendi Dünyalarında Yaşıyor
Planın dediği:
> "Servisler kendi dünyalarında yaşamamalı. Örneğin LongHorizonMemory, MemoryGraph, NeuralMemory, MemoryStore ayrı ayrı 'zihin' olmamalı."

**Durum:** Unified Engines var ama eski servisler hala doğrudan erişilebilir. Engine'de hem `memoryEngine` hem de `memoryGraph`, `longHorizonMemory`, `neuralMemoryFusion` ayrı ayrı duruyor.

**Çözüm:** Eski servisler `private` yapılmalı, sadece unified engine API'si dışarı açılmalı.

### 2. `skipped` Durumu Ayrılmamış
Planın dediği:
> "Durumlar kesin ayrılmalı: planned, executing, succeeded, failed, skipped, unavailable, timed_out, cancelled, blocked. `skipped` asla `success` gibi görünmemeli."

**Durum:** Meta Controller'da `outcome` field'ı var ama `skipped` ayrımı net değil.

**Çözüm:** `RunResult.outcome` enum'ına tüm durumlar eklenmeli.

### 3. Memory Confidence Tracking Eksik
Planın dediği:
> "Hiçbir memory otomatik olarak 'gerçek' sayılmasın. Her semantic memory: sourceEvents, confidence, lastVerifiedAt, contradictions taşımalı."

**Durum:** Memory'de `confidence` field'ı var ama `lastVerifiedAt` ve `contradictions` eksik.

**Çözüm:** Memory interface'ine bu field'lar eklenmeli.

---

## 🎯 FAZ 4 Tamamlanması İçin Yapılacaklar

### Küçük İyileştirmeler (Hemen yapılabilir)

1. **Eski servis erişimini kısıtla** — Unified engine API'si dışarı açılsın
2. **RunResult outcome enum'ını genişlet** — `skipped`, `timed_out`, `cancelled`, `blocked` ekle
3. **Memory'ye confidence field'ları ekle** — `lastVerifiedAt`, `contradictions`
4. **CognitiveState'e `uncertainty` ve `failures` ekle** — Planın istediği eksik field'lar

### Orta İyileştirmeler

5. **EventBus'u transactional yap** — Outbox pattern
6. **Causal/Correlation ID ekle** — Event'lere `traceId`, `causationId`, `correlationId`
7. **Mode transitions'ı zorunlu yap** — Geçersiz mod geçişlerini engelle

---

## 📊 Sonuç

**FAZ 4'ün ~%70'i zaten tamamlanmış durumda.**

Planın istediği mimarinin temeli (CognitiveState, Unified Engines, EventBus, Meta Controller) mevcut. Geriye kalan iş:

1. Eski servis erişimini kısıtla (unified API'ye geçiş)
2. Outcome enum'ını genişlet
3. Memory confidence tracking ekle
4. EventBus'u transactional yap

Bu iyileştirmeler yapıldığında FAZ 4 tamamlanmış olur.
