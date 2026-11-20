"use client"

import { Layers, Share2, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"

export type SelectionAction = "merge" | "share" | "delete"

export function SelectionBar({
  count,
  busy = false,
  onAction,
}: {
  count: number
  busy?: boolean
  onAction: (action: SelectionAction) => void
}) {
  const actions: { id: SelectionAction; label: string; icon: typeof Layers; enabled: boolean; danger?: boolean }[] = [
    { id: "merge", label: "Merge", icon: Layers, enabled: count >= 2 },
    { id: "share", label: "Share PDF", icon: Share2, enabled: count === 1 },
    { id: "delete", label: "Delete", icon: Trash2, enabled: count >= 1, danger: true },
  ]

  return (
    <div className="pointer-events-auto mx-auto w-full max-w-md" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="m-3 rounded-2xl border border-border bg-card/95 p-2 shadow-2xl shadow-black/40 backdrop-blur">
        <div className="grid grid-cols-3 gap-1">
          {actions.map((a) => {
            const Icon = a.icon
            const disabled = busy || !a.enabled
            return (
              <button
                key={a.id}
                type="button"
                disabled={disabled}
                onClick={() => onAction(a.id)}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-xl px-1 py-2.5 text-[11px] font-medium transition-colors",
                  a.danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-secondary",
                  disabled && "pointer-events-none opacity-40",
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
