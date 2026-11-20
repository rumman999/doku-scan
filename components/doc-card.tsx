"use client"

import { useEffect, useRef } from "react"
import { Check, FileText } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDocDate, pluralPages } from "@/lib/format"
import type { LibraryDocument } from "@/hooks/use-documents"

const LONG_PRESS_MS = 450
/** Finger travel that turns a press into a scroll (cancels the long-press). */
const MOVE_CANCEL_PX = 10

export function DocCard({
  doc,
  view,
  selectionMode,
  selected,
  onOpen,
  onToggle,
  onLongPress,
}: {
  doc: LibraryDocument
  view: "grid" | "list"
  selectionMode: boolean
  selected: boolean
  onOpen: () => void
  onToggle: () => void
  onLongPress: () => void
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  /** Set when a long-press fired, so the click that follows the release is ignored. */
  const longPressedRef = useRef(false)

  const cancelPress = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    startRef.current = null
  }
  useEffect(() => cancelPress, [])

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      longPressedRef.current = false
      startRef.current = { x: e.clientX, y: e.clientY }
      timerRef.current = setTimeout(() => {
        longPressedRef.current = true
        timerRef.current = null
        navigator.vibrate?.(10)
        onLongPress()
      }, LONG_PRESS_MS)
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = startRef.current
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_CANCEL_PX) cancelPress()
    },
    onPointerUp: cancelPress,
    onPointerLeave: cancelPress,
    onPointerCancel: cancelPress,
    // Suppress the OS context menu that a long-press opens on mobile.
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onClick: () => {
      if (longPressedRef.current) {
        longPressedRef.current = false
        return
      }
      if (selectionMode) onToggle()
      else onOpen()
    },
  }

  const checkbox = (
    <span
      className={cn(
        "flex size-6 items-center justify-center rounded-full border-2 transition-colors",
        selected ? "border-primary bg-primary text-primary-foreground" : "border-white/70 bg-black/30",
      )}
      aria-hidden
    >
      {selected && <Check className="size-4" strokeWidth={3} />}
    </span>
  )

  const cover = doc.coverUrl ? (
    <img src={doc.coverUrl} alt="" aria-hidden className="h-full w-full object-cover" draggable={false} />
  ) : (
    <span className="flex h-full w-full items-center justify-center text-muted-foreground">
      <FileText className="size-6" />
    </span>
  )

  const label = `${doc.name}, ${pluralPages(doc.pageCount)}`

  if (view === "list") {
    return (
      <button
        type="button"
        {...handlers}
        aria-label={label}
        aria-pressed={selectionMode ? selected : undefined}
        style={{ WebkitTouchCallout: "none" } as React.CSSProperties}
        className={cn(
          "flex w-full select-none items-center gap-3 rounded-xl border border-border bg-card p-2.5 text-left transition-colors",
          selected && "border-primary/60 bg-primary/5",
        )}
      >
        <span className="relative h-16 w-12 shrink-0 overflow-hidden rounded-md bg-muted">{cover}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{doc.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileText className="size-3" />
            {pluralPages(doc.pageCount)} · {formatDocDate(doc.updatedAt)}
          </span>
        </span>
        {selectionMode && <span className="shrink-0 pr-1">{checkbox}</span>}
      </button>
    )
  }

  return (
    <button
      type="button"
      {...handlers}
      aria-label={label}
      aria-pressed={selectionMode ? selected : undefined}
      style={{ WebkitTouchCallout: "none" } as React.CSSProperties}
      className={cn(
        "group flex select-none flex-col gap-2 rounded-xl border border-border bg-card p-2 text-left transition-colors",
        selected && "border-primary/60 bg-primary/5",
      )}
    >
      <span className="relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-muted">
        {cover}
        {selectionMode && <span className="absolute right-2 top-2">{checkbox}</span>}
        {selected && <span className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-primary" />}
      </span>
      <span className="flex min-w-0 flex-col px-0.5 pb-0.5">
        <span className="truncate text-xs font-medium text-foreground">{doc.name}</span>
        <span className="mt-0.5 text-[11px] text-muted-foreground">
          {pluralPages(doc.pageCount, true)} · {formatDocDate(doc.updatedAt)}
        </span>
      </span>
    </button>
  )
}
