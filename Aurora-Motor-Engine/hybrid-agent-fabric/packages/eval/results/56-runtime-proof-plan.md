# N Planı — "Declared complete" → "Runtime proven complete"

**Tarih:** 2026-09-20
**Kaynak:** Kullanıcının dış denetimi + benim `55-system-level-assessment.md`
ölçümlerim.

---

## 1. Denetimin doğrulanması

Denetçi dürüstçe "testleri çalıştıramadım, bu statik bir audit" dedi. Ben
çalıştırabiliyorum. **Her iddiayı önce ölçtüm.**

| # | Denetim iddiası | Ölçüm | Sonuç |
|---|---|---|---|
| 1 | M4: başarılı görevde `maintainMemory()` hiç çalışmıyor | başarılı → **0 çağrı**, başarısız → 1 | ✅ **DOĞRU** |
| 2 | "Planner deliberately NOT wired" yorumu yalan | yorum :2911, bağlantı :2776 — **135 satır arayla çelişiyor** | ✅ **DOĞRU** |
| 3 | Planner goal'dan bağımsız meta-faz üretiyor | PostgreSQL→`Understand→Simulate→Execute→Verify→Learn`, haiku→`Understand→Execute→Verify→Learn` | ✅ **DOĞRU** |
| 4 | Doğrulanan capability broker'a kayıt olmuyor | `capability-acquisition.ts`'te `CapabilityBroker` → **0 referans** | ✅ **DOĞRU** |
| 5 | `checkSecurity()` execute() yolunda çağrılmıyor | `engine.ts` **0**, `unified-execution-loop.ts` **0** | ✅ **DOĞRU** |
| 6 | M5: production'da semantic encoder yok | `new RealMemoryPipeline()` — sağlayıcı verilmiyor, hash encoder | ✅ **DOĞRU** |
| 7 | `wiredToEngine` elle yazılıyor, kanıt değil | `maturity.ts:51` elle `true` | ✅ **DOĞRU** |
| 8 | `verify-integration.ts` hâlâ 1.64.0 bekliyor | repo genelinde `1.64.0` → **0 eşleşme** | ❌ **ÇÜRÜDÜ** (zaten temiz) |

**7/8 doğru.** Denetim ciddiye alınmalı.

### Benim ölçümümle örtüşen kısım

`55-system-level-assessment.md`'de bulduğum "11 pipeline'dan 11'i `getStats()`
için, yalnız 3'ü gerçek iş için çağrılıyor" bulgusu, denetçinin "declared
integrated ≠ runtime proven" teşhisinin aynısı. İki bağımsız yol aynı
sonuca çıktı.

### Katılmadığım nokta

Denetim "M1 truth generation gerçek değil" diyor. Kısmen haklı ama
`wiredToEngine`'i **çalışma zamanı kanıtına** çevirmek tek satırlık iş değil:
her modül için gerçek bir görev koşup çağrıyı gözlemlemek gerekir. Bunu
N5'te, sahte bir otomasyonla değil, **gerçek bir prob ile** yapıyorum.

---

## 2. Reddettiğim maddeler ve gerekçeleri

Denetim 82 madde öneriyor. Hepsini uygulamak Madde 79'un ("daha fazla
özellik") ihlali olur. Şunları **bilerek yapmıyorum**:

| Öneri | Neden hayır |
|---|---|
| "execute()'a reasoning/attention/world/society ekle" (P0-1) | Denetimin kendi teşhisi feature explosion. Ana yola 5 subsystem daha eklemek teşhisin tersi. Önce var olanlar kanıtlansın. |
| "Gerçek semantic embedding default olsun" | `@xenova/transformers`'ı engine'e dep eklemek daha önce denendi ve reddedildi (bilinen çıkmaz). Bu bir altyapı kararı, kod düzeltmesi değil. |
| "Git history rewrite, eval results temizliği" | Kullanıcının verisi. İzinsiz geçmiş silinmez. |
| "Planner'ı task-specific yap" | Gerçek iş, ama LLM planlaması gerektirir → Madde 33 sınırında. Ayrı bir faz. |
| "62 task yerine 30 gerçek task" | Task setini küçültmek kanıtı azaltır. Standardizasyon ayrı iş. |
| "Statistical significance / bootstrap" | Haklı ama N sırasında değil; eval matematiği ayrı bir uzmanlık alanı. |

