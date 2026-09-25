# Contributing to Aurora Motor Engine

> Aurora Motor Engine'e katkıda bulunma rehberi.

---

## Geliştirme Ortamı Kurulumu

### Ön Gereksinimler

- Node.js 20+
- pnpm 9+
- Git
- (Opsiyonel) Docker
- (Opsiyonel) PostgreSQL

### Kurulum

```bash
# Depoyu klonla
git clone https://github.com/Hakki-CENG/Aurora-Motor-Engine.git
cd Aurora-Motor-Engine/hybrid-agent-fabric

# Bağımlılıkları yükle
pnpm install

# Geliştirme sunucusunu başlat
pnpm dev
```

### Proje Yapısı

```
hybrid-agent-fabric/
├── apps/
│   ├── control-api/          # REST API sunucusu
│   │   ├── src/
│   │   │   ├── main.ts       # Ana giriş noktası
│   │   │   ├── auth/         # Kimlik doğrulama
│   │   │   ├── middleware/    # Middleware'ler
│   │   │   ├── routes/       # Route modülleri
│   │   │   └── platforms/    # Platform doğrulama
│   │   └── test/             # API testleri
│   ├── canvas-web/           # React UI
│   │   ├── src/
│   │   │   ├── App.tsx       # Ana uygulama
│   │   │   ├── components/   # UI bileşenleri
│   │   │   └── styles.css    # Stilller
│   │   └── dist/             # Build çıktısı
│   ├── desktop/              # Electron masaüstü
│   ├── headless-client/      # CLI istemci
│   └── session-worker/       # Session worker
├── packages/
│   └── engine/               # Ana motor paketi
│       └── src/
│           ├── aurora/       # Aurora bilişsel servisler
│           ├── embodiment/   # Dijital embodiment
│           ├── memory/       # Hafıza yönetimi
│           ├── thought/      # Düşünce döngüsü
│           ├── world/        # Dünya modeli
│           ├── initiative/   # Proaktif initiative
│           ├── evolution/    # Evrim servisleri
│           └── ...
└── docs/                     # Dokümantasyon
```

---

## Kod Stili

### TypeScript

- **Strict mode** aktif
- `any` type kullanımından kaçının
- `as unknown as` cast'lerinden kaçının
- Interface'ler type'lara tercih edin
- Readonly mümkün olduğunca kullanın

### Naming Conventions

- **Dosya adları**: `kebab-case` (ör: `rate-limiter.ts`)
- **Class adları**: `PascalCase` (ör: `RateLimiter`)
- **Fonksiyon adları**: `camelCase` (ör: `createRateLimiter`)
- **Constant'lar**: `UPPER_SNAKE_CASE` (ör: `DEFAULT_CONFIG`)
- **Interface'ler**: `PascalCase` (ör: `RateLimitConfig`)
- **Type'lar**: `PascalCase` (ör: `ErrorCodeKey`)

### Error Handling

- Hataları `AppError` class'ı ile fırlatın
- Semantic error codes kullanın (`HAF-XXXX`)
- Operational vs programmer error ayrımı yapın
- Async fonksiyonlarda try-catch kullanın

```typescript
// ✅ Doğru
throw new AppError("SESSION_NOT_FOUND", { sessionId });

// ❌ Yanlış
throw new Error("Session not found");
```

### Route Pattern

```typescript
// ✅ Doğru - Zod ile validation
app.get("/v1/sessions", async (request) => {
  const q = z.object({
    tenantId: z.string().default("local"),
    page: z.coerce.number().int().min(1).default(1),
  }).parse(request.query);
  return { sessions: await engine.sessions(q.tenantId) };
});

// ❌ Yanlış - Validation yok
app.get("/v1/sessions", async (request) => {
  const tenantId = (request.query as any).tenantId || "local";
  return { sessions: await engine.sessions(tenantId) };
});
```

---

## Git Workflow

### Branch Naming

- `feature/xxx` — Yeni özellik
- `fix/xxx` — Hata düzeltmesi
- `refactor/xxx` — Refactoring
- `docs/xxx` — Dokümantasyon
- `test/xxx` — Test ekleme

### Commit Messages

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Türler:
- `feat` — Yeni özellik
- `fix` — Hata düzeltmesi
- `refactor` — Refactoring
- `docs` — Dokümantasyon
- `test` — Test
- `chore` — Bakım
- `style` — Kod stili
- `perf` — Performans

Örnekler:
```
feat(memory): add pagination to memory list endpoint
fix(auth): fix CSRF token validation
refactor(routes): split main.ts into route modules
docs(config): add configuration reference
test(rate-limiter): add rate limiter unit tests
```

### Pull Request

1. Feature branch oluştur
2. Değişiklikleri yap
3. Testleri çalıştır (`pnpm test`)
4. Lint kontrolü (`pnpm lint`)
5. PR oluştur ve açıkla
6. Review bekle
7. Merge

---

## Test Yazma

### Unit Test

```typescript
import { describe, it, expect } from "vitest";

describe("MyService", () => {
  it("should do something", () => {
    const result = myFunction();
    expect(result).toBe(expected);
  });

  it("should handle errors", () => {
    expect(() => myFunction(badInput)).toThrow(AppError);
  });
});
```

### Integration Test

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("API Integration", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should create session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { tenantId: "test" },
    });
    expect(response.statusCode).toBe(201);
  });
});
```

---

## Review Checklist

### Kod Kalitesi
- [ ] TypeScript strict mode uyumlu
- [ ] `any` type yok
- [ ] Error handling mevcut
- [ ] Zod validation mevcut
- [ ] Semantic error codes kullanılmış

### Güvenlik
- [ ] Input validation mevcut
- [ ] SQL injection riski yok
- [ ] Path traversal kontrolü var
- [ ] Rate limiting uygulanmış
- [ ] Auth kontrolü var

### Performans
- [ ] Pagination uygulanmış
- [ ] Gereksiz render yok
- [ ] Memory leak yok
- [ ] N+1 query yok

### Test
- [ ] Unit test mevcut
- [ ] Edge case'ler test edilmiş
- [ ] Error case'ler test edilmiş

---

## Sorun Bildirme

1. GitHub Issues kullanın
2. Şablonu doldurun
3. Reproduction adımları ekleyin
4. Ortam bilgisi verin
5. Log ekleyin

---

## İletişim

- GitHub Issues: Sorunlar ve öneriler
- Discussions: Genel tartışmalar
- Wiki: Dokümantasyon
