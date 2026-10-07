"use client"

import { useRef, useState } from "react"
import ReactCrop, { type Crop } from "react-image-crop"
import "react-image-crop/dist/ReactCrop.css"
import { Button } from "@/components/ui/button"

export function CropView({
  src,
  onCropComplete,
}: {
  src: string
  onCropComplete: (base64: string) => void
}) {
  const [crop, setCrop] = useState<Crop>()
  const imgRef = useRef<HTMLImageElement>(null)

  const handleConfirm = () => {
    if (!imgRef.current) return

    const canvas = document.createElement("canvas")
    const scaleX = imgRef.current.naturalWidth / imgRef.current.width
    const scaleY = imgRef.current.naturalHeight / imgRef.current.height

    const cropWidth = crop?.width ? crop.width : imgRef.current.width
    const cropHeight = crop?.height ? crop.height : imgRef.current.height
    const cropX = crop?.x ? crop.x : 0
    const cropY = crop?.y ? crop.y : 0

    canvas.width = cropWidth * scaleX
    canvas.height = cropHeight * scaleY

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    ctx.drawImage(
      imgRef.current,
      cropX * scaleX,
      cropY * scaleY,
      cropWidth * scaleX,
      cropHeight * scaleY,
      0,
      0,
      cropWidth * scaleX,
      cropHeight * scaleY
    )

    const base64 = canvas.toDataURL("image/jpeg")
    onCropComplete(base64)
  }

  return (
    <div className="flex flex-col gap-4 w-full">
      <div className="relative flex w-full items-center justify-center overflow-hidden rounded-2xl border border-border bg-black aspect-[3/4]">
        <ReactCrop crop={crop} onChange={(c) => setCrop(c)} className="max-h-full max-w-full">
          <img
            ref={imgRef}
            src={src}
            alt="Scanned document being adjusted"
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        </ReactCrop>
      </div>
      <Button
        onClick={handleConfirm}
        size="lg"
        className="w-full rounded-full shadow-xl shadow-primary/30 h-14 text-base font-semibold"
      >
        Confirm Crop
      </Button>
    </div>
  )
}
