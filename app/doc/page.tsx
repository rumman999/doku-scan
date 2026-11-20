"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, Camera, FileDown, Loader2, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SortablePageGrid } from "@/components/sortable-page-grid"
import { PdfExportSheet } from "@/components/pdf-export-sheet"
import { PageViewer } from "@/components/page-viewer"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { useScanBatch } from "@/hooks/use-scan-batch"
import {
  deleteDocuments,
  docSession,
  getDocument,
  renameDocument,
  type StoredDocument,
} from "@/lib/db/indexed-db"
import { formatDocDate, pdfFilename, pluralPages } from "@/lib/format"

export default function DocumentPage() {
  return (
    <Suspense fallback={<FullScreenSpinner />}>
      <DocumentView />
    </Suspense>
  )
}

function FullScreenSpinner() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </main>
  )
}

function DocumentView() {
  const router = useRouter()
  const params = useSearchParams()
  const id = params.get("id") ?? ""

  const [doc, setDoc] = useState<StoredDocument | null>(null)
  const [missing, setMissing] = useState(false)
  const { pages, ready, error, remove, reorder } = useScanBatch(docSession(id))

  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState("")
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const [exportOpen, setExportOpen] = useState(params.get("export") === "1")
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!id) {
      setMissing(true)
      return
    }
    let cancelled = false
    getDocument(id)
      .then((d) => {
        if (cancelled) return
        if (d) setDoc(d)
        else setMissing(true)
      })
      .catch((err) => {
        console.error("[Document] load failed", err)
        if (!cancelled) setMissing(true)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  // Removing the last page deletes the document in storage; leave the empty view.
  useEffect(() => {
    if (ready && doc && pages.length === 0) router.replace("/")
  }, [ready, doc, pages.length, router])

  useEffect(() => {
    if (renaming) nameInputRef.current?.select()
  }, [renaming])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 3500)
    return () => clearTimeout(t)
  }, [notice])

  if (missing) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-4 bg-background p-6 text-center text-foreground">
        <p className="text-sm text-muted-foreground">This document doesn&apos;t exist anymore.</p>
        <Button nativeButton={false} render={<Link href="/">Back to documents</Link>} className="rounded-xl" />
      </main>
    )
  }
  if (!doc) return <FullScreenSpinner />

  const startRename = () => {
    setDraftName(doc.name)
    setRenaming(true)
  }

  const commitRename = async () => {
    const name = draftName.trim()
    setRenaming(false)
    if (!name || name === doc.name) return
    try {
      await renameDocument(doc.id, name)
      setDoc({ ...doc, name, updatedAt: Date.now() })
    } catch (err) {
      console.error("[Document] rename failed", err)
      setNotice("Couldn't rename the document")
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteDocuments([doc.id])
      router.replace("/")
    } catch (err) {
      console.error("[Document] delete failed", err)
      setNotice("Couldn't delete the document")
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-background text-foreground">
      <header
        className="sticky top-0 z-20 flex items-center gap-1 bg-background/90 px-2 pb-3 backdrop-blur"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 rounded-full hover:bg-secondary"
          aria-label="Back to documents"
          nativeButton={false}
          render={
            <Link href="/">
              <ArrowLeft className="size-5" />
            </Link>
          }
        />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                commitRename()
              }}
            >
              <input
                ref={nameInputRef}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
                maxLength={80}
                aria-label="Document name"
                className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-base font-semibold outline-none focus:border-ring focus:ring-2 focus:ring-ring/40"
              />
            </form>
          ) : (
            <button
              type="button"
              onClick={startRename}
              className="group flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1 text-left"
              aria-label={`Rename ${doc.name}`}
            >
              <h1 className="truncate text-base font-semibold">{doc.name}</h1>
              <Pencil className="size-3.5 shrink-0 text-muted-foreground opacity-70 group-hover:opacity-100" />
            </button>
          )}
          <p className="px-1 text-xs text-muted-foreground">
            {pluralPages(pages.length)} · {formatDocDate(doc.updatedAt)}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 rounded-full text-destructive hover:bg-destructive/10"
          aria-label="Delete document"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="size-5" />
        </Button>
      </header>

      <div className="flex-1 px-4 pb-32 pt-2">
        {error ? (
          <p role="alert" className="py-12 text-center text-sm text-destructive">
            {error}
          </p>
        ) : !ready ? (
          <div className="flex justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {pages.length > 1 ? (
              <p className="mb-2 px-1 text-[11px] text-muted-foreground">Tap to view · hold &amp; drag to reorder</p>
            ) : null}
            <SortablePageGrid
              pages={pages}
              onReorder={reorder}
              onRemove={remove}
              onOpen={(pageId) => setViewerIndex(pages.findIndex((p) => p.id === pageId))}
            />
          </>
        )}
      </div>

      {/* Bottom actions */}
      <div
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto grid max-w-md grid-cols-2 gap-2 px-4 pt-3">
          <Button
            variant="secondary"
            className="h-12 gap-2 rounded-xl text-sm font-semibold"
            nativeButton={false}
            render={
              <Link href={`/scan?doc=${encodeURIComponent(doc.id)}`}>
                <Camera className="size-5" />
                Add pages
              </Link>
            }
          />
          <Button
            className="h-12 gap-2 rounded-xl text-sm font-semibold"
            onClick={() => setExportOpen(true)}
            disabled={!ready || pages.length === 0}
          >
            <FileDown className="size-5" />
            Export PDF
          </Button>
        </div>
      </div>

      {notice ? (
        <div
          role="alert"
          className="fixed inset-x-4 bottom-28 z-40 mx-auto max-w-sm rounded-xl bg-rose-600/90 px-4 py-2.5 text-center text-sm font-medium text-white shadow-lg"
        >
          {notice}
        </div>
      ) : null}

      <PdfExportSheet
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        pages={pages}
        onReorder={reorder}
        onRemove={remove}
        filename={pdfFilename(doc.name)}
        showPages={false}
      />

      <PageViewer pages={pages} index={viewerIndex} onIndexChange={setViewerIndex} onClose={() => setViewerIndex(null)} />

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this document?"
        description={`"${doc.name}" and its ${pluralPages(pages.length)} will be permanently removed from this device.`}
        confirmLabel="Delete"
        destructive
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </main>
  )
}
