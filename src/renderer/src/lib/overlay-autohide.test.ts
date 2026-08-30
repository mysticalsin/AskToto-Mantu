import { describe, it, expect } from 'vitest'
import {
  AUTO_HIDE_GRACE_MS,
  REVEAL_DWELL_MS,
  initialAutoHideState,
  isRevealed,
  reduceAutoHide,
  type AutoHideState
} from './overlay-autohide'

/**
 * MQA-274 — Vibe-Island-style auto-hide overlay state machine.
 * MQA-275 — reveal dwell (peek→revealed only commits after `dwell-elapsed`, so a pointer merely crossing
 * the peek strip doesn't instantly flash the bar open).
 *
 * Regression coverage for the pure peek/reveal logic: an enabled overlay must rest as the peek strip,
 * reveal on hover (after the dwell), ease back to peek only after the grace window, stay open while an
 * important event forces it, and never collapse (or spuriously re-render) when auto-hide is off.
 */

/** Test helper mirroring the renderer's dwell-timer effect: enters, then lets the dwell elapse. */
function revealViaHover(s: AutoHideState): AutoHideState {
  return reduceAutoHide(reduceAutoHide(s, { type: 'pointer-enter' }), { type: 'dwell-elapsed' })
}

describe('overlay auto-hide state machine (MQA-274)', () => {
  it('rests as the peek strip when enabled and idle', () => {
    const s = initialAutoHideState(true)
    expect(isRevealed(s)).toBe(false)
  })

  it('is always revealed when auto-hide is disabled', () => {
    const s = initialAutoHideState(false)
    expect(isRevealed(s)).toBe(true)
    // A pointer-leave while disabled must NOT arm a collapse (there is nothing to collapse to).
    const left = reduceAutoHide({ ...s, hovering: true }, { type: 'pointer-leave' })
    expect(left.graceArmed).toBe(false)
    expect(isRevealed(left)).toBe(true)
  })

  it('does NOT reveal on pointer-enter alone — the dwell must elapse first', () => {
    let s = initialAutoHideState(true)
    s = reduceAutoHide(s, { type: 'pointer-enter' })
    expect(s.hoverPending).toBe(true)
    expect(s.hovering).toBe(false)
    expect(isRevealed(s)).toBe(false) // still peeked — no flash
  })

  it('reveals once the dwell elapses, and cancels any pending collapse', () => {
    let s = revealViaHover(initialAutoHideState(true))
    expect(s.hovering).toBe(true)
    expect(s.hoverPending).toBe(false)
    expect(isRevealed(s)).toBe(true)
    // Leaving arms the grace collapse, but the bar stays revealed until the timer fires.
    s = reduceAutoHide(s, { type: 'pointer-leave' })
    expect(s.graceArmed).toBe(true)
    expect(isRevealed(s)).toBe(true)
    // Re-entering within the grace window cancels the pending collapse instantly — already revealed, so
    // no dwell is re-applied.
    s = reduceAutoHide(s, { type: 'pointer-enter' })
    expect(s.graceArmed).toBe(false)
    expect(s.hovering).toBe(true)
    expect(isRevealed(s)).toBe(true)
  })

  it('a pointer-leave before the dwell elapses cancels the reveal outright (no flash, no grace)', () => {
    let s = initialAutoHideState(true)
    s = reduceAutoHide(s, { type: 'pointer-enter' })
    expect(s.hoverPending).toBe(true)
    s = reduceAutoHide(s, { type: 'pointer-leave' })
    expect(s.hoverPending).toBe(false)
    expect(s.hovering).toBe(false)
    expect(s.graceArmed).toBe(false) // never opened, so nothing to ease back from
    expect(isRevealed(s)).toBe(false)
    // A stray dwell-elapsed firing after the cancel (the renderer clears its timeout, but be defensive) is
    // a no-op.
    s = reduceAutoHide(s, { type: 'dwell-elapsed' })
    expect(isRevealed(s)).toBe(false)
  })

  it('hide+leave collapses after grace (same machine hide and island use)', () => {
    let s = revealViaHover(initialAutoHideState(true))
    s = reduceAutoHide(s, { type: 'pointer-leave' })
    expect(isRevealed(s)).toBe(true) // still shown during grace
    s = reduceAutoHide(s, { type: 'grace-elapsed' })
    expect(s.graceArmed).toBe(false)
    expect(s.hovering).toBe(false)
    expect(isRevealed(s)).toBe(false) // now back to the peek strip
  })

  it('a forced event holds the bar open regardless of pointer, then eases back after grace on release', () => {
    let s = initialAutoHideState(true)
    // An important event (recording / live suggestion / error toast) forces the bar open while idle.
    s = reduceAutoHide(s, { type: 'set-forced', forced: true })
    expect(s.forced).toBe(true)
    expect(isRevealed(s)).toBe(true)
    // Pointer leaving while forced must NOT arm a collapse — the force still holds it.
    s = reduceAutoHide(s, { type: 'pointer-leave' })
    expect(s.graceArmed).toBe(false)
    expect(isRevealed(s)).toBe(true)
    // When the event ends and the pointer isn't over it, arm the grace collapse (return to auto-hide).
    s = reduceAutoHide(s, { type: 'set-forced', forced: false })
    expect(s.graceArmed).toBe(true)
    expect(isRevealed(s)).toBe(true)
    s = reduceAutoHide(s, { type: 'grace-elapsed' })
    expect(isRevealed(s)).toBe(false)
  })

  it('entering while forced is already revealing skips the dwell (no flash risk — already shown)', () => {
    let s = initialAutoHideState(true)
    s = reduceAutoHide(s, { type: 'set-forced', forced: true })
    s = reduceAutoHide(s, { type: 'pointer-enter' })
    expect(s.hoverPending).toBe(false)
    expect(s.hovering).toBe(true)
    expect(isRevealed(s)).toBe(true)
  })

  it('a forced event that ends while the pointer is still over it stays revealed with no collapse', () => {
    let s = revealViaHover(initialAutoHideState(true))
    s = reduceAutoHide(s, { type: 'set-forced', forced: true })
    s = reduceAutoHide(s, { type: 'set-forced', forced: false })
    // Hover still holds it open; no collapse should be pending.
    expect(s.graceArmed).toBe(false)
    expect(isRevealed(s)).toBe(true)
  })

  it('disabling auto-hide clears a pending collapse and reveals', () => {
    let s = revealViaHover(initialAutoHideState(true))
    s = reduceAutoHide(s, { type: 'pointer-leave' })
    expect(s.graceArmed).toBe(true)
    s = reduceAutoHide(s, { type: 'set-enabled', enabled: false })
    expect(s.enabled).toBe(false)
    expect(s.graceArmed).toBe(false)
    expect(isRevealed(s)).toBe(true)
  })

  it('returns the same reference on no-op events (so a reducer consumer does not re-render)', () => {
    const s: AutoHideState = initialAutoHideState(true)
    expect(reduceAutoHide(s, { type: 'set-enabled', enabled: true })).toBe(s)
    expect(reduceAutoHide(s, { type: 'set-forced', forced: false })).toBe(s)
    expect(reduceAutoHide(s, { type: 'pointer-leave' })).toBe(s) // not hovering, nothing armed
    expect(reduceAutoHide(s, { type: 'grace-elapsed' })).toBe(s) // nothing armed
    expect(reduceAutoHide(s, { type: 'dwell-elapsed' })).toBe(s) // no dwell pending
    const pending = reduceAutoHide(s, { type: 'pointer-enter' })
    expect(reduceAutoHide(pending, { type: 'pointer-enter' })).toBe(pending) // dwell already pending
    const hovered = reduceAutoHide(pending, { type: 'dwell-elapsed' })
    expect(reduceAutoHide(hovered, { type: 'pointer-enter' })).toBe(hovered) // already hovering
  })

  it('exposes a grace window inside the brief-mandated 400-600ms band', () => {
    expect(AUTO_HIDE_GRACE_MS).toBeGreaterThanOrEqual(400)
    expect(AUTO_HIDE_GRACE_MS).toBeLessThanOrEqual(600)
  })

  it('exposes a reveal dwell short enough to feel immediate but long enough to suppress a flash', () => {
    expect(REVEAL_DWELL_MS).toBeGreaterThanOrEqual(80)
    expect(REVEAL_DWELL_MS).toBeLessThanOrEqual(250)
  })
})
