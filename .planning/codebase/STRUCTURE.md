# Directory Structure
- `/app/`: Next.js routing (`/scan`, `/ocr`, `/settings`, `/`). All interactive routes must use the `'use client'` directive.
- `/components/`: App-specific UI (`crop-view.tsx`, `pdf-export-sheet.tsx`).
- `/components/ui/`: Reusable Shadcn UI primitives (DO NOT modify these unless explicitly instructed).
- `/lib/`: Helper functions (`utils.ts`).