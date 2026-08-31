import { describe, expect, it } from 'vitest'
import {
  BAR_PILL_HEIGHT_PX,
  BAR_PILL_SIZE_PX,
  BAR_PILL_WIDTH_PX,
  FIT_STUDIO_DEEP,
  FIT_STUDIO_HOT,
  FIT_STUDIO_MID,
  ORB_COLOR,
  ORB_DEEP,
  ORB_HOT,
  ORB_MOODS,
  REC_DOT_COLOR,
  SPHERE_RADIUS,
  isFixedCircle,
  isPurpleFamilyIdle,
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
    expect(SPHERE_RADIUS).toBe(0.9)
    expect(REC_DOT_COLOR).toBe(0xf0717a)
    expect(ORB_COLOR.idle).not.toBe(REC_DOT_COLOR)
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

  it('locks Fit Studio purple-magenta glass, not a particle cloud', () => {
    expect(ORB_COLOR.idle).toBe(FIT_STUDIO_MID)
    expect(ORB_COLOR.idle).toBe(0xb266e9)
    expect(ORB_HOT.idle).toBe(FIT_STUDIO_HOT)
    expect(ORB_DEEP.idle).toBe(FIT_STUDIO_DEEP)
    expect(ORB_COLOR.thinking).toBe(FIT_STUDIO_HOT)
    expect(ORB_COLOR.factcheck).toBe(0x5ab8f0)
    expect(ORB_COLOR.connecting).toBe(FIT_STUDIO_DEEP)
    expect(ORB_COLOR.connecting).not.toBe(0x2a0a4a)
    expect(ORB_COLOR.idle).not.toBe(0x7f00da)
    expect(ORB_COLOR.idle).not.toBe(0x4ca8e8)
    expect(isPurpleFamilyIdle()).toBe(true)
    const idle = moodTint('idle')
    const fact = moodTint('factcheck')
    const think = moodTint('thinking')
    const conn = moodTint('connecting')
    expect(idle.r).toBeGreaterThan(0.55)
    expect(idle.b).toBeGreaterThan(0.7)
    expect(idle.g).toBeLessThan(idle.r)
    expect(think.r).toBeGreaterThan(think.g)
    expect(fact.b).toBeGreaterThan(fact.r)
    expect(conn.b).toBeGreaterThan(conn.g)
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

  it('listening does not change the 52 box or paint the sphere rec-dot red', () => {
    expect(orbBoxForMood('idle')).toEqual({ width: 52, height: 52 })
    expect(REC_DOT_COLOR).toBe(0xf0717a)
    expect(ORB_COLOR.idle).toBe(0xb266e9)
    expect(ORB_COLOR.thinking).not.toBe(REC_DOT_COLOR)
    expect(ORB_COLOR.factcheck).not.toBe(REC_DOT_COLOR)
    expect(ORB_COLOR.connecting).not.toBe(REC_DOT_COLOR)
  })

  it('click expands and drag does not', () => {
    expect(pillClickShouldExpand(false)).toBe(true)
    expect(pillClickShouldExpand(true)).toBe(false)
  })

  it('orb rAF runs on a Bar circle and is off on Hide/Island', () => {
    expect(
      shouldRunOrbRaf({ minimized: false, barLayout: true, reducedMotion: false, documentHidden: false })
    ).toBe(true)
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
      orb.setListening(true)
      orb.setHover(0.4, -0.2, true)
      orb.setReducedMotion(true)
      orb.destroy()
    }).not.toThrow()
  })
})
