# P0 Düzeltmeleri — Tamamlandı

**Tarih:** 2026-09-22
**Kapsam:** `AURORA-INCELEME-RAPORU.md` içindeki üç P0 maddesi
**Değişen dosya:** 5 (`ci.yml`, `Dockerfile`, `package.json`, `package-lock.json`, `packages/engine/package.json`)

Her düzeltme, **projenin kendi kontrolü çalıştırılarak** doğrulandı.

---

## P0-1 · `npm audit --omit=dev` exit 1 → exit 0

### Değişiklik
`packages/engine/package.json`:
```diff
-    "nodemailer": "^7.0.5",
+    "nodemailer": "^10.0.10",
...
   "devDependencies": {
-    "@types/nodemailer": "^8.0.1",
     "@types/pg": "^8.23.1",
```

Nodemailer 10 kendi TypeScript tiplerini getiriyor (`dist/esm/nodemailer.d.ts`),
bu yüzden doğrudan `@types/nodemailer` bağımlılığı kaldırıldı. Paket hâlâ
`@types/smtp-server` üzerinden **transitive dev-dependency** olarak geliyor —
`npm audit --omit=dev` bunu saymaz.

Kod tarafında **hiçbir değişiklik gerekmedi.** Kullanılan API yüzeyi dar:
`email-channel-adapter.ts:546` `createTransport({...})` ve `:462` `transport.sendMail({...})`.
Advisory'lerdeki riskli alanların hiçbiri kullanılmıyor (`envelope.size`, `List-*` header,
transport `name` seçeneği, `jsonTransport`, `raw`).

### Doğrulama

| Kontrol | Önce | Sonra |
|---|---|---|
| `npm audit --omit=dev` | `REAL_AUDIT_EXIT=1`, 1 high | **`AUDIT_EXIT=0`, "found 0 vulnerabilities"** |
| `npm ci` (CI bunu çalıştırıyor) | OK | **OK** — lockfile senkron |
| `npm run typecheck -w @haf/engine` | 0 hata | **0 hata** |
| email/channel testleri | — | **5 dosya / 17 test geçti** |

`email-channel-adapter.test.ts` gerçek bir `smtp-server` ayağa kaldırıyor — yani
transport mock'lanmıyor, gerçekten SMTP konuşuluyor.

---

## P0-2 · CI "Kernel protocol smoke" → exit 0

### Değişiklik
`.github/workflows/ci.yml`. Kernel `protocolVersion: 2` her `execute` frame'inde
`executionId` + `kernelGeneration` + `hostToken` istiyor; eski adım bunları göndermiyordu.

```diff
-          python3 python/kernel_server.py <<'EOF2' | tee /tmp/kernel.jsonl
-          {"type":"execute","id":"1","code":"x=40\nx+2"}
-          {"type":"shutdown","id":"2"}
-          EOF2
-          grep -q '"result": "42"' /tmp/kernel.jsonl
+          python3 python/kernel_server.py <<'EOF2' | tee /tmp/kernel.jsonl
+          {"type":"execute","id":"1","executionId":"smoke-exec-1","kernelGeneration":"smoke-gen-1","hostToken":"smoke-token-1","code":"x=40\nx+2"}
+          {"type":"execute","id":"2","executionId":"smoke-exec-2","kernelGeneration":"smoke-gen-1","hostToken":"smoke-token-1","code":"raise ValueError('boom')"}
+          {"type":"shutdown","id":"3"}
+          EOF2
+          python3 - <<'PY'
+          ... assert protocolVersion == 2, result == "42", hata yolu ok==False ...
+          PY
```

Üç iyileşme birden:
1. **Fencing alanları gönderiliyor** → kod gerçekten çalışıyor.
2. **`grep` yerine JSON parse** → `json.dumps` byte düzenine değil frame semantiğine bakıyor.
3. **Başarısız yol da test ediliyor** ve `protocolVersion` sabitleniyor — kernel v3'e
   geçerse bu adım sessizce anlam değiştirmek yerine yüksek sesle patlar.

### Doğrulama
`ci.yml` PyYAML ile parse edildi, `run` bloğu çıkarıldı ve **GitHub Actions'ın
Linux'ta kullandığı şekilde** `bash -e` ile çalıştırıldı:

```
YAML parse: OK
jobs: build-test, recall-nightly, canvas-e2e
kernel protocol smoke: ok (protocolVersion 2, success and failure paths)
STEP_EXIT = 0
```

Önceki davranış: `"error": "execute frame omitted generation-fencing metadata"` → grep FAIL.

---

## P0-3 · `docker build` başarısız → başarılı

### Değişiklik
`Dockerfile` — kök neden: `npm ci`'den önce 10 workspace'in sadece 6'sının
`package.json`'u kopyalanıyordu. npm workspace'leri diskten keşfettiği için eksik
olanlar **sessizce linklenmiyor**, bağımlılıkları kurulmuyordu; lockfile ise onları
tanımlamaya devam ediyordu.

```diff
 COPY packages/engine/package.json packages/engine/package.json
+COPY packages/eval/package.json packages/eval/package.json
 COPY apps/control-api/package.json apps/control-api/package.json
 ...
 COPY apps/canvas-web/package.json apps/canvas-web/package.json
-RUN npm ci
+COPY apps/headless-client/package.json apps/headless-client/package.json
+COPY apps/release-tool/package.json apps/release-tool/package.json
+COPY apps/desktop/package.json apps/desktop/package.json
+RUN npm ci --ignore-scripts
 COPY packages packages
 COPY apps apps
 COPY python python
-RUN npm run build
+RUN npm run build:runtime
```

