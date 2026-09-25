# Aurora Motor Engine — 50 Faz Durum Raporu

**Tarih:** 2026-09-19
**Versiyon:** 1.65.0
**Ölçülen taban:** `typecheck` 0 hata · `vitest run` **195 dosya / 1217 test PASS** ·
`eval:validate` ✅ · `eval:baseline` ✅ 0/61 (+1 gerekçeli muaf) ·
`eval:learning` ✅ · `eval:recall:lock` ✅

> **Kapılar artık CI'da.** `npm run eval:gates` (validate + baseline + learning
> + recall regresyon kilidi, 5.3s) her push'ta koşuyor; FAZ 11 kabul kriteri
> gerçek encoder gerektirdiği için gecelik `recall-nightly` job'ına ayrıldı.
> Ayrıntı: `52-system-scan.md`.

> **İkinci tarama (entegrasyon) iki bağlantı kopukluğu buldu ve kapattı:**
> `MemoryEngine.recall()` `limit: 3` için **23** hafıza döndürüyordu (long-horizon
> sınırsızdı, birleşim sıralanmıyordu) — ana execution yolunda prompt'u
> şişiriyordu; ve planlama fazı hiç koşmuyordu (`PlanningEngine` vardı,
> `execute()` bağlamamıştı). İkisi de sabotajla doğrulandı.

> **Bu dosya 2026-09-17'de bayattı ve yanıltıcıydı.** "%14 ilerleme, 43 faz
> başlanmadı" diyordu; iddialarını koda karşı denetlediğimde dördü birden
> yanlış çıktı: `experimental/` dizini **var**, adversarial testler **var**,
> chaos test script'i **var**, `engine.execute()` **var**. "Engine 682/682"
> sayısı da eskimişti (şimdi 1109). Aşağıdaki tablolar dosya/test kanıtıyla
> yeniden doğrulanmıştır.

---

## 📊 Hızlı Özet

| Durum | Sayı |
|-------|------|
| ✅ Gate'i ölçülmüş ve geçmiş | 14 faz grubu |
| 🟡 Kod var, dış bağımlılık bekliyor | 3 kalem |
| ❌ Gerçekten yapılmamış | 0 faz |

**Dürüst özet:** yazılacak faz kodu kalmadı. Kalan üç kalem kod eksikliği
değil: ikisi harici erişim (API anahtarı, model bağlama), biri karar.

---

## ✅ Gate'i ölçülmüş fazlar

Her satırın kanıtı çalıştırılabilir bir testtir.

| Faz | Gate | Kanıt | Durum |
|-----|------|-------|-------|
| FAZ 0 | Deneysel ayrımı | `experimental/maturity.ts` + `maturity-registry.test.ts` 9/9 | ✅ |
| FAZ 1 | 61 eval görevi çalışıyor, sonuç kaydediliyor | `core-tasks.test.ts` 19/19 · `live-suite-baseline.test.ts` 4/4 | ✅ |
| FAZ 1 (gate) | Kriterler ayırt edici | `eval:validate` — 60/60 discriminative, 12/12 referans | ✅ |
| FAZ 11 | Recall@8 baseline'dan anlamlı iyi | 120 doc/15 sorgu: gerçek encoder **0.317→0.400** Δ**+0.083** (8W/1L/6T), hash encoder 0.339. Marj 0.05. | ✅ **geçiyor** |
| FAZ 17-19 | Eksik capability üretildi, **sandbox'ta test edildi** | `capability-synthesis.test.ts` 11/11 (gerçek Worker isolate) | ✅ |
| FAZ 20-21 | Skill synthesis doğrulaması | `skill-synthesis.test.ts` 17/17 | ✅ |
| FAZ 22 | Skill promotion gate, self-promotion imkânsız | `skill-promotion-gate.test.ts` 20/20 | ✅ |
| FAZ 29 | Yeni varyant baseline'ı bağımsız eval'de geçti | 21/21; tek-vaka terfi açığı kapatıldı (min 3 held-out vaka) | ✅ |
| FAZ 30 | İkinci karşılaşmada daha az adım | Gerçek loop: 4/4 aile, **%42.9** daha az adım (`eval:learning`); recall kapalıyken 0/4 | ✅ |
| FAZ 46-48 | Gerçek benchmark task seti | 61 gerçek görev (`CORE_EVAL_TASKS`) | ✅ |
| FAZ 51 P0 | Tek gerçek execution loop | bölüm 1-12, `unified-execution-loop.test.ts` 27/27 | ✅ |
| FAZ 51 P1 | Capability acquisition + decoy savunması | `capability-acquisition*.test.ts` 17/17 | ✅ |
| — | Gerçek workspace + acceptance | `acceptance-verification.test.ts` 10/10 · `grader-workspace.test.ts` 8/8 | ✅ |
| — | Uydurma başarı taraması | `grading-honesty.test.ts` 8/8 · `agent-sdk-execution.test.ts` 6/6 | ✅ |

---

## 🔟 Sistemin gerçek yetenek testi

Eski dosyada bu on maddenin **onu da ❌** idi. Doğrulanmış güncel hâli:

| # | Yetenek | Kanıt | Durum |
|---|---------|-------|-------|
| 1 | Basit bug düzeltme | 61 görevlik suite, gerçek workspace'te gradeleniyor | ✅ altyapı |
| 2 | Uzun görev (repo inceleme) | `engine.execute()` + budget/attempt sınırları | ✅ altyapı |
| 3 | Memory kullanımı | `recall-gate.test.ts` 8/8 | ✅ |
| 4 | Failure recovery | `failure-taxonomy.ts` 15 tip + bütçeli recovery | ✅ |
| 5 | Missing tool detection | `gap-detection.test.ts` 15/15 (deterministic 0.93) | ✅ |
| 6 | Capability acquisition | `capability-acquisition-loop.test.ts` — FAIL→GAP→ACQUIRE→RETRY→SUCCESS | ✅ |
| 7 | Verification (kötü çözümü reddetme) | known-bad decoy hileyi yakalıyor; `acceptanceVerifier` | ✅ |
| 8 | Learning (ikinci denemede daha hızlı) | `learning-metrics.test.ts` 17/17 + reuse testi | ✅ |
| 9 | World model (prediction → surprise → replan) | `aurora-world-model.test.ts` | 🟡 beta — öğrenilen forward model yok |
| 10 | Self-improvement | `self-improvement-gate.test.ts` 19/19 | 🟡 beta — operatör kümesi sabit |

9 ve 10 için isimlerin vaat ettiği seviye ile gerçek kapasite arasındaki fark
`maturity.ts`'te `gapToStable` olarak **yazılı** (madde 63/64).

---

## 🟡 Gerçekten kalan üç kalem

Hiçbiri "faz yapılmadı" değil; üçü de dış bağımlılık:

| Kalem | Engel | Sistem şu an ne diyor |
|---|---|---|
| 61 görevi gerçek LLM ile koşmak | **API anahtarı** | mock model ile 0/61 — doğru sonuç |
| Capability generator'ı bağlamak | **Model bağlama kararı** | ctor throw eder; `wiredToEngine: false` |
| Extension isolate'ı bağlamak | Karar (iki gerçek isolate hazır) | `ExtensionSandboxUnavailableError` |

---

## 📦 Modül olgunluk envanteri

29 kayıtlı modül: **7 stable · 16 beta · 6 experimental**.

Bu bir kusur değil, envanterin doğru olması. Kritik nokta: boşlukların hiçbiri
sessiz `return true` değil — her biri ya **throw eden guard**, ya `uncertain`
dönüşü, ya da maturity kaydında yazılı `gapToStable` metni.

| Seviye | Modüller |
|---|---|
| **stable (7)** | capability-synthesis · skill-synthesis · skill-promotion · skill-composition · security-system · production-persistence · real-memory-pipeline |
| **beta (16)** | unified-execution-loop · gap-detection · capability-acquisition · verification-factory · failure-taxonomy · self-improvement · world-model-exploration · model-routing · agent-society · goal-discovery · reward-hacking-defense · reward-hacking-detectors · integration-verification · jarvis-surface · **neural-memory-fusion** · **neural-cognitive-core** |
| **experimental (6)** | code-pipeline-service · agent-sdk-service · digital-twin · embodiment · federated · domain-experts |

---

## 🔁 Bu turda kapatılan dürüstlük açıkları

| Açık | Etkisi | Durum |
|---|---|---|
| `gradeJudge` aktivite sayıyordu | iki event → **score 1.0** | ✅ `uncertain`, score 0 |
| `qualityScore ?? 1.0` | ölçülmeyen = mükemmel | ✅ ortalamadan çıkarılıyor |
| `executeInSandbox` sahte | hiç çalışmamış uzantı **%100 başarı** | ✅ named error |
| Grader `process.cwd()` | 70 kriter yanlış dizinde | ✅ workspace'e bağlandı |
| Ajan workspace'i görmüyordu | dosya görevleri kazanılamaz | ✅ `createSession(workspacePath)` |
| Acceptance iki kez koşuyordu | çift yan etki | ✅ tek koşum |
| Trajectory runner `runTask()` | `partial → 0.5` | ✅ `execute()`, yarım puan yok |

---

## Sonuç

**Tamamlanmayan faz yok.** Yazılacak faz kodu kalmadı; kalan üç kalemin ikisi
harici erişim, biri karar. Sistem eksiklerini gizlemiyor — throw eden guard'lar
ve maturity kayıtlarıyla beyan ediyor.

---

## Ek denetim — isim dürüstlüğü (madde 63)

Bu tarama sırasında iki sınıf adının kapasiteyi abarttığı doğrulandı:

| Sınıf | Adın vaadi | Kodun gerçeği |
|---|---|---|
| `NeuralMemoryFusionService` | öğrenilmiş neural embedding | `Math.sin(hash(keyword))` ile 64-boyutlu deterministik vektör + kosinüs/Jaccard. Ağ yok, eğitim yok, ağırlık yok |
| `NeuralCognitiveCoreService` | neural bilişsel substrat | aktivasyon sayaçlı kalıcı pattern registry. Pattern eşleme gerçek, "neural" hiçbir şey yok |

İkisi de **çalışıyor ve faydalı** — sorun işlevde değil, isimde. Madde 63
gereği ikisi de `maturity.ts`'e `gapToStable` metniyle kaydedildi
(önerilen adlar: `VectorMemoryFusion`, `CognitivePatternRegistry`).
Yeniden adlandırma yapılmadı; kullanıcı talimatı isimleri ancak implementasyon
vaadi karşıladığında "gerçek" diye sunmamaktı — beyan bunu sağlıyor.

## Ek denetim — README (madde 64)

README `Implemented and tested:` başlığı altında **yedi** deneysel sistemi
tamamlanmış gibi listeliyordu; en çarpıcısı "agent SDK: … with sandbox
execution" — ki aynı turda sahte olduğu bulunup throw'a çevrildi.

README'ye `Implemented / Beta / Experimental` ayrımı ve maturity registry'ye
bağlantı eklendi; yedi sistem gerçek durumuyla (`scaffolding real, execution
not wired`) yeniden yazıldı.