---

## 3. N Planı — 5 madde, hepsi "runtime proven"

Sıra, **risk × kanıtlanabilirlik**'e göre. Her madde bir **gerçek davranış
değişikliği** + **sabotaj kanıtı** ile bitecek.

| # | İş | Neden | Kaynak |
|---|---|---|---|
| **N1** | `maintainMemory()` başarılı görevde de koşsun | Ölçülmüş bug: 0 çağrı. M4'ün kendi iddiası yanlış. | Denetim #1 |
| **N2** | Yalan yorumu sil, planner'ın gerçek sınırını yaz | Kod ↔ yorum çelişkisi geliştiriciyi yanıltır | Denetim #2/#3 |
| **N3** | Doğrulanan capability'yi broker'a kaydet | M6/M7'nin kapanmamış son halkası — "üretildi" ≠ "kullanılabilir" | Denetim #4 + benim M7 notum |
| **N4** | `checkSecurity()`'yi gerçek aksiyon yoluna bağla | M9'da silahlandırdım, sorulmuyordu. Kendi açık bıraktığım madde. | Denetim #5 + benim M9 notum |
| **N5** | `runtimeObserved` alanı: kanıtlı entegrasyon | `wiredToEngine` beyan, kanıt değil. Meta-bulgunun çözümü. | Denetim #7 + benim getStats bulgum |

**Kabul kriteri (her madde):** kod + gerçek yola bağlı + test + sabotaj kanıtı
+ olgunluk kaydı gerçeğe uygun. Beşi yoksa `implemented`, `completed` değil.

---

## 4. Uygulama günlüğü

(Aşağıya her N maddesi tamamlandıkça eklenecek.)

### N1 — Başarılı görevde hafıza bakımı (TAMAMLANDI)

Ölçüm: başarılı görev → `maintainMemory` **0 çağrı**, başarısız → 1. Sebep
`learn` hook'unda başarı dalındaki erken `return`. Hemen altındaki yorum ise
"her görevden sonra çalışması garanti olan tek yer" diyordu — **yanlış, tam da
yaygın durumda.** Mağazayı büyüten başarılı görevlerdi, bakım atlanan da onlar.

Mevcut iki bakım testi bunu neden kaçırdı: ikisi de workspace'siz görev
kullanıyor, o görevler `unverified` bitiyor — yani **yalnız başarısızlık dalını**
test ediyorlardı. Yeni test önce `status === "succeeded"` doğruluyor, böylece
sessizce aynı dala geri düşemez. Ölçüm: **0 → 1**.

**Sabotaj:** erken `return`'ü geri koy → **1 fail**.

---

### N2 — Yalan söyleyen yorum (TAMAMLANDI)

Kaynak `// Planner: deliberately NOT wired` diyordu, **135 satır altında** her
görevde planner'ı çağıran `plan:` hook'u vardı. Bayat yorumdan kötüsü: geliştirici
ya var olanı yeniden yazar ya da döngüye jenerik plan gitmediğini sanır.

Yorum ölçülen gerçekle değiştirildi ve **sınır teste bağlandı**:

```
"Optimize the PostgreSQL migration..."  → Understand → Simulate → Execute → Verify → Learn
"Write a haiku about the sea"           → Understand → Execute → Verify → Learn
```

Testi yazarken ölçtüğüm ayrıntı: goal metni **yalnız ilk adımın** açıklamasına
yapıştırılıyor. Yani "plan postgres'ten bahsediyor" doğru ama anlamsız; sonraki
adımlar iki alakasız hedefte **kelimesi kelimesine aynı**. Test bunu kontrol
ediyor. Gerçek bir planner gelirse bu test **düşmeli** — düşmesi silinme
işaretidir.

---

### N3 — Zincirin son halkası: broker kaydı (TAMAMLANDI)

Denetimin en değerli tespiti: **"CAPABILITY GENERATED" ile "CAPABILITY
AVAILABLE TO REAL AGENT" farklı cümleler ve yalnız ilki doğruydu.**
`acquire()` `acquired: true` dönüyordu, implementasyon sentez boru hattının
özel map'inde kalıyordu; döngü orijinal görevi, az önce inşa ettiği şeyi hiç
duymamış bir envantere karşı yeniden deniyordu.

