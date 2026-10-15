"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  DEFAULT_SESSION,
  addPage,
  clearSession,
  deletePage,
  listPages,
  reorderPages,
  type PageMeta,
} from "@/lib/db/indexed-db"

export interface BatchPage {
  id: string
  width: number
  height: number
  /** Object URL of the low-res thumbnail; owned and revoked by the hook. */
  thumbUrl: string
}

const THUMB_MAX = 320
const FULL_JPEG_QUALITY = 0.92

async function encodeJpeg(
  source: CanvasImageSource,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext("2d")!.drawImage(source, 0, 0, width, height)
    return canvas.convertToBlob({ type: "image/jpeg", quality })
  }
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  canvas.getContext("2d")!.drawImage(source, 0, 0, width, height)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG encode failed"))), "image/jpeg", quality),
  )
  canvas.width = canvas.height = 0
  return blob
}

function toBatchPage(meta: PageMeta): BatchPage {
  return {
    id: meta.id,
    width: meta.width,
    height: meta.height,
    thumbUrl: URL.createObjectURL(meta.thumbnail),
  }
}

/**
 * React state for the in-progress multi-page batch.
 *
 * Only thumbnails live in memory; each full-resolution capture is encoded to
 * JPEG and written to IndexedDB as soon as it's added. The batch is restored
 * on mount, so a reload or WebView kill mid-scan doesn't lose pages.
 */
export function useScanBatch(sessionId: string = DEFAULT_SESSION) {
  const [pages, setPages] = useState<BatchPage[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pagesRef = useRef(pages)
  pagesRef.current = pages

  useEffect(() => {
    let cancelled = false
    listPages(sessionId)
      .then((metas) => {
        if (cancelled) return
        setPages(metas.map(toBatchPage))
      })
      .catch((err) => {
        console.error("[ScanBatch] restore failed", err)
        if (!cancelled) setError("Couldn't open on-device storage")
      })
      .finally(() => !cancelled && setReady(true))
    return () => {
      cancelled = true
    }
  }, [sessionId])

  // Revoke all thumbnail URLs on unmount.
  useEffect(() => () => pagesRef.current.forEach((p) => URL.revokeObjectURL(p.thumbUrl)), [])

  /**
   * Persist a processed page. The caller keeps ownership of `bitmap` and
   * should close it once this resolves.
   */
  const addFromBitmap = useCallback(
    async (bitmap: ImageBitmap) => {
      const { width, height } = bitmap
      const scale = Math.min(1, THUMB_MAX / Math.max(width, height))
      const tw = Math.max(1, Math.round(width * scale))
      const th = Math.max(1, Math.round(height * scale))

      const [blob, thumbnail] = await Promise.all([
        encodeJpeg(bitmap, width, height, FULL_JPEG_QUALITY),
        encodeJpeg(bitmap, tw, th, 0.7),
      ])
      const meta = await addPage({ blob, thumbnail, width, height }, sessionId)
      const page = toBatchPage(meta)
      setPages((prev) => [...prev, page])
      return page
    },
    [sessionId],
  )

  const remove = useCallback(
    async (id: string) => {
      const target = pagesRef.current.find((p) => p.id === id)
      setPages((prev) => prev.filter((p) => p.id !== id))
      if (target) URL.revokeObjectURL(target.thumbUrl)
      await deletePage(id, sessionId)
    },
    [sessionId],
  )

  /** Optimistically apply an order, then persist it. */
  const reorder = useCallback(
    async (orderedIds: string[]) => {
      const byId = new Map(pagesRef.current.map((p) => [p.id, p]))
      const next = orderedIds.map((id) => byId.get(id)).filter((p): p is BatchPage => !!p)
      const previous = pagesRef.current
      setPages(next)
      try {
        await reorderPages(orderedIds, sessionId)
      } catch (err) {
        console.error("[ScanBatch] reorder failed", err)
        setPages(previous)
      }
    },
    [sessionId],
  )

  const clear = useCallback(async () => {
    pagesRef.current.forEach((p) => URL.revokeObjectURL(p.thumbUrl))
    setPages([])
    await clearSession(sessionId)
  }, [sessionId])

  return { pages, ready, error, addFromBitmap, remove, reorder, clear }
}
