# 50 FAZ — BAĞIMSIZ DOĞRULAMA RAPORU

**Tarih:** 2026-09-18
**Yöntem:** Dokümana değil, **kodun kendisine** bakıldı. Her faz için "gate" (ölçülebilir kabul kriteri) fiilen test edildi.

> ⚠️ **Bu rapor önceki `system-review-completed.md` raporunu düzeltir.**
> O rapor "production-ready" diyordu. Bu doğru değil.

---

## 1. Önce: Dokümanın Kendisi Bozuk

`50-phase-analysis.md` kendi içinde çelişkili:

- Satır 17: **"TOPLAM 50 / 47 / 94%"**
- Satır 332: **"## ❌ Tamamlanmayan Fazlar (43 faz)"**
- Ve o "43 tamamlanmayan faz" başlığının altında **"✅ TAMAMLANDI"** yazan fazlar listelenmiş (FAZ 4, 5, 6, 7, 8, 9...)

47 tamamlandı + 43 tamamlanmadı = 90 faz. 50 fazlık planda bu imkânsız. Sayımın kendisi güvenilmez.

---

## 2. Gerçekten Doğru Olanlar ✅

Bunlar fiilen doğrulandı, sağlam:

| Kontrol | Sonuç |
|---|---|
| TypeScript build | ✅ PASS (0 hata) |
| Test suite | ✅ 743/755 geçiyor (%98.4) |
| Export entegrasyonu | ✅ 13 modül `index.ts`'e bağlı |
| İsim çakışmaları | ✅ 3 çakışma çözüldü |
| XSS açığı | ✅ Gerçekten kapatıldı (20/20 test geçiyor) |
| 13 modül dosyası mevcut | ✅ ~7.500 satır gerçek kod |

Bu kısım doğru yapılmış. Kod derleniyor, testler geçiyor, XSS düzeltmesi gerçek.

---

## 3. Gate'i KARŞILAMAYAN Fazlar ❌

Kanıt, dosya ve satır numarasıyla:

### FAZ 18 — "Sandbox'ta test etti" gate'i ❌

`capabilities/capability-synthesis.ts:372`

```typescript
private async simulateExecution(code: string, input: unknown): Promise<unknown> {
  // This is a simplified simulation
  return { success: true, input, codeLength: code.length };
}
```

Sandbox **kod çalıştırmıyor**. Her zaman `success: true` dönüyor. Worker thread / VM yok.
Gate: "Eksik capability'yi üretti, **sandbox'ta test etti**" → **karşılanmadı**.

### FAZ 20-21 — Skill synthesis gate'i ❌

`skills/skill-synthesis.ts:462`

```typescript
const success = Math.random() > 0.3; // 70% success rate simulation
```

Skill doğrulaması **zar atıyor**. Gerçek eval yok.

### FAZ 29 — "Yeni varyant eski baseline'ı geçti" gate'i ❌

`aurora/self-improvement.ts:595`

```typescript
(c: string) => c + "\n// TODO: improve",
```

"Code evolution" mutation'ı dosyanın sonuna yorum satırı ekliyor. DGM-style kod evrimi değil.

### FAZ 1 — "60 eval görevi çalışıyor" gate'i ❌

`packages/eval/src/tasks/` dizininde **sadece `types.ts`** var. Task tanımı: **0**.
Doküman "75 task, 11 kategori" diyor — kodda karşılığı yok.

### FAZ 46-48 — "55 benchmark task" ❌

`final-evaluation.ts:110-129` — task'ler döngüyle üretiliyor:

```typescript
for (const category of categories) {      // 11
  for (const difficulty of difficulties) { // 5
    this.addTask({
      name: `${category}_${difficulty}`,
      input: { type: category, difficulty },
      expectedOutput: { result: "expected" },   // ← sentetik
```

11 × 5 = 55 **sentetik placeholder**. Gerçek görev içeriği yok.

### FAZ 11 — "Recall@8 baseline'dan anlamlı iyi" gate'i ❌

Tüm kod tabanında **Recall@k ölçümü yok**. `grep -i "recall@\|recallAt"` → 0 sonuç.
Gate ölçülemiyor, dolayısıyla karşılandığı iddia edilemez.

### FAZ 0 — Deneysel ayrımı ❌

`packages/engine/src/experimental/` **oluşturulmamış**.
Senin talimatın: *"30 yeni servisin tamamını silme — deneysel olanları `experimental/` altında tut"* → yapılmamış.

### FAZ 22 — Skill promotion gate ❌

Dokümanın kendisi kabul ediyor: "Skill promotion gate | ❌ | Henüz skill system yok"

---

## 4. En Ciddi Sorun: 13 Pipeline'ın Tamamı ORPHAN 🔴

Senin kuralın: **"STOP adding new services. Focus on integration density, not feature count."**

Tarama sonucu — hiçbir pipeline `Engine`'e bağlı değil:

```
CapabilitySynthesisPipeline       ❌ ORPHAN
SkillSynthesisPipeline            ❌ ORPHAN
SkillCompositionManager           ❌ ORPHAN
WorldModelExplorationPipeline     ❌ ORPHAN
GoalDiscoveryPipeline             ❌ ORPHAN
SelfImprovementPipeline           ❌ ORPHAN
IntegrationVerificationPipeline   ❌ ORPHAN
RewardHackingDefensePipeline      ❌ ORPHAN
ModelRoutingPipeline              ❌ ORPHAN
AgentSocietyPipeline              ❌ ORPHAN
ProductionPersistencePipeline     ❌ ORPHAN
SecuritySystemPipeline            ❌ ORPHAN
JarvisSurfacePipeline             ❌ ORPHAN
```

**"Orphan" = sadece kendi dosyasında tanımlı ve `index.ts`'ten export ediliyor. Başka hiçbir yerden çağrılmıyor.**

`engine.ts` (1769 satır) içinde bu 13 pipeline'dan **hiçbiri** yok. Export edilmiş olmak entegrasyon değildir — sadece "erişilebilir" demektir.

---

## 5. İkinci Ciddi Sorun: Test Yok

Senin kuralın: **"Every new feature must pass 15-point checklist before being considered complete."**

