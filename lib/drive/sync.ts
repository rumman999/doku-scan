/**
 * Two-way sync between the on-device library and a Google Drive folder.
 *
 * Drive layout (everything tagged with appProperties so it's found by id, not name):
 *
 *   <root folder>                      appProperties { dokuscanRoot: "1" }
 *     <document name>/                 { dokuscanDoc: <docId>, updatedAt: <ms> }
 *       doc.json                       { dokuscanManifest: "1" }   name, dates, page order
 *       page-<pageId>.jpg              { dokuscanPage: <pageId> }  full-resolution page
 *
 * Rules:
 * - Documents are matched by id; the side with the newer updatedAt wins.
 * - Pages are immutable once captured, so only missing pages are transferred;
 *   reorder/rename only rewrite the small manifest.
 * - A folder's updatedAt is written last, so an interrupted upload is simply
 *   retried on the next run, and a half-uploaded document is never downloaded.
 * - Local deletions (tombstones) move the Drive copy to the trash; nothing is
 *   ever permanently deleted from Drive by this code.
 */

import { DriveAuthError, FOLDER_MIME, type DriveClient, type DriveFile } from "./api"
import type { IncomingPage, PageMeta, StoredDocument, Tombstone } from "@/lib/db/indexed-db"

export const ROOT_KEY = "dokuscanRoot"
export const DOC_KEY = "dokuscanDoc"
export const PAGE_KEY = "dokuscanPage"
export const MANIFEST_KEY = "dokuscanManifest"
export const UPDATED_KEY = "updatedAt"
const MANIFEST_NAME = "doc.json"

export interface Manifest {
  version: 1
  id: string
  name: string
  createdAt: number
  updatedAt: number
  pages: { id: string; order: number; width: number; height: number; createdAt: number }[]
}

/** Storage access the sync needs (the real implementation is lib/db/indexed-db). */
export interface SyncStore {
  listDocumentRecords(): Promise<StoredDocument[]>
  listPages(sessionId: string): Promise<PageMeta[]>
  getPageBlob(id: string): Promise<Blob | null>
  applyRemoteDocument(doc: StoredDocument, pages: IncomingPage[]): Promise<void>
  listTombstones(): Promise<Tombstone[]>
  clearTombstones(ids: string[]): Promise<void>
  docSession(docId: string): string
}

export type MakeThumbnail = (page: Blob) => Promise<Blob>

export interface SyncProgress {
  phase: "checking" | "uploading" | "downloading" | "cleaning"
  done: number
  total: number
}

export interface SyncResult {
  uploaded: number
  downloaded: number
  trashed: number
  /** Per-document problems; other documents still synced. */
  errors: string[]
}

export class BackupFolderMissingError extends Error {
  constructor() {
    super("The backup folder is missing or was moved to the trash")
    this.name = "BackupFolderMissingError"
  }
}

/** Drive-safe folder name for a document. */
export function folderName(name: string): string {
  return name.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120) || "Document"
}

/* ------------------------------------------------------------------ */
/* Root folders                                                        */
/* ------------------------------------------------------------------ */

/** Backup folders this app created in the user's Drive (survives reinstall). */
export async function listBackupFolders(client: DriveClient): Promise<DriveFile[]> {
  const folders = await client.findFoldersByProperty(ROOT_KEY, "1")
  return folders.sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""))
}

export function createBackupFolder(client: DriveClient, name: string): Promise<DriveFile> {
  return client.createFolder(folderName(name), null, { [ROOT_KEY]: "1" })
}

