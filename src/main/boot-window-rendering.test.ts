import { describe, expect, it, vi } from 'vitest'
import { bootWindowRendering, constructBootWindow } from './boot-window-rendering'

describe('constructBootWindow (M2-0433)', () => {
  it("builds under the variant's options and audits the constructor's own time with the chrome and variant built", () => {
    const recordBootStage = vi.fn()
    let clock = 1_000
    const built = constructBootWindow(
      { recordBootStage },
      true,
      (rendering) => {
        clock += 760
        return { rendering }
      },
      'paint-when-hidden',
      () => clock
    )
    expect(built.rendering).toEqual({ variant: 'paint-when-hidden', paintWhenInitiallyHidden: true, backgroundThrottling: false })
    expect(recordBootStage).toHaveBeenCalledExactlyOnceWith('createWindow.construct', 760, {
      transparent: true,
      windowVariant: 'paint-when-hidden'
    })
  })

  it('builds the shipped configuration before observability starts, and records nothing when the constructor throws', () => {
    expect(constructBootWindow(null, false, (rendering) => rendering.variant, '')).toBe('shipped')
    const recordBootStage = vi.fn()
    expect(() =>
      constructBootWindow({ recordBootStage }, false, () => {
        throw new Error('no compositor')
      }, '')
    ).toThrow('no compositor')
    expect(recordBootStage).not.toHaveBeenCalled()
  })
})

describe('bootWindowRendering (M2-0433)', () => {
  it('is the shipped configuration when the QA variable is unset, empty or unknown', () => {
    const shipped = { variant: 'shipped', paintWhenInitiallyHidden: false, backgroundThrottling: false }
    expect(bootWindowRendering(undefined)).toEqual(shipped)
    expect(bootWindowRendering('')).toEqual(shipped)
    expect(bootWindowRendering('transparent')).toEqual(shipped)
    expect(bootWindowRendering('shipped')).toEqual(shipped)
  })

  it('each variant changes exactly one option from the shipped configuration', () => {
    expect(bootWindowRendering('paint-when-hidden')).toEqual({
      variant: 'paint-when-hidden',
      paintWhenInitiallyHidden: true,
      backgroundThrottling: false
    })
    expect(bootWindowRendering('background-throttling')).toEqual({
      variant: 'background-throttling',
      paintWhenInitiallyHidden: false,
      backgroundThrottling: true
    })
  })
})
