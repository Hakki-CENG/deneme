# Sistem taraması — açık eksikler listesi

Tarih: 2026-09-19. Amaç: aynı işi iki kez yapmamak için, devam etmeden önce
tüm sistemi tarayıp kalan gerçek eksikleri tek listede toplamak.

Tarama, bu oturumda bulunan **iki hata kalıbını** tüm repoya uyguladı:
1. **Tautolojik test** — retriever/sistem ne yaparsa yapsın geçen assertion
   (FAZ 11'in yanlışlıkla ✅ görünmesinin sebebiydi).
2. **Üretimde çağrılmayan metrik** — doğru hesaplayan ama yalnızca elle yazılmış
   sayılarla beslenen gate (FAZ 30'un durumuydu).

---

## Yapılan 10 tarama ve sonuçları

| # | Tarama | Sonuç |
|---|---|---|
| 1 | Tautolojik assertion kalıpları | ⚠️ 9 aday bulundu — çoğu meşru, 3'ü incelenmeli |
| 2 | Eval metrikleri üretimde çağrılıyor mu | ⚠️ `compareResults` hiç kullanılmıyor (0 çağrı) |
| 3 | Stub / not-implemented | ✅ Hepsi "dürüst stub" — sahte başarı yerine açıklayıcı hata |
| 4 | P0-3 `success/skipped` ayrımı | ✅ `isSuccess()` yalnız `succeeded` kabul ediyor; meta-controller yanlış alarm çıktı |
| 5 | P0-1/P0-2 tek loop + CognitiveContext | ⚠️ İki giriş noktası yan yana duruyor (`runTask` vs `execute`) |
| 6 | Kapatılmış test (`it.skip`/`.only`) | ✅ Hiç yok |
| 7 | `expect` içermeyen test | ✅ Hiç yok |
| 8 | CI hangi kapıları koşuyor | ❌ **Dört eval kapısının hiçbiri CI'da değil** |
| 9 | Dokümandaki test sayıları gerçek mi | ✅ Beşi de birebir doğru (17/21/20/17/15) |
| 10 | README olgunluk ayrımı (Madde 63/64) | ✅ Implemented/Beta/Experimental ayrımı mevcut ve dürüst |

---

## Açık eksikler — öncelik sırasıyla

### 🔴 E1 — Eval kapıları CI'da koşmuyor

`.github/workflows/ci.yml` yalnızca `npm run check` (= typecheck + test),
`test:adversarial`, `test:chaos` ve `build` koşuyor. **`eval:validate`,
`eval:baseline`, `eval:learning`, `eval:recall` hiçbiri yok.**

Bu, bu oturumda yapılan işin büyük kısmını savunmasız bırakıyor: FAZ 11 ve
FAZ 30 gate'leri düşse CI yeşil kalır. Bir gate'in tek değeri, kırıldığında
birinin görmesidir.

Not: `eval:recall` varsayılan (hash) encoder ile **kasten** exit 1 döner, yani
CI'a doğrudan eklenemez — ya `EMBEDDINGS_URL` ile koşulmalı ya da
"bilinen-başarısız" olarak ayrı raporlanmalı. Bu tasarlanmayı gerektiriyor.

### 🟠 E2 — İki `runTask` giriş noktası yan yana duruyor

`engine.ts` hem `runTask()` hem `execute()` sunuyor. `execute()` P0-1'in
istediği şey: kendi `TaskContext`'i, gerçek ajan, doğrulama, sınırlı kurtarma.
`runTask()` ise orkestrasyon katmanını sürüyor ve kod kendi yorumunda bunu
itiraf ediyor:

```
runTask("Delete all files on the moon and prove P=NP")
  → outcome: "success", subsystems: 0, phases: 0, outputs: []
```

Yorum "must not be read as evidence that work was performed" diyor — doğru ama
yetersiz: yorum bir koruma değil. Çağıran hâlâ yanlış olanı seçebilir.

**Eksik:** `runTask()`'in bu zayıflığını **test eden** bir şey yok. Deprecation
işareti veya çalışma zamanı uyarısı da yok.

### 🟠 E3 — `compareResults` ölü kod

`packages/eval/src/metrics/metrics.ts::compareResults` — repo genelinde **sıfır**
çağrı (test dahil). Ya bir runner'a bağlanmalı ya silinmeli. Ölü metrik,
"ölçüyoruz" izlenimi veren ama hiçbir şey ölçmeyen yüzey alanıdır.

`formatMetrics` de yalnızca 2 yerde ve runner'da hiç kullanılmıyor — incelenmeli.

### 🟡 E4 — Üç tautoloji adayı incelenmeli

Tarama 9 aday buldu; çoğu meşru (opsiyonel alanın tipini doğrulamak gibi).
Şunlar gate benzeri bağlamda ve bakılmalı:

- `p2-cognitive-telemetry.test.ts:32,33,41` — `typeof stats.totalCostUsd/totalTokens/totalTraces` `"number"` kontrolü. Telemetri **değerlerinin doğruluğu** iddia edilmiyor; sayaç hiç artmasa da geçer.
- `live-suite-baseline.test.ts:54` — `typeof result.metrics.totalSteps` `"number"`. Baseline suite'inde adım sayısının anlamlılığı iddia edilmiyor.
- `aurora-context.test.ts:104` — `typeof stats["auroraContextChars"]` `"number"`.

Bunlar FAZ 11'deki kadar kritik değil (kabul kriteri gate'i değiller) ama aynı
kalıbı taşıyorlar.

### 🟡 E5 — `learning-metrics::evaluateFamily` runner'da kullanılmıyor

`evaluateFamily` 8 çağrının hepsi testten. `evaluateLearningGate` artık
`eval:learning` üzerinden gerçek veriyle besleniyor (bu oturumda eklendi) ama
`evaluateFamily` hâlâ yalnız sentetik veri görüyor. Düşük risk — gate
fonksiyonu zaten onu içeriden çağırıyor.

---

## Kapalı olduğu doğrulanan maddeler (tekrar edilmemeli)

| Madde | Durum | Kanıt |
|---|---|---|
| FAZ 11 Recall@8 | ✅ geçiyor | gerçek encoder 0.317→0.400 (+0.083, 8W/1L/6T) |
| FAZ 29 self-improvement | ✅ + açık kapatıldı | 21/21; tek-vaka terfi engellendi (min 3 held-out) |
| FAZ 30 learning | ✅ ölçüldü | 4/4 aile %42.9; recall kapalıyken 0/4 (kontrol deneyi) |
| P0-3 durum ayrımı | ✅ | `isSuccess()` yalnız `succeeded`; loop doğrulayıcı yokken `unverified` |
| P0-7 failure taxonomy | ✅ ölçüldü | 15/15 tip ulaşılabilir, 11 strateji; `security_block`→abort (sabotajla doğrulandı) |
| P0-8 gap detection | ✅ zaten sağlam | 3 katman + `tierWeight` 100/50/10; LLM katmanı sahte sonuç üretmiyor |
| Madde 63/64 isimlendirme | ✅ | README Implemented/Beta/Experimental ayrımı dürüst |
| Kapatılmış/boş test | ✅ yok | `it.skip`/`.only`/expect'siz test sıfır |

---

## Önerilen sıra

1. **E1** (CI kapıları) — en yüksek değer: yapılan tüm ölçümleri kalıcı kılar.
2. **E2** (`runTask` koruması) — P0-1'in yarım kalan kısmı.
3. **E3** (ölü metrik) — küçük, temiz.
4. **E4** (tautoloji adayları) — küçük, kalıbı tamamen kapatır.
5. **E5** — düşük risk, opsiyonel.

> **Durum: beşi de ele alındı.** Sonuçlar için aşağıdaki
> "Uygulama sonuçları" bölümüne bakın. E5 yanlış alarm çıktı; E2 sırasında
> iddianın kendisi eskimiş bulundu; E4 iki gerçek kusur ortaya çıkardı.

---

# Uygulama sonuçları

Liste onaylandıktan sonra E1→E5 sırayla ele alındı. Her madde için önce
davranış ölçüldü, sonra değişiklik yapıldı, sonra **sabotaj deneyi** ile
korumanın gerçek olduğu kanıtlandı.

## ✅ E1 — Eval kapıları artık CI'da

Dört kapının süresi ve çıkış davranışı ölçüldü:

| kapı | süre | exit |
|---|---|---|
| `eval:validate` | 1.6s | 0 |
| `eval:baseline` | 3.1s | 0 |
| `eval:learning` | 0.4s | 0 |
| `eval:recall` | 0.5s | **1** (hash encoder ile, tasarım gereği) |

Üçü doğrudan eklenebilirdi; `eval:recall` edilemezdi. `continue-on-error` ile
eklemek "kırıldığında kimse görmez" sorununu aynen bırakırdı, o yüzden **iki
farklı şey ayrıldı**:

- **Kabul kriteri** (gerçek encoder gerektirir) → yeni `recall-nightly` job'ı,
  gecelik cron, `EMBEDDINGS_URL` secret'ı ile. Secret yoksa kırmızı X yerine
  GitHub warning basıp "kriter ölçülmedi" diyor — eksik secret için kırmızı X,
  insanları kırmızı X'i yok saymaya alıştırır.
- **Regresyon kilidi** (hash encoder, deterministik) → `eval:recall:lock`.
  Retrieval mantığı değişmediğini kanıtlar, "iyi olduğunu" değil. Çıktısı bunu
  açıkça söylüyor: *"This is NOT the FAZ 11 acceptance criterion."*

Eklenenler: kök `eval:gates` script'i (4 kapı zinciri, 5.3s) ve
`.github/workflows/ci.yml`'de "Acceptance gates (eval)" adımı.

**Sabotaj kanıtı:** `real-memory-pipeline.ts`'deki sıfır-skorlu kuyruk düzeltmesi
kaldırıldı → lock 3 metrikte kaymayı yakaladı
(`hybridRecall expected 0.338889 got 0.311111`, precision ve nDCG dâhil), exit 1.
Lock sabiti kasten bozulduğunda da `eval:gates` zinciri exit 1 verdi.

## ✅ E2 — `runTask()` artık test tarafından pinlenmiş (ve yorumlar düzeltildi)

Ölçüm sırasında **iddianın kendisinin eskidiği** ortaya çıktı. Altı dosyadaki
yorum şunu söylüyordu:

```
runTask("Delete all files on the moon and prove P=NP")
  → outcome: "success", subsystems: 0, phases: 0
```

Gerçek ölçüm (taze engine, iki farklı hedef):

```
runResult.outcome: "skipped", subsystemsUsed: [], phaseResults: []
```

P0-3 çalışması `MetaController`'daki iyimser initialiser'ı düzeltmiş; artık
`"skipped"` dönüyor — yani **doğru** davranış. Ama hiçbir test bunu tutmuyordu
ve yorumlar hâlâ eski hatayı şimdiki zamanla anlatıyordu.

Yapılanlar:
- `engine-execute-integration.test.ts`'e 2 karakterizasyon testi eklendi
  (`"skipped"` pinlendi, `execute()` ile yan yana karşılaştırıldı).
- `engine.ts`: `runTask()` artık `@deprecated`, docblock ölçülen gerçeği
  anlatıyor. Ayrıca eski docblock `result.outcome` örneği veriyordu — gerçek yol
  `result.runResult.outcome`, eskisi `undefined` dönerdi; düzeltildi.
- `cognitive.ts` (control-api, **canlı kod** — `main.ts:3503`'te kayıtlı)
  yorumundaki eskimiş iddia düzeltildi.

**Sabotaj kanıtı:** initialiser `"success"`a geri döndürüldü → 2 test
`expected 'success' to be 'skipped'` ile kırıldı.

## ✅ E3 — `compareResults` silindi

Repo genelinde sıfır çağrı. Ayrıca beklediği alanlar (`overallScore`,
`aggregateMetrics`) suite JSON'ında **hiç yok** — yani gerçek sonuçlara karşı
zaten çalışamazdı. İşlevsel ikizi `dashboard/eval-dashboard.ts`'te canlı.
Yerine neden silindiğini anlatan bir not bırakıldı.

`formatMetrics` ise ilk taramada ölü sanılmıştı; **yanlış alarm** —
`report-generator.ts` → `cli.ts` zinciriyle canlı. Dokunulmadı.

## ✅ E4 — Tautolojik testler gerçek ölçümlerle değiştirildi

Dört dosya. Hepsinde kalıp aynıydı: `expect(typeof X).toBe("number")` veya
`toBeInstanceOf(Array)` — hiçbir şey yapmayan bir implementasyonun da geçtiği
assertion'lar.

| dosya | önce | sonra | bulunan gerçek hata |
|---|---|---|---|
| `p2-cognitive-telemetry` | 4 test, maliyet hiç kaydedilmiyordu | 7 test, gerçek tutarlar | `why()` trace'ler için boş `summary` dönüyordu |
| `p2-adaptive-router` | 4 test, `rulesUpdated >= 0` | 5 test, strateji seçimi | `why()` seçilen yolu hiç söylemiyordu |
| `p2-causal-graph` | 4 test, `toBeInstanceOf(Array)` | 6 test, yol/düğüm kimlikleri | — |
| `live-suite-baseline` | `typeof totalSteps` | `totalSteps > 0` (ölçülen: 21) | — |

Yan ürün olarak **iki gerçek kusur** düzeltildi:

1. **`cognitive-telemetry.why()`** — `DecisionTrace`'te olmayan
   `description`/`statement` alanlarını arıyordu, boş özet dönüyordu. Artık
   hedefi, sonucu, güven değişimini, span/karar sayısını, maliyeti ve
   çıkarılan dersleri anlatıyor.
2. **`adaptive-router.why()`** — `routeName` olarak UUID, `target` olarak
   strateji adı dönüyordu; seçilen yol çıktıda hiç geçmiyordu.
   `alternativeRoutes` ise alakasız kararların id'leriydi. Ayrıca
   `recordOutcome()` çalışmadan önce `success=false` varsayıp "son kullanım
   başarısızdı" uyarısı basıyor ve 0.8 güven veriyordu — **ölçülmemiş ile kötü
   ölçülmüş** karıştırılıyordu (skipped≠success hatasının küçük hâli). Artık
   ayırıyor ve ölçülmemiş karara 0.3 veriyor.

**Sabotaj kanıtları:** maliyet toplaması `+= 0` yapıldı → 2 test kırıldı
(`expected +0 to be close to 0.045`). `quality` stratejisi latency'ye bakacak
şekilde bozuldu → test kırıldı. `findPaths` hep `[]` döndürüldü → test kırıldı
(eski `toBeInstanceOf(Array)` versiyonu bunu **yakalayamazdı**).

## ⚪ E5 — Yanlış alarm, aksiyon yok

`evaluateFamily`, `evaluateLearningGate` içinden `learning-metrics.ts:229`'da
çağrılıyor; o da `eval:learning` ile gerçek `UnifiedExecutionLoop` verisine
bağlı. Sentetik veriye kilitli değil.

---

## Doğrulama (tümü bu turda koşuldu)

- `npm run typecheck` → **0 hata**
- `npx vitest run` → **194 dosya / 1211 test PASS** (önceki: 1203, +8 net)
- `npm run eval:gates` → **exit 0** (4 kapı, 5.3s)
- `npm run eval:recall` → exit 1 (kabul kriteri, gerçek encoder olmadan;
  tasarım gereği)
- `git diff --check` → temiz
- Sabotaj/sonda kalıntısı → yok

---

# İkinci tarama — "sistem tam mı?" (entegrasyon yoğunluğu)

İlk tarama **tautoloji ve ölü kod** arıyordu. Bu tarama farklı bir soru sordu:
dokümanın ana tezi olan *"daha fazla parça değil, parçaların birbirine
bağlanması"* açısından **var olup bağlanmamış** ne kaldı?

## 🔴 F1 — `MemoryEngine.recall()` limit sözleşmesini ihlal ediyordu (DÜZELTİLDİ)

Oturumlardır açık duran şüphe ölçüldü ve **gerçek hata çıktı**.

`recall()` iki depoyu birleştiriyor: memory graph ve long-horizon. Graph
`query.limit`'i alıyordu, long-horizon almıyordu — `search()` kendi içinde
sabit 20 satır döndürüyor ve iki sonuç **ham birleştiriliyordu**:

```
recall({ text: "postgres migration", limit: 3 })  →  23 hafıza
```

(Ölçüm: taze engine, 30 long-horizon + 3 graph kaydı.)

Bu neden önemli: `engine.execute()` bunu **limit vermeden** çağırıyor ve sonuç
doğrudan ajanın prompt'una giriyor. Loop'un `learn` adımı her görevden sonra
hafıza yazdığı için taşma **sistem kullandıkça büyüyor** ve her prompt'u sessizce
şişiriyor. Yani FAZ 30'da ölçülen öğrenme döngüsünün kendisi bu hatayı besliyordu.

**Düzeltme:** iki depoya da `limit` veriliyor, birleşim **önem sırasına göre
sıralanıp** kesiliyor. Sıralama şart: ham kesme, graph önce listelendiği için
daha önemli bir long-horizon hafızasını düşürürdü. `totalFound` artık
döndürülen sayıyı raporluyor — kesme öncesi sayıyı vermek çağırana aldığından
fazla bağlam aldığını söylerdi.

**Kanıt:** `memory-engine-recall-contract.test.ts` (4 test) önce **kırmızı**
yazıldı (23 döndü, 3 beklendi), sonra düzeltildi. İki ayrı sabotaj:
sıralama kaldırıldı → `expected 0.2 to be close to 0.99` (kritik hafıza
düşüyordu); kesme kaldırıldı → 3 test kırıldı.

## 🟠 F2 — Planlama fazı hiç koşmuyordu (DÜZELTİLDİ)

`UnifiedExecutionLoop`'un `plan` hook'u vardı, `PlanningEngine` vardı — ama
`execute()` ikisini **bağlamamıştı**. Her koşuda loop şunu kaydediyordu:

```
unavailable: "No planner was supplied"
```

Loop dürüst davranıyordu (sahte başarı yok), ama bilişsel planlayıcı
yürütmeyi hiç bilgilendirmiyordu. Dokümanın şikâyet ettiği kalıbın tam örneği.

**Düzeltme:** `plan` dep'i `planningEngine.plan()`'e bağlandı.

**Dürüstlük notu (Madde 63):** `decomposeGoal()` sabit bir
Understand → Execute → Verify → Learn iskeleti üretiyor; adım açıklamaları
hedefe göre değişiyor ama bu henüz hedefe özgü derin ayrıştırma **değil**. Kod
yorumuna bu sınır açıkça yazıldı — dolu bir `context.plan` derin planlama
kanıtı sayılmamalı.

**Yan düzeltme:** plan `TaskContext`'te kalıp `TaskReport`'a çıkmıyordu, yani
dışarıdan denetlenemiyordu. `TaskReport.plan` eklendi.

**Kanıt:** 2 yeni test; sabotaj olarak `plan` dep'i koparıldı → ikisi de kırıldı.

## ✅ Bağlı olduğu doğrulananlar (aksiyon yok)

| Bağlantı | Durum |
|---|---|
| P0-4 eval → gerçek agent | `engine-eval.ts:85` ve `engine-eval-trajectory.ts:152` → `engine.execute()` |
| Failure taxonomy → loop | `unified-execution-loop.ts:372` `classifyFailure` + `:373` `chooseRecovery` |
| Gap detection → loop | `:389` `detectGaps` |
| Öğrenme döngüsü kapalı | `learn` → `memoryEngine.store` → sonraki `recall` (başarı 0.7 / sınıflandırılmış hata 0.5) |
| `acquireCapability` | `cognitiveRuntime`'a bağlı, gerçek sandbox sentezi. `execute()` otomatik çağırmıyor çünkü `code` parametresi istiyor — LLM üretmeli. Meşru sınır. |
| Sahte başarı kalıbı | Yeni örnek yok; bulunan `status: "succeeded"` atamaları gerçek iş sonrası |
| Boş `catch {}` | Yalnız listener izolasyonunda; hata yutma yok |

## Doğrulama

`typecheck` 0 hata · `vitest run` **195 dosya / 1217 test PASS** (önceki 1211) ·
`eval:gates` exit 0 (öğrenme gate'i recall değişikliğinden etkilenmedi: 4/4,
%42.9) · `git diff --check` temiz · sabotaj kalıntısı yok.
