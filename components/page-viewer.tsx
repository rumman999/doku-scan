"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react"
import { getPageBlob } from "@/lib/db/indexed-db"
import type { BatchPage } from "@/hooks/use-scan-batch"
import { cn } from "@/lib/utils"

const SWIPE_PX = 50

/**
 * Full-screen viewer for a document's pages. Only the visible page's
 * full-resolution blob is loaded; the thumbnail shows instantly meanwhile.
 */
export function PageViewer({
  pages,
  index,
  onIndexChange,
  onClose,
}: {
  pages: BatchPage[]
  index: number | null
  onIndexChange: (index: number) => void
  onClose: () => void
}) {
  const open = index !== null && index >= 0 && index < pages.length
  const page = open ? pages[index!] : null
  const [fullUrl, setFullUrl] = useState<{ id: string; url: string } | null>(null)
  const touchRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!page) return
    let cancelled = false
    let url: string | null = null
    getPageBlob(page.id)
      .then((blob) => {
        if (cancelled || !blob) return
        url = URL.createObjectURL(blob)
        setFullUrl({ id: page.id, url })
      })
      .catch((err) => console.error("[Viewer] load failed", err))
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [page?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const go = (delta: number) => {
    if (index === null) return
    const next = index + delta
    if (next >= 0 && next < pages.length) onIndexChange(next)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
      else if (e.key === "ArrowLeft") go(-1)
      else if (e.key === "ArrowRight") go(1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  if (!open || !page || typeof document === "undefined") return null
  const src = fullUrl?.id === page.id ? fullUrl.url : page.thumbUrl
  const loading = fullUrl?.id !== page.id

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Page ${index! + 1} of ${pages.length}`}
      className="fixed inset-0 z-[65] flex flex-col bg-black text-white"
      onTouchStart={(e) => (touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchEnd={(e) => {
        const s = touchRef.current
        touchRef.current = null
        if (!s) return
        const dx = e.changedTouches[0].clientX - s.x
        const dy = e.changedTouches[0].clientY - s.y
        if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1)
      }}
    >
      <header
        className="flex items-center justify-between px-3 pb-2"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <span className="px-2 text-sm font-medium tabular-nums text-white/80">
          {index! + 1} / {pages.length}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close viewer"
          className="flex size-10 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
        >
          <X className="size-5" />
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center p-3">
        <img src={src} alt={`Page ${index! + 1}`} className="max-h-full max-w-full object-contain" draggable={false} />
        {loading ? <Loader2 className="absolute size-6 animate-spin text-white/60" /> : null}
      </div>

      <footer
        className="flex items-center justify-between px-4 pt-2"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        {[
          { delta: -1, label: "Previous page", Icon: ChevronLeft, disabled: index === 0 },
          { delta: 1, label: "Next page", Icon: ChevronRight, disabled: index === pages.length - 1 },
        ].map(({ delta, label, Icon, disabled }) => (
          <button
            key={delta}
            type="button"
            onClick={() => go(delta)}
            disabled={disabled}
            aria-label={label}
            className={cn(
              "flex size-12 items-center justify-center rounded-full bg-white/10 hover:bg-white/20",
              disabled && "pointer-events-none opacity-30",
            )}
          >
            <Icon className="size-6" />
          </button>
        ))}
      </footer>
    </div>,
    document.body,
  )
}
