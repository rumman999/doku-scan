"use client"

import { useState } from "react"
import Link from "next/link"
import {
  ArrowLeft,
  ChevronRight,
  LogOut,
  CloudUpload,
  Wifi,
  Check,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type Quality = "high" | "medium" | "low"
type Format = "pdf" | "jpeg"

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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h2>
  )
}

/* Cloud provider logo marks (simple, brand-neutral glyphs) */
function GoogleDriveMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <path d="M8.4 3.5h7.2l7.2 12.5h-7.2L8.4 3.5Z" fill="currentColor" opacity="0.55" />
      <path d="M1.2 16 4.8 9.75 12 22.25l-3.6.0L1.2 16Z" fill="currentColor" opacity="0.85" />
      <path d="M8.4 22.25 15.6 16h7.2l-3.6 6.25H8.4Z" fill="currentColor" opacity="0.4" />
    </svg>
  )
}

function OneDriveMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <path
        d="M10.5 7.2a5 5 0 0 1 8.7 2.1 3.8 3.8 0 0 1-.4 7.5H7a4.2 4.2 0 0 1-.9-8.3 5 5 0 0 1 4.4-1.3Z"
        fill="currentColor"
      />
    </svg>
  )
}

function CloudProvider({
  name,
  detail,
  mark,
  connected,
  onToggle,
}: {
  name: string
  detail: string
  mark: React.ReactNode
  connected: boolean
  onToggle: () => void
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground">
        {mark}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        <p className="truncate text-xs text-muted-foreground">{connected ? detail : "Not connected"}</p>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold transition-colors",
          connected
            ? "bg-secondary text-foreground"
            : "bg-primary text-primary-foreground hover:opacity-90",
        )}
      >
        {connected ? (
          <>
            <Check className="size-3.5" />
            Linked
          </>
        ) : (
          "Connect"
        )}
      </button>
    </div>
  )
}

function ToggleRow({
  icon,
  title,
  subtitle,
  checked,
  onChange,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </div>
  )
}

function PrefRow({
  title,
  value,
  onCycle,
}: {
  title: string
  value: string
  onCycle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onCycle}
      className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-secondary/50"
    >
      <span className="flex-1 text-sm font-medium text-foreground">{title}</span>
      <span className="text-sm text-muted-foreground">{value}</span>
      <ChevronRight className="size-4 text-muted-foreground" />
    </button>
  )
}

function Divider() {
  return <div className="mx-4 h-px bg-border" />
}

export default function SettingsPage() {
  const [driveConnected, setDriveConnected] = useState(true)
  const [oneDriveConnected, setOneDriveConnected] = useState(false)
  const [autoUpload, setAutoUpload] = useState(true)
  const [wifiOnly, setWifiOnly] = useState(true)

  const qualities: Quality[] = ["high", "medium", "low"]
  const formats: Format[] = ["pdf", "jpeg"]
  const [quality, setQuality] = useState<Quality>("high")
  const [format, setFormat] = useState<Format>("pdf")

  const qualityLabel = { high: "High", medium: "Medium", low: "Low" }[quality]
  const formatLabel = { pdf: "PDF", jpeg: "JPEG" }[format]

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-20 flex items-center gap-1 bg-background/90 px-2 py-3 backdrop-blur">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-foreground hover:bg-secondary"
          aria-label="Go back"
          nativeButton={false}
          render={
            <Link href="/">
              <ArrowLeft className="size-5" />
            </Link>
          }
        />
        <h1 className="text-lg font-semibold">Settings</h1>
      </header>

      <div className="scrollbar-hidden flex-1 overflow-y-auto px-4 pb-10 pt-2">
        {/* Account */}
        <section className="mb-7">
          <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/15 text-base font-semibold text-primary">
              AM
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-foreground">Alex Morgan</p>
              <p className="truncate text-xs text-muted-foreground">alex.morgan@example.com</p>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
            >
              Switch
            </button>
          </div>
        </section>

        {/* Cloud Destination */}
        <section className="mb-7">
          <SectionLabel>Cloud Destination</SectionLabel>
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <CloudProvider
              name="Google Drive"
              detail="Scans · /Documents"
              mark={<GoogleDriveMark />}
              connected={driveConnected}
              onToggle={() => setDriveConnected((v) => !v)}
            />
            <Divider />
            <CloudProvider
              name="Microsoft OneDrive"
              detail="Synced"
              mark={<OneDriveMark />}
              connected={oneDriveConnected}
              onToggle={() => setOneDriveConnected((v) => !v)}
            />
            <Divider />
            <ToggleRow
              icon={<CloudUpload className="size-4" />}
              title="Auto-upload new scans"
              subtitle="Send scans to your linked cloud"
              checked={autoUpload}
              onChange={setAutoUpload}
            />
            <Divider />
            <ToggleRow
              icon={<Wifi className="size-4" />}
              title="Sync over Wi-Fi only"
              subtitle="Avoid using mobile data"
              checked={wifiOnly}
              onChange={setWifiOnly}
            />
          </div>
          <p className="mt-2 px-1 text-[11px] leading-relaxed text-muted-foreground">
            Files upload directly to your personal cloud. We never store your documents on our
            servers.
          </p>
        </section>

        {/* App Preferences */}
        <section className="mb-7">
          <SectionLabel>App Preferences</SectionLabel>
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <PrefRow
              title="Default Scan Quality"
              value={qualityLabel}
              onCycle={() =>
                setQuality(qualities[(qualities.indexOf(quality) + 1) % qualities.length])
              }
            />
            <Divider />
            <PrefRow
              title="Default Export Format"
              value={formatLabel}
              onCycle={() => setFormat(formats[(formats.indexOf(format) + 1) % formats.length])}
            />
          </div>
        </section>

        {/* Session */}
        <section className="mb-6">
          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-border bg-card py-3.5 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/5"
          >
            <LogOut className="size-4" />
            Sign Out
          </button>
        </section>

        <p className="text-center text-[11px] text-muted-foreground">Scanner · v1.0.0 · Open Source</p>
      </div>
    </main>
  )
}
