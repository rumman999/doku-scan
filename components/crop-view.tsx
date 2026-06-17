"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

type Point = { x: number; y: number }
type CornerKey = "tl" | "tr" | "br" | "bl"

const INITIAL_CORNERS: Record<CornerKey, Point> = {
  tl: { x: 18, y: 14 },
  tr: { x: 82, y: 9 },
  br: { x: 90, y: 88 },
  bl: { x: 12, y: 82 },
}

const CSS_FILTERS: Record<string, string> = {
  original: "none",
  magic: "saturate(1.35) contrast(1.15) brightness(1.08)",
  bw: "grayscale(1) contrast(1.7) brightness(1.1)",
  eco: "grayscale(0.85) brightness(1.12) contrast(0.95)",
}

export function CropView({ filter }: { filter: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [corners, setCorners] = useState<Record<CornerKey, Point>>(INITIAL_CORNERS)
  const dragging = useRef<CornerKey | null>(null)

  const updateFromEvent = useCallback((clientX: number, clientY: number) => {
    const key = dragging.current
    const el = containerRef.current
    if (!key || !el) return
    const rect = el.getBoundingClientRect()
    const x = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100))
    const y = Math.min(100, Math.max(0, ((clientY - rect.top) / rect.height) * 100))
    setCorners((prev) => ({ ...prev, [key]: { x, y } }))
  }, [])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return
      e.preventDefault()
      updateFromEvent(e.clientX, e.clientY)
    }
    const onUp = () => {
      dragging.current = null
    }
    window.addEventListener("pointermove", onMove, { passive: false })
    window.addEventListener("pointerup", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [updateFromEvent])

  const polygon = `polygon(${corners.tl.x}% ${corners.tl.y}%, ${corners.tr.x}% ${corners.tr.y}%, ${corners.br.x}% ${corners.br.y}%, ${corners.bl.x}% ${corners.bl.y}%)`

  const edgeMidpoints: { key: string; x: number; y: number }[] = [
    { key: "top", x: (corners.tl.x + corners.tr.x) / 2, y: (corners.tl.y + corners.tr.y) / 2 },
    { key: "right", x: (corners.tr.x + corners.br.x) / 2, y: (corners.tr.y + corners.br.y) / 2 },
    { key: "bottom", x: (corners.br.x + corners.bl.x) / 2, y: (corners.br.y + corners.bl.y) / 2 },
    { key: "left", x: (corners.bl.x + corners.tl.x) / 2, y: (corners.bl.y + corners.tl.y) / 2 },
  ]

  return (
    <div
      ref={containerRef}
      className="relative aspect-[3/4] w-full touch-none select-none overflow-hidden rounded-2xl border border-border bg-black"
    >
      {/* Document image */}
      <img
        src="/document-scan.png"
        alt="Scanned document being adjusted"
        className="absolute inset-0 h-full w-full object-cover"
        style={{ filter: CSS_FILTERS[filter] ?? "none" }}
        crossOrigin="anonymous"
        draggable={false}
      />

      {/* Darkened area outside the crop selection */}
      <div
        className="absolute inset-0 bg-background/70"
        style={{
          clipPath: `polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${corners.tl.x}% ${corners.tl.y}%, ${corners.bl.x}% ${corners.bl.y}%, ${corners.br.x}% ${corners.br.y}%, ${corners.tr.x}% ${corners.tr.y}%, ${corners.tl.x}% ${corners.tl.y}%)`,
        }}
      />

      {/* Translucent blue crop mask */}
      <div
        className="absolute inset-0 bg-primary/20"
        style={{ clipPath: polygon }}
      />

      {/* Crop outline */}
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polygon
          points={`${corners.tl.x},${corners.tl.y} ${corners.tr.x},${corners.tr.y} ${corners.br.x},${corners.br.y} ${corners.bl.x},${corners.bl.y}`}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth="0.6"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/* Edge midpoint markers */}
      {edgeMidpoints.map((m) => (
        <span
          key={m.key}
          aria-hidden
          className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary-foreground bg-primary"
          style={{ left: `${m.x}%`, top: `${m.y}%` }}
        />
      ))}

      {/* Draggable corner anchors */}
      {(Object.keys(corners) as CornerKey[]).map((key) => (
        <button
          key={key}
          type="button"
          aria-label={`Adjust ${key} corner`}
          onPointerDown={(e) => {
            e.preventDefault()
            dragging.current = key
          }}
          className={cn(
            "absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full",
            "cursor-grab touch-none active:cursor-grabbing",
          )}
          style={{ left: `${corners[key].x}%`, top: `${corners[key].y}%` }}
        >
          <span className="h-6 w-6 rounded-full border-[3px] border-primary bg-primary-foreground/90 shadow-lg ring-4 ring-primary/25" />
        </button>
      ))}
    </div>
  )
}
