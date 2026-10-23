/**
 * Which marks are drawn (G45). Pure, so the exit rule is tested without a DOM. Main decides when a mark ends; the
 * layer only keeps one that just left for its 140 ms exit, never longer, and never re-shows it (a stale mark must not
 * linger on a screen that changed).
 */
import type { MarkView } from '@shared/screen-marks'

export const MARK_EXIT_MS = 140

export interface DrawnMark {
  view: MarkView
  leaving: boolean
  leftAt?: number
}

export function nextDrawnMarks(previous: readonly DrawnMark[], live: readonly MarkView[], now: number): DrawnMark[] {
  const liveIds = new Set(live.map((mark) => mark.markId))
  const drawn: DrawnMark[] = live.map((view) => ({ view, leaving: false }))
  for (const mark of previous) {
    if (liveIds.has(mark.view.markId)) continue
    const leftAt = mark.leaving ? (mark.leftAt ?? now) : now
    if (now - leftAt < MARK_EXIT_MS) drawn.push({ view: mark.view, leaving: true, leftAt })
  }
  return drawn
}

/** Geometry of an arrow shaft: where it starts, how long it is, and its rotation in degrees. */
export function arrowGeometry(from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  return { left: from.x, top: from.y, length: Math.hypot(dx, dy), angle: (Math.atan2(dy, dx) * 180) / Math.PI }
}
