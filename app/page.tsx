"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Camera, FileText, LayoutGrid, List, Loader2, Search, Settings, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { DocCard } from "@/components/doc-card"
import { SelectionBar, type SelectionAction } from "@/components/selection-bar"
import { ThemeToggle } from "@/components/theme-toggle"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { useDocuments } from "@/hooks/use-documents"
import { useSettings } from "@/lib/settings"
import { deleteDocuments, mergeDocuments } from "@/lib/db/indexed-db"
import { scheduleBackup } from "@/lib/drive/backup"
import { pluralPages } from "@/lib/format"

export default function LibraryPage() {
  const router = useRouter()
  const { documents, ready, error, refresh } = useDocuments()
  const { settings, update } = useSettings()
  const view = settings.libraryView

  const [query, setQuery] = useState("")
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState<"delete" | "merge" | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const docs = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? documents.filter((d) => d.name.toLowerCase().includes(q)) : documents
  }, [documents, query])

  // Drop selections of documents that disappeared (deleted/merged elsewhere).
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(documents.map((d) => d.id))
      const next = new Set([...prev].filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [documents])

  // Opening the app catches up on anything not yet backed up (or restored elsewhere).
  useEffect(() => scheduleBackup(1500), [])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 3500)
    return () => clearTimeout(t)
  }, [notice])

  function enterSelection(id: string) {
    setSelectionMode(true)
    setSelected(new Set([id]))
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      if (next.size === 0) setSelectionMode(false)
      return next
    })
  }

  function exitSelection() {
    setSelectionMode(false)
    setSelected(new Set())
  }

  /** Selected ids in on-screen order (merge appends pages in this order). */
  const selectedIds = () => docs.filter((d) => selected.has(d.id)).map((d) => d.id)

  function handleAction(action: SelectionAction) {
    if (action === "share") {
      const [id] = selectedIds()
      if (id) router.push(`/doc?id=${encodeURIComponent(id)}&export=1`)
      return
    }
    setConfirm(action)
  }

  async function runConfirmed() {
    const ids = selectedIds()
    setBusy(true)
    try {
      if (confirm === "delete") {
        await deleteDocuments(ids)
      } else if (confirm === "merge") {
        await mergeDocuments(ids)
      }
      exitSelection()
      await refresh()
      scheduleBackup()
    } catch (err) {
      console.error(`[Library] ${confirm} failed`, err)
      setNotice(confirm === "merge" ? "Couldn't merge these documents" : "Couldn't delete these documents")
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  const selectedPages = documents.filter((d) => selected.has(d.id)).reduce((n, d) => n + d.pageCount, 0)
  const allSelected = docs.length > 0 && docs.every((d) => selected.has(d.id))

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-background text-foreground">
      {/* Header */}
      <header
        className="sticky top-0 z-20 bg-background/90 px-4 pb-3 backdrop-blur"
        style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}
      >
        <div className="mb-3 flex items-center justify-between">
          {selectionMode ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="-ml-2 rounded-full hover:bg-secondary"
                aria-label="Cancel selection"
                onClick={exitSelection}
              >
                <X className="size-5" />
              </Button>
              <h1 className="text-base font-semibold">{selected.size} selected</h1>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full text-primary hover:bg-secondary"
                onClick={() => (allSelected ? exitSelection() : setSelected(new Set(docs.map((d) => d.id))))}
              >
                {allSelected ? "None" : "All"}
              </Button>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold tracking-tight">Documents</h1>
              <div className="-mr-2 flex items-center">
                <ThemeToggle className="rounded-full hover:bg-secondary" />
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-full hover:bg-secondary"
                  aria-label="Settings"
                  nativeButton={false}
                  render={
                    <Link href="/settings">
                      <Settings className="size-5" />
                    </Link>
                  }
                />
              </div>
            </>
          )}
        </div>

        {/* Search + view toggle */}
        {documents.length > 0 ? (
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search documents"
                aria-label="Search documents"
                className="h-10 w-full rounded-xl border border-border bg-secondary pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
            </div>
            <div className="flex h-10 items-center rounded-xl border border-border bg-secondary p-1">
              {(
                [
                  ["grid", "Grid view", LayoutGrid],
                  ["list", "List view", List],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => update({ libraryView: value })}
                  aria-label={label}
                  aria-pressed={view === value}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg transition-colors",
                    view === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
                  )}
                >
                  <Icon className="size-4" />
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </header>

      {/* Content */}
      <div className="flex-1 px-4 pb-28 pt-2">
        {error ? (
          <p role="alert" className="py-12 text-center text-sm text-destructive">
            {error}
          </p>
        ) : !ready ? (
          <div className="flex justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : documents.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-20 text-center">
            <span className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <FileText className="size-8" />
            </span>
            <h2 className="text-base font-semibold">No documents yet</h2>
            <p className="mt-1 max-w-xs text-sm text-muted-foreground">
              Scan a page and it&apos;s saved here, on this device only.
            </p>
            <Button className="mt-6 h-11 gap-2 rounded-xl px-5" onClick={() => router.push("/scan")}>
              <Camera className="size-4" />
              Scan a document
            </Button>
          </div>
        ) : (
          <section>
            <h2 className="mb-3 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {query ? `Results · ${docs.length}` : `All documents · ${documents.length}`}
            </h2>
            {docs.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">No documents match “{query}”</p>
            ) : (
              <div className={cn(view === "grid" ? "grid grid-cols-2 gap-3" : "flex flex-col gap-2")}>
                {docs.map((d) => (
                  <DocCard
                    key={d.id}
                    doc={d}
                    view={view}
                    selectionMode={selectionMode}
                    selected={selected.has(d.id)}
                    onOpen={() => router.push(`/doc?id=${encodeURIComponent(d.id)}`)}
                    onToggle={() => toggle(d.id)}
                    onLongPress={() => (selectionMode ? toggle(d.id) : enterSelection(d.id))}
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {notice ? (
        <div
          role="alert"
          className="fixed inset-x-4 bottom-28 z-40 mx-auto max-w-sm rounded-xl bg-rose-600/90 px-4 py-2.5 text-center text-sm font-medium text-white shadow-lg"
        >
          {notice}
        </div>
      ) : null}

      {/* Bottom: selection bar or FAB */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30">
        {selectionMode ? (
          <SelectionBar count={selected.size} busy={busy} onAction={handleAction} />
        ) : documents.length > 0 ? (
          <div className="mx-auto flex max-w-md justify-end p-5" style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}>
            <button
              onClick={() => router.push("/scan")}
              className="pointer-events-auto flex size-14 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xl shadow-primary/30"
              aria-label="New scan"
            >
              <Camera className="size-6" />
            </button>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirm === "delete"}
        title={selected.size === 1 ? "Delete this document?" : `Delete ${selected.size} documents?`}
        description={`${pluralPages(selectedPages)} will be permanently removed from this device.`}
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={runConfirmed}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "merge"}
        title={`Merge ${selected.size} documents?`}
        description="Pages are combined into the first selected document, in the order shown. The other documents are removed."
        confirmLabel="Merge"
        busy={busy}
        onConfirm={runConfirmed}
        onCancel={() => setConfirm(null)}
      />
    </main>
  )
}
