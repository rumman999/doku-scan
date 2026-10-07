# Execution Roadmap

## Phase 1: Environment & Capture
* **Goal:** Verify boilerplate and implement native camera capture.
* **Success Criteria:** User can trigger the mobile camera, capture an image, and see it rendered in the browser.

## Phase 2: Cropping & UI Integration
* **Goal:** Wire the captured image state into the existing Shadcn `crop-view.tsx` component.
* **Success Criteria:** User can drag a cropping mask over the image and confirm the selection.

## Phase 3: Client-Side OCR
* **Goal:** Extract text locally.
* **Success Criteria:** `tesseract.js` successfully reads the cropped image canvas and populates the text area without network calls.

## Phase 4: PDF Generation
* **Goal:** Enable local file export.
* **Success Criteria:** `jspdf` successfully generates a valid PDF containing the cropped scan and text, prompting a local download.