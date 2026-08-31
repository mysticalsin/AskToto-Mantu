/**
 * Auto-hide overlay state machine (MQA-274) — the pure logic behind the Vibe-Island-style peek/reveal.
 *
 * Kept as a standalone, side-effect-free reducer so it can be unit-tested with fake timers, away from the
 * DOM and IPC. The renderer (App.tsx) owns the effects: it pushes `enabled`/`forced` from the live
 * settings + view state, wires pointer-enter/leave to the container, schedules the grace timer whenever
 * `graceArmed` flips true, and reads `isRevealed()` to decide whether to render the full bar or the slim
 * peek strip. The window itself resizes to hug whichever surface is shown — no show/focus call is ever
 * involved, which is what keeps the reveal non-activating.
 */

/** Grace period (ms) after the pointer leaves the revealed overlay before it collapses back to the peek
 *  strip. Long enough to survive a small overshoot / crossing a hairline gap without the bar flickering
 *  shut, short enough that a deliberate leave feels responsive. Sits in the 400-600ms band the product
 *  brief calls for. */
export const AUTO_HIDE_GRACE_MS = 500

/** Dwell (ms) the pointer must rest over the peek strip before it expands into the full bar. Without this,
 *  a pointer merely crossing the top edge of the screen (moving to another app, a menu bar click, etc.)
 *  would instantly flash the bar open and shut. Short enough that a deliberate hover still feels
 *  immediate. Only gates the peek→revealed transition — re-entering while already revealed (e.g. during
 *  the grace window, or while a force event holds it open) stays instant since nothing would "flash". */
export const REVEAL_DWELL_MS = 150

export interface AutoHideState {
  /** Auto-hide is in effect: the setting is on AND the overlay is in its idle bar surface (not minimized,
   *  no answer/panel open). When false the bar is always revealed. */
  enabled: boolean
  /** The pointer is currently over the overlay (peek strip or full bar). */
  hovering: boolean
  /** An important event (recording, a live suggestion, an error toast, in-flight input) is forcing the
   *  bar open regardless of pointer position. */
  forced: boolean
  /** A collapse is scheduled: the pointer has left (or a force event ended) but the grace timer has not
   *  yet elapsed, so the bar is still shown for now. */
  graceArmed: boolean
  /** The pointer entered the (still-collapsed) peek strip and the reveal dwell timer is running. Does NOT
   *  by itself reveal the bar — only `dwell-elapsed` flips `hovering`, and a `pointer-leave` before then
   *  cancels it with no reveal ever happening. */
  hoverPending: boolean
}

export function initialAutoHideState(enabled: boolean): AutoHideState {
  return { enabled, hovering: false, forced: false, graceArmed: false, hoverPending: false }
}

/** The single derived question the renderer asks each render: show the full bar (true) or the slim peek
 *  strip (false)? Revealed whenever auto-hide is off, the pointer is over it, an event forces it open, or
 *  a collapse is merely pending (still inside the grace window). `hoverPending` deliberately does NOT
 *  count — the dwell timer must elapse first. */
export function isRevealed(s: AutoHideState): boolean {
  return !s.enabled || s.hovering || s.forced || s.graceArmed
}

export type AutoHideEvent =
  | { type: 'set-enabled'; enabled: boolean }
  | { type: 'set-forced'; forced: boolean }
  | { type: 'pointer-enter' }
  | { type: 'pointer-leave' }
  | { type: 'grace-elapsed' }
  | { type: 'dwell-elapsed' }
  | { type: 'collapse-now' }

/** Pure transition. Returns the SAME reference when nothing changes so a `useReducer` consumer doesn't
 *  re-render on a no-op event (e.g. a repeated pointer-enter, or set-enabled to the current value). */
export function reduceAutoHide(s: AutoHideState, e: AutoHideEvent): AutoHideState {
  switch (e.type) {
    case 'set-enabled': {
      if (e.enabled === s.enabled) return s
      // Toggling the setting resets any pending collapse: turning it OFF means always-revealed (nothing to
      // collapse), turning it ON starts from a clean slate so it settles to peek unless hover/force holds
      // it open.
      return { ...s, enabled: e.enabled, graceArmed: false }
    }
    case 'set-forced': {
      if (e.forced === s.forced) return s
      // A new force event cancels any pending collapse. When the force ENDS, arm the grace timer so the
      // overlay eases back to peek rather than snapping shut the instant the event clears — unless the
      // pointer is over it (hover keeps it open, no collapse wanted) or auto-hide is off.
      return {
        ...s,
        forced: e.forced,
        graceArmed: e.forced ? false : s.enabled && !s.hovering
      }
    }
    case 'pointer-enter': {
      if (isRevealed(s)) {
        // Already shown (grace window, forced open, or auto-hide off) — no dwell needed, entering just
        // cancels a pending collapse and marks hover.
        if (s.hovering && !s.graceArmed && !s.hoverPending) return s
        return { ...s, hovering: true, graceArmed: false, hoverPending: false }
      }
      // Still collapsed to the peek strip: start the reveal dwell instead of expanding immediately.
      if (s.hoverPending) return s
      return { ...s, hoverPending: true }
    }
    case 'pointer-leave': {
      if (!s.hovering && !s.graceArmed && !s.hoverPending) return s
      // A leave before the dwell elapsed cancels it outright — the bar never opened, so there's nothing to
      // ease back from. Otherwise, only schedule a collapse when auto-hide is on and nothing else is
      // forcing the bar open.
      return { ...s, hovering: false, hoverPending: false, graceArmed: s.enabled && !s.forced && s.hovering }
    }
    case 'grace-elapsed': {
      if (!s.graceArmed) return s
      return { ...s, graceArmed: false }
    }
    case 'dwell-elapsed': {
      if (!s.hoverPending) return s
      return { ...s, hoverPending: false, hovering: true }
    }
    case 'collapse-now': {
      // Leave pill / Settings → Hide: park immediately. Do not arm grace (that kept a stub bar).
      if (!s.hovering && !s.graceArmed && !s.hoverPending) return s
      return { ...s, hovering: false, hoverPending: false, graceArmed: false }
    }
    default:
      return s
  }
}
