# Concerns

- Need to handle OCR processing efficiently.
- PDF export may require optimization for large documents.
- **Performance:** High-resolution mobile camera images may cause canvas memory leaks. Ensure image blobs are compressed or resized before passing to `tesseract.js`.
- **Mobile Layout:** Fixed viewport heights (`100dvh`) must be used to prevent UI jumping when the mobile browser address bar collapses.