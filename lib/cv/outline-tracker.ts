/**
 * Temporal stabiliser for live document detection.
 *
 * Raw per-frame detections on a busy desk flip between near-tied shapes (the
 * page, the page plus a sheet under it, a keyboard). The tracker keeps one
 * locked quad and only replaces it when a different shape holds for several
 * passes in a row; detections that agree with the lock are median-smoothed.
 * Corners are expected in canonical order ([TL, TR, BR, BL], as returned by
 * detection).
 */

import type { Point } from "./document-processor"

export interface OutlineTrackerConfig {
  /** Max corner distance (fraction of the frame's long side) that counts as "the same quad". */
  matchFrac: number
  /** Agreeing passes needed before the first outline appears. */
  confirmPasses: number
  /** Agreeing passes a different quad needs before it replaces the locked one. */
  switchPasses: number
  /** Consecutive misses before the locked quad is dropped. */
  lostAfterMisses: number
  /** Passes without any detection agreeing with the lock before it is dropped (a wrong lock can't stick). */
  staleAfter: number
  /** Detections kept for the per-corner median. */
  history: number
}

export const DEFAULT_TRACKER_CONFIG: OutlineTrackerConfig = {
  matchFrac: 0.06,
  confirmPasses: 2,
  switchPasses: 3,
  lostAfterMisses: 5,
  staleAfter: 6,
  history: 3,
}

export function maxCornerShift(a: Point[], b: Point[]): number {
  return Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)))
}

function median(values: number[]): number {
  const s = values.slice().sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function medianQuad(quads: Point[][]): Point[] {
  return quads[0].map((_, i) => ({ x: median(quads.map((q) => q[i].x)), y: median(quads.map((q) => q[i].y)) }))
}

export class OutlineTracker {
  private readonly cfg: OutlineTrackerConfig
  private locked: Point[] | null = null
  private recent: Point[][] = []
  private pending: Point[] | null = null
  private pendingCount = 0
  private misses = 0
  private unconfirmed = 0

  constructor(config: Partial<OutlineTrackerConfig> = {}) {
    this.cfg = { ...DEFAULT_TRACKER_CONFIG, ...config }
  }

  /** The quad currently shown, or null. */
  get quad(): Point[] | null {
    return this.locked
  }

  reset(): void {
    this.locked = null
    this.recent = []
    this.pending = null
    this.pendingCount = 0
    this.misses = 0
    this.unconfirmed = 0
  }

  /** Feed one detection pass (null = nothing found); returns the quad to show. */
  update(detection: Point[] | null, longSide: number): Point[] | null {
    if (!detection) {
      this.pending = null
      this.pendingCount = 0
      if (++this.misses >= this.cfg.lostAfterMisses) this.reset()
      return this.locked
    }
    this.misses = 0
    const tol = this.cfg.matchFrac * longSide

    if (this.locked && maxCornerShift(detection, this.locked) <= tol) {
      this.recent.push(detection)
      if (this.recent.length > this.cfg.history) this.recent.shift()
      this.locked = medianQuad(this.recent)
      this.pending = null
      this.pendingCount = 0
      this.unconfirmed = 0
      return this.locked
    }

    // Nothing has agreed with the lock for a while: it was likely a wrong pick, so re-acquire.
    if (this.locked && ++this.unconfirmed >= this.cfg.staleAfter) {
      this.locked = null
      this.recent = []
      this.unconfirmed = 0
    }

    // A different shape (or nothing locked yet): it has to hold before it is shown.
    if (this.pending && maxCornerShift(detection, this.pending) <= tol) this.pendingCount++
    else this.pendingCount = 1
    this.pending = detection
    if (this.pendingCount >= (this.locked ? this.cfg.switchPasses : this.cfg.confirmPasses)) {
      this.locked = detection
      this.recent = [detection]
      this.pending = null
      this.pendingCount = 0
      this.unconfirmed = 0
    }
    return this.locked
  }
}
