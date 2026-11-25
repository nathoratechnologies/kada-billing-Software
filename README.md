# kada-billing-Software

Billing for small shops: any shop registers itself, adds staff with roles, and bills from any phone or browser.

- Shop registration (name, logo, address, phone, optional GSTIN) and owner login
- Roles: **Owner** (everything, approves users), **Admin** (items, purchases, reports, adds users who wait for approval), **Sales** (billing, item list, own sales)
- Items with photos and stock, tick-to-bill, PDF bills, purchases that add stock, daily/weekly/monthly/yearly reports with PDF
- **Online with Firebase** (Firestore + Email/Password login) when `www/firebase-config.js` has a config; otherwise everything stays on the phone

## Firebase setup
1. Create a Firebase project, turn on Authentication → Email/Password, create a Firestore database.
2. Paste `firestore.rules` into Firestore → Rules and publish.
3. Put the web app config into `www/firebase-config.js` as `window.KADA_FIREBASE_CONFIG = { ... }`.

## Builds
Every push to `main` builds the website (GitHub Pages: https://upasnath.github.io/kada-billing/) and the Android APK
(Releases → test-build → kada-billing.apk).

## Project layout
- `www/index.html` – styles and page shell
- `www/app.js` – the app: registration, login, roles, billing, items, purchases, reports
- `src/native.js` – backend layer: Firebase or phone-only storage, PDF/sharing, import from older versions (bundled to `www/native.js`)
- `firestore.rules` – who may read and write what
- `android/` – Android project (Capacitor)
