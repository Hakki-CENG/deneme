# Aurora Motor Engine — Configuration Reference

> Tüm ortam değişkenleri ve yapılandırma seçenekleri.

---

## Genel Ayarlar

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `HAF_HOME` | `./var` | Ana dizin yolu |
| `HAF_MODEL_PROVIDER` | `mock` | Model sağlayıcı (`mock`, `openai-codex`, `openai-compatible`, veya profile ID) |
| `HAF_MODEL_NAME` | - | Model adı |
| `HAF_MODEL_BASE_URL` | `https://api.openai.com/v1` | Model API base URL |
| `HAF_MODEL_API_KEY` | - | Model API anahtarı |
| `HAF_MODEL_API_KEYS_JSON` | - | Birden fazla API anahtarı (JSON array) |
| `HAF_MODEL_FALLBACKS` | - | Virgülle ayrılmış fallback model listesi |
| `HAF_MODEL_API_VERSION` | - | Model API versiyonu |
| `HAF_MODEL_REGION` | - | Model bölge ayarı |
| `NODE_ENV` | `development` | Ortam (`development`, `production`, `test`) |

## Sandbox Ayarları

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `HAF_SANDBOX_BACKEND` | `local` | Sandbox backend (`local`, `docker`, `singularity`, `ssh`, `modal`, `daytona`, `vercel`, `kubernetes`) |
| `HAF_SSH_HOST` | - | SSH sandbox host (SSH backend için zorunlu) |
| `HAF_SSH_USER` | - | SSH kullanıcı adı |
| `HAF_SSH_PORT` | `22` | SSH portu |
| `HAF_SSH_IDENTITY_FILE` | - | SSH private key dosyası |
| `HAF_SSH_REMOTE_ROOT` | - | Uzak dizin kökü |
| `HAF_SSH_SYNC_FILES` | `true` | Dosya senkronizasyonu |
| `HAF_SINGULARITY_IMAGE` | - | Singularity imajı (Singularity backend için zorunlu) |
| `HAF_CLOUD_SANDBOX_GATEWAY` | - | Bulut sandbox gateway (cloud backends için zorunlu) |
| `HAF_KERNEL_SERVER` | - | Kernel server script yolu |

## Kimlik Doğrulama

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `HAF_API_TOKEN` | - | API erişim token'ı |
| `HAF_AUTH_DISABLED` | `false` | Kimlik doğrulamayı devre dışı bırak |
| `HAF_SESSION_SECRET` | - | Session şifreleme anahtarı (zorunlu) |
| `HAF_SESSION_COOKIE_NAME` | `haf_session` | Session cookie adı |
| `HAF_SESSION_TTL_MS` | `28800000` | Session ömrü (ms, varsayılan 8 saat) |
| `HAF_COOKIE_SECURE` | `true` | Secure cookie flag |
| `HAF_DEFAULT_TENANT` | `local` | Varsayılan tenant ID |

### OIDC Ayarları

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `HAF_OIDC_ISSUER` | - | OIDC issuer URL |
| `HAF_OIDC_CLIENT_ID` | - | OIDC client ID |
| `HAF_OIDC_CLIENT_SECRET` | - | OIDC client secret |
| `HAF_OIDC_REDIRECT_URI` | - | OIDC redirect URI |
| `HAF_OIDC_SCOPES` | - | OIDC scope'ları (boşlukla ayrılmış) |
| `HAF_OIDC_TENANT_CLAIM` | - | JWT'deki tenant claim adı |
| `HAF_OIDC_ROLE_CLAIM` | - | JWT'deki role claim adı |

