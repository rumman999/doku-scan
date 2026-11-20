"use client"

import { useCallback, useEffect, useState } from "react"
import type { PageSize, Quality } from "@/lib/pdf/export-pdf"

export type ScanFilter = "magic-color" | "bw" | "none"
export type ScanModeSetting = "single" | "batch"

export interface AppSettings {
  /** Enhancement applied to new scans. */
  defaultFilter: ScanFilter
  /** Mode the camera opens in. */
  defaultMode: ScanModeSetting
  /** Start the camera with auto-capture on. */
  autoCapture: boolean
  /** Initial PDF export options. */
  pdfPageSize: PageSize
  pdfQuality: Quality
  /** Library layout. */
  libraryView: "grid" | "list"
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultFilter: "magic-color",
  defaultMode: "single",
  autoCapture: false,
  pdfPageSize: "a4",
  pdfQuality: "high",
  libraryView: "grid",
}

const STORAGE_KEY = "dokuscan.settings.v1"
const CHANGE_EVENT = "dokuscan:settings"

/**
 * Read settings. Storage can be unavailable (private mode, blocked site data)
 * or hold an older/corrupt shape, so every field falls back to its default.
 */
export function loadSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    const pick = <K extends keyof AppSettings>(key: K, allowed: readonly AppSettings[K][]) =>
      allowed.includes(parsed[key] as AppSettings[K]) ? (parsed[key] as AppSettings[K]) : DEFAULT_SETTINGS[key]
    return {
      defaultFilter: pick("defaultFilter", ["magic-color", "bw", "none"]),
      defaultMode: pick("defaultMode", ["single", "batch"]),
      autoCapture: pick("autoCapture", [true, false]),
      pdfPageSize: pick("pdfPageSize", ["a4", "letter", "auto"]),
      pdfQuality: pick("pdfQuality", ["high", "medium", "low"]),
      libraryView: pick("libraryView", ["grid", "list"]),
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Not persisted (storage unavailable); still applied for this session below.
  }
  window.dispatchEvent(new CustomEvent<AppSettings>(CHANGE_EVENT, { detail: next }))
  return next
}

/**
 * Settings as React state. `loaded` is false during the first render (the
 * static export pre-renders without window), so callers that seed other state
 * from settings should wait for it.
 */
export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setSettings(loadSettings())
    setLoaded(true)
    const onChange = (e: Event) => setSettings((e as CustomEvent<AppSettings>).detail)
    window.addEventListener(CHANGE_EVENT, onChange)
    return () => window.removeEventListener(CHANGE_EVENT, onChange)
  }, [])

  const update = useCallback((patch: Partial<AppSettings>) => setSettings(saveSettings(patch)), [])

  return { settings, loaded, update }
}
