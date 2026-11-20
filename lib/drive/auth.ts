"use client"

import { Capacitor } from "@capacitor/core"

/** Narrowest Drive scope: only files this app creates (non-sensitive; no Google review needed). */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"

/**
 * OAuth "Web application" client id from Google Cloud Console, baked in at
 * build time. The Android client (package + SHA-1) must exist in the same
 * project but its id is NOT used here. See README "Google Drive backup".
 */
export const GOOGLE_WEB_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? ""

export function isDriveConfigured(): boolean {
  return GOOGLE_WEB_CLIENT_ID.length > 0
}

/** Raised when a token is needed but getting one would require showing UI. */
export class SignInRequiredError extends Error {
  constructor() {
    super("Sign in to Google to continue backing up")
    this.name = "SignInRequiredError"
  }
}

interface CachedToken {
  token: string
  expiresAt: number
}

// Access tokens live in memory only (never persisted): ~1h lifetime.
let cached: CachedToken | null = null
const SAFETY_MS = 2 * 60 * 1000
const DEFAULT_LIFETIME_MS = 55 * 60 * 1000

/* ---------------- Android / iOS (native Google sign-in) ---------------- */

let nativeInit: Promise<void> | null = null

async function nativeLogin(interactive: boolean): Promise<CachedToken> {
  const { SocialLogin } = await import("@capgo/capacitor-social-login")
  nativeInit ??= SocialLogin.initialize({
    google: { webClientId: GOOGLE_WEB_CLIENT_ID, mode: "online" },
  }).catch((err) => {
    nativeInit = null
    throw err
  })
  await nativeInit

  const res = await SocialLogin.login({
    provider: "google",
    options: {
      scopes: [DRIVE_SCOPE],
      // Background refresh: reuse the already-authorised account without a picker.
      ...(interactive ? {} : { filterByAuthorizedAccounts: true, autoSelectEnabled: true }),
    },
  })
  const access = (res.result as { accessToken?: { token?: string; expires?: string } | null }).accessToken
  if (!access?.token) {
    throw new Error("Google didn't grant Drive access. Try again and allow access to Google Drive.")
  }
  const expires = access.expires ? Date.parse(access.expires) : NaN
  return { token: access.token, expiresAt: Number.isFinite(expires) ? expires : Date.now() + DEFAULT_LIFETIME_MS }
}

/* ---------------- Web (Google Identity Services token model) ---------------- */

interface GisTokenResponse {
  access_token?: string
  expires_in?: number | string
  error?: string
  error_description?: string
}

declare global {
  interface Window {
    google?: any
  }
}

let gisLoad: Promise<void> | null = null

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  gisLoad ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script")
    s.src = "https://accounts.google.com/gsi/client"
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      gisLoad = null
      reject(new Error("Couldn't reach Google. Check your connection."))
    }
    document.head.appendChild(s)
  })
  return gisLoad
}

async function webLogin(interactive: boolean): Promise<CachedToken> {
  // GIS can only open its consent popup from a user gesture.
  if (!interactive) throw new SignInRequiredError()
  await loadGis()
  return new Promise<CachedToken>((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_WEB_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: (r: GisTokenResponse) => {
        if (r.error || !r.access_token) {
          reject(new Error(r.error_description || r.error || "Google sign-in was cancelled"))
          return
        }
        const secs = Number(r.expires_in)
        resolve({
          token: r.access_token,
          expiresAt: Date.now() + (Number.isFinite(secs) ? secs * 1000 : DEFAULT_LIFETIME_MS),
        })
      },
      error_callback: (e: { message?: string; type?: string }) =>
        reject(new Error(e?.type === "popup_closed" ? "Google sign-in was cancelled" : e?.message || "Google sign-in failed")),
    })
    client.requestAccessToken()
  })
}

/* ---------------- Public API ---------------- */

/**
 * A valid Drive access token. `interactive` may show Google's account /
 * consent UI and must come from a user action; background syncs pass false.
 */
export async function getDriveToken({ interactive, forceRefresh = false }: { interactive: boolean; forceRefresh?: boolean }): Promise<string> {
  if (!isDriveConfigured()) throw new Error("Google Drive backup isn't configured in this build")
  if (!forceRefresh && cached && cached.expiresAt - SAFETY_MS > Date.now()) return cached.token
  cached = null
  try {
    cached = Capacitor.isNativePlatform() ? await nativeLogin(interactive) : await webLogin(interactive)
  } catch (err) {
    if (!interactive && !(err instanceof SignInRequiredError)) throw new SignInRequiredError()
    throw err
  }
  return cached.token
}

export async function signOutOfDrive(): Promise<void> {
  const token = cached?.token
  cached = null
  try {
    if (Capacitor.isNativePlatform()) {
      const { SocialLogin } = await import("@capgo/capacitor-social-login")
      await SocialLogin.logout({ provider: "google" })
    } else if (token && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(token, () => {})
    }
  } catch (err) {
    console.warn("[Drive] sign-out failed", err)
  }
}
