"use client"

import React, { Suspense, useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Camera, Loader2, RefreshCw, Sparkles, X, Zap, ZapOff } from "lucide-react"
import { Capacitor } from "@capacitor/core"
import { Camera as CameraPlugin } from "@capacitor/camera"
import { CropView } from "@/components/crop-view"
import { FilterReview } from "@/components/filter-review"
import { useScanBatch } from "@/hooks/use-scan-batch"
import { appendSessionToDocument, createDocumentFromSession } from "@/lib/db/indexed-db"
import { loadSettings, type ScanFilter } from "@/lib/settings"
import { scheduleBackup } from "@/lib/drive/backup"
import { cn } from "@/lib/utils"
import { documentProcessor } from "@/lib/cv/processor-client"
import type { Point } from "@/lib/cv/document-processor"
import { BW_OPTIONS, MAGIC_COLOR_OPTIONS } from "@/lib/cv/presets"

type ScanMode = "single" | "batch"
type Screen = "camera" | "crop" | "review"

const RAW_FRAME_JPEG_QUALITY = 0.92
/** Long side of the downscaled frame sent to the detector. */
const DETECT_MAX_SIDE = 640
/** Minimum time between detection passes (~10/s max); keeps the outline live without hogging the phone. */
const DETECT_MIN_INTERVAL_MS = 100
/** Consecutive misses before the outline is dropped (prevents flicker on a single bad frame). */
const LOST_AFTER_MISSES = 3
/** How long the page must hold still before auto-capture fires. */
const STEADY_MS = 1200
/** Max corner drift (fraction of the frame's long side) that still counts as holding still. */
const STEADY_TOLERANCE = 0.025
/** After an auto-capture, re-arm once the page moves this far (next page placed) or is lost. */
const REARM_MOVE = 0.08
/** Outline easing per animation frame (0..1). Higher = snappier, lower = smoother. */
const OUTLINE_EASE = 0.35
const ACCENT = "#3b82f6"

const FILTER_LABELS: Record<ScanFilter, string> = { "magic-color": "Enhanced", bw: "B&W", none: "Original" }
const FILTER_CYCLE: ScanFilter[] = ["magic-color", "bw", "none"]

/** Render `page` with `filter` into a new bitmap. Never closes or transfers `page`. */
async function renderFiltered(page: ImageBitmap, filter: ScanFilter): Promise<ImageBitmap> {
  const copy = await createImageBitmap(page)
  if (filter === "magic-color") return documentProcessor.magicColor(copy, MAGIC_COLOR_OPTIONS)
  if (filter === "bw") return documentProcessor.applyBw(copy, BW_OPTIONS)
  return copy
}