## CORS ve Güvenlik

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `HAF_CORS_ORIGIN` | `false` | CORS origin (virgülle ayrılmış) |
| `HAF_TELEGRAM_WEBHOOK_SECRET` | - | Telegram webhook secret |
| `HAF_WHATSAPP_VERIFY_TOKEN` | - | WhatsApp verify token |
| `HAF_SIGNAL_WEBHOOK_SECRET` | - | Signal webhook secret |
| `HAF_MATRIX_WEBHOOK_SECRET` | - | Matrix webhook secret |
| `HAF_MATTERMOST_WEBHOOK_SECRET` | - | Mattermost webhook secret |
| `HAF_GOOGLE_CHAT_WEBHOOK_SECRET` | - | Google Chat webhook secret |
| `HAF_TEAMS_WEBHOOK_SECRET` | - | Teams webhook secret |

## Web Arama

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `HAF_WEB_SEARCH_PROVIDER` | `brave` | Web arama sağlayıcı (`brave`, `tavily`) |
| `HAF_BRAVE_API_KEY` | - | Brave Search API anahtarı |
| `HAF_TAVILY_API_KEY` | - | Tavily API anahtarı |

## Dış Hafıza

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `HAF_MEMORY_PROVIDER` | `` | Dış hafıza sağlayıcı (boş veya `honcho`) |

## Model Ayarları

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `HAF_CODEX_REASONING_EFFORT` | - | Codex reasoning effort (`low`, `medium`, `high`, `max`) |
| `HAF_CODEX_REQUEST_TIMEOUT_MS` | `180000` | Codex istek zaman aşımı (ms) |

## Observability

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `HAF_OTLP_ENDPOINT` | - | OpenTelemetry endpoint |
| `HAF_OTLP_HEADERS_JSON` | - | OTLP headers (JSON object) |
| `HAF_PROMETHEUS_ENABLED` | `false` | Prometheus metrikleri |

## Öğrenme ve Güven

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `HAF_LEARNING_TRUSTED_KEYS_JSON` | - | Ed25519 public key'leri (JSON object) |
| `HAF_WASI_TRUSTED_KEYS_JSON` | - | WASI plugin trusted key'leri (JSON object) |

## Canvas Web

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `HAF_CANVAS_ROOT` | `../../canvas-web/dist` | Canvas web dosyaları kök dizini |

---

## API Endpoint Özetleri

### Health & Metrics
- `GET /health` — Sistem sağlık durumu
- `GET /metrics` — Prometheus metrikleri
- `GET /v1/metrics` — JSON metrik snapshot

### Sessions
- `POST /v1/sessions` — Yeni session oluştur
- `GET /v1/sessions` — Session listesi (sayfalama destekli)
- `GET /v1/sessions/:id` — Session detayı
- `DELETE /v1/sessions/:id` — Session sil
- `POST /v1/sessions/:id/chat` — Sohbet gönder
- `GET /v1/sessions/:id/transcript` — Transcript al
- `GET /v1/sessions/:id/events` — Event listesi
- `GET /v1/sessions/:id/events/stream` — SSE event stream

### Aurora Memory
- `GET /v1/memory-graph/search` — Hafıza arama
- `GET /v1/memory-graph/memories` — Hafıza listesi (sayfalama)
- `POST /v1/memory-graph/memories` — Hafıza oluştur
- `DELETE /v1/memory-graph/memories/:id` — Hafıza sil
- `GET /v1/memory-graph/health` — Hafıza sağlık durumu
- `POST /v1/memory-graph/sweep` — Hafıza temizliği
- `GET /v1/memory-graph/anchors` — Anchor listesi
- `POST /v1/memory-graph/anchors` — Anchor oluştur

### Aurora World Model
- `GET /v1/world/entities` — Entity listesi
- `POST /v1/world/entities` — Entity oluştur/güncelle
- `POST /v1/world/states` — State kaydet
- `GET /v1/world/events` — Event listesi
- `POST /v1/world/events` — Event kaydet
- `GET /v1/world/predictions` — Tahmin listesi
- `POST /v1/world/predictions` — Tahmin oluştur
- `GET /v1/world/calibration` — Kalibrasyon raporu
- `GET /v1/world/consistency` — Tutarlılık kontrolü

