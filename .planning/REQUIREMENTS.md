# Core Requirements

* **REQ-1 (Capture):** Implement HTML5 `<input type="file" capture="environment">` for native mobile camera access. Pass the image blob to local state.
* **REQ-2 (Crop):** Integrate `react-image-crop` to provide a draggable, 4-point perspective correction mask over the captured document.
* **REQ-3 (OCR):** Integrate client-side `tesseract.js` in the OCR view to extract text from the cropped image canvas.
* **REQ-4 (Export):** Integrate `jspdf` within the export sheet component to compile the image and text into a downloadable local PDF.