# KÖK MD DOSYALARI — İDDİA DENETİMİ

**Tarih:** 2026-09-23 · **Kapsam:** 5 dosya · **Yöntem:** her ölçülebilir iddia komutla doğrulandı

Bu bir **denetim raporudur**. Kullanıcının talimatı gereği dosyalar
**birleştirilmedi ve silinmedi** — yalnız iddialar sınıflandırıldı.

**Sınıflar:** ✅ DOĞRU (ölçümle uyuşuyor) · 🕐 ESKİ (yazıldığında doğruydu, artık
değil) · ❌ YANLIŞ (yazıldığında da doğru değildi) · ❓ DOĞRULANAMAZ (ölçülebilir değil)

**Referans ölçümler (bu turda alındı):** sürüm **1.65.0** · `npm test` **1495
geçen, 0 failed** · TSC **0** · embodiment capability **14** (6 fs + 8 action) ·
`docs:state` 217 dosya / 1484 case / 30 modül.

---

## 1. DEGISIKLIK_OZETI.md

| # | İddia | Ölçülen | Sınıf |
|---|---|---|---|
| 1.1 | Versiyon 1.64.0 | **1.65.0** (11 package.json'un hepsi) | 🕐 |
| 1.2 | "7 FileSystemAgent capability: search, find, info, mkdir, delete, rename, copy" | **6** — `embodiment.fs.search` Faz 5.1'de kaldırıldı (`filesystem.grep` kapsıyordu) | 🕐 |
| 1.3 | "8 ActionFramework capability" | **8** | ✅ |
| 1.4 | "20 test: 11 FileSystemAgent + 6 ActionFramework + 3 Capabilities" | kırılım birebir tutuyor (11+6+3=20) | ✅ |
| 1.5 | "4 middleware: errorHandler, securityHeaders, rateLimiting, auditLogger" | 5 kayıt bulundu | ✅ |
| 1.6 | `renderMarkdown()` / `renderAnsi()` eklendi | 4 referans, mevcut | ✅ |
| 1.7 | `[data-theme="light"]` CSS eklendi | 95 kullanım | ✅ |
| 1.8 | "12 E2E test yazıldı" | **14** `test(` bloğu | 🕐 |
| 1.9 | Engine 613 test / 612 geçen / **1 WASI sandbox hatası** | toplam **1495 geçen, 0 failed**; WASI hatası yok | 🕐 |
| 1.10 | Control API 27 test | **56 test geçiyor** (7 dosya, `npx vitest run apps/control-api/test`) | 🕐 |
| 1.11 | TypeScript 0 hata (3 paket) | TSC=0 (10 paket) | ✅ |
| 1.12 | "Entegrasyon Oranı ~80% nihai" | ölçülebilir karşılığı yok | ❓ |
| 1.13 | "WASI test fix (sandbox ortam hatası)" kalan iş | test artık geçiyor | 🕐 |

**Özet:** 13 iddianın 6'sı doğru, 6'sı eski, 1'i doğrulanamaz. **Yanlış yok.**
Dosya dürüst bir tarihli anlık görüntü; sorun güncel olmaması.

---

## 2. GERCEK_DURUM_DEGERLENDIRMESI.md

| # | İddia | Ölçülen | Sınıf |
|---|---|---|---|
| 2.1 | Versiyon 1.64.0 | **1.65.0** | 🕐 |
| 2.2 | "612/613 test geçiyor (1 WASI sandbox hatası)" | 1495 geçen, 0 failed | 🕐 |
| 2.3 | **"6 Aurora entegrasyon servisi aktif"** | **4** `*Integration` alanı (`engine.ts:704-707`) | ❌ |
| 2.4 | "575+ inline route main.ts'de" | **610** route kaydı | ✅ |
| 2.5 | "4/4 middleware entegre" | 5 kayıt | ✅ |
| 2.6 | `closeSession()` eklendi | `engine.ts:2347` | ✅ |
| 2.7 | `/v1/sessions/:sessionId/close` endpoint | `main.ts:1248` | ✅ |
| 2.8 | "FileSystemAgent: 7 capability" | **6** | 🕐 |
| 2.9 | "ActionFramework: 8 capability" | **8** | ✅ |
| 2.10 | "20/20 test geçiyor" (embodiment) | 20 | ✅ |
| 2.11 | ARIA: `role="application"`, `banner`, `navigation`, `tablist`, `tab`, `main`, `complementary`, `alert`, `listbox`, `option`, `log`, `region`, `tree`, `treeitem` | hepsi var | ✅ |
| 2.12 | **ARIA: `role="article"` + `aria-label` — chat messages** | **0 kullanım** | ❌ |
| 2.13 | `aria-selected`, `aria-live` | 3 + 3 | ✅ |
| 2.14 | React Error Boundary eklendi | mevcut | ✅ |
| 2.15 | Skeleton + `skeleton-pulse` | mevcut | ✅ |
| 2.16 | **"Route dosyaları … Dead code, main.ts çalışıyor"** | `registerMetaControllerRoutes`/`registerAuroraServiceRoutes`/`registerCognitiveRoutes` **main.ts:3509-3511'de çağrılıyor** | ❌ |
| 2.17 | "Sistem ~85% nihai ve production-ready" | ölçülebilir karşılığı yok | ❓ |
| 2.18 | "Kritik eksik yok" | öznel | ❓ |

**Özet:** 18 iddianın 11'i doğru, 3'ü eski, **3'ü yanlış**, 2'si doğrulanamaz.

> **2.3, 2.12 ve 2.16 dikkat ister:** bunlar "zamanla eskidi" ile
> açıklanamaz. 2.16 özellikle zararlı — route dosyalarını "dead code" diye
> işaretlemek, birinin gerçekten kullanılan 82 KB'lık `aurora-services.ts`'i
> silmesine yol açabilirdi.

---

## 3. IMPLEMENTATION_STATUS.md

| # | İddia | Ölçülen | Sınıf |
|---|---|---|---|
| 3.1 | 13 servis sınıfı implemente (`AgentSocietyService`, `CognitiveWorkspaceService`, `CognitiveOrchestrator`, `DecisionService`, `PlanningService`, `MemoryGraphService`, `MultiWorldModelService`, `ProactiveInitiativeService`, `SkillEvolutionService`, `ThoughtCoreService`, `BackgroundThinkingService`, `UserModelService`, `WorldModelService`) | **13/13 dosya mevcut** | ✅ |
| 3.2 | Thought capability'leri: `thought.create`, `thought.list`, `thought.metrics`, `backgroundThinking.runCycle`, `backgroundThinking.scanMemory` | **5/5 mevcut** | ✅ |
| 3.3 | 4 yeni dosya (`thought-core-service.ts`, `background-thinking-service.ts`, `thought/index.ts`, `capabilities/thought-capabilities.ts`) | hepsi var | ✅ |
| 3.4 | **"Step 1.5: ThoughtCoreService / BackgroundThinkingService unit testleri YAPILMADI"** | `thought-core-service.test.ts` ve `background-thinking-service.test.ts` **mevcut** | 🕐 |
| 3.5 | "Digital Embodiment: 0% complete" (avatar/presence/modalities) | avatar/digital-embodiment servisi **yok** | ✅ |
| 3.6 | "package.json references 1.62.0, actual is 1.64.0" | actual **1.65.0** | 🕐 |
| 3.7 | "~100% complete" (Thought Loop, Proactive Initiative, ACOS, Multi-World, Memory, World Model) | yüzde ölçen bir mekanizma yok | ❓ |
| 3.8 | "npm install verified to execute cleanly" | `npm ci` exit 0 | ✅ |

**Özet:** 8 iddianın 5'i doğru, 2'si eski, 1'i doğrulanamaz. **Yanlış yok.**
Bu beş dosyanın en güvenilir olanı.

> 3.5 ile 6.3'ün (aşağıda) çelişkisine dikkat: aynı konu iki dosyada farklı
> tanımlanmış. IMPLEMENTATION_STATUS "Digital Embodiment"i avatar/presence
> olarak alıyor (0%, doğru); diğeri FileSystemAgent'ı aynı başlığa koyup "yok"
> diyor (yanlış).

---

## 4. NIHAI_EKSIKLER.md

| # | İddia | Ölçülen | Sınıf |
|---|---|---|---|
| 4.1 | **"0 ARIA attribute App.tsx'de"** | 14 farklı `role`, 3 `aria-selected`, 3 `aria-live` | 🕐 |
| 4.2 | **"App.tsx'de hiç error boundary yok"** | `ErrorBoundary` mevcut | 🕐 |
| 4.3 | **"Skeleton UI yok"** | mevcut | 🕐 |
| 4.4 | "15 capability kayıtlı" | **14** | 🕐 |
| 4.5 | "6+ Aurora servisi entegre" | 4 `*Integration` | ❌ |
| 4.6 | "Model Providers: 10 provider (OpenAI, Anthropic, Gemini, Azure, Bedrock, Codex)" | **17** provider id'si kayıtlı; parantezdeki 6 ad arasında **Codex yok**, `deepseek/groq/mistral/ollama/openrouter/qwen/vertex/xai` var | 🕐 |
| 4.7 | "deleteSession endpoint yok" | `deleteSession` 0 kullanım, DELETE route 0 | ✅ |
| 4.8 | **"14 route dosyası `src/routes/`"** | **5** dosya | ❌ |
| 4.9 | **"hiçbiri kullanılmıyor"** | üçü de `main.ts:3509-3511`'de çağrılıyor | ❌ |
| 4.10 | "main.ts'de 575 inline route" | 610 | 🕐 |
| 4.11 | "1200+ satır CSS" | 1228 | ✅ |
| 4.12 | "20 inline component App.tsx'de" | 34 eşleşme, 1196 satır | 🕐 |
| 4.13 | "Canvas Web: 0 unit test" | unit test dosyası yok | ✅ |
| 4.14 | Metin kalitesi: `"Hardcoded İngilizce/Türkçe字符串"` | **Çince "字符串" (string) parçası** kalmış | ❌ |

**Özet:** 14 iddianın 3'ü doğru, 7'si eski, **4'ü yanlış**.

> Bu dosya **diğerleriyle doğrudan çelişiyor**: 4.1–4.3 "ARIA/Error
> Boundary/Skeleton yok" diyor, GERCEK_DURUM bunların eklendiğini söylüyor ve
> **eklenmiş durumdalar**. Dosya, o işler yapılmadan önceki hâli anlatıyor ama
> üzerinde tarih dışında bunu gösteren hiçbir işaret yok.

---

## 5. NIHALSI_ICIN_EKSIKLER_VE_GELISTIRMELER.md

Dosya adı ayrıca yazım hatası içeriyor: **"NIHALSI"** (doğrusu NİHAİ).

| # | İddia | Ölçülen | Sınıf |
|---|---|---|---|
| 5.1 | "3454 satır tek dosyada tüm REST endpointleri" | **3525** | 🕐 |
| 5.2 | "915 satır tek React component" | **1196** | 🕐 |
| 5.3 | "Dark theme only — Light theme desteği ekle" | light theme mevcut (95 kullanım) | 🕐 |
| 5.4 | "Keyboard shortcuts eksik — Ctrl+N, Escape" | `ctrlKey/metaKey` 5, `Escape` 1 | 🕐 |
| 5.5 | "Loading skeleton yok" | mevcut | 🕐 |
| 5.6 | "Markdown render yok — mesajlar `pre` tag'inde" | `renderMarkdown` mevcut | 🕐 |
| 5.7 | "ANSI color support yok" | `renderAnsi` mevcut | 🕐 |
| 5.8 | "Error codes yok (HAF-001…)" | **55** `HAF-` kaydı; `ErrorCodes` 47 kod | 🕐 |
| 5.9 | "Rate limiting yok" | `middleware/rate-limiter.ts` + kayıt | 🕐 |
| 5.10 | "Audit logging yok" | `middleware/audit-logger.ts` + kayıt | 🕐 |
| 5.11 | "Request validation middleware yok" | `middleware/request-validator.ts` | 🕐 |
| 5.12 | "HSTS header yok" | `security-headers.ts` içinde **var** (`NODE_ENV=production`'da) | ❌ |
| 5.13 | "Playwright/Cypress test yok" | `playwright.config.ts` + `e2e/app.spec.ts` | 🕐 |
| 5.14 | "control-api için test yok" | **7** test dosyası | 🕐 |
| 5.15 | "CI pipeline eksik" | `.github/workflows/ci.yml` var | 🕐 |
| 5.16 | **"File System Agent yok"** | `embodiment/filesystem-agent.ts` (`class FileSystemAgent`) | ❌ |
| 5.17 | **"Action Framework yok — Goal→Plan→Action döngüsü implemente değil"** | `embodiment/action-framework.ts` + 8 capability | ❌ |
| 5.18 | "ThoughtCoreService 1171 satır" | **1202** | 🕐 |
| 5.19 | "Self-dialogue implementasyonu yok — sadece interface tanımlı" | `interface SelfDialogue` (`:95`), implementasyon yok | ✅ |
| 5.20 | "Terminal/Git Agent yok (agent-level değil)" | `class TerminalAgent`/`GitAgent`/`BrowserAgent` yok | ✅ |
| 5.21 | "README'de version 1.64.0, health endpoint'te 1.38.0" | README **1.65.0**; health endpoint `ENGINE_VERSION`'ı kullanıyor ve `version.ts` **package.json'dan okuyor** → sabit 1.38.0 yapısal olarak imkânsız | ❌ |
| 5.22 | "package.json version'ları tutarsız" | **11/11 dosya 1.65.0** | ❌ |
| 5.23 | "Dockerfile var ama multi-stage build eksik" | `FROM … AS build` + `FROM … AS runtime` → **multi-stage var** | ❌ |
| 5.24 | "Helm chart yok" | `charts/`/`helm/` yok | ✅ |
| 5.25 | "Python tarafında lock file yok" | `requirements.txt`/`pyproject.toml`/lock yok | ✅ |
| 5.26 | P0 listesi: rate limiting, HSTS+security headers, error code sistemi, version tutarlılığı | **4/4 zaten yapılmış** | 🕐 |
| 5.27 | "100+ madde kapandığında sistem nihai hale gelir" | ölçülebilir değil | ❓ |
| 5.28 | Bölüm 6.4–6.8 ve 7.x'teki ~60 madde ("Memory Palace yok", "Meta-World Model yok", "Confidence Engine yok" …) | her biri ayrı bir tasarım kararı; tek tek doğrulanmadı | ❓ |

**Özet:** 28 ölçülebilir iddianın 4'ü doğru, 17'si eski, **6'sı yanlış**,
1'i (5.27) doğrulanamaz; bölüm 6.4–6.8/7.x'teki ~60 madde ayrıca
doğrulanmadı.

---

## GENEL TABLO

| Dosya | Doğru | Eski | Yanlış | Doğrulanamaz |
|---|---:|---:|---:|---:|
| DEGISIKLIK_OZETI.md | 6 | 6 | 0 | 1 |
| GERCEK_DURUM_DEGERLENDIRMESI.md | 11 | 3 | **3** | 2 |
| IMPLEMENTATION_STATUS.md | 5 | 2 | 0 | 1 |
| NIHAI_EKSIKLER.md | 3 | 7 | **4** | 0 |
| NIHALSI_ICIN_EKSIKLER_VE_GELISTIRMELER.md | 4 | 17 | **6** | 1+ |
| **Toplam** | **29** | **35** | **13** | **5+** |

---

## DENETİMDE BULUNAN ÜÇ SİSTEMATİK SORUN

**1. Dosyalar birbirini yalanlıyor.** NIHAI_EKSIKLER "0 ARIA attribute" diyor,
GERCEK_DURUM ARIA listesini veriyor. İkisi de aynı dizinde, ikisinde de aynı
tarih (15 Eylül 2026) var, hangisinin geçerli olduğunu söyleyen hiçbir işaret
yok. Okuyucu hangisine güveneceğini bilemez.

**2. "Yok" iddialarının 6'sı hiçbir zaman doğru değildi.** HSTS, FileSystemAgent,
Action Framework, multi-stage Dockerfile, sürüm tutarlılığı, route dosyalarının
ölü kod olması — bunlar "sonradan yapıldı" diye açıklanamaz, **yazıldıklarında
da mevcutlardı**. Bu sınıf, eskime değil, doğrulamadan yazma.

**3. Ölçülemeyen iddialar ölçülenlerle aynı güvenle sunuluyor.** "~85% nihai",
"production-ready", "~100% complete" — hiçbiri bir ölçüme bağlı değil, ama
tabloda "612 test geçti" ile yan yana duruyor. Depoda bu yüzdeleri üreten bir
mekanizma yok; `docs:state` modül ve test sayıyor, "tamamlanma yüzdesi"
hesaplamıyor.

---

## DENETİMDE YAPILAN BİR HATA (kayda geçsin)

İlk taramada **"HSTS header yok"** sonucuna vardım, çünkü büyük harfli
`Strict-Transport-Security` aradım; kodda header adı küçük harfle
(`"strict-transport-security"`) yazılmış. Dosya `cat` edilince ortaya çıktı.
**Bu denetimin kendisi de aynı tuzağa düşebiliyor:** grep ile varlık yoklamak,
yokluğu kanıtlamaz. 5.12'deki ❌ işareti bu düzeltmeden sonra kondu.

---

## ÖNERİLEN SONRAKİ ADIM (uygulanmadı)

Kullanıcı "henüz birleştirme veya silme" dediği için yalnız öneri olarak:

1. Beş dosyayı tek bir **tarihli değişiklik günlüğü**ne indirgemek — hepsi zaten
   "şu tarihte şunu yaptık" anlatıyor; çelişkinin kaynağı beş ayrı kopya olmaları.
2. Kalan gerçek eksikleri (`deleteSession`, canvas-web unit testleri, Helm chart,
   Python lock, virtual scrolling, i18n, PWA) **`KNOWN_GAPS.md`'ye** taşımak —
   o dosya koddan üretiliyor ve `state-docs.test.ts` sapmayı yakalıyor.
3. Yüzde ve "production-ready" iddialarını ya bir ölçüme bağlamak ya da çıkarmak.
