# Aurora — Yol Haritası (üçüncü tarama sonrası)

**Tarih:** 2026-09-20 · **Taban:** `typecheck` 0 hata · `vitest run` **195 dosya
/ 1217 test PASS** · `eval:gates` exit 0

Bu belge **sistemde zaten olanı tekrar etmez**. Her madde ya ölçülmüş bir
boşluğu kapatıyor, ya da var olan bir parçayı ölçülmüş bir zayıflığından
güçlendiriyor. Her maddede *neden* ve *kanıt* var; kanıtı olmayan madde
listeye girmedi.

---

## Önce: sistemde ZATEN olan ve dokunulmayacaklar

Tarama sırasında "eksik" sanıp doğruladığım, aslında **mevcut ve sağlam**
olanlar. Bunlar yol haritasına girmiyor:

| Alan | Durum |
|---|---|
| Prometheus `/metrics`, `/health`, OTLP exporter | `observability/` — üçü de var |
| SSE streaming (Madde 34) | `main.ts:2303,2404` `text/event-stream` — gerçek |
| Bütçe zinciri (token/cost/toolCall) | Event'lerden çıkarılıp `TaskContext`'e yazılıyor, `budgetExceeded()` enforce ediyor |
| Failure taxonomy → recovery | Loop'ta bağlı (`:372`, `:373`) |
| Gap detection 3 katman | Loop'ta bağlı (`:389`), LLM katmanı dürüstçe hata fırlatıyor |
| Öğrenme döngüsü | `learn` → `store` → `recall` kapalı |
| Eval → gerçek agent (P0-4) | `engine.execute()` üzerinden |
| Güvenlik | 8 ayrı test dosyası: adversarial, OPA, sandbox, web, RLS |
| Olgunluk kaydı (Madde 63/64) | 28 modül, `stable/beta/experimental`, dürüst |
| V1/V2 doğrulayıcılar | Gerçek: build = formal, test = empirical |

---

## FAZ A — Dürüstlük borcu (küçük, yüksek getiri)

> Sistem doğru çalışıyor ama **yanlış şey anlatıyor**. En ucuz iş, en yüksek
> güven getirisi.

### A1 — Bayat eval sonuçlarını temizle 🔴

**Ölçüm:** `packages/eval/results/` altındaki **23 JSON'un 17'si** eski
aldatıcı `runTask()` formatından üretilmiş. Örnek:

```json
{"totalTasks":10,"passed":10,"overallScore":1,"durationMs":1830,
 "details":"Outcome: success, Subsystems: 3, Phases: 3, Duration: 2ms"}
```

10/10 ve `score 1.0` — 2 milisaniyede, hiçbir ajan koşmadan. Bunlar
düzeltilmiş kodun değil, **kapatılmış hatanın kalıntısı**. Repoda durdukları
sürece "Aurora %100 geçiyor" diye okunabilirler.

**Yapılacak:** Eski formatlı sonuçları sil veya `results/archive-pre-execute/`
altına taşıyıp `README` notu koy: *"bu dosyalar `runTask()` döneminden, geçerli
değil."* Yeni sonuçların formatını `status`/`verification` içerecek şekilde
sabitle.

**DoD:** `grep -l "Subsystems:" results/*.json` → 0 (veya hepsi arşiv altında).

### A2 — `TaskReport` JSON şemasını sabitle

Eval sonuçları serbest biçimli; `overallScore` gibi alanlar bazı dosyalarda
var, bazılarında yok (`compareResults` bu yüzden ölmüştü). Bir zod şeması +
şema sürümü, sonuçları karşılaştırılabilir yapar.

**Güçlendirme:** mevcut `TaskReport` zaten zengin — eksik olan diske yazılan
formun sözleşmesi.

---

## FAZ B — Planlamayı gerçek yap (F2'nin devamı)

> Planlama fazı geçen turda **bağlandı**. Şimdi plan gerçekten yürütmeyi
> yönlendirmeli. Bu, var olanı güçlendirmenin en net örneği.

### B1 — Plan adımlarının durumu güncellensin 🔴

