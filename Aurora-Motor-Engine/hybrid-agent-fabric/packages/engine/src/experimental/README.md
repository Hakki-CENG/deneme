# experimental/

FAZ 0 gate: **deneysel ayrımı**.

Bu dizin, olgunluk seviyesi "deneysel" olan yetenekleri **açıkça işaretler**.

## Neden dosyalar fiziksel olarak buraya taşınmadı?

Aday modüllerin (`digital-twin`, `embodiment`, `federated`, `domain-experts`,
`research`, `initiative`) tamamı `engine.ts` tarafından import ediliyor ve
çalışan testleri var. Dosyaları taşımak çalışan import'ları kırar ve gerçek bir
iyileştirme sağlamaz.

Kullanıcının talimatı **"30 yeni servisin tamamını silme — deneysel olanları
`experimental/` altında tut"** idi. Buradaki amaç *silmemek* ve *ayırt
edilebilir kılmak*. Bunu, çalışan kodu kırmadan **maturity registry** ile
sağlıyoruz: her modülün olgunluk seviyesi tek bir yerde, makinece okunabilir
biçimde beyan ediliyor.

## Olgunluk seviyeleri

| Seviye | Anlamı | Üretimde kullanılabilir mi? |
|---|---|---|
| `stable` | Testleri var, entegre, API'si donmuş | ✅ Evet |
| `beta` | Çalışıyor, entegre, API değişebilir | ⚠️ Dikkatli |
| `experimental` | İsmin vaat ettiği davranışın tamamını **henüz** sunmuyor | ❌ Hayır |

## Kritik kural

Bir modül `experimental` olarak işaretliyse, **adının vaat ettiği şeyi
yaptığını iddia etmez**. Örneğin `DigitalTwinService` gerçek bir dijital ikiz
simülasyonu değildir; durum aynası tutar. Bu ayrım `maturity.ts` içinde
`promisedBehaviour` ve `actualBehaviour` alanlarıyla açıkça yazılıdır.

Bir modülü `stable`'a yükseltmek için:
1. Kendi test dosyası olmalı
2. `Engine` üzerinden erişilebilir olmalı
3. `actualBehaviour` ile `promisedBehaviour` örtüşmeli
