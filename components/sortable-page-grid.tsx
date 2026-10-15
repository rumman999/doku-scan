"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { BatchPage } from "@/hooks/use-scan-batch"

const LONG_PRESS_MS = 220
const MOUSE_DRAG_THRESHOLD = 4
const TOUCH_CANCEL_THRESHOLD = 8
const AUTOSCROLL_EDGE = 56
const AUTOSCROLL_MAX_SPEED = 14

interface DragState {
  id: string
  pointerId: number
  /** Pointer offset inside the card at grab time. */
  grabX: number
  grabY: number
  /** Latest pointer position in viewport coordinates. */
  clientX: number
  clientY: number
  /** Slot rects relative to the grid's top-left, captured at drag start. */
  slots: { x: number; y: number; w: number; h: number }[]
}

interface PendingPress {
  id: string
  pointerId: number
  pointerType: string
  startX: number
  startY: number
  timer: number | null
  el: HTMLElement
}

function move<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const oy = getComputedStyle(node).overflowY
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

/**
 * Thumbnail grid with drag-to-reorder.
 *
 * Uses Pointer Events rather than the HTML5 drag-and-drop API, which doesn't
 * fire for touch input on mobile browsers. Touch requires a short long-press
 * so a normal swipe still scrolls the sheet; mouse/pen start after a few px.
 * The dragged card is positioned via direct DOM transforms (no React render
 * per pointermove); React only re-renders when the target slot changes.
 */
