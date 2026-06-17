"use client"

import { Check, FileText } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ScanDoc } from "@/lib/library-data"

export function DocCard({
  doc,
  view,
  selectionMode,
  selected,
  onToggle,
  onLongPress,
}: {
  doc: ScanDoc
  view: "grid" | "list"
  selectionMode: boolean
  selected: boolean
  onToggle: () => void
  onLongPress: () => void
}) {
  let pressTimer: ReturnType<typeof setTimeout>

  function startPress() {
    pressTimer = setTimeout(onLongPress, 450)
  }
  function endPress() {
    clearTimeout(pressTimer)
  }

  function handleClick() {
    if (selectionMode) onToggle()
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

  if (view === "list") {
    return (
      <button
        type="button"
        onClick={handleClick}
        onPointerDown={startPress}
        onPointerUp={endPress}
        onPointerLeave={endPress}
        aria-pressed={selectionMode ? selected : undefined}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl border border-border bg-card p-2.5 text-left transition-colors",
          selected && "border-primary/60 bg-primary/5",
        )}
      >
        <span className="relative h-16 w-12 shrink-0 overflow-hidden rounded-md bg-muted">
          <img
            src={doc.src || "/placeholder.svg"}
            alt=""
            aria-hidden
            className="h-full w-full object-cover"
            style={{ filter: doc.filter }}
            draggable={false}
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{doc.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileText className="size-3" />
            {doc.pages} {doc.pages === 1 ? "page" : "pages"} · {doc.date}
          </span>
        </span>
        {selectionMode && <span className="shrink-0 pr-1">{checkbox}</span>}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerLeave={endPress}
      aria-pressed={selectionMode ? selected : undefined}
      className={cn(
        "group flex flex-col gap-2 rounded-xl border border-border bg-card p-2 text-left transition-colors",
        selected && "border-primary/60 bg-primary/5",
      )}
    >
      <span className="relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-muted">
        <img
          src={doc.src || "/placeholder.svg"}
          alt={doc.name}
          className="h-full w-full object-cover"
          style={{ filter: doc.filter }}
          draggable={false}
        />
        {selectionMode && (
          <span className="absolute right-2 top-2">{checkbox}</span>
        )}
        {selected && <span className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-primary" />}
      </span>
      <span className="flex flex-col px-0.5 pb-0.5">
        <span className="truncate text-xs font-medium text-foreground">{doc.name}</span>
        <span className="mt-0.5 text-[11px] text-muted-foreground">
          {doc.pages} {doc.pages === 1 ? "pg" : "pgs"} · {doc.date}
        </span>
      </span>
    </button>
  )
}
