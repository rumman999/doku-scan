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

/** Apply the selected enhancement filter to an already-cropped page. */
async function applyFilter(source: Blob, filter: FilterMode): Promise<ImageBitmap> {
  try {
    if (filter === "magic-color") return await documentProcessor.magicColor(source, MAGIC_COLOR_OPTIONS)
    if (filter === "bw") return await documentProcessor.applyBw(source, BW_OPTIONS)
  } catch (err) {
    console.warn("[Filter] failed, keeping unfiltered page", err)
  }
  return createImageBitmap(source)
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
  const startCamera = useCallback(async () => {
    try {
      setCameraError(null)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null

      // Inside the Android/iOS app the WebView can only open the camera once
      // the OS-level permission is granted. (The plugin's web implementation
      // throws "Not implemented", and browsers prompt via getUserMedia anyway.)
      if (Capacitor.isNativePlatform()) {
        const { camera } = await CameraPlugin.requestPermissions({ permissions: ["camera"] })
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
        setCameraActive(true)
      }
    } catch (err: any) {
      console.error("[Camera Access Error]", err)
      setCameraError(
        err?.name === "NotAllowedError"
          ? "Camera permission denied. Please allow camera access in your browser settings."
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
    startCamera()
    documentProcessor.init().catch(console.error)
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [startCamera])

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
    queueRef.current = queueRef.current.then(async () => {
      let bitmap: ImageBitmap
      try {
        const result = await documentProcessor.processFull(
          raw,
          corners ?? undefined,
          filter,
          MAGIC_COLOR_OPTIONS,
          BW_OPTIONS,
        )
        bitmap = result.bitmap
      } catch (err) {
        // Keep the page rather than lose it; it can still be exported as-is.
        console.warn("[Batch] processing failed, saving raw frame", err)
        bitmap = await createImageBitmap(raw)
      }
      try {
        await batch.addFromBitmap(bitmap)
      } catch (err) {
        console.error("[Batch] failed to save page", err)
      } finally {
        bitmap.close()
        setPendingCount((n) => n - 1)
      }
    })
  }

  /** Single: hand the frame to the crop screen. */
  const openCrop = (raw: Blob, corners: Point[] | null) => {
    setCropSrc(URL.createObjectURL(raw))
    setCropCorners(corners)
    setScreen("crop")
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
    setCropSrc(null)
    setCropCorners(null)
    setScreen("camera")
  }

  /** Single-mode crop confirmed: filter, persist, and go to export. */
  const handleCropComplete = async (dataUrl: string) => {
    setScreen("saving")
    try {
      const cropped = await (await fetch(dataUrl)).blob()
      const bitmap = await applyFilter(cropped, settingsRef.current.filterMode)
      try {
        await single.clear()
        await single.addFromBitmap(bitmap)
      } finally {
        bitmap.close()
      }
      closeCrop()
      setExportTarget("single")
    } catch (err) {
      console.error("[Single Save Error]", err)
      closeCrop()
    }
  }

  /** Batch finish: wait for queued pages to land in IndexedDB, then export. */
  const handleBatchFinish = async () => {
    setFinishing(true)
    try {
      await queueRef.current
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
    if (!cameraActive || detectionPaused) return

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
          setDetectedCorners(fullCorners)
          lastCornersRef.current = fullCorners

          steadyCountRef.current += 1
          if (settingsRef.current.autoCapture && autoArmedRef.current && steadyCountRef.current >= 3) {
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
  useEffect(() => {
    const canvas = overlayCanvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width
    canvas.height = rect.height
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    if (!detectedCorners || detectedCorners.length !== 4 || detectionPaused) return

    // object-fit: cover mapping from video pixels to viewport pixels
    const videoW = video.videoWidth || 1920
    const videoH = video.videoHeight || 1080
    const scale = Math.max(canvas.width / videoW, canvas.height / videoH)
    const offsetX = (canvas.width - videoW * scale) / 2
    const offsetY = (canvas.height - videoH * scale) / 2
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
  }, [detectedCorners, detectionPaused])

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

      <PdfExportSheet
        open={exportTarget !== null}
        onClose={() => setExportTarget(null)}
        pages={exportBatch.pages}
        onReorder={exportBatch.reorder}
        onRemove={exportBatch.remove}
      />
    </main>
  )
}
