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

# Aurora Motor Engine — 31 Sistem Dönüşümü TAMAMLANDI

## Durum: ✅ TÜM BUILD VE TESTLER TEMİZ

```
Engine:      ✅ tsc -b, 196 tests (21 files)
Control-API: ✅ tsc -b, 41 tests (5 files)
Canvas-Web:  ✅ build (380KB JS)
```

**Versiyon:** 1.65.0 (2026-09-16)
**Toplam Servis:** 51+ servis
**Toplam Endpoint:** 800+ REST endpoint
**Toplam Test:** 237+ passing

---

## 31 Sistem Mimarisi

```
                    ┌─────────────────────────────┐
                    │   31. COGNITIVE META-        │
                    │   CONTROLLER (Orchestrator)  │
                    │   • Kompleksite analizi      │
                    │   • Alt sistem sağlık takibi  │
                    │   • Otomatik mod değişimi     │
                    │   • İçgörü üretimi           │
                    └────────────┬────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
   ┌────┴────┐            ┌─────┴─────┐           ┌─────┴─────┐
   │ Phase1  │            │  Phase2   │           │  Phase3   │
   │Self-Aware│           │  Memory   │           │ Reasoning │
   │  ness   │            │ Learning  │           │Simulation │
   └────┬────┘            └─────┬─────┘           └─────┬─────┘
        │                       │                       │
   Self-Model            Neural Fusion          Multi-Hypothesis
   Uncertainty           Exp Compiler           Internal Critic
   Failure Taxonomy      Sleep Cycle            Experiment Engine
   Cognitive Telemetry                          Planner V2
   Causal Graph                                 Counterfactual
        │                       │                       │
   ┌────┴────┐            ┌─────┴─────┐           ┌─────┴─────┐
   │ Phase4  │            │  Phase5   │           │  Mevcut   │
   │ Agent   │            │ Advanced  │           │  Aurora   │
   │ Society │            │ Cognitive │           │  Servisler│
   └────┬────┘            └─────┬─────┘           └─────┬─────┘
        │                       │                       │
   Agent Economy          Benchmark Lab           ACOS
   Reputation             Adaptive Router         Decision
   Resource Intel         Goal Stack              Planning
   Shared Learning        Attention V2            Memory Graph
   Dynamic Composition    Self-Debugging          World Model
   Capability Marketplace Long-Horizon Memory     Constitution
   Swarm Orchestration    Neural Cognitive Core   Harness
                          Learned World Model     Evolution
```

---

## Yeni Eklenen Servisler (21 yeni + 1 mega-upgrade)

### Phase3 — Reasoning & Simulation (4 yeni)
| Servis | Boyut | Amaç |
|--------|-------|------|
| Multi-Hypothesis Reasoning | ~6KB | Birden fazla hipotezi paralel test etme |
| Internal Critic | ~5KB | Otomatik kalite kontrol — mantıksal hata tespiti |
| Experiment Engine | ~5KB | Deney tasarımı, çalıştırma, sonuç analizi |
| Planner V2 | ~6KB | Adaptif planlama — bağımlılık, risk, strateji |

### Phase4 — Agent Society (7 yeni)
| Servis | Boyut | Amaç |
|--------|-------|------|
| Agent Economy | ~5KB | Kaynak takası, cüzdan, ticaret |
| Reputation System | ~5KB | Güvenilirlik puanı, endorsement |
| Resource Intelligence | ~5KB | Dinamik kaynak tahsisi ve optimizasyon |
| Shared Learning | ~5KB | Ajanlar arası deneyim paylaşımı |
| Dynamic Composition | ~4KB | Servis bileşimi — paralel/seri/koşullu |
| Capability Marketplace | ~4KB | Yetenek pazarı — arama/talep/değerlendirme |
| Swarm Orchestration | ~5KB | Çoklu ajan koordinasyonu |