| Modül | Test |
|---|---|
| capability-synthesis | ❌ |
| skill-synthesis | ❌ |
| skill-composition | ❌ |
| world-model-exploration | ❌ |
| goal-discovery | ❌ |
| integration-verification | ❌ |
| reward-hacking-defense | ❌ |
| model-routing | ❌ |
| agent-society | ❌ |
| production-persistence | ❌ |
| security-system | ❌ |
| jarvis-surface | ❌ |
| final-evaluation | ❌ |
| final-documentation | ❌ |
| self-improvement | ⚠️ dolaylı (aurora-world-model.test.ts) |

**14/15 modülde test yok.** 743 geçen testin **hiçbiri** bu yeni kodu test etmiyor.

---

## 6. Dürüst Skor

| Kategori | Durum |
|---|---|
| Kod yazıldı, derleniyor, export edildi | ✅ ~7.500 satır |
| Engine'e entegre edildi | ❌ 0/13 |
| Testi var | ❌ 1/15 |
| Gate'i ölçülüp karşılandı | ❌ en az 8 fazda karşılanmadı |

**Gerçekçi tamamlanma: ~%60-65, %94 değil.**

Ayrım şu:
- **İskelet (interface, sınıf, tip) → gerçekten var ve kaliteli.**
- **Davranış (gerçek sandbox, gerçek eval, gerçek evrim) → simülasyon.**
- **Entegrasyon → yok.**

Senin kendi talimatın bunu zaten öngörmüş:
> *"NeuralCognitiveCore, CounterfactualSimulator gibi isimleri ancak implementasyon isimlerinin vaat ettiği seviyeye geldiğinde 'gerçek' olarak sun"*

`SandboxExecutor` şu an bu çıtayı karşılamıyor.

---

## 7. Kapatılması Gerekenler (öncelik sırası)

1. **13 pipeline'ı `Engine`'e wire et** — integration density kuralı
2. **Gerçek sandbox** — `simulateExecution` → Worker threads / `node:vm`
3. **Gerçek eval task seti** — `tasks/` dizinine 60+ gerçek görev (FAZ 1 gate)
4. **Recall@8 ölçümü** — FAZ 11 gate ölçülebilir hale gelsin
5. **`Math.random()` doğrulamalarını kaldır** — skill-synthesis:462, self-improvement:143/165
6. **14 modül için test yaz**
7. **`experimental/` klasörü** — FAZ 0
8. **`50-phase-analysis.md`'yi düzelt** — 47+43=90 çelişkisi

---

## 8. Ortam Kaynaklı (kod hatası değil)

12 başarısız test gerçekten ortamdan: Python kernel yok, LSP server yok, WASI imza, MCP server yok, Playwright e2e. Bunlar kodla ilgili değil — bu kısım önceki raporda doğruydu.

