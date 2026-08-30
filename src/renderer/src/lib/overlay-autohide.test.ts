import { describe, it, expect } from 'vitest'
import {
  AUTO_HIDE_GRACE_MS,
  initialAutoHideState,
  isRevealed,
  reduceAutoHide,
  type AutoHideState
} from './overlay-autohide'

/**
 * MQA-274 — Vibe-Island-style auto-hide overlay state machine.
 *
 * Regression coverage for the pure peek/reveal logic: an enabled overlay must rest as the peek strip,
 * reveal on hover, ease back to peek only after the grace window, stay open while an important event
 * forces it, and never collapse (or spuriously re-render) when auto-hide is off.
 */
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

  it('reveals on pointer-enter and cancels any pending collapse', () => {
    let s = initialAutoHideState(true)
    s = reduceAutoHide(s, { type: 'pointer-enter' })
    expect(s.hovering).toBe(true)
    expect(isRevealed(s)).toBe(true)
    // Leaving arms the grace collapse, but the bar stays revealed until the timer fires.
    s = reduceAutoHide(s, { type: 'pointer-leave' })
    expect(s.graceArmed).toBe(true)
    expect(isRevealed(s)).toBe(true)
    // Re-entering within the grace window cancels the pending collapse.
    s = reduceAutoHide(s, { type: 'pointer-enter' })
    expect(s.graceArmed).toBe(false)
    expect(s.hovering).toBe(true)
    expect(isRevealed(s)).toBe(true)
  })

  it('collapses to peek only after the grace window elapses', () => {
    let s = reduceAutoHide(initialAutoHideState(true), { type: 'pointer-enter' })
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

  it('a forced event that ends while the pointer is still over it stays revealed with no collapse', () => {
    let s = reduceAutoHide(initialAutoHideState(true), { type: 'pointer-enter' })
    s = reduceAutoHide(s, { type: 'set-forced', forced: true })
    s = reduceAutoHide(s, { type: 'set-forced', forced: false })
    // Hover still holds it open; no collapse should be pending.
    expect(s.graceArmed).toBe(false)
    expect(isRevealed(s)).toBe(true)
  })

  it('disabling auto-hide clears a pending collapse and reveals', () => {
    let s = reduceAutoHide(initialAutoHideState(true), { type: 'pointer-enter' })
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
    const hovered = reduceAutoHide(s, { type: 'pointer-enter' })
    expect(reduceAutoHide(hovered, { type: 'pointer-enter' })).toBe(hovered) // already hovering
  })

  it('exposes a grace window inside the brief-mandated 400-600ms band', () => {
    expect(AUTO_HIDE_GRACE_MS).toBeGreaterThanOrEqual(400)
    expect(AUTO_HIDE_GRACE_MS).toBeLessThanOrEqual(600)
  })
})
