/**
 * IndexedDB-backed page store for multi-page scan batches.
 *
 * Processed 8MP frames are written to disk as JPEG blobs the moment they are
 * captured, so the React tree only ever holds small thumbnail object URLs.
 * High-resolution data is read back one page at a time during PDF export.
 */

const DB_NAME = "dokuscan"
const DB_VERSION = 1
const PAGES_STORE = "pages"
const SESSION_INDEX = "bySession"

/** Default batch id. A single in-progress batch survives reloads/crashes. */
export const DEFAULT_SESSION = "current"

export interface StoredPage {
  id: string
  sessionId: string
  /** Position within the batch (0-based, contiguous after every write). */
  order: number
  /** Full-resolution processed JPEG. */
  blob: Blob
  /** ~320px JPEG used for the grid. */
  thumbnail: Blob
  width: number
  height: number
  createdAt: number
}

/** Lightweight view of a page: everything except the high-res blob. */
export type PageMeta = Omit<StoredPage, "blob">

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

    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(PAGES_STORE)) {
        const store = db.createObjectStore(PAGES_STORE, { keyPath: "id" })
        store.createIndex(SESSION_INDEX, "sessionId", { unique: false })
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

/** Append a page to the end of a batch. Returns its metadata (no high-res blob). */
export async function addPage(
  input: { blob: Blob; thumbnail: Blob; width: number; height: number },
  sessionId: string = DEFAULT_SESSION,
): Promise<PageMeta> {
  const db = await openDb()
  const tx = db.transaction(PAGES_STORE, "readwrite")
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
  await txDone(tx)

  const { blob: _blob, ...meta } = record
  return meta
}

/**
 * List a batch in order. High-res blobs are stripped before returning so they
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

/** Walk a batch with a cursor, calling `visit` with each record (one at a time). */
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

/** Persist a new ordering. `orderedIds` must contain the batch's page ids. */
export async function reorderPages(
  orderedIds: string[],
  sessionId: string = DEFAULT_SESSION,
): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(PAGES_STORE, "readwrite")
  await applyOrder(
    tx.objectStore(PAGES_STORE),
    sessionId,
    new Map(orderedIds.map((id, i) => [id, i])),
  )
  await txDone(tx)
}

/** Delete one page and compact the remaining order values. */
export async function deletePage(id: string, sessionId: string = DEFAULT_SESSION): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(PAGES_STORE, "readwrite")
  const store = tx.objectStore(PAGES_STORE)
  await requestToPromise(store.delete(id))

  // Collect only (id, order) pairs, then compact to 0..n-1.
  const remaining: { id: string; order: number }[] = []
  await walkSession(store, sessionId, (record) => {
    remaining.push({ id: record.id, order: record.order })
  })
  remaining.sort((a, b) => a.order - b.order)
  await applyOrder(store, sessionId, new Map(remaining.map((r, i) => [r.id, i])))
  await txDone(tx)
}

/** Remove every page in a batch. */
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
