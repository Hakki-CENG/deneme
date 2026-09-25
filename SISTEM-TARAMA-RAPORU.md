# Aurora Motor Engine — Anlık Sistem Taraması

Tarih: 2026-09-22 · Sürüm: 1.65.0 · Kapsam: tüm monorepo (10 paket, 9 test workspace'i)

Bu rapor hafızadan değil, komutlar çalıştırılarak üretildi. Her bulgunun yanında
onu üreten komut ve dönen değer var.

---

## 1. Şu anki doğrulanmış durum

| Kontrol | Komut | Sonuç |
|---|---|---|
| Typecheck (10 paket) | `npm run typecheck` | **0 hata** |
| Testler (9 workspace) | `npm test` | **1495 test geçti, exit 0** |
| Entegrasyon doğrulaması | `npm run verify:integration` | **10/10** |
| OpenAPI drift | `npm run docs:openapi:check` | **temiz** — 844 kayıt, 715 path |
| Çalışma zamanı ölçümü | `npm run observe:runtime` | **29/30 modül çalıştı, 1 idle, 0 never-loaded** |
| Sürüm tutarlılığı | `engine-version-runtime` | 1.65.0 |

Bu tarama sırasında **iki gerçek arıza bulundu ve giderildi** (aşağıda).

---

## 2. Bu taramada bulunan ve giderilen arızalar

### 2.1 Üretilen durum dokümanları ölçümün 9 modül gerisindeydi

`npm test` içinde `@haf/eval`'den **3 test düşüyordu**:

```
FAIL test/state-docs.test.ts > CURRENT_STATE.md  > matches what the generator produces today
FAIL test/state-docs.test.ts > MATURITY_MATRIX.md > matches what the generator produces today
FAIL test/state-docs.test.ts > KNOWN_GAPS.md     > matches what the generator produces today
```

Diskteki dosyalar ile üretecin çıktısı arasındaki fark:

```
< | Modules observed doing work in a real task (measured) | 20 |
> | Modules observed doing work in a real task (measured) | 29 |

< ## Constructed at startup but idle during a real task (10)
> ## Constructed at startup but idle during a real task (1)
```

**Kök neden:** `docs:state` kaynağı değil **derlenmiş `dist/`'i** okuyor. Kayıt
(`runtime-observation.ts`) güncellenip motor yeniden derlenmeden dokümanlar
yenilenmiyor. Yani dokümanlar sessizce bayatlıyor ve bunu ancak test yakalıyor.

**Giderildi:** derlemeden sonra `docs:state` yeniden çalıştırıldı → 16/16 test geçti.
**Kalıcı çözüm Faz 1'de** (aşağıda) — bu bir süreç hatası, tekrarlayabilir.

### 2.2 Release metadata bayattı

```
FAIL release-metadata-fresh
     content hash differs (891 attested entries vs 891 now)
```

Bu oturumdaki kaynak düzenlemeleri (`engine.ts`, `capabilities/embodiment.ts`,
`execution/unified-execution-loop.ts`) attest edilmiş hash'leri geçersiz kılmıştı.

**Giderildi:** `npm run release:prepare` → `verify:integration` **10/10**.

---

## 3. Faz faz kalan işler

Öncelik sırası: ölçümün güvenilirliği → gerçek metrik hataları → ölü kod →
API doğruluğu → tasarım tekrarı.

### FAZ 1 — Ölçüm bütünlüğü ✅ TAMAMLANDI (2026-09-22)

Ölçüm diğer her şeyin dayanağı. Ölçüm yalan söylerse sonraki fazların hepsi
yanlış zemine basar.

**Yapılanlar ve kanıtları:**

- **1.1 giderildi.** `state-docs-cli.ts`'e `stalePairs` / `staleEngineBuilds`
  bekçisi eklendi: kaynak derlenmiş dosyadan yeniyse `docs:state` **exit 1** ile
  duruyor ve hangi dosyanın bayat olduğunu söyleyip `npm run build -w @haf/engine`
  öneriyor. Ölçülen davranış:
  ```
  $ touch packages/engine/src/experimental/runtime-observation.ts
  $ npm run docs:state -w @haf/eval
  exit=1
  Refusing to generate state documents from a stale engine build.
    packages/engine/src/experimental/runtime-observation.ts is newer than
    packages/engine/dist/experimental/runtime-observation.js
  ```
  Derlemeden sonra `exit=0`. Karşılaştırma mantığı saf bir fonksiyona
  (`stalePairs`) ayrıldı; 4 yeni test eklendi.

- **1.2 giderildi.** Ölçüm koşucusu artık capability broker'ına abone olup her
  çağrının sonucunu kaydediyor ve çıktı modül sayısının hemen yanında basılıyor:
  ```
  3 capability invocations, 0 of them threw:
    embodiment.fs.info             ok
    filesystem.write               ok
  ```
  Hiç başarılı çağrısı olmayan bir capability `ONLY ERRORS` olarak işaretleniyor
  ve son hata mesajıyla birlikte gösteriliyor. Veri kaynağı doğrulandı — broker
  fırlatan çağrı için `phase: "finished"`, `status: "error"` üretiyor:
  ```
  [{"id":"embodiment.fs.info","status":"error","error":"Access denied: /etc/passwd"}]
  ```
  Sınıflandırma saf bir fonksiyona (`classifyOutcomes`) ayrıldı; 4 yeni test.
  Böylece "exercised" artık "çalışıyor" anlamına gelmiyor — ikisi yan yana
  raporlanıyor.

- **1.1 `docs:state` kaynağı değil `dist`'i okuyor.**
  Kanıt: §2.1. Dokümanlar 9 modül gerideydi ve bunu yalnız test yakaladı.
  İş: üreteci kaynaktan okutmak ya da betiğe derlemeyi zorunlu ön koşul yapmak.
  Doğrulama: kayıt değişip derleme yapılmadan `docs:state` çalıştırıldığında
  çıktının güncel olması.

- **1.2 Kapsama, her çağrısında fırlatan bir capability'yi "çalıştı" sayıyor.**
  Kanıt: `embodiment.fs.*` çağrıları ENOENT fırlatırken ölçüm
  `resolveSafePath` gördüğü için modülü exercised sayıyordu. Düzeltmeden sonra
  listede `createFileInfo` da var — o metod yalnız başarı yolunda koşar.
  İş: gözlem kaydına başarısız çağrıyı ayrı işaretlemek.
  Doğrulama: kasıtlı fırlatan bir capability'nin exercised sayılmaması.

### FAZ 2 — Gerçek metrik hataları ✅ TAMAMLANDI (2026-09-22)

`aurora/neural-cognitive-core.ts` içindeki iki sayı da ölçüm gibi görünüp ölçüm
değildi. Servisin **hiç test dosyası yoktu** — hataların bu kadar uzun süre
kalmasının sebebi bu.

**Önceki teşhisin düzeltilmesi:** tarama raporunda "`usageCount` hiç artmıyor"
yazılmıştı. Bu **yanlıştı** — `activate()` içinde `bestMatch.usageCount++` var.
Gerçek hata daha ince: `recordOutcome`, *sonuçların* ortalaması için *etkinleşme*
sayacını payda olarak kullanıyordu; ikisi farklı şeyler.

Düzeltmeden önce ölçülen davranış:

| Durum | Dönen değer | Olması gereken |
|---|---|---|
| hiç etkinleşmeden 1 başarısızlık | `-0.5` | `0` |
| ardından 2. başarısızlık | `0.5` (yükseldi) | `0` |
| aynı durum, 3 × `snapshot()` | `0.372 / 0.519 / 0.434` | üçü de aynı |

- **2.1 giderildi.** `outcomeCount` / `successCount` alanları eklendi; oran artık
  `successCount / outcomeCount`. Etkinleşme sayısından bağımsız, `[0, 1]` dışına
  çıkamıyor. Ölçülen: `-0.5 → 0`, salınım `0.5 → 0`, bir başarı eklenince `1/3`.
- **2.2 giderildi.** `Math.random() * 0.5 + 0.2` yerine desenlerin ortalama
  etkinleşme dağılımı üzerinden **normalize Shannon entropisi**
  (`normalisedEntropy`, `log(n)`'e bölünmüş → `[0, 1]`). Ölçülen: aynı durum için
  üç çağrı da `0.000000`; tek ağırlık `0`, eşit dağılım `1`.

**Testlerin hatayı yakaladığı doğrulandı.** Yeni dosya
`test/neural-cognitive-core.test.ts` (15 test). Düzeltme geçici olarak geri
alındığında **6 test düşüyor**, düzeltmeyle 15/15 geçiyor — yani testler
değişikliğe gerçekten duyarlı.

### FAZ 3 — Ölü ve erişilemez kod — 3.1 TAMAMLANDI, iki aşamada (2026-09-22)

#### 3.1a — İlk konsolidasyon

`ModelSelectionEngine`'in çağrılmaması tek başına sorun değildi; altındaki sorun
**model yönlendirmesinin sistemden kopuk olmasıydı**. Üç katmanlı kopukluk vardı:
yürütme yolu `addDefaultModels()` ile dolu sabit bir listeye bakıyordu (gerçek
sağlayıcılarla `addModel` çağıran kimse yoktu), karar yalnızca kaydedilip
uygulanmıyordu, ve gerçek kayıt defterini okuyan `ModelSelectionEngine` hiç
çağrılmıyordu. Ayrıca tahminler `latencyMs = 1000 + idx*500` ve
`cost = 0.001/(idx+1)` olduğu için **ilk kaydedilen sağlayıcı her stratejide
kazanıyordu**.

`selectModel` bağı `ModelSelectionEngine`'e çevrildi, uydurma tahminler kaldırıldı,
ölü kalan `cognitiveRuntime.selectModelForTask` silindi.

#### 3.1b — Kullanıcının 4. yolu: gerçek zincir, tek otorite

Öneri değerlendirildi ve iki noktada düzeltildi:

- **Öncül güncel değildi.** "`routing/model-routing` gerçek execution path'te,
  `ModelSelectionEngine` kullanılmıyor" durumu 3.1a'dan **önce**ydi; bağlantı
  zaten yapılmıştı.
- **Çizilen zincir çalışmıyordu.** `ModelSelectionEngine → ModelRoutingPipeline`
  için `ModelRoutingPipeline`'ın `accuracy / latencyMs / costPerToken /
  supportedLanguages` üzerinden puanlaması gerekiyor; bu alanlar gerçek modeller
  için sistemde **hiçbir yerde yok**. Zincire koymak onları yeniden uydurmak
  demekti.

Uygulanan sürüm — şekil aynı, altındaki katman gerçek verisi olan:

```
UnifiedExecutionLoop
      ↓
ModelSelectionEngine          ← tek public giriş noktası
      ↓
  adaylar = ModelRouter (gerçek sağlayıcılar)
          × ModelConfigurationRegistry (tenant'ın gerçek modelleri)
          ∪ ProviderProfile.defaultModel (konfigürasyon yoksa)
      ↓
  kanıt  = ModelCapabilityRegistry (ölçülmüşse) + AdaptiveRouter geçmişi
      ↓
  karar  = "provider:model"   ← GERÇEK bir route, uygulanıyor
```

`ModelRoutingPipeline` **ikinci scorer olarak kullanılmıyor**; benchmark,
yönlendirme geçmişi ve görev-gereksinimi katmanı olarak kalıyor.

**"Ölçülmemiş" artık açık bir durum.** `ModelCapabilityRegistry`'de
`reliability: 0.9`, `successRate: 1.0`, `avgLatencyMs ?? 2000`,
`costPer1kInput ?? 0.001` sabit tohumları kaldırıldı; alanlar opsiyonel. Bu
tohumlar yalnız sahte görünmüyordu, **öğrenilen değerleri de kirletiyordu**:
`reliability` bir EMA olduğu için ilk başarı `0.9 * 0.95 + 0.05 = 0.905`
üretiyor, ilk gerçek gecikme uydurma 2000 ms ile ortalanıyordu. Ayrıca
`selectBest` ölçülmemiş bir modeli sayısal sınırı sağlıyor sayıyordu (artık
sağlamıyor) ve `getStats` ölçülmemişleri **0 kabul edip** ortalamayı aşağı
çekiyordu (artık yalnız ölçülenlerin ortalaması + `measuredModels` sayısı).

Ölçülen davranış:

| Durum | Sonuç |
|---|---|
| Konfigürasyonsuz, profil `defaultModel`'li | aday `anthropic:claude-sonnet-4-5-20250929`, `measured: false` |
| Tenant konfigürasyonu eklenince | aday `anthropic:tenant-choice` (konfigürasyon öncelikli) |
| Ölçülmüş vs ölçülmemiş (quality) | `anthropic:measured-model` kazanıyor, skor `1.000` vs `0.500`, `measuredCandidates: 1` |
| Hiç kanıt yokken | `measuredCandidates: 0` ve gerekçe: *"not evidence-based"* |
| Hiç çalıştırılabilir model yokken | `selectedModel: ""` + *"No runnable model"* — model uydurulmuyor |
| Gerçek route bulunduğunda | gözlem **"applied"** ile bitiyor, `context.modelRoute` set ediliyor |

Karar artık **uygulanıyor**: `selectedModel` bir `provider:model` route olduğu ve
oturum tam bu biçimi doğruladığı için (`session-actor.ts:229`) yönlendirme ilk
kez gerçekten etkili. Çalıştırılabilir model yoksa oturum mevcut route'unda
kalıyor.

**Ölçüm 28/30.** İki modül idle: `capabilities/capability-synthesis` (gerçek model
gerektiriyor) ve `routing/model-routing` (artık seçici değil). Yönlendirmeyi
yapan `aurora/unified-engines` ise 30'luk olgunluk kaydında **yok**, yani sayı
işi yapan modülü izlemiyor.

**3.2 `capabilities/capability-synthesis`** hâlâ açık.

### FAZ 4 — API doğruluğu ✅ TAMAMLANDI (2026-09-22)

**Sorun:** olmayan bir oturum 404 değil **500** dönüyordu.
`SESSION_NOT_FOUND` (`HAF-3001`, 404) `error-handler.ts`'te **tanımlıydı ama
hiçbir yerde kullanılmıyordu**.

**Kök neden:** `runtime/supervisor.ts` dört ayrı noktada düz `Error` fırlatıyordu
(`Session ${id} does not exist.` ×3, `... has no snapshot.`). Handler yalnız
`ZodError` ve `AppError`'ı tanıyordu; engine ayrı bir paket olduğu için
`AppError` fırlatamaz, dolayısıyla hata 500 fallback'ine düşüyordu.

Mesaj metnini eşleştirmek çözüm olmazdı — biri mesajı yeniden yazdığında API
sözleşmesi sessizce bozulur. Bunun yerine tipli hata:

- `SessionNotFoundError` (alan: `sessionId`, sebep: `unknown | no-snapshot`) ve
  `SessionAlreadyExistsError` eklendi; dört fırlatma noktası bunlara çevrildi.
- Handler bu iki tipi çeviriyor: `SessionNotFoundError → 404 / HAF-3001`,
  `SessionAlreadyExistsError → 409 / HAF-3006` (yeni kod).

**Testlerin hatayı yakaladığı doğrulandı.** Çeviri geçici olarak devre dışı
bırakıldığında **3 test düşüyor**, onunla 17/17 geçiyor. Dördüncü test
(sınıflandırılmamış hata → 500) ikisinde de geçiyor; çeviri spesifik kalmalı,
her engine hatasını 404 yapmak gerçek arızaları "bulunamadı" arkasına gizlerdi.

Ayrıca bir eksik daha çıktı: mevcut `error-handler.test.ts` yalnız kayıt
sabitlerini doğruluyordu — `HAF-3001`'in **var olduğunu** test ediyordu,
**döndüğünü** değil. Hatanın bu kadar uzun yaşamasının sebebi bu. Yeni testler
gerçek Fastify örneği üzerinde `registerErrorHandler`'ı çalıştırıyor.

Engine tarafı da ayrıca sabitlendi: `engine.session(olmayan-id)` gerçekten
`SessionNotFoundError` fırlatıyor, `sessionId`'yi taşıyor, ve **var olan** oturum
için snapshot dönmeye devam ediyor (düzeltmenin fazla geniş olmadığını göstermek
için).

### FAZ 4b — Kullanıcının eklediği sistematik hata ✅ TAMAMLANDI (2026-09-23)

Kullanıcının teşhisi: *"`error-handler.test.ts` yalnız kayıt sabitlerini
doğruluyordu — `HAF-3001`'in var olduğunu test ediyordu, döndüğünü değil."*
Tek örnek değil, **sınıf** olarak ele alındı.

**Denetim sonucu:** `ErrorCodes`'ta **47 kayıtlı kod** vardı, **24'ü hiçbir kod
yolu tarafından üretilmiyordu.** Yani sözleşmenin yarısı ölü kayıttı; bir istemci
bu kodları bekleyerek yazsa, o hata hiç gelmezdi.

**İki ölü kod gerçek yola bağlandı:**

| Hata | HTTP | Kod | Davranış |
|---|---|---|---|
| `ModelOAuthError` | 401 | `HAF-6005` | `reloginRequired` isteğe yansıyor |
| `ModelProviderError` | 502 | `HAF-6002` | `credentialDisposition !== "none"` ise 401 + `Retry-After` |

**Kalan 22'si için bekçi yazıldı:** `apps/control-api/test/error-code-registry.test.ts`
(7 test) tüm `apps/` + `packages/` kaynaklarını tarar, üretilmeyen kodları
gerekçeli bir `DORMANT` listesiyle karşılaştırır. İki yönlü cırcır:

- kayda yeni ölü kod eklenirse test düşer (sahte `HAF-3007` ile doğrulandı: **1 failed**),
- `DORMANT`'taki bir kod üretilmeye başlarsa test düşer (liste güncellenmeli).

**Kendi kendini aklatan denetim tuzağı:** ilk sürüm kendi `DORMANT` map'ini de
corpus'a kattığı için 22 kod "üretiliyor" göründü. Kaynak tarayan her bekçi
`fileURLToPath(import.meta.url)` ile **kendi dosyasını dışlamalı.**

### FAZ 5 — Tasarım tekrarı ve ölçüm izolasyonu ✅ TAMAMLANDI (2026-09-23)

- **5.1 Kapsanan capability kaldırıldı.**
  İddia iki kümenin örtüştüğüydü; **kısmen yanlıştı** — id'ler çakışmıyor,
  `filesystem.*` içerik, `embodiment.fs.*` yapı/metaveri işi yapıyor,
  bütünleyiciler. Gerçek örtüşme **tek çiftteydi**:
  `filesystem.grep` `{pattern, path, include, ignoreCase, maxMatches, contextLines}`
  ⊃ `embodiment.fs.search` `{query, path, filePattern}` — kesin alt küme.
  Bağımlılık taraması yalnız kendi 2 testini gösterdi → `embodiment.fs.search`
  kaldırıldı. `fileSystemAgentCapabilities` **7 → 6** capability.

- **5.2 Recall'un tool çağrısını yeniden tetiklemesi — kök neden enjeksiyondu.**
  Ölçülen: birinci görevin `[tool filesystem.write ...]` direktifi belleğe
  yazıldı, ikinci görev ("hiç tool kullanma") onu recall ile geri aldı ve araç
  çalıştı. Bu **yalnız ölçüm kirliliği değil**: bellek ve hedef aynı kanaldan
  modele gidiyor, yani önceki görevin yazdığı metin sonraki görevde araç
  çağrısına yol açabiliyor — gerçek bir prompt-enjeksiyon vektörü.

  Düzeltme: `buildAgentBriefing` recall edilen bellekleri
  `defangDirectives()` ile geçiriyor; `[tool ...]` yerine
  `[tool directive removed from recalled memory]` konuyor. **Silinmiyor,
  değiştiriliyor** — sessizce düşürmek belleğin neden kırpılmış göründüğünü
  gizlerdi. Hedefin kendi direktifi etkilenmiyor (çağıranın isteği korunuyor).

  **Ölçüldü:** görev 1 `filesystem.write` çağırıyor, tool istemeyen görev 2
  **hiçbir şey çağırmıyor** (düzeltme öncesi çağırıyordu).
  **Duyarlılık:** `defangDirectives` kapatılınca **4 failed**, geri konunca 6/6.

- **5.3 İki "router" ayrıldı.**
  `models/model-router.ts`'teki sınıf `ModelRouter` → **`ModelProviderRegistry`**
  (o zaten bir kayıt defteri; kendisi de bir `ModelProvider` — kayıtlı
  sağlayıcıya yönlendiriyor). Geriye uyumluluk için `ModelRouter` deprecated
  takma ad olarak duruyor. `routing/model-routing.ts`'e bu ayrımı ve neden
  yürütme yolundaki seçici **olmadığını** anlatan başlık eklendi.

### P3 — Deprecated bağımlılıklar ve çift doküman ✅ TAMAMLANDI (2026-09-23)

**1. `nats@2.29.3` → `@nats-io/transport-node@3.4.0` (gerçek göç, doğrulandı).**

Deprecation sebebi sürüm değildi — `nats@2.29.3` zaten **son sürüm**, paket
taşınmış: *"Package moved. Use @nats-io/transport-node"*. Yani "yükselt" değil,
"yeni ada geç" gerekiyordu.

Tip tanımları tek tek okunarak doğrulandı: kullanılan `connect` seçeneklerinin
(`servers`, `token`, `user`, `pass`, `reconnect`, `maxReconnectAttempts`) hepsi
v3'te de var; `Subscription extends AsyncIterable<Msg>`, `msg.respond`,
`connection.request/drain/publish` aynı. **Tek kırılma `JSONCodec`'in kalkması**
— v3 yalnız `Codec<T>` arayüzünü bırakmış. Yerine 8 satırlık `jsonCodec<T>()`
yazıldı. Bu arada `NatsConnection` ve `Subscription` içe aktarmalarının **ölü**
olduğu görüldü (yalnız import satırında geçiyordu) ve kaldırıldı.

Ölçüldü: `connect` gerçek bir fonksiyon, `JSONCodec` v3'te gerçekten yok,
SBOM'da eski `nats` kaydı **0**, yeni paket **1**.

**Codec için duyarlılık kanıtı:** mevcut testler yalnız ASCII yük gönderiyordu,
yani kayıplı bir kodlama (latin1) bile geçebilirdi. UTF-8 testi eklendi; codec
latin1'e bozulunca **1 failed**, geri konunca 3/3.

**2. Electron 41.7.1 → 44.4.5.**

API denetimi: kullanılan API'lerin hiçbiri 43/44 breaking listesinde yok.
`showHiddenFiles`, `app.isUnityRunning`, `setBadgeCount`, `setProgressBar`,
`net.request`, `nodeIntegrationInSubFrames`, `select-client-certificate`
kullanılmıyor; tek "clipboard" eşleşmesi bir **izin adı**
(`"clipboard-sanitized-write"`), 44'te kaldırılan `clipboard` modülü değil.
electron-builder hedefleri `dmg/zip`, `nsis/zip`, `AppImage/deb` — açık arch
yok, kaldırılan ia32/armv7l hedeflenmiyor.

**3. Bu sırada gerçek bir kusur bulundu ve düzeltildi: preload hiç çalışmıyordu.**

`window.hafDesktop` renderer'da **`undefined`** dönüyordu. Sebep: `preload.ts`
ESM olarak derleniyor (paket `"type": "module"`) ama pencere `sandbox: true` —
Electron ESM preload'u yalnız sandbox kapalıyken yüklüyor.

**Karşılaştırmalı ölçüm** (aynı içerik, tek fark `import` vs `require`, aynı
`sandbox: true`):

| | Electron 41.7.1 | Electron 44.4.5 |
|---|---|---|
| ESM (`dist/preload.js`) | `bridge=null` | `bridge=null` |
| CJS (`require`) | köprü açılıyor | `{"platform":"linux","versions":{"electron":"44.4.5","chrome":"152.0.7977.130"}}` |

İki sürümde de aynı → **hata yükseltmeden önce de vardı**, benim değişikliğim
değil. Düzeltme: `tsconfig.preload.json` preload'u CommonJS derliyor, build
`preload.cjs` olarak yeniden adlandırıyor, `main.ts` ona işaret ediyor.
Düzeltme sonrası gerçek `dist/preload.cjs` köprüyü açıyor.

Gerçek uygulama girişi de doğrulandı: `dist/main.js` Electron 44 altında 20 sn
ayakta kaldı, canvas sayfası **2 kez** istendi ve sunuldu (yani CSP + izin
işleyicisi + pencere kurulumu gerçek yoldan geçti).

**4. Çift doküman.** `uc-ajan-reposu-nihai-mimari-analizi.md`,
`hybrid-agent-fabric/docs/reference-analysis.md` ile **bayt bayt aynıydı**
(md5 `44ab15617346088d80030da29e13a668`, 93.894 bayt, 2.732 satır) ve hiçbir
yerden bağlantı almıyordu. Kök kopya yönlendiriciye çevrildi; içerik tek yerde.

**5. Kalan deprecated bağımlılıklar — düzeltilemiyor, sebebi ölçüldü.**

`glob@7.2.3`, `rimraf@2.6.3`, `inflight@1.0.6`, `boolean@3.2.0` sürüyor. Dördü de
**hiçbir `package.json`'da doğrudan kayıtlı değil** (0 kayıt); hepsi
`electron-builder@26.15.3`'ten geliyor ve o **zaten en son sürüm**.

> **Düzeltilen iddia:** "Electron 44'e geçmek `boolean`'ı eler" demiştim —
> **yanlıştı.** `electron@44`'ün `@electron/get@^5` kullandığını doğrulamıştım
> (doğru), ama `boolean`'ın eleneceğini doğrulamamıştım: `electron-builder` →
> `app-builder-lib` → `@electron/get@3.1.0` → `global-agent` → `boolean@3.2.0`
> bağımsız olarak çekiyor. Yükseltme sonrası `boolean` hâlâ duruyor.
> Electron yükseltmesinin gerekçesi artık "deprecated bağımlılığı gidermek"
> değil, **güncel Chromium/güvenlik yamaları** üzerinde olmak.

---

## 4. Önerilen sıra

1. **Faz 1** — iki madde, ikisi de küçük. Ölçümün güvenilirliği diğer her fazın
   ön koşulu.
2. **Faz 2** — iki gerçek metrik hatası; biri tek satırlık, repoda doğru örneği var.
3. **Faz 3.1** — karar gerektiriyor (bağla mı kaldır mı), ama ucuz.
4. **Faz 4.1** — tek rota, net doğrulama.
5. **Faz 3.2** — en büyük iş (gerçek model ya da enjekte edilebilir üretici).
6. **Faz 5** — tasarım kararları; acelesi yok ama borç olarak duruyor.
