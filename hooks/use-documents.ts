"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { listDocuments, type DocumentSummary } from "@/lib/db/indexed-db"
import { LIBRARY_CHANGED_EVENT } from "@/lib/drive/backup"

export interface LibraryDocument extends Omit<DocumentSummary, "cover"> {
  /** Object URL of the first page's thumbnail; owned and revoked by the hook. */
  coverUrl: string | null
}

/** The saved document library, refreshed on mount and whenever the app returns to the foreground. */
export function useDocuments() {
  const [documents, setDocuments] = useState<LibraryDocument[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const urlsRef = useRef<string[]>([])
  const generationRef = useRef(0)

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current
    try {
      const summaries = await listDocuments()
      // A newer refresh started meanwhile; its result wins.
      if (generation !== generationRef.current) return
      const next = summaries.map(({ cover, ...doc }) => ({
        ...doc,
        coverUrl: cover ? URL.createObjectURL(cover) : null,
      }))
      const stale = urlsRef.current
      urlsRef.current = next.flatMap((d) => (d.coverUrl ? [d.coverUrl] : []))
      setDocuments(next)
      setError(null)
      // Revoke after the new list has rendered so images never flash blank.
      requestAnimationFrame(() => stale.forEach((u) => URL.revokeObjectURL(u)))
    } catch (err) {
      console.error("[Library] load failed", err)
      if (generation === generationRef.current) setError("Couldn't open on-device storage")
    } finally {
      if (generation === generationRef.current) setReady(true)
    }
  }, [])

  useEffect(() => {
    refresh()
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    // A backup sync restored or removed documents.
    window.addEventListener(LIBRARY_CHANGED_EVENT, refresh)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener(LIBRARY_CHANGED_EVENT, refresh)
      generationRef.current++
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u))
      urlsRef.current = []
    }
  }, [refresh])

  return { documents, ready, error, refresh }
}
