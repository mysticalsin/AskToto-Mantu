import { describe, expect, it } from 'vitest'
import {
  CaptureResultSchema,
  ScreenObservationIdentitySchema,
  ScreenScopeSchema,
  screenSourceId
} from './screen-observation'
import { CaptureResultSchema as ReExported } from './ipc'

describe('screen observation scope (G16)', () => {
  it('accepts a display, a window and a region scope', () => {
    expect(ScreenScopeSchema.parse({ kind: 'display' })).toEqual({ kind: 'display' })
    expect(ScreenScopeSchema.parse({ kind: 'window', windowId: 'window:42:0' })).toEqual({
      kind: 'window',
      windowId: 'window:42:0'
    })
    const region = { x: 0.1, y: 0.2, width: 0.5, height: 0.25 }
    expect(ScreenScopeSchema.parse({ kind: 'region', region })).toEqual({ kind: 'region', region })
  })

  it('refuses a region that leaves the display, is empty, or is not a number', () => {
    const bad = [
      { x: 0.8, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0.9, width: 0.5, height: 0.2 },
      { x: -0.1, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0, width: 0, height: 0.5 },
      { x: 0, y: 0, width: Number.NaN, height: 0.5 }
    ]
    for (const region of bad) expect(ScreenScopeSchema.safeParse({ kind: 'region', region }).success).toBe(false)
  })

  it('refuses an unknown kind, an extra field smuggled onto a display scope and an empty window id', () => {
    expect(ScreenScopeSchema.safeParse({ kind: 'desktop' }).success).toBe(false)
    expect(ScreenScopeSchema.safeParse({ kind: 'window', windowId: '' }).success).toBe(false)
    expect(ScreenScopeSchema.safeParse({ kind: 'window', windowId: 'x'.repeat(129) }).success).toBe(false)
    expect(ScreenScopeSchema.safeParse({ kind: 'display', displayId: 9 }).success).toBe(false)
  })
})

describe('screen source id (G16)', () => {
  it('names the display, the region on it and the window', () => {
    expect(screenSourceId({ kind: 'display' }, 7)).toBe('display:7')
    expect(screenSourceId({ kind: 'region', region: { x: 0.1, y: 0.25, width: 0.5, height: 0.5 } }, 7)).toBe(
      'display:7/region:0.1,0.25,0.5,0.5'
    )
    expect(screenSourceId({ kind: 'window', windowId: 'window:42:0' }, 7)).toBe('window:window:42:0')
  })

  it('gives two different regions of one display two different ids', () => {
    const a = screenSourceId({ kind: 'region', region: { x: 0, y: 0, width: 0.5, height: 0.5 } }, 1)
    const b = screenSourceId({ kind: 'region', region: { x: 0.5, y: 0, width: 0.5, height: 0.5 } }, 1)
    expect(a).not.toBe(b)
  })

  it('stays inside the identity schema length cap even for the longest window id', () => {
    const id = screenSourceId({ kind: 'window', windowId: 'w'.repeat(128) }, 1)
    expect(id.length).toBeLessThanOrEqual(160)
  })
})

describe('capture result carries the observation identity (G16)', () => {
  const identity = {
    observationId: 'obs-1',
    sequence: 1,
    sourceId: 'display:7',
    scope: 'display' as const,
    generation: 0,
    capturedAt: 1_000
  }

  it('validates the identity and refuses a negative generation or a zero sequence', () => {
    expect(ScreenObservationIdentitySchema.parse(identity)).toEqual(identity)
    expect(ScreenObservationIdentitySchema.safeParse({ ...identity, generation: -1 }).success).toBe(false)
    expect(ScreenObservationIdentitySchema.safeParse({ ...identity, sequence: 0 }).success).toBe(false)
    expect(ScreenObservationIdentitySchema.safeParse({ ...identity, scope: 'desktop' }).success).toBe(false)
  })

  it('keeps the previous capture result shape valid and adds the optional identity', () => {
    const base = { image: 'AAAA', width: 10, height: 10, capturedAt: 5 }
    expect(CaptureResultSchema.safeParse(base).success).toBe(true)
    expect(CaptureResultSchema.parse({ ...base, observation: identity }).observation).toEqual(identity)
  })

  it('is the same schema shared/ipc.ts has always exported', () => {
    expect(ReExported).toBe(CaptureResultSchema)
  })
})
