/**
 * Gesture binding (Métis 2.12 G34, R011). Pure.
 *
 * When the owner starts a gesture (the hold chord, a panel command), main captures one snapshot of what it
 * itself observed at that instant: which app was in front, which session the gesture belongs to, and the owner.
 * A task created from that gesture is bound to the snapshot. If the front app is different by the time the task
 * dispatches, the task refuses with `target_changed`; it never retargets to wherever the pointer or focus went.
 *
 * Nothing in a binding comes from the renderer, a transcript or screen text.
 */

/** The app main saw in front (the foreground watcher's observation): bundle id or window handle, pid, title. */
export interface GestureTarget {
  readonly windowId: string
  readonly pid: number
  readonly title: string
}

export interface GestureBinding {
  readonly bindingId: string
  readonly owner: { readonly webContentsId: number; readonly revision: number }
  readonly sessionId: string
  /** Null when main could not observe the foreground at gesture start: there is then nothing to retarget from. */
  readonly target: GestureTarget | null
  readonly capturedAtMs: number
}

export type TargetCheck = { ok: true } | { ok: false; reason: 'target_changed' }

/**
 * Is the app in front now the one that was in front when the gesture started? Métis itself in front is its own
 * confirmation card, not a change of target. The title is informational and never compared: a page title moves
 * without the owner going anywhere.
 */
export function checkGestureTarget(
  binding: GestureBinding,
  current: GestureTarget | null,
  ownPid: number
): TargetCheck {
  if (!binding.target) return { ok: true }
  if (!current) return { ok: false, reason: 'target_changed' }
  if (current.pid === ownPid) return { ok: true }
  return current.windowId === binding.target.windowId && current.pid === binding.target.pid
    ? { ok: true }
    : { ok: false, reason: 'target_changed' }
}
