import { describe, expect, it } from 'vitest'
import { paintOrbFirstFrame } from './orb-first-frame'
import {
  BAR_ORB_SPEED,
  BAR_ORB_THEME,
  BAR_PILL_HEIGHT_PX,
  BAR_PILL_SIZE_PX,
  BAR_PILL_WIDTH_PX,
  ORB_MOODS,
  ORB_STATE,
  isFixedCircle,
  orbAspectRatio,
  orbBoxForMood,
  orbHostPaintsText,
  pillClickShouldExpand,
  resolveBarOrbState,
  resolveOrbMood,
  shouldAnimateOrb,
  shouldRunOrbRaf,
  shouldShowOrbRecDot
} from './bar-pill-orb'

describe('bar pill thinking-orb circle', () => {
  it('is a fixed circle: equal width and height, never a stadium', () => {
    expect(BAR_PILL_WIDTH_PX).toBe(BAR_PILL_HEIGHT_PX)
    expect(BAR_PILL_WIDTH_PX).toBe(BAR_PILL_SIZE_PX)
    expect(BAR_PILL_SIZE_PX).toBe(64)
    expect(isFixedCircle(BAR_PILL_WIDTH_PX, BAR_PILL_HEIGHT_PX)).toBe(true)
    expect(orbAspectRatio()).toBe(1)
    expect(shouldShowOrbRecDot(true)).toBe(false)
    expect(shouldShowOrbRecDot(false)).toBe(false)
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

  it('locks playground pixels: idle solving, listen listening, think working', () => {
    // orbs.jakubantalik.com 64px 1.00x — Tony Mac-show: solving is the rest circle.
    expect(resolveBarOrbState({ mood: 'idle' })).toBe('solving')
    expect(resolveBarOrbState({ mood: 'idle', listening: true })).toBe('listening')
    expect(resolveBarOrbState({ mood: 'thinking' })).toBe('working')
    expect(BAR_PILL_SIZE_PX).toBe(64)
    expect(BAR_ORB_THEME).toBe('dark')
    expect(BAR_ORB_SPEED).toBe(1)
  })

  it('maps moods to Jakub thinking-orb states, monochrome dark', () => {
    expect(ORB_STATE.idle).toBe('solving')
    expect(ORB_STATE.thinking).toBe('working')
    expect(ORB_STATE.factcheck).toBe('searching')
    expect(ORB_STATE.connecting).toBe('connecting')
    expect(BAR_ORB_THEME).toBe('dark')
    expect(resolveBarOrbState({ mood: 'idle' })).toBe('solving')
    expect(resolveBarOrbState({ mood: 'thinking' })).toBe('working')
    expect(resolveBarOrbState({ mood: 'factcheck' })).toBe('searching')
    expect(resolveBarOrbState({ mood: 'connecting' })).toBe('connecting')
    expect(resolveBarOrbState({ mood: 'idle', listening: true })).toBe('listening')
    expect(resolveBarOrbState({ mood: 'thinking', listening: true })).toBe('listening')
    expect(resolveBarOrbState({ mood: 'connecting', listening: true })).toBe('connecting')
  })

  it('resolves orbMood with connecting > factcheck > thinking > idle', () => {
    expect(resolveOrbMood({})).toBe('idle')
    expect(resolveOrbMood({ thinking: true })).toBe('thinking')
    expect(resolveOrbMood({ factcheck: true })).toBe('factcheck')
    expect(resolveOrbMood({ connecting: true })).toBe('connecting')
    expect(resolveOrbMood({ thinking: true, factcheck: true })).toBe('factcheck')
    expect(resolveOrbMood({ connecting: true, factcheck: true, thinking: true })).toBe('connecting')
  })

  it('listening does not change the 64 box and does not add a rec-dot', () => {
    expect(orbBoxForMood('idle')).toEqual({ width: 64, height: 64 })
    expect(shouldShowOrbRecDot(true)).toBe(false)
    expect(resolveBarOrbState({ mood: 'idle', listening: true })).toBe('listening')
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

  it('reduced-motion is a still package frame and does not throw without canvas', () => {
    expect(shouldAnimateOrb(true)).toBe(false)
    expect(shouldAnimateOrb(false)).toBe(true)
    const matchMedia = (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false
      },
      onchange: null
    })
    // @ts-expect-error test stub
    globalThis.matchMedia = matchMedia
    const canvas = {
      width: BAR_PILL_SIZE_PX,
      height: BAR_PILL_SIZE_PX,
      getContext: () => null
    } as unknown as HTMLCanvasElement
    expect(() => {
      paintOrbFirstFrame(canvas, 'solving', BAR_PILL_SIZE_PX, true)
      paintOrbFirstFrame(canvas, 'listening', BAR_PILL_SIZE_PX, true)
      paintOrbFirstFrame(canvas, 'working', BAR_PILL_SIZE_PX, true)
    }).not.toThrow()
  })

  it('does not paint playground captions on the orb host', () => {
    expect(orbHostPaintsText('<span class="aw-orb__host"><canvas></canvas></span>')).toBe(false)
    expect(orbHostPaintsText('<span class="aw-orb__host">Solving…</span>')).toBe(true)
    expect(orbHostPaintsText('<button data-bar-pill-orb aria-label="Solving…"><canvas></canvas></button>')).toBe(
      false
    )
    expect(orbHostPaintsText('<button data-bar-pill-orb><span>Solving</span></button>')).toBe(true)
  })
})
