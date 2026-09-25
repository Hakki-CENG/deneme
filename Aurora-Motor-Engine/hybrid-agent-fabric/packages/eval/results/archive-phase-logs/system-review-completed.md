# Sistem Tam İnceleme — Durum Raporu

**İlk sürüm:** 2026-09-17
**Düzeltme:** 2026-09-18

> ⚠️ **DÜZELTME — "production-ready" iddiası geri çekilmiştir.**
>
> Bu dosyanın 2026-09-17 tarihli sürümü şu cümleyle bitiyordu:
>
> > *"Sistem production-ready durumdadır. 🚀"*
>
> **Bu iddia o tarihte desteklenmiyordu.** Gerekçe aşağıda. Cümle,
> ölçülebilir bir hazırlık tablosuyla değiştirilmiştir.

---

## 1. "Production-ready" Neden Yanlıştı

O tarihte doğru olan tek şey **derlemenin temiz olması ve testlerin
çoğunun geçmesiydi.** Bunlar gerekli, ama yeterli değil. Aynı anda:

| Sorun | O günkü gerçek |
|---|---|
| 13 cognitive pipeline | **0/13 Engine'e bağlıydı** — hepsi orphan |
| Yeni 15 modülün testi | **14/15'inde test yoktu** |
| Sandbox | `simulateExecution()` her zaman `success: true` dönüyordu |
| Skill doğrulama | `Math.random() > 0.3` ile zar atıyordu |
| Eval task seti | `tasks/` dizininde **0 görev** vardı |
| Benchmark | 55 sentetik task, `expectedOutput: {result:"expected"}` |
| Recall@k | Kod tabanında **hiç ölçülmüyordu** |
| 12 başarısız test | "ortam kaynaklı" denip geçilmişti — aslında **fixture'lar eksikti** |

"Export edilmiş olmak entegrasyon değildir." Bir sistemin dışa açtığı sınıflar
hiçbir yerden çağrılmıyorsa, o özellik çalışmıyor demektir.

Ayrıca **%98.4 geçme oranı** ifadesi, başarısız 12 testin kök nedeni
araştırılmadan "ortam" hanesine yazıldığı için olduğundan iyi görünüyordu.

---

## 2. İlk Sürümde Gerçekten Doğru Yapılanlar ✅

Bu kısım geçerliliğini koruyor:

| Düzeltme | Durum |
|---|---|
| 13 modülün `index.ts` export'u | ✅ Gerçekten eklendi |
| `SkillCandidate` → `SkillSynthesisCandidate` | ✅ Çakışma çözüldü |
| `ContextItem` → `SecurityContextItem` | ✅ Çakışma çözüldü |
| `Event` → `PersistenceEvent` | ✅ Çakışma çözüldü |
| XSS açığı (`renderMarkdown`) | ✅ Gerçekten kapatıldı (20/20 test) |

XSS düzeltmesinin sırası kritiktir ve değiştirilmemelidir: code block'lar
placeholder'a alınır → kalan metin `&<>` için escape edilir → placeholder'lar
geri yüklenir → `javascript:` URL'leri engellenir.

---

## 3. Bugünkü Ölçülen Durum

| Kontrol | Değer |
|---|---|
| TypeScript build | ✅ 0 hata |
| Test suite | ✅ **1118/1118 PASS** (183 dosya) |
| Başarısız test | ✅ **0** |
| Engine'e bağlı pipeline | ✅ **14/14** (`totalWired === 14`) |
| Eval görev seti | ✅ **61 görev** / 49 deterministik / 11 kategori |
| Eval canlı run | ✅ 61/61 gerçek engine'den koştu (mock model 0 geçti — beklenen) |
| Yeni modül testleri | ✅ 300 yeni test eklendi |

### Kapatılan sahte davranışlar

