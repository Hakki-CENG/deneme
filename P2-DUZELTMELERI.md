# Aurora Motor Engine — P2 Düzeltmeleri

**Repo:** `Hakki-CENG/Aurora-Motor-Engine` → `hybrid-agent-fabric/` (v1.65.0)
**Kapsam:** inceleme raporundaki P2-8, P2-9, P2-10, P2-11
**Yöntem:** her düzeltme dosyaya yazıldı ve çalıştırılarak doğrulandı. Bu turun ana teması:
**"iddia ↔ gerçek" sapmasını ölçen hiçbir mekanizma yoktu.** Dört P2 maddesinin dördü de bu
tek kök nedene çıkıyor, o yüzden çözüm tek bir yerde toplandı.

---

## 0. Özet

| Madde | Durum | Ölçülen sonuç |
|---|---|---|
| **P2-8** `verify-integration.ts` çürümüş/sahipsiz | ✅ yeniden yazıldı | 71 string-grep → **10 gerçek invariant**, `10/10 PASS exit 0`, CI'a bağlı |
| **P2-9** API dokümanı gerçeğin %1'i | ✅ | 7 path → **715 path / 844 operasyon**; **4 hayalet endpoint** bulundu ve silindi |
| **P2-10** Dokümanlar kodu yalanlıyor | ✅ | üretilen dokümanlar yenilendi (**212 dosya · 1429 case**), 10 bayat dosyaya uyarı bandı |
| **P2-11** Supply-chain attestation bayat | ✅ | `1.38.0`/310 dosya → **`1.65.0`/891 dosya**; %40'ı gitignore'daydı, temizlendi; bundle artık manifest ile *kanıtlanabilir* biçimde aynı |
| **Yeni bulunan kusurlar** | 6 düzeltildi, 1 belgelendi | aşağıda §5 |

**Doğrulama:** `npm run verify:integration` → **10/10, exit 0**. `npm test` → **exit 0, 212 dosya, 1440 passed + 1 skipped, 0 hata**.

---

## 1. P2-8 — `verify-integration.ts` yeniden yazıldı

Eski dosyanın dört kusuru da ölçülmüştü: sabit mutlak yol (`/home/user/...`), kasten silinmiş
12 dosyayı beklemesi, `main.ts` içinde `version: "1.64.0"` **literalini** araması (yani doğru
kodu başarısız sayması), ve hiçbir yerden çağrılmaması. 71 kontrolün hepsi `fileExists` ya da
`fileContains` idi — bir string'in dosyada geçmesi, bir şeyin bağlı olduğu anlamına gelmez.

**Yapılan:** dosya silindi, yerine `scripts/verify-integration.mjs` yazıldı. Kendi konumundan
türeyen yollar, string-grep yok, her kontrol bu depoda **gerçekten yaşanmış** bir regresyonu ölçüyor:

