import { describe, expect, it } from 'vitest'
import {
  BAR_PILL_HEIGHT_PX,
  BAR_PILL_SIZE_PX,
  BAR_PILL_WIDTH_PX,
  JARVIS_ORB_COLOR,
  JARVIS_ORB_POINTS,
  ORB_COLOR,
  ORB_MOODS,
  ORB_NDC_SCALE,
  connectionIndices,
  fibonacciSphere,
  isFixedCircle,
  moodTint,
  mountBarPillOrb,
  orbAspectRatio,
  orbBoxForMood,
  pillClickShouldExpand,
  resolveOrbMood,
  shouldAnimateOrb,
  shouldRunOrbRaf
} from './bar-pill-orb'

describe('bar pill sentient circle', () => {
  it('is a fixed circle: equal width and height, never a stadium', () => {
    expect(BAR_PILL_WIDTH_PX).toBe(BAR_PILL_HEIGHT_PX)
    expect(BAR_PILL_WIDTH_PX).toBe(BAR_PILL_SIZE_PX)
    expect(isFixedCircle(BAR_PILL_WIDTH_PX, BAR_PILL_HEIGHT_PX)).toBe(true)
    expect(orbAspectRatio()).toBe(1)
    expect(ORB_NDC_SCALE).toBeGreaterThan(0)
  })

  it('aspect ratio is 1 and bounding box is constant on every mood', () => {
    const rest = orbBoxForMood('idle')
    for (const mood of ORB_MOODS) {
      const box = orbBoxForMood(mood)
      expect(box.width).toBe(box.height)
      expect(box).toEqual(rest)
      expect(orbAspectRatio(box.width, box.height)).toBe(1)
    }
  })

  it('locks particle craft and the product color language', () => {
    expect(JARVIS_ORB_POINTS).toBe(2000)
    expect(ORB_COLOR.idle).toBe(0x7f00da)
    expect(ORB_COLOR.thinking).toBe(0x9a2bf0)
    expect(ORB_COLOR.factcheck).toBe(0x4ca8e8)
    expect(ORB_COLOR.connecting).toBe(0x2a0a4a)
    expect(JARVIS_ORB_COLOR).toBe(ORB_COLOR.factcheck)
    const idle = moodTint('idle')
    const fact = moodTint('factcheck')
    const think = moodTint('thinking')
    const conn = moodTint('connecting')
    expect(idle.r).toBeGreaterThan(idle.g)
    expect(idle.b).toBeGreaterThan(idle.r)
    expect(fact.b).toBeGreaterThan(fact.r)
    expect(think.r).toBeGreaterThan(idle.r)
    expect(conn.r + conn.g + conn.b).toBeLessThan(idle.r + idle.g + idle.b)
  })

  it('resolves orbMood with connecting > factcheck > thinking > idle', () => {
    expect(resolveOrbMood({})).toBe('idle')
    expect(resolveOrbMood({ thinking: true })).toBe('thinking')
    expect(resolveOrbMood({ factcheck: true })).toBe('factcheck')
    expect(resolveOrbMood({ connecting: true })).toBe('connecting')
    expect(resolveOrbMood({ thinking: true, factcheck: true })).toBe('factcheck')
    expect(resolveOrbMood({ connecting: true, factcheck: true, thinking: true })).toBe('connecting')
  })

  it('builds a unit sphere and O(n) constellation lines', () => {
    const pts = fibonacciSphere(64)
    expect(pts.length).toBe(192)
    let max = 0
    let maxX = 0
    let maxY = 0
    for (let i = 0; i < 64; i++) {
      const x = pts[i * 3]
      const y = pts[i * 3 + 1]
      const z = pts[i * 3 + 2]
      max = Math.max(max, Math.abs(Math.hypot(x, y, z) - 1))
      maxX = Math.max(maxX, Math.abs(x))
      maxY = Math.max(maxY, Math.abs(y))
    }
    expect(max).toBeLessThan(0.02)
    expect(Math.abs(maxX - maxY)).toBeLessThan(0.08)
    const lines = connectionIndices(64)
    expect(lines.length).toBe(64 * 3 * 2)
    expect(lines.length % 2).toBe(0)
    const t0 = performance.now()
    const big = connectionIndices(2000)
    expect(performance.now() - t0).toBeLessThan(15)
    expect(big.length).toBe(2000 * 3 * 2)
  })

  it('click expands and drag does not', () => {
    expect(pillClickShouldExpand(false)).toBe(true)
    expect(pillClickShouldExpand(true)).toBe(false)
  })

  it('orb rAF is off when the bar is idle', () => {
    expect(
      shouldRunOrbRaf({ minimized: false, barLayout: true, reducedMotion: false, documentHidden: false })
    ).toBe(false)
    expect(
      shouldRunOrbRaf({ minimized: true, barLayout: false, reducedMotion: false, documentHidden: false })
    ).toBe(false)
    expect(
      shouldRunOrbRaf({ minimized: true, barLayout: true, reducedMotion: true, documentHidden: false })
    ).toBe(false)
    expect(
      shouldRunOrbRaf({ minimized: true, barLayout: true, reducedMotion: false, documentHidden: true })
    ).toBe(false)
    expect(
      shouldRunOrbRaf({ minimized: true, barLayout: true, reducedMotion: false, documentHidden: false })
    ).toBe(true)
  })

  it('reduced-motion is a still frame and mount does not throw without WebGL', () => {
    expect(shouldAnimateOrb(true)).toBe(false)
    expect(shouldAnimateOrb(false)).toBe(true)
    const canvas = {
      width: BAR_PILL_SIZE_PX,
      height: BAR_PILL_SIZE_PX,
      clientWidth: BAR_PILL_SIZE_PX,
      clientHeight: BAR_PILL_SIZE_PX,
      getContext: () => null
    } as unknown as HTMLCanvasElement
    expect(() => {
      const orb = mountBarPillOrb(canvas, { reducedMotion: true, mood: 'idle' })
      orb.setMood('thinking')
      orb.setMood('factcheck')
      orb.setMood('connecting')
      orb.setHover(0.4, -0.2, true)
      orb.setReducedMotion(true)
      orb.destroy()
    }).not.toThrow()
  })
})