/** Number of documents in a backup folder (for the "restore from" picker). */
export async function countBackedUpDocuments(client: DriveClient, rootId: string): Promise<number> {
  const folders = await client.listChildren(rootId, `mimeType = '${FOLDER_MIME}'`)
  return folders.filter((f) => f.appProperties?.[DOC_KEY] && Number(f.appProperties[UPDATED_KEY]) > 0).length
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

export async function syncFolder(
  client: DriveClient,
  rootId: string,
  store: SyncStore,
  makeThumbnail: MakeThumbnail,
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncResult> {
  const result: SyncResult = { uploaded: 0, downloaded: 0, trashed: 0, errors: [] }
  onProgress?.({ phase: "checking", done: 0, total: 0 })

  const root = await client.get(rootId)
  if (!root || root.trashed) throw new BackupFolderMissingError()

  // Remote documents by id.
  const remote = new Map<string, DriveFile>()
  for (const f of await client.listChildren(rootId, `mimeType = '${FOLDER_MIME}'`)) {
    const id = f.appProperties?.[DOC_KEY]
    if (id && !remote.has(id)) remote.set(id, f)
  }

  // 1) Local deletions -> Drive trash.
  const tombstones = await store.listTombstones()
  const deleted = new Set(tombstones.map((t) => t.docId))
  onProgress?.({ phase: "cleaning", done: 0, total: tombstones.length })
  for (const t of tombstones) {
    const folder = remote.get(t.docId)
    if (folder) {
      await client.trash(folder.id)
      remote.delete(t.docId)
      result.trashed++
    }
  }
  await store.clearTombstones([...deleted])

  // 2) Decide direction per document.
  const locals = await store.listDocumentRecords()
  const localIds = new Set(locals.map((d) => d.id))
  const toPush: { doc: StoredDocument; folder: DriveFile | null }[] = []
  const toPull: DriveFile[] = []
  for (const doc of locals) {
    const folder = remote.get(doc.id) ?? null
    const remoteUpdated = Number(folder?.appProperties?.[UPDATED_KEY] ?? 0)
    if (!folder || doc.updatedAt > remoteUpdated) toPush.push({ doc, folder })
    else if (remoteUpdated > doc.updatedAt) toPull.push(folder)
  }
  for (const [id, folder] of remote) {
    if (!localIds.has(id) && !deleted.has(id) && Number(folder.appProperties?.[UPDATED_KEY] ?? 0) > 0) toPull.push(folder)
  }

  const guard = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (err) {
      if (err instanceof DriveAuthError) throw err
      console.error(`[Backup] ${label} failed`, err)
      result.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 3) Upload.
  for (let i = 0; i < toPush.length; i++) {
    onProgress?.({ phase: "uploading", done: i, total: toPush.length })
    const { doc, folder } = toPush[i]
    await guard(`Upload "${doc.name}"`, async () => {
      result.uploaded += await pushDocument(client, rootId, doc, folder, store)
    })
  }

  // 4) Download.
  for (let i = 0; i < toPull.length; i++) {
    onProgress?.({ phase: "downloading", done: i, total: toPull.length })
    const folder = toPull[i]
    await guard(`Download "${folder.name}"`, async () => {
      if (await pullDocument(client, folder, store, makeThumbnail)) result.downloaded++
    })
  }

  return result
}

/** Upload one document. Returns 1 when something changed remotely. */
async function pushDocument(
  client: DriveClient,
  rootId: string,
  doc: StoredDocument,
  existing: DriveFile | null,
  store: SyncStore,
): Promise<number> {
  const pages = await store.listPages(store.docSession(doc.id))
  if (pages.length === 0) return 0

  // updatedAt "0" marks the folder as incomplete until the very end.
  const folder = existing ?? (await client.createFolder(folderName(doc.name), rootId, { [DOC_KEY]: doc.id, [UPDATED_KEY]: "0" }))
  const children = existing ? await client.listChildren(folder.id) : []
  const remotePages = new Map<string, DriveFile>()
  let manifestFile: DriveFile | null = null
  for (const c of children) {
    const pid = c.appProperties?.[PAGE_KEY]
    if (pid) remotePages.set(pid, c)
    else if (c.appProperties?.[MANIFEST_KEY]) manifestFile = c
  }

  for (const p of pages) {
    if (remotePages.has(p.id)) continue
    const blob = await store.getPageBlob(p.id)
    if (!blob) throw new Error(`page ${p.order + 1} is missing on this device`)
    await client.upload(`page-${p.id}.jpg`, folder.id, blob, "image/jpeg", { [PAGE_KEY]: p.id })
  }
  const localIds = new Set(pages.map((p) => p.id))
  for (const [pid, file] of remotePages) if (!localIds.has(pid)) await client.trash(file.id)

  const manifest: Manifest = {
    version: 1,
    id: doc.id,
    name: doc.name,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    pages: pages.map((p) => ({ id: p.id, order: p.order, width: p.width, height: p.height, createdAt: p.createdAt })),
  }
  const json = new Blob([JSON.stringify(manifest, null, 1)], { type: "application/json" })
  if (manifestFile) await client.updateContent(manifestFile.id, json, "application/json")
  else await client.upload(MANIFEST_NAME, folder.id, json, "application/json", { [MANIFEST_KEY]: "1" })

  await client.updateMetadata(folder.id, {
    name: folderName(doc.name),
    appProperties: { [DOC_KEY]: doc.id, [UPDATED_KEY]: String(doc.updatedAt) },
  })
  return 1
}

/** Download one document. Returns false when the remote copy is unusable (skipped). */
async function pullDocument(
  client: DriveClient,
  folder: DriveFile,
  store: SyncStore,
  makeThumbnail: MakeThumbnail,
): Promise<boolean> {
  const children = await client.listChildren(folder.id)
  const manifestFile = children.find((c) => c.appProperties?.[MANIFEST_KEY])
  if (!manifestFile) throw new Error("backup is incomplete (no doc.json)")
  const manifest = JSON.parse(await (await client.download(manifestFile.id)).text()) as Manifest
  if (manifest.version !== 1 || manifest.id !== folder.appProperties?.[DOC_KEY]) {
    throw new Error("doc.json doesn't match its folder")
  }
  if (!manifest.pages.length) return false

  const remotePages = new Map<string, DriveFile>()
  for (const c of children) {
    const pid = c.appProperties?.[PAGE_KEY]
    if (pid) remotePages.set(pid, c)
  }
  const localIds = new Set((await store.listPages(store.docSession(manifest.id))).map((p) => p.id))

  const incoming: IncomingPage[] = []
  for (const p of [...manifest.pages].sort((a, b) => a.order - b.order)) {
    const base = { id: p.id, order: incoming.length, width: p.width, height: p.height, createdAt: p.createdAt }
    if (localIds.has(p.id)) {
      incoming.push(base)
      continue
    }
    const file = remotePages.get(p.id)
    if (!file) throw new Error(`page ${p.order + 1} is missing from the backup`)
    const blob = await client.download(file.id)
    incoming.push({ ...base, blob, thumbnail: await makeThumbnail(blob) })
  }

  await store.applyRemoteDocument(
    { id: manifest.id, name: manifest.name, createdAt: manifest.createdAt, updatedAt: manifest.updatedAt },
    incoming,
  )
  return true
}
