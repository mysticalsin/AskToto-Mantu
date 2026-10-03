/**
 * right-edge-state.ts — the right-edge IPC contract (M2-0202, spec v3 §2, §4).
 *
 * IPC.rightEdgeState (renderer → main, invoke): the surface the page renders, its content height and the pins
 * holding it open; main replies with the current RightEdgeSurfaceState. IPC.rightEdgeSurface (main → renderer):
 * the same RightEdgeSurfaceState whenever it changes. The renderer takes its placement only from it.
 *
 * Invariants:
 * - While any pin is set, main refuses the pointer leave-park and the unhovered auto-park.
 * - An explicit Hide (control, Escape, hotkey, tray) parks under every pin except an IME composition: the IME
 *   owns the keyboard until it commits or cancels.
 */
import { z } from 'zod'

/** The nine pins, in report order. Each one's source is in src/renderer/src/lib/right-edge/pins.ts. */
export const RIGHT_EDGE_PINS = [
  'user',
  'typing',
  'ime',
  'menu',
  'drag',
  'dialog',
  'approval',
  'execution',
  'outcome'
] as const
export type RightEdgePin = (typeof RIGHT_EDGE_PINS)[number]

/** 'top-center' when the right edge does not apply (the preference, or a work area too small for it). */
export const RIGHT_EDGE_SURFACES = ['top-center', 'rest', 'island', 'reader'] as const
export type RightEdgeSurface = (typeof RIGHT_EDGE_SURFACES)[number]

/** 'none' is the invisible Hide band, 'tab' the legacy Island rail (until the S5 flip), 'handle' the 24x72 rest. */
export type RightEdgeSurfaceRestKind = 'none' | 'tab' | 'handle'
/** W: the work area reaches the display edge. D: a Dock or taskbar sits on that edge. S: another display
 *  continues past it. A: reserved for the edge classes of S6. */
export type RightEdgeEdgeClass = 'W' | 'D' | 'S' | 'A'

export interface RightEdgeSurfaceState {
  surface: RightEdgeSurface
  restKind: RightEdgeSurfaceRestKind
  edgeClass: RightEdgeEdgeClass
  /** H_max, the tallest island card the work area holds (0 for top-center). */
  cardMaxHeight: number
  /** The tallest content slot inside that card (0 for top-center). */
  slotMax: number
}

export const RightEdgeStateSchema = z.object({
  surface: z.enum(RIGHT_EDGE_SURFACES),
  contentHeight: z.number().finite().min(0).max(100_000),
  pins: z.array(z.enum(RIGHT_EDGE_PINS)).max(RIGHT_EDGE_PINS.length)
})
export type RightEdgeState = z.infer<typeof RightEdgeStateSchema>

export const RIGHT_EDGE_IDLE_STATE: RightEdgeState = { surface: 'top-center', contentHeight: 0, pins: [] }

/** pointer-leave: the pointer left the hold region. auto-park: a reveal the pointer never visited timed out.
 *  explicit: Hide, Escape, the hotkey or tray toggle. */
export type RightEdgeParkCause = 'pointer-leave' | 'auto-park' | 'explicit'

export function rightEdgeParkAllowed(pins: readonly RightEdgePin[], cause: RightEdgeParkCause): boolean {
  if (cause === 'explicit') return !pins.includes('ime')
  return pins.length === 0
}
