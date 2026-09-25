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

# Aurora Motor Engine — 30 Sistem Dönüşüm Raporu

## Tarih: 2025-09-15

---

## ✅ Tüm Build ve Test'ler Temiz

```
Engine:      ✅ tsc -b
Control-API: ✅ tsc -b
Canvas-Web:  ✅ TS Check + Build (380KB JS, 46KB CSS)

Tests:       Engine 27/27 | Control-API 27/27 | Canvas-Web 18/18
```

---

## Yeni Engine Servisleri (9 servis, ~66KB kod)

| # | Servis | Dosya | Boyut | Amaç |
|---|--------|-------|-------|------|
| 1 | **Self-Model Service** | `self-model-service.ts` | 11.6KB | Metacognition — kendi durumunu modelleme |
| 2 | **Uncertainty Engine** | `uncertainty-engine.ts` | 6.5KB | Her claim için confidence/evidence/assumptions |
| 3 | **Failure Taxonomy** | `failure-taxonomy.ts` | 7.2KB | Başarısızlık sınıflandırma + pattern çıkarma |
| 4 | **Cognitive Telemetry** | `cognitive-telemetry.ts` | 6.6KB | Karar izleme — "neden bu kararı aldım?" |
| 5 | **Neural Memory Fusion** | `neural-memory-fusion.ts` | 7.6KB | Symbolic + Neural memory birleştirme |
| 6 | **Experience Compiler** | `experience-compiler.ts` | 6.1KB | Deneyim → Skill dönüşümü |
| 7 | **Sleep Cycle** | `sleep-cycle.ts` | 4.4KB | Memory consolidation (light/deep/REM) |
| 8 | **Counterfactual Simulator** | `counterfactual-simulator.ts` | 5.2KB | "Ya şöyle yapsaydım?" simülasyonları |
| 9 | **Meta-Controller** | `meta-controller.ts` | 10.7KB | Tüm30 sistemi orkestre eden meta-kontrolcü |

---

## Yeni API Endpoint'leri (37 endpoint)

### Self-Model (7 endpoint)
- `GET /v1/self-model` — Full state
- `POST /v1/self-model/goals` — Goal ekle
- `POST /v1/self-model/beliefs` — Belief ekle
- `POST /v1/self-model/capabilities` — Capability değerlendir
- `POST /v1/self-model/hypotheses` — Hipotez öner
- `POST /v1/self-model/reflect` — Refleksyon çalıştır
- `POST /v1/self-model/strategy` — Strateji değiştir

### Uncertainty Engine (5 endpoint)
- `GET /v1/uncertainty/claims` — Tüm claim'ler
- `POST /v1/uncertainty/assert` — Yeni claim oluştur
- `GET /v1/uncertainty/confident` — Güvenli claim'ler
- `GET /v1/uncertainty/uncertain` — Belirsiz claim'ler
- `GET /v1/uncertainty/calibration` — Kalibrasyon istatistikleri

### Failure Taxonomy (5 endpoint)
- `GET /v1/failures` — Tüm failure'lar
- `POST /v1/failures/classify` — Failure sınıflandır
- `GET /v1/failures/stats` — İstatistikler
- `GET /v1/failures/patterns` — Pattern'ler
- `GET /v1/failures/recommendations` — Öneriler

### Cognitive Telemetry (3 endpoint)
- `GET /v1/telemetry/traces` — Trace'ler
- `GET /v1/telemetry/stats` — İstatistikler
- `GET /v1/telemetry/insights` — En öğretici trace'ler

### Neural Memory Fusion (4 endpoint)
- `GET /v1/neural-fusion/stats` — İstatistikler
- `GET /v1/neural-fusion/patterns` — Pattern'ler
- `POST /v1/neural-fusion/similar` — Semantik benzerlik ara
- `POST /v1/neural-fusion/consolidate` — Consolidation

