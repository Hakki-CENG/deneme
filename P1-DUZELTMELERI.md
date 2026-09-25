# Aurora Motor Engine — Bug A/B + P1 Düzeltmeleri

**Repo:** `Hakki-CENG/Aurora-Motor-Engine` → `hybrid-agent-fabric/` (v1.65.0)
**Kapsam:** P0 sırasında ortaya çıkan 2 yeni bug + inceleme raporundaki P1-4, P1-5, P1-6, P1-7
**Yöntem:** her düzeltme dosyaya yazıldı ve projenin kendi kontrolüyle (test / build / typecheck / audit) doğrulandı.

---

## 0. Özet

| Madde | Durum | Ölçülen sonuç |
|---|---|---|
| **Bug A** — `eval:gates` kirli working tree | ✅ | gates öncesi/sonrası `git status` boş; izlenen `results/` 617→67 dosya, 34 MB→724 KB |
| **Bug B** — `version.ts` yol çözümü | ✅ | `ENGINE_VERSION = 1.65.0` (dist'ten doğrulandı), 3 test |
| **P1-4** — Vitest dosya tekrarı | ✅ | 1237 → 207 dosya çalıştırması (**6.0× azalma**), exit 0 |
| **P1-5** — Node sürüm tutarsızlığı | ✅ | Node v22.23.2'de ci/audit/typecheck/build hepsi OK, **EBADENGINE 4→0** |
| **P1-6** — `acp-server` + `session-worker` 0 test | ✅ | 7 + 8 = **15 yeni test**, gerçek entrypoint'ler subprocess olarak sürülüyor |
| **P1-7** — Thought servisleri 0 test | ✅ | 26 + 23 = **49 yeni test** |
| **Yeni bulunan kusurlar** | ✅ 5 düzeltildi | aşağıda §7 |

**Tam regresyon:** `npm test` → **exit 0**, **9 workspace / 211 test dosyası / 1436 passed + 1 skipped**, **0 hata**.

| workspace | dosya | test |
|---|---|---|
| engine | 187 | 1222 (+1 skipped) |
| eval | 12 | 126 |
| control-api | 5 | 41 |
| headless-client | 2 | 8 |
| acp-server | 1 | 7 **(yeni)** |
| session-worker | 1 | 8 **(yeni)** |
| canvas-web | 1 | 20 |
| release-tool | 1 | 3 |
| desktop | 1 | 1 |
| **toplam** | **211** | **1436 + 1 skipped** |

---

## 1. Bug A — `npm run eval:gates` izlenen dosyaları değiştiriyordu

`packages/eval/results/` altında **üretilen** çıktılar (`runs/`, `trajectories/`, `benchmarks/`,
`costs/`, `monitor/`, `quality-gates/`, `recovery/`, `experiments/`, …) git tarafından izleniyordu.
Gates'i çalıştırmak bu dosyaları yeniden yazdığı için CI'da working tree kirleniyor,
"temiz ağaç" varsayımı sessizce bozuluyordu.

**Düzeltme:** 14 üretilen yol + `var-inbound-smoke/` `.gitignore`'a eklendi, 560 dosya
`git rm -r --cached` ile indeksten çıkarıldı.

**Doğrulama:** gates `exit 0`; çalıştırma **öncesi ve sonrası** `git status` boş.
İzlenen `results/`: **617 → 67 dosya, 34 MB → 724 KB**. Kalan 67 dosya el yazımı analiz `.md`'leri.

---

## 2. Bug B — `packages/engine/src/version.ts` ilk dalı hep ölüydü

Kod `resolve(__dirname, "../../package.json")` kullanıyordu. Bu yol hem `src/` hem `dist/`
için `packages/package.json`'a denk geliyor — **ölçüldü: böyle bir dosya yok**. Yani ilk dal
hiç çalışmıyor, kod her zaman `process.cwd()`'ye düşüyordu. Docker'da `WORKDIR /app` sayesinde
şans eseri doğru sonucu veriyordu; başka bir cwd'den çalıştırıldığında sürüm yanlış olacaktı.

**Düzeltme:** `__dirname`'den yukarı yürüyüp `name === "@haf/engine"` olan ilk `package.json`'ı
bulan `findOwnPackageJson()`; bulunamazsa `"0.0.0-unknown"`.

**Doğrulama:** `packages/engine/test/version.test.ts` → 3 test geçti.
Regresyon kanıtı: eski kod geri konduğunda 3. test **FAIL**; decoy probe
`{"ENGINE_NAME":"decoy-not-the-engine","ENGINE_VERSION":"9.9.9-decoy"}`.
Bu turda dist üzerinden tekrar ölçüldü: `ENGINE_VERSION = 1.65.0`, `ENGINE_NAME = @haf/engine`.

---

## 3. P1-4 — Vitest her workspace'te diğerlerinin testlerini de topluyordu

7 workspace'in her birinde neredeyse aynı `vitest.config.ts` vardı ve `include` desenleri
birbirinin dosyalarını da yakalıyordu. Sonuç: `npx vitest list --filesOnly` ile ölçüldüğünde
**207 test dosyası 1237 kez** çalıştırılıyordu.

**Düzeltme:** paylaşılan `vitest.project.ts` içinde tek bir `hafProject(name, relativeRoot)`
factory'si; kök `vitest.config.ts` ve 7 workspace config'i bunu kullanıyor. Her workspace artık
yalnızca kendi kökünü tarıyor.

**Doğrulama (workspace başına toplanan dosya):**

| workspace | beklenen | ölçülen |
|---|---|---|
| engine | 185 | 185 ✅ |
| eval | 12 | 12 ✅ |
| control-api | 5 | 5 ✅ |
| headless-client | 2 | 2 ✅ |
| release-tool | 1 | 1 ✅ |
| canvas-web | 1 | 1 ✅ |
| desktop | 1 | 1 ✅ |
| **toplam** | **207** | **207 ✅** |

Kökten `npx vitest list --filesOnly` da 207 veriyor. **1237 → 207 = 6.0× azalma**, `npm test` exit 0.

---

## 4. P1-5 — Node sürüm sözleşmesi tutarsızdı

Kök `package.json` `>=20.0.0` derken CI Node 20 kullanıyor, `apps/desktop` ise `>=22.12.0`
istiyordu. `npm ci` dört pakette **EBADENGINE** uyarısı veriyordu.

**Kök neden ölçüldü:** `electron@41`'in kendi engines'i `node >= 12.20.55`. `>=22.12.0`
gereksinimi electron'dan değil, `electron-builder`'ın çektiği transitive
**`@electron/rebuild@4.2.0` + `node-abi@4.35.0`** (+`content-disposition@3.0.0`) paketlerinden geliyor.

**Düzeltme:** kök `engines` `>=22.12.0`; `.github/workflows/ci.yml` 3 yerde `node-version: 22`;
`Dockerfile` 2 yerde `node:22-bookworm-slim`. Sözleşme artık tutarlı — 10 workspace tarandı,
engines'i yalnız `apps/desktop` bildiriyor ve o da `>=22.12.0`.

**Doğrulama — Node v22.23.2 / npm 10.9.8 ile gerçek çalıştırma:**

| adım | sonuç |
|---|---|
| `npm ci` | OK — **EBADENGINE 4 → 0** |
| `npm audit --omit=dev` | OK — 0 vulnerability |
| `npm run typecheck` (10 workspace) | OK |
| `npm run build` (10 workspace) | OK |

---

## 5. P1-6 — `acp-server` ve `session-worker` hiç test edilmiyordu

İkisi de üst-seviye script: modül kapsamında engine kuruyor, stdio/Unix socket dinliyor.
Import edilerek unit test edilemezler; tek dürüst kapsam **gerçek derlenmiş artifact'i
subprocess olarak sürmek**.

### `apps/acp-server/test/protocol.test.ts` — 7 test
Derlenmiş `dist/main.js` spawn ediliyor, satır-sınırlı JSON-RPC stdio üzerinden sürülüyor
(mock provider + geçici `HAF_HOME`; ağ yok, python kernel yok, repo durumuna dokunmuyor).

Kapsanan: `initialize` yetenek/sürüm bildirimi, bilinmeyen metodda `-32601` (asma yok),
session yokken prompt reddi, `session/new` → `session/prompt` → `session/close` tam turu,
açık session varken ikinci `session/new` reddi, close sonrası yeniden açma,
**bozuk JSON satırından sonra sunucunun ölmediğinin** kanıtı.

### `apps/session-worker/test/entrypoint.test.ts` — 8 test
`dist/main.js` gerçek env değişkenleriyle spawn ediliyor, **gerçek Unix socket** üzerinden
gerçek `WorkerProtocolClient` ile bağlanılıyor.

Kapsanan: descriptor dosyasının yazılması ve `ping`, root session'ın worker id altında
bootstrap'ı, `list_sessions`, `approvals_list`, **aile dışı session'a giden komutun reddi**
(`"Command targets a session outside this worker family"` — daha önce hiç çalıştırılmamıştı),
bilinmeyen metod reddi, `shutdown` sonrası **exit code 0**, ve eksik `HAF_WORKER_TOKEN` ile
başlamayı reddedip hangi değişkenin eksik olduğunu söylemesi.

> Not: mevcut `worker-protocol.test.ts` protokole **bilinçli olarak engine'siz bir fikstürle**
> bakıyor. Bu testler onu tekrarlamıyor, gerçek entrypoint'i ekliyor.
> `spawn_child`/`fork` bilinçli olarak sürülmüyor: ek detached OS process'i doğuruyorlar ve o
> alan zaten `worker-process-manager.test.ts`'te kapsanıyor.

Ayrıca kök `package.json`'daki `test` script'i **elle bakılan 7 workspace'lik bir listedi** ve
yeni test script'i olan workspace'leri sessizce atlıyordu — bu yüzden yeni testler ilk tam
çalıştırmada hiç koşmadı. Liste `npm run test --workspaces --if-present` ile değiştirildi
(9/10 workspace'te test script'i var; `wasi-runner`'da yok, atlanıyor).

---

## 6. P1-7 — Thought servisleri 1189 + 309 satır, 0 test

### `packages/engine/test/thought-core-service.test.ts` — 26 test
Deterministik enjekte saat (`now`/`tick`) ve `mkdtemp` kökü ile. Kapsanan: thought yaşam
döngüsü ve durum makinesi, `MAX_*` sınırları ve en-eskiyi-`splice` davranışı, `calculatePriority`
eşikleri ve `calculatePriorityScore` formülü, tenant izolasyonu (`findThought` başka tenant'ın
id'sinde fırlatıyor), araştırma kuyruğu sıralaması, durum dosyası `schemaVersion: 1`,
`auroraUnit`/`auroraText` doğrulaması ve `healthCheck` eşikleri.

### `packages/engine/test/background-thinking-service.test.ts` — 23 test
Etiket-benzerliği taraması (Jaccard + "en az 2 ortak etiket" kuralı + benzerlik tabanı),
araştırma fırsatı üretimi, döngü muhasebesi ve durum/thread dürüstlüğü, eski thought
yeniden değerlendirmesi.

---

## 7. Test yazarken bulunan GERÇEK kusurlar (hepsi düzeltildi)

Bunlar planlanmış maddeler değildi; sıfır kapsamlı kodu test etmenin doğrudan ürünü.

### 7.1 `BackgroundThinkingService.runCycle()` varsayılan argümanlarıyla HER ZAMAN fırlatıyordu
Per-iteration bütçesi `maxDurationMs / maxIterations` = `10000 / 3` = **3333.333…** hesaplanıyordu.
`ThoughtCoreService.runBackgroundThinking` bu değeri `auroraInteger(_, 100, 60000, "Max duration")`
ile doğruluyor, yani **tam sayı** istiyor. Sonuç: `runCycle()` ve dolayısıyla
`startBackgroundThread()` varsayılan ayarlarla her çağrıda `"Max duration is invalid."` fırlatıyordu.

Bağımsız kanıt (derlenmiş `dist` üzerinden, test framework'süz):
```
10000/3 = 3333.3333333333335 | Number.isInteger: false
runCycle() varsayilan: THROWS -> Max duration is invalid.
startBackgroundThread: THROWS -> Max duration is invalid.
```
**Düzeltme:** `Math.floor` + `[100, 60000]` aralığına kırpma + `maxIterations` için 0'a bölme koruması.

### 7.2 `getStatus()` hiç çalışmamış bir servisi "az önce çalıştı" diye bildiriyordu
`lastRunAt` her çağrıda `new Date().toISOString()` ile damgalanıyordu; `totalCycles`,
`totalThoughtsProcessed`, `totalConnectionsFound` sabit `0`'dı. Kaynakta
`// In a real implementation, this would track...` notu duruyordu.
Bu, `execution-status.ts`'in "deneysel alt sistemler numara yapmaz" ilkesinin tam tersi.
**Düzeltme:** gerçek ölçülen durum; `lastRunAt` ilk döngüden önce **yok**.

### 7.3 `stopBackgroundThread()` hiç başlatılmamış bir thread için `stopped: true` dönüyordu
Herhangi bir id için sahte başarı. `startBackgroundThread` de thread'i `threads` map'ine hiç
kaydetmiyordu, dolayısıyla `stop()`'un `threads.clear()` çağrısı ölü koddu.
**Düzeltme:** thread gerçekten kaydediliyor; bilinmeyen id → `stopped: false`.

### 7.4 `runCycle` kırpılmış döngüyü tamamlanmış gibi raporluyordu
`iteration` alanı `maxIterations`'ı geri veriyordu; süre bütçesi döngüyü 1. turda kırsa bile
`3` görünüyordu. **Düzeltme:** gerçekten çalışan tur sayısı raporlanıyor.

### 7.5 `blockThought` sebep etiketi dedup'ı bozuyordu
`[^a-z0-9._-]+ → "-"` dönüşümü baştaki/sondaki ayracı kırpmıyordu:
`"needs review"` → `blocked:needs-review`, `"needs review!"` → `blocked:needs-review-`.
Aynı anlam, iki farklı etiket — dedup çalışmıyordu.
**Düzeltme:** iki uç da kırpılıyor; yalnız noktalama içeren bir sebep bilgi taşımadığı için
çıplak `blocked:` etiketi eklenmiyor.

### 7.6 Sürüm `1.38.0` altı dosyada 9 yerde sabit kodlanmıştı (repo 1.65.0)
`grep` ile ölçüldü. Etkilenen yüzeyler:

| dosya | neyi yanlış bildiriyordu |
|---|---|
| `apps/acp-server/src/main.ts:224` | ACP `agentInfo.version` |
| `apps/control-api/src/main.ts:410` | `serviceVersion` |
| `apps/headless-client/src/rpc.ts:30` | JSON-RPC `clientInfo.version` |
| `apps/release-tool/src/main.ts:26` | CLI yardım metni |
| `apps/release-tool/src/release.ts:77` | **imzalanan provenance `builderId`** |
| `apps/release-tool/src/release.ts:211` | **SBOM `creationInfo.creators`** |
| `packages/engine/src/mcp/mcp-manager.ts:238` | MCP client kimliği |
| `packages/engine/src/observability/otlp-exporter.ts:66,71` | **OTLP `service.version` + scope** |

İki sonuç özellikle ciddi: release tool **kendi imzaladığı attestation'da** kendini 27 sürüm eski
diye tanımlıyordu (rapordaki P2-11 "bayat provenance" bulgusunun mekanik nedeni) ve **her
telemetri span'i yanlış sürüme** atfediliyordu.

**Düzeltme:** engine içi dosyalar ve `@haf/engine`'e zaten bağımlı olan app'ler `ENGINE_VERSION`
kullanıyor; `release.ts` zaten okuduğu kök `package.json` sürümünü kullanıyor; bağımlılığı olmayan
iki CLI (`release-tool`, `headless-client`) kendi `package.json`'ını okuyor.
`grep -rn '1\.38\.0' --include=*.ts apps/*/src packages/*/src` artık yalnızca açıklayıcı yorum
satırlarını döndürüyor.

### 7.7 (düzeltildi) `reevaluateOldThoughts` yapmadığı bir eylemi raporluyordu
Sayaç `archived` adını taşıyordu ama kod `setWaiting` yazıyordu — hiçbir şey arşivlenmiyordu.
Dışa açık bir sözleşme değil (capability/REST'te yok, ölçüldü), bu yüzden
`movedToWaiting` olarak yeniden adlandırıldı.

---

## 8. Doğrulama

| kontrol | komut | sonuç |
|---|---|---|
| Tam regresyon | `npm test` | **exit 0**, 9 workspace, 0 hata |
| Typecheck | `npm run typecheck` (10 workspace) | exit 0 |
| Node 22 tam zincir | ci → audit → typecheck → build | hepsi OK |
| Yeni thought testleri | `vitest run --root packages/engine` | 49/49 |
| Yeni ACP testleri | `vitest run --root apps/acp-server` | 7/7 |
| Yeni worker testleri | `vitest run --root apps/session-worker` | 8/8 |
| Sabit sürüm kalmadı | `grep -rn '1\.38\.0' apps/*/src packages/*/src` | yalnız yorum satırları |
| Bug B dist'ten | `import('.../dist/index.js')` | `ENGINE_VERSION = 1.65.0` |

Yeni testlerin hepsi **eski kodla başarısız oluyor** — yani gerçekten buldukları kusuru sabitliyorlar
(7.1 bağımsız script ile, 7.5 ilk çalıştırmada `blocked:waiting-on-user-input-` hatasıyla,
sürüm testi ACP handshake'inde kanıtlandı).

---

## 9. Doğrulanamayan / açık kalan

- **Docker ve GitHub Actions runner sandbox'ta yok.** `Dockerfile` ve `ci.yml` değişiklikleri
  COPY/RUN sırasını `/tmp` altında taklit ederek ve `run` bloğunu PyYAML ile çıkarıp `bash -e`
  ile çalıştırarak doğrulandı; gerçek `docker build` ve gerçek runner **çalıştırılmadı**.
- **`pretest` hâlâ elle bakılan bir liste** (engine + subprocess olarak spawn edilen 3 app).
  Bilinçli tercih — tüm workspace'leri build etmek `canvas-web`'in vite build'ini de işin içine
  katıp test süresini ciddi uzatıyordu. Yeni bir subprocess testi eklendiğinde buraya eklenmeli.
- **`wasi-runner` hâlâ testsiz** (yalnız `wasi-plugin.test.ts` engine tarafında var). P1-6 kapsamı
  `acp-server` + `session-worker` olarak tanımlanmıştı.
- **`spawn_child` / `fork`** gerçek worker testinde sürülmüyor (ek OS process'i doğuruyorlar).
- **`release-metadata/` bayat kalmaya devam ediyor** (P2/P3 kapsamı): 7.6 düzeltmesi aracın
  bundan sonra *doğru* sürüm yazmasını sağlıyor, ama mevcut üretilmiş metadata 1.38.0 damgalı
  ve yeniden üretilmedi.
- **P2/P3 maddelerine dokunulmadı:** `verify-integration.ts` (71 kontrol / 29 FAIL / orphan),
  doküman-route uçurumu (844 route vs `openapi.yaml` 7 path), çelişen durum belgeleri,
  çift `release-metadata`, nightly'nin `EMBEDDINGS_URL` yokken exit 0 dönmesi.
