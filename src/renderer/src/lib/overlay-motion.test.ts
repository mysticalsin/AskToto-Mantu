import { describe, expect, it } from 'vitest'
import {
  OVERLAY_HIDE_MS,
  OVERLAY_PARK_FALLBACK_MS,
  OVERLAY_REVEAL_MS,
  overlayShouldParkNow,
  overlayShowPeek,
  overlaySpringAfterHide,
  overlaySpringAfterReveal,
  overlaySpringClassName
} from './overlay-motion'

describe('overlay hide/reveal spring timings', () => {
  it('reveal is 320–380ms and hide is 280–340ms; park fallback is 400ms', () => {
    expect(OVERLAY_REVEAL_MS).toBeGreaterThanOrEqual(320)
    expect(OVERLAY_REVEAL_MS).toBeLessThanOrEqual(380)
    expect(OVERLAY_HIDE_MS).toBeGreaterThanOrEqual(280)
    expect(OVERLAY_HIDE_MS).toBeLessThanOrEqual(340)
    expect(OVERLAY_PARK_FALLBACK_MS).toBe(400)
    expect(OVERLAY_PARK_FALLBACK_MS).toBeGreaterThan(OVERLAY_HIDE_MS)
  })

  it('reduced-motion skips the spring and parks immediately; otherwise hide waits', () => {
    expect(overlaySpringAfterReveal(false)).toBe('in')
    expect(overlaySpringAfterReveal(true)).toBe('settled')
    expect(overlaySpringAfterHide(false)).toBe('out')
    expect(overlaySpringAfterHide(true)).toBe('rest')
    expect(overlayShouldParkNow('out', false)).toBe(true)
    expect(overlayShouldParkNow('in', false)).toBe(false)
    expect(overlayShouldParkNow('settled', true)).toBe(true)
  })

  it('shows the hide pad only when fully parked — bar stays mounted during the spring', () => {
    expect(overlayShowPeek(true, false, 'rest')).toBe(true)
    expect(overlayShowPeek(true, false, 'out')).toBe(false)
    expect(overlayShowPeek(true, false, 'in')).toBe(false)
    expect(overlayShowPeek(true, true, 'settled')).toBe(false)
    expect(overlayShowPeek(false, false, 'rest')).toBe(false)
    expect(overlayShowPeek(true, false, 'rest', true)).toBe(false)
    expect(overlaySpringClassName('in')).toMatch(/overlay-spring--in/)
    expect(overlaySpringClassName('out')).toMatch(/overlay-spring--out/)
  })
})
