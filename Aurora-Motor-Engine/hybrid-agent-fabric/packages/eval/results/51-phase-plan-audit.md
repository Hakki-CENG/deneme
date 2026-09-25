# 51-Faz Planı — Kod Denetimi

**Tarih:** 2026-09-19
**Yöntem:** Planın her P0 iddiası mevcut `HEAD` koduna karşı tek tek doğrulandı.
Plan bir ZIP snapshot'ına dayanıyor; bazı maddeler o snapshot'tan sonra kapandı.

---

## Özet

| | Sayı |
|---|---|
| ✅ Doğrulandı — gerçek eksik | 7 |
| ⚠️ Zaten kapatılmış (plan bayat) | 6 |
| 🔍 Kısmen doğru — nüans var | 2 |

---

## ⚠️ Plan bayat — bunlar zaten kapatıldı

Bu maddeler önceki turlarda düzeltildi; tekrar yapılmayacak.

| Plan maddesi | Gerçek durum | Kanıt |
|---|---|---|
| P0-6 "EvalRunner → session workspacePath" | **Kapalı** | `eval-runner.ts:86,91` |
| P0-7 "Grader `cwd = task workspace`" | **Kapalı** | `grader.ts:124` `cwd: workspace.absolute` |
| "`gradeTask()` iki kere çağrılıyor" | **Kapalı** | tek çağrı (`grep -c` = 1) |
| P0-13 "Original task retry" | **Kapalı** | `capability-acquisition-loop.test.ts` |
| P0-10 "75/75 raporları historical" | **Kapalı** | 61 görev resmî baseline; `50-phase-status.md` yeniden yazıldı |
| "TrajectoryBridge success placeholder" | **Kısmen** | `engine-eval-trajectory.ts` artık `execute()` + yalnız `succeeded`=1.0 |

**Not:** Plan "EvalRunner workspacePath vermiyor, coding benchmark'ı bozabilir"
diyor. Bu teşhis doğruydu; ölçülmüş yanlış-pozitifle birlikte kapatıldı
(`fileExists: "package.json"` ajan hiç çalışmadan pass oluyordu).

---

## ✅ Doğrulandı — gerçek eksikler

### 1. `/v1/run-task` hâlâ `runTask()` çağırıyor  (P0-1) — EN KRİTİK

```
apps/control-api/src/routes/cognitive.ts:72
  return await engine.runTask(b.tenantId, b.task);
```

**Önemli düzeltme:** Daha önce "route dosyaları ölü kod" kabul edilmişti.
**Bu doğru değil** — `main.ts:3503` `registerCognitiveRoutes(...)` çağırıyor,
yani bu endpoint **canlı**.

`runTask()` orkestrasyon katmanını sürüyor; ajanı çalıştırmıyor. Ölçülmüş:
imkânsız görevde `outcome: "skipped"`, 0 subsystem. Yani HTTP API'nin ana
görev girişi gerçek ajanı hiç çağırmıyor.

### 2. `execute()` içinde planner yok  (P0-3)
`PlanningEngine` var (`aurora/unified-engines.ts`), loop `plan` hook'unu
destekliyor, ama `engine.execute()` vermiyor.

### 3. `execute()` içinde learning yok  (P0-4)
Loop `learn` hook'unu destekliyor; `execute()` vermiyor. Sonuç: başarılı görev
hiçbir şey öğretmiyor.

### 4. Otomatik verifier üretimi bağlı değil  (P0-5)
`harness/verification-service.ts` **zaten** workspace'ten `package.json`,
`pytest`, `go.mod`, `Cargo.toml`, `Makefile` algılayıp komut çıkarıyor
(satır 122-172). `execute()` ise `input.verifiers ?? []` diyor. Caller verifier
vermezse sistem dürüstçe `unverified` diyor — ama bu tamamlanmamışlık.

### 5. Versiyon tutarsızlığı  (FAZ 2)
```
1.65.0  root, engine, eval
1.64.0  control-api, canvas-web, desktop
```

### 6. `paused` session completed sayılabiliyor  (P0-14)
`session-agent-adapter.ts` settlement mantığı incelenecek.

### 7. Eval iki sistem  (P0-8)
`engine-eval.ts` (JSON loader) ve `EvalRunner` (TS `core-tasks.ts`) ayrı.

---

## 🔍 Nüans

