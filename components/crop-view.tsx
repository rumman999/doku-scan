"use client"

import React, { useRef, useState, useEffect, useCallback } from "react"
import { Check, RotateCcw, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Point } from "@/lib/cv/document-processor"
import { documentProcessor } from "@/lib/cv/processor-client"

interface CropViewProps {
  src: string
  initialCorners?: Point[] | null
  onCropComplete: (base64: string) => void
  onCancel?: () => void
}

export function CropView({
  src,
  initialCorners,
  onCropComplete,
  onCancel,
}: CropViewProps) {
  // DOM References
  const containerRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const polygonRef = useRef<SVGPolygonElement | null>(null)

  // Direct DOM references for 4 handle elements to mutate styles at 60fps without React re-renders
  const handleRefs = useRef<(SVGGElement | null)[]>([null, null, null, null])

  // Magnifier Canvas Ref
  const magnifierCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const magnifierContainerRef = useRef<HTMLDivElement | null>(null)

  // Natural image dimensions & Display scale factors
  const imgDimensionsRef = useRef<{
    naturalWidth: number
    naturalHeight: number
    displayWidth: number
    displayHeight: number
    offsetX: number
    offsetY: number
  }>({
    naturalWidth: 0,
    naturalHeight: 0,
    displayWidth: 0,
    displayHeight: 0,
    offsetX: 0,
    offsetY: 0,
  })

  // Stored corner coordinates in natural image pixel space [TL, TR, BR, BL]
  const cornersRef = useRef<Point[]>([
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ])

  // Active dragging state
  const activeDragIndexRef = useRef<number | null>(null)
  const isWarpingRef = useRef<boolean>(false)
  const [isProcessing, setIsProcessing] = useState<boolean>(false)

  /**
   * Recalculates display bounds and maps natural image coordinates to SVG screen coordinates.
   */
  const updateLayoutMetrics = useCallback(() => {
    const img = imgRef.current
    const container = containerRef.current
    if (!img || !container || img.naturalWidth === 0) return

    const containerRect = container.getBoundingClientRect()
    const nw = img.naturalWidth
    const nh = img.naturalHeight

    // Compute contained image layout dimensions
    const scale = Math.min(containerRect.width / nw, containerRect.height / nh)
    const dw = nw * scale
    const dh = nh * scale
    const ox = (containerRect.width - dw) / 2
    const oy = (containerRect.height - dh) / 2

    imgDimensionsRef.current = {
      naturalWidth: nw,
      naturalHeight: nh,
      displayWidth: dw,
      displayHeight: dh,
      offsetX: ox,
      offsetY: oy,
    }

    renderSvgElements()
  }, [])

  /**
   * Directly updates SVG polygon points and handle positions at 60fps without triggering React renders.
   */
  const renderSvgElements = useCallback(() => {
    const { naturalWidth, naturalHeight, displayWidth, displayHeight, offsetX, offsetY } =
      imgDimensionsRef.current
    if (naturalWidth === 0 || displayWidth === 0) return

    const scaleX = displayWidth / naturalWidth
    const scaleY = displayHeight / naturalHeight

    const screenPoints = cornersRef.current.map((c) => ({
      x: c.x * scaleX + offsetX,
      y: c.y * scaleY + offsetY,
    }))

    // Update SVG Polygon points attribute
    if (polygonRef.current) {
      polygonRef.current.setAttribute(
        "points",
        screenPoints.map((p) => `${p.x},${p.y}`).join(" ")
      )
    }

    // Move handle SVG groups
    screenPoints.forEach((p, idx) => {
      const handle = handleRefs.current[idx]
      if (handle) {
        handle.setAttribute("transform", `translate(${p.x}, ${p.y})`)
      }
    })
  }, [])

  /**
   * Initializes corners either from auto-detected points or fallback inset rectangle.
   */
  const initCorners = useCallback(() => {
    const img = imgRef.current
    if (!img || img.naturalWidth === 0) return

    const nw = img.naturalWidth
    const nh = img.naturalHeight

    if (initialCorners && initialCorners.length === 4) {
      cornersRef.current = initialCorners.map((p) => ({
        x: Math.max(0, Math.min(nw, p.x)),
        y: Math.max(0, Math.min(nh, p.y)),
      }))
    } else {
      // 8% inset padding fallback
      const padX = nw * 0.08
      const padY = nh * 0.08
      cornersRef.current = [
        { x: padX, y: padY }, // Top-Left
        { x: nw - padX, y: padY }, // Top-Right
        { x: nw - padX, y: nh - padY }, // Bottom-Right
        { x: padX, y: nh - padY }, // Bottom-Left
      ]
    }

    updateLayoutMetrics()
  }, [initialCorners, updateLayoutMetrics])

  /**
   * Update magnifying loupe preview canvas.
   * Magnifies a 60x60 pixel area around the current corner by 3.5x.
   */
  const updateMagnifier = useCallback((screenX: number, screenY: number, naturalPt: Point) => {
    const magCanvas = magnifierCanvasRef.current
    const magContainer = magnifierContainerRef.current
    const img = imgRef.current
    if (!magCanvas || !magContainer || !img) return

    const ctx = magCanvas.getContext("2d")
    if (!ctx) return

    const magSize = 110
    magCanvas.width = magSize
    magCanvas.height = magSize

    // Position magnifier 85px above the finger so it's not obscured
    const magLeft = Math.max(10, Math.min(window.innerWidth - magSize - 10, screenX - magSize / 2))
    const magTop = Math.max(10, screenY - magSize - 40)

    magContainer.style.transform = `translate3d(${magLeft}px, ${magTop}px, 0)`
    magContainer.style.opacity = "1"

    // Clear
    ctx.clearRect(0, 0, magSize, magSize)

    // Draw magnified image slice (3.5x zoom)
    const sampleBox = 36
    ctx.drawImage(
      img,
      naturalPt.x - sampleBox / 2,
      naturalPt.y - sampleBox / 2,
      sampleBox,
      sampleBox,
      0,
      0,
      magSize,
      magSize
    )

    // Draw crosshair reticle
    ctx.save()
    ctx.strokeStyle = "#2dd4bf"
    ctx.lineWidth = 1.5
    ctx.beginPath()
    // Horizontal line
    ctx.moveTo(0, magSize / 2)
    ctx.lineTo(magSize, magSize / 2)
    // Vertical line
    ctx.moveTo(magSize / 2, 0)
    ctx.lineTo(magSize / 2, magSize)
    ctx.stroke()

    // Center targeting ring
    ctx.beginPath()
    ctx.arc(magSize / 2, magSize / 2, 6, 0, Math.PI * 2)
    ctx.strokeStyle = "#ffffff"
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.restore()
  }, [])

  const hideMagnifier = useCallback(() => {
    const magContainer = magnifierContainerRef.current
    if (magContainer) {
      magContainer.style.opacity = "0"
    }
  }, [])

  // Touch and Pointer Event Listeners
  const handlePointerDown = (index: number) => (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    activeDragIndexRef.current = index
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    const dragIdx = activeDragIndexRef.current
    if (dragIdx === null) return

    e.preventDefault()
    const container = containerRef.current
    if (!container) return

    const containerRect = container.getBoundingClientRect()
    const clientX = e.clientX
    const clientY = e.clientY

    const { naturalWidth, naturalHeight, displayWidth, displayHeight, offsetX, offsetY } =
      imgDimensionsRef.current
    if (naturalWidth === 0 || displayWidth === 0) return

    // Calculate position within image bounds
    const screenX = clientX - containerRect.left
    const screenY = clientY - containerRect.top

    const localX = Math.max(0, Math.min(displayWidth, screenX - offsetX))
    const localY = Math.max(0, Math.min(displayHeight, screenY - offsetY))

    // Convert to natural image coordinate space
    const natX = Math.round((localX / displayWidth) * naturalWidth)
    const natY = Math.round((localY / displayHeight) * naturalHeight)

    cornersRef.current[dragIdx] = { x: natX, y: natY }

    // Fast 60fps DOM mutation
    renderSvgElements()

    // Update magnifying loupe
    updateMagnifier(clientX, clientY, { x: natX, y: natY })
  }

  const handlePointerUp = (e: React.PointerEvent) => {
    if (activeDragIndexRef.current !== null) {
      activeDragIndexRef.current = null
      hideMagnifier()
    }
  }

  // Detect corners automatically if not supplied
  const runAutoDetection = async () => {
    const img = imgRef.current
    if (!img || img.naturalWidth === 0) return

    try {
      setIsProcessing(true)
      const bitmap = await createImageBitmap(img)
      const detected = await documentProcessor.detectCorners(bitmap)
      if (detected && detected.length === 4) {
        cornersRef.current = detected
        renderSvgElements()
      }
    } catch (err) {
      console.error("[Auto-Detect Error]", err)
    } finally {
      setIsProcessing(false)
    }
  }

  // Confirm and trigger warpPerspective in Web Worker
  const handleConfirmWarp = async () => {
    const img = imgRef.current
    if (!img || isWarpingRef.current) return

    try {
      isWarpingRef.current = true
      setIsProcessing(true)

      const bitmap = await createImageBitmap(img)
      const corners = cornersRef.current

      // Offload to Web Worker with finalized corner coordinates
      const dewarpedBitmap = await documentProcessor.dewarp(bitmap, corners)

      // Convert result to JPEG Base64
      const canvas = document.createElement("canvas")
      canvas.width = dewarpedBitmap.width
      canvas.height = dewarpedBitmap.height
      const ctx = canvas.getContext("2d")
      if (!ctx) throw new Error("Could not create canvas context")

      ctx.drawImage(dewarpedBitmap, 0, 0)
      const base64 = canvas.toDataURL("image/jpeg", 0.94)

      dewarpedBitmap.close()
      onCropComplete(base64)
    } catch (err) {
      console.error("[Warp Error]", err)
    } finally {
      setIsProcessing(false)
      isWarpingRef.current = false
    }
  }

  // Window resize observer
  useEffect(() => {
    window.addEventListener("resize", updateLayoutMetrics)
    return () => window.removeEventListener("resize", updateLayoutMetrics)
  }, [updateLayoutMetrics])

  return (
    <div className="relative flex flex-col h-full w-full select-none overflow-hidden bg-black text-white">
      {/* Interactive Crop Viewport */}
      <div
        ref={containerRef}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="relative flex-1 w-full h-full flex items-center justify-center overflow-hidden touch-none"
      >
        <img
          ref={imgRef}
          src={src}
          alt="Document for corner adjustment"
          onLoad={initCorners}
          draggable={false}
          className="max-h-full max-w-full object-contain pointer-events-none select-none opacity-90"
        />

        {/* SVG Polygon Overlay & Corner Draggable Handles */}
        <svg
          ref={svgRef}
          className="absolute inset-0 h-full w-full pointer-events-none overflow-visible"
        >
          {/* Shaded Quadrilateral Polygon */}
          <polygon
            ref={polygonRef}
            className="fill-teal-500/20 stroke-teal-400 [stroke-width:2.5px] [stroke-dasharray:6_4] filter drop-shadow-[0_0_8px_rgba(20,184,166,0.6)]"
          />

          {/* Draggable Corner Handles with Large Invisible Hit-Slop (48px) */}
          {[0, 1, 2, 3].map((idx) => (
            <g
              key={idx}
              ref={(el) => {
                handleRefs.current[idx] = el
              }}
              onPointerDown={handlePointerDown(idx)}
              className="pointer-events-auto cursor-grab active:cursor-grabbing"
            >
              {/* Invisible 48px Touch Hit-Slop for mobile finger ease */}
              <circle r="26" fill="transparent" />

              {/* Outer Cyan Glow Ring */}
              <circle
                r="11"
                className="fill-teal-500/40 stroke-teal-400 stroke-2 filter drop-shadow-[0_0_6px_#14b8a6]"
              />

              {/* Inner White Target Pin */}
              <circle r="4.5" fill="#ffffff" />
            </g>
          ))}
        </svg>

        {/* Localized Floating Magnifier Reticle (Offset above user's touch) */}
        <div
          ref={magnifierContainerRef}
          className="fixed top-0 left-0 z-50 pointer-events-none transition-opacity duration-100 opacity-0 will-change-transform"
        >
          <div className="relative size-[110px] rounded-full overflow-hidden border-2 border-white shadow-2xl shadow-teal-500/40 bg-black">
            <canvas ref={magnifierCanvasRef} className="size-full" />
          </div>
        </div>
      </div>

      {/* Bottom Floating Control Bar */}
      <footer className="relative z-30 flex items-center justify-between p-4 bg-gradient-to-t from-black via-black/90 to-transparent">
        <Button
          onClick={runAutoDetection}
          variant="secondary"
          size="sm"
          disabled={isProcessing}
          className="rounded-full bg-white/10 text-white hover:bg-white/20 border border-white/10 backdrop-blur-md"
        >
          <Sparkles className="mr-1.5 size-4 text-teal-400" />
          Auto-Detect
        </Button>

        <div className="flex items-center gap-3">
          {onCancel && (
            <Button
              onClick={onCancel}
              variant="ghost"
              size="sm"
              disabled={isProcessing}
              className="rounded-full text-white/70 hover:text-white hover:bg-white/10"
            >
              Cancel
            </Button>
          )}

          <Button
            onClick={handleConfirmWarp}
            disabled={isProcessing}
            size="lg"
            className="rounded-full bg-teal-500 hover:bg-teal-600 text-white font-semibold shadow-lg shadow-teal-500/30 px-6 h-12"
          >
            <Check className="mr-2 size-5" />
            {isProcessing ? "Dewarping..." : "Done"}
          </Button>
        </div>
      </footer>
    </div>
  )
}
