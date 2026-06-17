import { Folder } from "lucide-react"
import type { DocFolder } from "@/lib/library-data"

export function FolderCard({ folder, view }: { folder: DocFolder; view: "grid" | "list" }) {
  if (view === "list") {
    return (
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-secondary"
      >
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `color-mix(in oklch, ${folder.accent} 22%, transparent)` }}
        >
          <Folder className="size-5" style={{ color: folder.accent }} fill={folder.accent} />
        </span>
        <span className="flex flex-1 flex-col">
          <span className="text-sm font-medium text-foreground">{folder.name}</span>
          <span className="text-xs text-muted-foreground">{folder.count} documents</span>
        </span>
      </button>
    )
  }

  return (
    <button
      type="button"
      className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-secondary"
    >
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: `color-mix(in oklch, ${folder.accent} 22%, transparent)` }}
      >
        <Folder className="size-5" style={{ color: folder.accent }} fill={folder.accent} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{folder.name}</span>
        <span className="text-xs text-muted-foreground">{folder.count}</span>
      </span>
    </button>
  )
}