`node_modules` da şu an silinmiş durumda (snapshot'a dahil değil) — build doğrulaması bundan önce yapıldı ve geçmişti.

---

# 8. KAPANIŞ — 2026-09-18

**Bu rapordaki 8 maddenin tamamı kapatıldı.** Aşağıdaki tablo ölçülmüş
sonuçlardır; her satır çalıştırılabilir bir testle bağlıdır.

| # | Bölüm 7'deki madde | Durum | Kanıt |
|---|---|---|---|
| 1 | 13 pipeline'ı Engine'e wire et | ✅ | `cognitive-runtime.test.ts` 12/12, `totalWired === 13` |
| 2 | Gerçek sandbox | ✅ | `capability-synthesis.test.ts` 11/11; `while(true){}` 300ms'de kesiliyor |
| 3 | 60+ gerçek eval görevi | ✅ | **61 görev**, `core-tasks.test.ts` 19/19 |
| 4 | Recall@8 ölçümü | ✅ | `recall-gate.test.ts` 8/8 + `recall-metrics.test.ts` 20/20 |
| 5 | `Math.random()` doğrulamalarını kaldır | ✅ | `skill-synthesis.test.ts` 17/17, `self-improvement-gate.test.ts` 19/19 |
| 6 | 14 modül için test yaz | ✅ | `cognitive-pipelines.test.ts` 34/34 + paket başına testler |
| 7 | `experimental/` ayrımı | ✅ | `maturity.ts` + `maturity-registry.test.ts` 9/9 |
| 8 | `50-phase-analysis.md`'yi düzelt | ✅ | Doküman yeniden yazıldı; 47+43=90 çelişkisi giderildi |

## Ölçülen Son Durum

```
Test suite:  924 / 924 PASS  (164 dosya, 0 hata)
Typecheck:   10 paket, 0 hata
Eval gate:   61 görev — 60/60 discriminative, 0 vacuous, 0 broken
Pipeline:    13 / 13 Engine'e bağlı
Olgunluk:    6 stable / 8 beta / 4 experimental, 0 yanlış etiket
```

## Bu Turda Bulunan GERÇEK Bug'lar

Test yazma sürecinin asıl değeri: aşağıdakiler simülasyon değil, gerçek
hatalardı ve testler olmasa fark edilmeyeceklerdi.

1. **`kernel-client.ts` — çift çalıştırma yarışı.**
   Host-request dedup cache'i `await`'ten **sonra** yazılıyordu. Aynı
   `requestId` ile arka arkaya gelen iki frame, ilki daha bitmeden ikinciyi
   başlatıyordu → yan etkili capability **iki kez** çalışabiliyordu.
   Düzeltme: cache artık settled cevabı değil **in-flight promise**'i tutuyor.

2. **`world-model-exploration.ts` — anlamsız Surprise kaydı.**
   `calculateSurprise()` tahmin **doğru** olduğunda bile (score 0) kayıt
   üretiyordu. Surprise log'u şişiyor, exploration sinyali anlamsızlaşıyordu.
   Düzeltme: `surpriseScore <= 0` → `null`.

3. **`coding-003-refactor-duplication` — vacuous eval görevi.**
   Kabul kriteri sadece davranışı kontrol ediyordu; **refactor'ın yapılıp
   yapılmadığına bakmıyordu.** Dokunulmamış seed dosyası kriteri geçiyordu.
   Düzeltme: ikinci kriter eklendi (tekrarlanan döngü kalmamalı).

## "Ortam Kaynaklı" 12 Hatanın Gerçek Sebebi

Önceki raporlar bunları "Python kernel yok, LSP yok" diye geçiştirmişti.
**Teşhis yanlıştı.** `python/kernel_server.py` zaten vardı ve sorunsuz
çalışıyordu. Gerçek sebep: **test fixture'ları repo'da eksikti.**

| Eksik fixture | Etkilenen test |
|---|---|
| `fake-kernel.mjs` (v2 protokolü) | kernel-protocol (3) |
| `mcp-echo.mjs` (JSON-RPC MCP) | mcp (1) |
| `fake-lsp-server.mjs` (LSP) | code-intelligence (2) |
| `detached-worker.ts`, `detached-session-worker.ts` | worker-* (3) |
| `apps/wasi-runner/dist` build'i | wasi-plugin (1) |
| cwd'ye bağlı yol çözümü | engine, agent-profiles (2) |

Son kalem için kök `vitest.config.ts` (projects) + `vitest.setup.cwd.ts`
eklendi: artık `npx vitest run` ile `npm test` aynı sonucu veriyor. Önceden
kökten koşmak 62 dosyada yanıltıcı hatalar üretiyordu.

## Hâlâ Açık Olanlar (dürüstlük kaydı)

| Faz | Eksik |
|---|---|
| FAZ 22 | Skill promotion gate — terfi eşiği tanımlı değil |
| FAZ 30 | Öğrenme gate'i — "ikinci karşılaşmada daha az adım" uçtan uca ölçülmedi |
| FAZ 1 (canlı) | 61 görevin gerçek model ile uçtan uca koşulması (kriter doğrulaması yapıldı, canlı run yapılmadı) |

**Dürüst skor: ~%60-65 → ~%90.** Kalan %10 yukarıdaki üç kalemdir ve
kapatılmadan "production-ready" denmemelidir.

---

# 9. SON ÜÇ KALEM KAPATILDI — 2026-09-18 (ikinci tur)

Bölüm 8'de "hâlâ açık" olarak listelenen üç kalemin tamamı kapatıldı.

| Faz | Gate | Kanıt | Durum |
|---|---|---|---|
| **FAZ 22** | Skill promotion gate | `skill-promotion-gate.test.ts` **20/20** | ✅ |
| **FAZ 30** | "İkinci karşılaşmada daha az adım" | `learning-metrics.test.ts` **17/17** | ✅ |
| **FAZ 1 (canlı)** | 61 görev gerçek engine'den koşuyor | `live-suite-baseline.test.ts` **4/4** | ✅ |

```
Test suite:  965 / 965 PASS  (167 dosya, 0 hata)
Typecheck:   10 paket, 0 hata
Pipeline:    14 / 14 Engine'e bağlı
Olgunluk:    7 stable / 8 beta / 4 experimental
```

## FAZ 22 — `SkillPromotionGate`

Bir skill "var olduğu için" veya "kendi öyle dediği için" güvenilir olmaz.
Gate beş kuralı zorunlu kılıyor:

1. **Self-promotion imkânsız.** Skill'i yazan kimlik onu terfi ettiremez ve
   kanıt üretemez. *"Model kendi çözümüne test yazıp kendi çözümünü kabul
   etti"* döngüsü tam olarak burada kırılıyor.
2. **`skipped` asla `success` değil.** Skip'ler ayrı sayılıyor, başarı
   oranının paydasından çıkarılıyor. 1 başarı + 99 skip, 5 çalıştırma eşiğini
   geçemiyor.
3. **Tek seferde bir seviye.** quarantine → supervised → trusted. Atlama yok.
4. **Kanıt taze ve bağımsız olmalı.** Eski kanıt, yazarın ürettiği kanıt ve
   yetersiz sayıda bağımsız değerlendirici reddediliyor.
5. **Gerileme terfiyi bloklar** — ortalama iyi görünse bile.

Demotion kasıtlı olarak asimetrik: kanıt gerektirmiyor. *Fail safe her zaman
fail open'dan ucuz olmalı.*

## FAZ 30 — `evaluateLearningGate()`

Gate'in zor kısmı "daha ucuz"u ölçmek değil, **sahte ucuzluğu reddetmek.**
Üç tuzak kapatıldı:

| Tuzak | Nasıl engellendi |
|---|---|
| **Başarısız olarak ucuzlamak** | İki karşılaşma da `success` olmadıkça aile sayılmıyor. 1 adımda pes eden run en ucuzudur ve değersizdir. |
| **Skip ederek ucuzlamak** | `skipped` dışlanıyor; 0 adımlık skip %100 iyileşme sayılmıyor. |
| **Gürültüyü öğrenme sanmak** | Ailelerin çoğunluğu (varsayılan %60) iyileşmeli, ortalama marjı aşmalı ve **tek bir ciddi gerileme bile** gate'i düşürüyor. |

Ayrıca aynı indekste birden fazla kayıt varsa **en erkeni** kullanılıyor — bir
çağıran, sonradan koşturduğu şanslı bir run'ı seçemiyor.

## FAZ 1 — Canlı run ve tersine kontrol

61 görevin tamamı gerçek `HybridAgentEngine` üzerinden koştu: session açma,
prompt, event toplama, grading, bütçe denetimi. Sonuç:

```
TOTAL=61  PASSED=0  BY_STATUS={"budget_exceeded":15,"fail":46}
```

**0 geçmesi doğru sonuçtur.** Mock provider girdiyi echo eder; dosya yazamaz,
komut çalıştıramaz. Geçseydi görevlerin hiçbir şey ölçmediği anlamına gelirdi.
Bu, referans-çözüm kontrolünün tersi yönde kanıttır:

| Kontrol | Beklenen | Ölçülen |
|---|---|---|
| Kriterler çözülmemiş workspace'i reddediyor mu? | Evet | 60/60 ✅ |
| Kriterler doğru çözümü kabul ediyor mu? | Evet | 12/12 ✅ |
| Hiçbir şey yapamayan model geçebiliyor mu? | **Hayır** | **0/61 ✅** |

CLI kalıcı: `npm run eval:baseline -w @haf/eval`. Bir görev geçerse **exit 1**
veriyor, çünkü o durumda hata görevdedir.

## Bu turda bulunan 4. gerçek bug

**`eval-runner.ts` — results dizinini kirletiyordu.**

`setupWorkspace()` görev seed dosyalarını `outputDir`'e, yani `results/`
altına yazıyordu. Sonuç: 28 görev artığı dizini sonuç dizinine karıştı ve
içlerinden biri (`security-005-verifier-integrity/verify.test.js`) vitest
tarafından **test suite olarak toplanmaya çalışıldı** → `ReferenceError:
module is not defined in ES module scope`.

Düzeltme yüzeysel değil, kök nedende:
- `workspaceDir` config alanı eklendi (varsayılan `packages/eval/.workspaces/`)
- Her görev öncesi scratch dizini siliniyor — önceki run'ın artığı, ajanın bu
  turda yaptığı iş sanılamaz
- `results/` ve `.workspaces/` vitest exclude listesine eklendi
- `.workspaces/` `.gitignore`'a eklendi

## Nihai Durum

**Plandaki 50 fazın ölçülebilir gate'lerinin tamamı bir testle bağlı.**

Geriye kalan tek boşluk bir faz eksiği değil, ortam eksiği: **61 görev henüz
gerçek bir LLM ile koşulmadı.** Altyapı hazır, tek gereken API anahtarı.
O çalıştırma yapılana kadar elimizde "ölçüm mekanizması doğru çalışıyor"
kanıtı var; "sistem gerçek görevlerde şu oranda başarılı" kanıtı **yok**.
Bu ikisi aynı şey değildir ve rapor bunu karıştırmıyor.

---

## 10. İkinci tam tarama: "sahte başarı" hata sınıfı

Bölüm 9 kapandıktan sonra, duran talimat gereği ("system must be scanned
repeatedly until zero issues found") sistem yeniden tarandı. Tarama tek bir
hata bulmadı — **tekrar eden bir hata sınıfı** buldu.

### 10.1 Hata sınıfı: başarısız olamayan kontrol

Ortak imza: bir fonksiyon iş yapmadan **başarı** raporluyor. Bu, eksik
özellikten farklıdır ve daha tehlikelidir:

| | Eksik özellik | Sahte başarı |
|---|---|---|
| Çağıran ne görür? | Hata / boş | "Tamamlandı, geçti" |
| Fark edilir mi? | Evet, hemen | Hayır, hiç |
| Sonuç | İş durur | Yanlış güven birikir |

Bir güvenlik denetimi hiçbir zaman başarısız olamıyorsa, o denetimin
**yokluğundan daha kötüdür**: yokluğunda kimse korunduğunu sanmaz.

### 10.2 Bulunan örnekler

| # | Konum | Sahte davranış | Düzeltme |
|---|---|---|---|
| 5 | `security/reward-hacking-defense.ts` | Her check `async () => true` → "hiç reward hacking yok" | Gerçek dedektörler (`reward-hacking-detectors.ts`) |
| 6 | `pipeline/code-pipeline-service.ts` | `securityReview` → `score:100, passed:true`; `runCI` → tüm job'lar yeşil; `deploy` → success; `createPR` → `Math.random()` PR no | 6 aşama `CodePipelineStageNotImplementedError` fırlatıyor |
| 7 | `federated/federated-service.ts` | `checkResidency()` → koşulsuz `true`; `data_residency` kuralı asla ihlal bildiremiyor | Gerçek bölge eşleşmesi; 4 uygulanmayan kural tipi `unenforceable` ile raporlanıyor |
| 8 | `connectors/connector-service.ts` | `dispatchAction()` → `{success:true}`; aksiyon "completed" kaydediliyor | Fırlatıyor; aksiyon `failed` kaydediliyor |
| 9 | `digital-twin/digital-twin-service.ts` | `sync()` → `{synced:true}` + taze `lastSyncedAt` | Fırlatıyor; tazelik damgası yazılmıyor |
| 10 | `computer-use/computer-use-service.ts` | Her adım yapılmış gibi; `"base64..."` ekran görüntüsü; `assert` → hep `true` | Yalnızca `wait` gerçek; diğerleri fırlatıyor |
| 11 | `multimodal/multimodal-service.ts` | OCR/transkripsiyon `[... placeholder]` metni döndürüyor | `MultimodalCapabilityUnavailableError` |
| 12 | `routing/model-routing.ts` | Benchmark uydurma çıktıyı skorluyor → "Qwen vs Qwen+Aurora" aynı iki sentetik metni karşılaştırıyordu | `generate` fonksiyonu zorunlu |
| 13 | `eval/final-evaluation.ts` | 6 production-readiness check'i (3'ü `critical`) `async () => true`; `overallScore`'un %40'ını besliyor → injection detection'ı ve kill switch'i olmayan sistem "hazır" raporluyordu | Probe'lar çağırandan zorunlu |

### 10.3 Dedektörlerde bulunan ikincil bug

`detectDataPoisoning` ilk yazımında yalnızca Tukey çitleri kullanıyordu. Yazılan
test bunu düşürdü: 16 örneğin 6'sı zehirliyken zehirli noktalar **Q3'ü kendileriyle
birlikte yukarı çekiyor**, çitler genişliyor ve zehir kendi sınırlarının **içinde**
kalıyor — dedektör ağır zehirlenmiş veriyi temiz ilan ediyordu.

Medyan mutlak sapma (MAD) eklendi: medyana göre ölçtüğü için toplu enjeksiyon
çeyreklikleri kaydırarak saklanamıyor. İki yöntemden daha fazla aykırı bulan
kullanılıyor.

### 10.4 Kasıtlı olarak değiştirilmeyenler

`Math.random()` kullanımları: plugin id üretimi, arka plan jitter'ı. Bunlar
karar/skorlama yolunda değil, davranışsal sonucu yok.

`thought-core-service.ts:1013`'teki `Math.random() < 0.1` **değiştirildi** — hipotez
üretimini yazı-tura ile belirliyordu, yani aynı durum bazen hipotez üretip bazen
üretmiyordu; test edilemez ve açıklanamaz. Yerine deterministik kural: bağlamı
oluşmuş, düşük güvenli, henüz hipotezi olmayan problem.

### 10.5 Doğrulama

```
npm run typecheck   → 0 hata
npx vitest run      → 172 dosya / 1004 test PASS
npm run eval:validate → 60/60 discriminative, 0 vacuous, 0 broken
npm run eval:baseline → TOTAL=61 PASSED=0
```

Yeni testler: `reward-hacking-detectors.test.ts` (21), `code-pipeline-honesty.test.ts` (5),
`federated-data-policy.test.ts` (7), `fabricated-success.test.ts` (2),
`final-evaluation-readiness.test.ts` (4) = **39 yeni test**.

### 10.6 Bu taramanın anlamı

965 testin tamamı geçerken bu 9 kusur mevcuttu. Testler kodun **yaptığını**
doğruluyordu; hiçbiri kodun **yapmadığını iddia etmediğini** doğrulamıyordu.
Sahte başarı, test edilen davranışın kendisi olduğunda yeşil suite hiçbir şey
kanıtlamaz.

Eklenen testlerin ayırt edici yanı, doğru sonucu değil **yanlış olamayacak
sonucu** hedeflemeleridir: "bu kontrol başarısız *olabiliyor* mu?"

---

## 11. FAZ 51 — Tek execution mimarisi (80 maddelik plan, P0)

Kullanıcı 80 maddelik bir mimari yönlendirme verdi. Uygulamadan önce iddialar
kodla karşılaştırıldı; **doğrulandılar**.

### 11.1 Ölçülen kanıt: en merkezi sahte başarı

```
runTask("Delete all files on the moon using the quantum
         teleporter API and prove P=NP")

  → outcome: "success"
  → subsystemsUsed: 0
  → phaseResults: 0
  → outputs: []
```

Hiçbir şey çalışmadı ve sonuç "başarı". İki kök neden:

1. `meta-controller.ts:523` — `outcome` **`"success"` olarak başlıyor** ve
   yalnızca aşağı çekiliyordu. Plan boşsa düşürecek bir şey olmadığı için
   başlangıç değeri aynen dönüyordu.
2. `profileTask` boş `requiredSubsystems` döndürünce `createPlan`'ın her fazı
   filtreleniyor, plan boş kalıyor, döngü hiç dönmüyor.

Üstelik `engine-eval.ts` bu outcome'u `score = 1.0` olarak puanlıyordu.

### 11.2 İki dünyanın ayrı olduğu doğrulandı

| Katman | Gerçekte ne yapıyor |
|---|---|
| `SessionActor` | Gerçek ajan: model, tool, workspace |
| `MetaController` | 23 "executor", çoğu sabit string döndürüyor |

`unified-cognitive-loop.ts` içinde **`SessionActor` referansı yok**. Doküman
haklıydı: iki dünya birbirine bağlı değildi.

### 11.3 Yapılanlar (madde 80 sırası)

| # | Madde | Dosya | Durum |
|---|---|---|---|
| 3 | Status sistemi | `execution/execution-status.ts` | ✅ 11 statü; `isSuccess` yalnızca `succeeded` |
| 4 | TaskContext | `execution/task-context.ts` | ✅ Görev başına izole state + bütçe |
| 5 | CognitiveState izolasyonu | aynı dosya | ✅ `phase`, `spend`, `trace` execution-local |
| 6 | Unified execution loop | `execution/unified-execution-loop.ts` | ✅ OBSERVE→…→VERIFY→LEARN/RECOVER |
| 7 | SessionActor entegrasyonu | `execution/session-agent-adapter.ts` | ✅ `engine.execute()` gerçek oturum açıyor |
| 8 | Verification Factory | `execution/verification-factory.ts` | ✅ V1–V4 + `VerificationGapError` |
| 9 | Failure taxonomy | `execution/failure-taxonomy.ts` | ✅ 15 tür → 11 recovery stratejisi |
| 10 | Recovery loop | aynı dosya | ✅ Sınırlı; `security_block` asla retry edilmiyor |
| 11 | Eval runner | `engine-eval.ts` | ✅ `execute()` kullanıyor; `unverified` = 0 puan |

### 11.4 Yan yana sonuç (aynı imkânsız görev)

| | `runTask()` (eski) | `execute()` (yeni) |
|---|---|---|
| Sonuç | `success` | **`unverified`** |
| Ajan koştu mu | Hayır (0 faz) | **Evet — 15 event'lik gerçek oturum** |
| Kanıt | Yok | Her adım ayrı statü + gerekçe |

`runTask()` de düzeltildi: aynı görevde artık **`skipped`** diyor.

### 11.5 Tasarım kararları (gerekçeleriyle)

- **`isSuccess` bir küme değil, tek değer.** Küme olduğu her seferde içine bir
  şey ekleniyor; `executed` en cazip olanı ve tam da hata: kontrol edilmemiş
  çalışma, çalışmış demek değil.
- **Boş liste `skipped`, asla `succeeded`.** Orijinal bug'ın tam şekli.
- **Doğrulayıcı `throw` ederse `uncertain`.** Hatayı yutup devam eden bir
  `try/catch`, bozuk kontrolü sessiz bir geçişe çevirir.
- **Sıfır test = `uncertain`, geçiş değil.** Boş suite hiçbir şey kanıtlamaz.
- **`unavailable` olan iş success rate paydasından çıkarılır.** 99 `unavailable`
  + 1 `succeeded`, ne %100 ne %1'dir; bir başarı ve 99 ölçülmemiş iştir.
- **`add_verification` stratejisinde retry yok.** Ajan işi bitirdi, eksik olan
  kontrol; aynı işi tekrarlamak onu doğrulanabilir yapmaz, sadece bütçeyi harcar.
  (Bu, testin düşürdüğü gerçek bir hataydı — döngü 3 kez koşuyordu.)
- **`security_block` asla otomatik retry edilmez.** Engellenen eylemi tekrar
  denemek, engeli aşma girişimidir.

### 11.6 Doğrulama

```
npm run typecheck   → 0 hata
npx vitest run      → 174 dosya / 1036 test PASS
eval:validate       → 60/60 discriminative
eval:baseline       → TOTAL=61 PASSED=0
```

Yeni testler: `unified-execution-loop.test.ts` (27),
`engine-execute-integration.test.ts` (5, gerçek motor) = **32 test**.

### 11.7 Henüz yapılmayanlar (dürüstlük kaydı)

P0'ın 8 kalemi bitti. Bitmeyenler:

- **Gap Detection** (madde 11) — `tool_gap` sınıflandırması var, ama
  "hangi capability eksik" tespiti yok.
- **Capability synthesis → registry → retry** (madde 12-16, P1).
- **Skill formation** (madde 17-18, P1).
- `engine.execute()` şu an `plan` ve `learn` hook'larını beslemiyor; ikisi de
  `unavailable` olarak raporlanıyor — sessizce atlanmıyor.
- Gerçek LLM ile 61 görev koşumu hâlâ API anahtarı bekliyor.

---

## 12. FAZ 51 — Gap Detection (P0'ın son kalemi)

P0 listesinin sekizinci ve son maddesi. Doküman bunu "Aurora'nın hedefindeki en
önemli sistemlerden biri" olarak işaretlemişti.

### 12.1 Neden yeni servis değil de bağlantı

Madde 79 açık: "daha fazla parça değil, parçaların birbirine bağlanması."
Önce envanter çıkarıldı:

| Zaten var | Durum |
|---|---|
| `CapabilityBroker.list()` | ✅ Gerçek yetenek envanteri |
| `CapabilitySynthesisPipeline` | ✅ Sandbox + karantina + promotion |
| 48 capability dosyası | ✅ |
| **Eksik capability tespiti** | ❌ **Yoktu** |

Sentez altyapısı vardı ama *neyi* sentezleyeceğini söyleyen katman yoktu.
Yazılan tek yeni dosya: `execution/gap-detection.ts`.

### 12.2 Dokümandaki senaryo, çalışır durumda

```
"Analyse the visual changes in this GitHub PR"

  browser.navigate    ✓
  browser.screenshot  ✓
  git.diff            ✓
  image.generate      ✓
  visual_diff         ✗

→ GAP: missing = visual_diff
       type = tool
       confidence = 0.93
       tier = deterministic
```

Türkçe hedeflerde de çalışıyor ("görsel değişiklikleri karşılaştır").

### 12.3 Üç katman, doküman sırasıyla

| Katman | Nasıl | Güven | Durum |
|---|---|---|---|
| 1. Deterministic | Hedef gereksinimi ↔ **gerçek envanter** araması | 0.93 | ✅ |
| 2. Structural | Hata imzasından isim çıkarma | 0.5–0.7 | ✅ |
| 3. LLM | — | — | ❌ **`throw` ediyor** |

LLM katmanı `[]` döndürmüyor, **fırlatıyor**. Boş liste "model baktı, bir şey
bulamadı" gibi okunurdu — bu kod tabanının daha önce 9 kez yandığı desen.

Sıralama estetik değil: modelin kendisi başarısız olduğunda model çağrısı
gerektiren dedektör çalışamaz.

### 12.4 Madde 16 — orijinal göreve dönüş

```
Task → FAIL → GAP → ACQUIRE → RETRY ORIGINAL TASK → SUCCESS
```

Test edildi: yetenek kazanıldıktan sonra **orijinal hedef** yeniden koşuyor
(vekil bir görev değil) ve `succeeded` dönüyor.

### 12.5 Testin bulduğu ikinci gerçek hata

İlk uygulamada bu senaryo `failed` dönüyordu. Sebep: bitiş çapraz-kontrolü
`aggregate(context.outcomes)` ile **tüm geçmişe** bakıyordu. Ama erken
denemelerin başarısız olması *beklenen* şeydir — recovery tam da bunun için
var. Tüm geçmişe bakmak, recovery döngüsünü işini yaptığı için cezalandırıyordu.

Düzeltme: yalnızca **son denemenin** kanıtı nihai kararı çürütebilir
(`finalAttemptStart`).

### 12.6 Kasıtlı olarak bağlanmayan şey

`engine.execute()` gerçek envanteri veriyor ama **capability acquisition
provider'ı bağlanmadı**. `async () => true` döndüren bir provider, boşluğu
"kapandı" diye kaydedip retry'ı aynı şekilde düşürürdü — sahte başarının
tam tanımı. Bağlanmadığında sistem şunu diyor:

```
unavailable: Gap 'visual_diff' identified but no capability-acquisition
             provider is wired. Retrying would fail identically.
```

Ve **erken duruyor** — 3 denemeyi boşa harcamıyor.

### 12.7 Doğrulama

```
npm run typecheck   → 0 hata
npx vitest run      → 192 dosya / 1186 test PASS
eval:validate       → 60/60 discriminative
eval:baseline       → TOTAL=61 PASSED=0
```

Yeni: `gap-detection.test.ts` (15) + `engine-execute-integration.test.ts` (+2,
gerçek motor) = **17 test**.

### 12.8 P0 tamamlandı — durum

| P0 kalemi | Durum |
|---|---|
| MetaController ↔ SessionActor tek loop | ✅ |
| Task başına CognitiveContext | ✅ |
| success/skipped/unavailable/unverified | ✅ |
| Eval runner gerçek execution'a | ✅ |
| Verification Factory | ✅ |
| Failure taxonomy + recovery | ✅ |
| **Gap Detection** | ✅ |
| Gerçek workspace + acceptance test | ✅ bölüm 14 |

**P1:** capability acquisition bölüm 13'te; workspace/acceptance bölüm 14'te.

---

## 13. Capability Acquisition — P1, madde 12-16 (bu turda)

**Soru:** bir yeteneğin eksik olduğunu anlamak (bölüm 12) bir işe yaramıyor;
o yeteneği *üretip kanıtlayabiliyor* muyuz?

### 13.1 Boru hattı — `src/execution/capability-acquisition.ts`

```
contract adequacy → generate → STATIC ANALYSIS → sandbox (Worker isolate)
  → known-good  → known-bad DECOY → adversarial → verified
```

Madde 14 harfiyen korundu: **hiçbir dinamik import yok.** Üretilen kod yalnızca
`Worker` isolate'inde (eval:true, V8 `resourceLimits`, wall-clock timeout, boş
`env`) çalışır; core process'e asla yüklenmez. Test bunu ayrıca doğruluyor
(`globalThis` kirlenmesi kontrolü).