function maxCornerShift(a: Point[], b: Point[]): number {
  return Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export default function ScanPage() {
  // useSearchParams needs a Suspense boundary in a static export.
  return (
    <Suspense fallback={<main className="h-dvh w-full bg-black" />}>
      <ScanScreen />
    </Suspense>
  )
}

function ScanScreen() {
  const router = useRouter()
  /** When set, captured pages are appended to this existing document. */
  const targetDocId = useSearchParams().get("doc")
  const returnHref = targetDocId ? `/doc?id=${encodeURIComponent(targetDocId)}` : "/"

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const progressRef = useRef<SVGCircleElement | null>(null)
  const shutterRef = useRef<HTMLButtonElement | null>(null)
  const flashRef = useRef<HTMLDivElement | null>(null)
  const thumbRef = useRef<HTMLDivElement | null>(null)
  /** Reused full-resolution canvas for shutter captures. */
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null)

  // Camera
  const streamRef = useRef<MediaStream | null>(null)
  const mountedRef = useRef(true)
  /** Bumped on every (re)start/stop so a slow getUserMedia from an older attempt is discarded. */
  const cameraAttemptRef = useRef(0)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [hasTorch, setHasTorch] = useState(false)
  const [torchEnabled, setTorchEnabled] = useState(false)

  // Options (seeded from settings)
  const [mode, setMode] = useState<ScanMode>("single")
  const [filter, setFilter] = useState<ScanFilter>("magic-color")
  const [autoCapture, setAutoCapture] = useState(false)
  useEffect(() => {
    const s = loadSettings()
    setFilter(s.defaultFilter)
    setMode(s.defaultMode)
    setAutoCapture(s.autoCapture)
  }, [])

  // Flow
  const [screen, setScreen] = useState<Screen>("camera")
  const [cropSrc, setCropSrc] = useState<string | null>(null)
  const cropSrcRef = useRef<string | null>(null)
  const [cropCorners, setCropCorners] = useState<Point[] | null>(null)
  const [reviewPage, setReviewPage] = useState<ImageBitmap | null>(null)
  const reviewPageRef = useRef<ImageBitmap | null>(null)
  reviewPageRef.current = reviewPage
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // Pages (full-res in IndexedDB; only thumbnails in memory)
  const batch = useScanBatch("current")
  const single = useScanBatch("single")
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const [pendingCount, setPendingCount] = useState(0)
  const capturingRef = useRef(false)
  const [finishing, setFinishing] = useState(false)

  // Detection (refs: updated ~10x/s without re-rendering React)
  const targetRef = useRef<Point[] | null>(null)
  const missesRef = useRef(0)
  const anchorRef = useRef<Point[] | null>(null)
  const steadySinceRef = useRef(0)
  const autoArmedRef = useRef(true)
  const autoCapturedAtRef = useRef<Point[] | null>(null)
  const videoSizeRef = useRef({ w: 0, h: 0 })
  // UI-facing detection state; only set when it actually changes.
  const [detected, setDetected] = useState(false)
  const [steady, setSteady] = useState(false)

  const settingsRef = useRef({ mode, filter, autoCapture })
  settingsRef.current = { mode, filter, autoCapture }

  const detectionPaused = screen !== "camera" || finishing || saving

  /* ------------------------------------------------------------------ */
  /* Camera lifecycle                                                    */
  /* ------------------------------------------------------------------ */

  const stopCamera = useCallback(() => {
    cameraAttemptRef.current++
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCameraActive(false)
    setTorchEnabled(false)
  }, [])

  const startCamera = useCallback(async () => {
    const attempt = ++cameraAttemptRef.current
    const stale = () => !mountedRef.current || attempt !== cameraAttemptRef.current
    try {
      setCameraError(null)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      setTorchEnabled(false)

      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError("This device or browser doesn't support camera access.")
        return
      }

      // In the Android/iOS app the WebView can only open the camera once the
      // OS-level permission is granted.
      if (Capacitor.isNativePlatform()) {
        const { camera } = await CameraPlugin.requestPermissions({ permissions: ["camera"] })
        if (stale()) return
        if (camera !== "granted") {
          setCameraError("Camera access is off. Allow it for Doku Scan in your phone's app settings.")
          return
        }
      }

      // 1440p is plenty for documents and keeps the preview pipeline at full
      // frame rate on mid-range phones (4K requests often drop it to ~15fps).
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 2560 },
          height: { ideal: 1440 },
          frameRate: { ideal: 30 },
        },
      })
      if (stale()) {
        mediaStream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = mediaStream

      const track = mediaStream.getVideoTracks()[0]
      if (track) {
        const caps = (track.getCapabilities?.() as any) || {}
        setHasTorch(Boolean(caps.torch))
        if (caps.focusMode?.includes?.("continuous")) {
          track.applyConstraints({ advanced: [{ focusMode: "continuous" } as any] }).catch(() => {})
        }
      }

      const video = videoRef.current
      if (video) {
        video.srcObject = mediaStream
        await video.play()
        if (stale()) return
        setCameraActive(true)
      }
    } catch (err: any) {
      if (stale() || err?.name === "AbortError") return
      console.error("[Camera] start failed", err)
      setCameraError(
        err?.name === "NotAllowedError" || err?.name === "SecurityError"
          ? "Camera access was denied. Allow it in your settings, then try again."
          : err?.name === "NotReadableError"
            ? "The camera is being used by another app. Close it and try again."
            : err?.name === "NotFoundError" || err?.name === "OverconstrainedError"
              ? "No usable camera was found on this device."
              : "The camera couldn't start. Try again.",
      )
      setCameraActive(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    startCamera()
    documentProcessor.init().catch(console.error)
    return () => {
      mountedRef.current = false
      stopCamera()
    }
  }, [startCamera, stopCamera])

  // Release the camera in the background; reopen on return (only on the camera screen).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stopCamera()
      else if (!streamRef.current) startCamera()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => document.removeEventListener("visibilitychange", onVisibility)
  }, [startCamera, stopCamera])

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try {
      const next = !torchEnabled
      await track.applyConstraints({ advanced: [{ torch: next } as any] })
      setTorchEnabled(next)
    } catch (e) {
      console.warn("[Camera] torch not supported", e)
    }
  }

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  // Release the captured photo / review bitmap if the screen unmounts mid-flow.
  useEffect(
    () => () => {
      if (cropSrcRef.current) URL.revokeObjectURL(cropSrcRef.current)
      reviewPageRef.current?.close()
    },
    [],
  )

  /* ------------------------------------------------------------------ */
  /* Detection loop + outline renderer                                   */
  /* ------------------------------------------------------------------ */

  const resetDetection = useCallback(() => {
    targetRef.current = null
    anchorRef.current = null
    steadySinceRef.current = 0
    missesRef.current = 0
    setDetected(false)
    setSteady(false)
  }, [])

  const handleShutterRef = useRef<() => void>(() => {})

  const onDetection = useCallback((corners: Point[] | null, now: number) => {
    const { w, h } = videoSizeRef.current
    const longSide = Math.max(w, h) || 1

    if (!corners) {
      if (++missesRef.current < LOST_AFTER_MISSES) return
      targetRef.current = null
      anchorRef.current = null
      steadySinceRef.current = 0
      autoArmedRef.current = true // page removed: next one may auto-capture
      autoCapturedAtRef.current = null
      setDetected(false)
      setSteady(false)
      return
    }

    missesRef.current = 0
    targetRef.current = corners
    if (!anchorRef.current || maxCornerShift(anchorRef.current, corners) > longSide * STEADY_TOLERANCE) {
      anchorRef.current = corners
      steadySinceRef.current = now
    }
    if (autoCapturedAtRef.current && maxCornerShift(autoCapturedAtRef.current, corners) > longSide * REARM_MOVE) {
      autoArmedRef.current = true
      autoCapturedAtRef.current = null
    }
    const heldFor = now - steadySinceRef.current
    setDetected(true)
    setSteady(heldFor > 300)

    const s = settingsRef.current
    if (s.autoCapture && autoArmedRef.current && heldFor >= STEADY_MS) {
      autoArmedRef.current = false
      autoCapturedAtRef.current = corners
      handleShutterRef.current()
    }
  }, [])

  // Detection: back-to-back passes on a GPU-downscaled frame, at most every 100ms.
  useEffect(() => {
    if (!cameraActive || detectionPaused) {
      resetDetection()
      return
    }
    let stopped = false
    ;(async () => {
      while (!stopped) {
        const started = performance.now()
        const video = videoRef.current
        if (video && video.readyState >= 2 && video.videoWidth > 0) {
          const vw = video.videoWidth
          const vh = video.videoHeight
          videoSizeRef.current = { w: vw, h: vh }
          try {
            const s = Math.min(1, DETECT_MAX_SIDE / Math.max(vw, vh))
            const frame = await createImageBitmap(video, {
              resizeWidth: Math.round(vw * s),
              resizeHeight: Math.round(vh * s),
              resizeQuality: "low",
            })
            // Some engines ignore resize options; derive the real scale from the result.
            const scale = frame.width / vw
            const corners = await documentProcessor.detectCorners(frame)
            if (stopped) break
            onDetection(corners?.map((p) => ({ x: p.x / scale, y: p.y / scale })) ?? null, performance.now())
          } catch (err) {
            if (!stopped) console.warn("[Detect] pass failed", err)
            await sleep(400)
          }
        }
        await sleep(Math.max(0, DETECT_MIN_INTERVAL_MS - (performance.now() - started)))
      }
    })()
    return () => {
      stopped = true
    }
  }, [cameraActive, detectionPaused, onDetection, resetDetection])

  // Outline renderer: eases toward the latest detection every frame, so the
  // outline glides instead of jumping between detections.
  useEffect(() => {
    if (screen !== "camera") return
    const canvas = overlayRef.current
    const box = previewRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !box || !ctx) return

    let cssW = 0
    let cssH = 0
    let dpr = 1
    const resize = () => {
      const r = box.getBoundingClientRect()
      dpr = window.devicePixelRatio || 1
      cssW = r.width
      cssH = r.height
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(box)

    let shown: Point[] | null = null
    let alpha = 0
    let drewEmpty = false
    let raf = 0
    const ringLen = 2 * Math.PI * 38

    const frame = () => {
      raf = requestAnimationFrame(frame)
      const target = targetRef.current
      alpha = Math.max(0, Math.min(1, alpha + (target ? 0.2 : -0.12)))
      if (target) {
        shown = shown ? shown.map((p, i) => ({ x: p.x + (target[i].x - p.x) * OUTLINE_EASE, y: p.y + (target[i].y - p.y) * OUTLINE_EASE })) : target
      }

      // Auto-capture progress ring around the shutter.
      const ring = progressRef.current
      if (ring) {
        const s = settingsRef.current
        const p =
          s.autoCapture && target && autoArmedRef.current && steadySinceRef.current
            ? Math.min(1, (performance.now() - steadySinceRef.current) / STEADY_MS)
            : 0
        ring.style.strokeDashoffset = String(ringLen * (1 - p))
      }

      if (alpha === 0 || !shown) {
        if (!drewEmpty) {
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          drewEmpty = true
        }
        if (alpha === 0) shown = null
        return
      }
      drewEmpty = false

      const { w: vw, h: vh } = videoSizeRef.current
      if (!vw || !vh) return
      // object-contain mapping: video pixels -> preview box (letterboxed).
      const scale = Math.min(cssW / vw, cssH / vh)
      const ox = (cssW - vw * scale) / 2
      const oy = (cssH - vh * scale) / 2
      const pts = shown.map((p) => ({ x: ox + p.x * scale, y: oy + p.y * scale }))

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)
      ctx.globalAlpha = alpha
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.closePath()
      ctx.fillStyle = "rgba(59,130,246,0.16)"
      ctx.fill()
      ctx.lineWidth = 3
      ctx.lineJoin = "round"
      ctx.strokeStyle = ACCENT
      ctx.stroke()
      for (const p of pts) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2)
        ctx.fillStyle = "#fff"
        ctx.fill()
        ctx.lineWidth = 2.5
        ctx.strokeStyle = ACCENT
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [screen])

  /* ------------------------------------------------------------------ */
  /* Capture                                                             */
  /* ------------------------------------------------------------------ */

  /** Grab the current frame at full resolution and JPEG-encode it. */
  const captureFrame = async (): Promise<{ blob: Blob; corners: Point[] | null } | null> => {
    const video = videoRef.current
    if (!video || video.readyState < 2 || video.videoWidth === 0 || capturingRef.current) return null
    capturingRef.current = true
    try {
      const canvas = frameCanvasRef.current ?? (frameCanvasRef.current = document.createElement("canvas"))
      if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth
      if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight
      const ctx = canvas.getContext("2d")
      if (!ctx) throw new Error("Could not create capture canvas")
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const corners = targetRef.current
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Frame encode failed"))), "image/jpeg", RAW_FRAME_JPEG_QUALITY),
      )
      return { blob, corners }
    } finally {
      capturingRef.current = false
    }
  }

  const playCaptureFeedback = () => {
    flashRef.current?.animate([{ opacity: 0.7 }, { opacity: 0 }], { duration: 220, easing: "ease-out" })
    shutterRef.current?.animate([{ transform: "scale(1)" }, { transform: "scale(0.9)" }, { transform: "scale(1)" }], {
      duration: 180,
      easing: "ease-out",
    })
    thumbRef.current?.animate([{ transform: "scale(1)" }, { transform: "scale(1.15)" }, { transform: "scale(1)" }], {
      duration: 280,
      easing: "ease-out",
    })
    navigator.vibrate?.(12)
  }

  /** Batch: dewarp + filter + store in the background; never blocks the shutter. */
  const enqueueBatchPage = (raw: Blob, corners: Point[] | null, pageFilter: ScanFilter) => {
    setPendingCount((n) => n + 1)
    // Every step is caught: a rejected link would skip all later pages.
    queueRef.current = queueRef.current.then(async () => {
      let bitmap: ImageBitmap | null = null
      try {
        try {
          // Re-detect on the full-resolution frame; live corners are only a fallback.
          const result = await documentProcessor.processFull(
            raw,
            undefined,
            pageFilter,
            MAGIC_COLOR_OPTIONS,
            BW_OPTIONS,
            corners ?? undefined,
          )
          bitmap = result.bitmap
        } catch (err) {
          console.warn("[Batch] processing failed, saving raw frame", err)
          bitmap = await createImageBitmap(raw)
        }
        await batch.addFromBitmap(bitmap)
      } catch (err) {
        console.error("[Batch] failed to save page", err)
        if (mountedRef.current) setNotice("A page couldn't be saved. Please capture it again.")
      } finally {
        bitmap?.close()
        if (mountedRef.current) setPendingCount((n) => n - 1)
      }
    })
  }

  const openCrop = (raw: Blob, corners: Point[] | null) => {
    const url = URL.createObjectURL(raw)
    cropSrcRef.current = url
    setCropSrc(url)
    setCropCorners(corners)
    setScreen("crop")
    // Refine on the captured photo itself; preview corners can lag the shutter.
    documentProcessor
      .detectCorners(raw)
      .then((found) => {
        if (found?.length === 4 && cropSrcRef.current === url) setCropCorners(found)
      })
      .catch((err) => console.warn("[Crop] detection on captured frame failed", err))
  }

  const handleShutter = async () => {
    if (screen !== "camera" || finishing) return
    const { mode: currentMode, filter: currentFilter } = settingsRef.current
    try {
      const frame = await captureFrame()
      if (!frame) return
      playCaptureFeedback()
      steadySinceRef.current = performance.now()
      if (currentMode === "batch") enqueueBatchPage(frame.blob, frame.corners, currentFilter)
      else openCrop(frame.blob, frame.corners)
    } catch (err) {
      console.error("[Capture] failed", err)
      setNotice("Couldn't take the photo. Try again.")
    }
  }
  handleShutterRef.current = handleShutter

  /* ------------------------------------------------------------------ */
  /* Single-page flow: crop -> review -> save                            */
  /* ------------------------------------------------------------------ */

  const closeFlow = () => {
    if (cropSrcRef.current) URL.revokeObjectURL(cropSrcRef.current)
    cropSrcRef.current = null
    setCropSrc(null)
    setCropCorners(null)
    reviewPageRef.current?.close()
    setReviewPage(null)
    setScreen("camera")
  }

  const handleCropComplete = (page: ImageBitmap, corners: Point[]) => {
    // Remember the user's corners so "back to crop" restores them.
    setCropCorners(corners)
    reviewPageRef.current?.close()
    setReviewPage(page)
    setScreen("review")
  }

  const backToCrop = () => {
    reviewPageRef.current?.close()
    setReviewPage(null)
    setScreen("crop")
  }

  /** Move a capture session into the library (new document or the one being extended) and open it. */
  const saveSessionToLibrary = async (sessionId: string, source: typeof batch) => {
    let docId = targetDocId
    if (docId) await appendSessionToDocument(sessionId, docId)
    else docId = (await createDocumentFromSession(sessionId)).id
    source.forget()
    scheduleBackup()
    router.replace(`/doc?id=${encodeURIComponent(docId)}`)
  }

  const handleReviewSave = async (chosen: ScanFilter) => {
    const page = reviewPageRef.current
    if (!page || saving) return
    setSaving(true)
    let out: ImageBitmap | null = null
    try {
      try {
        out = await renderFiltered(page, chosen)
      } catch (err) {
        console.warn("[Save] filter failed, saving unfiltered", err)
        out = await createImageBitmap(page)
      }
      await single.clear()
      await single.addFromBitmap(out)
      await saveSessionToLibrary("single", single)
    } catch (err) {
      console.error("[Save] failed", err)
      setNotice("Couldn't save this page. Check free storage and try again.")
      setSaving(false)
    } finally {
      out?.close()
    }
  }

  /* ------------------------------------------------------------------ */
  /* Batch finish                                                        */
  /* ------------------------------------------------------------------ */

  const handleBatchFinish = async () => {
    setFinishing(true)
    try {
      await queueRef.current.catch(() => {})
      await saveSessionToLibrary("current", batch)
    } catch (err) {
      console.error("[Batch] save failed", err)
      setNotice("Couldn't save these pages. Check free storage and try again.")
      setFinishing(false)
    }
  }

  /* ------------------------------------------------------------------ */
  /* UI                                                                  */
  /* ------------------------------------------------------------------ */

  const batchCount = batch.pages.length + pendingCount
  const batchPreview = batch.pages.at(-1)?.thumbUrl ?? null

  const hint = !cameraActive
    ? "Starting camera…"
    : finishing
      ? "Saving pages…"
      : !detected
        ? "Point the camera at a document"
        : autoCapture
          ? steady
            ? "Hold still…"
            : "Hold steady to capture"
          : "Tap to capture"

  return (
    <main className="fixed inset-0 flex select-none flex-col bg-black text-white">
      {/* Top bar */}
      <header
        className="relative z-10 flex shrink-0 items-center justify-between px-2 pb-2"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <Link
          href={returnHref}
          aria-label="Close camera"
          className="flex size-11 items-center justify-center rounded-full active:bg-white/10"
        >
          <X className="size-6" />
        </Link>

        <div className="flex items-center gap-1">
          {mode === "batch" ? (
            <button
              type="button"
              onClick={() => setFilter((f) => FILTER_CYCLE[(FILTER_CYCLE.indexOf(f) + 1) % FILTER_CYCLE.length])}
              aria-label={`Filter: ${FILTER_LABELS[filter]}. Tap to change.`}
              className="flex h-9 items-center gap-1.5 rounded-full bg-white/10 px-3 text-xs font-semibold active:bg-white/20"
            >
              <Sparkles className="size-3.5" />
              {FILTER_LABELS[filter]}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setAutoCapture((v) => !v)}
            aria-pressed={autoCapture}
            className={cn(
              "flex h-9 items-center rounded-full px-3 text-xs font-semibold transition-colors",
              autoCapture ? "bg-primary text-primary-foreground" : "bg-white/10 text-white active:bg-white/20",
            )}
          >
            Auto
          </button>
          {hasTorch ? (
            <button
              type="button"
              onClick={toggleTorch}
              aria-label={torchEnabled ? "Turn flash off" : "Turn flash on"}
              aria-pressed={torchEnabled}
              className={cn(
                "flex size-11 items-center justify-center rounded-full active:bg-white/10",
                torchEnabled && "text-amber-300",
              )}
            >
              {torchEnabled ? <Zap className="size-5" fill="currentColor" /> : <ZapOff className="size-5" />}
            </button>
          ) : null}
        </div>
      </header>

      {/* Viewfinder: the whole camera frame is visible (no zoom-to-fill crop), so what you see is what you get. */}
      <div ref={previewRef} className="relative min-h-0 flex-1 overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className={cn("absolute inset-0 h-full w-full object-contain transition-opacity duration-300", cameraActive ? "opacity-100" : "opacity-0")}
        />
        <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />
        <div ref={flashRef} className="pointer-events-none absolute inset-0 bg-white opacity-0" />

        {!cameraActive && !cameraError ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-7 animate-spin text-white/50" />
          </div>
        ) : null}

        {cameraError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-white/10">
              <Camera className="size-7 text-white/80" />
            </span>
            <p className="max-w-xs text-sm text-white/85">{cameraError}</p>
            <button
              type="button"
              onClick={startCamera}
              className="flex h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-black active:opacity-90"
            >
              <RefreshCw className="size-4" />
              Try again
            </button>
          </div>
        ) : null}

      </div>

      {/* Controls */}
      <div className="shrink-0 px-5 pt-3" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
        <p aria-live="polite" className="mb-3 h-5 text-center text-[13px] font-medium text-white/80">
          {hint}
        </p>

        <div role="radiogroup" aria-label="Scan mode" className="mb-4 flex justify-center gap-6">
          {(["single", "batch"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => setMode(value)}
              disabled={mode === "batch" && batchCount > 0 && value === "single"}
              className={cn(
                "relative pb-1.5 text-xs font-bold uppercase tracking-[0.12em] transition-colors disabled:opacity-30",
                mode === value ? "text-white" : "text-white/45",
              )}
            >
              {value}
              <span
                className={cn(
                  "absolute inset-x-0 -bottom-0.5 mx-auto size-1 rounded-full bg-primary transition-opacity",
                  mode === value ? "opacity-100" : "opacity-0",
                )}
              />
            </button>
          ))}
        </div>

        <div className="mx-auto grid max-w-sm grid-cols-3 items-center">
          {/* Left: batch tray */}
          <div className="flex justify-start">
            {mode === "batch" && batchCount > 0 ? (
              <div ref={thumbRef} className="relative size-14">
                <div className="size-full overflow-hidden rounded-lg border-2 border-white/80 bg-white/10">
                  {batchPreview ? (
                    <img src={batchPreview} alt="Last page" className="size-full object-cover" />
                  ) : (
                    <div className="flex size-full items-center justify-center">
                      <Loader2 className="size-5 animate-spin text-white/70" />
                    </div>
                  )}
                </div>
                <span className="absolute -right-2 -top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold tabular-nums text-primary-foreground">
                  {batchCount}
                </span>
                {pendingCount > 0 ? (
                  <Loader2 className="absolute -bottom-1.5 -right-1.5 size-4 animate-spin rounded-full bg-black text-white" />
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Center: shutter with auto-capture progress ring */}
          <div className="flex justify-center">
            <button
              ref={shutterRef}
              type="button"
              disabled={!cameraActive || screen !== "camera" || finishing}
              onClick={handleShutter}
              aria-label={mode === "batch" ? "Capture page" : "Capture document"}
              className="relative flex size-[84px] items-center justify-center disabled:opacity-40"
            >
              <svg viewBox="0 0 84 84" className="absolute inset-0 -rotate-90">
                <circle cx="42" cy="42" r="38" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="4" />
                <circle
                  ref={progressRef}
                  cx="42"
                  cy="42"
                  r="38"
                  fill="none"
                  stroke={ACCENT}
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 38}
                  strokeDashoffset={2 * Math.PI * 38}
                />
              </svg>
              <span
                className={cn(
                  "size-[66px] rounded-full transition-colors duration-200 active:scale-95",
                  detected ? "bg-white" : "bg-white/85",
                )}
              />
            </button>
          </div>

          {/* Right: finish batch */}
          <div className="flex justify-end">
            {mode === "batch" && batchCount > 0 ? (
              <button
                type="button"
                onClick={handleBatchFinish}
                disabled={finishing}
                className="flex h-11 items-center gap-1.5 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground active:opacity-90 disabled:opacity-60"
              >
                {finishing ? <Loader2 className="size-4 animate-spin" /> : null}
                Save
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Single-page flow overlays */}
      {screen === "crop" && cropSrc ? (
        <div className="absolute inset-0 z-20">
          <CropView src={cropSrc} initialCorners={cropCorners} onCropComplete={handleCropComplete} onCancel={closeFlow} />
        </div>
      ) : null}
      {screen === "review" && reviewPage ? (
        <div className="absolute inset-0 z-20">
          <FilterReview page={reviewPage} initialFilter={filter} saving={saving} onBack={backToCrop} onSave={handleReviewSave} />
        </div>
      ) : null}

      {notice ? (
        <div
          role="alert"
          className="pointer-events-none absolute inset-x-4 z-30 mx-auto max-w-sm rounded-xl bg-rose-600 px-4 py-2.5 text-center text-sm font-medium text-white shadow-lg"
          style={{ top: "calc(max(0.5rem, env(safe-area-inset-top)) + 3.5rem)" }}
        >
          {notice}
        </div>
      ) : null}
    </main>
  )
}
