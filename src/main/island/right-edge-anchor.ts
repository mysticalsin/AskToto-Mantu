/**
 * island/right-edge-anchor.ts — the main process's per-display right-edge anchor and the rects that follow it
 * (M2-0202, spec v3 §2). Like geometry.ts it has no Electron import and never writes window bounds: index.ts
 * resolves the live display, asks here for the rect, and its applyRightEdgeBounds is the only writer.
 *
 * Invariants: every right-edge rect (open drawer, Hide band, Island tab, hold region) is computed from one
 * anchor A per display; a drag's pending anchor wins until it is persisted; a display's legacy normalized Y
 * is converted on its first resolve and written as the new key once, never under a lock on either key.
 */

import { overlayDisplayKey } from '@shared/overlay-placement'
import {
  RIGHT_EDGE_DEFAULT_ANCHOR,
  anchorFraction,
  anchorY,
  holdRegion,
  legacyDrawerRect,
  legacyTabRect,
  readerRect,
  resolveRightEdgeAnchor,
  restRect,
  revealCorridor,
  rightEdgeAnchorLocked,
  type Rect
} from '@shared/right-edge-geometry'
import { CURSOR_LEAVE_GRACE_PX, pointInRect } from './cursor-watch'

export interface RightEdgeDisplay {
  id: number
  workArea: Rect
}

/** Which right-edge window: the open legacy drawer, the Reader, the Hide park (rest 'none', the band) or the Island tab. */
export type RightEdgeWindowKind = 'open' | 'reader' | 'band' | 'tab'

export interface RightEdgeAnchorDeps {
  /** The stored anchors (overlayRightEdgeAnchorByDisplay) and legacy normalized Ys (overlayRightEdgeYByDisplay). */
  stored: () => { anchors: Record<string, number>; legacy: Record<string, number> }
  /** Merges `anchors` into overlayRightEdgeAnchorByDisplay. */
  saveAnchors: (anchors: Record<string, number>) => void
  lockedKeys: () => readonly string[]
  /** Whether the live placement is still right-edge when a drag's anchor is persisted. */
  rightEdgeLive: () => boolean
  warn: (message: string, error: unknown) => void
  /** Runs `run` once after `ms` (index.ts owns the timer). */
  later: (run: () => void, ms: number) => void
}

/** Debounce for persisting a drag's anchor, trailing one gesture. */
export const RIGHT_EDGE_ANCHOR_SAVE_MS = 350

export function createRightEdgeAnchors(deps: RightEdgeAnchorDeps) {
  const pending = new Map<string, number>()
  // Display keys converted this session: a failed migration write is not retried per tick.
  const migrated = new Set<string>()
  let saveQueued = false
  // After a band reveal: the y the pointer revealed the drawer from, until it first enters the drawer.
  let revealY: number | null = null

  /** The display's anchor fraction f. */
  function fraction(display: RightEdgeDisplay): number {
    const key = overlayDisplayKey(display.id)
    if (!key) return RIGHT_EDGE_DEFAULT_ANCHOR
    const queued = pending.get(key)
    if (queued !== undefined) return queued
    const { anchors, legacy } = deps.stored()
    const { f, persist } = resolveRightEdgeAnchor({
      workArea: display.workArea,
      anchor: anchors[key],
      legacyY: legacy[key],
      lockedKeys: deps.lockedKeys()
    })
    if (persist && !migrated.has(key)) {
      migrated.add(key)
      try {
        deps.saveAnchors({ [key]: f })
      } catch (error) {
        deps.warn('could not migrate the right-edge position', error)
      }
    }
    return f
  }

  /** The anchor A (handle-centre y in DIP) on `display`. */
  function y(display: RightEdgeDisplay): number {
    return anchorY(display.workArea, fraction(display))
  }

  function rect(kind: RightEdgeWindowKind, display: RightEdgeDisplay): Rect {
    const a = y(display)
    if (kind === 'open') return legacyDrawerRect(display.workArea, a)
    if (kind === 'reader') return readerRect(display.workArea)
    return kind === 'band' ? restRect('none', display.workArea, a) : legacyTabRect(display.workArea, a)
  }

  /** Where the pointer keeps the revealed drawer open, with the post-band-reveal corridor until it enters the drawer. */
  function hold(display: RightEdgeDisplay, cursor: { x: number; y: number }): Rect[] {
    const open = rect('open', display)
    if (revealY !== null && pointInRect(cursor, open)) revealY = null
    const edgeX = display.workArea.x + display.workArea.width
    const corridor = revealY === null ? null : revealCorridor(open, revealY, edgeX)
    return holdRegion(display.workArea, open, y(display), { gracePx: CURSOR_LEAVE_GRACE_PX, edgeX, corridor })
  }

  /** A drag moved the handle centre to `centreY`: every rect follows at once; persisted after the drag settles. */
  function drag(display: RightEdgeDisplay, centreY: number): void {
    if (rightEdgeAnchorLocked(deps.lockedKeys())) return
    const key = overlayDisplayKey(display.id)
    if (!key) return
    // Stored inside the anchor clamp, so a drag back from past a bound moves at once.
    pending.set(key, anchorFraction(display.workArea, anchorY(display.workArea, anchorFraction(display.workArea, centreY))))
    if (saveQueued) return
    saveQueued = true
    deps.later(() => {
      saveQueued = false
      const anchors = Object.fromEntries(pending)
      pending.clear()
      if (Object.keys(anchors).length === 0 || !deps.rightEdgeLive()) return
      try {
        if (rightEdgeAnchorLocked(deps.lockedKeys())) return
        deps.saveAnchors(anchors)
      } catch (error) {
        deps.warn('could not persist right-edge position', error)
      }
    }, RIGHT_EDGE_ANCHOR_SAVE_MS)
  }

  return {
    fraction,
    y,
    rect,
    hold,
    drag,
    /** A band reveal from `at` (null: a reveal that needs no corridor). */
    noteReveal(at: number | null): void {
      revealY = at
    }
  }
}

export type RightEdgeAnchors = ReturnType<typeof createRightEdgeAnchors>