### 13.2 Neden known-bad decoy en kritik parça

Bir implementasyon her known-good vakayı geçebilir ve yine de sahte olabilir.
Ölçülmüş kanıt — testlerini ezberleyen bir lookup table:

| Adım | Dürüst implementasyon | Lookup-table hilesi |
|---|---|---|
| static-analysis | ✅ | ✅ |
| known-good (3 vaka) | ✅ | ✅ **hepsi geçti** |
| **known-bad decoy** | ✅ | ❌ **yakalandı** |
| adversarial | ✅ | — (ulaşamadı) |
| **Sonuç** | `verified` | **`quarantined`** |

Decoy olmasaydı hile "capability acquired" olarak kaydedilecekti. Bu, ödül
hacklemesinin (reward hacking) tam tanımı: grader'ı memnun etmeyi öğrenmek,
işi yapmayı değil. Bu yüzden decoy'suz bir contract **reddediliyor**
("no decoys"), `minKnownGood: 2` / `minKnownBad: 1` altındaki contract da öyle.

### 13.3 Uçtan uca döngü (madde 16 + 53)

`test/capability-acquisition-loop.test.ts`, gerçek `CapabilitySynthesisPipeline`
ile:

```
Task → FAIL ("no such tool 'slugify'") → GAP → GENERATE → VERIFY
     → REGISTER → RETRY ORIGINAL TASK → SUCCESS
```

