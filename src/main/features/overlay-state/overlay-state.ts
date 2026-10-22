/**
 * Overlay desired and applied state (G17): the pure half.
 *
 * The overlay window has a DESIRED state (where it should sit, whether it should show, that it floats above
 * full-screen apps, that Private View's window protection follows the user's setting) and an APPLIED state
 * (what the window actually is, or what this module last pushed into it when the OS offers no getter). A
 * resume, an unlock, a display change or a Spaces/full-screen transition lets the two drift apart.
 * `planOverlayPass` compares them and returns the smallest idempotent list of actions that converge them.
 * It performs none of them; overlay-reconciler.ts applies them.
 *
 * Invariants:
 *   - Protection and click-through come from the live settings at plan time (the caller passes them in), so
 *     a reconcile can never re-enable a protection or capture setting the user turned off.
 *   - A window is only ever shown by a plan, never hidden: a hide is the user's, captured at its transition.
 *   - Size belongs to the renderer's own resizing. A free-form plan restores POSITION and keeps the live
 *     size, apart from the height ceiling the display imposes.
 *   - A window whose display disappeared goes to the top edge of the nearest work area (DESIGN.md).
 */
import type { OverlayLayout } from '@shared/overlay-chrome'
import { clampAxis, clampHeight } from '../../island/geometry'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The slice of an Electron Display the planner reads. */
export interface DisplayInfo {
  id: number
  bounds: Rect
  workArea: Rect
}

/** Reconcile at once, then at 250, 1000 and 2500 ms, and stop. */
export const OVERLAY_RECOVERY_PASS_MS = [0, 250, 1000, 2500] as const

export interface OverlayDesired {
  /** Where the user or the app last put the window; null until one is captured. */
  anchor: Rect | null
  /** The display the anchor was on when captured, to tell when that display is gone. */
  anchorDisplayId: number | null
  visible: boolean
  alwaysOnTop: boolean
  contentProtection: boolean
  clickThrough: boolean
  layout: OverlayLayout
  parked: boolean
}

/** What the window reports about itself. */
export interface OverlayObserved {
  bounds: Rect
  visible: boolean
  alwaysOnTop: boolean
}

/** What this module last pushed into properties the window cannot report back. null = unknown. */
export interface OverlayApplied {
  contentProtection: boolean | null
  clickThrough: boolean | null
}

export type OverlayAction =
  | { kind: 'setBounds'; bounds: Rect }
  | { kind: 'reanchor' }
  | { kind: 'show' }
  | { kind: 'alwaysOnTop' }
  | { kind: 'contentProtection'; on: boolean }
  | { kind: 'clickThrough'; on: boolean }

const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

const overlapArea = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

const centre = (r: Rect): { x: number; y: number } => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

/** The display with the largest overlap with `rect`, else the one whose centre is nearest (Electron's own rule). */
export function nearestDisplay<D extends DisplayInfo>(rect: Rect, displays: readonly D[]): D | null {
  let best: D | null = null
  let bestOverlap = 0
  for (const display of displays) {
    const area = overlapArea(rect, display.bounds)
    if (area > bestOverlap) {
      best = display
      bestOverlap = area
    }
  }
  if (best) return best
  const c = centre(rect)
  let bestDistance = Number.POSITIVE_INFINITY
  for (const display of displays) {
    const d = centre(display.bounds)
    const distance = (d.x - c.x) ** 2 + (d.y - c.y) ** 2
    if (distance < bestDistance) {
      best = display
      bestDistance = distance
    }
  }
  return best
}

/**
 * True when `rect` overlaps at least one display. It tests the display bounds, not the work area: a parked
 * Hide or Island rest sits at the very top edge, which a notched work area excludes.
 */
export function overlapsAnyDisplay(rect: Rect, displays: readonly DisplayInfo[]): boolean {
  return displays.some((d) => overlapArea(rect, d.bounds) > 0)
}

/**
 * Fit a free-form window to a work area: height ceiling first (a window grown for a tall display must shrink
 * when the display does, even while it is still partly visible), then, only if it is entirely off the area,
 * pull it back in. Moved from index.ts's display re-anchor.
 */
export function reanchorFreeBounds(candidate: Rect, workArea: Rect, barMinHeight: number): Rect {
  const height = clampHeight(candidate.height, workArea.height, barMinHeight)
  if (overlapArea(candidate, workArea) > 0) {
    if (height === candidate.height) return candidate
    return { ...candidate, y: Math.min(candidate.y, workArea.y + workArea.height - height - 8), height }
  }
  return {
    ...candidate,
    x: clampAxis(candidate.x, candidate.width, workArea.x, workArea.width),
    y: clampAxis(candidate.y, height, workArea.y, workArea.height),
    height
  }
}

export interface OverlayPlanInput<D extends DisplayInfo> {
  desired: OverlayDesired
  observed: OverlayObserved
  applied: OverlayApplied
  displays: readonly D[]
  /** 'delegate': the app owns the bounds (parked hover rest, right-edge sidecar). 'free': this module does. */
  mode: 'free' | 'delegate'
  /** Delegate mode: ask for a re-anchor even without drift (a display event, as before this module). */
  forceReanchor: boolean
  /** Push the properties the window cannot report back, even if they look current. */
  reassert: boolean
  barMinHeight: number
  /** DESIGN.md top-edge placement for a window of this size on `display`. */
  topEdgePosition(width: number, height: number, display: D): { x: number; y: number }
}

function planBounds<D extends DisplayInfo>(input: OverlayPlanInput<D>): OverlayAction[] {
  const { desired, observed, displays } = input
  const anchor = desired.anchor
  const anchorDisplayGone = desired.anchorDisplayId !== null && !displays.some((d) => d.id === desired.anchorDisplayId)
  if (input.mode === 'delegate') {
    const drifted = anchor !== null && !sameRect(anchor, observed.bounds)
    return input.forceReanchor || anchorDisplayGone || drifted ? [{ kind: 'reanchor' }] : []
  }
  if (displays.length === 0) return []
  const from = anchor ?? observed.bounds
  let target: Rect
  if (anchorDisplayGone) {
    const display = nearestDisplay(from, displays)
    if (!display) return []
    const height = clampHeight(observed.bounds.height, display.workArea.height, input.barMinHeight)
    const { x, y } = input.topEdgePosition(observed.bounds.width, height, display)
    target = { x, y, width: observed.bounds.width, height }
  } else {
    const candidate = { x: from.x, y: from.y, width: observed.bounds.width, height: observed.bounds.height }
    const display = nearestDisplay(candidate, displays)
    if (!display) return []
    target = reanchorFreeBounds(candidate, display.workArea, input.barMinHeight)
  }
  return sameRect(target, observed.bounds) ? [] : [{ kind: 'setBounds', bounds: target }]
}

/** The actions that bring the window from `observed`/`applied` to `desired`, in apply order. */
export function planOverlayPass<D extends DisplayInfo>(input: OverlayPlanInput<D>): OverlayAction[] {
  const { desired, observed, applied } = input
  const actions = planBounds(input)
  if (desired.visible && !observed.visible) actions.push({ kind: 'show' })
  if (desired.alwaysOnTop && (!observed.alwaysOnTop || input.reassert)) actions.push({ kind: 'alwaysOnTop' })
  if (input.reassert || applied.contentProtection !== desired.contentProtection) {
    actions.push({ kind: 'contentProtection', on: desired.contentProtection })
  }
  if (input.reassert || applied.clickThrough !== desired.clickThrough) {
    actions.push({ kind: 'clickThrough', on: desired.clickThrough })
  }
  return actions
}
