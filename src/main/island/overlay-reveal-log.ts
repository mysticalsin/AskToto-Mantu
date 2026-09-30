import type { OverlayLayout } from '@shared/overlay-chrome'
import type { OverlayPlacement } from '@shared/overlay-placement'

/**
 * Who moved the overlay between parked and revealed (M2-0431). Every transition is logged with exactly one:
 * the main-process cursor watch, the page (its own hover, spring or dock controls), a global hotkey, a
 * show/hide toggle (tray, relaunch, notification), or the Settings surface and its layout changes.
 */
export const OVERLAY_TRANSITION_CAUSES = ['cursor-watch', 'renderer', 'hotkey', 'toggle', 'settings'] as const
export type OverlayTransitionCause = (typeof OVERLAY_TRANSITION_CAUSES)[number]

/** The hover zone a reveal came from: the top-center notch area, the right-edge band, or none (a keyboard,
 *  tray or Settings reveal). */
export const OVERLAY_FLASH_ZONES = ['notch', 'edge-band', 'none'] as const
export type OverlayFlashZone = (typeof OVERLAY_FLASH_ZONES)[number]

/** A reveal that parks sooner than this, with no click or keypress in between, read to the owner as a flash. */
export const OVERLAY_FLASH_WINDOW_MS = 2_000

export interface OverlayTransitionContext {
  placement: OverlayPlacement
  layout: OverlayLayout
}

/** The content-free `overlay.flash` audit detail: timing and chrome only, never page content or positions. */
export interface OverlayFlash {
  visibleMs: number
  zone: OverlayFlashZone
  placement: OverlayPlacement
  layout: OverlayLayout
}

export interface OverlayRevealLogDeps {
  now: () => number
  log: (line: string) => void
  audit: (event: 'overlay.flash', detail: OverlayFlash) => void
}

/** `detail` is an optional content-free suffix for the log line only (window geometry, pointer position). */
export interface OverlayRevealLog {
  /** The overlay is now revealed. A reveal while already revealed is not a transition and is ignored. */
  revealed(cause: OverlayTransitionCause, context: OverlayTransitionContext, detail?: string): void
  /** The overlay is now parked (or hidden). A park while already parked is not a transition and is ignored. */
  parked(cause: OverlayTransitionCause, context: OverlayTransitionContext, detail?: string): void
  /** A Chromium input event reached the overlay page (`webContents` 'input-event' type). */
  input(type: string): void
}

/** Input types that are a deliberate click or keypress; pointer moves, wheel and key-ups are not. */
const DELIBERATE_INPUT = new Set(['mouseDown', 'rawKeyDown', 'keyDown', 'char'])

/** Causes that are themselves a click or keypress outside the page (a global hotkey, a tray or notification click,
 *  a Settings action): a reveal or park they touch is never a flash. */
const DELIBERATE_CAUSES: ReadonlySet<OverlayTransitionCause> = new Set(['hotkey', 'toggle', 'settings'])

export function overlayRevealZone(cause: OverlayTransitionCause, placement: OverlayPlacement): OverlayFlashZone {
  if (cause !== 'cursor-watch' && cause !== 'renderer') return 'none'
  return placement === 'right-edge' ? 'edge-band' : 'notch'
}

function chromeTag(context: OverlayTransitionContext, detail: string | undefined): string {
  return `placement=${context.placement} layout=${context.layout}${detail ? ` ${detail}` : ''}`
}

export function createOverlayRevealLog(deps: OverlayRevealLogDeps): OverlayRevealLog {
  // Unknown until the first transition: a boot-time park is logged but has no reveal to measure.
  let state: 'unknown' | 'revealed' | 'parked' = 'unknown'
  let shown: { at: number; zone: OverlayFlashZone; interacted: boolean } | null = null

  return {
    revealed(cause, context, detail) {
      const deliberate = DELIBERATE_CAUSES.has(cause)
      if (state === 'revealed') {
        if (shown && deliberate) shown.interacted = true
        return
      }
      state = 'revealed'
      const zone = overlayRevealZone(cause, context.placement)
      shown = { at: deps.now(), zone, interacted: deliberate }
      deps.log(`[overlay] reveal cause=${cause} zone=${zone} ${chromeTag(context, detail)}`)
    },
    parked(cause, context, detail) {
      if (state === 'parked') return
      state = 'parked'
      const reveal = shown
      shown = null
      if (!reveal) {
        deps.log(`[overlay] park cause=${cause} ${chromeTag(context, detail)}`)
        return
      }
      const visibleMs = Math.max(0, Math.round(deps.now() - reveal.at))
      const flash = visibleMs < OVERLAY_FLASH_WINDOW_MS && !reveal.interacted && !DELIBERATE_CAUSES.has(cause)
      deps.log(`[overlay] park cause=${cause} visibleMs=${visibleMs}${flash ? ' flash' : ''} ${chromeTag(context, detail)}`)
      if (flash) deps.audit('overlay.flash', { visibleMs, zone: reveal.zone, placement: context.placement, layout: context.layout })
    },
    input(type) {
      if (shown && DELIBERATE_INPUT.has(type)) shown.interacted = true
    }
  }
}
