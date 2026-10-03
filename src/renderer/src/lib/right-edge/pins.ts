/**
 * pins.ts — the nine right-edge pins (M2-0202, spec v3 §4) and the page state each one comes from. A pin
 * holds the surface open: while any is set the page keeps its auto-hide forced open and main refuses the
 * pointer leave-park and the unhovered auto-park (shared/right-edge-state.ts). An explicit Hide parks under
 * every pin except an IME composition.
 *
 *   user       the user pinned the surface open (the status control's "keep open", a click on the handle)
 *   typing     a keystroke in the composer, or a pointerdown in it, within RE_TYPING_PIN_MS
 *   ime        an IME composition is in progress in the composer
 *   menu       a menu or list is open
 *   drag       the surface is being dragged
 *   dialog     a confirm sheet or dialog is open
 *   approval   an action waits for the user's approval
 *   execution  an approved action is running
 *   outcome    an action ran and its outcome is not known yet
 *
 * A notice (an error, a status line) is not a pin: it never holds the surface open on its own.
 */
import { useCallback, useEffect, useState } from 'react'
import { RIGHT_EDGE_PINS, type RightEdgePin } from '@shared/right-edge-state'
import { RE_TYPING_PIN_MS } from '@shared/right-edge-timing'

export { RIGHT_EDGE_PINS, type RightEdgePin }

export interface RightEdgePinSources {
  userPinned?: boolean
  /** Epoch ms of the last composer keystroke or pointerdown. */
  lastKeystrokeAt?: number | null
  composing?: boolean
  menuOpen?: boolean
  dragging?: boolean
  dialogOpen?: boolean
  approvalPending?: boolean
  executing?: boolean
  outcomeUnknown?: boolean
}

/** How long the typing pin still holds at `now` (0 once it has lapsed). */
export function typingPinRemainingMs(lastKeystrokeAt: number | null | undefined, now: number): number {
  if (lastKeystrokeAt == null) return 0
  return Math.max(0, lastKeystrokeAt + RE_TYPING_PIN_MS - now)
}

/** The pins set at `now`, in RIGHT_EDGE_PINS order. */
export function rightEdgePins(sources: RightEdgePinSources, now: number): RightEdgePin[] {
  const set: Record<RightEdgePin, boolean> = {
    user: sources.userPinned === true,
    typing: typingPinRemainingMs(sources.lastKeystrokeAt, now) > 0,
    ime: sources.composing === true,
    menu: sources.menuOpen === true,
    drag: sources.dragging === true,
    dialog: sources.dialogOpen === true,
    approval: sources.approvalPending === true,
    execution: sources.executing === true,
    outcome: sources.outcomeUnknown === true
  }
  return RIGHT_EDGE_PINS.filter((pin) => set[pin])
}

/**
 * An attention item (an approval waiting, an outcome to see) reveals the surface once. The returned check is
 * true the first time it sees an item id and false for it ever after, so a Hide after the reveal holds until
 * the next item. The reveal is explicit: it clears the Hide latch the pointer would otherwise need to leave.
 */
export function createAttentionLatch(): (itemId: string | null | undefined) => boolean {
  const seen = new Set<string>()
  return (itemId) => {
    if (!itemId || seen.has(itemId)) return false
    seen.add(itemId)
    return true
  }
}

/**
 * The composer-owned pins (typing, ime) plus the page's other sources. Re-renders when the typing pin lapses,
 * so the pins the page reports drop it exactly RE_TYPING_PIN_MS after the last keystroke.
 */
export function useRightEdgePins(sources: Omit<RightEdgePinSources, 'lastKeystrokeAt' | 'composing'>): {
  pins: RightEdgePin[]
  noteComposerActivity: () => void
  setComposing: (composing: boolean) => void
} {
  const [lastKeystrokeAt, setLastKeystrokeAt] = useState<number | null>(null)
  const [composing, setComposing] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const noteComposerActivity = useCallback((): void => {
    const at = Date.now()
    setLastKeystrokeAt(at)
    setNow(at)
  }, [])
  useEffect(() => {
    const remaining = typingPinRemainingMs(lastKeystrokeAt, now)
    if (remaining <= 0) return
    const timer = window.setTimeout(() => setNow(Date.now()), remaining)
    return () => window.clearTimeout(timer)
  }, [lastKeystrokeAt, now])
  return { pins: rightEdgePins({ ...sources, lastKeystrokeAt, composing }, now), noteComposerActivity, setComposing }
}