### Aurora Initiative
- `GET /v1/initiative` — Initiative listesi (sayfalama + sıralama)
- `POST /v1/initiative/:id/accept` — Initiative kabul et
- `POST /v1/initiative/:id/dismiss` — Initiative reddet
- `POST /v1/initiative/bulk-dismiss` — Toplu reddetme
- `POST /v1/initiative/scan` — Initiative tarama
- `GET /v1/initiative/watchers` — Watcher listesi
- `GET /v1/initiative/briefing` — Günlük briefing

### Aurora Evolution
- `GET /v1/evolution` — Evolution indeksi
- `GET /v1/evolution/stuck` — Stuck pattern'ler
- `GET /v1/evolution/gaps` — Skill gap listesi
- `POST /v1/evolution/gaps` — Skill gap oluştur
- `GET /v1/evolution/experiments` — Deney listesi

### Aurora Cognitive
- `GET /v1/cognitive/objects` — Cognitive object listesi
- `POST /v1/cognitive/objects` — Cognitive object oluştur
- `POST /v1/cognitive/attention/allocate` — Dikkat dağıtımı
- `GET /v1/cognitive/goals` — Goal listesi

### Society
- `GET /v1/society/roles` — Rol listesi
- `POST /v1/society/roles` — Rol oluştur
- `GET /v1/society/tasks` — Görev listesi
- `POST /v1/society/tasks` — Görev oluştur
- `GET /v1/society/deliberations` — Müzakere listesi

### Platforms
- `POST /v1/platforms/telegram/webhook` — Telegram webhook
- `POST /v1/platforms/slack/webhook` — Slack webhook
- `POST /v1/platforms/discord/webhook` — Discord webhook
- `POST /v1/platforms/whatsapp/webhook` — WhatsApp webhook
- (ve diğer platformlar...)

### MCP
- `GET /v1/mcp/servers` — MCP server listesi
- `POST /v1/mcp/servers/stdio` — Stdio MCP server ekle
- `POST /v1/mcp/servers/http` — HTTP MCP server ekle
- `DELETE /v1/mcp/servers/:name` — MCP server sil

### Learning
- `GET /v1/learning/candidates` — Öğrenme adayları
- `POST /v1/learning/candidates` — Aday öner
- `GET /v1/learning/refinements` — İyileştirmeler
- `GET /v1/learning/releases` — Yayınlar

### Automations
- `GET /v1/automations` — Otomasyon listesi
- `POST /v1/automations` — Otomasyon oluştur
- `GET /v1/schedules` — Zamanlama listesi
- `POST /v1/schedules` — Zamanlama oluştur

---

## Hata Kodları

Tüm hatalar `HAF-{KATEGORİ}-{NUMARA}` formatında döner:

- **1xxx** — Kimlik doğrulama hataları
- **2xxx** — Doğrulama hataları
- **3xxx** — Session hataları
- **4xxx** — Aurora hataları
- **5xxx** — Platform hataları
- **6xxx** — Model hataları
- **7xxx** — Kaynak hataları
- **8xxx** — Sistem hataları

Örnek hata yanıtı:
```json
{
  "error": {
    "code": "HAF-1001",
    "message": "Invalid authentication token",
    "requestId": "req-abc123",
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

---

## Rate Limiting

| Endpoint | Limit | Pencere |
|----------|-------|---------|
| Genel API | 100 istek/dk | 60 saniye |
| Chat/AI | 30 istek/dk | 60 saniye |
| Auth | 10 istek/dk | 60 saniye |
| Upload | 20 istek/dk | 60 saniye |
| Webhook | 200 istek/dk | 60 saniye |
| Platform webhook | 500 istek/dk | 60 saniye |

Rate limit header'ları:
- `X-RateLimit-Limit` — Maksimum istek sayısı
- `X-RateLimit-Remaining` — Kalan istek sayısı
- `X-RateLimit-Reset` — Reset zamanı (epoch)
- `Retry-After` — Bekleme süresi (saniye)
