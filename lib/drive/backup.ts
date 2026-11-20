"use client"

import { useCallback, useEffect, useState } from "react"
import { DriveAuthError, DriveClient, type DriveFile } from "./api"
import { getDriveToken, isDriveConfigured, signOutOfDrive, SignInRequiredError } from "./auth"
import {
  BackupFolderMissingError,
  countBackedUpDocuments,
  createBackupFolder,
  listBackupFolders,
  syncFolder,
  type SyncProgress,
  type SyncResult,
} from "./sync"
import * as db from "@/lib/db/indexed-db"

/** Persisted link to a Drive folder. No tokens are stored. */
export interface BackupLink {
  folderId: string
  folderName: string
  email: string | null
  autoBackup: boolean
  lastSyncAt: number | null
  /** Problem from the last run, shown in Settings until the next success. */
  lastError: string | null
  /** The last automatic run needs the user to sign in again. */
  needsSignIn: boolean
}

export interface BackupStatus {
  link: BackupLink | null
  running: boolean
  progress: SyncProgress | null
}

const STORAGE_KEY = "dokuscan.backup.v1"
const EVENT = "dokuscan:backup"
export const LIBRARY_CHANGED_EVENT = "dokuscan:library-changed"
const AUTO_DELAY_MS = 3000

let running: Promise<SyncResult> | null = null
let progress: SyncProgress | null = null
let autoTimer: ReturnType<typeof setTimeout> | null = null

function readLink(): BackupLink | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<BackupLink>
    if (!v.folderId || !v.folderName) return null
    return {
      folderId: v.folderId,
      folderName: v.folderName,
      email: v.email ?? null,
      autoBackup: v.autoBackup ?? true,
      lastSyncAt: v.lastSyncAt ?? null,
      lastError: v.lastError ?? null,
      needsSignIn: v.needsSignIn ?? false,
    }
  } catch {
    return null
  }
}

function emit() {
  window.dispatchEvent(new Event(EVENT))
}

function writeLink(link: BackupLink | null) {
  try {
    if (link) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(link))
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage unavailable: the link lasts for this session only.
  }
  emit()
}

function patchLink(patch: Partial<BackupLink>) {
  const link = readLink()
  if (link) writeLink({ ...link, ...patch })
}

function clientFor(interactive: boolean): DriveClient {
  return new DriveClient((forceRefresh) => getDriveToken({ interactive, forceRefresh }))
}

/** ~320px JPEG thumbnail for a page downloaded from Drive. */
async function makeThumbnail(page: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(page)
  try {
    const s = Math.min(1, 320 / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * s))
    const h = Math.max(1, Math.round(bmp.height * s))
    if (typeof OffscreenCanvas !== "undefined") {
      const c = new OffscreenCanvas(w, h)
      c.getContext("2d")!.drawImage(bmp, 0, 0, w, h)
      return await c.convertToBlob({ type: "image/jpeg", quality: 0.7 })
    }
    const c = document.createElement("canvas")
    c.width = w
    c.height = h
    c.getContext("2d")!.drawImage(bmp, 0, 0, w, h)
    return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", 0.7))
  } finally {
    bmp.close()
  }
}

const store = {
  listDocumentRecords: db.listDocumentRecords,
  listPages: db.listPages,
  getPageBlob: db.getPageBlob,
  applyRemoteDocument: db.applyRemoteDocument,
  listTombstones: db.listTombstones,
  clearTombstones: db.clearTombstones,
  docSession: db.docSession,
}

function describe(err: unknown): string {
  if (err instanceof BackupFolderMissingError) return "The backup folder was deleted or moved to the trash. Choose a folder again."
  if (err instanceof SignInRequiredError || err instanceof DriveAuthError) return "Sign in to Google again to resume backups."
  if (typeof navigator !== "undefined" && !navigator.onLine) return "You're offline. Backup will resume when you're back online."
  return err instanceof Error ? err.message : "Backup failed"
}

/**
 * Sync now. `interactive` (from a button) may show Google sign-in; automatic
 * runs never do and instead flag `needsSignIn`. Concurrent calls share one run.
 */
