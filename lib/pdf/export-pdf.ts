import { Capacitor } from "@capacitor/core"
import { Directory, Filesystem } from "@capacitor/filesystem"
import { Share } from "@capacitor/share"
import { jsPDF, GState } from "jspdf"
import { getPageBlob, type PageMeta } from "@/lib/db/indexed-db"

export type PageSize = "a4" | "letter" | "auto"
export type Quality = "high" | "medium" | "low"

export interface ExportOptions {
  pageSize: PageSize
  quality: Quality
  watermark?: string
  password?: string
  filename?: string
}

export interface ExportProgress {
  done: number
  total: number
}

/**
 * Target raster density and JPEG quality per preset. Re-encoding each page at
 * the density it will actually print at is where the payload savings come
 * from: an 8MP capture on A4 is ~380dpi, so "medium" roughly halves pixel
 * count before the lower JPEG quality is even applied.
 */
const QUALITY_PRESETS: Record<Quality, { dpi: number; jpeg: number }> = {
  high: { dpi: 300, jpeg: 0.85 },
  medium: { dpi: 200, jpeg: 0.72 },
  low: { dpi: 144, jpeg: 0.55 },
}

// Page sizes in PDF points (1pt = 1/72in).
const PAGE_FORMATS: Record<Exclude<PageSize, "auto">, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
}
const MARGIN_PT = 18

interface PlacedImage {
  bytes: Uint8Array
  width: number
  height: number
}

/**
 * Decode, downscale and re-encode one page. Decoding goes through
 * createImageBitmap so the browser can decode off the main thread, and the
 * bitmap is closed immediately after drawing to release its pixel memory.
 */
async function recompressPage(blob: Blob, maxW: number, maxH: number, jpeg: number): Promise<PlacedImage> {
  const probe = await createImageBitmap(blob)
  const scale = Math.min(1, maxW / probe.width, maxH / probe.height)
  const width = Math.max(1, Math.round(probe.width * scale))
  const height = Math.max(1, Math.round(probe.height * scale))

  let bitmap = probe
  if (scale < 1) {
    probe.close()
    bitmap = await createImageBitmap(blob, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: "high",
    })
  }

  let out: Blob
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext("2d")!
    ctx.fillStyle = "#ffffff" // JPEG has no alpha; avoid black fill on transparent edges
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    out = await canvas.convertToBlob({ type: "image/jpeg", quality: jpeg })
  } else {
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d")!
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    out = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG encode failed"))), "image/jpeg", jpeg),
    )
    canvas.width = canvas.height = 0
  }

  return { bytes: new Uint8Array(await out.arrayBuffer()), width, height }
}

function drawWatermark(doc: jsPDF, text: string, pageW: number, pageH: number) {
  const fontSize = Math.min(pageW, pageH) / Math.max(6, text.length * 0.55)
  doc.saveGraphicsState()
  doc.setGState(new GState({ opacity: 0.15 }))
  doc.setTextColor(120, 120, 120)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(fontSize)
  doc.text(text, pageW / 2, pageH / 2, { align: "center", baseline: "middle", angle: 45 })
  doc.restoreGraphicsState()
}

/** Yield to the event loop so progress UI can paint between pages. */
const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0))

/**
 * Build a PDF from page ids stored in IndexedDB.
 *
 * Pages are streamed: exactly one high-res blob is read, recompressed and
 * appended at a time, and every intermediate (blob, bitmap, canvas) is
 * released before the next page is fetched. jsPDF still retains the final
 * compressed JPEG bytes for each page until output, which is the irreducible
 * cost of building the document client-side.
 */
