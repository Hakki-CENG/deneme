<!-- HAF-STATUS-BANNER -->
> ## ⚠️ Elle yazılmış anlık görüntü — doğrulanmamış
>
> Bu dosya **koddan üretilmez** ve yazıldığından bu yana doğrulanmamıştır.
> İçindeki test sayıları, tamamlanma yüzdeleri ve "production-ready" gibi
> iddialar ölçülmüş gerçekle çelişebilir (ör. bu dosya "612 test" derken
> ölçülen değer farklıdır).
>
> **Yetkili kaynaklar** — bunlar koddan üretilir ve `packages/eval/test/state-docs.test.ts`
> sapmayı yakalar:
>
> - `hybrid-agent-fabric/CURRENT_STATE.md` — ölçülen modül/test durumu
> - `hybrid-agent-fabric/MATURITY_MATRIX.md` — olgunluk seviyeleri
> - `hybrid-agent-fabric/KNOWN_GAPS.md` — bilinen eksikler
>
> Depo invariantları için: `npm run verify:integration`.
> Bu bandın varlığı `scripts/verify-integration.mjs` tarafından denetlenir.

# Aurora Motor Engine — 30 Katmanlı Dönüşüm Planı

## Mevcut Güçlü Temel (Zaten Var)
- **Memory**: 7 katman (working→session→episodic→semantic→procedural→user→palace)
- **Cognitive Workspace**: objects, goals, 6 mod, attention allocation
- **World Model**: entities, events, calibration, causality, simulation, predictions
- **Planning**: plans, steps, delegation, estimation, contingency (kısmen)
- **Decision Service**: options, criteria, calibration, dissent, outcomes
- **Evolution**: gaps, candidates, 6 stage pipeline
- **Experience Distiller**: session trajectory → lesson proposals
- **Autopilot**: 7 cadence türü (pulse→monthly-strategy)
- **Cognitive Orchestrator**: ACOS control loop
- **Society**: roles, tasks, deliberations, budget, reputation (kısmen)
- **Risk/Trust/Constitution/User Model**: hepsi mevcut

## İnşa Edilecek (30 Sistem + Meta-Controller)

### FAZ 1 — Self-Awareness & Observability (Hafta1)
| # | Sistem | Engine Servisi | Öncelik |
|---|--------|---------------|---------|
| 1 | Self-Model Service | `self-model-service.ts` | KRİTİK |
| 2 | Uncertainty Engine | `uncertainty-engine.ts` | KRİTİK |
| 3 | Failure Taxonomy | `failure-taxonomy.ts` | YÜKSEK |
| 4 | Cognitive Telemetry | `cognitive-telemetry.ts` | YÜKSEK |

### FAZ 2 — Memory & Learning Revolution (Hafta2)
| # | Sistem | Engine Servisi | Öncelik |
|---|--------|---------------|---------|
| 5 | Neural Memory Fusion | `neural-memory-fusion.ts` | KRİTİK |
| 6 | Experience→Skill Compiler | `experience-compiler.ts` | KRİTİK |
| 7 | Sleep Cycle / Consolidation | `sleep-cycle.ts` | YÜKSEK |
| 8 | Recursive Skill Discovery | `recursive-skill-discovery.ts` | YÜKSEK |

### FAZ 3 — Reasoning & Simulation (Hafta3)
| # | Sistem | Engine Servisi | Öncelik |
|---|--------|---------------|---------|
| 9 | Counterfactual Simulator | `counterfactual-simulator.ts` | KRİTİK |
| 10 | Multi-Hypothesis Reasoning | `multi-hypothesis.ts` | YÜKSEK |
| 11 | Internal Critic | `internal-critic.ts` | YÜKSEK |
| 12 | Experiment Engine | `experiment-engine.ts` | YÜKSEK |
| 13 | Hierarchical Planner2.0 | Enhancement | YÜKSEK |

### FAZ 4 — Agent Society & Resources (Hafta4)
| # | Sistem | Engine Servisi | Öncelik |
|---|--------|---------------|---------|
| 14 | Agent Economy | `agent-economy.ts` | YÜKSEK |
| 15 | Agent Reputation | `agent-reputation.ts` | YÜKSEK |
| 16 | Resource Intelligence | `resource-intelligence.ts` | ORTA |
| 17 | Digital Twin | `digital-twin.ts` | ORTA |
| 18 | Repository Evolution | `repo-evolution.ts` | ORTA |
| 19 | Tool Discovery | `tool-discovery.ts` | ORTA |
| 20 | Knowledge Acquisition | `knowledge-acquisition.ts` | ORTA |

### FAZ 5 — Neural Core & Meta-Controller (Hafta5)
| # | Sistem | Engine Servisi | Öncelik |
|---|--------|---------------|---------|
| 21 | Benchmark Lab | `benchmark-lab.ts` | YÜKSEK |
| 22 | Adaptive Model Router | `adaptive-router.ts` | YÜKSEK |
| 23 | Goal Stack + Evolution | Enhancement | ORTA |
| 24 | Attention Manager2.0 | Enhancement | ORTA |
| 25 | Self-Debugging | `self-debugging.ts` | ORTA |
| 26 | Causal Graph Engine | Enhancement | ORTA |
| 27 | Long-Horizon Task Memory | Enhancement | ORTA |
| 28 | Neural Cognitive Core | `neural-cognitive-core.ts` | DÜŞÜK |
| 29 | Learned World Model | `learned-world-model.ts` | DÜŞÜK |
| 30 | Cognitive Meta-Controller | `meta-controller.ts` | KRİTİK |

## Entegrasyon Mimarisi

```
                    ┌─────────────────────┐
                    │  META CONTROLLER    │
                    │  (30.alt sistem)    │
                    └─────────┬───────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
   │ Memory  │          │Reasoning│          │ Society │
   │ Stack   │          │ Stack   │          │ Stack   │
   └────┬────┘          └────┬────┘          └────┬────┘
        │                     │                     │
   Neural Fusion      Counterfactual         Agent Economy
   Experience→Skill   Multi-Hypothesis       Reputation
   Sleep Cycle        Internal Critic        Resource Intel
   Failure Taxonomy   Experiment Engine      Tool Discovery
   Knowledge Acq      Benchmark Lab          Digital Twin
```

## Her Servis Şablonu

```typescript
//1. Service class (DurableJsonState ile)
//2. REST endpoints (main.ts'ye eklenir)
//3. UI panel (App.tsx'e eklenir)
//4. Integration hooks (cognitive orchestrator'a bağlanır)
```
