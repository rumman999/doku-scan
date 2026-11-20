"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowLeft, Check, Loader2 } from "lucide-react"
import { documentProcessor } from "@/lib/cv/processor-client"
import { cn } from "@/lib/utils"
import type { ScanFilter } from "@/lib/settings"
import { MAGIC_COLOR_OPTIONS, BW_OPTIONS } from "@/lib/cv/presets"

const FILTERS: { value: ScanFilter; label: string }[] = [
  { value: "magic-color", label: "Magic Color" },
  { value: "bw", label: "B&W" },
  { value: "none", label: "Original" },
]

/** Long side of the on-screen preview; the full-resolution page is only filtered on save. */
const PREVIEW_MAX = 1400
const THUMB_MAX = 220

async function scaled(source: ImageBitmap, max: number): Promise<ImageBitmap> {
  const s = Math.min(1, max / Math.max(source.width, source.height))
  return createImageBitmap(source, {
    resizeWidth: Math.max(1, Math.round(source.width * s)),
    resizeHeight: Math.max(1, Math.round(source.height * s)),
    resizeQuality: "medium",
  })
}

async function filtered(source: ImageBitmap, filter: ScanFilter): Promise<ImageBitmap> {
  if (filter === "magic-color") return documentProcessor.magicColor(source, MAGIC_COLOR_OPTIONS)
  if (filter === "bw") return documentProcessor.applyBw(source, BW_OPTIONS)
  return source
}

function paint(canvas: HTMLCanvasElement | null, bitmap: ImageBitmap) {
  if (!canvas) return
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
}

/**
 * Pick the enhancement for a cropped page, previewing each option on the page
 * itself. Previews run on downscaled copies so switching is quick; the caller
 * applies the chosen filter to the full-resolution page.
 */
export function FilterReview({
  page,
  initialFilter,
  saving,
  onBack,
  onSave,
}: {
  /** Dewarped page. Still owned by the caller; never transferred or closed here. */
  page: ImageBitmap
  initialFilter: ScanFilter
  saving: boolean
  onBack: () => void
  onSave: (filter: ScanFilter) => void
}) {
  const [filter, setFilter] = useState<ScanFilter>(initialFilter)
  const [rendering, setRendering] = useState(true)
  const previewRef = useRef<HTMLCanvasElement | null>(null)
  const thumbRefs = useRef<Record<string, HTMLCanvasElement | null>>({})
  const previewCache = useRef(new Map<ScanFilter, ImageBitmap>())

  // Thumbnails for all three options, once per page.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const base = await scaled(page, THUMB_MAX)
      for (const f of FILTERS) {
        if (cancelled) break
        try {
          const out = await filtered(await createImageBitmap(base), f.value)
          if (!cancelled) paint(thumbRefs.current[f.value], out)
          out.close()
        } catch (err) {
          console.warn("[Review] thumbnail failed", f.value, err)
        }
      }
      base.close()
    })()
    return () => {
      cancelled = true
    }
  }, [page])

  // Large preview for the selected option (cached per filter).
  useEffect(() => {
    let cancelled = false
    const cached = previewCache.current.get(filter)
    if (cached) {
      paint(previewRef.current, cached)
      setRendering(false)
      return
    }
    setRendering(true)
    ;(async () => {
      try {
        const out = await filtered(await scaled(page, PREVIEW_MAX), filter)
        if (cancelled) {
          out.close()
          return
        }
        previewCache.current.set(filter, out)
        paint(previewRef.current, out)
      } catch (err) {
        console.warn("[Review] preview failed", err)
      } finally {
        if (!cancelled) setRendering(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [page, filter])

  useEffect(() => {
    const cache = previewCache.current
    return () => {
      cache.forEach((b) => b.close())
      cache.clear()
    }
  }, [page])

  return (
    <div className="flex h-full w-full select-none flex-col bg-black text-white">
      <header
        className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center px-3 pb-2"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <button
          type="button"
          onClick={onBack}
          disabled={saving}
          className="flex h-10 items-center gap-1.5 justify-self-start rounded-full px-3 text-sm font-medium text-white/85 active:bg-white/10 disabled:opacity-40"
        >
          <ArrowLeft className="size-5" />
          Crop
        </button>
        <span className="text-sm font-semibold">Enhance</span>
        <span aria-hidden />
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center p-5">
        <canvas ref={previewRef} className="max-h-full max-w-full rounded-sm object-contain shadow-2xl" />
        {rendering ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-7 animate-spin text-white/70" />
          </div>
        ) : null}
      </div>

      <div className="shrink-0 px-4 pt-2" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
        <div role="radiogroup" aria-label="Filter" className="mb-4 flex justify-center gap-3">
          {FILTERS.map((f) => {
            const active = filter === f.value
            return (
              <button
                key={f.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={saving}
                onClick={() => setFilter(f.value)}
                className="flex w-20 flex-col items-center gap-1.5"
              >
                <span
                  className={cn(
                    "flex h-24 w-full items-center justify-center overflow-hidden rounded-lg border-2 bg-white/5 transition-colors",
                    active ? "border-primary" : "border-transparent",
                  )}
                >
                  <canvas
                    ref={(el) => {
                      thumbRefs.current[f.value] = el
                    }}
                    className="max-h-full max-w-full object-contain"
                  />
                </span>
                <span className={cn("text-xs font-medium", active ? "text-white" : "text-white/55")}>{f.label}</span>
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => onSave(filter)}
          disabled={saving}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-primary text-sm font-semibold text-primary-foreground active:opacity-90 disabled:opacity-60"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  )
}
