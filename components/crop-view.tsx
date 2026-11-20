"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import { ArrowRight, Loader2, Maximize, ScanLine, X } from "lucide-react"
import { Point } from "@/lib/cv/document-processor"
import { documentProcessor } from "@/lib/cv/processor-client"
import { cn } from "@/lib/utils"

interface CropViewProps {
  src: string
  initialCorners?: Point[] | null
  /** Receives the dewarped page (caller owns and must close() it) and the corners used. */
  onCropComplete: (page: ImageBitmap, corners: Point[]) => void | Promise<void>
  /** Discard this photo and go back to the camera. */
  onCancel?: () => void
}

/** Accent used inside SVG/canvas, matching the app's primary blue. */
const ACCENT = "#3b82f6"
const LOUPE_SIZE = 112
/** Source pixels shown in the loupe (zoom = LOUPE_SIZE / LOUPE_SAMPLE). */
const LOUPE_SAMPLE = 40

/** Where the image is drawn inside the container, in container pixels. */
interface Layout {
  naturalWidth: number
  naturalHeight: number
  left: number
  top: number
  width: number
  height: number
}

function fullFrame(w: number, h: number): Point[] {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ]
}

function insetFrame(w: number, h: number, f = 0.08): Point[] {
  return [
    { x: w * f, y: h * f },
    { x: w * (1 - f), y: h * f },
    { x: w * (1 - f), y: h * (1 - f) },
    { x: w * f, y: h * (1 - f) },
  ]
}

/**
 * Corner adjustment for a captured photo. Handles and outline are moved by
 * direct DOM mutation (no React render per pointermove), so dragging stays
 * at display frame rate on low-end phones.
 */
