import { describe, expect, it } from 'vitest'
import { NATIVE_WINDOW_MATRIX, UI_SURFACE_HOST, surfacePolicy, windowPolicy } from './window-layering'

describe('window layering and capture matrix (R038)', () => {
  it('every window that is ever drawn follows the content-protection setting', () => {
    for (const w of NATIVE_WINDOW_MATRIX.filter((x) => x.composited)) {
      expect(['follows-setting', 'always'], w.id).toContain(w.contentProtection)
      expect(w.appearsInCaptureWhenProtected, w.id).toBe(false)
    }
  })

  it('a window that is never drawn takes no level and can never be captured', () => {
    for (const w of NATIVE_WINDOW_MATRIX.filter((x) => !x.composited)) {
      expect(w.alwaysOnTop, w.id).toBeNull()
      expect(w.appearsInCaptureWhenUnprotected, w.id).toBe(false)
    }
  })

  it('has one row per window and per creation site', () => {
    const ids = NATIVE_WINDOW_MATRIX.map((w) => w.id)
    expect(new Set(ids).size).toBe(ids.length)
    const sites = NATIVE_WINDOW_MATRIX.map((w) => `${w.site.module}: ${w.site.variable}`)
    expect(new Set(sites).size).toBe(sites.length)
  })

  it('every UI surface is hosted by a drawn window, so it inherits that protection', () => {
    for (const surface of Object.keys(UI_SURFACE_HOST) as (keyof typeof UI_SURFACE_HOST)[]) {
      expect(surfacePolicy(surface).composited, surface).toBe(true)
    }
  })

  it('the bar, sidecar, confirm card, task cards and voice pill share the overlay window and its top level', () => {
    for (const s of [
      'overlay-bar',
      'right-edge-sidecar',
      'command-confirm-card',
      'task-cards',
      'voice-pill'
    ] as const) {
      expect(UI_SURFACE_HOST[s]).toBe('overlay')
    }
    expect(windowPolicy('overlay').alwaysOnTop).toBe('screen-saver')
  })

  it('the annotation window is always content-protected, click-through at the top level, and hosts screen marks', () => {
    const annotation = windowPolicy('annotation')
    expect(annotation.contentProtection).toBe('always')
    expect(annotation.appearsInCaptureWhenUnprotected).toBe(false)
    expect(annotation.alwaysOnTop).toBe('screen-saver')
    expect(surfacePolicy('screen-marks').id).toBe('annotation')
  })
})
