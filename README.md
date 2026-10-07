<div align="center">
  <img src="public/icon.svg" alt="Doku Scan Logo" width="160" height="160" />
</div>

# Doku Scan MVP

A fully offline, local-first document scanning application built with Next.js and natively packaged for mobile devices via Capacitor.

## Features
- **Native Camera Capture**: Snaps high-quality document photos directly via the device's native camera plugin (Capacitor), circumventing mobile browser memory limitations.
- **Client-Side Cropping**: Adjust the perspective and borders of your document cleanly using `react-image-crop` and HTML5 Canvas.
- **Multi-Page Support**: Continuously scan and append as many pages as you need into a single local gallery state before finalizing.
- **Native PDF Export**: Generates an A4 PDF containing all scanned pages perfectly fit using `jspdf`, and seamlessly writes the raw binary directly to the Android/iOS filesystem via `@capacitor/filesystem`.
- **Zero API Footprint**: Works completely offline.

## Architecture & Stack
- **Framework**: Next.js 14 (App Router, Static Export)
- **UI & Styling**: Tailwind CSS, Shadcn UI, Lucide Icons
- **Native Shell**: CapacitorJS (iOS & Android)
- **Filesystem**: @capacitor/filesystem
- **PDF Generation**: jsPDF

## Local Development

### 1. Web Preview
To preview and test the application in a local browser with PWA elements injected (for camera emulation):
```bash
pnpm install
pnpm dev
```
*Note: A fallback web camera UI will slide up to allow testing the crop and OCR flows without a physical device.*

### 2. Native Mobile Development
Since this project is configured for static export (`output: 'export'`), you must build the web assets before synchronizing them to the native shell.

```bash
# 1. Build the static Next.js export (/out)
pnpm build

# 2. Sync the assets to iOS and Android
npx cap sync

# 3. Open the native IDEs to build and deploy to a device
npx cap open ios
npx cap open android
```

## Maintenance Notes
- **Filesystem Access**: Native export requires correct OS permissions for writing to the `Documents` directory. 
- **Static Assets**: The `next.config.mjs` disables Image optimization (`unoptimized: true`) as required by native static environments.
- **State Handoff**: `sessionStorage` is utilized to safely proxy captured blob URLs between the Library page and the Scanner UI before they are actively cropped.
