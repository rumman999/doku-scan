"use client"

import { Layers, Share2, FolderInput, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"

const ACTIONS = [
  { id: "merge", label: "Merge", icon: Layers },
  { id: "share", label: "Share PDF", icon: Share2 },
  { id: "move", label: "Move", icon: FolderInput },
  { id: "delete", label: "Delete", icon: Trash2, danger: true },
]

export function SelectionBar({ count }: { count: number }) {
  return (
    <div className="pointer-events-auto mx-auto w-full max-w-md">
      <div className="m-3 rounded-2xl border border-border bg-card/95 p-2 shadow-2xl shadow-black/40 backdrop-blur">
        <div className="grid grid-cols-4 gap-1">
          {ACTIONS.map((a) => {
            const Icon = a.icon
            const disabled = a.id === "merge" && count < 2
            return (
              <button
                key={a.id}
                type="button"
                disabled={disabled}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-xl px-1 py-2.5 text-[11px] font-medium transition-colors",
                  a.danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-secondary",
                  disabled && "opacity-40",
                )}
              >
                <Icon className="size-5" />
                {a.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