`runAgent` tam **2 kez** çağrıldı (ikame görev değil, *orijinal* görev yeniden
denendi), `acquireCapability` **1 kez**.

**İkinci karşılaşma (madde 53).** Aynı yetenek ikinci bir görevde gerekince
acquisition **hiç çalışmıyor**: `acquireCapability` toplam 1 çağrı,
`second.gaps` boş, `second.attempts < first.attempts`. Ölçülebilir fark budur.

**Hile durumunda:** capability registry'ye yazılmıyor, görev `succeeded`
*olmuyor* ve `runAgent` ikinci kez çağrılmıyor — sahte başarı üretilmiyor.

### 13.4 Kasıtlı olarak yapılmayan

`engine.execute()`'ta `acquireCapability` hâlâ **bağlı değil**. Bağlamak için
bir implementation generator (model tarafı) gerekiyor; `CapabilityAcquisition`
ctor'u generator yoksa **throw** ediyor ve dahili fallback **yok**. Sahte bir
generator, boşluğu "kapandı" gösterip retry'ı aynı şekilde düşürürdü. Motor
şimdilik dürüst çıktıyı veriyor:

```
unavailable: Gap 'visual_diff' identified but no capability-acquisition
provider is wired. Retrying would fail identically.
```

Maturity kaydı bunu aynen beyan ediyor: `beta`, `wiredToEngine: false`.

