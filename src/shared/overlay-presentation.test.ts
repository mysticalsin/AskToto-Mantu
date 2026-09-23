import { describe, expect, it } from 'vitest'
import {
  allowedOverlayLayouts,
  normalizeOverlayLayoutForPlacement,
  resolveOverlayPresentation
} from './overlay-presentation'

describe('overlay presentation', () => {
  it('normalizes the legacy bar layout when right-edge is selected', () => {
    expect(allowedOverlayLayouts('top-center')).toEqual(['hide', 'island', 'bar'])
    expect(allowedOverlayLayouts('right-edge')).toEqual(['hide', 'island'])
    expect(normalizeOverlayLayoutForPlacement('bar', 'right-edge')).toBe('island')
    expect(resolveOverlayPresentation({ placement: 'right-edge', layout: 'bar' })).toEqual({
      placement: 'right-edge',
      layout: 'island',
      surface: 'edge-chat'
    })
  })

  it('preserves every valid layout at top-center', () => {
    expect(normalizeOverlayLayoutForPlacement('hide', 'top-center')).toBe('hide')
    expect(normalizeOverlayLayoutForPlacement('island', 'top-center')).toBe('island')
    expect(normalizeOverlayLayoutForPlacement('bar', 'top-center')).toBe('bar')
    expect(resolveOverlayPresentation({ placement: 'top-center', layout: 'bar' })).toEqual({
      placement: 'top-center',
      layout: 'bar',
      surface: 'top-bar'
    })
  })

  it('defaults malformed runtime layouts without changing a valid placement', () => {
    expect(normalizeOverlayLayoutForPlacement('unknown' as never, 'right-edge')).toBe('hide')
    expect(resolveOverlayPresentation({ placement: 'top-center', layout: 'unknown' as never })).toEqual({
      placement: 'top-center',
      layout: 'hide',
      surface: 'top-bar'
    })
  })
})
