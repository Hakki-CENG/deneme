# Sistem Seviyesi Değerlendirmesi

**Tarih:** 2026-09-20
**Yöntem:** Mevcut belgelere güvenilmedi. Her rakam ya doğrudan koddan sayıldı
ya da çalıştırılıp ölçüldü. Ölçümlerin bir kısmı önceki belgeleri çürüttü.

---

## 1. Tek cümlelik cevap

**Aurora, dürüstlüğü kanıtlanmış gerçek bir görev yürütme omurgasına sahip;
çevresinde ise henüz o omurgaya bağlanmamış çok geniş bir yüzey var.**

Seviye: **çalışan bir çekirdek + ağır bir çeper.** Ne "prototip" ne de
"production-ready"; ikisinin arasında, çekirdeği ölçülebilir biçimde sağlam.

---

## 2. Ölçülen rakamlar

| Ölçüm | Değer |
|---|---|
| Kaynak kod | **106.198 satır**, 366 TS dosyası |
| Test | **192 dosya, 26.649 satır** |
| Test sonucu | **202 dosya / 1342 test — hepsi PASS** |
| Typecheck | **0 hata** |
| Eval kapıları | **4/4 geçti** |
| Olgunluk kaydı | 30 modül: **6 stable / 18 beta / 6 experimental** |
| `hasTests: false` | **0** |
| `wiredToEngine: false` | **0** |
| HTTP endpoint | **500 benzersiz** (609 tanım) |
| Eval görevi | 61 görev + 62 core task |

Test/kaynak oranı ≈ **1:4** — düşük değil, ama 106k satır için kapsam eşit
dağılmıyor (aşağıya bakınız).

---

## 3. Gerçekten çalışan çekirdek (ölçülmüş)

Gerçek bir workspace'te gerçek bir görev koşturdum:

```
goal: "Add a health check endpoint to the service"
→ status=succeeded, attempts=1, 233ms
→ Recalled 0 memories
→ Planned 4 steps (1 ready, 3 with dependencies)
→ Agent session settled as idle after 46 events
→ Verified by test:node — GERÇEK `npm test` koştu, V2_empirical, confidence 0.9
```

Bu taklit değil: doğrulayıcı workspace'teki `package.json`'ı algılayıp
komutu çalıştırdı.

**Dürüstlük çekirdeği — asıl değerli kısım.** İmkânsız görevde:

```
"Delete all files on the moon and prove P=NP"
→ status=unverified  (succeeded DEĞİL)
→ "the work completed but no verifier exists for it.
   Repeating the work cannot make it verifiable."
```

Sistem yapamadığı şeyi **yaptım demiyor**. Çoğu benzeri sistemin başarısız
olduğu yer burasıdır.

`execute()` altı hook'un altısını da bağlamış durumda: `runAgent`, `recall`,
`plan`, `verifiersFor`, `inventory`, `learn`.

**Kanıtlanmış öğrenme:** 4/4 görev ailesi ikinci karşılaşmada **%42,9 daha az
adım ve maliyet** ile tamamlanıyor. Bu, planın "aynı problemi ikinci kez daha
iyi çöz" kriterinin ölçülmüş karşılığı.

**Kanıtlanmış yetenek edinimi (M6/M7):** görev başarısız → gap → sözleşme →
kod → statik analiz → sandbox → 3 known-good + 1 yem + 3 adversarial → kayıt →
**orijinal görev 2. denemede `succeeded`**.

---

## 4. Asıl yapısal bulgu: çekirdek dar, çeper geniş

`cognitive-runtime`'ın tuttuğu 11 pipeline'dan **her birinden çağrılan metotları
saydım**:

| Çağrılan metot | Sayı |
|---|---|
| `getStats()` | **11 pipeline'ın 11'inde** |
| Gerçek iş yapan çağrı | **yalnız 3'ünde** (`capabilitySynthesis.synthesizeAndTest`/`promoteCapability`, `selfImprovement.initializeProtectedCores`, `security.initialize` — sonuncusu **bu hafta M9'da eklendi**) |

Yani **8 pipeline yalnızca istatistik raporlamak için tutuluyor.** Kod var,
test var, bağlantı var — ama karar akışına katkısı yok.

Aynı desen `stable` etiketinde de görüldü: 6 `stable` modülün yalnız biri
(`capability-synthesis`) `engine.ts`'te geçiyor; diğerleri
`cognitive-runtime` üzerinden dolaylı duruyor.

**500 HTTP endpoint** bu çeperin dışa vurumu. Örnekleme yaptım: endpoint'ler
salt `getStats` sarmalayıcısı değil (%2), gerçek metotlara bağlılar — ama
`/v1/sessions` 74, `/v1/society` 28, `/v1/world` 19 gibi dağılım, çekirdeğe
oranla yüzeyin ne kadar büyüdüğünü gösteriyor. Bu, kullanıcının kendi koyduğu
**"yeni servis ekleme, entegrasyon yoğunluğuna odaklan"** kuralının neden
konduğunu doğruluyor.

---

## 5. İsim–gerçeklik dürüstlüğü (Madde 63/64)

Olgunluk kayıtları bu konuda **dürüst**:

