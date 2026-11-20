"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { X, FileDown, ShieldCheck, ImageIcon, FileText, Stamp, Eye, EyeOff, Loader2, Layers } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SortablePageGrid } from "@/components/sortable-page-grid"
import type { BatchPage } from "@/hooks/use-scan-batch"
import {
  buildPdf,
  defaultPdfFilename,
  deliverPdf,
  type DeliveryResult,
  type PageSize,
  type Quality,
} from "@/lib/pdf/export-pdf"
import { cn } from "@/lib/utils"
import { loadSettings } from "@/lib/settings"

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-300 ease-in-out outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        checked ? "border-primary bg-primary" : "border-border bg-secondary",
      )}
    >
      <span
        className={cn(
          "inline-block size-4 transform rounded-full bg-card shadow-sm ring-1 ring-foreground/10 transition-transform duration-300 ease-in-out",
          checked ? "translate-x-[22px]" : "translate-x-0.5",
        )}
      />
    </button>
  )
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-lg bg-secondary p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            value === opt.value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function Row({
  icon,
  title,
  description,
  children,
  stacked,
}: {
  icon?: React.ReactNode
  title: string
  description?: string
  children?: React.ReactNode
  stacked?: boolean
}) {
  return (
    <div
      className={cn(
        "flex gap-3 px-4 py-3.5",
        stacked ? "flex-col" : "items-center justify-between",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        {icon ? <span className="mt-0.5 text-muted-foreground">{icon}</span> : null}
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      {children ? <div className={cn(stacked && "w-full")}>{children}</div> : null}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1 pb-2 pt-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  )
}

function Reveal({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      aria-hidden={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className={cn("min-h-0 overflow-hidden", !open && "pointer-events-none")}>{children}</div>
    </div>
  )
}

export function PdfExportSheet({
  open,
  onClose,
  pages,
  onReorder,
  onRemove,
  onExported,
  filename,
  showPages = true,
}: {
  open: boolean
  onClose: () => void
  pages: BatchPage[]
  onReorder: (orderedIds: string[]) => void
  onRemove: (id: string) => void
  onExported?: (result: DeliveryResult) => void
  /** Output file name (".pdf" included). Defaults to a timestamped name. */
  filename?: string
  /** Hide the page grid when the caller already shows the pages. */
  showPages?: boolean
}) {
  const [mounted, setMounted] = useState(false)

  const [pageSize, setPageSize] = useState<PageSize>("a4")
  const [quality, setQuality] = useState<Quality>("high")
  const [watermarkOn, setWatermarkOn] = useState(false)
  const [watermarkText, setWatermarkText] = useState("")
  const [passwordOn, setPasswordOn] = useState(false)
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const exporting = progress !== null

  useEffect(() => setMounted(true), [])

  // Each time the sheet opens, start from the user's saved PDF defaults.
  useEffect(() => {
    if (!open) return
    const s = loadSettings()
    setPageSize(s.pdfPageSize)
    setQuality(s.pdfQuality)
    setExportError(null)
  }, [open])

  // Lock body scroll while open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden"
    } else {
      document.body.style.overflow = ""
    }
    return () => {
      document.body.style.overflow = ""
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !exporting) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose, exporting])

  if (!mounted) return null

  async function handleGenerate() {
    setExportError(null)
    setProgress({ done: 0, total: pages.length })
    try {
      const name = filename ?? defaultPdfFilename()
      const blob = await buildPdf(
        pages,
        {
          pageSize,
          quality,
          watermark: watermarkOn ? watermarkText : undefined,
          password: passwordOn ? password : undefined,
        },
        setProgress,
      )
      const result = await deliverPdf(blob, name)
      onExported?.(result)
      if (result !== "cancelled") onClose()
    } catch (err) {
      console.error("[PDF Export]", err)
      setExportError(err instanceof Error ? err.message : "Export failed")
    } finally {
      setProgress(null)
    }
  }

  const passwordMismatch = passwordOn && confirm.length > 0 && password !== confirm
  const canGenerate =
    pages.length > 0 &&
    !exporting &&
    (!watermarkOn || watermarkText.trim().length > 0) &&
    (!passwordOn || (password.length >= 4 && password === confirm))

  return createPortal(
    <div
      aria-hidden={!open}
      className={cn(
        "fixed inset-0 z-50 transition-opacity duration-300",
        open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={exporting ? undefined : onClose}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-sm"
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="PDF Export and Security settings"
        className={cn(
          "absolute inset-x-0 bottom-0 mx-auto flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-3xl border border-border bg-background shadow-2xl transition-transform duration-300 ease-out",
          open ? "translate-y-0" : "translate-y-full",
        )}
      >
        {/* Grabber + header */}
        <div className="shrink-0 px-5 pt-3">
          <div className="mx-auto h-1.5 w-10 rounded-full bg-input" />
          <div className="flex items-center justify-between py-3">
            <div>
              <h2 className="text-lg font-bold tracking-tight text-foreground">Export PDF</h2>
              <p className="text-xs text-muted-foreground">Configure output and security</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full hover:bg-secondary"
              aria-label="Close"
              disabled={exporting}
              onClick={onClose}
            >
              <X className="size-5" />
            </Button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="scrollbar-minimal flex-1 overflow-y-auto px-5 pb-4">
          {/* Pages section */}
          {showPages ? (
          <>
          <div className="flex items-baseline justify-between">
            <SectionLabel>
              Pages{pages.length > 0 ? ` · ${pages.length}` : ""}
            </SectionLabel>
            {pages.length > 1 ? (
              <p className="px-1 pb-2 text-[11px] text-muted-foreground">Hold &amp; drag to reorder</p>
            ) : null}
          </div>
          <div
            aria-busy={exporting}
            className={cn(
              "mb-5 rounded-2xl border border-border bg-card p-3",
              // Removing/reordering mid-export would make buildPdf read a page that no longer exists.
              exporting && "pointer-events-none opacity-60",
            )}
          >
            {pages.length > 0 ? (
              <SortablePageGrid pages={pages} onReorder={onReorder} onRemove={onRemove} />
            ) : (
              <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
                <Layers className="size-6" />
                <p className="text-sm">No pages scanned yet</p>
              </div>
            )}
          </div>
          </>
          ) : null}

          {/* Document section */}
          <SectionLabel>Document</SectionLabel>
          <div className="divide-y divide-border rounded-2xl border border-border bg-card">
            <Row icon={<FileText className="size-4" />} title="Page Size" description="Output dimensions">
              <SegmentedControl
                value={pageSize}
                onChange={setPageSize}
                options={[
                  { value: "a4", label: "A4" },
                  { value: "letter", label: "Letter" },
                  { value: "auto", label: "Auto" },
                ]}
              />
            </Row>
            <Row
              icon={<ImageIcon className="size-4" />}
              title="Image Compression"
              description="Higher quality means larger files"
            >
              <SegmentedControl
                value={quality}
                onChange={setQuality}
                options={[
                  { value: "high", label: "High" },
                  { value: "medium", label: "Med" },
                  { value: "low", label: "Low" },
                ]}
              />
            </Row>
          </div>

          {/* Watermark section */}
          <div className="mt-5">
            <SectionLabel>Branding</SectionLabel>
            <div className="rounded-2xl border border-border bg-card">
              <Row icon={<Stamp className="size-4" />} title="Add Custom Watermark" description="Stamp text across each page">
                <Toggle checked={watermarkOn} onChange={setWatermarkOn} label="Toggle watermark" />
              </Row>
              <Reveal open={watermarkOn}>
                <div className="px-4 pb-4">
                  <input
                    type="text"
                    value={watermarkText}
                    onChange={(e) => setWatermarkText(e.target.value)}
                    placeholder="e.g. CONFIDENTIAL"
                    maxLength={40}
                    className="w-full rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/40"
                  />
                  <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
                    {watermarkText.length}/40 characters
                  </p>
                </div>
              </Reveal>
            </div>
          </div>

          {/* Security section */}
          <div className="mt-5">
            <SectionLabel>Security</SectionLabel>
            <div className="rounded-2xl border border-border bg-card">
              <Row
                icon={<ShieldCheck className="size-4" />}
                title="Require Password to Open PDF"
                description="Recipients must enter a password"
              >
                <Toggle checked={passwordOn} onChange={setPasswordOn} label="Toggle password protection" />
              </Row>
              <Reveal open={passwordOn}>
                <div className="flex flex-col gap-3 px-4 pb-4">
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Password"
                      className="w-full rounded-xl border border-input bg-background px-3.5 py-2.5 pr-11 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/40"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                  <input
                    type={showPassword ? "text" : "password"}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Confirm password"
                    className={cn(
                      "w-full rounded-xl border bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:ring-2",
                      passwordMismatch
                        ? "border-destructive focus:border-destructive focus:ring-destructive/30"
                        : "border-input focus:border-ring focus:ring-ring/40",
                    )}
                  />
                  {passwordMismatch ? (
                    <p className="px-1 text-[11px] font-medium text-destructive">Passwords do not match</p>
                  ) : (
                    <p className="px-1 text-[11px] text-muted-foreground">Use at least 4 characters</p>
                  )}
                </div>
              </Reveal>
            </div>
          </div>
        </div>

        {/* Sticky generate button */}
        <div
          className="shrink-0 border-t border-border bg-background px-5 pt-3"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          {exportError ? (
            <p role="alert" className="mb-2 px-1 text-xs font-medium text-destructive">
              {exportError}
            </p>
          ) : null}
          <Button
            size="lg"
            disabled={!canGenerate}
            onClick={handleGenerate}
            className="relative h-13 w-full gap-2 overflow-hidden rounded-2xl py-3.5 text-base font-semibold shadow-lg shadow-primary/25"
          >
            {progress ? (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-primary-foreground/15 transition-[width] duration-200"
                style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
              />
            ) : null}
            {progress ? <Loader2 className="size-5 animate-spin" /> : <FileDown className="size-5" />}
            <span aria-live="polite">
              {progress
                ? progress.done < progress.total
                  ? `Processing page ${progress.done + 1} of ${progress.total}`
                  : "Finalizing PDF…"
                : `Generate PDF${pages.length > 1 ? ` (${pages.length} pages)` : ""}`}
            </span>
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
