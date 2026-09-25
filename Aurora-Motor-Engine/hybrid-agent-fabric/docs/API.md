# Aurora Motor Engine - API Dokümantasyonu

**Versiyon:**1.65.0  
**Temel URL:** `http://localhost:8787`

---

## 📚 İçindekiler

1. [Genel Bilgiler](#genel-bilgiler)
2. [Authentication](#authentication)
3. [Cognitive Architecture](#cognitive-architecture)
4. [Memory Services](#memory-services)
5. [Agent Economy](#agent-economy)
6. [Planning & Goals](#planning--goals)
7. [Error Handling](#error-handling)

---

## Genel Bilgiler

### Rate Limiting
- **Genel API:**100 istek/dakika
- **Chat/AI:**30 istek/dakika
- **Auth:**10 istek/dakika
- **Upload:**20 istek/dakika

### Response Format
```json
{
  "data": { ... },
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 100,
    "totalPages": 5,
    "hasNext": true,
    "hasPrev": false
  }
}
```

### Error Format
```json
{
  "error": "error_type",
  "message": "Human readable message",
  "issues": [] // Zod validation errors
}
```

---

## Authentication

### CSRF Protection
Tüm POST/PUT/DELETE istekleri için `x-haf-csrf` header'ı gereklidir.

---

## Cognitive Architecture

### Self-Model

#### GET /v1/self-model
Agent'ın mevcut durumunu getirir.

**Query Parameters:**
- `tenantId` (string, default: "local")

**Response:**
```json
{
  "goals": [...],
  "beliefs": [...],
  "capabilities": [...],
  "hypotheses": [...]
}
```

#### POST /v1/self-model/goals
Yeni hedef ekler.

**Body:**
```json
{
  "tenantId": "local",
  "title": "Hedef başlığı",
  "description": "Hedef açıklaması",
  "priority": 5,
  "parentId": "optional-parent-id"
}
```

#### POST /v1/self-model/reflect
Agent'ın kendi kendine düşünmesini tetikler.

---

### Uncertainty Engine

#### GET /v1/uncertainty/claims
Belirsizlik iddialarını listeler.

**Query Parameters:**
- `tenantId` (string)
- `domain` (string, optional)
- `status` (string, optional)

#### POST /v1/uncertainty/assert
Yeni bir belirsizlik iddiası ekler.

**Body:**
```json
{
  "tenantId": "local",
  "claim": "Bu özellik çalışıyor",
  "domain": "testing",
  "confidence": 0.85,
  "evidence": [...],
  "assumptions": [...]
}
```

---

### Multi-Hypothesis Reasoning

#### GET /v1/multi-hypothesis
Hipotezleri listeler.

#### POST /v1/multi-hypothesis
Yeni hipotez oluşturur.

**Body:**
```json
{
  "tenantId": "local",
  "statement": "X feature Y yapar",
  "domain": "testing",
  "assumptions": ["assumption1"],
  "implications": ["implication1"]
}
```

#### POST /v1/multi-hypothesis/:id/evidence
Hipoteze kanıt ekler.

---

### Failure Taxonomy

#### GET /v1/failures
Hata sınıflandırmalarını listeler.

#### POST /v1/failures/classify
Yeni hata sınıflandırması oluşturur.

**Body:**
```json
{
  "tenantId": "local",
  "description": "Hata açıklaması",
  "category": "runtime",
  "severity": "high",
  "rootCause": "Nedeni"
}
```

---

## Memory Services

### Long-Horizon Memory

#### GET /v1/long-horizon-memory
Uzun vadeli hafızayı sorgular.

#### POST /v1/long-horizon-memory/memory
Yeni hafıza ekler.

### Neural Memory Fusion

#### GET /v1/neural-memory-fusion/stats
Hafıza birleştirme istatistikleri.

---

## Agent Economy

### POST /v1/economy/trade
Takas teklifi oluşturur.

**Body:**
```json
{
  "tenantId": "local",
  "fromAgentId": "agent1",
  "toAgentId": "agent2",
  "offer": { "resource": "cpu", "amount": 10 },
  "request": { "resource": "memory", "amount": 5 }
}
```

---

## Planning & Goals

### Goal Stack

#### GET /v1/goals
Hedefleri listeler.

#### POST /v1/goals
Yeni hedef ekler.

**Body:**
```json
{
  "tenantId": "local",
  "goalTitle": "Hedef başlığı",
  "goalDescription": "Açıklama",
  "priority": 5
}
```

---

## Error Handling

### HTTP Status Codes
- `200` - Başarılı
- `201` - Oluşturuldu
- `400` - Geçersiz istek (Zod validation)
- `404` - Bulunamadı
- `429` - Rate limit aşıldı
- `500` - Sunucu hatası

### Rate Limit Response
```json
{
  "error": "rate_limit_exceeded",
  "message": "Too many requests",
  "retryAfter": 60
}
```

---

## Environment Variables

| Değişken | Açıklama | Default |
|----------|----------|---------|
| `TRUST_PROXY` | X-Forwarded-For güven | `false` |
| `PORT` | Sunucu portu | `8787` |
| `NODE_ENV` | Ortam | `development` |

---

## WebSocket Events

Canvas WebSocket üzerinden real-time güncelleme alır:

- `agent:status` - Agent durumu değişti
- `task:completed` - Görev tamamlandı
- `memory:updated` - Hafıza güncellendi

---

## Ek Kaynaklar

- [README](../README.md)
- [Contributing](../CONTRIBUTING.md)
- [Security Policy](../SECURITY.md)
