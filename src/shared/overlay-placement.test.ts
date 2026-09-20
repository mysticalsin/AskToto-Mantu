import { describe, expect, it } from 'vitest'
import { overlayDisplayKey, parseOverlayPlacement } from './overlay-placement'

describe('overlay placement settings', () => {
  it('keeps top-center as the backwards-compatible default', () => {
    expect(parseOverlayPlacement(undefined)).toBe('top-center')
    expect(parseOverlayPlacement('unexpected')).toBe('top-center')
  })

  it('accepts right-edge without changing the overlay chrome vocabulary', () => {
    expect(parseOverlayPlacement('right-edge')).toBe('right-edge')
  })

  it('uses an opaque local display identity for per-display placement memory', () => {
    expect(overlayDisplayKey(42)).toBe('display:42')
  })

  it('never creates placement keys for virtual or invalid Electron displays', () => {
    expect(overlayDisplayKey(-1)).toBeNull()
    expect(overlayDisplayKey(-10)).toBeNull()
    expect(overlayDisplayKey(0)).toBeNull()
    expect(overlayDisplayKey(Number.NaN)).toBeNull()
  })
})
