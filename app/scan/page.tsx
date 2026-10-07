"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Camera as CapacitorCamera, CameraResultType, CameraSource } from '@capacitor/camera'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { defineCustomElements } from '@ionic/pwa-elements/loader'
import { ArrowLeft, Settings, Check, Camera } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CropView } from "@/components/crop-view"
import jsPDF from 'jspdf'

export default function Page() {
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const [scannedPages, setScannedPages] = useState<string[]>([])

  const handleExportPdf = async () => {
    if (scannedPages.length === 0) return;

    const doc = new jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: "a4",
    });

    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 15;
    const maxImgWidth = pageWidth - margin * 2;
    const maxImgHeight = pageHeight - margin * 2;

    for (let i = 0; i < scannedPages.length; i++) {
      if (i > 0) doc.addPage();
      
      const imgData = scannedPages[i];
      
      await new Promise<void>((resolve) => {
        const img = new Image();
        img.src = imgData;
        img.onload = () => {
          let imgWidth = img.width;
          let imgHeight = img.height;
          const ratio = imgWidth / imgHeight;

          if (imgWidth > maxImgWidth) {
            imgWidth = maxImgWidth;
            imgHeight = imgWidth / ratio;
          }
          if (imgHeight > maxImgHeight) {
            imgHeight = maxImgHeight;
            imgWidth = imgHeight * ratio;
          }

          const x = (pageWidth - imgWidth) / 2;
          const y = margin;

          doc.addImage(imgData, "JPEG", x, y, imgWidth, imgHeight);
          resolve();
        };
      });
    }

    try {
      const pdfBase64 = doc.output('datauristring').split(',')[1];
      const fileName = `Scanned_Document_${Date.now()}.pdf`;
      
      await Filesystem.writeFile({
        path: fileName,
        data: pdfBase64,
        directory: Directory.Documents
      });

      alert(`Saved ${fileName} to native Documents folder!`);
      handleReset();
    } catch (e) {
      console.error("Error saving PDF:", e);
      alert("Failed to save PDF to native filesystem.");
    }
  };

  const handleReset = () => {
    setImageSrc(null);
    setScannedPages([]);
  };

  const takePhoto = async () => {
    try {
      const image = await CapacitorCamera.getPhoto({
        quality: 100,
        allowEditing: false,
        resultType: CameraResultType.Uri,
        source: CameraSource.Camera
      });
      if (image.webPath) {
        setImageSrc(image.webPath);
      }
    } catch (e) {
      console.error(e)
    }
  };

  useEffect(() => {
    defineCustomElements(window)
    const stored = sessionStorage.getItem("scanImage")
    if (stored) {
      setImageSrc(stored)
      sessionStorage.removeItem("scanImage")
    }
  }, [])

  useEffect(() => {
    return () => {
      if (imageSrc) {
        URL.revokeObjectURL(imageSrc)
      }
    }
  }, [imageSrc])

  const handleCropComplete = (base64: string) => {
    setScannedPages((prev) => [...prev, base64]);
    setImageSrc(null);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-background text-foreground">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-foreground hover:bg-secondary"
          aria-label="Go back"
          nativeButton={false}
          render={
            <Link href="/">
              <ArrowLeft className="size-5" />
            </Link>
          }
        />
        <h1 className="text-base font-semibold">
          {imageSrc ? "Adjust Page" : scannedPages.length > 0 ? `Scanned Pages (${scannedPages.length})` : "Scan Document"}
        </h1>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-foreground hover:bg-secondary"
          aria-label="Settings"
        >
          <Settings className="size-5" />
        </Button>
      </header>

      {/* Main View Area */}
      {imageSrc ? (
        <section className="flex flex-1 flex-col justify-center px-4 pb-4">
          <CropView src={imageSrc} onCropComplete={handleCropComplete} />
        </section>
      ) : scannedPages.length > 0 ? (
        <section className="flex flex-1 flex-col gap-4 px-4 pb-32 pt-4">
          <div className="grid grid-cols-2 gap-4 overflow-y-auto">
            {scannedPages.map((page, index) => (
              <div key={index} className="relative aspect-[3/4] overflow-hidden rounded-xl border border-border shadow-sm">
                <img src={page} className="h-full w-full object-cover" alt={`Page ${index + 1}`} />
                <div className="absolute top-2 left-2 rounded-full bg-black/60 px-2 py-1 text-xs font-medium text-white backdrop-blur-md">
                  {index + 1}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center text-muted-foreground">
          <div className="mb-4 rounded-full bg-secondary p-6">
            <Camera className="size-10" />
          </div>
          <p>Tap the camera button to scan your first page</p>
        </div>
      )}

      {/* Bottom Action Area */}
      {!imageSrc && (
        <div className="fixed bottom-0 left-0 right-0 z-20 flex flex-col items-center justify-center bg-gradient-to-t from-background via-background/90 to-transparent pb-8 pt-12 px-6">
          {scannedPages.length > 0 ? (
            <div className="flex w-full max-w-md flex-col gap-3">
              <Button onClick={takePhoto} variant="secondary" size="lg" className="w-full rounded-full h-14 text-base font-semibold shadow-sm">
                <Camera className="mr-2 size-5" />
                Scan Next Page
              </Button>
              <Button onClick={handleExportPdf} size="lg" className="w-full rounded-full shadow-xl shadow-primary/30 h-14 text-base font-semibold">
                <Check className="mr-2 size-5" />
                Finish & Export PDF
              </Button>
            </div>
          ) : (
            <button
              onClick={takePhoto}
              className="flex h-16 w-16 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground shadow-2xl shadow-primary"
            >
              <svg className="size-8" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="5" />
                <path
                  d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      )}
    </main>
  )
}
