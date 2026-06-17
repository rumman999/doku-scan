"use client"

import { cn } from "@/lib/utils"

export type FilterOption = {
  id: string
  label: string
  css: string
}

export const FILTERS: FilterOption[] = [
  { id: "original", label: "Original", css: "none" },
  { id: "magic", label: "Magic Color", css: "saturate(1.35) contrast(1.15) brightness(1.08)" },
  { id: "bw", label: "Sharp B&W", css: "grayscale(1) contrast(1.7) brightness(1.1)" },
  { id: "eco", label: "Eco Grayscale", css: "grayscale(0.85) brightness(1.12) contrast(0.95)" },
]

export function FilterBar({
  active,
  onChange,
}: {
  active: string
  onChange: (id: string) => void
}) {
  return (
    <div className="w-full">
      <h2 className="mb-3 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Filters
      </h2>
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {FILTERS.map((f) => {
          const isActive = f.id === active
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => onChange(f.id)}
              aria-pressed={isActive}
              className="flex shrink-0 flex-col items-center gap-2 focus:outline-none"
            >
              <span
                className={cn(
                  "relative block h-20 w-16 overflow-hidden rounded-lg border-2 transition-colors",
                  isActive ? "border-primary" : "border-border",
                )}
              >
                <img
                  src="/document-scan.png"
                  alt=""
                  aria-hidden
                  className="h-full w-full object-cover"
                  style={{ filter: f.css }}
                  draggable={false}
                />
              </span>
              <span
                className={cn(
                  "text-[11px] font-medium leading-tight",
                  isActive ? "text-primary" : "text-muted-foreground",
                )}
              >
                {f.label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
