"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { Check, CloudUpload, FolderOpen, FolderPlus, Loader2, RefreshCw, TriangleAlert, X } from "lucide-react"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { cn } from "@/lib/utils"
import { formatDocDate } from "@/lib/format"
import {
  connectDrive,
  disconnectDrive,
  linkFolder,
  runBackup,
  setAutoBackup,
  useBackup,
  type FolderChoice,
} from "@/lib/drive/backup"
import type { SyncResult } from "@/lib/drive/sync"

function DriveMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <path d="M8.4 3.5h7.2l7.2 12.5h-7.2L8.4 3.5Z" fill="currentColor" opacity="0.55" />
      <path d="M1.2 16 4.8 9.75 12 22.25H8.4L1.2 16Z" fill="currentColor" opacity="0.85" />
      <path d="M8.4 22.25 15.6 16h7.2l-3.6 6.25H8.4Z" fill="currentColor" opacity="0.4" />
    </svg>
  )
}

function summarize(r: SyncResult): string {
  const parts: string[] = []
  if (r.downloaded) parts.push(`restored ${r.downloaded}`)
  if (r.uploaded) parts.push(`backed up ${r.uploaded}`)
  if (r.trashed) parts.push(`removed ${r.trashed}`)
  const head = parts.length ? `Done: ${parts.join(", ")} document${r.downloaded + r.uploaded + r.trashed === 1 ? "" : "s"}` : "Everything is already backed up"
  return r.errors.length ? `${head}. ${r.errors.length} couldn't sync.` : head
}

const PHASE_LABEL = { checking: "Checking backup…", uploading: "Uploading", downloading: "Restoring", cleaning: "Cleaning up" } as const

