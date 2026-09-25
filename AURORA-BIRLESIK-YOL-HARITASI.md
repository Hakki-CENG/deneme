# AURORA BİRLEŞİK YOL HARİTASI — v1

**Tarih:** 2026-09-23
**Girdi:** `uploads/AURORA_NIHAI_MASTER_YOL_HARITASI.md` (1506 satır) + mesajdaki yazılı plan (FAZ 0–32)
**Yöntem:** her iki belge incelendi, mevcut durum iddiaları komutla ölçüldü, sonra birleştirildi

---

## 1. PLAN MANTIKLI MI? — DEĞERLENDİRME

**Evet, büyük ölçüde.** Üç gerekçe:

**a) Mevcut durum iddiaları doğru çıktı.** Plan "30 maturity modülünden 28'i gerçek
task'ta çalışmış" diyor. Ölçtüm:

```
28/30 modules did work during the task.
  2 loaded but never consulted — a call site is missing
  0 never loaded
```

Boştaki ikisi: `capabilities/capability-synthesis` ve `routing/model-routing`.
"217 test dosyası", "1495 test 0 failed", "typecheck 0", "integration 10/10" —
hepsi benim bu oturumda aldığım ölçümlerle birebir aynı. **Plan uydurmuyor.**

**b) Önceki kararlarımı bağımsız olarak doğruluyor.** P0.1 şöyle diyor:

> "Sırf maturity sayısını 30/30 yapmak için idle modülü yapay olarak çalıştırma."

Bu, Faz 3'te `routing/model-routing`'i yürütme yolundan çıkarırken verdiğim
kararın ta kendisi — ve ölçümde o modül hâlâ `idle` görünüyor, yani karar
korunmuş. Aynı şekilde P0.3 ("ölçülmemiş ile ölçülmüş sıfırı tip seviyesinde
ayır") ve P0.2 (adayların gerçek kaynaklardan gelmesi) Faz 3.1b'de uyguladığım
şeyler.

**c) Ana teşhisi benim bulgularımla örtüşüyor.** "Ana problem artık temel
mimari yok değil; parçaların derinleşmesi ve tek bir kapalı döngüye bağlanması."
Benim P0–P3 boyunca gördüğüm de bu: parçalar var, davranış sığ.

**Ama bir sorunu var:** P0 listesinin **5'i zaten kapalı, 3'ü kısmen kapalı.**
Plan olduğu gibi uygulanırsa yapılmış iş yeniden yapılır. Birleştirme bunu
düzeltiyor.

---

## 2. P0 MADDELERİNİN GERÇEK DURUMU (ölçüldü)

| Madde | Plan diyor | Ölçülen | Durum |
|---|---|---|---|
| P0.1 Model routing tek otorite | yapılacak | `UnifiedExecutionLoop → ModelSelectionEngine` zinciri kurulu; `routing/model-routing` **idle** (ölçümle) | ✅ **KAPALI** |
| P0.2 Gerçek aday kümesi | yapılacak | `candidates(tenantId)` = registry × configuration ∪ provider default | ✅ **KAPALI** |
| P0.3 Ölçülmemiş metrik | yapılacak | metrikler opsiyonel, `measuredModels` ayrı, `measuredCandidates` raporlanıyor | ✅ **KAPALI** |
| P0.4 **Outcome feedback** | yapılacak | **A4/C6 ile kapandı**: `engine.ts:3240` `recordModelOutcome` → `modelCapabilityRegistry.recordOutcome(route, verified, latencyMs)`; başarı sinyali doğrulama verdict'i. Ölçüldü: `measuredModels` 0→**1**, `avgLatency` 0→**49 ms** | ✅ **KAPALI 2026-09-23** |
| P0.5 Task-local CognitiveState | yapılacak | slot'lar + **flat alanlar artık tek bir slot'tan türetiliyor** (`focusedTask()` kimin olduğunu söylüyor); belirsiz `setActiveGoal`/`setActivePlan` silindi | ✅ **KAPALI 2026-09-23** |
| P0.6 Semantik recovery | yapılacak | `recoveryDirective` + `avoidTools` uygulanıyor; **idempotency eklendi**: `TaskContext.effectKey` (deneme içi sabit, denemeler arası farklı) + capability acquisition içerik-hash'i ile replay | ✅ **KAPALI 2026-09-23** |
| P0.7 Fail-closed | yapılacak | `invokeGuard` zaten fail-closed (throw/timeout → `deny`) — **ölçülüp test altına alındı**; reddiyeler artık `CapabilityDeniedError` ve **doğru sınıflandırılıyor** (önceden 4/4 `fundamental_unknown`) | ✅ **KAPALI 2026-09-23** |
| P0.8 **Gerçek imza** | yapılacak | **A8 ile kapandı**: `agent-sdk-service.ts:509` `signExtension` = canonical payload + `cryptoSign(null, …)` Ed25519 + trust-root türetme + revocation reddi + `sha256` payloadHash; 12 imza testi | ✅ **KAPALI 2026-09-23** |
| P0.9 Typed errors | yapılacak | **45 kayıtlı kodun 45'i de üretiliyor; DORMANT listesi boş** (ölçüldü) | ✅ **KAPALI 2026-09-23** |
| P0.10 Maturity ölçümü | yapılacak | ölçüm aracının kendi kararı test edildi; `stable` artık kanıt istiyor | ✅ **KAPALI 2026-09-23** |
| P0.11 Tek source-of-truth | yapılacak | bant denetimi **kaynaktan türetiliyor** (10 → 15 dosya), yetkili dokümandaki bayat kural tanımı düzeltildi, README'nin kaynaksız sayıları etiketlendi | ✅ **KAPALI 2026-09-23** |

**Sonuç (2026-09-23 güncellendi):** P0'ın **11 maddesinin 11'i kapalı**. P0.4 ve
P0.8 bu satır yazıldığında açıktı; ikisi de ölçülmüş kanıtla kapandı (yukarıda).
Üç kısmi madde (P0.5/P0.6/P0.7) ve P0.10/P0.11 de kapandı. Yeni bir "faz 0" icat
etmeye gerek kalmadı.

---

## 3. İKİ BELGE NASIL BİRLEŞTİRİLDİ

İki belge aynı işi farklı granülerlikte anlatıyor:

| Master belge | Yazılı plan | Birleşik |
|---|---|---|
| P0 (11 madde) | FAZ 0 | **BÖLÜM A** |
| P1.1–P1.8 (task) | FAZ 1 | **BÖLÜM B** |
| P0.4 + P2.1 + FAZ 2 | FAZ 2 | **BÖLÜM C** |
| P1.15–P1.21 + FAZ 3 | FAZ 3 | **BÖLÜM D** |
| P1.9–P1.14 + FAZ 4 | FAZ 4 | **BÖLÜM E** |
| P1.22–P1.26 + FAZ 5 | FAZ 5 | **BÖLÜM F** |
| P1.27–P1.32 + FAZ 6 | FAZ 6 | **BÖLÜM G** |
| P1.33–P1.39 + FAZ 7 | FAZ 7 | **BÖLÜM H** |
| P1.40–P1.54, P2.x | FAZ 8–16 | **BÖLÜM I–M** |
| P2.38–P2.46, P3.x | FAZ 17–28 | **BÖLÜM N–Q** |
| P3.1–P3.5, FAZ 29–31 | FAZ 29–31 | **BÖLÜM R** |
| P4.x | FAZ 25–27 | **BÖLÜM S** |

**Çakışma çözümü:** yazılı planın FAZ sıralaması ile master belgenin P0→P4
önceliği **aynı şeyi söylüyor** (execution → model → memory → society → …).
Yazılı planın "1. Execution + planner, 2. Model routing + outcome learning,
3. Memory + world model, 4. Agent Society…" sırası master belgenin P1
dizilimiyle örtüşüyor. Çelişki yok; yazılı planın sırası **uygulama sırası**
olarak alındı, master belgenin madde detayı **içerik** olarak alındı.

**Çıkarılanlar:** FAZ 25–27 (digital twin / federated / marketplace) master
belgede P4'te ve "ilk gün şart değil" diye işaretli → en sona.

---

## 4. BİRLEŞİK PLAN

Her maddede: 🆕 yeni iş · 🟡 kısmen var, tamamlanacak · ✅ kapalı (kanıtlı)

### BÖLÜM A — GERÇEĞİ SABİTLE (yazılı FAZ 0 + master P0)

| # | İş | Durum |
|---|---|---|
| A1 | Model routing tek otorite | ✅ |
| A2 | Gerçek aday kümesi | ✅ |
| A3 | Ölçülmemiş ≠ ölçülmüş sıfır | ✅ |
| A4 | **Model outcome feedback → `recordOutcome`** | ✅ **2026-09-23** |
| A5 | Task-local cognitive state (flat-field artığını kaldır) | ✅ **2026-09-23** |
| A6 | Recovery idempotency anahtarı | ✅ **2026-09-23** |
| A7 | Engine-level security screening fail-closed | ✅ **2026-09-23** |
| A8 | **Gerçek kriptografik extension signing** | ✅ **2026-09-23** |
| A9 | Typed errors'ı kalan entity'lere yay (22 → **0** dormant kod) | ✅ **2026-09-23** |
| A10 | Maturity seviye algoritmasını derinleştir | ✅ **2026-09-23** |
| A11 | Durum dokümanlarını tek kaynağa indir | ✅ **2026-09-23** |

### BÖLÜM B — GERÇEK EXECUTION OMURGASI (yazılı FAZ 1 + master P1.1–P1.8)

| # | İş |
|---|---|
| B1 | Tek universal task primitive — kimlik (user, parent, deadline, priority, provenance) + yüzey denetimi | ✅ **2026-09-24** |
| B2 | Goal understanding: hedef, kısıt, deadline, beklenen çıktı, başarı koşulu, risk, eksik bilgi | ✅ **2026-09-24** |
| B3 | **Gerçek task-specific planner** — Goal → sub-goals → dependencies → **DAG** → parallel tasks → resources → verifiers | ✅ **2026-09-24** |
| B4 | Plan gerçekten yürüsün — her step gerçek durum + kanıt taşıyor, yürüyüş dalga dalga ilerliyor | ✅ **2026-09-24** |
| B5 | Dinamik replanning — FAIL → neden → yeni plan → etkilenmiş subtree | ✅ **2026-09-24** |
| B6 | Step-level verification — success criterion, evidence, verifier, output | ✅ **2026-09-24** |
| B7 | **"Agent tamam dedi" yasak** — evidence envanteri: ne kontrol edildi, ne edilmedi | ✅ **2026-09-24** |
| B8 | Long-horizon task manager — durable queue, pause/resume, onay, deadline, escalation, parent-child, digest | ✅ **2026-09-24** |

> **B3 en kritik madde.** Yazılı plan "şu an Aurora'nın en önemli açıklarından
> biri" diyor; master belge P1.3'te aynı şeyi söylüyor. İki belge de aynı
> noktayı işaret ediyorsa oradan başlanır.

### BÖLÜM C — MODEL SEÇİMİ + OUTCOME LEARNING (yazılı FAZ 2)

| # | İş | Durum |
|---|---|---|
| C1 | Tek otorite | ✅ |
| C2 | Gerçek adaylar | ✅ |
| C3 | `provider:model` route | ✅ |
| C4 | Route gerçekten uygulanıyor (`context.modelRoute`) | ✅ |
| C5 | Cold-start / `unmeasured` durumu | ✅ |
| C6 | **Outcome feedback: latency, tokens, cost, success, verification → `AdaptiveRouter` + `ModelCapabilityRegistry`** | ✅ **2026-09-23** (=A4) |

### BÖLÜM D — MEMORY (yazılı FAZ 3 + master P1.15–P1.21)

| # | İş |
|---|---|
| D1 | Gerçek embedding sağlayıcısı runtime recall yolunda (konfigüre edilir, dürüst fallback) | ✅ **2026-09-24** |
| D2 | Durable vector indeks — kalıcılık + tenant izolasyonu zaten vardı; sağlayıcı-sürüm koruması, rebuild, yükleme doğrulaması, tek embedding girintisi eklendi | ✅ **2026-09-24** |
| D3 | BM25 + Vector + RRF + Rerank üretim yolu — durable adaylar üzerinde ranker | ✅ **2026-09-24** |
| D4 | Memory türleri: 7 katman + graph servis, modelde ve tüm API'lerde (ölçüldü; katman başına davranış politikaları kapsam dışı) | ✅ **2026-09-24** |
| D5 | `MemoryClaimType` = tam bu dördü; remember/list/filtre/relation'larda taşınıyor (ölçüldü) | ✅ **2026-09-24** |
| D6 | Contradiction engine: detect (vardı) → **karşılaştır → yargıla → supersede** (yeni orta yarım) | ✅ **2026-09-24** |
| D7 | Procedural memory: trajectory → skill — makine vardı, **besleme yoktu**; learn kancası bağlı | ✅ **2026-09-24** |
| D8 | **Memory'deki `[tool …]` asla executable sayılmasın** | ✅ (Faz 5.2'de yapıldı, `defangDirectives`) |

### BÖLÜM E — REASONING (yazılı FAZ 4 + master P1.9–P1.14)