**Ölçüm:** `grep -c "step.status =" unified-execution-loop.ts` → **0**.
Plan üretiliyor, `TaskReport.plan`'a çıkıyor, ama **her adım sonsuza kadar
`"skipped"`**. Yani rapor "4 adım planlandı, 4'ü atlandı" diyor — hangi adımın
yapıldığı bilinmiyor.

**Yapılacak:** ACT ve VERIFY fazları ilerledikçe ilgili adımı
`executed`/`succeeded`/`failed` olarak işaretle. En az: ajan koştuysa "Execute"
adımı, doğrulayıcı koştuysa "Verify" adımı güncellensin.

**DoD + sabotaj:** Bir testte tüm adımların `skipped` kalmadığını doğrula;
güncellemeyi kaldır → test kırılsın.

### B2 — Bağımlılık grafiği loop'a geçsin

**Ölçüm:** `decomposeGoal()` gerçek bir DAG üretiyor
(`dependencies: ["Understand"]`, `[prev]` …) ama `engine.ts`'deki `plan` dep'i
adımları `"ad: açıklama"` string'ine düzleştiriyor —
`grep -c dependencies unified-execution-loop.ts` → **0**. Graf üretilip
atılıyor.

**Yapılacak:** `plan` dep'inin dönüş tipini yapılandırılmış hale getir
(`{name, description, dependencies}`), loop bağımlılık sırasını korusun.

### B3 — Hedefe özgü ayrıştırma (dürüstlük sınırını kaldır)

**Mevcut durum, kodda yazılı:** iskelet sabit —
Understand → Execute → Verify → Learn; yalnız açıklamalar hedefe uyarlanıyor.
Bu, geçen tur `engine.ts` yorumuna dürüstçe not edildi.

**Yapılacak:** model destekli ayrıştırma; çıktı şema ile doğrulansın, boş/geçersiz
plan `planning_failure` olarak sınıflansın (taksonomi zaten bu tipi tanıyor).
**Yapılmayacak:** "her hedef için 4 adım" şablonunu daha fazla `if/else` ile
şişirmek.

**DoD:** İki farklı hedef → **farklı adım isimleri** (sadece farklı açıklama
değil). Sabit iskelete geri dönülürse test kırılsın.

---

## FAZ C — Doğrulama katmanını tamamla

### C1 — V3 Consensus doğrulayıcı 🟠

**Ölçüm:** `V3_consensus` tipi, ağırlığı (`2`) ve özerklik kuralı
(`"controlled"`) **tanımlı**; `consensusVerifier` üreten kod **sıfır**
(`grep` → 0). Yani dört katmanlı tasarımın üçüncüsü kâğıt üzerinde.

