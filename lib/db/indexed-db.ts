/**
 * IndexedDB-backed storage for scanned pages and saved documents.
 *
 * Pages: processed 8MP frames are written to disk as JPEG blobs the moment
 * they are captured, so the React tree only ever holds small thumbnail object
 * URLs. High-resolution data is read back one page at a time (viewer, PDF).
 *
 * Every page belongs to a "session":
 * - capture sessions ("current" for batch mode, "single" for single mode)
 *   hold pages that are still being scanned;
 * - document sessions (`doc:<id>`, see {@link docSession}) hold the pages of a
 *   saved document in the library.
 *
 * Saving a scan moves its pages from the capture session into a document
 * session inside one transaction, so pages are never copied or lost.
 */

const DB_NAME = "dokuscan"
const DB_VERSION = 2
const PAGES_STORE = "pages"
const DOCS_STORE = "documents"
const SESSION_INDEX = "bySession"

/** Default batch id. A single in-progress batch survives reloads/crashes. */
export const DEFAULT_SESSION = "current"

const DOC_PREFIX = "doc:"

/** Session id holding the pages of library document `docId`. */
export function docSession(docId: string): string {
  return DOC_PREFIX + docId
}

function docIdFromSession(sessionId: string): string | null {
  return sessionId.startsWith(DOC_PREFIX) ? sessionId.slice(DOC_PREFIX.length) : null
}

export interface StoredPage {
  id: string
  sessionId: string
  /** Position within the session (0-based, contiguous after every write). */
  order: number
  /** Full-resolution processed JPEG. */
  blob: Blob
  /** ~320px JPEG used for grids. */
  thumbnail: Blob
  width: number
  height: number
  createdAt: number
}

/** Lightweight view of a page: everything except the high-res blob. */
export type PageMeta = Omit<StoredPage, "blob">

export interface StoredDocument {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

/** A document plus what the library list needs to render it. */
export interface DocumentSummary extends StoredDocument {
  pageCount: number
  /** Thumbnail of the first page, or null for an empty document. */
  cover: Blob | null
}

let dbPromise: Promise<IDBDatabase> | null = null

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"))
  })
}

export function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available in this environment"))
  }
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    // Additive migrations only: existing pages survive every upgrade.
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(PAGES_STORE)) {
        const store = db.createObjectStore(PAGES_STORE, { keyPath: "id" })
        store.createIndex(SESSION_INDEX, "sessionId", { unique: false })
      }
      if (!db.objectStoreNames.contains(DOCS_STORE)) {
        db.createObjectStore(DOCS_STORE, { keyPath: "id" })
      }
    }

    req.onsuccess = () => {
      const db = req.result
      // Another tab upgraded the schema: drop our handle so it can proceed.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => {
      dbPromise = null
      reject(req.error)
    }
    req.onblocked = () => console.warn("[IndexedDB] open blocked by another tab")
  })

  // Ask the browser not to evict our data under storage pressure (best effort).
  navigator.storage?.persist?.().catch(() => {})

  return dbPromise
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

async function getSessionRecords(
  store: IDBObjectStore,
  sessionId: string,
): Promise<StoredPage[]> {
  const records = await requestToPromise(
    store.index(SESSION_INDEX).getAll(IDBKeyRange.only(sessionId)) as IDBRequest<StoredPage[]>,
  )
  return records.sort((a, b) => a.order - b.order)
}

/** Bump a document's updatedAt (no-op for capture sessions or missing docs). */
async function touchDocument(docs: IDBObjectStore, sessionId: string): Promise<void> {
  const docId = docIdFromSession(sessionId)
  if (!docId) return
  const doc = await requestToPromise(docs.get(docId) as IDBRequest<StoredDocument | undefined>)
  if (doc) docs.put({ ...doc, updatedAt: Date.now() })
}

/** Append a page to the end of a session. Returns its metadata (no high-res blob). */
export async function addPage(
  input: { blob: Blob; thumbnail: Blob; width: number; height: number },
  sessionId: string = DEFAULT_SESSION,
): Promise<PageMeta> {
  const db = await openDb()
  const tx = db.transaction([PAGES_STORE, DOCS_STORE], "readwrite")
  const store = tx.objectStore(PAGES_STORE)

  const count = await requestToPromise(
    store.index(SESSION_INDEX).count(IDBKeyRange.only(sessionId)),
  )
  const record: StoredPage = {
    id: newId(),
    sessionId,
    order: count,
    createdAt: Date.now(),
    ...input,
  }
  store.put(record)
  await touchDocument(tx.objectStore(DOCS_STORE), sessionId)
  await txDone(tx)

  const { blob: _blob, ...meta } = record
  return meta
}

/**
 * List a session in order. High-res blobs are stripped before returning so they
 * become unreachable and can be garbage-collected immediately.
 */
