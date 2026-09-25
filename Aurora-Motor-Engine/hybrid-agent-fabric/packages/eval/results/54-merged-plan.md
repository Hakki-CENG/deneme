# 51 fazlık plan — kod denetimi ve birleştirilmiş uygulama planı

**Tarih:** 2026-09-20 · **Taban:** 195 dosya / 1217 test PASS · `eval:gates` exit 0

Gelen 51 fazlık planı satır satır koda karşı denetledim. Sonuç tek cümleyle:
**plan mimari olarak doğru, ama fazlarının çoğu bu repoda zaten inşa edilmiş.**

Bu bir eleştiri değil — planın hedef durumu ile sistemin bugünkü hâli örtüşüyor.
Ama "aynı şeyleri yapmayalım" kısıtı gereği, uygulanacak şey planın tamamı
değil, **denetimden geçip gerçekten eksik çıkan kısmı**.

---

## Bölüm 1 — Plan fazlarının kod karşılığı

### Zaten TAM olanlar (uygulanmayacak)

| Faz | İstenen | Kodda |
|---|---|---|
| **2** Version truth | tek `version.ts` | ✅ `engine/src/version.ts` — package.json'dan okuyor, hardcode yok |
| **3** Status contract | 11 durumlu enum, `skipped != success` | ✅ `execution-status.ts` — **11 değerin 11'i** mevcut, `isSuccess()` yalnız `succeeded` |
| **8** Event stream | `afterSequence`/`limit`/`nextSequence` | ✅ 29 kullanım |
| **11** Verification gap | `VerificationGapError` | ✅ 11 kullanım |
| **23** 4 memory tipi | working/episodic/semantic/procedural | ✅ dördü de |
| **24** Hybrid retrieval | BM25+embedding+RRF+reranker | ✅ 26 referans; FAZ 11'de +0.083 ölçüldü |
| **26** Failure taxonomy | 15 kategori | ✅ **15'in 15'i birebir** |
| **27** Recovery policy | 8 strateji | ✅ **11 strateji** (istenenden fazla) |
| **43** Long-horizon | context compaction | ✅ `rolling-micro-compactor.ts` |
| **44** Parallel exec | paralel tool | ✅ `parallel-tool-execution.ts` |
| **47** Immutable core | kill switch, reward hacking | ✅ `reward-hacking-defense.ts` + `detectors.ts` |
| **48** Durable persistence | journal/snapshot/replay | ✅ `command-journal`, `effect-journal`, `snapshot-store`, `session-lease`, postgres |

### KISMEN olanlar → gerçek iş burada

| Faz | Eksik olan tam olarak ne | Ölçüm |
|---|---|---|
| **1** Repo truth | `CURRENT_STATE/MATURITY_MATRIX/KNOWN_GAPS` dosyaları yok; **17/23 eval JSON'u bayat** | 17/23 |
| **12/13** Real planner | plan üretiliyor ama adım durumu hiç güncellenmiyor, DAG atılıyor | `step.status =` → **0**, `dependencies` → **0** |
| **9** Verification factory | V1/V2 gerçek, **V3 consensus hiç üretilmiyor** | `consensusVerifier` → **0** |
| **24** Retrieval | kazanan pipeline **ana yolda kullanılmıyor** | `RealMemoryPipeline` in `unified-engines` → **0** |
| **25** Consolidation/forgetting | `decay()` yazılmış, **hiç çağrılmıyor** | `.decay()` → **0** |
| **28-33** Capability acquisition | uçtan uca zincir kapalı değil | `wiredToEngine: false` |

### Bu repoya uygun OLMAYANLAR

- **FAZ 4** — "runTask deprecated olsun": zaten `@deprecated`, HTTP `/v1/run-task`
  `execute()` kullanıyor. Yapıldı.