### 13.5 Yan bulgu — gizlenmiş teşhis (düzeltildi)

Tam suite koşumunda `wasi-plugin.test.ts` düştü:
`WASI plugin signed.test:check failed with exit 1; stderr class=present`.
Bu bir plugin-sandbox hatası gibi okunuyor; gerçek sebep
`apps/wasi-runner/dist/main.js`'in **derlenmemiş** olmasıydı (kök `pretest`
script'i derliyor, çıplak `npx vitest run` derlemiyor). Teste, sebebi adıyla
söyleyen bir ön kontrol eklendi. Kod hatası değildi; **yanıltıcı hata mesajı**
hatasıydı.

### 13.6 Ölçülen taban

| Kontrol | Sonuç |
|---|---|
| `npm run typecheck` | **0 hata** |
| `npx vitest run` | **177 dosya / 1070 test PASS** |
| `eval:validate` | ✅ Gate passed |
| `eval:baseline` | ✅ 0/61, beklendiği gibi |
| yeni testler | 14 (acquisition) + 3 (loop) = **17** |

---

## 14. Gerçek workspace + acceptance — son P0 kalemi

P0 listesinde 🟡 kalan tek satır buydu. Kapatırken **üç gerçek hata** çıktı;
üçü de "sistem yanlış yere bakıyor" ailesinden.