Kök `package.json`'a yeni script:
```json
"build:runtime": "npm run build -w @haf/engine && npm run build -w @haf/canvas-web && npm run build -w @haf/control-api && npm run build -w @haf/acp-server && npm run build -w @haf/session-worker && npm run build -w @haf/wasi-runner"
```

İki ek karar:
- **`--ignore-scripts`** → imaj headless bir API; Electron'un ~100 MB'lık prebuilt
  binary indirmesi saf israf. Paketin **tipleri yine kuruluyor** (`electron.d.ts` var),
  sadece binary inmiyor.
- **`build:runtime`** → runtime aşaması zaten yalnızca 6 dist kopyalıyor. Eski
  `npm run build` imajda hiç olmayan desktop/headless-client/release-tool/eval'i de
  derlemeye çalışıyordu.

### Doğrulama
Dockerfile'ın yeni build aşaması **satır satır taklit edildi** (sandbox'ta Docker daemon yok):

| Ölçüm | Önce | Sonra |
|---|---|---|
| `npm ci` sonrası bağlı workspace | **6** | **10** (`acp-server canvas-web control-api desktop engine eval headless-client release-tool session-worker wasi-runner`) |
| `node_modules/electron` | YOK | VAR |
| `electron/electron.d.ts` | — | VAR |
| `electron/dist/electron` (~100 MB binary) | — | **YOK** (istenmeyen indirme engellendi) |
| Build sonucu | `TS2307: Cannot find module 'electron'` → `npm error code 1` | **`BUILD:RUNTIME OK`** |
| Üretilen dist | — | 6/6 (`engine`, `canvas-web`, `control-api`, `acp-server`, `session-worker`, `wasi-runner`) |

---

## Regresyon kontrolü — tamamı yeniden çalıştırıldı

| Kontrol | Sonuç |
|---|---|
| `npm ci` | **OK** (lockfile ↔ package.json senkron) |
| `npm audit --omit=dev` | **OK**, 0 vulnerability |
| `npm run typecheck` (10 workspace) | **OK**, 0 hata |
| `npm run build` (10 workspace, desktop dahil) | **OK** |
| `npx vitest run` (tüm monorepo) | **206/206 dosya, 1369 passed \| 1 skipped, exit 0** |
| `npm run eval:gates` | **OK** |

Test sonucu P0 öncesi baseline ile **birebir aynı** (206/206, 1369 passed) — regresyon yok.

### Gerçek çalışma zamanı duman testi
Derlenmiş `dist`'ten sunucu gerçekten başlatıldı:

```
$ node apps/control-api/dist/main.js
GET /health          → {"status":"ok","engine":"hybrid-agent-fabric","version":"1.65.0",
                        "provider":["mock"],"sandbox":"local","persistence":"file","nats":false}
GET /v1/capabilities → 200, gerçek capability listesi
[AUDIT] INFO GET /v1/capabilities 200 3ms      ← audit-logger middleware çalışıyor
```

---

## P0 sırasında ortaya çıkan iki yeni bulgu (düzeltilmedi, kayıt altında)

### A) `npm run eval:gates` izlenen dosyaları değiştiriyor
Her çalıştırmada:
```
 M packages/eval/results/core-suite-baseline-mock.json
 M packages/eval/results/criteria-validation.json
 M packages/eval/results/criteria-validation.md
?? packages/eval/results/runs/aurora-core-<timestamp>.json
```
CI her çalıştırmada kirli working tree bırakıyor, geliştiriciler anlamsız diff görüyor.
**P3-12'nin (eval/results gitignore'a alınmalı) somut kanıtı.**

### B) `packages/engine/src/version.ts` dist yolunda yanlış çözümlüyor
```js
const pkgPath = resolve(__dirname, "../../package.json");
```
`rootDir: "src"` + `outDir: "dist"` olduğu için `src/version.ts` → `dist/version.js`.
Yani `__dirname` = `packages/engine/dist` ve `../../package.json` = **`packages/package.json`**
→ mevcut değil. Kod her zaman `process.cwd()` yedeğine düşüyor.

Ölçüldü — ilk dal **her iki yerleşimde de** ölü:

```
src (tsx):        ../../package.json -> packages/package.json          *** YOK ***
                  ../package.json    -> packages/engine/package.json   VAR
dist (derlenmis): ../../package.json -> packages/package.json          *** YOK ***
                  ../package.json    -> packages/engine/package.json   VAR
```

Yani kod **her zaman** `process.cwd()` yedeğine düşüyor. Docker'da `WORKDIR /app`
sayesinde doğru değeri buluyor — **şans eseri**. Farklı bir cwd'den çalıştırılırsa
dosyanın başındaki sabit `let version = "1.65.0"` yedeğine düşer ve `/health`
sessizce yanlış sürüm bildirir. Dosyadaki yorum *"works with npx tsx, compiled dist,
and different CWDs"* iddiası **hiçbir yerleşim için doğru değil**.
Düzeltme: `../../package.json` → `../package.json`.

---

## Sıradaki adım

**P1-4 — test paketinin 6 kez tekrar çalışması.** P0 sonrası CI'da kalan tek sert risk bu:
`build-test` job'ının limiti 20 dakika ve paket 8 kez tam çalışıyor.