- **FAZ 16-20** — "gerçek benchmark": altyapı hazır (61 görev, 11 kategori,
  4 gate CI'da). Eksik olan altyapı değil, **gerçek modelle koşu** — bu bir API
  anahtarı meselesi, kod meselesi değil.
- **FAZ 50** — proaktif Jarvis/ürünleştirme: Madde 79'un "daha fazla UI" yasağına
  giriyor, çekirdek kanıtlanmadan yapılmamalı.

---

## Bölüm 2 — Uygulanacak birleşik plan

Kendi 53-roadmap'imle planın kesişimi. Sıra, planın kendi bağımlılık grafiğine
uyuyor: **önce doğruluk, sonra planlama, sonra doğrulama, sonra hafıza, en son
capability zinciri.**

| # | İş | Kaynak | Neden şimdi |
|---|---|---|---|
| **M1** | Repo truth: 3 durum dosyası + bayat sonuç temizliği | Plan F1 + benim A1 | Yanlış kanıt, hatalı koddan tehlikeli. En ucuz. |
| **M2** | Plan adım durumu + bağımlılık grafiği | Plan F13 + benim B1/B2 | Plan raporlanıyor ama anlamsız (hepsi `skipped`) |
| **M3** | V3 Consensus verifier | Plan F9 + benim C1 | 4 katmanlı tasarımın eksik ayağı |
| **M4** | Hafıza bakımı (decay/consolidation) | Plan F25 + benim D2 | Sessiz bozulma; hafıza tek yönlü büyüyor |
| **M5** | Gerçek encoder'ı ana yola bağla | Plan F24 + benim D1 | Ölçülmüş +0.083 üretimde kullanılmıyor |
| **M6** | Capability zinciri kapanışı | Plan F28-33 + benim F1 | En büyük mimari getiri, en son |

Her madde **Madde 76 DoD** ile bitecek: kod + gerçek yola bağlı + test + eval +
failure davranışı — ve her birinde **sabotaj kanıtı**.


---

## Bölüm 3 — Uygulama günlüğü

### M1 — Repository truth (TAMAMLANDI)

Plan FAZ 1 + kendi haritamın A1 maddesi. Amaç: sistemin durumu hakkındaki
iddiaları ölçülebilir hâle getirmek ve yanlış kanıtı dolaşımdan çıkarmak.

**Yapılanlar**

| # | İş | Sonuç |
|---|---|---|
| 1 | Bayat JSON sonuçları arşivlendi | `results/archive-pre-execute/` — 21 dosya |
| 2 | Bayat MD raporları arşivlendi | aynı dizin — 4 dosya (`difficulty-analysis.md` dâhil) |
| 3 | Faz günlükleri ayrıldı | `results/archive-phase-logs/` — 29 dosya |
| 4 | İki arşive gerekçe README'si | Neden geçersiz + yerine ne kullanılmalı |
| 5 | Durum belgesi üreteci | `packages/eval/src/runner/state-docs-cli.ts` |
| 6 | Üç durum belgesi | `CURRENT_STATE.md`, `MATURITY_MATRIX.md`, `KNOWN_GAPS.md` |
| 7 | Bayatlama testi | `packages/eval/test/state-docs.test.ts` — 16 test |
| 8 | README durum bölümü | Madde 63/64: özellik sayısı değil, olgunluk |

**Neden elle yazılmadı:** repoda zaten 27 adet elle yazılmış
"FAZ NN TAMAMLANDI ✅" dosyası ve `Weighted Score: 100.0%` diyen bir
`difficulty-analysis.md` vardı — hepsi yazıldıktan günler sonra yanlıştı ve
yanlışlaştıklarında hiçbir şey kırılmadı. Üç belge artık koddan üretiliyor,
diverjans hâlinde test kırılıyor.

**Ölçüm: yedi seviyeli olgunluk merdiveni (29 modül)**

`implemented: 1 · initialized: 0 · reachable: 0 · integrated: 2 ·
exercised: 23 · verified: 2 · production: 1`

Kritik ayrım `exercised` (bir test sürüyor) ile `verified` (bir kabul kapısı
ölçüyor) arasında: sistemin çoğu test ediliyor, yalnız 3 modül regresyon
hâlinde kapı kırıyor.

**Sabotaj kanıtı**

| Sabotaj | İlk sonuç | Düzeltme | Son sonuç |
|---|---|---|---|
| Üretilmiş belgeyi elle düzenle (`embodiment` → `production`) | **yakalandı** (1 fail) | — | yakalanıyor |
| `maturity.ts` kaynağını değiştir, **build alma** | **KAÇTI** — 15/15 yeşil | Kaynağı metin olarak okuyup `dist` ile karşılaştıran test eklendi | **yakalanıyor** (1 fail) |

İkinci sabotaj gerçek bir kusur ortaya çıkardı: üreteç kayıt defterini
`dist/`'ten okuyor, `src`'den değil. Build alınmadan yapılan bir düzenleme,
belgelerin eski kayıttan güvenle yanlış üretilmesine yol açıyordu. Testler
geri yüklemeden sonra temiz (`grep -c SABOTAJ` = 0).

**İki üreteç hatası, ölçümle yakalandı**

1. Test dosyalarını iki sabit dizinde aradım; testler **yedi** dizine yayılmış
   (195 yerine 185 saydı). Özyinelemeli yürüyüşe çevrildi.
2. Tam metin karşılaştırması, *bu testin kendisi eklendiği için* sayılar
   değişince kırıldı. Sayılar normalize edilip ayrıca %5 toleranslı sayısal
   testle korunuyor — her yeni test build'i kırmasın diye.

**Doğrulama tabanı (M1 sonrası)**

| Kontrol | Sonuç |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | **196 dosya / 1233 test PASS** (öncesi 195/1217) |
| `npm run eval:gates` | exit 0, 4 kapı |
| Regresyon kilidi | Recall@8 0.317 → 0.339, kilit tutuyor |

**Sıradaki:** M2 — plan adımı durumu + bağımlılık grafiği
(`unified-execution-loop.ts`). Ölçülen boşluk: `step.status =` 0 atama,
döngüde `dependencies` 0 kullanım; `TaskReport.plan` alanı var ama adımlar
daima `"skipped"`.


### M2 — Plan adımı durumu + bağımlılık grafiği (TAMAMLANDI)

Plan FAZ 13 + kendi haritamın B1/B2 maddesi.

**Ölçülen boşluk:** `TaskReport.plan` alanı vardı ama bilgi taşımıyordu. Döngü
her adımı `status: "skipped"` sabitiyle kuruyordu ve bir daha dokunmuyordu —
tamamen yürütülmüş bir plan ile hiç başlatılmamış bir plan **birebir aynı**
çıktıyı veriyordu. Ayrıca `PlanningEngine.decomposeGoal` gerçek bir DAG
üretiyordu, ama kenarlar rapora hiç ulaşmıyordu.

**Kenarların kaybolduğu üç nokta** (her biri tek satır):

| # | Dosya | Ne yapıyordu |
|---|---|---|
| 1 | `unified-engines.ts:255` | `PlanningResult.steps` tipi `dependencies` alanını hiç içermiyordu |
| 2 | `unified-engines.ts:299` | `.map()` `dependencies`'i düşürüyordu |
| 3 | `engine.ts:1804` | Her adımı `` `${name}: ${description}` `` string'ine düzleştiriyordu |

**Yeni: `packages/engine/src/execution/plan-progress.ts`**

İki ayrımı kod seviyesinde zorunlu kılıyor:

- **`not_implemented` ≠ `skipped`** — `skipped` bir *karardır*; kimsenin
  bakmadığı bir adım hakkında karar verilmemiştir. Adımlar artık
  `not_implemented` doğuyor.
- **`blocked` ≠ `failed`** — bağımlılığı çöken adım başarısız olmadı, **sırası
  hiç gelmedi**. İkisini birleştirmek tek bir kök nedeni bağımsız hataların
  çığı gibi gösteriyordu.

Ek olarak: döngüsel bağımlılık ve var olmayan adıma referans artık **planlama
başarısızlığı** (sessizce düzeltilmiyor); `readySteps` yalnız `succeeded`
bağımlılığı tatmin edici sayıyor (`executed` yetmez — çalıştı demek işe yaradı
demek değil).

**Kanıtlanamayan şeyi iddia etmeme:** Ajan hedefi bütün olarak alıyor, adım
adım değil. Adaptör adım sonucu bildirmediğinde adımlar `unverified`
işaretleniyor — `succeeded` değil. Tek bir toplu sonuçtan adım başına yeşil
durum türetmek, tam olarak "10/10, score 1.0" üreten çıkarımdır.

**Sabotaj kanıtı**

| Sabotaj | Sonuç |
|---|---|
| `blocked` → `failed` döndür | **6 test kırıldı** |
| `unverified` → `succeeded` yaz | **1 test kırıldı** |

Geri yükleme temiz (`grep -c SABOTAJ` = 0).

**Bir hatam, testle yakalandı:** `ExecutionOutcome`'un alanını `summary`
varsaydım; gerçekte `evidence`. Şemayı okumadan varsaydığım için 3 test
kırıldı — kendi kuralımın ihlali.

**Doğrulama tabanı (M2 sonrası)**

| Kontrol | Sonuç |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | **197 dosya / 1264 test PASS** (M1 sonrası 196/1233) |
| `npm run eval:gates` | exit 0, 4/4 kapı |
| Öğrenme kapısı | 4/4 aile, ortalama **%42.9** daha az adım |
| Regresyon kilidi | Recall@8 0.317 → 0.339, tutuyor |

Yeni testler: `plan-progress.test.ts` (20) + `unified-execution-loop.test.ts`
(+9) + `engine-execute-integration.test.ts` (+2, **gerçek `execute()` yolunda**
uçtan uca DAG doğrulaması).

**Sıradaki:** M3 — V3 consensus doğrulayıcısı. Ölçülen boşluk:
`V3_consensus` tipi tanımlı, `consensusVerifier` **0 çağrı**.


### M3 — V3 consensus doğrulayıcısı (TAMAMLANDI)

Plan FAZ 9 + kendi haritamın C1 maddesi.

**Ölçülen boşluk:** `VerificationFactory` V3 sonuçlarını **tüketmeyi** ilk
günden biliyordu; hiçbir şey V3 **üretmiyordu**. Tier tanımlıydı, işleniyordu,
belgelenmişti ve erişilemezdi — `consensusVerifier` araması **0** dönüyordu.

**Yeni: `packages/engine/src/execution/consensus-verifier.ts`**

Tasarımın karşı durduğu hata "değerlendiriciler yanılıyor" değil; **"hiç
bağımsız değillerdi, dolayısıyla uzlaşmaları bilgi taşımıyordu ve biz bunu
doğrulama saydık"**.

| Kural | Neden |
|---|---|
| **Bağımsızlık zorunlu** | Tek modele üç prompt = aynı hatayı tekrarlama şansı olan tek değerlendirici. `source` alanı ile ölçülüyor; 2 bağımsız kaynak yoksa panel **hiç çalıştırılmıyor** |
| **Muhalefet ezilemez** | 4 onaya karşı 1 ret → claim **bloke**. Çoğunluk oylaması, panelde gerekçesi olan tek kararı çöpe atardı |
| **Çekimserlik onay değil** | Hata veren veya `uncertain` dönen değerlendirici havuzdan çıkarılır, asla uzlaşma sayılmaz |
| **Güven tavanı 0.75** | Değerlendiricilerin uzlaşması, değerlendiriciler hakkında kanıttır — yer gerçeği değil |

Değerlendiriciler `Promise.all` ile **eşzamanlı** koşuyor: sıralı koşmak birinin
cevabını diğerine taşıma kapısı açardı, bu da tier'ın dayandığı bağımsızlığı yok
ederdi.

**Fabrikada bulunan gerçek kusur:** `verify()` V3 **sonuç sayısı** ≥ 2 arıyordu.
Bu yanlış birim: bağımsızlığı içeride zorlayan tek bir panel **bir** sonuç
üretir ve yok sayılırdı — oysa aynı modeli saran iki doğrulayıcı kuralı
geçerdi. Kural "≥ 1 V3 paneli" olarak düzeltildi; bağımsızlık panelin işi.

**Engine'de bulunan ikinci kusur:** `verifiersFor` içinde `if (!workspace)
return supplied;` ve `if (!recipe) return supplied;` erken dönüşleri, V3
bloğundan önce çalışıyordu — yani tier tam da **gerekli olduğu** durumlarda
(workspace yok ya da toolchain yok) atlanıyordu. Guard yeniden düzenlendi.

**Bağlama kararı:** V3 varsayılan değil **yedek**. Yalnız hiçbir objektif
doğrulayıcı kurulamadığında devreye giriyor — `npm test` oradayken panele
sormak, kanıtın yerine görüş koymaktır. Panel verilmezse V3 üretilmiyor ve
döngü dürüstçe `unverified` diyor.

**Sabotaj kanıtı**

| Sabotaj | Sonuç |
|---|---|
| Bağımsızlık kontrolünü kaldır | **2 test kırıldı** |
| Muhalefeti çoğunlukla ez | **4 test kırıldı** (entegrasyon dâhil) |

**Doğrulama tabanı (M3 sonrası)**

| Kontrol | Sonuç |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | **198 dosya / 1284 test PASS** (M2 sonrası 197/1264) |
| `npm run eval:gates` | exit 0, 4/4 |
| Baseline | 0/61 (hareketsiz model geçemiyor) |
| Öğrenme kapısı | 4/4 aile, **%42.9** daha az adım |

Yeni testler: `consensus-verifier.test.ts` (16) + `engine-execute-integration.test.ts`
(+4, **gerçek `execute()` yolunda** V3 ile `succeeded`).

`maturity.ts` güncellendi: artık "V3 consensus has no implementation" demiyor.

**Sıradaki:** M4 — hafıza bakımı. Ölçülen boşluk: `long-horizon-memory.ts:57
decay()` **0 çağrı**, `autoConsolidate` yalnız manuel HTTP ucundan.


### M4 — Hafıza bakımı: decay + consolidation (TAMAMLANDI)

Plan FAZ 25 + kendi haritamın D2 maddesi.

**Ölçülen boşluk:** `decay()` **0 çağrı**, `autoConsolidate()` yalnız manuel
HTTP ucundan (`aurora-services.ts:325`). Bakım vardı, hiç çalışmıyordu.

**Sonda ile bulunan üç gerçek kusur** (hiçbiri plandan gelmedi):

**1. `autoConsolidate` yapmadığı işi raporluyordu.** Ölçüm:

```
autoConsolidate() -> { promoted: 1, insights: ["Promoted 'hot' from short
                       to long-term (importance: 9)"] }
memories.find(m => m.title === "hot").horizon -> "short"
```

Metin "terfi ettirildi" diyor, depo "short" diyor, ikisini uzlaştıran hiçbir
şey yok. Kod, **kriterlere uyan hafızaları sayıyor** ve hiçbir şeyi
değiştirmiyordu. Yapmadığı işi raporlayan bakım rutini, hiçbir şey yapmayandan
daha kötüdür: çağıran kontrol etmeyi bırakır.

**2. Ölçek çelişkisi hafızayı önemsizleştiriyordu.** `consolidate()`
`Math.min(1, maxImportance + 0.1)` hesaplıyordu — 0..1 ölçeği varsayıyor, oysa
`storeMemory()` 0..10 yazıyor. Ölçüm: **önem 9 ve 8 olan iki hafızayı
birleştirince sonuç 1.** Kırpma her zaman makul görünen bir sayıya indiği için
fark edilmemişti.

**3. İki çelişen decay tanımı.** `decay()` `lastAccessedAt`'ten `decayFactor`
ile yaşlandırıyor; `autoConsolidate` ise "30 günden eski VE importance < 3"
sayıyordu — farklı ölçekte bir eşik, gerçek decay ile ancak ~100 günde
ulaşılabilir. İkisi hiç anlaşmıyordu ve hiçbiri diğerini tetiklemiyordu.

**Ek olarak bulunan:** `autoConsolidate` **idempotent değildi** — ikinci koşu
aynı kümeyi yeniden birleştiriyor, her koşuda bir özet daha üretiyordu. İkinci
çağrıyı ölçene kadar görünmezdi. `consolidatedFrom` geri-bağlantısıyla
düzeltildi.

**Bağlama kararı:** Bakım `learn` hook'una bağlandı — her görevden sonra
(başarılı ya da değil) çalışan tek yer. **Kiracı başına 5 dakikada bir** ile
sınırlandırıldı: consolidation depoyu yeniden yazar, her görevde çalıştırmak
bakımı görev maliyetinin baskın kalemi yapardı. Zaman damgası `await`'ten
**önce** yazılıyor; aksi halde aynı anda biten iki görev örtüşen geçişler
başlatırdı.

**Sabotaj kanıtı**

| Sabotaj | Sonuç |
|---|---|
| Terfiyi geri al (sadece say) | **3 test kırıldı** |
| `MAX_IMPORTANCE` = 1 (ölçek hatası) | **1 test kırıldı** |
| Bakımı `learn` hook'tan kopar | **2 test kırıldı** (entegrasyon) |

Bir sabotaj denemem geçersizdi: `MAX_IMPORTANCE` import'unu kullanılmaz
bırakıp esbuild'i kırdım — testleri değil derlemeyi bozdum. "no tests" çıktısı
yakalama değildir; sabitin **değerini** değiştirerek tekrarladım.

**Doğrulama tabanı (M4 sonrası)**

| Kontrol | Sonuç |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | **199 dosya / 1307 test PASS** (M3 sonrası 198/1284) |
| `npm run eval:gates` | exit 0, 4/4 |
| Öğrenme kapısı | 4/4 aile, **%42.9** daha az adım |

Yeni testler: `memory-maintenance.test.ts` (19) + `engine-execute-integration.test.ts`
(+4, **gerçek `execute()` yolunda** terfi/budama/hız sınırı/hata yutma).

`maturity.ts`'e `aurora/long-horizon-memory` kaydı eklendi (daha önce hiç
yoktu — kendi başına bir dürüstlük boşluğuydu). Kayıt **30 modüle** çıktı.

**Sıradaki:** M5 — `RealMemoryPipeline`'ı ana yola bağlama. Ölçülen boşluk:
`unified-engines.ts` içinde `RealMemoryPipeline` **0 geçiş**.


### M5 — `RealMemoryPipeline` ana yola (TAMAMLANDI)

Plan FAZ 24 + kendi haritamın D1 maddesi.

**Ölçülen boşluk:** `RealMemoryPipeline` (BM25 + vector + RRF + rerank) eval
koşum takımı dışında **0 referans**. `npm run eval:recall` bunu ölçüyordu
(Recall@8 0.317 → 0.400 gerçek encoder ile) ama ajan bu sıralamayı hiç
almıyordu — **projenin ölçtüğü sıralama, ajanın aldığı sıralama değildi.**

**Mimari karar:** Pipeline **depo değil, sıralayıcı** olarak bağlandı. Kendi
korpusunu bellekte tutuyor (`private memories: MemoryItem[]`, kalıcılık yok);
kayıt sistemi yapmak yeniden başlatmada hafıza kaybettirirdi. Kalıcı depoların
döndürdüğü adayları sıralıyor.

**Bulunan iki gerçek kusur:**

**1. `longHorizon.search()` doğal dil sorularına sessizlik dönüyordu.** Tüm
sorgu dizesini tek alt-dize olarak arıyordu:

```
search("t1", "why did the postgres migration fail")  ->  []
```

— depoda "The postgres migration failed because of a missing index" olmasına
rağmen. Çağıranlar soru gönderiyor, alt-dize değil. **Aday üretmeyen bir arama
sıralanamaz, füzyona giremez, iyileştirilemez** — üstündeki her katman boş
sonucu miras alır.

**2. Doğru sinyal `score` değil `bm25Score`.** Ölçüm:

| senaryo | bm25 aralığı | yorum |
|---|---|---|
| hepsi eşit alakalı ("postgres migration", 7 hafıza) | 0.0988 – 0.1360 | %27 fark, tamamen uzunluk normalizasyonu |
| biri gerçekten alakalı ("why did the postgres migration fail") | **2.69 vs 0.00** | gerçek ayrım |

Pipeline'ın birleşik `score`'u **hiç sıfır olmuyor** (RRF her belgeye sıra katkısı
veriyor), dolayısıyla "zayıf eşleşti" ile "hiç eşleşmedi"yi ayıramıyor. `bm25Score`
ayırıyor. Kural: alaka oranı **≥ 2 kat** ise alaka belirleyici, değilse önem.

**Ölçülen iyileşme** ("why did the postgres migration fail", limit 2):

```
ESKI (yalniz importance):        YENI (hibrit):
  1. [0.9] Deployment pipeline     1. [0.4] The postgres migration failed...
  2. [0.8] Team standup 9am        2. [0.9] Deployment pipeline...
  (dogru cevap 3. sirada,          (dogru cevap 1. sirada)
   limit=2 ile hic donmuyor)
```

**Sabotaj kanıtı — biri kaçtı ve gerçek bir test boşluğu ortaya çıkardı**

| Sabotaj | İlk sonuç | Düzeltme | Son |
|---|---|---|---|
| `search`'ü tam-dize eşleşmeye döndür | yakalandı (2 fail) | — | yakalanıyor |
| Beraberlik kuralını kaldır | yakalandı (1 fail) | — | yakalanıyor |
| **Sıralamayı tamamen kaldır** | **KAÇTI — 10/10 yeşil** | Birden çok adayın hayatta kaldığı test eklendi | **yakalanıyor** |

Üçüncüsü önemli: `search()`'e eklediğim terim filtresi senaryoyu **tek adaya**
indiriyordu, sıralanacak bir şey kalmıyordu. **İki düzeltmemden biri diğerini
test edilemez kılmıştı** — özellik test edilmiş görünürken test edilmiyordu.

**Testte bulunan kendi hatam:** "alakasız kelime dağarcığı" için "adaylar
düşürülmesin" testi yazmıştım. Ölçüm, o sorguda **hiç aday olmadığını**
gösterdi — boş dönmek doğru davranış (alakasız hafızayla prompt şişirmek bağlam
bütçesi israfıdır). Test, gerçek davranışı savunacak şekilde yeniden yazıldı.

**Doğrulama tabanı (M5 sonrası)**

| Kontrol | Sonuç |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | **199 dosya / 1314 test PASS** (M4 sonrası 199/1307) |
| `npm run eval:gates` | exit 0, 4/4 |
| Regresyon kilidi | Recall@8 0.317 → 0.339 **değişmedi** |

**Sıradaki:** M6 — capability zincirinin kapanışı (`Task fails → Gap →
Contract → Code → Tests → Sandbox → Verifier → Registry → Broker → retry →
PASS`). Ölçülen boşluk: `maturity.ts` `execution/capability-acquisition` için
dürüstçe `wiredToEngine: false` diyor.


### M6 — Capability zincirinin kapanışı (TAMAMLANDI)

Plan FAZ 28-33 + kendi haritamın F1 maddesi. Planın nihai kriteri:
`Task fails → Gap → Contract → Code → Tests → Sandbox → Verifier → Registry →
Broker → retry → PASS`.

**Önce denetim, sonra kod — ve bu beni yanlış bir dosya yazmaktan kurtardı.**
`capability-acquisition-provider.ts` diye yeni bir dosya yazdım; derleyici
`CapabilityContract` ve `contractFromGap` isim çakışması verdi. Meğer
**470 satırlık tam bir `capability-acquisition.ts` zaten varmış** — statik
analiz, yaşam döngüsü, `ImplementationGenerator`, yem (decoy) savunması dahil.
Yeni dosyayı sildim. *Yazmadan önce aramak, sildikten sonra aramaktan ucuz.*

**Ölçülen boşluk:** Zincirin **tamamı** vardı ve 21 testle kanıtlanmıştı
(`capability-acquisition-e2e.test.ts` uçtan uca retry'ı bile test ediyor).
Eksik olan tek şey: `CapabilityAcquisition`'ın `src` içinde **0 çağrısı**.
`maturity.ts` bunu dürüstçe `wiredToEngine: false` diye kaydetmişti.

**Sandbox'ın gerçekten koruduğu ölçüldü:**

| girdi | sonuç |
|---|---|
| `return input.a + input.b` | **verified** |
| `throw new Error('boom')` | rejected: boom |
| `return 999` (beklenen 5) | rejected: output did not match |
| `require('node:fs').readFileSync(...)` | rejected: **require is not defined** |
| `while(true){}` | rejected: timed out after 5000ms |

Hepsi `trustLevel: quarantine`'de kaldı — **Madde 14 korunuyor**, üretilen kod
core sürecine hiç girmiyor.

**Yapılan bağlama:** `execute()`'a `capabilityGenerator` parametresi eklendi.
Varsayılan yok, model bağlaması yok (**Madde 33**: model yalnız reasoning
substrate; *ne zaman* edinileceğine, doğrulamaya ve kayda Aurora karar verir —
yalnız kod yazımı devredilir). Jeneratör verilmezse döngü eski dürüst
davranışını sürdürüyor: gap `unavailable` olarak raporlanıyor.

**Zayıflatmayı reddettiğim eşik:** `CapabilityAcquisition` en az 2 known-good
ve 1 known-bad (yem) vakası istiyor. `contractFromGap` bunları boş
döndürüyordu, yani zincir eşiği geçemiyordu. **Eşiği düşürmedim** — yem
vakaları, beklenen cevapları koda gömen implementasyona karşı tek savunma.
Bunun yerine `DetectedGap`'e opsiyonel `testCases` eklendi: vaka yoksa
edinim **hiç denemiyor** (jeneratör bile çağrılmıyor). Test vakası olmayan bir
gap bir problemi tarif eder, bir şartnameyi değil.

**Sabotaj kanıtı — biri yine kaçtı, aynı ders**

| Sabotaj | İlk sonuç | Düzeltme | Son |
|---|---|---|---|
| `knownBad` eşiğini kaldır | yakalandı (1 fail) | — | yakalanıyor |
| Statik analizi atla | yakalandı (4 fail) | — | yakalanıyor |
| **`execute()` bağlantısını kopar** | **KAÇTI** | Bağlantıyı ölçen test yazıldı | **yakalanıyor** (3 fail) |

M5'teki ile aynı desen: **testim çıktının varlığını doğruluyordu, davranışını
değil.** `expect(report).toBeDefined()` her zaman geçer.

**Test yazarken bulduğum, ürün hatası olmayan şey:** güçlendirilmiş test önce
başarısız oldu — jeneratör hiç çağrılmıyordu. Ölçtüm: mock ajan "tamamlandı"
diyor, görev `verification_gap` ile bitiyor, taksonomi `add_verification`
seçiyor. `acquire_capability` yalnız **`tool_gap`** sınıflandırmasından
tetikleniyor. Yol doğru çalışıyordu; **senaryom yanlıştı.** Test, ajanın
"araç yok" diye başarısız olduğu gerçek koşula göre yeniden yazıldı.

**Doğrulama tabanı (M6 sonrası)**

| Kontrol | Sonuç |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | **199 dosya / 1320 test PASS** (M5 sonrası 199/1314) |
| `npm run eval:gates` | exit 0, 4/4 |
| Öğrenme kapısı | 4/4 aile, **%42.9** daha az adım |

`maturity.ts`: `execution/capability-acquisition` artık
**`wiredToEngine: true`** — ve kalan boşluk (test vakası sentezi) açıkça
yazıldı.


### M7 — Test vakası sentezi: zincirin gerçekten tetiklenmesi (TAMAMLANDI)

M6 zinciri bağladı ama sonunda dürüst bir boşluk bıraktım: `contractFromGap`
test vakalarını **boş** döndürüyordu, edinim de haklı olarak "doğrulanamayan
şeyi inşa etmem" deyip duruyordu. Yani zincir **gerçek bir gap'te hiç
çalışmıyordu** — yalnız vakaları elle veren testlerde çalışıyordu.

**Karar: vakaları detektör icat etmesin.** İlk içgüdü "gap'ten otomatik test
üret" idi. Reddettim: kendi test verisini uyduran bir detektör kendi ödevini
kendi notlandırır, ve `knownBad` yemi, beklenen cevapları koda gömen
implementasyona karşı **tek** savunma. Bunun yerine vakalar `REQUIREMENTS`
tablosuna, kural başına, **elle** yazıldı.

**Ölçüm önce, kod sonra — ve bu bir yalanı ortaya çıkardı.** `pdf_parsing`
tabloda `synthesisable: true` diye işaretliydi. Sandbox'ta dosya sistemi ve
ikili çözümleme yok; orada yazılacak kod PDF ayrıştırmayı ancak **taklit**
edebilirdi. **`synthesisable: false` yapıldı.** Bir yeteneği inşa
edilebilir diye işaretlemek, sentezi çalışamayacak bir şeyi inşa etmeye
göndermek demek.

`visual_diff` ise saf fonksiyon olarak sabitlendi: piksel dizileri girer,
farklı indeksler çıkar. Pikselleri **yükleyen** şey dışarıda kalır; sentezlenen
ve denetlenen şey karşılaştırmanın kendisi.

**Yem savunmasının gerçekten çalıştığı ölçüldü.** Known-good vakalarını
ezberleyip gerisine sabit dönen bir implementasyon yazdım:

| implementasyon | known-good | yem | sonuç |
|---|---|---|---|
| gerçek karşılaştırma | ok | ok | **verified** |
| sabit `return [1]` | **FAIL** | — | quarantined |
| **ezberci** (3 vakayı bilir) | **ok** | **FAIL** | **quarantined** |

Ezberci **her known-good vakasını geçiyor**. Onu yalnız yem yakalıyor. Bu
yüzden teste bir değişmez eklendi: *yem girdisi hiçbir known-good vakasında
görünmemeli* — görünürse savunma tiyatrodur.

**Zincirin kapanışı (ölçülmüş, `capability-closure-e2e.test.ts`)**

```
görev başarısız → gap: visual_diff (0.93) → sözleşme (3 known-good, 1 yem,
3 adversarial) → kod → statik analiz → sandbox → kayıt →
ORİJİNAL görev 2. denemede → succeeded
```

**Kendi sondamın iki hatası** (ürün hatası değil, ikisi de sözleşmeyi
okumadan yazmaktan): `verifiers` diye alan yazdım, gerçek ad `verifiersFor`;
`tier: "V1"` yazdım, gerçek değer `V1_formal`. İkisi de **sessizce** yok
sayıldı. Üçüncüsü daha öğretici: hep "pass" diyen bir doğrulayıcı koyunca
döngü **başarısız ilk denemeyi** `succeeded` saydı. Dürüst doğrulayıcı
(yetenek yokken fail) ile gerçek sonuç çıktı.

**Sabotaj kanıtı**

| Sabotaj | Sonuç |
|---|---|
| `testCases`'i gap'e taşımayı kaldır | **4 fail** |
| Yemi known-good ile aynı yap | **3 fail** |
| `pdf_parsing`'i tekrar `synthesisable: true` yap | **1 fail** |

**Doğrulama tabanı (M7 sonrası)**

| Kontrol | Sonuç |
|---|---|
| `npm run typecheck` | exit 0 |
| engine + eval | **200 dosya / 1326 test PASS** |
| `npm run eval:gates` | exit 0, 4/4 |

Yol boyunca bir yan bulgu: `wasi-plugin` testi fail veriyordu, benim
değişikliğimden **bağımsız** (`git stash` ile ölçüldü) — eksik build çıktısı,
`vitest`'i doğrudan çağırınca `pretest` koşmuyor. `@haf/wasi-runner` derlendi.

**Dürüst sınır:** Bu **bir** yetenek. `maturity.ts` artık bunu böyle
kaydediyor: 7 kuraldan yalnız `visual_diff` vaka taşıyor, gerisi gap'ini
söyleyip duruyor. "Aurora her eksik aracı kendi kapatabiliyor" **değil**;
"Aurora bir eksik aracı fark edip güvenle inşa edip sonraki denemede
kullanabiliyor" — ve bu ölçülmüş durumda.


### M8 — Denetim raporunun yeniden doğrulanması + sessiz bir güvenlik kusuru (TAMAMLANDI)

Kullanıcı "(b) 51 fazın KISMEN listesine geç" dedi. O listedeki her madde
M1–M7'de kapanmıştı, bu yüzden `51-phase-plan-audit.md`'nin **"gerçek eksikler"**
bölümündeki 7 maddeye döndüm ve hepsini bugünkü koda karşı yeniden ölçtüm.

**Yedisi de kapanmış. Denetim raporu bayat:**

| # | Madde | Bugünkü kanıt |
|---|---|---|
| 1 | `/v1/run-task` → `runTask()` | `execute()` çağırıyor; eski yol `/v1/cognitive-trace`'e uyarıyla taşınmış |
| 2 | `execute()` planner yok | `plan:` hook'u bağlı (`engine.ts:2776`) |
| 3 | `execute()` learning yok | `learn:` hook'u bağlı (`engine.ts:2946`) |
| 4 | Otomatik verifier yok | `this.verification.detect()` bağlı (`:2811`) |
| 5 | Versiyon tutarsız | **hepsi 1.65.0** |
| 6 | `paused` completed sayılıyor | guard var (`session-agent-adapter.ts`) |
| 7 | `engine-eval` `runTask()` | `execute()` kullanıyor (yalnız dosya başlığı bayattı) |

Rapora güvenip "iş kalmadı" demek yerine ölçtüm; **ölçüm raporu çürüttü**.

**Sonra yeni tarama — ve asıl bulgu buradan çıktı.** 30 olgunluk kaydının
28'i bağlı ve testli. Kalan ikisi testsiz görünüyordu:

- **`embodiment`** — kayıt `hasTests: false` diyordu, ama
  `embodiment-integration.test.ts` **20 testle geçiyor**. Kayıt yanlıştı.
- **`domain-experts`** — 342 satır, `engine.ts`'e bağlı, HTTP'den erişilebilir,
  **gerçekten sıfır testi var**.

**Ölçülen kusur (sonda ile, tahminle değil):**

```
checkCompliance("local", "legal", "TR")
  → status = "compliant", score = 100, requirements = 0
```

Sebep: `[].every(r => r.met)` **true** döner. Yani hiçbir kural yüklenmemiş bir
yargı alanı için hukuki uyumluluk sorulduğunda sistem **"tam uyumlu, 100"**
diyordu. Bu rota canlı (`main.ts:3502` → `POST /v1/domain-experts/compliance`).
Yüksek riskli bir alanda verilebilecek **en tehlikeli cevap**: veri yokluğunu
temiz sağlık raporu gibi sunmak.

**Düzeltme:** `status: "unknown"`, `score: 0`, ve ne eksik olduğunu söyleyen bir
`unknownReason`. İlginç olan şu: `"unknown"` durumu tip birleşiminde **zaten
vardı** ve hiçbir üreticisi yoktu. Şimdi var.

`consult()` yolunu da ölçtüm: kaynaksız, confidence 0.2, "profesyonele
başvurun", `requiresProfessionalReview: true`. **Bu dürüst** — olduğu gibi
bırakıldı, yalnız testle sabitlendi.

**Sabotaj kanıtı — biri zayıf çıktı, düzeltildi**

| Sabotaj | İlk | Son |
|---|---|---|
| Boş gereksinim → `compliant`/100'e dön | 1 fail | **2 fail** |
| Kaynaksız danışmada confidence 0.9 | 2 fail | 2 fail |
| Tenant izolasyonunu kaldır | 1 fail | 1 fail |

İlk sabotajda ikinci testim kaçırdı: `status`'a göre dallanıyordu, sabotaj da
`compliant` üretip `else` dalını memnun ediyordu. Değişmezi **kanıta** göre
yeniden yazdım ("gereksinim yoksa verdict olamaz"), şimdi yakalıyor.

**Doğrulama tabanı (M8 sonrası)**

| Kontrol | Sonuç |
|---|---|
| `npm run typecheck` | exit 0 |
| engine + eval | **201 dosya / 1335 test PASS** |
| `npm run eval:gates` | exit 0, 4/4 |

`maturity.ts`: `embodiment` ve `domain-experts` artık `hasTests: true`;
`domain-experts`'in gerçek davranışı (şablon dönen yardımcılar, aranmayan kaynak
veritabanı) ve düzeltilen kusur kayda geçti.


### M9 — Silahlanmamış güvenlik boru hattı (TAMAMLANDI)

Tarama `stable` işaretli 7 kayda odaklandı: en güçlü iddia, yanlışsa en
pahalısı. `security/security-system` — "trust levels, approvals, kill
switches, injection detection" — en yüksek riskliydi.

**Ölçüm (sonda, tahmin değil).** Boru hattını `cognitive-runtime`'ın kurduğu
gibi kurdum:

```
getStats() → injectionDetector: { totalPatterns: 0 }
             killSwitchManager: { totalKillSwitches: 0 }
```

Korumalar `initialize()` içinde yaşıyor, constructor'da değil — ve
**hiç kimse çağırmıyordu.** `cognitive-runtime.initialize()` başka korumaları
(immutable path'ler, reward-hacking desenleri) kuruyor, `this.security`'yi
atlıyordu.

**Bu kusurun neden görünmesi zor:** injection denemesi yine de reddediliyordu.

| | reddedildi mi | gerekçe | detections |
|---|---|---|---|
| silahsız (eski) | **evet** | "Capability not approved for this trust level" | **0** |
| silahlı (yeni) | evet | **"Injection detected"** | 2 (Instruction Override, System Prompt Exfiltration) |

Aynı verdict, **tamamen farklı sebep**. Eski red bir tespit değil, **boş onay
matrisinin yan etkisiydi** — eklenen ilk onay o kazara güvenliği kaldırırdı.
Yeşil görünen bir sistemin sessizce korumasız olmasının ders kitabı örneği.

**Düzeltme:** `AuroraCognitiveRuntime.initialize()` artık
`this.security.initialize()` çağırıyor → 0 yerine **9 desen, 2 kill switch,
2 trust policy, 3 onay**. İdempotans ikinci çağrıyla ölçüldü: sayılar
değişmiyor (çoğalan kill switch, reset'te tetikli kopya bırakırdı).

**`stable` → `beta` indirildi.** Kayıt "dördü de uygulandı" diyordu; doğruydu
ama *silahlanmadığını* atlıyordu. Dahası `checkSecurity()`'nin hâlâ
`execute()` yolunda çağıranı yok. **Silahlı ama sorulmayan bir güvenlik
modülü beta olarak dürüst, stable olarak yanıltıcıdır.** `maturity-registry`
testi `security-system`'i "sandbox-backed stable" grubuna koyuyordu; ölçülen
gerçeğe göre kendi testine ayrıldı.

**Sabotaj kanıtı**

| Sabotaj | Sonuç |
|---|---|
| `security.initialize()` çağrısını kaldır | **2 fail** |
| `checkSecurity`'den kill switch kontrolünü çıkar | **1 fail** |
| Injection desenlerini boşalt | **2 fail** |

**Kendi hatam:** sondada sınıf adını `CognitiveRuntime` diye uydurdum; gerçek
ad `AuroraCognitiveRuntime`. M7'deki `verifiersFor`/`V1_formal` hatasının
aynısı — sözleşmeyi okumadan yazmak.

**Doğrulama tabanı (M9 sonrası)**

| Kontrol | Sonuç |
|---|---|
| `npm run typecheck` | exit 0 |
| engine + eval | **202 dosya / 1342 test PASS** |
| `npm run eval:gates` | exit 0, 4/4 |

**Açık kalan, bilerek:** `checkSecurity()` artık silahlı ama ajan girdisini
oradan geçirmek ayrı bir değişiklik — kendi failure mode'ları var, buraya
sıkıştırılacak bir satır değil. `gapToStable` bunu aynen söylüyor.
