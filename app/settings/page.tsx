"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useTheme } from "next-themes"
import { ArrowLeft, HardDrive, ShieldCheck, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { cn } from "@/lib/utils"
import { useSettings } from "@/lib/settings"
import { deleteAllData, listDocuments } from "@/lib/db/indexed-db"
import { formatBytes, pluralPages } from "@/lib/format"

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{children}</h2>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">{children}</div>
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-lg bg-secondary p-0.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={value === opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
              value === opt.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function SwitchRow({
  title,
  subtitle,
  checked,
  onChange,
}: {
  title: string
  subtitle: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-300 outline-none focus-visible:ring-2 focus-visible:ring-ring",
          checked ? "border-primary bg-primary" : "border-border bg-secondary",
        )}
      >
        <span
          className={cn(
            "inline-block size-4 rounded-full bg-card shadow-sm ring-1 ring-foreground/10 transition-transform duration-300",
            checked ? "translate-x-[22px]" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  )
}

export default function SettingsPage() {
  const { settings, update } = useSettings()
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [storage, setStorage] = useState<{ docs: number; pages: number; bytes: number | null } | null>(null)
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [wiping, setWiping] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const loadStorage = useCallback(async () => {
    try {
      const docs = await listDocuments()
      const estimate = await navigator.storage?.estimate?.().catch(() => undefined)
      setStorage({
        docs: docs.length,
        pages: docs.reduce((n, d) => n + d.pageCount, 0),
        bytes: estimate?.usage ?? null,
      })
    } catch (err) {
      console.error("[Settings] storage info failed", err)
    }
  }, [])

  useEffect(() => {
    setMounted(true)
    loadStorage()
  }, [loadStorage])

  const wipe = async () => {
    setWiping(true)
    try {
      await deleteAllData()
      setNotice("All documents deleted")
      await loadStorage()
    } catch (err) {
      console.error("[Settings] delete all failed", err)
      setNotice("Couldn't delete documents")
    } finally {
      setWiping(false)
      setConfirmWipe(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-background text-foreground">
      <header
        className="sticky top-0 z-20 flex items-center gap-1 bg-background/90 px-2 pb-3 backdrop-blur"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
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

      <div className="flex-1 space-y-7 px-4 pb-10 pt-2">
        <section>
          <SectionLabel>Appearance</SectionLabel>
          <Card>
            <Segmented
              label="Theme"
              value={(mounted ? theme : "system") as "system" | "light" | "dark"}
              onChange={setTheme}
              options={[
                { value: "system", label: "Auto" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </Card>
        </section>

        <section>
          <SectionLabel>Scanning</SectionLabel>
          <Card>
            <Segmented
              label="Default filter"
              value={settings.defaultFilter}
              onChange={(v) => update({ defaultFilter: v })}
              options={[
                { value: "magic-color", label: "Magic" },
                { value: "bw", label: "B&W" },
                { value: "none", label: "Original" },
              ]}
            />
            <Segmented
              label="Start in"
              value={settings.defaultMode}
              onChange={(v) => update({ defaultMode: v })}
              options={[
                { value: "single", label: "Single" },
                { value: "batch", label: "Batch" },
              ]}
            />
            <SwitchRow
              title="Auto-capture"
              subtitle="Take the photo when the page holds still"
              checked={settings.autoCapture}
              onChange={(v) => update({ autoCapture: v })}
            />
          </Card>
        </section>

        <section>
          <SectionLabel>PDF export</SectionLabel>
          <Card>
            <Segmented
              label="Page size"
              value={settings.pdfPageSize}
              onChange={(v) => update({ pdfPageSize: v })}
              options={[
                { value: "a4", label: "A4" },
                { value: "letter", label: "Letter" },
                { value: "auto", label: "Auto" },
              ]}
            />
            <Segmented
              label="Image quality"
              value={settings.pdfQuality}
              onChange={(v) => update({ pdfQuality: v })}
              options={[
                { value: "high", label: "High" },
                { value: "medium", label: "Med" },
                { value: "low", label: "Low" },
              ]}
            />
          </Card>
        </section>

        <section>
          <SectionLabel>Storage</SectionLabel>
          <Card>
            <div className="flex items-center gap-3 px-4 py-3.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                <HardDrive className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {storage
                    ? `${storage.docs} ${storage.docs === 1 ? "document" : "documents"} · ${pluralPages(storage.pages)}`
                    : "Calculating…"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {storage?.bytes != null ? `${formatBytes(storage.bytes)} used on this device` : "Stored on this device"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setConfirmWipe(true)}
              disabled={!storage || storage.docs === 0}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm font-medium text-destructive transition-colors hover:bg-destructive/5 disabled:pointer-events-none disabled:opacity-40"
            >
              <Trash2 className="size-4" />
              Delete all documents
            </button>
          </Card>
          {notice ? (
            <p role="status" className="mt-2 px-1 text-xs text-muted-foreground">
              {notice}
            </p>
          ) : null}
        </section>

        <section>
          <div className="flex gap-3 rounded-2xl border border-border bg-card p-4">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Doku Scan works fully offline. Your scans never leave this device unless you share or
              export them yourself. No account, no cloud, no tracking.
            </p>
          </div>
        </section>

        <p className="text-center text-[11px] text-muted-foreground">Doku Scan · v{process.env.NEXT_PUBLIC_APP_VERSION}</p>
      </div>

      <ConfirmDialog
        open={confirmWipe}
        title="Delete all documents?"
        description={
          storage
            ? `${storage.docs} ${storage.docs === 1 ? "document" : "documents"} (${pluralPages(storage.pages)}) will be permanently removed from this device. This can't be undone.`
            : undefined
        }
        confirmLabel="Delete all"
        destructive
        busy={wiping}
        onConfirm={wipe}
        onCancel={() => setConfirmWipe(false)}
      />
    </main>
  )
}