/** "Back up to Google Drive" card for the settings page. */
export function BackupSettings() {
  const { link, running, progress, configured } = useBackup()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)
  const [picker, setPicker] = useState<{ email: string | null; folders: FolderChoice[] } | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  const act = async (fn: () => Promise<string | void>) => {
    setBusy(true)
    setMessage(null)
    try {
      const text = await fn()
      if (text) setMessage({ text })
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Something went wrong", error: true })
    } finally {
      setBusy(false)
    }
  }

  if (!configured) {
    return (
      <div className="flex gap-3 rounded-2xl border border-border bg-card p-4">
        <span className="mt-0.5 text-muted-foreground">
          <DriveMark />
        </span>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Google Drive backup isn&apos;t set up in this build. Add a Google OAuth client id
          (<code className="font-mono">NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID</code>) and rebuild. See the README.
        </p>
      </div>
    )
  }

  const statusLine = running
    ? progress && progress.total > 0 && progress.phase !== "checking"
      ? `${PHASE_LABEL[progress.phase]} ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
      : PHASE_LABEL.checking
    : link?.lastError
      ? link.lastError
      : link?.lastSyncAt
        ? `Last backup ${formatDocDate(link.lastSyncAt).replace(/^Today, /, "today at ").replace(/^Yesterday, /, "yesterday at ")}`
        : "Not backed up yet"

  return (
    <>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {!link ? (
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground">
                <DriveMark />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Back up to Google Drive</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Keep a copy of every document in a folder you choose. After reinstalling, connect the same
                  folder to get everything back. Doku Scan can only see files it creates.
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  setPicker(await connectDrive())
                })
              }
              className="flex h-11 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground active:opacity-90 disabled:opacity-60"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <CloudUpload className="size-4" />}
              Connect Google Drive
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 px-4 py-3.5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground">
                <DriveMark />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{link.folderName}</p>
                <p className="truncate text-xs text-muted-foreground">{link.email ?? "Google Drive"}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 px-4 py-3">
              {running ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
              ) : link.lastError ? (
                <TriangleAlert className="size-4 shrink-0 text-amber-500" />
              ) : (
                <Check className="size-4 shrink-0 text-emerald-500" />
              )}
              <p
                role="status"
                className={cn("min-w-0 flex-1 text-xs", link.lastError && !running ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}
              >
                {statusLine}
              </p>
            </div>
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">Back up automatically</p>
                <p className="text-xs text-muted-foreground">After each change, when online</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={link.autoBackup}
                aria-label="Back up automatically"
                onClick={() => setAutoBackup(!link.autoBackup)}
                className={cn(
                  "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-300 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  link.autoBackup ? "border-primary bg-primary" : "border-border bg-secondary",
                )}
              >
                <span
                  className={cn(
                    "inline-block size-4 rounded-full bg-card shadow-sm ring-1 ring-foreground/10 transition-transform duration-300",
                    link.autoBackup ? "translate-x-[22px]" : "translate-x-0.5",
                  )}
                />
              </button>
            </div>
            <div className="grid grid-cols-2 divide-x divide-border">
              <button
                type="button"
                disabled={busy || running}
                onClick={() => act(async () => summarize(await runBackup({ interactive: true })))}
                className="flex items-center justify-center gap-2 py-3.5 text-sm font-medium text-primary transition-colors hover:bg-secondary/60 disabled:opacity-50"
              >
                <RefreshCw className={cn("size-4", running && "animate-spin")} />
                {link.needsSignIn ? "Sign in & back up" : "Back up now"}
              </button>
              <button
                type="button"
                disabled={busy || running}
                onClick={() => setConfirmDisconnect(true)}
                className="py-3.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary/60 disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          </>
        )}
      </div>

      {message ? (
        <p role="status" className={cn("mt-2 px-1 text-xs", message.error ? "text-destructive" : "text-muted-foreground")}>
          {message.text}
        </p>
      ) : null}

      {picker ? (
        <FolderPicker
          email={picker.email}
          folders={picker.folders}
          onClose={() => setPicker(null)}
          onPick={(choice) =>
            act(async () => {
              const r = await linkFolder(choice, picker.email)
              setPicker(null)
              return summarize(r)
            })
          }
          busy={busy}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect Google Drive?"
        description="Automatic backups stop. Your backup stays in Google Drive, and you can reconnect to it anytime."
        confirmLabel="Disconnect"
        onConfirm={async () => {
          setConfirmDisconnect(false)
          await disconnectDrive()
          setMessage({ text: "Disconnected. Your backup is still in Google Drive." })
        }}
        onCancel={() => setConfirmDisconnect(false)}
      />
    </>
  )
}

function FolderPicker({
  email,
  folders,
  busy,
  onPick,
  onClose,
}: {
  email: string | null
  folders: FolderChoice[]
  busy: boolean
  onPick: (choice: { id: string; name: string } | { create: string }) => void
  onClose: () => void
}) {
  const [name, setName] = useState("Doku Scan")
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [busy, onClose])

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-4">
      <button type="button" aria-label="Close" onClick={busy ? undefined : onClose} className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="picker-title"
        className="relative max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-border bg-background p-5 shadow-2xl sm:rounded-3xl"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="picker-title" className="text-base font-semibold text-foreground">
              Choose a backup folder
            </h2>
            {email ? <p className="text-xs text-muted-foreground">{email}</p> : null}
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded-full p-1.5 text-muted-foreground hover:bg-secondary">
            <X className="size-5" />
          </button>
        </div>

        {folders.length > 0 ? (
          <>
            <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Restore from an existing backup</p>
            <div className="mb-5 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
              {folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onPick({ id: f.id, name: f.name })}
                  className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-secondary/60 disabled:opacity-60"
                >
                  <FolderOpen className="size-5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{f.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {f.documents} document{f.documents === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="text-xs font-semibold text-primary">Use</span>
                </button>
              ))}
            </div>
          </>
        ) : null}

        <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {folders.length ? "Or start a new backup" : "Create a backup folder"}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) onPick({ create: name.trim() })
          }}
          className="flex gap-2"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            aria-label="Folder name"
            className="h-11 min-w-0 flex-1 rounded-xl border border-input bg-background px-3.5 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/40"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="flex h-11 shrink-0 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}
            Create
          </button>
        </form>
        <p className="mt-2 px-1 text-[11px] leading-relaxed text-muted-foreground">
          Created in your Google Drive. Existing documents on this phone are uploaded right away.
        </p>
      </div>
    </div>,
    document.body,
  )
}