| Modül | Kaydın kendi ifadesi |
|---|---|
| `neural-memory-fusion` | "64-dim hash vektörleri (Math.sin), **no network, no training, no learned weights**" |
| `neural-cognitive-core` | "**nothing about it is neural**" |
| `federated` | "**no gradient exchange**" |
| `digital-twin` | "**no simulation loop**" |
| `self-improvement` | "operatör kümesi küçük ve **elle yazılmış, öğrenilmiş değil**" |
| `world-model-exploration` | "tahminler **çağıran tarafından veriliyor, öğrenilmiyor**" |

**Açık kalan çelişki:** kayıtlar dürüst, ama **dosya/sınıf adları hâlâ
`neural-*`**. Madde 63 "isim gerçeğin önüne geçmesin" diyor. Kayıt bunu
telafi ediyor, isim hâlâ yanıltıyor.

---

## 6. Zayıf noktalar (ölçülmüş)

1. **Recall@8 kapısı içeriden FAIL.** Çıktı: `FAIL: Recall@8 0.317 → 0.339
   (Δ0.022 < margin 0.05, 1W/1L/13T)`. Kapı "regresyon kilidi" olarak geçiyor
   (davranış değişmedi), ama **iyileştirme hedefi tutmuyor**. 15 sorgunun
   13'ü berabere — yani sıralama çoğu sorguda hiç fark yaratmıyor.

2. **Baseline 0/61.** Eylemsiz modelle 61 görevin sıfırı geçiyor. Bu bir
   *dürüstlük* kanıtı (görevler bedava geçilmiyor), ama **gerçek modelle
   ölçüm hâlâ yok** — API anahtarı meselesi, kod meselesi değil.

3. **`checkSecurity()` silahlı ama çağıran yok.** M9'da pipeline
   silahlandırıldı (0 → 9 injection deseni); ancak ajan girdisi hâlâ oradan
   geçmiyor.

4. **Kalıcılık boşluğu.** `real-memory-pipeline` `stable` ama kalıcılığı yok;
   bellek süreç ömrüyle sınırlı.

5. **Test kapsamı eşitsiz.** 180 test dosyasının neredeyse tamamı
   `packages/engine`'de; `apps/control-api` için **5 test** var — 500
   endpoint'in çoğu test edilmemiş.

---

## 7. Son 9 turda ne değişti

| Faz | Bulgu |
|---|---|
| M1 | Durum belgeleri koddan üretiliyor (elle yazılmıyor) |
| M2 | Plan adımları gerçek durum + bağımlılık taşıyor |
| M3 | V3 consensus doğrulama erişilebilir oldu |
| M4 | Hafıza bakımı gerçekten çalışıyor (4 kusur) |
| M5 | Ölçülmüş sıralama ana yola bağlandı |
| M6 | Capability zinciri `execute()`'a bağlandı |
| M7 | Test vakaları geldi; zincir **gerçekten** tetikleniyor |
| M8 | **Boş uyumluluk verisi "100 uyumlu" diyordu** → `unknown`/0 |
| M9 | **Güvenlik boru hattı silahsızdı** (0 desen) → silahlandı |

M8 ve M9 aynı sınıf kusurdu: **yeşil görünen, aslında korumayan sistem.**

---

## 8. Dürüst seviye tespiti

| Alan | Seviye |
|---|---|
| Görev yürütme + doğrulama | **Çalışıyor, kanıtlı** |
| Dürüst başarısızlık raporlama | **Güçlü** — en olgun yanı |
| Öğrenme (ikinci karşılaşma) | **Ölçülmüş: %42,9** |
| Yetenek edinimi | **Uçtan uca kapalı — ama 1 yetenek** |
| Hafıza erişimi | **Çalışıyor, iyileştirme hedefi tutmuyor** |
| Güvenlik | **Silahlı, ana yolda sorulmuyor** |
| Geniş servis yüzeyi (500 endpoint) | **Çoğu çekirdeğe bağlı değil** |
| Gerçek model altında kanıt | **Yok** |

**Özet:** Aurora'nın *iddiaları* ile *gerçeği* arasındaki fark, 9 tur önceki
duruma göre çok daraldı — ve bunun sebebi yeni özellik eklenmesi değil,
**yanlış iddiaların ölçülüp düzeltilmesi**. Bugünkü en büyük risk yeni kod
eksikliği değil; **çeperdeki 8 pipeline ve 500 endpoint'in çekirdeğe
bağlanmamış olması.**

---

## 9. Bundan sonrası için öneri (öncelik sırasıyla)

1. **`checkSecurity()`'yi `execute()` yoluna bağla.** Silahlı ama sorulmayan
   koruma, korumasızlıkla aynı şey.
2. **`neural-*` isimlerini gerçeğe çek** (`VectorMemoryFusion`,
   `PatternRegistry`). Madde 63'ün doğrudan gereği, düşük risk.
3. **Recall@8'i marjın üstüne çıkar** veya hedefi dürüstçe düşür — 13/15
   beraberlik, sıralamanın çoğu sorguda etkisiz olduğunu söylüyor.
4. **`control-api` için sözleşme testleri.** 500 endpoint / 5 test
   sürdürülebilir değil.
5. **Yeni servis ekleme.** Ölçüm bunu doğruluyor: çeper zaten çekirdekten
   büyük.
