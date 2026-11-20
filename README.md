<div align="center">
  <img src="public/icon.svg" alt="Doku Scan Logo" width="160" height="160" />
</div>

# Doku Scan

A free, fully offline document scanner. Built with Next.js (static export) and packaged for Android/iOS with Capacitor. No account, no cloud, no tracking: scans stay on the device unless you share them.

## Features
- **Live edge detection**: OpenCV (WebAssembly, in a Web Worker) finds the page in the camera preview; optional auto-capture when the page holds still.
- **Perspective crop**: drag the corners (with a magnifier) and the page is flattened to a top-down scan.
- **Enhancement filters**: Magic Color (shadow removal + sharpening), Black & White, or Original.
- **Single and batch modes**: batch keeps shooting while pages process in the background.
- **Document library**: scans are saved on the device (IndexedDB). Rename, reorder, remove or add pages, view full screen, merge documents, delete.
- **PDF export**: A4 / Letter / Auto page size, quality presets, optional watermark and password; shared via the native share sheet.

## Development

```bash
pnpm install
pnpm dev          # http://localhost:3000 (camera works on localhost)
pnpm typecheck
pnpm build        # static export to out/ (type errors fail the build)
```

### Android

Requires JDK 21 (`JAVA_HOME`) and the Android SDK (`ANDROID_HOME`).

```bash
pnpm build
npx cap sync android
npx cap run android      # or: npx cap open android
```

Debug the app's WebView from desktop Chrome at `chrome://inspect`.

## Architecture
- `app/` — screens: library (`/`), document (`/doc?id=`), scanner (`/scan`), settings.
- `lib/cv/` — detection, dewarp and filters (OpenCV.js). `lib/cv/worker.ts` is bundled to `public/cv-worker.js` by `scripts/build-worker.mjs`; `public/opencv.js` is vendored OpenCV 4.8.0.
- `lib/db/indexed-db.ts` — pages (full-res JPEG + thumbnail) and documents. Pages belong to a session: `current`/`single` while scanning, `doc:<id>` once saved. Saving moves pages in one transaction.
- `lib/pdf/export-pdf.ts` — streams pages one at a time into jsPDF, then shares/downloads.
- `lib/settings.ts` — user defaults (localStorage).

Note: PDF passwords use jsPDF's built-in RC4 encryption. It keeps casual readers out but is not strong encryption.