**Neden değerli:** V1/V2 yalnız derlenebilir/test edilebilir işleri kapsıyor.
"Bu doküman iyi mi", "bu özet doğru mu" gibi işler şu an doğrudan V4
(insan) oluyor. V3, birden fazla değerlendiricinin mutabakatıyla bu boşluğu
kapatır — factory'de birleştirme mantığı (`V3'ler arası mutabakat`) zaten yazılı.

**Dikkat (Madde 14/33):** consensus, doğrulayıcının kendini değiştirememesi
kuralına tabi; üretilen kod core'a yüklenmez.

### C2 — `unverified` oranını ölçen bir gate

Loop doğrulayıcı yoksa dürüstçe `unverified` diyor — doğru davranış. Ama
**kaç görevin unverified kaldığı ölçülmüyor**. Bu oran yükselirse sistem
sessizce "hiçbir şeyi doğrulayamıyor" durumuna kayar.

**Yapılacak:** `eval:gates`'e ekle: örnek görev kümesinde `unverified` oranı
eşiğin üstüne çıkarsa FAIL.

---

## FAZ D — Hafıza kalitesi (F1'in devamı)

### D1 — Gerçek encoder'ı ana yola bağla 🟠

**Ölçüm:** FAZ 11'de `RealMemoryPipeline` gerçek encoder'la
**0.317 → 0.400 (+0.083)** ölçüldü. Ama
`grep RealMemoryPipeline unified-engines.ts` → **yok**. Yani kazanan retriever
eval'de kanıtlandı, **`MemoryEngine.recall()` onu kullanmıyor** — ana yol hâlâ
graph + long-horizon füzyonu.

**Yapılacak:** `MemoryEngine`'i `RealMemoryPipeline` üzerinden çalışacak şekilde
bağla (encoder yoksa mevcut yola düş). Bu, eval'de ölçülen kazancı üretime
taşır.

**DoD:** Recall kalitesi ana yolda ölçülsün; `EMBEDDINGS_URL` yokken davranış
bozulmasın.

### D2 — Hafıza bakımı hiç çalışmıyor 🟠

**Ölçüm:** `long-horizon-memory.ts` içinde `decay()` ve `autoConsolidate()`
ikisi de **var ve gerçek**. Ama:

- `decay()` → repo genelinde **0 çağrı**. Hiç çalışmıyor.
- `autoConsolidate()` → **1 çağrı**, o da manuel HTTP:
  `POST /v1/memory/consolidate`. Birinin elle tetiklemesi gerekiyor.
- Scheduler'da hafıza bakımı **yok** (`scheduler/` içinde decay/consolidate
  araması boş).

**Neden önemli:** Hafıza tek yönlü büyüyor. Geçen turda `recall()`'un `limit`
ihlalini kapattık (23 → 3), ama **altta yatan büyüme** duruyor: `learn` her
görevden sonra yazıyor, hiçbir şey budamıyor. Zamanla arama yavaşlar ve
alaka düşer — `decay` tam bunun için yazılmış, sadece kimse çağırmıyor.

**Yapılacak:** Scheduler'a periyodik bakım işi ekle (decay + autoConsolidate).
Çürüme oranı yapılandırılabilir olsun; bakım işi **kendi sonucunu raporlasın**
(kaç kayıt çürüdü/birleşti) ki sessizce hiçbir şey yapmadığı fark edilsin.

**DoD + sabotaj:** Bakım öncesi/sonrası kayıt sayısı ve önem dağılımı ölçülsün;
`decay()` çağrısını kaldır → test kırılsın.

---

## FAZ E — Ölçeklenebilirlik (yapısal)

### E1 — `DurableJsonState` bağımlılığını azalt 🟠

**Ölçüm:** **77 servis** durumunu JSON dosyasında tutuyor; yalnız event-store
Postgres destekli.

**Sonuçları:** tek süreç dışında paylaşılamaz; eşzamanlı yazımda dosya kilidi
darboğazı; yatay ölçekleme mümkün değil.

**Yapılacak:** `DurableJsonState` arkasına bir depo arayüzü koy (JSON | Postgres),
**en sıcak 3-5 servisten** başla. 77'sini birden taşımak Madde 79'a (gereksiz
büyük iş) girer.

**DoD:** Aynı testler her iki backend'de de geçsin.

### E2 — Eşzamanlılık testi

`cognitive-state-isolation.test.ts` var. Eksik olan: **aynı tenant'ta iki
görev aynı anda** koşarken durum bozulması. `PlanningEngine`'de bunun bir izi
var (kod yorumu "iki eşzamanlı çağrı birbirini eziyordu" diyor — slot ile
çözülmüş). Aynı sınıf hata başka serviste olabilir.

---

## FAZ F — Yetenek kazanımı döngüsünü kapat

### F1 — `acquireCapability` otomatik tetiklensin

**Mevcut:** `engine.acquireCapability()` gerçek — sandbox'ta sentezleyip
doğruluyor. Ama `execute()` onu **kendi başına çağırmıyor**; `code` parametresi
istiyor, yani kodu birinin üretmesi gerek. Gap detection eksikliği isimlendirdiği
halde döngü orada duruyor.

**Yapılacak:** Gap → model kod üretir → **karantina → sandbox → statik analiz →
doğrulama → registry** (Madde 14 zinciri, aynen korunacak) → retry.
`maturity.ts` bu modülü zaten `wired=false` diye işaretliyor — dürüst, ve
kapatılacak boşluk tam olarak bu.

**DoD:** Uçtan uca bir test: eksik yetenek → sentez → doğrulama → aynı görev
ikinci denemede başarılı. Doğrulama başarısızsa karantinada kalsın.

---

## FAZ G — Geliştirici deneyimi

### G1 — `eval:gates` için tek sayfalık pano

**Ölçüm:** `dashboard/eval-dashboard.ts` **var**, `generateDashboard()` ve
`saveDashboard()` export ediyor, regresyon karşılaştırması içeriyor
(`overallScore` düşüşünü rapor ediyor) — ama repo genelinde **0 çağrı**.
`results/dashboard.md` elle üretilmiş ve bayat.

Küçük iş, iyi getiri: `eval:gates` sonrası panoyu üret. Not: A1'deki bayat
sonuçlar temizlenmeden pano üretmek, çöp veriyi resmîleştirir — **A1'den sonra
yapılmalı**.

### G2 — CI'da gate geçmişi

Şu an her koşu bağımsız. Gate değerlerini (Recall@8, öğrenme %, unverified
oranı) zaman serisine yaz ki **yavaş bozulma** görünsün.

---

## Öncelik sırası

| Sıra | Madde | Neden |
|---|---|---|
| 1 | **A1** | Yanlış kanıt, doğru koddan daha tehlikeli. Ucuz. |
| 2 | **B1** | Plan raporlanıyor ama anlamsız (`hepsi skipped`). Küçük, net. |
| 3 | **D1** | Ölçülmüş +0.083 kazanç üretimde kullanılmıyor. |
| 4 | **C1** | Dört katmanlı doğrulamanın eksik ayağı. |
| 5 | **F1** | P1'in kalbi; en büyük iş, en yüksek mimari getiri. |
| 6 | **B2/B3** | Planlamayı şablondan çıkar. |
| 7 | **E1** | Yapısal, büyük; erken başlamak riskli değil ama acil değil. |
| 8 | **A2, C2, D2, E2, G1, G2** | Destekleyici. |

---

## Bu listeye girmeyenler (Madde 79)

Yeni provider, blockchain, federated learning genişletmesi, agent economy, P2P,
yeni cognitive sınıf, ek UI, "neural" etiketli katman, self-training ağırlıklar.
Hiçbiri ölçülmüş bir boşluğa karşılık gelmiyor.

---

## Ek: her maddenin kanıtı (ölçüm çıktısı)

Bu tablodaki her satır tarama sırasında komutla ölçüldü. Kanıtı olmayan hiçbir
madde listeye alınmadı.

| Madde | Ölçüm | Sonuç |
|---|---|---|
| A1 | `grep -l "Subsystems:" results/*.json` | **17 / 23** dosya eski formatta |
| B1 | `grep -c "step.status =" unified-execution-loop.ts` | **0** — adımlar hep `skipped` |
| B2 | `grep -c "dependencies" unified-execution-loop.ts` | **0** — DAG üretilip atılıyor |
| C1 | `grep consensusVerifier` (factory hariç) | **0** — V3 hiç üretilmiyor |
| D1 | `grep RealMemoryPipeline unified-engines.ts` | **0** — kazanan retriever ana yolda yok |
| D2 | `grep "\.decay("` (tanım hariç) | **0** — hafıza bakımı hiç koşmuyor |
| E1 | `grep -l DurableJsonState src/` | **77** servis JSON'da |
| F1 | `maturity.ts` capability-acquisition | `wiredToEngine: false` (kayıt dürüst) |
| G1 | `grep generateDashboard` (tanım hariç) | **0** — pano üretilmiyor |

### Taramanın kendi sınırları

Dürüst olmak gerekirse bu tarama şunları **yapmadı**:

- Gerçek bir LLM ile uçtan uca koşu yapılmadı (mock provider kullanıldı), yani
  "gerçek modelle kaç görev geçiyor" hâlâ ölçülmemiş bir soru. A1 bunun neden
  önemli olduğunu gösteriyor: elde bu soruya cevap gibi görünen ama olmayan
  17 dosya var.
- Yük/performans ölçümü yapılmadı; E1'in gerekçesi yapısal akıl yürütme
  (77 servis, tek süreç), ölçülmüş bir darboğaz değil.
- 293 kaynak dosyanın tamamı tek tek okunmadı; tarama kalıp aramasıyla yapıldı,
  dolayısıyla "bulunmadı" ≠ "yok".