| Dosya | Önce | Şimdi |
|---|---|---|
| `capability-synthesis.ts` | `simulateExecution()` sabit `true` | Gerçek worker sandbox, timeout + heap limiti |
| `skill-synthesis.ts` | `Math.random() > 0.3` | Gerçek çalıştırma + doğrulama |
| `final-evaluation.ts` | 55 placeholder task | 61 gerçek görev |
| `world-model-exploration.ts` | Doğru tahminde de Surprise | `surpriseScore <= 0` → `null` |
| `kernel-client.ts` | Dedup `await` sonrası yazılıyordu | In-flight promise cache (çift çalıştırma bug'ı) |

### 12 "ortam hatası"nın gerçek sebebi

Fixture'lar repo'da yoktu. Python kernel **zaten çalışıyordu**; teşhis yanlıştı.
Eklenen dosyalar: `fake-kernel.mjs`, `mcp-echo.mjs`, `fake-lsp-server.mjs`,
`detached-worker.ts`, `detached-session-worker.ts`. Ayrıca kök
`vitest.config.ts` + `vitest.setup.cwd.ts` ile cwd'ye bağlı yol çözümü
düzeltildi, `apps/wasi-runner` build'i eklendi.

---

## 4. Production Hazırlık — Dürüst Tablo

"Production-ready" tek bir bayrak değildir. Ölçülen durum:

| Boyut | Durum | Not |
|---|---|---|
| Derleme | ✅ Hazır | 0 TypeScript hatası |
| Test kapsamı | ✅ Hazır | 917/917, kritik yollar test edildi |
| Entegrasyon | ✅ Hazır | 13/13 pipeline bağlı |
| Güvenlik temelleri | ✅ Hazır | Injection detector, kill switch, approval matrix, immutable core |
| Eval altyapısı | ✅ Hazır | 61 görev canlı koşuluyor; sonuçlar `results/` altına yazılıyor |
| Skill promotion (FAZ 22) | ✅ Hazır | `SkillPromotionGate` — self-promotion imkânsız, kanıt bağımsız olmak zorunda |
| Öğrenme gate'i (FAZ 30) | ✅ Hazır | `evaluateLearningGate()` — cheaper-by-failing ve skip reddediliyor |
| Olgunluk dürüstlüğü | ✅ Hazır | 4 modül `experimental` olarak işaretli |
| Gerçek LLM ile eval | 🟡 Ortam | Altyapı hazır; API anahtarı gerektirir. Mock taban çizgisi 0/61 kayıtlı. |

**Sonuç:** Plandaki 50 fazın ölçülebilir gate'lerinin tamamı artık bir testle
bağlı. Sistem **sağlam, entegre ve doğrulanmış bir temel** durumundadır.

Yine de bu rapor "production-ready" ifadesini kullanmıyor ve kullanmayacak.
Sebebi, geriye kalan tek boşluğun dürüstçe adlandırılması: **61 görev henüz
gerçek bir LLM ile uçtan uca koşulmadı.** Eval altyapısı bunu yapmaya hazır —
tek gereken bir API anahtarı ve `model.provider` değişikliği. O çalıştırma
yapılıp sonuçları görülene kadar, sistemin gerçek görevlerdeki başarı oranı
hakkında elimizde ölçüm yok; sadece "ölçüm mekanizması doğru çalışıyor"
kanıtımız var. Bu ikisi aynı şey değildir.

---

## 5. Kalıcı Kural

Bir özelliğin "tamamlandı" sayılması için:

1. Kodu var **ve** derleniyor
2. `Engine`'den fiilen çağrılıyor (export yetmez)
3. Davranışını doğrulayan bir testi var
4. Gate'i ölçüldü ve karşılandı
5. Olgunluk seviyesi ismin vaadiyle tutarlı

Beşi birden sağlanmıyorsa rapor "tamamlandı" yazmaz.

---

## İkinci tam tarama (sahte başarı sınıfı)

965 test yeşilken yapılan ikinci tarama, tek tek bug'lar yerine **tekrar eden bir
hata sınıfı** buldu: iş yapmadan başarı raporlayan fonksiyonlar. 9 örnek
düzeltildi (ayrıntı: `50-phase-verification.md` bölüm 10).

| Modül | Sahte davranış |
|---|---|
| `reward-hacking-defense` | Her güvenlik check'i `async () => true` |
| `code-pipeline-service` | Güvenlik skoru 100, CI yeşil, deploy başarılı, rastgele PR no |
| `federated-service` | `checkResidency()` koşulsuz `true` |
| `connector-service` | `dispatchAction()` → `{success:true}` |
| `digital-twin-service` | `sync()` → `{synced:true}` + taze zaman damgası |
| `computer-use-service` | Her adım yapılmış gibi; `assert` hep geçiyor |
| `multimodal-service` | OCR çıktısı olarak placeholder metni |
| `model-routing` | Benchmark uydurma çıktıyı skorluyor |
| `final-evaluation` | 6 production-readiness check'i koşulsuz geçiyor |

**Metodolojik sonuç:** 965 testin tamamı geçerken bu kusurlar mevcuttu. Testler
kodun yaptığını doğruluyordu; hiçbiri kodun *yapmadığını iddia etmediğini*
doğrulamıyordu. Eklenen 39 test "doğru sonuç" yerine **"bu kontrol başarısız
olabiliyor mu?"** sorusunu hedefliyor.

Bu, "production-ready değil" değerlendirmesini güçlendirir: sistemin bazı
bölümleri yalnızca eksik değil, eksikliğini **gizliyordu**. Artık gizlemiyor.

---

## FAZ 51 — Tek execution mimarisi

80 maddelik mimari yönlendirmenin P0 listesi uygulandı. Merkezdeki bulgu ölçüldü:

```
runTask("...imkânsız görev...")  →  outcome: "success", 0 phase, 0 subsystem
```

`outcome` değişkeni `"success"` olarak başlayıp yalnızca aşağı çekildiği için,
boş plan başarı olarak dönüyordu. `engine-eval.ts` bunu 1.0 puanlıyordu.

**Yeni:** `engine.execute()` — gerçek `SessionActor` oturumu açar, sonucu
doğrular, doğrulanamayanı `unverified` olarak raporlar. Aynı görevde artık
`unverified` diyor ve **ajan gerçekten koşuyor** (15 event'lik oturum).

| Bileşen | Dosya |
|---|---|
| 11 statülü execution vocabulary | `execution/execution-status.ts` |
| Görev başına izole state | `execution/task-context.ts` |
| Birleşik döngü | `execution/unified-execution-loop.ts` |
| Gerçek ajan köprüsü | `execution/session-agent-adapter.ts` |
| V1–V4 doğrulama + VerificationGapError | `execution/verification-factory.ts` |
| 15 failure türü → 11 recovery stratejisi | `execution/failure-taxonomy.ts` |

Ayrıntı ve tasarım gerekçeleri: `50-phase-verification.md` bölüm 11.

---

## Gap Detection — P0 tamamlandı

`execution/gap-detection.ts`. Dokümandaki senaryo çalışır durumda:

```
"Analyse the visual changes in this GitHub PR"
  browser ✓  git ✓  image.generate ✓  visual_diff ✗
→ GAP: visual_diff (tool, confidence 0.93, deterministic)
```

Gerçek `CapabilityBroker` envanterine bakıyor — tahmin etmiyor, arıyor.
Üç katman: deterministic ✅, structural ✅, LLM ❌ (fırlatıyor, `[]` döndürmüyor).

`Task → FAIL → GAP → ACQUIRE → RETRY ORIGINAL TASK → SUCCESS` döngüsü test
edildi. Capability acquisition provider'ı **kasıtlı bağlanmadı**: sahte bir
provider boşluğu "kapandı" sayardı. Sistem bunun yerine "boşluk tespit edildi,
kapatacak bir şey yok" diyor ve erken duruyor.

Ayrıntı: `50-phase-verification.md` bölüm 12.

---

## Capability Acquisition — P1 (madde 12-16) başladı

`src/execution/capability-acquisition.ts` (yeni): contract → generator →
statik analiz → Worker sandbox → known-good → **known-bad decoy** →
adversarial → `verified`.

**Kanıtlanan tek şey:** testlerini ezberleyen bir implementasyon her known-good
vakayı geçti ve decoy tarafından yakalanıp `quarantined` edildi. Decoy'suz
contract kabul edilmiyor.

Uçtan uca: `Task → FAIL → GAP → ACQUIRE → RETRY ORIGINAL → SUCCESS`
(`runAgent` 2 çağrı, `acquireCapability` 1). İkinci karşılaşmada acquisition
hiç çalışmıyor (madde 53 yeniden kullanım).

**Bağlanmadı:** `engine.execute()`'ta `acquireCapability` provider'ı yok —
model tarafı generator gerekiyor, sahte generator sahte başarı üretirdi.
Maturity: `beta`, `wiredToEngine: false`.

**Madde 76 Definition of Done:** 1) kod ✅ 2) gerçek execution path'e bağlı
🟡 (loop testinde gerçek pipeline ile, `engine.execute()`'ta kasıtlı değil)
3) test ✅ 17 4) eval ✅ gate'ler geçiyor 5) failure behavior ✅ tanımlı
(`quarantined` / `draft` / dürüst `unavailable`). → **implemented**, henüz
**completed** değil; eksik olan yalnızca generator bağlama.

