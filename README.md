# Kutla Backend (Firebase Cloud Functions)

API anahtarlarınızı (OpenAI, Replicate) burada tutup uygulama callable function ile alır. **Bu kodu ayrı bir Firebase projesinde / sunucuda deploy edeceksiniz.**

## Kurulum

1. **Firebase CLI** (yoksa): `npm install -g firebase-tools`
2. **Giriş:** `firebase login`
3. **Proje:** Bu dizinde `firebase use --add` ile proje seçin veya `.firebaserc.example` dosyasını `.firebaserc` yapıp `YOUR_FIREBASE_PROJECT_ID` yerine kendi proje ID'nizi yazın.
4. **Secret'ları tanımlayın:**
   ```bash
   firebase functions:secrets:set OPENAI_API_KEY
   firebase functions:secrets:set REPLICATE_API_TOKEN
   ```
   İstendiğinde ilgili değerleri yapıştırın.
5. **Deploy:**
   ```bash
   cd backend && firebase deploy --only functions
   ```

## iOS tarafı

- Aynı Firebase projesine bir iOS uygulaması ekleyin, `GoogleService-Info.plist` indirip Kutla Xcode projesine ekleyin.
- Uygulama başlarken `getApiKeys` callable'ını çağırıp dönen anahtarları kullanacak.

## Dosya yapısı

- `functions/index.js` – `getApiKeys` callable (secret'ları döndürür)
- `firebase.json` – Functions kaynağı
- Secret'lar Firebase/Google Cloud Secret Manager'da tutulur; deploy sırasında veya `firebase functions:secrets:set` ile ayarlanır.