export async function listPages(sessionId: string = DEFAULT_SESSION): Promise<PageMeta[]> {
  const db = await openDb()
  const tx = db.transaction(PAGES_STORE, "readonly")
  const records = await getSessionRecords(tx.objectStore(PAGES_STORE), sessionId)
  return records.map(({ blob: _blob, ...meta }) => meta)
}

/** Fetch a single page's full-resolution blob. */
export async function getPageBlob(id: string): Promise<Blob | null> {
  const db = await openDb()
  const tx = db.transaction(PAGES_STORE, "readonly")
  const record = await requestToPromise(
    tx.objectStore(PAGES_STORE).get(id) as IDBRequest<StoredPage | undefined>,
  )
  return record?.blob ?? null
}

/** Walk a session with a cursor, calling `visit` with each record (one at a time). */
function walkSession(
  store: IDBObjectStore,
  sessionId: string,
  visit: (record: StoredPage, cursor: IDBCursorWithValue) => void,
): Promise<void> {
  const req = store.index(SESSION_INDEX).openCursor(IDBKeyRange.only(sessionId))
  return new Promise((resolve, reject) => {
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return resolve()
      visit(cursor.value as StoredPage, cursor)
      cursor.continue()
    }
  })
}

/** Rewrite `order` fields in place; untouched records are never re-serialised. */
function applyOrder(
  store: IDBObjectStore,
  sessionId: string,
  position: Map<string, number>,
): Promise<void> {
  return walkSession(store, sessionId, (record, cursor) => {
    const order = position.get(record.id)
    if (order !== undefined && order !== record.order) cursor.update({ ...record, order })
  })
}

/** Persist a new ordering. `orderedIds` must contain the session's page ids. */
export async function reorderPages(
  orderedIds: string[],
  sessionId: string = DEFAULT_SESSION,
): Promise<void> {
  const db = await openDb()
  const tx = db.transaction([PAGES_STORE, DOCS_STORE], "readwrite")
  await applyOrder(
    tx.objectStore(PAGES_STORE),
    sessionId,
    new Map(orderedIds.map((id, i) => [id, i])),
  )
  await touchDocument(tx.objectStore(DOCS_STORE), sessionId)
  await txDone(tx)
}

/**
 * Delete one page and compact the remaining order values. Deleting the last
 * page of a library document deletes the (now empty) document too.
 */
export async function deletePage(id: string, sessionId: string = DEFAULT_SESSION): Promise<void> {
  const db = await openDb()
  const tx = db.transaction([PAGES_STORE, DOCS_STORE], "readwrite")
  const store = tx.objectStore(PAGES_STORE)
  const docs = tx.objectStore(DOCS_STORE)
  await requestToPromise(store.delete(id))

  // Collect only (id, order) pairs, then compact to 0..n-1.
  const remaining: { id: string; order: number }[] = []
  await walkSession(store, sessionId, (record) => {
    remaining.push({ id: record.id, order: record.order })
  })
  remaining.sort((a, b) => a.order - b.order)
  await applyOrder(store, sessionId, new Map(remaining.map((r, i) => [r.id, i])))

  const docId = docIdFromSession(sessionId)
  if (docId && remaining.length === 0) docs.delete(docId)
  else await touchDocument(docs, sessionId)
  await txDone(tx)
}

/** Remove every page in a session. */
export async function clearSession(sessionId: string = DEFAULT_SESSION): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(PAGES_STORE, "readwrite")
  const store = tx.objectStore(PAGES_STORE)
  const keys = await requestToPromise(
    store.index(SESSION_INDEX).getAllKeys(IDBKeyRange.only(sessionId)),
  )
  for (const key of keys) store.delete(key)
  await txDone(tx)
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