export function SortablePageGrid({
  pages,
  onReorder,
  onRemove,
}: {
  pages: BatchPage[]
  onReorder: (orderedIds: string[]) => void
  onRemove: (id: string) => void
}) {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef(new Map<string, HTMLDivElement>())
  const dragRef = useRef<DragState | null>(null)
  const pendingRef = useRef<PendingPress | null>(null)
  const scrollParentRef = useRef<HTMLElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const refocusRef = useRef<string | null>(null)
  const noop = () => {}
  const onWindowMoveRef = useRef<(e: PointerEvent) => void>(noop)
  const onWindowUpRef = useRef<(e: PointerEvent) => void>(noop)

  const [dragId, setDragId] = useState<string | null>(null)
  const [overIndex, setOverIndex] = useState(0)
  const overIndexRef = useRef(0)

  const preview = useMemo(() => {
    if (!dragId) return pages
    const from = pages.findIndex((p) => p.id === dragId)
    return from < 0 ? pages : move(pages, from, overIndex)
  }, [pages, dragId, overIndex])

  /** Position the dragged card under the pointer, relative to its current slot. */
  const positionDragged = useCallback(() => {
    const drag = dragRef.current
    const grid = gridRef.current
    const el = drag && itemRefs.current.get(drag.id)
    if (!drag || !grid || !el) return
    const g = grid.getBoundingClientRect()
    const slot = drag.slots[overIndexRef.current]
    const x = drag.clientX - g.left - drag.grabX - slot.x
    const y = drag.clientY - g.top - drag.grabY - slot.y
    el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.06)`
  }, [])

  const updateOverIndex = useCallback(() => {
    const drag = dragRef.current
    const grid = gridRef.current
    if (!drag || !grid) return
    const g = grid.getBoundingClientRect()
    const slot0 = drag.slots[0]
    // Centre of the dragged card in grid coordinates.
    const cx = drag.clientX - g.left - drag.grabX + slot0.w / 2
    const cy = drag.clientY - g.top - drag.grabY + slot0.h / 2
    let best = overIndexRef.current
    let bestDist = Infinity
    drag.slots.forEach((s, i) => {
      const d = (s.x + s.w / 2 - cx) ** 2 + (s.y + s.h / 2 - cy) ** 2
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    })
    if (best !== overIndexRef.current) {
      overIndexRef.current = best
      setOverIndex(best)
    }
  }, [])

  // After React moves the dragged node into a new slot, re-anchor its transform.
  useLayoutEffect(() => {
    if (dragId) positionDragged()
  }, [dragId, overIndex, positionDragged])

  const autoScrollLoop = useCallback(() => {
    const drag = dragRef.current
    const scroller = scrollParentRef.current
    if (!drag) return
    if (scroller) {
      const r = scroller.getBoundingClientRect()
      let dy = 0
      if (drag.clientY < r.top + AUTOSCROLL_EDGE) {
        dy = -AUTOSCROLL_MAX_SPEED * (1 - Math.max(0, drag.clientY - r.top) / AUTOSCROLL_EDGE)
      } else if (drag.clientY > r.bottom - AUTOSCROLL_EDGE) {
        dy = AUTOSCROLL_MAX_SPEED * (1 - Math.max(0, r.bottom - drag.clientY) / AUTOSCROLL_EDGE)
      }
      if (dy !== 0) {
        scroller.scrollTop += dy
        positionDragged()
        updateOverIndex()
      }
    }
    rafRef.current = requestAnimationFrame(autoScrollLoop)
  }, [positionDragged, updateOverIndex])

  const beginDrag = useCallback(
    (press: PendingPress, clientX: number, clientY: number) => {
      const grid = gridRef.current
      if (!grid) return
      const g = grid.getBoundingClientRect()
      const slots = pages.map((p) => {
        const r = itemRefs.current.get(p.id)!.getBoundingClientRect()
        return { x: r.left - g.left, y: r.top - g.top, w: r.width, h: r.height }
      })
      const from = pages.findIndex((p) => p.id === press.id)
      const card = press.el.getBoundingClientRect()

      dragRef.current = {
        id: press.id,
        pointerId: press.pointerId,
        grabX: press.startX - card.left,
        grabY: press.startY - card.top,
        clientX,
        clientY,
        slots,
      }
      window.addEventListener("pointermove", onWindowMoveRef.current)
      window.addEventListener("pointerup", onWindowUpRef.current)
      window.addEventListener("pointercancel", onWindowUpRef.current)
      scrollParentRef.current = findScrollParent(grid)
      overIndexRef.current = from
      setOverIndex(from)
      setDragId(press.id)
      navigator.vibrate?.(10)
      rafRef.current = requestAnimationFrame(autoScrollLoop)
    },
    [pages, autoScrollLoop],
  )

  const endDrag = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current
      if (!drag) return
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      window.removeEventListener("pointermove", onWindowMoveRef.current)
      window.removeEventListener("pointerup", onWindowUpRef.current)
      window.removeEventListener("pointercancel", onWindowUpRef.current)
      const el = itemRefs.current.get(drag.id)
      if (el) el.style.transform = ""
      dragRef.current = null

      const from = pages.findIndex((p) => p.id === drag.id)
      const to = overIndexRef.current
      setDragId(null)
      if (commit && from >= 0 && from !== to) {
        onReorder(move(pages, from, to).map((p) => p.id))
      }
    },
    [pages, onReorder],
  )

  const clearPending = () => {
    const p = pendingRef.current
    if (p?.timer != null) window.clearTimeout(p.timer)
    pendingRef.current = null
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, id: string) => {
    if (e.button !== 0 || dragRef.current) return
    clearPending()
    const press: PendingPress = {
      id,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      timer: null,
      el: e.currentTarget,
    }
    if (e.pointerType === "touch") {
      press.timer = window.setTimeout(() => {
        if (pendingRef.current === press) {
          pendingRef.current = null
          beginDrag(press, press.startX, press.startY)
        }
      }, LONG_PRESS_MS)
    }
    pendingRef.current = press
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pending = pendingRef.current
    if (pending && pending.pointerId === e.pointerId) {
      const dist = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY)
      if (pending.pointerType === "touch") {
        if (dist > TOUCH_CANCEL_THRESHOLD) clearPending() // user is scrolling
      } else if (dist > MOUSE_DRAG_THRESHOLD) {
        clearPending()
        beginDrag(pending, e.clientX, e.clientY)
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pendingRef.current?.pointerId === e.pointerId) clearPending()
  }

  // Active drags listen on window: React may re-parent the dragged node when
  // the order changes, which would drop element-level pointer capture.
  const endDragRef = useRef(endDrag)
  endDragRef.current = endDrag
  onWindowMoveRef.current = useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      drag.clientX = e.clientX
      drag.clientY = e.clientY
      positionDragged()
      updateOverIndex()
    },
    [positionDragged, updateOverIndex],
  )
  onWindowUpRef.current = useCallback((e: PointerEvent) => {
    if (dragRef.current?.pointerId === e.pointerId) endDragRef.current(e.type === "pointerup")
  }, [])

  // Once a touch drag is active, stop the browser from scrolling the sheet.
  // Must be a non-passive native listener; React's touch handlers are passive.
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const block = (e: TouchEvent) => {
      if (dragRef.current) e.preventDefault()
    }
    grid.addEventListener("touchmove", block, { passive: false })
    return () => grid.removeEventListener("touchmove", block)
  }, [])

  useEffect(
    () => () => {
      clearPending()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      window.removeEventListener("pointermove", onWindowMoveRef.current)
      window.removeEventListener("pointerup", onWindowUpRef.current)
      window.removeEventListener("pointercancel", onWindowUpRef.current)
    },
    [],
  )

  // Keep keyboard focus on a card after it moves.
  useEffect(() => {
    const id = refocusRef.current
    if (!id) return
    refocusRef.current = null
    itemRefs.current.get(id)?.focus()
  }, [pages])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, index: number) => {
    const delta =
      e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0
    if (!delta) return
    const to = index + delta
    if (to < 0 || to >= pages.length) return
    e.preventDefault()
    refocusRef.current = pages[index].id
    onReorder(move(pages, index, to).map((p) => p.id))
  }

  return (
    <div
      ref={gridRef}
      role="list"
      aria-label="Scanned pages. Press and hold to drag, or focus a page and use arrow keys to reorder."
      className="grid grid-cols-3 gap-3"
    >
      {preview.map((page, index) => {
        const isDragging = page.id === dragId
        return (
          <div
            key={page.id}
            ref={(el) => {
              if (el) itemRefs.current.set(page.id, el)
              else itemRefs.current.delete(page.id)
            }}
            role="listitem"
            tabIndex={0}
            aria-label={`Page ${index + 1} of ${preview.length}`}
            aria-grabbed={isDragging}
            onPointerDown={(e) => onPointerDown(e, page.id)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={(e) => onKeyDown(e, index)}
            onContextMenu={(e) => e.preventDefault()}
            className={cn(
              "group relative aspect-[3/4] cursor-grab touch-manipulation select-none overflow-hidden rounded-xl border border-border bg-secondary outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              isDragging
                ? "z-10 cursor-grabbing shadow-2xl ring-2 ring-primary"
                : dragId
                  ? "transition-transform duration-150"
                  : "transition-shadow hover:shadow-md",
            )}
            style={{ WebkitTouchCallout: "none" } as React.CSSProperties}
          >
            <img
              src={page.thumbUrl}
              alt=""
              draggable={false}
              className="pointer-events-none size-full object-contain"
            />
            <span className="absolute bottom-1.5 left-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground/75 px-1.5 text-[11px] font-semibold text-background tabular-nums">
              {index + 1}
            </span>
            {!dragId && (
              <button
                type="button"
                aria-label={`Remove page ${index + 1}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onRemove(page.id)}
                className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-full bg-foreground/60 text-background opacity-100 transition-opacity hover:bg-destructive sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
