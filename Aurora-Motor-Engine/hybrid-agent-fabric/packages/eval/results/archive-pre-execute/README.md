# Arşiv — `execute()` öncesi sonuçlar (GEÇERLİ DEĞİL)

Bu dizindeki dosyalar **kanıt olarak kullanılamaz.** Hepsi 2026-09-17
tarihinde, `engine.runTask()` düzeltilmeden önce üretildi.

## Neden geçersizler

`runTask()` bilişsel orkestrasyon katmanını sürüyor, gerçek ajanı değil.
O dönemde `outcome` iyimser başlıyor ve yalnızca düşürülüyordu, yani boş bir
plan "success" dönüyordu. Ölçülen örnek:

```json
{"totalTasks":10,"passed":10,"overallScore":1,"durationMs":1830,
 "details":"Outcome: success, Subsystems: 3, Phases: 3, Duration: 2ms"}
```

10 görev, 2 milisaniye, hiçbir ajan koşmadan — `%100 başarı`.

Diğer yanıltıcı örnek, `standalone-eval-1789662874414.json`:
**0 görev geçmiş ama `overallScore: 0.51`** raporlanmış.

`difficulty-analysis.md` ise `Weighted Score: 100.0%` diyor.

## Bunun yerine ne kullanılmalı

| Soru | Geçerli kaynak |
|---|---|
| Kabul kriterleri ayırt edici mi? | `npm run eval:validate` → `criteria-validation.json` |
| Hareketsiz model kaç görev geçiyor? | `npm run eval:baseline` → `core-suite-baseline-mock.json` (0/61 beklenir) |
| Sistem öğreniyor mu? | `npm run eval:learning` |
| Retrieval bozuldu mu? | `npm run eval:recall:lock` |
| Hepsi birden | `npm run eval:gates` |

Silmek yerine arşivlendiler: aynı hatanın tekrar üretilmesi hâlinde
karşılaştırma yapılabilsin diye. Yeni sonuç üretirken bu dizine yazmayın.
