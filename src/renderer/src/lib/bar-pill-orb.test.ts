import { describe, expect, it } from 'vitest'
import {
  JARVIS_ORB_COLOR,
  JARVIS_ORB_POINTS,
  connectionIndices,
  fibonacciSphere,
  moodFromListen,
  moodTint,
  mountBarPillOrb,
  pillClickShouldExpand,
  shouldAnimateOrb,
  shouldRunOrbRaf
} from './bar-pill-orb'

describe('bar pill Jarvis orb', () => {
  it('locks the Jarvis look constants', () => {
    expect(JARVIS_ORB_POINTS).toBe(2000)
    expect(JARVIS_ORB_COLOR).toBe(0x4ca8e8)
  })

  it('maps listen state onto orb mood', () => {
    expect(moodFromListen(false, false, false)).toBe('idle')
    expect(moodFromListen(true, false, false)).toBe('listening')
    expect(moodFromListen(true, true, true)).toBe('paused')
    expect(moodFromListen(true, false, true)).toBe('degraded')
  })

  it('degraded tint is amber, not confident cyan', () => {
    const idle = moodTint('idle')
    const degraded = moodTint('degraded')
    expect(degraded.r).toBeGreaterThan(idle.r)
    expect(degraded.g).toBeGreaterThan(0.6)
  })

  it('builds a unit sphere and O(n) constellation lines', () => {
    const pts = fibonacciSphere(64)
    expect(pts.length).toBe(192)
    let max = 0
    for (let i = 0; i < 64; i++) {
      const x = pts[i * 3]
      const y = pts[i * 3 + 1]
      const z = pts[i * 3 + 2]
      max = Math.max(max, Math.abs(Math.hypot(x, y, z) - 1))
    }
    expect(max).toBeLessThan(0.02)
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
      width: 144,
      height: 52,
      clientWidth: 144,
      clientHeight: 52,
      getContext: () => null
    } as unknown as HTMLCanvasElement
    expect(() => {
      const orb = mountBarPillOrb(canvas, { reducedMotion: true, mood: 'idle' })
      orb.setMood('listening')
      orb.setHover(0.4, -0.2, true)
      orb.setReducedMotion(true)
      orb.destroy()
    }).not.toThrow()
  })
})
