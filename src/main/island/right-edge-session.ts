/**
 * right-edge-session.ts — main's view of the right-edge page (M2-0202, spec v3 §4): the latest
 * IPC.rightEdgeState the renderer reported, the park gate on its pins, and IPC.rightEdgeSurface delivery.
 *
 * Invariants:
 * - The pins are the renderer's: a reload or a crashed renderer resets them, so a stale pin never holds the
 *   surface open.
 * - A pointer leave-park the gate refused is retried once every pin is gone (onPinsCleared), so the surface
 *   still parks when the pointer stayed away.
 * - IPC.rightEdgeSurface is sent only when the surface changes; a report always answers with the current one.
 * - The Reader (spec v3 §6) is pending from the page's 'reader' report until it reports the island or
 *   top-center, or a reveal must open the island (a pointer on the band, the ask hotkey). A park keeps it
 *   pending, so the next explicit reveal opens the Reader again. While it is pending only an explicit park (Hide, Escape, the hotkey, the
 *   tray, a window blur) applies: the pointer leave-park and the unhovered auto-park never do.
 */
import {
  RIGHT_EDGE_IDLE_STATE,
  rightEdgeParkAllowed,
  type RightEdgeParkCause,
  type RightEdgePin,
  type RightEdgeState,
  type RightEdgeSurface,
  type RightEdgeSurfaceState
} from '@shared/right-edge-state'
import { RE_BLUR_TOGGLE_GRACE_MS } from '@shared/right-edge-timing'

export interface RightEdgeSession {
  pins(): readonly RightEdgePin[]
  /** The surface the page last reported it renders. */
  pageSurface(): RightEdgeSurface
  /** The page's open surface is the Reader: an open window takes readerRect and the cursor watch stands down. */
  readerPending(): boolean
  /** The next reveal opens the island, never the Reader: a pointer reveal from the band, or the ask hotkey. */
  noteIslandReveal(): void
  /** A window blur parked the Reader at `now` (performance.now() ms). */
  noteBlurPark(now: number): void
  /** True once for a tray toggle within RE_BLUR_TOGGLE_GRACE_MS of a blur park: the toggle was that Hide. */
  toggleAbsorbedByBlur(reason: 'hotkey' | 'tray', now: number): boolean
  /** False when the pins or an open Reader refuse this park; a pin refusal is remembered and retried when they clear. */
  parkAllowed(cause: RightEdgeParkCause): boolean
  /** A renderer report: stores it and answers with the current surface. */
  report(state: RightEdgeState): RightEdgeSurfaceState
  /** Sends the current surface when it changed since the last send or report. */
  push(): void
  /** The renderer reloaded or went away. */
  reset(): void
}

export function createRightEdgeSession(deps: {
  surface: () => RightEdgeSurfaceState
  send: (surface: RightEdgeSurfaceState) => void
  onPinsCleared: () => void
  /** The page switched between the island and the Reader: the open window takes the new surface's rect. */
  onReaderChange?: (reader: boolean) => void
  log?: (line: string) => void
}): RightEdgeSession {
  let state: RightEdgeState = RIGHT_EDGE_IDLE_STATE
  let sent: string | null = null
  let reader = false
  let blurParkedAt: number | null = null
  // Refusals since the pins were last clear: each is logged once (the watch asks every tick).
  const refused = new Set<RightEdgeParkCause>()
  return {
    pins: () => state.pins,
    pageSurface: () => state.surface,
    readerPending: () => reader,
    noteIslandReveal() {
      reader = false
    },
    noteBlurPark(now) {
      blurParkedAt = now
    },
    toggleAbsorbedByBlur(reason, now) {
      const at = blurParkedAt
      blurParkedAt = null
      return reason === 'tray' && at !== null && now - at < RE_BLUR_TOGGLE_GRACE_MS
    },
    parkAllowed(cause) {
      if (cause !== 'explicit' && reader) return false
      if (rightEdgeParkAllowed(state.pins, cause)) return true
      if (!refused.has(cause)) deps.log?.(`[right-edge] ${cause} park refused pins=${state.pins.join(',')}`)
      refused.add(cause)
      return false
    },
    report(next) {
      const cleared = state.pins.length > 0 && next.pins.length === 0
      state = next
      // 'rest' keeps the Reader pending: a parked Reader is restored by the next explicit reveal.
      const nextReader = next.surface === 'rest' ? reader : next.surface === 'reader'
      if (nextReader !== reader) {
        reader = nextReader
        deps.onReaderChange?.(reader)
      }
      const surface = deps.surface()
      sent = JSON.stringify(surface)
      if (cleared) {
        // The unhovered auto-park re-fires from the watch on its own; only a refused leave-park needs a retry.
        const retry = refused.has('pointer-leave')
        refused.clear()
        if (retry) deps.onPinsCleared()
      }
      return surface
    },
    push() {
      const surface = deps.surface()
      const key = JSON.stringify(surface)
      if (key === sent) return
      sent = key
      deps.send(surface)
    },
    reset() {
      state = RIGHT_EDGE_IDLE_STATE
      sent = null
      blurParkedAt = null
      if (reader) {
        reader = false
        deps.onReaderChange?.(false)
      }
      refused.clear()
    }
  }
}