export async function buildPdf(
  pages: Pick<PageMeta, "id" | "width" | "height">[],
  options: ExportOptions,
  onProgress?: (p: ExportProgress) => void,
): Promise<Blob> {
  if (pages.length === 0) throw new Error("No pages to export")

  const preset = QUALITY_PRESETS[options.quality]
  const pxPerPt = preset.dpi / 72
  const watermark = options.watermark?.trim()

  let doc: jsPDF | null = null
  onProgress?.({ done: 0, total: pages.length })

  for (let i = 0; i < pages.length; i++) {
    let blob: Blob | null = await getPageBlob(pages[i].id)
    if (!blob) throw new Error(`Page ${i + 1} is missing from storage`)

    let pageW: number
    let pageH: number
    let image: PlacedImage

    if (options.pageSize === "auto") {
      // Page takes the image's aspect ratio, sized to its pixels at target dpi.
      // Cap the long edge at A3-ish so huge captures don't create poster pages.
      const maxPt = 1190
      image = await recompressPage(blob, maxPt * pxPerPt, maxPt * pxPerPt, preset.jpeg)
      pageW = image.width / pxPerPt
      pageH = image.height / pxPerPt
    } else {
      const [w, h] = PAGE_FORMATS[options.pageSize]
      const boxW = w - MARGIN_PT * 2
      const boxH = h - MARGIN_PT * 2
      // Pick orientation per page so landscape scans fill the sheet.
      const landscape = pages[i].width > pages[i].height
      pageW = landscape ? h : w
      pageH = landscape ? w : h
      const bw = landscape ? boxH : boxW
      const bh = landscape ? boxW : boxH
      image = await recompressPage(blob, bw * pxPerPt, bh * pxPerPt, preset.jpeg)
    }
    blob = null

    const orientation = pageW > pageH ? "landscape" : "portrait"
    if (!doc) {
      doc = new jsPDF({
        unit: "pt",
        format: [pageW, pageH],
        orientation,
        compress: true, // deflate content streams/xref (JPEG data stays DCT-encoded)
        putOnlyUsedFonts: true,
        ...(options.password
          ? {
              encryption: {
                userPassword: options.password,
                ownerPassword: options.password,
                userPermissions: ["print", "copy"],
              },
            }
          : {}),
      })
    } else {
      doc.addPage([pageW, pageH], orientation)
    }

    // Fit image inside the page (or margin box) preserving aspect ratio.
    const margin = options.pageSize === "auto" ? 0 : MARGIN_PT
    const fit = Math.min((pageW - margin * 2) / image.width, (pageH - margin * 2) / image.height)
    const drawW = image.width * fit
    const drawH = image.height * fit
    // Unique alias per page so jsPDF doesn't hash the bytes to dedupe.
    doc.addImage(image.bytes, "JPEG", (pageW - drawW) / 2, (pageH - drawH) / 2, drawW, drawH, `p${i}`, "NONE")

    if (watermark) drawWatermark(doc, watermark, pageW, pageH)

    onProgress?.({ done: i + 1, total: pages.length })
    await nextFrame()
  }

  return doc!.output("blob")
}

export type DeliveryResult = "shared" | "downloaded" | "cancelled"

/** Cache sub-folder for exported PDFs; wiped at the start of each native export. */
const NATIVE_EXPORT_DIR = "exports"

/**
 * Base64-encode the PDF (no data: prefix) for Filesystem.writeFile.
 * FileReader encodes natively, avoiding the intermediate binary string that
 * jsPDF's output("datauristring") builds before calling btoa.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.slice(result.indexOf(",") + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/**
 * Native (Capacitor) delivery: write the PDF into the app cache and open the
 * Android/iOS share sheet with its file URI. The cache path is exposed via
 * the FileProvider declared in android/app/src/main/res/xml/file_paths.xml.
 */
async function deliverPdfNative(blob: Blob, filename: string): Promise<DeliveryResult> {
  // Previous exports can't be deleted right after sharing (the receiving app
  // may still be reading them), so clear them out before writing a new one.
  await Filesystem.rmdir({ path: NATIVE_EXPORT_DIR, directory: Directory.Cache, recursive: true }).catch(
    () => {},
  )

  const { uri } = await Filesystem.writeFile({
    path: `${NATIVE_EXPORT_DIR}/${filename}`,
    data: await blobToBase64(blob),
    directory: Directory.Cache,
    recursive: true,
  })

  try {
    await Share.share({ url: uri, title: "Scanned Document", dialogTitle: "Share PDF" })
    return "shared"
  } catch (err) {
    // The plugin rejects with "Share canceled" when the user dismisses the sheet.
    if (/cancel/i.test((err as Error)?.message ?? "")) return "cancelled"
    throw err
  }
}

/**
 * Web fallback for local browser testing: OS share sheet when the browser can
 * share files, otherwise a regular download.
 */
async function deliverPdfWeb(blob: Blob, filename: string): Promise<DeliveryResult> {
  const file = new File([blob], filename, { type: "application/pdf" })

  if (typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename })
      return "shared"
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return "cancelled"
      // NotAllowedError (lost user activation during a long export) etc. → download.
      console.warn("[PDF Export] share failed, falling back to download", err)
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.rel = "noopener"
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Give the download a moment to start before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return "downloaded"
}

/** Hand the finished PDF to the user: native share sheet in Capacitor, browser otherwise. */
export function deliverPdf(blob: Blob, filename: string): Promise<DeliveryResult> {
  return Capacitor.isNativePlatform() ? deliverPdfNative(blob, filename) : deliverPdfWeb(blob, filename)
}

export function defaultPdfFilename(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `DokuScan_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}.pdf`
}
