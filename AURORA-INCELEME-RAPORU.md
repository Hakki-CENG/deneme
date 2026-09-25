# Aurora Motor Engine — Tam Repo İncelemesi

**Repo:** https://github.com/Hakki-CENG/Aurora-Motor-Engine
**Commit:** `b932623` ("Aurora Motor Engine ZIP içeriği eklendi")
**İnceleme tarihi:** 2026-09-21
**Yöntem:** Repo tamamen klonlandı; her iddia **çalıştırılarak** doğrulandı (statik okuma değil).

---

## 0. Önce doğrulanan temel ölçümler

Bunlar repo'nun **sağlam** tarafı — dürüstlük için başa yazıyorum:

| Kontrol | Komut | Sonuç |
|---|---|---|
| Bağımlılık kurulumu | `npm ci` | ✅ 656 paket, temiz |
| Typecheck (10 workspace) | `npm run typecheck` | ✅ **0 hata**, `TYPECHECK_EXIT=0` |
| Tam test paketi | `npx vitest run` (kök) | ✅ **206/206 dosya**, `1369 passed | 1 skipped`, `SUITE_EXIT=0`, 177 sn |
| Tam derleme (10 workspace) | `npm run build` | ✅ `BUILD_EXIT=0` |
| Kabul kapıları | `npm run eval:gates` | ✅ `GATES_EXIT=0` |
| Frontend ↔ Backend sözleşmesi | 235 client path ↔ 844 route | ✅ **0 yetim endpoint** |
| Kod hijyeni | `grep TODO\|FIXME\|HACK\|XXX` | ✅ 96.624 satır kaynakta sadece **7** işaret |

Yani: **kod tabanı ve testler gerçekten çalışıyor.** Aşağıdaki sorunların tamamı
**entegrasyon, CI/CD, paketleme, dokümantasyon ve repo hijyeni** katmanında.

---

# P0 — Kritik: CI/CD şu anda her push'ta kırmızı

## 1. `npm audit --omit=dev` → exit 1 (CI 3. adımda durur)

CI (`hybrid-agent-fabric/.github/workflows/ci.yml`) `- run: npm audit --omit=dev`
çalıştırıyor, `continue-on-error` yok. Ölçülen:

```
$ npm audit --omit=dev
nodemailer  <=9.1.0   Severity: high
  GHSA-c7w3-x93f-qmm8  SMTP command injection via unsanitized envelope.size
  GHSA-vvjj-xcjg-gr5g  SMTP command injection via CRLF in Transport name (EHLO/HELO)
  GHSA-268h-hp4c-crq3  CRLF injection in List-* header comments
  ... (10 advisory toplam)
1 high severity vulnerability
$ echo $?   →  REAL_AUDIT_EXIT=1
```

- `packages/engine/package.json` → `"nodemailer": "^7.0.5"`, kurulan sürüm **7.0.13**
- Düzeltme `nodemailer@10.0.10` (**major** kırılım)
- **Etki:** CI job'ı testler daha başlamadan başarısız.

## 2. "Kernel protocol smoke" adımı → her Linux çalıştırmasında başarısız

CI'daki heredoc:

```bash
python3 python/kernel_server.py <<'EOF2' | tee /tmp/kernel.jsonl
{"type":"execute","id":"1","code":"x=40\nx+2"}
{"type":"shutdown","id":"2"}
EOF2
grep -q '"result": "42"' /tmp/kernel.jsonl
```

Birebir çalıştırıldı, gerçek çıktı:

```json
{"type": "ready", "pid": 37144, "protocolVersion": 2}
{"type": "result", "id": "1", "ok": false,
 "error": "execute frame omitted generation-fencing metadata", ...}
```
→ `grep` eşleşmiyor → **FAIL**.

**Kök neden:** `python/kernel_server.py:158-162` artık `protocolVersion: 2` ve her
`execute` frame'inde `executionId` + `kernelGeneration` + `hostToken` **zorunlu**:

```python
if not all(isinstance(value, str) and value for value in (execution_id, kernel_generation, host_token)):
    raise ValueError("execute frame omitted generation-fencing metadata")
```

Kernel'in kendisi sağlam — doğru alanlarla:

```json
{"type":"execute","id":"1","executionId":"e1","kernelGeneration":"g1","hostToken":"t1","code":"x=40\nx+2"}
→ {"type": "result", "id": "1", "ok": true, "result": "42", "resultType": "int"}
```