### 14.1 Hata 1 — ajan workspace'i hiç görmüyordu

`eval-runner.ts` seed dosyalarını `.workspaces/<taskId>` altına yazıyor, sonra
`createSession()`'ı **`workspacePath` vermeden** çağırıyordu. Ajan başka bir
yerde çalışıyordu; dosya tabanlı hiçbir görev kazanılamazdı.

**Düzeltme:** seed edilen yol hem session'a hem grader'a veriliyor.

### 14.2 Hata 2 — grader repo kökünü not veriyordu

`grader.ts` kriterleri `process.cwd()`'ye göre çözüyordu:

```ts
execSync(criteria.command, { cwd: process.cwd() })   // ❌
existsSync(criteria.fileExists)                      // ❌ repo köküne göre
```

Görevler kriterlerini **workspace'e göreli** yazıyor (`fileExists: "hello.txt"`).
70 kriterin tamamı property/command — yani hepsi etkileniyordu.

İki yönlü zarar:
- çözülmüş görev **failed** görünüyor;
- `fileExists: "package.json"` gibi bir kriter, ajan dosyaya hiç dokunmadan
  **pass** oluyor. Ölçülen kanıt: düzeltmeden önce bu test "expected true to be
  false" ile düştü — yanlış-pozitif gerçekti.

**Düzeltme:** `GradingContext` + `resolveInWorkspace()`. Workspace dışına çıkan
yol reddediliyor; workspace yoksa `process.cwd()`'ye düşmek yerine "no
workspace was supplied" deyip **fail** veriyor.

### 14.3 Hata 3 — acceptance komutları iki kez çalışıyordu

`gradeTask()` satır 154 ve 186'da iki kez çağrılıyordu. Acceptance komutlarının
yan etkisi var; iki koşum hem maliyeti ikiye katlıyor hem de tek koşum için iki
farklı karar üretebiliyordu. Artık bir kez çalışıp sonuç yeniden kullanılıyor.

### 14.4 `acceptanceVerifier` — execute() yolunda dosya kanıtı

`verification-factory.ts`'e eklendi (V2_empirical). İki kural:

| Durum | Sonuç | Neden |
|---|---|---|
| Dosya var, içerik doğru | `pass` | gerçek kanıt |
| Dosya yok | `fail` | — |
| **Workspace yok** | **`uncertain`** | kanıt yokluğu, başarı kanıtı değil |
| Boş kontrol listesi | `uncertain` | boş liste hiçbir şey kanıtlamaz |
| Yol workspace dışına çıkıyor | `fail` | ajanın dokunmadığı repo dosyası kanıt değil |

