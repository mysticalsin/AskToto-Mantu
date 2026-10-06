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
 */
import {
  RIGHT_EDGE_IDLE_STATE,
  rightEdgeParkAllowed,
  type RightEdgeParkCause,
  type RightEdgePin,
  type RightEdgeState,
  type RightEdgeSurfaceState
} from '@shared/right-edge-state'

export interface RightEdgeSession {
  pins(): readonly RightEdgePin[]
  /** False when the pins refuse this park; the refusal is remembered and retried when they clear. */
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
  log?: (line: string) => void
}): RightEdgeSession {
  let state: RightEdgeState = RIGHT_EDGE_IDLE_STATE
  let sent: string | null = null
  // Refusals since the pins were last clear: each is logged once (the watch asks every tick).
  const refused = new Set<RightEdgeParkCause>()
  return {
    pins: () => state.pins,
    parkAllowed(cause) {
      if (rightEdgeParkAllowed(state.pins, cause)) return true
      if (!refused.has(cause)) deps.log?.(`[right-edge] ${cause} park refused pins=${state.pins.join(',')}`)
      refused.add(cause)
      return false
    },
    report(next) {
      const cleared = state.pins.length > 0 && next.pins.length === 0
      state = next
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
      refused.clear()
    }
  }
}