**Bozuk olan CI adımı.** `git log`: kernel `2db6a95`'te protocolVersion 2'ye geçti,
`ci.yml` en son `b932623`'te güncellendi ama bu adım hiç senkronlanmadı.

## 3. `docker build` her zaman başarısız — birebir yeniden üretildi

`Dockerfile` build aşamasında **10 workspace'in sadece 6'sının** `package.json`'u
`npm ci`'den **önce** kopyalanıyor:

```dockerfile
COPY packages/engine/package.json      packages/engine/package.json
COPY apps/control-api/package.json     apps/control-api/package.json
COPY apps/acp-server/package.json      apps/acp-server/package.json
COPY apps/session-worker/package.json  apps/session-worker/package.json
COPY apps/wasi-runner/package.json     apps/wasi-runner/package.json
COPY apps/canvas-web/package.json      apps/canvas-web/package.json
RUN npm ci            # ← EKSİK: packages/eval, apps/desktop,
                      #          apps/headless-client, apps/release-tool
...
COPY packages packages   # kaynaklar BURADA geliyor
COPY apps apps
RUN npm run build        # ama 10 workspace'in HEPSİNİ derliyor
```

Dockerfile'ın COPY sırası birebir taklit edilerek ölçüldü:

```
npm ci        → 383 paket kuruldu (gerçek workspace'te 656)
                node_modules/@haf/ → sadece 6 symlink
                node_modules/electron        → YOK
                node_modules/electron-builder → YOK
npm run build → ...
> @haf/desktop@1.65.0 build
> tsc -b tsconfig.json --force
src/main.ts(1,52): error TS2307: Cannot find module 'electron' or its corresponding type declarations.
src/preload.ts(1,31): error TS2307: Cannot find module 'electron' ...
npm error code 1
BUILD_FAILED exit=1
```

Aynı `npm run build`, **tam** `node_modules` ile repo'da `BUILD_EXIT=0` veriyor —
yani sorun kod değil, Dockerfile'ın eksik workspace kopyalaması.

**Ek çelişki:** Runtime aşaması zaten sadece 6 dist kopyalıyor
(engine, control-api, acp-server, session-worker, wasi-runner, canvas-web).
`desktop`, `headless-client`, `release-tool`, `eval` imajda yok — ama build'de derlenmeye çalışılıyor.

---

# P1 — Yüksek

## 4. Test paketi 6 kez tekrar çalışıyor (CI'ı timeout'a sürükler)

Sadece `apps/canvas-web`'in kendi `vitest.config.ts`'i var. Diğer 6 workspace'te
config yok, dolayısıyla `vitest run` yukarı yürüyüp **kök** `vitest.config.ts`'i
buluyor ve onun `projects: [...]` listesiyle **tüm monorepo'yu** topluyor.

Ölçüldü (`vitest list --filesOnly`):

| Çalıştırılan dizin | Kendi test dosyası | Toplanan dosya |
|---|---|---|
| `apps/canvas-web` (config var) | 1 | **1** ✅ |
| `apps/release-tool` (config yok) | 1 | **206** ❌ |
| `apps/desktop` (config yok) | 1 | **206** ❌ |
| `packages/engine` (config yok) | 184 | **206** ❌ |

Kök `npm test` zinciri:
`engine(206) + control-api(206) + headless-client(206) + release-tool(206) + canvas-web(1) + desktop(206) + eval(206)`
= **1237 test-dosyası çalıştırması, 206 yerine.**

CI'da toplam **8 tam paket**: `npm run check` (6×) + `test:adversarial` içindeki
filtresiz `npm run test -w @haf/headless-client` ve `-w @haf/release-tool` (2×).
`build-test` job'ının limiti **20 dakika**. Burada tek geçiş 177 sn sürdü (2 vCPU / 2 GB).