| # | İş | Durum |
|---|---|---|
| E1 | Multi-hypothesis karar yolunda — her kurtarma kararı rakip hipotez ÇİFTİ olarak açılır (bet + olumsuzlaması), sonraki denemenin verdict'i ikisini ayrıştırır; `markCompeting` bağlantısı eklendi | ✅ **2026-09-24** |
| E2 | Critic planı ilk denemeden önce gözden geçirir — reject → görev blocked (ajan hiç koşmaz), revise → bulgular brifinge/kısıtlara girer | ✅ **2026-09-24** |
| E3 | Belirsizlik → ask/research/verify/second opinion (ölçüldü: B2 ask/research + B6/B7 kanıt katmanı + V3 consensus paneli + ask_human tırmanması; kalibrasyon F2/F3'ten) | ✅ **2026-09-24** |
| E4 | Karşıolgusal: `WorldEngine` yalan sözleşmesi düzeltildi ("hiçbir şeyin tavsiyesi"), tam makine HTTP'ye açıldı (create/scenarios/recommend/outcome/calibration); karar öncesi dal karşılaştırması F4 kapısı + F5 future tree | ✅ **2026-09-24** |
| E5 | Attention/cognitive budget — günlük token bütçesi yürütmeden önce bağlar (blocked); odak rezervasyonu + görev sonunda GERÇEK token muhasebesi (`completeFocus`) | ✅ **2026-09-24** |
| E6 | Cognitive modes — emergency modunun dişleri var: acil olmayan iş (urgency < 0.7) durur, P0 yine de koşar; geçişler anayasal yasallaştırılmış | ✅ **2026-09-24** |
| E7 | Global Workspace — görevin kendisi kara tahtaya girer (kind: problem), dikkat ekonomisinde yarışır, slot sızıntısız bırakılır | ✅ **2026-09-24** |

### BÖLÜM F — WORLD MODEL (yazılı FAZ 5 + master P1.22–P1.26)

| # | İş | Durum |
|---|---|---|
| F1 | Entity/State/Relation/Event/Outcome tek modelde (ölçüldü; makine tamam, yetenek+HTTP+ACOS'tan erişilebilir) | ✅ **2026-09-24** |
| F2 | Heuristic → learned prediction — prior, kiracının ölçülmüş sonuç oranına harmanlanır (kanıt eşiği 5, tam ağırlık 20; ince kanıt yok sayılır) | ✅ **2026-09-24** |
| F3 | predict → act → observe → compare → surprise → update — predict/record çifti zaten bağlıydı; **dayanıklı** yarı eklendi: görev başına 1 tahmin, Brier + kalibrasyon birikiyor | ✅ **2026-09-24** |
| F4 | Multi-world perspektifleri karara bağlı — `worldAnalysisId` ile görev-analiz bağı; reject/hold yürütmeden önce durdurur, konsensüs + muhalefet karar defterine yazılır | ✅ **2026-09-24** |
| F5 | Future tree: cost/benefit (0–1, opsiyonel) + dal EV'si (kümülatif olasılık × (fayda − maliyet)) + kök EV + risk kütlesi + ölçülmemiş sayısı | ✅ **2026-09-24** |

### BÖLÜM G — AGENT SOCIETY (yazılı FAZ 6 + master P1.27–P1.32)

| # | İş | Durum |
|---|---|---|
| G1 | Gerçek specialist delegation — motorun yürüttüğü görevin planı artık topluluk katmanına yansıyor (`mirrorPlanToSociety`), kalan hazır adımlar policy altında köprüyle uzmana devrediliyor; tagsiz seçim reddedilir (tahmin değil seçim) | ✅ **2026-09-24** |
| G2 | Lifecycle — pause/resume/cancel (slot + rezervasyon muhasebesiyle) ve döngü koruması eklendi; spawn/assign/observe/message/verify/retire makineleri ölçülüp bağlı bulundu (wait/join/aggregate/escalate kapsam dışı) | ✅ **2026-09-24** |
| G3 | Dynamic composition — geçici team (deliberation 2–50 rol + quorum), gereksiz ajan yaratmama (policy varsayılan kapalı + tagsiz reddi), agent/context budget, cyclic delegation detection (çocuk oturum devir köklendiremez) | ✅ **2026-09-24** |
| G4 | Governance — itibar kanıta bağlı (incremental ortalama + child-event doğrulaması) + **decay** (30 günlük yarı ömür, okuma başına değil zaman başına), dissent/quorum/conflict resolution makineleri ölçülüp testli | ✅ **2026-09-24** |
| G5 | Execution economy — token/time/cost bütçeleri, agent-level muhasebe (reserved→used), cost-benefit (award skoru), tükenme karşısında cancel rezervasyon iadesi + günlük roll; wallet borsası (AgentEconomyService) hâlâ kopuk — not | ✅ **2026-09-24** |
| G6 | Communication güvenliği — otobüs gövdesi motorun giriş taramasından geçer (enjeksiyon reddi kalıcı olmaz), mesaj provenance katmanı (`fromLayer`), least privilege (profil parent'ı aşamaz) + tenant izolasyonu ölçülüp testli | ✅ **2026-09-24** |

### BÖLÜM H — EMBODIMENT (yazılı FAZ 7 + master P1.33–P1.39)

| # | İş | Durum |
|---|---|---|
| H1 | Generic tool abstraction — descriptor'a idempotency beyanı + output şeması; capability'ye verify (etki doğrulaması) ve rollback (telafi); broker üçünü de uygular: şema ihlali reddedilir, verify fail çağrıyı düşürür, execute hatasında rollback denenir | ✅ **2026-09-24** |
| H2 | Filesystem sertleştirme — kota (yazım yolunda, öngörülen toplamla), dosya kilidi (O_EXCL + sahiplik + stale TTL), büyük dosya akışı (stream + offsetBytes pencere okuma), arşiv güvenliği (tar/tgz: yalnız dosya+dizin, traversal/symlink/device reddi) | ✅ **2026-09-24** |
| H3 | Terminal/process — ölçümle kapalı bulundu: process.exec sandbox'ta (env allowlist, timeout, ulimit kaynak limitleri bağlı, süreç ağacı kill, stdout/stderr); yeniden yazılmadı | ✅ **2026-09-24** |
| H4 | Browser/computer-use — select + upload eklendi; aksiyon doğrulaması (snapshot hash karşılaştırması, actionEffect raporu) ve anti-loop (değişmeyen tekrar = döngü, reddedilir); insan onayı risk sınıfı üzerinden broker'da (S7 testinde kanıtlı) | ✅ **2026-09-24** |
| H5 | Git/GitHub — clone (yalnız https, credentialsız, depth-1; onay kapısından), push (external_side_effect; force yok), rollback (reset --hard + clean, rev önce çözülür), ci.status (yerel dürüst rapor); PR zinciri (create/comment/close/merge SHA-korumalı) zaten vardı | ✅ **2026-09-24** |
| H6 | Code intelligence — bağımlılık grafiği (relative→kenar, paket→external), yama üretimi (LCS diff; filesystem.patch ile round-trip), refactor doğrulaması (diagnostics baseline'a karşı regressed/improved/clean); LSP+sembol+tanı+zaten vardı | ✅ **2026-09-24** |
| H7 | Environment mapper — environment.probe: interpreter'lar ve araç sürümleri (sandbox'ta ölçülür), cihaz (disk/CPU/bellek), proje yapısı + dil dağılımı, izinler (katalog risk dağılımı); ağ erişimi bilinçli ölçülmez, rapor söyler | ✅ **2026-09-24** |

### BÖLÜM I — RESEARCH (master P1.40–P1.43)
| # | Madde | Durum |
|---|------|-------|
| I1 | Gerçek search backend — ResearchEngineService.collectSources eskiden `return []` idi (ölü kod, "In production" yorumuyla); artık: yapılandırılmış web arama sağlayıcısı (Brave/Tavily, WebSearchService) + SSRF-guard'lı bounded fetcher (web.fetch ile aynı sözleşme, fetchPublicDocument) + iç kapsam için hibrit bilgi indeksi; HTML meta çıkarma (title/author/publishedAt/description), PDF metin çıkarıcı (filtersız + FlateDecode, imaj-only'da dürüst "no extractable text layer"), URL-normalize + SHA-256 digest + Jaccard ≥0.85 tekilleştirme, freshness skoru + tarih aralığı filtresi (bilinmeyen tarih görünür kalır); sağlayıcı yapılandırılmamışsa açık hata — kaynak uydurma yok | ✅ **2026-09-25** |
| I2 | Citation/provenance — alıntı gerçek içeriğe karşı doğrulanır: quote → span (normalize edilmiş içerikte start/end offset) → source ilişkisi + contentDigest bağlama; verifyCitation bulunamayanı gerekçesiyle reddeder; verifySource yalnız gerçekten kontrol edilebileni raporlar (fetch edildi mi, HTTPS, tarih var mı, kaç alıntı doğrulandı); rememberResult citation'ları evidenceRefs, en güvenilir kaynağı sourceId provenance'ı olarak hafıza grafa yazar (sourceType: external) | ✅ **2026-09-25** |
| I3 | Research Director workflow — question→search→collect→compare→verify→synthesize→cite→report→remember tam akış gerçek koleksiyonla; raporda her bulgu alıntılanmış span (unsupportedFindings=0 sayılır ve rapor edilir); 7 research.* capability broker'a kayıtlı (network risk sınıfı onay kapısından); verify-source HTTP rotası artık gerçek fetch+doğrulama yapıyor | ✅ **2026-09-25** |
| I4 | Research watcher — topic/project/repository/paper/technology izleme; gerçek değişiklik algılama (içerik parmak izi = SHA-256, önceki anlık görüntüyle karşılaştırma; ilk koşu "baseline" sayılır, değişiklik değil), önem skoru (değişim büyüklüğü + anahtar kelime örtüşmesi), dikkat bütçesi mevcut initiative servisinde (dedup/quiet-hours/budget) — değişiklik initiative olarak önerilir, baskılanma suppressedDuplicates sayacında dürüstçe tutulur | ✅ **2026-09-25** |

### BÖLÜM J — USER MODEL (master P1.44–P1.48)
| # | Madde | Durum |
|---|------|-------|
| J1 | Event wiring — UserModelIntegration EventBus'a abone (task.received/completed/failed) + broker capability.finished dinleyicisi; görev talebi → yalnız inference consent AÇIKSA proposed goal claim (consent pending, kullanıcı onaylar); görev sonucu → activity sinyali + advice takip gözlemi (taskRef eşleşmesi; helpfulness kullanıcıya kalır — autoObserved işaretli); hata → error sinyali; research.*/git.push → davranış sinyalleri; hepsi per-feature consent'e tabur, handler hataları görevi bozamaz (fail-open); task.completed/failed olaylarına userId eklendi (P1.1 kimliği) | ✅ **2026-09-25** |
| J2 | Goal model — dependsOnGoalIds (blockedGoals: achieved olmayan bağımlılık listesi) + conflictsWithGoalIds + goalConflicts: beyan edilen çatışmalar (simetrik rapor), bağımlılık döngüleri (DFS), kısa-vadeli aşırı yüklenme (aktif short > eşik); self/eksik referans reddedilir | ✅ **2026-09-25** |
| J3 | Project model — UserProject: repo/workspace bağlantıları (https/git@ doğrulamalı), aktif görevler, deadline (overdue kontrolü), mimari notlar, sıralı nextActions, recentFailures, expertise etiketleri; overview (gecikme/bekleyen aksiyon/7 günlük hata sayısı); summary'de projects yansır; forgetUser projeleri de siler | ✅ **2026-09-25** |
| J4 | Advice effectiveness — observeAdviceFollowed/observeAdviceFollowedByTask: takip otomatik gözlenir, helpfulness tanımsız kalır (kullanıcı reytingi üstün gelir, tek outcome); advicePolicy: <3 reyting "insufficient-evidence", <0.35 advise-less (72s), >0.7 advise-more (6s), arası normal (24s) | ✅ **2026-09-25** |
| J5 | Kullanıcı kontrolleri — gör (claims/summary) ✅ · düzelt/sil (correct/forget, projeler dahil) ✅ · export (user.model.export capability + governance) ✅ · per-feature privacy (inference default OFF; signals/advice-tracking/research-memory/state-estimation) ✅ · retention (gün bazlı; inferred kayıtlar silinir, user-stated kalır ve sayılır) ✅ | ✅ **2026-09-25** |

### BÖLÜM K — PROACTIVE (master P1.49–P1.54)
| # | Madde | Durum |
|---|------|-------|
| K1 | Event intake bus — ProactiveIntakeBus: EventBus (task.completed/failed) + broker capability.finished + kanal inbound (gateway onIngested hook) + schedule ateşlemeleri (tick'te çekilir, tenant'ı job'dan alır) → tipli intake olayları; kaynak haritası açık (git.*/filesystem yazma/research/environment → git/filesystem/research/system), eşleşmeyen capability olay üretmez; ölü köprü düzeltildi: MemoryInitiativeIntegration olmayan `initiative.scan()`'i çağırıp sessizce yutuluyordu → artık gerçek `ingest(source:"memory")`; InitiativeSource'a "tasks" ve "schedules" eklendi | ✅ **2026-09-25** |
| K2 | Initiative engine — mevcut worthiness/priority/budget/quiet-hours/trust/dedup/escalate gerçek (ölçümle); eklendi: **context fit** (user model'in state estimate'i; busy/working → P1 digest'a düşer, guardian risk düşmez, tahmin yoksa hiçbir şey düşürülmez) + **gerçek goal alignment** (propose'ta provider, kullanıcı modelinin aktif hedeflerine karşı skorlar; provider yoksa relevance varsayımı kalır — uydurulmaz) | ✅ **2026-09-25** |
| K3 | Durable proactive scheduler — watcher state/cooldown/dedup/processed zaten durable (ölçümle); motor başına `runProactiveCycleForAllTenants` + interval timer (config `proactive.intervalMinutes`, default 5 dk, 0 = kapalı; unref; shutdown'da temizlenir): tenants() → runWatchers → evaluate → dönem digest'i yalnız yeni periyotta (daily/weekly/monthly periodKey kontrolüyle, bir kez); DurableScheduler'ın kendisi (advance-before-dispatch, restart-safe) ölçümle kapalı bulundu — yeniden yazılmadı | ✅ **2026-09-25** |
| K4 | Communication selector — kanal tercihleri (orderedChannels + destination, tenant bazlı durable) + selectChannel: tercih sırası ∩ şu an gerçekten var olan adaptörler; in-app her zaman mevcut (ürün yüzeyi), başka hiçbir şey varsayılmaz; gerekçe döner; deliver: seçilen kanal üzerinden gerçek gönderim (outboundChannels.send) + markDelivered; in-app için gönderici gerekmez, diğer kanallar göndericisiz reddedilir; 6 yeni capability (channel.preferences/select/deliver/mute/mutes.list/cycle.run) | ✅ **2026-09-25** |
| K5 | Briefing'ler — buildDigest daily/weekly/monthly vardı (ölçümle); eklendi: canlı bölüm sağlayıcıları (Project risks: geciken deadline + son hatalar; Goal changes: stalled + çatışmalar; Memory changes: son 24h hafıza kayıtları) — motor wiring'inde gerçek servislerden beslenir; sağlayıcı boş dönerse bölüm eklenmez, patlarsa briefing bozulmaz | ✅ **2026-09-25** |
| K6 | Trust-preserving policy — silence-when-low-value/budget/dedup/trust-adaptation/dismiss/escalate gerçek (ölçümle); eklendi: **explain why** (her karar InitiativeDecision izi taşır: effectiveScore, eşikler, trustFactor, contextFit, muted, insan-okur reason) + **tür susturma** (muteKind: deadline'lı, süresi geçince kendiliğinden düşer; muted tür archive'a gider, asla iletilmez) | ✅ **2026-09-25** |

### BÖLÜM L — BACKGROUND THINKING + SELF-MODEL (master P2.10–P2.15, P2.8)
L1 Durable thought queue 🟡 · L2 Curiosity 🆕 · L3 Open problems 🟡 ·
L4 Thought anchors 🟡 · L5 Reflection cycles 🟡 · L6 Dream mode (side effect
yok) 🟡 · L7 **Self-model karar mekanizmasını değiştirsin** 🆕

### BÖLÜM M — LEARNING + SELF-IMPROVEMENT + CAPABILITY (master P2.1–P2.9)
M1 Outcome learning 🆕 (=A4/C6) · M2 Skill discovery 🟡 · M3 Skill testing 🟡 ·
M4 Promotion/retirement 🟡 · M5 Capability acquisition 🟡 · M6 Semantic
evaluation 🆕 · M7 Self-debugging 🆕 · M8 Meta-learning 🆕
**Kural:** kendini geliştirmenin sonucu ölçümde daha kötüyse production'a girmez.

### BÖLÜM N — MULTIMODAL / CONNECTORS / SDK (master P2.20–P2.29)
N1 Gerçek STT 🆕 · N2 Gerçek TTS 🆕 · N3 Vision 🟡 (`analyzeImage` var) ·
N4 Multimodal memory + provenance 🆕 · N5 Connector SDK 🆕 · N6 Connector
safety/reliability 🆕 · N7 Secure agent sandbox 🟡 · N8 Extension lifecycle 🟡 ·
N9 Marketplace 🆕

### BÖLÜM O — DISTRIBUTED / PERSISTENCE (master P2.30–P2.37)
O1 Real node federation 🟡 · O2 Federated learning (kalacaksa: secure
aggregation + poisoning defense + privacy accounting) 🆕 · O3 Device-aware
routing 🆕 · O4 Unified persistence (Postgres + transactions + migrations +
locking + versioning) 🆕 · O5 Backup/restore/PITR 🆕 · O6 Worker reliability 🆕 ·
O7 Partition handling 🆕 · O8 Load scaling 🆕

### BÖLÜM P — SECURITY (master P2.38–P2.42)
P1 Gerçek prompt-injection suite (web/PDF/email/GitHub/memory/tool result/agent
message/MCP) 🆕 · P2 Tool abuse suite 🆕 · P3 Cross-tenant attack suite 🆕 ·
P4 Secret protection 🟡 · P5 Security auditability 🆕 · **P6 Fail-closed** 🟡

### BÖLÜM Q — OBSERVABILITY / API / UX (master P2.43–P2.55)
Q1 Unified telemetry 🟡 · Q2 Distributed tracing 🟡 · Q3 Health model 🟡 ·
Q4 SLO 🆕 · Q5 Complete OpenAPI (`x-schema-status: unspecified` kalksın) 🟡 ·
Q6 API modularization 🆕 · Q7 SDK 🆕 · Q8 WebSocket/SSE 🟡 · Q9 First-run setup 🆕 ·
Q10 Unified task UI 🆕 · Q11 Cognitive transparency 🆕 · Q12 Human-in-the-loop 🟡 ·
Q13 Desktop hardening 🟡

### BÖLÜM R — BENCHMARK / ABLATION / LONG-HORIZON (master P3.1–P3.5)
R1 Ortak benchmark suite (Coding/Research/Browser/Files/Planning/Memory/
Long-Horizon/Multi-Agent/Recovery/Proactive) 🆕 · R2 Rakip karşılaştırması 🆕 ·
R3 **Ablation** (full vs −memory vs −planning vs −society vs −world vs
−verification) 🆕 · R4 Long-horizon benchmark 🆕 · R5 Adaptive routing benchmark 🆕

### BÖLÜM S — İLERİ VİZYON (master P4)
S1 Memory Palace · S2 Meta-World · S3 Cognitive Health · S4 Loop detection ·
S5 Opportunity Engine · S6 Risk Engine · S7 Execution reputation ·
S8 Continuous self-optimization · S9 Self-created tools · S10 Self-created
micro-agents — hepsi 🆕, en sona.

### BÖLÜM T — REPO/RELEASE HİJYENİ (master P3.6–P3.15)
T1 Clean repo 🟡 (çift doküman çözüldü, 5 MD denetimi hazır) · T2 Clean Git
history 🆕 · T3 CI gerçek runner doğrulaması 🆕 · T4 Release reproducibility 🟡 ·
T5 Büyük dosyaları parçala (`main.ts` 3525, `App.tsx` 1196, `engine.ts`) 🆕 ·
T6 `any` azalt 🆕 · T7 Interface contracts 🆕 · T8 Dependency hygiene 🟡
(`nats` çözüldü; kalan 4 deprecated upstream) · T9 Deterministic tests 🆕

---

## 5. UYGULAMA SIRASI

Yazılı planın önerdiği sıra ile master belgenin önceliği aynı. Birleşik sıra:

```
A (gerçeği sabitle: A4, A8, A9, A10, A11)   ← 5 gerçek iş
        ↓
B (execution + planner: B1–B8)              ← EN BÜYÜK KAZANÇ
        ↓
C (outcome learning: C6)                    ← A4 ile aynı iş
        ↓
D + F (memory + world model)
        ↓
E (reasoning: E1–E7)   ← birleştirme hatasıyla diagramdan düşmüştü; F kapanınca eklendi
        ↓
G (agent society)
        ↓
H + I (embodiment + research)
        ↓
J + K (user model + proactive)
        ↓
L + M (background thinking + learning + self-improvement)
        ↓
P + O (security + distributed + persistence)
        ↓
N + Q (multimodal + connectors + observability + UX)
        ↓
R (benchmark + ablation + long-horizon)
        ↓
S (ileri vizyon)
```

---

## 6. KABUL KRİTERLERİ

İki belge de aynı şeyi söylüyor: **"özellik kendi başına çalışıyor" yetmez.**
Yazılı planın 20 kabul testi ile master belgenin 13 DONE kriteri örtüşüyor.
Birleşik liste (ölçülebilir olanlar):

1. Tek cümlelik karmaşık görev → kendi planını üretip tamamlar (DAG + evidence)
2. Coding görevi → kod + test + PR
3. Research → gerçek kaynak ve citation ile rapor
4. Memory → haftalar sonra doğru bilgiyi hatırlar
5. User correction → yanlış hafızayı düzeltir, sonraki kararlar değişir
6. Model routing → **ölçülmüş sonuçlardan öğrenir** (C6'nın kanıtı)
7. Multi-agent → gerçek specialist team kurar
8. Agent conflict → evidence ile çözüm
9. Tool failure → recovery
10. Plan failure → **gerçekten** replanning
11. Capability gap → yeni capability edinip görevi tekrar dener
12. Background thinking → izinsiz side effect olmadan
13. Proactive → kullanıcı konuşmadan değerli girişim
14. Computer-use → gerçek masaüstünde kontrollü iş
15. Voice/vision → gerçek backend'lerle
16. Security → injection/credential/tool abuse engellenir
17. Crash/restart → uzun göreve kaldığı yerden devam
18. Learning → sonraki benzer görevde **davranış ölçülebilir biçimde değişir**
19. Self-improvement → benchmark'ta ölçülmüş iyileşme
20. Hepsi **tek bir ortak runtime yaşam döngüsünde**

**Her madde için zorunlu:** düzeltme geri alındığında testin düştüğü gösterilir
(duyarlılık kanıtı). Ölçülemeyen iddia "tamamlandı" sayılmaz.

---

## 7. İLK ADIM ÖNERİSİ

Bölüm A'nın açık maddeleri küçük ve yüksek değerli; B'ye temiz girmek için önce
onlar:

1. **A4/C6 — Model outcome feedback.** En kritik açık madde. `recordOutcome`
   var ama hiç çağrılmıyor; yani Aurora model seçiminde **deneyimden
   öğrenmiyor**. Kabul testi 6'nın ön koşulu.
2. **A8 — Gerçek imza.** `randomUUID()` imza değil; `verifySignature` hiçbir
   şeyi doğrulamıyor. Güvenlik kusuru.
3. **A11 — Durum dokümanları.** 5 MD'nin denetimi hazır; birleştirme bekliyor.
4. **A9 — Kalan typed errors.** 22 dormant kod.
5. **A10 — Maturity derinliği.**

Sonra **B3 (gerçek planner)** — iki belgenin de işaret ettiği en büyük açık.

---

## 8. UYGULAMA GÜNLÜĞÜ

### A4/C6 — Model outcome feedback ✅ (2026-09-23)

**Sorun (ölçüldü):** `ModelCapabilityRegistry.recordOutcome()` ve
`AdaptiveRouter.recordOutcome()` ikisi de vardı, ama execution yolundan **hiçbiri
çağrılmıyordu**. Tüm `recordOutcome` çağrıları başka servislere
(society/decisions/counterfactual) gidiyordu. Yani router, hiç toplamadığı
kanıtlarla model sıralıyordu.

**Yapılan:**

1. `ModelOutcomeSample` tipi + `ExecutionDependencies.recordModelOutcome` —
   mevcut opsiyonel-enjekte deseniyle. Başarı sinyali **doğrulama kararı**,
   agent'ın `completed` iddiası değil; ikisi ayrı alan olarak taşınıyor.
2. Loop, doğrulamadan sonra bir kez çağırıyor; gerçek `latencyMs`, `tokens`,
   `costUsd`, `attempt` ve `decisionId` ile. Kayıt başarısız olursa görev
   başarısız olmuyor ama kayıp `observations`'a yazılıyor (sessiz delik yok).
3. `select()` artık `decisionId` döndürüyor → `selectModel` closure'ı onu
   taşıyor → sonuç o karara bağlanıyor. Önceden `AdaptiveRouter`'a giden yol
   yoktu çünkü karar id'si dışarı çıkmıyordu.
4. `engine.ts` iki kayıt defterine de bağlıyor + `model.outcome.recorded` olayı.

**Yol üstünde bulunan ikinci kusur:** `recordOutcome` içinde `if (!p) return;`
vardı — profili olmayan modelin sonucu **sessizce atılıyordu**. Hiç
kullanılmamış modelin profili olmadığı için **ilk ölçüm hep çöpe gidiyor**,
dolayısıyla döngü kendi kendine hiç başlayamıyordu. Artık ilk gerçek istekten
bootstrap ediliyor; bilinmeyen alanlar (`contextWindow`, `capabilities`)
**uydurulmuyor**, absent kalıyor.

**Ölçülen kanıt:**

| | önce | sonra |
|---|---|---|
| `capabilityRegistry.measuredModels` | 0 | **1** |
| profil | yok | `mock:mock-model-1`, istek 1, latency 48 ms, `contextWindow: undefined` |
| `adaptiveRouter.avgLatency` | 0 | **49 ms** |
| `adaptiveRouter.successRate` | 0 | **0** (görev `unverified` → doğru) |

`successRate`'in 0 kalması kritik: görev "tamamlandı" ama doğrulanamadı ve
**başarı sayılmadı**.

**Duyarlılık:** iki düzeltme birlikte kapatılınca **7 failed**; geri konunca 8/8.

**Doğrulama:** `BUILD` 0 · `TSC` 0 · `docs:state` **218 dosya / 1492 case / 30
modül** · `verify:integration` **10/10** · `npm test` **exit 0, 1503 geçen, 0
failed** · OpenAPI temiz (4 curated + 711 generated).

**Sıradaki:** A8 (gerçek kriptografik imza), A11 (durum dokümanları), A9 (kalan
typed errors), A10 (maturity derinliği) — sonra **B3 (gerçek planner)**.

### A8 — Gerçek kriptografik extension signing ✅ (2026-09-23)

**Sorun (ölçüldü):** `signExtension` imza olarak `randomUUID()` üretiyordu ve
`verifySignature` `return !!extension.signature` yapıyordu — yani **herhangi
boş-olmayan string doğrulanıyordu**, az önce yazılan rastgele UUID dahil. Red
edemeyen imza, imza değildir.

**Yapılan:**
- `canonicalJson()` — her derinlikte anahtarları sıralayan deterministik
  serileştirme. **İlk denemede `JSON.stringify(v, keys.sort())` kullandım ve bu
  yanlıştı:** dizi-replacer her seviyede anahtar filtrelediği için `manifest`'in
  iç alanları payload'dan düşüyordu. Ölçüldü: `manifest.entrypoint`'i
  değiştirmek doğrulamayı **bozmuyordu**. Doğru kanonikleştirme yazıldı.
- Ed25519 imza (`sign(null, payload, key)`), SHA-256 payload hash'i,
  `ExtensionSignature` kaydı.
- Trust root: `generateSigningKey()`, `addTrustRoot()` (Ed25519 olmayanı
  reddeder), `revokeSigningKey()`. Özel anahtar **hiç saklanmıyor**, bir kez
  dönüyor.
- `verifySignature` artık: kayıtlı + revoked-olmayan anahtar + payload hash
  eşleşmesi + gerçek kriptografik doğrulama.
- Revoked anahtarla **imzalama** da reddediliyor (test bunu yakaladı: önce
  imzalanıp doğrulamada patlıyordu).

**Not:** repoda `security/manifest-trust.ts` zaten doğru Ed25519 doğrulaması
yapıyordu (`verify(null, …)`). Yani doğru desen mevcuttu, `agent-sdk-service`
istisnaydı.

**Duyarlılık:** eski davranış (`!!signature`) geri yüklenince **3 failed**;
geri konunca 12/12. Test 12 vaka: imzalama/doğrulama, **tampering**, unsigned,
legacy string, revoked, bilinmeyen extension, `allowUnsigned`, güvenilmeyen
anahtar, Ed25519-olmayan trust root, dış anahtar.

### A9a — Typed errors: doğrulama kodları (22 → 18 dormant) ✅ 4 kod (2026-09-23)

**Sorun (ölçüldü):** Fastify doğrulama bloğu her durumda `HAF-2001` ("body")
dönüyordu. Query string'i bozuk olan istemciye "body'n yanlış" deniyordu. Dört
kod kayıtta vardı, hiçbiri üretilmiyordu.

**Yapılan:** `error.validationContext` (`'body' | 'headers' | 'params' |
'querystring'` — Fastify tipinden doğrulandı) doğru koda eşleniyor; ayrıca
`FST_ERR_CTP_INVALID_MEDIA_TYPE` → **415 HAF-2006**.

**Cırcır çalıştı:** `error-code-registry.test.ts` artık üretilen 4 kodu
yakalayıp testi düşürdü ("the list is meant to shrink") — Faz 4b'de tasarlanan
mekanizma tam öngörüldüğü gibi davrandı. 4 girdi DORMANT'tan çıkarıldı.

**Ölçülen ayrıntı:** `text/plain` ile 415 **alınmıyor**, çünkü Fastify onu
varsayılan olarak parse ediyor ve şema doğrulaması önce davranıyor (400/HAF-2001
— doğru ama başka vaka). Gerçek 415 için parse edilmeyen tür gerekiyor
(`application/xml` → 415 HAF-2006, ölçüldü).

**Duyarlılık:** eşleme kaldırılınca **3 failed**; geri konunca 6/6.

**Kalan 18 dormant:** `AUTH_SESSION_NOT_FOUND`, `AUTH_SESSION_EXPIRED`,
`AUTH_INSUFFICIENT_ROLE`, `AUTH_SYSTEM_ADMIN_REQUIRED`, `AUTH_OIDC_ERROR`,
`SESSION_ALREADY_CLOSED`, `SESSION_LIMIT_EXCEEDED`, `SESSION_EXECUTION_FAILED`,
`AURORA_INITIATIVE_ERROR`, `AURORA_EVOLUTION_ERROR`, `AURORA_COGNITIVE_ERROR`,
`AURORA_THOUGHT_ERROR`, `PLATFORM_CONNECTION_FAILED`, `PLATFORM_RATE_LIMITED`,
`PLATFORM_QUOTA_EXCEEDED`, `RESOURCE_QUOTA_EXCEEDED`, `SYSTEM_DEPENDENCY_FAILED`,
`SYSTEM_MAINTENANCE`.

**A8+A9 sonrası doğrulama:** `BUILD` 0 · `TSC` 0 · `docs:state` **220 dosya /
1510 case / 30 modül** · `verify:integration` **10/10** · `npm test` **exit 0,
1521 geçen, 0 failed** · OpenAPI temiz (4 curated + 711 generated).

### A9b — Typed errors tamamlandı: 18 → 0 dormant ✅ (2026-09-23)

**Sorun (ölçüldü):** 18 kayıtlı kod hiç üretilmiyordu. Yani API, göndermediği
yanıtları belgeliyordu.

**Motor tarafı — yeni tiplenmiş hatalar** (`packages/engine/src/runtime/session-errors.ts`,
yeni dosya; `supervisor.ts` yeniden export ediyor, public API değişmedi):

| Hata | Koşul | HTTP |
|---|---|---|
| `SessionNotRunnableError` | kapalı / duraklatılmış / arşivlenmiş oturum | 409 HAF-3002 |
| `SessionLimitError` | fan-out sınırı (`depth` \| `concurrency` \| `lifetime`) | 429 HAF-3003 |
| `SessionBudgetExceededError` | harcama/t token tavanı aşıldı (verdict ile) | 429 HAF-3004 |
| `ChannelDeliveryError` | giden platform teslimi (`rejected` \| `rate-limited` \| `quota-exceeded` \| `connection-failed`) | 429/429/502 |

**Bulunan gerçek kusur (plan yoktu, ölçüm ortaya çıkardı):** kapalı bir oturum
**aynı süreçte yeniden diriliyordu.** `closeSession` aktörü haritadan silip
lease'i bırakıyor; bir sonraki komut `getActor`'da kalıcı durumu `"recovering"`
yapıp `initialize()` ile `"idle"`a çekiyordu — prompt çalışıyordu. Ölçüldü:
`PROMPT_RESULT {"status":"completed"}`. Düzeltme sonrası:
`{"status":"rejected","error":{"code":"SESSION_NOT_RUNNABLE","sessionState":"closed"}}`.
`getActor` artık kapalı oturumu **okumak için** kuruyor: durum korunuyor,
generation artmıyor, lease alınmıyor, `initialize` çağrılmıyor.

**Komut reddi bir sonuçtur, throw değil:** `CommandResult.error` artık opsiyonel
`sessionState` taşıyor ve actor `SESSION_NOT_RUNNABLE` kodunu üretiyor. Route
(`POST /v1/sessions/:id/commands`) bunu 409'a çeviriyor — önceden 200 dönüyordu.

**control-api tarafı:**
- **`src/auth/auth-guards.ts` (yeni):** `main.ts`'ten çıkarıldı. 5 kod:
  `AUTH_SESSION_NOT_FOUND`, `AUTH_SESSION_EXPIRED`, `AUTH_SYSTEM_ADMIN_REQUIRED`,
  `AUTH_INSUFFICIENT_ROLE`, `AUTH_CSRF_INVALID`. Hepsi `AppError` ile fırlatılıyor
  (inline `reply.send` merkezi handler'ı atlıyordu).
- **`IdentityService.lookupSession` + `EncryptedSessionStore.peek`:** "süresi
  dolmuş çerez" ile "çerez yok" artık ayrışıyor; `peek` kaydı silmiyor, yani
  koşul gözlemlenebilir kalıyor.
- **`src/routes/aurora-service-errors.ts` (yeni):** `onRoute` kancası, URL →
  servis eşlemesi tek tabloda (`/v1/initiative`, `/v1/evolution`, `/v1/cognitive`).
  `ZodError` ve `AppError` olduğu gibi geçiyor.
- **`src/middleware/maintenance.ts` (yeni):** gerçek bakım modu → 503 HAF-8005;
  `/health` ve toggle erişilebilir kalıyor. `GET/POST /v1/system/maintenance`.
- **`SYSTEM_DEPENDENCY_FAILED`:** `cause` zincirinde soket kodu (`ECONNREFUSED`,
  `ETIMEDOUT`, …) → 502. Mesaj metninden değil, koddan.

**Kayıttan silinen 2 kod** (üretemeyen koşul yok, uydurmak yerine silindi):
- `AURORA_THOUGHT_ERROR` — hiçbir HTTP yüzeyi düşünce işlemeyi çağırmıyor
  (`engine.thoughtCore` / `engine.backgroundThinking` yalnız yaşam döngüsünden).
- `RESOURCE_QUOTA_EXCEEDED` — motorda hiçbir kaynak kotası uygulanmıyor.

**Duyarlılık (9 geri alma, hepsi testi düşürdü):** API tarafı 6/4/1/2/2 failed ·
motor tarafı 2/1/4/1 failed · geri konunca **32/32** ve **45/45**.

**Ölçülen sonuç:** kayıtlı **45** kod, **0** dormant (script ile sayıldı).
Yeni testler: `session-typed-errors` 7 · `channel-delivery-errors` 7 ·
`session-and-platform-error-codes` 8 · `auth-guard-codes` 7 ·
`aurora-service-error-codes` 5 · `maintenance-mode` 5 = **39 yeni test**.

**A9b sonrası tam zincir:** `build --workspaces` **0** · `typecheck` (tüm repo)
**0** · `docs:state` **226 dosya / 1549 case / 30 modül** · `release:prepare`
**0** · `verify:integration` **10/10** · OpenAPI **0** (844 kayıt, 4 curated +
711 generated) · `npm test` **exit 0, 1560 geçen, 0 failed (226 dosya)**.

### A5 — Task-local cognitive state: flat-field artığı kaldırıldı ✅ (2026-09-23)

**Sorun (ölçüldü):** `CognitiveState`'te iki ayrı kayıt vardı: görev başına
slot'lar **ve** bağımsız yazılan flat alanlar (`activeGoal`, `activePlan`).
`setActiveGoalFor(taskId, goal)` slot'a yazıp **koşulsuz** flat alanı da
eziyordu. İki plan aynı anda çalışınca flat görünüm "hangi `await` son
döndüyse o" oluyordu — sıraya bağlı, keyfi.

**Yapılan:**
- `focusedTaskId` eklendi; `beginTask` odağı yeni göreve taşıyor, `endTask`
  biten görevden **en yeni çalışana** kaydırıyor (kimse çalışmıyorsa `null`).
- **`refreshFlatView()`** flat alanları odak slot'undan **türetiyor**. Artık
  `activeGoal`/`activePlan`'ın tek yazıcısı var ve bu yazıcı adlandırılmış bir
  görevden kopyalıyor.
- Slot setter'ları mirror'ı bıraktı: `setActiveGoalFor` yalnız odak göreviyse
  flat görünümü tazeliyor → arka plandaki bir görev, operatörün baktığı hedefi
  değiştiremiyor.
- **`setActiveGoal` / `setActivePlan` silindi** (deprecated değil): "kimin
  hedefi olduğunu söylemeden 'the' active goal ilan etmek" tam da slot'ların
  kaldırdığı belirsizlikti. Motorda çağıranı yoktu (grep ile doğrulandı).
- `focusedTask(): string | null` eklendi → flat görünümün **kimin** olduğu
  artık sorulabilir.
- `UnifiedCognitiveLoop.execute` artık `beginTask(traceId, tenantId)` /
  `endTask(traceId)` çağırıyor ve hatalarını `recordFailureFor(traceId, …)` ile
  kendi slotuna yazıyor. Önceden tüm hatalar tek global listede, hiçbir göreve
  bağlı değildi.
- `PlanningEngine.plan` ve `engine.ts`'teki bayat yorumlar ("flat fields are
  still mirrored underneath") gerçeğe güncellendi.

**Değişmeyen:** `recordFailure` global `lastFailure`/`failureHistory`'yi
yazmaya devam ediyor — "en son ne bozuldu?" gerçek bir soru. Değişen, hatanın
aynı zamanda adlandırılmış bir göreve bağlanması.

**Test:** `test/cognitive-state-isolation.test.ts` yeniden yazıldı (**15 test**).
İlk `describe` bloğu eski kusuru "belgeliyordu" ve artık var olmayan API'yi
çağırıyordu; yeni hali türetilmiş görünümün kurallarını ölçüyor: odak kim,
arka plan görevi odağı çalamaz, biten görevden odak kayar, kimse çalışmıyorsa
flat alan dürüstçe `null`.

**Duyarlılık:** mirror geri konup odak kaydırma kaldırılınca **2 failed**;
geri konunca **15/15**.

**A5 sonrası tam zincir:** `typecheck` (tüm repo) **0** · `build --workspaces`
**0** · `npm test` **exit 0, 1563 geçen, 0 failed (226 dosya)** · `docs:state`
**226 dosya / 1552 case / 30 modül** · `release:prepare` **0** ·
`verify:integration` **10/10** · OpenAPI **0**.

### A6 — Recovery idempotency ✅ (2026-09-23)

**Sorun 1 (kod okunarak doğrulandı):** capability acquisition **idempotent
değildi.** `capability-synthesis.ts:175` → `const id = randomUUID()`. Yürütme
döngüsü `acquireCapability`'ı recovery yolundan çağırıyor
(`unified-execution-loop.ts:937`), yani aynı gap için birden çok kez
sorulabiliyor. Her deneme **yeni bir capability** sentezleyip kaydediyor ve
zaten kayıtlı olan kararı yeniden almak için sandbox'ı bir kez daha
çalıştırıyordu.

**Sorun 2 (kod okunarak doğrulandı):** yan etki anahtarı **çağrı başınaydı,
etki başına değil.** `session-actor.ts:826` → `idempotencyKey:
`${command.commandId}:${call.id}`` — ikisi de her denemede taze. Effect journal
(`persistence/effect-journal.ts`) bu anahtarla zaten tekilleştiriyor, ama
anahtar her seferinde yeni olduğu için tekrarlanan bir etkiyi **hiçbir zaman**
tanıyamıyordu.

**Yapılan:**
- **`TaskContext.effectKey(scope)`** (yeni): `task:{taskId}:{attempt}:{sha256(canonicalJson(scope))[:32]}`.
  Tasarımın tamamı kapsamdaki `attempt`:
  - **deneme içinde** aynı etki iki kez uygulanamaz (çökme/belirsiz sonuç
    sonrası yeniden oynatmayı koruyan şey bu),
  - **denemeler arasında** uygulanabilir, çünkü 2. deneme farklı bir karardır.
    Denemeler arası tekilleştirme, bilinçli bir ikinci denemeyi sessizce
    no-op'a çevirirdi — ters yöndeki ve fark edilmesi daha zor olan hata.
- **`util/canonical-json.ts`** (yeni, paylaşılan): anahtar sıradasından
  bağımsız deterministik serileştirme. İki modülde zaten özel kopyası vardı;
  array-replacer tuzağı yorumda kayıtlı.
- **`AuroraCognitiveRuntime.acquireCapability`** artık içerik hash'i ile
  memoize: aynı `name/description/code/testInput/expectedOutput` → **kayıtlı
  cevap döner**, yeniden sentezlenmez. `CapabilityAcquisitionResult.replayed`
  bayrağı eklendi. **Reddedilmiş sonuç da replay ediliyor** — kimsenin
  istemediği bir "ikinci şans" vermek fabrication olurdu. Replay
  `capability.acquisition.replayed` olayı olarak denetim izine yazılıyor.

**Test:** `test/recovery-idempotency.test.ts` (**8 test**) — effectKey
kararlılığı/sıra bağımsızlığı/iç içe alanlar/deneme ve görev ayrımı · gerçek
`AuroraCognitiveRuntime` + gerçek sandbox ile replay (aynı `capabilityId`,
`replayed: true`, `totalCapabilities` **1 artıyor**, reddedilmiş sonuç da
replay, farklı istek ayrı sentez).

**Duyarlılık:** memoizasyon kaldırılınca **2 failed**; geri konunca **8/8**.

**A6 sonrası tam zincir:** `typecheck` (tüm repo) **0** · `build --workspaces`
**0** · `npm test` **exit 0, 1571 geçen, 0 failed (227 dosya)** · `docs:state`
**227 dosya / 1560 case / 30 modül** · `release:prepare` **0** ·
`verify:integration` **10/10** · OpenAPI **0**.

### A7 — Fail-closed screening: davranış doğru, sınıflandırma yanlıştı ✅ (2026-09-23)

**Plan ne diyordu:** "broker'da `invokeGuard` throw ederse capability
çalışmıyor — kısmen". **Ölçülen gerçek:** `hook-bus.ts:87` `invokeGuard`
zaten **fail-closed**: guard throw ederse veya timeout olursa `deny` dönüyor
("guards are synchronous-at-boundary and fail-closed"). Yani davranış
doğruydu; **testi yoktu**, yani hiçbir şey onu tutmuyordu.

**Asıl kusur (ölçüldü):** tüm reddiyeler düz `Error`'dı ve ayırt eden tek şey
cümlenin kendisiydi. `classifyFailure` desenle sınıflandırıyor; `security_block`
kuralları `/blocked by policy/i`, `/kill switch/i`, `/forbidden by guard/i`.
Broker'ın kendi mesajları bunların **hiçbirine** uymuyordu. Ölçüm:

| Eski mesaj | `classifyFailure` |
|---|---|
| `A security plugin denied demo.write.` | `fundamental_unknown` |
| `Security hook … failed closed: …` | `fundamental_unknown` |
| `Policy denied demo.write: …` | `fundamental_unknown` |
| `Approval denied for demo.write.` | `fundamental_unknown` |

**4 reddiyenin 4'ü de tanınmıyordu.** Sonucu: `security_block` → `abort`
("Retrying would be an attempt to bypass it") yerine `fundamental_unknown` →
`ask_human` ("The failure could not be classified"). Döngü reddedilen eylemi
yeniden denemiyordu (yani açık bir bypass yok), ama operatöre **yanlış soru**
gidiyordu: "güvenlik kapısı reddetti" yerine "sınıflandırılamadı".

**Yapılan:**
- **`CapabilityDeniedError`** (yeni, `capabilities/capability-broker.ts`):
  `capabilityId` + `source: "security-guard" | "policy" | "approval"` +
  `details`. Üç ret noktası da (guard / policy / approval) artık bunu fırlatıyor.
- Mesajlar, taxonomy'nin **zaten tanıdığı** kanonik ifadeyi kullanıyor:
  `forbidden by guard` · `blocked by policy` · `was not permitted` (→
  `permission_gap`, çünkü onay eksikliği güvenlik bloğu değil, ayrı bir kategori).
- Fail-closed yolu **test altına alındı**: guard throw → capability hiç
  çalışmıyor + `security_block`; guard timeout (20 ms, sonsuz promise) → aynı;
  sağlıklı guard `allow` → capability çalışıyor.

**Ölçülen yeni durum:** guard → `security_block` · policy → `security_block` ·
approval → `permission_gap`.

**Güncellenen 2 mevcut test:** eski `"Policy denied"` metnini bekliyorlardı
(`adversarial-security.test.ts:37`, `aurora-policy-enforcement.test.ts:135`).
Yeni kanonik ifadeye geçirildi — ikisi de hâlâ "reddedildi" iddiasını ölçüyor,
üstelik artık hangi kapının reddettiğini de.

**Test:** `test/security-screening-fail-closed.test.ts` (**6 test**).
**Duyarlılık:** tiplenmiş reddiyeler düz `Error`'a çevrilince **5 failed**;
geri konunca **6/6**.

**A7 sonrası tam zincir:** `typecheck` (tüm repo) **0** · `build --workspaces`
**0** · `npm test` **exit 0, 1577 geçen, 0 failed (228 dosya)** · `docs:state`
**228 dosya / 1577 case / 30 modül** · `release:prepare` **0** ·
`verify:integration` **10/10** · OpenAPI **0**.

### A10 — Maturity derinliği: ölçüm aracı kendini test ediyor, `stable` kanıt istiyor ✅ (2026-09-23)

**Plan ne diyordu (`uploads/…:103-108`):** "Maturity seviye algoritmasını
derinleştir … başarısız çağrıyı `exercised` sayma … ölçüm tool'u kendi
ölçümünü doğrulayan bir self-test içersin."

**Ölçülen gerçek — üç ayrı kusur, hepsi komutla doğrulandı:**

1. **Başlık satırı başarısız çağrıyı iş sayıyordu.** `observe-runtime-cli.ts`
   derinliği yalnız V8 coverage'dan çıkarıyordu:
   `during.length > 0 ? "exercised" : …`. Araç bunu *biliyordu* ve sadece
   uyarı basıyordu ("A module can be listed as exercised above while its only
   calls failed"), ama manşeti düzeltmiyordu: "N modules did work" cümlesi
   yanlış kalıyordu.
2. **Aracın kendi kararı testsizdi.** `classifyOutcomes` için test vardı,
   derinlik kararı için yoktu — yani "exercised" ile "failed" ayrımını kimse
   tutmuyordu.
3. **`production` beyandan üretiliyordu.** `state-docs-cli.ts` `levelOf()`
   şöyleydi: `entry.level === "stable" ? "production" : "verified"`. Yani
   merdivenin en üst basamağı elle yazılmış bir alanın sonucuydu. Ölçülen:
   `memory/real-memory-pipeline` satırı `production` diyordu; gerekçesi
   `eval:recall` — ki o bu reponun içinde recall ölçüyor. O `verified`,
   `production` değil.

**Yapılan:**

- **`judgeDepth` (saf, test edilebilir).** Coverage + broker sonucu birlikte
  karar veriyor. Bir modülün **kendi** capability'lerinin **tümü** başarısızsa
  derinlik `failed`, `exercised` değil. Dar tutuldu: tek bir başarılı çağrı
  "çalışıyor" demek için yeter; outcome kanıtı olmayan modül düşürülmüyor
  (modüllerin çoğu broker'dan geçmiyor, "kanıt yok" ≠ "başarısız").
- **`capabilityModules()`** capability id → modül eşlemesini **kaynaktan
  okuyor** (`capabilities/*.ts` içindeki `id:` alanları), elle tutulan bir
  harita değil. Ölçüldü: `embodiment.fs.info → capabilities/embodiment`,
  `filesystem.write → capabilities/filesystem`.
- **`ObservationDepth`'e `failed` eklendi** + `observationSummary().failed`.
- **`selfCheck()`** her `observe:runtime` koşusunda aracın kendi kararını
  yeniden üretiyor: eşleme hâlâ doğru mu, tümü-failed modül hâlâ
  düşürülüyor mu, kanıtsız modül hâlâ düşürülmüyor mu. Bozuksa
  **exit 1** ve "this measurement is not trustworthy".
- **`effectiveLevelOf` / `evidenceLevelOf` / `stableWithoutProductionEvidence`
  (`maturity.ts`).** Kural: **`stable` üretim kanıtı ister.** Testi olan ve
  çağrılan modül "kurulmuş ve erişilebilir"dir, o `beta`. Kayıt
  *yeniden yazılmadı*: beyan duruyor, kanıtın desteklediği seviye yanında
  raporlanıyor — aradaki fark bulgunun kendisi, 6 etiketi sessizce `beta`
  yapmak onu gizlerdi. `evidenceLevelOf` ölçümden türüyor
  (`observationOf(...).depth === "exercised"`), elle yazılamıyor.
- **`state-docs-cli.ts` `levelOf()`** artık `effectiveLevelOf(entry) === "stable"`
  istiyor. Sonuç ölçüldü: `memory/real-memory-pipeline` matriste
  **`production` → `verified`**, matriste **0** `production` satırı kaldı.

**Ölçülen sayılar (probe ile, sonra silindi):** 30 modül · beyan
**6 stable / 18 beta / 6 experimental** · gözlem **28 exercised / 0 failed /
2 constructed** · kanıt **28 verified / 2 unproven** · üretim kanıtsız stable
**6** → **effective: 0 stable / 24 beta / 6 experimental**. Yani bugün
hiçbir modül `stable` demeye yetecek kanıta sahip değil; `productionEvidence`
alanı boş ve boş kalması dürüst.

**Duyarlılık (geri almalı, üçü de ölçüldü):**

| Sabotaj | Sonuç |
|---|---|
| `OBSERVE_BREAK_ATTRIBUTION` ile eşleme boşaltıldı | `observe:runtime` **exit 1**, "attribution broke: filesystem.write -> undefined" + "a module whose only call threw was called \"exercised\"" |
| `effectiveLevelOf` yalnız beyanı döndürdü | `maturity-registry.test.ts` **2 failed** (15'ten) |
| `evidenceLevelOf` ölçmeden `"verified"` dedi | `maturity-registry.test.ts` **1 failed** |
| `levelOf` eski `entry.level === "stable"` hâline döndü | `state-docs.test.ts` **3 failed** (21'den) |

Hepsi geri kondu: `diff -q` **RESTORE_OK**, sabotage izi **0**, testler
**15/15**, **21/21**, `observe:runtime` **exit 0**.

**Yeni testler: 12** (`runtime-observation.test.ts` 10→16,
`maturity-registry.test.ts` 10→15, `state-docs.test.ts` 20→21).

**A10 sonrası tam zincir:** `typecheck` (tüm repo) **0** · `build --workspaces`
**0 TS hatası** · `npm test` **exit 0, 1589 geçen, 0 failed (228 dosya)** ·
`docs:state` **228 dosya / 1578 case / 30 modül** · `release:prepare` **0** ·
`verify:integration` **10/10** · OpenAPI **844 kayıt**.

**Not (dürüstlük):** `docs:state` "declared" sayısını `^\s*it\(` ile sayıyor ve
bu bir **alt sınır** — kendisi de öyle yazıyor ("the runner remains the
authority"). 1578 declared / 1589 runner farkı bu turun işi değil; kaynağı
ölçüldü: `cloud-sandbox` +4, `state-docs` +6, `version` +1 (tablo/dinamik
testler).

**Ayrıca düzeltilen yanlışım:** A7 kaydına `docs:state` için **1566** yazmışım;
bu tur aynı komutla ölçülen değer **1577**'ydi. Kayıt düzeltildi.

### A11 — Durum dokümanları: bant denetimi elle tutulan listeden kurtarıldı ✅ (2026-09-23)

**Plan ne diyordu (`uploads/…:110-115`):** "Elle yazılmış eski MD'leri arşiv veya
redirect yap … ölçülemez/eski iddiaları authoritative dokümandan çıkar … Her
sayısal iddia komut/rapor kaynağına bağlansın."

**Ölçülen gerçek — bant denetimi geçiyordu ama liste elle tutuluyordu.**
`scripts/verify-integration.mjs` içindeki kontrol **10 dosyalık sabit bir
dizi**ydi ve `verify:integration` **10/10 PASS** veriyordu. Aynı ağaçta bandı
olmayan **5** durum dokümanı vardı, üçü `docs/` içinde — yani kontrol adını
saydığı on dosyayı doğruluyordu, on birinciyi hiç görmüyordu. Tıpkı A7'deki
durum gibi: davranış değil, **onu tutan şey** eksikti.

Bandı olmayan 5 dosya ve ölçülen iddiaları:

| Dosya | İddia |
|---|---|
| `SECURITY-FIXES.md` | "✅ Tüm P0, P1 ve P2 sorunları çözüldü", "24/24", `production-ready` |
| `PHASE6-FEATURES.md` | "✅ Tüm 15 özellik eklendi ve entegre edildi", "196 tests" |
| `GÜÇLENDİRME-ÖZELLİKLERİ.md` | "563 endpoint, 46 yetenek, 19 UI panel" |
| `docs/upstream-gap-audit-2026-08-18.md` | "236 tests", "255 tests", "175 tests passed" |
| `../NIHALSI_ICIN_EKSIKLER_VE_GELISTIRMELER.md` | "production-ready hale gelir", "%50 tamamlanmış" |

**Deseni dar tutmak için ölçülen iki yanlış-pozitif** (ikisi de komutla
doğrulandı, ikisi de desenin dışında bırakıldı):

- `\d{3,} satır` → `docs/reference-analysis.md` (2.732 satırlık analiz) **10
  "iddia"** veriyordu; oysa "App.tsx 1196 satır" bir dosya betimlemesi, durum
  iddiası değil.
- `tamamlandı` → `docs/API.md:265`'te `task:completed` olayının açıklaması
  "Görev tamamlandı". Büyük harfli `TAMAMLANDI` biçimi istenince başlık
  yakalanıyor, düz cümle yakalanmıyor.

**Yapılan:**

- **`handWrittenStatusDocs()`**: liste artık **türetiliyor** — `.` , `docs/`,
  `..` taranıyor, üretilmiş dokümanlar (`Generated: … docs:state`) ve bandı
  olanlar atlanıyor, kalanlardan durum iddiası taşıyanlar raporlanıyor.
  Sabit dizi silindi.
- **5 dosyaya bant eklendi** → bannerlı MD **10 → 15** (ölçüldü). Bant metni
  mevcut şablondan alındı; içinde ölçülebilir sayı yok, yani kendisi
  bayatlamıyor.
- **Yetkili dokümandaki bayat kural tanımı düzeltildi (A10'un bıraktığı iz).**
  A10 `levelOf`'u değiştirmişti ama `CURRENT_STATE.md` hâlâ
  "`production` = Verified **and** rated `stable` in the maturity register"
  diyordu — yani **kodun artık uygulamadığı kuralı** anlatıyordu. Plan tam
  bunu istiyor: "eski iddiaları authoritative dokümandan çıkar". Yeni tanım
  `productionEvidence`'ı söylüyor; `state-docs.test.ts`'e bunu tutan assertion
  eklendi.
- **README'nin kaynaksız sayıları etiketlendi.** "76 new API endpoints" ve
  "24 issues resolved (7 P0, 13 P1, 4 P2)" hiçbir komuttan gelmiyordu; ölçüldü:
  elle yazılmış `PHASE6-FEATURES.md:46` ve `SECURITY-FIXES.md:181`'den
  kopyalanmış. Silinmediler (tarihî kayıt), ama "hangi kaynaktan geldiği ve
  hiçbir komutun bunları üretmediği" yazıldı — planın "her sayısal iddia
  komut/rapor kaynağına bağlansın" maddesi.

**Duyarlılık (geri almalı, ikisi de ölçüldü):**

| Sabotaj | Sonuç |
|---|---|
| `docs/API.md` sonuna `production-ready, 999 endpoint` satırı eklendi | `verify:integration` **exit 1**, "no staleness banner: docs/API.md (claims e.g. \"production-ready\")" |
| `production` tanımı eski hâline döndürüldü | `state-docs.test.ts` **2 failed** (21'den) |

İkisi de geri kondu: `diff -q` **RESTORE_OK**, probe izi **0**, `verify:integration`
**10/10**.

**Ara not (dürüstlük):** bu turun ortasında `node_modules` sıfırlanmıştı;
`npm run build` **exit 127 / "tsc: not found"** verdi ve `verify:integration`
"engine is not built" diye 2 kontrol düşürdü. `npm install` (654 paket) sonrası
zincir yeniden kuruldu. Ayrıca `npm run build -w A -w B` **çalışmıyor**
(127) — workspace'ler ayrı ayrı verilmeli.

**A11 sonrası tam zincir:** `typecheck` (tüm repo) **0** · `build --workspaces`
**0 TS hatası** · `npm test` **exit 0, 1589 geçen, 0 failed (228 dosya)** ·
`docs:state` **228 dosya / 1578 case / 30 modül** · `release:prepare` **0** ·
`verify:integration` **10/10** · OpenAPI **844 kayıt**.

### B3 — Gerçek task-specific planner: model önce, keyword iskeleti kayıtlı yedek ✅ (2026-09-24)

**Plan ne diyordu (P1.3):** "Keyword skeleton planner'dan model-backed veya
hybrid planner'a geç. Goal decomposition. Dependency graph / DAG. Parallelizable
steps. Preconditions/postconditions. Expected outputs. Verifiers per step.
Cost/time budget. Risk score."

**Ölçülen gerçek — planner diye bir şey yoktu, bir şablon vardı.**
`PlanningEngine.decomposeGoal()` (`aurora/unified-engines.ts`) adım adlarını
**sabit bir kümeden** veriyor: `Understand, [Research], [Design], [Simulate],
Execute, Verify, Learn`. Hedef metni yalnız ortadaki üçünden hangilerinin
görüneceğine karar veriyor, hem de `g.includes("create")` gibi alt-dizi
testleriyle. Her `estimatedMs` ve her `risk` **literal**.

İki hedefle ölçtüm (test olarak da sabitledim):

| Hedef | Adımlar | `Execute` bütçesi |
|---|---|---|
| "Create a file called hello.txt…" | Understand, Design, Execute, Verify, Learn | **20.000 ms** |
| "Create a distributed consensus system that survives a Byzantine partition across nine regions" | **birebir aynı** | **10.000 ms** |

Yani zor olan hedef **yarı zaman** alıyor; sebebi `execTime = needsCoding ?
20000 : goal.length > 500 ? 15000 : 10000` — bir alt-dizi testi ve bir karakter
sayısı, tahmin yerine geçiyor. (Önce "bütçeler de aynı" yazmıştım; ölçünce
yanlış çıktı, tablo ölçülen değerlerle düzeltildi.)

**Yapılan:**

- **`aurora/task-planner.ts` (YENİ).** `TaskPlanner.plan()` modeli gerçekten
  soruyor (`models.stream` + text_delta toplanıyor), cevabı doğruluyor, olmazsa
  keyword iskeletine düşüyor.
- **Kayıt tutuluyor:** `TaskPlanDraft.source = "model" | "fallback"` +
  `fallbackReason` + `modelRoute`. `PlanningResult`'a da taşındı, yani
  `/v1/planning/plan` cevabı artık **hangi planner'ın çalıştığını söylüyor**.
  Motorun kendi yorumu zaten uyarıyordu: "do not read a populated `context.plan`
  as evidence of deep planning" — artık okumaya gerek yok, alan var.
- **Doğrulama işin kendisi, formalite değil** (`validatePlanSteps`): döngü,
  kendini bağımlılık, bilinmeyen bağımlılık, ileriye bağımlılık, tekrarlanan
  adım adı, boş ad/açıklama, bilinmeyen `risk` etiketi, adım sayısı tavanı,
  adım-başına ve toplam süre tavanı. Model güvenilmez girdi; kenarları burada
  reddediliyor, üç faz sonra durmuş bir adım olarak değil.
- **`parallelWaves()`**: paralellik **ölçülüyor** — elmas plan `[["a"],["b","c"],["d"]]`,
  zincir plan dalga başına 1 adım (yani övünecek paralellik yok).
- **`keywordDecomposition()`** public sarmalayıcı: iskelet silinmedi, tek
  implementasyon olarak kaldı ve yedek yolu buradan besleniyor.
- **`/v1/planning/plan`** `sessionId` kabul ediyor (model çağrısı
  ilişkilendirilebilsin). `modelRoute` **bilerek kabul edilmiyor** — route
  seçmek politika altında router'ın işi, çağıranın değil.

**Kapsam dışı bırakılan (dürüstlük):** adımları yürütmek **B4**, adım başına
`expectedOutput`'u gerçekten kontrol etmek **B6**. Bu modül plan üretiyor ve
doğruluyor; yürüttüğünü iddia etmiyor.

**Test: 21 yeni** (`test/task-planner.test.ts`). Gerçek motorla iki test var:
biri `engine.taskPlanner`'ın `TaskPlanner` olduğunu ve mock provider ile
`source: "fallback"` + gerekçe döndüğünü ölçüyor (mock düz metin veriyor, dürüst
sonuç bu), diğeri keyword iskeletinin iki farklı hedefe aynı adımları verdiğini
sabitliyor.

**Duyarlılık (geri almalı, ikisi de ölçüldü):**

| Sabotaj | Sonuç |
|---|---|
| `plan()` modele hiç sormadan yedeğe düştü | **5 failed** / 21 |
| Bilinmeyen-bağımlılık kontrolü kapatıldı (`if (false)`) | **1 failed** |

İkisi de geri kondu: `diff -q` **RESTORE_OK**, iz **0**, testler **21/21**.

**B3 sonrası tam zincir:** `typecheck` (tüm repo) **0** · `build --workspaces`
**0 TS hatası** · `npm test` **exit 0, 1610 geçen, 0 failed (229 dosya)** ·
`docs:state` **229 dosya / 1599 case / 30 modül** · `release:prepare` **0** ·
`verify:integration` **10/10** · OpenAPI **844 kayıt** · `observe:runtime`
**exit 0**, 28/30, **Self-check passed**.

### B4 — Plan gerçekten yürüyor: yürüyüş dalga dalga, her adım kanıt taşıyor ✅ (2026-09-24)

**Plan ne diyordu (P1.4):** "Plan adımlarını yalnız prompt'a koyma; runtime
bunları gerçekten yürütmeli. Step status … Step başına evidence … Partial
completion."

**Ölçülen gerçek — iki ayrı kusur, ikisi de probe ile doğrulandı.**

Üç adımlı bir zincir (`a → b → c`), ajan görevi tamamlamış:

```
wave1 ready:   a
after wave 1:  a=unverified  b=not_implemented  c=not_implemented
next ready:    (none)
```

1. **Runtime planı hiç yürümüyordu.** `runAgent(context)` deneme başına bir kez
   çağrılıyor, `recordStepProgress` **ondan sonra** çalışıyordu; yani adım
   durumları ajanın kendi raporunun sonradan okunmasıydı. Adımları dolaşan,
   ikincisini isteyen hiçbir şey yoktu. `engine.ts:3517`'de planın tek
   kullanımı `planned: (context.plan?.steps.length ?? 0) > 0` — bir boolean.
2. **Yürüse de 1. dalgayı geçemiyordu.** Ajan adım-başına sonuç
   bildirmediğinde hazır adımlar `unverified` işaretleniyor; `readySteps()` ise
   `isSuccess` ile kapı kuruyor ve `isSuccess` yalnız `"succeeded"`. Yani `b` ve
   `c` sonsuza dek `not_implemented`: `blocked` değil (bir şey başarısız
   olmadı), çalışmış değil. Rapor "3 step(s), 2 not attempted" diyordu — ajanın
   bitirdiği bir görev için.

**Yapılan:**

- **`execution/plan-execution.ts` (YENİ).** `nextSteps` (yürüyüşün bir
  sonraki dalgası), `advancePlan` (bir koşunun plan için ne anlama geldiğine
  **saf** karar), `prerequisiteAllowsDependants`, `walkComplete`,
  `pendingSteps`, `plannedWaves`.
- **Kural:** `unverified` bir ön koşul bağımlılarını **başlatır**. Bu
  `execution-status.ts`'in yumuşatılması değil — görevin genel durumu hâlâ
  unverified işle `succeeded` olamıyor (test var). Karar yalnız "sonraki adım
  başlayabilir mi"; başlatmamak ilk adımı doğrulanmış yapmıyor, sadece planın
  kalanını kaybettiriyor. **Başarısız** ön koşul hâlâ `blocked` üretiyor.
- **Plan görev başına bir kez üretiliyor.** Deneme başına yeniden kuruluyordu ve
  her adım `not_implemented`'a sıfırlanıyordu; ölçüldü: 3 denemeden sonra bile
  `a:unverified(att=1) b:not_implemented c:not_implemented`. Replanning gerçek
  bir özellik (**B5**) ve bitmiş adımları **kasten** korumalı; sessizce silmek o
  özellik değil.
- **`add_verification` arası artık yürüyüşe bakıyor.** "İş bitti ama doğrulayıcı
  yok, tekrarlamak doğrulanabilir yapmaz" kuralı duruyordu ve planın kalanını da
  götürüyordu. Yürüyüşte adım kaldıysa sonraki geçiş bir **tekrar değil, sonraki
  adım**.
- **Her adım kanıt taşıyor:** `TaskPlanStep.evidence` (attempt, actor, detail,
  durationMs, tokens, toolCalls, error, at) + `attempts` (deneme sayısı adım
  başına görünür). Yürüyüş iz'e de yazılıyor: `Step walk, attempt N: a=unverified, …`.
- **Doğrulanan yol korundu:** verifier `pass` derse görev biter. (Aşağıda.)

**Ölçülen sonuç (aynı zincir, aynı ajan):**

```
agentCalls=3   status=unverified   attempts=3
steps=a:unverified(att=1) b:unverified(att=1) c:unverified(att=1)
summary=… Plan: 3 step(s).
```

**Bu turda yaptığım ve tam suite'in yakaladığı hata:** doğrulanmış yolu da
yürütmeye devam ettirmiştim. `engine-execute-integration.test.ts`'te **3 test**
`succeeded` beklerken `failed` aldı — verifier `pass` dedikten sonra fazladan
denemeler recovery'ye girip görevi düşürüyordu. Geri aldım ve **regresyon testi
ekledim**: verifier geçerse tek deneme, `succeeded`, planın kalanı
`not_implemented` olarak raporda görünür. Gerekçe koda da yazıldı: *plan Aurora'nın
işi, verdict çağıranın.*

**Test: 16 yeni** (`test/plan-execution.test.ts`) + 1 mevcut test güncellendi
(eski "per-step" metnini bekliyordu; artık `unverified` + kanıt + `attempts`
doğrulanıyor).

**Duyarlılık (geri almalı, üçü de ölçüldü):**

| Sabotaj | Sonuç |
|---|---|
| Plan her denemede yeniden kuruldu | **2 failed** / 15 |
| `add_verification` arası eski hâline döndü | **2 failed** / 15 |
| `unverified` bağımlılığı yine tatmin etmedi | **4 failed** / 15 |

Hepsi geri kondu: `diff -q` **RESTORE_OK**, iz **0**.

**B4 sonrası tam zincir:** `typecheck` (tüm repo) **0** · `build --workspaces`
**0 TS hatası** · `npm test` **exit 0, 1626 geçen, 0 failed (230 dosya)** ·
`docs:state` **230 dosya / 1615 case / 30 modül** · `release:prepare` **0** ·
`verify:integration` **10/10** · OpenAPI **844 kayıt**.

**Kapsam dışı (dürüstlük):** adım başına gerçek doğrulayıcı **B6**
(`expectedOutput`'u kontrol etmek), başarısızlıktan sonra yeniden planlama
**B5**. Bugün adımlar çalışıyor ve kanıt taşıyor; "doğrulandı" diyen bir adım
yok, çünkü onu diyebilecek mekanizma B6.

### B5 — Dinamik replanning: plan bozuksa plan değişir, çalışan iş asla silinmez ✅ (2026-09-24)

**Plan ne diyordu (P1.5):** "Starting from FAIL → reason analysis → new plan →
affected subtree." Ayrıca master'ın B4 kararına atıfı vardı: "plan bir kez
kurulur" kararı B5'te bilinçli olarak değiştirilecek, **bitmiş adımlar
korunarak**.

**Ölçülen gerçek — kod yazılmadan önce probe ile doğrulandı:**

```
"The plan was invalid: circular dependency between steps"  → kind=planning_failure  strategy=replan
"The plan was empty"                                       → kind=planning_failure  strategy=replan
"I do not know which version is deployed"                  → kind=knowledge_gap    strategy=replan
"The same error happened repeatedly"                       → kind=skill_gap        strategy=replan
```

`chooseRecovery` bu üç durumda **kurulduğu günden beri** `strategy: "replan"`
döndürüyor ve `unified-execution-loop.ts`'te bu stratejiyi okuyan **hiçbir kod
yoktu**. Döngü `acquire_capability`, `change_tool`, `change_model`,
`add_verification`'ı ismen ele alıyordu; `replan` düz retry'a düşüyordu. Yani
**planın kendisinin sorun olduğu** bir göreve aynı plan tekrar tekrar veriliyordu
— bu arada recovery directive'i ajana "farklı bir yaklaşım seç" diyordu.
Söylemek yapmak değil.

**Yapılan:**

- **`mergeReplan(current, proposed)` → `ReplanResult`** (`execution/plan-execution.ts`).
  İki yarı eşit önemde: (1) **çalışmış adım aynen korunur** — status'u, evidence'ı,
  attempts'iyle; bitmiş işi temiz bir plan uğruna silmek, sistemlerin bitmiş işi
  yeniden yapıp yapmadığını ilerlediğini sandığı raporları yazma biçimidir.
  (2) **yalnız etkilenen subtree yenilenir** — hiç denenmemiş (`not_implemented`)
  adımlar düşer, yeni adımlar onların yerine geçer.
- **Redler döndürülür, fırlatılmaz, ve asla sessizce yutulmaz:** boş öneri
  ("plan yok" bir plan değil) · korunan adımın id'sini yeniden öneren plan
  (kenarlar id'yle referans verdiğinden her bağ belirsizleşir;_planner adımlarını
  adlandırmalı_) · aynı id'yi iki kez öneren plan · döngü içeren plan (hiçbir
  sırayla yürütülemez). Reddedilirse **eski plan yürürlükte kalır ve rapor bunu
  söyler** — "yeniden planladık" ile "yapamadık" farklı gerçekler.
- **Bağımlılıklar birleştirmeden sonra çözülür:** yeni adımın kenarı hayatta
  kalan bir adıma işaret ediyorsa korunur, düşene işaret ediyorsa düşürülür —
  artık var olmayan adıma işaret eden kenar, B4'ün kaldırdığı takılmanın ta
  kendisiydi.
- **Döngüye bağlandı:** `recovery.strategy === "replan"` → `deps.plan(context)`
  yeniden çağrılır, `mergeReplan` uygulanır, `task.replanned` event'i emit
  edilir (reason, kept/replaced/added listeleriyle), iz'e ve outcome'lara yazılır.
- **Tavan: `MAX_REPLANS_PER_TASK = 2`** ve sayaç `TaskContext.replans`'ta —
  kod yolundan bağımsız uçurulamaz. Kötü plan üreten bir planner'ın tüm deneme
  bütçesini planlamaya harcatmasına izin yok. Tavan dolunca outcome "already
  been replanned N time(s)" der ve mevcut planla devam eder.
- **Rapor artık plan değiştiğini söylüyor:** `replanReasons` (sırayla sebepler)
  sayacı summary'nin plan notuna ekleniyor — `Plan: 3 step(s), 1 succeeded,
  replanned 1 time(s) after planning_failure.` Sayı tek başına **nedeni**
  saklıyor; `planning_failure` ile `knowledge_gap` ikisi de replan yapar.

**Bu turda yaptığım iki hata (öğretici olanlar):**

1. **`maxAttempts`'i deps içine koydum** — o `LoopConfig`'in alanı ve kurucunun
   **ikinci** argümanı. Deps'te sessizce yok sayılıyordu; tavan testi default 3'te
   kesildiğinden "tavan çalışmıyor" sanıldı. Probe açtı: `attempts=3`,
   "Exhausted 3 recovery attempts". Testler düzeltildi; yorumda iki farklı limit
   olduğu kayıtlı (`maxAttempts` config, `budget.maxRecoveryAttempts` default 3).
2. **Summary'yi ölçmeden iddia ettim:** `report.summary` **son denemenin**
   cümlesidir; replan notu oraya kendiliğinden girmez. Çözüm beklentiyi gevşetmek
   değil, notu gerçekten oraya koymaktı — plan notu artık replan'ı taşıyor.

**Test: 12 yeni** (`test/plan-replanning.test.ts`) — 7 birim (koruma, kenar
çözümü, 4 red sebebi, adsız-planner redti) + 5 döngü (attribution'lı replan,
failed adımın kayıt olarak korunması, red kaydı, tavan, plan-suçu-olmayan
hata replan yapmaz: `ECONNREFUSED` → `retry_with_backoff`, planner 1 kez çağrılır).

**Duyarlılık (geri almalı, üçü de ölçüldü):**

| Sabotaj | Sonuç |
|---|---|
| `replan` dalı tamamen kaldırıldı (eski davranış) | **3 failed** / 12 |
| `mergeReplan` çalışmış adımları korumaz | **5 failed** / 12 |
| `MAX_REPLANS_PER_TASK = 999` | **1 failed** / 12 |

Hepsi geri kondu: `diff -q` **RESTORE_OK**, iz **0**.

**B5 sonrası tam zincir:** `typecheck` **0** · `build --workspaces` **0 TS** ·
`npm test` **exit 0 — 1638 geçen / 0 failed / 231 dosya** (kök özeti 9 vitest
bloğunun toplamı; tek blok 1373 gösterir, toplam ayrıca sayıldı) ·
`docs:state` **231 / 1627 / 30** · `release:prepare` **0** · `verify:integration`
**10/10** · OpenAPI **844**.

**Kapsam dışı (dürüstlük):** replan **ne zaman gerektiğine** karar veren hâlâ
hata sınıflandırması — plan henüz başarısız olmadan önce (ör. bütçe daralınca
kapsam küçültme) yeniden planlama **yok**; o `reduce_scope` stratejisinin işi ve
o da okunmuyor olabilirdi (sonraki taramalarda). Adım başına doğrulayıcı **B6**.

### B6 — Adım başına doğrulama: kanıt, üreten adıma bağlanır ✅ (2026-09-24)

**Plan ne diyordu (P1.6):** her adım için success criterion · build/test gibi
genel kanıtı goal-specific verification'dan ayır · verifier seçimini
otomatikleştir · V3 consensus için evaluator panelini otomatik oluştur.

**Ölçülen gerçek — kod yazılmadan önce probe ile:**

```
görev: "Create hello.txt with Hi"   goal-scoped verifier: file-hello → pass
status=succeeded verdict=pass
steps=write:unverified check:not_implemented
summary=Verified after 1 attempt(s). … Plan: 2 step(s), 1 not attempted.
```

Rapor aynı anda "dosya kontrol edildi, Hi içeriyor" (hedef düzeyi) ve "bu adım
için sonucu doğrulayacak bir şey yok" (adım düzeyi) diyordu. Kanıt var —
dosyayı yazan adıma hiç bağlanmamıştı. Üstelik planner'a `expectedOutput`
("bir verifier sonradan kontrol edebilir") açıkça soruluyor ve kriter loop'a
giden yolda **iki yerde düşürülüyordu**: `PlanningEngine.plan`'ın adım
eşlemesinde ve `engine.ts`'in `deps.plan` köprüsünde — yani hiçbir adım,
prensipte bile, doğrulanamazdı.

**Yapılan (7 parça):**

1. **`TaskPlanStep.successCriterion`** + `PlannedStep.successCriterion` —
   planner `expectedOutput` der, runtime `successCriterion` der; köprü çevirir
   (planner çıktıdan konuşur çünkü artifakt için sorulur; runtime kriterden
   konuşur çünkü verifier'ın değerlendirdiği o). `buildPlan` artık taşıyor.
2. **`TaskPlanStep.verification` (`StepVerificationRecord`)** — hangi denemenin
   işi kontrol edildi, panel kimlerden kuruldu, birleşik verdict, kendi özeti.
   `evidence` işin *koştuğunu*, `verification` *kontrol edildiğini* kaydeder;
   ikisini eşitlemek "ajan çalıştı dedi"nin "doğrulandı"ya dönüşmesidir.
3. **`Verifier.appliesTo?: (step: StepClaim) => boolean`** — otomatik seçim,
   dürüst olan tek yönde: **verifier** hangi iddiaları değerlendirebildiğini
   beyan eder, çünkü planner sunucunun ne kaydettiğini bilemez. `appliesTo`'su
   olmayan verifier adımlar hakkında konuşmaz.
4. **`selectStepVerifiers`** — panel kurulumu. Kural (P1.6'nın ayrımı):
   **workspace-kapsamlı verifier'lar adım paneline girmez.** Yeşil bir build
   çalışma alanının sağlam olduğunu kanıtlar; bir adımın kriterinin
   gerçekleştiğini değil. Genel kanıtı adım kanıtı saymak, hiç oluşturulmamış
   bir dosyaya yeşil bir build'in kefil olmasıdır.
5. **Döngüde `verifySteps`** — yalnız `unverified` adımlar kontrol edilir
   (adapter'ın attribute ettiği statüye dokunulmaz; `not_implemented`'ın
   kontrol edecek şeyi yok). Pool deneme başına **bir kez** çekilir, iki düzey
   paylaşır. `pass` → `succeeded` (*kontrollü* başarı), `fail` → `failed` +
   bağımlılar `blocked` (blockUnreachable yeniden türetilir — recordStepProgress'teki
   çağrı bu statüler varken değil önce koşuyordu) + `priorFailures`'a yazılır,
   `uncertain` → statü değişmez, kayıt değişir. Kriteri olan ama paneli olmayan
   adım gözlemden geçer ("no verifier applies"), yutulmaz.
6. **Panel = P1.6'nın evaluator paneli:** paneldeki her applicable verifier
   çalışır (fabrikanın kendi kuralları): V1/V2 **fail** oya boğulamaz — test bunu sabitliyor
   (content-check pass + existence-check fail → adım failed).
7. **`planSummary.unverified`** — "koştu, çürüten yok, doğrulayan yok" artık
   ayrık sayılıyor ve özet cümlede görünüyor (`Plan: 2 step(s), 1 unverified`).

**B4 sınırı korundu (bilinçli):** hedef verifier'ı `pass` derse görev yine
anında biter; adım doğrulaması ajan denemesi harcamaz, hedef verdict'ini
ezmez. Test ediyor: `write` verified-succeeded olurken `check`
`not_implemented` kalır — çağıranın kabul kriteri işi bitirir.

**Test: 11 yeni** (`test/plan-step-verification.test.ts`) — 3 seçim/kriter
birimi + 5 döngü davranışı (başat senaryo, refüt+bağımlı blocked, uncertain,
"no verifier applies" gözlemi, panel hard-fail) + 2 köprü (model planındaki
`expectedOutput` PlanningEngine'den geçer; keyword fallback kriter icat etmez).
`plan-progress.test.ts` 2 yerde güncellendi (`unverified` sayımı).

**Duyarlılık (geri almalı, dördü de ölçüldü):**

| Sabotaj | Sonuç |
|---|---|
| `verifySteps` devre dışı | **5 failed** / 11 |
| workspace dışlaması kaldırıldı | **1 failed** / 11 |
| `appliesTo` yok sayıldı (her goal verifier her adımı doğrular) | **3 failed** / 11 |
| doğrulama sonrası `blockUnreachable` kaldırıldı | **1 failed** / 11 |

Hepsi geri kondu: `diff -q` **RESTORE_OK**, iz **0**.

**B6 sonrası tam zincir:** `typecheck` **0** · `build --workspaces` **0 TS** ·
`npm test` **exit 0 — 1649 geçen / 0 failed / 232 dosya** · `docs:state`
**232 / 1638 / 30** · `release:prepare` **0** · `verify:integration` **10/10** ·
OpenAPI **844**.

**Kapsam dışı (dürüstlük):** `engine.ts` köprü satırı (`expectedOutput →
successCriterion`) tip-denetimli ama davranış testi yok — motor testlerinin
mock modeli plan JSON'u üretmediğinden planlama her zaman keyword fallback'e
düşer ve köprü dalı çalışmaz; zincirin testli kısmı TaskPlanner→PlanningEngine
eşitliğinde duruyor. Kriter yalnız model kaynaklı planda vardır; keyword
fallback bilerek hiç üretmez (icat edilen kriter, kimseyle belirtilmemiş bir
iddiayı verifier'a "doğrulatır").

### B1 — Universal task primitive: görevin kimliği bütün kalmak zorunda ✅ (2026-09-24)

**Plan ne diyordu (P1.1):** tüm girişler ortak task lifecycle'a bağlansın;
gerekirse yüzeyler aynı `TaskContext`/execution primitive'e dönüştürülsün;
**her görevin ID, tenant, user, parent task, deadline, budget, priority ve
provenance bilgisi olsun.**

**Ölçülen gerçek (iki başlıkta):**

1. **Kimlik eksikti.** `TaskContextInit` şunları taşıyordu: tenant, goal, taskId,
   sessionId, workspace, constraints, budget, correlationId. P1.1'in istediği
   sekizden **dördü hiç yoktu** (user, parent task, deadline-bir-instant-olarak,
   priority); provenans yalnız `correlationId` olarak vardı — o bir izi bağlar,
   görevi **hangi yüzeyin ürettiğini** söylemez. `TaskReport` tenant'ı bile
   taşımıyordu: rapor süreç sınırını aşıyordu (API yanıtına serileşiyor) ve
   okuyucuya tenant'ı banttan söylemek gerekiyordu.
2. **Yüzeyler ölçüldü** (kod okumayla, tek tek):

| Yüzey | Giriş noktası | Ajan işi | Yol | Görev primitifi? |
|---|---|---|---|---|
| API | `POST /v1/run-task` | goal-task | `engine.execute()` → UnifiedExecutionLoop | ✓ |
| Channel | `ChannelGateway.ingest` | oturum-promptu | `supervisor.dispatch(session.prompt)` | bilerek ayrık |
| Scheduler/webhook | `AutomationService` | komut koşusu | `Supervisor` + kendi `AutomationRun` durumları | bilerek ayrık |
| Chat | oturumlar | oturum-promptu | session actor | bilerek ayrık |
| Proactive | `ProactiveInitiativeService` → autopilot | **hayır** | sınıflandırma + özet | henüz göreve dönüşmüyor |
| MCP | mcp servisleri | elicitation/aracı | — | araç yüzeyi |

"Ayrık" olanlar bilerek ayrık: kanal geçidi sohbet sürekliliği için **rota
başına tek oturum** tutuyor (`routes` anahtara göre); her mesajı görev döngüsüne
çevirmek oturum sürekliliğini yıkar. Oturum-promptu ile goal-task **farklı
semantiklerdir** — master'ın "gerekirse" koşulu tam da budur. Hangi promptun
göreve dönüşmesi gerektiğine **B2'nin niyet sınıflandırması** karar verecek;
o olmadan zorlamak yanlış araç olur.

**Yapılan:**

- **`TaskContextInit` / `TaskContext` / `TaskReport`** artık şu kimliği taşıyor:
  `userId` (sistem-başlatmalı görevde **yok** — tenant, kullanıcı demek değildir;
  icat edilen kullanıcı her denetim günlüğüne yalan yazar) · `parentTaskId`
  (kökte yok; delegation ve B8 devamı yazacak, rapor okuyacak) · `priority`
  (serbest string — initiative servisinin P0–P4 geleneği; kendi şeması olan
  yüzey yalana çevirmek zorunda kalmasın) · `deadline` (**mutlak instant**;
  `budget.timeMs` bir *süre*dir — "10 dakika harcayabilirsin" ile "kullanıcıya
  17:00'e kadar lazım" farklı kısıtlar; ikisini eşitlemek sistemin bütçenin
  tamamını deadline geçtikten sonra güzelce bitirmesinin tarifidir. Taşınır ve
  raporlanır; **zorlaması** B8'in işi) · `provenance`
  (`TaskSurface`: api/chat/channel/scheduler/proactive/mcp/background/internal
  + yüzeyin kendi referansı).
- **`TaskReport.tenantId`** — rapor artık tek başına hangi tenant için koştuğunu
  söylüyor.
- **`task.received` event'i kimliği taşıyor** — izi izleyen, kimin istediğini ve
  nereden geldiğini öğrenmek için motora geri çağırmak zorunda kalmıyor.
- **API yüzeyi tam geçişli:** `/v1/run-task` artık `userId`, `parentTaskId`,
  `priority`, `deadline` kabul ediyor, `provenance: { surface: "api", ref:
  request.id }` damgalıyor ve **yanıt makbuz olarak kimliği geri veriyor**.
  Girmediği yerde varsayılan üretmiyor — "local" gibi.

**Test: 7 yeni** — `test/task-identity.test.ts` (4): tam kimlik akışı init →
context → report · icat edilmez (yok = yok, tenant her zaman var) · deadline +
timeMs aynı anda var kalır · `task.received` payload'ı. 
`apps/control-api/test/run-task-identity.test.ts` (3): **gerçek route kodu**
stub engine ile — kimlik geçişi + makbuz · provenance api-damgası (request id
referanslı) · girmediyse varsayılan yok. Bu, route davranışının gerçek kodda
ölçüldüğü ilk control-api testi (öncekiler mock route kuruyordu).

**Duyarlılık (geri almalı, üçü de ölçüldü):**

| Sabotaj | Sonuç |
|---|---|
| `buildReport` kimlik geçişi kaldırıldı | **3 failed** / 4 |
| `task.received` payload'ından kimlik silindi | **1 failed** / 4 |
| route provenance damgası kaldırıldı | **1 failed** / 3 |

Hepsi geri kondu: `diff -q` **RESTORE_OK**, iz **0**.

**B1 sonrası tam zincir:** `typecheck` **0** · `build --workspaces` **0 TS** ·
`npm test` **exit 0 — 1656 geçen / 0 failed / 234 dosya** · `docs:state`
**234 / 1645 / 30** · `release:prepare` **0** · `verify:integration` **10/10** ·
OpenAPI **844**.

**Kapsam dışı (dürüstlük):** kanal/scheduler/chat yüzeylerinin **hangi**
işlerinin göreve dönüşeceği B2'nin niyet sınıflandırmasına bağlı (ölçülen
denetim tablosu yukarıda); proactive initiative'lerin göreve dönüşmesi
**bağlı değil** — gerçek bir açık, tek başına bir madde; `deadline`'ın koşu
sırasında zorlanması ve `parentTaskId`'nin yazılması B8.

### B2 — Gerçek task understanding: model çıkarır, kod karar verir ✅ (2026-09-24)

**Plan ne diyordu (P1.2):** model destekli intent/goal understanding · hedef,
constraints, preferences, deadline, expected artifact, success criteria çıkar ·
eksik bilgi kritikse clarifying question üret · belirsizlik yüksekse hemen
action yapma — ask/think/research kararı ver.

**Ölçülen gerçek:** hiçbir şey koşmuyordu. Hedef opak bir string olarak planlamaya
ve yürütmeye giriyordu. Kısıt yalnız çağıranın elle verdiğiydi; deadline, beklenen
artifact ve başarı koşulu hiçbir yerde yaşamıyordu. Kritik bir bilinmezen üzerine
kurulu görev ("veritabanını taşı" — **hangi** veritabanı?) yine de koşuyor ve
bütün deneme bütçesini, en başta sorulabilecek bir soruyu keşfetmeye harcıyordu.

**Yapılan:**

- **`aurora/goal-understanding.ts` (YENİ)** — `GoalUnderstandingService`,
  TaskPlanner'ın (B3) deseni: model önce, yanıt güvenilmez metin olarak
  doğrulanır, fallback dürüsttür (**hiçbir şey çıkarmaz ve bunu söyler**;
  uydurulmuş belirsizlik yok, tavsiye "act" — B2 öncesi davranışın aynısı,
  artık etiketli), sonuç `source` + `fallbackReason` taşır.
- **Ayran temelli tasarım: model çıkarır, kod karar verir.** `recommendAction`
  saf fonksiyondur; eşik (0.7) ve politika koddadır, çünkü modelin kendini
  "act"e ikna edebildiği politika politika değildir:
  - kritik bilinmezen + yalnız kullanıcı cevaplayabilir → **ask**
  - kritik bilinmezen + sistem cevaplayabilir → **research** (bilgi var,
    toplanmamış)
  - belirsizlik ≥ eşik → **think** (hedef birkaç anlama gelebilir; sessizce
    birini seçmek pozisyondur)
  - değilse → **act**
  - "ask"ta model soru vermediyse sorular bilinmezlerden türetilir —
    "kritik ama soru yok" sessizce "act"'e düşmez.
- **Doğrulama sınırları:** parse edilmeyen deadline reddedilir (yalan raporda
  tekrarlanamaz), ambiguity 0..1 dışı reddedilir, kritiklik boolean olmalı,
  sınıflandırılmamış bilinmezen **non-critical + "user"** varsayılır (yanlış
  "user" bir tur soru-cost, yanlış "system" bütün deneme-cost).
- **Döngüde UNDERSTAND fazı** (`deps.understandGoal`): denemelerden **önce**,
  görev başına bir kez. Kısıtlar aynen, tercihler etiketli ("Preference: …")
  briefing'ın zaten okuduğu `context.constraints`'e birleşir (çağıranın
  kısıtı korunur; ctor artık savunmacı kopya alır). Deadline: çağıran
  vermediyse anlamadan benimsenir — **açık talimat çıkarımı geçer**.
  Riskler understanding kaydında kalır (kısıt bölümüne zorlamak onları
  yanlış etiketlemek olurdu). Anlama kendisi patlarsa görev metinle devam
  eder, gözleme yazılır.
- **"ask" kontrol akışını değiştirir:** görev deneme döngüsüne **hiç girmez**
  (ajan çağrılmaz, `attempts=0`), durum `blocked`, ve sorular makine-okunur
  şekilde `TaskReport.clarification`'da (questions + eksikler + understanding) —
  özette gömülü değil. "research"/"think" yürütmeye directive olarak girer
  ("Research needed before acting: …").
- **Motor bağlı:** `engine.execute()` her görevde anlamayı çağırır (planner
  gibi); mock modelde dürüst fallback'e düşer.

**Test: 20 yeni** (`test/goal-understanding.test.ts`) — 5 service (model yolu,
prose fallback, modelsiz, çürük deadline, sınır dışı ambiguity) · 5 politika
(ask/research/think/act, soru türetme, ask>research önceliği) · 7 döngü
(ask'ta başlamaz, kısıt/preference birleşimi, deadline benimseme + çağıran
kazanır, research directive'i, anlama patlarsa devam, kaynak kaydı) · 2 tarayıcı
· 1 doğrulama.

**Duyarlılık (geri almalı, üçü de ölçüldü):**

| Sabotaj | Sonuç |
|---|---|
| ask-dalı kaldırıldı (görev her durumda koşar) | **1 failed** / 20 |
| politika hep "act" döndü | **3 failed** / 20 |
| kısıt birleştirme kaldırıldı | **1 failed** / 20 |

Hepsi geri kondu: `diff -q` **RESTORE_OK**, iz **0**.

**B2 sonrası tam zincir:** `typecheck` **0** · `build --workspaces` **0 TS** ·
`npm test` **exit 0 — 1676 geçen / 0 failed / 235 dosya** · `docs:state`
**235 / 1665 / 30** · `release:prepare` **0** · `verify:integration` **10/10** ·
OpenAPI **844**.

**Kapsam dışı (dürüstlük):** anlamanın çıkardığı `successCriteria` henüz
TaskPlanner'ın prompt'una girmiyor (planner hedef metni görür; kriterler raporda
`report.understanding` üzerinden görünür) — planner girdisini zenginleştirmek
B3'ün genişletilmesi olur, B2'nin değil. "ask" cevabı geri geldiğinde göreve
devam ettirme (yanıt→yeniden anlama→koşma döngüsü) yok: API yüzeyi clarification'ı
döndürür, çağıran cevapla yeniden çağırır. B1'deki yüzey denetim tablosunda
"hangi prompt göreve dönüşecek" sorusunun cevabı artık var (niyet
sınıflandırması), ama kanal/scheduler yüzeylerine **bağlanmadı** — o kendi
maddesi.

### B7 — Evidence-first completion: rapor neyin kontrol edildiğini söylemek zorunda ✅ (2026-09-24)

**Plan ne diyordu (P1.7):** "Agent says done" tek başına success olmasın ·
gerçek artifact/test/diff/command output… evidence gereksinimlerini tanımla ·
kullanıcıya neyin doğrulandığını göster.

**Ölçülen gerçek — ne zaten vardı, ne yoktu:**

Zaten güçlü olan yarım: hedef verifier'ı yoksa görev `unverified`; workspace
kanıtıyla gelen `pass` `uncertain`'a düşürülüyor (nedeniyle); `acceptUnverified`
motorda hiç kullanılmıyor (yalnız loop config'te).

Eksik olan yarım — probe ile ölçüldü. Anlamanın (B2) bir expected artifact ve
2 başarı kriteri çıkardığı görev, workspace-scoped build geçişiyle koştu:

```
status=unverified verdict=uncertain
summary=…downgraded to uncertain: the evidence is workspace-scoped (build)…
```

Düşürme doğru — ama rapor **hiçbir yerde** "istenen artifact'ı ve iki kriteri
hiçbir şey kontrol etmedi" demiyordu. Okuyucu `report.understanding` ile
`report.verification.results`'ı eliyle karşılaştırmak zorundaydı. P1.7'nin
"kullanıcıya neyin doğrulandığını göster" maddesi tam olarak eksik olan buydu.
Ayrıca `acceptUnverified: true` açıldığında rapor "executed" diyordu —
sebebinin "ajanın sözü, konfigürasyon gereği kabul edildi" olduğunu söylemeden.

**Yapılan:**

- **`execution/evidence-coverage.ts` (YENİ, saf):** `buildEvidenceRequirements`
  (understanding'ın expectedArtifact'i → 1 artifact gereksinimi; her success
  criterion → 1 criterion gereksinimi; hiçbiri yoksa **boş envanter** — hedefin
  bir gerçeği, arama başarısızlığı değil) · `assessEvidenceCoverage`
  (gereksinim × pool) · `evidenceCoverageNote` (özet için).
- **Kapsam kuralı:** bir verifier bir gereksinimi yalnız **beyanla** kapsar —
  B6'nın `appliesTo` mekanizması, aynı dürüstlük yönünde: `appliesTo`'su
  olmayan bir goal verifier "muhtemelen doğru şeyi kontrol etti" demez;
  "muhtemelen kontrol etti" raporlanabilir bir gerçek değil. Beyan eden ama
  sonuç üretmeyen verifier `uncertain` sayılır (kanıt yokluğu pass değildir —
  fabrikanın kendi kuralı).
- **Döngü:** her denemede, hedef verification'ından sonra envanter hesaplanır
  (`report.evidence`: gereksinim, checked/unchecked, kapsayan verifier'lar ve
  verdikleri verdict) ve gözleme yazılır ("Evidence coverage: 0/3 requirement(s)
  checked; unchecked: hello.txt containing Hi; …"). **Kontrol akışını
  değiştirmez** — durum kuralları aynı; bu rapor içindir.
- **Özet cümlesi:** `succeeded`, `unverified` ve `executed` durumlarında
  `Evidence: 0/3 requirement(s) checked.` notu.
- **`acceptUnverified` dürüstlüğü:** "executed" yalnız o yoldan gelir
  (grep ile doğrulandı: lastStatus atamalarının tamamı blocked/succeeded/
  failed/unverified; tek "executed" ternary'de). Özet artık gerçek sebebi
  söylüyor: *"Accepted on the agent's word (acceptUnverified): the run finished
  but nothing could confirm the result."* Politika seçimi ölçüm gibi
  gösterilemez.

**Bu turda duyarlılığın kendi dersi:** S2 sabotajı (kapsam `appliesTo`'dan
değil "her goal verifier kapsar"dan gelsin) **ilk ölçümde 0 failed verdi** —
testlerde "goal-scoped ama beyansız verifier" durumu yoktu. Çekirdek kuralın
testi yokmuş. Test eklendi ("does not count a goal verifier that never declared
what it checks"), sabotaj yeniden ölçüldü: **1 failed**. Kuralın testi
olmayana kural denmez.

**Test: 12 yeni** (`test/evidence-first-completion.test.ts`) — 5 birim
(gereksinim kurulumı, boş envanter, beyansız kapsamsızlık, beyan+çalıştı,
beyan+refüt, beyan+sonuç yok → uncertain, not render'ı) + 5 döngü
(workspace-only → 0/3 + özet + gözlem; beyanlı verifier → 3/3 + succeeded;
gereksinimsiz hedef → envanter yok; acceptUnverified → gerçek sebep).

**Duyarlılık (geri almalı; S2 iki kez ölçüldü — test eklenmeden önce ve sonra):**

| Sabotaj | Sonuç |
|---|---|
| coverage hesabı tamamen kaldırıldı | **3 failed** / 11 |
| kapsam `appliesTo` yerine scope'tan | ilk ölçüm **0 failed** → test eklendi → **1 failed** / 12 |
| özet notu kaldırıldı | **3 failed** / 11 |

Hepsi geri kondu: `RESTORE_OK`, iz **0**.

**B7 sonrası tam zincir:** `typecheck` **0** · `build --workspaces` **0 TS** ·
`npm test` **exit 0 — 1688 geçen / 0 failed / 236 dosya** · `docs:state`
**236 / 1677 / 30** · `release:prepare` **0** · `verify:integration` **10/10** ·
OpenAPI **844**.

**Kapsam dışı (dürüstlük):** envanterin kaynağı şu an yalnız understanding'ın
artifact/kriterleri — çağıranın kendi gereksinim beyanı (ör. "bana file hash
ver") için ayrı bir API yok; caller verifier'larını `appliesTo` ile donatarak
kapsam bildirebilir. "browser result / API result" gibi kanıt türleri etiket
olarak yok — türleri verifier yazarı belirler, Aurora uydurmaz.

### B8 — Long-horizon task manager: saatler süren görev artık bir şey ✅ (2026-09-24)

**Bununlala Bölüm B'nin tamamı (B1–B8) kapandı.**

**Plan ne diyordu (P1.8):** saatler/günler süren görevlerde durable queue ·
pause/resume · scheduled continuation · deadline awareness · human approval
waiting state · failure escalation · parent-child tasks · progress digest.

**Ölçülen gerçek:** `DurableScheduler` **oturum promptlarını** zamanlıyor
(cron/interval/once), `AutomationService` komut koşularını persist ediyordu —
ikisi de durable, ikisi de görev hakkında değil. Saatler sürecek bir hedefin
**temsili yoktu**: `engine.execute()` senkron bir promise; süreç yeniden
başlayınca oturum günlüklerinden başka her şey kayboluyordu. Pause yok, insan
onayı bekleme yok, escalation yok, üst-alt bağ yok, digest yok — P1.8'in
saydığı sekizden hiçbiri yoktu.

**Mimari karar — hepsini dürüst kılan tek biçim:** *uzun görev = alt görev
dizisi.* Her adım enjekte edilen `execute()` primitifinden geçer (B1'in
`parentTaskId`'siyle bağlanır; kimliği taşır; anlama-planlama-yürüyüş-
doğrulama-kanıt omurgasının tamamından). Manager "arasını" yönetir — persist,
duraklatma, zamanlama, deadline, onay, escalation — "içini" asla: o iş
primitifin. Durability `AutomationService` deseni: atomik yazılan JSON durum
dosyası; restart'ta `running` bulunan görev `queued`'ya döner (yarı-olmuş
adım, primitifin idempotency anahtarı altında yeniden koşar — bitti sanılmaz).

**Sekiz alt maddenin karşılıkları:**

1. **Durable queue** — her geçişte persist; restart testi **yeni instance'la**
   ölçüldü (state yükleme + zamanı gelince devam).
2. **Pause/resume** — pause çalışan adımı geri çekmez (gerçek yan etkidir);
   adım biter, döngü bir sonraki **sınırda** park eder. Resume kaldığı adımdan.
3. **Scheduled continuation** — adımın `scheduledFor`'u; `tick()` zamanı
   gelmediyse dokunmaz; `nextStepAt` kalıcı.
4. **Deadline awareness** — her adım öncesi kontrol; geçtiyse görev `failed`,
   kalan adımlar `not_run`, `execute` hiç çağrılmaz.
5. **Human approval** — `requiresApproval`'lı adım `waiting_approval`'da durur;
   onay **kalıcıdır** (`approval: "granted"` persist) — restart insana aynı
   soruyu iki kez sordurmaz; red → görev `failed`, kalan `not_run`.
6. **Failure escalation** — adım `succeeded` değilse üç politika: `abort`
   (dur, kalan `not_run`) · `continue` (devam, hasar kayıtlı) · `escalate`
   (insan kararır). **Bitiş dürüstlüğü:** kaydında failed adım olan görev asla
   `succeeded` olamaz — `continue`/`escalate` yolları bunu spekülatif kılar,
   `finalize` engeller.
7. **Parent-child** — her adım `parentTaskId` + `provenance { surface:
   "background", ref: üstGörevId }` ile koşar; `childTaskId` kalıcı adım kaydı.
8. **Progress digest** — görev başına { durum, adım sayıları, sıradaki adım,
   deadline, bekleme sebebi }; tenant izole.

**Yazarken yakalanan üç gerçek bug (testi yazmadan/dport ederken, duyarlılık
tablosunda kendi sabotajları olarak da ölçüldü):**

1. `pause()` running durumunda hiçbir şey yazmıyordu — run loop `paused`
   okuyor ama onu kimse yazmıyordu; park asla olmazdı.
2. `continue`/`escalate` politikalarında kayıtlı failed adımlı görev
   `succeeded` bitiriyordu — bu tam olarak B7'nin yasakladığı yalan.
3. `approve` onayı kalıcı yazmıyordu — run loop aynı `requiresApproval`
   adımını yine bekler, insan aynı soruya sonsuza dek cevap verirdi. Ayrıca
   escalation sonrası approve "geç" demekti ama kod "aynı adımı yeniden koş"
   yapıyordu; kalan adımlar koşulmadan görev bitebiliyordu.

**Test: 13 yeni** (`test/long-horizon-tasks.test.ts`) — sıra + üst-alt bağ +
provenance · kuyruk sırası · restart sürdürmesi (yeni instance) · running→
re-queue · pause sınırında park + resume · onay bekle→ver→koş · red→not_run ·
deadline geçti→hiç koşmaz · abort · continue (succeeded yalanı yok) · escalate
(approve geç demektir, yeniden koş değil) · digest + tenant izolasyonu.

**Duyarlılık (geri almalı, dördü de ölçüldü):**

| Sabotaj | Sonuç |
|---|---|
| restart'ta running→queued kaldırıldı | **1 failed** / 13 |
| pause durumu yazmaz (bug'ın kendisi) | **1 failed** / 13 |
| finalize failed adımları yok sayar | **2 failed** / 13 |
| approve onayı kalıcı yazmaz (bug'ın kendisi) | **1 failed** / 13 |

Hepsi geri kondu: `diff -q` **RESTORE_OK**, iz **0**.

**B8 sonrası tam zincir:** `typecheck` **0** · `build --workspaces` **0 TS** ·
`npm test` **exit 0 — 1701 geçen / 0 failed / 237 dosya** · `docs:state`
**237 / 1690 / 30** · `release:prepare` **0** · `verify:integration` **10/10** ·
OpenAPI **844**.

**Kapsam dışı (dürüstlük):** manager `engine.execute`'e henüz bağlanmadı —
servis motor içinde kurulabilir (`engine.longHorizon`), scheduler/AutomationService
yüzeyleriyle ve control-api HTTP uçlarıyla entegrasyon ayrı iş (OpenAPI
yeniden üretimi gerektirir). `tick()`'i sürecek bir zamanlayıcı (interval)
yok — çağıran çeker; DurableScheduler'ın timer'ı buna devredilebilir. Adım
hedefleri elle verilir; "uzun görevi otomatik adımlara böl" B3 planner'ının
genişletilmesi olurdu.

### D1 + D3 — Gerçek embedding sağlayıcısı runtime'a bağlandı; ölçülen sıralama artık ajanın aldığı sıralama ✅ (2026-09-24)

**Bölüm D durum ölçümü (kod okuyarak, tek tek):** D4 (7 katman: working/session/
episodic/semantic/procedural/user/palace + graph servisi) ve D5 (claimType =
observation/inference/hypothesis/prediction) **kodda ve tüm API'lerde
taşınıyor** — satırlar bayattı, düzeltildi. D6'nın yalnız elle kurulan
`contradicts` ilişkisi + `superseded` durumu var, **otomatik algılama yok**;
D2'nin durable vektör indeksi yok (embedding'ler hiçbir yere kalıcı yazılmıyor);
D7 ölçülmedi (açık kaldı).

**Plan ne diyordu (D1):** "Benchmark'taki gerçek embedding pipeline'ını
runtime'a taşı." **(D3):** "BM25 + Vector + RRF + Rerank üretim yolu olsun."

**Ölçülen gerçek:** `RealMemoryPipeline` üretimde recall ranker'ı olarak
zaten koşuyordu — ama **embedding sağlayıcısız**: depodaki tek encoder hash
tabanlı olduğundan ve yüzey örtüşmesini (BM25'ın zaten ölçtüğü şeyi, daha
gürültülü) ölçtüğü için bilerek verilmiyordu (eval ölçümü: Recall@8
0.317→0.289, 0W/4L/11T). Gerçek sağlayıcılar (BGE/E5, OpenAI-uyumlu uç nokta
arkasında) **aynı dosyada duruyordu** ve yalnız eval harness'ten erişilebiliyordu.
Yani projenin ölçtüğü sıralama, ajanın aldığı sıralama hiç değildi: üretim
recall'u leksikaldi.

**Yapılan:**

- **`EngineConfig.embedding`** — `{ apiBase, apiKey?, kind?: "bge" | "e5" }`;
  motor sağlayıcıyı kurar, `MemoryEngine`'e 8. parametre olarak geçirir.
  **Yokluğu hiçbir şeyi değiştirmez** (leksiksel varsayılan) — bu repoda dış
  servis olmadan kefil olunabilecek tek yapılandırma o.
- **`MemoryEngine.rank` skor ayrımı:** sağlayıcı `isSemantic` değilse pipeline'a
  **bilerek verilmez** (iki leksiksel sinyali bağımsız kanıt gibi kaynaştırmak
  ölçülmüş zarar). Semantik modda sinyal füzyonlu `score` (yüzey örtüşmesi +
  anlam, eval'in 0.317→0.361 ölçtüğü yapılandırma); leksiksel modda `bm25Score`
  (birleşik skor hiç sıfır olmadığından "zayıf eşleşti" ile "eşleşmedi"yi
  ayıramıyor — mevcut gerekçe aynen duruyor).
- **Test, gerçek üretim yolu üzerinden:** yerel bir **OpenAI-uyumlu HTTP
  `/embeddings` sunucusu** (node:http) — üretimdeki BGE hizmetinin izleyeceği
  yolun aynısı: config → sağlayıcı → fetch → pipeline → rank → sıralama.
  Vektörler dikey eksenli (database/cache/nötr) olduğundan semantik benzerlik
  kesin ve bilinir. Üç test: semantik ilgili anı, leksiksel örtüşen ve daha
  yüksek önemlilikli anının üstüne çıkar · uç nokta yapılandırılmadıysa
  leksiksel varsayılan birebir korunur (sabitledi) · ölü uç nokta önem
  sırasına yumuşak düşer (recall ölmez).

**Bu turun kendi dersi (test stub'ında):** sunucu `embedBatch`'in `input`'unu
(string dizisi) tek string sayıyordu → tüm adaylar aynı vektörü alıyordu →
test kablolamayı değil stub'ı ölçüyordu. İlk koşu yakaladı; stub OpenAI
lehçesine düzeltildi (`input` dizi olabilir, yanıt öğe başına embedding).
Kablosuz yeşil test, stub'ın doğruluğuna da kanıttır — değil.

**Duyarlılık (geri almalı, üçü de ölçüldü):**

| Sabotaj | Sonuç |
|---|---|
| motor sağlayıcıyı MemoryEngine'e geçirmiyor | **1 failed** / 3 |
| skor ayrımı kaldırıldı (semantik modda da bm25Score) | **1 failed** / 3 |
| rank'ın yumuşak düşüşü kaldırıldı (ölü uç nokta recall'u öldürür) | **1 failed** / 3 |

Hepsi geri kondu: `diff -q` **RESTORE_OK**, iz **0**.

**D1+D3 sonrası tam zincir:** `typecheck` **0** · `build --workspaces` **0 TS** ·
`npm test` **exit 0 — 1704 geçen / 0 failed / 238 dosya** · `docs:state`
**238 / 1693 / 30** · `release:prepare` **0** · `verify:integration` **10/10** ·
OpenAPI **844**.

**Kapsam dışı (dürüstlük):** embedding'ler **kalıcı değil** — her recall'da
adaylar yeniden gömülüyor (D2'nin işi: durable vektör indeksi). Gerçek BGE/E5
hizmeti repoda yok; sağlayıcı dış uç nokta varsayıyor ve `isSemantic: true`
sözüne güveniyor. `graph.recall`'ın kendi `semanticIndex`'i (varsa) ayrı bir
yol — bu iş MemoryEngine ranker'ına dokundu.

### D2 — Durable vektör indeksi: sağlayıcı değişince kanıt çöpe dönmüyor ✅ (2026-09-24)

**Plan ne diyordu:** "Durable vector/index backend (graph + metadata + tenant
isolation + versioning + rebuild)."

**Ölçülen gerçek — backend zaten vardı, üç şey yoktu, bir de ben hata
yapmıştım:**

`HybridSearchIndex` (`search/hybrid-index.ts`) kalıcıydı (atomik JSON),
tenant-izoleliydi, embedding'leri **sağlayıcı kimliğiyle birlikte** saklıyordu
ve motorun **hem bellek grafiği hem bilgi indeksleyicisiyle paylaşılmıştı** —
`graph.remember` upsert, `graph.recall` search, silme iki taraflı. Yani
"backend" satırı büyük ölçüde bayattı. Olmayanlar:

1. **`search()` sağlayıcı uyumsuzluğunu denetlemiyordu:** sorgunun vektörüyle
   HER belgenin vektörü arasında cosine hesaplıyordu — belgeyi hangi modelin
   gömdüğüne bakmadan. Başka bir model konfigüre edildiğinde indeks, farklı
   uzaylara ait benzerlikleri hibrit skora sessizce karıştırıyordu: kanıt gibi
   görünen ve kanıt olmayan sayılar.
2. **Göç yolu yoktu:** saklanan metinleri mevcut sağlayıcıyla yeniden gömecek
   `rebuild` yoktu — sağlayıcı değişikliği indeksi kalıcı olarak vektör-ölü
   bırakıyordu.
3. **Yükleme doğrulaması yoktu:** dosyadaki bozuk satır (elle düzenleme,
   kesik yazma) `search`'e ulaşıyordu.
4. **Ve D1'de ben hata yapmıştım:** `EngineConfig`'de **zaten var olan**
   `embeddings?` alanının yanına ikinci bir `embedding?` girintisi ve ayrı
   BGE/E5 sağlayıcı sınıfları eklemiştim — aynı uç nokta, iki farklı isimle,
   iki kez konfigüre edilir hâle gelmişti. D2'nin ölçümü sırasında
   yakalandı. (Kullanıcının kurallarından: "aynı işi yapan iki sistemi
   çoğaltmak değil, bir sistemi gerçekten güçlü hale getirmek.")

**Yapılan:**

- **Sağlayıcı-sürüm koruması (`search`):** belge `embeddingProvider`'ı
  mevcut sağlayıcıdan farklıysa vektör skoru **0** — çapraz-uzay cosine yok;
  leksiksel skor yaşamaya devam eder (indeks körelir, kör olmaz). Sağlayıcı
  kimliği = indeksin sürümü.
- **`rebuild()`:** metinler kaynak-doğru, vektörler türetilmiş — tüm belgeleri
  mevcut sağlayıcıyla (64'lü gruplar hâlinde) yeniden gömer, kalıcı yazar.
  Açık çağrıdır, otomatik değil: gerçek uç noktaya karşı büyük indeksi yeniden
  gömmek gerçek para.
- **Yükleme doğrulaması:** belge biçiminde olmayan satırlar yüklenirken
  düşer; `count()` gerçeği söyler.
- **Tek girinti, iki lehçe:** `batchEmbedderToPipelineProvider` — arama
  yolunun toplu gömücü lehçesini (`embed(texts[])`) recall ranker'ının
  tek-metin lehçesine uyarlar. `dimensions` ilk vektörden **ölçülür**, ilan
  edilmez (pipeline tüketmiyor; tahmin yazmak vektörlerle anlaşamazlığa
  hazır bir yalan olurdu). Motor artık `config.embeddings`'i her iki yöne
  bağlar; D1'in `embedding?` girintisi ve BGE/E5 kurulum bloğu **silindi**.
- **D1 testleri birleşik girintiye taşındı** (aynı davranış, tek alan:
  `embeddings: {baseUrl, apiKey}`).

**Test: 5 yeni** (`test/durable-vector-index.test.ts`) — kalıcılık + tenant
izolasyonu (yeni instance) · bozuk satır düşer, geçer kalır · uyumsuz
sağlayıcıda vectorScore=0 + leksiksel sıralama yaşar · rebuild sonrası
semantik eşleşme (leksiksel ayrık sorgu!) öne çıkar ve göç kalıcıdır · adaptör
(model/isSemantic/embed/embedBatch/ölçülen dimensions).

**Duyarlılık (geri almalı, dördü de ölçüldü; 8 testlik birleşik koşu):**

| Sabotaj | Sonuç |
|---|---|
| sağlayıcı uyumsuzluk koruması kaldırıldı | **1 failed** / 8 |
| rebuild yeniden gömmez (no-op) | **1 failed** / 8 |
| yükleme doğrulaması kaldırıldı | **1 failed** / 8 |
| motor adaptörü MemoryEngine'e geçmiyor | **1 failed** / 8 |

Hepsi geri kondu: `diff -q` **RESTORE_OK**, iz **0**.

**D2 sonrası tam zincir:** `typecheck` **0** · `build --workspaces` **0 TS** ·
`npm test` **exit 0 — 1709 geçen / 0 failed / 239 dosya** · `docs:state`
**239 / 1698 / 30** · `release:prepare` **0** · `verify:integration` **10/10** ·
OpenAPI **844**.

**Kapsam dışı (dürüstlük):** recall sırasında adaylar `MemoryEngine.rank`'ta
hâlâ yeniden gömülüyor (D1 tasarımı; graph kendi durable indeksinden vektörle
aday seçer, rank birleşik kümeyi sıralar — sorgu günde iki kez gömülür, bilinen
maliyet). `rebuild`'i çağıracak HTTP/cli yüzeyi yok (metot + test var;
OpenAPI yeniden üretimi gerektirirdi). Hash varsayılanına dönen kurulumlarda
indeks leksiksel olarak yaşamaya devam eder — bilinçli.

### D6 — Çelişki motoru: eksik olan orta yarım — yargı ✅ (2026-09-24)

**Plan ne diyordu:** "Contradiction engine: detect → compare evidence →
confidence → supersede" (master P1.18: "Source, provenance, confidence,
importance, validity, superseded state. User correction/retraction.
Contradiction management.")

**Ölçülen gerçek — zincirin iki ucu vardı, ortası yok:**

- `detectContradictions(tenantId)` **vardı**: aktif iddialar arasında aynı
  konu + ters polarite → `contradicts` ilişkisi + karşılıklı
  `contradictionIds` bayrakları.
- `supersede(tenantId, id, replacementId)` **vardı**: kaybeden `superseded`
  + `supersededById` + `validTo`; recall'ın `active` filtresi dışarıda
  bırakıyor; provenance için saklı.
- **Arada hiçbir şey yoktu.** Algılanan bir çelişki sonsuza dek iki tarafı da
  aktif, iki tarafı da her prompt'a recall edilir durumda bekliyordu; tek çözüm
  yolu id'leri elle seçen bir çağırandı — ve hiçbir çağıran yargılayacak
  konumda değildi. "Compare evidence → confidence → supersede" yarımı yoktu.

**Yapılan — `memory/contradiction-service.ts` (YENİ):**

- **Politika koddadır, modelde değil** (B2 ilkesi: modelin kendini ikna
  edebildiği yargıç yargıç değildir). Üç kural, sırayla:
  1. **Kullanıcı düzeltmesi:** bir taraf `user` kaynaklı, diğeri değilse
     kullanıcı kazanır — marj şartı yok (marj, kendinden emin bir yalanı zayıf
     bir doğrudan korumak için var; kullanıcı düzeltmesi o durum değil).
  2. **Kanıt gücü farkı ≥ 0.25:** kazanan supersede eder. Güç = kaynak ağırlığı
     (user 1.0 · event 0.85 · system 0.7 · agent 0.6 · memory 0.5 · external
     0.45) × iddia ağırlığı (observation 1.0 · inference 0.8 · prediction 0.6 ·
     hypothesis 0.5) × confidence + kanıt bonusu (5'e kadar, azalan getiri).
  3. **Eşitlik = dokunma:** iki taraf da aktif ve bayraklı kalır.
     **Yenilik (recency) beraberliği BOZMAZ** — "en son yazılan doğru"
     = "ajanın son sözü doğru", ki doğrulama katmanının varlık sebebi tam bu
     varsayımı reddetmek.
- **`MemoryContradictionService`:** `resolvePair` (bilinen çifti yargıla +
  uygula) · `resolveDetected` (taramayı çalıştır, her çifti yargıla).
  Idempotent: tarama yalnız AKTİF iddialara bakar, supersede edilen aktif
  olmaktan çıkar → ikinci koşu yalnız gerçekten hâlâ tartışmalı olanı inceler.
- **Motor bağlı:** `engine.contradictions` public alan.
- `adjudicate` + `evidenceStrength` **saf** fonksiyonlar — kurallar tek başına
  test edilebilir.

**Bu turda yaptığım hata (D2'dekinin tekrarı, itiraf):** graph'a id-bazlı `get`
"ekledim" — oysa **zaten vardı** (fırlatan sürüm). `tsc` duplicate implementation
yakaladı; benim kopyam silindi, servis mevcut `get`'in semantiğine uyarlandı.
**Ders ikinci kez ölçüldü: eklemeden önce komutla varlığı kontrol et.**

**Test: 8 yeni** (`test/contradiction-engine.test.ts`) — 2 güç birimi (ağırlıklar
· azalan-getiri tavanı) · 3 saf yargı (user önceliği · net fark · **eşitlikte
dokunma — recency kazanmaz**) · 4 uçtan uca (detect→yargıla→supersede→recall
dışlar + idempotent ikinci koşu 0 çelişki · kullanıcı düzeltmesi kendinden emin
ajan iddiasını yener · dengeli çelişkide iki taraf aktif+bayraklı · olmayan çift
hatadır sessiz atlama değil).

**Duyarlılık (geri almalı, dördü de ölçüldü):**

| Sabotaj | Sonuç |
|---|---|
| kullanıcı-düzeltmesi önceliği kaldırıldı | **2 failed** / 8 |
| eşik 0 (her çelişkide biri kazanır) | **2 failed** / 8 |
| supersede uygulanmaz (yalnız karar) | **2 failed** / 8 |
| eşitlikte "yeni kazanır" | **2 failed** / 8 |

Hepsi geri kondu: `diff -q` **RESTORE_OK**, iz **0**.

**D6 sonrası tam zincir:** `typecheck` **0** · `build --workspaces` **0 TS** ·
`npm test` **exit 0 — 1717 geçen / 0 failed / 240 dosya** · `docs:state`
**240 / 1706 / 30** · `release:prepare` **0** · `verify:integration` **10/10** ·
OpenAPI **844**. (Komşu 13 bellek/graph suite'i birlikte 85/85.)

**Kapsam dışı (dürüstlük):** yargıç **saf koddur** — çelişkiyi anlamak için
model kullanılmıyor (algılayıcı zaten leksiksel-polarite tabanlı; "anlamsal
çelişki" — örn. "replica sağlıklı" vs "replica geride kalıyor" eşanlamlı-farklı
sözcüklerle — ancak model tabanlı algılayıcıyla bulunur, ayrı iş). `resolveDetected`
elle tetiklenir (motor üzerinde metot var; periyodik/HTTP tetikleyici yok).

### D7 — Prosedürel bellek: makine tamamdı, besleme hiç yoktu ✅ (2026-09-24)

**Bununla Bölüm D'nin tamamı (D1–D8) kapandı.**

**Plan ne diyordu (P1.20):** "Başarılı task trajectory'den reusable procedure
çıkar. Actual tool sequence + conditions + verification kriterlerini sakla.
Skill replay testleri oluştur."

**Ölçülen gerçek:** `ExperienceCompilerService` makinenin **tamamını**
içeriyordu — `recordExperience` (adım başına action/tool/input/output/duration/
success), `compileSkills` (tag gruplama, ≥3 başarılı deneyim, tekrarlanan
action:tool dizisini prosedür olarak çıkar, aşamalı: candidate→approved→
production), `recordSkillOutcome`, `promoteSkill`, `findSkill`; durable ve
tenant-izoleli. Ve `recordExperience`'ın **src/ içinde tek bir çağıranı yoktu.**
Hiçbir gerçek görev yörüngesi derleyiciye ulaşmıyordu; hiçbir prosedür gerçek
işten derlenmiyordu. D7'nin "trajectory → skill" oku yalnızca kullanılmayan
kod olarak vardı — tıpkı replanning'in (B5) yalnızca okunmayan bir strateji
olarak var olması gibi.

**Yapılan — köprü, ikinci sistem değil** (kullanıcı kuralı: bir sistemi gerçekten
güçlendirmek):

- **`recordTaskExperience(trajectory)`** — biten bir görevi deneyim olarak
  kaydeder. Eşleme kuralları, her biri bilinçli seçim:
  - **outcome:** `succeeded` → success · `failed` → failure · **gerisi
    (unverified, blocked, …) → partial.** Doğrulanmamış koşu başarı değildir:
    doğrulanmamış işten prosedür derlemek sisteme "kendinden emin görünen çıktı
    iyi çıktıdır" öğretir.
  - **steps:** yalnız **kanıt taşıyan** plan adımları (B4 attribution'ı —
    döngünün elindeki en dürüst "gerçek araç dizisi"). Kanıtlı adımı olmayan
    görev, çağırdığı yeteneklere düşer (gerçek araçlar, kaba tane). İkisi de
    yoksa **hiçbir şey icat edilmez**.
  - **tags = çağrılan yetenekler** — gerçekten kullanılan araçlara göre
    gruplama; hedef metninden anahtar sözcük çıkarımı **bilerek yok** (B3'ün
    eleştirdiği şey).
  - **verification** özeti de kayıtta (P1.20 "verification kriterlerini sakla").
- **Motor `learn` kancası bağlı:** her biten görev (başarı VE başarısızlık —
  başarısızlık da öğretir; derleme zaten yalnız success'leri gruplar) yörüngesi
  kaydolur + aynı kancada `compileSkills` (tenant başına deneyim tavanı
  derlemeyi sınırlı tutar).
- **Tavan (varsayılan 500/tenant, kurucuda ayarlanabilir):** derleyici her
  kayıtta havuzu tarar; sınırsız havuz bir görevi kaydetmeyi koşmasından
  pahalı yapardı. FIFO düşürme; asılı referans zararı yok (yanlış beceri değil).

**Test: 9 yeni** (`test/procedural-memory.test.ts`) — 4 kayıt birimi (kanıtlı
adımlar+araçlar+tags+verification · unverified→partial · yetenek düşüşü ·
boşta icat yok) · 3 derleme (3 doğrulanmış yörünge → candidate beceri, prosedür
= tekrarlanan dizi · doğrulanmamıştan derlenmez · promote→findSkill + tenant
izolasyonu) · 1 tavan · 1 **gerçek yol** (motor.execute → deneyim kaydedilir;
ders = raporun özeti).

**Duyarlılık (geri almalı, dördü de ölçüldü):**

| Sabotaj | Sonuç |
|---|---|
| learn kancası kaydı çağırmıyor (orijinal durum) | **1 failed** / 9 |
| outcome hep "partial" (başarı asla derlenmez) | **3 failed** / 9 |
| kanıtlı adımlar düşürülüyor | **2 failed** / 9 |
| tavan uygulanmıyor | **1 failed** / 9 |

Hepsi geri kondu: `diff -q` **RESTORE_OK**, iz **0**.

**D7 sonrası tam zincir:** `typecheck` **0** · `build --workspaces` **0 TS** ·
`npm test` **exit 0 — 1726 geçen / 0 failed / 241 dosya** · `docs:state`
**241 / 1715 / 30** · `release:prepare` **0** · `verify:integration` **10/10** ·
OpenAPI **844**.

**Kapsam dışı (dürüstlük):** P1.20'nin üçüncü maddesi — **skill replay
testleri** — yok (derlenen prosedürü otomatik test edecek koşucu M3'ün "skill
testing" maddesi; D7 kayıt+derleme bağını kurdu). `findSkill` yürütmeye
bağlı değil: bir sonraki görevin hedefinden tag çıkarımı icat etmek istemedim;
hangi bağlamda becerinin önerileceği (B3 planner girdisi? briefing?) ayrı
karar. Prosedür çıkarımı frekans tabanlı (≥2 tekrar) — anlamsal benzerlik yok.

### F — World model: öğrenme sinyali dayanıklılaştı, perspektifler karara bağlandı ✅ (2026-09-24)

**Bununla Bölüm F'nin tamamı (F1–F5) kapandı → sayaç 29 ✅.**

**Ölçüm (yazmadan önce):**

- **F3'ün roadmap notu bayattı** — "loop'a bağlı değil" yazıyordu ama predict/record
  çifti motora çoktan bağlıydı (engine adapter → `cognitiveRuntime.predictStep` /
  `recordStep` → `WorldModelExplorationPipeline`). Gerçek boşluk başka yerdeydi:
  sürpriz **bellek-içi** pipeline'da kalıyordu — restart'ta sıfır, hiçbir gelecek
  davranışı değiştirmiyordu; dayanıklı `WorldModelService`'in Brier/kalibrasyon
  makinesi yürütme yolundan hiç beslenmiyordu (yalnız yetenek+HTTP).
- **F2 tam boşluktu:** prior sabit heuristicti (`0.5 + planned 0.1 + verifiers 0.15`)
  ve hiçbir deneyim onu kıpırdatamıyordu — P1.23'ün "caller-provided heuristic"
  tanımının ta kendisi. `LearnedWorldModelService` kuralları kimse okumuyordu.
- **F1 makine olarak tamamdı** (ölçüldü): entity/state/relation/event/causal-link/
  prediction tek dayanıklı store'da, temporal geçerlilik, claim/source tipleri,
  scope ayrımları, 15 yetenek + HTTP + ACOS okuması → ölçümle ✅ (D4/D5 gibi).
- **F4 tam boşluktu:** 12 perspektif + debate + consensus + itibar makinesi tamam,
  ama yürütme yolu hiçbir şey sormuyordu; `DecisionService.analysisId` alanı vardı,
  gerçek karardan gelen tek değer yoktu.
- **F5 yarımdı:** futureTree kümülatif olasılık veriyordu; cost/risk/benefit ve EV
  hiçbir yerde yoktu.

**Yapılan (köprü, ikinci sistem değil):**

- **F3:** motorun worldModel adapter'i görev başına **bir** dayanıklı tahmin açar
  (yalnız ilk denemede — puanlanan iddia "bu görev doğrulanır"; deneme sayısı değil)
  ve bitişte doğrulanmış sonuçla çözer → Brier + kalibrasyon restart'lar arası
  birikir. Tahmin hatası görevi düşürmez (advisory), rapor neyin kaybolduğunu söyler.
- **F2:** prior kanıt gelene kadar heuristic kalır ve `basis` "uninformed heuristic"
  der; ≥5 çözülmüş tahminde ölçülmüş sonuç oranıyla harmanlanır (ağırlık 5/20'ten
  1'e doğrusal), 20'de prior = ölçülmüş baz oranı. 4 örnek anekdottur — öğrenilmez.
- **F4:** `execute({ worldAnalysisId })` — bilinmeyen id çağıran hatası olarak
  hemen fırlar; **kapı** ilk denemeden önce çalışır: reject/hold → görev
  **blocked** (hiç deneme harcanmaz), proceed/uncertain → çalışır, konsensüs +
  muhalefet rapora not düşer. proceed/reject için konsensüs **karar defterine**
  yazılır (kriter = perspektif görüşleri, seçenekler proceed/do-not-proceed,
  ağırlıklar oranı koruyarak 0–1'e ölçekli, muhalefet rationale'larıyla korunur);
  görev bitince kayıt gerçek sonuçla kapatılır (blocked → "consensus applied",
  koştu → markExecuted + recordOutcome → "reviewed"). Kapı kendi hatasında
  **fail-closed**: analiz makinesi hata verip de görev sessizce koşarsa kapı
  lastik mühür olur.
- **F5:** senaryoya opsiyonel `cost`/`benefit` (0–1; tek taraflı tahmin saklanır ama
  EV üretmez); dal EV'si = **kümülatif** olasılık × (fayda − maliyet) — yalnız iki
  tahmin de varsa; `futureTreeOutlook`: kök EV (çocuklar iki kez sayılmaz),
  `riskMass` (net-negatif köklerin olasılık kütlesi), ölçülen/ölçülmeyen dal sayısı.
  Ölçülmemiş = **undefined**, asla gizli sıfır değil.

**Testler (17 yeni):** `test/world-model-prediction-loop.test.ts` (4 prior birimi +
2 gerçek-yol: retry'li görevde tek dayanıklı tahmin + çözümleme + kalibrasyon;
20 çözülmüş tahminle 0.25 baz oranının sonraki tahmini 0.25'e çekmesi) ·
`test/world-analysis-gate.test.ts` (3 loop sözleşmesi + 4 motor: reject → blocked +
defter + muhalefet, proceed → koşar + "reviewed" + gerçek sonuç, açık analiz →
blocked, bilinmeyen id → throw) · `test/world-future-tree.test.ts` (4: EV yalnız
ölçülende, kök EV/çift sayım yok, risk kütlesi + tümü-ölçülmemiş ağaçta EV yok,
doğrulama).

| Sabotaj | Sonuç |
|---|---|
| dayanıklı tahmin hiç açılmıyor | **2 failed** / 6 |
| resolve edilmiyor (kalibrasyon boş kalır) | **2 failed** / 6 |
| prior asla öğrenmiyor (harman kapalı) | **3 failed** / 6 |
| her denemede tahin açılıyor (sel) | **1 failed** / 6 |
| kapı motora geçirilmiyor | **3 failed** / 7 |
| kapı hatasında fail-open | **1 failed** / 7 |
| muhalefet karar defterine yazılmıyor | **2 failed** / 7 |
| ölçülmemiş dala sahte 0 EV | **3 failed** / 4 |
| EV kümülatif yerine dal olasılığı | **1 failed** / 4 |

Hepsi geri kondu: `diff -q` **RESTORE_OK**, iz **0**.

**F sonrası tam zincir:** `typecheck` **0** · `build --workspaces` **0 TS** ·
`npm test` **exit 0 — 1743 geçen / 0 failed / 244 dosya / 1 skipped** ·
`docs:state` **244 / 1732 / 30** · `release:prepare` **0** · `verify:integration`
**10/10** · OpenAPI **844** (yeni yol eklenmedi; mevcut rotaların şeması
zenginleşti — scenario cost/benefit, run-task `worldAnalysisId`).

**Sıra düzeltmesi (birleştirme hatası):** §5 uygulama sırası diyagramında
**Bölüm E (REASONING, E1–E7) yoktu** — birleştirilirken gözden düşmüş. Sıra:
… → D + F → **E (reasoning)** → G (agent society) → … olarak düzeltildi; E,
G'den önce kapanacak. (Aşağıdaki diyagram güncellendi.)

**Kapsam dışı (dürüstlük):** P1.24'ün "periyodik gerçek-tool-gözlemiyle hizalama"
maddesinin tam hali (out-of-date state taraması zaten `reassess` + ACOS
expire/inconsistency ile var; periyodik tetikleyici K3'ün scheduler'ına bağlı) ·
P1.26'nın "user goal alignment" maddesi J2 (goal model) olmadan anlamlı değil —
senaryoya `goalIds` bağlamak goal-model bölümünde yapılacak · `LearnedWorldModelService`
(rules) ayrı bir varlık olarak duruyor — prior öğrenmesi onun yerine
`WorldModelService` kalibrasyonundan besleniyor; iki sistemi birleştirmek ayrı ve
tehlikeli bir iş (veri göçü ister), bilinçli olarak yapılmadı.

### E — Reasoning: hipotez, eleştirmen ve dikkat gerçek karara girdi ✅ (2026-09-24)

**Bununla Bölüm E'nin tamamı (E1–E7) kapandı → sayaç 36 ✅.**
(A→B→C→D→F→E sırasıyla kapandı; sıradaki bölüm **G — AGENT SOCIETY**.)

**Ölçüm (yazmadan önce):**

- **E1:** `MultiHypothesisReasoningService` makinesi tamamdı (propose/evidence/
  test/reason/supersede, durable) ama yalnız HTTP `/v1/reason` ve bir durum
  penceresinden çağrılıyordu; yürütmedeki hiçbir karar hipotez üretmiyordu.
  `competingHypotheses` alanı her kayıtta vardı — dolduran hiçbir metot yoktu.
- **E2:** `InternalCriticService.review` yalnız ReasoningEngine (HTTP) ve durum
  penceresi tarafından çağrılıyordu. Planı hiç görmedi; hiçbir eleştiri hiçbir
  planı değiştirmedi.
- **E5+E6+E7:** Global Workspace (nesneler, bütçe, odak slotları, modlar,
  anayasal hedef sıralaması) kendi içinde tamamdı; girişimler ve ACOS
  döngüleri orada yarışıyordu — ama görevin kendisi (engine.execute) kara
  tahtaya hiç girmiyordu, bütçe yürütme yolunu bağlamıyordu ve "emergency"
  modunun hiçbir davranışsal etkisi yoktu (yalnız HTTP/capability'den elle
  değişiyordu).
- **E4:** karşıolgusal makinesinin ÇAĞIRANI YOKTU — tek sarmalayıcı
  (`WorldEngine.simulateCounterfactual`) senaryo eklemeden "recommended"
  olarak simülasyonun KENDİ id'sini döndürüyordu: hiçbir şeyin tavsiyesi.
- **E3:** büyük ölçüde önceki bölümlerle kapalıydı (B2 ask/research/think,
  B6/B7 kanıt katmanı, V3 ikinci-görüş paneli, ask_human tırmanması) + F2/F3
  kalibrasyonu → ölçümle ✅.

**Yapılan (köprü, ikinci sistem değil):**

- **E1:** loop'a `recoveryHypothesis` kancası — başarısız denemenin kurtarma
  stratejisi seçildiği anda (bu bir BAHİSTİR) motor rakip hipotez çiftini açar:
  "kurtarma X, K türündeki hatayı çözer" vs "hata yapısal; X çözemez".
  `markCompeting` ikisini bağlar. Sonraki denemenin TEMİZ verdict'i (pass/fail)
  ikisini `recordTest` + `addEvidence` ile ayrıştırır (biri confirmed biri
  refuted). "uncertain" dürüstçe notlandırmaz. Bahissiz ilk deneme notlandırılmaz.
- **E2:** loop'a `critiquePlan` kancası — plan üretildikten, ajan koşmadan ÖNCE
  (yalnız deneme 1, plan varsa): eleştirmen gerçek plan metnini (hedef + adımlar
  + doğrulama ölçütleri) görür. **reject → görev blocked** (eleştirmenin
  reddettiği plan sanki bir şey olmamış gibi yürütülmez), **revise →** her bulgu
  `Critic (severity): açıklama — öneri` satırı olarak kısıtlara/brifinge girer
  (B2'nin kanalı). Eleştirmen hatası görev düşürmez — değerlendirici, yetkili
  değil (kapıların tersine; bilinçli ayrım).
- **E5+E7:** `engine.execute` görevi Global Workspace'e **intake** eder
  (kind: problem, kaynak: user/agent, urgency önem eşlemesi P0–P4, bütçe
  varsa requestedTokens). **Dikkat kapısı** (loop'a `attentionGate`, analiz
  kapısından sonra, ikisi de fail-closed): mod politikası → günlük token
  bütçesi → odak slotları. Bütçe tükenmişse görev **blocked** (deneme harcanmaz);
  slot doluysa görev dürüst notla REZERVASYONSUZ koşar (arayan istemi arka plan
  bilişinden kovulamaz — P0 hariç preemption yok). Görev sonunda odak bırakılır
  ve **gerçek harcanan token** `completeFocus` ile bütçeye işlenir — slot
  sızıntısı yok, tahmin değil ölçüm muhasebesi var.
- **E6:** `MODE_ATTENTION_POLICY` koddaki politika olarak eklendi: emergency
  modunda urgency < 0.7 olan iş durur ("acil durum bütçesi krizdir"); P0 yine
  koşar. Modun artık davranışsal etkisi var; geçişler anayasal geçiş grafiğiyle
  sınırlı (emergency'den yalnız reactive/reflection'a çıkılır — test edildi).
- **E4:** `WorldEngine.simulateCounterfactual` dürüst sözleşmeye çevrildi
  (`recommendedScenarioId: null` — tavsiye, senaryo ve tahmin verecek
  `recommend()`'dendir). Tam makine HTTP'ye açıldı: 6 yeni yol
  (create/list/scenarios/recommend/outcome/calibration). Tahminler (effort/
  risk/cost/quality) çağıranındır — rotalar icat etmez.

**Testler (12 yeni):** `test/reasoning-integration.test.ts` — 3 loop eleştirmen
sözleşmesi (reject/revise/hata) + 2 loop hipotez sözleşmesi (fail→retry→pass
zinciri; uncertain notlandırmaz) + 5 motor (retry → confirmed+refuted rakip
çifti; plan eleştirisi gözlemlenir; kara tahta + odak bırakma; tükenmiş bütçe →
blocked; emergency → rutin durur/P0 koşar/reactive'e dönüş) + 2 karşıolgusal
(ağırlıklı skor + kalibrasyon; düzeltilmiş sözleşme).

| Sabotaj | Sonuç |
|---|---|
| dikkat kapısı motora verilmiyor | **2 failed** / 12 |
| bütçe tükenmesi engellemiyor | **1 failed** / 12 |
| emergency politikası uygulanmıyor | **1 failed** / 12 |
| görev kara tahtaya girmiyor (intake yok) | **2 failed** / 12 |
| odak hiç bırakılmıyor (sızıntı) | **1 failed** / 12 |
| kurtarma hipotezi açılmıyor | **3 failed** / 12 |
| hipotez notlandırılmıyor | **2 failed** / 12 |
| eleştirmen motora bağlı değil | **1 failed** / 12 |
| revise bulguları brifinge gitmiyor | **1 failed** / 12 |
| karşıolgusal skoru yok sayıyor | **1 failed** / 12 |

Hepsi geri kondu: `diff -q` **RESTORE_OK**, iz **0**.

**E sonrası tam zincir:** `typecheck` **0** · `build --workspaces` **0 TS** ·
`npm test` **exit 0 — 1755 geçen / 0 failed / 245 dosya / 1 skipped** ·
`docs:state` **245 / 1744 / 30** · `release:prepare` **0** · `verify:integration`
**10/10** · OpenAPI **850** (+6 karşıolgusal yolu; drift testi önce düştü —
844'tü, spec yeniden üretildi, 4/4 geçti).

**Kapsam dışı (dürüstlük):** eleştirmenin kural seti bugün critical/fatal
çıkarabilen kural içermiyor — reject dişleri loop sözleşme düzeyinde testli,
üretimde şu an en çok "revise" tetiklenir; anlamsal (model tabanlı) plan
eleştirisi ayrı iş. Karşıolgusal rotalarında simId üzerinde tenant doğrulaması
yok (servis katmanının önceden var olan tasarımı; learned-world rotalarıyla
aynı şekil — P bölümünde sertleştirilecek). "Think more vs act now"
kararı: görev bütçesi (`budgetExceeded`) + bilişsel bütçe kapısı + B2 ask
önerisi birlikte bu üçlüyü oluşturur; ayrı bir karar üretici modül yok.
Kaos testi: 8'den fazla eşzamanlı görevde 9.'sundan itibaren görevler
rezervasyonsuz-koşar yoluna düşer (bloke olmaz, not düşer) — eşzamanlılık
sınırı bilinçli politika, ölçülmedi.

### G — Agent society: plan devri gerçek yürütme yoluna bağlandı, yaşam döngüsü ve otobüs güvenliği tamamlandı ✅ (2026-09-24)

**Ölçüm (yazmadan önce):**

- **G1'in merkezindeki kopukluk:** `AuroraExecutionBridge` (delegate/activate/
  sync) tamamdı — 13 testi, deterministik aday sıralaması, economics-önce-
  posting, probation politikası vardı. Ama motorda `this.delegation.` için
  **sıfır çağrı** vardı: motorun `plan:` adaptörü `planner-v2.json`'a
  yazıyordu; köprünün okuduğu `PlanningService` planları gerçek yürütme
  yolundan hiç beslenmiyordu. "Kalan işi uzmana devret" yolunun tek girişi
  elle kurulan HTTP çağrısıydı.
- **G2:** marketplace'te `open→assigned→running→completed/failed` akışı
  vardı; **pause/resume/cancel yoktu**, iptalde bütçe rezervasyonu geri
  verilmiyordu, bir çocuk oturumun devri köklendirmesini (döngü) hiçbir şey
  engellemiyordu.
- **G4:** itibar kanıta bağlıydı ama **sönüm yoktu** — aylardır çalışmayan
  bir rolün itibarı tazeymiş gibi award skorusunda ağırlık taşıyordu.
- **G6:** otobüs mesajları (`broadcast`) herhangi bir giriş taramasından
  geçmiyordu; `fromRoleId` dışında provenance taşımıyordu. Motorun ön kapısı
  (goal taraması) ile yan kapı (otobüs) aynı standarda tabi değildi.
- Mevcut ve sağlam (yeniden yazılmadı): 23 builtin rol, deliberation +
  dissent + quorum, metaMonitor advisory'leri, retireUnderperformers,
  rol profili parent capability'yi aşamaz, tenant izolasyonu, harvester →
  `bridge.sync` zinciri.

**Yapılanlar:**

- **G1 — `mirrorPlanToSociety` (engine.ts):** `engine.execute` bittiğinde,
  raporun planı `PlanningService`'e yansıtılır (adım anahtarları normalize
  edilir, `dependsOn` kenarları korunur; loop statusları dürüst eşlenir —
  `succeeded→done`, `failed/timed_out→failed`, `blocked/unavailable→
  blocked`, `skipped/cancelled/simulated→skipped`; tamamlanma iddia etmeyen
  statuslar `pending` kalır). Ardından policy-kapılı devir: `autoDelegate`
  kapalıysa gözlemle atlanır; **capabilityTags yoksa devir reddedilir**
  ("uzman seçmek için eşleşecek yetkinlik olmadan seçim, tahmin olur");
  ready adımlar köprüye verilir (`activate: policy.autoActivate`).
  `capabilityTags`, `execute` girişine opsiyonel alan olarak eklendi —
  çağıran bilir, motor uydurmaz. Tüm hatalar gözlem olarak raporlanır,
  görevin verdict'ini asla değiştirmez.
- **G2 — lifecycle (agent-society-service.ts):** `pauseTask` (yalnız
  running'den; concurrency tavanından ve stalled izleyiciden çıkar, token
  rezervasyonunu TUTAR — görev hâlâ koşmayı planlıyor), `resumeTask`
  (yalnız paused'dan), `cancelTask` (open/assigned/running/paused'dan;
  terminal reddi; **rezervasyonu günlük bütçeye iade eder**; pause/cancel
  gerekçeleri kayda geçer). **Döngü koruması:** `postTask`, kökü çocuk
  oturum olan devri reddeder (`session.parentSessionId` → "delegation
  cycle") — devir ağacının kökü parent oturum olmak zorunda.
- **G4 — itibar sönümü:** `roles()` üzerinden `decayReputations` — kanıt
  eskidikçe itibar nötr 0.5'e **30 günlük yarı ömürle** yaklaşır; çıpa
  `reputationUpdatedAt` (son decay ya da son taze kanıt), yani sönüm
  okuma başına değil GEÇEN ZAMAN başına uygulanır; `recordOutcome` yeni
  kanıtla çıpayı sıfırlar. Tüm itibar tüketicileri (award sıralaması,
  köprü aday skoru, emeklilik) `roles()` üzerinden aktığı için kimse
  bayat sayı üzerinde hareket edemez.
- **G6 — otobüs güvenliği:** `broadcast` gövdesi, motorun goal taramasıyla
  AYNI `cognitiveRuntime.screenInput`'tan geçer; reddedilen gövde otobüse
  kalıcı olarak girmez (test, injection gövdesinin inbox'ta görünmediğini
  doğrular). Mesaja `fromLayer` (prime|council|specialist|micro) yazılır —
  provenance katmanı, tüketiciye tavsiyeyi katmana göre tartma imkânı verir.
- Yetenek kayıtları (`society.task.pause/resume/cancel`) + 3 HTTP rotası
  (`/v1/society/tasks/:id/pause|resume|cancel`).

**Test:** `packages/engine/test/society-integration.test.ts` — **7/7**:
mirror+devir (gerçek `engine.execute` + gerçek root oturum + gerçek
marketplace görevi), policy-kapalı dürüst atlama, tagsiz reddi, tam yaşam
döngüsü (gerçek `spawnChild`, gerçek child-session event kanıtıyla
`recordOutcome`), döngü koruması, otobüs taraması + provenance, sönüm
(40 günlük kanıt → 0.5+0.4·2^(−40/30); ikinci okuma değeri değiştirmez).

**Sabotaj (10/10 yakalandı, hepsi geri kondu, `diff -q` RESTORE_OK, iz 0):**

| Sabotaj | Sonuç |
|---|---|
| otobüs taraması devre dışı (passthrough) | **1 failed** / 7 |
| döngü koruması kaldırılır | **1 failed** / 7 |
| sönüm hiç uygulanmaz | **1 failed** / 7 |
| sönüm çıpası yok sayılır (createdAt'a sabitlenir) | **1 failed** / 7 |
| paused görev slotu meşgul tutar | **1 failed** / 7 |
| cancel rezervasyonu geri vermez | **1 failed** / 7 |
| motor policy'siz devreder | **1 failed** / 7 |
| tagsiz seçim reddi kalkar | **1 failed** / 7 |
| `fromLayer` sahte katman yazar | **1 failed** / 7 |
| resume her statüde çalışır | **1 failed** / 7 |

Komşu regresyon: 7 suite **68/68** (agent-society, delegation×2, harvest,
society-extensions, plan-replanning, reasoning-integration).

**G sonrası tam zincir:** `typecheck` **0** · `build --workspaces` **0 TS** ·
`npm test` **exit 0 — 1762 geçen / 0 failed / 246 dosya / 1 skipped** ·
`docs:state` **246 / 1751 / 30** · `release:prepare` **0** ·
`verify:integration` **10/10** · OpenAPI **853** (+3 lifecycle yolu; spec
yeniden üretildi, `docs:openapi:check` geçti).

**Bununla Bölüm G'nin tamamı (G1–G6) kapandı → sayaç 42 ✅.**

**Kapsam dışı / dürüstlük notları (G):** P1.28'in 15 fiilinden wait/join/
aggregate/escalate'nin birebir karşılığı yok (retry/reassign dolayık:
görev terminal olunca adım yeniden devredilebilir); pause kayıt katmanıdır,
çocuk süreci fiilen donduramaz (bu katman orkestrasyon durumunu sahipler,
process control değil — yorumda yazılı). P1.30'un "critical actions için
stronger consensus" kalıbı ayrı bir eşik politikası olarak kodlanmadı
(quorum + ağırlıklı çözüm mevcut). P1.32'nin sayısal trust-level
kademeleri yok; provenance katmanı (`fromLayer`) taşıyıcı olarak eklendi.
`AgentEconomyService`'in cpu/memory/storage wallet borsası (92 satır)
topluluk token bütçesinden hâlâ kopuk ayrı sistem — P1.31'in "token/time/
cost" şartını topluluk bütçesi karşılıyor, wallet borsası bağlanmadı.
Devir zincirinin kapanış yarısı (recordOutcome → `bridge.sync` → adım
kapanır) harvester döngüsüne ve HTTP'ye yaslanıyor; motor içi otomatik
tetikleyici değil.

### H — Embodiment: arac sözleşmesi dişli hale geldi, dosya sistemi kotaya ve kilite girdi, elleri (git/browser) ve gözleri (kod zekası/ortam) bağlandı ✅ (2026-09-24)

**Ölçüm (yazmadan önce):**

- **H1:** `CapabilityDescriptor`da input şeması, risk, side-effect, izin
  (`allowedCapabilityIds` + broker policy/approval zinciri) vardı. Yoktu:
  **idempotency beyanı** (idempotencyKey yalnız context'te taşıyordu),
  **output şeması**, **verifier** (etki doğrulaması), **rollback** (telafi).
  `defineCapability` üç parametreliydi; broker `capability.execute`'u çağırıp
  sonucu olduğu gibi döndürüyordu.
- **H2:** confinement + symlink savunması (realpath read/write-parent) +
  base64 binary yazma (sha256 doğrulamalı) tamamdı. Yoktu: **kota**, **dosya
  kilidi**, **büyük dosya akışı** (`filesystem.read` tüm dosyayı `readFile`
  ile belleğe alıp sonra dilimliyordu), **arşiv güvenliği** (hiçbir tar/zip
  açma yoktu).
- **H3:** process.exec + sandbox zaten sağlamdı (env allowlist scrub'ı,
  timeout, `SandboxResourceLimits` — motor init'te bağlı: 4096 MB/900 s/
  2048 MB/512 süreç, detached süreç grubu kill'i, stdout/stderr birleşik
  transcript) → **ölçümle kapalı**, yeniden yazılmadı.
- **H4:** tarayıcıda navigate/snapshot/click/type/press/computer.* vardı; yoktu:
  **select**, **dosya yükleme**, **aksiyon doğrulaması** (eylem işe yaradı mı
  hiç bilinmiyordu), **anti-loop** (sonsuza kadar aynı ölü butona basılabilirdi).
  İnsan onayı altyapısı (broker → policy → approval pending) vardı.
- **H5:** status/diff/branch/commit + hosted PR zinciri (create/comment/close/
  merge SHA-korumalı) vardı. Yoktu: **clone, push, rollback, CI durumu**.
- **H6:** LSP istemcisi + fallback scanner + catalog + diagnostics + sembol/
  tanım/referans + `verify.recipe/run` (build/test orkestrasyonu) vardı. Yoktu:
  **bağımlılık grafiği, yama üretimi, refactor doğrulaması**.
- **H7:** ortam haritası yoktu (`environment.ts` kaynak/bölge/eylem
  kayıtlarıydı; interpreter'lar, araç sürümleri, cihaz, proje yapısı ölçen
  hiçbir şey yoktu).

**Yapılanlar:**

- **H1 — ortak sözleşme (types.ts + schema.ts + broker):** descriptor'a
  `idempotency` ("inherent"|"keyed") ve `outputSchema` (zod→JSON) alanları;
  `Capability` arayüzüne `validateOutput` / `verify` / `rollback` metotları;
  `defineCapability` opsiyonel 4. parametre (`CapabilityContractSpec`).
  Broker: execute sonrası **output şeması ihlali çağrıyı düşürür**,
  **verify `ok: false` çağrıyı düşürür**, **execute/verify hatasında rollback
  denenir** (best-effort; başarısızsa "rollback not completed" diye kayda
  geçer, orijinal hatayı asla maskellemez). Core örnekler: `filesystem.read`
  (inherent + output), `filesystem.write`/`write_binary` (keyed + output +
  verify: diske geri oku/eşleş; rollback: önceki içeriği geri yükle, dosya
  yoksa sil), `git.ci.status` (inherent).
- **H2 — dosya sistemi (filesystem.ts + workspace-quota.ts + safe-tar.ts):**
  **Kota:** `WorkspaceQuota` (bounded tarama + 30 sn cache + delta takibi;
  `workspaceQuotaBytes` config'i, default 512 MiB); write/write_binary/patch/
  archive.extract öngörülen toplamla kotayı aşarsa yazmadan reddeder, aşım
  mesajı iki sayıyı da söyler. **Kilit:** `filesystem.lock/unlock` —
  `.aurora-locks/` altında O_EXCL kilit dosyası; sahiplenme sessionId bazlı
  (başkası açamaz), stale TTL aşılınca devralma; broker efekt günlüğü tek
  süreçte çağrıları serileştirdiğinden çift kilit tek motorda da imkânsız.
  **Akış:** `filesystem.read` createReadStream ile okur — maxChars dolunca
  akış yarılır (bellek sabit), `offsetBytes`/`limitBytes` pencere açar
  (dosyanın başını okumadan kuyruğa ulaşır). **Arşiv:** `filesystem.archive.
  extract` — `parseSafeTar` yalnız dosya+dizin kabul eder; traversal (`../`,
  abs, sürücü harfi), symlink/hardlink/device/fifo girişleri ve GNU long-name
  reddedilir; entry/tek dosya/toplam boyut sınırları; arşiv TAMAMEN
  doğrulanmadan tek bayt yazılmaz.
- **H4 — tarayıcı (browser-manager.ts + browser.ts):** `browser.select`
  (dropdown değeri) ve `browser.upload` (workspace dosyası; realpath sınır
  kontrolü — sembolik bağla dışarı sızma reddi); her aksiyon
  `performAction`'dan geçer: **aksiyon doğrulaması** (önceki/sonraki snapshot
  hash'i karşılaştırılır, `actionEffect: {changed, previousHash, currentHash}`
  raporlanır) + **anti-loop** (`detectActionLoop`: aynı aksiyon+hedef 3 kez
  VE sayfa hiç değişmedi → reddedilir; değişen tekrar = meşru retry).
- **H5 — git (git.ts):** `git.clone` (yalnız https, URL'de kullanıcı bilgisi
  yasak, host doğrulaması, depth-1 single-branch, hedef workspace içinde;
  **network riski → insan onay kapısı**), `git.push` (external_side_effect;
  force yok — refspec `HEAD:refs/heads/branch`), `git.rollback` (önce
  `rev-parse --verify`, sonra reset --hard + opsiyonel clean -fd, son durum
  raporu), `git.ci.status` (yerel dürüst rapor: doğrulama tarifi işaretçisi,
  ahead/behind, kirli ağaç, remote varlığı — hosted CI sonucu uydurmaz).
- **H6 — kod zekası (code-intelligence/service.ts + capabilities):**
  `code.dependencies` (JS/TS import/require/export-from + Python import;
  relative→dosya kenarı, paket→external; bounded + capped bayrağı),
  `code.patch.generate` (LCS satır diffleri; hunk numaraları örtüşen
  context'te doğru; **çıktı `filesystem.patch` ile birebir uygulanabilir** —
  round-trip testli; trailing-newline tuzağı bulundu ve üretici tarafta
  kapatıldı), `code.refactor.verify` (baseline diagnostics run'ına karşı:
  yeni hata → `regressed`, çözülen → `improved`, değişim yok → `clean`).
- **H7 — ortam haritası (environment-probe.ts + environment.probe):**
  interpreter'lar (node/npm/python3/pip3/git/make/tsc `--version` — hepsi
  session sandbox'ında ölçülür, bulunamayan "available: false" dürüst raporu),
  cihaz (df/nproc/free — ölçülemeyen alan yoksa `measured: false`), proje
  yapısı (bounded yürüyüş + dil dağılımı), izinler (canlı katalog risk
  dağılımı). **Ağ erişimi bilinçli olarak ölçülmez** — rapor bunu gerekçesiyle
  söyler.
- Mevcut test bütünlüğü: `browser-manager.test.ts`'in advertised-listesi
  bilinçli güncellendi (select/upload eklendi).

**Test:** `packages/engine/test/embodiment-hardening.test.ts` — **19/19**:
sözleşme beyanları (5: descriptor, verify, outputSchema, rollback, gerçek
write yolu), kota + kilit + yarış + akış + arşiv (4), git kapıları (4:
takım, onay kapısı, URL guard'ları, push deny), kod zekası (3), ortam (1),
tarayıcı (2: loop dedektörü + toolset).

**Sabotaj (10/10 yakalandı, hepsi geri kondu, `diff -q` RESTORE_OK, iz 0):**

| Sabotaj | Sonuç |
|---|---|
| broker verify çağırmaz | **1 failed** / 19 |
| broker rollback çağırmaz | **1 failed** / 19 |
| broker output şemasını doğrulamaz | **1 failed** / 19 |
| kota yazımda uygulanmaz | **1 failed** / 19 |
| kilit sahiplenme kontrolü yok | **1 failed** / 19 |
| arşiv traversal savunması yok | **1 failed** / 19 |
| clone https zorunluluğu yok | **2 failed** / 19 |
| tarayıcı loop dedektörü kör | **1 failed** / 19 |
| akış okuma offset yok sayar | **1 failed** / 19 |
| refactor kararı hep "clean" | **1 failed** / 19 |

Not: kilide ilk uygulanan O_EXCL sabotajı (wx→w) testi düşürmedi — broker'ın
efekt günlüğü tek süreçte çağrıları serileştirdiği için yarış O_EXCL'e hiç
 ulaşmıyormuş; sabotaj, ölçülebilir savunmaya (sahiplenme) çevrilip yakalandı.
 O_EXCL çapraz-süreç savunması olarak koddadır; tek süreçte davranışı
 efekt serileştirmesi kapsıyor.

Komşu regresyon: 9 suite **61/61** (browser-manager, code-intelligence,
git-capabilities, embodiment-integration, background-shell, policy-enforcement,
auto-approvals, adversarial-security, agent-profiles).

**H sonrası tam zincir:** `typecheck` **0** · `build --workspaces` **0 TS** ·
`npm test` **exit 0 — 1781 geçen / 0 failed / 247 dosya / 1 skipped** ·
`docs:state` **247 / 1770 / 30** · `release:prepare` **0** ·
`verify:integration` **10/10** · OpenAPI **853** (yeni HTTP rotası yok;
yeni yetenekler genel oturum uçlarından erişilir, spec değişmedi).

**Bununla Bölüm H'nin tamamı (H1–H7) kapandı → sayaç 49 ✅.**

**Kapsam dışı / dürüstlük notları (H):** P1.36'nın DOM+accessibility tree
kısmı mevcut snapshot'ın rol/aria etiketli interaktif eleman listesidir;
tam a11y ağacı değil. `git.ci.status` hosted CI (GitHub Checks API) okumaz
— yerel gerçeklerle çalışır; hosted entegrasyon P bölümünde
değerlendirilecek. `git.push` yalnız onaylı ve force'suz; merge politikası
hosted merge'in SHA korumasına dayanır. P1.39'un "network state" bilinçli
ölçülmez (probe gerekçesini rapor eder); "device state" df/nproc/free ile
sınırlı. `code.dependencies` tarayıcı (parser değil) dürüstlüğündedir.
Rollback yalnız beyan eden yetenekler için çalışır (filesystem.write/
write_binary) — genel bir "her araç geri alınır" iddiası yok.

### I+J — Research gerçek backend'ine kavuştu, kullanıcı modeli motorun olaylarına bağlandı ✅ (2026-09-25)

**Ölçüm (yazmadan önce):**

- `ResearchEngineService` engine'e bağlıydı ama `collectSources()` **`return []`**
  döndürüyordu ("In production, search multiple sources" yorumuyla) — araştırma
  motoru hiçbir zaman kaynak toplayamazdı; hiç research.* capability'si yoktu
  (user.\* 17 adeye karşı 0), hiç testi yoktu, çağıranı yoktu → ölü kod.
- `verifyCitation` yalnız arama snippet'ine bakıyordu; `verifySource` sabit
  "unverified"/0.5 stub'ıydı; alıntı→span→kaynak ilişkisi ve hafızada citation
  saklama yoktu. PDF parsing, tekilleştirme, freshness filtresi yoktu.
- Watcher kavramı initiative servisinde vardı ama yalnız elle `ingest()`
  edilen olayları tarıyordu — gerçek dünya değişiklik algılama yoktu.
- J bloğunda `UserModelService` zengin ve gerçekte (claims/consent/correction/
  goals/advice/signals, 17 capability) — ama `observeClaim`/`recordSignal`/
  `recordAdvice`'i capability dışında **hiçbir şey çağırmıyordu**: EventBus'a
  task.received (goal+userId taşıyor!) / completed / failed akıyordu, köprü yoktu.
  Goal çatışması/bağımlılığı, proje modeli, davranış ayarı, per-feature privacy
  ve retention yoktu.

**Yapılanlar:**

- **I1** `research-engine-service.ts` gerçek koleksiyonla yeniden yazıldı:
  WebSearchService (Brave/Tavily) + `fetchPublicDocument` (web.fetch ile aynı
  SSRF/redirect/bounded sözleşme — capabilities/web.ts'ten paylaşıldı) + iç
  kapsam için knowledgeIndex. HTML meta çıkarma, PDF metin çıkarıcı
  (`pdf-text-extract.ts`: Tj/TJ/hex operatörleri, escape'ler, FlateDecode
  zlib ile), URL-normalize (utm düşür) + SHA-256 digest + token Jaccard ≥0.85
  tekilleştirme, freshness skoru ve tarih aralığı filtresi
  (`source-extraction.ts`). Sağlayıcı yoksa açık hata — uydurma yok.
- **I2** alıntı doğrulama gerçek: span offset + contentDigest; verifySource
  yalnız kontrol edilebileni söyler; rememberResult hafıza grafa
  sourceType:external + evidenceRefs:citation-id yazar.
- **I3** rapor her bulguyu alıntıya bağlar (unsupportedFindings=0);
  `capabilities/research.ts`: research.query/report/remember +
  watcher.add/list/remove/run (network risk → broker onayı). verify-source
  HTTP rotası `verifyUrl` ile gerçek fetch+doğrulama yapar.
- **I4** watcher: içerik parmak izi karşılaştırma, baseline ≠ change ayrımı,
  önem skoru (değişim + anahtar kelime), initiative servisine öneri (dikkat
  bütçesi/dedup/quiet-hours orada); baskılanma ayrı sayaçta.
- **J1** `user-model-integration.ts`: EventBus (task.received/completed/failed
  + broker capability.finished) → consent kapılı wiring. task.completed/failed
  olaylarına userId eklendi. Engine'e `userModelIntegration` config'i.
- **J2-J5** user-model-service: dependsOn/conflictsWith + goalConflicts (beyan,
  döngü DFS, overcommit) + blockedGoals; UserProject modeli; advicePolicy;
  feature consent (inference default OFF) + retention (inferred silinir,
  user-stated kalır) + exportUser; forgetUser projeleri kapsar.
- **Çekirdek düzeltme (J1 ölçümünde bulundu):** `DurableJsonState.read()`
  paralel ilk-okumalarda `this.value`'yu ezebiliyordu (kayıp yazma yarışı) —
  paylaşılan ilk-yükleme promise'i ile düzeltildi; tüm Aurora servislerini korur.

**Test:** `test/research-engine.test.ts` (18 servis + 4 motor bağlantısı) +
`test/user-model-integration.test.ts` (22) = **44 yeni test, 44/44**. Motor
testleri onay kapısı desenini kullanır (research.query network risk →
approvals.list + resolve). Komşu regresyon: aurora-initiative-user-model,
web-search, embodiment-hardening, browser-manager, aurora-memory-graph,
aurora-cognitive-extensions, aurora-context, agent-society, aurora-operations,
aurora-end-to-end → 73/73.

**Sabotaj (10/10 yakalandı, her biri vitest'te en az 1 failure):**

| # | Sabotaj | Sonuç |
|---|---------|-------|
| S1 | collectSources'ta webSearch yapılandırma kontrolünü atla | 1F |
| S2 | verifyCitation'da "bulunamadı" reddini atla | 1F |
| S3 | Jaccard eşiğini 2 yap (yakın-kopya yakalanmaz) | ilk 0F → test yakın-kopya senaryosuna düzeltildi → 1F |
| S4 | PDF FlateDecode açmayı atla | 1F |
| S5 | Watcher digest karşılaştırmasını `true \|\|` ile etkisizleştir | 2F |
| S6 | Inference consent kapısını kaldır | 1F |
| S7 | advise-less eşiğini imkânsız yap | 1F |
| S8 | Retention cutoff'u 1000x büyüt | 1F |
| S9 | Goal döngü DFS'ini boş kütle çalıştır | 1F |
| S10 | DurableJsonState paylaşılan yüklemeyi yarışlı hale geri al | 1F |

S3'ün ilk koşusu 0F verdi: test mirror sayfasını title dahil birebir aynı
yazdığından SHA-256 digest eşleşmesi yakalıyor, Jaccard yolu hiç ezilmiyordu —
test gerçek yakın-kopyaya (digest farklı, örtüşme eşiğin üstünde) çevrildi.
Bu, "sabotaj 0F = test eksik" kuralının işlediğinin kanıtıdır.

**Zincir:** typecheck --workspaces **0** · build --workspaces **0** ·
`npm test` **exit 0 — 249 dosya / 1825 geçen / 0 failed / 1 skipped**
(+2 dosya, +44 test) · `docs:state -w @haf/eval` **249/1814/30** ·
OpenAPI **853 (check 0; spec değişmedi — verifyUrl mevcut rotanın
davranışıydı, yeni rota eklenmedi)** · `release:prepare` **0** ·
`verify:integration` **10/10**.

**Dürüstlük notları:**

- Ara sıra: "3 days ago" gibi göreli tarihler bilinçli reddedilir (ISO
  doğrulanabilir olana kadar publishedAt bilinmiyor kalır); tarih aralığı
  filtresi yalnız bilinen tarihlere uygulanır, bilinmeyen görünür kalır.
- PDF çıkarıcı basit kodlamalı içerik akışlarında çalışır (LaTeX/Word
  çıktıları); CID/CMap fontları ve taranmış belgeler desteklenmez — sebep
  söylenir, içerik uydurulmaz.
- Watcher importance skoru sezgiseldir (değişim oranı + anahtar kelime);
  dikkat bütçesi kararını initiative servisi verir.
- J1'de auto-gözlem yalnız "takip edildi"yi bilir; "yardım etti" kullanıcı
  reytingi olmadan asla varsayılmaz (autoObserved işaretiyle ayrılır).
- Araştırma hafızası (research-memory) consent anahtarı entegrasyon
  katmanını bağlar; research.remember capability'si agent/kullanıcı
  çağrısıyla çalışır (capability düzeyinde ayrı bir kapı yoktur).
- HTTP yüzeyinde /v1/research rotaları vardı; davranışları gerçek hale geldi,
  OpenAPI spec'i değişmedi.

**Bununla Bölüm I'nin (I1–I4) ve Bölüm J'nin (J1–J5) tamamı kapandı → sayaç 58 ✅.**

### K — Proaktif katman olay akışına, karar izlerine ve gerçek kanal seçimine kavuştu ✅ (2026-09-25)

**Ölçüm (yazmadan önce):**

- Initiative servisinin kendisi (worthiness, P0-P4, dikkat bütçesi, quiet
  hours, trust adaptasyonu, dedup, escalate, digest) gerçek ve testliydi —
  ama **çevresi kopuktu**: `MemoryInitiativeIntegration` olmayan
  `engine.initiative.scan()` metodunu çağırıyor, hata sessizce yutuluyordu →
  memory→initiative köprüsü hiç çalışmamıştı. git/files/research/environment/
  tasks/schedules/notifications kaynaklarından otomatik intake akışı yoktu.
- `runWatchers`/`evaluate`/`buildDigest`'i periyodik çalıştıran hiçbir şey
  yoktu — DurableScheduler gerçek ve restart-safe ama yalnız prompt job'ları
  dispatch ediyordu; proaktif döngü dönmez durumdaydı.
- Kanal altyapısı (email/IRC/Twilio adaptörleri, registry, gateway routing)
  gerçekte; ama queued initiative'in hangi kanaldan gideceğini seçen bir
  mantık, kanal tercihi ve deliver akışı yoktu.
- Kararlar açıklamasızdı ("neden bölündüm?" sorusu cevapsız), tür susturma
  yoktu (dismiss tekil), digest yalnız initiative'lerden kuruluyordu (proje
  riski / hedef / hafıza değişikliği bölümleri yok).
- goalAlignment parametresi verilmezse userRelevance'e düşüyordu — kullanıcı
  modelinin aktif hedeflerine bakılmıyordu; context fit kavramı yoktu.

**Yapılanlar:**

- **K1** `initiative/proactive-intake-bus.ts`: EventBus (task.completed/
  failed → "tasks") + broker capability.finished (git.* → "git";
  filesystem yazma → "filesystem"; research.* → "research"; environment.probe
  → "system") + gateway onIngested (inbound mesaj → "notification") +
  schedule ateşlemeleri (tick'te çekilir; lastScheduleFire ile aynı ateş
  bir kez raporlanır; restart sonrası en son ateş bir kez tekrar edebilir —
  initiative dedup zararsız kılar, dürüst not journalda). Ölü scan() köprüsü
  gerçek `ingest(source:"memory")` ile değiştirildi.
- **K2** InitiativeProviders DI: contextState (user model state estimate;
  busy → P1 digest'a, guardian risk muaf; tahmin yoksa=hiçbir şey) ve
  goalAlignment (aktif hedeflere karşı gerçek skor).
- **K3** `tenants()` + `runProactiveCycle` (watchers → evaluate → dönem
  digest'i yalnız yeni periodKey'de) + motor tarafında interval timer
  (`proactive.intervalMinutes`, default 5, 0=kapalı).
- **K4** kanal tercihleri + selectChannel (tercih ∩ mevcut adaptörler;
  in-app daima; gerekçe metinle) + deliver (gerçek send + markDelivered).
- **K5** digestSections DI + motor wiring'i (Project risks / Goal changes /
  Memory changes gerçek servislerden).
- **K6** InitiativeDecision izi (aritmetiğiyle birlikte reason) + muteKind
  (deadline'lı, kendiliğinden düşen).

**Test:** `test/proactive-engine.test.ts` — **22 test, 22/22** (K1 bus 4, K2
3, K3 2, K4 4, K5 2, K6 2, motor wiring 5: capability envanteri, tam döngü,
gerçek goal-alignment, mute uçtan uca — privileged onay kapısı deseniyle).
Komşu regresyon: aurora-initiative-user-model, user-model-integration,
research-engine, aurora-cognitive-extensions, channels, channel-routing,
hosted-scheduler → **67/67**.

**Sabotaj (10/10 yakalandı):**

| # | Sabotaj | Sonuç |
|---|---------|-------|
| S1 | intake bus kaynak eşlemesini tamamen kapat | 1F |
| S2 | context-fit busy erteleme dalını kapat | 1F |
| S3 | goal-alignment provider çağrısını atla | 2F |
| S4 | mute denetimini `false &&` ile boşa çıkar | 2F |
| S5 | queued karar nedenini "ok" sabitine çevir | 1F |
| S6 | selectChannel'da uygunluk filtresini kaldır | 1F |
| S7 | deliver'da gerçek gönderimi atla | 1F |
| S8 | digest canlı bölümlerini yoksay | 1F |
| S9 | digest "zaten var" kontrolünü her zaman true yap | 2F |
| S10 | motor döngüsünde tenant listesini boş sabitle | 1F |

Not: S1'in ilk denemesi yanlış uygulanmıştı (mevcut satırlara dokunmayan ölü
kod ekledi → 0F). Sabotaj "metodun tamamını etkisizleştirmeli" ilkesiyle
yeniden uygulandı → 1F. Test eksikliği değildi, sabotaj uygulama hatasıydı.

**Zincir:** typecheck --workspaces **0** · build --workspaces **0** ·
`npm test` **exit 0 — 250 dosya / 1847 geçen / 0 failed / 1 skipped**
(+1 dosya, +22 test) · `docs:state -w @haf/eval` **250/1836/30** ·
OpenAPI **853 (check 0; yeni rota eklenmedi)** · `release:prepare` **0** ·
`verify:integration` **10/10** (ilk koşu 9/10: release:prepare ile verify
yanlışlıkla paralel koşmuştu — manifest yazımı bitmeden sayıldı; sırayla
yeniden koşumda 10/10; zincirin kendisi değil, koşum sırası hatasıydı).

**Dürüstlük notları:**

- Schedule intake "pull" modelidir: her tick'te lastRunAt değişen job'lar
  raporlanır; in-memory takip nedeniyle restart sonrası en son ateş bir kez
  tekrar raporlanabilir (initiative dedup zararsız kılar). Kalıcı offset
  iddiasında bulunulmaz.
- environment.probe → "system" kaynağına maplenir (enum'da "environment"
  yoktur; mevcut katalogla dürüst eşleme).
- context fit yalnız "busy"/"working" tahminlerinde P1'i erteler; tahmin
  yokluğu asla "boşta" varsayılmaz; guardian risk asla ertelenmez.
- selectChannel yalnız gerçekten yapılandırılmış adaptörleri görür
  (outboundChannels.list); in-app ürün yüzeyi olduğundan daima mevcuttur.
- Digest bölümleri sağlayıcı cevap vermezse eklenmez ("honest absence"),
  sağlayıcı patlarsa briefing yine de üretilir.
- Kanal tercihi capability'si privileged'dır; evaluate de öyle — insan onayı
  olmadan sessizlik politikası değiştirilemez (testler onay kapısı
  deseniyle çalışır).

**Bununla Bölüm K'nın tamamı (K1–K6) kapandı → sayaç 64 ✅.**

### L+M — Düşünme/özyansıma katmanı ve öğrenme sistemi karar yüzeylerine kavuştu ✅ (2026-09-25)

**Ölçüm (yazmadan önce):**

- **L1 🟡** background-thinking'in sayaçları ve thread'leri in-memory idi;
  `start()` yalnız flag çeviriyordu; `runCycle`'i periyodik çağıran hiçbir
  şey yoktu (gerçek kadans autopilot/ACOS'ta; bu servis ayrı katman).
- **L2 ✅** curiosityQueue skoru (1−güven)×etki×önem gerçek; capability ve
  ACOS reflect tüketicisi var.
- **L3 🟡** OpenProblem zengindi (findings/nextStep/reviewIntervalDays) ama
  hipotez ↔ problem bağlantısı yoktu.
- **L4 ✅** thought anchor'lar memory-graph'te durable; dueAnchors + ACOS
  tüketimi çalışıyor.
- **L5 🟡** `reflect()` `tenantId === "local"` hardcode idi — diğer
  tenant'lar boş yansıtıyordu; olay tetikli çağıranı yoktu.
- **L6 ✅** dream mode 60s bütçeli ve yan etki kısıtlı; kadans default OFF.
- **L7 🆕** `recordCapabilityOutcome` yalnız unified-engines'ten yazılıyordu;
  karar mekanizması (güçlü/zayıf yön, güvenilirlik, öneri) hiç yoktu.
- **M1 ✅** outcome-harvester motor 1910 + delegation hook 1866'da wired.
  **M2–M4 ✅** skill-evolution (gaps/blueprints/evaluation/usage/regression
  baselines/advanceStage/retire/sweep). **M5 ✅** capability-acquisition.
- **M6 ❓** rollout değerlendirmesi yalnız `exitCode === 0` — before/after
  görev skoru ve performans etkisi ölçülmüyordu (P2.6'nın özü).
- **M7 🟡** self-debugging durable'dı ama `selfHeal` anahtar-kelime
  şablonuydu: doğrulanmış fix geçmişine hiç bakmıyordu.
- **M8 🆕** strateji sonuçları (ne zaman doğrula/delegele/sor) hiç
  ölçülmüyordu (P2.9).

**Yapılanlar:**

- **L1** `background-thinking-service.ts`: sayaçlar ve thread'ler durable
  ledger'a (`background-thinking/ledger.json`, DurableJsonState, lazy-init
  uyumlu) taşındı; `init()` eklendi; kesinti politikası iterasyon sınırında
  `stopRequested` ile (explicit `runCycle` çağrıları etkilenmez — test bunu
  yakaladı ve tasarım düzeltildi). Motor tarafında kadans timer'ı
  (`backgroundThinkingIntervalMinutes`, default 30, 0=kapalı, unref) +
  `runBackgroundThinkingForAllTenants()` (initiative.tenants() üzerinden;
  bir tenantın hatası döngüyü durdurmaz).
- **L3** `thought-core-service.ts`: `Hypothesis.problemId?` +
  createHypothesis'ta bağlantı doğrulaması (yanlış link throw) +
  `hypothesesForProblem()` (updatedAt desc).
- **L5** `self-model-service.ts`: reflect() tenant fix + yeni insight'lar
  (son dersler — pattern artık ne yapılacağını da söylüyor; test edilmemiş
  hipotezler; >5 aktif hedef). `self-model-integration.ts` (yeni):
  task.completed → hedefli yansıma (milestone) + strateji sonucu;
  task.failed → failure yansıması + recordFailure (kök neden ayrıca
  izole edilmediği dürüstçe etiketli) + strateji sonucu; handler'lar
  fail-open (yansıma yansıttığı görevi düşüremez). Periyodik yansıma
  autopilot'un reflection kadansında (24h) zaten vardı.
- **L7** `decisionInputs()`: strengths/weaknesses/reliabilityPerCapability/
  knownLimitations/uncertainty(+basis)/currentWorkload/availableTools —
  capability ve model listeleri gerçek kaynaklardan (motor registry'leri).
  `advise()`: verify/delegate/ask-user önerileri yalnız ölçülmüş geçmişle;
  geçmiş yoksa "sapma için neden yok" dürüst cevabı. `knownLimitations()`:
  failRate ≥ 0.4 & ≥3 tekrar kanıtla; `recordCapabilityOutcome` artık
  tanımlı olmayan capability'yi "unknown" düzeyinde kendisi yaratıyor
  (outcome ground truth; eskiden sessizce yok sayılıyordu — test yakaladı).
- **M8** `recordStrategyOutcome()` + `strategyAdvice()`: <5 örnek →
  "insufficient-evidence" (tahmin üretmez); ≥5 → ölçülmüş başarı
  oranlarından verify/delegate/research/ask-user önerileri.
- **M7** `selfHeal()`: aynı subsystem'deki doğrulanmış (verified) fix'ler
  geçmişten sorgulanır ve yeniden uygulanacak adımlar olarak döner
  (reapply-verified-fix-N + verify adımı); geçmiş yoksa şablon fallback
  "basis: symptom-template" olarak dürüstçe etiketlenir ve
  reproduce/isolate/hypothesize adımları eklenir.
- **M6** `learning-rollout.ts`: `runBaseline()` (değişiklik ÖNCESİ ölçüm;
  exitCode + outputHash + durationMs) + `runEvaluation()` sonrası
  `semanticVerdict` (exitCodeRegressions / behaviorChangedCommands /
  medianDurationDeltaMs / verdict) + regression kapısı: baseline'da geçen
  komutun sonra düşmesi promote'u engeller ve gerekçe governor kaydına
  "semantic:regression / Regression vs baseline" olarak yazılır. Süreler her
  iki tarafta ölçülür (performans etkisi görünür). API:
  `POST /v1/learning/releases/:id/baseline`.
- **Yüzeyler:** `capabilities/self-model.ts` (yeni): self.decision.inputs,
  self.advise, self.limitations, self.strategy.record, self.strategy.advice,
  self.reflect, self.debug.selfheal, self.debug.report. Control-API:
  /v1/self-model/reflect (tenant+trigger parametreleri — eskiden tenant
  yok sayılıyordu), decision-inputs, limitations, advise, strategy-advice,
  strategy-outcomes.

**Test:** `test/lm-learning-and-selfmodel.test.ts` — **9 test, 9/9** (L3
problem-link + kötü link reddi + tenant izolasyonu; L1 durable ledger +
restart + thread temizliği; L5 tenant izolasyonu + ders içeriği; L7
reliability + delegate önerisi + geçmişsiz dürüst cevap; M8 eşik altı
dürüstlük; M7 verified-history önce/şablon sonra + basis etiketi; M6
regression bloğu ve no-baseline dürüst raporu; L5 wiring olay → yansıma,
deterministik sayaçlarla). Komşu regresyon: background-thinking,
thought-core, thought-memory-integration, aurora-acos, p2-self-model,
p2-self-debugging, learning-rollout → **81/81**.

**Sabotaj (8/8 yakalandı):**

| # | Sabotaj | Sonuç |
|---|---------|-------|
| S1 | runCycle başına sabit dönüş (ledger'a hiç yazmaz) | 1F |
| S2 | hypothesesForProblem'u boş döndür | 1F |
| S3 | reflect'te tenant filtresini kaldır | 1F |
| S4 | advise'a sabit "öneri yok" dönüşü | 1F |
| S5 | strategyAdvice'u hep insufficient-evidence sabitle | 2F |
| S6 | selfHeal'da verified-fix filtresini boşa çıkar | 1F |
| S7 | regression kapısını `regressed = false` sabitle | 1F* |
| S8 | task.completed handler'ında reflect'i `if (false)`'la | 1F |

Not (*): S7'nin ilk koşumu 0F verdi — test status beklentisiyle ayrım
yapmıyordu çünkü `regressed ⊆ ¬passed` (status zaten evaluation_failed).
Ayrımın gerçek yerinin governor kaydındaki "semantic:regression" gerekçesi
olduğu anlaşılınca test gerekçe kanıtını da içerecek şekilde güçlendirildi;
yeniden koşumda 1F. Sabotaj, testin zayıflığını buldu — tasarım doğruydu,
test ayrımı eksikti.

**Zincir:** typecheck --workspaces **0** · build --workspaces **0** ·
`npm test` **exit 0 — 251 dosya / 1856 geçen / 0 failed / 1 skipped**
(+1 dosya, +9 test) · `docs:state -w @haf/eval` **251/1845/30** ·
OpenAPI **859 (check 0; +6 rota)** · `release:prepare` **0** ·
`release:verify` **valid** · `verify:integration` **10/10**.

**Dürüstlük notları:**

- L1'de `running` flag'i bilinçli olarak in-memory kalır (süreç kapsamı);
  kalıcı olan sayaçlar, thread'ler ve kesintiYE kadar tamamlanan işler.
  Restart çalışan bir döngüyü keser — bu bilinçli davranış, ledger'daki
  iş yarıda kalmış sayılmaz.
- M6'da outputHash farkı (behaviorChanged) tek başına ASLA red nedeni
  olmaz — bilinçli bir davranış değişikliği de olabilir; yalnız
  exitCode regresyonu (baseline'da geçip sonra düşen) kapıdır.
  `regressed ⊆ ¬passed` olduğundan status ayrımı yoktur; ayrım governor
  kaydındaki gerekçedir.
- M6 baseline yokluğu sessizce "geçti" sayılmaz: verdict "no-baseline"
  olarak raporlanır (karşılaştırma yapılamadığı açıkça söylenir).
- M8 <5 örnekte tavsiye üretmez; "insufficient-evidence" modu sonuçtur,
  hata değil.
- M7 selfHeal şablon fallback'i artık kendini "symptom-template" olarak
  etiketler; verified-geçmiş önerisi "reapply-verified-fix" adımlarıyla
  gelir ve kapatma öncesi verify adımı zorunludur.
- L5 task.failed yansıması kök neden analizi yapmaz; recordFailure'e
  yazdığı ders "needs investigation" olarak etiketlenir — otomatik
  kök-neden iddiasında bulunulmaz.
- Motor kadansı default 30 dk'dır ve 0 ile kapatılabilir; açık
  `runCycle` çağrıları her durumda çalışır (test bunu garanti eder).

**Bununla Bölüm L'nin (L1–L7) ve Bölüm M'nin (M1–M8) tamamı kapandı → sayaç 65 ✅.**

### P+O — Güvenlik sertleştirmesi kanıtlandı, kalıcılık/dağıtık katman karar yüzeylerine kavuştu ✅ (2026-09-25)

**Ölçüm (yazmadan önce):**

- **P1 🟡:** Görev metni (`screenInput`) ve capability argümanları
  (pre_capability guard) taranıyordu; society broadcast G6 screening'i,
  memory yazımında injection scan zaten vardı. **Ama tool ÇIKTILARI**
  (dosya içeriği, exec stdout, web/PDF snippet'leri) modele dönerken hiç
  taranmıyordu — dolaylı enjeksiyonun ana kanalı açıktı.
- **P2 ✅çoğunlukla:** SSRF gerçek (assertSafeUrl + redirect yeniden
  doğrulama), path confinement, credential-exfiltration pattern'i guard'da —
  ama vektör bazlı tek paket yoktu.
- **P3 🟡:** tenant izolasyonu servis servis gerçekti, tek saldırı paketi
  olarak doğrulanmıyordu.
- **P4 🟡:** masking (buildApprovalPreview) ve kapsamlı lease'ler gerçek;
  **secret rotasyon yoktu.**
- **P5 🟡:** onay kaydı resolve edilince pending'den siliniyor, kimse
  tutulmuyordu; güvenlik olayları yalnız in-memory Map'te yaşıyordu.
- **P6 ✅:** screening fail-closed testleri zaten güçlü.
- **O1 🟡:** NATS transport gerçek (event bridge + command bus) ama node
  identity/capability discovery/remote execution yok — tek-runtime ürün.
- **O2:** master "if retained in final vision" diyor → **karar: tutulmuyor**
  (aşağıda gerekçe).
- **O3 🆕:** model seçiminde cihaz farkındalığı (local/cloud, gizlilik) yoktu.
- **O4 ✅:** Postgres katmanı gerçek ve pg-mem ile testli (migrations, RLS,
  event store, snapshot, journal'lar); JSON state uygun yerlerde.
- **O5 🆕:** yedekleme hiç yoktu (yalnız dosya bazlı write-backup).
- **O6 ✅çoğunlukla:** pg session lease (TTL+renewal), scheduler
  advance-before-dispatch, command/effect journal dedup — semantikler
  dokümante edilmemişti.
- **O7 🟡:** split-brain önleme lease'lerle var; partition senaryoları
  test edilmemişti.
- **O8 🆕:** yük/ölçek testi yoktu.

**Yapılanlar:**

- **P1 (çekirdek):** `src/security/untrusted-content-gate.ts` (yeni) —
  prompt-hedefli pattern'lerle tarama; tespit → içerik **çitle çevrilir**
  (`<UNTRUSTED_CONTENT source=... warning=...>`), orijinal metin çitin
  içinde korunur (güvenlik analisti enjekte sayfayı hâlâ okuyabilir);
  kill switch → içerik tamamen karantinaya alınır. **Tek dikiş noktası:**
  broker'da yeni `tool_result` transform hook'u — ara çıktısı model
  bağlamına giren HER capability (fs.read, process.exec, web/PDF research,
  MCP, plugin) bu sınırdan geçer. Guard hook'un tasarım felsefesiyle aynı:
  payload pattern'leri (SQL/command/path) bilinçli olarak HARİÇ — yorumlayıcı
  capability'nin kendi sorumluluğu (guard hook'taki ölçümle aynı gerekçe).
- **P5:** `ApprovalService.resolve(id, decision, resolvedBy?)` — kimlik +
  zaman kaydı; resolve/timeout/auto-approve yollarının hepsi kalıcı
  `audit/approvals.jsonl`'a who/what/when/why/decision yazar.
  `KillSwitchManager.setAuditSink` — motor, güvenlik olaylarını
  `audit/security-audit.jsonl`'a zincirli append ile yazar. Yeni
  `security.audit.query` capability: kayıtların **depolama temelini de
  söyler** (durable dosya vs in-memory — in-memory olan "durable" diye
  sunulmaz). API: `/v1/approvals/:id/resolve` artık `resolvedBy` alır.
- **P4:** `CredentialBroker.rotate()` — değer değişir, version artar,
  **bekleyen tüm lease'ler ölür** (rotasyon kozmetik olamaz: eski değer
  lease süresi boyunca erişilebilir kalırdı).
- **O3:** `ModelProviderRegistry`'ye locality bildirimi
  (`setLocality`) + `ModelRequest.privacy`: "local-only" → beyan edilmemiş
  sağlayıcı **cloud sayılır** (güvenli varsayım), liste boşalırsa dürüst
  hata (sessiz cloud fallback'i yok); "prefer-local" → yerel önce, cloud
  yedek. Motor config: `modelLocality`.
- **O5:** `src/persistence/backup-service.ts` (yeni) — full/incremental
  (yalnız değişen hash'ler kopyalanır, manifest tüm ağacı listeler),
  verify (zincirdeki her saklı dosya SHA256 yeniden hash'lenir), restore
  **önce doğrular, tek uyumsuzlukta hiç dokunmaz** (kısmi restore yok).
  Motor: `engine.backups` (config `backupRoot`, default data kökü dışında).
- **O6/O7/O8 testleri** (aşağıda) — mevcut garantileri ölçüme bağladı;
  kod değişikliği gerektirmeyenler dürüstlük notu olarak hazırlandı.

**Test:** `test/po-security-hardening.test.ts` — **15 test, 15/15**;
`test/o-distributed-persistence.test.ts` — **9 test, 9/9**. P1: direkt
görev reddi + gerekçe · dosya okuma çitleme (benign dokunulmaz) · exec
stdout çitleme (argümanlarda enjeksiyon YOK — o yol guard testi) · memory
kapıdan red + **disk-manipülasyonu sonrası recall çitleme** · PDF
kaynak-düzeyi çitleme + kill-switch karantini. P2: path traversal,
credential-exfiltration argüman redi, SSRF (onay akışı içinden gerçek
red). P3: memory/society/scheduler/workspace çapraz-tenant. P4: rotasyon
lease'leri öldürür + yeni lease yeni değeri görür + masking. P5: kimlikli
resolve + kalıcı iz + sorgu yüzeyi. O3: local-only boşta hata / yerel
sağlayıcıyla çalışır / prefer-local sıralaması (route_selected ile).
O5: zincir geri yükleme + **bozuk yedekte fail-closed** (canlı ağaca
dokunmaz). O6: dispatch çökmesi yeniden ateşlemez (advance-before-dispatch,
restart eşdeğeriyle). O7: pg erişilemez → dürüst ECONNREFUSED. O8: 8
eşzamanlı session (kirletilme yok), 30 job'lık tick + ikinci tick no-op,
60 kayıt × 20 eşzamanlı arama izolasyonla.

**Testin bulduğu gerçek hata:** incremental zincirinde kalıtsal dosyalar
(`stored: false`) manifestte listelendiği için chainFiles map'inde
saklandıkları yedeği EZİYORDU → verify/restore saklı olmayan kopyaya
bakıp başarısız oluyordu. Test ilk koşumda kırmızı verdi; servis
düzeltildi (incremental + !stored → atla). Sabotaj S10 aynı hatayı
bilinçli olarak yeniden üretti ve yine yakalandı.

**Sabotaj (10/10 yakalandı):**

| # | Sabotaj | Sonuç |
|---|---------|-------|
| S1 | gate hiç çitlemez (detect boş metne bakar) | 5F |
| S2 | broker tool_result dikişi başka hook'a yönlenir | 4F |
| S3 | resolve kimliği "unnamed-operator" sabitine düşer | 1F |
| S4 | güvenlik olayları durable'a yazılmaz | 1F |
| S5 | rotasyon eski lease'leri yaşatır | 1F |
| S6 | memory tenant filtresi kaldırılır | 1F |
| S7 | restore doğrulama kapısını atlar | 1F |
| S8 | local-only filtresi kaldırılır | 1F |
| S9 | scheduler advance'ı dispatch'ten önce diske yazmaz | 1F |
| S10 | incremental zincir kaynağı yine ezmeye döner | 1F |

**Zincir:** typecheck --workspaces **0** · build --workspaces **0** ·
`npm test` **exit 0 — 253 dosya / 1880 geçen / 0 failed / 1 skipped**
(+2 dosya, +24 test) · `docs:state -w @haf/eval` **253/1869/30** ·
OpenAPI **859 (check 0; yeni rota yok, approvals resolve body şeması
güncellendi)** · `release:prepare` **0** · `release:verify` **valid** ·
`verify:integration` **10/10**.

**Dürüstlük notları:**

- **P1'de çitleme engelleme değildir** — bilinçli tasarım: enjekte içerici
  sayfayı ANALİZ etme görevi meşrudur; içerik korunur ama talimat gibi
  görünemez. Karar yüzeyleri (görev metni, capability argümanları, society
  broadcast) bloke edilir; veri kanalları çitlenir ve güvenlik olayı
  yükselir.
- Tool çıktısındaki payload pattern'leri (SQL/command/path/script)
  taranmaz — o desenlerin yorumlayıcısı ilgili capability'dir ve kendi
  sınırını zaten kontrol eder (guard hook'taki ölçümle aynı sonuç).
- E-posta: inbound gövde "UNTRUSTED INBOUND EMAIL" işaretleriyle görev
  metnine girer → görev metni screening'i enjeksiyon varsa görevi REDDER
  (fail-closed). Analist-incelemesi senaryosu için dosya/URL kanalları
  çitlemeli yolu kullanır.
- O2 **tutulmuyor:** hiçbir yerde parametre/gradyan eğitimi yok; öğrenme
  lokal outcome/skill bazlı. Var olmayan bir eğitim döngüsü için secure
  aggregation sahtesi yapmak ölçüm kuralını ihlal eder. Master'ın "if
  retained" koşulu bu gerekçeyle "not retained" olarak kapatıldı.
- O1 🟡 kalır: NATS transport (event bridge + command bus) gerçektir;
  node identity/capability discovery/remote execution yoktur, ikinci bir
  runtime olmadan federation testi tiyatro olur. Tek-runtime ürün olarak
  dürüst etiketlendi.
- O3'te latency/battery/GPU telemetrisi YOKTUR — headless sunucu
  çalışma zamanında bu ölçümler uydurma olur. Gerçek olan: local/cloud
  ayrımı + gizlilik kısıtı + boş listede dürüst hata.
- O5 PITR = "zincirdeki herhangi bir yedek noktasına dönüş" (tutarlı
  anlık görüntü). PostgreSQL event store için replay-PITR veritabanının
  kendisine aittir (events+snapshots tabloları); bu serviste olduğu
  iddia edilmez.
- O6 semantikleri: scheduler/dispatch **at-least-once** (advance
  durable-before-dispatch; çökme yeniden ateşlemez), effect journal
  belirsiz sonuçta replay'i BLOKLAR (uncertain → hata), pg session lease
  tek sahiplik (split-brain önleme), JSON modda cross-node durum yoktur.
- O7'de NATS partition dayanıklılığı client auto-reconnect
  (maxReconnectAttempts: -1) yapılandırmasıyla sağlanır; uygulama
  katmanında ayrı devre kesici yoktur — belirtilmedik iyileştirme iddiası
  yok.
- `security.audit.query` in-memory olayların temelini "in-memory" olarak
  etiketler; durable dosya yoksa "absent" raporlanır, uydurulmaz.
- Onay kimliği gelmediğinde kayıt "unnamed-operator" yazar — isim
  uydurulmaz; timeout kaynağı "timeout", otomatik onay "auto-rule:ID".

**Bununla Bölüm P'nin (P1–P6) ve Bölüm O'nun (O1–O8) tamamı kapandı (O2 gerekçeli tutulmama kararıyla) → sayaç 66 ✅.**

### N+Q — Multimodal dürüstleştirildi, gözlemlenebilirlik karar yüzeylerine kavuştu ✅ (2026-09-25)

**Ölçüm (yazmadan önce):**

- **N1 STT ✅gerçek:** AudioService (OpenAI-uyumlu HTTP, workspace
  confinement, byte limiti, dil/prompt parametreleri, testler). Eksik:
  ölçülmüş gecikme → **eklendi**.
- **N2 TTS ✅gerçek:** aynı servis (format/ses/hız, çıktı 0600). Eksik:
  gecikme ölçümü → **eklendi**. Streaming/barge-in yok — bkz. notlar.
- **N3 Vision 🟡:** Gerçek yol SAĞLAM: workspace görselleri MIME+hash
  doğrulamasıyla 6 sağlayıcının yerel formatına projekte ediliyor
  (models/multimodal + testler). **Ama** eski multimodal-service girişleri
  sahte etiketliydi: analyzeImage "method: vision-model" diyordu (hiç model
  çağrılmıyordu), detectObjects/detectVideoObjects/extractEntities boş
  dönüyordu — OCR/transcribe düzgün biçimde throw ederken nesne/video
  analizi "completed + boş liste" üretiyordu → **düzeltildi**.
- **N4 🆕:** hafıza kayıtlarında medya referansı, provenance ve modality
  güveni yoktu → **eklendi**.
- **N5 Connector SDK 🟡:** ConnectorService kayıt/aksiyon defteri gerçek ve
  eksikler dürüstçe throw ediyor; sağlayıcı backend'leri (Gmail/Notion/…)
  yok. **Bu koşumda uygulanmadı — dış API + OAuth gerektirir.**
- **N6 Connector reliability 🟡:** email adaptöründe dedup/event-key var;
  genel retry/rate-limit/pagination katmanı yok — backend olmadan
  test edilemez, uydurma koruma yazılmadı.
- **N7 ✅** sandbox-worker + cloud-sandbox + WASI testleri · **N8 ✅**
  manifest-trust (sign/verify/pin/decisions/assertInstallable, 6 test) +
  skills-hub karantini · **N9 ✅** skills-hub + capability-marketplace.
- **Q1 ✅** OperationalMetrics (olay kaynaklı) + OTLP + /metrics ·
  **Q2 🟡** traceId olay zarfında zorunlu; NATS köprüsü zarfı olduğu gibi
  taşır — uçtan uca iz testi yok.
- **Q3 🟡:** `/health` koşulsuz `{status:"ok"}` döndürüyordu — ölü
  veritabanı da "ok" derdi → **bileşen bazlı gerçek kontrol eklendi**.
- **Q4 🆕:** SLO hiç yoktu → **olay kaynaklı SLO servisi eklendi**.
- **Q5 🟡:** 854/859 operasyonda `x-schema-status: unspecified` (dürüst
  etiket; şema üretimi main.ts parçalanmasına bağlı — T5/Q6 ile).
- **Q6 🟡** main.ts 3.5k satır (T5 ile) · **Q7 ✅** headless-client SDK
  (TS; Python/CLI yok) · **Q8 ✅** 2 SSE akışı (session events + worker).
- **Q9/Q10 🟡:** first-run setup ve task UI masaüstü ürün yüzeyi — engine
  tarafında karşılığı yok, ölçümsüz iddia yazılmadı.
- **Q11 🆕:** "Aurora bunu neden yaptı?" tek derleme yüzeyi yoktu →
  **eklendi** · **Q12 ✅** onaylar+sorular+SSE+auto-approval kuralları
  (P5 denetim iziyle) · **Q13 ✅** desktop security testleri.

**Yapılanlar:**

- **N1/N2** `audio-service.ts`: transcribe/synthesize dönüşlerine
  `durationMs` — gerçek ölçülen dönüş süresi (mock gecikmesiyle test
  edildi; sabit değer değil).
- **N3** `multimodal-service.ts`: analyzeImage/analyzeVideo artık
  MultimodalCapabilityUnavailableError atıyor (gerçek yolun
  models/multimodal olduğu gerekçesiyle); detectObjects/
  detectVideoObjects/extractEntities → notImplemented. "completed + boş
  liste" üreten tek yüzey kalmadı.
- **N4** `memory-store.ts` + `capabilities/memory.ts`: MemoryRecord.
  `attachments?` (path, mimeType, sha256, bytes, kind, confidence —
  modality güveni). Capability katmanı yazım anında dosyayı workspace
  içinden okuyup SHA256'ü ölçer; uyuşmazsa kayıt reddedilir ("hash
  mismatch" gerekçeli). Store katmanı digest formatını/CONFIDENCE
  aralığını doğrular. Provenance zaten kayıtta (createdBy/model).
- **Q3** `observability/health-service.ts` (yeni): model sağlayıcılar
  (status() detayı olan "ok", olmayan "unknown" — sağlıklı VARSAYILMAZ),
  PostgreSQL gerçek SELECT 1 (dosya modu "file" olarak raporlanır, geçti
  denmez), NATS yapılandırma, scheduler aktif iş sayısı, memory/cognitive
  anlık görüntüleri. Genel durum "ok"|"degraded" — "down" iddiası süreç
  ayaktayken erişilemez olduğu için bilinçli olarak yok. `/health` bu
  rapora bağlandı + `/v1/health/report`.
- **Q4** `observability/slo-service.ts` (yeni): olay akışından
  task_success_rate (task.completed/failed), tool_success_rate
  (capability.finished), p95_model_turn_latency (started/finished
  eşleşmesi sessionId+turnId+iteration ile). Her gösterge örnek sayısıyla
  gelir; hedef opsiyoneldir (hedef verilirse error budget hesaplanır);
  recovery_success ve memory_retrieval_quality ölçülemez → `null` +
  gerekçe, sayı uydurulmaz. Pencere in-memory (restart'ta sıfır,
  measuredSince raporlanır). Motor: `config.sloTargets` + `/v1/slo`.
- **Q11** `observability/task-explain.ts` (yeni): `explainTask(report)` —
  cevap yalnızca raporun ölçtüğünden kurulur: hedef anlama (kaynağıyla),
  plan adımları, seçilen model (routing observation AYNEN alıntılanır —
  karar anındaki güveniyle), kullanılan capability'ler, doğrulama kararı,
  hata→iyileştirme zinciri, açık gap'ler, evidence coverage. Raporda
  olmayan alan "not recorded" diye yanıtlanır. API: `POST /v1/explain/task`.

**Test:** `test/nq-multimodal-observability.test.ts` — **10 test, 10/10**
(N1/N2 ölçülen gecikme; N3 reddedici miras girişler; N4 hash doğrulaması +
değiştirilmiş dosya reddi + **doğru hash'le workspace kaçışı reddi** +
store doğrulaması; Q3 bozuk DB→degraded + sağlayıcısız→degraded +
status'suz sağlayıcı→unknown + canlı motor; Q4 üç gösterge + hedef/bütçe +
boş pencere null'ları; Q11 dolu rapor + "not recorded" dürüstlüğü).
Komşu regresyon: audio, multimodal, procedural-memory,
external-memory-engine, aurora-end-to-end, aurora-engine-integration,
attachments, engine, fabricated-success, lifecycle-hooks,
aurora-cognitive-extensions, control-api platform-verification,
openapi-drift → **50/50**.

**Sabotaj (10/10 yakalandı):**

| # | Sabotaj | Sonuç |
|---|---------|-------|
| S1 | gecikme 0 sabitlenir | 1F |
| S2 | analyzeImage yine boş başarı döner | 1F |
| S3 | attachment hash kontrolü atlanır | 1F |
| S4 | workspace kaçış kontrolü kaldırılır | 1F* |
| S5 | health hep "ok" döner | 2F |
| S6 | DB hatası gizlenir | 1F |
| S7 | task.failed paydayen silinir | 1F* |
| S8 | gecikme yarıya bölünür | 1F |
| S9 | explain model uydurur | 1F |
| S10 | explain doğrulama uydurur | 1F |

Not (*): İlk koşumda S4 ve S7 etkisizdi — testlerin zayıflığı, kodun değil.
S4'te kaçış testi hash çakışmasıyla maskeleniyordu (dışarıdaki dosyanın
doğru hash'i verilince yalnız confinement reddediyordu); test doğru-hash'li
dış dosya senaryosuyla güçlendirildi → 1F. S7'nin ilk hali
(taskSucceeded koşulsuz artar) gerçek olay akışında ayırt edilemezdi
(task.completed yalnız succeeded durumla yayılır); sabotaj
task.failed'in paydayeni silmesine çevrildi → 1F.

**Zincir:** typecheck --workspaces **0** · build --workspaces **0** ·
`npm test` **exit 0 — 254 dosya / 1890 geçen / 0 failed / 1 skipped**
(+1 dosya, +10 test) · `docs:state -w @haf/eval` **254/1879/30** ·
OpenAPI **862 (check 0; +3 rota)** · `release:prepare` **0** ·
`release:verify` **valid** · `verify:integration` **10/10**.

**Dürüstlük notları:**

- N1/N2'de streaming STT/TTS ve barge-in YOKTUR — headless runtime'da
  sesli oturum kavramı bulunmuyor; tek atımlık transcribe/synthesize
  gerçektir ve gecikmesi ölçülür. Barge-in iddiası ölçümsüz yazılmadı.
- N3'te görüntü ANLAMA yolu model sağlayıcılarıdır (6 provider'a gerçek
  projeksiyon); multimodal-service'in eski girişleri backend'siz reddeder.
  OCR fallback yoktur — throw eder, uydurmaz.
- Q3'te "unknown" geçerli bir cevaptır: status() sunmayan sağlayıcı
  sağlıklı varsayılmaz; dosya modundaki kalıcılık "veritabanı geçti"
  değil "kontrol yapılmadı" olarak raporlanır.
- Q4'te recovery_success ve memory_retrieval_quality ölçülmez: sinyal
  olay akışında yok; null + gerekçe asla tahmin sayısına dönmez. Pencere
  in-memory'dir — restart sonrası measuredSince yeniden başlar; kalıcı
  SLO iddiasında bulunulmaz.
- Q11'de model kimliği yalnızca routing observation varsa alıntılanır
  (karar anındaki özgül metinle); yoksa "not recorded". Doğrulamasız
  görev "unverified by construction" der — geçti ima edilmez.
- Q5'te 854 operasyon hâlâ `x-schema-status: unspecified` — bunlar
  "bilinmiyor" dürüst etiketidir; main.ts parçalanmadan (T5/Q6) şema
  üretimi ölçeklenmez. Bu bölümde 3 yeni rota aynı dürüst etiketle
  eklendi.
- N5/N6 connector sağlayıcı backend'leri bilinçli olarak yazılmadı:
  kimlik bilgisi ve dış API gerektiren entegrasyonlar sahte kayıtla
  "bağlı" gösterilemezdi. Kayıt defteri + dürüst hata mesajları kalır.
- Q2 izleme: traceId her olay zarfında zorunludur ve Postgres şemasında
  NOT NULL'dur; uçtan uca yayılım testi NATS'lı ikili-runtime kurulum
  gerektirir (O1 ile aynı sınır).

**Bununla Bölüm N'nin (N1–N9) ve Bölüm Q'nun (Q1–Q13) tamamı kapandı (N5/N6/Q5/Q6/Q9/Q10/Q2 dürüst 🟡 etiketleriyle) → sayaç 67 ✅.**

### R — Ölçme katmanı: ablasyon kanıtlandı, benchmark kapsamı dürüst haritalandı, long-horizon ve routing ölçüldü ✅ (2026-09-25)

**Ölçüm (kod yazılmadan önce):** Eval paketi 61 deterministik görev / 11
kategori (coding 10, tool_use 8, planning 6, long_horizon 5, memory 5,
multimodal 4, reasoning 5, recovery 5, research 4, security 5,
capability_acquisition 4) — browser/files/multi-agent/proactive SUİTE'TE YOK.
Motor dikişi: `UnifiedExecutionLoop(deps, config)` ctor'unun tüm deps'ı
opsiyonel; learn kancası loop 1659'da çağrılır ve engine.ts'te tanımlanır
(başarı/başarısızlık dersleri fuseMemory ile — learning hiçbir zaman görev
kararını değiştirmez). AdaptiveRouterService: route(...) → kalıcı
adaptive-router.json; kurallar 3+ kullanımdan sonra boost'u açar,
recordOutcome successRate/avgLatencyMs günceller.

**Yapılanlar:**

- **P3.3 ablasyon (ana teslim):** `ABLATION_FLAGS` haritası +
  `ablateExecutionDependencies(deps, flags)` loop modülünde; 9 bayrak
  (memory, planning, verification, world-model, adaptive-routing,
  cognitive-core, self-improvement, goal-discovery, domain-expert) →
  ilgili dep anahtarları silinir. EngineConfig'e `ablations?: readonly
  string[]`; engine.ts'te loopDeps her görevde taze kurulur, ablasyon
  uygulanır, bilinmeyen bayrak ölçüm yalanını önlemek için throw eder.
  Testler flag'e DEĞİL gözlemlenebilir farka trust eder: -memory → "Recalled"
  outcome yok; -planning → "No planner was supplied" + plan.steps 0;
  -verification → results 0 + verdict "uncertain" + status "unverified"
  (çağıranın verdiği verifier bile çalışmaz); -world-model → world-model
  gözlemi yok; -adaptive-routing → routing gözlemi yok; baseline hepsinin
  VARlığını kanıtlar. Ablated motor görevi yine tamamlar (kırık ölçüm değil).
- **P3.1 kapsam haritası:** `suiteCoverage()` — master planın 10 benchmark
  kavramının 8'i suite kategorileriyle, 2'si (multi-agent, proactive)
  motor-tarafı harness ile ölçülür; "engine-harness" ayrı etikettir,
  "suite"'e yuvarlanmaz. Motor testleri: society görevi postTask→bid→award→
  execute→recordOutcome (gerçek child-session event kanıtıyla, bütçe
  kullanımı 20_000 kanıtlanır); initiative watcher+ingest+runWatchers →
  eşleşme initiative üretir.
- **P3.2 karşılaştırma modülü:** `compareRuns()` — 9 metrik (task success,
  verified success, completion, recovery, latency, cost, interventions,
  memory retention, false-success). Ortak görev kümesi dışındaki görevler
  oranlardan çıkarılır ve ADI VERİLEREK raporlanır; ölçülmeyen metrik
  "not-provided" — asla 0 dolgusu; false-success yalnız success+verified
  aynı görevde kayıtlıysa hesaplanır.
- **P3.4 long-horizon:** yeniden başlatma testi — aynı homePath üzerinde
  İKİNCİ motor instance'ı: memory.search bulur, scheduler job ve initiative
  watcher kalır, restart sonrası execute yine "Recalled" üretir (kalıcı
  bellek döngüde kullanılıyor) + kapalıyken düşen yeni bellek "changing
  world state" olarak görülür.
- **P3.5 adaptive routing:** sentetik path'lerle 5 senaryo — cold start
  (strateji tek karar verici, learned not yok), measured models
  (successRate 0.5 + avgLatency 525 ölçülür), changing provider quality
  (3 kazan + 6 kayıp → "33% success" öğrenilir, boost küçülür, skor düşer),
  cost/latency/quality stratejileri aynı sağlayıcı setinde FARKLI path seçer,
  durum restart'ta kalıcı (cold start yalnızca ilk kez).

**Sabotaj (10/10 yakalandı, ilk koşuda):**

| # | Sabotaj | Sonuç |
|---|---------|-------|
| S1 | memory ablasyon bayrağı hiçbir şey silmez | 1F |
| S2 | planning yanlış katmanı (recall) siler | 1F |
| S3 | bilinmeyen ablasyon bayrağı sessizce yutulur | 1F |
| S4 | motor konfigüre edilmiş ablasyonu hiç uygulamaz | 4F |
| S5 | ölçülmemiş ortalamalar 0'la doldurulur | 1F |
| S6 | oranlar ortak olmayan görevler üzerinden hesaplanır | 1F |
| S7 | engine-harness kapsamı "suite"'e yuvarlanır | 1F |
| S8 | quality stratejisi reliability yerine latency skorlar | 1F |
| S9 | kaydedilen sonuçlar başarı oranını hiç güncellemez | 1F |
| S10 | false-success oranı doğrulama yokken 0'la doldurulur | 1F |

**Zincir:** typecheck --workspaces **0** · build --workspaces **0** ·
`npm test` **exit 0 — 257 dosya / 1916 geçen / 0 failed / 1 skipped**
(+3 dosya, +26 test: engine r-ablation-benchmark 16, eval
r-comparison-coverage 9, komşu 1) · OpenAPI **862 (check 0; API yüzeyi
değişmedi)** · `release:prepare` **0** · `release:verify` **valid** ·
`verify:integration` **10/10**.

**Dürüstlük notları:**

- **P3.2 rakip sayıları YOKTUR:** Hermes/OpenHands/Codex/Claude Code bu
  ortamda koşulamadı (dış ağ ve API anahtarı yok). Karşılaştırma MODÜLÜ ve
  metrik tanımı gerçek; sayı üretmek uydurma olurdu. Dış ajan sonuçları aynı
  kayıt şekliyle (ComparisonRun) beslenirse metrikler kendiliğinden
  hesaplanır — "not-provided" dürüst etiketi korunur.
- **P3.4 gerçek zaman ölçekleri (1h/6h/24h/7d) simüle EDİLMEDİ:** test
  restart + kalıcılık + değişen dünya durumunu kanıtlar; saatlerce süren
  duvar-saati koşusu bu ortamda anlamlı ölçüm vermezdi (zaman ilerletme
  sahteciliği ise uydurma sayılırdı). Ölçülen şey: durum ömrü motor ömründen
  bağımsız.
- **P3.1 kategori adları:** master planın "browser" ve "files" kavramları
  suite'te ayrı kategori DEĞİL, tool_use altında temsil edilir; bu haritada
  açıkça yazılıdır.
- **P3.5 router kalitesi sentetiktir:** latency/cost/reliability girdileri
  ölçülmüş sağlayıcı istatistikleri değil, senaryo parametreleridir; ölçülen
  şey karar mekanizmasının (öğrenme, boost, strateji ayrımı) kendisidir.
- Ablasyon çalışması ölçüm aracıdır: ablasyonlu motor üretim konfigürasyonu
  DEĞİLDİR (config yorumunda yazılı).

**Bununla Bölüm R'nin (P3.1–P3.5) kapsanan kısmı kapandı (P3.2 rakip
sayıları ve P3.4 duvar-saati ölçekleri dürüst 🟡 etiketleriyle) → sayaç 68 ✅.**

### S — İleri vizyon: kendi yönünü bulan katman (master P4) — ölçümle doğrulandı, gerçek boşluklar dolduruldu ✅ (2026-09-25)

**Ölçüm (kod yazılmadan önce):** S maddelerinin BEŞİ önceki bölümlerde zaten
inşa edilmiş ve testli çıktı — S1 Memory Palace (memoryGraph L8 palace
katmanı + materializeInsight + thought→memory event entegrasyonu:
aurora-memory-graph, thought-memory-integration testleri) · S2 Meta-World
(multiWorld perspektif ağırlıkları recordScenarioOutcome ile ölçülen
sonuçlara göre güncellenir: aurora-world-model) · S3 Cognitive Health
(cognitive.health(): loopBlocked, budgetSaturation, healthScore:
aurora-cognitive-extensions) · S8 sürekli öz-optimizasyon (self-improvement +
estimation-calibrator + experiment-engine, M bölümü) · S9 kendi yarattığı
araçlar (capability-synthesis: quarantine → sandbox test → promote,
capability-acquisition-* testleri). GERÇEK BOŞLUKLAR: S4 çapraz-görev döngü
tespiti, S5+S6 motorun kendi durumundan risk/fırsat türetme, S7 execution
reputation (ReputationService ada halinde — kurulu, kimse yazmıyor,
okuyamıyor), S10 mikro-ajan yaratma.

**Yapılanlar (yalnızca boşluklar):**

- **S4 LoopDetectionService** (`cognitive/loop-detection-service.ts`): aynı
 outcome imzası (goal+status+failure kinds sha256) tekrarlandıkça sayar;
  eşik (3) geçilince DetectedLoop {occurrences, evidence(son 10), detectedAt}
  kalıcı ve sorgulanabilir. "Durdur" dürüstçe yorumlandı: kullanıcının açık
  isteğini reddetmek değil — iç retry limitleri (attempts/replans) zaten
  vardı; eksik olan çapraz-görev sinyali. Eşik altı kayıt sayaçtır, döngü
  DEĞİLDİR (activeLoops yalnız eşik geçenleri döndürür); acknowledge sayacı
  sıfırdan başlatır, geçmiş kalır.
- **S5+S6 RiskOpportunityEngine** (`proactive/risk-opportunity-engine.ts`):
  5 GERÇEK sinyal kaynağından türetir — aktif döngüler → repeated-outcome
  riski (loop id kanıtıyla), bütçe doygunluğu ≥0.9 → risk, bayat stratejik
  nesneler → risk, 2+ kez görülen capability gap'i → acquisition fırsatı,
  hiç doğrulanmamış palace hipotezi → test fırsatı. Boş sinyal = boş liste;
  her türetilmiş öğe kanıt referansı taşır; evaluate saf (öneri üretmez),
  propose gerçek initiative katmanına iter (baskılanan çiftler sayılır,
  gerçek hata yayılır).
- **S7 execution reputation:** ReputationService'e entries() eklendi;
  engine.execute() artık her görev sonrası seçilen model path'ine
  (routing kararında yakalanır) recordInteraction yazar — success rapor
  kararı, helpful doğrulama verdict'i (doğrulanmamış başarı helpful sayılmaz).
  Kalıcıdır; restart sonrası korunur.
- **S10 MicroAgentFactory** (`society/micro-agent-factory.ts`): döngü
  kanıtında ÖLÇÜLMÜŞ capability'lerden uzman önerisi türetir (yoksa RED —
  uydurulmuş beceri listesi fabrikasyon olur); apply → gerçek society "micro"
  rolü (builtin değil), marketplace'te eşleşen işi bid+award alabilir;
  tekrar eden desen TEK öneri üretir (dedupe); reddedilmiş öneri uygulanamaz.
- **Motor dikişi:** engine.execute() sonunda recordSelfDirectionSignals —
  imza kaydı, gap'lerin kalıcı sayımı, reputation etkileşimi, eşik geçilince
  otomatik uzman önerisi. Society hand-off kuralı aynı: kararı asla
  yeniden yazmaz, hatası gözlem olarak raporlanır.

**Testler:** `test/s-self-direction.test.ts` 8 test — 3 aynı başarısızlık
= 1 döngü + farklı hedef katılmaz + acknowledge; ölçülen capability yoksa
"dürüst hayır" gözlemi; reputation 3 doğrulanmış başarı → trustLevel
yükselir + restart'ta kalıcı; döngü → risk initiative (gerçek initiative
katmanında, kanıt ref'iyle); 1 gap desen DEĞİLDİR, 2 gap fırsattır;
doğrulanmamış palace hipotezi fırsattır; boş sinyal = boş liste +
signalCounts; uzman önerisi ölçülen tag'lerle → apply → gerçek micro rol →
eşleşen görevi kazanır; becerisiz kanıt → RED.

**Sabotaj (10/10 yakalandı, ilk koşuda):**

| # | Sabotaj | Sonuç |
|---|---------|-------|
| S1 | occurrences birikmez (=1 sabit) | 1F |
| S2 | tek olay bile döngü sanılır (eşik 1) | 1F |
| S3 | uzman beceri listesi uydurulur ("planning") | 1F |
| S4 | becerisiz kanıtla da öneri üretilir | 1F |
| S5 | her bütçe kullanımı doygunluk riski olur (≥0) | 1F |
| S6 | döngü riski kanıt referansı taşımaz | 1F |
| S7 | reputation uydurma agentId ile yazılır | 1F |
| S8 | motor sinyalleri hiç kaydetmez | 4F |
| S9 | tek gap görülmesi desene yuvarlanır (eşik 1) | 1F |
| S10 | türetilen risk/fırsat initiative katmanına ulaşmaz | 1F |

**Zincir:** typecheck --workspaces **0** · build --workspaces **0** ·
`npm test` **exit 0 — 257 dosya / 1923 geçen / 0 failed / 2 skipped**
(+1 dosya, +8 test) · OpenAPI **862 (check 0; API yüzeyi değişmedi)** ·
`release:prepare` **0** · `release:verify` **valid** ·
`verify:integration` **10/10**. Sayım düzeltmesi: R bölümünde "257/1916/1S"
yazılmıştı, gerçek sayım **256/1915/2S** idi (toplama hatası); bu bölüm
kesin yeniden sayımla yazıldı.

**Dürüstlük notları:**

- Master'ın "aynı sonuç 10 kez → durdur" örneği thought katmanı içindir;
  görev tarafı eşik 3 olarak bağlandı (yapılandırılabilir). "Durdur"
  kullanıcının isteğini reddetmek olarak uygulanmadı — bu farklı (ve güvensiz)
  bir özellik olurdu; uygulanan şey ölçülmüş, kalıcı, sorgulanabilir sinyal
  + türetilen uzman önerisi + risk girişimi.
- S10'un "yaratıcı" kısmı mock sağlayıcı altında deterministik türetmedir:
  önerinin beceri listesi döngü kanıtında ölçülen capability'lerin birleşimi
  olmaktan ibarettir; gerçek modelde spec üretimi modelin işidir, burada
  uydurulmadı.
- S5/S6 yalnız 5 sinyal kaynağı okur; dış pazar, trend analizi, zaman
  içindeki değişim sinyalleri YOKTUR ve boş sinyalde liste boş döner —
  sessizlik asla özet uydurmaya dönmez.
- S7'de agentId routing'in ölçtüğü model path'idir; mock altında bu
  "(no runnable model)" olabilir — dürüsttür, süslenmez.
- S1/S2/S3/S8/S9 için YENİ kod yazılmadı: ölçümle mevcut ve testli
  olduğu kanıtlandı (kanıt dosyaları yukarıda adli). Var olanı yeniden
  yazmak "yaptım" demek için yapılırdı.

**Bununla Bölüm S'nin ölçülebilir kısmı kapandı (S1/S2/S3/S8/S9 ölçümle
kanıtlı mevcut; S4/S5/S6/S7/S10 bu bölümde inşa edildi) → sayaç 69 ✅.**

### T — Repo/release hijyeni: ratchet'lerle ölçülen temizlik, yeniden üretilebilirlik kanıtlandı, iki gizli spec-drift zayıflığı kapatıldı ✅ (2026-09-25)

**Ölçüm (kod yazılmadan önce):** T1 — repo kökünde .gitignore YOK, 6 izlenen
şüpheli dosya (release-metadata/, .tar.gz, .local/), 805 işlenmemiş
değişiklik. T2 — 38 commit / 6 MB pack, 1 MiB üstü blob YOK, sır DEĞERİ yok
(test fixture'larındaki AWS dokümantasyon örneği anahtar / yansıma sentineli
/ üretilmiş IRC test anahtarı — tasarımdandır). T3 — CI var ve kurallı;
`npm run eval:recall -w @haf/eval` workspace-kapsamlı (denetleyici kapsam
çözümlemesi yapmalıydı). T4 — iki ardışık prepare FARKLI checksum üretiyor
(sebep: duvar-saati damgaları + invocationId; araçta SOURCE_DATE_EPOCH ve
deterministik invocationId DESTEĞİ VARMIŞ, kanıt yokmuş). T5 — main.ts 3545,
engine.ts 5539, App.tsx 1196; `src/routes/` modül deseni KISMEN var. T6 —
src ağaçlarında 1039 `any` eşleşmesi (en kötü App.tsx 420). T7 — motor
paketinin 441 isimlik export yüzeyi — hiçbir kilit yok. T8 — duplicate
bağımlılık 0. T9 — 47 test dosyası Math.random/Date.now kullanıyor, envanter
yok.

**Yapılanlar:**

- **`scripts/repo-hygiene-audit.mjs`** — 8 ratchet tek raporda, exit kodlu:
  T5 boyut kilitleri (main 3514 / engine 5540 / App 1197 — sadece küçelir) ·
  T5 OpenAPI MUTLAK sayı kilidi (862; sync-check yeniden üretimle küçülen
  spec'i "current" sanıyordu) · T6 any sayımı ≤1039 · T3 CI betik tutarlılığı
  (workspace `-w` kapsam çözümlemesiyle) · T1 izlenen yapıt desenleri ≤6 +
  .gitignore varlığı · T2 geçmişte 1 MiB+ blob ve ÜRETİM yolundaki sır değeri
  (test yolları bilinçli muaf — sahte anahtarlar sızıntı değil gürültü) ·
  T9 determinizm envanteri (47 dosyalık allowlist dışına çıkmak fail) ·
  T8 duplicate deps.
- **T4 yeniden üretilebilirlik KANITI:** `t4-reproducibility.test.ts` 4 test
  — sabit epoch + aynı ağaç → bayt-özdeş SHA256SUMS; farklı epoch → farklı;
  değişen ağaç → farklı; sabitlenen epoch yapıtların KENDİSİNDE
  (generatedAt/startedOn) ve deterministik invocationId'de. In-process
  `prepareRelease()` (src) — ilk halinin dist koşması sabotajla yakalandı.
- **T7 arayüz sözleşmesi:** `t7-api-surface.test.ts` — 441 isimlik export
  snapshot'ı (gerçek listeden üretildi, uydurulmadı) + runtime bağlarının
  gerçekliği + yük taşıyan ankrajlar + HybridAgentEngine tip sözleşmesi
  (loops/riskOpportunity/microAgents/adaptiveRouter instance üyeleri —
  derleme zamanı kilit).
- **T5 ilk bölme + büyüme kilitleri:** gözlemlenebilirlik rotası grubu
  (8 rota: /health, /v1/health/report, /v1/slo, /v1/explain/task, /metrics,
  /v1/metrics, /v1/fleet/*) main.ts'ten `src/routes/observability.ts`'ye
  birebir taşındı (main 3545→3513); `t5-route-extraction.test.ts` kabloyu,
  yol sahipliğini ve spec kapsamını kilitler.
- **İKİ GERÇEK GİZLİ ZAYIFLIK BULUNDU VE KAPATILDI:** (1) OpenAPI
  üreticisinin SABİT kaynak listesi — yeni rota modülü spec'ten sessizce
  düşüyordu (862→854) ve `--check` YEŞİL kalıyordu (aynı eski listeden
  yeniden üretip karşılaştırıyor); (2) openapi-drift testinde AYNI sabit
  liste — spec'in "var olmayan rota reklamı yaptığını" sanıyordu. İkisi de
  `routes/` dizin keşfine çevrildi + mutlak 862 kilidi eklendi → sınıf
  kalktı.
- **T1 somut adım:** repo köküne .gitignore (hiç yoktu) — 6 izlenen dosya
  ratchet altında (geçmişte kalırlar; temizliği history-rewrite ister).

**Sabotaj (10/10; ilk koşu 6/10 — 2 anchor uyuşmazlığı + 4 GERÇEK test
zayıflığı, hepsi güçlendirildi):**

| # | Sabotaj | Sonuç |
|---|---------|-------|
| T4-a | SOURCE_DATE_EPOCH yok sayılır (duvar saati döner) | 1F |
| T4-b | invocationId yine rastgelelenir | 1F |
| T5-a | modülden bir rota düşürülür | 1F |
| T5-b | boyut raketi 999999'a gevşetilir | 1F |
| T5-c | main.ts modülü hiç kaydetmez | 1F |
| T6 | any raketi gevşetilir | 1F |
| T3 | workspace-kapsamlı CI betikleri yok sayılır | 1F |
| T9 | determinizm envanteri dosya toplamaz | 1F |
| T2 | sır eşleşmeleri hiç toplanmaz | 1F |
| T7 | anchor export yeniden adlandırılır | 1F |

Dersler: (1) T4 testi ilk halinde dist'i koşuyordu — src'teki sabotaj
görünmezdi; test `prepareRelease()`'i src'ten in-process çağırır oldu.
(2) "Audit bugün yeşil" bir raketin GEVŞETİLDİĞİNİ yakalamaz — sınırların
kendisi testte sabitlendi (862, 1039, boyut sınırları). (3) Drift testinin
kendi kaynak listesi de çürüyebiliyormuş — dizin keşfi sınıfı kaldırdı.

**Zincir:** typecheck --workspaces **0** · build --workspaces **0** ·
`npm test` **exit 0 — 261 dosya / 1939 geçen / 0 failed / 2 skipped**
(+4 dosya, +16 test) · OpenAPI **862 (check 0)** · `release:prepare` **0** ·
`release:verify` **valid** · `verify:integration` **10/10**.

**Dürüstlük notları:**

- **T5 tamamlanmadı:** main.ts'ten BİR tutarlı grup çıkarıldı (8 rota) ve
  üç dosyanın büyümesi kilitlendi; engine.ts (5539) ve App.tsx (1196)
  bölünmedi — tek bölümde 6000 satırlık mekanik bölme ölçüsüz risk olurdu.
  Ratchet'ler bölme ilerledikçe düşürülür; büyüme artık sessiz değil.
- **T2 geçmiş temizliği yapılmadı:** geçmişe işlemiş tarball/site-packages
  kalır (6 izlenen dosya); silinmesi history-rewrite + push gerektirir ve
  ağ yok. Denetlendi, raporlandı, ratchet'lendi.
- **T3 gerçek runner doğrulaması 🟡:** CI konfigürasyonu gerçek ve betikleri
  doğrulandı; bir GitHub runner'ın bunu koştuğunu bu ortamda kanıtlayamayız
  (ağ yok). Drift kilitleri yerelde aynı zinciri çalıştırıyor.
- **T6 azaltma değil ratchet:** 1039 sabitlendi; azaltma ayrı iş, her adımda
  sınır bilinçli düşürülür. App.tsx tek başına 420.
- **T8 deprecated paketler 🟡:** deprecated durumu registry erişimi ister
  (ağ yok); ölçülebilen kısım (duplicate'ler = 0) ölçüldü ve kilitlendi.
- **T9 çift koşum kanıtı:** tam suite bu oturumda iki kez üst üste koşuldu
  (ölçüm + final) — 261 dosya / 1939 / 0F her ikisinde; kalıcı teslimat
  envanter + allowlist ratchet'i.

**Bununla Bölüm T kapandı → sayaç 70 ✅. A'dan T'ye BİRLEŞİK PLANIN TAMAMI
TAMAMLANDI.** Kalan dürüst 🟡 etiketler (P3.2 rakip sayıları, P3.4 duvar-saati
ölçekleri, T3 gerçek runner, T5 kalan bölmeler, T6 any azaltımı, T8 deprecated
listesi, N5/N6/Q5/Q6/Q9/Q10/Q2/O1 dış-sistem bağımlıları) ölçülemediği için
değil, bu ortamda ölçülemeyeceği için açık — her biri yol haritasında kendi
bölümünde gerekçesiyle yazılıdır. Plan bitti; ölçülemeyen hiçbir şey
"yapıldı" denmedi.
