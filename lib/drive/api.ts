/**
 * Minimal Google Drive v3 REST client (drive.file scope).
 *
 * Only what backup needs: folders, small JSON manifests and JPEG pages.
 * App-owned items are tagged with appProperties so they can be found again
 * after a reinstall without depending on names the user may have changed.
 */

const API = "https://www.googleapis.com/drive/v3"
const UPLOAD = "https://www.googleapis.com/upload/drive/v3"
export const FOLDER_MIME = "application/vnd.google-apps.folder"

export interface DriveFile {
  id: string
  name: string
  mimeType?: string
  appProperties?: Record<string, string>
  modifiedTime?: string
}

export class DriveAuthError extends Error {
  constructor(message = "Google sign-in expired") {
    super(message)
    this.name = "DriveAuthError"
  }
}

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "DriveError"
  }
}

/** Returns a valid access token. `forceRefresh` after the API rejected the previous one. */
export type TokenProvider = (forceRefresh: boolean) => Promise<string>

const FIELDS = "id,name,mimeType,appProperties,modifiedTime"

/** Escape a value for a Drive query string literal. */
function q(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
}

export class DriveClient {
  constructor(
    private readonly token: TokenProvider,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** Authorised request with one retry on 401 (token expired) and backoff on rate limits / 5xx. */
  private async request(url: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    // After a 401 the provider has already been asked to refresh, so a plain read gets the new token.
    const token = await this.token(false)
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    })
    if (res.status === 401) {
      if (attempt >= 1) throw new DriveAuthError()
      await this.token(true)
      return this.request(url, init, attempt + 1)
    }
    if ((res.status === 429 || res.status >= 500 || (res.status === 403 && (await isRateLimit(res.clone())))) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 500 + Math.random() * 250))
      return this.request(url, init, attempt + 1)
    }
    if (!res.ok) {
      let detail = ""
      try {
        detail = (await res.json())?.error?.message ?? ""
      } catch {}
      throw new DriveError(`Google Drive request failed (${res.status})${detail ? `: ${detail}` : ""}`, res.status)
    }
    return res
  }

  /** All matches of a Drive query (follows pagination). */
  async list(query: string): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({
        q: query,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: "1000",
        spaces: "drive",
      })
      if (pageToken) params.set("pageToken", pageToken)
      const res = await this.request(`${API}/files?${params}`)
      const body = await res.json()
      out.push(...(body.files ?? []))
      pageToken = body.nextPageToken
    } while (pageToken)
    return out
  }

  /** Children of a folder (not trashed). */
  listChildren(folderId: string, extra = ""): Promise<DriveFile[]> {
    return this.list(`${q(folderId)} in parents and trashed = false${extra ? ` and ${extra}` : ""}`)
  }

  /** Folders this app created and tagged with appProperties[key] = value. */
  findFoldersByProperty(key: string, value: string): Promise<DriveFile[]> {
    return this.list(
      `mimeType = ${q(FOLDER_MIME)} and trashed = false and appProperties has { key=${q(key)} and value=${q(value)} }`,
    )
  }

  async get(id: string): Promise<(DriveFile & { trashed?: boolean }) | null> {
    try {
      const res = await this.request(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS},trashed`)
      return res.json()
    } catch (err) {
      if (err instanceof DriveError && err.status === 404) return null
      throw err
    }
  }

  async createFolder(name: string, parentId: string | null, appProperties: Record<string, string>): Promise<DriveFile> {
    const res = await this.request(`${API}/files?fields=${FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, appProperties, ...(parentId ? { parents: [parentId] } : {}) }),
    })
    return res.json()
  }

  /** Create a file with content in one request (multipart upload). */
  async upload(
    name: string,
    parentId: string,
    content: Blob,
    mimeType: string,
    appProperties: Record<string, string>,
  ): Promise<DriveFile> {
    const boundary = `dokuscan-${Math.random().toString(36).slice(2)}`
    const metadata = JSON.stringify({ name, parents: [parentId], mimeType, appProperties })
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      content,
      `\r\n--${boundary}--`,
    ])
    const res = await this.request(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    })
    return res.json()
  }

  /** Replace a file's content (and optionally its metadata). */
  async updateContent(id: string, content: Blob, mimeType: string): Promise<void> {
    await this.request(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": mimeType },
      body: content,
    })
  }

  async updateMetadata(id: string, patch: { name?: string; appProperties?: Record<string, string> }): Promise<void> {
    await this.request(`${API}/files/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(patch),
    })
  }

  /** Move to Drive's trash (recoverable for 30 days), never a permanent delete. */
  async trash(id: string): Promise<void> {
    try {
      await this.request(`${API}/files/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ trashed: true }),
      })
    } catch (err) {
      if (err instanceof DriveError && err.status === 404) return
      throw err
    }
  }

  async download(id: string): Promise<Blob> {
    const res = await this.request(`${API}/files/${encodeURIComponent(id)}?alt=media`)
    return res.blob()
  }

  /** Signed-in account, for display. */
  async aboutUser(): Promise<{ email: string | null; name: string | null }> {
    const res = await this.request(`${API}/about?fields=user(emailAddress,displayName)`)
    const body = await res.json()
    return { email: body.user?.emailAddress ?? null, name: body.user?.displayName ?? null }
  }
}

async function isRateLimit(res: Response): Promise<boolean> {
  try {
    const reason = (await res.json())?.error?.errors?.[0]?.reason
    return reason === "rateLimitExceeded" || reason === "userRateLimitExceeded"
  } catch {
    return false
  }
}