**Çözüm:** her workspace'e kendi `vitest.config.ts`'i (veya kök config'i sadece kökten çağır).

## 5. Node sürüm sözleşmesi tutarsız

| Yer | Gereksinim |
|---|---|
| kök `package.json` `engines` | `node >= 20.0.0` |
| `apps/desktop/package.json` `engines` | **`node >= 22.12.0`** |
| `Dockerfile` | `FROM node:20-bookworm-slim` |
| `ci.yml` (3 job'ın hepsi) | `node-version: 20` |

`npm ci` sırasında uyarı olarak görünüyor (`EBADENGINE @haf/desktop required >=22.12.0, current v20.20.2`).
Desktop gerçekten Node 22 istiyorsa CI ve Docker imajı onu hiç derleyemez/test edemez.

## 6. Üç workspace test kapsamı dışında

| Workspace | `npm test`'te | `typecheck`'te | Kendi test dosyası |
|---|---|---|---|
| `@haf/acp-server` (332 satır) | ❌ yok | ✅ | **0** |
| `@haf/session-worker` (185 satır) | ❌ yok | ✅ | **0** |
| `@haf/wasi-runner` (24 satır) | ❌ yok | ✅ | 0 (engine'in `wasi-plugin.test.ts`'i dolaylı kapsıyor) |

- `apps/acp-server/src/main.ts` — hiçbir test dosyası referans vermiyor, **sıfır kapsama**.
- `apps/session-worker/src/main.ts` — `apps/control-api/src/main.ts:564` tarafından
  gerçek detached-worker entrypoint'i olarak kullanılıyor
  (`new URL("../../session-worker/dist/main.js", ...)`), ama engine testleri gerçek
  binary yerine `packages/engine/test/fixtures/detached-session-worker.ts` **fikstürünü** kullanıyor.
  Yani üretime giden yol test edilmiyor.

## 7. En büyük iki yeni servis testsiz

```
packages/engine/src/thought/thought-core-service.ts        1189 satır  → 0 test
packages/engine/src/thought/background-thinking-service.ts  309 satır  → 0 test
```

`grep -rl "ThoughtCoreService\|BackgroundThinkingService" packages/engine/test/` → **boş**.
Sadece `thought-memory-integration.test.ts` (214 satırlık adaptör) test edilmiş.

Repo'nun kendi `IMPLEMENTATION_STATUS.md`'si bunu zaten itiraf ediyor:

```
### Step 1.5: Complete Thought Loop Testing
- [ ] Unit tests for ThoughtCoreService
- [ ] Unit tests for BackgroundThinkingService
- [ ] Integration tests for thought capabilities
```

Ama aynı dosya yukarıda `Thought Loop Architecture: ~100% complete` yazıyor.

---

# P2 — Orta

## 8. `verify-integration.ts` çürümüş ve sahipsiz

Repo'nun kendi entegrasyon denetleyicisi. Çalıştırıldı:

```
TOTAL: 71 checks   PASSED: 42   FAILED: 29
❌ SOME CHECKS FAILED - Please fix the issues above
REAL_EXIT=1
```

Dört ayrı kusur:

1. **Sabit mutlak yol** (`verify-integration.ts:9`):
   `const BASE = "/home/user/Aurora-Motor-Engine/hybrid-agent-fabric";`
   → Başka herhangi bir makinede 71/71 başarısız olur. (Benim klonum tesadüfen aynı yolda olduğu için 42'si geçti.)
2. **Var olmayan dosyaları bekliyor** (`verify-integration.ts:51-55`): `sessions.ts`,
   `aurora-memory.ts`, `aurora-world.ts`, `aurora-initiative.ts`, `aurora-evolution.ts`,
   `aurora-cognitive.ts`, `platforms.ts`, `mcp.ts`, `learning.ts`, `automations.ts`,
   `society.ts`, `plugins.ts` — bunlar **kasten silinmiş**
   (`TAMAMLANAN-GÜÇLENDİRME.md`: "14 dosya silindi"). Gerçekte `src/routes/` altında 5 dosya var.
3. **Kodun kendi ilkesiyle çelişiyor:** `version is 1.64.0` diye
   `main.ts` içinde `version: "1.64.0"` **literalini** arıyor. Oysa kod doğru olanı yapıyor:
   `main.ts:12` `ENGINE_VERSION` import ediyor, `packages/engine/src/version.ts` başlığı
   *"Always reads from package.json — never hardcode version strings."* Denetleyici bayat, kod değil.
4. **Hiçbir yere bağlı değil:** hiçbir `package.json` script'i ve hiçbir CI workflow'u çağırmıyor.
   (Repo'nun kendi `packages/eval/results/56-runtime-proof-plan.md`'si bile onu "❌ ÇÜRÜDÜ" diye işaretlemiş.)

## 9. API dokümantasyonu gerçeğin ~%1'i

| Kaynak | Yol sayısı |
|---|---|
| **Gerçekte kayıtlı route** (`main.ts` + `routes/*.ts`) | **844** |
| `docs/openapi.yaml` | **7** (%0,8) |
| `docs/API-REFERENCE.md` | 128 (%15) |
| `docs/API.md` | 14 |

`openapi.yaml` sadece şunları tanımlıyor: `/health`, `/v1/sessions`,
`/v1/sessions/{sessionId}`, `/v1/sessions/{sessionId}/chat`, `/v1/memory-graph/search`,
`/v1/world/entities`, `/v1/initiative`.

## 10. Dokümanlar birbirini ve kodu yalanlıyor

### 10a. Kök seviyedeki Türkçe durum dosyaları ↔ üretilen dosyalar

Repo'nun README'si açıkça diyor ki `CURRENT_STATE.md` / `MATURITY_MATRIX.md` /
`KNOWN_GAPS.md` **koddan üretilir** ve `packages/eval/test/state-docs.test.ts`
(16 test, geçiyor) sapmayı yakalar. Üretilen dosyaların söylediği:

```
CURRENT_STATE.md (2026-09-20):
  Test files                                    206
  Test cases (declared)                         1359
  Modules observed doing work in a real task      5  / 30
  implemented: 0 · initialized: 0 · reachable: 25 · integrated: 0
  · exercised: 4 · verified: 1 · production: 0
KNOWN_GAPS.md:
  "Constructed at startup but idle during a real task (25)"
  "Declared distance to stable (24)"
```

Ama kökteki elle yazılmış dosyalar:

| Dosya | İddia | Ölçülen gerçek |
|---|---|---|
| `GERCEK_DURUM_DEGERLENDIRMESI.md` | "~85% nihai", "**production-ready**", "**Kritik eksik yok**" | `production` seviyesinde **0** modül |
| `GERCEK_DURUM_DEGERLENDIRMESI.md` | "612/613 test geçiyor" | 1369 passed / 206 dosya |
| `GERCEK_DURUM_DEGERLENDIRMESI.md` | "Control API: 27/27 test" | control-api'de 5 dosya; suite 1369 |
| `DEGISIKLIK_OZETI.md` | "Toplam 660 test, 659 geçti" | 1370 |
| `31-SİSTEM-TAMAMLANDI.md` | "Engine: 196 tests (21 files)" | 184 dosya |
| `31-SİSTEM-TAMAMLANDI.md` | "800+ REST endpoint" / "702 REST endpoint" (aynı dosyada iki farklı sayı) | 844 |
| `IMPLEMENTATION_STATUS.md` | "Digital Embodiment: **0% complete**" | `packages/engine/src/embodiment/` mevcut, `embodiment-integration.test.ts` geçiyor |
| `IMPLEMENTATION_STATUS.md` | "Version inconsistencies fixed (1.62.0 → 1.64.0)" | Her yerde **1.65.0** — doküman 3 sürüm geride |

### 10b. Dosyalar kendi içinde çelişkili

- `NIHAI_EKSIKLER.md` → ARIA / ErrorBoundary / Skeleton için "**❌ EKSİK**, Öncelik: **YÜKSEK**"
  diyor; aynı dosyanın altında "### Yüksek Öncelik — Hemen Yapılmalı → **✅** ARIA attributes ekle"
  diye tamamlanmış gösteriyor. `GERCEK_DURUM_DEGERLENDIRMESI.md` de yapıldığını söylüyor.
  Kod (`App.tsx`) yapıldığını doğruluyor → **üst bölüm bayat**.
- `NIHAI_EKSIKLER.md` → "8. Dead Route Files: **14 route dosyası** `src/routes/` — hiçbiri kullanılmıyor"
  ↔ `TAMAMLANAN-GÜÇLENDİRME.md` (aynı tarih) → "1. Dead route dosyaları ✅ **14 dosya silindi**".
  Gerçek: 5 dosya var ve `main.ts:14` `routes/index.js`'i **import ediyor** (ölü kod değil).
- `TAMAMLANAN-GÜÇLENDİRME.md` tarihi **2025**-09-15; diğer tüm dosyalar **2026**.
- `TAMAMLANAN-GÜÇLENDİRME.md` → "Canvas-Web unit test ✅ 18 test"; gerçek `src/utils.test.ts` içinde **21**.
- `TAMAMLANAN-GÜÇLENDİRME.md` → "Tier 2 — Yeni Panel'ler: KnowledgePanel, CodeIntelPanel,
  BgWorkersPanel, SchedulesPanel, TrustPanel, RiskPanel, UserModelPanel".
  Bu 7 panel **var**, ama ayrı dosya olarak değil — hepsi `App.tsx` (1196 satır) içinde inline.
  `src/components/` altında sadece `ChatPanel`, `DiffViewer`, `FilesPanel`, `TerminalPanel` var.

> **Not:** README bu sorunu zaten teşhis etmiş: *"the repo previously accumulated
> 27 hand-written 'PHASE NN COMPLETED ✅' files that were false within days of being written."*
> Çözüm üretilen dokümanlar. Ama kökteki 5 Türkçe MD dosyası ve
> `hybrid-agent-fabric/` altındaki 7 Türkçe MD dosyası bu disiplinin **dışında** kalmış.

## 11. Supply-chain attestation tamamen bayat

`release-metadata/` (imzalı provenance + SBOM + manifest) ile mevcut ağaç karşılaştırıldı:

```
source-manifest.json → project: {"name":"hybrid-agent-fabric","version":"1.38.0"}
                       generatedAt: 2026-08-19   entries: 310
provenance.intoto.jsonl → builder: release-tool@1.38.0

Gerçek repo: 1.65.0, git'te izlenen 1437 kaynak dosya

manifest entries:        310
  ağaçta bulunamayan:      0
  içeriği DEĞİŞMİŞ:       52   (.github/workflows/ci.yml, .gitignore,
                                apps/acp-server/package.json, apps/canvas-web/index.html, ...)
  manifest'te HİÇ olmayan: 1127 dosya
```

Yani SLSA provenance ve her iki SBOM **27 sürüm ve ~1100 dosya geride**.
Şu hâliyle tedarik zinciri garantisi **anlamsız** — yanlış güven vermesi, hiç olmamasından kötü.

---

# P3 — Repo hijyeni

| # | Bulgu | Ölçüm |
|---|---|---|
| 12 | **`packages/eval/results/` commit'lenmiş** | **34 MB / 617 dosya** — repo'nun 46 MB'ının %74'ü. `.gitignore` `packages/eval/.workspaces/`'i dışlıyor ama `results/`'i **dışlamıyor**. İçinde `/home/user/...` mutlak yolları ve ham stack trace'ler var. |
| 13 | **`var-inbound-smoke/` çalışma-zamanı durumu commit'lenmiş** | `data/catalog/sessions.json`, `data/events/*.jsonl`, `data/snapshots/*.json`, `data/agent-inbox/*.json`, `data/journal/commands.jsonl` — test artığı, git'te olmamalı |
| 14 | **`release-metadata` iki kez commit'lenmiş** | `hybrid-agent-fabric/release-metadata/` ve `hybrid-agent-fabric-release-metadata/release-metadata/` → 6 dosyanın 6'sı da **byte-identical** (md5 birebir aynı), 1,5 MB × 2 |
| 15 | **Kök dizinde 880 KB PDF** | `uploads/Aurora Agent Society Architecture V1-birleştirildi(1).pdf` — "(1)" indirme-son eki adın içinde |
| 16 | **Birebir kopya doküman** | `uc-ajan-reposu-nihai-mimari-analizi.md` (kök, 93.894 B) ≡ `hybrid-agent-fabric/docs/reference-analysis.md` — md5 `44ab15617346088d80030da29e13a668` her ikisinde |
| 17 | **Tek commit'te 950 dosya** | `b932623`: `950 files changed, 1097350 insertions(+), 1506 deletions(-)` — "ZIP içeriği eklendi". Bu içeriğin anlamlı bir git geçmişi **yok**. |
| 18 | **Tutarsız non-ASCII dosya adları** | `DÖNÜŞÜM-PLANı.md` ve `GÜÇLENDİRME-PLANı.md` küçük noktasız **`ı`** kullanıyor; kardeşleri (`30-SİSTEM-DÖNÜŞÜM.md`, `GÜÇLENDİRME-ÖZELLİKLERİ.md`) büyük **`İ`**. Case-insensitive dosya sistemlerinde çakışma riski. |
| 19 | **Repo kökünde README yok** | Kök = 5 bayat Türkçe MD + 64 KB txt + 93 KB analiz + `uploads/` + `hybrid-agent-fabric/`. GitHub açılış sayfası projeyi değil bu yığını gösteriyor. Gerçek proje bir seviye aşağıda. |
| 20 | **Mimari spec iki formatta** | `aurora-agent-society-architecture-v1.txt` (64 KB) kökte + aynı içeriğin PDF'i `uploads/`'ta |

---

# Özet tablo

| Öncelik | Sorun | Kanıt | Etki |
|---|---|---|---|
| **P0** | `npm audit --omit=dev` exit 1 (nodemailer high) | `REAL_AUDIT_EXIT=1` | CI 3. adımda kırmızı |
| **P0** | Kernel smoke testi protocolVersion 2'ye güncellenmemiş | `"error": "execute frame omitted generation-fencing metadata"` | CI Linux'ta kırmızı |
| **P0** | `docker build` başarısız (eksik workspace `package.json` kopyası) | `TS2307: Cannot find module 'electron'`, `npm error code 1` | İmaj hiç üretilemiyor |
| **P1** | Test paketi 6× tekrar (`vitest.config` sadece canvas-web'de) | `release-tool` → 206 dosya topluyor | CI'da 8 tam geçiş, 20 dk limiti |
| **P1** | Node sürüm çelişkisi (desktop ≥22.12 vs Docker/CI 20) | `engines` + `FROM node:20` | Desktop hiç derlenemiyor |
| **P1** | `acp-server` (332 s.) ve `session-worker` (185 s.) testsiz | 0 test dosyası, `npm test`'te yok | Üretim yolu doğrulanmıyor |
| **P1** | `ThoughtCoreService` (1189 s.) + `BackgroundThinkingService` (309 s.) testsiz | grep boş | En büyük yeni özellik korumasız |
| **P2** | `verify-integration.ts`: sabit yol, 29/71 FAIL, sahipsiz | `REAL_EXIT=1` | Yanıltıcı/ölü araç |
| **P2** | API dokümanı 844 route'a karşı 7 OpenAPI yolu | sayıldı | Entegrasyon yapan kör |
| **P2** | Kök MD dosyaları üretilen dokümanlarla çelişiyor | `production: 0` vs "production-ready" | Yanlış güven |
| **P2** | Provenance/SBOM 1.38.0'da kalmış (310 dosya / 52'si değişmiş) | hash karşılaştırması | Tedarik zinciri garantisi geçersiz |
| **P3** | 34 MB `eval/results` + çift `release-metadata` + 880 KB PDF + kopya MD | `du` / `md5sum` | Şişkin, dağınık repo |

---

# Önerilen düzeltme sırası

**Hemen (CI'ı yeşile döndürmek için):**
1. `nodemailer` → `^10.x`'e yükselt, `email-channel-adapter.ts`'teki kırılımları düzelt.
2. `ci.yml` kernel smoke'una `executionId` / `kernelGeneration` / `hostToken` ekle
   (yukarıda çalışan frame var).
3. `Dockerfile`'a eksik 4 workspace `package.json` COPY satırını ekle **veya**
   `npm run build`'i runtime'a giden 6 workspace'le sınırlandır (`build:runtime` script'i).

**Kısa vade:**
4. Her workspace'e kendi `vitest.config.ts`'i → `npm test` 6× değil 1× çalışsın.
5. Node sürümünü tek karara bağla (hepsi 22, ya da desktop'u 20'ye indir).
6. `acp-server`, `session-worker`, `ThoughtCoreService`, `BackgroundThinkingService` için test yaz.
7. `verify-integration.ts`'i sil veya `import.meta.url` tabanlı yola çevirip `npm run verify` olarak CI'a bağla.

**Orta vade:**
8. `packages/eval/results/` ve `var-inbound-smoke/`'u `.gitignore`'a ekle, git'ten çıkar.
9. Çift `release-metadata`'dan birini sil; `npm run release:prepare` ile 1.65.0 için yeniden üret.
10. Kökteki 5 + `hybrid-agent-fabric/` altındaki 7 bayat Türkçe MD'yi arşivle veya
    üretilen `CURRENT_STATE.md`'ye yönlendiren tek bir `DURUM.md`'ye indir.
11. Repo köküne gerçek bir `README.md` koy; `openapi.yaml`'i kayıtlı route'lardan üret.
