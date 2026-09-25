<!-- HAF-STATUS-BANNER -->
> ## ⚠️ Elle yazılmış anlık görüntü — doğrulanmamış
>
> Bu dosya **koddan üretilmez** ve yazıldığından bu yana doğrulanmamıştır.
> İçindeki test sayıları, tamamlanma yüzdeleri ve "production-ready" gibi
> iddialar ölçülmüş gerçekle çelişebilir (ör. bu dosya "612 test" derken
> ölçülen değer farklıdır).
>
> **Yetkili kaynaklar** — bunlar koddan üretilir ve `packages/eval/test/state-docs.test.ts`
> sapmayı yakalar:
>
> - `hybrid-agent-fabric/CURRENT_STATE.md` — ölçülen modül/test durumu
> - `hybrid-agent-fabric/MATURITY_MATRIX.md` — olgunluk seviyeleri
> - `hybrid-agent-fabric/KNOWN_GAPS.md` — bilinen eksikler
>
> Depo invariantları için: `npm run verify:integration`.
> Bu bandın varlığı `scripts/verify-integration.mjs` tarafından denetlenir.

# Aurora Motor Engine — Güçlendirme Planı

## Mevcut Durum
- **Engine:** 214 kaynak dosya, 115 readonly servis, 361 yetenek, 41 public method
- **Control-API:** 576+ inline rota, 27 test passing
- **Canvas-Web:** 1016 satır App.tsx, 1226 satır CSS, 18 test passing
- **Build:** ✅ Engine, ✅ Control-API, ✅ Canvas-Web (343KB JS, 45KB CSS)
- **Test:** Engine 612/613, Control-API 27/27, Canvas-Web 18/18

## Kapatılan 5 Eksik
1. ✅ Dead route dosyaları temizlendi (14 dosya silindi)
2. ✅ Canvas-Web unit test'leri (18 test)
3. ✅ Virtual scrolling (VirtualList.tsx)
4. ✅ i18n desteği (en/tr, 107 anahtar)
5. ✅ PWA/offline desteği (SW + manifest)

## Güçlendirme Özellikleri (Engine'de var, UI'da eksik)

### S Tier — En Yüksek Etki
| # | Özellik | Engine Servisi | UI Durum |
|---|---------|---------------|----------|
| 1 | Session Arama/Filtreleme | engine.sessionSearch | ❌ UI yok |
| 2 | Dosya İçerik Arama | knowledgeIndexer | ❌ UI yok |
| 3 | Session Şablonları | profiles + createSession opts | ❌ Kısmi |
| 4 | Maliyet Gösterge Paneli | /v1/cost | ❌ UI yok |
| 5 | Keyboard Kısayolları | — | ❌ Kısmi |
| 6 | Agent Society Görselleştirme | engine.society | ❌ UI yok |
| 7 | Audit Log Görüntüleyici | engine.auditLog | ❌ UI yok |
| 8 | Model Performans Metrikleri | — | ❌ UI yok |
| 9 | Toplu Session İşlemleri | batch endpoints | ❌ UI yok |
| 10 | Session Karşılaştırma | replay/consensus | ❌ UI yok |

## Uygulama Sırası
1. Session Arama/Filtreleme (S1)
2. Dosya İçerik Arama (S2)
3. Session Şablonları (S3)
4. Maliyet Paneli (S4)
5. Keyboard Kısayolları (S5)
6. Agent Society Görselleştirme (S6)
7. Audit Log Görüntüleyici (S7)
8. Model Performans Metrikleri (S8)
9. Toplu Session İşlemleri (S9)
10. Session Karşılaştırma (S10)
