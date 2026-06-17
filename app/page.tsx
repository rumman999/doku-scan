"use client"

import { useState } from "react"
import Link from "next/link"
import { Search, LayoutGrid, List, Camera, X, Settings } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { FOLDERS, DOCUMENTS } from "@/lib/library-data"
import { FolderCard } from "@/components/folder-card"
import { DocCard } from "@/components/doc-card"
import { SelectionBar } from "@/components/selection-bar"

export default function LibraryPage() {
  const [view, setView] = useState<"grid" | "list">("grid")
  const [query, setQuery] = useState("")
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const docs = DOCUMENTS.filter((d) => d.name.toLowerCase().includes(query.toLowerCase()))
  const folders = query
    ? FOLDERS.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()))
    : FOLDERS

  function enterSelection(id: string) {
    setSelectionMode(true)
    setSelected(new Set([id]))
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exitSelection() {
    setSelectionMode(false)
    setSelected(new Set())
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-background/90 px-4 pb-3 pt-4 backdrop-blur">
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
                onClick={() =>
                  setSelected(
                    selected.size === docs.length ? new Set() : new Set(docs.map((d) => d.id)),
                  )
                }
              >
                {selected.size === docs.length ? "None" : "All"}
              </Button>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold tracking-tight">Documents</h1>
              <Button
                variant="ghost"
                size="icon"
                className="-mr-2 rounded-full hover:bg-secondary"
                aria-label="Settings"
              >
                <Settings className="size-5" />
              </Button>
            </>
          )}
        </div>

        {/* Search + view toggle */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search documents"
              className="h-10 w-full rounded-xl border border-border bg-secondary pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
          </div>
          <div className="flex h-10 items-center rounded-xl border border-border bg-secondary p-1">
            <button
              type="button"
              onClick={() => setView("grid")}
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              className={cn(
                "flex size-8 items-center justify-center rounded-lg transition-colors",
                view === "grid" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
              )}
            >
              <LayoutGrid className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setView("list")}
              aria-label="List view"
              aria-pressed={view === "list"}
              className={cn(
                "flex size-8 items-center justify-center rounded-lg transition-colors",
                view === "list" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
              )}
            >
              <List className="size-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 px-4 pb-28 pt-2">
        {/* Folders */}
        {folders.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-3 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Folders
            </h2>
            <div className={cn(view === "grid" ? "grid grid-cols-2 gap-3" : "flex flex-col gap-2")}>
              {folders.map((f) => (
                <FolderCard key={f.id} folder={f} view={view} />
              ))}
            </div>
          </section>
        )}

        {/* Documents */}
        <section>
          <h2 className="mb-3 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Recent Scans
          </h2>
          {docs.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">No documents found</p>
          ) : (
            <div className={cn(view === "grid" ? "grid grid-cols-2 gap-3" : "flex flex-col gap-2")}>
              {docs.map((d) => (
                <DocCard
                  key={d.id}
                  doc={d}
                  view={view}
                  selectionMode={selectionMode}
                  selected={selected.has(d.id)}
                  onToggle={() => toggle(d.id)}
                  onLongPress={() => enterSelection(d.id)}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Bottom: selection bar or FAB */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30">
        {selectionMode ? (
          <SelectionBar count={selected.size} />
        ) : (
          <div className="mx-auto flex max-w-md justify-end p-5">
            <Button
              size="icon"
              className="pointer-events-auto size-14 rounded-full shadow-xl shadow-primary/30"
              aria-label="New scan"
              nativeButton={false}
              render={
                <Link href="/scan">
                  <Camera className="size-6" />
                </Link>
              }
            />
          </div>
        )}
      </div>
    </main>
  )
}
