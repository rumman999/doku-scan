"use client"

import { useState } from "react"
import { ArrowLeft, Settings, FileDown, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CropView } from "@/components/crop-view"
import { FilterBar } from "@/components/filter-bar"

export default function Page() {
  const [filter, setFilter] = useState("original")
  const [resetKey, setResetKey] = useState(0)

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-background text-foreground">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-foreground hover:bg-secondary"
          aria-label="Go back"
        >
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="text-base font-semibold">Adjust Document</h1>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-foreground hover:bg-secondary"
          aria-label="Settings"
        >
          <Settings className="size-5" />
        </Button>
      </header>

      {/* Document adjustment view */}
      <section className="flex flex-1 flex-col gap-6 px-4 pb-4">
        <div className="flex flex-col gap-3">
          <CropView key={resetKey} filter={filter} />
          <p className="text-center text-xs text-muted-foreground">
            Drag the corners to align the document edges
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mx-auto rounded-full"
            onClick={() => setResetKey((k) => k + 1)}
          >
            <RotateCcw className="size-4" />
            Reset crop
          </Button>
        </div>

        {/* Filter toolbar */}
        <FilterBar active={filter} onChange={setFilter} />
      </section>

      {/* Floating action button */}
      <div className="pointer-events-none sticky bottom-0 z-10 flex justify-end p-5">
        <Button
          size="lg"
          className="pointer-events-auto h-14 gap-2 rounded-full px-6 text-base font-semibold shadow-xl shadow-primary/30"
        >
          <FileDown className="size-5" />
          Save PDF
        </Button>
      </div>
    </main>
  )
}