export function runBackup({ interactive }: { interactive: boolean }): Promise<SyncResult> {
  if (running) return running
  const link = readLink()
  if (!link) return Promise.reject(new Error("Google Drive isn't connected"))

  running = (async () => {
    emit()
    try {
      const result = await syncFolder(clientFor(interactive), link.folderId, store, makeThumbnail, (p) => {
        progress = p
        emit()
      })
      patchLink({
        lastSyncAt: Date.now(),
        needsSignIn: false,
        lastError: result.errors.length ? `${result.errors.length} document(s) couldn't sync: ${result.errors[0]}` : null,
      })
      if (result.downloaded > 0 || result.trashed > 0) window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT))
      return result
    } catch (err) {
      console.error("[Backup] sync failed", err)
      patchLink({
        lastError: describe(err),
        needsSignIn: err instanceof SignInRequiredError || err instanceof DriveAuthError,
      })
      throw err
    } finally {
      running = null
      progress = null
      emit()
    }
  })()
  return running
}

/**
 * Queue an automatic backup after a library change (debounced). No-op when
 * not linked, auto backup is off, or the device is offline.
 */
export function scheduleBackup(delayMs = AUTO_DELAY_MS) {
  if (typeof window === "undefined" || !isDriveConfigured()) return
  const link = readLink()
  if (!link?.autoBackup || link.needsSignIn) return
  if (autoTimer) clearTimeout(autoTimer)
  autoTimer = setTimeout(() => {
    autoTimer = null
    if (!navigator.onLine) return
    runBackup({ interactive: false }).catch(() => {})
  }, delayMs)
}

// Catch up as soon as connectivity returns.
if (typeof window !== "undefined") window.addEventListener("online", () => scheduleBackup(1000))

/* ------------------------------------------------------------------ */
/* Linking                                                             */
/* ------------------------------------------------------------------ */

export interface FolderChoice {
  id: string
  name: string
  documents: number
}

/** Sign in (shows Google UI) and list existing backup folders this app created. */
export async function connectDrive(): Promise<{ email: string | null; folders: FolderChoice[] }> {
  const client = clientFor(true)
  await getDriveToken({ interactive: true, forceRefresh: true })
  const [{ email }, folders] = await Promise.all([client.aboutUser().catch(() => ({ email: null })), listBackupFolders(client)])
  const choices = await Promise.all(
    folders.map(async (f: DriveFile) => ({
      id: f.id,
      name: f.name,
      documents: await countBackedUpDocuments(client, f.id).catch(() => 0),
    })),
  )
  return { email, folders: choices }
}

/** Link to an existing backup folder (restore) or a newly created one, then sync. */
export async function linkFolder(choice: { id: string; name: string } | { create: string }, email: string | null) {
  let id: string
  let name: string
  if ("create" in choice) {
    const folder = await createBackupFolder(clientFor(true), choice.create)
    id = folder.id
    name = folder.name
  } else {
    id = choice.id
    name = choice.name
  }
  writeLink({ folderId: id, folderName: name, email, autoBackup: true, lastSyncAt: null, lastError: null, needsSignIn: false })
  return runBackup({ interactive: true })
}

export async function disconnectDrive() {
  if (autoTimer) clearTimeout(autoTimer)
  writeLink(null)
  await signOutOfDrive()
}

export function setAutoBackup(on: boolean) {
  patchLink({ autoBackup: on })
  if (on) scheduleBackup(500)
}

/* ------------------------------------------------------------------ */
/* React                                                               */
/* ------------------------------------------------------------------ */

export function useBackup(): BackupStatus & { configured: boolean } {
  const [status, setStatus] = useState<BackupStatus>({ link: null, running: false, progress: null })
  const refresh = useCallback(() => setStatus({ link: readLink(), running: running !== null, progress }), [])
  useEffect(() => {
    refresh()
    window.addEventListener(EVENT, refresh)
    return () => window.removeEventListener(EVENT, refresh)
  }, [refresh])
  return { ...status, configured: isDriveConfigured() }
}