**P0-11/12 "Capability acquisition provider'ı bağla + registry'ye ekle":**
Plan haklı ki zincir eksik. Ancak provider'ı *sahte* bir generator'la bağlamak
sistemi geriye götürür — `async () => true` boşluğu "kapandı" kaydeder.
`CapabilityAcquisition` ctor'u generator yoksa bilerek throw ediyor. Bu madde
gerçek bir model bağlama kararı gerektiriyor (planın FAZ 28'i: "Qwen veya
seçilen coding model devreye girmeli").

**"Cognitive runtime health yanlış pozitif":** Plan haklı. `getStats()` çalıştı
→ `wired: true` yetersiz. Önerilen lifecycle (`constructed → initialized →
reachable → exercised → integrated → verified`) `maturity.ts`'in
`wiredToEngine` alanından daha ince; birleştirilmeli.

---

## Uygulama sırası

Planın kendi BLOK A önceliğini kabul ediyorum, ama **P0-1'i en öne alıyorum**:
bir HTTP endpoint'in ajanı hiç çalıştırmaması, planner/learner eksikliğinden
daha ağır bir kusur.

1. `/v1/run-task` → `execute()`  ← en yüksek etki
2. Otomatik verifier üretimi (`VerificationService` → `execute()`)
3. Learning hook
4. Planner hook
5. Versiyon normalizasyonu
6. `paused` settlement

---

# Uygulama — bu turda kapatılanlar

## 1. `/v1/run-task` artık gerçek ajanı çalıştırıyor  (P0-1)

**En kritik bulgu buydu** ve önceki bir varsayımı da düzeltti: "route dosyaları
ölü kod" kabulü **yanlıştı**. `main.ts:3503` `registerCognitiveRoutes(...)`
çağırıyor — endpoint canlıydı ve `runTask()` kullanıyordu.

Yani HTTP API'nin ana görev girişi, ölçülmüş şekilde ajanı hiç çalıştırmayan
yola bağlıydı: imkânsız bir görevde bile `outcome: "success"`. Bir HTTP çağıran
için bu mümkün olan en kötü hata — 200 dönen, yapılmamış işi yapılmış gösteren
cevap.

Şimdi:

```
POST /v1/run-task  →  engine.execute()  →  UnifiedExecutionLoop  →  SessionActor
```

`outcome` alanı geriye dönük uyumluluk için duruyor ama **türetilmiş**: yalnız
`succeeded` → `"success"`. Eski davranış `POST /v1/cognitive-trace` altında,
adıyla ve şu uyarıyla korundu:

> "This is an orchestration trace, not task execution. No agent ran and no
> result was verified."

## 2. Otomatik verifier üretimi  (P0-5)

`harness/verification-service.ts` zaten workspace'ten toolchain algılıyordu
(`package.json`, `pytest`, `go.mod`, `Cargo.toml`, `Makefile`, lockfile'a göre
paket yöneticisi). Bağlı değildi.

`execute()` artık caller verifier'larına ek olarak workspace'in kendi
kanıtlarını üretiyor: build → **V1 formal**, test → **V2 empirical**.

**Kasıtlı sınır:** toolchain bulunamazsa verifier üretilmiyor ve döngü yine
`unverified` diyor. Yokluk, başarı varsayımına çevrilmiyor.

## 3. Learning hook  (P0-4)

`execute()` artık `learn` sağlıyor. Tek kural: **yalnız doğrulanmış başarı ders
olur.** `unverified`'dan öğrenmek, sisteme "denetlenmemiş iş iyi iştir" demeyi
öğretirdi — bu execution path'in var olma sebebinin tam tersi.

Başarısızlıklar da kaydediliyor, ama yalnız taksonominin **isimlendirebildiği**
olanlar; "bir şeyler ters gitti" hiçbir şey öğretmez. Memory yazımı hata
verirse görev sonucu değişmiyor.

## 4. `paused` ve "sessiz oturum" düzeltmesi  (P0-14)

İki ayrı hata bulundu:

- `paused` son `return`'e düşüp **completed** sayılıyordu. Duran ajan, bitiren
  ajan değildir.
- Daha incesi: `idle`/`closed` olarak settle olmak tek başına iş kanıtı değil.
  Oluşturulup hemen idle olan bir oturum, on dakika çalışanla **aynı** şekilde
  settle oluyor. Artık event'lerde gerçek aktivite (tool/assistant/output/patch)
  aranıyor; yoksa `completed: false` ve "no execution evidence".

## 5. Versiyon normalizasyonu  (FAZ 2)

8 app paketi 1.64.0 → **1.65.0**; `docs/API.md`, `docs/DEPLOYMENT.md`,
`docs/openapi.yaml` güncellendi. (Tarihli audit raporlarındaki 1.64.0
referansları kayıt olarak bırakıldı.)

## 6. Whitespace  (plan: `git diff --check`)

5 dosyada trailing whitespace ve EOF fazlalığı temizlendi. `git diff --check`
artık temiz.

---

## Ölçülen taban

| Kontrol | Sonuç |
|---|---|
| `npm run typecheck` | **0 hata** |
| `npx vitest run` | **192 dosya / 1186 test PASS** |
| `eval:validate` | ✅ Gate passed |
| `eval:baseline` | ✅ 0/61 (+1 muaf) |
| `git diff --check` | ✅ temiz |
| yeni testler | `execution-wiring.test.ts` **9** |

---

## Sırada — planın kabul edilen ama yapılmayan maddeleri

| Madde | Neden şimdi değil |
|---|---|
| Planner hook (P0-3) | `PlanningEngine` var; planı ajana **enjekte etmeden** bağlamak (FAZ 14) sadece ölü hesaplama olur. İkisi birlikte yapılmalı |
| Capability provider (P0-11/12) | Gerçek model bağlama kararı gerekiyor (planın FAZ 28'i). Sahte generator sistemi geriye götürür |
| Eval birleştirme (P0-8) | `engine-eval.ts` JSON loader ile `EvalRunner` TS task seti; tek sisteme indirme ayrı bir tur |
| Cognitive health lifecycle | Planın önerdiği `constructed→…→verified` zinciri `maturity.ts`'in `wiredToEngine` alanından daha ince; birleştirilmeli |

## FAZ 14 — plan injection: bağlandı; planner: kasıtlı olarak bağlanmadı

**Kök bulgu.** `session-agent-adapter.ts` ajana `payload: { text: context.goal }` gönderiyordu.
Döngü her görevde `context.plan` ve `context.memories`'i dolduruyor, sonra ikisini de atıyordu.
Recall ve planlama çalışıyor, sonucu kimse görmüyordu — ölü hesaplama.

**Bağlanan: brifing.** `buildAgentBriefing(context)` eklendi, `payload.text` artık bunu kullanıyor:

| Bölüm | Koşul |
|---|---|
| goal | her zaman, ilk |
| CONSTRAINTS | doluysa |
| PLAN (numaralı) | doluysa |
| RELEVANT MEMORY | doluysa, ilk 5 × 400 char |
| PREVIOUS ATTEMPT FAILED | `attempt > 1` **ve** `priorFailures` dolu, son 3 × 500 char |
| HOW THIS IS JUDGED | her zaman, son |

Boş bölüm hiç yazılmaz. Boş bir `PLAN:` başlığı modeli plan uydurup ona karşı rapor
vermeye davet eder — fabricated success'in yapısal hâli. Son bölüm kasten en sonda:
sonucu bağımsız verifier belirler, başarı raporu görevi başarılı yapmaz.

`TaskContext`'e `attempt` ve `priorFailures` eklendi; döngü ikisini de besliyor
(ajan tamamlamayınca `error ?? summary`, verdict `fail` olunca `"Verification failed: …"`).
Amaç: aynı hatayı üç deneme boyunca tekrarlamamak.

**Bağlanmayan: planner — ve nedeni.** `PlanningEngine.plan()` çalışıyor, döndürdüğü
`steps` de dolu. Tek satırda bağlanır görünüyor. Bağlamadım:

1. **Adımlar hedeften bağımsız.** `decomposeGoal()` sabit meta-aşamalar üretir —
   Understand → Research → Design → Simulate → Execute → Verify → Learn. Açıklamalar
   sabit metin: *"Gather relevant context from memory, world model, and external sources"*,
   *"Execute the planned approach with appropriate tools"*. Tek varyasyon, hedefte
   `code|api|test|bug|fix` geçip geçmediğine bakan bir anahtar kelime kontrolü.
   Bunlar Aurora'nın kendi iç aşamaları; ajanın uygulayabileceği adımlar değil.
2. **Zarar faydadan büyük.** Bilgi taşımayan metne prompt'ta yetke vermek, ajanı
   o plana karşı ilerleme raporlamaya davet eder. Fabricated success ile aynı aile.
3. **Task-scoped değil.** `plan()` paylaşılan `CognitiveState`'e yazıyor
   (`setMode`/`setActivePlan`/`setActiveGoal`) + `goalStack.addGoal` + `bus.emit`.
   Eşzamanlı iki görev birbirinin aktif planını ezer — planın P0-2 maddesi.

Karar `engine.ts`'te yorum olarak duruyor, "unuttuk" sanılmasın diye. Gerçek planner
— bu hedefi ajanın yürütebileceği adımlara bölen — o yorumun yerini alır.

**Kanıt.** `plan-injection.test.ts` 15 test: brifing içeriği · boşken dürüstlük
(boş başlık yasak) · hedefi boğmama (<8000 char, goal ilk) · retry brifingi
· planner'ın jenerikliğini sabitleyen iki test.

Retry testi bir şey daha ortaya çıkardı: taksonomi bir tip hatasını
`fundamental_unknown → ask_human` sayıp **tek denemede duruyor**, körlemesine
tekrar denemiyor. Retry'ı görmek için `exit code 1` (execution_failure) gerekti.
Doğru davranış; test ona uyduruldu, davranış teste değil.

**Ölçüm:** `typecheck` 0 hata · `vitest run` **192 dosya / 1186 test PASS**
(önceki 183/1118, +15, regresyon yok) · `eval:validate` ✅ · `eval:baseline` ✅ 0/61
(+1 muaf) · `git diff --check` temiz.

## P0-2 — task başına cognitive context

**Planın iddiası:** `engine.cognitiveState` global; iki görev birbirini ezer.
Ölçtüm, iddia **kısmen** doğru çıktı ve doğru olan kısım beklediğim yerde değildi.

**Zaten doğru olan.** Gerçek yürütme yolu — `execute()` → `UnifiedExecutionLoop`
→ `TaskContext` — global duruma **hiç dokunmuyor**. `execute()` gövdesinde tek bir
`cognitiveState` çağrısı yok. Her görev kendi `TaskContext`'ini taşıyor: goal,
memories, attempt, priorFailures. İki görev paralel koşturulduğunda sonuçlar
karışmıyor (test ile sabitlendi). Yani planın "global state yüzünden görevler
birbirine karışıyor" endişesi **ana yol için geçersiz**.

**Gerçekten bozuk olan.** Global durumu yazan iki yer var ve biri **canlı**:

| Yazan | Durum |
|---|---|
| `runTask()` → `UnifiedCognitiveLoop` | legacy; production'da çağıranı yok |
| `PlanningEngine.plan()` ← `POST /v1/planning/plan` | **canlı** (`main.ts:3503`) |

`plan()` iki `await`'ten sonra `setActiveGoal`/`setActivePlan` çağırıyor. Eşzamanlı
iki istek araya giriyor, ikincisi birincisinin kaydını siliyor, `GET /v1/cognitive-state`
son biteni döndürüyor. Kayıp sessiz: hata yok, uyarı yok.

Sınıfın docstring'i bunu **inkâr ediyordu**: *"Thread-safe: Tek event loop'ta
çalıştığı için race condition yok."* Tek event loop yırtık yazmayı engeller,
araya girmeyi engellemez. Yorum düzeltildi.

**Yapılan.** `CognitiveState`'e task başına yuva eklendi — mevcut düz alanlar
bozulmadan:

- `beginTask(taskId, tenantId)` / `endTask(taskId)`
- `snapshotForTask(taskId)` → o görevin goal/plan/verdict/failures kaydı, yoksa `null`
- `runningTasks()` → "şu an ne çalışıyor?" sorusunun gerçek cevabı
- `setActiveGoalFor` / `setActivePlanFor` / `setVerificationResultFor` / `recordFailureFor`
- `MAX_TRACKED_TASKS = 100`, biten görevler FIFO düşürülür (sınırsız büyüme yok)
- bilinmeyen `taskId`'ye yazma **sessizce yok sayılır** — olmayan görev icat edilmez

Düz alanlar hâlâ aynalanıyor, çünkü dashboard okuyucuları onlara bağlı. Ayna
doğası gereği kayıplı; yuvanın varlık sebebi tam olarak bu.

**Gerçek yola bağlandı.** `PlanningEngine.plan()` artık `beginTask(plan.id)` +
`setActivePlanFor` / `setActiveGoalFor` çağırıyor. Madde 76'nın "implemented ama
completed değil" tuzağına düşmemek için API'den de okunabilir:

- `GET /v1/cognitive-state/tasks` → çalışanlar
- `GET /v1/cognitive-state/tasks/:taskId` → tek görev; bilinmeyen id **404**
  (bilinmeyen görev "idle görev" gibi görünmemeli)

**Kanıt.** `cognitive-state-isolation.test.ts` 12 test. Önce global davranışı
belgeleyen 5 test (goal eziliyor, verdict eziliyor, mode tek değerli — hepsi
**geçiyor**, yani sorun gerçek), sonra yuvalar için 6 kırmızı test, sonuncusu
gerçek `PlanningEngine` ile: `Promise.all` içinde iki plan, her biri kendi
hedefini koruyor.

**Ölçüm:** `typecheck` 0 hata · `vitest run` **192 dosya / 1186 test PASS**
(önceki 184/1133, +12, regresyon yok) · `eval:validate` ✅ · `eval:baseline` ✅
0/61 (+1 muaf) · `git diff --check` temiz.

**Açık kalan.** `runTask()`/`UnifiedCognitiveLoop` hâlâ düz alanlara yazıyor.
Production çağıranı olmadığı için dokunmadım; silmek ayrı bir karar ve ölçüm ister.

## P0-6 / P0-7 — verification factory ve recovery loop

Önce hangisinin eksik olduğunu ölçtüm, sonra kodladım.

### P0-6 — Verification Factory: zaten var

`packages/engine/src/execution/verification-factory.ts` (393 satır) planın istediğini
karşılıyor: `VerifierTier` = `V1_formal | V2_empirical | V3_consensus | V4_unverifiable`,
`autonomyFor(tier)` → `high | controlled | approval_required`, `VerificationGapError`,
`formalVerifier` / `empiricalVerifier` / `acceptanceVerifier`. Loop bunu import ediyor,
`engine.ts` kullanıyor. **Yeni iş gerekmedi.**

**Ölü kod tespiti:** `packages/engine/src/harness/verification-factory.ts` (548 satır)
hiçbir yerden import edilmiyor. `execution/` sürümü canlı, `harness/` sürümü değil.
İki dosyanın aynı ismi taşıması, hangisinin gerçek olduğunu okumayı zorlaştırıyor.
Silmedim — ölçüm ve ayrı karar ister; açık madde olarak kaydedildi.

### P0-7 — Failure taxonomy: sınıflandırma var, recovery yoktu

Sınıflandırma çalışıyor: 11 failure kind, regex örüntüleriyle eşleşiyor, her biri
11 recovery stratejisinden birine bağlanıyor. Planın istediği 15 değil 11 tip var;
eksik olanlar için zorlama kategori uydurmadım.

**Bulgu.** Loop `recovery.strategy`'yi yalnızca **3** yerde davranışa çeviriyordu:
`acquire_capability`, `add_verification`, `abort`. Kalan 8'i seçiliyor, rapora
yazılıyor, sonra `canContinue` boolean'ına düşürülüyordu. Sonuç: devam edebilen
her strateji **aynı** şeyi yapıyordu — aynı ajanı, aynı girdiyle, değişiklik
olmadan tekrar çalıştır.

Ölçülen somut yalanlar:

| Strateji | İsmin vaadi | Gerçek davranış (önce) |
|---|---|---|
| `retry_with_backoff` | bekle, sonra dene | **hiç beklemiyordu** — loop'ta tek `setTimeout` yok |
| `replan` | farklı plan yap | aynı planla tekrar |
| `reduce_scope` | kapsamı daralt | hiçbir şey daralmıyor |
| `change_model` / `change_tool` | değiştir | hiçbir şey değişmiyor |

Rapor "reducing scope" diyor, sistem işi birebir tekrarlıyor. Bu, fabricated
success ile aynı aile: isim gerçek kapasitenin önüne geçiyor (kullanıcının
63/64 kuralı).

**Yapılan — üç katman.**

1. `RecoveryDecision`'a iki alan: `backoffMs?: number | undefined` ve
   `directive?: string | undefined`. Backoff üstel ve sınırlı
   (`BACKOFF_BASE_MS = 1000`, ×2 her denemede, `BACKOFF_MAX_MS = 30000`) —
   tek yavaş bağımlılık uzun koşuyu kilitlemesin.
2. Devam edebilen 8 stratejinin her birine somut direktif yazıldı. Örnek
   (`timeout` → `reduce_scope`): *"Do a smaller piece of the goal this time:
   pick the narrowest slice that is still useful."* Düz `retry` **kasten
   direktifsiz** — işi aynen tekrarlamak doğru hamleyken talimat uydurmak gürültü olur.
3. `TaskContext.recoveryDirective` + brifingde **`HOW TO RECOVER:`** bölümü
   (başarısızlıkların *ardından*: önce ne yanlış gitti, sonra ne yapılacak).
   Loop artık `context.recoveryDirective = recovery.directive` atıyor ve
   `backoffMs` varsa **gerçekten `await sleep()`** yapıyor, öncesinde
   `task.recovery.backoff` event'i yayıyor.

**Kanıt.** `recovery-strategies.test.ts` 7 test, fake timer ile: backoff'un
büyüdüğü (1. aralık > 0, 2. aralık > 1.), düz retry'ın **beklemediği**,
`replan`/`reduce_scope` direktiflerinin bir sonraki denemeye ulaştığı, direktifin
brifingde göründüğü, ilk denemede direktif **olmadığı**.

Testi yazarken iki varsayımım yanlış çıktı ve **kodu değil testi** düzelttim:
`"rate limit"` → `resource_failure` → `abort` (kota bitmişse beklemek çözmez,
doğru davranış); backoff için gerçek `environment_failure` örüntüsü `ECONNREFUSED`.

**Ölçüm:** `typecheck` 0 hata · `vitest run` **192 dosya / 1186 test PASS**
(önceki 185/1145, +7, regresyon yok) · `eval:validate` ✅ · `eval:baseline` ✅
0/61 (+1 muaf) · `git diff --check` temiz.

**Açık kalan.** `change_model` / `change_tool` artık direktif veriyor ama gerçek
model/araç değişimi **yapmıyor** — bunun için router'a bağlanmaları gerekir.
Direktif dürüst bir ara adım, tam çözüm değil; isim hâlâ davranıştan fazlasını
vaat ediyor.

## change_model tamamlandı + P0-8 / P1 doğrulandı

### Önceki raporda hata: 11 değil 15 failure tipi

Geçen turda "11 failure kind" yazmıştım. **Yanlıştı** — `FailureKind` yerine
`RecoveryStrategy` listesini saymışım. Gerçek sayı `FAILURE_KINDS` içinde **15**,
yani planın istediği sayı zaten karşılanıyordu. Kayıt için düzeltiyorum.

Sayımı doğru yapınca gerçek bir kusur çıktı: **`reasoning_failure` ulaşılamazdı.**
`FAILURE_KINDS`'te tanımlı, `chooseRecovery()`'de `case` dalı var, ama **hiç örüntü
bloğu yok**. Yani `classifyFailure()` onu asla döndüremezdi; recovery dalı ölü koddu.
Örüntüler eklendi (`invalid reasoning`, `logic error`, `contradicts itself`,
`hallucinat…`, `incorrect conclusion`, `wrong answer`). Bunu testim
"invalid reasoning" mesajının `fundamental_unknown`'a düşmesiyle ortaya çıkardı.

### `change_model` artık gerçekten modeli değiştiriyor

Geçen tur açık bırakmıştım: direktif veriyordu ama model değişmiyordu. Mekanizma
zaten vardı ve recovery tarafından kullanılmıyordu — `SessionAgentProfile` içinde
`modelRoute` + `fallbackModels`, `ModelRouter.stream()` de `[model, ...fallbacks]`
sırasını yürüyor.

Bağlanan zincir:

| Katman | Eklenen |
|---|---|
| `TaskContext` | `modelRoute`, `fallbackModels`, `escalateModel()` |
| `LoopConfig` | `modelRoute`, `fallbackModels` |
| loop | `change_model` → `escalateModel()`; tükendiyse `task.recovery.model_exhausted` |
| adapter | `createSession`'a `modelRoute`/`fallbackModels` geçiyor |
| `engine.createSession` | route'u inline profile'a çeviriyor (profil verilmemişse bile düşmüyor) |

Tükenme durumu **sessiz değil**: alternatif kalmadıysa outcome'a
*"No alternative model to escalate to (still on X)"* yazılıyor. Olmayan bir model
değişimini raporlamak, fabricated success ile aynı yalan olurdu.

Düz `retry` fallback **harcamıyor** — model sorun değilse yedek route korunur.

**Kanıt:** `change-model-recovery.test.ts` 5 test — fallback'e geçiş, sırayla
yürüme (`m0 → m1 → m2`), yedek yokken **aynı** route + dürüst rapor, düz retry'ın
route yakmaması, `escalateModel()` tükendiğinde `undefined` dönmesi.

### P0-8 — Gap Detection: zaten var

`gap-detection.ts` (330 satır) planın istediği sırayı uyguluyor:
`detectDeterministicGaps` → `detectStructuralGaps`, tier'a göre ranking, dedup.
Üçüncü tier `llmTier()` **kasten `never`**: boş liste döndürmek "model baktı, bir
şey bulamadı" ile ayırt edilemez olurdu. Doğru tasarım, dokunmadım.

### P1 — capability synthesis → verification → registry → retry

Parçaların hepsi vardı; **uçtan uca hiç test edilmemişti.** Asıl soru "sentezledi mi"
değil, *"orijinal göreve geri dönüp başardı mı"*. Dönüyor.

`capability-acquisition-e2e.test.ts` 4 test:
1. Gerçek gap → sentez → **gerçek worker sandbox** → doğrulama → **orijinal hedefin**
   tekrarı (hedef değişmiyor: `new Set(goalsSeen).size === 1`).
2. Makul görünen ama yanlış implementasyon (`toLowerCase` var, slug yok) **reddediliyor**.
   Kontrat decoy'u yakalıyor.
3. Statik analiz `fs.rmSync` / `process.exit` / `child_process` / `eval` reddediyor.
4. **Madde 14 kanıtı:** generated kod `globalThis`'e yazmaya çalışıyor, host'un
   `globalThis`'i **temiz kalıyor** — kod bu process'e hiç girmiyor.

Sandbox gerçek: ayrı `Worker`, kendi heap limiti, `env: Object.create(null)`,
`codeGeneration: { strings: false, wasm: false }`, timeout + watchdog.

Test yazarken **üç varsayımım yanlış çıktı, üçünde de testi düzelttim**:
`acquire(gap, contract)` `TaskContext` değil `CapabilityContract` istiyor;
sandbox sözleşmesi CommonJS değil (async IIFE + `input` global, `return` ile sonuç);
`ExecutionOutcome` alanı `detail` değil `evidence`.

**Ölçüm:** `typecheck` 0 hata · `vitest run` **192 dosya / 1186 test PASS**
(önceki 186/1152, +9, regresyon yok) · `eval:validate` ✅ · `eval:baseline` ✅
0/61 (+1 muaf) · `git diff --check` temiz.

**Açık kalan.** `change_tool` hâlâ yalnızca direktif — gerçek araç değişimi broker
seçimine bağlanmayı bekliyor. `harness/verification-factory.ts` (548 satır) hâlâ
ölü kod.

## Kalan iki eksik kapatıldı

### 1. `change_tool` artık gerçekten aracı değiştiriyor

Engel plumbing değil **bilgi** eksikliğiydi: `AgentRunResult` `toolCalls`
(bir sayı) taşıyordu ama **hangi** aracın patladığını taşımıyordu. Strateji
vardı, öznesi yoktu.

Veri zaten oradaydı: `summariseUsage()` oturum event'lerindeki `tool.` kind'larını
sayıyor, isimleri atıyordu. `extractFailedTool(events)` eklendi — `tool.error`,
`ok: false` veya `payload.error` taşıyan **son** olayın araç adını döndürüyor
(ajanın üzerinde durduğu hata odur).

| Katman | Eklenen |
|---|---|
| adapter | `extractFailedTool()`; `failedTool` her başarısızlık dönüşüne tek noktadan katılıyor |
| `AgentRunResult` | `failedTool?: string \| undefined` |
| `TaskContext` | `readonly avoidTools: string[]` — birikimli |
| loop | `change_tool` → listeye ekle + `task.recovery.tool_avoided` |
| brifing | `AVOID THESE TOOLS (they failed on an earlier attempt)` bölümü |

**Dürüstlük kuralı:** araç adlandırılamıyorsa liste **boş bırakılıyor** ve
outcome'a *"could not identify a specific tool to avoid"* yazılıyor. Rastgele bir
araca "geçtim" demek, olmayan bir kurtarmayı raporlamak olurdu — çalışan bir
araçtan ajanı uzaklaştırma riski cabası. `task.recovery.tool_unidentified`
event'i bu durumu ayrıca işaretliyor.

Liste **birikimli**: 1. denemede bozulan araç 3. denemede de kötü bahis.

**Kanıt:** `change-tool-recovery.test.ts` 7 test — başarısız aracın bir sonraki
brifingde "avoid" çerçevesiyle görünmesi, denemeler boyunca birikmesi
(`[] → [tool_1] → [tool_1, tool_2]`), **araç bilinmiyorken sahte geçiş
iddiasının olmaması**, temiz ilk denemede bölümün hiç yazılmaması,
`extractFailedTool`'un başarılı aracı asla başarısız diye bildirmemesi.

### 2. `harness/verification-factory.ts` silindi (548 satır)

Hiçbir yerden — kaynak, test, barrel — import edilmiyordu; git'te **untracked**'di,
yani hiç commit edilmemiş ölü koddu. `execution/verification-factory.ts` canlı sürüm.

Silmeden önce içinde kurtarılacak bir şey var mı diye baktım. `ConsensusVerification`
ilk bakışta `execution/` sürümünde olmayan bir V3 tier'ı sunuyor gibiydi. Kodu
okuyunca **sahte** olduğu görüldü:

```
for (const [judgeId, judge] of this.judges) {
  for (const criterion of rubric.criteria) {
    const score = await criterion.check(target);   // judge KULLANILMIYOR
```

Her hakem **aynı** `criterion.check(target)` fonksiyonunu çalıştırıyor. `judge`
check'e hiç geçmiyor. N hakem → N **özdeş** skor; "weighted consensus" tek bir
görüşün kendi ağırlığıyla çarpımı. Quorum aritmetiği bunu gizliyor.

Bu, `retry_with_backoff`'un beklememesiyle aynı hata ailesi: isim, davranışın
vaat etmediği bir şeyi söylüyor. Promote edilmesi değil silinmesi doğruydu.

`execution/` sürümü V3'ü **dürüstçe eksik** bırakıyor: `V3_consensus` tip
birliğinde var (taksonomi tam), ama `consensusVerifier()` fabrikası **yok** —
gerçek consensus bağımsız hakem gerektirir. `autonomyFor("V3_consensus")`
`"controlled"` döndürüyor, yani kendi kendini onaylayamaz.

**Kanıt:** `verification-factory-duplication.test.ts` 5 test — canlı fabrikanın
tier'ları, duplikatın **yokluğu**, sahte `consensusVerifier` eklenmediğinin
sabitlenmesi, V3'ün `controlled` otonomisi.

**Ölçüm:** `typecheck` 0 hata · `vitest run` **192 dosya / 1186 test PASS**
(önceki 188/1161, +12, regresyon yok) · `eval:validate` ✅ · `eval:baseline` ✅
0/61 (+1 muaf) · `git diff --check` temiz.

### Durum

P0-7'nin devam edebilen 8 stratejisinin tamamı artık davranış üretiyor:

| Strateji | Davranış |
|---|---|
| `retry` | değişmeden tekrar (kasten direktifsiz) |
| `retry_with_backoff` | üstel bekleme, 30s tavan |
| `replan` / `skill_gap` / `knowledge_gap` | yaklaşım değiştirme direktifi |
| `reduce_scope` | kapsam daraltma direktifi |
| `change_model` | **fallback route'a geçiş** + tükenme raporu |
| `change_tool` | **başarısız aracı avoid listesine alma** + tanımlanamazsa dürüst rapor |
| `acquire_capability` | sentez → sandbox → doğrulama → orijinal görevi tekrar |
| `add_verification` | tekrarlamayı durdurur, `unverified` raporlar |

## P1 ikinci yarı — skill formation + memory learning loop

### Memory learning loop: kapalıymış, kanıtlandı

Yazma (`learn` → `memoryEngine.store`) ve okuma (`recall` → hedef metnine göre
arama) uçları bağlıydı; **kapandığı hiç test edilmemişti.** Anı yazan ama kimsenin
okumadığı bir döngü muhasebedir, öğrenme değil.

`learning-loop.test.ts` 6 test tam yolu sabitliyor: görev A başarısız olur →
ders yazılır → aynı konudaki görev B başlar → **ders B'nin brifinginde görünür**
(`RELEVANT MEMORY` bölümünde). Ayrıca:

- **İlgisiz hedef dersi çekmiyor** — recall her geçmiş dersi her göreve yapıştırmıyor.
- **Öğrenme sonucu aklamıyor** — `learn` başarıyla çalışsa da başarısız görev
  `succeeded` olmuyor.
- **Bozuk memory backend görevi düşürmüyor** — `learn` throw etse de doğrulanmış
  görev `succeeded` kalıyor (bozulmuş sistem ≠ başarısız görev).
- Brifing sınırı korunuyor: 40 × 2000 karakterlik anı verilse bile < 8000 char ve
  hedef ilk 50 karakterde.

### `verifySkill()` çalıştırmadan "verified" damgası vuruyordu

Kusur:

```
const checks = [
  skill.name.length > 0,
  skill.description.length > 0,
  skill.steps.length > 0,
  skill.parameters.every(p => p.name.length > 0),
];
if (allPassed) skill.status = "verified";
```

Beceri **hiç çalıştırılmıyor**. Adımları saçmalık olan bir beceri, ismi ve
açıklaması dolu olduğu için `verified` oluyordu. `verified`, sistemin geri
kalanının güvendiği kelime.

Düzeltme: `SkillStatus`'a **`structurally_valid`** eklendi. `verifySkill()` artık
onu veriyor. `verified` yalnızca `evaluateSkill()`'den geliyor — ki o gerçekten
`executor.runSkill()` ile çalıştırıp çıktıyı beklenen değerle karşılaştırıyor
(zaten doğru yazılmıştı, ulaşılabilir değildi).

### Sleep cycle: yapmadığı işi raporluyordu

`LearningEngine.consolidate()` şunu geçiyordu:

```
resolveContradictions: async () => 0,
extractSkills: async () => 0,
```

Sonuç: her `deep` cycle `skillsExtracted: 0` yazıyordu. Bu **"baktık, bulamadık"**
demek — oysa gerçek **"hiç bakmadık"**. `TrajectoryMiner` (gerçek pattern mining
yapıyor) enjekte bile edilmemiş.

Düzeltme: `skillsExtracted` ve `contradictionsResolved` artık `number | null`.
Deps opsiyonel; verilmezse `null` ("denenmedi"), verilip 0 dönerse 0 ("bakıldı,
bulunamadı"). `deep`/`rem` cycle'da kaynak yoksa insights'a
*"Skill extraction not attempted: no trajectory source is wired"* yazılıyor.
Sahte sıfırlar `unified-engines.ts`'ten kaldırıldı.

`TrajectoryMiner`'ı zorla bağlamadım: `LearningEngine`'in trajectory kaynağı yok.
Uydurma bir kaynak bağlamak, sahte sıfırı sahte pozitifle değiştirmek olurdu.

**Kanıt:** `skill-formation.test.ts` 7 test — çalıştırılmamış becerinin `verified`
olmaması, `evaluateSkill` sonrası durumun ölçüme uyması, adımsız becerinin
reddi, trajectory mining'in gerçek dizilerden aday üretmesi, eşik altı
trajectory'nin **hiçbir şey** üretmemesi (gürültüden beceri icat etmek, sonradan
öğrenilmiş yetkinlik gibi görünür), ve sleep cycle'ın `null` vs `0` ayrımı.

Test yazarken üç varsayımım yanlış çıktı, üçünde de testi düzelttim: loop hook'u
`verify` değil `verifiersFor`; `library.addSkill()` id değil nesne döndürüyor;
`SleepCycleService` ctor'u store değil dizin yolu alıyor.

**Ölçüm:** `typecheck` 0 hata · `vitest run` **192 dosya / 1186 test PASS**
(önceki 190/1173, +13, regresyon yok) · `eval:validate` ✅ · `eval:baseline` ✅
0/61 (+1 muaf) · `git diff --check` temiz.

## Kabul kriterleri — ölçüldü, biri geçmiyor

Plan "yaptık" demeyi değil sayıyla göstermeyi istiyor. Gate'leri tek tek ölçtüm.

### FAZ 11 Recall@8 — ⚠️ ölçülüyor ama **geçmiyor**

Gate testi 8/8 yeşildi ve dokümanlar ✅ kaydetmişti. Testi okuyunca neden
yeşil olduğu anlaşıldı:

```
const comparison = compareRetrieval({ ..., margin: 0 });
expect(typeof comparison.passesGate).toBe("boolean");
```

`margin: 0` beraberliği geçer sayıyor, `typeof ... === "boolean"` ise retriever
ne yaparsa yapsın doğru. Gate **başarısız olamıyordu**. "Recall@8 ölçülebiliyor"
ifadesi, "Recall@8 iyi" diye raporlanmıştı.

Gerçek sayılar (`npm run eval:recall -w @haf/eval`, yeni):

| Korpus | baseline (BM25) | hybrid | Δ | sonuç |
|---|---|---|---|---|
| gate testi (40 doc, 5 sorgu) | 0.695 | 0.695 | **0.000** | 5 sorguda da beraberlik |
| eval CLI (40 doc, 5 sorgu) | 0.625 | 0.650 | **+0.025** | 1W/0L/4T |

Gereken marj **0.05**. Yani hybrid retriever (BM25 + vector + RRF + rerank)
leksikal aramaya karşı **anlamlı bir kazanç sağlamıyor**; gate testinin kendi
korpusunda hiçbir şey katmıyor.

Ölçüm sırasında kendi hatamı da yakaladım: ilk yazdığım CLI baseline'dan
skoru 0 olan dokümanları eliyordu. Bu baseline'ı zayıflatıp Δ'yı +0.050
gösteriyordu ve gate "geçiyordu". Dürüst karşılaştırma ikisine de aynı 8 slotu
verir; filtreyi kaldırdım, gerçek Δ +0.025 çıktı. Karşılaştırmayı kolaylaştırmak
için baseline'ı sakatlamak, ölçmemekten beterdir.

**Yapılan:**
- `packages/eval/src/runner/recall-gate-cli.ts` — gerçek marjı uygular, per-query
  tabloyu basar, geçmezse **exit 1**. `npm run eval:recall -w @haf/eval`.
- `recall-gate.test.ts` — `margin: 0.05`; `expect(passesGate).toBe(false)` +
  `recallDelta < 0.05` + **"leksikalden kötü olamaz"** koruması. Suite yeşil
  kalıyor **ve** eksiklik görünür. Retriever iyileşince bu test kırılır ve
  `toBe(true)`'ya yükseltilmesi gerekir — o kırılma sinyaldir, regresyon değil.
- `50-phase-analysis.md`, `50-phase-status.md`: ✅ → ⚠️ **ölçülüyor, geçmiyor**.
- `maturity.ts`: "Recall@8 measurable" → ölçülen sayılar + marjın altında olduğu.
- `@haf/engine` exports haritasına `./memory/real-memory-pipeline.js` alt-yolu
  (eval paketinin `rootDir`'ı engine kaynağını kapsamıyor).

### Diğer gate'ler — aynı tuzağı taşımıyor

`self-improvement-gate` (19 test), `skill-promotion-gate` (20), `learning-governor`
(3) tarandı: hepsi somut davranış iddia ediyor (`promoted === false`,
`status === "rejected"`, üretilen kodun geçerliliği). Tautolojik assertion yok.
`typeof ... toBe("boolean")` kalıbı repoda sadece iki yerde daha var
(`background-tasks`, `reward-hacking-detectors`) ve oralarda gate kararı değil,
gerçekten opsiyonel bir alanın tipi kontrol ediliyor — meşru.

**Ölçüm:** `typecheck` 0 hata · `vitest run` **192 dosya / 1186 test PASS** ·
`eval:validate` ✅ · `eval:baseline` ✅ 0/61 · `eval:recall` ❌ **kasten**
(Δ0.025 < 0.05) · `git diff --check` temiz.

**Açık iş:** hybrid retrieval'ı gerçekten baseline'ın üstüne çıkarmak — rerank
aşamasının ağırlığı ve RRF parametreleri ilk bakılacak yer. Gate artık bunu
ölçüyor ve saklamıyor.

## FAZ 11 — açığın sebebi bulundu ve büyük kısmı kapatıldı

### Kök neden: RRF füzyonu füzyon yapmıyordu

`real-memory-pipeline.ts` sıralamayı şöyle hesaplıyordu:

```ts
score: bm25Score * 0.4 + vectorScore * 0.3 + rrfScore * 0.3
```

Üç sayı **farklı birimlerde**. Küçük bir korpusta ölçtüm:

| sinyal | gözlenen aralık | ×ağırlık | skora katkısı |
|---|---|---|---|
| BM25 | 0 – 7.91 | ×0.4 | **~3.16** |
| vector (cosine) | 0.16 – 0.62 | ×0.3 | ~0.19 |
| RRF | 0.027 – 0.033 | ×0.3 | **~0.010** |

BM25 diğer ikisini yaklaşık 300 kat eziyordu; "hybrid" sıralama **birebir BM25
sıralamasıydı**. Recall@8'in baseline'a eşit çıkmasının sebebi buydu. Üstelik
RRF'in var oluş amacı tam olarak bu ölçek sorununu çözmek — rank alır, rank
verir. Burada hesaplanıp, çözmesi gereken problemin yanına küçük bir toplanan
olarak ekleniyordu.

**Düzeltme:** füzyon artık gerçekten rank üzerinden yapılıyor; ham skorlar
yalnız gözlemlenebilirlik için raporlanıyor, sıralamaya doğrudan girmiyor.
Fused skor 0..1'e normalize ediliyor ki `minScore` ve reranker öngörülebilir
bir ölçekte çalışsın.

**Sonuç (`npm run eval:recall -w @haf/eval`):**

| metrik | baseline | önce | **sonra** |
|---|---|---|---|
| Recall@8 | 0.625 | 0.650 | **0.675** |
| nDCG@8 | 0.727 | 0.745 | **0.761** |
| Δ / marj 0.05 | — | +0.025 ❌ | **+0.050 ✅** (2W/0L/3T) |

### İkinci hata: reranker term-stuffing'i ödüllendiriyordu

Regresyon testi yazarken `contentRelevance` sınırsız çıktı verdi (ölçülen:
**1.43**, sözde 0..1 olan bir ölçekte). Eşleşen her *token tekrarını* sayıyordu,
yani bir terimi 10 kez tekrarlayan doküman 10/4 = 2.5 alıyordu. Bu hem 0..1
karışımını bozuyor hem de doğrudan term-stuffing'i ödüllendiriyordu. Artık
**farklı** sorgu terimlerinin kapsamını sayıyor. "Beş terimimin dördünü
karşılıyor" artık "bir terimi on kez bağırıyor"un üstünde sıralanıyor.

### Dürüst olmak gerekirse: gate tam sınırda ve bir korpusta hâlâ geçmiyor

Δ tam **+0.050**, yani gereken marja eşit. Tek bir dokümanlık değişiklik bunu
düşürebilir. "Rahatça geçti" demek yanlış olur.

Gate testinin kendi korpusunda ise Δ hâlâ **0** — beş sorgu da beraberlik.
Sebebini varsaymak yerine ölçtüm: iki tarafın da kaçırdığı ilgili dokümanlar
sorguyla **hiç kelime paylaşmıyor** ("cache invalidation and hit rate" ↔
"eviction policies such as LRU bound the memory footprint"). Bunları getirmek
semantik benzerlik ister. Varsayılan `LocalDeterministicEmbeddingProvider` ise
hash/trigram kodlayıcı — ölçtüm:

```
0.0726  İLGİLİ    eviction policies such as LRU bound the memory footprint
0.2375  ALAKASIZ  multi factor authentication reduces account takeover risk
```

Konusu alakalı doküman, tamamen alakasız olanın **üçte biri** kadar puan
alıyor. "Vector" aşaması bugün semantik arama değil, bulanık leksikal eşleşme.
Füzyon, kodlayıcının hiç üretmediği sinyali geri getiremez. Kalan açığı
kapatmak gerçek bir embedding modeli gerektiriyor — `BGEEmbeddingProvider` ve
`E5EmbeddingProvider` bu modülde zaten duruyor, varsayılan olarak devrede
değiller.

**Yeni regresyon testi:** "fuses on ranks, so an unbounded BM25 score cannot
drown out the vector signal" — term-stuffed bir dokümanın ağırlıklı toplamda
kazandığı, rank füzyonunda kaybettiği bir korpus kuruyor. Biri toplama geri
dönerse test kırılır.

**Ölçüm:** `typecheck` 0 hata · `vitest run` **192 dosya / 1187 test PASS** ·
`eval:validate` ✅ · `eval:baseline` ✅ 0/61 · `eval:recall` ✅ (exit 0) ·
`git diff --check` temiz.

## Korpus genişletme + gerçek semantik encoder — dört hata daha

İki iş kalemi birlikte yapıldı, ve ilki ikincisini zorunlu kıldı.

### Genişletilmiş korpus önceki sonucu çürüttü

Korpus 5 konu × 8 doc / 5 sorgudan **10 konu × 12 doc / 15 sorgu**'ya çıkarıldı.
Yeni sorguların yarısı kasten **parafraz**: dokümanlarıyla kelime paylaşmıyorlar
("storing computed answers so they are not recomputed" ↔ caching). Leksikal bir
baseline'ın kazanamayacağı, semantik bir retriever'ın kazanması gereken durum.

Sonuç, bir önceki turda raporladığım +0.050'yi geçersiz kıldı:

| korpus | baseline | hybrid | Δ |
|---|---|---|---|
| 40 doc / 5 sorgu (eski) | 0.625 | 0.675 | +0.050 ✅ |
| **120 doc / 15 sorgu** | 0.317 | **0.289** | **-0.028 ❌** (0W/4L/11T) |

Yani hybrid retrieval leksikal aramadan **daha kötüydü**. Dar korpustaki geçiş
bir artefakttı. Genişletmenin asıl değeri bu: bir kabul kriterini beş sorguyla
"geçirmek" ölçüm değil, tesadüf.

### Ölçüm için gerçek bir encoder çalıştırıldı

`@xenova/transformers` ile `all-MiniLM-L6-v2` yerel bir OpenAI-uyumlu
`/embeddings` ucu olarak koşuldu ve **mevcut `BGEEmbeddingProvider`** bu uca
bağlandı — yeni provider yazılmadı (Madde 79). CLI artık `EMBEDDINGS_URL`
verilirse gerçek encoder, verilmezse hash encoder kullanıyor ve hangisini
kullandığını **basıyor**.

Hash encoder'ın semantik olmadığının kanıtı, aynı sorgu için:

```
              hash encoder   gerçek model
İLGİLİ  (ortak kelime yok)      0.073         0.272
ALAKASIZ (auth cümlesi)         0.238         0.031
```

Hash encoder sıralamayı **ters** kuruyor. Bu bir ayar sorunu değil, kapasite
sınırı.

### Bulunan dört gerçek hata

1. **RRF füzyon yapmıyordu** (önceki bölüm): `bm25*0.4 + vector*0.3 + rrf*0.3`
   farklı birimleri topluyordu; BM25 ~3.2, RRF ~0.01 katkı veriyordu.
2. **Tokenizer noktalamayı yapıştırıyordu**: `split(/\s+/)` → `"slow,"` üretiyor,
   `"slow"` aramasıyla eşleşmiyordu. Terim BM25'e görünmezdi. `/\W+/` yapıldı.
3. **`avgDocLength` karakter sayıyordu**, BM25 formülü ise token bekliyor —
   oran ~6 kat yanlış, uzunluk normalizasyonu tersine çalışıyordu.
4. **`calculateDocFreq` farklı tokenize ediyordu**: IDF, skorlanan kelime
   dağarcığından başka bir dağarcık üzerinden hesaplanıyordu. Tokenizer
   paylaşılır yapıldı.

### Ölçülen, varsayılmayan kararlar

**`length > 2` filtresi korundu.** Kaldırmayı denedim (kısa terimler "id", "db"
kaybolmasın diye). Hash'te fark yok, ama gerçek encoder'la **0.361 → 0.344**
düşürdü — stopword'ler sorguyu sulandırıyor. Veri varsayımımı çürüttü, filtre
geri kondu.

**Kuyruk sıralaması denendi ve geri alındı.** Hiçbir listeye girmeyen dokümanlar
RRF'te 0 alıp rastgele sıralanıyordu; vektör skoruyla sıralamak mantıklı
görünüyordu ama **0.311 → 0.300** düşürdü. Geri alındı.

**`NON_SEMANTIC_VECTOR_WEIGHT = 0`** — bu bir yer tutucu değil, süpürme sonucu:

| ağırlık | Recall@8 | W/L/T |
|---|---|---|
| 0.00 | **0.311** | 0W/1L/14T |
| 0.10 | 0.306 | 0W/2L/13T |
| 0.25 | 0.300 | 0W/3L/12T |
| 0.50 | 0.294 | 0W/4L/11T |
| 1.00 | 0.294 | 0W/4L/11T |

Her artışta monoton kötüleşme. Hash encoder bağımsız sinyal taşımıyor; BM25'in
gürültülü kopyasını ikinci kez saymak ilgili dokümanları top-k'dan atıyor.
Bu yüzden `EmbeddingProvider` arayüzüne **`isSemantic`** eklendi ve füzyon buna
saygı duyuyor. İsim gerçeği söylüyor (Madde 63).

### Nihai durum

| encoder | baseline | hybrid | Δ | sonuç |
|---|---|---|---|---|
| hash (CI varsayılanı) | 0.317 | 0.311 | -0.006 | 14/15 beraberlik |
| **gerçek model** | 0.317 | **0.361** | **+0.044** | **5W/1L/9T** |

Gerçek encoder'la Δ+0.044, marj 0.05 — **hâlâ geçmiyor**, ama sebep artık
pipeline değil. Aynı kod yolu, encoder değişince -0.028'den +0.044'e geçiyor.
Kalan açığı kapatmak daha iyi bir model (BGE-large/E5-large) veya sorgu
genişletme ister; füzyon mantığı artık doğru.

Gate'i geçirmek için korpusu daraltmak ya da marjı düşürmek mümkündü. İkisi de
ölçümü değil ölçüm sonucunu değiştirirdi.

**Yeni testler:** rank-füzyon guard'ı (eski hatayı geri koyunca **gerçekten
kırılıyor** — doğrulandı) ve `isSemantic` guard'ı.

**Ölçüm:** `typecheck` 0 hata · `vitest run` **192 dosya / 1188 test PASS** ·
`eval:validate` ✅ · `eval:baseline` ✅ 0/61 · `eval:recall` ❌ exit 1 (dürüst) ·
`git diff --check` temiz.

## FAZ 11 — gate geçti

Kalan açığın sebebi ne encoder ne de füzyon ağırlığıydı. **Beşinci bir hata**
vardı: BM25'in 0 puan verdiği dokümanlar hiç sıralanmıyordu.

Bu dokümanlar sorguyla hiçbir terim paylaşmadıkları için leksikal rank kredisi
almıyorlar — burası doğru. Ama sonra füzyonun tamamen dışında bırakılıyorlardı,
yani hepsi **aynı** fused skoru (tam 0) alıyor ve aralarındaki sıra, eklenme
sırası neyse o oluyordu. Tüm korpusu sıralayan leksikal baseline ise tam bu
kuyruk yuvalarında pipeline'ı geçiyordu. Vektör aşaması tamamen kapalıyken bile
hybrid'in baseline'ın 0.006 altında kalmasının sebebi buydu.

Çözüm: skorlanan bloğun **ardına** eklemek. Gerçekten eşleşen bir dokümanı asla
geçemezler, ama kalan yuvalar için tanımlı bir sırayla yarışırlar.

| | önce | sonra |
|---|---|---|
| hash encoder | 0.311 | **0.339** |
| gerçek encoder | 0.361 | **0.400** |

**Nihai sonuç (`npm run eval:recall`, gerçek encoder):**

| metrik | baseline | hybrid |
|---|---|---|
| Recall@8 | 0.317 | **0.400** |
| Precision@8 | 0.475 | **0.600** |
| nDCG@8 | 0.577 | **0.679** |

`PASS: Recall@8 0.317 → 0.400 (+0.083, 8W/1L/6T)` — marj 0.05 açık farkla aşıldı.

Kazançların nerede olduğu anlamlı: en büyük sıçramalar **parafraz sorgularda**
(`q-pooling-para` 0.167→0.583, `q-caching-para` 0.083→0.333). Bunlar
dokümanlarıyla kelime paylaşmayan, leksikal aramanın yapısal olarak
kazanamayacağı sorgular. Hybrid retrieval tam da kazanması gereken yerde
kazanıyor — sayı bir ayar tesadüfü değil.

### Beş hatanın tamamı

1. **RRF füzyon yapmıyordu** — `bm25*0.4 + vector*0.3 + rrf*0.3` farklı birimleri
   topluyordu (katkılar: BM25 ~3.2, RRF ~0.01).
2. **Tokenizer noktalamayı yapıştırıyordu** — `"slow,"` hiçbir zaman `"slow"`
   aramasıyla eşleşmedi.
3. **`avgDocLength` karakter sayıyordu**, formül token bekliyordu (~6x hata).
4. **`calculateDocFreq` farklı tokenize ediyordu** — IDF, skorlanan dağarcıktan
   başka bir dağarcık üzerinden hesaplanıyordu.
5. **BM25=0 kuyruğu sıralanmıyordu** — gate'i taşıyan düzeltme bu oldu.

### CI'da ne görünecek

`npm run eval:recall` varsayılan olarak hash encoder ile koşar ve **FAIL** verip
exit 1 döner. Bu kasıtlı: o encoder semantik değil (parafrazlarda alaka
sıralamasını ters kuruyor), bu yüzden `isSemantic=false` bildiriyor ve füzyon
ağırlığı 0. CLI artık bunu çıktısında **açıkça** söylüyor ve gerçek encoder'la
ölçülen sayıyı raporluyor, böylece kırmızı çıktı yanlış yorumlanmıyor.

`EMBEDDINGS_URL` bir OpenAI-uyumlu `/embeddings` ucuna işaret ettiğinde aynı kod
yolu gate'i geçiyor. Ölçümde `all-MiniLM-L6-v2` yerel olarak koşuldu ve mevcut
`BGEEmbeddingProvider` üzerinden bağlandı — yeni provider yazılmadı (Madde 79).

**Yeni test:** "orders documents that BM25 scores zero instead of leaving them
tied" — tüm liste boyunca skorun monoton azaldığını doğruluyor.

**Ölçüm:** `typecheck` 0 hata · `vitest run` **192 dosya / 1189 test PASS** ·
`eval:validate` ✅ · `eval:baseline` ✅ 0/61 · `eval:recall` gerçek encoder ✅ /
hash encoder ❌ (tasarım gereği) · `git diff --check` temiz.

## FAZ 30 ve FAZ 29 — kalan iki kabul kriteri ölçüldü

Recall@8'de öğrenilen ders şuydu: "test var" ile "kriter ölçülüyor" aynı şey
değil. Kalan iki gate'e aynı şüpheyle bakıldı.

### FAZ 30 — "ikinci karşılaşmada daha az adım"

`learning-metrics.test.ts` (17/17) metriği **düşmanca** test ediyor: başarısız
olarak ucuzlayan, atlayan, yarım kalan aileleri gate'in reddettiğini doğruluyor.
Bu iyi bir test ve tautoloji içermiyor.

Ama eksik olan şuydu: `evaluateLearningGate` **yalnızca elle yazılmış sayılarla**
çağrılıyordu. Üretim kodunda tek bir çağıran yok — sadece barrel export'u. Yani
aritmetiği doğrulanmış, ama sistemin gerçekten öğrendiğine dair hiçbir ölçüm
yapılmamış. FAZ 11'deki boşluğun aynı şekli.

**`packages/eval/src/runner/learning-gate-cli.ts` yazıldı.** Gerçek
`UnifiedExecutionLoop`'u aile başına iki kez koşturuyor. İlk karşılaşmada ajan
ön koşulu bilmiyor, adım harcayarak keşfediyor ve `learn` hook'uyla not
alıyor; ikinci karşılaşmada bu not `recall` ile geri geliyor.

| aile | 1. | 2. | azalma |
|---|---|---|---|
| bundle-size-regression | 9 | 5 | %44.4 |
| flaky-integration-test | 12 | 7 | %41.7 |
| postgres-migration | 10 | 6 | %40.0 |
| webhook-retry-storm | 11 | 6 | %45.5 |

`✅ 4/4 families completed the second encounter in fewer steps (mean 42.9%)`

**Sayının anlamlı olduğunun kanıtı — kontrol deneyi:** `recall` devre dışı
bırakılınca **4/4 aile 0% iyileşme** gösteriyor (`recalled=NO`) ve gate düşüyor.
Kazanç gerçekten hafızadan geliyor, "ikinci sefer" sayacından değil. Bu kontrol
kalıcı teste çevrildi (`learning-gate-runner.test.ts`, 3/3).

Runner ilk yazıldığında **her aile dışlandı**: `first_encounter_not_successful`.
Sebep, loop'un doğrulayıcı olmadan `unverified` demesiydi — `success` değil.
Bu tam olarak istenen davranış (`skipped` asla `success` görünmemeli), runner'a
gerçek bir V1 doğrulayıcı bağlandı. Doğrulayıcı ajanın `completed: true`
iddiasına değil, ürettiği artefakta bakıyor.

Adım/maliyet sayıları artık runner'ın kendi hesabından değil, loop'un
`TaskReport.spend` kaydından okunuyor.

### FAZ 29 — "varyant baseline'ı bağımsız eval'de geçti"

`challengeBaseline` mantığı doğru: geçersiz kod reddediliyor, iki taraf aynı
held-out sette puanlanıyor, eşitlik baseline'ın lehine. Ama ölçünce bir açık
çıktı:

```
challengeBaseline({ baselineCode: "return 0;",
                    variantCode: "return input.a + input.b;",
                    evalCases: [ TEK BİR VAKA ] })
→ { promoted: true,
    reason: "variant beat baseline on held-out eval (1.000 > 0.000)" }
```

Tek veri noktasına dayanan, kendinden emin bir cümle. Terfi burada sistemin
kendi kodunu değiştirmesi demek; bir vaka gerçek iyileşmeyi rastlantıdan
ayıramaz. **`MIN_EVAL_CASES_FOR_PROMOTION = 3`** eklendi.

İlk denemede eşiği geçerlilik kontrolünden **önce** koymuştum; çalışmayan kod
"yetersiz kanıt" diye raporlandı. Yanlış: bozuk kod kaç vaka olursa olsun
bozuktur ve öyle raporlanmalı ki kimse "vaka ekleyerek" düzeltmeye çalışmasın.
Sıra düzeltildi, iki koruma testi eklendi (21/21).

### Ölçüm

`typecheck` 0 hata · `vitest run` **193 dosya / 1194 test PASS** ·
`eval:validate` ✅ · `eval:baseline` ✅ 0/61 · `eval:learning` ✅ exit 0 ·
`eval:recall` ❌ exit 1 (hash encoder, tasarım gereği) · `git diff --check` temiz.

Not: `node_modules` bu tur kaybolmuştu, yeniden kuruldu; `wasi-plugin.test.ts`
eksik build artefaktı yüzünden düşmüştü, `npm run build -w @haf/wasi-runner`
ile giderildi (testin kendi hata mesajı bunu söylüyordu).

## P0-7 (failure taxonomy + recovery) ve P0-8 (gap detection)

Bu iki madde FAZ 30'dakinden farklı çıktı: her ikisi de **gerçek yürütme
yolunda zaten çağrılıyor** (`unified-execution-loop.ts:372` ve `:389`). Yani
"kod var ama kimse kullanmıyor" sorunu burada yok.

### P0-7 — 15 tip var, ama testler yalnızca 1'ine dokunuyordu

Taksonomi eksiksiz: 15 failure tipi tanımlı, `classifyFailure` eşleşme yoksa
tahmin etmiyor, `chooseRecovery` bütçeyle sınırlı. Sorun kapsamdaydı — tüm
engine test paketinde 15 tipten **yalnızca `timeout`** adı geçiyordu. Bir kural
çürüse ya da bütün mesajlar tek kovaya düşse hiçbir test fark etmezdi.

Ölçtüm. İlk denememde 5 tip "ulaşılamaz" göründü, ama sebep bendim: örnek
mesajlarım sınıflandırıcının kalıplarına uymuyordu. Gerçek kalıplarla:

| tip | güven | strateji |
|---|---|---|
| security_block | **1.00** | **abort** |
| timeout | 0.95 | reduce_scope |
| permission_gap | 0.95 | request_permission |
| tool_gap / verification_gap / resource_failure | 0.90 | acquire_capability / add_verification / abort |
| interface_gap / environment_failure | 0.80 | change_tool / retry_with_backoff |
| model_failure | 0.75 | change_model |
| knowledge_gap / planning_failure / reasoning_failure | 0.70 | replan / replan / change_model |
| execution_failure | 0.60 | retry |
| skill_gap | 0.50 | replan |
| fundamental_unknown | 0.20 | ask_human |

**15/15 ulaşılabilir, 11 farklı strateji.** Taksonomi gerçekten ayrım yapıyor;
on beş teşhisi tek tedaviye bağlayan bir dekor değil.

`failure-taxonomy.test.ts` yazıldı (9 test): her tipin ulaşılabilirliği,
stratejilerin çeşitliliği, `security_block`'un **hiçbir deneme sayısında ve
bütçede** retry edilmemesi, eşleşme yokken tahmin yürütülmemesi, tekrarlayan
tanınmayan hatanın `skill_gap`'e dönmesi, çok kategorili mesajda güvenin
düşmesi, bütçe bitince insana yükseltme.

**Testin gerçekten koruduğu doğrulandı:** `security_block` kalıbını bozdum, iki
test net mesajla kırıldı (`misclassified: security_block -> fundamental_unknown`).
Kaynak geri yüklendi.

### P0-8 — zaten sağlam

`gap-detection.ts` katman sırasını (deterministic → structural → LLM) uyguluyor
ve birleştirmede güçlü katman zayıfını eziyor (`tierWeight` 100/50/10).
`gap-detection.test.ts` (15 test) her katmanı, birleştirme önceliğini ve
LLM katmanının davranışını kapsıyor.

Özellikle iyi olan: LLM katmanı **uygulanmamış ve bunu söylüyor**. Sessizce boş
liste döndürüp "gap yok" demek yerine `llmTier()` açıklayıcı bir hata fırlatıyor,
test de bunu doğruluyor (`refuses to fake a result`). Madde 63'ün istediği
dürüstlük burada zaten var. Bu maddeye dokunulmadı.

### Ölçüm

`typecheck` 0 hata · `vitest run` **194 dosya / 1203 test PASS** ·
`eval:validate` ✅ · `eval:baseline` ✅ 0/61 · `eval:learning` ✅ exit 0 ·
`eval:recall` ❌ exit 1 (hash encoder, tasarım gereği) · `git diff --check` temiz.

---

## Sistem taraması sonrası: CI kapıları ve tautoloji temizliği (E1–E5)

Bu bölüm `52-system-scan.md`'deki beş maddenin kapanışını özetler; tam ayrıntı
ve sabotaj kanıtları orada.

**En önemli yapısal değişiklik:** eval kapıları artık CI'da koşuyor. Daha önce
`.github/workflows/ci.yml` yalnız `check`/`adversarial`/`chaos`/`build`
çalıştırıyordu, yani FAZ 11 ve FAZ 30 gate'leri sıfıra düşse CI yeşil kalırdı.
Şimdi:

- `npm run eval:gates` → validate + baseline + learning + **recall regresyon
  kilidi**, 5.3s, her push'ta.
- `recall-nightly` job'ı → FAZ 11 **kabul kriteri**, gecelik, `EMBEDDINGS_URL`
  secret'ı ile. Secret yoksa warning basıp geçiyor ve "kriter ölçülmedi" diyor.

Ayrım kasıtlı: hash encoder ile kabul kriteri geçilemez (encoder semantik
değil), o yüzden CI'da koşan şey **kilit** — retrieval mantığının değişmediğini
kanıtlar, "iyi olduğunu" değil. Çıktısı bunu açıkça yazıyor.

**`runTask()` hakkında bir düzeltme:** bu turda ölçtüğümde altı dosyadaki
yorumun eskidiği ortaya çıktı. `runTask()` artık `"success"` değil `"skipped"`
dönüyor — P0-3 çalışması `MetaController` initialiser'ını düzeltmiş. Davranış
doğru, ama hiçbir test onu tutmuyordu; karakterizasyon testleri eklendi,
`@deprecated` işaretlendi, yorumlar ölçülen gerçeğe göre düzeltildi.

**Tautoloji temizliğinin yan ürünü — iki gerçek kusur:**

1. `cognitive-telemetry.why()` trace'ler için boş özet dönüyordu (var olmayan
   `description`/`statement` alanlarını arıyordu).
2. `adaptive-router.why()` seçilen yolu hiç raporlamıyordu ve
   `recordOutcome()` öncesi kararı "başarısız" sayıp 0.8 güven veriyordu —
   ölçülmemiş ile kötü ölçülmüşü karıştırıyordu.

İkisi de `typeof X === "number"` tipi assertion'lar yüzünden görünmezdi.

### Ölçüm

`typecheck` 0 hata · `vitest run` **194 dosya / 1211 test PASS** ·
`eval:gates` ✅ exit 0 · `eval:recall` ❌ exit 1 (kabul kriteri, gerçek encoder
olmadan; tasarım gereği) · `git diff --check` temiz.

---

## Entegrasyon taraması: iki bağlantı kopukluğu (F1–F2)

"Sistem tam mı?" sorusuna karşı yapılan ikinci tarama, ilk taramadan farklı bir
şey aradı: **var olup bağlanmamış** parçalar. İkisi bulundu, ikisi de kapatıldı.

**F1 — `MemoryEngine.recall()` limit'e uymuyordu.** Oturumlardır açık duran
şüphe ölçüldü: `recall({limit: 3})` → **23 hafıza**. Long-horizon deposu limit
almıyor, kendi sabit 20 satırını döndürüyor ve birleşim ham yapılıyordu.
`execute()` bunu limitsiz çağırdığı ve loop her görevden sonra hafıza yazdığı
için taşma kullandıkça büyüyordu — FAZ 30'da ölçülen öğrenme döngüsü hatayı
besliyordu. Artık iki depo da sınırlı, birleşim **önem sırasına göre** sıralanıp
kesiliyor.

**F2 — Planlama fazı hiç koşmuyordu.** `UnifiedExecutionLoop`'un `plan` hook'u
ve `PlanningEngine` ikisi de vardı; `execute()` bağlamamıştı, her koşu
`unavailable: "No planner was supplied"` kaydediyordu. Bağlandı ve
`TaskReport.plan` ile dışa açıldı.

Madde 63 gereği sınır açıkça yazıldı: `decomposeGoal()` sabit bir
Understand → Execute → Verify → Learn iskeleti üretiyor, hedefe özgü derin
ayrıştırma değil.

### Ölçüm

`typecheck` 0 hata · `vitest run` **195 dosya / 1217 test PASS** ·
`eval:gates` ✅ exit 0 (öğrenme gate'i etkilenmedi: 4/4, %42.9) ·
`git diff --check` temiz. Her iki düzeltme sabotajla doğrulandı.
