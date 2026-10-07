# Architecture
- **Paradigm:** Offline-first, client-side single-page application (SPA).
- **Data Flow:** No backend, no API routes, no database. State is managed entirely in-memory using React `useState` and `useRef` during the scan lifecycle.
- **Pipeline:** Native HTML5 Camera Capture -> Canvas Rendering -> `react-image-crop` -> `tesseract.js` WebWorker Extraction -> `jspdf` Blob Generation.