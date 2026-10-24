import { describe, expect, it } from 'vitest'
import { ocrUnavailableCopy, resolveOcrAvailability } from './ocr-availability'

describe('OCR availability', () => {
  it('resolves win32 to unavailable/platform-unsupported even when a helper is present', () => {
    expect(resolveOcrAvailability('win32', true)).toEqual({ state: 'unavailable', reason: 'platform-unsupported' })
  })

  it('resolves linux to unavailable/platform-unsupported', () => {
    expect(resolveOcrAvailability('linux', false)).toEqual({ state: 'unavailable', reason: 'platform-unsupported' })
  })

  it('resolves darwin with helper to available/vision', () => {
    expect(resolveOcrAvailability('darwin', true)).toEqual({ state: 'available', engine: 'vision' })
  })

  it('resolves darwin without helper to unavailable/helper-missing', () => {
    expect(resolveOcrAvailability('darwin', false)).toEqual({ state: 'unavailable', reason: 'helper-missing' })
  })

  it('copy names Windows for platform-unsupported and never mentions a model', () => {
    const copy = ocrUnavailableCopy('platform-unsupported')
    expect(copy).toBe("On-device text reading (OCR) isn't available on Windows.")
    expect(copy).not.toMatch(/model/i)
    expect(ocrUnavailableCopy('helper-missing')).toBe(
      "On-device text reading (OCR) isn't installed in this copy of Métis."
    )
  })
})
