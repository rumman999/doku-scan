"use client"

import React, { useState, useEffect, useRef, useCallback } from "react"
import Link from "next/link"
import { ArrowLeft, Camera, RefreshCw, Sparkles, Zap, ZapOff, ChevronRight, Loader2 } from "lucide-react"
import { Capacitor } from "@capacitor/core"
import { Camera as CameraPlugin } from "@capacitor/camera"
import { Button } from "@/components/ui/button"
import { CropView } from "@/components/crop-view"
import { PdfExportSheet } from "@/components/pdf-export-sheet"
import { useScanBatch } from "@/hooks/use-scan-batch"
import { cn } from "@/lib/utils"
import { documentProcessor } from "@/lib/cv/processor-client"
import { Point } from "@/lib/cv/document-processor"

type ScanMode = "single" | "batch"
type FilterMode = "magic-color" | "bw" | "none"
type Screen = "camera" | "crop" | "saving"

const MAGIC_COLOR_OPTIONS = { unsharpStrength: 0.6, saturationBoost: 1.25 }
const BW_OPTIONS = { method: "adaptive-gaussian" as const, blockSize: 21, cConstant: 10 }
const RAW_FRAME_JPEG_QUALITY = 0.95
/** Consecutive steady detections needed before auto-capture fires (~1.5s at 500ms polling). */
const AUTO_CAPTURE_STEADY_FRAMES = 3
/** Max corner drift between polls, as a fraction of the frame's long side, to count as "steady". */
const STEADY_TOLERANCE = 0.02

/**
 * Apply the selected enhancement filter to an already-cropped page.
 * Takes ownership of `page`: it is either returned or closed.
 */
async function applyFilter(page: ImageBitmap, filter: FilterMode): Promise<ImageBitmap> {
  if (filter === "none") return page
  try {
    // The worker call transfers (detaches) its input, so send a copy and keep
    // the original as a fallback if filtering fails.
    const copy = await createImageBitmap(page)
    const filtered =
      filter === "magic-color"
        ? await documentProcessor.magicColor(copy, MAGIC_COLOR_OPTIONS)
        : await documentProcessor.applyBw(copy, BW_OPTIONS)
    page.close()
    return filtered
  } catch (err) {
    console.warn("[Filter] failed, keeping unfiltered page", err)
    return page
  }
}

/** True when every corner moved less than `tolerance` pixels since the previous detection. */
function cornersSteady(prev: Point[] | null, next: Point[], tolerance: number): boolean {
  if (!prev || prev.length !== 4) return false
  return next.every((p, i) => Math.hypot(p.x - prev[i].x, p.y - prev[i].y) <= tolerance)
}

