/** "Today, 9:41 AM", "Yesterday, 6:02 PM", "Mar 14" or "Mar 14, 2025" for older years. */
export function formatDocDate(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp)
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayMs = 24 * 60 * 60 * 1000

  if (timestamp >= startOfToday) return `Today, ${time}`
  if (timestamp >= startOfToday - dayMs) return `Yesterday, ${time}`
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  })
}

export function pluralPages(n: number, short = false): string {
  if (short) return `${n} ${n === 1 ? "pg" : "pgs"}`
  return `${n} ${n === 1 ? "page" : "pages"}`
}

/** File-system-safe PDF name from a document title. */
export function pdfFilename(name: string): string {
  const safe = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
  return `${safe || "Document"}.pdf`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}