/** Default document name, e.g. "Scan 2026-11-20 14:05". */
export function defaultDocumentName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `Scan ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

/**
 * Move every page of `fromSession` to the end of `toSession`, keeping their
 * relative order. Runs inside the caller's transaction. Returns pages moved.
 */
async function movePages(store: IDBObjectStore, fromSession: string, toSession: string): Promise<number> {
  const offset = await requestToPromise(store.index(SESSION_INDEX).count(IDBKeyRange.only(toSession)))
  const moving: { id: string; order: number }[] = []
  await walkSession(store, fromSession, (record) => moving.push({ id: record.id, order: record.order }))
  moving.sort((a, b) => a.order - b.order)
  const position = new Map(moving.map((m, i) => [m.id, offset + i]))

  // Re-key in a second pass: updating the indexed field while iterating that
  // same index range would make the cursor skip records.
  for (const { id } of moving) {
    const record = await requestToPromise(store.get(id) as IDBRequest<StoredPage>)
    store.put({ ...record, sessionId: toSession, order: position.get(id)! })
  }
  return moving.length
}

/**
 * Turn a capture session into a new library document. The pages are moved,
 * not copied, so the capture session is empty afterwards.
 */
export async function createDocumentFromSession(
  sessionId: string,
  name: string = defaultDocumentName(),
): Promise<StoredDocument> {
  const db = await openDb()
  const tx = db.transaction([PAGES_STORE, DOCS_STORE], "readwrite")
  const now = Date.now()
  const doc: StoredDocument = { id: newId(), name, createdAt: now, updatedAt: now }

  const moved = await movePages(tx.objectStore(PAGES_STORE), sessionId, docSession(doc.id))
  if (moved === 0) {
    tx.abort()
    await txDone(tx).catch(() => {})
    throw new Error("Nothing to save: the scan has no pages")
  }
  tx.objectStore(DOCS_STORE).put(doc)
  await txDone(tx)
  return doc
}

/** Append a capture session's pages to the end of an existing document. */
export async function appendSessionToDocument(sessionId: string, docId: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction([PAGES_STORE, DOCS_STORE], "readwrite")
  const docs = tx.objectStore(DOCS_STORE)
  const doc = await requestToPromise(docs.get(docId) as IDBRequest<StoredDocument | undefined>)
  if (!doc) {
    tx.abort()
    await txDone(tx).catch(() => {})
    throw new Error("That document no longer exists")
  }
  await movePages(tx.objectStore(PAGES_STORE), sessionId, docSession(docId))
  docs.put({ ...doc, updatedAt: Date.now() })
  await txDone(tx)
}

export async function getDocument(id: string): Promise<StoredDocument | null> {
  const db = await openDb()
  const tx = db.transaction(DOCS_STORE, "readonly")
  return (await requestToPromise(tx.objectStore(DOCS_STORE).get(id) as IDBRequest<StoredDocument | undefined>)) ?? null
}

/** All documents, most recently updated first, with page count and cover thumbnail. */
export async function listDocuments(): Promise<DocumentSummary[]> {
  const db = await openDb()
  const tx = db.transaction([PAGES_STORE, DOCS_STORE], "readonly")
  const docs = await requestToPromise(tx.objectStore(DOCS_STORE).getAll() as IDBRequest<StoredDocument[]>)
  const pages = tx.objectStore(PAGES_STORE)

  const summaries = await Promise.all(
    docs.map(async (doc): Promise<DocumentSummary> => {
      let pageCount = 0
      let cover: Blob | null = null
      let coverOrder = Infinity
      await walkSession(pages, docSession(doc.id), (record) => {
        pageCount++
        if (record.order < coverOrder) {
          coverOrder = record.order
          cover = record.thumbnail
        }
      })
      return { ...doc, pageCount, cover }
    }),
  )
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function renameDocument(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error("Name can't be empty")
  const db = await openDb()
  const tx = db.transaction(DOCS_STORE, "readwrite")
  const store = tx.objectStore(DOCS_STORE)
  const doc = await requestToPromise(store.get(id) as IDBRequest<StoredDocument | undefined>)
  if (doc) store.put({ ...doc, name: trimmed, updatedAt: Date.now() })
  await txDone(tx)
}

/** Delete documents and all of their pages. */
export async function deleteDocuments(ids: string[]): Promise<void> {
  const db = await openDb()
  const tx = db.transaction([PAGES_STORE, DOCS_STORE], "readwrite")
  const pages = tx.objectStore(PAGES_STORE)
  const docs = tx.objectStore(DOCS_STORE)
  for (const id of ids) {
    const keys = await requestToPromise(
      pages.index(SESSION_INDEX).getAllKeys(IDBKeyRange.only(docSession(id))),
    )
    for (const key of keys) pages.delete(key)
    docs.delete(id)
  }
  await txDone(tx)
}

/**
 * Merge documents into the first id: the others' pages are appended in the
 * given order and the emptied documents are removed.
 */
export async function mergeDocuments(ids: string[]): Promise<string> {
  if (ids.length < 2) throw new Error("Select at least two documents to merge")
  const [targetId, ...rest] = ids
  const db = await openDb()
  const tx = db.transaction([PAGES_STORE, DOCS_STORE], "readwrite")
  const pages = tx.objectStore(PAGES_STORE)
  const docs = tx.objectStore(DOCS_STORE)
  const target = await requestToPromise(docs.get(targetId) as IDBRequest<StoredDocument | undefined>)
  if (!target) {
    tx.abort()
    await txDone(tx).catch(() => {})
    throw new Error("That document no longer exists")
  }
  for (const id of rest) {
    await movePages(pages, docSession(id), docSession(targetId))
    docs.delete(id)
  }
  docs.put({ ...target, updatedAt: Date.now() })
  await txDone(tx)
  return targetId
}

/** Delete every document and every in-progress scan. */
export async function deleteAllData(): Promise<void> {
  const db = await openDb()
  const tx = db.transaction([PAGES_STORE, DOCS_STORE], "readwrite")
  tx.objectStore(PAGES_STORE).clear()
  tx.objectStore(DOCS_STORE).clear()
  await txDone(tx)
}
