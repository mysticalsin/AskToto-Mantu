import { describe, expect, it, vi } from 'vitest'
import type { Rect } from '@shared/screen-marks'
import { createScreenMarks, type FrameNote } from './screen-marks'

const DISPLAY: Rect = { x: 0, y: 0, width: 1440, height: 900 }

function setup(bounds: Record<number, Rect | null> = { 1: DISPLAY, 2: { x: 1440, y: 0, width: 1920, height: 1080 } }) {
  let n = 0
  const store = createScreenMarks({ displayBounds: (id) => bounds[id] ?? null, newId: () => `mark-${++n}` })
  const frame = (over: Partial<FrameNote> = {}): FrameNote => ({
    observationId: 'obs-1',
    generation: 0,
    displayId: 1,
    screenshot: { width: 2880, height: 1800 },
    ...over
  })
  return { store, bounds, frame }
}

describe('screen marks store (G43)', () => {
  it('places a mark bound to the live screenshot and shows it on that display only', () => {
    const { store, frame } = setup()
    store.noteFrame(frame())
    const placed = store.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 1440, y: 900 } })
    expect(placed).toEqual({ ok: true, markId: 'mark-1' })
    const views = store.views()
    expect([...views.keys()]).toEqual([1])
    expect(views.get(1)).toEqual([{ markId: 'mark-1', kind: 'point', x: 720, y: 450 }])
  })

  it('refuses a mark for a screenshot that is not the live one, before any frame, or outside the image', () => {
    const { store, frame } = setup()
    expect(store.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 1, y: 1 } })).toEqual({
      ok: false,
      reason: 'no-observation'
    })
    store.noteFrame(frame())
    expect(store.place({ screenshotId: 'obs-0', shape: { kind: 'point', x: 1, y: 1 } })).toEqual({
      ok: false,
      reason: 'stale-screenshot'
    })
    expect(store.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 2881, y: 1 } })).toEqual({
      ok: false,
      reason: 'out-of-image'
    })
    expect(
      store.place({ screenshotId: 'obs-1', shape: { kind: 'box', x: 2800, y: 10, width: 200, height: 10 } })
    ).toEqual({
      ok: false,
      reason: 'out-of-image'
    })
  })

  it('drops every mark of an older screenshot when a new one is noted (never re-projected)', () => {
    const { store, frame } = setup()
    store.noteFrame(frame())
    store.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 10, y: 10 } })
    store.noteFrame(frame({ observationId: 'obs-2' }))
    expect(store.views().size).toBe(0)
    expect(store.count()).toBe(0)
    // Going back to the old id must not resurrect it.
    store.noteFrame(frame({ observationId: 'obs-1' }))
    expect(store.views().size).toBe(0)
  })

  it('keeps marks when the same observation is noted again (a reused frame)', () => {
    const { store, frame } = setup()
    store.noteFrame(frame())
    store.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 10, y: 10 } })
    store.noteFrame(frame())
    expect(store.count()).toBe(1)
  })

  it('splits marks by display when a later frame is of another display (older marks are stale)', () => {
    const { store, frame } = setup()
    store.noteFrame(frame())
    store.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 10, y: 10 } })
    store.noteFrame(frame({ observationId: 'obs-2', displayId: 2, screenshot: { width: 1920, height: 1080 } }))
    store.place({ screenshotId: 'obs-2', shape: { kind: 'point', x: 100, y: 100 } })
    expect([...store.views().keys()]).toEqual([2])
  })

  it('recomputes on a DPI change and hides a mark whose display vanished, retaining it for a return', () => {
    const { store, frame, bounds } = setup()
    store.noteFrame(frame())
    store.place({ screenshotId: 'obs-1', shape: { kind: 'box', x: 200, y: 100, width: 400, height: 300 } })
    bounds[1] = { x: 0, y: 0, width: 2880, height: 1800 }
    store.refresh()
    expect(store.views().get(1)).toEqual([{ markId: 'mark-1', kind: 'box', x: 200, y: 100, width: 400, height: 300 }])
    bounds[1] = null
    store.refresh()
    expect(store.views().size).toBe(0)
    expect(store.count()).toBe(1)
    bounds[1] = DISPLAY
    store.refresh()
    expect(store.views().get(1)?.[0]).toMatchObject({ x: 100, y: 50 })
  })

  it('clears all marks and forgets the observation on clear(), so nothing is placed until a new frame', () => {
    const { store, frame } = setup()
    store.noteFrame(frame())
    store.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 10, y: 10 } })
    store.clear('session-ended')
    expect(store.count()).toBe(0)
    expect(store.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 1, y: 1 } })).toEqual({
      ok: false,
      reason: 'no-observation'
    })
  })

  it('caps the number of marks', () => {
    const { store, frame } = setup()
    store.noteFrame(frame())
    for (let i = 0; i < 24; i++) store.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: i, y: i } })
    expect(store.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 1, y: 1 } })).toEqual({
      ok: false,
      reason: 'too-many'
    })
  })

  it('removes one mark by id', () => {
    const { store, frame } = setup()
    store.noteFrame(frame())
    store.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 1, y: 1 } })
    expect(store.remove('mark-1')).toBe(true)
    expect(store.remove('mark-1')).toBe(false)
    expect(store.count()).toBe(0)
  })

  it('notifies listeners on a change, not on a no-op refresh, and a throwing listener does not break the store', () => {
    const { store, frame } = setup()
    const listener = vi.fn()
    store.onChange(() => {
      throw new Error('listener bug')
    })
    store.onChange(listener)
    store.noteFrame(frame())
    store.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 1, y: 1 } })
    const afterPlace = listener.mock.calls.length
    expect(afterPlace).toBeGreaterThan(0)
    store.refresh()
    expect(listener.mock.calls.length).toBe(afterPlace)
  })

  it('exposes only renderer-safe views (no pixels, no ids of the screenshot)', () => {
    const { store, frame } = setup()
    store.noteFrame(frame())
    store.place({ screenshotId: 'obs-1', shape: { kind: 'label-anchor', x: 10, y: 10, stepNumber: 3 } })
    const json = JSON.stringify([...store.views().values()])
    expect(json).not.toContain('obs-1')
    expect(json).not.toContain('screenshot')
  })
})
