import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initialAutoHideState, isRevealed, reduceAutoHide } from './overlay-autohide'
import {
  OVERLAY_HIDE_MS,
  OVERLAY_PARK_FALLBACK_MS,
  OVERLAY_REVEAL_MS,
  overlayHideParkedClassName,
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
    expect(overlaySpringClassName('in', 'right')).toMatch(/overlay-spring--edge-right/)
    expect(overlaySpringClassName('out', 'right')).toMatch(/overlay-spring--edge-right/)
    expect(overlaySpringClassName('settled', 'right')).toMatch(/overlay-spring--edge-right/)
  })

  it('M2-0431: a parked Hide paints nothing, and only while it rests parked', () => {
    expect(overlayHideParkedClassName('rest', false, true)).toBe('overlay-spring--parked')
    expect(overlayHideParkedClassName('in', false, true)).toBe('')
    expect(overlayHideParkedClassName('out', false, true)).toBe('')
    expect(overlayHideParkedClassName('rest', true, true)).toBe('')
    expect(overlayHideParkedClassName('rest', false, false)).toBe('')
  })

  it("M2-0431: main's hotkey/tray reveal notification un-parks the page, and the pointer staying away keeps it painted", () => {
    // Main sends { hovering: true } after it restores a parked top-center Hide; the page maps it to a native reveal-now.
    let s = reduceAutoHide(initialAutoHideState(true), { type: 'reveal-now', native: true })
    expect(overlayHideParkedClassName('rest', isRevealed(s), true)).toBe('')
    // No pointer ever entered, so no page leave; a stray one does not end main's hold either.
    s = reduceAutoHide(s, { type: 'pointer-leave' })
    expect(isRevealed(s)).toBe(true)
    expect(overlayHideParkedClassName('rest', isRevealed(s), true)).toBe('')
  })

  it('M2-0431: the Hide/Island spring fades opacity (no hard cuts); reduced motion zeroes its duration', () => {
    const css = readFileSync(join(__dirname, '../styles/overlay-motion.css'), 'utf8').replace(/\r\n/g, '\n')
    const frame = (name: string, stop: 'from' | 'to'): string => {
      const body = css.slice(css.indexOf(`@keyframes ${name} {`))
      const at = body.indexOf(`${stop} {`)
      return body.slice(at, body.indexOf('}', at))
    }
    for (const name of ['overlay-spring-in', 'overlay-spring-in-right']) {
      expect(frame(name, 'from')).toMatch(/opacity: 0;/)
      expect(frame(name, 'to')).toMatch(/opacity: 1;/)
    }
    for (const name of ['overlay-spring-out', 'overlay-spring-out-right']) {
      expect(frame(name, 'from')).toMatch(/opacity: 1;/)
      expect(frame(name, 'to')).toMatch(/opacity: 0;/)
    }
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/animation-duration: 0ms !important;/)
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
