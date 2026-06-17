export type DocFolder = {
  id: string
  name: string
  count: number
  accent: string
}

export type ScanDoc = {
  id: string
  name: string
  date: string
  pages: number
  src: string
  filter: string
}

export const FOLDERS: DocFolder[] = [
  { id: "receipts", name: "Receipts", count: 24, accent: "oklch(0.62 0.18 250)" },
  { id: "id-cards", name: "ID Cards", count: 6, accent: "oklch(0.65 0.17 160)" },
  { id: "whiteboards", name: "Whiteboards", count: 11, accent: "oklch(0.7 0.16 60)" },
  { id: "contracts", name: "Contracts", count: 9, accent: "oklch(0.62 0.2 20)" },
]

export const DOCUMENTS: ScanDoc[] = [
  { id: "d1", name: "Office Lease Agreement", date: "Today, 9:41 AM", pages: 4, src: "/document-scan.png", filter: "none" },
  { id: "d2", name: "Grocery Receipt", date: "Today, 8:12 AM", pages: 1, src: "/document-scan.png", filter: "grayscale(1) contrast(1.7) brightness(1.1)" },
  { id: "d3", name: "Project Whiteboard", date: "Yesterday", pages: 2, src: "/document-scan.png", filter: "saturate(1.35) contrast(1.15) brightness(1.08)" },
  { id: "d4", name: "Insurance Form", date: "Yesterday", pages: 3, src: "/document-scan.png", filter: "grayscale(0.85) brightness(1.12) contrast(0.95)" },
  { id: "d5", name: "Business Card", date: "Mar 14", pages: 1, src: "/document-scan.png", filter: "none" },
  { id: "d6", name: "Meeting Notes", date: "Mar 12", pages: 5, src: "/document-scan.png", filter: "grayscale(1) contrast(1.7) brightness(1.1)" },
]