**Madde 14 nasıl korundu:** adaptör üretilen kodu **çalıştırmıyor**. Broker'a
kaydettiği capability'nin `execute()`'ı her çağrıyı **sandbox'a geri delege
ediyor** (`testInSandbox`) — aynı izole VM, aynı limitler. Kod karantinadan
çıkmıyor; değişen tek şey, broker'ın kendi politika/onay/effect-journal
denetimi altında ona çağrı yönlendirebilmesi.

**Ölçülen sonuç:**

```
acquire: true (verified)
broker ONCE : 0 capability
publish     : acquired.visual_diff
broker SONRA: [{id:"acquired.visual_diff", risk:"pure", source:"skill"}]
broker.execute({a:[1,2,3], b:[1,9,3]}) → [1]     ✔
broker.execute({a:[4,4,4,4], b:[4,0,4,0]}) → [1,3] ✔ (ezber değil, hesaplıyor)
ikinci publish → false, "already registered"      ✔ idempotent
```

**İki tasarım kararı:**

- **`acquired.` ad alanı.** Üretilen bir `fs.write` gerçek olanı gölgelemesin.
- **`risk: "pure"`** — ve bu bir hoşgörü değil, **doğruluk**. `CapabilityRisk`
  *neye erişebildiğini* anlatıyor, *ne kadar güvenildiğini* değil. Sandbox'ta
  dosya sistemi/ağ/process yok (M6'da ölçüldü: `require` tanımsız, sonsuz döngü
  timeout'la öldürüldü). Daha yüksek kategori iddia etmek, yapamayacağı
  erişimlere karşı koruma söyleyip **asıl endişeyi** (implementasyonun genç
  olması) hiç söylememek olurdu; o endişe açıklamada ve ad alanında duruyor.

Yol boyunca **ikinci bir yalan yorum** bulundu: "Capability acquisition is
deliberately NOT wired yet" — M6'da bağlanmıştı. Düzeltildi.

**Sabotaj kanıtı**

| Sabotaj | Sonuç |
|---|---|
| `register()` çağrısını kaldır | **5 fail** |
| Sandbox yerine sabit değer döndür | **1 fail** |
| `acquired.` ad alanını kaldır | **3 fail** |

**Doğrulama:** typecheck 0 hata · **203 dosya / 1350 test PASS** ·
`eval:gates` 4/4.

**Dürüst sınır:** `execute()` üzerinden uçtan uca ölçtüğümde kayıt
tetiklenmedi — çünkü mock ajan "tamamlandı" diyor, görev `verification_gap`
ile bitiyor ve `acquire_capability` yalnız `tool_gap`'ten tetikleniyor. Bu
bilinen ve doğru davranış (M6'da da ölçülmüştü); zincir döngü seviyesinde
kanıtlandı.

---

## N4 — checkSecurity() gerçek aksiyon yoluna bağlandı

**Denetim maddesi:** "M9 'pipeline armed' sorununu çözer, 'pipeline protects all real
agent actions'ı çözmez." M9 boru hattını silahlandırdı (0 desen → 9 desen, 0 kill
switch → gerçek switch'ler) ama kimse ona bir şey sormuyordu.

### Bağlanma noktası: broker, engine.execute() değil

`engine.execute()` içine bir kontrol koymak döngünün *kendi* defter tutmasını korurdu;
HTTP üzerinden açılan oturum, MCP tool call, plugin — hepsi kaçardı. Yan etkiler
`execute()`'ta olmuyor, broker bir capability'yi çalıştırdığında oluyor ve bu yolların
hepsi `CapabilityBroker.execute()`'ta birleşiyor. Orada zaten policy/approval/journal'dan
**önce** çalışan bir `pre_capability` guard noktası vardı. Tek dikiş, tüm çağıranlar.

Guard yalnız broker'ın göremediği iki şeye bakıyor. Policy, approval ve trust
**kasıtlı olarak tekrarlanmadı**: aynı soruya iki cevap, hangisinin kazandığına dair
kural olmadan üretilmiş olurdu.

### Ölçüm (engine'in kendi broker'ı üzerinden)

```
1. NORMAL        -> gecti (guard yolu acik)
2. INJECTION     -> ENGELLENDI: Instruction Override, System Prompt Exfiltration
3. KILL SWITCH   -> DURDURDU: no capability may execute until it is reset
4. RESET SONRASI -> gecti (geri donusu var, tek yonlu kapi degil)
```

### Ölçümün tasarımı değiştirdiği yer: 5 kırık test

İlk sürüm argümanları **tüm** desenlerle taradı. Sonuç: 5 geçen test kırıldı.

| Kırılan | Sebep |
|---|---|
| background-shell | `Command Injection` = `/[;&\|`$]/` → `npm run build && npm test` reddedildi |
| search-patch-verify | `Path Traversal` → diff içindeki `../outside.txt` reddedildi; "escapes the assigned workspace" mesajı kayboldu |
| git-capabilities, workspace-attachment, persistent-goals | aynı iki desen |

Bu bir test sorunu değil, benim sınıflandırma hatamdı. Desenler iki farklı katmanı
karıştırıyor. **payload** desenleri bir string'in bir yorumlayıcıya (shell, SQL, path
çözücü) ulaşmasıyla ilgili — ama shell capability'sinin *varlık sebebi* `&&` almak ve
o capability kendi kaçışını kendisi yapıyor, kendi sınırını kendisi kontrol ediyor ve
daha **spesifik** bir hata veriyor. Merkezi battaniye kontrol orada çıkarma yapıyor:
çalışan çağrıyı kırıyor, spesifik hatayı genel hataya çeviriyor.

**prompt** desenleri tersi: yorumlayıcı modelin kendisi, aşağı akışta hiçbir kaçış
yardım etmiyor ve hiçbir capability "ignore all previous instructions"ı veri olarak
almayı beklemiyor. Merkezi olarak engellenmeye değer olan tek sınıf bu.

Çözüm: `InjectionTarget = "payload" | "prompt"` eklendi, `detect(input, target?)`
filtreleyebiliyor, guard yalnız `"prompt"` soruyor. 5 test düzeldi, guard hâlâ yakalıyor.

### Sabotaj kanıtı (5 varyant, hepsi geri yüklendi, iz 0)

| Sabotaj | Sonuç |
|---|---|
| Kill switch kontrolünü kaldır | **4 fail** |
| Injection taramasını kaldır (hep allow) | **4 fail** |
| `engine.ts`'te guard kaydını kaldır (ilk deneme) | **0 fail** ← testler guard'ı kanıtlıyordu, *bağlı olduğunu* değil |
| aynısı, engine-seviyesi test eklendikten sonra | **2 fail** |
| `target` filtresini kaldır (eski geniş tarama) | **4 fail** |
| prompt desenlerini `payload`'a çevir | **5 fail** |

Üçüncü satır N4'ün en önemli bulgusu: guard'ın doğru çalıştığını kanıtlayan 9 test,
onu engine'den söktüğümde hepsi yeşil kaldı — oysa N4'ün **tek konusu** o bağlantıydı.
Gerçek `HybridAgentEngine` üzerinden, motorun kendi kaydettiği `filesystem.read`
capability'siyle 2 test eklendi; artık bağlantının kendisi korunuyor.

### Doğrulama

typecheck 0 hata · **204 dosya / 1362 test PASS** (N3: 203/1350) · `eval:gates` 4/4, EXIT=0.

### Dürüst sınır

Gerçek model altında kanıt yok. Bugün enjekte metin capability *argümanlarında*
aranıyor; gerçek bir saldırı büyük olasılıkla model çıktısında veya araç sonucunda
gelir. Bu, mock provider'la kapatılamayacak bir boşluk.

---

## N5 — `runtimeObserved`: iddia değil, ölçüm

**Sorun:** `wiredToEngine` elle yazılan bir boolean ve **30 modülün 30'u da
`true`** diyordu; hiçbiri `false` demiyordu. Hiç ayırt etmeyen bir alan ölçüm
değil, alışkanlıktır. N4'ün üçüncü sabotajı bunu somut göstermişti: guard
kaydını `engine.ts`'ten silmek sıfır test kırmıştı.

Çözüm elle ikinci bir boolean eklemek **değil** — aynı sorunu tekrarlardı.
V8 coverage ile gerçekten ne koştuğu ölçüldü.

### Ölçüm yöntemi: iki koşunun farkı

İki ayrı süreç, `NODE_V8_COVERAGE` altında: (1) yalnız `initialize()`,
(2) `initialize()` + gerçek bir `engine.execute()` hedefi. **Fark** alınıyor —
aksi hâlde başlatmada kurulan her servis meşgul görünür. Zaten `wiredToEngine`
30/30'un sebebi tam olarak bu.

Constructor, alan başlatıcı ve `getX`/`isX`/`getStats` erişimcileri hariç:
bir servisi inşa edip ona kendi sayaçlarını sormak, o servisin iş yapması değil.

Ölçüm birkaç kez sıkılaştırıldı; her adımda sayı düştü:

| Sayım | Sonuç |
|---|---|
| Çalışan herhangi bir fn-range | 28/30 |
| İsimli fonksiyon (init/stat hariç) | 26/30 |
| Constructor ve alan init de hariç | 17/30 |
| **Başlatma farkı alınmış — görev sırasında** | **5/30** |

İlk üç sayı da "doğru"ydu ve hepsi yanıltıcıydı. Doğru soru "yüklendi mi" değil,
"görev sırasında iş yaptı mı".

### Sonuç: 5/30

Görev sırasında iş yapan: `unified-execution-loop` (`run`, `emit`,
`recordStepProgress`, `buildReport`) · `gap-detection` (`detectGaps`,
`detectDeterministicGaps`, `detectStructuralGaps`) · `verification-factory`
(`verify`, `combine`) · `failure-taxonomy` (`classifyFailure`, `chooseRecovery`)
· `long-horizon-memory` (`search`, `decay`, `autoConsolidate`).

Kalan 25'i `initialize()`'da kurulup bir daha hiç sorulmuyor —
`security/security-system` ve `capabilities/capability-synthesis` dahil.

### Tekrarlanabilirlik: `npm run observe:runtime -w @haf/engine`

Elle bakımlı bir "ne çalışıyor" listesi, yerini aldığı boolean gibi çürür.
Ölçüm bir komut hâline getirildi ve bağımsız olarak elle yaptığım sayımı
doğruladı (5/30).

### Dürüstlük kısıtı: tek görev tek yol ölçer

`RuntimeObservation` hangi hedef altında ölçüldüğünü kaydediyor.
`constructed` **"ölü kod" demek değil**, "bu hedeften ulaşılmıyor" demek.
`society/agent-society` dosya yazma hedefinde boşta, başka bir hedefte olmayabilir.

### Sabotaj kanıtı (3 varyant, iz 0)

| Sabotaj | Sonuç |
|---|---|
| Bir modülü boş metot listesiyle `exercised` yap | **2 fail** |
| Hepsini `exercised` yap (iddia = gözlem) | **3 fail** |
| Bir modülü kayıttan sil | **2 fail** |

İkincisi kritik: kaydı süsleyip "hepsi çalışıyor" demek artık testten geçmiyor.
İddia > gözlem eşitsizliği kasıtlı olarak test ediliyor — bu boşluğu kapatmak
gerçek bir mühendislik sonucu olmalı, kayıt düzenleyerek değil.

### Üretilen dokümanlara etkisi

`levelOf()` artık `integrated` rütbesini elle beyana değil ölçüme dayandırıyor.
Sonuç: **25 modül `reachable`'a düştü**, 4'ü `exercised`, 1'i `verified`.
Önceden hepsi `integrated` ve üstü görünüyordu. `KNOWN_GAPS.md`'ye ölçüm
yöntemini ve kullanılan hedefi yazan yeni bir bölüm eklendi.

### Doğrulama

typecheck 0 hata · **205 dosya / 1368 test PASS** · `eval:gates` 4/4, EXIT=0.

---

## O1 — FAZ 11 kabul kriteri gerçek encoder ile kanıtlandı

**Sorun:** `eval:recall` içeriden FAIL veriyordu (0.317 → 0.339) ve çıktısı şunu
iddia ediyordu: "encoder sınır, retrieval mantığı değil — gerçek bir encoder ile
0.317 → 0.400 geçiyor." Bu iddia **hiç doğrulanamıyordu**: kaynağı, kimsenin
tekrar üretemediği bir koşuydu. Kodda iki farklı rakam da dolaşıyordu (0.361 ve
0.400) — hangisinin ne olduğu belirsizdi.

### Ölçüm

Ortamda ağ erişimi olduğunu görünce tahmin etmek yerine ölçtüm:
`sentence-transformers` kuruldu, `all-MiniLM-L6-v2` (384 boyut) CPU'da
OpenAI uyumlu bir `/embeddings` uç noktası olarak ayağa kaldırıldı.

```
  encoder: remote (http://127.0.0.1:8099/v1/embeddings)

  metric          baseline(bm25)   hybrid
  Recall@8        0.317            0.400
  Precision@8     0.475            0.600
  MRR             0.947            0.950
  nDCG@8          0.577            0.678

  PASS: Recall@8 0.317 → 0.400 (+0.083, 8W/1L/6T)
✅ Gate passed: Recall@8 beats the lexical baseline by the required margin.
```

**FAZ 11 kriteri gerçekten karşılanıyor.** Üç ardışık koşu birebir aynı sayıyı
verdi. İddia edilen `0.317 → 0.400 (+0.083)` **birebir tuttu**.

Tek sapma: kazanan sayısı `7W/1L/7T` yazılıydı, ölçüm `8W/1L/6T` dedi. Metin
9 dosyada düzeltildi — ölçüm değil.

### İki rakamın açıklaması (ve sabotajın kanıtladığı şey)

`0.361` ve `0.400` çelişki değilmiş; ikincisi bm25-tail sıralaması düzeltmesinin
sonucuymuş. Sabotajla doğrulandı:

| Sabotaj | Sonuç |
|---|---|
| Gerçek encoder'a da `isSemantic=false` muamelesi (vektör ağırlığı 0) | `0.400 → 0.339` **FAIL** |
| bm25-tail sıralamasını geri al | `0.400 → 0.361` **FAIL** |

İkinci satır kaynak koddaki `0.361 (5W/1L/9T)` yorumunu **birebir yeniden
üretti**. Yani o yorumlar gerçekten ölçümdenmiş.

### Süreç dersi: `dist` ile kaynak arasındaki fark

İlk sabotaj denemem **hiçbir şeyi değiştirmedi** — skor sabit kaldı. Sebep kodun
sağlamlığı değildi: `recall-gate-cli.ts` `@haf/engine/...` üzerinden **derlenmiş
`dist`'i** okuyor, ben ise kaynağı değiştiriyordum. Sabotajım hiç yüklenmemişti.
`npx tsc -b packages/engine` eklenince ikisi de yakalandı.

**Sabotaj sıfır etki gösteriyorsa, önce sabotajın gerçekten yüklendiğini ölç.**

### Kalıcı hâle getirme

- `packages/eval/tools/local-embeddings-server.py` — gerçek MiniLM, OpenAI uyumlu.
- `packages/eval/tools/run-real-recall.sh` — encoder'ı başlatır, hazır olmasını
  **yoklar** (sabit `sleep` değil: soğuk/sıcak cache süresi değişken), kapıyı
  çalıştırır, `trap` ile her hâlükârda kapatır.
- `npm run eval:recall:real -w @haf/eval` — tek komut, API anahtarı gerekmez.
- Gate FAIL mesajı artık bu komutu söylüyor; "encoder sınır" artık mazeret değil,
  yoklanabilir bir iddia.
- `test/real-encoder-recall.test.ts` — encoder yoksa `skip`, varsa gerçekten koşar.
  **0.400 sabiti yazılmadı**: süitin üretemeyeceği bir sayıyı iddia etmek, bu
  sorunun ilk çıkış sebebiydi.

### CI kararı: kapı hâlâ hash encoder'da kilitli

`eval:gates` `--regression-lock` kullanmaya devam ediyor. CI'ın her koşuda 90MB
model indirmesi doğru değil; kilit fusion/ranking regresyonunu yakalar, kriteri
değil. Fark artık açıkça yazılı.

### Doğrulama

typecheck 0 hata · **206 dosya / 1369 test PASS + 1 skipped** (encoder yokken
doğru davranış) · `eval:gates` 4/4, EXIT=0 · `eval:recall:real` **PASS**.