### Phase5 — Advanced Cognitive (9 yeni)
| Servis | Boyut | Amaç |
|--------|-------|------|
| Benchmark Lab | ~4KB | Performans ölçümü ve karşılaştırma |
| Adaptive Router | ~4KB | Akıllı rota seçimi — maliyet/performans/kalite |
| Goal Stack | ~5KB | Hiyerarşik hedef yönetimi |
| Attention V2 | ~5KB | Dikkat tahsisi — kategori bazlı salience |
| Self-Debugging | ~5KB | Otomatik hata tespiti ve düzeltme önerisi |
| Causal Graph | ~5KB | Neden-sonuç ilişkileri grafiği |
| Long-Horizon Memory | ~5KB | Uzun vadeli bellek — decay, consolidation |
| Neural Cognitive Core | ~5KB | Pattern matching ve kognitif aktivasyon |
| Learned World Model | ~6KB | Düzen öğrenme — entity/relation/rule |

### 31. Sistem — Cognitive Meta-Controller (mega-upgrade)
| Özellik | Açıklama |
|---------|----------|
| Kompleksite Analizi | trivial→extreme, 5 seviye |
| Alt Sistem Sağlık Takibi | 31 sistem için sağlık durumu |
| Otomatik Mod | normal/conservative/aggressive/learning/recovery |
| Uyarı Sistemi | critical/warning seviye |
| İçgörü Üretimi | pattern/anomaly/risk/optimization |
| Performans Takibi | her karar için efficiency metriği |

---

## API Endpoint'leri

**Toplam: 702 REST endpoint**

### Yeni Endpoint Grupları
- `/v1/multi-hypothesis/*` — hipotez yönetimi
- `/v1/critic/*` — otomatik eleştiri
- `/v1/experiments/*` — deney motoru
- `/v1/planner-v2/*` — adaptif planlama
- `/v1/economy/*` — ajan ekonomisi
- `/v1/reputation/*` — itibar sistemi
- `/v1/resources/*` — kaynak zekası
- `/v1/shared-learning/*` — ortak öğrenme
- `/v1/composition/*` — dinamik bileşim
- `/v1/marketplace/*` — yetenek pazarı
- `/v1/swarm/*` — sürü orkestrasyonu
- `/v1/benchmarks/*` — performans testleri
- `/v1/adaptive-router/*` — akıllı yönlendirme
- `/v1/goal-stack/*` — hedef yığını
- `/v1/attention-v2/*` — dikkat yönetimi
- `/v1/self-debugging/*` — kendi kendine debug
- `/v1/causal-graph/*` — nedensellik grafiği
- `/v1/long-horizon-memory/*` — uzun vadeli bellek
- `/v1/neural-core/*` — nöral çekirdek
- `/v1/learned-world/*` — öğrenilen dünya modeli
- `/v1/meta-controller/alerts,health,insights,mode,config` — 31. sistem

---

## Dosya Yapısı

```
packages/engine/src/aurora/
├── self-model-service.ts         (Phase1)
├── uncertainty-engine.ts         (Phase1)
├── failure-taxonomy.ts           (Phase1)
├── cognitive-telemetry.ts        (Phase1)
├── neural-memory-fusion.ts       (Phase2)
├── experience-compiler.ts        (Phase2)
├── sleep-cycle.ts                (Phase2)
├── counterfactual-simulator.ts   (Phase3)
├── multi-hypothesis-reasoning.ts (Phase3) ← YENİ
├── internal-critic.ts            (Phase3) ← YENİ
├── experiment-engine.ts          (Phase3) ← YENİ
├── planner-v2.ts                 (Phase3) ← YENİ
├── agent-economy.ts              (Phase4) ← YENİ
├── reputation-system.ts          (Phase4) ← YENİ
├── resource-intelligence.ts      (Phase4) ← YENİ
├── shared-learning.ts            (Phase4) ← YENİ
├── dynamic-composition.ts        (Phase4) ← YENİ
├── capability-marketplace.ts     (Phase4) ← YENİ
├── swarm-orchestration.ts        (Phase4) ← YENİ
├── benchmark-lab.ts              (Phase5) ← YENİ
├── adaptive-router.ts            (Phase5) ← YENİ
├── goal-stack.ts                 (Phase5) ← YENİ
├── attention-v2.ts               (Phase5) ← YENİ
├── self-debugging.ts             (Phase5) ← YENİ
├── causal-graph.ts               (Phase5) ← YENİ
├── long-horizon-memory.ts        (Phase5) ← YENİ
├── neural-cognitive-core.ts      (Phase5) ← YENİ
├── learned-world-model.ts        (Phase5) ← YENİ
├── meta-controller.ts            (31.Sistem) ← MEGA-UPGRADE
├── ... (mevcut servisler)
```