| # | kontrol | neyi yakalıyor |
|---|---|---|
| 1 | `workspace-versions` | 11 `package.json`'ın sürümde ayrışması |
| 2 | `spec-version` | `openapi.yaml`'ın başka sürüm bildirmesi |
| 3 | `no-hardcoded-product-version` | kaynakta sabit ürün sürümü literali (1.38.0 / 1.61.0 vakaları) |
| 4 | `openapi-current` | spec'in kayıtlı route'lardan sapması (7'ye karşı 844) |
| 5 | `release-metadata-fresh` | attestation'ın ağaçtan sapması (1.38.0 / 310 dosya) |
| 5b | `attestation-excludes-generated` | attestation'a gitignore'daki üretilmiş dosyaların sızması |
| 6 | `node-version-agreement` | engines ≥20 / CI 20 / desktop ≥22.12 çelişkisi |
| 7 | `workspace-test-coverage` | test script'i olmayan workspace |
| 7b | `status-docs-banner` | bayat durum dokümanının uyarısız kalması |
| 8 | `engine-version-runtime` | derlenmiş engine'in yanlış sürüm bildirmesi (grep değil, **çalıştırarak**) |

**Sonuç:** `10/10 checks passed`, `exit 0`. `package.json`'a `verify:integration` eklendi ve
`.github/workflows/ci.yml`'e `Repository invariants` adımı olarak bağlandı (`npm run build`'den
sonra, çünkü derlenmiş engine ve release-tool'u okuyor). Eski araç hiçbir yere bağlı değildi;
şimdi CI kırmızıya döner.

> **Not:** `workspace-test-coverage` ilk çalıştırmada `apps/wasi-runner` için FAIL verdi. İnceleme:
> `src/main.ts` yalnızca **24 satırlık** bir başlatıcı ve `packages/engine/test/wasi-plugin.test.ts`
> onun derlenmiş `dist/main.js`'ini gerçekten spawn ediyor (build edilince 2/2 geçtiğini doğruladım).
> Yani kapsama var ama başka workspace'te. Kurala sessiz bir istisna yerine **kaydedilen** bir istisna
> eklendi: `"haf:testedBy": "@haf/engine"`. Kontrol, hedef workspace'in gerçekten test script'i
> olduğunu da doğruluyor, yani iddia sahte olamıyor.

---

## 2. P2-9 — OpenAPI: 7 path → 844 operasyon

`scripts/generate-openapi.mjs` yazıldı. YAML bağımlılığı yok (kök `node_modules`'taki `js-yaml`
yalnızca transitive, ona bağlanmak kırılgan olurdu): elle yazılmış 4 path **bayt-bayt korunuyor**,
kalan 711 path üretiliyor. Üretilen bölüm `# ── BEGIN GENERATED ──` / `# ── END GENERATED ──`
sentinelleri arasında, böylece araç **idempotent** (üç ardışık çalıştırma → aynı sha256, ölçüldü).

**Dürüstlük:** üretilen operasyonlar **şema iddia etmiyor**. Handler'lar satır-içi zod şemalarıyla
doğruluyor ve üreteç bunları değerlendirmiyor; uydurma şema, eksik şemadan daha kötü bir yalan olurdu.
Her üretilen operasyon `x-schema-status: unspecified` taşıyor ve kaynak dosyasını gösteriyor.

### 2a. Dört hayalet endpoint bulundu ve silindi

Üretilen operasyon sayısı (844) ile YAML'daki operasyon sayısı (848) **uymuyordu**. Fark
incelendiğinde elle yazılmış 7 path'in 4 operasyonunun **kodda hiç olmadığı** ortaya çıktı:

| hayalet | ölçülen gerçek |
|---|---|
| `GET /v1/memory-graph/search` | çalışan sunucuda **HTTP 404** |
| `GET /v1/initiative` | çalışan sunucuda **HTTP 404** |
| `DELETE /v1/sessions/{sessionId}` | kodda kayıtlı değil (aşağıdaki 500 maskesi) |
| `POST /v1/sessions/{sessionId}/chat` | kodda kayıtlı değil (aşağıdaki 500 maskesi) |

Dördü de spec'ten çıkarıldı. Küratörlü spec artık 4 path / 6 operasyon — hepsi gerçek.

### 2b. Kalıcı sapma bekçisi

`apps/control-api/test/openapi-drift.test.ts` (4 test) spec'i **YAML kütüphanesi olmadan**, satır
taramasıyla okuyor — yani üreteçle **kod paylaşmıyor**; üreteç bozulursa test yine yakalar.
İki yönü de denetliyor: belgelenmemiş route ve var olmayan route.

**Regresyon kanıtı:** spec'e kasıtlı olarak 1 hayalet eklendi ve 1 gerçek route silindi →
**3/4 test FAIL** (`expected 845 to be 844`, "spec advertises routes that do not exist",
"undocumented routes"). Spec geri konunca **4/4 PASS**.

### 2c. Ölçülen son durum

```
kaynak operasyon : 844
spec  operasyon : 844
spec paths      : 715
kaynakta olup spec'te olmayan : 0
spec'te olup kaynakta olmayan : 0
```

---

## 3. P2-10 — Dokümanlar

1. **Üretilen dokümanlar yenilendi:** `npm run docs:state -w @haf/eval` → `CURRENT_STATE.md`,
   `MATURITY_MATRIX.md`, `KNOWN_GAPS.md`. Artık **212 test dosyası · 1429 case · 30 modül**
   bildiriyor (P1'de eklenen testler dahil).
2. **10 elle yazılmış durum dosyasına uyarı bandı eklendi** (silinmediler — tarihsel kayıt):
   `GERCEK_DURUM_DEGERLENDIRMESI.md`, `DEGISIKLIK_OZETI.md`, `IMPLEMENTATION_STATUS.md` (kök + `docs/`),
   `NIHAI_EKSIKLER.md`, `30-SİSTEM-DÖNÜŞÜM.md`, `31-SİSTEM-TAMAMLANDI.md`, `DÖNÜŞÜM-PLANı.md`,
   `GÜÇLENDİRME-PLANı.md`, `TAMAMLANAN-GÜÇLENDİRME.md`.
   Bant, dosyanın **üretilmediğini ve doğrulanmadığını** söylüyor ve yetkili kaynaklara yönlendiriyor.
3. **Bandın varlığı artık denetleniyor:** `status-docs-banner` kontrolü. Bant silinirse CI kırmızı.

> Dokümanlardaki çelişkili *sayısal* iddialar ("612 test", "702 REST endpoint", "production-ready")
> tek tek otomatikleştirilmedi — genel bir "yanlış sayı" dedektörü yazılamaz. Bant + üretilen
> dokümanların yetkili ilan edilmesi, okuyucuyu yanlış sayıya değil doğru kaynağa yönlendiriyor.

---

## 4. P2-11 — Supply-chain attestation

`release:verify` bayat bundle'a **`valid:true`** diyordu, çünkü yalnızca **iç tutarlılığı**
(checksum'lar) kontrol ediyor. 27 sürüm ve ~1100 dosya geride olması onun kapsamı dışında.
**Asıl eksik yetenek buydu:** sapmayı ölçen hiçbir şey yoktu. Şimdi `release-metadata-fresh` ölçüyor.

**Yeniden üretim** README'de belgelenen süreçle yapıldı (`SOURCE_DATE_EPOCH=1790035200`,
2026-09-22T00:00:00Z):

| | önce | sonra |
|---|---|---|
| `source-manifest.json` sürüm | `1.38.0` | **`1.65.0`** |
| `generatedAt` | 2026-08-19 | **2026-09-22** |
| entry sayısı | 310 | **891** (önceki denemede 1453'tü; §5.6) |
| provenance `builder.id` | `release-tool@1.38.0` | **`release-tool@1.65.0`** |
| SPDX `creators` | `Tool: haf-release-1.38.0` | **`Tool: haf-release-1.65.0`** |
| SPDX `name` | `hybrid-agent-fabric-1.38.0` | **`hybrid-agent-fabric-1.65.0`** |
| `release:verify` | `valid:true` (bayat) | **`valid:true`** (güncel) |

Bu, P1'de yapılan 7.6 sürüm düzeltmesinin **gerçek attestation yolunda** uçtan uca kanıtı:
builder kimliği ve SBOM creator'ı artık package.json'dan geliyor.

### 4a. Bundle'ı üreten script hiç yoktu

`artifacts/hybrid-agent-fabric-source.tar.gz` 376 girdi içeriyordu, kendi manifest'i ise 310 —
ikisi farklı, belgelenmemiş süreçlerle üretilmişti ve **tarball'ı üreten hiçbir script yoktu**.

`scripts/build-source-bundle.mjs` yazıldı: tarball **manifest'in dosya listesinden** üretiliyor,
yani arşiv ile attestation artık *yapısal olarak* aynı küme. `--verify` arşivi geri okuyup
manifest'le karşılaştırıyor:

```
Bundle matches the manifest: 891 files in hybrid-agent-fabric-source.tar.gz
```

Determinizm: sıralı liste, `--mtime=@SOURCE_DATE_EPOCH`, `--owner=0 --group=0 --numeric-owner`.
`release:bundle` / `release:bundle:verify` script'leri eklendi.

> **Bu script kendi doğrulamasında gerçek bir hata yakaladı:** `tar tzf`, Türkçe dosya adlarını
> sekizli kaçışla (`S\304\260STEM`) listeliyor ve kökteki 7 Türkçe dosya "eksik/fazla" görünüyordu.
> `--quoting-style=literal` ile düzeltildi.

### 4b. Çelişen ikinci attestation kaldırıldı

`hybrid-agent-fabric-release-metadata/release-metadata/` byte-identical bir kopyaydı (P3-14) ve
yeniden üretimden sonra **1.38.0 damgalı bayat bir kopya** olarak taze olanla çelişiyordu.
İki çelişen attestation, bir tanesinden kötüdür — `git rm -r` ile kaldırıldı.

### 4c. Sıralama kuralı (önemli)

`release-metadata-fresh`, manifest üretildikten **sonra** değişen her dosyada kırmızıya döner
(bu turda iki kez yaşandı ve ikisinde de doğruydu). Doğru sıra:

```
tüm kod değişiklikleri → npm run release:prepare → npm run release:bundle
                        → npm run release:prepare -- --artifact ../hybrid-agent-fabric-source.tar.gz
                        → npm run release:bundle:verify → npm run verify:integration
```

---

## 5. Yeni bulunan kusurlar

### 5.1 ✅ DÜZELTİLDİ — Eşleşmeyen route'lar 404 yerine 500 dönüyordu

`GET /v1/sessions/<var-olmayan-id>/<herhangi-bir-şey>` her ek için **500** veriyordu. Neden ölçüldü:
`preHandler` hook'u tenant çözmek için `engine.session(id)` çağırıyor, o fırlatıyor. Fastify kök
hook'larını **404 handler'ına da** uyguladığı için, route hiç eşleşmese bile bu kod çalışıyordu.

Fastify davranışı prob ile ölçüldü (varsayılmadı): `request.routeOptions.url` **tam olarak** route
eşleşmediğinde `undefined`.

**Düzeltme:** `apps/control-api/src/main.ts` — hook, route eşleşmediğinde kenara çekiliyor.
Eşleşmeyen route'un yetkilendirecek bir kaynağı yoktur; 404'ü Fastify üretsin.

**Çalışan sunucuda ölçüldü (öncesi → sonrası):**

| istek | önce | sonra |
|---|---|---|
| `GET /v1/sessions/{yok}/chat` | 500 | **404** |
| `GET /v1/sessions/{yok}/totally-bogus-xyz` | 500 | **404** |
| `GET /v1/agent-profiles/{yok}` | 500 | **404** |
| `GET /health` | 200 | 200 |
| `GET /v1/sessions/{gerçek-id}` | 200 | **200** |
| `GET /v1/memory-graph/memories` | 200 | 200 |
| `GET /v1/initiative/initiatives` | 200 | 200 |
| `GET /v1/sessions` (token yok) | 401 | **401** |

Yani 404'e dönüşenler yalnızca gerçekten var olmayan yollar; gerçek route'lar ve 401 davranışı bozulmadı.

### 5.2 ⚠️ DÜZELTİLMEDİ (belgelendi) — Var olan route'ta eksik kaynak hâlâ 500

`GET /v1/sessions/{var-olmayan-id}` (route **var**) hâlâ **500** dönüyor, çünkü hook handler'dan
önce patlıyor. Doğru yanıt 404.

**Neden düzeltilmedi:** engine tiplendirilmiş bir `NotFoundError` fırlatmıyor, düz `Error` atıyor
(`supervisor.ts:238, 422, 775`). "Bulunamadı"yı gerçek bir arıza hatasından (ör. Postgres down)
ayırmak için ya mesaj metni eşleştirmek gerekir (kırılgan) ya da engine'e tiplendirilmiş hata
eklemek (187 test dosyasının dokunduğu yüzey). İkisi de bu turun kapsamı dışında bir karar.
Aynı sorun `engine.automations.get`, `engine.learning.get`, `engine.refinements.get`,
`engine.agentProfiles.get` için de geçerli.

### 5.3 ✅ DÜZELTİLDİ — `stateless-mcp-client.ts` içinde sabit `1.61.0`

P1'deki 7.6 düzeltmesinin **kaçırdığı** aynı sınıftan bir örnek: MCP `clientInfo` sürümü
`version: "1.61.0"` olarak sabitti. `ENGINE_VERSION`'a çevrildi, import eklendi,
`npm run typecheck -w @haf/engine` → exit 0.

> Bu, `no-hardcoded-product-version` kontrolünün değerini gösteriyor: kural geriye dönük
> uygulanınca gözden kaçmış bir örnek daha ortaya çıktı.

### 5.4 ✅ DÜZELTİLDİ — Üreteç idempotent değildi

İlk sürüm, kendi ürettiği bölümü bir sonraki çalıştırmada "küratörlü" diye geri okuyordu; her
çalıştırmada banner çoğalacaktı. Sentinel ile düzeltildi, üç ardışık çalıştırma aynı sha256'yı veriyor.

### 5.5 ✅ DÜZELTİLDİ — Kök yol `/` kayboluyordu

Path anahtarı regex'i `^ {2}\/\S+:$` idi ve `  /:` satırını (kök yol) eşleştirmiyordu; `GET /`
spec'ten düşüyordu. `\S*` ile düzeltildi. Bu, üretilen spec'in kaynakla **birebir** karşılaştırılması
sayesinde yakalandı (844 ≠ 843 farkı araştırıldı, varsayılmadı).

### 5.6 ✅ DÜZELTİLDİ — Attestation'ın %40'ı git'in ignore ettiği dosyalardı

Yeniden üretimden sonra manifest'in içeriği `git ls-files` ile karşılaştırıldı:

```
manifest entry       : 1453
git'te izlenen       :  873
İZLENMEYEN (attested):  580     ← %40
  552  packages/eval/results/…   (üretilmiş, her eval:gates'te yeniden yazılıyor)
    8  var-inbound-smoke/…       (smoke test artığı)
   ~20 yeni kaynak dosyası        (henüz stage edilmemiş — meşru)
```

Kök neden: `buildSourceManifest` dosya sistemini yürüyor ve **`.gitignore`'a bakmıyordu**.
Yani SLSA provenance, her `npm run eval:gates` çalıştırmasında değişen çöp durumu "kaynak"
diye mühürlüyordu — ve gates'i çalıştırmak attestation'ı geçersiz kılıyordu.

**Düzeltme (iki katman):**
1. `apps/release-tool/src/release.ts` → `EXCLUDED_PATHS` + `EXCLUDED_PREFIXES`, `.gitignore`'daki
   yolların **birebir aynısı**. Açık liste tercih edildi çünkü release-tool belgelenmiş olarak
   git checkout olmadan da çalışabiliyor.
2. `scripts/verify-integration.mjs` → `attestation-excludes-generated` kontrolü, manifest'i
   `git ls-files --others --ignored --exclude-standard` ile çapraz denetliyor. Yani liste
   `.gitignore`'ın gerisinde kalırsa **build kırılıyor**, sessizce çöp mühürlenmiyor.
   Henüz stage edilmemiş yeni kaynak dosyaları **cezalandırılmıyor** — yalnızca git'in
   *kasten* ignore ettikleri işaretleniyor.

**Sonuç:** manifest **1453 → 891 dosya**; `attestation-excludes-generated` → PASS
("all 891 attested files are source git does not ignore"). `apps/release-tool` testleri 3/3.

---

## 6. Değişen dosyalar

**Yeni:** `scripts/verify-integration.mjs`, `scripts/generate-openapi.mjs`,
`scripts/build-source-bundle.mjs`, `apps/control-api/test/openapi-drift.test.ts`

**Değişen:** `docs/openapi.yaml` (7 → 715 path), `apps/control-api/src/main.ts` (route guard),
`packages/engine/src/mcp/stateless-mcp-client.ts`, `apps/release-tool/src/release.ts`
(üretilmiş dosyaları dışlama), `.github/workflows/ci.yml` (+1 adım),
`package.json` (+5 script), `apps/wasi-runner/package.json` (`haf:testedBy`),
`CURRENT_STATE.md` / `MATURITY_MATRIX.md` / `KNOWN_GAPS.md` (yeniden üretildi),
10 bayat durum `.md`'si (bant), `release-metadata/*` (yeniden üretildi)

**Silinen:** `verify-integration.ts` (354 satır, çürümüş), `hybrid-agent-fabric-release-metadata/`
(bayat kopya)

---

## 7. Doğrulama

| kontrol | komut | sonuç |
|---|---|---|
| Depo invariantları | `npm run verify:integration` | **10/10 PASS, exit 0** |
| OpenAPI sapma testi | `vitest run --root apps/control-api` | 4/4 (sabotajda 3/4 FAIL) |
| Üreteç idempotency | 3× `generate-openapi.mjs` | aynı sha256 |
| Üreteç güncellik | `generate-openapi.mjs --check` | exit 0 |
| Bundle ≡ manifest | `npm run release:bundle:verify` | 891 dosya, exit 0 |
| release-tool testleri | `vitest run --root apps/release-tool` | 3/3 PASS (`release.ts` değişti) |
| Attestation iç tutarlılık | `npm run release:verify` | `valid:true`, exit 0 |
| Engine typecheck | `npm run typecheck -w @haf/engine` | exit 0 |
| Control-API build+typecheck | `npm run build/typecheck -w @haf/control-api` | exit 0 |
| 500→404 düzeltmesi | çalışan sunucuda 8 istek | tablo §5.1 |
| Tam regresyon | `npm test` | aşağıda |

**Tam suite:** `npm test` → **exit 0**, 9 workspace, **212 test dosyası**, **1440 passed + 1 skipped**, **0 hata**.

| workspace | dosya | test |
|---|---|---|
| engine | 187 | 1222 (+1 skipped) |
| eval | 12 | 126 |
| control-api | 6 | 45 (**+1 dosya / +4 test**) |
| headless-client | 2 | 8 |
| acp-server | 1 | 7 |
| session-worker | 1 | 8 |
| canvas-web | 1 | 20 |
| release-tool | 1 | 3 |
| desktop | 1 | 1 |
| **toplam** | **212** | **1440 + 1 skipped** |

`release.ts` değiştiği için `apps/release-tool` testleri ayrıca çalıştırıldı: **3/3 PASS**.

---

## 8. Doğrulanamayan / açık kalan

- **GitHub Actions runner sandbox'ta yok.** CI'a eklenen `Repository invariants` adımı
  **gerçek runner'da çalıştırılmadı**; yalnızca YAML parse edildi ve adımın komutu
  (`npm run verify:integration`) yerelde exit 0 verdi.
- **Attestation imzasız.** `release:verify` → `"signature":"absent"`. Önceki bundle da imzasızdı,
  yani bu bir geriye gidiş değil; ama imzalı bir attestation isteniyorsa `HAF_RELEASE_SIGNING_KEY`
  ile yeniden üretilmeli. Ayrıca **bir git commit'ine değil, çalışma ağacına** karşı üretildi.
- **§5.2 düzeltilmedi:** var olan route'ta eksik kaynak hâlâ 500. Engine'e tiplendirilmiş
  `NotFoundError` eklemek gerekiyor.
- **Üretilen OpenAPI operasyonları şemasız.** Gerçek şema için `@fastify/swagger` + zod→JSON Schema
  gerekir; bu yeni bir bağımlılık ve 844 route'un notlanması demek. Mevcut durum dürüstçe
  `x-schema-status: unspecified` olarak işaretli.
- **`docs/API.md` (14 yol) ve `docs/API-REFERENCE.md` (128 yol)** elle yazılmış olarak duruyor ve
  artık `openapi.yaml` ile çelişiyor. Silinmediler.
- **P3 maddelerine dokunulmadı:** kök dizindeki 880 KB PDF, birebir kopya
  `uc-ajan-reposu-nihai-mimari-analizi.md`, noktasız `ı` içeren dosya adları, tek commit'te 950 dosya.