export function CropView({ src, initialCorners, onCropComplete, onCancel }: CropViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const shadeRef = useRef<SVGPathElement | null>(null)
  const outlineRef = useRef<SVGPolygonElement | null>(null)
  const handleRefs = useRef<(SVGGElement | null)[]>([null, null, null, null])
  const loupeRef = useRef<HTMLDivElement | null>(null)
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const layoutRef = useRef<Layout | null>(null)
  /** Corners in natural image pixels, [TL, TR, BR, BL]. */
  const cornersRef = useRef<Point[]>(fullFrame(1, 1))
  const dragRef = useRef<{ index: number; pointerId: number; offsetX: number; offsetY: number } | null>(null)
  /** Set once the user moves a handle; late auto-detection must not overwrite their work. */
  const userEditedRef = useRef(false)
  const busyRef = useRef(false)

  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<null | "detect" | "crop">(null)
  const [error, setError] = useState<string | null>(null)
  /** Whether the current corners came from detection (drives the Detect / Full page toggle). */
  const [isFullPage, setIsFullPage] = useState(false)

  const toScreen = (p: Point, l: Layout) => ({
    x: l.left + (p.x / l.naturalWidth) * l.width,
    y: l.top + (p.y / l.naturalHeight) * l.height,
  })

  const render = useCallback(() => {
    const l = layoutRef.current
    if (!l) return
    const pts = cornersRef.current.map((p) => toScreen(p, l))
    const poly = pts.map((p) => `${p.x},${p.y}`).join(" ")
    outlineRef.current?.setAttribute("points", poly)
    const c = containerRef.current
    if (shadeRef.current && c) {
      const { width, height } = c.getBoundingClientRect()
      // Even-odd fill: everything except the selected quad is dimmed.
      shadeRef.current.setAttribute(
        "d",
        `M0 0H${width}V${height}H0Z M${pts.map((p) => `${p.x} ${p.y}`).join(" L")}Z`,
      )
    }
    pts.forEach((p, i) => handleRefs.current[i]?.setAttribute("transform", `translate(${p.x} ${p.y})`))
  }, [])

  /** Measure where the <img> actually landed (object-contain, padding) inside the container. */
  const measure = useCallback(() => {
    const img = imgRef.current
    const c = containerRef.current
    if (!img || !c || !img.naturalWidth) return
    const cr = c.getBoundingClientRect()
    const ir = img.getBoundingClientRect()
    layoutRef.current = {
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      left: ir.left - cr.left,
      top: ir.top - cr.top,
      width: ir.width,
      height: ir.height,
    }
    render()
  }, [render])

  const setCorners = useCallback(
    (pts: Point[]) => {
      cornersRef.current = pts.map((p) => ({ ...p }))
      render()
    },
    [render],
  )

  const applyInitial = useCallback(() => {
    const img = imgRef.current
    if (!img?.naturalWidth) return
    const w = img.naturalWidth
    const h = img.naturalHeight
    if (initialCorners?.length === 4) {
      setCorners(initialCorners.map((p) => ({ x: Math.min(w, Math.max(0, p.x)), y: Math.min(h, Math.max(0, p.y)) })))
      setIsFullPage(false)
    } else {
      setCorners(insetFrame(w, h))
      setIsFullPage(false)
    }
  }, [initialCorners, setCorners])

  // New photo: reset edit state.
  useEffect(() => {
    userEditedRef.current = false
    setError(null)
    setLoaded(false)
  }, [src])

  // Better corners can arrive after load (detection on the captured photo runs in the background).
  useEffect(() => {
    if (loaded && !userEditedRef.current) applyInitial()
  }, [loaded, applyInitial])

  useEffect(() => {
    const c = containerRef.current
    if (!c) return
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null
    ro?.observe(c)
    window.addEventListener("resize", measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [measure])

  /* ---------------- Dragging ---------------- */

  const drawLoupe = (screen: Point, natural: Point) => {
    const loupe = loupeRef.current
    const canvas = loupeCanvasRef.current
    const img = imgRef.current
    const c = containerRef.current
    if (!loupe || !canvas || !img || !c) return
    const dpr = window.devicePixelRatio || 1
    const px = Math.round(LOUPE_SIZE * dpr)
    if (canvas.width !== px) {
      canvas.width = px
      canvas.height = px
    }
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, px, px)
    ctx.drawImage(img, natural.x - LOUPE_SAMPLE / 2, natural.y - LOUPE_SAMPLE / 2, LOUPE_SAMPLE, LOUPE_SAMPLE, 0, 0, px, px)
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1.5 * dpr
    ctx.beginPath()
    ctx.moveTo(px / 2, px / 2 - 12 * dpr)
    ctx.lineTo(px / 2, px / 2 + 12 * dpr)
    ctx.moveTo(px / 2 - 12 * dpr, px / 2)
    ctx.lineTo(px / 2 + 12 * dpr, px / 2)
    ctx.stroke()

    // Keep the loupe in the corner away from the finger.
    const { width } = c.getBoundingClientRect()
    const left = screen.x < width / 2 ? width - LOUPE_SIZE - 12 : 12
    loupe.style.transform = `translate3d(${left}px, 12px, 0)`
    loupe.style.opacity = "1"
  }

  const onHandleDown = (index: number) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const l = layoutRef.current
    const c = containerRef.current
    if (!l || !c || busyRef.current) return
    const cr = c.getBoundingClientRect()
    const p = toScreen(cornersRef.current[index], l)
    // Keep the grab offset so the corner doesn't jump under the finger.
    dragRef.current = { index, pointerId: e.pointerId, offsetX: p.x - (e.clientX - cr.left), offsetY: p.y - (e.clientY - cr.top) }
    userEditedRef.current = true
    setError(null)
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    const l = layoutRef.current
    const c = containerRef.current
    if (!drag || drag.pointerId !== e.pointerId || !l || !c) return
    e.preventDefault()
    const cr = c.getBoundingClientRect()
    const sx = Math.min(l.left + l.width, Math.max(l.left, e.clientX - cr.left + drag.offsetX))
    const sy = Math.min(l.top + l.height, Math.max(l.top, e.clientY - cr.top + drag.offsetY))
    const natural = {
      x: ((sx - l.left) / l.width) * l.naturalWidth,
      y: ((sy - l.top) / l.height) * l.naturalHeight,
    }
    cornersRef.current[drag.index] = natural
    render()
    drawLoupe({ x: sx, y: sy }, natural)
  }

  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current?.pointerId !== e.pointerId) return
    dragRef.current = null
    if (loupeRef.current) loupeRef.current.style.opacity = "0"
    setIsFullPage(false)
  }

  /* ---------------- Actions ---------------- */

  const toggleFrame = async () => {
    const img = imgRef.current
    if (!img?.naturalWidth || busyRef.current) return
    setError(null)
    if (!isFullPage) {
      setCorners(fullFrame(img.naturalWidth, img.naturalHeight))
      setIsFullPage(true)
      userEditedRef.current = true
      return
    }
    // Back from full page: re-run detection on the photo.
    busyRef.current = true
    setBusy("detect")
    try {
      const detected = await documentProcessor.detectCorners(await createImageBitmap(img))
      if (detected?.length === 4) {
        setCorners(detected)
        setIsFullPage(false)
      } else {
        setError("No edges found. Drag the corners into place.")
      }
    } catch (err) {
      console.error("[Crop] detect failed", err)
      setError("Detection failed. Drag the corners into place.")
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }

  const confirm = async () => {
    const img = imgRef.current
    if (!img?.naturalWidth || busyRef.current) return
    busyRef.current = true
    setBusy("crop")
    setError(null)
    try {
      const bitmap = await createImageBitmap(img)
      const corners = cornersRef.current.map((p) => ({ ...p }))
      const page = await documentProcessor.dewarp(bitmap, corners)
      await onCropComplete(page, corners)
    } catch (err) {
      console.error("[Crop] dewarp failed", err)
      setError("Couldn't crop this page. Adjust the corners and try again.")
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }

  return (
    <div className="flex h-full w-full select-none flex-col bg-black text-white">
      <header
        className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center px-3 pb-2"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <button
          type="button"
          onClick={onCancel}
          disabled={!!busy}
          className="flex h-10 items-center gap-1.5 justify-self-start rounded-full px-3 text-sm font-medium text-white/85 active:bg-white/10 disabled:opacity-40"
        >
          <X className="size-5" />
          Retake
        </button>
        <span className="text-sm font-semibold">Adjust corners</span>
        <span aria-hidden />
      </header>

      <div
        ref={containerRef}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="relative min-h-0 flex-1 touch-none overflow-hidden"
      >
        {/* Padding keeps corner handles at the photo's edge reachable. */}
        <div className="absolute inset-0 flex items-center justify-center p-7">
          <img
            ref={imgRef}
            src={src}
            alt="Captured photo"
            onLoad={() => {
              measure()
              setLoaded(true)
            }}
            draggable={false}
            className="pointer-events-none max-h-full max-w-full object-contain"
          />
        </div>

        <svg className={cn("absolute inset-0 h-full w-full", !loaded && "invisible")}>
          <path ref={shadeRef} fill="rgba(0,0,0,0.55)" fillRule="evenodd" />
          <polygon ref={outlineRef} fill="none" stroke={ACCENT} strokeWidth={2.5} strokeLinejoin="round" />
          {[0, 1, 2, 3].map((i) => (
            <g
              key={i}
              ref={(el) => {
                handleRefs.current[i] = el
              }}
              onPointerDown={onHandleDown(i)}
              className="cursor-grab"
              role="slider"
              aria-label={["Top-left corner", "Top-right corner", "Bottom-right corner", "Bottom-left corner"][i]}
            >
              {/* 52px invisible touch target */}
              <circle r={26} fill="transparent" />
              <circle r={10} fill="white" stroke={ACCENT} strokeWidth={3} />
            </g>
          ))}
        </svg>

        <div
          ref={loupeRef}
          className="pointer-events-none absolute left-0 top-0 overflow-hidden rounded-full border-2 border-white opacity-0 shadow-xl transition-opacity duration-100"
          style={{ width: LOUPE_SIZE, height: LOUPE_SIZE }}
        >
          <canvas ref={loupeCanvasRef} className="size-full" />
        </div>

        {error ? (
          <p
            role="alert"
            className="absolute inset-x-4 bottom-3 mx-auto max-w-sm rounded-xl bg-rose-600 px-4 py-2.5 text-center text-sm font-medium text-white"
          >
            {error}
          </p>
        ) : null}
      </div>

      <footer
        className="flex shrink-0 items-center justify-between gap-3 px-4 pt-3"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        <button
          type="button"
          onClick={toggleFrame}
          disabled={!loaded || !!busy}
          className="flex h-12 items-center gap-2 rounded-full bg-white/10 px-4 text-sm font-medium active:bg-white/20 disabled:opacity-40"
        >
          {busy === "detect" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : isFullPage ? (
            <ScanLine className="size-4" />
          ) : (
            <Maximize className="size-4" />
          )}
          {isFullPage ? "Detect edges" : "Full page"}
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={!loaded || !!busy}
          className="flex h-12 items-center gap-2 rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground active:opacity-90 disabled:opacity-50"
        >
          {busy === "crop" ? <Loader2 className="size-4 animate-spin" /> : null}
          Next
          {busy !== "crop" ? <ArrowRight className="size-4" /> : null}
        </button>
      </footer>
    </div>
  )
}
