"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { X, FileDown, ShieldCheck, ImageIcon, FileText, Stamp, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type PageSize = "a4" | "letter" | "auto"
type Quality = "high" | "medium" | "low"

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
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span
        className={cn(
          "inline-block size-5 transform rounded-full bg-card shadow-sm transition-transform duration-200",
          checked ? "translate-x-5" : "translate-x-0.5",
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

export function PdfExportSheet({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [mounted, setMounted] = useState(false)
  const [visible, setVisible] = useState(false)

  const [pageSize, setPageSize] = useState<PageSize>("a4")
  const [quality, setQuality] = useState<Quality>("high")
  const [watermarkOn, setWatermarkOn] = useState(false)
  const [watermarkText, setWatermarkText] = useState("")
  const [passwordOn, setPasswordOn] = useState(false)
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => setMounted(true), [])

  // Animate in/out and lock body scroll
  useEffect(() => {
    if (open) {
      setVisible(true)
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
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!mounted) return null

  const passwordMismatch = passwordOn && confirm.length > 0 && password !== confirm
  const canGenerate =
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
        onClick={onClose}
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
              onClick={onClose}
            >
              <X className="size-5" />
            </Button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-5 pb-4">
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
              {watermarkOn ? (
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
              ) : null}
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
              {passwordOn ? (
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
              ) : null}
            </div>
          </div>
        </div>

        {/* Sticky generate button */}
        <div
          className="shrink-0 border-t border-border bg-background px-5 pt-3"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <Button
            size="lg"
            disabled={!canGenerate}
            onClick={onClose}
            className="h-13 w-full gap-2 rounded-2xl py-3.5 text-base font-semibold shadow-lg shadow-primary/25"
          >
            <FileDown className="size-5" />
            Generate PDF
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