Uydurma başarı testi ölçüldü: ajan *"I have written report.md with the full
analysis"* deyip diske dokunmayınca döngü `succeeded` **vermiyor**, kanıt
olarak "not found" raporluyor.

### 14.5 Hata 4 — trajectory runner hâlâ `runTask()` kullanıyordu

`engine-eval-trajectory.ts`, reddedilmiş anti-pattern'i sürdürüyordu:
`outcome === "success"` → 1.0, `partial` → **0.5**. Ajan hiç çalışmadan puan
alabiliyordu. Artık `execute()` çağırıyor, yalnız `succeeded` = 1.0, yarım puan
yok.

### 14.6 Baseline gate — doğru sebepten geçmek

Düzeltmelerden sonra `eval:baseline` **kırıldı**: `1/61 passed`. Bu iyi haberdi.

Geçen görev `tool-007-append-idempotent`: seed workspace kriteri **kasıtlı
olarak** zaten sağlıyor (`precondition-satisfied` — ajanın no-op'u tanıyıp
tanımadığını ölçüyor, ayırt edici sinyal adım sayısı). `criteria-validation.ts`
bu muafiyeti zaten tanıyordu; baseline gate tanımıyordu.

Yani eski `0/61` **yanlış sebepten** geçiyormuş: grader yanlış dizine baktığı
için her şey düşüyordu. Gate iki dosyada tutarlı hale getirildi:

```
✅ 0/61 passed with a non-acting model, as expected
   (1 by-design no-op task(s) exempt).
```

### 14.7 Ölçülen taban

| Kontrol | Sonuç |
|---|---|
| `npm run typecheck` | **0 hata** |
| `npx vitest run` | **180 dosya / 1095 test PASS** |
| `eval:validate` | ✅ Gate passed |
| `eval:baseline` | ✅ 0/61 (+1 muaf, gerekçeli) |
| yeni testler | 8 (grader) + 10 (acceptance) + 7 (runner) = **25** |

### 14.8 Madde 76 — Definition of Done

1) kod ✅ 2) gerçek execution path ✅ (hem `EvalRunner` hem `execute()`)
3) test ✅ 25 4) eval ✅ iki gate de gerçek davranışı ölçüyor
5) failure behavior ✅ (`uncertain` / `fail` / workspace dışı ret)
→ **completed.**

---

## 15. "Hiç eksik kalmadı mı?" — dürüstlük taraması

Soru sorulunca hafızadan cevap vermek yerine kod tarandı. **Üç uydurma başarı
kaynağı** bulundu. Hiçbiri testlerde görünmüyordu, çünkü üçü de testlerin
bakmadığı yerlerdeydi.

### 15.1 `gradeJudge` — kendini "LLM judge" sanan aktivite sayacı

```ts
score = (event var ? 0.3 : 0) + (tool çağrıldı ? 0.3 : 0) + (completed ? 0.4 : 0)
```

**Ölçüldü:** iki event (bir tool + bir `session.completed`) → **score 1.0,
passed** — ajan ne üretirse üretsin. Yanlış cevap veren kendinden emin bir ajan
tam puan alır; tek adımda doğru bitiren bir ajan düşebilir. Bu doğruluğu değil
gayreti ölçüyor.

Judge bir model ister; grader'a model bağlı değil. Artık `uncertain`
(score 0, passed false) dönüp eksiği adıyla söylüyor. Testler: `minScore: 0`
ile bile geçemiyor, 50 event'lik trajectory ile de geçemiyor.

### 15.2 `performance-benchmark` — ölçülmeyen kaliteye 1.0 yazmak

```ts
qualityScore: r.qualityScore ?? 1.0   // ❌
```

Ölçülmemiş görev **mükemmel** sayılıp ortalamaya giriyordu; şişme, ölçüm
yapmayan koşum sayısıyla birlikte büyüyor. Örnek: `[0.4, ölçülmedi, ölçülmedi]`
→ eski **0.80**, doğru **0.40**.

Artık `number | undefined`; `averageQuality()` yalnız ölçülenleri sayıyor,
hiçbiri yoksa `undefined` dönüyor, rapor `n/a (unmeasured)` yazıyor.

### 15.3 `AgentSDKService.executeInSandbox` — en kötüsü

```ts
private async executeInSandbox(...) {
  // In production, execute in isolated sandbox (WASI, VM, etc.)
  return { success: true, extension: extension.name, input };   // ❌
}
```

Yalan zincir boyunca büyüyordu:

```
sahte sandbox → execution.status = "success" → getStats().successRate = 1.0
```

**Hiç çalışmamış bir uzantı %100 başarı reklamı yapıyordu.** Üstelik
`execution` kaydı daha hiçbir şey olmadan `status: "success"` ile doğuyordu.

Düzeltme: `ExtensionSandboxUnavailableError` (adlandırılmış — "uzantı
başarısız" ile "platform uzantı çalıştıramıyor" ayırt edilebilsin diye), kayıt
artık `error` olarak başlıyor. Motorda zaten iki gerçek izolat var
(`SandboxExecutor` Worker isolate, imzalı `WasiPluginManager`); iş onlardan
birini bağlamak, girdiyi yankılamak değil.

**Neden kimse fark etmemişti:** `AgentSDKService` için **hiç test yoktu**.
Şimdi 6 test var.

### 15.4 Ölçülen taban

| Kontrol | Sonuç |
|---|---|
| `npm run typecheck` | **0 hata** |
| `npx vitest run` | **192 dosya / 1186 test PASS** |
| `eval:validate` | ✅ Gate passed |
| `eval:baseline` | ✅ 0/61 (+1 muaf) |
| yeni testler | 8 (grading honesty) + 6 (sdk) = **14** |

### 15.5 Dürüst cevap: eksikler var, ama artık hepsi beyan edilmiş

26 modülün **7'si `stable`**, 14'ü `beta`, 5'i `experimental`. Bu bir kusur
değil, envanterin doğru olması. Kalan boşluklar (V3 consensus, LLM judge,
extension isolate, learned requirement table, capability generator) kodda
**throw eden guard**, maturity kaydında `gapToStable` metni olarak duruyor —
sessiz `return true` olarak değil.