export default function ScanPage() {
  // Video and Canvas Refs
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null)
  /** Reused full-resolution canvas for shutter captures. */
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const flashRef = useRef<HTMLDivElement | null>(null)
  const badgeRef = useRef<HTMLDivElement | null>(null)

  // Stream & Hardware State
  const streamRef = useRef<MediaStream | null>(null)
  const [cameraActive, setCameraActive] = useState<boolean>(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const mountedRef = useRef<boolean>(true)
  /** Bumped on every (re)start/stop so a slow getUserMedia from an older attempt is discarded. */
  const cameraAttemptRef = useRef<number>(0)
  const [torchEnabled, setTorchEnabled] = useState<boolean>(false)
  const [hasTorch, setHasTorch] = useState<boolean>(false)

  // CV Detection & Overlay State
  const [detectedCorners, setDetectedCorners] = useState<Point[] | null>(null)
  const [autoCapture, setAutoCapture] = useState<boolean>(false)
  const [filterMode, setFilterMode] = useState<FilterMode>("magic-color")
  const [mode, setMode] = useState<ScanMode>("single")

  // Flow State
  const [screen, setScreen] = useState<Screen>("camera")
  const [cropSrc, setCropSrc] = useState<string | null>(null)
  const [cropCorners, setCropCorners] = useState<Point[] | null>(null)
  const [exportTarget, setExportTarget] = useState<ScanMode | null>(null)

  // Full-res pages live in IndexedDB; only thumbnail URLs are held in memory.
  // Single-mode scans get their own session so they never mix with a batch.
  const batch = useScanBatch("current")
  const single = useScanBatch("single")

  // Batch capture queue: frames are JPEG-encoded at the shutter (≈2MB each,
  // instead of a 32MB RGBA bitmap) and processed serially in the background.
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const [pendingCount, setPendingCount] = useState<number>(0)
  const capturingRef = useRef<boolean>(false)
  const [finishing, setFinishing] = useState<boolean>(false)

  // Auto-capture bookkeeping
  const steadyCountRef = useRef<number>(0)
  const lastCornersRef = useRef<Point[] | null>(null)
  /** Disarmed after an auto-capture until the document leaves the frame. */
  const autoArmedRef = useRef<boolean>(true)

  // Latest values for use inside the polling interval
  const settingsRef = useRef({ mode, filterMode, autoCapture })
  settingsRef.current = { mode, filterMode, autoCapture }

  const detectionPaused = screen !== "camera" || exportTarget !== null

  /**
   * Request native permission (Capacitor), then open the rear camera stream.
   */
  const stopCamera = useCallback(() => {
    cameraAttemptRef.current++
    streamRef.current?.getTracks().forEach((track) => track.stop())
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
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      setTorchEnabled(false)

      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError("This device or browser doesn't support camera access.")
        setCameraActive(false)
        return
      }

      // Inside the Android/iOS app the WebView can only open the camera once
      // the OS-level permission is granted. (The plugin's web implementation
      // throws "Not implemented", and browsers prompt via getUserMedia anyway.)
      if (Capacitor.isNativePlatform()) {
        const { camera } = await CameraPlugin.requestPermissions({ permissions: ["camera"] })
        if (stale()) return
        if (camera !== "granted") {
          setCameraError(
            "Camera permission denied. Enable camera access for DokuScan in your device's app settings.",
          )
          setCameraActive(false)
          return
        }
      }

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "environment",
          width: { ideal: 4096 },
          height: { ideal: 2160 },
        },
      })
      // Unmounted or restarted while the permission prompt / camera startup was pending:
      // release this stream, otherwise the camera (and its indicator light) stays on.
      if (stale()) {
        mediaStream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = mediaStream

      const videoTrack = mediaStream.getVideoTracks()[0]
      if (videoTrack) {
        const capabilities = (videoTrack.getCapabilities?.() as any) || {}
        setHasTorch(Boolean(capabilities.torch))
        // Best effort: continuous autofocus where the device exposes it.
        if (capabilities.focusMode?.includes?.("continuous")) {
          videoTrack
            .applyConstraints({ advanced: [{ focusMode: "continuous" } as any] })
            .catch(() => {})
        }
      }

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream
        await videoRef.current.play()
        if (stale()) return
        setCameraActive(true)
      }
    } catch (err: any) {
      if (stale()) return
      // play() rejects with AbortError when a newer start replaces the source; not a failure.
      if (err?.name === "AbortError") return
      console.error("[Camera Access Error]", err)
      setCameraError(
        err?.name === "NotAllowedError" || err?.name === "SecurityError"
          ? "Camera permission denied. Please allow camera access in your browser settings."
          : err?.name === "NotReadableError"
            ? "The camera is being used by another app. Close it and try again."
            : err?.name === "NotFoundError" || err?.name === "OverconstrainedError"
              ? "No usable camera was found on this device."
              : "Unable to start camera. Please ensure camera hardware is connected.",
      )
      setCameraActive(false)
    }
  }, [])

  // Toggle Torch / Flashlight on mobile devices
  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try {
      const nextState = !torchEnabled
      await track.applyConstraints({ advanced: [{ torch: nextState } as any] })
      setTorchEnabled(nextState)
    } catch (e) {
      console.warn("Torch constraint not supported on this device", e)
    }
  }

  // Lifecycle: start camera + worker on mount, always release the camera on unmount
  useEffect(() => {
    mountedRef.current = true
    startCamera()
    documentProcessor.init().catch(console.error)
    return () => {
      mountedRef.current = false
      stopCamera()
    }
  }, [startCamera, stopCamera])

  // Release the camera while the app is in the background (saves battery, lets
  // other apps use it, and avoids a frozen preview on resume), then reopen it.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stopCamera()
      else if (!streamRef.current) startCamera()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => document.removeEventListener("visibilitychange", onVisibility)
  }, [startCamera, stopCamera])

  // Auto-dismiss transient notices.
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  /**
   * Grab the current video frame at full resolution and JPEG-encode it.
   * Returns null if a previous capture is still encoding or the video isn't ready.
   */
  const captureFrame = async (): Promise<{ blob: Blob; corners: Point[] | null } | null> => {
    const video = videoRef.current
    if (!video || video.readyState < 2 || video.videoWidth === 0 || capturingRef.current) return null
    capturingRef.current = true
    try {
      const canvas = frameCanvasRef.current ?? (frameCanvasRef.current = document.createElement("canvas"))
      if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth
      if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight
      const ctx = canvas.getContext("2d")
      if (!ctx) throw new Error("Could not create capture canvas 2D context")
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

      // Corners are in video pixel space, which matches the captured frame.
      const corners = lastCornersRef.current
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Frame encode failed"))),
          "image/jpeg",
          RAW_FRAME_JPEG_QUALITY,
        ),
      )
      return { blob, corners }
    } finally {
      capturingRef.current = false
    }
  }

  const playCaptureFeedback = () => {
    flashRef.current?.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 260, easing: "ease-out" })
    badgeRef.current?.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.18)" }, { transform: "scale(1)" }],
      { duration: 300, easing: "ease-out" },
    )
    navigator.vibrate?.(15)
  }

  /** Batch: enqueue dewarp + filter + IndexedDB write; never blocks the shutter. */
  const enqueueBatchPage = (raw: Blob, corners: Point[] | null, filter: FilterMode) => {
    setPendingCount((n) => n + 1)
    // Every step is caught: a rejected link would silently skip all later pages
    // in the chain and leave "Next" waiting on a failed promise.
    queueRef.current = queueRef.current.then(async () => {
      let bitmap: ImageBitmap | null = null
      try {
        try {
          // Detect on the full-resolution capture; the live-preview corners are
          // only a fallback because they can lag the shutter by up to ~500ms.
          const result = await documentProcessor.processFull(
            raw,
            undefined,
            filter,
            MAGIC_COLOR_OPTIONS,
            BW_OPTIONS,
            corners ?? undefined,
          )
          bitmap = result.bitmap
        } catch (err) {
          // Keep the page rather than lose it; it can still be exported as-is.
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

  const cropSrcRef = useRef<string | null>(null)
  cropSrcRef.current = cropSrc

  // Release the captured photo's object URL if the page unmounts mid-crop.
  useEffect(
    () => () => {
      if (cropSrcRef.current) URL.revokeObjectURL(cropSrcRef.current)
    },
    [],
  )

  /** Single: hand the frame to the crop screen. */
  const openCrop = (raw: Blob, corners: Point[] | null) => {
    const url = URL.createObjectURL(raw)
    cropSrcRef.current = url
    setCropSrc(url)
    setCropCorners(corners)
    setScreen("crop")
    // Refine on the captured photo itself; the preview corners may be stale.
    documentProcessor
      .detectCorners(raw)
      .then((detected) => {
        if (!detected || detected.length !== 4 || cropSrcRef.current !== url) return
        setCropCorners(detected)
      })
      .catch((err) => console.warn("[Crop] detection on captured frame failed", err))
  }

  const handleShutter = async () => {
    if (screen !== "camera") return
    const { mode: currentMode, filterMode: currentFilter } = settingsRef.current
    try {
      const frame = await captureFrame()
      if (!frame) return
      steadyCountRef.current = 0
      if (currentMode === "batch") {
        playCaptureFeedback()
        enqueueBatchPage(frame.blob, frame.corners, currentFilter)
      } else {
        openCrop(frame.blob, frame.corners)
      }
    } catch (err) {
      console.error("[Capture Error]", err)
    }
  }
  const handleShutterRef = useRef(handleShutter)
  handleShutterRef.current = handleShutter

  const closeCrop = () => {
    if (cropSrc) URL.revokeObjectURL(cropSrc)
    cropSrcRef.current = null
    setCropSrc(null)
    setCropCorners(null)
    setScreen("camera")
  }

  /** Single-mode crop confirmed: filter, persist, and go to export. Takes ownership of `page`. */
  const handleCropComplete = async (page: ImageBitmap) => {
    setScreen("saving")
    let bitmap: ImageBitmap | null = page
    try {
      bitmap = await applyFilter(page, settingsRef.current.filterMode)
      await single.clear()
      await single.addFromBitmap(bitmap)
      closeCrop()
      setExportTarget("single")
    } catch (err) {
      console.error("[Single Save Error]", err)
      // Stay on the crop screen so the user can retry instead of losing the shot.
      setScreen("crop")
      setNotice("Couldn't save this page. Check free storage and try again.")
    } finally {
      bitmap?.close()
    }
  }

  /** Batch finish: wait for queued pages to land in IndexedDB, then export. */
  const handleBatchFinish = async () => {
    setFinishing(true)
    try {
      await queueRef.current.catch(() => {})
      setExportTarget("batch")
    } finally {
      setFinishing(false)
    }
  }

  /**
   * Continuous 500ms polling detection loop.
   * Samples a scaled low-resolution frame (max 640px) to feed the Web Worker.
   */
  useEffect(() => {
    if (!cameraActive || detectionPaused) {
      // Don't leave a stale outline (or a primed auto-capture) behind.
      setDetectedCorners(null)
      lastCornersRef.current = null
      steadyCountRef.current = 0
      return
    }

    let busy = false
    let stopped = false
    const interval = setInterval(async () => {
      const video = videoRef.current
      if (busy || stopped || !video || video.readyState < 2 || video.videoWidth === 0) return
      busy = true
      try {
        const canvas = sampleCanvasRef.current ?? (sampleCanvasRef.current = document.createElement("canvas"))
        const scale = Math.min(640 / video.videoWidth, 1.0)
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        const ctx = canvas.getContext("2d", { willReadFrequently: true })
        if (!ctx) return
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const sampleBitmap = await createImageBitmap(canvas)

        const corners = await documentProcessor.detectCorners(sampleBitmap, {
          blurKernelSize: 5,
          cannyThreshold1: 30,
          cannyThreshold2: 150,
          epsilonFactor: 0.02,
        })
        if (stopped) return

        if (corners && corners.length === 4) {
          // Rescale corners back to video stream native coordinate space
          const fullCorners: Point[] = corners.map((p) => ({ x: p.x / scale, y: p.y / scale }))
          const tolerance = Math.max(video.videoWidth, video.videoHeight) * STEADY_TOLERANCE
          // Only count frames where the page hasn't moved; otherwise auto-capture
          // fires mid-motion and produces blurry, mis-cropped pages.
          steadyCountRef.current = cornersSteady(lastCornersRef.current, fullCorners, tolerance)
            ? steadyCountRef.current + 1
            : 1
          setDetectedCorners(fullCorners)
          lastCornersRef.current = fullCorners

          if (
            settingsRef.current.autoCapture &&
            autoArmedRef.current &&
            steadyCountRef.current >= AUTO_CAPTURE_STEADY_FRAMES
          ) {
            autoArmedRef.current = false
            handleShutterRef.current()
          }
        } else {
          setDetectedCorners(null)
          lastCornersRef.current = null
          steadyCountRef.current = 0
          autoArmedRef.current = true // page removed/changed: allow next auto-capture
        }
      } catch (err) {
        console.error("[Corner Detection Loop Error]", err)
      } finally {
        busy = false
      }
    }, 500)

    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [cameraActive, detectionPaused])

  /**
   * Draw the dynamic real-time polygon overlay matched to the viewport video display.
   */
  const [viewport, setViewport] = useState(0)
  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  useEffect(() => {
    const canvas = overlayCanvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Back the canvas at device resolution so the outline is crisp on phones.
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(rect.width * dpr)
    canvas.height = Math.round(rect.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)

    if (!detectedCorners || detectedCorners.length !== 4 || detectionPaused) return

    // object-fit: cover mapping from video pixels to viewport (CSS) pixels
    const videoW = video.videoWidth || 1920
    const videoH = video.videoHeight || 1080
    const scale = Math.max(rect.width / videoW, rect.height / videoH)
    const offsetX = (rect.width - videoW * scale) / 2
    const offsetY = (rect.height - videoH * scale) / 2
    const viewPoints = detectedCorners.map((p) => ({ x: p.x * scale + offsetX, y: p.y * scale + offsetY }))

    ctx.save()
    ctx.beginPath()
    ctx.moveTo(viewPoints[0].x, viewPoints[0].y)
    for (let i = 1; i < 4; i++) ctx.lineTo(viewPoints[i].x, viewPoints[i].y)
    ctx.closePath()
    ctx.fillStyle = "rgba(45, 212, 191, 0.18)"
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = "#2dd4bf"
    ctx.shadowColor = "#14b8a6"
    ctx.shadowBlur = 12
    ctx.stroke()

    viewPoints.forEach((pt) => {
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 7, 0, Math.PI * 2)
      ctx.fillStyle = "#ffffff"
      ctx.shadowColor = "#2dd4bf"
      ctx.shadowBlur = 8
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = "#0d9488"
      ctx.stroke()
    })
    ctx.restore()
  }, [detectedCorners, detectionPaused, viewport])

  const batchCount = batch.pages.length + pendingCount
  const batchPreview = batch.pages.at(-1)?.thumbUrl ?? null
  const exportBatch = exportTarget === "single" ? single : batch

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-black text-white select-none">
      {/* Full-screen live viewfinder */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className="absolute inset-0 h-full w-full object-cover"
      />
      <canvas ref={overlayCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* Capture flash (animated via WAAPI on each batch shot) */}
      <div ref={flashRef} className="pointer-events-none absolute inset-0 z-30 bg-white opacity-0" />

      {cameraError ? (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black p-6 text-center">
          <Camera className="mb-4 size-12 animate-pulse text-rose-500" />
          <p className="mb-4 max-w-xs text-sm font-medium text-white">{cameraError}</p>
          <Button onClick={startCamera} variant="secondary" className="rounded-full">
            <RefreshCw className="mr-2 size-4" /> Try Again
          </Button>
        </div>
      ) : null}

      {/* Top Control Bar */}
      <header
        className="absolute inset-x-0 top-0 z-20 flex items-center justify-between bg-gradient-to-b from-black/75 via-black/30 to-transparent px-4 pb-6"
        style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}
      >
        <Button
          variant="ghost"
          size="icon"
          className="size-10 rounded-full bg-black/40 text-white backdrop-blur-md hover:bg-black/60"
          aria-label="Back"
          nativeButton={false}
          render={
            <Link href="/">
              <ArrowLeft className="size-5" />
            </Link>
          }
        />

        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-full border border-white/10 bg-black/50 p-1 text-xs font-medium backdrop-blur-md">
            {(
              [
                ["magic-color", "Magic Color"],
                ["bw", "B&W"],
                ["none", "Original"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilterMode(value)}
                aria-pressed={filterMode === value}
                className={cn(
                  "rounded-full px-3 py-1 transition-all",
                  filterMode === value
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-white/70 hover:text-white",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {hasTorch && (
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTorch}
              aria-label={torchEnabled ? "Turn torch off" : "Turn torch on"}
              className={cn(
                "size-10 rounded-full bg-black/40 backdrop-blur-md hover:bg-black/60",
                torchEnabled ? "text-amber-400" : "text-white",
              )}
            >
              {torchEnabled ? <Zap className="size-5" /> : <ZapOff className="size-5" />}
            </Button>
          )}
        </div>
      </header>

      {/* Live Detection Guidance Badge */}
      <div className="pointer-events-none absolute inset-x-0 top-24 z-10 flex justify-center">
        <div
          className={cn(
            "flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold backdrop-blur-md transition-all",
            detectedCorners
              ? "border-emerald-500/40 bg-emerald-500/20 text-emerald-300 shadow-lg shadow-emerald-500/10"
              : "border-white/10 bg-black/40 text-white/70",
          )}
        >
          <Sparkles className="size-3.5" />
          {detectedCorners ? "Document Detected" : "Align Document in Frame"}
        </div>
      </div>

      {/* Bottom controls, layered over the video */}
      <div
        className="absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-4 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-6 pt-10"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-center gap-2">
          {/* Single / Batch mode toggle */}
          <div
            role="radiogroup"
            aria-label="Scan mode"
            className="flex items-center rounded-full border border-white/15 bg-black/50 p-1 text-xs font-semibold backdrop-blur-md"
          >
            {(["single", "batch"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                onClick={() => setMode(value)}
                className={cn(
                  "rounded-full px-4 py-1.5 capitalize transition-all",
                  mode === value ? "bg-white text-black shadow-sm" : "text-white/70 hover:text-white",
                )}
              >
                {value}
              </button>
            ))}
          </div>

          {/* Auto-capture toggle */}
          <button
            type="button"
            onClick={() => setAutoCapture((prev) => !prev)}
            aria-pressed={autoCapture}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold backdrop-blur-md transition-all",
              autoCapture
                ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20"
                : "border-white/15 bg-black/50 text-white/80 hover:bg-black/70",
            )}
          >
            <span className={cn("size-2 rounded-full", autoCapture ? "animate-pulse bg-white" : "bg-white/40")} />
            Auto
          </button>
        </div>

        <div className="grid w-full max-w-sm grid-cols-3 items-center">
          {/* Left: batch thumbnail + counter badge */}
          <div className="flex justify-start">
            {mode === "batch" && batchCount > 0 ? (
              <div ref={badgeRef} className="relative size-14">
                <div className="size-full overflow-hidden rounded-xl border-2 border-white/40 bg-white/10 shadow-md">
                  {batchPreview ? (
                    <img src={batchPreview} alt="Last scanned page" className="size-full object-cover" />
                  ) : (
                    <div className="flex size-full items-center justify-center">
                      <Loader2 className="size-5 animate-spin text-white/70" />
                    </div>
                  )}
                </div>
                <span className="absolute -right-2 -top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold tabular-nums text-primary-foreground shadow">
                  {batchCount}
                </span>
                {pendingCount > 0 ? (
                  <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-1.5 text-[10px] font-medium text-white/80">
                    saving
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Center: shutter */}
          <div className="flex justify-center">
            <button
              type="button"
              disabled={!cameraActive || screen !== "camera"}
              onClick={handleShutter}
              className="group relative flex size-20 items-center justify-center rounded-full border-4 border-white/85 p-1 shadow-2xl backdrop-blur-md transition-transform active:scale-95 disabled:pointer-events-none disabled:opacity-50"
              aria-label={mode === "batch" ? "Capture page" : "Capture document"}
            >
              <span
                className={cn(
                  "size-full rounded-full transition-all duration-200 group-active:scale-90",
                  detectedCorners ? "bg-primary shadow-lg shadow-primary/40" : "bg-white",
                )}
              />
            </button>
          </div>

          {/* Right: batch finish */}
          <div className="flex justify-end">
            {mode === "batch" && batchCount > 0 ? (
              <Button
                onClick={handleBatchFinish}
                disabled={finishing}
                className="h-11 gap-1 rounded-full bg-emerald-500 px-4 font-semibold text-white shadow-xl shadow-emerald-500/30 hover:bg-emerald-600"
              >
                {finishing ? <Loader2 className="size-4 animate-spin" /> : null}
                Next
                {!finishing ? <ChevronRight className="size-4" /> : null}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Single mode: crop screen */}
      {screen !== "camera" && cropSrc ? (
        <div className="absolute inset-0 z-40 bg-black">
          <CropView
            src={cropSrc}
            initialCorners={cropCorners}
            onCropComplete={handleCropComplete}
            onCancel={closeCrop}
          />
          {screen === "saving" ? (
            <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm">
              <Loader2 className="size-8 animate-spin text-primary" />
              <p className="text-sm font-medium text-white/80">Enhancing page…</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <div
          role="alert"
          className="pointer-events-none absolute inset-x-4 top-36 z-[60] mx-auto max-w-sm rounded-xl bg-rose-600/90 px-4 py-2.5 text-center text-sm font-medium text-white shadow-lg"
        >
          {notice}
        </div>
      ) : null}

      <PdfExportSheet
        open={exportTarget !== null}
        onClose={() => setExportTarget(null)}
        pages={exportBatch.pages}
        onReorder={exportBatch.reorder}
        onRemove={exportBatch.remove}
        onExported={(result) => {
          // A delivered batch is finished: start the next scan with an empty
          // tray instead of silently mixing old pages into the next document.
          if (result !== "cancelled" && exportTarget === "batch") {
            batch.clear().catch((err) => console.error("[Batch] clear after export failed", err))
          }
        }}
      />
    </main>
  )
}