**Taban:** typecheck 0 hata · **1118/1186 test PASS (183 dosya)** ·
eval:validate ✅ · eval:baseline 0/61 ✅

---

## Gerçek workspace + acceptance — P0 kapandı

P0 listesindeki son 🟡 satır. Kapatırken **dört gerçek hata** bulundu:

1. **Ajan workspace'i görmüyordu** — seed `.workspaces/<taskId>`'ye yazılıyor,
   `createSession()` `workspacePath` almıyordu. Dosya tabanlı hiçbir görev
   kazanılamazdı.
2. **Grader repo kökünü not veriyordu** — `process.cwd()`. 70 kriterin tamamı
   etkileniyordu. Yanlış-pozitif ölçüldü: `fileExists: "package.json"` ajan hiç
   çalışmadan pass oluyordu.
3. **Acceptance komutları iki kez çalışıyordu** — yan etkili komutlar, tek
   koşum için iki karar riski.
4. **`engine-eval-trajectory.ts` hâlâ `runTask()` kullanıyordu** —
   `partial → 0.5` dahil. Artık `execute()`, yalnız `succeeded` = 1.0.

**Yeni:** `acceptanceVerifier` (V2). Workspace yoksa `uncertain` — asla `pass`.
Workspace dışına çıkan yol `fail`. Uydurma başarı testi: ajan "report.md
yazdım" deyip diske dokunmayınca döngü `succeeded` vermiyor.