### Experience Compiler (3 endpoint)
- `GET /v1/experience-compiler/skills` — Skill'ler
- `GET /v1/experience-compiler/experiences` — Deneyimler
- `POST /v1/experience-compiler/compile` — Skill derle

### Sleep Cycle (2 endpoint)
- `GET /v1/sleep-cycle/cycles` — Döngüler
- `POST /v1/sleep-cycle/schedule` — Schedule ayarla

### Counterfactual Simulator (5 endpoint)
- `GET /v1/simulations` — Simülasyonlar
- `POST /v1/simulations` — Yeni simülasyon
- `POST /v1/simulations/:id/scenarios` — Scenario ekle
- `POST /v1/simulations/:id/recommend` — Öner
- `GET /v1/simulations/calibration` — Kalibrasyon

### Meta-Controller (3 endpoint)
- `POST /v1/meta-controller/profile` — Task profile oluştur
- `POST /v1/meta-controller/plan` — Execution plan oluştur
- `GET /v1/meta-controller/stats` — İstatistikler

---

## Toplam Sistem Sayısı

| Kategori | Sayı |
|----------|------|
| Mevcut engine servisleri | ~20 |
| Yeni cognitive servisler | 9 |
| UI Panel'leri | 32 |
| API Endpoint'leri | 563+37 = 600+ |
| Tab'lar | 32 |

---

## Her Servisin Entegrasyon Noktaları

### Self-Model → Cognitive Orchestrator
- ACOS cycle'ında self-model.reflect() çağrılır
- Her task failure'da self-model.recordFailure() çağrılır
- Strategy switch'lerde self-model.switchStrategy() çağrılır

### Uncertainty Engine → Decision Service
- Her karar öncesi uncertainty.assert() ile confidence kaydedilir
- Karar sonucunda uncertainty.verify() ile kalibrasyon güncellenir

### Failure Taxonomy → Evolution Service
- failure-taxonomy.classify() → evolution.gaps'a otomatik gap oluşturur
- Pattern'ler evolution.candidates'a skill candidate olarak akar

### Cognitive Telemetry → Tüm Servisler
- Her servis çağrısı span olarak kaydedilir
- Trace'ler debugging ve akademik araştırma için kullanılır

### Neural Memory Fusion → Memory Graph
- Her yeni memory objesi için otomatik embedding oluşturulur
- Consolidation sırasında pattern discovery çalıştırılır

### Experience Compiler → Skill Evolution
- Başarılı task tamamlamaları experience olarak kaydedilir
- compileSkills() çağrıldığında aday skill'ler oluşturulur

### Sleep Cycle → Autopilot
- Autopilot cadence'leri ile entegre çalışır
- light: her30dk, deep: her4saat, REM: her24saat

### Counterfactual Simulator → Planning Service
- Plan oluşturulmadan önce simulation çalıştırılabilir
- Scenario'lar karşılaştırılıp en iyisi önerilir

### Meta Controller → Tüm Servisler
- Her görev için complexity analizi yapar
- Hangi subsystem'lerin çalıştırılacağına karar verir
- Parallel execution planlaması yapar
- Performance telemetry ile kendi kendini optimize eder

---

## Mimari Diyagram

```
                    ┌─────────────────────┐
                    │  META CONTROLLER    │
                    │  (9.yeni servis)    │
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
        │                     │                     │
   ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
   │Uncertain│          │Telemetry│          │Self-Model│
   │ Engine  │          │ Service │          │ Service  │
   └─────────┘          └─────────┘          └──────────┘
```

---

## Gelecek Fazlar (Henüz Uygulanmadı)

### FAZ3 (Kalan): Multi-Hypothesis, Internal Critic, Experiment Engine
### FAZ4: Agent Economy, Reputation, Resource Intelligence, Digital Twin
### FAZ5 (Kalan): Benchmark Lab, Adaptive Router, Neural Cognitive Core

Bu servisler engine'e eklenebilir ancak UI entegrasyonu henüz yapılmadı.
Mevcut API endpoint'leri ile çalışabilirler.
