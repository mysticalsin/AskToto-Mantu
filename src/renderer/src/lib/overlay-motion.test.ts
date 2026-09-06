import { describe, expect, it } from 'vitest'
import {
  OVERLAY_HIDE_MS,
  OVERLAY_PARK_FALLBACK_MS,
  OVERLAY_REVEAL_MS,
  overlayShouldParkNow,
  overlayShowPeek,
  overlaySpringAfterHide,
  overlaySpringAfterReveal,
  overlaySpringClassName,
  CIRCLE_REST_COLLAPSE_MS,
  CIRCLE_REST_EXPAND_MS,
  circleRestSpringAfterCollapse,
  circleRestSpringAfterExpand,
  circleRestSpringClassName
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

  it('Circle/Jarvis expand is a spring, not a hard cut; reduced-motion skips it', () => {
    expect(CIRCLE_REST_EXPAND_MS).toBeGreaterThanOrEqual(380)
    expect(CIRCLE_REST_EXPAND_MS).toBeLessThanOrEqual(480)
    expect(CIRCLE_REST_COLLAPSE_MS).toBeGreaterThanOrEqual(280)
    expect(CIRCLE_REST_COLLAPSE_MS).toBeLessThanOrEqual(380)
    expect(circleRestSpringAfterExpand(false)).toBe('expand')
    expect(circleRestSpringAfterExpand(true)).toBe('idle')
    expect(circleRestSpringAfterCollapse(false)).toBe('collapse')
    expect(circleRestSpringAfterCollapse(true)).toBe('idle')
    expect(circleRestSpringClassName('expand')).toMatch(/circle-rest-spring--expand/)
    expect(circleRestSpringClassName('collapse')).toMatch(/circle-rest-spring--collapse/)
    expect(circleRestSpringClassName('expand')).not.toMatch(/overlay-spring/)
    expect(circleRestSpringClassName('idle')).not.toMatch(/overlay-spring/)
  })
})