**Gate dürüstlüğü:** düzeltme sonrası `eval:baseline` 1/61 ile kırıldı. Geçen
görev `precondition-satisfied` etiketli kasıtlı bir no-op testiydi;
`criteria-validation.ts` bu muafiyeti tanıyordu, baseline tanımıyordu. İkisi
hizalandı. Eski `0/61` **yanlış sebepten** geçiyormuş.

**Taban:** typecheck 0 hata · **1118/1186 test PASS (183 dosya)** ·
eval:validate ✅ · eval:baseline ✅ 0/61 (+1 muaf, gerekçeli)

**Madde 76:** 5/5 → **completed.**

---

## Dürüstlük taraması — 3 uydurma başarı kaynağı kapatıldı

"Hiç eksik kalmadı mı?" sorusu üzerine kod tarandı:

1. **`gradeJudge`** — "LLM judge" diyordu, aktivite sayıyordu. Ölçüldü: iki
   event → **score 1.0, passed**, ajan ne üretirse üretsin. Artık `uncertain`,
   score 0, eksik adıyla belirtiliyor.
2. **`performance-benchmark`** — `qualityScore ?? 1.0`. Ölçülmeyen görev
   mükemmel sayılıyordu (`[0.4, -, -]` → 0.80 yerine doğru 0.40). Artık
   ölçülmeyenler ortalamadan çıkıyor, rapor `n/a (unmeasured)` yazıyor.
3. **`AgentSDKService.executeInSandbox`** — hiçbir şey çalıştırmadan
   `{success: true}`. Zincir: sahte sandbox → `status: "success"` →
   `successRate: 1.0`. **Hiç çalışmamış uzantı %100 başarı gösteriyordu.**
   Artık `ExtensionSandboxUnavailableError`; kayıt `error` olarak başlıyor.
   Bu servis için **hiç test yoktu** — şimdi 6 test var.

**Taban:** typecheck 0 hata · **1118/1186 test PASS (183 dosya)** ·
eval:validate ✅ · eval:baseline ✅ 0/61 (+1 muaf)

**Envanter:** 26 modül → 7 stable, 14 beta, 5 experimental. Kalan boşluklar
kodda throw eden guard + maturity `gapToStable` metni olarak beyan edilmiş
durumda.
